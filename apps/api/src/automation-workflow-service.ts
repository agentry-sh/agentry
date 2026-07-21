import {
  and,
  asc,
  eq,
  gt,
  isNull,
  notLike,
  sql,
} from "drizzle-orm";
import {
  automationWorkflowBudgetCharges,
  automationWorkflowCommands,
  automationWorkflowEffectEvents,
  automationWorkflowEffects,
  automationWorkflowExecutionAuthorities,
  automationWorkflowRunEvents,
  automationWorkflowRuns,
  automationWorkflowRunStates,
  automationWorkflowSuspensions,
  automationWorkflows,
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
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "./automation-deletion-boundary.js";
import { AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS } from "./automation-budgets.js";
import {
  assertAutomationWorkflowAuthorityOpen,
  readAutomationWorkflowAuthority,
  type AutomationWorkflowAuthority,
} from "./automation-workflow-controls.js";
import {
  assertAutomationWorkflowRunLease,
  readAutomationWorkflowRunLease,
  type AutomationWorkflowPublicLease,
} from "./automation-workflow-leases.js";
import {
  executeAutomationWorkflowCommand,
  nextAutomationWorkflowAction,
  replayAutomationWorkflowRun,
  type AutomationWorkflowActor,
  type AutomationWorkflowNextAction,
  type AutomationWorkflowRunEvent,
  type AutomationWorkflowRunState,
  type AutomationWorkflowRuntimeCommand,
  AutomationWorkflowRuntimeError,
  type AutomationWorkflowRuntimeResult,
} from "./automation-workflow-runtime.js";
import {
  loadAutomationWorkflowRevision,
  type StoredAutomationWorkflowRevision,
} from "./automation-workflow-store.js";
import {
  consumeAutomationWorkflowTriggerReceiptForRun,
  loadAutomationWorkflowTriggerReceiptForStart,
} from "./automation-workflow-triggers.js";
import type { AutomationWorkflowPrincipal } from "./automation-workflow-components.js";
import {
  AutomationWorkflowAdapterError,
  requireAutomationWorkflowComponentAdapter,
  validateAutomationWorkflowAdapterOutput,
  type AutomationWorkflowAdapterContext,
} from "./automation-workflow-adapters.js";
import {
  advanceAutomationWorkflowEvidenceBoundEffect,
  assertAutomationWorkflowEffectReceiptActor,
  releaseAutomationWorkflowTerminalLease,
  synchronizeAutomationWorkflowMaterializations,
} from "./automation-workflow-materializations.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type StripServerEnvelope<T> = T extends unknown ? Omit<T, "at" | "actor"> : never;
export type AutomationWorkflowLogicalCommand = StripServerEnvelope<AutomationWorkflowRuntimeCommand>;

export type AutomationWorkflowCommandActor = AutomationWorkflowActor;

export type AutomationWorkflowLeaseFence = {
  lease_epoch: number;
  lease_token: string;
};

export type AutomationWorkflowCommandReceipt = {
  kind: "automation_workflow_command_receipt";
  schema_version: "1";
  run_id: string;
  command_id: string;
  request_hash: string;
  expected_revision: number;
  committed_revision: number;
  state_hash: string;
  state: AutomationWorkflowRunState;
  next_action: AutomationWorkflowNextAction;
  idempotent_replay: boolean;
  effect_call: null | {
    intent_hash: string;
    provider_operation_key: string;
    call_authorized: boolean;
    reconcile_only: boolean;
    lease_epoch: number;
  };
};

export type StartAutomationWorkflowRunInput = {
  project_id: string;
  automation_id: string;
  idempotency_key: string;
  trigger_receipt_id: string;
  runner_credential_id: string;
  observed_at?: number;
};

export type ApplyAutomationWorkflowCommandInput = {
  run_id: string;
  command: Exclude<AutomationWorkflowLogicalCommand, { kind: "start" } | { kind: "effect_reconciled" }>;
  actor: AutomationWorkflowActor;
  lease?: AutomationWorkflowLeaseFence;
  observed_at?: number;
};

export type AutomationWorkflowRunRouteSet = Readonly<{
  run: string;
  commands: string;
  cancel: string;
  advance: string;
  lease: string;
  lease_renew: string;
}>;

export function automationWorkflowRunRoutes(
  projectId: string,
  automationId: string,
  runId: string,
): AutomationWorkflowRunRouteSet {
  const run = `/v1/projects/${encodeURIComponent(projectId)}/automation-workflows/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`;
  return {
    run,
    commands: `${run}/commands`,
    cancel: `${run}/cancel`,
    advance: `${run}/advance`,
    lease: `${run}/lease`,
    lease_renew: `${run}/lease/renew`,
  };
}

export function automationWorkflowEffectRoutes(
  projectId: string,
  automationId: string,
  runId: string,
  effectId: string,
) {
  const run = automationWorkflowRunRoutes(projectId, automationId, runId).run;
  const effect = `${run}/effects/${encodeURIComponent(effectId)}`;
  return {
    effect,
    reconcile: `${effect}/reconcile`,
  } as const;
}

type AutomationWorkflowEffectStatus = typeof automationWorkflowEffects.$inferSelect["status"];
type AutomationWorkflowSuspensionStatus = typeof automationWorkflowSuspensions.$inferSelect["status"];
type AutomationWorkflowSuspensionKind = typeof automationWorkflowSuspensions.$inferSelect["kind"];

export type AutomationWorkflowRecoverableNextAction = Readonly<{
  runtime: NonNullable<AutomationWorkflowNextAction>;
  required_principal: AutomationWorkflowPrincipal;
  method: "POST";
  path: string;
  expected_revision: number;
  lease_required: boolean;
  lease: null | Readonly<{
    current: AutomationWorkflowPublicLease | null;
    acquire: Readonly<{ method: "POST"; path: string }>;
    renew: Readonly<{ method: "POST"; path: string }>;
    release: Readonly<{ method: "DELETE"; path: string }>;
  }>;
  timing: Readonly<{
    ready_at: number;
    next_check_at: number | null;
    expires_at: number | null;
    deadline_at: number;
  }>;
  effect_id: string | null;
  effect_status: AutomationWorkflowEffectStatus | null;
  suspension_id: string | null;
  suspension_kind: AutomationWorkflowSuspensionKind | null;
  suspension_status: AutomationWorkflowSuspensionStatus | null;
}>;

export type AutomationWorkflowExecutionControl = Readonly<{
  execution_authorized: boolean;
  next_action_suppressed: boolean;
  project_control: Readonly<{
    method: "GET";
    path: string;
  }>;
  workflow_control: Readonly<{
    method: "GET";
    path: string;
  }>;
  recovery: null | Readonly<{
    mode: "continue_project_deletion" | "restore_authority_or_cancel";
    instruction: string;
    deletion_command_id: string | null;
    cancel_run: Readonly<{
      allowed: boolean;
      method: "POST";
      path: string;
    }>;
    settle_already_started_effect: Readonly<{
      allowed: boolean;
      method: "POST";
      path: string;
    }>;
    reconcile_already_started_effect: Readonly<{
      allowed: boolean;
      instruction: string;
    }>;
  }>;
}>;

export type AutomationWorkflowEffectProviderEvidence = Readonly<{
  effect_event_id: string;
  effect_event_sequence: number;
  event: string;
  observed_at: number;
  actor_principal: AutomationWorkflowActor["principal"];
  evidence_hash: string;
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

const RUNTIME_FORBIDDEN_CODES = new Set([
  "actor_credential_required",
  "principal_not_allowed",
]);

const RUNTIME_CONFLICT_CODES = new Set([
  "approval_expired",
  "effect_call_not_started",
  "effect_indeterminate",
  "effect_not_indeterminate",
  "nothing_due",
  "run_already_started",
  "run_command_stale",
  "run_not_started",
  "run_revision_conflict",
  "run_terminal",
  "trigger_receipt_not_eligible",
  "verification_expired",
  "verification_not_expired",
  "wait_expired",
  "wait_not_expired",
]);

/** Preserve recoverable runtime errors at the public service boundary. */
async function executeWorkflowCommand(
  ...args: Parameters<typeof executeAutomationWorkflowCommand>
): Promise<AutomationWorkflowRuntimeResult> {
  try {
    return await executeAutomationWorkflowCommand(...args);
  } catch (error) {
    if (!(error instanceof AutomationWorkflowRuntimeError)) throw error;
    const status = RUNTIME_FORBIDDEN_CODES.has(error.code)
      ? 403
      : RUNTIME_CONFLICT_CODES.has(error.code)
        ? 409
        : 422;
    throw new AgentryError({
      status,
      code: `automation_workflow_${error.code}`,
      message: error.message,
      nextAction: error.next_action,
      details: error.details,
    });
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const IDEMPOTENCY_KEY = /^[\u0021-\u007E]{8,500}$/u;
const SYSTEM_ACTOR = { principal: "agentry_system", credential_id: null } as const;

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
  return now;
}

function parseObject(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw errors.persistenceFailed(
      `Persisted ${label} is not a canonical JSON object.`,
      "Quarantine workflow execution and inspect the immutable runtime ledger.",
    );
  }
}

async function logicalRequestHash(
  runId: string,
  command: AutomationWorkflowLogicalCommand,
  actor: AutomationWorkflowActor,
  executionAuthorityId?: string | null,
): Promise<string> {
  const identityCommand = command.kind === "effect_receipt_recorded" &&
      command.output &&
      typeof command.output === "object" &&
      !Array.isArray(command.output)
    ? {
        ...command,
        output: {
          ...(command.output as Record<string, unknown>),
          // Provider receipt time is owned by the successful command
          // transaction, not by the runner. Normalize it out of caller
          // identity so response-loss replay survives a second boundary.
          recorded_at: 0,
        },
      }
    : command;
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-command-request-v1",
    run_id: runId,
    command: identityCommand,
    actor,
    ...(executionAuthorityId === undefined
      ? {}
      : { execution_authority_id: executionAuthorityId }),
  }));
}

async function stateSnapshot(state: AutomationWorkflowRunState) {
  const json = canonicalJsonStringify(state);
  return { json, hash: await sha256Hex(json) };
}

function nextReadyAt(action: AutomationWorkflowNextAction): number | null {
  if (!action) return null;
  if (action.kind === "suspended") return action.next_check_at;
  if (action.kind === "reconcile_effect") {
    return "next_reconcile_at" in action && typeof action.next_reconcile_at === "number"
      ? action.next_reconcile_at
      : null;
  }
  return null;
}

async function validateTriggerAdapterBoundary(
  revision: StoredAutomationWorkflowRevision,
  triggerOutput: unknown,
  at: number,
): Promise<void> {
  const node = revision.workflow.nodes.find((candidate) => candidate.id === revision.workflow.entry);
  const resolved = revision.compiled.resolved_nodes.find((candidate) => candidate.node_id === revision.workflow.entry);
  if (!node || node.kind !== "trigger" || !resolved) throw new Error("compiled workflow entry is not a resolved trigger");
  const context: AutomationWorkflowAdapterContext = {
    project_id: revision.project_id,
    node_id: node.id,
    component: node.component,
    component_hash: resolved.component_hash,
    runner: revision.workflow.runner,
    config: node.config,
    inputs: {},
    intent: null,
    at,
  };
  const validated = await validateAutomationWorkflowAdapterOutput(context, triggerOutput);
  if (!validated.success) {
    throw new AgentryError({
      status: 422,
      code: "automation_workflow_trigger_receipt_invalid",
      message: "The trigger receipt violates its exact reviewed adapter and immutable start-time binding.",
      nextAction: "Discard the receipt and request a fresh server-issued trigger occurrence.",
      details: { node_id: node.id, issues: validated.issues },
    });
  }
}

function isRunnerWorkCommand(command: ApplyAutomationWorkflowCommandInput["command"]): boolean {
  return new Set([
    "component_succeeded",
    "component_domain_failed",
    "effect_call_started",
  ]).has(command.kind);
}

function mayProceedWhilePaused(command: ApplyAutomationWorkflowCommandInput["command"]): boolean {
  return command.kind === "cancel" ||
    command.kind === "quarantine" ||
    command.kind === "effect_receipt_recorded";
}

async function validateCommandAdapterBoundary(
  revision: StoredAutomationWorkflowRevision,
  state: AutomationWorkflowRunState,
  command: ApplyAutomationWorkflowCommandInput["command"],
  at: number,
): Promise<void> {
  if (
    command.kind !== "component_succeeded" &&
    command.kind !== "component_domain_failed" &&
    command.kind !== "effect_call_started" &&
    command.kind !== "effect_receipt_recorded" &&
    command.kind !== "wait_resolved" &&
    command.kind !== "verification_resolved"
  ) return;
  const nodeId = command.node_id;
  const node = revision.workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || !("component" in node)) {
    throw errors.conflict(
      "automation_workflow_adapter_node_invalid",
      "The command node has no immutable component adapter binding.",
      "Reload the exact run action; never select a component from caller input.",
      { node_id: nodeId },
    );
  }
  const resolved = revision.compiled.resolved_nodes.find((candidate) => candidate.node_id === nodeId);
  if (!resolved) throw new Error(`compiled node ${nodeId} has no component hash`);
  const inputs = Object.fromEntries(Object.entries("inputs" in node ? node.inputs : {}).map(
    ([port, reference]) => {
      const output = state.outputs[reference.node_id];
      if (!output) throw new Error(`workflow adapter input ${port} has no same-run output`);
      return [port, {
        contract: output.contract,
        payload: output.payload,
        payload_hash: output.payload_hash,
      }];
    },
  ));
  const effect = state.effects[nodeId];
  const context: AutomationWorkflowAdapterContext = {
    project_id: state.project_id,
    node_id: nodeId,
    component: node.component,
    component_hash: resolved.component_hash,
    runner: revision.workflow.runner,
    config: node.config,
    inputs,
    intent: effect ? {
      intent_hash: effect.intent_hash,
      provider_target: effect.provider_target,
    } : null,
    at,
  };
  try {
    await requireAutomationWorkflowComponentAdapter({
      ...node.component,
      component_hash: resolved.component_hash,
    });
  } catch (error) {
    if (error instanceof AutomationWorkflowAdapterError) {
      throw new AgentryError({
        status: 409,
        code: error.code,
        message: error.message,
        nextAction: error.next_action,
        details: { node_id: nodeId, component: node.component, component_hash: resolved.component_hash },
      });
    }
    throw error;
  }
  if (
    command.kind === "component_succeeded" ||
    command.kind === "effect_receipt_recorded" ||
    (command.kind === "wait_resolved" && command.outcome === "ready") ||
    (command.kind === "verification_resolved" && (
      command.outcome === "pass" || command.outcome === "fail"
    ))
  ) {
    const validated = await validateAutomationWorkflowAdapterOutput(context, command.output);
    if (!validated.success) {
      throw new AgentryError({
        status: 422,
        code: "automation_workflow_adapter_output_invalid",
        message: "The adapter output is structurally valid but violates immutable semantic or workspace bindings.",
        nextAction: "Discard the output. Re-run only under the exact frozen inputs, target, workspace policy, and effect intent.",
        details: { node_id: nodeId, issues: validated.issues },
      });
    }
    if (command.kind === "component_succeeded" && node.kind === "agent_task") {
      const usage = command.usage;
      if (!usage) {
        throw new AgentryError({
          status: 422,
          code: "automation_workflow_usage_required",
          message: "Agent-task completion requires one adapter-observed cumulative usage record.",
          nextAction: "Report the exact monotonic turns/cost and independently observed workspace delta with the component result.",
        });
      }
      const output = validated.output as Record<string, AutomationWorkflowJsonValue>;
      if (node.component.id === "agent.code-fix") {
        const changedFiles = Array.isArray(output.changed_files)
          ? output.changed_files as Array<Record<string, AutomationWorkflowJsonValue>>
          : [];
        const outputPaths = changedFiles.map((file) => String(file.path)).sort();
        const observedPaths = [...usage.touched_files].sort();
        const outputChurn = changedFiles.reduce(
          (sum, file) => sum + Number(file.added_lines) + Number(file.deleted_lines),
          0,
        );
        if (
          canonicalJsonStringify(outputPaths) !== canonicalJsonStringify(observedPaths) ||
          outputChurn !== usage.changed_line_churn
        ) {
          throw new AgentryError({
            status: 422,
            code: "automation_workflow_workspace_observation_mismatch",
            message: "The code proposal does not match the adapter-observed touched files and line churn.",
            nextAction: "Discard the proposal and re-read the exact checkout diff; runner prose cannot expand workspace authority.",
            details: { node_id: nodeId },
          });
        }
      } else if (usage.touched_files.length > 0 || usage.changed_line_churn !== 0) {
        throw new AgentryError({
          status: 422,
          code: "automation_workflow_workspace_observation_unexpected",
          message: "This agent component has no workspace mutation authority.",
          nextAction: "Discard workspace changes and report zero touched files and zero changed-line churn.",
          details: { node_id: nodeId },
        });
      }
    }
  }
}

function materializeSystemOwnedCommandFields(
  revision: StoredAutomationWorkflowRevision,
  command: ApplyAutomationWorkflowCommandInput["command"],
  actor: AutomationWorkflowActor,
  at: number,
): ApplyAutomationWorkflowCommandInput["command"] {
  const node = "node_id" in command
    ? revision.workflow.nodes.find((candidate) => candidate.id === command.node_id)
    : undefined;
  if (
    command.kind === "effect_receipt_recorded" &&
    node?.kind === "effect" &&
    node.component.id === "effect.github.draft-pr" &&
    command.output &&
    typeof command.output === "object" &&
    !Array.isArray(command.output)
  ) {
    return {
      ...command,
      output: {
        ...(command.output as Record<string, unknown>),
        // The provider reports provider facts; Agentry records when those
        // facts crossed the durable workflow boundary.
        recorded_at: at,
      },
    };
  }
  if (
    actor.principal !== "agentry_system" ||
    command.kind !== "component_succeeded" ||
    !node ||
    node.kind !== "effect" ||
    node.component.id !== "effect.report.private" ||
    !command.output ||
    typeof command.output !== "object" ||
    Array.isArray(command.output)
  ) {
    return command;
  }
  return {
    ...command,
    output: {
      ...(command.output as Record<string, unknown>),
      // This field is authority owned by the transaction clock. The internal
      // executor sends a stable placeholder so exact retries keep one request
      // hash while the first successful commit records the real DB second.
      recorded_at: at,
    },
  };
}

async function readReceipt(
  tx: Transaction,
  runId: string,
  commandId: string,
  requestHash: string,
): Promise<AutomationWorkflowCommandReceipt | null> {
  const row = (
    await tx.select().from(automationWorkflowCommands).where(and(
      eq(automationWorkflowCommands.runId, runId),
      eq(automationWorkflowCommands.commandId, commandId),
    )).limit(1)
  )[0] ?? null;
  if (!row) return null;
  if (row.requestHash !== requestHash) {
    throw errors.conflict(
      "automation_workflow_command_id_reused",
      "The workflow command id is already bound to a different logical request or actor.",
      "Replay the exact original command or choose a new command id for genuinely new work.",
      { run_id: runId, command_id: commandId },
    );
  }
  const parsed = parseObject(row.responseJson, "workflow command response") as unknown as AutomationWorkflowCommandReceipt;
  const expectedHash = await sha256Hex(canonicalJsonStringify(parsed));
  if (expectedHash !== row.responseHash || parsed.state_hash !== row.committedStateHash) {
    throw errors.persistenceFailed(
      "The workflow command receipt hash does not match its persisted response/state binding.",
      "Quarantine the run and inspect command-ledger integrity before issuing more work.",
      { run_id: runId, command_id: commandId },
    );
  }
  return {
    ...parsed,
    idempotent_replay: true,
    effect_call: parsed.effect_call
      ? { ...parsed.effect_call, call_authorized: false, reconcile_only: true }
      : null,
  };
}

/**
 * A durable command receipt proves what committed; it is never an evergreen
 * grant. Preserve exact response-loss replay while live authority remains
 * open, but remove the historical continuation as soon as any kill switch,
 * deletion fence, revision change, or frozen-runner revocation closes it.
 */
async function suppressClosedAuthorityReplay(
  db: Transaction,
  run: typeof automationWorkflowRuns.$inferSelect,
  receipt: AutomationWorkflowCommandReceipt,
): Promise<AutomationWorkflowCommandReceipt> {
  const authority = await readAutomationWorkflowAuthority(
    db,
    run.projectId,
    run.automationId,
    run.workflowRevisionId,
    run.runnerCredentialId,
    run.executionAuthorityId,
  );
  return authority.open
    ? receipt
    : {
        ...receipt,
        next_action: null,
        effect_call: receipt.effect_call
          ? { ...receipt.effect_call, call_authorized: false, reconcile_only: true }
          : null,
      };
}

/**
 * A workflow run is executable only when its immutable root still has one
 * exact reviewed enablement receipt. This is an integrity check, not the live
 * head/kill-switch check performed separately before work is authorized.
 */
async function assertAutomationWorkflowRunExecutionAuthority(
  db: Db | Transaction,
  run: typeof automationWorkflowRuns.$inferSelect,
): Promise<typeof automationWorkflowExecutionAuthorities.$inferSelect> {
  if (!run.executionAuthorityId || !run.executionDescriptorHash) {
    throw errors.persistenceFailed(
      "The workflow run root has no durable execution-authority binding.",
      "Quarantine this legacy or corrupt run. Save, review, and enable a new exact revision before starting replacement work.",
      { run_id: run.id },
    );
  }
  const authority = (
    await db.select().from(automationWorkflowExecutionAuthorities).where(and(
      eq(automationWorkflowExecutionAuthorities.id, run.executionAuthorityId),
      eq(automationWorkflowExecutionAuthorities.projectId, run.projectId),
      eq(automationWorkflowExecutionAuthorities.automationId, run.automationId),
      eq(automationWorkflowExecutionAuthorities.workflowRevisionId, run.workflowRevisionId),
      eq(automationWorkflowExecutionAuthorities.workflowHash, run.workflowHash),
      eq(automationWorkflowExecutionAuthorities.compileHash, run.compileHash),
      eq(automationWorkflowExecutionAuthorities.descriptorHash, run.executionDescriptorHash),
      eq(automationWorkflowExecutionAuthorities.runnerCredentialId, run.runnerCredentialId),
    )).limit(1)
  )[0] ?? null;
  if (!authority) {
    throw errors.persistenceFailed(
      "The workflow run root differs from its immutable execution-authority receipt.",
      "Quarantine the run and inspect its reviewed revision, descriptor, and frozen runner bindings before issuing more work.",
      {
        run_id: run.id,
        execution_authority_id: run.executionAuthorityId,
        execution_descriptor_hash: run.executionDescriptorHash,
      },
    );
  }
  return authority;
}

function eventFromRow(
  row: typeof automationWorkflowRunEvents.$inferSelect,
): AutomationWorkflowRunEvent {
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

async function loadAndVerifyState(
  tx: Transaction,
  run: typeof automationWorkflowRuns.$inferSelect,
  revision: StoredAutomationWorkflowRevision,
) {
  const projection = (
    await tx.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, run.id),
    ).limit(1)
  )[0] ?? null;
  if (!projection) throw errors.notFound("automation_workflow_run_state");
  const eventRows = await tx.select().from(automationWorkflowRunEvents).where(
    eq(automationWorkflowRunEvents.runId, run.id),
  ).orderBy(asc(automationWorkflowRunEvents.sequence));
  const events = eventRows.map(eventFromRow);
  const replayed = await replayAutomationWorkflowRun(revision.compiled, events);
  if (!replayed) throw new Error("workflow run event ledger replayed to no state");
  const snapshot = await stateSnapshot(replayed);
  if (
    projection.projectId !== run.projectId ||
    projection.automationId !== run.automationId ||
    projection.workflowRevisionId !== run.workflowRevisionId ||
    projection.workflowHash !== run.workflowHash ||
    projection.compileHash !== run.compileHash ||
    projection.stateVersion !== replayed.revision ||
    projection.status !== replayed.status ||
    projection.currentNodeId !== replayed.current_node_id ||
    projection.stateJson !== snapshot.json ||
    projection.stateHash !== snapshot.hash ||
    projection.activeRuntimeSeconds !== replayed.active_runtime_seconds ||
    projection.elapsedDeadlineAt !== replayed.elapsed_deadline_at ||
    projection.usageSequence !== replayed.usage_sequence ||
    projection.turnsUsed !== replayed.turns_used ||
    projection.costMicros !== replayed.cost_micros ||
    projection.filesChanged !== replayed.changed_files.length ||
    projection.changedLineChurn !== replayed.changed_line_churn
  ) {
    throw errors.persistenceFailed(
      "The workflow run projection differs from strict event replay.",
      "Quarantine the run; never issue an adapter action from the disposable projection.",
      { run_id: run.id, projected_revision: projection.stateVersion, replayed_revision: replayed.revision },
    );
  }
  return { projection, state: replayed, events };
}

async function persistEvents(
  tx: Transaction,
  run: typeof automationWorkflowRuns.$inferSelect,
  events: readonly AutomationWorkflowRunEvent[],
) {
  if (events.length === 0) throw new Error("successful workflow command emitted no events");
  const inserted = await tx.insert(automationWorkflowRunEvents).values(events.map((event) => ({
    id: event.event_id,
    priorEventHash: event.prior_event_hash,
    projectId: run.projectId,
    automationId: run.automationId,
    runId: run.id,
    sequence: event.sequence,
    commandId: event.command_id,
    requestHash: event.request_hash,
    eventVersion: event.event_version,
    event: event.event,
    workflowHash: event.workflow_hash,
    compileHash: event.compile_hash,
    nodeId: event.node_id,
    componentHash: event.component_hash,
    payloadSchemaRef: event.payload_schema_ref,
    payloadJson: canonicalJsonStringify(event.payload),
    payloadHash: event.payload_hash,
    actorPrincipal: event.actor.principal,
    actorCredentialId: event.actor.credential_id,
    at: event.at,
  }))).returning({ id: automationWorkflowRunEvents.id });
  if (inserted.length !== events.length) throw new Error("workflow event insert cardinality mismatch");
}

async function persistCommandResult(
  tx: Transaction,
  input: {
    run: typeof automationWorkflowRuns.$inferSelect;
    revision: StoredAutomationWorkflowRevision;
    prior_state: AutomationWorkflowRunState | null;
    result: AutomationWorkflowRuntimeResult;
    command: AutomationWorkflowRuntimeCommand;
    request_hash: string;
    lease_epoch: number | null;
    fresh_effect_call: boolean;
    evidence_bound_effect?: Readonly<{
      idempotency_key_hash: string;
      expected_event: "effect.completed" | "effect.reconciled_absent" | "effect.reconciliation_unknown" | "effect.reconciliation_exhausted";
      reconciliation_payload: Record<string, AutomationWorkflowJsonValue>;
    }>;
  },
): Promise<AutomationWorkflowCommandReceipt> {
  const { run, result, command } = input;
  await persistEvents(tx, run, result.events);
  let precommittedEffectWorkflowEventId: string | undefined;
  if (input.evidence_bound_effect) {
    const effectEvents = result.events.filter((event) => [
      "effect.completed",
      "effect.reconciled_absent",
      "effect.reconciliation_unknown",
      "effect.reconciliation_exhausted",
    ].includes(event.event));
    if (
      effectEvents.length !== 1 ||
      effectEvents[0]!.event !== input.evidence_bound_effect.expected_event
    ) {
      throw errors.persistenceFailed(
        "The evidence-bound reconciliation did not emit its exact planned workflow effect transition.",
        "Roll back the transaction and inspect runtime/planner policy drift before reconciling again.",
        { run_id: run.id, expected_event: input.evidence_bound_effect.expected_event },
      );
    }
    const workflowEvent = effectEvents[0]!;
    await advanceAutomationWorkflowEvidenceBoundEffect(tx, {
      run,
      workflow_event: workflowEvent,
      idempotency_key_hash: input.evidence_bound_effect.idempotency_key_hash,
      reconciliation_payload: input.evidence_bound_effect.reconciliation_payload,
    });
    precommittedEffectWorkflowEventId = workflowEvent.event_id;
  }
  // Suspension/effect materializations are applied by the service after the
  // immutable events exist and before their command receipt/projection commits.
  await synchronizeAutomationWorkflowMaterializations(tx, {
    run,
    revision: input.revision,
    prior_state: input.prior_state,
    result,
    lease_epoch: input.lease_epoch,
    precommitted_effect_workflow_event_id: precommittedEffectWorkflowEventId,
  });
  const snapshot = await stateSnapshot(result.state);
  const durableEffectCall = input.fresh_effect_call && result.next_action?.kind === "reconcile_effect"
    ? {
        intent_hash: result.next_action.intent_hash,
        provider_operation_key: result.next_action.intent_hash,
        call_authorized: false,
        reconcile_only: true,
        lease_epoch: input.lease_epoch!,
      }
    : null;
  const durable: AutomationWorkflowCommandReceipt = {
    kind: "automation_workflow_command_receipt",
    schema_version: "1",
    run_id: run.id,
    command_id: command.command_id,
    request_hash: input.request_hash,
    expected_revision: command.expected_revision,
    committed_revision: result.state.revision,
    state_hash: snapshot.hash,
    state: result.state,
    next_action: result.next_action,
    idempotent_replay: false,
    effect_call: durableEffectCall,
  };
  const responseJson = canonicalJsonStringify(durable);
  const responseHash = await sha256Hex(responseJson);
  const receipt = await tx.insert(automationWorkflowCommands).values({
    runId: run.id,
    commandId: command.command_id,
    projectId: run.projectId,
    automationId: run.automationId,
    requestHash: input.request_hash,
    expectedRevision: command.expected_revision,
    committedRevision: result.state.revision,
    firstSequence: result.events[0]!.sequence,
    lastSequence: result.events.at(-1)!.sequence,
    actorPrincipal: command.actor.principal,
    actorCredentialId: command.actor.credential_id,
    leaseEpoch: input.lease_epoch,
    committedStateHash: snapshot.hash,
    responseJson,
    responseHash,
    createdAt: command.at,
  }).returning({ commandId: automationWorkflowCommands.commandId });
  if (receipt.length !== 1) throw new Error("workflow command receipt insert failed");

  const projectionValues = {
    stateVersion: result.state.revision,
    status: result.state.status,
    currentNodeId: result.state.current_node_id,
    stateJson: snapshot.json,
    stateHash: snapshot.hash,
    readyAt: nextReadyAt(result.next_action),
    activeRuntimeSeconds: result.state.active_runtime_seconds,
    elapsedDeadlineAt: result.state.elapsed_deadline_at,
    turnsUsed: "turns_used" in result.state ? result.state.turns_used as number : 0,
    costMicros: "cost_micros" in result.state ? result.state.cost_micros as number : 0,
    filesChanged: "changed_files" in result.state && Array.isArray(result.state.changed_files)
      ? result.state.changed_files.length
      : 0,
    changedLineChurn: "changed_line_churn" in result.state
      ? result.state.changed_line_churn as number
      : 0,
    usageSequence: "usage_sequence" in result.state ? result.state.usage_sequence as number : 0,
    updatedAt: command.at,
  };
  if (input.prior_state === null) {
    const insertedState = await tx.insert(automationWorkflowRunStates).values({
      runId: run.id,
      projectId: run.projectId,
      automationId: run.automationId,
      workflowRevisionId: run.workflowRevisionId,
      workflowHash: run.workflowHash,
      compileHash: run.compileHash,
      ...projectionValues,
      createdAt: command.at,
    }).returning({ runId: automationWorkflowRunStates.runId });
    if (insertedState.length !== 1) throw new Error("workflow run projection insert failed");
  } else {
    const changed = await tx.update(automationWorkflowRunStates).set(projectionValues).where(and(
      eq(automationWorkflowRunStates.runId, run.id),
      eq(automationWorkflowRunStates.stateVersion, input.prior_state.revision),
      eq(automationWorkflowRunStates.stateHash, input.prior_state.last_event_hash.length === 64
        ? await sha256Hex(canonicalJsonStringify(input.prior_state))
        : ""),
      automationWritesOpenForProject(automationWorkflowRunStates.projectId),
    )).returning({ runId: automationWorkflowRunStates.runId });
    if (changed.length !== 1) {
      throw errors.conflict(
        "automation_workflow_run_revision_conflict",
        "Another command committed this workflow run revision first.",
        "Reload the exact command receipt or current run action; do not reuse stale adapter output.",
        { run_id: run.id, expected_revision: input.prior_state.revision },
      );
    }
  }
  const terminalEvent = [...result.events].reverse().find((event) => [
    "run.completed",
    "run.escalated",
    "run.cancelled",
    "run.quarantined",
  ].includes(event.event));
  if (terminalEvent) {
    await releaseAutomationWorkflowTerminalLease(tx, run, terminalEvent);
  }
  if (input.fresh_effect_call && durable.effect_call) {
    return {
      ...durable,
      effect_call: {
        ...durable.effect_call,
        call_authorized: true,
        reconcile_only: false,
      },
    };
  }
  return durable;
}

/**
 * Internal production bridge for evidence-bound provider reconciliation.
 * Generic callers cannot submit this historical runtime command variant; the
 * dedicated reconciliation service validates evidence and invokes this helper
 * inside the same transaction that commits both ledgers and projections.
 */
export async function persistAutomationWorkflowEvidenceBoundReconciliation(
  tx: Transaction,
  input: {
    run: typeof automationWorkflowRuns.$inferSelect;
    revision: StoredAutomationWorkflowRevision;
    prior_state: AutomationWorkflowRunState;
    command: Extract<AutomationWorkflowRuntimeCommand, { kind: "effect_reconciled" }>;
    request_hash: string;
    halt_after_effect_settlement_reason?: "kill_switch_active";
    effect_ledger: Readonly<{
      idempotency_key_hash: string;
      expected_event: "effect.completed" | "effect.reconciled_absent" | "effect.reconciliation_unknown" | "effect.reconciliation_exhausted";
      reconciliation_payload: Record<string, AutomationWorkflowJsonValue>;
    }>;
  },
): Promise<AutomationWorkflowCommandReceipt> {
  const result = await executeWorkflowCommand(
    input.revision.compiled,
    input.prior_state,
    input.command,
    {
      request_hash: input.request_hash,
      halt_after_effect_settlement_reason: input.halt_after_effect_settlement_reason,
    },
  );
  return persistCommandResult(tx, {
    run: input.run,
    revision: input.revision,
    prior_state: input.prior_state,
    result,
    command: input.command,
    request_hash: input.request_hash,
    lease_epoch: null,
    fresh_effect_call: false,
    evidence_bound_effect: {
      ...input.effect_ledger,
    },
  });
}

async function reserveRollingCharge(
  tx: Transaction,
  input: {
    id: string;
    project_id: string;
    automation_id: string;
    run_id: string;
    kind: "run" | "external_effect_call";
    subject_key: string;
    node_id: string | null;
    effect_attempt: number | null;
    limit: number;
    now: number;
  },
): Promise<boolean> {
  if (input.limit <= 0) return false;
  const inserted = await tx.insert(automationWorkflowBudgetCharges).select(
    tx.select({
      id: sql<string>`${input.id}`.as("id"),
      projectId: sql<string>`${input.project_id}`.as("project_id"),
      automationId: sql<string>`${input.automation_id}`.as("automation_id"),
      runId: sql<string>`${input.run_id}`.as("run_id"),
      kind: sql<string>`${input.kind}`.as("kind"),
      subjectKey: sql<string>`${input.subject_key}`.as("subject_key"),
      nodeId: sql<string | null>`${input.node_id}`.as("node_id"),
      effectAttempt: sql<number | null>`${input.effect_attempt}`.as("effect_attempt"),
      createdAt: sql<number>`${input.now}`.as("created_at"),
    }).from(automationWorkflowRuns).where(and(
      eq(automationWorkflowRuns.id, input.run_id),
      automationWritesOpenForProject(automationWorkflowRuns.projectId),
      sql`(
        SELECT count(*)
        FROM ${automationWorkflowBudgetCharges} prior_charge
        WHERE prior_charge.project_id = ${input.project_id}
          AND prior_charge.automation_id = ${input.automation_id}
          AND prior_charge.kind = ${input.kind}
          AND prior_charge.created_at >= ${input.now - AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS}
      ) < ${input.limit}`,
    )),
  ).onConflictDoNothing().returning({ id: automationWorkflowBudgetCharges.id });
  return inserted.length === 1;
}

async function rollingBudgetRetryAt(
  tx: Transaction,
  input: {
    project_id: string;
    automation_id: string;
    kind: "run" | "external_effect_call";
    now: number;
  },
): Promise<number> {
  const oldest = (
    await tx.select({
      createdAt: sql<number | null>`min(${automationWorkflowBudgetCharges.createdAt})`,
    }).from(automationWorkflowBudgetCharges).where(and(
      eq(automationWorkflowBudgetCharges.projectId, input.project_id),
      eq(automationWorkflowBudgetCharges.automationId, input.automation_id),
      eq(automationWorkflowBudgetCharges.kind, input.kind),
      sql`${automationWorkflowBudgetCharges.createdAt} >= ${input.now - AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS}`,
    ))
  )[0]?.createdAt;
  if (typeof oldest !== "number" || !Number.isSafeInteger(oldest) || oldest < 0) {
    throw errors.persistenceFailed(
      "The rolling workflow budget was exhausted without a recoverable oldest charge.",
      "Keep the workflow stopped and inspect its immutable budget ledger before retrying.",
      { project_id: input.project_id, automation_id: input.automation_id, kind: input.kind },
    );
  }
  // The rolling window is inclusive at its lower bound, so one extra second
  // is required before the oldest charge no longer consumes capacity.
  return oldest + AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS + 1;
}

async function recoverAutomationWorkflowStartReceipt(
  tx: Transaction,
  run: typeof automationWorkflowRuns.$inferSelect,
  requestedReceiptId: string,
): Promise<AutomationWorkflowCommandReceipt> {
  if (run.triggerReceiptId !== requestedReceiptId) {
    throw errors.conflict(
      "idempotency_key_reused",
      "This workflow start Idempotency-Key is already bound to a different trigger receipt.",
      "Replay the exact original receipt id or use a new stable Idempotency-Key for a different server-issued receipt.",
      { run_id: run.id, original_trigger_receipt_id: run.triggerReceiptId, received_trigger_receipt_id: requestedReceiptId },
    );
  }
  await assertAutomationWorkflowRunExecutionAuthority(tx, run);
  const revision = await loadAutomationWorkflowRevision(tx as unknown as Db, run.projectId, run.workflowRevisionId);
  if (!revision) throw errors.persistenceFailed(
    "The existing workflow start references a missing immutable revision.",
    "Quarantine workflow execution and inspect the run-root binding.",
    { run_id: run.id },
  );
  const triggerOutput = parseObject(run.triggerPayloadJson, "workflow run trigger payload");
  if (await sha256Hex(run.triggerPayloadJson) !== run.triggerPayloadHash) {
    throw errors.persistenceFailed(
      "The existing workflow run trigger payload hash is invalid.",
      "Quarantine the run and inspect its receipt/run-root binding before issuing more work.",
      { run_id: run.id, trigger_receipt_id: run.triggerReceiptId },
    );
  }
  const logical: Extract<AutomationWorkflowLogicalCommand, { kind: "start" }> = {
    kind: "start",
    command_id: `start:${run.id.slice("awrun_".length)}`,
    expected_revision: 0,
    run_id: run.id,
    project_id: run.projectId,
    automation_id: run.automationId,
    workflow_revision: revision.revision,
    trigger_output: triggerOutput,
  };
  const requestHash = await logicalRequestHash(
    run.id,
    logical,
    SYSTEM_ACTOR,
    run.executionAuthorityId,
  );
  if (requestHash !== run.requestHash) {
    throw errors.persistenceFailed(
      "The existing workflow run request hash differs from its canonical server-authored start command.",
      "Quarantine the run and inspect command-ledger integrity; never reconstruct trigger facts.",
      { run_id: run.id },
    );
  }
  const receipt = await readReceipt(tx, run.id, logical.command_id, requestHash);
  if (receipt) return suppressClosedAuthorityReplay(tx, run, receipt);
  throw errors.persistenceFailed(
    "The workflow run root exists without its atomic start command receipt.",
    "Quarantine the orphan run root; never retry by changing the idempotency key.",
    { run_id: run.id },
  );
}

export async function startAutomationWorkflowRun(
  db: Db,
  input: StartAutomationWorkflowRunInput,
): Promise<AutomationWorkflowCommandReceipt> {
  if (
    !ID.test(input.project_id) ||
    !/^[a-z][a-z0-9_-]{0,99}$/u.test(input.automation_id) ||
    !ID.test(input.trigger_receipt_id) ||
    !ID.test(input.runner_credential_id)
  ) {
    throw errors.invalidPayload({
      reason: "project_id, automation_id, trigger_receipt_id, or runner credential identity is invalid",
    });
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotency_key)) {
    throw errors.invalidPayload({ reason: "idempotency_key must contain 8-500 visible ASCII characters" });
  }
  const idempotencyKeyHash = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-start-idempotency-v1",
    project_id: input.project_id,
    automation_id: input.automation_id,
    key: input.idempotency_key,
  }));
  const existingRun = (
    await db.select().from(automationWorkflowRuns).where(and(
      eq(automationWorkflowRuns.projectId, input.project_id),
      eq(automationWorkflowRuns.automationId, input.automation_id),
      eq(automationWorkflowRuns.idempotencyKeyHash, idempotencyKeyHash),
    )).limit(1)
  )[0] ?? null;
  if (existingRun) {
    return db.transaction((tx) => recoverAutomationWorkflowStartReceipt(
      tx,
      existingRun,
      input.trigger_receipt_id,
    ));
  }

  return db.transaction(async (tx) => {
    const now = await databaseNow(tx, input.observed_at);
    await assertAutomationWritesOpen(tx as unknown as Db, input.project_id);
    const trigger = await loadAutomationWorkflowTriggerReceiptForStart(tx, {
      project_id: input.project_id,
      automation_id: input.automation_id,
      receipt_id: input.trigger_receipt_id,
      at: now,
    });
    if (trigger.outcome === "consumed") {
      const consumedRun = (
        await tx.select().from(automationWorkflowRuns).where(and(
          eq(automationWorkflowRuns.id, trigger.consumed_run_id),
          eq(automationWorkflowRuns.projectId, input.project_id),
          eq(automationWorkflowRuns.automationId, input.automation_id),
          eq(automationWorkflowRuns.triggerReceiptId, input.trigger_receipt_id),
        )).limit(1)
      )[0] ?? null;
      if (!consumedRun) throw errors.persistenceFailed(
        "The consumed trigger receipt references a missing workflow run.",
        "Quarantine workflow execution and repair the receipt/run-root binding before retrying.",
        { receipt_id: input.trigger_receipt_id, consumed_run_id: trigger.consumed_run_id },
      );
      return recoverAutomationWorkflowStartReceipt(tx, consumedRun, input.trigger_receipt_id);
    }

    const revision = await loadAutomationWorkflowRevision(
      tx as unknown as Db,
      input.project_id,
      trigger.workflow_revision_id,
    );
    if (!revision) throw errors.notFound("automation_workflow_revision");
    if (
      revision.automation_id !== input.automation_id ||
      revision.workflow_hash !== trigger.workflow_hash ||
      revision.compile_hash !== trigger.compile_hash
    ) {
      throw errors.persistenceFailed(
        "The trigger receipt differs from its immutable workflow revision.",
        "Do not start a run. Pause the workflow and inspect trigger/revision persistence integrity.",
        { receipt_id: input.trigger_receipt_id, workflow_revision_id: trigger.workflow_revision_id },
      );
    }
    const executionAuthority = (
      await tx.select().from(automationWorkflowExecutionAuthorities).where(and(
        eq(automationWorkflowExecutionAuthorities.id, trigger.execution_authority_id),
        eq(automationWorkflowExecutionAuthorities.projectId, input.project_id),
        eq(automationWorkflowExecutionAuthorities.automationId, input.automation_id),
        eq(automationWorkflowExecutionAuthorities.workflowRevisionId, trigger.workflow_revision_id),
        eq(automationWorkflowExecutionAuthorities.workflowHash, trigger.workflow_hash),
        eq(automationWorkflowExecutionAuthorities.compileHash, trigger.compile_hash),
        eq(automationWorkflowExecutionAuthorities.runnerCredentialId, input.runner_credential_id),
      )).limit(1)
    )[0] ?? null;
    if (!executionAuthority) {
      throw errors.persistenceFailed(
        "The trigger receipt has no exact immutable execution-authority receipt for this revision and runner.",
        "Do not start the run. Pause the workflow, inspect its enablement receipt, then save, review, and enable a new exact revision.",
        {
          receipt_id: input.trigger_receipt_id,
          workflow_revision_id: trigger.workflow_revision_id,
          execution_authority_id: trigger.execution_authority_id,
          runner_credential_id: input.runner_credential_id,
        },
      );
    }
    await validateTriggerAdapterBoundary(revision, trigger.trigger_output, now);
    if (trigger.attempt > revision.workflow.limits.max_attempts_per_trigger) {
      throw new AgentryError({
        status: 429,
        code: "automation_workflow_trigger_attempt_budget_exhausted",
        message: "The server-issued receipt exceeds the immutable per-trigger attempt budget.",
        nextAction: "Do not start or mint another attempt for this trigger identity. Inspect the receipt ledger and workflow revision.",
        details: {
          maximum: revision.workflow.limits.max_attempts_per_trigger,
          trigger_key: trigger.trigger_key,
          attempt: trigger.attempt,
        },
      });
    }
    const runDigest = await sha256Hex(canonicalJsonStringify({
      namespace: "agentry-automation-workflow-run-id-v1",
      project_id: input.project_id,
      automation_id: input.automation_id,
      workflow_revision_id: trigger.workflow_revision_id,
      execution_authority_id: trigger.execution_authority_id,
      trigger_receipt_id: input.trigger_receipt_id,
      idempotency_key_hash: idempotencyKeyHash,
    }));
    const runId = `awrun_${runDigest}`;
    const commandId = `start:${runDigest}`;
    const logical: Extract<AutomationWorkflowLogicalCommand, { kind: "start" }> = {
      kind: "start",
      command_id: commandId,
      expected_revision: 0,
      run_id: runId,
      project_id: input.project_id,
      automation_id: input.automation_id,
      workflow_revision: revision.revision,
      trigger_output: trigger.trigger_output,
    };
    const requestHash = await logicalRequestHash(
      runId,
      logical,
      SYSTEM_ACTOR,
      trigger.execution_authority_id,
    );
    const replay = await readReceipt(tx, runId, commandId, requestHash);
    if (replay) {
      const replayRun = (
        await tx.select().from(automationWorkflowRuns).where(
          eq(automationWorkflowRuns.id, runId),
        ).limit(1)
      )[0] ?? null;
      if (!replayRun) {
        throw errors.persistenceFailed(
          "The workflow start receipt exists without its immutable run root.",
          "Quarantine workflow execution and inspect command-ledger integrity.",
          { run_id: runId, command_id: commandId },
        );
      }
      await assertAutomationWorkflowRunExecutionAuthority(tx, replayRun);
      return suppressClosedAuthorityReplay(tx, replayRun, replay);
    }
    const limitsJson = canonicalJsonStringify(revision.workflow.limits);
    const limitsHash = await sha256Hex(limitsJson);
    const runnerCredentials = await tx.select({ id: projectCredentials.id }).from(projectCredentials).where(and(
      eq(projectCredentials.projectId, input.project_id),
      eq(projectCredentials.kind, "automation_runner"),
      eq(projectCredentials.automationId, input.automation_id),
      isNull(projectCredentials.revokedAt),
      gt(projectCredentials.expiresAt, now),
      notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
    )).limit(2);
    if (runnerCredentials.length !== 1 || runnerCredentials[0]!.id !== input.runner_credential_id) {
      throw errors.conflict(
        "automation_workflow_runner_credential_ambiguous",
        runnerCredentials.length === 0
          ? "The workflow has no active exact runner credential."
          : runnerCredentials.length > 1
            ? "The workflow has more than one active runner credential."
            : "The authenticated runner is not the workflow's one active exact credential.",
        "Keep the workflow disabled until exactly one unrevoked automation_runner credential is bound to this automation id, then authenticate with that credential.",
        {
          automation_id: input.automation_id,
          active_runner_credentials: runnerCredentials.length,
          authenticated_credential_id: input.runner_credential_id,
        },
      );
    }
    await assertAutomationWorkflowAuthorityOpen(
      tx,
      input.project_id,
      input.automation_id,
      trigger.workflow_revision_id,
      input.runner_credential_id,
      trigger.execution_authority_id,
    );
    const insertedRun = await tx.insert(automationWorkflowRuns).select(
      tx.select({
        id: sql<string>`${runId}`.as("id"),
        projectId: automationWorkflows.projectId,
        automationId: automationWorkflows.automationId,
        workflowRevisionId: sql<string>`${trigger.workflow_revision_id}`.as("workflow_revision_id"),
        workflowHash: sql<string>`${trigger.workflow_hash}`.as("workflow_hash"),
        compileHash: sql<string>`${trigger.compile_hash}`.as("compile_hash"),
        executionAuthorityId: sql<string>`${trigger.execution_authority_id}`.as("execution_authority_id"),
        executionDescriptorHash: sql<string>`${executionAuthority.descriptorHash}`.as("execution_descriptor_hash"),
        triggerReceiptId: sql<string>`${input.trigger_receipt_id}`.as("trigger_receipt_id"),
        triggerKind: sql<string>`${trigger.trigger_kind}`.as("trigger_kind"),
        triggerKey: sql<string>`${trigger.trigger_key}`.as("trigger_key"),
        triggerPayloadJson: sql<string>`${trigger.trigger_output_json}`.as("trigger_payload_json"),
        triggerPayloadHash: sql<string>`${trigger.trigger_output_hash}`.as("trigger_payload_hash"),
        attempt: sql<number>`${trigger.attempt}`.as("attempt"),
        idempotencyKeyHash: sql<string>`${idempotencyKeyHash}`.as("idempotency_key_hash"),
        requestHash: sql<string>`${requestHash}`.as("request_hash"),
        limitsJson: sql<string>`${limitsJson}`.as("limits_json"),
        limitsHash: sql<string>`${limitsHash}`.as("limits_hash"),
        runnerCredentialId: sql<string>`${input.runner_credential_id}`.as("runner_credential_id"),
        createdAt: sql<number>`${now}`.as("created_at"),
        updatedAt: sql<number>`${now}`.as("updated_at"),
      }).from(automationWorkflows).where(and(
        eq(automationWorkflows.projectId, input.project_id),
        eq(automationWorkflows.automationId, input.automation_id),
        eq(automationWorkflows.enabled, 1),
        eq(automationWorkflows.activeRevisionId, trigger.workflow_revision_id),
        eq(automationWorkflows.activeExecutionAuthorityId, trigger.execution_authority_id),
        automationWritesOpenForProject(automationWorkflows.projectId),
      )),
    ).onConflictDoNothing().returning();
    if (insertedRun.length !== 1) {
      throw errors.conflict(
        "automation_workflow_start_contention",
        "The trigger receipt or idempotency identity was consumed concurrently.",
        "Replay the exact start request to recover its durable command receipt, or read the receipt's consumed_run_id.",
        { run_id: runId, trigger_receipt_id: input.trigger_receipt_id },
      );
    }
    const run = insertedRun[0]!;
    await consumeAutomationWorkflowTriggerReceiptForRun(tx, {
      project_id: input.project_id,
      automation_id: input.automation_id,
      receipt_id: input.trigger_receipt_id,
      run_id: runId,
      at: now,
    });
    const chargeId = await sha256Hex(`workflow-run:${runId}`);
    if (!await reserveRollingCharge(tx, {
      id: chargeId,
      project_id: input.project_id,
      automation_id: input.automation_id,
      run_id: runId,
      kind: "run",
      subject_key: "run",
      node_id: null,
      effect_attempt: null,
      limit: revision.workflow.limits.max_runs_per_day,
      now,
    })) {
      const retryAt = await rollingBudgetRetryAt(tx, {
        project_id: input.project_id,
        automation_id: input.automation_id,
        kind: "run",
        now,
      });
      throw new AgentryError({
        status: 429,
        code: "automation_workflow_daily_run_budget_exhausted",
        message: "The rolling 24-hour workflow run budget is exhausted.",
        nextAction: "Wait until retry_at, then replay the same receipt and Idempotency-Key; do not change keys to bypass the budget.",
        details: { maximum: revision.workflow.limits.max_runs_per_day, retry_at: retryAt },
      });
    }
    const command: AutomationWorkflowRuntimeCommand = {
      ...logical,
      at: now,
      actor: SYSTEM_ACTOR,
    };
    const result = await executeWorkflowCommand(
      revision.compiled,
      null,
      command,
      { request_hash: requestHash },
    );
    return persistCommandResult(tx, {
      run,
      revision,
      prior_state: null,
      result,
      command,
      request_hash: requestHash,
      lease_epoch: null,
      fresh_effect_call: false,
    });
  });
}

export async function applyAutomationWorkflowCommand(
  db: Db,
  input: ApplyAutomationWorkflowCommandInput,
): Promise<AutomationWorkflowCommandReceipt> {
  if (!ID.test(input.run_id)) throw errors.invalidPayload({ reason: "run_id is invalid" });
  // Runtime replay retains the historical command variant, but production
  // persistence accepts reconciliation only through the evidence-bound effect
  // ledger service. Keep this guard for untyped/internal JSON callers as well
  // as excluding the variant from the TypeScript input contract above.
  if ((input.command as { kind: string }).kind === "effect_reconciled") {
    throw errors.conflict(
      "automation_workflow_effect_reconciliation_dedicated_service_required",
      "Generic workflow commands cannot assert an external provider reconciliation outcome.",
      "Use the evidence-bound effect reconciliation service; it advances live workflow/effect ledgers atomically and uses detached settlement only after the run is terminal.",
      { run_id: input.run_id },
    );
  }
  const requestHash = await logicalRequestHash(input.run_id, input.command, input.actor);
  return db.transaction(async (tx) => {
    const replay = await readReceipt(tx, input.run_id, input.command.command_id, requestHash);
    if (replay) {
      const replayRun = (
        await tx.select().from(automationWorkflowRuns).where(
          eq(automationWorkflowRuns.id, input.run_id),
        ).limit(1)
      )[0] ?? null;
      if (!replayRun) {
        throw errors.persistenceFailed(
          "The workflow command receipt exists without its immutable run root.",
          "Quarantine workflow execution and inspect command-ledger integrity.",
          { run_id: input.run_id, command_id: input.command.command_id },
        );
      }
      await assertAutomationWorkflowRunExecutionAuthority(tx, replayRun);
      return suppressClosedAuthorityReplay(tx, replayRun, replay);
    }
    const now = await databaseNow(tx, input.observed_at);
    const run = (
      await tx.select().from(automationWorkflowRuns).where(
        eq(automationWorkflowRuns.id, input.run_id),
      ).limit(1)
    )[0] ?? null;
    if (!run) throw errors.notFound("automation_workflow_run");
    await assertAutomationWorkflowRunExecutionAuthority(tx, run);
    await assertAutomationWritesOpen(tx as unknown as Db, run.projectId);
    const revision = await loadAutomationWorkflowRevision(
      tx as unknown as Db,
      run.projectId,
      run.workflowRevisionId,
    );
    if (!revision) throw errors.notFound("automation_workflow_revision");
    if (
      revision.automation_id !== run.automationId ||
      revision.workflow_hash !== run.workflowHash ||
      revision.compile_hash !== run.compileHash ||
      canonicalJsonStringify(revision.workflow.limits) !== run.limitsJson ||
      await sha256Hex(run.limitsJson) !== run.limitsHash
    ) {
      throw errors.persistenceFailed(
        "The workflow run root differs from its immutable revision policy.",
        "Quarantine the run and inspect the run-root/revision binding.",
        { run_id: run.id },
      );
    }
    const loaded = await loadAndVerifyState(tx, run, revision);
    const authority = await readAutomationWorkflowAuthority(
      tx,
      run.projectId,
      run.automationId,
      run.workflowRevisionId,
      run.runnerCredentialId,
      run.executionAuthorityId,
    );
    if (!authority.open && !mayProceedWhilePaused(input.command)) {
      await assertAutomationWorkflowAuthorityOpen(
        tx,
        run.projectId,
        run.automationId,
        run.workflowRevisionId,
        run.runnerCredentialId,
        run.executionAuthorityId,
      );
    }
    let leaseEpoch: number | null = null;
    if (isRunnerWorkCommand(input.command) && input.actor.principal === "automation_runner") {
      if (
        !input.actor.credential_id ||
        !input.lease
      ) {
        throw errors.forbidden();
      }
      await assertAutomationWorkflowRunLease(tx, {
        run_id: run.id,
        lease_epoch: input.lease.lease_epoch,
        holder_credential_id: input.actor.credential_id,
        lease_token: input.lease.lease_token,
        observed_at: now,
      });
      leaseEpoch = input.lease.lease_epoch;
    }
    const logicalCommand = materializeSystemOwnedCommandFields(
      revision,
      input.command,
      input.actor,
      now,
    );
    const command: AutomationWorkflowRuntimeCommand = {
      ...logicalCommand,
      at: now,
      actor: input.actor,
    } as AutomationWorkflowRuntimeCommand;
    await validateCommandAdapterBoundary(revision, loaded.state, logicalCommand, now);
    if (logicalCommand.kind === "effect_receipt_recorded") {
      const originalCall = await assertAutomationWorkflowEffectReceiptActor(tx, {
        run_id: run.id,
        node_id: logicalCommand.node_id,
        intent_hash: logicalCommand.intent_hash,
        actor: input.actor,
      });
      leaseEpoch = originalCall.call.leaseEpoch;
    }
    const result = await executeWorkflowCommand(
      revision.compiled,
      loaded.state,
      command,
      {
        request_hash: requestHash,
        halt_after_effect_settlement_reason: !authority.open &&
          input.command.kind === "effect_receipt_recorded"
          ? "kill_switch_active"
          : undefined,
      },
    );
    const effectCallStarted = result.events.find((event) => event.event === "effect.call_started");
    const freshEffectCall = effectCallStarted !== undefined;
    if (effectCallStarted) {
      const nodeId = effectCallStarted.node_id;
      if (!nodeId) {
        throw errors.persistenceFailed(
          "The emitted provider call-start event has no effect node binding.",
          "Roll back the command; never charge or authorize an unbound provider call.",
          { run_id: run.id, event_id: effectCallStarted.event_id },
        );
      }
      const priorCalls = (
        await tx.select({ count: sql<number>`count(*)` }).from(automationWorkflowBudgetCharges).where(and(
          eq(automationWorkflowBudgetCharges.runId, run.id),
          eq(automationWorkflowBudgetCharges.kind, "external_effect_call"),
        ))
      )[0]?.count ?? 0;
      if (priorCalls >= revision.workflow.limits.max_external_effects_per_run) {
        throw new AgentryError({
          status: 429,
          code: "automation_workflow_effect_run_budget_exhausted",
          message: "The aggregate per-run provider call budget is exhausted.",
          nextAction: "Do not call the provider. Escalate or inspect prior immutable effect attempts.",
          details: { maximum: revision.workflow.limits.max_external_effects_per_run },
        });
      }
      const effectAttempt = 1;
      const chargeId = await sha256Hex(`workflow-effect:${run.id}:${nodeId}:${effectAttempt}`);
      if (!await reserveRollingCharge(tx, {
        id: chargeId,
        project_id: run.projectId,
        automation_id: run.automationId,
        run_id: run.id,
        kind: "external_effect_call",
        subject_key: `${nodeId}:${effectAttempt}`,
        node_id: nodeId,
        effect_attempt: effectAttempt,
        limit: revision.workflow.limits.max_external_effects_per_day,
        now,
      })) {
        const retryAt = await rollingBudgetRetryAt(tx, {
          project_id: run.projectId,
          automation_id: run.automationId,
          kind: "external_effect_call",
          now,
        });
        throw new AgentryError({
          status: 429,
          code: "automation_workflow_effect_daily_budget_exhausted",
          message: "The rolling 24-hour provider call budget is exhausted.",
          nextAction: "Do not call the provider. Wait for a spent call authorization to leave the inclusive rolling window.",
          details: {
            maximum: revision.workflow.limits.max_external_effects_per_day,
            retry_at: retryAt,
          },
        });
      }
    }
    return persistCommandResult(tx, {
      run,
      revision,
      prior_state: loaded.state,
      result,
      command,
      request_hash: requestHash,
      lease_epoch: leaseEpoch,
      fresh_effect_call: freshEffectCall,
    });
  });
}

type ActionMaterializations = Readonly<{
  effect: typeof automationWorkflowEffects.$inferSelect | null;
  suspension: typeof automationWorkflowSuspensions.$inferSelect | null;
}>;

async function loadActionMaterializations(
  db: Db,
  run: typeof automationWorkflowRuns.$inferSelect,
  action: NonNullable<AutomationWorkflowNextAction>,
): Promise<ActionMaterializations> {
  let effect: typeof automationWorkflowEffects.$inferSelect | null = null;
  let suspension: typeof automationWorkflowSuspensions.$inferSelect | null = null;

  if (action.kind === "execute_effect" || action.kind === "reconcile_effect") {
    effect = (
      await db.select().from(automationWorkflowEffects).where(and(
        eq(automationWorkflowEffects.runId, run.id),
        eq(automationWorkflowEffects.nodeId, action.node_id),
      )).limit(1)
    )[0] ?? null;
    if (
      !effect ||
      effect.projectId !== run.projectId ||
      effect.automationId !== run.automationId ||
      effect.intentHash !== action.intent_hash ||
      effect.providerTarget !== action.provider_target ||
      effect.providerOperationKey !== action.intent_hash ||
      action.kind === "execute_effect" && effect.status !== "reserved" ||
      action.kind === "reconcile_effect" && effect.status !== "indeterminate"
    ) {
      throw errors.persistenceFailed(
        "The workflow next action differs from its durable effect projection.",
        "Quarantine the run and rebuild the effect projection from its immutable event ledgers before issuing work.",
        { run_id: run.id, node_id: action.node_id, effect_id: effect?.id ?? null },
      );
    }
    if (effect.approvalSuspensionId === null) {
      throw errors.persistenceFailed(
        "The external workflow effect has no durable approval suspension id.",
        "Stop before the provider call and rebuild the approval/effect materializations from the immutable run ledger.",
        { run_id: run.id, effect_id: effect.id },
      );
    }
    if (effect.approvalSuspensionId !== null) {
      suspension = (
        await db.select().from(automationWorkflowSuspensions).where(and(
          eq(automationWorkflowSuspensions.id, effect.approvalSuspensionId),
          eq(automationWorkflowSuspensions.runId, run.id),
        )).limit(1)
      )[0] ?? null;
      if (
        !suspension ||
        suspension.kind !== "approval" ||
        suspension.status !== "approved" ||
        suspension.bindingHash !== effect.approvalBindingHash
      ) {
        throw errors.persistenceFailed(
          "The workflow effect has no exact durable approved suspension binding.",
          "Stop before the provider call and rebuild the approval/effect materializations from the immutable run ledger.",
          { run_id: run.id, effect_id: effect.id },
        );
      }
    }
  } else if (action.kind === "await_approval" || action.kind === "suspended") {
    suspension = (
      await db.select().from(automationWorkflowSuspensions).where(and(
        eq(automationWorkflowSuspensions.runId, run.id),
        eq(automationWorkflowSuspensions.nodeId, action.node_id),
      )).limit(1)
    )[0] ?? null;
    const expectedKind = action.kind === "await_approval" ? "approval" : action.suspension;
    if (
      !suspension ||
      suspension.projectId !== run.projectId ||
      suspension.automationId !== run.automationId ||
      suspension.kind !== expectedKind ||
      suspension.status !== "pending" ||
      suspension.deadlineAt !== (action.kind === "await_approval" ? action.expires_at : action.deadline_at) ||
      action.kind === "await_approval" && suspension.bindingHash !== action.binding_hash ||
      action.kind === "suspended" && suspension.nextCheckAt !== action.next_check_at
    ) {
      throw errors.persistenceFailed(
        "The workflow next action differs from its durable suspension projection.",
        "Quarantine the run and rebuild the suspension projection from the immutable run ledger before resolving it.",
        { run_id: run.id, node_id: action.node_id, suspension_id: suspension?.id ?? null },
      );
    }
  }

  return { effect, suspension };
}

function requiredPrincipalForAction(
  revision: StoredAutomationWorkflowRevision,
  action: NonNullable<AutomationWorkflowNextAction>,
): AutomationWorkflowPrincipal {
  if (action.kind === "await_approval") return "human_project_owner";
  if (action.kind === "reconcile_effect") return "trusted_ci";
  if (action.kind === "suspended") return "agentry_system";
  const principal = revision.compiled.principals.by_node.find(
    (candidate) => candidate.node_id === action.node_id,
  )?.roles.executor;
  if (!principal) throw new Error(`workflow action ${action.node_id} has no frozen executor principal`);
  return principal;
}

async function recoverableNextAction(
  db: Db,
  run: typeof automationWorkflowRuns.$inferSelect,
  revision: StoredAutomationWorkflowRevision,
  state: AutomationWorkflowRunState,
  readyAt: number,
  action: NonNullable<AutomationWorkflowNextAction>,
): Promise<AutomationWorkflowRecoverableNextAction> {
  const materializations = await loadActionMaterializations(db, run, action);
  const requiredPrincipal = requiredPrincipalForAction(revision, action);
  const leaseRequired = requiredPrincipal === "automation_runner" && (
    action.kind === "execute_component" || action.kind === "execute_effect"
  );
  const routes = automationWorkflowRunRoutes(run.projectId, run.automationId, run.id);
  const operationPath = action.kind === "reconcile_effect"
    ? automationWorkflowEffectRoutes(
        run.projectId,
        run.automationId,
        run.id,
        materializations.effect!.id,
      ).reconcile
    : requiredPrincipal === "agentry_system"
      ? routes.advance
      : routes.commands;
  const currentLease = leaseRequired
    ? await readAutomationWorkflowRunLease(db, run.id)
    : null;
  const nextCheckAt = action.kind === "reconcile_effect"
    ? action.next_reconcile_at
    : action.kind === "suspended"
      ? action.next_check_at
      : null;
  const expiresAt = action.kind === "await_approval"
    ? action.expires_at
    : action.kind === "execute_effect" && materializations.suspension?.kind === "approval"
      ? materializations.suspension.deadlineAt
      : null;
  const actionReadyAt = nextCheckAt ?? readyAt;

  return {
    runtime: action,
    required_principal: requiredPrincipal,
    method: "POST",
    path: operationPath,
    expected_revision: state.revision,
    lease_required: leaseRequired,
    lease: leaseRequired ? {
      current: currentLease,
      acquire: { method: "POST", path: routes.lease },
      renew: { method: "POST", path: routes.lease_renew },
      release: { method: "DELETE", path: routes.lease },
    } : null,
    timing: {
      ready_at: actionReadyAt,
      next_check_at: nextCheckAt,
      expires_at: expiresAt,
      deadline_at: state.elapsed_deadline_at,
    },
    effect_id: materializations.effect?.id ?? null,
    effect_status: materializations.effect?.status ?? null,
    suspension_id: materializations.suspension?.id ?? null,
    suspension_kind: materializations.suspension?.kind ?? null,
    suspension_status: materializations.suspension?.status ?? null,
  };
}

function effectProjectionFailure(effectId: string, reason: string): never {
  throw errors.persistenceFailed(
    `The workflow effect projection or evidence ledger is inconsistent: ${reason}.`,
    "Stop reconciliation and rebuild the effect projection from its immutable hash-linked event ledger.",
    { effect_id: effectId },
  );
}

function evidenceString(
  value: unknown,
  field: string,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`provider evidence ${field} is invalid`);
  }
  return value;
}

function evidenceInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`provider evidence ${field} is invalid`);
  }
  return value as number;
}

async function providerEvidenceFromEvents(
  effect: typeof automationWorkflowEffects.$inferSelect,
  events: Array<typeof automationWorkflowEffectEvents.$inferSelect>,
): Promise<AutomationWorkflowEffectProviderEvidence | null> {
  for (const event of [...events].reverse()) {
    const payload = parseObject(event.payloadJson, "workflow effect event payload");
    if (await sha256Hex(event.payloadJson) !== event.payloadHash) {
      effectProjectionFailure(effect.id, "an effect-event payload hash does not match");
    }
    // Intent/call ledger entries also carry their owning workflow event under
    // `evidence`; only dedicated reconciliation entries add evidence_hash.
    if (payload.evidence_hash === undefined) continue;
    if (payload.evidence === undefined) {
      effectProjectionFailure(effect.id, "provider reconciliation evidence is missing");
    }
    if (!payload.evidence || typeof payload.evidence !== "object" || Array.isArray(payload.evidence)) {
      effectProjectionFailure(effect.id, "provider reconciliation evidence is not an object");
    }
    try {
      const evidence = payload.evidence as Record<string, unknown>;
      const evidenceHash = evidenceString(payload.evidence_hash, "evidence_hash", 64);
      if (await sha256Hex(canonicalJsonStringify(evidence)) !== evidenceHash) {
        throw new Error("provider evidence hash does not match");
      }
      const provider = evidenceString(evidence.provider, "provider", 100);
      if (provider !== "github") throw new Error("provider evidence is not github");
      const providerOperationKey = evidenceString(evidence.provider_operation_key, "provider_operation_key", 200);
      const providerTarget = evidenceString(evidence.provider_target, "provider_target", 2_000);
      const intentMarker = evidenceString(evidence.intent_marker, "intent_marker", 200);
      const expectedHeadSha = evidenceString(evidence.expected_head_sha, "expected_head_sha", 64);
      const lookupStartedAt = evidenceInteger(evidence.lookup_started_at, "lookup_started_at");
      const lookupCompletedAt = evidenceInteger(evidence.lookup_completed_at, "lookup_completed_at");
      const lookupResult = evidenceString(evidence.lookup_result, "lookup_result", 20);
      if (!new Set(["found", "not_found", "unknown"]).has(lookupResult)) {
        throw new Error("provider evidence lookup_result is invalid");
      }
      const matchedProviderRef = evidence.matched_provider_ref;
      if (matchedProviderRef !== null && (
        typeof matchedProviderRef !== "string" || matchedProviderRef.length < 1 || matchedProviderRef.length > 2_000
      )) {
        throw new Error("provider evidence matched_provider_ref is invalid");
      }
      if (
        providerOperationKey !== effect.providerOperationKey ||
        providerTarget !== effect.providerTarget ||
        intentMarker !== effect.intentHash ||
        lookupCompletedAt < lookupStartedAt
      ) {
        throw new Error("provider evidence differs from the immutable effect identity");
      }
      return {
        effect_event_id: event.id,
        effect_event_sequence: event.sequence,
        event: event.event,
        observed_at: event.at,
        actor_principal: event.actorPrincipal as AutomationWorkflowActor["principal"],
        evidence_hash: evidenceHash,
        provider: "github",
        provider_operation_key: providerOperationKey,
        provider_target: providerTarget,
        intent_marker: intentMarker,
        expected_head_sha: expectedHeadSha,
        lookup_started_at: lookupStartedAt,
        lookup_completed_at: lookupCompletedAt,
        lookup_result: lookupResult as AutomationWorkflowEffectProviderEvidence["lookup_result"],
        matched_provider_ref: matchedProviderRef as string | null,
      };
    } catch (error) {
      effectProjectionFailure(
        effect.id,
        error instanceof Error ? error.message : "provider evidence is invalid",
      );
    }
  }
  return null;
}

function automationWorkflowExecutionControl(
  run: typeof automationWorkflowRuns.$inferSelect,
  authority: AutomationWorkflowAuthority,
  nextActionSuppressed: boolean,
): AutomationWorkflowExecutionControl {
  const routes = automationWorkflowRunRoutes(run.projectId, run.automationId, run.id);
  const base = `/v1/projects/${encodeURIComponent(run.projectId)}`;
  if (authority.open) {
    return {
      execution_authorized: true,
      next_action_suppressed: false,
      project_control: { method: "GET", path: `${base}/automation-workflow-control` },
      workflow_control: {
        method: "GET",
        path: `${base}/automation-workflows/${encodeURIComponent(run.automationId)}`,
      },
      recovery: null,
    };
  }

  const deletionFenced = authority.reason === "project_deletion_fenced";
  const recoveryAllowed = !deletionFenced;
  const instruction = deletionFenced
    ? "Do not execute, cancel, settle, or reconcile new state. Resume the already-fenced project deletion with its original Idempotency-Key and frozen cleanup manifest."
    : authority.reason === "runner_credential_inactive"
      ? "This run's frozen runner credential cannot be replaced in place. Cancel the run or settle/reconcile only an already-started provider effect; create a new run only after one active exact runner credential is bound and the workflow is enabled."
      : authority.reason === "project_paused" || authority.reason === "project_control_missing"
        ? "Read project_control, resolve the project-wide authority state, and resume only after owner review. Cancellation and already-started effect recovery remain available while deletion is not fenced."
        : "Read workflow_control and restore only the exact reviewed revision after owner review. Cancellation and already-started effect recovery remain available while deletion is not fenced.";
  return {
    execution_authorized: false,
    next_action_suppressed: nextActionSuppressed,
    project_control: { method: "GET", path: `${base}/automation-workflow-control` },
    workflow_control: {
      method: "GET",
      path: `${base}/automation-workflows/${encodeURIComponent(run.automationId)}`,
    },
    recovery: {
      mode: deletionFenced ? "continue_project_deletion" : "restore_authority_or_cancel",
      instruction,
      deletion_command_id: authority.deletion_fence?.command_id ?? null,
      cancel_run: {
        allowed: recoveryAllowed,
        method: "POST",
        path: routes.cancel,
      },
      settle_already_started_effect: {
        allowed: recoveryAllowed,
        method: "POST",
        path: routes.commands,
      },
      reconcile_already_started_effect: {
        allowed: recoveryAllowed,
        instruction: recoveryAllowed
          ? "Read the exact indeterminate effect, then use only its evidence-bound trusted-CI reconciliation operation. This never authorizes another provider call."
          : "Use the frozen deletion manifest for external follow-up; the project deletion fence blocks new local reconciliation state.",
      },
    },
  };
}

export async function readAutomationWorkflowEffect(
  db: Db,
  projectId: string,
  automationId: string,
  runId: string,
  effectId: string,
) {
  const effect = (
    await db.select().from(automationWorkflowEffects).where(and(
      eq(automationWorkflowEffects.id, effectId),
      eq(automationWorkflowEffects.projectId, projectId),
      eq(automationWorkflowEffects.automationId, automationId),
      eq(automationWorkflowEffects.runId, runId),
    )).limit(1)
  )[0] ?? null;
  if (!effect) return null;
  const events = await db.select().from(automationWorkflowEffectEvents).where(
    eq(automationWorkflowEffectEvents.effectId, effect.id),
  ).orderBy(asc(automationWorkflowEffectEvents.sequence));
  if (events.length < 1 || events.length > effect.maxReconciliations + 2) {
    effectProjectionFailure(effect.id, "the bounded effect-event count is invalid");
  }
  for (const [index, event] of events.entries()) {
    if (
      event.sequence !== index + 1 ||
      event.projectId !== effect.projectId ||
      event.automationId !== effect.automationId ||
      event.runId !== effect.runId ||
      event.priorEventHash !== (index === 0 ? null : events[index - 1]!.id)
    ) {
      effectProjectionFailure(effect.id, "the effect-event identity or hash chain is broken");
    }
    if (await sha256Hex(event.payloadJson) !== event.payloadHash) {
      effectProjectionFailure(effect.id, "an effect-event payload hash does not match");
    }
  }
  const firstEvent = events[0]!;
  const lastEvent = events.at(-1)!;
  const expectedLastEvent = effect.status === "reserved"
    ? "effect.intent_reserved"
    : effect.status === "succeeded"
      ? "effect.completed"
      : effect.status === "manual_follow_up"
        ? "effect.reconciliation_exhausted"
        : new Set([
            "effect.call_started",
            "effect.reconciled_absent",
            "effect.reconciliation_unknown",
          ]).has(lastEvent.event)
          ? lastEvent.event
          : null;
  if (
    firstEvent.id !== effect.createdEventId ||
    firstEvent.event !== "effect.intent_reserved" ||
    lastEvent.id !== effect.lastEventId ||
    lastEvent.event !== expectedLastEvent ||
    lastEvent.effectAttempt !== effect.callAttempt ||
    lastEvent.reconciliationCount !== effect.reconciliationCount
  ) {
    effectProjectionFailure(effect.id, "the indexed effect state differs from its last event");
  }
  if (
    effect.receiptJson !== null && await sha256Hex(effect.receiptJson) !== effect.receiptHash ||
    effect.status === "succeeded" && (effect.receiptJson === null || effect.receiptHash === null) ||
    effect.status !== "succeeded" && (effect.receiptJson !== null || effect.receiptHash !== null)
  ) {
    effectProjectionFailure(effect.id, "the provider receipt hash/status binding is invalid");
  }
  const approval = effect.approvalSuspensionId === null
    ? null
    : (
        await db.select().from(automationWorkflowSuspensions).where(and(
          eq(automationWorkflowSuspensions.id, effect.approvalSuspensionId),
          eq(automationWorkflowSuspensions.runId, effect.runId),
        )).limit(1)
      )[0] ?? null;
  if (
    !approval ||
    approval.kind !== "approval" ||
    approval.bindingHash !== effect.approvalBindingHash
  ) {
    effectProjectionFailure(effect.id, "the approval suspension binding is missing or invalid");
  }
  const evidence = await providerEvidenceFromEvents(effect, events);
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(clock.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("database clock did not return unix seconds");
  const due = effect.status === "indeterminate" &&
    effect.reconcileAfterAt !== null &&
    now >= effect.reconcileAfterAt;
  const routes = automationWorkflowEffectRoutes(
    effect.projectId,
    effect.automationId,
    effect.runId,
    effect.id,
  );

  return {
    kind: "automation_workflow_effect" as const,
    schema_version: "1" as const,
    project_id: effect.projectId,
    automation_id: effect.automationId,
    run_id: effect.runId,
    effect_id: effect.id,
    node_id: effect.nodeId,
    component: {
      id: effect.componentId,
      version: effect.componentVersion,
      component_hash: effect.componentHash,
    },
    status: effect.status,
    version: effect.version,
    input_hash: effect.inputHash,
    intent_hash: effect.intentHash,
    approval: {
      suspension_id: approval.id,
      binding_hash: approval.bindingHash,
      status: approval.status,
      expires_at: approval.deadlineAt,
      resolved_at: approval.resolvedAt,
    },
    provider: {
      target: effect.providerTarget,
      operation_key: effect.providerOperationKey,
      call_attempt: effect.callAttempt,
      maximum_call_attempts: effect.maxCallAttempts,
      call_started_at: effect.callStartedAt,
      provider_ref: effect.providerRef,
      receipt_hash: effect.receiptHash,
      completed_at: effect.completedAt,
    },
    reconciliation: {
      count: effect.reconciliationCount,
      maximum: effect.maxReconciliations,
      remaining: effect.maxReconciliations - effect.reconciliationCount,
      next_reconcile_at: effect.reconcileAfterAt,
      due,
      operation: effect.status === "indeterminate"
        ? {
            method: "POST" as const,
            path: routes.reconcile,
            required_principal: "trusted_ci" as const,
            idempotency_key_required: true as const,
          }
        : null,
      last_provider_evidence: evidence,
    },
    ledger: {
      created_event_id: effect.createdEventId,
      last_event_id: effect.lastEventId,
      event_count: events.length,
      last_event: {
        id: lastEvent.id,
        sequence: lastEvent.sequence,
        event: lastEvent.event,
        at: lastEvent.at,
        actor_principal: lastEvent.actorPrincipal as AutomationWorkflowActor["principal"],
      },
    },
    provider_call_authorized: false as const,
    created_at: effect.createdAt,
    updated_at: effect.updatedAt,
  };
}

export async function readAutomationWorkflowRun(
  db: Db,
  projectId: string,
  runId: string,
) {
  const run = (
    await db.select().from(automationWorkflowRuns).where(and(
      eq(automationWorkflowRuns.id, runId),
      eq(automationWorkflowRuns.projectId, projectId),
    )).limit(1)
  )[0] ?? null;
  if (!run) return null;
  await assertAutomationWorkflowRunExecutionAuthority(db, run);
  const revision = await loadAutomationWorkflowRevision(db, projectId, run.workflowRevisionId);
  if (!revision) throw errors.persistenceFailed(
    "The workflow run references a missing immutable revision.",
    "Quarantine workflow execution and inspect database integrity.",
    { run_id: runId },
  );
  const loaded = await loadAndVerifyState(db as unknown as Transaction, run, revision);
  const authority = await readAutomationWorkflowAuthority(
    db,
    run.projectId,
    run.automationId,
    run.workflowRevisionId,
    run.runnerCredentialId,
    run.executionAuthorityId,
  );
  const nextAction = await nextAutomationWorkflowAction(revision.compiled, loaded.state);
  const recoverableAction = authority.open && nextAction
    ? await recoverableNextAction(
        db,
        run,
        revision,
        loaded.state,
        loaded.projection.updatedAt,
        nextAction,
      )
    : null;
  const executionControl = automationWorkflowExecutionControl(
    run,
    authority,
    !authority.open && nextAction !== null,
  );
  return {
    kind: "automation_workflow_run" as const,
    schema_version: "1" as const,
    project_id: run.projectId,
    automation_id: run.automationId,
    run_id: run.id,
    workflow_revision_id: run.workflowRevisionId,
    workflow_hash: run.workflowHash,
    compile_hash: run.compileHash,
    execution_authority_id: run.executionAuthorityId,
    execution_descriptor_hash: run.executionDescriptorHash,
    trigger_receipt_id: run.triggerReceiptId,
    trigger_kind: run.triggerKind,
    trigger_key: run.triggerKey,
    attempt: run.attempt,
    runner_credential_id: run.runnerCredentialId,
    authority,
    execution_control: executionControl,
    state: loaded.state,
    next_action: recoverableAction,
  };
}
