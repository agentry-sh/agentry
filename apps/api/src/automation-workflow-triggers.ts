import {
  and,
  asc,
  desc,
  eq,
  gt,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  automationWorkflowRuns,
  automationWorkflowTriggerReceipts,
  cases,
  posthogConnections,
} from "@agentry/db/schema";
import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
  uuidv7,
  type AutomationWorkflowJsonValue,
} from "@agentrysh/shared";
import type { getDb } from "./db.js";
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "./automation-deletion-boundary.js";
import {
  assertAutomationWorkflowAuthorityOpen,
  readAutomationWorkflowAuthority,
} from "./automation-workflow-controls.js";
import { validateAutomationWorkflowPayload } from "./automation-workflow-contracts.js";
import {
  loadAutomationWorkflow,
  type StoredAutomationWorkflow,
} from "./automation-workflow-store.js";
import { findLatestScheduleOccurrence } from "./automation-trigger-orchestration.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Db | Transaction;
type ReceiptRow = typeof automationWorkflowTriggerReceipts.$inferSelect;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const WORKFLOW_ID = /^[a-z][a-z0-9_-]{0,99}$/u;
const CASE_RECEIPT_LIFETIME_SECONDS = 3_600;

export type AutomationWorkflowTriggerReceiptStatus =
  | "ready"
  | "consumed"
  | "expired"
  | "cancelled";

export type AutomationWorkflowTriggerReceipt = {
  kind: "automation_workflow_trigger_receipt";
  schema_version: "1";
  receipt_id: string;
  project_id: string;
  automation_id: string;
  workflow_revision_id: string;
  workflow_hash: string;
  compile_hash: string;
  execution_authority_id: string;
  trigger_node_id: string;
  component: {
    id: "trigger.cases.unhandled" | "trigger.schedule.cron";
    version: string;
    component_hash: string;
    output_contract: "case_trigger_receipt@1" | "schedule_trigger_receipt@1";
    output_schema_hash: string;
  };
  trigger_kind: "case" | "schedule";
  trigger_key: string;
  attempt: number;
  trigger_output: Record<string, AutomationWorkflowJsonValue>;
  trigger_output_hash: string;
  source_trust: "customer_posthog" | "agentry_system";
  status: AutomationWorkflowTriggerReceiptStatus;
  consumed_run_id: string | null;
  issued_at: number;
  available_at: number;
  expires_at: number;
  consumed_at: number | null;
  cancelled_at: number | null;
  cancel_reason: string | null;
  updated_at: number;
  next_action: string;
};

export type AutomationWorkflowTriggerIssuanceResult = {
  kind: "automation_workflow_trigger_issuance";
  schema_version: "1";
  project_id: string;
  automation_id: string;
  workflow_revision_id: string;
  trigger_kind: "case" | "schedule";
  receipts: AutomationWorkflowTriggerReceipt[];
  issued_count: number;
  replayed_count: number;
  skipped: Array<{
    code: string;
    reason: string;
    details?: Record<string, AutomationWorkflowJsonValue>;
  }>;
  next_action: string;
};

export type AutomationWorkflowTriggerStartAuthority = {
  outcome: "ready";
  receipt: AutomationWorkflowTriggerReceipt;
  workflow_revision_id: string;
  workflow_hash: string;
  compile_hash: string;
  execution_authority_id: string;
  trigger_kind: "case" | "schedule";
  trigger_key: string;
  attempt: number;
  trigger_output: Record<string, AutomationWorkflowJsonValue>;
  trigger_output_json: string;
  trigger_output_hash: string;
};

export type AutomationWorkflowTriggerStartLookup =
  | AutomationWorkflowTriggerStartAuthority
  | {
      outcome: "consumed";
      receipt: AutomationWorkflowTriggerReceipt;
      consumed_run_id: string;
    };

export type ConsumeAutomationWorkflowTriggerReceiptResult = {
  receipt: AutomationWorkflowTriggerReceipt;
  consumed_run_id: string;
  idempotent_replay: boolean;
};

type TriggerDescriptor = {
  node_id: string;
  component_id: "trigger.cases.unhandled" | "trigger.schedule.cron";
  component_version: string;
  component_hash: string;
  output_contract: "case_trigger_receipt@1" | "schedule_trigger_receipt@1";
  output_schema_hash: string;
  config: Record<string, AutomationWorkflowJsonValue>;
};

function validateSelector(projectId: string, automationId: string): void {
  if (!ID.test(projectId)) {
    throw errors.invalidPayload({ reason: "project_id is invalid" });
  }
  if (!WORKFLOW_ID.test(automationId)) {
    throw errors.invalidPayload({ reason: "automation_id is invalid" });
  }
}

function validateReceiptId(receiptId: string): void {
  if (!ID.test(receiptId)) {
    throw errors.invalidPayload({ reason: "trigger_receipt_id is invalid" });
  }
}

async function databaseNow(db: ReadDb, observedAt?: number): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("database clock did not return unix seconds");
  }
  if (observedAt === undefined) return now;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0 || Math.abs(observedAt - now) > 1) {
    throw errors.invalidPayload({
      reason: "observed_at must be a nonnegative integer matching the database clock within one second",
    });
  }
  return now;
}

function triggerDescriptor(workflow: StoredAutomationWorkflow): TriggerDescriptor {
  const node = workflow.workflow.nodes.find((candidate) => candidate.id === workflow.workflow.entry);
  const resolved = workflow.compiled.resolved_nodes.find(
    (candidate) => candidate.node_id === workflow.workflow.entry,
  );
  if (!node || node.kind !== "trigger" || !resolved) {
    throw errors.persistenceFailed(
      "The active workflow entry is not an exact resolved trigger node.",
      "Pause the workflow and save a newly compiled immutable revision before issuing receipts.",
      { automation_id: workflow.automation_id, revision_id: workflow.revision_id },
    );
  }
  const componentId = node.component.id;
  const outputContract = resolved.output_contract;
  if (
    (componentId !== "trigger.cases.unhandled" && componentId !== "trigger.schedule.cron") ||
    (outputContract !== "case_trigger_receipt@1" && outputContract !== "schedule_trigger_receipt@1") ||
    (componentId === "trigger.cases.unhandled" && outputContract !== "case_trigger_receipt@1") ||
    (componentId === "trigger.schedule.cron" && outputContract !== "schedule_trigger_receipt@1")
  ) {
    throw errors.persistenceFailed(
      "The active workflow trigger component and output contract do not form an installed authority pair.",
      "Pause the workflow and compile it against the installed trigger catalog.",
      { automation_id: workflow.automation_id, node_id: node.id },
    );
  }
  return {
    node_id: node.id,
    component_id: componentId,
    component_version: node.component.version,
    component_hash: resolved.component_hash,
    output_contract: outputContract,
    output_schema_hash: resolved.output_contract_schema_hash,
    config: node.config as Record<string, AutomationWorkflowJsonValue>,
  };
}

async function canonicalTriggerOutput(
  contract: TriggerDescriptor["output_contract"],
  payload: unknown,
): Promise<{ payload: Record<string, AutomationWorkflowJsonValue>; json: string; hash: string }> {
  const validated = await validateAutomationWorkflowPayload(contract, payload);
  if (!validated.success) {
    throw errors.persistenceFailed(
      "The server-derived trigger output failed its frozen workflow contract.",
      "Keep the workflow disabled and repair the trigger adapter before issuing another receipt.",
      { contract, issues: validated.issues },
    );
  }
  if (!validated.payload || typeof validated.payload !== "object" || Array.isArray(validated.payload)) {
    throw new Error("trigger contract accepted a non-object payload");
  }
  const json = canonicalJsonStringify(validated.payload);
  return {
    payload: validated.payload as Record<string, AutomationWorkflowJsonValue>,
    json,
    hash: validated.payload_hash,
  };
}

async function receiptFromRow(row: ReceiptRow): Promise<AutomationWorkflowTriggerReceipt> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch {
    parsed = null;
  }
  const canonical = await canonicalTriggerOutput(
    row.outputContract as TriggerDescriptor["output_contract"],
    parsed,
  );
  if (canonical.json !== row.payloadJson || canonical.hash !== row.payloadHash) {
    throw errors.persistenceFailed(
      "The workflow trigger receipt payload differs from its canonical persisted hash.",
      "Do not start a run. Pause the workflow and inspect the immutable trigger authority row.",
      { receipt_id: row.id },
    );
  }
  if (!row.executionAuthorityId) {
    throw errors.persistenceFailed(
      "The workflow trigger receipt has no durable execution authority.",
      "Do not start a run. Pause the workflow and request a new receipt only after a fresh reviewed enablement.",
      { receipt_id: row.id },
    );
  }
  return {
    kind: "automation_workflow_trigger_receipt",
    schema_version: "1",
    receipt_id: row.id,
    project_id: row.projectId,
    automation_id: row.automationId,
    workflow_revision_id: row.workflowRevisionId,
    workflow_hash: row.workflowHash,
    compile_hash: row.compileHash,
    execution_authority_id: row.executionAuthorityId,
    trigger_node_id: row.triggerNodeId,
    component: {
      id: row.componentId as TriggerDescriptor["component_id"],
      version: row.componentVersion,
      component_hash: row.componentHash,
      output_contract: row.outputContract as TriggerDescriptor["output_contract"],
      output_schema_hash: row.outputSchemaHash,
    },
    trigger_kind: row.triggerKind,
    trigger_key: row.triggerKey,
    attempt: row.attempt,
    trigger_output: canonical.payload,
    trigger_output_hash: row.payloadHash,
    source_trust: row.sourceTrust,
    status: row.status,
    consumed_run_id: row.consumedRunId,
    issued_at: row.issuedAt,
    available_at: row.availableAt,
    expires_at: row.expiresAt,
    consumed_at: row.consumedAt,
    cancelled_at: row.cancelledAt,
    cancel_reason: row.cancelReason,
    updated_at: row.updatedAt,
    next_action: receiptNextAction(row),
  };
}

function receiptNextAction(row: ReceiptRow): string {
  if (row.status === "ready") {
    return "Start exactly this receipt before expires_at with one stable Idempotency-Key; never construct or edit trigger_output.";
  }
  if (row.status === "consumed") {
    return `Read workflow run ${row.consumedRunId ?? "from consumed_run_id"}; retrying the exact start request must replay that run.`;
  }
  if (row.status === "expired") {
    return "Request another server eligibility sweep. Do not replay or alter this expired receipt.";
  }
  return "Inspect cancel_reason and the active workflow revision. Request a new server-issued receipt only after authority is restored.";
}

function receiptValues(
  workflow: StoredAutomationWorkflow,
  descriptor: TriggerDescriptor,
  input: {
    id: string;
    trigger_kind: "case" | "schedule";
    trigger_key: string;
    attempt: number;
    output: { json: string; hash: string };
    source_trust: "customer_posthog" | "agentry_system";
    issued_at: number;
    available_at: number;
    expires_at: number;
  },
): typeof automationWorkflowTriggerReceipts.$inferInsert {
  if (!workflow.active_execution_authority_id) {
    throw errors.persistenceFailed(
      "The active workflow head has no durable execution authority.",
      "Pause the workflow and explicitly enable a newly reviewed exact revision before issuing trigger receipts.",
      { automation_id: workflow.automation_id, revision_id: workflow.revision_id },
    );
  }
  return {
    id: input.id,
    projectId: workflow.project_id,
    automationId: workflow.automation_id,
    workflowRevisionId: workflow.revision_id,
    workflowHash: workflow.workflow_hash,
    compileHash: workflow.compile_hash,
    executionAuthorityId: workflow.active_execution_authority_id,
    triggerNodeId: descriptor.node_id,
    componentId: descriptor.component_id,
    componentVersion: descriptor.component_version,
    componentHash: descriptor.component_hash,
    outputContract: descriptor.output_contract,
    outputSchemaHash: descriptor.output_schema_hash,
    triggerKind: input.trigger_kind,
    triggerKey: input.trigger_key,
    attempt: input.attempt,
    payloadJson: input.output.json,
    payloadHash: input.output.hash,
    sourceTrust: input.source_trust,
    status: "ready",
    consumedRunId: null,
    issuedAt: input.issued_at,
    availableAt: input.available_at,
    expiresAt: input.expires_at,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    updatedAt: input.issued_at,
  };
}

async function insertReceiptIdempotently(
  tx: Transaction,
  values: typeof automationWorkflowTriggerReceipts.$inferInsert,
): Promise<{ row: ReceiptRow; inserted: boolean }> {
  try {
    await tx.insert(automationWorkflowTriggerReceipts).values(values).onConflictDoNothing();
  } catch (cause) {
    throw errors.conflict(
      "automation_workflow_trigger_authority_changed",
      "Workflow or source authority changed before the server-derived trigger receipt could commit.",
      "Reload the active workflow and request another eligibility sweep; do not synthesize trigger facts.",
      {
        project_id: values.projectId,
        automation_id: values.automationId,
        workflow_revision_id: values.workflowRevisionId,
        cause: cause instanceof Error ? cause.message : "trigger receipt insert rejected",
      },
    );
  }
  const winner = (
    await tx.select().from(automationWorkflowTriggerReceipts).where(and(
      eq(automationWorkflowTriggerReceipts.projectId, values.projectId),
      eq(automationWorkflowTriggerReceipts.automationId, values.automationId),
      eq(automationWorkflowTriggerReceipts.workflowRevisionId, values.workflowRevisionId),
      eq(automationWorkflowTriggerReceipts.triggerKey, values.triggerKey),
      eq(automationWorkflowTriggerReceipts.attempt, values.attempt),
    )).limit(1)
  )[0] ?? null;
  if (!winner) {
    throw errors.conflict(
      "automation_workflow_trigger_authority_changed",
      "No trigger receipt committed under the expected active workflow revision.",
      "Reload workflow authority and request another server eligibility sweep.",
      { automation_id: values.automationId, workflow_revision_id: values.workflowRevisionId },
    );
  }
  const exact =
    winner.workflowHash === values.workflowHash &&
    winner.compileHash === values.compileHash &&
    winner.executionAuthorityId === values.executionAuthorityId &&
    winner.componentHash === values.componentHash &&
    winner.outputSchemaHash === values.outputSchemaHash &&
    winner.payloadJson === values.payloadJson &&
    winner.payloadHash === values.payloadHash;
  if (!exact) {
    throw errors.conflict(
      "automation_workflow_trigger_occurrence_conflict",
      "This trigger occurrence and attempt are already bound to different immutable evidence.",
      "Do not reinterpret the occurrence. Read the existing receipt and its consumed_run_id or wait for a new source revision.",
      { receipt_id: winner.id, trigger_key: winner.triggerKey, attempt: winner.attempt },
    );
  }
  return { row: winner, inserted: winner.id === values.id };
}

async function expireReadyReceiptsInTransaction(
  tx: Transaction,
  projectId: string,
  automationId: string | undefined,
  now: number,
): Promise<number> {
  const rows = await tx.update(automationWorkflowTriggerReceipts).set({
    status: "expired",
    updatedAt: now,
  }).where(and(
    eq(automationWorkflowTriggerReceipts.projectId, projectId),
    automationId ? eq(automationWorkflowTriggerReceipts.automationId, automationId) : undefined,
    eq(automationWorkflowTriggerReceipts.status, "ready"),
    lte(automationWorkflowTriggerReceipts.expiresAt, now),
    automationWritesOpenForProject(automationWorkflowTriggerReceipts.projectId),
  )).returning({ id: automationWorkflowTriggerReceipts.id });
  return rows.length;
}

async function cancelStaleRevisionReceipts(
  tx: Transaction,
  workflow: StoredAutomationWorkflow,
  now: number,
): Promise<void> {
  await tx.update(automationWorkflowTriggerReceipts).set({
    status: "cancelled",
    cancelledAt: now,
    cancelReason: "active_revision_changed",
    updatedAt: now,
  }).where(and(
    eq(automationWorkflowTriggerReceipts.projectId, workflow.project_id),
    eq(automationWorkflowTriggerReceipts.automationId, workflow.automation_id),
    eq(automationWorkflowTriggerReceipts.status, "ready"),
    or(
      ne(automationWorkflowTriggerReceipts.workflowRevisionId, workflow.revision_id),
      ne(
        automationWorkflowTriggerReceipts.executionAuthorityId,
        workflow.active_execution_authority_id ?? "",
      ),
    ),
    automationWritesOpenForProject(automationWorkflowTriggerReceipts.projectId),
  ));
}

/**
 * Issue receipts from the database clock, active immutable workflow revision,
 * and trusted Agentry state only. The caller selects a workflow but cannot
 * provide a case id, revision, trust label, cron occurrence, or trigger body.
 */
export async function issueAutomationWorkflowTriggerReceipts(
  db: Db,
  input: { project_id: string; automation_id: string; observed_at?: number },
): Promise<AutomationWorkflowTriggerIssuanceResult> {
  validateSelector(input.project_id, input.automation_id);
  await assertAutomationWritesOpen(db, input.project_id);
  const workflow = await loadAutomationWorkflow(db, input.project_id, input.automation_id);
  if (!workflow) throw errors.notFound("automation_workflow");
  if (
    !workflow.enabled ||
    workflow.active_revision_id !== workflow.revision_id ||
    !workflow.active_execution_authority_id ||
    workflow.paused_at !== null
  ) {
    throw errors.conflict(
      "automation_workflow_disabled",
      "The workflow has no active unpaused revision from which trigger authority can be issued.",
      "Complete readiness, enable the exact reviewed revision, then request another server eligibility sweep.",
      { automation_id: input.automation_id, workflow_revision_id: workflow.revision_id },
    );
  }
  const descriptor = triggerDescriptor(workflow);
  return db.transaction(async (tx) => {
    const now = await databaseNow(tx, input.observed_at);
    await assertAutomationWritesOpen(tx as unknown as Db, input.project_id);
    await assertAutomationWorkflowAuthorityOpen(
      tx,
      workflow.project_id,
      workflow.automation_id,
      workflow.revision_id,
    );
    await expireReadyReceiptsInTransaction(tx, workflow.project_id, workflow.automation_id, now);
    await cancelStaleRevisionReceipts(tx, workflow, now);
    return descriptor.component_id === "trigger.schedule.cron"
      ? issueScheduleReceipt(tx, workflow, descriptor, now)
      : issueCaseReceipts(tx, workflow, descriptor, now);
  });
}

async function issueScheduleReceipt(
  tx: Transaction,
  workflow: StoredAutomationWorkflow,
  descriptor: TriggerDescriptor,
  now: number,
): Promise<AutomationWorkflowTriggerIssuanceResult> {
  const cron = descriptor.config.cron;
  const timezone = descriptor.config.timezone;
  const startWindowSeconds = descriptor.config.start_window_seconds;
  if (
    typeof cron !== "string" ||
    typeof timezone !== "string" ||
    !Number.isSafeInteger(startWindowSeconds) ||
    Number(startWindowSeconds) < 60
  ) {
    throw errors.persistenceFailed(
      "The active schedule trigger config is not executable.",
      "Pause the workflow and save a newly compiled revision with cron, timezone, and start_window_seconds.",
      { node_id: descriptor.node_id },
    );
  }
  const scheduledFor = findLatestScheduleOccurrence(
    cron,
    timezone,
    now,
    Number(startWindowSeconds),
  );
  if (scheduledFor === null) {
    return issuanceResult(workflow, "schedule", [], 0, 0, [{
      code: "schedule_not_due",
      reason: "No server-evaluated cron occurrence falls inside the configured half-open start window.",
    }]);
  }
  const triggerKey = `schedule:${scheduledFor}`;
  const existing = await rowsForTrigger(tx, workflow, triggerKey);
  const replay = existing.find((row) => row.status === "ready" || row.status === "consumed");
  if (replay) {
    return issuanceResult(workflow, "schedule", [await receiptFromRow(replay)], 0, 1, []);
  }
  const attempt = (existing[0]?.attempt ?? 0) + 1;
  if (attempt > workflow.workflow.limits.max_attempts_per_trigger) {
    return issuanceResult(workflow, "schedule", [], 0, 0, [{
      code: "trigger_attempt_budget_exhausted",
      reason: "The immutable per-occurrence attempt budget is exhausted.",
      details: { trigger_key: triggerKey, maximum: workflow.workflow.limits.max_attempts_per_trigger },
    }]);
  }
  const receiptId = `awtr_${uuidv7()}`;
  const output = await canonicalTriggerOutput(descriptor.output_contract, {
    receipt_id: receiptId,
    scheduled_for: scheduledFor,
    window_start: scheduledFor,
    window_end: scheduledFor + Number(startWindowSeconds),
    instruction_authority: "none",
  });
  const persisted = await insertReceiptIdempotently(tx, receiptValues(workflow, descriptor, {
    id: receiptId,
    trigger_kind: "schedule",
    trigger_key: triggerKey,
    attempt,
    output,
    source_trust: "agentry_system",
    issued_at: now,
    available_at: scheduledFor,
    expires_at: scheduledFor + Number(startWindowSeconds),
  }));
  return issuanceResult(
    workflow,
    "schedule",
    [await receiptFromRow(persisted.row)],
    persisted.inserted ? 1 : 0,
    persisted.inserted ? 0 : 1,
    [],
  );
}

async function issueCaseReceipts(
  tx: Transaction,
  workflow: StoredAutomationWorkflow,
  descriptor: TriggerDescriptor,
  now: number,
): Promise<AutomationWorkflowTriggerIssuanceResult> {
  const maxCases = descriptor.config.max_cases_per_sweep;
  const cooldownSeconds = descriptor.config.cooldown_seconds;
  if (
    !Number.isSafeInteger(maxCases) || Number(maxCases) < 1 ||
    !Number.isSafeInteger(cooldownSeconds) || Number(cooldownSeconds) < 60 ||
    descriptor.config.required_trust !== "customer_posthog"
  ) {
    throw errors.persistenceFailed(
      "The active case trigger config is not executable.",
      "Pause the workflow and save a newly compiled trusted-server case trigger revision.",
      { node_id: descriptor.node_id },
    );
  }

  const candidates = await tx.select({
    row: cases,
    sourceConnectionId: posthogConnections.id,
  }).from(cases).innerJoin(posthogConnections, and(
    eq(posthogConnections.projectId, cases.projectId),
    eq(posthogConnections.status, "active"),
  )).where(and(
    eq(cases.projectId, workflow.project_id),
    eq(cases.status, "active"),
    eq(cases.providerEventClassification, "customer_exception"),
    eq(cases.lastTrustLevel, "customer_posthog"),
    eq(cases.lastCredentialKind, "posthog_oauth"),
  )).orderBy(desc(cases.lastSeenAt), asc(cases.id)).limit(Number(maxCases) * 4);

  const receipts: AutomationWorkflowTriggerReceipt[] = [];
  const skipped: AutomationWorkflowTriggerIssuanceResult["skipped"] = [];
  let issued = 0;
  let replayed = 0;
  for (const candidate of candidates) {
    if (receipts.length >= Number(maxCases)) break;
    const caseRow = candidate.row;
    const triggerKey = `case:${caseRow.id}:${caseRow.revision}`;
    const existing = await rowsForTrigger(tx, workflow, triggerKey);
    const current = existing.find((row) => row.status === "ready" || row.status === "consumed");
    if (current) {
      receipts.push(await receiptFromRow(current));
      replayed += 1;
      continue;
    }
    const prior = existing[0];
    if (prior && prior.issuedAt + Number(cooldownSeconds) > now) {
      skipped.push({
        code: "case_trigger_cooldown_active",
        reason: "The server-owned cooldown for this exact case revision has not elapsed.",
        details: { case_id: caseRow.id, case_revision: caseRow.revision, eligible_at: prior.issuedAt + Number(cooldownSeconds) },
      });
      continue;
    }
    const attempt = (prior?.attempt ?? 0) + 1;
    if (attempt > workflow.workflow.limits.max_attempts_per_trigger) {
      skipped.push({
        code: "trigger_attempt_budget_exhausted",
        reason: "The immutable per-case-revision trigger attempt budget is exhausted.",
        details: { case_id: caseRow.id, case_revision: caseRow.revision, maximum: workflow.workflow.limits.max_attempts_per_trigger },
      });
      continue;
    }
    const sourceSnapshot = canonicalJsonStringify({
      namespace: "agentry-workflow-case-trigger-source-v1",
      project_id: workflow.project_id,
      automation_id: workflow.automation_id,
      workflow_revision_id: workflow.revision_id,
      case_id: caseRow.id,
      case_revision: caseRow.revision,
      fingerprint: caseRow.fingerprint,
      error_type: caseRow.errorType,
      message: caseRow.message,
      event_count: caseRow.eventCount,
      first_seen_at: caseRow.firstSeenAt,
      last_seen_at: caseRow.lastSeenAt,
      last_deploy_sha: caseRow.lastDeploySha,
      source_trust: caseRow.lastTrustLevel,
      source_connection_id: candidate.sourceConnectionId,
    });
    const receiptId = `awtr_${uuidv7()}`;
    const expiresAt = now + CASE_RECEIPT_LIFETIME_SECONDS;
    const output = await canonicalTriggerOutput(descriptor.output_contract, {
      receipt_id: receiptId,
      case_id: caseRow.id,
      case_revision: caseRow.revision,
      snapshot_hash: await sha256Hex(sourceSnapshot),
      source_trust: "customer_posthog",
      issued_at: now,
      expires_at: expiresAt,
      instruction_authority: "none",
    });
    const persisted = await insertReceiptIdempotently(tx, receiptValues(workflow, descriptor, {
      id: receiptId,
      trigger_kind: "case",
      trigger_key: triggerKey,
      attempt,
      output,
      source_trust: "customer_posthog",
      issued_at: now,
      available_at: now,
      expires_at: expiresAt,
    }));
    receipts.push(await receiptFromRow(persisted.row));
    if (persisted.inserted) issued += 1;
    else replayed += 1;
  }
  if (receipts.length === 0 && skipped.length === 0) {
    skipped.push({
      code: "no_eligible_posthog_cases",
      reason: "No active customer-exception case has a current active PostHog OAuth connection and eligible revision.",
    });
  }
  return issuanceResult(workflow, "case", receipts, issued, replayed, skipped);
}

async function rowsForTrigger(
  tx: Transaction,
  workflow: StoredAutomationWorkflow,
  triggerKey: string,
): Promise<ReceiptRow[]> {
  return tx.select().from(automationWorkflowTriggerReceipts).where(and(
    eq(automationWorkflowTriggerReceipts.projectId, workflow.project_id),
    eq(automationWorkflowTriggerReceipts.automationId, workflow.automation_id),
    eq(automationWorkflowTriggerReceipts.workflowRevisionId, workflow.revision_id),
    eq(automationWorkflowTriggerReceipts.triggerKey, triggerKey),
  )).orderBy(desc(automationWorkflowTriggerReceipts.attempt));
}

function issuanceResult(
  workflow: StoredAutomationWorkflow,
  triggerKind: "case" | "schedule",
  receipts: AutomationWorkflowTriggerReceipt[],
  issuedCount: number,
  replayedCount: number,
  skipped: AutomationWorkflowTriggerIssuanceResult["skipped"],
): AutomationWorkflowTriggerIssuanceResult {
  return {
    kind: "automation_workflow_trigger_issuance",
    schema_version: "1",
    project_id: workflow.project_id,
    automation_id: workflow.automation_id,
    workflow_revision_id: workflow.revision_id,
    trigger_kind: triggerKind,
    receipts,
    issued_count: issuedCount,
    replayed_count: replayedCount,
    skipped,
    next_action: receipts.some((receipt) => receipt.status === "ready")
      ? "Start one exact ready receipt using only receipt_id and a stable Idempotency-Key. The server reloads trigger_output from this immutable row."
      : receipts.some((receipt) => receipt.status === "consumed")
        ? "Read consumed_run_id and recover that run; do not create another start request for the occurrence."
        : "Follow the structured skipped reason, then request another server eligibility sweep when it is recoverable.",
  };
}

/** Materialize all due ready receipts as expired using the database clock. */
export async function expireAutomationWorkflowTriggerReceipts(
  db: Db,
  input: { project_id: string; automation_id?: string; observed_at?: number },
): Promise<{ expired_count: number; expired_at: number }> {
  if (!ID.test(input.project_id)) throw errors.invalidPayload({ reason: "project_id is invalid" });
  if (input.automation_id !== undefined && !WORKFLOW_ID.test(input.automation_id)) {
    throw errors.invalidPayload({ reason: "automation_id is invalid" });
  }
  return db.transaction(async (tx) => {
    const now = await databaseNow(tx, input.observed_at);
    const expired = await expireReadyReceiptsInTransaction(tx, input.project_id, input.automation_id, now);
    return { expired_count: expired, expired_at: now };
  });
}

/** Read one exact receipt; consumed_run_id is the canonical lost-response recovery link. */
export async function readAutomationWorkflowTriggerReceipt(
  db: Db,
  input: { project_id: string; automation_id: string; receipt_id: string },
): Promise<AutomationWorkflowTriggerReceipt | null> {
  validateSelector(input.project_id, input.automation_id);
  validateReceiptId(input.receipt_id);
  await expireAutomationWorkflowTriggerReceipts(db, {
    project_id: input.project_id,
    automation_id: input.automation_id,
  });
  const row = (
    await db.select().from(automationWorkflowTriggerReceipts).where(and(
      eq(automationWorkflowTriggerReceipts.id, input.receipt_id),
      eq(automationWorkflowTriggerReceipts.projectId, input.project_id),
      eq(automationWorkflowTriggerReceipts.automationId, input.automation_id),
    )).limit(1)
  )[0] ?? null;
  return row ? receiptFromRow(row) : null;
}

/** Bounded receipt history ordered for recovery: newest issuance first. */
export async function listAutomationWorkflowTriggerReceipts(
  db: Db,
  input: {
    project_id: string;
    automation_id: string;
    status?: AutomationWorkflowTriggerReceiptStatus;
    limit?: number;
    cursor?: { issued_at: number; receipt_id: string };
  },
): Promise<AutomationWorkflowTriggerReceipt[]> {
  validateSelector(input.project_id, input.automation_id);
  if (input.status !== undefined && !["ready", "consumed", "expired", "cancelled"].includes(input.status)) {
    throw errors.invalidPayload({ reason: "status is invalid" });
  }
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw errors.invalidPayload({ reason: "limit must be an integer between 1 and 100" });
  }
  if (input.cursor && (
    !Number.isSafeInteger(input.cursor.issued_at) ||
    input.cursor.issued_at < 0 ||
    !ID.test(input.cursor.receipt_id)
  )) {
    throw errors.invalidPayload({ reason: "cursor is invalid" });
  }
  await expireAutomationWorkflowTriggerReceipts(db, {
    project_id: input.project_id,
    automation_id: input.automation_id,
  });
  const rows = await db.select().from(automationWorkflowTriggerReceipts).where(and(
    eq(automationWorkflowTriggerReceipts.projectId, input.project_id),
    eq(automationWorkflowTriggerReceipts.automationId, input.automation_id),
    input.status ? eq(automationWorkflowTriggerReceipts.status, input.status) : undefined,
    input.cursor ? or(
      lt(automationWorkflowTriggerReceipts.issuedAt, input.cursor.issued_at),
      and(
        eq(automationWorkflowTriggerReceipts.issuedAt, input.cursor.issued_at),
        lt(automationWorkflowTriggerReceipts.id, input.cursor.receipt_id),
      ),
    ) : undefined,
  )).orderBy(desc(automationWorkflowTriggerReceipts.issuedAt), desc(automationWorkflowTriggerReceipts.id)).limit(limit);
  return Promise.all(rows.map(receiptFromRow));
}

/**
 * Transaction-only start lookup. It never accepts trigger facts: the exact
 * canonical trigger_output and frozen revision are recovered from receipt_id.
 */
export async function loadAutomationWorkflowTriggerReceiptForStart(
  tx: Transaction,
  input: {
    project_id: string;
    automation_id: string;
    receipt_id: string;
    at: number;
  },
): Promise<AutomationWorkflowTriggerStartLookup> {
  validateSelector(input.project_id, input.automation_id);
  validateReceiptId(input.receipt_id);
  const row = (
    await tx.select().from(automationWorkflowTriggerReceipts).where(and(
      eq(automationWorkflowTriggerReceipts.id, input.receipt_id),
      eq(automationWorkflowTriggerReceipts.projectId, input.project_id),
      eq(automationWorkflowTriggerReceipts.automationId, input.automation_id),
    )).limit(1)
  )[0] ?? null;
  if (!row) throw errors.notFound("automation_workflow_trigger_receipt");
  if (row.status === "ready" && row.expiresAt <= input.at) {
    throw errors.conflict(
      "automation_workflow_trigger_receipt_expired",
      "The server-issued trigger receipt expired before the run started.",
      "Request another server eligibility sweep; do not edit or replay the expired trigger output.",
      { receipt_id: row.id, expires_at: row.expiresAt },
    );
  }
  const receipt = await receiptFromRow(row);
  if (row.status === "consumed" && row.consumedRunId) {
    return { outcome: "consumed", receipt, consumed_run_id: row.consumedRunId };
  }
  if (row.status !== "ready") {
    throw errors.conflict(
      `automation_workflow_trigger_receipt_${row.status}`,
      `The server-issued trigger receipt is ${row.status} and cannot create a run.`,
      receipt.next_action,
      { receipt_id: row.id, status: row.status, cancel_reason: row.cancelReason },
    );
  }
  if (input.at < row.availableAt) {
    throw errors.conflict(
      "automation_workflow_trigger_receipt_not_yet_available",
      "The server-issued trigger occurrence is not available yet.",
      "Wait until available_at, then retry the exact start request with the same Idempotency-Key.",
      { receipt_id: row.id, available_at: row.availableAt },
    );
  }
  await assertAutomationWritesOpen(tx as unknown as Db, row.projectId);
  if (row.triggerKind === "case") {
    const caseId = receipt.trigger_output.case_id;
    const caseRevision = receipt.trigger_output.case_revision;
    const currentCase = typeof caseId === "string" && Number.isSafeInteger(caseRevision)
      ? (
          await tx.select({ id: cases.id }).from(cases).where(and(
            eq(cases.id, caseId),
            eq(cases.projectId, row.projectId),
            eq(cases.revision, Number(caseRevision)),
            eq(cases.status, "active"),
            eq(cases.providerEventClassification, "customer_exception"),
          )).limit(1)
        )[0]
      : null;
    if (!currentCase) {
      throw errors.conflict(
        "automation_workflow_case_trigger_source_changed",
        "The case behind this trigger receipt is no longer an eligible customer exception revision.",
        "Request a new server eligibility sweep; onboarding-proof and unclassified PostHog issues cannot start unattended work.",
        { receipt_id: row.id, case_id: caseId ?? null, case_revision: caseRevision ?? null },
      );
    }
  }
  const authority = await readAutomationWorkflowAuthority(
    tx,
    row.projectId,
    row.automationId,
    row.workflowRevisionId,
    undefined,
    receipt.execution_authority_id,
  );
  if (!authority.open) {
    throw errors.conflict(
      "automation_workflow_trigger_authority_closed",
      "The receipt's exact workflow revision is no longer active and unpaused.",
      "Do not start work. Inspect workflow readiness or pause reason, then request a new receipt after exact authority is restored.",
      { receipt_id: row.id, authority_reason: authority.reason },
    );
  }
  return {
    outcome: "ready",
    receipt,
    workflow_revision_id: row.workflowRevisionId,
    workflow_hash: row.workflowHash,
    compile_hash: row.compileHash,
    execution_authority_id: receipt.execution_authority_id,
    trigger_kind: row.triggerKind,
    trigger_key: row.triggerKey,
    attempt: row.attempt,
    trigger_output: receipt.trigger_output,
    trigger_output_json: row.payloadJson,
    trigger_output_hash: row.payloadHash,
  };
}

/**
 * Consume after the matching immutable run root has been inserted, before the
 * surrounding start transaction commits. The database guard verifies every
 * revision, occurrence, payload, attempt, and timestamp field against run_id.
 */
export async function consumeAutomationWorkflowTriggerReceiptForRun(
  tx: Transaction,
  input: {
    project_id: string;
    automation_id: string;
    receipt_id: string;
    run_id: string;
    at: number;
  },
): Promise<ConsumeAutomationWorkflowTriggerReceiptResult> {
  validateSelector(input.project_id, input.automation_id);
  validateReceiptId(input.receipt_id);
  if (!ID.test(input.run_id)) throw errors.invalidPayload({ reason: "run_id is invalid" });
  const lookup = await loadAutomationWorkflowTriggerReceiptForStart(tx, input);
  if (lookup.outcome === "consumed") {
    if (lookup.consumed_run_id !== input.run_id) {
      throw errors.conflict(
        "automation_workflow_trigger_receipt_already_consumed",
        "The trigger receipt is already bound to a different immutable run.",
        "Read consumed_run_id and recover that run; never choose another idempotency key for the same receipt.",
        { receipt_id: input.receipt_id, consumed_run_id: lookup.consumed_run_id },
      );
    }
    return {
      receipt: lookup.receipt,
      consumed_run_id: lookup.consumed_run_id,
      idempotent_replay: true,
    };
  }
  const run = (
    await tx.select({ id: automationWorkflowRuns.id }).from(automationWorkflowRuns).where(and(
      eq(automationWorkflowRuns.id, input.run_id),
      eq(automationWorkflowRuns.projectId, input.project_id),
      eq(automationWorkflowRuns.automationId, input.automation_id),
      eq(automationWorkflowRuns.triggerReceiptId, input.receipt_id),
    )).limit(1)
  )[0] ?? null;
  if (!run) {
    throw errors.conflict(
      "automation_workflow_trigger_run_missing",
      "The exact immutable run root does not exist in this start transaction.",
      "Insert the receipt-bound run root first, then consume the receipt before committing the same transaction.",
      { receipt_id: input.receipt_id, run_id: input.run_id },
    );
  }
  const updated = await tx.update(automationWorkflowTriggerReceipts).set({
    status: "consumed",
    consumedRunId: input.run_id,
    consumedAt: input.at,
    updatedAt: input.at,
  }).where(and(
    eq(automationWorkflowTriggerReceipts.id, input.receipt_id),
    eq(automationWorkflowTriggerReceipts.projectId, input.project_id),
    eq(automationWorkflowTriggerReceipts.automationId, input.automation_id),
    eq(automationWorkflowTriggerReceipts.status, "ready"),
    lte(automationWorkflowTriggerReceipts.availableAt, input.at),
    gt(automationWorkflowTriggerReceipts.expiresAt, input.at),
    automationWritesOpenForProject(automationWorkflowTriggerReceipts.projectId),
  )).returning();
  if (updated.length !== 1) {
    const winner = (
      await tx.select().from(automationWorkflowTriggerReceipts).where(
        eq(automationWorkflowTriggerReceipts.id, input.receipt_id),
      ).limit(1)
    )[0] ?? null;
    if (winner?.status === "consumed" && winner.consumedRunId === input.run_id) {
      return {
        receipt: await receiptFromRow(winner),
        consumed_run_id: input.run_id,
        idempotent_replay: true,
      };
    }
    throw errors.conflict(
      "automation_workflow_trigger_consume_conflict",
      "Trigger authority changed before the exact run could consume it.",
      "Read the receipt. Recover consumed_run_id when present; otherwise request a new server eligibility sweep.",
      { receipt_id: input.receipt_id, run_id: input.run_id },
    );
  }
  return {
    receipt: await receiptFromRow(updated[0]!),
    consumed_run_id: input.run_id,
    idempotent_replay: false,
  };
}
