import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  automationWorkflowEffectEvents,
  automationWorkflowEffects,
  automationWorkflowRunLeases,
  automationWorkflowRuns,
  automationWorkflowSuspensions,
} from "@agentry/db/schema";
import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
  type AutomationWorkflowJsonValue,
} from "@agentrysh/shared";
import type { getDb } from "./db.js";
import {
  requireAutomationWorkflowComponentAdapter,
} from "./automation-workflow-adapters.js";
import type {
  AutomationWorkflowActor,
  AutomationWorkflowRunEvent,
  AutomationWorkflowRunState,
  AutomationWorkflowRuntimeResult,
} from "./automation-workflow-runtime.js";
import type { StoredAutomationWorkflowRevision } from "./automation-workflow-store.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Run = typeof automationWorkflowRuns.$inferSelect;
type Effect = typeof automationWorkflowEffects.$inferSelect;

const EFFECT_EVENTS = new Set([
  "effect.intent_reserved",
  "effect.call_started",
  "effect.completed",
  "effect.reconciled_absent",
  "effect.reconciliation_unknown",
  "effect.reconciliation_exhausted",
]);

const EVIDENCE_BOUND_RECONCILIATION_EVENTS = new Set([
  "effect.completed",
  "effect.reconciled_absent",
  "effect.reconciliation_unknown",
  "effect.reconciliation_exhausted",
]);

function objectValue(value: AutomationWorkflowJsonValue, label: string): Record<string, AutomationWorkflowJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errors.persistenceFailed(
      `Workflow ${label} must be a canonical JSON object.`,
      "Quarantine the run and inspect the immutable workflow event before continuing.",
    );
  }
  return value as Record<string, AutomationWorkflowJsonValue>;
}

function stringField(event: AutomationWorkflowRunEvent, field: string): string {
  const value = event.payload[field];
  if (typeof value !== "string" || value.length < 1) {
    throw new Error(`${event.event}.${field} is not a nonempty string`);
  }
  return value;
}

function numberField(event: AutomationWorkflowRunEvent, field: string): number {
  const value = event.payload[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${event.event}.${field} is not a nonnegative integer`);
  }
  return value as number;
}

async function suspensionId(runId: string, nodeId: string, kind: "approval" | "wait" | "verify") {
  return `awfs_${await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-suspension-v1",
    run_id: runId,
    node_id: nodeId,
    kind,
  }))}`;
}

async function effectId(runId: string, nodeId: string) {
  return `awfx_${await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-effect-v1",
    run_id: runId,
    node_id: nodeId,
  }))}`;
}

async function appendEffectEvent(
  tx: Transaction,
  input: {
    run: Run;
    effect_id: string;
    workflow_event: AutomationWorkflowRunEvent;
    effect_attempt: number;
    reconciliation_count: number;
    lease_epoch: number | null;
    ledger_payload?: Record<string, AutomationWorkflowJsonValue>;
    idempotency_key_hash?: string;
  },
) {
  const prior = (
    await tx.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, input.effect_id),
    ).orderBy(desc(automationWorkflowEffectEvents.sequence)).limit(1)
  )[0] ?? null;
  const sequence = (prior?.sequence ?? 0) + 1;
  const payload = input.ledger_payload ?? {
    intent_hash: typeof input.workflow_event.payload.intent_hash === "string"
      ? input.workflow_event.payload.intent_hash
      : null,
    workflow_event_id: input.workflow_event.event_id,
    workflow_event_payload_hash: input.workflow_event.payload_hash,
    workflow_command_id: input.workflow_event.command_id,
    workflow_request_hash: input.workflow_event.request_hash,
    evidence: input.workflow_event.payload,
  } satisfies Record<string, AutomationWorkflowJsonValue>;
  const payloadJson = canonicalJsonStringify(payload);
  const payloadHash = await sha256Hex(payloadJson);
  const idempotencyKeyHash = input.idempotency_key_hash ?? await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-effect-event-idempotency-v1",
    workflow_event_id: input.workflow_event.event_id,
  }));
  const id = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-effect-event-v1",
    prior_event_hash: prior?.id ?? null,
    effect_id: input.effect_id,
    sequence,
    event: input.workflow_event.event,
    effect_attempt: input.effect_attempt,
    reconciliation_count: input.reconciliation_count,
    lease_epoch: input.lease_epoch,
    payload_hash: payloadHash,
    actor: input.workflow_event.actor,
    at: input.workflow_event.at,
  }));
  const inserted = await tx.insert(automationWorkflowEffectEvents).values({
    id,
    idempotencyKeyHash,
    priorEventHash: prior?.id ?? null,
    effectId: input.effect_id,
    projectId: input.run.projectId,
    automationId: input.run.automationId,
    runId: input.run.id,
    sequence,
    event: input.workflow_event.event,
    effectAttempt: input.effect_attempt,
    reconciliationCount: input.reconciliation_count,
    leaseEpoch: input.lease_epoch,
    payloadJson,
    payloadHash,
    actorPrincipal: input.workflow_event.actor.principal,
    actorCredentialId: input.workflow_event.actor.credential_id,
    at: input.workflow_event.at,
  }).returning({ id: automationWorkflowEffectEvents.id });
  if (inserted.length !== 1) throw new Error("workflow effect event insert failed");
  return { id, sequence, payloadJson, payloadHash };
}

async function createSuspension(
  tx: Transaction,
  run: Run,
  state: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
) {
  const nodeId = event.node_id!;
  if (event.event === "approval.requested") {
    const subjectNodeId = stringField(event, "subject_node_id");
    const subject = state.outputs[subjectNodeId];
    if (!subject || subject.payload_hash !== stringField(event, "subject_hash")) {
      throw errors.persistenceFailed(
        "The approval suspension subject does not match its same-run immutable output.",
        "Quarantine the run; do not expose or approve an unbound subject.",
        { run_id: run.id, node_id: nodeId },
      );
    }
    const subjectJson = canonicalJsonStringify(objectValue(subject.payload, "approval subject"));
    const id = await suspensionId(run.id, nodeId, "approval");
    const inserted = await tx.insert(automationWorkflowSuspensions).values({
      id,
      projectId: run.projectId,
      automationId: run.automationId,
      runId: run.id,
      nodeId,
      kind: "approval",
      status: "pending",
      version: 1,
      bindingHash: stringField(event, "binding_hash"),
      subjectJson,
      subjectHash: subject.payload_hash,
      nextCheckAt: null,
      deadlineAt: numberField(event, "expires_at"),
      resultJson: null,
      resultHash: null,
      decisionBy: null,
      decisionReason: null,
      createdAt: event.at,
      updatedAt: event.at,
      resolvedAt: null,
    }).returning({ id: automationWorkflowSuspensions.id });
    if (inserted.length !== 1) throw new Error("workflow approval suspension insert failed");
    return;
  }

  const kind = event.event === "wait.registered" ? "wait" : "verify";
  const id = await suspensionId(run.id, nodeId, kind);
  const inserted = await tx.insert(automationWorkflowSuspensions).values({
    id,
    projectId: run.projectId,
    automationId: run.automationId,
    runId: run.id,
    nodeId,
    kind,
    status: "pending",
    version: 1,
    bindingHash: null,
    subjectJson: null,
    subjectHash: null,
    nextCheckAt: numberField(event, "next_check_at"),
    deadlineAt: numberField(event, "deadline_at"),
    resultJson: null,
    resultHash: null,
    decisionBy: null,
    decisionReason: null,
    createdAt: event.at,
    updatedAt: event.at,
    resolvedAt: null,
  }).returning({ id: automationWorkflowSuspensions.id });
  if (inserted.length !== 1) throw new Error("workflow durable suspension insert failed");
}

async function resolveSuspension(tx: Transaction, run: Run, event: AutomationWorkflowRunEvent) {
  const nodeId = event.node_id!;
  const existing = (
    await tx.select().from(automationWorkflowSuspensions).where(and(
      eq(automationWorkflowSuspensions.runId, run.id),
      eq(automationWorkflowSuspensions.nodeId, nodeId),
    )).limit(1)
  )[0] ?? null;
  if (!existing || existing.status !== "pending") {
    throw errors.persistenceFailed(
      "The workflow suspension projection is missing or no longer pending.",
      "Quarantine the run and rebuild the suspension from immutable workflow events.",
      { run_id: run.id, node_id: nodeId, event: event.event },
    );
  }
  if (event.event === "verification.pending") {
    const changed = await tx.update(automationWorkflowSuspensions).set({
      version: existing.version + 1,
      nextCheckAt: numberField(event, "next_check_at"),
      updatedAt: event.at,
    }).where(and(
      eq(automationWorkflowSuspensions.id, existing.id),
      eq(automationWorkflowSuspensions.version, existing.version),
      eq(automationWorkflowSuspensions.status, "pending"),
    )).returning({ id: automationWorkflowSuspensions.id });
    if (changed.length !== 1) throw new Error("workflow verification suspension CAS failed");
    return;
  }

  let status: typeof automationWorkflowSuspensions.$inferInsert.status;
  let resultJson: string | null = null;
  let resultHash: string | null = null;
  let decisionBy: string | null = null;
  let decisionReason: string | null = null;
  switch (event.event) {
    case "approval.approved":
    case "approval.rejected":
      status = event.event === "approval.approved" ? "approved" : "rejected";
      decisionBy = event.actor.credential_id;
      decisionReason = stringField(event, "reason");
      break;
    case "approval.expired": status = "expired"; break;
    case "wait.ready": status = "ready"; break;
    case "wait.timed_out": status = "timed_out"; break;
    case "wait.domain_failed": status = "error"; break;
    case "verification.passed": status = "passed"; break;
    case "verification.failed": status = "not_passed"; break;
    case "verification.timed_out": status = "timed_out"; break;
    case "verification.domain_failed": status = "error"; break;
    default: throw new Error(`unsupported suspension event ${event.event}`);
  }
  if (["wait.ready", "verification.passed", "verification.failed"].includes(event.event)) {
    const output = objectValue(event.payload.output!, `${event.event} result`);
    resultJson = canonicalJsonStringify(output);
    resultHash = stringField(event, "output_hash");
    if (await sha256Hex(resultJson) !== resultHash) {
      throw new Error(`${event.event} result hash does not match its canonical payload`);
    }
  }
  const changed = await tx.update(automationWorkflowSuspensions).set({
    status,
    version: existing.version + 1,
    nextCheckAt: null,
    resultJson,
    resultHash,
    decisionBy,
    decisionReason,
    updatedAt: event.at,
    resolvedAt: event.at,
  }).where(and(
    eq(automationWorkflowSuspensions.id, existing.id),
    eq(automationWorkflowSuspensions.version, existing.version),
    eq(automationWorkflowSuspensions.status, "pending"),
  )).returning({ id: automationWorkflowSuspensions.id });
  if (changed.length !== 1) throw new Error("workflow suspension resolution CAS failed");
}

async function reserveEffect(
  tx: Transaction,
  run: Run,
  revision: StoredAutomationWorkflowRevision,
  state: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
) {
  const nodeId = event.node_id!;
  const node = revision.workflow.nodes.find((candidate) => candidate.id === nodeId);
  const resolved = revision.compiled.resolved_nodes.find((candidate) => candidate.node_id === nodeId);
  if (!node || node.kind !== "effect" || !resolved) throw new Error("effect intent points to an unknown component");
  const adapter = await requireAutomationWorkflowComponentAdapter({
    ...node.component,
    component_hash: resolved.component_hash,
  });
  const policy = adapter.reconciliation_policy;
  if (!policy) throw new Error("external effect adapter has no reconciliation policy");
  const frozenAdapterPolicy = {
    protocol_version: "1",
    semantic_validator_version: adapter.semantic_validator_version,
    reconciliation_policy: {
      ...policy,
      outcomes: [...policy.outcomes],
    },
  } satisfies Record<string, AutomationWorkflowJsonValue>;
  const frozenAdapterPolicyHash = await sha256Hex(canonicalJsonStringify(frozenAdapterPolicy));
  const approval = state.approvals[nodeId];
  if (!approval || approval.status !== "approved") throw new Error("reserved effect has no approved binding");
  const id = await effectId(run.id, nodeId);
  const ledgerPayload = {
    intent_hash: typeof event.payload.intent_hash === "string" ? event.payload.intent_hash : null,
    workflow_event_id: event.event_id,
    workflow_event_payload_hash: event.payload_hash,
    workflow_command_id: event.command_id,
    workflow_request_hash: event.request_hash,
    evidence: event.payload,
    frozen_adapter_policy: frozenAdapterPolicy,
    frozen_adapter_policy_hash: frozenAdapterPolicyHash,
  } satisfies Record<string, AutomationWorkflowJsonValue>;
  const ledger = await appendEffectEvent(tx, {
    run,
    effect_id: id,
    workflow_event: event,
    effect_attempt: 0,
    reconciliation_count: 0,
    lease_epoch: null,
    ledger_payload: ledgerPayload,
  });
  const approvalId = await suspensionId(run.id, approval.approval_node_id, "approval");
  const inserted = await tx.insert(automationWorkflowEffects).values({
    id,
    projectId: run.projectId,
    automationId: run.automationId,
    runId: run.id,
    nodeId,
    componentId: node.component.id,
    componentVersion: node.component.version,
    componentHash: resolved.component_hash,
    approvalSuspensionId: approvalId,
    approvalBindingHash: approval.binding_hash,
    inputHash: stringField(event, "input_hash"),
    intentHash: stringField(event, "intent_hash"),
    providerTarget: stringField(event, "provider_target"),
    providerOperationKey: stringField(event, "intent_hash"),
    createdEventId: ledger.id,
    lastEventId: ledger.id,
    status: "reserved",
    version: 1,
    callAttempt: 0,
    maxCallAttempts: policy.max_provider_call_attempts,
    maxReconciliations: policy.max_automatic_reconciliations,
    reconciliationCount: 0,
    reconcileAfterAt: null,
    providerRef: null,
    receiptJson: null,
    receiptHash: null,
    createdAt: event.at,
    updatedAt: event.at,
    callStartedAt: null,
    completedAt: null,
  }).returning({ id: automationWorkflowEffects.id });
  if (inserted.length !== 1) throw new Error("workflow effect projection insert failed");
}

function providerRef(output: Record<string, AutomationWorkflowJsonValue>): string | null {
  for (const key of ["pr_url", "report_id", "provider_ref"]) {
    const value = output[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 2_000) return value;
  }
  return null;
}

async function advanceEffect(
  tx: Transaction,
  run: Run,
  event: AutomationWorkflowRunEvent,
  leaseEpoch: number | null,
  ledgerOverride?: Readonly<{
    payload: Record<string, AutomationWorkflowJsonValue>;
    idempotency_key_hash: string;
  }>,
) {
  const nodeId = event.node_id!;
  const current = (
    await tx.select().from(automationWorkflowEffects).where(and(
      eq(automationWorkflowEffects.runId, run.id),
      eq(automationWorkflowEffects.nodeId, nodeId),
    )).limit(1)
  )[0] ?? null;
  if (!current) throw new Error("workflow effect projection is missing");
  const callAttempt = event.event === "effect.call_started" ? current.callAttempt + 1 : current.callAttempt;
  const reconciliationCount = event.event.startsWith("effect.reconciliation") || event.event === "effect.reconciled_absent"
    ? numberField(event, "reconciliation_count")
    : current.reconciliationCount;
  const ledger = await appendEffectEvent(tx, {
    run,
    effect_id: current.id,
    workflow_event: event,
    effect_attempt: callAttempt,
    reconciliation_count: reconciliationCount,
    lease_epoch: event.event === "effect.call_started" || (
      event.event === "effect.completed" && event.actor.principal === "automation_runner"
    ) ? leaseEpoch : null,
    ledger_payload: ledgerOverride?.payload,
    idempotency_key_hash: ledgerOverride?.idempotency_key_hash,
  });
  const values: Partial<typeof automationWorkflowEffects.$inferInsert> = {
    version: current.version + 1,
    lastEventId: ledger.id,
    updatedAt: event.at,
  };
  if (event.event === "effect.call_started") {
    if (!leaseEpoch) throw new Error("provider call start has no durable lease epoch");
    values.status = "indeterminate";
    values.callAttempt = callAttempt;
    values.reconcileAfterAt = numberField(event, "next_reconcile_at");
    values.callStartedAt = event.at;
  } else if (event.event === "effect.completed") {
    const output = objectValue(event.payload.output!, "effect receipt");
    const receiptJson = canonicalJsonStringify(output);
    const receiptHash = stringField(event, "output_hash");
    if (await sha256Hex(receiptJson) !== receiptHash) throw new Error("effect receipt payload hash mismatch");
    values.status = "succeeded";
    values.reconcileAfterAt = null;
    values.providerRef = providerRef(output);
    values.receiptJson = receiptJson;
    values.receiptHash = receiptHash;
    values.completedAt = event.at;
  } else if (event.event === "effect.reconciliation_exhausted") {
    values.status = "manual_follow_up";
    values.reconciliationCount = reconciliationCount;
    values.reconcileAfterAt = null;
  } else {
    values.status = "indeterminate";
    values.reconciliationCount = reconciliationCount;
    values.reconcileAfterAt = numberField(event, "next_reconcile_at");
  }
  const changed = await tx.update(automationWorkflowEffects).set(values).where(and(
    eq(automationWorkflowEffects.id, current.id),
    eq(automationWorkflowEffects.version, current.version),
    eq(automationWorkflowEffects.lastEventId, current.lastEventId),
  )).returning({ id: automationWorkflowEffects.id });
  if (changed.length !== 1) throw new Error("workflow effect projection CAS failed");
  return ledger;
}

/**
 * Append the full provider evidence to the effect ledger while binding it
 * one-way to the already-persisted workflow event. The caller commits both
 * ledgers and both projections in one database transaction.
 */
export async function advanceAutomationWorkflowEvidenceBoundEffect(
  tx: Transaction,
  input: {
    run: Run;
    workflow_event: AutomationWorkflowRunEvent;
    idempotency_key_hash: string;
    reconciliation_payload: Record<string, AutomationWorkflowJsonValue>;
  },
) {
  const event = input.workflow_event;
  if (
    !EVIDENCE_BOUND_RECONCILIATION_EVENTS.has(event.event) ||
    event.actor.principal !== "agentry_system" && event.actor.principal !== "trusted_ci" ||
    input.reconciliation_payload.request_hash !== event.request_hash
  ) {
    throw errors.persistenceFailed(
      "The evidence-bound effect transition does not match its trusted workflow event request.",
      "Roll back both ledgers and retry only through the dedicated reconciliation service.",
      { run_id: input.run.id, workflow_event_id: event.event_id },
    );
  }
  const payload = {
    ...input.reconciliation_payload,
    workflow_event_id: event.event_id,
    workflow_event_payload_hash: event.payload_hash,
    workflow_command_id: event.command_id,
    workflow_request_hash: event.request_hash,
  } satisfies Record<string, AutomationWorkflowJsonValue>;
  return advanceEffect(tx, input.run, event, null, {
    payload,
    idempotency_key_hash: input.idempotency_key_hash,
  });
}

async function cancelPendingSuspensions(tx: Transaction, run: Run, event: AutomationWorkflowRunEvent) {
  await tx.update(automationWorkflowSuspensions).set({
    status: "cancelled",
    version: sql`${automationWorkflowSuspensions.version} + 1`,
    nextCheckAt: null,
    decisionBy: null,
    decisionReason: null,
    resultJson: null,
    resultHash: null,
    updatedAt: event.at,
    resolvedAt: event.at,
  }).where(and(
    eq(automationWorkflowSuspensions.runId, run.id),
    eq(automationWorkflowSuspensions.status, "pending"),
  ));
}

export async function releaseAutomationWorkflowTerminalLease(
  tx: Transaction,
  run: Run,
  event: AutomationWorkflowRunEvent,
) {
  const latest = (
    await tx.select().from(automationWorkflowRunLeases).where(
      eq(automationWorkflowRunLeases.runId, run.id),
    ).orderBy(desc(automationWorkflowRunLeases.leaseEpoch)).limit(1)
  )[0] ?? null;
  if (!latest || latest.releasedAt !== null) return;
  const changed = await tx.update(automationWorkflowRunLeases).set({
    version: latest.version + 1,
    releasedAt: event.at,
    releaseReason: `workflow_${event.event}`,
  }).where(and(
    eq(automationWorkflowRunLeases.runId, run.id),
    eq(automationWorkflowRunLeases.leaseEpoch, latest.leaseEpoch),
    eq(automationWorkflowRunLeases.version, latest.version),
    isNull(automationWorkflowRunLeases.releasedAt),
  )).returning({ runId: automationWorkflowRunLeases.runId });
  if (changed.length !== 1) throw new Error("terminal workflow lease release CAS failed");
}

export async function synchronizeAutomationWorkflowMaterializations(
  tx: Transaction,
  input: {
    run: Run;
    revision: StoredAutomationWorkflowRevision;
    prior_state: AutomationWorkflowRunState | null;
    result: AutomationWorkflowRuntimeResult;
    lease_epoch: number | null;
    precommitted_effect_workflow_event_id?: string;
  },
): Promise<void> {
  let observedPrecommittedEffect = input.precommitted_effect_workflow_event_id === undefined;
  for (const event of input.result.events) {
    if (["approval.requested", "wait.registered", "verification.started"].includes(event.event)) {
      await createSuspension(tx, input.run, input.result.state, event);
    } else if ([
      "approval.approved",
      "approval.rejected",
      "approval.expired",
      "wait.ready",
      "wait.timed_out",
      "wait.domain_failed",
      "verification.pending",
      "verification.passed",
      "verification.failed",
      "verification.timed_out",
      "verification.domain_failed",
    ].includes(event.event)) {
      await resolveSuspension(tx, input.run, event);
    }
    if (event.event === "effect.intent_reserved") {
      await reserveEffect(tx, input.run, input.revision, input.result.state, event);
    } else if (EFFECT_EVENTS.has(event.event)) {
      if (event.event_id === input.precommitted_effect_workflow_event_id) {
        observedPrecommittedEffect = true;
      } else {
        await advanceEffect(tx, input.run, event, input.lease_epoch);
      }
    }
    if (event.event === "run.cancelled" || event.event === "run.quarantined") {
      await cancelPendingSuspensions(tx, input.run, event);
    }
  }
  if (!observedPrecommittedEffect) {
    throw new Error("precommitted workflow effect event was not emitted by the runtime command");
  }
}

/**
 * Provider receipts may arrive after a lease expires, but only the exact
 * credential that durably recorded call-start may bind that receipt.
 */
export async function assertAutomationWorkflowEffectReceiptActor(
  tx: Transaction,
  input: {
    run_id: string;
    node_id: string;
    intent_hash: string;
    actor: AutomationWorkflowActor;
  },
) {
  const effect = (
    await tx.select().from(automationWorkflowEffects).where(and(
      eq(automationWorkflowEffects.runId, input.run_id),
      eq(automationWorkflowEffects.nodeId, input.node_id),
      eq(automationWorkflowEffects.intentHash, input.intent_hash),
    )).limit(1)
  )[0] ?? null;
  if (!effect) throw errors.notFound("automation_workflow_effect");
  const call = (
    await tx.select().from(automationWorkflowEffectEvents).where(and(
      eq(automationWorkflowEffectEvents.effectId, effect.id),
      eq(automationWorkflowEffectEvents.event, "effect.call_started"),
    )).orderBy(desc(automationWorkflowEffectEvents.sequence)).limit(1)
  )[0] ?? null;
  if (
    !call ||
    call.leaseEpoch === null ||
    input.actor.principal !== "automation_runner" ||
    !input.actor.credential_id ||
    call.actorPrincipal !== input.actor.principal ||
    call.actorCredentialId !== input.actor.credential_id
  ) {
    throw errors.forbidden();
  }
  return { effect, call };
}
