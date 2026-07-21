import {
  canonicalJsonStringify,
  sha256Hex,
  type AutomationWorkflowDefinition,
  type AutomationWorkflowJsonValue,
  type AutomationWorkflowNode,
} from "@agentrysh/shared";
import {
  automationWorkflowComponentKey,
  type AutomationWorkflowPrincipal,
} from "./automation-workflow-components.js";
import {
  getAutomationWorkflowDataContract,
  serializeAutomationWorkflowDataContract,
  validateAutomationWorkflowPayload,
} from "./automation-workflow-contracts.js";
import type { CompiledAutomationWorkflow } from "./automation-workflow-compiler.js";

export const AUTOMATION_WORKFLOW_EVENT_VERSION = "1" as const;
export const AUTOMATION_WORKFLOW_RUNTIME_VERSION = "1" as const;
export const AUTOMATION_WORKFLOW_MAX_EFFECT_RECONCILIATIONS = 3;

export type AutomationWorkflowRunStatus =
  | "running"
  | "awaiting_component"
  | "awaiting_approval"
  | "effect_reserved"
  | "effect_indeterminate"
  | "waiting"
  | "verifying"
  | "completed"
  | "escalated"
  | "cancelled"
  | "quarantined";

export type AutomationWorkflowActor = {
  principal: AutomationWorkflowPrincipal;
  credential_id: string | null;
};

export type AutomationWorkflowRunOutput = {
  node_id: string;
  contract: string;
  schema_hash: string;
  assurance: "reported" | "recorded" | "observed" | "verified";
  payload: AutomationWorkflowJsonValue;
  payload_hash: string;
  recorded_at: number;
};

export type AutomationWorkflowApprovalState = {
  approval_node_id: string;
  effect_node_id: string;
  subject_node_id: string;
  subject_port: string;
  subject_hash: string;
  binding_hash: string;
  provider_target: string;
  expires_at: number;
  status: "pending" | "approved" | "rejected" | "expired";
  decided_at: number | null;
};

export type AutomationWorkflowEffectState = {
  node_id: string;
  component_hash: string;
  input_hash: string;
  intent_hash: string;
  provider_target: string;
  status: "reserved" | "indeterminate" | "succeeded";
  reconciliation_count: number;
  next_reconcile_at: number | null;
  reserved_at: number;
  call_started_at: number | null;
  completed_at: number | null;
};

export type AutomationWorkflowPendingState =
  | {
      kind: "component";
      node_id: string;
      attempt: number;
      component_hash: string;
      input_hash: string;
      usage_sequence: number | null;
    }
  | ({ kind: "approval"; node_id: string } & AutomationWorkflowApprovalState)
  | {
      kind: "effect";
      node_id: string;
      component_hash: string;
      input_hash: string;
      intent_hash: string;
      provider_target: string;
      status: "reserved" | "indeterminate";
      reconciliation_count: number;
      next_reconcile_at: number | null;
    }
  | {
      kind: "wait";
      node_id: string;
      input_hash: string;
      started_at: number;
      deadline_at: number;
      next_check_at: number;
    }
  | {
      kind: "verify";
      node_id: string;
      input_hash: string;
      started_at: number;
      deadline_at: number;
      next_check_at: number;
    };

export type AutomationWorkflowRunState = {
  runtime_version: typeof AUTOMATION_WORKFLOW_RUNTIME_VERSION;
  run_id: string;
  project_id: string;
  automation_id: string;
  workflow_revision: number;
  workflow_hash: string;
  compile_hash: string;
  revision: number;
  status: AutomationWorkflowRunStatus;
  current_node_id: string | null;
  outputs: Record<string, AutomationWorkflowRunOutput>;
  attempts: Record<string, number>;
  approvals: Record<string, AutomationWorkflowApprovalState>;
  effects: Record<string, AutomationWorkflowEffectState>;
  pending: AutomationWorkflowPendingState | null;
  active_runtime_seconds: number;
  active_started_at: number | null;
  usage_sequence: number;
  turns_used: number;
  cost_micros: number;
  changed_files: string[];
  changed_line_churn: number;
  started_at: number;
  elapsed_deadline_at: number;
  last_event_at: number;
  last_event_hash: string;
  last_command_id: string;
  last_request_hash: string;
  last_actor: AutomationWorkflowActor;
  terminal: null | {
    outcome: "complete" | "escalate" | "cancelled" | "quarantined";
    node_id: string | null;
    result_node_id?: string;
    destination?: string;
    instructions?: string;
    reason?: string;
    at: number;
  };
};

export type AutomationWorkflowAdapterUsage = {
  /** Strictly contiguous adapter observation sequence for this run. */
  sequence: number;
  /** Cumulative model turns observed across the run. */
  turns_used: number;
  /** Cumulative integer micro-dollars observed across the run. */
  cost_micros: number;
  /** Sorted unique repository-relative files touched by this component attempt. */
  touched_files: string[];
  /** Added-plus-deleted line churn observed for this component attempt. */
  changed_line_churn: number;
};

export type AutomationWorkflowRunEvent = {
  event_id: string;
  prior_event_hash: string | null;
  event_version: typeof AUTOMATION_WORKFLOW_EVENT_VERSION;
  run_id: string;
  sequence: number;
  command_id: string;
  request_hash: string;
  event: string;
  at: number;
  actor: AutomationWorkflowActor;
  workflow_hash: string;
  compile_hash: string;
  node_id: string | null;
  component_hash: string | null;
  payload_schema_ref: string | null;
  payload_hash: string;
  payload: Record<string, AutomationWorkflowJsonValue>;
};

type RuntimeCommandBase = {
  command_id: string;
  expected_revision: number;
  at: number;
  actor: AutomationWorkflowActor;
};

export type AutomationWorkflowRuntimeCommand =
  | (RuntimeCommandBase & {
      kind: "start";
      run_id: string;
      project_id: string;
      automation_id: string;
      workflow_revision: number;
      trigger_output: unknown;
    })
  | (RuntimeCommandBase & {
      kind: "component_succeeded";
      node_id: string;
      output: unknown;
      usage?: AutomationWorkflowAdapterUsage;
    })
  | (RuntimeCommandBase & {
      kind: "component_domain_failed";
      node_id: string;
      error: { code: string; message: string };
      usage?: AutomationWorkflowAdapterUsage;
    })
  | (RuntimeCommandBase & {
      kind: "approval_decided";
      node_id: string;
      decision: "approved" | "rejected";
      reason: string;
    })
  | (RuntimeCommandBase & {
      kind: "effect_call_started";
      node_id: string;
      intent_hash: string;
    })
  | (RuntimeCommandBase & {
      kind: "effect_receipt_recorded";
      node_id: string;
      intent_hash: string;
      output: unknown;
    })
  | (RuntimeCommandBase & {
      kind: "effect_reconciled";
      node_id: string;
      intent_hash: string;
      outcome: "found" | "absent" | "unknown";
      output?: unknown;
    })
  | (RuntimeCommandBase & {
      kind: "wait_resolved";
      node_id: string;
      outcome: "ready" | "timeout" | "domain_error";
      output?: unknown;
      error?: { code: string; message: string };
    })
  | (RuntimeCommandBase & {
      kind: "verification_resolved";
      node_id: string;
      outcome: "pending" | "pass" | "fail" | "timeout" | "domain_error";
      output?: unknown;
      next_check_at?: number;
      error?: { code: string; message: string };
    })
  | (RuntimeCommandBase & { kind: "tick" })
  | (RuntimeCommandBase & { kind: "cancel"; reason: string })
  | (RuntimeCommandBase & { kind: "quarantine"; reason: string });

export type AutomationWorkflowNextAction =
  | {
      kind: "execute_component";
      node_id: string;
      attempt: number;
      component: { id: string; version: string };
      component_hash: string;
      config: Record<string, AutomationWorkflowJsonValue>;
      inputs: Record<string, AutomationWorkflowRunOutput>;
      input_hash: string;
      output_contract: string;
      output_schema_hash: string;
      output_minimum_assurance: AutomationWorkflowRunOutput["assurance"];
    }
  | {
      kind: "await_approval";
      node_id: string;
      effect_node_id: string;
      subject_hash: string;
      binding_hash: string;
      expires_at: number;
    }
  | {
      kind: "execute_effect";
      node_id: string;
      component: { id: string; version: string };
      component_hash: string;
      intent_hash: string;
      provider_target: string;
      input_hash: string;
      inputs: Record<string, AutomationWorkflowRunOutput>;
    }
  | {
      kind: "reconcile_effect";
      node_id: string;
      intent_hash: string;
      provider_target: string;
      reconciliation_count: number;
      next_reconcile_at: number;
    }
  | {
      kind: "suspended";
      suspension: "wait" | "verify";
      node_id: string;
      next_check_at: number;
      deadline_at: number;
    }
  | null;

export type AutomationWorkflowRuntimeResult = {
  state: AutomationWorkflowRunState;
  events: AutomationWorkflowRunEvent[];
  next_action: AutomationWorkflowNextAction;
};

export type AutomationWorkflowRuntimeOptions = {
  /** Stable hash of the persisted logical request, excluding server-observed execution time. */
  request_hash?: string;
  /**
   * Live authority may close after provider call-start. The service can still
   * settle that exact effect, then force a terminal stop before any downstream
   * node is issued.
   */
  halt_after_effect_settlement_reason?: "kill_switch_active";
};

export class AutomationWorkflowRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly next_action: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AutomationWorkflowRuntimeError";
  }
}

type RuntimeContext = {
  compiled: CompiledAutomationWorkflow;
  command: AutomationWorkflowRuntimeCommand;
  request_hash: string;
  state: AutomationWorkflowRunState | null;
  events: AutomationWorkflowRunEvent[];
};

const TERMINAL_STATUSES = new Set<AutomationWorkflowRunStatus>([
  "completed",
  "escalated",
  "cancelled",
  "quarantined",
]);

const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const EVENT_NAMES = new Set([
  "run.started",
  "run.usage_recorded",
  "trigger.completed",
  "node.ready",
  "node.completed",
  "node.domain_failed",
  "condition.evaluated",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "effect.intent_reserved",
  "effect.call_started",
  "effect.completed",
  "effect.reconciled_absent",
  "effect.reconciliation_unknown",
  "effect.reconciliation_exhausted",
  "wait.registered",
  "wait.ready",
  "wait.timed_out",
  "wait.domain_failed",
  "verification.started",
  "verification.pending",
  "verification.passed",
  "verification.failed",
  "verification.timed_out",
  "verification.domain_failed",
  "run.completed",
  "run.escalated",
  "run.cancelled",
  "run.quarantined",
]);
const PRINCIPALS = new Set<AutomationWorkflowPrincipal>([
  "agentry_system",
  "automation_runner",
  "human_project_owner",
  "customer_posthog",
  "trusted_ci",
]);

export async function executeAutomationWorkflowCommand(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState | null,
  command: AutomationWorkflowRuntimeCommand,
  options: AutomationWorkflowRuntimeOptions = {},
): Promise<AutomationWorkflowRuntimeResult> {
  assertCompiledRuntimeBinding(compiled);
  assertCommandEnvelope(state, command);
  if (options.request_hash !== undefined && !SHA256_HEX.test(options.request_hash)) {
    runtimeError(
      "request_hash_invalid",
      "The persisted request hash must be a lowercase SHA-256 value.",
      "Hash the stable logical request envelope and pass its exact 64-character lowercase digest.",
    );
  }
  if (
    options.halt_after_effect_settlement_reason !== undefined &&
    options.halt_after_effect_settlement_reason !== "kill_switch_active"
  ) {
    runtimeError(
      "effect_settlement_halt_reason_invalid",
      "The post-effect halt reason is not a supported live-authority control.",
      "Use only the server-derived kill-switch halt reason.",
    );
  }
  const requestHash = options.request_hash ?? await hashJson(command);
  const context: RuntimeContext = {
    compiled,
    command,
    request_hash: requestHash,
    state,
    events: [],
  };

  if (command.kind === "start") {
    if (state !== null) runtimeError("run_already_started", "The run already has durable state.", "Replay the original start command or continue the current run revision.");
    await startRun(context, command);
  } else {
    if (!state) runtimeError("run_not_started", "The run has no durable start event.", "Start it from one exact server-issued trigger receipt.");
    assertStateBinding(compiled, state);
    if (TERMINAL_STATUSES.has(state.status)) {
      runtimeError("run_terminal", `Run is already ${state.status}.`, "Read the terminal receipt; terminal workflow runs cannot be revived.");
    }
    const activeAtCommand = state.active_runtime_seconds + (
      state.active_started_at === null ? 0 : Math.max(0, command.at - state.active_started_at)
    );
    const terminalControl = command.kind === "cancel" || command.kind === "quarantine";
    const effectSettlement = command.kind === "effect_receipt_recorded" || command.kind === "effect_reconciled";
    const exhaustedReason = command.at >= state.elapsed_deadline_at
      ? "elapsed_deadline_exceeded"
      : activeAtCommand >= compiled.workflow.limits.max_active_runtime_seconds
        ? "active_runtime_budget_exceeded"
        : null;
    if (exhaustedReason && !terminalControl && !effectSettlement) {
      await appendEvent(context, "run.quarantined", state.current_node_id, null, null, {
        reason: exhaustedReason,
      });
    } else {
      await applyCommand(context, command);
      const settlementStopReason = effectSettlement
        ? options.halt_after_effect_settlement_reason ?? exhaustedReason
        : null;
      if (settlementStopReason && context.state && !TERMINAL_STATUSES.has(context.state.status)) {
        await appendEvent(context, "run.quarantined", context.state.current_node_id, null, null, {
          reason: settlementStopReason,
        });
      }
    }
  }

  if (context.state && context.state.status === "running") {
    await drainInternalNodes(context);
  }
  if (!context.state) throw new Error("workflow runtime produced no state");
  return {
    state: context.state,
    events: context.events,
    next_action: await nextAutomationWorkflowAction(compiled, context.state),
  };
}

async function startRun(
  context: RuntimeContext,
  command: Extract<AutomationWorkflowRuntimeCommand, { kind: "start" }>,
) {
  requirePrincipal(command.actor, "agentry_system", "Only Agentry may consume a trigger receipt and start a workflow run.");
  if (command.expected_revision !== 0) runtimeError("run_revision_conflict", "A start command must expect revision 0.", "Reload the run; start only when no event exists.");
  if (command.automation_id !== context.compiled.workflow.id) {
    runtimeError("automation_binding_mismatch", "The run automation id does not match the compiled workflow.", "Use the exact workflow id bound to the trigger receipt.");
  }
  if (!Number.isSafeInteger(command.workflow_revision) || command.workflow_revision < 1) {
    runtimeError("workflow_revision_invalid", "workflow_revision must be a positive integer.", "Load the persisted immutable workflow revision.");
  }
  const trigger = nodeById(context.compiled.workflow, context.compiled.workflow.entry);
  if (trigger.kind !== "trigger") throw new Error("compiled workflow entry is not a trigger");
  const resolved = resolvedNode(context.compiled, trigger.id);
  const output = await validatedOutput(resolved, command.trigger_output, command.at);
  assertTriggerReceiptEligible(output, command.at);
  await appendEvent(context, "run.started", trigger.id, resolved.component_hash, null, {
    project_id: command.project_id,
    automation_id: command.automation_id,
    workflow_revision: command.workflow_revision,
    started_at: command.at,
    elapsed_deadline_at: command.at + context.compiled.workflow.limits.max_elapsed_seconds,
  });
  await appendEvent(context, "trigger.completed", trigger.id, resolved.component_hash, output.contract, {
    output: output.payload,
    output_hash: output.payload_hash,
    output_schema_hash: output.schema_hash,
    output_assurance: output.assurance,
    next_node_id: trigger.next,
  });
}

async function applyCommand(
  context: RuntimeContext,
  command: Exclude<AutomationWorkflowRuntimeCommand, { kind: "start" }>,
) {
  const state = context.state!;
  switch (command.kind) {
    case "component_succeeded": {
      const pending = requirePending(state, "component", command.node_id);
      const node = nodeById(context.compiled.workflow, command.node_id);
      if (!["query", "agent_task", "effect"].includes(node.kind)) invalidNodeCommand(node, command.kind);
      const componentNode = node as Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" }>;
      const component = componentForNode(context.compiled, componentNode);
      if (node.kind === "effect" && component.side_effect.kind === "external_provider") {
        runtimeError("effect_protocol_required", "External effects cannot complete through the generic component command.", "Reserve the intent, record call start, then record or reconcile its receipt.");
      }
      requirePrincipal(command.actor, component.principal_roles.executor, "The authenticated principal is not this component's declared executor.");
      const output = await validatedOutput(resolvedNode(context.compiled, node.id), command.output, command.at);
      await appendAgentUsage(context, componentNode, pending.component_hash, command.usage);
      const budgetReason = agentUsageBudgetExceeded(context.compiled, context.state!);
      if (budgetReason) {
        await appendEvent(context, "run.quarantined", node.id, null, null, { reason: budgetReason });
        break;
      }
      await appendEvent(context, "node.completed", node.id, pending.component_hash, output.contract, {
        output: output.payload,
        output_hash: output.payload_hash,
        output_schema_hash: output.schema_hash,
        output_assurance: output.assurance,
        exit: "next",
        next_node_id: linearNext(componentNode),
      });
      break;
    }
    case "component_domain_failed": {
      const pending = requirePending(state, "component", command.node_id);
      const node = nodeById(context.compiled.workflow, command.node_id);
      if (!["query", "agent_task", "effect"].includes(node.kind)) invalidNodeCommand(node, command.kind);
      const componentNode = node as Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" }>;
      const component = componentForNode(context.compiled, componentNode);
      requirePrincipal(command.actor, component.principal_roles.executor, "The authenticated principal is not this component's declared executor.");
      const error = boundedDomainError(command.error);
      await appendAgentUsage(context, componentNode, pending.component_hash, command.usage);
      const budgetReason = agentUsageBudgetExceeded(context.compiled, context.state!);
      if (budgetReason) {
        await appendEvent(context, "run.quarantined", node.id, null, null, { reason: budgetReason });
        break;
      }
      await appendEvent(context, "node.domain_failed", node.id, pending.component_hash, null, {
        error,
        exit: "on_error",
        next_node_id: linearError(componentNode),
      });
      break;
    }
    case "approval_decided": {
      const pending = requirePending(state, "approval", command.node_id);
      requirePrincipal(command.actor, "human_project_owner", "Only a project owner may decide a workflow approval.");
      if (command.at >= pending.expires_at) {
        runtimeError("approval_expired", "The approval deadline has passed.", "Run the lifecycle tick so the immutable expired branch is recorded.");
      }
      const reason = boundedReason(command.reason);
      const node = nodeById(context.compiled.workflow, command.node_id);
      if (node.kind !== "approval") invalidNodeCommand(node, command.kind);
      const next = command.decision === "approved" ? node.on_approved : node.on_rejected;
      await appendEvent(context, `approval.${command.decision}`, node.id, null, null, {
        reason,
        effect_node_id: pending.effect_node_id,
        next_node_id: next,
      });
      break;
    }
    case "effect_call_started": {
      const pending = requirePending(state, "effect", command.node_id);
      requirePrincipal(command.actor, "automation_runner", "Only the exact automation runner may begin this external effect.");
      requireIntent(pending, command.intent_hash);
      if (pending.status !== "reserved") runtimeError("effect_indeterminate", "This effect already has an unresolved provider call.", "Reconcile the existing intent before any repeat.");
      const approval = state.approvals[command.node_id];
      if (!approval || approval.status !== "approved" || command.at >= approval.expires_at) {
        runtimeError(
          "effect_approval_expired",
          "The exact approval expired before the provider call began.",
          "Do not call the provider. Escalate or start a new run that obtains fresh exact approval.",
        );
      }
      await appendEvent(context, "effect.call_started", command.node_id, pending.component_hash, null, {
        intent_hash: pending.intent_hash,
        next_reconcile_at: nextEffectReconcileAt(context.compiled, state, command.at),
      });
      break;
    }
    case "effect_receipt_recorded": {
      const pending = requirePending(state, "effect", command.node_id);
      requirePrincipal(command.actor, "automation_runner", "Only the exact automation runner may report its provider receipt.");
      requireIntent(pending, command.intent_hash);
      if (pending.status !== "indeterminate") runtimeError("effect_call_not_started", "No durable call-start marker exists for this effect.", "Record call start before invoking the provider.");
      await completeExternalEffect(context, command.node_id, command.output, "reported");
      break;
    }
    case "effect_reconciled": {
      const pending = requirePending(state, "effect", command.node_id);
      if (!new Set<AutomationWorkflowPrincipal>(["agentry_system", "trusted_ci"]).has(command.actor.principal)) {
        runtimeError("principal_not_allowed", "Effect reconciliation requires Agentry or trusted CI evidence.", "Use the adapter's trusted reconciliation operation.");
      }
      requireIntent(pending, command.intent_hash);
      if (pending.status !== "indeterminate") runtimeError("effect_not_indeterminate", "Only an indeterminate provider call needs reconciliation.", "Continue the current effect action returned by the runtime.");
      if (!new Set(["found", "absent", "unknown"]).has(command.outcome)) {
        runtimeError(
          "effect_reconciliation_outcome_invalid",
          "Effect reconciliation outcome must be found, absent, or unknown.",
          "Return found only with a typed receipt, absent only with definitive non-application evidence, or unknown when provider state remains inconclusive.",
        );
      }
      if (pending.next_reconcile_at === null || command.at < pending.next_reconcile_at) {
        runtimeError(
          "effect_reconciliation_not_due",
          "The bounded reconciliation interval has not elapsed.",
          "Wait until the exact next_reconcile_at returned by the runtime; a direct provider receipt may still be recorded immediately.",
        );
      }
      if (command.outcome === "found") {
        if (command.output === undefined) runtimeError("effect_receipt_missing", "Found reconciliation requires the typed provider receipt.", "Return the exact object observed at the provider.");
        await completeExternalEffect(context, command.node_id, command.output, "observed");
      } else {
        if (command.output !== undefined) {
          runtimeError(
            "effect_receipt_unexpected",
            `${command.outcome === "absent" ? "Absent" : "Unknown"} reconciliation cannot include a success receipt.`,
            command.outcome === "absent"
              ? "Omit output only after the adapter definitively proves provider absence."
              : "Omit output when the adapter cannot yet determine whether the provider applied the intent.",
          );
        }
        const reconciliationCount = pending.reconciliation_count + 1;
        if (reconciliationCount >= AUTOMATION_WORKFLOW_MAX_EFFECT_RECONCILIATIONS) {
          await appendEvent(context, "effect.reconciliation_exhausted", command.node_id, pending.component_hash, null, {
            intent_hash: pending.intent_hash,
            reconciliation_count: reconciliationCount,
          });
          await appendEvent(context, "run.quarantined", command.node_id, null, null, {
            reason: "effect_reconciliation_exhausted_manual_follow_up_required",
          });
        } else {
          await appendEvent(context, command.outcome === "absent" ? "effect.reconciled_absent" : "effect.reconciliation_unknown", command.node_id, pending.component_hash, null, {
            intent_hash: pending.intent_hash,
            reconciliation_count: reconciliationCount,
            next_reconcile_at: nextEffectReconcileAt(context.compiled, state, command.at),
          });
        }
      }
      break;
    }
    case "wait_resolved": {
      const pending = requirePending(state, "wait", command.node_id);
      requirePrincipal(command.actor, "agentry_system", "Wait resolution must come from the installed Agentry adapter.");
      const node = nodeById(context.compiled.workflow, command.node_id);
      if (node.kind !== "wait") invalidNodeCommand(node, command.kind);
      if (command.outcome === "ready") {
        if (command.at >= pending.deadline_at) runtimeError("wait_expired", "The wait deadline has passed.", "Run the lifecycle tick so the immutable timeout branch is recorded.");
        if (command.output === undefined) runtimeError("wait_output_missing", "A ready wait requires its typed observed output.", "Return the exact adapter-observed receipt.");
        const output = await validatedOutput(resolvedNode(context.compiled, node.id), command.output, command.at);
        await appendEvent(context, "wait.ready", node.id, resolvedNode(context.compiled, node.id).component_hash, output.contract, {
          output: output.payload,
          output_hash: output.payload_hash,
          output_schema_hash: output.schema_hash,
          output_assurance: output.assurance,
          next_node_id: node.on_ready,
        });
      } else if (command.outcome === "timeout") {
        if (command.at < pending.deadline_at) runtimeError("wait_not_expired", "The wait deadline has not passed.", "Keep the run suspended or provide trusted ready evidence.");
        await appendEvent(context, "wait.timed_out", node.id, resolvedNode(context.compiled, node.id).component_hash, null, { next_node_id: node.on_timeout });
      } else {
        if (command.at >= pending.deadline_at) runtimeError("wait_expired", "The wait deadline has passed.", "Run the lifecycle tick so the immutable timeout branch is recorded.");
        await appendEvent(context, "wait.domain_failed", node.id, resolvedNode(context.compiled, node.id).component_hash, null, {
          error: boundedDomainError(command.error),
          next_node_id: node.on_error,
        });
      }
      break;
    }
    case "verification_resolved": {
      const pending = requirePending(state, "verify", command.node_id);
      requirePrincipal(command.actor, "agentry_system", "Verification values and outcomes are server-evaluated; callers cannot attest passed.");
      const node = nodeById(context.compiled.workflow, command.node_id);
      if (node.kind !== "verify") invalidNodeCommand(node, command.kind);
      const componentHash = resolvedNode(context.compiled, node.id).component_hash;
      if (command.outcome === "pending") {
        if (command.at >= pending.deadline_at) runtimeError("verification_expired", "The verification deadline has passed.", "Run the lifecycle tick so the immutable timeout branch is recorded.");
        if (!Number.isSafeInteger(command.next_check_at) || command.next_check_at! <= command.at || command.next_check_at! > pending.deadline_at) {
          runtimeError("verification_check_time_invalid", "next_check_at must be after now and no later than the immutable deadline.", "Choose the next bounded server-owned check time.");
        }
        await appendEvent(context, "verification.pending", node.id, componentHash, null, { next_check_at: command.next_check_at! });
      } else if (command.outcome === "pass" || command.outcome === "fail") {
        if (command.at >= pending.deadline_at) runtimeError("verification_expired", "The verification deadline has passed.", "Run the lifecycle tick so the immutable timeout branch is recorded.");
        if (command.output === undefined) runtimeError("verification_output_missing", "A terminal verification outcome requires its typed server result.", "Evaluate the frozen verification plan and return the exact typed result.");
        const output = await validatedOutput(resolvedNode(context.compiled, node.id), command.output, command.at);
        const passed = isObject(output.payload) ? output.payload.passed : undefined;
        if (passed !== (command.outcome === "pass")) {
          runtimeError("verification_outcome_mismatch", "The typed passed field contradicts the selected verification outcome.", "Use pass only for passed=true and fail only for passed=false.");
        }
        await appendEvent(context, `verification.${command.outcome === "pass" ? "passed" : "failed"}`, node.id, componentHash, output.contract, {
          output: output.payload,
          output_hash: output.payload_hash,
          output_schema_hash: output.schema_hash,
          output_assurance: output.assurance,
          next_node_id: command.outcome === "pass" ? node.on_pass : node.on_fail,
        });
      } else if (command.outcome === "timeout") {
        if (command.at < pending.deadline_at) runtimeError("verification_not_expired", "The verification deadline has not passed.", "Keep the run suspended or evaluate the frozen verification plan.");
        await appendEvent(context, "verification.timed_out", node.id, componentHash, null, { next_node_id: node.on_timeout });
      } else {
        if (command.at >= pending.deadline_at) runtimeError("verification_expired", "The verification deadline has passed.", "Run the lifecycle tick so the immutable timeout branch is recorded.");
        await appendEvent(context, "verification.domain_failed", node.id, componentHash, null, {
          error: boundedDomainError(command.error),
          next_node_id: node.on_error,
        });
      }
      break;
    }
    case "tick": {
      requirePrincipal(command.actor, "agentry_system", "Lifecycle ticks are server-owned.");
      if (state.pending?.kind === "approval" && command.at >= state.pending.expires_at) {
        const node = nodeById(context.compiled.workflow, state.pending.node_id);
        if (node.kind !== "approval") throw new Error("approval pending state points to non-approval node");
        await appendEvent(context, "approval.expired", node.id, null, null, {
          effect_node_id: state.pending.effect_node_id,
          next_node_id: node.on_expired,
        });
      } else if (state.pending?.kind === "wait" && command.at >= state.pending.deadline_at) {
        const node = nodeById(context.compiled.workflow, state.pending.node_id);
        if (node.kind !== "wait") throw new Error("wait pending state points to non-wait node");
        await appendEvent(context, "wait.timed_out", node.id, resolvedNode(context.compiled, node.id).component_hash, null, { next_node_id: node.on_timeout });
      } else if (state.pending?.kind === "verify" && command.at >= state.pending.deadline_at) {
        const node = nodeById(context.compiled.workflow, state.pending.node_id);
        if (node.kind !== "verify") throw new Error("verify pending state points to non-verify node");
        await appendEvent(context, "verification.timed_out", node.id, resolvedNode(context.compiled, node.id).component_hash, null, { next_node_id: node.on_timeout });
      } else {
        runtimeError("nothing_due", "No approval, wait, verification, or run deadline is due.", "Keep the current next_action and retry at its next_check_at or deadline.");
      }
      break;
    }
    case "cancel": {
      requirePrincipal(command.actor, "human_project_owner", "Only a project owner may cancel workflow coordination authority.");
      await appendEvent(context, "run.cancelled", state.current_node_id, null, null, { reason: boundedReason(command.reason) });
      break;
    }
    case "quarantine": {
      requirePrincipal(command.actor, "agentry_system", "Only Agentry may quarantine corrupted or unsafe runtime state.");
      await appendEvent(context, "run.quarantined", state.current_node_id, null, null, { reason: boundedReason(command.reason) });
      break;
    }
  }
}

async function drainInternalNodes(context: RuntimeContext): Promise<void> {
  for (let count = 0; count <= context.compiled.workflow.nodes.length; count += 1) {
    const state = context.state!;
    if (state.status !== "running" || !state.current_node_id) return;
    const node = nodeById(context.compiled.workflow, state.current_node_id);
    switch (node.kind) {
      case "trigger":
        await appendEvent(context, "run.quarantined", node.id, resolvedNode(context.compiled, node.id).component_hash, null, { reason: "trigger_reentered" });
        return;
      case "condition": {
        const source = requireOutput(state, node.predicate.value.node_id);
        const value = valueAtPath(source.payload, node.predicate.value.path);
        const result = evaluatePredicate(value, node.predicate.operator, node.predicate.expected);
        const next = result ? node.on_true : node.on_false;
        await appendEvent(context, "condition.evaluated", node.id, null, null, {
          source_node_id: source.node_id,
          source_payload_hash: source.payload_hash,
          value_path: node.predicate.value.path,
          operator: node.predicate.operator,
          expected: node.predicate.expected,
          result,
          next_node_id: next,
        });
        break;
      }
      case "approval": {
        const effect = nodeById(context.compiled.workflow, node.on_approved);
        if (effect.kind !== "effect") throw new Error("compiled approval does not point directly to an effect");
        const effectComponent = componentForNode(context.compiled, effect);
        const subjectPort = effectComponent.authority.approval_subject_port;
        if (!subjectPort) throw new Error("protected effect has no approval subject port");
        const subjectRef = effect.inputs[subjectPort];
        if (!subjectRef || subjectRef.node_id !== node.subject.node_id) throw new Error("compiled approval subject binding drifted");
        const subject = requireOutput(state, subjectRef.node_id);
        const providerTarget = providerTargetFor(context.compiled, state, effectComponent.side_effect.kind);
        const expiresAt = context.command.at + node.expires_after_seconds;
        const resolvedEffect = resolvedNode(context.compiled, effect.id);
        const bindingHash = await hashJson({
          workflow_hash: context.compiled.workflow_hash,
          compile_hash: context.compiled.compile_hash,
          component_hash: resolvedEffect.component_hash,
          run_id: state.run_id,
          approval_node_id: node.id,
          effect_node_id: effect.id,
          subject_port: subjectPort,
          subject_hash: subject.payload_hash,
          provider_target: providerTarget,
          expires_at: expiresAt,
        });
        await appendEvent(context, "approval.requested", node.id, null, null, {
          effect_node_id: effect.id,
          subject_node_id: subject.node_id,
          subject_port: subjectPort,
          subject_hash: subject.payload_hash,
          binding_hash: bindingHash,
          provider_target: providerTarget,
          expires_at: expiresAt,
        });
        return;
      }
      case "query":
      case "agent_task":
      case "effect": {
        const component = componentForNode(context.compiled, node);
        const resolved = resolvedNode(context.compiled, node.id);
        const inputs = await runtimeInputs(context.compiled, state, node);
        const inputHash = await inputSnapshotHash(inputs);
        if (node.kind === "effect" && component.side_effect.kind === "external_provider") {
          if (Object.keys(state.effects).length >= context.compiled.workflow.limits.max_external_effects_per_run) {
            await appendEvent(context, "run.quarantined", node.id, resolved.component_hash, null, { reason: "external_effect_run_budget_exhausted" });
            return;
          }
          const approval = state.approvals[node.id];
          if (!approval || approval.status !== "approved" || approval.expires_at <= context.command.at) {
            await appendEvent(context, "run.quarantined", node.id, resolved.component_hash, null, { reason: "effect_approval_missing_or_expired" });
            return;
          }
          const providerTarget = providerTargetFor(context.compiled, state, component.side_effect.kind);
          const intentHash = await hashJson({
            compile_hash: context.compiled.compile_hash,
            component_hash: resolved.component_hash,
            run_id: state.run_id,
            node_id: node.id,
            canonical_input_hash: inputHash,
            provider_target: providerTarget,
            approval_binding_hash: approval.binding_hash,
          });
          await appendEvent(context, "effect.intent_reserved", node.id, resolved.component_hash, null, {
            input_hash: inputHash,
            intent_hash: intentHash,
            provider_target: providerTarget,
          });
          return;
        }
        if (node.kind === "agent_task" && agentTaskBudgetUnavailable(context.compiled, state)) {
          await appendEvent(context, "run.quarantined", node.id, resolved.component_hash, null, {
            reason: "agent_task_budget_unavailable",
          });
          return;
        }
        const attempt = (state.attempts[node.id] ?? 0) + 1;
        await appendEvent(context, "node.ready", node.id, resolved.component_hash, null, {
          attempt,
          input_hash: inputHash,
        });
        return;
      }
      case "wait":
      case "verify": {
        const resolved = resolvedNode(context.compiled, node.id);
        const component = componentForNode(context.compiled, node);
        const inputs = await runtimeInputs(context.compiled, state, node);
        const inputHash = await inputSnapshotHash(inputs);
        const field = component.timing.max_wait_seconds_config_field;
        const configured = field ? node.config[field] : undefined;
        if (component.timing.mode !== "durable_wait" || typeof configured !== "number") {
          throw new Error(`durable ${node.kind} component has no numeric maximum wait`);
        }
        const deadlineAt = Math.min(state.elapsed_deadline_at, context.command.at + configured);
        await appendEvent(context, node.kind === "wait" ? "wait.registered" : "verification.started", node.id, resolved.component_hash, null, {
          input_hash: inputHash,
          started_at: context.command.at,
          deadline_at: deadlineAt,
          next_check_at: context.command.at,
        });
        return;
      }
      case "terminal":
        if (node.terminal.outcome === "complete") {
          const result = requireOutput(state, node.terminal.result.node_id);
          await appendEvent(context, "run.completed", node.id, null, null, {
            result_node_id: result.node_id,
            result_contract: result.contract,
            result_hash: result.payload_hash,
          });
        } else {
          await appendEvent(context, "run.escalated", node.id, null, null, {
            destination: node.terminal.destination,
            instructions: node.terminal.instructions,
          });
        }
        return;
    }
  }
  await appendEvent(context, "run.quarantined", context.state?.current_node_id ?? null, null, null, { reason: "internal_advance_bound_exceeded" });
}

async function completeExternalEffect(
  context: RuntimeContext,
  nodeId: string,
  rawOutput: unknown,
  observedAssurance: "reported" | "observed",
) {
  const state = context.state!;
  const pending = requirePending(state, "effect", nodeId);
  const node = nodeById(context.compiled.workflow, nodeId);
  if (node.kind !== "effect") invalidNodeCommand(node, "effect completion");
  const output = await validatedOutput(resolvedNode(context.compiled, node.id), rawOutput, context.command.at);
  const assurance = maximumAssurance(output.assurance, observedAssurance);
  await appendEvent(context, "effect.completed", node.id, pending.component_hash, output.contract, {
    output: output.payload,
    output_hash: output.payload_hash,
    output_schema_hash: output.schema_hash,
    output_assurance: assurance,
    intent_hash: pending.intent_hash,
    next_node_id: node.next,
  });
}

async function appendEvent(
  context: RuntimeContext,
  eventName: string,
  nodeId: string | null,
  componentHash: string | null,
  payloadSchemaRef: string | null,
  payload: Record<string, AutomationWorkflowJsonValue>,
): Promise<void> {
  const sequence = (context.state?.revision ?? 0) + 1;
  const payloadHash = await hashJson(payload);
  const runId = context.state?.run_id ?? (context.command.kind === "start" ? context.command.run_id : "");
  const envelope: Omit<AutomationWorkflowRunEvent, "event_id"> = {
    prior_event_hash: context.state?.last_event_hash ?? null,
    event_version: AUTOMATION_WORKFLOW_EVENT_VERSION,
    run_id: runId,
    sequence,
    command_id: context.command.command_id,
    request_hash: context.request_hash,
    event: eventName,
    at: context.command.at,
    actor: context.command.actor,
    workflow_hash: context.compiled.workflow_hash,
    compile_hash: context.compiled.compile_hash,
    node_id: nodeId,
    component_hash: componentHash,
    payload_schema_ref: payloadSchemaRef,
    payload_hash: payloadHash,
    payload,
  };
  const event: AutomationWorkflowRunEvent = {
    event_id: await workflowEventId(envelope),
    ...envelope,
  };
  context.state = await applyAutomationWorkflowRunEvent(context.compiled, context.state, event);
  context.events.push(event);
}

export async function applyAutomationWorkflowRunEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState | null,
  event: AutomationWorkflowRunEvent,
): Promise<AutomationWorkflowRunState> {
  await verifyAutomationWorkflowRunEvent(compiled, event);
  if (event.event_version !== AUTOMATION_WORKFLOW_EVENT_VERSION) throw new Error(`unsupported workflow event version ${event.event_version}`);
  if (event.sequence !== (prior?.revision ?? 0) + 1) throw new Error("workflow event sequence is not contiguous");
  if (event.prior_event_hash !== (prior?.last_event_hash ?? null)) throw new Error("workflow event prior hash chain is broken");
  if (prior && (prior.run_id !== event.run_id || prior.workflow_hash !== event.workflow_hash || prior.compile_hash !== event.compile_hash)) {
    throw new Error("workflow event binding does not match prior state");
  }
  if (prior && event.at < prior.last_event_at) throw new Error("workflow event time is not monotonic");
  if (prior && TERMINAL_STATUSES.has(prior.status)) throw new Error("workflow event cannot follow a terminal run state");
  await assertAutomationWorkflowEventTransition(compiled, prior, event);
  if (!prior) {
    return {
      runtime_version: AUTOMATION_WORKFLOW_RUNTIME_VERSION,
      run_id: event.run_id,
      project_id: stringField(event.payload, "project_id"),
      automation_id: stringField(event.payload, "automation_id"),
      workflow_revision: numberField(event.payload, "workflow_revision"),
      workflow_hash: event.workflow_hash,
      compile_hash: event.compile_hash,
      revision: event.sequence,
      status: "running",
      current_node_id: event.node_id,
      outputs: {},
      attempts: {},
      approvals: {},
      effects: {},
      pending: null,
      active_runtime_seconds: 0,
      active_started_at: event.at,
      usage_sequence: 0,
      turns_used: 0,
      cost_micros: 0,
      changed_files: [],
      changed_line_churn: 0,
      started_at: numberField(event.payload, "started_at"),
      elapsed_deadline_at: numberField(event.payload, "elapsed_deadline_at"),
      last_event_at: event.at,
      last_event_hash: event.event_id,
      last_command_id: event.command_id,
      last_request_hash: event.request_hash,
      last_actor: { ...event.actor },
      terminal: null,
    };
  }

  const state = cloneState(prior);
  state.revision = event.sequence;
  state.last_event_at = event.at;
  state.last_event_hash = event.event_id;
  state.last_command_id = event.command_id;
  state.last_request_hash = event.request_hash;
  state.last_actor = { ...event.actor };
  switch (event.event) {
    case "run.usage_recorded": {
      const pending = requirePending(state, "component", stringNode(event));
      const touchedFiles = stringArrayField(event.payload, "touched_files");
      state.usage_sequence = numberField(event.payload, "sequence");
      state.turns_used = numberField(event.payload, "turns_used");
      state.cost_micros = numberField(event.payload, "cost_micros");
      state.changed_files = sortedUniqueStrings([...state.changed_files, ...touchedFiles]);
      state.changed_line_churn = safeIntegerSum(
        state.changed_line_churn,
        numberField(event.payload, "changed_line_churn"),
        "workflow usage changed-line churn overflowed",
      );
      state.pending = { ...pending, usage_sequence: state.usage_sequence };
      break;
    }
    case "trigger.completed":
    case "node.completed":
    case "effect.completed":
    case "wait.ready":
    case "verification.passed":
    case "verification.failed":
      recordOutput(state, event);
      resumeState(state, event.at, stringField(event.payload, "next_node_id"));
      break;
    case "node.ready":
      state.status = "awaiting_component";
      state.attempts[stringNode(event)] = numberField(event.payload, "attempt");
      state.pending = {
        kind: "component",
        node_id: stringNode(event),
        attempt: numberField(event.payload, "attempt"),
        component_hash: requiredComponentHash(event),
        input_hash: stringField(event.payload, "input_hash"),
        usage_sequence: null,
      };
      break;
    case "node.domain_failed":
    case "wait.domain_failed":
    case "verification.domain_failed":
    case "condition.evaluated":
    case "approval.rejected":
    case "approval.expired":
    case "wait.timed_out":
    case "verification.timed_out":
      if (event.event.startsWith("approval.")) updateApprovalDecision(state, event, event.event.slice("approval.".length) as "rejected" | "expired");
      resumeState(state, event.at, stringField(event.payload, "next_node_id"));
      break;
    case "approval.requested": {
      suspendState(state, event.at);
      const approval: AutomationWorkflowApprovalState = {
        approval_node_id: stringNode(event),
        effect_node_id: stringField(event.payload, "effect_node_id"),
        subject_node_id: stringField(event.payload, "subject_node_id"),
        subject_port: stringField(event.payload, "subject_port"),
        subject_hash: stringField(event.payload, "subject_hash"),
        binding_hash: stringField(event.payload, "binding_hash"),
        provider_target: stringField(event.payload, "provider_target"),
        expires_at: numberField(event.payload, "expires_at"),
        status: "pending",
        decided_at: null,
      };
      state.status = "awaiting_approval";
      state.pending = { kind: "approval", node_id: approval.approval_node_id, ...approval };
      state.approvals[approval.effect_node_id] = approval;
      break;
    }
    case "approval.approved":
      updateApprovalDecision(state, event, "approved");
      resumeState(state, event.at, stringField(event.payload, "next_node_id"));
      break;
    case "effect.intent_reserved":
      state.status = "effect_reserved";
      state.pending = {
        kind: "effect",
        node_id: stringNode(event),
        component_hash: requiredComponentHash(event),
        input_hash: stringField(event.payload, "input_hash"),
        intent_hash: stringField(event.payload, "intent_hash"),
        provider_target: stringField(event.payload, "provider_target"),
        status: "reserved",
        reconciliation_count: 0,
        next_reconcile_at: null,
      };
      state.effects[stringNode(event)] = {
        node_id: stringNode(event),
        component_hash: requiredComponentHash(event),
        input_hash: stringField(event.payload, "input_hash"),
        intent_hash: stringField(event.payload, "intent_hash"),
        provider_target: stringField(event.payload, "provider_target"),
        status: "reserved",
        reconciliation_count: 0,
        next_reconcile_at: null,
        reserved_at: event.at,
        call_started_at: null,
        completed_at: null,
      };
      break;
    case "effect.call_started": {
      const pending = requirePending(state, "effect", stringNode(event));
      suspendState(state, event.at);
      state.status = "effect_indeterminate";
      state.pending = {
        ...pending,
        status: "indeterminate",
        next_reconcile_at: numberField(event.payload, "next_reconcile_at"),
      };
      state.effects[pending.node_id] = {
        ...state.effects[pending.node_id]!,
        status: "indeterminate",
        next_reconcile_at: numberField(event.payload, "next_reconcile_at"),
        call_started_at: event.at,
      };
      break;
    }
    case "effect.reconciled_absent":
    case "effect.reconciliation_unknown": {
      const pending = requirePending(state, "effect", stringNode(event));
      state.pending = {
        ...pending,
        reconciliation_count: numberField(event.payload, "reconciliation_count"),
        next_reconcile_at: numberField(event.payload, "next_reconcile_at"),
      };
      state.effects[pending.node_id] = {
        ...state.effects[pending.node_id]!,
        reconciliation_count: numberField(event.payload, "reconciliation_count"),
        next_reconcile_at: numberField(event.payload, "next_reconcile_at"),
      };
      break;
    }
    case "effect.reconciliation_exhausted": {
      const pending = requirePending(state, "effect", stringNode(event));
      state.pending = {
        ...pending,
        reconciliation_count: numberField(event.payload, "reconciliation_count"),
        next_reconcile_at: null,
      };
      state.effects[pending.node_id] = {
        ...state.effects[pending.node_id]!,
        reconciliation_count: numberField(event.payload, "reconciliation_count"),
        next_reconcile_at: null,
      };
      break;
    }
    case "wait.registered":
    case "verification.started": {
      suspendState(state, event.at);
      const kind = event.event === "wait.registered" ? "wait" : "verify";
      state.status = kind === "wait" ? "waiting" : "verifying";
      state.pending = {
        kind,
        node_id: stringNode(event),
        input_hash: stringField(event.payload, "input_hash"),
        started_at: numberField(event.payload, "started_at"),
        deadline_at: numberField(event.payload, "deadline_at"),
        next_check_at: numberField(event.payload, "next_check_at"),
      };
      break;
    }
    case "verification.pending": {
      const pending = requirePending(state, "verify", stringNode(event));
      state.pending = { ...pending, next_check_at: numberField(event.payload, "next_check_at") };
      break;
    }
    case "run.completed":
      terminalState(state, event, "completed", "complete");
      state.terminal!.result_node_id = stringField(event.payload, "result_node_id");
      break;
    case "run.escalated":
      terminalState(state, event, "escalated", "escalate");
      state.terminal!.destination = stringField(event.payload, "destination");
      state.terminal!.instructions = stringField(event.payload, "instructions");
      break;
    case "run.cancelled":
      terminalState(state, event, "cancelled", "cancelled");
      state.terminal!.reason = stringField(event.payload, "reason");
      break;
    case "run.quarantined":
      terminalState(state, event, "quarantined", "quarantined");
      state.terminal!.reason = stringField(event.payload, "reason");
      break;
    default:
      throw new Error(`unsupported workflow event ${event.event}`);
  }
  return state;
}

export async function replayAutomationWorkflowRun(
  compiled: CompiledAutomationWorkflow,
  events: readonly AutomationWorkflowRunEvent[],
): Promise<AutomationWorkflowRunState | null> {
  let state: AutomationWorkflowRunState | null = null;
  for (const event of events) {
    state = await applyAutomationWorkflowRunEvent(compiled, state, event);
  }
  if (state) assertStateBinding(compiled, state);
  return state;
}

export async function verifyAutomationWorkflowRunEvent(
  compiled: CompiledAutomationWorkflow,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  if (event.workflow_hash !== compiled.workflow_hash || event.compile_hash !== compiled.compile_hash) {
    throw new Error("workflow event is not bound to the frozen compile artifact");
  }
  const payloadHash = await hashJson(event.payload);
  if (payloadHash !== event.payload_hash) throw new Error("workflow event payload hash mismatch");
  const { event_id: _eventId, ...envelope } = event;
  const expectedEventId = await workflowEventId(envelope);
  if (expectedEventId !== event.event_id) throw new Error("workflow event identity hash mismatch");
  assertWorkflowEventEnvelope(event);
}

async function workflowEventId(
  envelope: Omit<AutomationWorkflowRunEvent, "event_id">,
): Promise<string> {
  return hashJson(envelope);
}

function assertWorkflowEventEnvelope(event: AutomationWorkflowRunEvent): void {
  if (!SHA256_HEX.test(event.event_id)) throw new Error("workflow event id must be a SHA-256 hash");
  if (event.prior_event_hash !== null && !SHA256_HEX.test(event.prior_event_hash)) {
    throw new Error("workflow event prior hash must be null or a SHA-256 hash");
  }
  if (!COMMAND_ID.test(event.command_id)) throw new Error("workflow event command id is invalid");
  if (!SHA256_HEX.test(event.request_hash)) throw new Error("workflow event request hash must be a SHA-256 hash");
  if (!SHA256_HEX.test(event.payload_hash)) throw new Error("workflow event payload hash must be a SHA-256 hash");
  if (!SHA256_HEX.test(event.workflow_hash) || !SHA256_HEX.test(event.compile_hash)) {
    throw new Error("workflow event compile binding hashes are invalid");
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("workflow event sequence must be positive");
  if (!Number.isSafeInteger(event.at) || event.at < 0) throw new Error("workflow event time must be nonnegative");
  if (!EVENT_NAMES.has(event.event)) throw new Error(`unsupported workflow event ${event.event}`);
  if (typeof event.run_id !== "string" || event.run_id.length < 1 || event.run_id.length > 200) {
    throw new Error("workflow event run id is invalid");
  }
  if (!PRINCIPALS.has(event.actor.principal)) throw new Error("workflow event actor principal is invalid");
  if (event.actor.credential_id !== null && (
    typeof event.actor.credential_id !== "string" ||
    event.actor.credential_id.length < 1 ||
    event.actor.credential_id.length > 200
  )) throw new Error("workflow event actor credential id is invalid");
  if (event.node_id !== null && (typeof event.node_id !== "string" || event.node_id.length < 1)) {
    throw new Error("workflow event node id is invalid");
  }
  if (event.component_hash !== null && !SHA256_HEX.test(event.component_hash)) {
    throw new Error("workflow event component hash is invalid");
  }
  if (event.payload_schema_ref !== null && (
    typeof event.payload_schema_ref !== "string" || event.payload_schema_ref.length < 1
  )) throw new Error("workflow event payload schema ref is invalid");
  if (!isObject(event.payload)) throw new Error("workflow event payload must be a JSON object");
}

async function assertAutomationWorkflowEventTransition(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState | null,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  if (!prior) {
    await assertRunStartedEvent(compiled, event);
    return;
  }
  if (event.event === "run.started") throw new Error("run.started can only be the first workflow event");

  switch (event.event) {
    case "run.usage_recorded":
      assertRunUsageRecordedEvent(compiled, prior, event);
      return;
    case "trigger.completed":
      await assertTriggerCompletedEvent(compiled, prior, event);
      return;
    case "node.ready":
      await assertNodeReadyEvent(compiled, prior, event);
      return;
    case "node.completed":
      await assertNodeCompletedEvent(compiled, prior, event);
      return;
    case "node.domain_failed":
      assertNodeDomainFailedEvent(compiled, prior, event);
      return;
    case "condition.evaluated":
      assertConditionEvaluatedEvent(compiled, prior, event);
      return;
    case "approval.requested":
      await assertApprovalRequestedEvent(compiled, prior, event);
      return;
    case "approval.approved":
    case "approval.rejected":
    case "approval.expired":
      assertApprovalDecisionEvent(compiled, prior, event);
      return;
    case "effect.intent_reserved":
      await assertEffectIntentReservedEvent(compiled, prior, event);
      return;
    case "effect.call_started":
      assertEffectCallStartedEvent(compiled, prior, event);
      return;
    case "effect.completed":
      await assertEffectCompletedEvent(compiled, prior, event);
      return;
    case "effect.reconciled_absent":
    case "effect.reconciliation_unknown":
      assertEffectReconciliationDeferredEvent(compiled, prior, event);
      return;
    case "effect.reconciliation_exhausted":
      assertEffectReconciliationExhaustedEvent(compiled, prior, event);
      return;
    case "wait.registered":
    case "verification.started":
      await assertDurableWaitStartedEvent(compiled, prior, event);
      return;
    case "wait.ready":
      await assertWaitReadyEvent(compiled, prior, event);
      return;
    case "wait.timed_out":
    case "wait.domain_failed":
      assertWaitExitEvent(compiled, prior, event);
      return;
    case "verification.pending":
      assertVerificationPendingEvent(compiled, prior, event);
      return;
    case "verification.passed":
    case "verification.failed":
      await assertVerificationResultEvent(compiled, prior, event);
      return;
    case "verification.timed_out":
    case "verification.domain_failed":
      assertVerificationExitEvent(compiled, prior, event);
      return;
    case "run.completed":
    case "run.escalated":
      assertTerminalEvent(compiled, prior, event);
      return;
    case "run.cancelled":
      assertRunCancelledEvent(compiled, prior, event);
      return;
    case "run.quarantined":
      assertRunQuarantinedEvent(compiled, prior, event);
      return;
    default:
      throw new Error(`unsupported workflow event ${event.event}`);
  }
}

async function assertRunStartedEvent(
  compiled: CompiledAutomationWorkflow,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  if (event.event !== "run.started") throw new Error("first workflow event must be run.started");
  assertExactPayload(event, ["project_id", "automation_id", "workflow_revision", "started_at", "elapsed_deadline_at"]);
  const trigger = nodeById(compiled.workflow, compiled.workflow.entry);
  if (trigger.kind !== "trigger") throw new Error("compiled workflow entry is not a trigger");
  assertEventNode(event, trigger.id);
  assertComponentEnvelope(compiled, event, trigger.id, null);
  assertEventPrincipal(event, ["agentry_system"]);
  if (stringField(event.payload, "automation_id") !== compiled.workflow.id) throw new Error("run.started automation id does not match workflow");
  const revision = numberField(event.payload, "workflow_revision");
  if (revision < 1) throw new Error("run.started workflow revision must be positive");
  if (numberField(event.payload, "started_at") !== event.at) throw new Error("run.started timestamp does not match event time");
  const expectedDeadline = event.at + compiled.workflow.limits.max_elapsed_seconds;
  if (numberField(event.payload, "elapsed_deadline_at") !== expectedDeadline) throw new Error("run.started elapsed deadline does not match workflow limit");
  if (stringField(event.payload, "project_id").length < 1) throw new Error("run.started project id is empty");
}

async function assertTriggerCompletedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["output", "output_hash", "output_schema_hash", "output_assurance", "next_node_id"]);
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  if (node.kind !== "trigger") throw new Error("trigger.completed requires the current trigger node");
  assertEventPrincipal(event, ["agentry_system"]);
  assertStringEquals(event, "next_node_id", node.next);
  await assertOutputEvent(compiled, event, node.id, resolvedNode(compiled, node.id).output_minimum_assurance);
  assertTriggerPayloadEligible(resolvedNode(compiled, node.id).output_contract, event.payload.output, event.at);
}

async function assertNodeReadyEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["attempt", "input_hash"]);
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  if (node.kind !== "query" && node.kind !== "agent_task" && node.kind !== "effect") {
    throw new Error("node.ready requires a linear component node");
  }
  const component = componentForNode(compiled, node);
  if (node.kind === "effect" && component.side_effect.kind === "external_provider") {
    throw new Error("external provider effects require intent reservation instead of node.ready");
  }
  assertComponentEnvelope(compiled, event, node.id, null);
  const expectedAttempt = (prior.attempts[node.id] ?? 0) + 1;
  if (numberField(event.payload, "attempt") !== expectedAttempt) throw new Error("node.ready attempt is not the next immutable attempt");
  const expectedInputHash = await inputSnapshotHash(await runtimeInputs(compiled, prior, node));
  assertStringEquals(event, "input_hash", expectedInputHash);
}

function assertRunUsageRecordedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["sequence", "turns_used", "cost_micros", "touched_files", "changed_line_churn"]);
  const pending = requirePending(prior, "component", stringNode(event));
  if (prior.status !== "awaiting_component") throw new Error("run.usage_recorded requires an awaiting component run");
  if (pending.usage_sequence !== null) throw new Error("component attempt already has a durable usage observation");
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "agent_task") throw new Error("run.usage_recorded requires an agent_task node");
  const component = componentForNode(compiled, node);
  assertEventPrincipal(event, [component.principal_roles.executor]);
  assertComponentEnvelope(compiled, event, node.id, null);
  if (pending.component_hash !== event.component_hash) throw new Error("run.usage_recorded component hash differs from pending state");
  assertUsageValues(
    prior,
    numberField(event.payload, "sequence"),
    numberField(event.payload, "turns_used"),
    numberField(event.payload, "cost_micros"),
    stringArrayField(event.payload, "touched_files"),
    numberField(event.payload, "changed_line_churn"),
  );
}

async function assertNodeCompletedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["output", "output_hash", "output_schema_hash", "output_assurance", "exit", "next_node_id"]);
  const node = requirePendingComponentNode(compiled, prior, event);
  const component = componentForNode(compiled, node);
  if (node.kind === "effect" && component.side_effect.kind === "external_provider") {
    throw new Error("external provider effects cannot complete through node.completed");
  }
  assertEventPrincipal(event, [component.principal_roles.executor]);
  assertAgentUsageContinuation(prior, node, event);
  assertStringEquals(event, "exit", "next");
  assertStringEquals(event, "next_node_id", node.next);
  await assertOutputEvent(compiled, event, node.id, resolvedNode(compiled, node.id).output_minimum_assurance);
}

function assertNodeDomainFailedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["error", "exit", "next_node_id"]);
  const node = requirePendingComponentNode(compiled, prior, event);
  const component = componentForNode(compiled, node);
  assertEventPrincipal(event, [component.principal_roles.executor]);
  assertAgentUsageContinuation(prior, node, event);
  assertComponentEnvelope(compiled, event, node.id, null);
  assertDomainError(event);
  assertStringEquals(event, "exit", "on_error");
  assertStringEquals(event, "next_node_id", node.on_error);
}

function assertConditionEvaluatedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["source_node_id", "source_payload_hash", "value_path", "operator", "expected", "result", "next_node_id"]);
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  if (node.kind !== "condition") throw new Error("condition.evaluated requires the current condition node");
  assertNoComponentEnvelope(event);
  const source = requireOutput(prior, node.predicate.value.node_id);
  assertStringEquals(event, "source_node_id", source.node_id);
  assertStringEquals(event, "source_payload_hash", source.payload_hash);
  assertJsonEquals(event.payload.value_path, node.predicate.value.path, "condition value path");
  assertStringEquals(event, "operator", node.predicate.operator);
  assertJsonEquals(event.payload.expected, node.predicate.expected, "condition expected value");
  const result = evaluatePredicate(valueAtPath(source.payload, node.predicate.value.path), node.predicate.operator, node.predicate.expected);
  if (booleanField(event.payload, "result") !== result) throw new Error("condition result does not match frozen predicate");
  assertStringEquals(event, "next_node_id", result ? node.on_true : node.on_false);
}

async function assertApprovalRequestedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["effect_node_id", "subject_node_id", "subject_port", "subject_hash", "binding_hash", "provider_target", "expires_at"]);
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  if (node.kind !== "approval") throw new Error("approval.requested requires the current approval node");
  assertNoComponentEnvelope(event);
  const effect = nodeById(compiled.workflow, node.on_approved);
  if (effect.kind !== "effect") throw new Error("approval on_approved must target an effect");
  const effectComponent = componentForNode(compiled, effect);
  const subjectPort = effectComponent.authority.approval_subject_port;
  if (!subjectPort) throw new Error("protected effect has no approval subject port");
  const subjectRef = effect.inputs[subjectPort];
  if (!subjectRef || subjectRef.node_id !== node.subject.node_id) throw new Error("approval subject binding does not match protected effect");
  const subject = requireOutput(prior, subjectRef.node_id);
  const providerTarget = providerTargetFor(compiled, prior, effectComponent.side_effect.kind);
  const expiresAt = event.at + node.expires_after_seconds;
  const bindingHash = await hashJson({
    workflow_hash: compiled.workflow_hash,
    compile_hash: compiled.compile_hash,
    component_hash: resolvedNode(compiled, effect.id).component_hash,
    run_id: prior.run_id,
    approval_node_id: node.id,
    effect_node_id: effect.id,
    subject_port: subjectPort,
    subject_hash: subject.payload_hash,
    provider_target: providerTarget,
    expires_at: expiresAt,
  });
  assertStringEquals(event, "effect_node_id", effect.id);
  assertStringEquals(event, "subject_node_id", subject.node_id);
  assertStringEquals(event, "subject_port", subjectPort);
  assertStringEquals(event, "subject_hash", subject.payload_hash);
  assertStringEquals(event, "binding_hash", bindingHash);
  assertStringEquals(event, "provider_target", providerTarget);
  if (numberField(event.payload, "expires_at") !== expiresAt) throw new Error("approval expiry does not match frozen node duration");
  if (prior.approvals[effect.id]) throw new Error("approval subject was already recorded for this effect");
}

function assertApprovalDecisionEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  const expired = event.event === "approval.expired";
  assertExactPayload(event, expired ? ["effect_node_id", "next_node_id"] : ["reason", "effect_node_id", "next_node_id"]);
  const pending = requirePending(prior, "approval", stringNode(event));
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "approval") throw new Error("approval decision requires an approval node");
  assertEventNode(event, node.id);
  assertNoComponentEnvelope(event);
  assertStringEquals(event, "effect_node_id", pending.effect_node_id);
  if (expired) {
    assertEventPrincipal(event, ["agentry_system"]);
    if (event.at < pending.expires_at) throw new Error("approval expiration occurred before its deadline");
    assertStringEquals(event, "next_node_id", node.on_expired);
    return;
  }
  assertEventPrincipal(event, ["human_project_owner"]);
  if (event.at >= pending.expires_at) throw new Error("approval decision occurred at or after expiry");
  assertBoundedReasonField(event, "reason");
  assertStringEquals(event, "next_node_id", event.event === "approval.approved" ? node.on_approved : node.on_rejected);
}

async function assertEffectIntentReservedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["input_hash", "intent_hash", "provider_target"]);
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  if (node.kind !== "effect") throw new Error("effect.intent_reserved requires the current effect node");
  const component = componentForNode(compiled, node);
  if (component.side_effect.kind !== "external_provider") throw new Error("intent reservation requires an external provider effect");
  assertComponentEnvelope(compiled, event, node.id, null);
  if (Object.keys(prior.effects).length >= compiled.workflow.limits.max_external_effects_per_run) {
    throw new Error("effect intent was reserved after the per-run effect budget was exhausted");
  }
  const approval = prior.approvals[node.id];
  if (!approval || approval.status !== "approved" || approval.expires_at <= event.at) {
    throw new Error("effect intent has no exact unexpired approval");
  }
  const inputHash = await inputSnapshotHash(await runtimeInputs(compiled, prior, node));
  const providerTarget = providerTargetFor(compiled, prior, component.side_effect.kind);
  const intentHash = await hashJson({
    compile_hash: compiled.compile_hash,
    component_hash: resolvedNode(compiled, node.id).component_hash,
    run_id: prior.run_id,
    node_id: node.id,
    canonical_input_hash: inputHash,
    provider_target: providerTarget,
    approval_binding_hash: approval.binding_hash,
  });
  assertStringEquals(event, "input_hash", inputHash);
  assertStringEquals(event, "provider_target", providerTarget);
  assertStringEquals(event, "intent_hash", intentHash);
  if (prior.effects[node.id]) throw new Error("effect intent was already reserved for this run node");
}

function assertEffectCallStartedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["intent_hash", "next_reconcile_at"]);
  const pending = requirePending(prior, "effect", stringNode(event));
  if (pending.status !== "reserved" || prior.status !== "effect_reserved") throw new Error("effect.call_started requires one reserved effect");
  assertComponentEnvelope(compiled, event, pending.node_id, null);
  assertEventPrincipal(event, ["automation_runner"]);
  assertStringEquals(event, "intent_hash", pending.intent_hash);
  if (numberField(event.payload, "next_reconcile_at") !== nextEffectReconcileAt(compiled, prior, event.at)) {
    throw new Error("effect.call_started next reconciliation time does not match the frozen backoff");
  }
}

async function assertEffectCompletedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["output", "output_hash", "output_schema_hash", "output_assurance", "intent_hash", "next_node_id"]);
  const pending = requirePending(prior, "effect", stringNode(event));
  if (pending.status !== "indeterminate" || prior.status !== "effect_indeterminate") throw new Error("effect.completed requires an indeterminate provider call");
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "effect") throw new Error("effect completion points to a non-effect node");
  assertEventPrincipal(event, ["automation_runner", "agentry_system", "trusted_ci"]);
  if (
    event.actor.principal !== "automation_runner" &&
    (pending.next_reconcile_at === null || event.at < pending.next_reconcile_at)
  ) {
    throw new Error("effect reconciliation completed before its bounded next reconciliation time");
  }
  assertStringEquals(event, "intent_hash", pending.intent_hash);
  assertStringEquals(event, "next_node_id", node.next);
  const observed = event.actor.principal === "automation_runner" ? "reported" : "observed";
  await assertOutputEvent(compiled, event, node.id, maximumAssurance(resolvedNode(compiled, node.id).output_minimum_assurance, observed));
}

function assertEffectReconciliationDeferredEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  if (event.event !== "effect.reconciled_absent" && event.event !== "effect.reconciliation_unknown") {
    throw new Error("effect reconciliation deferral has an unsupported outcome event");
  }
  assertExactPayload(event, ["intent_hash", "reconciliation_count", "next_reconcile_at"]);
  const pending = requirePending(prior, "effect", stringNode(event));
  if (pending.status !== "indeterminate" || prior.status !== "effect_indeterminate") throw new Error("effect reconciliation requires an indeterminate effect");
  assertComponentEnvelope(compiled, event, pending.node_id, null);
  assertEventPrincipal(event, ["agentry_system", "trusted_ci"]);
  assertStringEquals(event, "intent_hash", pending.intent_hash);
  if (pending.next_reconcile_at === null || event.at < pending.next_reconcile_at) {
    throw new Error("effect reconciliation occurred before its bounded next reconciliation time");
  }
  const reconciliationCount = numberField(event.payload, "reconciliation_count");
  if (reconciliationCount !== pending.reconciliation_count + 1) {
    throw new Error("effect reconciliation count is not contiguous");
  }
  if (reconciliationCount >= AUTOMATION_WORKFLOW_MAX_EFFECT_RECONCILIATIONS) {
    throw new Error("deferred effect reconciliation exceeded the bounded automatic retry ceiling");
  }
  if (numberField(event.payload, "next_reconcile_at") !== nextEffectReconcileAt(compiled, prior, event.at)) {
    throw new Error("effect reconciliation next check does not match the frozen backoff");
  }
}

function assertEffectReconciliationExhaustedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["intent_hash", "reconciliation_count"]);
  const pending = requirePending(prior, "effect", stringNode(event));
  if (pending.status !== "indeterminate" || prior.status !== "effect_indeterminate") {
    throw new Error("effect reconciliation exhaustion requires an indeterminate effect");
  }
  assertComponentEnvelope(compiled, event, pending.node_id, null);
  assertEventPrincipal(event, ["agentry_system", "trusted_ci"]);
  assertStringEquals(event, "intent_hash", pending.intent_hash);
  if (pending.next_reconcile_at === null || event.at < pending.next_reconcile_at) {
    throw new Error("effect reconciliation exhaustion occurred before its bounded next reconciliation time");
  }
  const reconciliationCount = numberField(event.payload, "reconciliation_count");
  if (
    reconciliationCount !== pending.reconciliation_count + 1 ||
    reconciliationCount !== AUTOMATION_WORKFLOW_MAX_EFFECT_RECONCILIATIONS
  ) {
    throw new Error("effect reconciliation exhaustion does not match the immutable retry ceiling");
  }
}

async function assertDurableWaitStartedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["input_hash", "started_at", "deadline_at", "next_check_at"]);
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  const expectedKind = event.event === "wait.registered" ? "wait" : "verify";
  if (node.kind !== expectedKind) throw new Error(`${event.event} requires the current ${expectedKind} node`);
  assertComponentEnvelope(compiled, event, node.id, null);
  const component = componentForNode(compiled, node);
  const durationField = component.timing.max_wait_seconds_config_field;
  const duration = durationField ? node.config[durationField] : undefined;
  if (component.timing.mode !== "durable_wait" || typeof duration !== "number") {
    throw new Error(`${event.event} component has no frozen durable wait duration`);
  }
  const inputHash = await inputSnapshotHash(await runtimeInputs(compiled, prior, node));
  const deadline = Math.min(prior.elapsed_deadline_at, event.at + duration);
  assertStringEquals(event, "input_hash", inputHash);
  if (numberField(event.payload, "started_at") !== event.at) throw new Error(`${event.event} started_at does not match event time`);
  if (numberField(event.payload, "deadline_at") !== deadline) throw new Error(`${event.event} deadline does not match frozen limits`);
  if (numberField(event.payload, "next_check_at") !== event.at) throw new Error(`${event.event} first check must begin at registration time`);
}

async function assertWaitReadyEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["output", "output_hash", "output_schema_hash", "output_assurance", "next_node_id"]);
  const pending = requirePending(prior, "wait", stringNode(event));
  if (prior.status !== "waiting") throw new Error("wait.ready requires a waiting run");
  if (event.at >= pending.deadline_at) throw new Error("wait.ready occurred at or after its deadline");
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "wait") throw new Error("wait.ready points to a non-wait node");
  assertEventPrincipal(event, ["agentry_system"]);
  assertStringEquals(event, "next_node_id", node.on_ready);
  await assertOutputEvent(compiled, event, node.id, resolvedNode(compiled, node.id).output_minimum_assurance);
}

function assertWaitExitEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  const domainError = event.event === "wait.domain_failed";
  assertExactPayload(event, domainError ? ["error", "next_node_id"] : ["next_node_id"]);
  const pending = requirePending(prior, "wait", stringNode(event));
  if (prior.status !== "waiting") throw new Error(`${event.event} requires a waiting run`);
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "wait") throw new Error(`${event.event} points to a non-wait node`);
  assertComponentEnvelope(compiled, event, node.id, null);
  assertEventPrincipal(event, ["agentry_system"]);
  if (domainError) {
    if (event.at >= pending.deadline_at) throw new Error("wait domain failure occurred at or after timeout");
    assertDomainError(event);
    assertStringEquals(event, "next_node_id", node.on_error);
  } else {
    if (event.at < pending.deadline_at) throw new Error("wait timeout occurred before its deadline");
    assertStringEquals(event, "next_node_id", node.on_timeout);
  }
}

function assertVerificationPendingEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["next_check_at"]);
  const pending = requirePending(prior, "verify", stringNode(event));
  if (prior.status !== "verifying") throw new Error("verification.pending requires a verifying run");
  if (event.at >= pending.deadline_at) throw new Error("verification.pending occurred at or after timeout");
  assertComponentEnvelope(compiled, event, pending.node_id, null);
  assertEventPrincipal(event, ["agentry_system"]);
  const nextCheck = numberField(event.payload, "next_check_at");
  if (nextCheck <= event.at || nextCheck > pending.deadline_at) throw new Error("verification next check is outside its immutable window");
}

async function assertVerificationResultEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Promise<void> {
  assertExactPayload(event, ["output", "output_hash", "output_schema_hash", "output_assurance", "next_node_id"]);
  const pending = requirePending(prior, "verify", stringNode(event));
  if (prior.status !== "verifying") throw new Error(`${event.event} requires a verifying run`);
  if (event.at >= pending.deadline_at) throw new Error(`${event.event} occurred at or after timeout`);
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "verify") throw new Error(`${event.event} points to a non-verification node`);
  assertEventPrincipal(event, ["agentry_system"]);
  const passed = event.event === "verification.passed";
  assertStringEquals(event, "next_node_id", passed ? node.on_pass : node.on_fail);
  await assertOutputEvent(compiled, event, node.id, resolvedNode(compiled, node.id).output_minimum_assurance);
  const output = event.payload.output;
  if (!isObject(output) || output.passed !== passed) throw new Error(`${event.event} output contradicts its passed field`);
}

function assertVerificationExitEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  const domainError = event.event === "verification.domain_failed";
  assertExactPayload(event, domainError ? ["error", "next_node_id"] : ["next_node_id"]);
  const pending = requirePending(prior, "verify", stringNode(event));
  if (prior.status !== "verifying") throw new Error(`${event.event} requires a verifying run`);
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "verify") throw new Error(`${event.event} points to a non-verification node`);
  assertComponentEnvelope(compiled, event, node.id, null);
  assertEventPrincipal(event, ["agentry_system"]);
  if (domainError) {
    if (event.at >= pending.deadline_at) throw new Error("verification domain failure occurred at or after timeout");
    assertDomainError(event);
    assertStringEquals(event, "next_node_id", node.on_error);
  } else {
    if (event.at < pending.deadline_at) throw new Error("verification timeout occurred before its deadline");
    assertStringEquals(event, "next_node_id", node.on_timeout);
  }
}

function assertTerminalEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertAutomaticContinuation(prior, event);
  const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
  if (node.kind !== "terminal") throw new Error(`${event.event} requires the current terminal node`);
  assertNoComponentEnvelope(event);
  if (event.event === "run.completed") {
    assertExactPayload(event, ["result_node_id", "result_contract", "result_hash"]);
    if (node.terminal.outcome !== "complete") throw new Error("run.completed requires a complete terminal");
    const result = requireOutput(prior, node.terminal.result.node_id);
    assertStringEquals(event, "result_node_id", result.node_id);
    assertStringEquals(event, "result_contract", result.contract);
    assertStringEquals(event, "result_hash", result.payload_hash);
    return;
  }
  assertExactPayload(event, ["destination", "instructions"]);
  if (node.terminal.outcome !== "escalate") throw new Error("run.escalated requires an escalation terminal");
  assertStringEquals(event, "destination", node.terminal.destination);
  assertStringEquals(event, "instructions", node.terminal.instructions);
}

function assertRunCancelledEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["reason"]);
  assertEventNode(event, prior.current_node_id);
  assertNoComponentEnvelope(event);
  assertEventPrincipal(event, ["human_project_owner"]);
  assertBoundedReasonField(event, "reason");
  if (!compiled.workflow.nodes.some((node) => node.id === event.node_id)) throw new Error("run.cancelled current node is not in the workflow");
}

function assertRunQuarantinedEvent(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  assertExactPayload(event, ["reason"]);
  assertEventNode(event, prior.current_node_id);
  if (event.payload_schema_ref !== null) throw new Error("run.quarantined cannot carry an output schema");
  if (event.component_hash !== null) {
    if (!event.node_id) throw new Error("run.quarantined component hash requires a node");
    const resolved = compiled.resolved_nodes.find((candidate) => candidate.node_id === event.node_id);
    if (!resolved || resolved.component_hash !== event.component_hash) throw new Error("run.quarantined component hash does not match the current node");
  }
  const reason = assertBoundedReasonField(event, "reason");
  if (reason === "elapsed_deadline_exceeded") {
    if (event.at < prior.elapsed_deadline_at) throw new Error("elapsed deadline quarantine occurred before the deadline");
    if (event.component_hash !== null) throw new Error("elapsed deadline quarantine cannot carry a component hash");
    return;
  }
  if (reason === "active_runtime_budget_exceeded") {
    const activeAtEvent = prior.active_runtime_seconds + (
      prior.active_started_at === null ? 0 : Math.max(0, event.at - prior.active_started_at)
    );
    if (activeAtEvent < compiled.workflow.limits.max_active_runtime_seconds) {
      throw new Error("active runtime quarantine occurred before the budget was exhausted");
    }
    if (event.component_hash !== null) throw new Error("active runtime quarantine cannot carry a component hash");
    return;
  }
  if (reason === "kill_switch_active") {
    assertAutomaticContinuation(prior, event);
    if (!Object.values(prior.effects).some((effect) =>
      effect.status === "succeeded" || effect.status === "indeterminate"
    )) {
      throw new Error("kill-switch settlement quarantine has no settled or indeterminate provider effect");
    }
    if (event.component_hash !== null) throw new Error("kill-switch settlement quarantine cannot carry a component hash");
    return;
  }
  if (reason === "trigger_reentered") {
    assertAutomaticContinuation(prior, event);
    const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
    if (node.kind !== "trigger") throw new Error("trigger reentry quarantine requires the current trigger node");
    assertComponentEnvelope(compiled, event, node.id, null);
    return;
  }
  if (reason === "external_effect_run_budget_exhausted") {
    assertAutomaticContinuation(prior, event);
    const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
    if (node.kind !== "effect" || componentForNode(compiled, node).side_effect.kind !== "external_provider") {
      throw new Error("external effect budget quarantine requires the current provider effect");
    }
    if (Object.keys(prior.effects).length < compiled.workflow.limits.max_external_effects_per_run) {
      throw new Error("external effect budget quarantine occurred before exhaustion");
    }
    assertComponentEnvelope(compiled, event, node.id, null);
    return;
  }
  if (reason === "effect_approval_missing_or_expired") {
    assertAutomaticContinuation(prior, event);
    const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
    if (node.kind !== "effect" || componentForNode(compiled, node).side_effect.kind !== "external_provider") {
      throw new Error("approval quarantine requires the current provider effect");
    }
    const approval = prior.approvals[node.id];
    if (approval?.status === "approved" && approval.expires_at > event.at) {
      throw new Error("approval quarantine occurred despite an exact unexpired approval");
    }
    assertComponentEnvelope(compiled, event, node.id, null);
    return;
  }
  if (reason === "agent_task_budget_unavailable") {
    assertAutomaticContinuation(prior, event);
    const node = requireCurrentWorkflowNode(compiled, prior, event, "running");
    if (node.kind !== "agent_task" || !agentTaskBudgetUnavailable(compiled, prior)) {
      throw new Error("agent task budget quarantine occurred while aggregate turn and cost capacity remained");
    }
    assertComponentEnvelope(compiled, event, node.id, null);
    return;
  }
  if (
    reason === "turn_budget_exceeded" ||
    reason === "cost_budget_exceeded" ||
    reason === "workspace_file_budget_exceeded" ||
    reason === "workspace_line_budget_exceeded"
  ) {
    assertAutomaticContinuation(prior, event);
    const pending = requirePending(prior, "component", event.node_id ?? "");
    const node = nodeById(compiled.workflow, pending.node_id);
    if (prior.status !== "awaiting_component" || node.kind !== "agent_task") {
      throw new Error("agent usage budget quarantine requires the pending agent_task");
    }
    if (agentUsageBudgetExceeded(compiled, prior) !== reason) {
      throw new Error("agent usage budget quarantine reason does not match the aggregate projection");
    }
    if (event.component_hash !== null) throw new Error("agent usage budget quarantine cannot carry a component hash");
    return;
  }
  if (reason === "effect_reconciliation_exhausted_manual_follow_up_required") {
    assertAutomaticContinuation(prior, event);
    const pending = requirePending(prior, "effect", event.node_id ?? "");
    if (
      prior.status !== "effect_indeterminate" ||
      pending.reconciliation_count !== AUTOMATION_WORKFLOW_MAX_EFFECT_RECONCILIATIONS ||
      pending.next_reconcile_at !== null
    ) {
      throw new Error("manual effect follow-up quarantine requires an exhausted indeterminate reconciliation");
    }
    if (event.component_hash !== null) throw new Error("effect reconciliation quarantine cannot carry a component hash");
    return;
  }
  if (reason === "internal_advance_bound_exceeded") {
    assertAutomaticContinuation(prior, event);
    if (event.component_hash !== null) throw new Error("internal advance quarantine cannot carry a component hash");
    return;
  }
  assertEventPrincipal(event, ["agentry_system"]);
  if (event.component_hash !== null) throw new Error("explicit run quarantine cannot carry a component hash");
}

async function assertOutputEvent(
  compiled: CompiledAutomationWorkflow,
  event: AutomationWorkflowRunEvent,
  nodeId: string,
  expectedAssurance: AutomationWorkflowRunOutput["assurance"],
): Promise<void> {
  const resolved = resolvedNode(compiled, nodeId);
  assertComponentEnvelope(compiled, event, nodeId, resolved.output_contract);
  assertStringEquals(event, "output_schema_hash", resolved.output_contract_schema_hash);
  if (assuranceField(event.payload, "output_assurance") !== expectedAssurance) {
    throw new Error("workflow output assurance does not match its authenticated component path");
  }
  if (!("output" in event.payload)) throw new Error("workflow output event has no output payload");
  const rawOutputHash = await hashJson(event.payload.output);
  assertStringEquals(event, "output_hash", rawOutputHash);
  const validated = await validateAutomationWorkflowPayload(resolved.output_contract, event.payload.output);
  if (!validated.success) throw new Error(`workflow output does not satisfy ${resolved.output_contract}`);
  if (validated.payload_hash !== rawOutputHash) throw new Error("workflow output is not in canonical validated form");
  const contract = getAutomationWorkflowDataContract(resolved.output_contract);
  if (!contract) throw new Error(`workflow output contract ${resolved.output_contract} is not installed`);
  const installedContract = await serializeAutomationWorkflowDataContract(contract);
  if (installedContract.schema_hash !== resolved.output_contract_schema_hash) throw new Error("workflow output schema differs from the frozen compile artifact");
}

function requireCurrentWorkflowNode(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
  status: AutomationWorkflowRunStatus,
): AutomationWorkflowNode {
  if (prior.status !== status || prior.pending !== null) throw new Error(`${event.event} requires ${status} with no pending operation`);
  if (!prior.current_node_id) throw new Error(`${event.event} requires a current workflow node`);
  assertEventNode(event, prior.current_node_id);
  return nodeById(compiled.workflow, prior.current_node_id);
}

function requirePendingComponentNode(
  compiled: CompiledAutomationWorkflow,
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" }> {
  const pending = requirePending(prior, "component", stringNode(event));
  if (prior.status !== "awaiting_component") throw new Error(`${event.event} requires an awaiting component run`);
  const node = nodeById(compiled.workflow, pending.node_id);
  if (node.kind !== "query" && node.kind !== "agent_task" && node.kind !== "effect") {
    throw new Error(`${event.event} pending component points to an unsupported node`);
  }
  assertComponentEnvelope(compiled, event, node.id, event.event === "node.completed" ? resolvedNode(compiled, node.id).output_contract : null);
  if (pending.component_hash !== event.component_hash) throw new Error(`${event.event} component hash differs from pending state`);
  return node;
}

function assertComponentEnvelope(
  compiled: CompiledAutomationWorkflow,
  event: AutomationWorkflowRunEvent,
  nodeId: string,
  schemaRef: string | null,
): void {
  assertEventNode(event, nodeId);
  const resolved = resolvedNode(compiled, nodeId);
  if (event.component_hash !== resolved.component_hash) throw new Error("workflow event component hash mismatch");
  if (event.payload_schema_ref !== schemaRef) throw new Error("workflow event output contract mismatch");
}

function assertNoComponentEnvelope(event: AutomationWorkflowRunEvent): void {
  if (event.component_hash !== null || event.payload_schema_ref !== null) {
    throw new Error(`${event.event} cannot carry component or output-contract bindings`);
  }
}

function assertAutomaticContinuation(
  prior: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
): void {
  if (
    event.command_id !== prior.last_command_id ||
    event.request_hash !== prior.last_request_hash ||
    event.at !== prior.last_event_at ||
    event.actor.principal !== prior.last_actor.principal ||
    event.actor.credential_id !== prior.last_actor.credential_id
  ) throw new Error(`${event.event} is not part of the command that reached this internal node`);
}

function assertEventPrincipal(
  event: AutomationWorkflowRunEvent,
  allowed: readonly AutomationWorkflowPrincipal[],
): void {
  if (!allowed.includes(event.actor.principal)) throw new Error(`${event.event} actor principal is not authorized`);
}

function assertEventNode(event: AutomationWorkflowRunEvent, expected: string | null): void {
  if (event.node_id !== expected) throw new Error(`${event.event} node does not match the legal transition`);
}

function assertExactPayload(event: AutomationWorkflowRunEvent, fields: readonly string[]): void {
  const actual = Object.keys(event.payload).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${event.event} payload fields do not match its immutable event schema`);
  }
}

function assertStringEquals(event: AutomationWorkflowRunEvent, field: string, expected: string): void {
  if (stringField(event.payload, field) !== expected) throw new Error(`${event.event} payload.${field} does not match the legal transition`);
}

function booleanField(payload: Record<string, AutomationWorkflowJsonValue>, field: string): boolean {
  const value = payload[field];
  if (typeof value !== "boolean") throw new Error(`workflow event payload.${field} must be a boolean`);
  return value;
}

function assertJsonEquals(actual: AutomationWorkflowJsonValue | undefined, expected: AutomationWorkflowJsonValue, label: string): void {
  if (actual === undefined || canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw new Error(`${label} does not match the compiled workflow`);
  }
}

function assertDomainError(event: AutomationWorkflowRunEvent): void {
  const error = event.payload.error;
  if (!isObject(error) || Object.keys(error).sort().join("\u0000") !== "code\u0000message") {
    throw new Error(`${event.event} has an invalid domain error payload`);
  }
  if (typeof error.code !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(error.code)) {
    throw new Error(`${event.event} domain error code is invalid`);
  }
  if (typeof error.message !== "string" || error.message.trim() !== error.message || error.message.length < 1 || error.message.length > 2_000) {
    throw new Error(`${event.event} domain error message is invalid`);
  }
}

function assertBoundedReasonField(event: AutomationWorkflowRunEvent, field: string): string {
  const reason = stringField(event.payload, field);
  if (reason.trim() !== reason || reason.length < 1 || reason.length > 2_000) {
    throw new Error(`${event.event} payload.${field} is not a bounded canonical reason`);
  }
  return reason;
}

export async function nextAutomationWorkflowAction(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState,
): Promise<AutomationWorkflowNextAction> {
  assertStateBinding(compiled, state);
  if (!state.pending || TERMINAL_STATUSES.has(state.status)) return null;
  if (state.pending.kind === "component") {
    const node = nodeById(compiled.workflow, state.pending.node_id);
    if (!["query", "agent_task", "effect"].includes(node.kind)) throw new Error("component pending state points to unsupported node");
    const componentNode = node as Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" }>;
    const resolved = resolvedNode(compiled, node.id);
    return {
      kind: "execute_component",
      node_id: node.id,
      attempt: state.pending.attempt,
      component: componentNode.component,
      component_hash: state.pending.component_hash,
      config: componentNode.config,
      inputs: await runtimeInputs(compiled, state, componentNode),
      input_hash: state.pending.input_hash,
      output_contract: resolved.output_contract,
      output_schema_hash: resolved.output_contract_schema_hash,
      output_minimum_assurance: resolved.output_minimum_assurance,
    };
  }
  if (state.pending.kind === "approval") {
    return {
      kind: "await_approval",
      node_id: state.pending.node_id,
      effect_node_id: state.pending.effect_node_id,
      subject_hash: state.pending.subject_hash,
      binding_hash: state.pending.binding_hash,
      expires_at: state.pending.expires_at,
    };
  }
  if (state.pending.kind === "effect") {
    if (state.pending.status === "indeterminate") {
      if (state.pending.next_reconcile_at === null) {
        throw new Error("nonterminal indeterminate effect has no bounded reconciliation time");
      }
      return {
        kind: "reconcile_effect",
        node_id: state.pending.node_id,
        intent_hash: state.pending.intent_hash,
        provider_target: state.pending.provider_target,
        reconciliation_count: state.pending.reconciliation_count,
        next_reconcile_at: state.pending.next_reconcile_at,
      };
    }
    const node = nodeById(compiled.workflow, state.pending.node_id);
    if (node.kind !== "effect") throw new Error("effect pending state points to non-effect node");
    return {
      kind: "execute_effect",
      node_id: node.id,
      component: node.component,
      component_hash: state.pending.component_hash,
      intent_hash: state.pending.intent_hash,
      provider_target: state.pending.provider_target,
      input_hash: state.pending.input_hash,
      inputs: await runtimeInputs(compiled, state, node),
    };
  }
  return {
    kind: "suspended",
    suspension: state.pending.kind,
    node_id: state.pending.node_id,
    next_check_at: state.pending.next_check_at,
    deadline_at: state.pending.deadline_at,
  };
}

function assertCompiledRuntimeBinding(compiled: CompiledAutomationWorkflow) {
  if (compiled.kind !== "automation_workflow_compile" || compiled.schema_version !== "3") {
    runtimeError("compiled_workflow_invalid", "The runtime accepts only a server-compiled workflow v3 artifact.", "Compile the exact workflow definition again.");
  }
  if (compiled.candidate.enabled !== false) throw new Error("compiler produced an enabled candidate");
}

function assertCommandEnvelope(
  state: AutomationWorkflowRunState | null,
  command: AutomationWorkflowRuntimeCommand,
) {
  if (!COMMAND_ID.test(command.command_id)) runtimeError("command_id_invalid", "command_id must be a bounded stable identifier.", "Use one stable idempotency key for the logical command.");
  if (!Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) runtimeError("run_revision_invalid", "expected_revision must be a nonnegative integer.", "Read the current run revision.");
  if (!Number.isSafeInteger(command.at) || command.at < 0) runtimeError("command_time_invalid", "Command time must be a nonnegative server timestamp.", "Use the server-owned current time.");
  if (state && command.expected_revision !== state.revision) runtimeError("run_revision_conflict", `Expected run revision ${command.expected_revision}, current is ${state.revision}.`, "Reload the run and replay only the exact prior command or submit against the current revision.");
  if (state && command.at < state.last_event_at) runtimeError("command_time_regressed", "Command time precedes the last durable workflow event.", "Use a server-owned timestamp at or after the current run projection time.");
  if (!command.actor.credential_id && !new Set<AutomationWorkflowPrincipal>(["agentry_system", "customer_posthog", "trusted_ci"]).has(command.actor.principal)) {
    runtimeError("actor_credential_required", "Human and runner commands require an authenticated credential tombstone.", "Authenticate with the exact principal required for this command.");
  }
}

function assertStateBinding(compiled: CompiledAutomationWorkflow, state: AutomationWorkflowRunState) {
  if (state.workflow_hash !== compiled.workflow_hash || state.compile_hash !== compiled.compile_hash || state.automation_id !== compiled.workflow.id) {
    runtimeError("run_compile_binding_mismatch", "Run state is not bound to this immutable compiled workflow.", "Load the exact revision and compile hash frozen when the run started.");
  }
  if (!SHA256_HEX.test(state.last_event_hash)) throw new Error("run projection has no valid last event hash");
  if (!Number.isSafeInteger(state.usage_sequence) || state.usage_sequence < 0) {
    throw new Error("run projection has an invalid usage sequence");
  }
  if (!Number.isSafeInteger(state.turns_used) || state.turns_used < 0) {
    throw new Error("run projection has invalid aggregate turns");
  }
  if (!Number.isSafeInteger(state.cost_micros) || state.cost_micros < 0) {
    throw new Error("run projection has invalid aggregate cost");
  }
  if (!Number.isSafeInteger(state.changed_line_churn) || state.changed_line_churn < 0) {
    throw new Error("run projection has invalid aggregate changed-line churn");
  }
  assertCanonicalTouchedFiles(state.changed_files);
  if (state.pending?.kind === "component" && state.pending.usage_sequence !== null && (
    !Number.isSafeInteger(state.pending.usage_sequence) ||
    state.pending.usage_sequence !== state.usage_sequence
  )) {
    throw new Error("run projection pending component has an invalid usage binding");
  }
  if (state.pending?.kind === "effect") {
    if (!Number.isSafeInteger(state.pending.reconciliation_count) || state.pending.reconciliation_count < 0) {
      throw new Error("run projection pending effect has an invalid reconciliation count");
    }
    if (
      state.pending.status === "reserved" && state.pending.next_reconcile_at !== null ||
      state.pending.status === "indeterminate" && (
        state.pending.next_reconcile_at === null ||
        !Number.isSafeInteger(state.pending.next_reconcile_at) ||
        state.pending.next_reconcile_at < state.last_event_at
      )
    ) {
      throw new Error("run projection pending effect has an invalid reconciliation schedule");
    }
  }
}

function requirePrincipal(actor: AutomationWorkflowActor, expected: AutomationWorkflowPrincipal, message: string) {
  if (actor.principal !== expected) runtimeError("principal_not_allowed", message, `Authenticate as ${expected} without substituting another credential boundary.`);
}

function nodeById(workflow: AutomationWorkflowDefinition, nodeId: string): AutomationWorkflowNode {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`compiled workflow node ${nodeId} is missing`);
  return node;
}

function resolvedNode(compiled: CompiledAutomationWorkflow, nodeId: string) {
  const resolved = compiled.resolved_nodes.find((candidate) => candidate.node_id === nodeId);
  if (!resolved) throw new Error(`node ${nodeId} has no resolved component`);
  return resolved;
}

function componentForNode(
  compiled: CompiledAutomationWorkflow,
  node: Extract<AutomationWorkflowNode, { kind: "trigger" | "query" | "agent_task" | "effect" | "wait" | "verify" }>,
) {
  const key = automationWorkflowComponentKey(node.component);
  const component = compiled.resolved_components.find((candidate) => automationWorkflowComponentKey(candidate) === key);
  if (!component) throw new Error(`compiled component ${key} is missing`);
  return component;
}

async function validatedOutput(
  resolved: CompiledAutomationWorkflow["resolved_nodes"][number],
  input: unknown,
  at: number,
): Promise<AutomationWorkflowRunOutput> {
  const result = await validateAutomationWorkflowPayload(resolved.output_contract, input);
  if (!result.success) {
    runtimeError("component_output_invalid", `Output does not satisfy ${resolved.output_contract}.`, "Return only the exact bounded payload described by the frozen component contract.", { issues: result.issues });
  }
  const dataContract = getAutomationWorkflowDataContract(resolved.output_contract);
  if (!dataContract) throw new Error(`compiled output contract ${resolved.output_contract} is not installed`);
  const serializedContract = await serializeAutomationWorkflowDataContract(dataContract);
  if (serializedContract.schema_hash !== resolved.output_contract_schema_hash) {
    runtimeError("component_schema_hash_mismatch", "Installed payload schema differs from the frozen compile artifact.", "Quarantine the run and restore the exact immutable contract implementation.");
  }
  return {
    node_id: resolved.node_id,
    contract: result.contract,
    schema_hash: resolved.output_contract_schema_hash,
    assurance: resolved.output_minimum_assurance,
    payload: result.payload,
    payload_hash: result.payload_hash,
    recorded_at: at,
  };
}

function assertTriggerReceiptEligible(output: AutomationWorkflowRunOutput, at: number): void {
  assertTriggerPayloadEligible(output.contract, output.payload, at);
}

function assertTriggerPayloadEligible(
  contract: string,
  payload: AutomationWorkflowJsonValue | undefined,
  at: number,
): void {
  if (!isObject(payload)) throw new Error("trigger receipt payload must be an object");
  if (contract === "case_trigger_receipt@1") {
    const issuedAt = payload.issued_at;
    const expiresAt = payload.expires_at;
    if (typeof issuedAt !== "number" || typeof expiresAt !== "number" || at < issuedAt || at >= expiresAt) {
      runtimeError("trigger_receipt_not_eligible", "The case trigger receipt is not currently eligible.", "Consume the exact server-issued receipt no earlier than issuance and before its expiry.");
    }
  } else if (contract === "schedule_trigger_receipt@1") {
    const windowStart = payload.window_start;
    const windowEnd = payload.window_end;
    if (typeof windowStart !== "number" || typeof windowEnd !== "number" || at < windowStart || at >= windowEnd) {
      runtimeError("trigger_receipt_not_eligible", "The scheduled trigger occurrence is outside its half-open start window.", "Wait for a current server-issued schedule receipt; do not replay an expired occurrence.");
    }
  }
}

async function runtimeInputs(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState,
  node: Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" | "wait" | "verify" }>,
): Promise<Record<string, AutomationWorkflowRunOutput>> {
  const resolved = resolvedNode(compiled, node.id);
  const inputs: Record<string, AutomationWorkflowRunOutput> = {};
  for (const [portName, ref] of Object.entries(node.inputs)) {
    const port = resolved.input_ports[portName];
    if (!port) throw new Error(`compiled input port ${node.id}.${portName} is missing`);
    const output = requireOutput(state, ref.node_id);
    if (output.contract !== port.contract || output.schema_hash !== port.schema_hash) {
      runtimeError("input_contract_mismatch", `Input ${node.id}.${portName} does not match its frozen contract and schema hash.`, "Quarantine the run; do not coerce or reinterpret persisted output.");
    }
    if (assuranceRank(output.assurance) < assuranceRank(port.minimum_assurance)) {
      runtimeError("input_assurance_insufficient", `Input ${node.id}.${portName} has ${output.assurance} assurance but requires ${port.minimum_assurance}.`, "Obtain evidence through the component's declared authoritative adapter.");
    }
    inputs[portName] = output;
  }
  return inputs;
}

async function inputSnapshotHash(inputs: Record<string, AutomationWorkflowRunOutput>): Promise<string> {
  return hashJson(Object.fromEntries(Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right)).map(([port, output]) => [port, {
    node_id: output.node_id,
    contract: output.contract,
    schema_hash: output.schema_hash,
    assurance: output.assurance,
    payload_hash: output.payload_hash,
  }])));
}

function providerTargetFor(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState,
  sideEffectKind: string,
): string {
  if (sideEffectKind === "external_provider") {
    if (!compiled.workflow.runner.repository) throw new Error("external provider effect has no frozen repository target");
    return compiled.workflow.runner.repository;
  }
  return `agentry:project:${state.project_id}`;
}

function requireOutput(state: AutomationWorkflowRunState, nodeId: string): AutomationWorkflowRunOutput {
  const output = state.outputs[nodeId];
  if (!output) runtimeError("run_output_missing", `Required same-run output ${nodeId} is missing.`, "Quarantine the run; never synthesize or import output from another run.");
  return output;
}

function requirePending<K extends AutomationWorkflowPendingState["kind"]>(
  state: AutomationWorkflowRunState,
  kind: K,
  nodeId: string,
): Extract<AutomationWorkflowPendingState, { kind: K }> {
  const pending = state.pending;
  if (!pending || pending.kind !== kind || pending.node_id !== nodeId) {
    runtimeError("run_command_stale", `Run is not waiting for ${kind} at node ${nodeId}.`, "Reload the current run revision and follow its exact next_action.");
  }
  return pending as Extract<AutomationWorkflowPendingState, { kind: K }>;
}

function requireIntent(pending: Extract<AutomationWorkflowPendingState, { kind: "effect" }>, intentHash: string) {
  if (intentHash !== pending.intent_hash) runtimeError("effect_intent_mismatch", "The effect intent hash does not match the durable run-node intent.", "Use the exact intent returned by the current run action.");
}

async function appendAgentUsage(
  context: RuntimeContext,
  node: Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" }>,
  componentHash: string,
  usage: AutomationWorkflowAdapterUsage | undefined,
): Promise<void> {
  if (node.kind !== "agent_task") {
    if (usage !== undefined) {
      runtimeError(
        "agent_usage_unexpected",
        "Adapter-observed agent usage is accepted only for agent_task completion or domain failure.",
        "Omit usage for deterministic query and effect components.",
      );
    }
    return;
  }
  if (usage === undefined) {
    runtimeError(
      "agent_usage_required",
      "Agent task completion requires adapter-observed cumulative usage.",
      "Report the exact contiguous usage sequence, cumulative turns and cost, touched files, and changed-line churn.",
    );
  }
  const state = context.state!;
  assertUsageCommand(state, usage);
  await appendEvent(context, "run.usage_recorded", node.id, componentHash, null, {
    sequence: usage.sequence,
    turns_used: usage.turns_used,
    cost_micros: usage.cost_micros,
    touched_files: usage.touched_files,
    changed_line_churn: usage.changed_line_churn,
  });
}

function assertUsageCommand(
  state: AutomationWorkflowRunState,
  usage: AutomationWorkflowAdapterUsage,
): void {
  try {
    assertUsageValues(
      state,
      usage.sequence,
      usage.turns_used,
      usage.cost_micros,
      usage.touched_files,
      usage.changed_line_churn,
    );
  } catch (error) {
    runtimeError(
      "agent_usage_invalid",
      error instanceof Error ? error.message : "Adapter-observed agent usage is invalid.",
      "Read the current run aggregate and submit one canonical, contiguous adapter observation.",
    );
  }
}

function assertUsageValues(
  state: AutomationWorkflowRunState,
  sequence: number,
  turnsUsed: number,
  costMicros: number,
  touchedFiles: readonly string[],
  changedLineChurn: number,
): void {
  if (!Number.isSafeInteger(sequence) || sequence !== state.usage_sequence + 1) {
    throw new Error("Agent usage sequence is not the next contiguous run observation.");
  }
  if (!Number.isSafeInteger(turnsUsed) || turnsUsed < state.turns_used) {
    throw new Error("Agent usage turns must be a nonnegative, nondecreasing safe integer.");
  }
  if (!Number.isSafeInteger(costMicros) || costMicros < state.cost_micros) {
    throw new Error("Agent usage cost_micros must be a nonnegative, nondecreasing safe integer.");
  }
  assertCanonicalTouchedFiles(touchedFiles);
  if (!Number.isSafeInteger(changedLineChurn) || changedLineChurn < 0) {
    throw new Error("Agent usage changed_line_churn must be a nonnegative safe integer.");
  }
  safeIntegerSum(state.changed_line_churn, changedLineChurn, "Agent usage changed-line churn exceeds the safe integer range.");
}

function assertCanonicalTouchedFiles(value: readonly string[]): void {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new Error("Agent usage touched_files must contain at most 1000 canonical repository-relative paths.");
  }
  let previous: string | null = null;
  for (const path of value) {
    if (
      typeof path !== "string" ||
      path.length < 1 ||
      path.length > 500 ||
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)
    ) {
      throw new Error("Agent usage touched_files contains a non-canonical repository-relative path.");
    }
    if (previous !== null && path <= previous) {
      throw new Error("Agent usage touched_files must be strictly sorted and unique.");
    }
    previous = path;
  }
}

function assertAgentUsageContinuation(
  prior: AutomationWorkflowRunState,
  node: Extract<AutomationWorkflowNode, { kind: "query" | "agent_task" | "effect" }>,
  event: AutomationWorkflowRunEvent,
): void {
  const pending = requirePending(prior, "component", node.id);
  if (node.kind === "agent_task") {
    if (pending.usage_sequence === null || pending.usage_sequence !== prior.usage_sequence) {
      throw new Error(`${event.event} agent_task has no exact durable usage observation`);
    }
    assertAutomaticContinuation(prior, event);
  } else if (pending.usage_sequence !== null) {
    throw new Error(`${event.event} non-agent component cannot carry agent usage`);
  }
}

function agentUsageBudgetExceeded(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState,
): string | null {
  if (state.turns_used > compiled.workflow.limits.max_turns_per_run) return "turn_budget_exceeded";
  const costLimit = costLimitMicros(compiled);
  if (costLimit !== null && state.cost_micros > costLimit) return "cost_budget_exceeded";
  if (state.changed_files.length > compiled.workflow.limits.max_files_changed_per_run) {
    return "workspace_file_budget_exceeded";
  }
  if (state.changed_line_churn > compiled.workflow.limits.max_changed_lines_per_run) {
    return "workspace_line_budget_exceeded";
  }
  return null;
}

function agentTaskBudgetUnavailable(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState,
): boolean {
  if (state.turns_used >= compiled.workflow.limits.max_turns_per_run) return true;
  const costLimit = costLimitMicros(compiled);
  return costLimit !== null && state.cost_micros >= costLimit;
}

function costLimitMicros(compiled: CompiledAutomationWorkflow): number | null {
  const cost = compiled.workflow.limits.max_cost_usd_per_run;
  return cost === undefined ? null : Math.round(cost * 1_000_000);
}

function nextEffectReconcileAt(
  compiled: CompiledAutomationWorkflow,
  state: AutomationWorkflowRunState,
  at: number,
): number {
  return Math.min(state.elapsed_deadline_at, at + compiled.workflow.limits.retry_backoff_seconds);
}

function linearNext(node: AutomationWorkflowNode): string {
  if (node.kind === "query" || node.kind === "agent_task" || node.kind === "effect") return node.next;
  throw new Error(`node ${node.id} has no linear next exit`);
}

function linearError(node: AutomationWorkflowNode): string {
  if (node.kind === "query" || node.kind === "agent_task" || node.kind === "effect") return node.on_error;
  throw new Error(`node ${node.id} has no linear error exit`);
}

function invalidNodeCommand(node: AutomationWorkflowNode, command: string): never {
  return runtimeError("node_command_invalid", `${command} is not valid for ${node.kind} node ${node.id}.`, "Follow the exact next_action for the current node kind.");
}

function boundedDomainError(value: { code: string; message: string } | undefined) {
  if (!value || !/^[a-z][a-z0-9_.-]{0,127}$/u.test(value.code) || value.message.trim().length < 1 || value.message.length > 2_000) {
    runtimeError("domain_error_invalid", "Declared domain errors require a canonical code and bounded message.", "Return an adapter-declared domain failure; quarantine infrastructure or schema faults.");
  }
  return { code: value.code, message: value.message.trim() };
}

function boundedReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 1 || reason.length > 2_000) runtimeError("reason_invalid", "Reason must contain 1-2000 characters.", "Provide a concise nonsecret reason.");
  return reason;
}

function valueAtPath(root: AutomationWorkflowJsonValue, path: string[]): AutomationWorkflowJsonValue {
  let value: AutomationWorkflowJsonValue = root;
  for (const part of path) {
    if (!isObject(value) || !(part in value)) runtimeError("condition_value_missing", `Condition path ${path.join(".")} is missing at runtime.`, "Quarantine the schema/adapter mismatch instead of choosing a graph branch.");
    value = value[part]!;
  }
  return value;
}

function evaluatePredicate(
  value: AutomationWorkflowJsonValue,
  operator: Extract<AutomationWorkflowNode, { kind: "condition" }>["predicate"]["operator"],
  expected: string | number | boolean | null,
): boolean {
  if (Array.isArray(value) || isObject(value)) runtimeError("condition_value_not_scalar", "Condition runtime value is not a scalar.", "Fix the adapter output to match the frozen typed value path.");
  switch (operator) {
    case "eq": return value === expected;
    case "not_eq": return value !== expected;
    case "gt": return typeof value === "number" && typeof expected === "number" && value > expected;
    case "gte": return typeof value === "number" && typeof expected === "number" && value >= expected;
    case "lt": return typeof value === "number" && typeof expected === "number" && value < expected;
    case "lte": return typeof value === "number" && typeof expected === "number" && value <= expected;
    case "contains": return typeof value === "string" && typeof expected === "string" && value.includes(expected);
  }
}

function cloneState(state: AutomationWorkflowRunState): AutomationWorkflowRunState {
  return {
    ...state,
    outputs: { ...state.outputs },
    attempts: { ...state.attempts },
    approvals: Object.fromEntries(Object.entries(state.approvals).map(([key, value]) => [key, { ...value }])),
    effects: Object.fromEntries(Object.entries(state.effects).map(([key, value]) => [key, { ...value }])),
    changed_files: [...state.changed_files],
    pending: state.pending ? { ...state.pending } : null,
    last_actor: { ...state.last_actor },
    terminal: state.terminal ? { ...state.terminal } : null,
  };
}

function recordOutput(state: AutomationWorkflowRunState, event: AutomationWorkflowRunEvent) {
  const nodeId = stringNode(event);
  if (state.outputs[nodeId]) throw new Error(`node ${nodeId} already has an immutable output`);
  if (!event.payload_schema_ref) throw new Error(`output event ${event.event} has no payload schema ref`);
  state.outputs[nodeId] = {
    node_id: nodeId,
    contract: event.payload_schema_ref,
    schema_hash: stringField(event.payload, "output_schema_hash"),
    assurance: assuranceField(event.payload, "output_assurance"),
    payload: event.payload.output!,
    payload_hash: stringField(event.payload, "output_hash"),
    recorded_at: event.at,
  };
  if (event.event === "effect.completed") {
    const effect = state.effects[nodeId];
    if (!effect) throw new Error(`effect ${nodeId} completed without a durable intent`);
    state.effects[nodeId] = {
      ...effect,
      status: "succeeded",
      next_reconcile_at: null,
      completed_at: event.at,
    };
  }
}

function updateApprovalDecision(
  state: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
  decision: "approved" | "rejected" | "expired",
) {
  const effectNodeId = stringField(event.payload, "effect_node_id");
  const approval = state.approvals[effectNodeId];
  if (!approval || approval.status !== "pending") throw new Error("approval decision has no pending immutable subject");
  state.approvals[effectNodeId] = { ...approval, status: decision, decided_at: event.at };
}

function suspendState(state: AutomationWorkflowRunState, at: number) {
  if (state.active_started_at !== null) {
    state.active_runtime_seconds += Math.max(0, at - state.active_started_at);
  }
  state.active_started_at = null;
}

function resumeState(state: AutomationWorkflowRunState, at: number, nextNodeId: string) {
  if (state.active_started_at !== null) {
    state.active_runtime_seconds += Math.max(0, at - state.active_started_at);
  }
  state.status = "running";
  state.current_node_id = nextNodeId;
  state.pending = null;
  state.active_started_at = at;
}

function terminalState(
  state: AutomationWorkflowRunState,
  event: AutomationWorkflowRunEvent,
  status: "completed" | "escalated" | "cancelled" | "quarantined",
  outcome: "complete" | "escalate" | "cancelled" | "quarantined",
) {
  suspendState(state, event.at);
  state.status = status;
  state.current_node_id = null;
  state.pending = null;
  state.terminal = { outcome, node_id: event.node_id, at: event.at };
}

function stringNode(event: AutomationWorkflowRunEvent): string {
  if (!event.node_id) throw new Error(`event ${event.event} requires node_id`);
  return event.node_id;
}

function requiredComponentHash(event: AutomationWorkflowRunEvent): string {
  if (!event.component_hash) throw new Error(`event ${event.event} requires component_hash`);
  return event.component_hash;
}

function stringField(payload: Record<string, AutomationWorkflowJsonValue>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`workflow event payload.${field} must be a string`);
  return value;
}

function numberField(payload: Record<string, AutomationWorkflowJsonValue>, field: string): number {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`workflow event payload.${field} must be an integer`);
  return value;
}

function stringArrayField(payload: Record<string, AutomationWorkflowJsonValue>, field: string): string[] {
  const value = payload[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`workflow event payload.${field} must be a string array`);
  }
  return value as string[];
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function safeIntegerSum(left: number, right: number, message: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error(message);
  return sum;
}

function assuranceField(
  payload: Record<string, AutomationWorkflowJsonValue>,
  field: string,
): AutomationWorkflowRunOutput["assurance"] {
  const value = stringField(payload, field);
  if (!new Set(["reported", "recorded", "observed", "verified"]).has(value)) throw new Error(`workflow event payload.${field} has unknown assurance`);
  return value as AutomationWorkflowRunOutput["assurance"];
}

function assuranceRank(value: AutomationWorkflowRunOutput["assurance"]): number {
  return { reported: 0, recorded: 1, observed: 2, verified: 3 }[value];
}

function maximumAssurance(
  left: AutomationWorkflowRunOutput["assurance"],
  right: AutomationWorkflowRunOutput["assurance"],
): AutomationWorkflowRunOutput["assurance"] {
  return assuranceRank(left) >= assuranceRank(right) ? left : right;
}

function isObject(value: unknown): value is Record<string, AutomationWorkflowJsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function hashJson(value: unknown): Promise<string> {
  try {
    return await sha256Hex(canonicalJsonStringify(value));
  } catch {
    return runtimeError("runtime_payload_not_canonical", "Command or event payload is not bounded canonical JSON.", "Remove cycles, undefined values, non-finite numbers, and non-JSON objects.");
  }
}

function runtimeError(
  code: string,
  message: string,
  nextAction: string,
  details: Record<string, unknown> = {},
): never {
  throw new AutomationWorkflowRuntimeError(code, message, nextAction, details);
}
