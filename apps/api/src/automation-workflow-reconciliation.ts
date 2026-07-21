import { and, asc, desc, eq, gt, isNull, notLike, sql } from "drizzle-orm";
import {
  automationWorkflowEffectEvents,
  automationWorkflowEffects,
  automationWorkflowRunEvents,
  automationWorkflowRuns,
  automationWorkflowRunStates,
  projectCredentials,
} from "@agentry/db/schema";
import {
  AgentryError,
  canonicalJsonStringify,
  errors,
  sha256Hex,
  type AutomationWorkflowJsonValue,
} from "@agentrysh/shared";
import type { getDb } from "./db.js";
import { assertAutomationWritesOpen } from "./automation-deletion-boundary.js";
import {
  requireAutomationWorkflowComponentAdapter,
  validateAutomationWorkflowAdapterOutput,
  type AutomationWorkflowAdapterContext,
  type AutomationWorkflowEffectReconciliationPolicy,
} from "./automation-workflow-adapters.js";
import { readAutomationWorkflowAuthority } from "./automation-workflow-controls.js";
import {
  replayAutomationWorkflowRun,
  type AutomationWorkflowActor,
  type AutomationWorkflowRunEvent,
  type AutomationWorkflowRunState,
  type AutomationWorkflowRuntimeCommand,
} from "./automation-workflow-runtime.js";
import {
  loadAutomationWorkflowRevision,
  type StoredAutomationWorkflowRevision,
} from "./automation-workflow-store.js";
import { persistAutomationWorkflowEvidenceBoundReconciliation } from "./automation-workflow-service.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Run = typeof automationWorkflowRuns.$inferSelect;
type Effect = typeof automationWorkflowEffects.$inferSelect;
type EffectEvent = typeof automationWorkflowEffectEvents.$inferSelect;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const IDEMPOTENCY_KEY = /^[\u0021-\u007E]{8,500}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-fA-F0-9]{7,64}$/u;
const TERMINAL_RUN_STATUSES = new Set(["completed", "escalated", "cancelled", "quarantined"]);
const MAX_PROVIDER_LOOKUP_SECONDS = 300;

export type AutomationWorkflowEffectReconciliationActor =
  | Readonly<{ principal: "agentry_system"; credential_id: null }>
  | Readonly<{ principal: "trusted_ci"; credential_id: string }>;

export type AutomationWorkflowGithubReconciliationEvidence = Readonly<{
  provider: "github";
  provider_operation_key: string;
  provider_target: string;
  intent_marker: string;
  expected_head_sha: string;
  lookup_started_at: number;
  lookup_completed_at: number;
  lookup_result: "found" | "not_found" | "unknown";
  matched_provider_ref: string | null;
}>;

export type ReconcileAutomationWorkflowEffectInput = Readonly<{
  project_id: string;
  effect_id: string;
  idempotency_key: string;
  outcome: "found" | "definitively_absent" | "unknown";
  evidence: AutomationWorkflowGithubReconciliationEvidence;
  output?: unknown;
  actor: AutomationWorkflowEffectReconciliationActor;
  /** Test/worker clock injection. It is deliberately excluded from request identity. */
  observed_at?: number;
}>;

type DurableReconciliationReceipt = Readonly<{
  kind: "automation_workflow_effect_reconciliation_receipt";
  schema_version: "1";
  project_id: string;
  automation_id: string;
  run_id: string;
  effect_id: string;
  node_id: string;
  intent_hash: string;
  request_hash: string;
  requested_outcome: ReconcileAutomationWorkflowEffectInput["outcome"];
  effective_outcome: ReconcileAutomationWorkflowEffectInput["outcome"];
  effect_status: "indeterminate" | "succeeded" | "manual_follow_up";
  reconciliation_count: number;
  next_reconcile_at: number | null;
  provider_ref: string | null;
  receipt_hash: string | null;
  provider_call_authorized: false;
}>;

export type AutomationWorkflowEffectReconciliationReceipt = DurableReconciliationReceipt & Readonly<{
  effect_event_id: string;
  effect_event_sequence: number;
  idempotent_replay: boolean;
}>;

export type AutomationWorkflowEffectReconciliationTransition = Readonly<{
  event: "effect.completed" | "effect.reconciled_absent" | "effect.reconciliation_unknown" | "effect.reconciliation_exhausted";
  effective_outcome: ReconcileAutomationWorkflowEffectInput["outcome"];
  status: "indeterminate" | "succeeded" | "manual_follow_up";
  reconciliation_count: number;
  next_reconcile_at: number | null;
}>;

function reconciliationError(
  status: number,
  code: string,
  message: string,
  nextAction: string,
  details: Record<string, unknown> = {},
): never {
  throw new AgentryError({ status, code, message, nextAction, details });
}

async function databaseNow(db: Transaction, observedAt?: number): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("database clock did not return unix seconds");
  if (observedAt === undefined) return now;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw errors.invalidPayload({ reason: "observed_at must be a nonnegative integer" });
  }
  if (Math.abs(observedAt - now) > 1) {
    throw errors.invalidPayload({
      reason: "observed_at must match the database clock within one second",
    });
  }
  // observed_at is only a skew assertion. All authority and due checks use
  // the queried database clock, including the one-second boundary.
  return now;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw errors.persistenceFailed(
      `Persisted ${label} is not a canonical JSON object.`,
      "Stop reconciliation and inspect the immutable effect ledger before retrying.",
    );
  }
}

function assertExactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(wanted)) {
    throw errors.invalidPayload({ reason: `${label} must contain exactly: ${wanted.join(", ")}` });
  }
}

function validateEnvelope(input: ReconcileAutomationWorkflowEffectInput): void {
  if (!ID.test(input.project_id) || !ID.test(input.effect_id)) {
    throw errors.invalidPayload({ reason: "project_id or effect_id is invalid" });
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotency_key)) {
    throw errors.invalidPayload({ reason: "idempotency_key must contain 8-500 visible ASCII characters" });
  }
  if (
    (input.actor.principal === "agentry_system" && input.actor.credential_id !== null) ||
    (input.actor.principal === "trusted_ci" && !ID.test(input.actor.credential_id)) ||
    !["agentry_system", "trusted_ci"].includes(input.actor.principal)
  ) {
    throw errors.forbidden();
  }
  if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence)) {
    throw errors.invalidPayload({ reason: "evidence must be the exact GitHub lookup evidence object" });
  }
  assertExactKeys(input.evidence, [
    "provider",
    "provider_operation_key",
    "provider_target",
    "intent_marker",
    "expected_head_sha",
    "lookup_started_at",
    "lookup_completed_at",
    "lookup_result",
    "matched_provider_ref",
  ], "evidence");
  if (
    input.evidence.provider !== "github" ||
    typeof input.evidence.provider_operation_key !== "string" ||
    typeof input.evidence.provider_target !== "string" ||
    typeof input.evidence.intent_marker !== "string" ||
    !GIT_SHA.test(input.evidence.expected_head_sha) ||
    !Number.isSafeInteger(input.evidence.lookup_started_at) ||
    input.evidence.lookup_started_at < 0 ||
    !Number.isSafeInteger(input.evidence.lookup_completed_at) ||
    input.evidence.lookup_completed_at < 0 ||
    !["found", "not_found", "unknown"].includes(input.evidence.lookup_result) ||
    (input.evidence.matched_provider_ref !== null && typeof input.evidence.matched_provider_ref !== "string")
  ) {
    throw errors.invalidPayload({ reason: "evidence has an invalid GitHub operation, target, head, time, result, or provider reference" });
  }
  if (input.outcome === "found" && input.output === undefined) {
    throw errors.invalidPayload({ reason: "found reconciliation requires the exact provider receipt output" });
  }
  if (input.outcome !== "found" && input.output !== undefined) {
    throw errors.invalidPayload({ reason: "only found reconciliation may carry provider output" });
  }
}

export async function automationWorkflowEffectReconciliationIdempotencyHash(
  effectId: string,
  idempotencyKey: string,
): Promise<string> {
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-effect-reconciliation-idempotency-v1",
    effect_id: effectId,
    key: idempotencyKey,
  }));
}

async function reconciliationRequestHash(input: ReconcileAutomationWorkflowEffectInput): Promise<string> {
  const output = input.outcome === "found" &&
      input.output &&
      typeof input.output === "object" &&
      !Array.isArray(input.output)
    ? {
        ...(input.output as Record<string, unknown>),
        // Agentry owns the durable receipt time. Normalize it out of caller
        // request identity so a replacement trusted-CI credential can recover
        // the same logical receipt after response loss.
        recorded_at: 0,
      }
    : input.outcome === "found" ? input.output : null;
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-effect-reconciliation-request-v1",
    project_id: input.project_id,
    effect_id: input.effect_id,
    outcome: input.outcome,
    evidence: input.evidence,
    output,
    actor: { principal: input.actor.principal },
  }));
}

export function planAutomationWorkflowEffectReconciliation(
  input: Readonly<{
    requested_outcome: ReconcileAutomationWorkflowEffectInput["outcome"];
    reconciliation_count: number;
    max_reconciliations: number;
    call_started_at: number;
    now: number;
    retry_backoff_seconds: number;
    backoff_deadline_at?: number;
    absence_consistency_window_seconds: number;
  }>,
): AutomationWorkflowEffectReconciliationTransition {
  const integers = [
    input.reconciliation_count,
    input.max_reconciliations,
    input.call_started_at,
    input.now,
    input.retry_backoff_seconds,
    input.absence_consistency_window_seconds,
    ...(input.backoff_deadline_at === undefined ? [] : [input.backoff_deadline_at]),
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0) || input.max_reconciliations < 1) {
    throw new Error("effect reconciliation transition has invalid frozen integers");
  }
  if (input.requested_outcome === "found") {
    return {
      event: "effect.completed",
      effective_outcome: "found",
      status: "succeeded",
      reconciliation_count: input.reconciliation_count,
      next_reconcile_at: null,
    };
  }
  const effectiveOutcome = input.requested_outcome === "definitively_absent" &&
    input.now < input.call_started_at + input.absence_consistency_window_seconds
    ? "unknown"
    : input.requested_outcome;
  const reconciliationCount = input.reconciliation_count + 1;
  if (reconciliationCount >= input.max_reconciliations) {
    return {
      event: "effect.reconciliation_exhausted",
      effective_outcome: effectiveOutcome,
      status: "manual_follow_up",
      reconciliation_count: input.max_reconciliations,
      next_reconcile_at: null,
    };
  }
  const unfencedNextReconcileAt = input.now + input.retry_backoff_seconds;
  if (!Number.isSafeInteger(unfencedNextReconcileAt)) throw new Error("effect reconciliation backoff overflowed");
  const nextReconcileAt = input.backoff_deadline_at === undefined
    ? unfencedNextReconcileAt
    : Math.min(unfencedNextReconcileAt, input.backoff_deadline_at);
  return {
    event: effectiveOutcome === "definitively_absent"
      ? "effect.reconciled_absent"
      : "effect.reconciliation_unknown",
    effective_outcome: effectiveOutcome,
    status: "indeterminate",
    reconciliation_count: reconciliationCount,
    next_reconcile_at: nextReconcileAt,
  };
}

function eventFromRow(row: typeof automationWorkflowRunEvents.$inferSelect): AutomationWorkflowRunEvent {
  return {
    event_id: row.id,
    prior_event_hash: row.priorEventHash,
    event_version: row.eventVersion as "1",
    run_id: row.runId,
    sequence: row.sequence,
    command_id: row.commandId,
    request_hash: row.requestHash,
    event: row.event,
    at: row.at,
    actor: {
      principal: row.actorPrincipal as AutomationWorkflowActor["principal"],
      credential_id: row.actorCredentialId,
    },
    workflow_hash: row.workflowHash,
    compile_hash: row.compileHash,
    node_id: row.nodeId,
    component_hash: row.componentHash,
    payload_schema_ref: row.payloadSchemaRef,
    payload_hash: row.payloadHash,
    payload: parseObject(row.payloadJson, "workflow event payload") as Record<string, AutomationWorkflowJsonValue>,
  };
}

async function loadStrictRunState(
  tx: Transaction,
  run: Run,
  revision: StoredAutomationWorkflowRevision,
): Promise<AutomationWorkflowRunState> {
  const projection = (
    await tx.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, run.id),
    ).limit(1)
  )[0] ?? null;
  if (!projection) throw errors.notFound("automation_workflow_run_state");
  const rows = await tx.select().from(automationWorkflowRunEvents).where(
    eq(automationWorkflowRunEvents.runId, run.id),
  ).orderBy(asc(automationWorkflowRunEvents.sequence));
  const state = await replayAutomationWorkflowRun(revision.compiled, rows.map(eventFromRow));
  if (!state) throw errors.persistenceFailed(
    "The workflow event ledger replayed to no run state.",
    "Stop reconciliation and inspect the immutable workflow ledger.",
    { run_id: run.id },
  );
  const stateJson = canonicalJsonStringify(state);
  const stateHash = await sha256Hex(stateJson);
  if (
    projection.stateVersion !== state.revision ||
    projection.status !== state.status ||
    projection.stateJson !== stateJson ||
    projection.stateHash !== stateHash ||
    projection.workflowRevisionId !== revision.revision_id ||
    projection.workflowHash !== revision.workflow_hash ||
    projection.compileHash !== revision.compile_hash
  ) {
    throw errors.persistenceFailed(
      "The workflow projection differs from strict immutable event replay.",
      "Stop reconciliation and repair or quarantine the corrupted workflow projection.",
      { run_id: run.id },
    );
  }
  return state;
}

function jsonObject(value: AutomationWorkflowJsonValue, label: string): Record<string, AutomationWorkflowJsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errors.persistenceFailed(
      `${label} is not an immutable JSON object.`,
      "Stop reconciliation and inspect the exact workflow output binding.",
    );
  }
  return value as Record<string, AutomationWorkflowJsonValue>;
}

async function adapterContext(
  revision: StoredAutomationWorkflowRevision,
  state: AutomationWorkflowRunState,
  effect: Effect,
  at: number,
): Promise<{ context: AutomationWorkflowAdapterContext; semanticValidatorVersion: number; expectedHeadSha: string }> {
  const node = revision.workflow.nodes.find((candidate) => candidate.id === effect.nodeId);
  const resolved = revision.compiled.resolved_nodes.find((candidate) => candidate.node_id === effect.nodeId);
  if (!node || node.kind !== "effect" || !resolved) {
    throw errors.persistenceFailed(
      "The effect projection has no exact immutable workflow component.",
      "Stop reconciliation and inspect the run revision/effect binding.",
      { effect_id: effect.id },
    );
  }
  if (
    node.component.id !== effect.componentId ||
    node.component.version !== effect.componentVersion ||
    resolved.component_hash !== effect.componentHash
  ) {
    throw errors.persistenceFailed(
      "The effect projection component differs from its immutable revision.",
      "Stop reconciliation; never substitute a current component or adapter.",
      { effect_id: effect.id },
    );
  }
  const inputs = Object.fromEntries(Object.entries(node.inputs).map(([port, reference]) => {
    const output = state.outputs[reference.node_id];
    if (!output) {
      throw errors.persistenceFailed(
        `The exact same-run adapter input ${port} is missing.`,
        "Stop reconciliation and inspect strict workflow replay.",
        { effect_id: effect.id, producer_node_id: reference.node_id },
      );
    }
    return [port, {
      contract: output.contract,
      payload: output.payload,
      payload_hash: output.payload_hash,
    }];
  }));
  const adapter = await requireAutomationWorkflowComponentAdapter({
    ...node.component,
    component_hash: resolved.component_hash,
  });
  if (!adapter.reconciliation_policy || adapter.reconciliation_policy.provider !== "github") {
    reconciliationError(
      409,
      "automation_workflow_effect_not_reconcilable",
      "The exact effect adapter has no reviewed independent reconciliation policy.",
      "Leave the effect unchanged and use its owning runtime adapter or manual provider follow-up.",
      { effect_id: effect.id },
    );
  }
  const proposal = jsonObject(inputs.proposal?.payload as AutomationWorkflowJsonValue, "The approved proposal input");
  const expectedHeadSha = proposal.head_sha;
  if (typeof expectedHeadSha !== "string" || !GIT_SHA.test(expectedHeadSha)) {
    throw errors.persistenceFailed(
      "The approved proposal has no valid frozen head SHA.",
      "Stop reconciliation and inspect the immutable proposal output.",
      { effect_id: effect.id },
    );
  }
  return {
    context: {
      project_id: runProjectId(state, effect),
      node_id: effect.nodeId,
      component: node.component,
      component_hash: resolved.component_hash,
      runner: revision.workflow.runner,
      config: node.config,
      inputs,
      intent: {
        intent_hash: effect.intentHash,
        provider_target: effect.providerTarget,
      },
      at,
    },
    semanticValidatorVersion: adapter.semantic_validator_version,
    expectedHeadSha,
  };
}

function frozenReconciliationPolicy(value: unknown): AutomationWorkflowEffectReconciliationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("frozen reconciliation policy is not an object");
  }
  const policy = value as Record<string, unknown>;
  assertExactKeys(policy, [
    "protocol_version",
    "strategy",
    "provider",
    "stable_operation_key",
    "native_provider_idempotency",
    "provider_intent_marker_required",
    "absence_consistency_window_seconds",
    "backoff_source",
    "max_automatic_reconciliations",
    "max_provider_call_attempts",
    "outcomes",
    "absence_before_consistency_window",
    "retry_after_definitive_absence",
    "ambiguous_outcome",
    "exhausted_outcome",
    "absence_evidence_required",
  ], "frozen reconciliation policy");
  if (
    policy.protocol_version !== "1" ||
    policy.strategy !== "provider_lookup_before_retry" ||
    policy.provider !== "github" ||
    policy.stable_operation_key !== "intent_hash" ||
    policy.native_provider_idempotency !== false ||
    policy.provider_intent_marker_required !== true ||
    !Number.isSafeInteger(policy.absence_consistency_window_seconds) ||
    (policy.absence_consistency_window_seconds as number) < 0 ||
    policy.backoff_source !== "frozen_workflow_limit" ||
    !Number.isSafeInteger(policy.max_automatic_reconciliations) ||
    (policy.max_automatic_reconciliations as number) < 1 ||
    !Number.isSafeInteger(policy.max_provider_call_attempts) ||
    (policy.max_provider_call_attempts as number) < 1 ||
    canonicalJsonStringify(policy.outcomes) !== canonicalJsonStringify(["found", "definitively_absent", "unknown"]) ||
    policy.absence_before_consistency_window !== "unknown" ||
    policy.retry_after_definitive_absence !== "manual_follow_up_no_provider_retry" ||
    policy.ambiguous_outcome !== "indeterminate" ||
    policy.exhausted_outcome !== "manual_follow_up" ||
    policy.absence_evidence_required !== true
  ) {
    throw new Error("frozen reconciliation policy has unreviewed semantics");
  }
  return policy as unknown as AutomationWorkflowEffectReconciliationPolicy;
}

async function loadFrozenReconciliationPolicy(
  tx: Transaction,
  effect: Effect,
  semanticValidatorVersion: number,
): Promise<AutomationWorkflowEffectReconciliationPolicy> {
  const created = (
    await tx.select().from(automationWorkflowEffectEvents).where(and(
      eq(automationWorkflowEffectEvents.id, effect.createdEventId),
      eq(automationWorkflowEffectEvents.effectId, effect.id),
    )).limit(1)
  )[0] ?? null;
  if (!created || created.sequence !== 1 || created.event !== "effect.intent_reserved") {
    throw errors.persistenceFailed(
      "The effect projection has no exact immutable intent-reservation policy event.",
      "Stop reconciliation and rebuild the effect root from its first ledger event.",
      { effect_id: effect.id },
    );
  }
  const payload = parseObject(created.payloadJson, "effect intent-reservation payload");
  if (await sha256Hex(canonicalJsonStringify(payload)) !== created.payloadHash) {
    throw errors.persistenceFailed(
      "The immutable effect intent-reservation payload hash is invalid.",
      "Stop reconciliation and inspect the effect ledger root.",
      { effect_id: effect.id, effect_event_id: created.id },
    );
  }
  const frozen = payload.frozen_adapter_policy;
  if (!frozen || typeof frozen !== "object" || Array.isArray(frozen)) {
    throw errors.persistenceFailed(
      "The effect intent did not freeze its adapter reconciliation policy.",
      "Require manual follow-up; never adopt current adapter policy retroactively.",
      { effect_id: effect.id },
    );
  }
  const frozenObject = frozen as Record<string, unknown>;
  try {
    assertExactKeys(frozenObject, [
      "protocol_version",
      "semantic_validator_version",
      "reconciliation_policy",
    ], "frozen adapter policy");
    if (
      frozenObject.protocol_version !== "1" ||
      !Number.isSafeInteger(frozenObject.semantic_validator_version) ||
      frozenObject.semantic_validator_version !== semanticValidatorVersion
    ) {
      throw new Error("semantic validator version drift");
    }
    const frozenHash = await sha256Hex(canonicalJsonStringify(frozenObject));
    if (payload.frozen_adapter_policy_hash !== frozenHash) throw new Error("frozen policy hash mismatch");
    const policy = frozenReconciliationPolicy(frozenObject.reconciliation_policy);
    if (
      effect.maxCallAttempts !== policy.max_provider_call_attempts ||
      effect.maxCallAttempts !== 1 ||
      effect.maxReconciliations !== policy.max_automatic_reconciliations ||
      effect.maxReconciliations !== 3
    ) {
      throw new Error("effect policy projection drift");
    }
    return policy;
  } catch {
    throw errors.persistenceFailed(
      "The frozen adapter reconciliation policy or its semantic-validator binding is invalid.",
      "Stop reconciliation and require manual follow-up; never infer authority from a newer adapter.",
      { effect_id: effect.id },
    );
  }
}

function runProjectId(state: AutomationWorkflowRunState, effect: Effect): string {
  if (state.project_id !== effect.projectId || state.run_id !== effect.runId || state.automation_id !== effect.automationId) {
    throw errors.persistenceFailed(
      "The effect identity differs from the strictly replayed run.",
      "Stop reconciliation and inspect the effect projection/root binding.",
      { effect_id: effect.id },
    );
  }
  return state.project_id;
}

function validateEvidence(
  input: ReconcileAutomationWorkflowEffectInput,
  effect: Effect,
  expectedHeadSha: string,
  now: number,
): void {
  const evidence = input.evidence;
  if (
    evidence.provider_operation_key !== effect.providerOperationKey ||
    evidence.provider_operation_key !== effect.intentHash ||
    evidence.provider_target !== effect.providerTarget ||
    evidence.intent_marker !== effect.intentHash ||
    evidence.expected_head_sha.toLowerCase() !== expectedHeadSha.toLowerCase()
  ) {
    reconciliationError(
      422,
      "automation_workflow_reconciliation_evidence_mismatch",
      "GitHub lookup evidence is not bound to the exact durable operation, target, intent marker, and approved head SHA.",
      "Discard the lookup. Query GitHub only for the frozen effect identity and retry with a new idempotency key.",
      { effect_id: effect.id },
    );
  }
  if (
    effect.callStartedAt === null ||
    evidence.lookup_started_at < effect.callStartedAt ||
    evidence.lookup_completed_at < evidence.lookup_started_at ||
    evidence.lookup_completed_at > now ||
    evidence.lookup_completed_at - evidence.lookup_started_at > MAX_PROVIDER_LOOKUP_SECONDS
  ) {
    reconciliationError(
      422,
      "automation_workflow_reconciliation_time_evidence_invalid",
      "GitHub lookup times are not a bounded post-call-start interval completed before the server-owned receipt time.",
      "Repeat the exact provider lookup and record its bounded start/completion times.",
      { effect_id: effect.id },
    );
  }
  const expectedLookupResult = input.outcome === "found"
    ? "found"
    : input.outcome === "definitively_absent"
      ? "not_found"
      : "unknown";
  if (evidence.lookup_result !== expectedLookupResult) {
    reconciliationError(
      422,
      "automation_workflow_reconciliation_result_mismatch",
      "The requested reconciliation outcome does not match the exact GitHub lookup result.",
      "Use found for one exact match, definitively_absent for a completed zero-match lookup, or unknown for an inconclusive lookup.",
      { effect_id: effect.id },
    );
  }
  if (
    (input.outcome === "found" && !evidence.matched_provider_ref) ||
    (input.outcome !== "found" && evidence.matched_provider_ref !== null)
  ) {
    reconciliationError(
      422,
      "automation_workflow_reconciliation_provider_ref_invalid",
      "GitHub lookup evidence has an invalid matched provider reference for its outcome.",
      "Bind found to exactly one PR URL; bind absent and unknown to no provider reference.",
      { effect_id: effect.id },
    );
  }
}

async function effectEventId(input: {
  prior_event_hash: string;
  effect_id: string;
  sequence: number;
  event: string;
  effect_attempt: number;
  reconciliation_count: number;
  payload_hash: string;
  actor: AutomationWorkflowEffectReconciliationActor;
  at: number;
}): Promise<string> {
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-effect-event-v1",
    ...input,
    lease_epoch: null,
  }));
}

function durableReceipt(value: unknown): DurableReconciliationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing reconciliation receipt");
  const receipt = value as Record<string, unknown>;
  if (
    receipt.kind !== "automation_workflow_effect_reconciliation_receipt" ||
    receipt.schema_version !== "1" ||
    receipt.provider_call_authorized !== false ||
    typeof receipt.request_hash !== "string" ||
    !SHA256_HEX.test(receipt.request_hash)
  ) {
    throw new Error("invalid reconciliation receipt");
  }
  return receipt as DurableReconciliationReceipt;
}

async function replayReceipt(
  row: EffectEvent,
  requestHash: string,
): Promise<AutomationWorkflowEffectReconciliationReceipt> {
  const payload = parseObject(row.payloadJson, "effect reconciliation event payload");
  const payloadHash = await sha256Hex(canonicalJsonStringify(payload));
  if (payloadHash !== row.payloadHash || payload.request_hash !== requestHash) {
    if (payloadHash === row.payloadHash && typeof payload.request_hash === "string") {
      reconciliationError(
        409,
        "automation_workflow_reconciliation_idempotency_key_reused",
        "The effect reconciliation idempotency key is already bound to a different outcome, evidence, output, or actor.",
        "Replay the exact original request or use a new key for a genuinely new provider lookup.",
        { effect_id: row.effectId },
      );
    }
    throw errors.persistenceFailed(
      "The persisted effect reconciliation receipt hash is invalid.",
      "Stop reconciliation and inspect the immutable effect ledger.",
      { effect_id: row.effectId, effect_event_id: row.id },
    );
  }
  const expectedId = await effectEventId({
    prior_event_hash: row.priorEventHash!,
    effect_id: row.effectId,
    sequence: row.sequence,
    event: row.event,
    effect_attempt: row.effectAttempt,
    reconciliation_count: row.reconciliationCount,
    payload_hash: row.payloadHash,
    actor: {
      principal: row.actorPrincipal as AutomationWorkflowEffectReconciliationActor["principal"],
      credential_id: row.actorCredentialId as never,
    },
    at: row.at,
  });
  if (expectedId !== row.id) {
    throw errors.persistenceFailed(
      "The persisted effect reconciliation event id does not match its immutable envelope.",
      "Stop reconciliation and inspect the effect hash chain.",
      { effect_id: row.effectId, effect_event_id: row.id },
    );
  }
  let receipt: DurableReconciliationReceipt;
  try {
    receipt = durableReceipt(payload.reconciliation_receipt);
  } catch {
    throw errors.persistenceFailed(
      "The persisted effect reconciliation event has no valid durable receipt.",
      "Stop reconciliation and inspect the immutable effect ledger.",
      { effect_id: row.effectId, effect_event_id: row.id },
    );
  }
  return {
    ...receipt,
    effect_event_id: row.id,
    effect_event_sequence: row.sequence,
    idempotent_replay: true,
  };
}

async function existingReceipt(
  tx: Transaction,
  effectId: string,
  idempotencyKeyHash: string,
  requestHash: string,
): Promise<AutomationWorkflowEffectReconciliationReceipt | null> {
  const row = (
    await tx.select().from(automationWorkflowEffectEvents).where(and(
      eq(automationWorkflowEffectEvents.effectId, effectId),
      eq(automationWorkflowEffectEvents.idempotencyKeyHash, idempotencyKeyHash),
    )).limit(1)
  )[0] ?? null;
  return row ? replayReceipt(row, requestHash) : null;
}

/**
 * Reconcile one already-started GitHub effect from exact provider evidence.
 * Nonterminal runs advance workflow/effect ledgers atomically; a closed
 * authority additionally quarantines after settlement. Only an already-
 * terminal run uses detached effect-only settlement. No branch reauthorizes a
 * provider call.
 */
export async function reconcileAutomationWorkflowEffect(
  db: Db,
  input: ReconcileAutomationWorkflowEffectInput,
): Promise<AutomationWorkflowEffectReconciliationReceipt> {
  validateEnvelope(input);
  const idempotencyKeyHash = await automationWorkflowEffectReconciliationIdempotencyHash(
    input.effect_id,
    input.idempotency_key,
  );
  const requestHash = await reconciliationRequestHash(input);

  return db.transaction(async (tx) => {
    const effect = (
      await tx.select().from(automationWorkflowEffects).where(and(
        eq(automationWorkflowEffects.id, input.effect_id),
        eq(automationWorkflowEffects.projectId, input.project_id),
      )).limit(1)
    )[0] ?? null;
    if (!effect) throw errors.notFound("automation_workflow_effect");
    // Exact response-loss recovery is a read of an already-authorized immutable
    // receipt. It remains available after kill switches, credential expiry or
    // revocation (through another active project-bound trusted-CI credential),
    // and deletion write fences close new mutation authority. Revoked bearer
    // tokens are never accepted at the HTTP authentication boundary.
    const replay = await existingReceipt(tx, input.effect_id, idempotencyKeyHash, requestHash);
    if (replay) return replay;
    const now = await databaseNow(tx, input.observed_at);
    await assertAutomationWritesOpen(tx as unknown as Db, effect.projectId);
    if (input.actor.principal === "trusted_ci") {
      const credential = (
        await tx.select({ id: projectCredentials.id }).from(projectCredentials).where(and(
          eq(projectCredentials.id, input.actor.credential_id),
          eq(projectCredentials.projectId, effect.projectId),
          eq(projectCredentials.kind, "ci_deploy"),
          isNull(projectCredentials.revokedAt),
          gt(projectCredentials.expiresAt, now),
          notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
        )).limit(1)
      )[0] ?? null;
      if (!credential) {
        reconciliationError(
          403,
          "automation_workflow_reconciliation_ci_credential_invalid",
          "Trusted-CI reconciliation requires one exact active project-bound ci_deploy credential.",
          "Authenticate with the unrevoked, unexpired AGENTRY_CI_API_KEY for this effect project; never submit a caller-selected credential id.",
          { effect_id: effect.id, credential_id: input.actor.credential_id },
        );
      }
    }
    if (effect.status !== "indeterminate" || effect.callAttempt < 1 || effect.callStartedAt === null) {
      reconciliationError(
        409,
        "automation_workflow_effect_not_indeterminate",
        `The exact effect is already ${effect.status} and cannot accept a new reconciliation event.`,
        "Return its existing receipt or manual-follow-up state; never authorize or repeat the provider call.",
        { effect_id: effect.id, status: effect.status },
      );
    }
    if (effect.reconcileAfterAt === null || now < effect.reconcileAfterAt) {
      reconciliationError(
        409,
        "automation_workflow_effect_reconciliation_not_due",
        "The frozen effect reconciliation backoff has not elapsed.",
        "Wait until next_reconcile_at, then perform one exact provider lookup with a new idempotency key.",
        { effect_id: effect.id, next_reconcile_at: effect.reconcileAfterAt },
      );
    }
    const run = (
      await tx.select().from(automationWorkflowRuns).where(
        eq(automationWorkflowRuns.id, effect.runId),
      ).limit(1)
    )[0] ?? null;
    if (!run) throw errors.notFound("automation_workflow_run");
    const revision = await loadAutomationWorkflowRevision(
      tx as unknown as Db,
      run.projectId,
      run.workflowRevisionId,
    );
    if (!revision) throw errors.notFound("automation_workflow_revision");
    if (
      run.projectId !== effect.projectId ||
      run.automationId !== effect.automationId ||
      run.workflowHash !== revision.workflow_hash ||
      run.compileHash !== revision.compile_hash ||
      run.automationId !== revision.automation_id ||
      run.limitsJson !== canonicalJsonStringify(revision.workflow.limits) ||
      run.limitsHash !== await sha256Hex(run.limitsJson)
    ) {
      throw errors.persistenceFailed(
        "The effect, run root, and immutable workflow revision do not share one exact policy binding.",
        "Stop reconciliation and inspect the immutable root/revision hashes.",
        { effect_id: effect.id, run_id: run.id },
      );
    }
    const state = await loadStrictRunState(tx, run, revision);
    const authority = await readAutomationWorkflowAuthority(
      tx,
      run.projectId,
      run.automationId,
      run.workflowRevisionId,
      run.runnerCredentialId,
      run.executionAuthorityId,
    );
    const { context, semanticValidatorVersion, expectedHeadSha } = await adapterContext(revision, state, effect, now);
    const policy = await loadFrozenReconciliationPolicy(tx, effect, semanticValidatorVersion);
    validateEvidence(input, effect, expectedHeadSha, now);
    let output: AutomationWorkflowJsonValue | null = null;
    let outputHash: string | null = null;
    if (input.outcome === "found") {
      const materializedOutput = input.output &&
          typeof input.output === "object" &&
          !Array.isArray(input.output)
        ? {
            ...(input.output as Record<string, unknown>),
            recorded_at: now,
          }
        : input.output;
      const validated = await validateAutomationWorkflowAdapterOutput(context, materializedOutput);
      if (!validated.success) {
        reconciliationError(
          422,
          "automation_workflow_reconciliation_output_invalid",
          "The found GitHub receipt violates the exact immutable adapter bindings.",
          "Discard the receipt and repeat the provider lookup for the frozen intent, proposal, repository, and head SHA.",
          { effect_id: effect.id, issues: validated.issues },
        );
      }
      output = validated.output;
      outputHash = validated.output_hash;
      const outputObject = jsonObject(output, "The found provider receipt");
      if (
        outputObject.pr_url !== input.evidence.matched_provider_ref ||
        String(outputObject.head_sha).toLowerCase() !== input.evidence.expected_head_sha.toLowerCase()
      ) {
        reconciliationError(
          422,
          "automation_workflow_reconciliation_match_mismatch",
          "The validated provider receipt does not match the exact GitHub lookup reference and head evidence.",
          "Discard the lookup and receipt; do not choose between multiple or mismatched PRs.",
          { effect_id: effect.id },
        );
      }
    }
    const transition = planAutomationWorkflowEffectReconciliation({
      requested_outcome: input.outcome,
      reconciliation_count: effect.reconciliationCount,
      max_reconciliations: effect.maxReconciliations,
      call_started_at: effect.callStartedAt,
      now,
      retry_backoff_seconds: revision.workflow.limits.retry_backoff_seconds,
      backoff_deadline_at: TERMINAL_RUN_STATUSES.has(state.status) ? undefined : state.elapsed_deadline_at,
      absence_consistency_window_seconds: policy.absence_consistency_window_seconds,
    });
    const evidenceJson = canonicalJsonStringify(input.evidence);
    const evidenceHash = await sha256Hex(evidenceJson);
    const durable: DurableReconciliationReceipt = {
      kind: "automation_workflow_effect_reconciliation_receipt",
      schema_version: "1",
      project_id: effect.projectId,
      automation_id: effect.automationId,
      run_id: effect.runId,
      effect_id: effect.id,
      node_id: effect.nodeId,
      intent_hash: effect.intentHash,
      request_hash: requestHash,
      requested_outcome: input.outcome,
      effective_outcome: transition.effective_outcome,
      effect_status: transition.status,
      reconciliation_count: transition.reconciliation_count,
      next_reconcile_at: transition.next_reconcile_at,
      provider_ref: input.outcome === "found" ? input.evidence.matched_provider_ref : null,
      receipt_hash: outputHash,
      provider_call_authorized: false,
    };
    const payload = {
      protocol_version: "1",
      intent_hash: effect.intentHash,
      request_hash: requestHash,
      requested_outcome: input.outcome,
      effective_outcome: transition.effective_outcome,
      provider: "github",
      provider_operation_key: effect.providerOperationKey,
      provider_target: effect.providerTarget,
      evidence_hash: evidenceHash,
      evidence: input.evidence,
      output,
      output_hash: outputHash,
      next_reconcile_at: transition.next_reconcile_at,
      reconciliation_receipt: durable,
    } satisfies Record<string, AutomationWorkflowJsonValue>;

    if (!TERMINAL_RUN_STATUSES.has(state.status)) {
      const runtimeOutcome: "found" | "absent" | "unknown" = transition.effective_outcome === "definitively_absent"
        ? "absent"
        : transition.effective_outcome;
      const command: Extract<AutomationWorkflowRuntimeCommand, { kind: "effect_reconciled" }> = {
        kind: "effect_reconciled" as const,
        command_id: `effect-reconcile:${idempotencyKeyHash}`,
        expected_revision: state.revision,
        node_id: effect.nodeId,
        intent_hash: effect.intentHash,
        outcome: runtimeOutcome,
        ...(runtimeOutcome === "found" ? { output } : {}),
        at: now,
        actor: input.actor,
      };
      await persistAutomationWorkflowEvidenceBoundReconciliation(tx, {
        run,
        revision,
        prior_state: state,
        command,
        request_hash: requestHash,
        halt_after_effect_settlement_reason: authority.open ? undefined : "kill_switch_active",
        effect_ledger: {
          idempotency_key_hash: idempotencyKeyHash,
          expected_event: transition.event,
          reconciliation_payload: payload,
        },
      });
      const committed = await existingReceipt(tx, effect.id, idempotencyKeyHash, requestHash);
      if (!committed) {
        throw errors.persistenceFailed(
          "The atomic reconciliation command committed without its bound effect-ledger receipt.",
          "Roll back both ledgers and inspect the dedicated reconciliation bridge.",
          { effect_id: effect.id, run_id: run.id },
        );
      }
      return { ...committed, idempotent_replay: false };
    }

    // Once the workflow is already terminal, only the effect ledger remains
    // mutable. Detached settlement cannot revive or rewrite terminal history.
    const prior = (
      await tx.select().from(automationWorkflowEffectEvents).where(
        eq(automationWorkflowEffectEvents.effectId, effect.id),
      ).orderBy(desc(automationWorkflowEffectEvents.sequence)).limit(1)
    )[0] ?? null;
    if (!prior || prior.id !== effect.lastEventId) {
      throw errors.persistenceFailed(
        "The effect projection does not point to the current immutable effect-event tail.",
        "Stop reconciliation and rebuild the effect projection from its hash chain.",
        { effect_id: effect.id },
      );
    }
    const payloadJson = canonicalJsonStringify(payload);
    const payloadHash = await sha256Hex(payloadJson);
    const sequence = prior.sequence + 1;
    const id = await effectEventId({
      prior_event_hash: prior.id,
      effect_id: effect.id,
      sequence,
      event: transition.event,
      effect_attempt: effect.callAttempt,
      reconciliation_count: transition.reconciliation_count,
      payload_hash: payloadHash,
      actor: input.actor,
      at: now,
    });
    const inserted = await tx.insert(automationWorkflowEffectEvents).values({
      id,
      idempotencyKeyHash,
      priorEventHash: prior.id,
      effectId: effect.id,
      projectId: effect.projectId,
      automationId: effect.automationId,
      runId: effect.runId,
      sequence,
      event: transition.event,
      effectAttempt: effect.callAttempt,
      reconciliationCount: transition.reconciliation_count,
      leaseEpoch: null,
      payloadJson,
      payloadHash,
      actorPrincipal: input.actor.principal,
      actorCredentialId: input.actor.credential_id,
      at: now,
    }).onConflictDoNothing().returning({ id: automationWorkflowEffectEvents.id });
    if (inserted.length !== 1) {
      const concurrent = await existingReceipt(tx, effect.id, idempotencyKeyHash, requestHash);
      if (concurrent) return concurrent;
      reconciliationError(
        409,
        "automation_workflow_effect_reconciliation_contention",
        "Another reconciler advanced the exact effect hash chain first.",
        "Read the current effect and retry only if another bounded lookup remains due.",
        { effect_id: effect.id },
      );
    }
    const projectionValues: Partial<typeof automationWorkflowEffects.$inferInsert> = {
      version: effect.version + 1,
      lastEventId: id,
      status: transition.status,
      reconciliationCount: transition.reconciliation_count,
      reconcileAfterAt: transition.next_reconcile_at,
      updatedAt: now,
    };
    if (transition.status === "succeeded") {
      projectionValues.providerRef = input.evidence.matched_provider_ref;
      projectionValues.receiptJson = canonicalJsonStringify(output);
      projectionValues.receiptHash = outputHash;
      projectionValues.completedAt = now;
    }
    const changed = await tx.update(automationWorkflowEffects).set(projectionValues).where(and(
      eq(automationWorkflowEffects.id, effect.id),
      eq(automationWorkflowEffects.version, effect.version),
      eq(automationWorkflowEffects.lastEventId, effect.lastEventId),
      eq(automationWorkflowEffects.status, "indeterminate"),
    )).returning({ id: automationWorkflowEffects.id });
    if (changed.length !== 1) {
      throw errors.conflict(
        "automation_workflow_effect_reconciliation_contention",
        "Another reconciler changed the exact effect projection before commit.",
        "Read the current effect and retry only if another bounded lookup remains due.",
        { effect_id: effect.id },
      );
    }
    return {
      ...durable,
      effect_event_id: id,
      effect_event_sequence: sequence,
      idempotent_replay: false,
    };
  });
}
