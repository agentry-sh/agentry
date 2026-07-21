import { z } from "zod";
import {
  canonicalJsonStringify,
  isValidCronExpression,
  isValidTimeZone,
  sha256Hex,
} from "@agentrysh/shared";
import {
  getAutomationWorkflowDataContract,
  serializeAutomationWorkflowDataContract,
} from "./automation-workflow-contracts.js";

export const AUTOMATION_WORKFLOW_COMPONENT_VERSION = "1.0.0" as const;

export type AutomationWorkflowComponentKind =
  | "trigger"
  | "query"
  | "agent_task"
  | "effect"
  | "wait"
  | "verify";

export type AutomationWorkflowPrincipal =
  | "agentry_system"
  | "automation_runner"
  | "human_project_owner"
  | "customer_posthog"
  | "trusted_ci";

export type AutomationWorkflowRequirement = {
  id: string;
  kind:
    | "project_readiness"
    | "credential"
    | "caller_assertion"
    | "approval"
    | "proof"
    | "runtime";
  requirement: string;
  next_action: string;
};

type SerializableConfigField = {
  type: "string" | "integer" | "number" | "boolean" | "string_array";
  required: boolean;
  minimum?: number;
  maximum?: number;
  min_items?: number;
  max_items?: number;
  item_format?: string;
  item_min_length?: number;
  item_max_length?: number;
  const?: string | number | boolean;
  format?: string;
  description: string;
};

export type SerializableAutomationWorkflowComponent = {
  id: string;
  version: string;
  kind: AutomationWorkflowComponentKind;
  title: string;
  description: string;
  input_ports: Record<string, {
    contract: string;
    required: boolean;
    description: string;
  }>;
  output_contract: string;
  output_value_paths: Array<{
    path: string[];
    type: "string" | "number" | "boolean" | "null";
  }>;
  output_available_on: Array<"next" | "on_ready" | "on_pass" | "on_fail">;
  config_contract: {
    additional_properties: false;
    fields: Record<string, SerializableConfigField>;
    rules: Array<
      | { kind: "distinct_items"; field: string }
      | { kind: "field_gte"; field: string; other_field: string }
    >;
  };
  principal_roles: {
    executor: AutomationWorkflowPrincipal;
    callers: AutomationWorkflowPrincipal[];
    approver: AutomationWorkflowPrincipal | null;
    evidence_sources: AutomationWorkflowPrincipal[];
  };
  requirement_templates: Array<{
    id: string;
    kind: AutomationWorkflowRequirement["kind"];
    description: string;
  }>;
  authority: {
    telemetry_instruction_authority: "none";
    owner_goal_grants_authority: false;
    effect_authority: "none" | "workflow_policy" | "one_time_grant";
    approval_floor: "none" | "per_run";
    approval_subject_port: string | null;
  };
  side_effect: {
    kind: "none" | "customer_runner_workspace" | "agentry_record" | "external_provider";
    description: string;
    forbidden: string[];
    enforcement: "runtime_required";
    workspace_policy: null | {
      path_semantics: "repository_relative_glob";
      allowed_paths_config_field: "allowed_paths";
      forbidden_paths: string[];
      deny_precedence: true;
      forbidden_change_types: string[];
      required_test_commands_config_field: "test_commands";
      max_files_changed_config_field: "max_files_changed";
      max_changed_lines_config_field: "max_changed_lines";
    };
    mutation_protocol: null | {
      intent_identity: "compile_hash+component_hash+run_id+node_id+canonical_input_hash+provider_target";
      reservation: "durable_unique_intent_before_provider_call";
      authorization_cardinality: "one_authorized_intent_per_run_node";
      provider_retry_safety: "adapter_specific_idempotency_or_reconciliation_required";
      uncertain_outcome: "indeterminate_until_reconciled";
      retry_policy: "reconcile_existing_intent_before_any_repeat";
      replay_policy: "return_persisted_receipt_without_repeating_provider_effect";
    };
  };
  lineage: {
    scope: "same_workflow_run";
    output_bound_to_inputs: true;
    runtime_preconditions: string[];
  };
  timing: {
    mode: "active" | "durable_wait";
    max_wait_seconds_config_field: string | null;
  };
};

export type AutomationWorkflowComponentManifest = {
  serializable: SerializableAutomationWorkflowComponent;
  config_schema: z.ZodTypeAny;
  requirements: (config: Record<string, unknown>) => AutomationWorkflowRequirement[];
};

const emptyConfig = z.object({}).strict();
const boundedText = (max: number) => z.string().trim().min(1).max(max);
export const AutomationWorkflowRepositoryRelativeGlobSchema = boundedText(500).refine((value) =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").includes("..") &&
  !/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(value) &&
  !/[\u0000-\u001f\u007f]/u.test(value),
"must be a repository-relative glob without parent traversal, backslashes, or a URI/drive prefix");
export const AutomationWorkflowCommandTextSchema = boundedText(500).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "must not contain control characters",
);
const eventName = z.string().min(1).max(200).regex(
  /^[^\s\u0000-\u001F\u007F]+$/u,
  "event names cannot contain whitespace or control characters",
);

const caseTriggerConfig = z.object({
  max_cases_per_sweep: z.number().int().min(1).max(100),
  cooldown_seconds: z.number().int().min(60).max(604_800),
  required_trust: z.literal("customer_posthog"),
}).strict();

const scheduleTriggerConfig = z.object({
  cron: boundedText(200).refine(
    isValidCronExpression,
    "must be a valid conservative five-field cron expression",
  ),
  timezone: boundedText(100).refine(
    isValidTimeZone,
    "must be a valid IANA time zone",
  ),
  start_window_seconds: z.number().int().min(60).max(86_400),
}).strict();

const codeFixTaskConfig = z.object({
  allowed_paths: z.array(AutomationWorkflowRepositoryRelativeGlobSchema).min(1).max(100),
  test_commands: z.array(AutomationWorkflowCommandTextSchema).min(1).max(30),
  max_files_changed: z.number().int().min(1).max(100),
  max_changed_lines: z.number().int().min(1).max(10_000),
}).strict();

const funnelQueryConfig = z.object({
  events: z.array(eventName).min(2).max(20),
  period_days: z.number().int().min(1).max(90),
  minimum_sample_size: z.number().int().min(1).max(100_000),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.events).size !== value.events.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["events"],
      message: "events must contain distinct event names in funnel order",
    });
  }
});

const deployWaitConfig = z.object({
  timeout_seconds: z.number().int().min(60).max(2_592_000),
}).strict();

const recurrenceVerificationConfig = z.object({
  traffic_sample_event: eventName,
  observation_window_seconds: z.number().int().min(60).max(2_592_000),
  max_wait_seconds: z.number().int().min(60).max(2_592_000),
  min_sample_size: z.number().int().min(1).max(10_000_000),
}).strict().superRefine((value, ctx) => {
  if (value.max_wait_seconds < value.observation_window_seconds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_wait_seconds"],
      message: "max_wait_seconds must be at least observation_window_seconds",
    });
  }
});

const fields = (
  value: Record<string, SerializableConfigField>,
  rules: SerializableAutomationWorkflowComponent["config_contract"]["rules"] = [],
): SerializableAutomationWorkflowComponent["config_contract"] => ({
  additional_properties: false,
  fields: value,
  rules,
});

const requirementTemplate = (
  id: string,
  kind: AutomationWorkflowRequirement["kind"],
  description: string,
) => ({ id, kind, description });

function defaultOutputExits(
  kind: AutomationWorkflowComponentKind,
): SerializableAutomationWorkflowComponent["output_available_on"] {
  switch (kind) {
    case "trigger":
    case "query":
    case "agent_task":
    case "effect":
      return ["next"];
    case "wait":
      return ["on_ready"];
    case "verify":
      return ["on_pass", "on_fail"];
  }
}

const base = (
  input: Omit<
    SerializableAutomationWorkflowComponent,
    "version" | "output_value_paths" | "output_available_on" | "timing"
  > & Pick<
    Partial<SerializableAutomationWorkflowComponent>,
    "output_value_paths" | "output_available_on" | "timing"
  >,
): SerializableAutomationWorkflowComponent => ({
  ...input,
  output_value_paths: input.output_value_paths ?? [],
  output_available_on: input.output_available_on ?? defaultOutputExits(input.kind),
  timing: input.timing ?? { mode: "active", max_wait_seconds_config_field: null },
  version: AUTOMATION_WORKFLOW_COMPONENT_VERSION,
});

function manifest(
  serializable: SerializableAutomationWorkflowComponent,
  configSchema: z.ZodTypeAny,
  requirements: AutomationWorkflowComponentManifest["requirements"] = () => [],
): AutomationWorkflowComponentManifest {
  return Object.freeze({
    serializable: deepFreeze(serializable),
    config_schema: configSchema,
    requirements,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

const roles = (
  executor: AutomationWorkflowPrincipal,
  input: Partial<Omit<SerializableAutomationWorkflowComponent["principal_roles"], "executor">> = {},
): SerializableAutomationWorkflowComponent["principal_roles"] => ({
  executor,
  callers: input.callers ?? [],
  approver: input.approver ?? null,
  evidence_sources: input.evidence_sources ?? [],
});

const sideEffect = (
  kind: SerializableAutomationWorkflowComponent["side_effect"]["kind"],
  description: string,
  forbidden: string[],
  workspacePolicy: SerializableAutomationWorkflowComponent["side_effect"]["workspace_policy"] = null,
  mutationProtocol: SerializableAutomationWorkflowComponent["side_effect"]["mutation_protocol"] = null,
): SerializableAutomationWorkflowComponent["side_effect"] => ({
  kind,
  description,
  forbidden,
  enforcement: "runtime_required",
  workspace_policy: workspacePolicy,
  mutation_protocol: mutationProtocol,
});

const EXTERNAL_PROVIDER_MUTATION_PROTOCOL: NonNullable<
  SerializableAutomationWorkflowComponent["side_effect"]["mutation_protocol"]
> = {
  intent_identity: "compile_hash+component_hash+run_id+node_id+canonical_input_hash+provider_target",
  reservation: "durable_unique_intent_before_provider_call",
  authorization_cardinality: "one_authorized_intent_per_run_node",
  provider_retry_safety: "adapter_specific_idempotency_or_reconciliation_required",
  uncertain_outcome: "indeterminate_until_reconciled",
  retry_policy: "reconcile_existing_intent_before_any_repeat",
  replay_policy: "return_persisted_receipt_without_repeating_provider_effect",
};

const CODE_FIX_WORKSPACE_POLICY: NonNullable<
  SerializableAutomationWorkflowComponent["side_effect"]["workspace_policy"]
> = {
  path_semantics: "repository_relative_glob",
  allowed_paths_config_field: "allowed_paths",
  forbidden_paths: [
    ".env*",
    "**/.env*",
    "secrets/**",
    "**/secrets/**",
    "credentials*",
    "**/credentials*",
    ".github/workflows/**",
  ],
  deny_precedence: true,
  forbidden_change_types: [
    "dependencies",
    "database_migrations",
    "infrastructure",
    "authentication",
    "billing",
    "permissions",
  ],
  required_test_commands_config_field: "test_commands",
  max_files_changed_config_field: "max_files_changed",
  max_changed_lines_config_field: "max_changed_lines",
};

const lineage = (
  runtimePreconditions: string[] = [],
): SerializableAutomationWorkflowComponent["lineage"] => ({
  scope: "same_workflow_run",
  output_bound_to_inputs: true,
  runtime_preconditions: runtimePreconditions,
});

const COMPONENTS: readonly AutomationWorkflowComponentManifest[] = Object.freeze([
  manifest(
    base({
      id: "trigger.cases.unhandled",
      kind: "trigger",
      title: "PostHog-observed unhandled case",
      description: "Bind one eligible server-issued receipt for a PostHog case projection as the workflow run anchor.",
      input_ports: {},
      output_contract: "case_trigger_receipt@1",
      output_value_paths: [
        { path: ["case_id"], type: "string" },
        { path: ["case_revision"], type: "number" },
      ],
      config_contract: fields({
        max_cases_per_sweep: { type: "integer", required: true, minimum: 1, maximum: 100, description: "Maximum eligible cases considered in one bounded sweep." },
        cooldown_seconds: { type: "integer", required: true, minimum: 60, maximum: 604_800, description: "Minimum delay before reconsidering equivalent work." },
        required_trust: { type: "string", required: true, const: "customer_posthog", description: "Case evidence must come from the customer-owned PostHog data plane." },
      }),
      principal_roles: roles("agentry_system", { evidence_sources: ["customer_posthog"] }),
      requirement_templates: [
        requirementTemplate("signal_map_saved", "project_readiness", "A canonical signal map is saved."),
        requirementTemplate("onboarding_verified_for_signal_map", "project_readiness", "The current onboarding receipt is verified for that signal map."),
        requirementTemplate("safe_error_proved", "project_readiness", "The approved safe error path was proved from shipped code."),
        requirementTemplate("posthog_connection_active", "project_readiness", "The read-only customer PostHog connection is active."),
        requirementTemplate("scheduler_execution_configured", "caller_assertion", "The selected runner consumes exact server-issued case receipts."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "none",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("none", "Receipt eligibility and run anchoring only.", ["runner_authored_trigger"]),
      lineage: lineage(["trusted_case_revision_is_eligible"]),
    }),
    caseTriggerConfig,
    () => [
      gate("signal_map_saved", "project_readiness", "A canonical signal map is saved.", "Finish verified onboarding and save the approved signal map."),
      gate("onboarding_verified_for_signal_map", "project_readiness", "The current onboarding receipt is verified for the saved signal map.", "Follow onboarding next_action until the exact plan is verified."),
      gate("safe_error_proved", "project_readiness", "The approved safe error path was proved from shipped code.", "Complete the scoped safe-error proof before enabling this trigger."),
      gate("posthog_connection_active", "project_readiness", "The read-only customer PostHog connection is active.", "Reconnect the project's PostHog Cloud OAuth connection."),
      gate("scheduler_execution_configured", "caller_assertion", "The selected runner consumes exact server-issued case receipts.", "Configure the customer-owned runner to poll and consume only Agentry-issued receipts."),
    ],
  ),
  manifest(
    base({
      id: "trigger.schedule.cron",
      kind: "trigger",
      title: "Cron schedule",
      description: "Bind one server-issued due receipt for an exact cron occurrence as the workflow run anchor.",
      input_ports: {},
      output_contract: "schedule_trigger_receipt@1",
      output_value_paths: [{ path: ["scheduled_for"], type: "number" }],
      config_contract: fields({
        cron: { type: "string", required: true, format: "five_field_cron", description: "Conservative five-field cron expression." },
        timezone: { type: "string", required: true, format: "iana_timezone", description: "IANA timezone used to derive the occurrence." },
        start_window_seconds: { type: "integer", required: true, minimum: 60, maximum: 86_400, description: "Bounded window in which the occurrence may start." },
      }),
      principal_roles: roles("agentry_system"),
      requirement_templates: [
        requirementTemplate("scheduler_execution_configured", "caller_assertion", "The selected scheduler consumes exact due schedule receipts."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "none",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("none", "Clock eligibility only.", ["runner_authored_scheduled_for"]),
      lineage: lineage(["server_issued_due_schedule_receipt"]),
    }),
    scheduleTriggerConfig,
    () => [
      gate("scheduler_execution_configured", "caller_assertion", "The selected scheduler consumes exact due schedule receipts.", "Configure the customer-owned scheduler without changing scheduled_for."),
    ],
  ),
  manifest(
    base({
      id: "query.cases.claimed-evidence",
      kind: "query",
      title: "Claimed case evidence",
      description: "Materialize bounded case evidence only while the exact case revision claim is active.",
      input_ports: {
        case_receipt: { contract: "case_trigger_receipt@1", required: true, description: "Exact server-issued case trigger receipt." },
      },
      output_contract: "claimed_case_evidence@1",
      output_value_paths: [
        { path: ["case_id"], type: "string" },
        { path: ["case_revision"], type: "number" },
      ],
      config_contract: fields({}),
      principal_roles: roles("agentry_system", {
        callers: ["automation_runner"],
        evidence_sources: ["agentry_system", "customer_posthog"],
      }),
      requirement_templates: [
        requirementTemplate("active_case_claim", "runtime", "The exact receipt case revision has an active claim owned by the runner."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "none",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("none", "Bounded evidence materialization only.", ["unscoped_case_inventory", "telemetry_as_instruction"]),
      lineage: lineage(["active_case_revision_claim_owned_by_runner"]),
    }),
    emptyConfig,
    () => [
      gate("active_case_claim", "runtime", "The exact case revision has an active claim owned by the runner.", "Claim the server-issued case receipt before materializing evidence."),
    ],
  ),
  manifest(
    base({
      id: "query.analytics.ordered-funnel-period-compare",
      kind: "query",
      title: "Ordered funnel period comparison",
      description: "Materialize one receipt-anchored aggregate comparison for approved observed events.",
      input_ports: {
        schedule: { contract: "schedule_trigger_receipt@1", required: true, description: "Exact due schedule receipt anchoring both periods." },
      },
      output_contract: "ordered_funnel_source@1",
      output_value_paths: [
        { path: ["source_hash"], type: "string" },
        { path: ["readiness", "status"], type: "string" },
      ],
      config_contract: fields({
        events: { type: "string_array", required: true, min_items: 2, max_items: 20, item_format: "event_name", item_min_length: 1, item_max_length: 200, description: "Distinct approved event names in exact funnel order." },
        period_days: { type: "integer", required: true, minimum: 1, maximum: 90, description: "Length of each adjacent comparison period." },
        minimum_sample_size: { type: "integer", required: true, minimum: 1, maximum: 100_000, description: "Minimum observed users required in each period." },
      }, [{ kind: "distinct_items", field: "events" }]),
      principal_roles: roles("agentry_system", {
        callers: ["automation_runner"],
        evidence_sources: ["agentry_system"],
      }),
      requirement_templates: [
        requirementTemplate("signal_map_saved", "project_readiness", "A canonical signal map is saved."),
        requirementTemplate("onboarding_verified_for_signal_map", "project_readiness", "The current onboarding receipt is verified."),
        requirementTemplate("ordered_funnel_blueprint_available", "project_readiness", "The bounded ordered-funnel blueprint is available."),
        requirementTemplate("event_approved:{event}", "project_readiness", "Every configured event is approved."),
        requirementTemplate("event_observed:{event}", "project_readiness", "Every configured event was observed in current proof."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "none",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("none", "Server-owned aggregate query only.", ["generic_hogql", "identifiers", "arbitrary_period"]),
      lineage: lineage(["exact_schedule_receipt_period_anchor"]),
    }),
    funnelQueryConfig,
    (config) => {
      const parsed = funnelQueryConfig.parse(config);
      return [
        gate("signal_map_saved", "project_readiness", "A canonical signal map is saved.", "Finish onboarding and save the approved signal map."),
        gate("onboarding_verified_for_signal_map", "project_readiness", "The current onboarding receipt is verified for that signal map.", "Follow onboarding next_action until the exact plan is verified."),
        gate("ordered_funnel_blueprint_available", "project_readiness", "The bounded ordered-funnel comparison is available.", "Upgrade Agentry until the exact aggregate blueprint is available."),
        ...parsed.events.flatMap((event) => [
          gate(`event_approved:${event}`, "project_readiness", `${event} is approved in the signal map.`, "Choose an approved event or update and re-verify the signal map."),
          gate(`event_observed:${event}`, "project_readiness", `${event} was observed in current onboarding proof.`, "Exercise the real event in a fresh proof before enabling this workflow."),
        ]),
      ];
    },
  ),
  manifest(
    base({
      id: "agent.code-fix",
      kind: "agent_task",
      title: "Bounded code-fix task",
      description: "Let the exact runner diagnose case evidence and prepare a bounded tested proposal.",
      input_ports: {
        evidence: { contract: "claimed_case_evidence@1", required: true, description: "Bounded evidence for the exact actively claimed case revision." },
      },
      output_contract: "code_fix_proposal@1",
      output_value_paths: [{ path: ["proposal_hash"], type: "string" }],
      config_contract: fields({
        allowed_paths: { type: "string_array", required: true, min_items: 1, max_items: 100, item_format: "repository_relative_glob", item_min_length: 1, item_max_length: 500, description: "Exact repository path globs the task may change." },
        test_commands: { type: "string_array", required: true, min_items: 1, max_items: 30, item_format: "command_without_control_characters", item_min_length: 1, item_max_length: 500, description: "Exact test commands the runner must execute." },
        max_files_changed: { type: "integer", required: true, minimum: 1, maximum: 100, description: "Maximum changed files." },
        max_changed_lines: { type: "integer", required: true, minimum: 1, maximum: 10_000, description: "Maximum added plus deleted lines." },
      }),
      principal_roles: roles("automation_runner"),
      requirement_templates: [
        requirementTemplate("repository_draft_pr_access_confirmed", "caller_assertion", "The runner has bounded draft-PR repository access."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "workflow_policy",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect(
        "customer_runner_workspace",
        "Bounded local checkout edits and tests; no provider effect.",
        ["merge", "deploy", "direct_push", "workflow_edit", "secret_change", "dependency_change", "database_migration", "infrastructure_change", "authentication_change", "billing_change", "permission_change"],
        CODE_FIX_WORKSPACE_POLICY,
      ),
      lineage: lineage(["exact_claimed_case_evidence_snapshot"]),
    }),
    codeFixTaskConfig,
    () => [
      gate("repository_draft_pr_access_confirmed", "caller_assertion", "The runner has bounded draft-PR repository access.", "Configure least-privilege repository access and confirm it before enablement."),
    ],
  ),
  manifest(
    base({
      id: "agent.funnel-review",
      kind: "agent_task",
      title: "Funnel review task",
      description: "Interpret one immutable aggregate source as typed evidence and bounded hypotheses.",
      input_ports: {
        source: { contract: "ordered_funnel_source@1", required: true, description: "Immutable ordered-funnel aggregate source." },
      },
      output_contract: "funnel_review_report@1",
      output_value_paths: [{ path: ["source_hash"], type: "string" }],
      config_contract: fields({}),
      principal_roles: roles("automation_runner"),
      requirement_templates: [],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "none",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("none", "Reasoning output only.", ["causal_claim", "code_change", "publish", "send"]),
      lineage: lineage(["immutable_aggregate_source_hash_preserved"]),
    }),
    emptyConfig,
  ),
  manifest(
    base({
      id: "effect.github.draft-pr",
      kind: "effect",
      title: "Draft pull request",
      description: "Authorize and record one bounded draft PR from an exact approved proposal.",
      input_ports: {
        proposal: { contract: "code_fix_proposal@1", required: true, description: "Exact bounded code-fix proposal authorized by the approval subject." },
      },
      output_contract: "draft_pr_receipt@1",
      output_value_paths: [
        { path: ["pr_url"], type: "string" },
        { path: ["head_sha"], type: "string" },
      ],
      config_contract: fields({}),
      principal_roles: roles("automation_runner", { approver: "human_project_owner" }),
      requirement_templates: [
        requirementTemplate("draft_pr_approval", "approval", "Every draft PR uses one exact unexpired owner approval."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "one_time_grant",
        approval_floor: "per_run",
        approval_subject_port: "proposal",
      },
      side_effect: sideEffect(
        "external_provider",
        "Create one draft PR after exact authorization.",
        ["merge", "deploy", "rollback", "direct_push", "workflow_edit"],
        null,
        EXTERNAL_PROVIDER_MUTATION_PROTOCOL,
      ),
      lineage: lineage(["exact_unexpired_approval_grant_for_proposal"]),
    }),
    emptyConfig,
    () => [
      gate("draft_pr_approval", "approval", "Every draft PR uses one exact unexpired owner approval.", "Bind the effect to an upstream approval node over the exact proposal subject."),
    ],
  ),
  manifest(
    base({
      id: "effect.report.private",
      kind: "effect",
      title: "Private report",
      description: "Record one source-bound private typed report without publication or sending.",
      input_ports: {
        source: { contract: "ordered_funnel_source@1", required: true, description: "Immutable aggregate source whose identity and period must be preserved." },
        report: { contract: "funnel_review_report@1", required: true, description: "Typed runner-authored report bound to the source hash." },
      },
      output_contract: "private_report_receipt@1",
      output_value_paths: [{ path: ["report_id"], type: "string" }],
      config_contract: fields({}),
      principal_roles: roles("agentry_system", { callers: ["automation_runner"] }),
      requirement_templates: [],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "workflow_policy",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("agentry_record", "Persist one private typed report.", ["publish", "send", "code_change"]),
      lineage: lineage(["report_source_hash_and_period_match_immutable_query_source"]),
    }),
    emptyConfig,
  ),
  manifest(
    base({
      id: "wait.deploy.observed",
      kind: "wait",
      title: "Trusted deploy observed",
      description: "Suspend until trusted CI records the exact draft-PR commit deploy or the deadline expires.",
      input_ports: {
        draft_pr: { contract: "draft_pr_receipt@1", required: true, description: "Exact draft PR and head commit to observe through trusted CI." },
      },
      output_contract: "trusted_deploy_receipt@1",
      output_value_paths: [{ path: ["deploy_sha"], type: "string" }],
      config_contract: fields({
        timeout_seconds: { type: "integer", required: true, minimum: 60, maximum: 2_592_000, description: "Maximum wait for trusted provider proof and deploy binding." },
      }),
      principal_roles: roles("agentry_system", {
        callers: ["automation_runner"],
        evidence_sources: ["trusted_ci"],
      }),
      requirement_templates: [
        requirementTemplate("ci_credential_active", "credential", "A CI proof/deploy credential is active."),
        requirementTemplate("ci_proof_callback_configured", "caller_assertion", "CI records provider-observed PR proof."),
        requirementTemplate("deploy_ingest_configured", "caller_assertion", "The provider records the successful exact deploy."),
        requirementTemplate("trusted_ci_pr_and_deploy_proof", "proof", "Trusted CI must record the exact PR proof and successful deploy."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "none",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("none", "Durable suspension only.", ["runner_attested_deploy"]),
      lineage: lineage(["deploy_commit_matches_draft_pr_head_commit"]),
      timing: { mode: "durable_wait", max_wait_seconds_config_field: "timeout_seconds" },
    }),
    deployWaitConfig,
    () => [
      gate("ci_credential_active", "credential", "An active AGENTRY_CI_API_KEY exists.", "Create and install the CI credential only in trusted CI/provider automation."),
      gate("ci_proof_callback_configured", "caller_assertion", "CI records provider-observed PR proof.", "Wire the trusted CI proof callback before enablement."),
      gate("deploy_ingest_configured", "caller_assertion", "The provider records the exact successful deploy.", "Wire provider-only deploy ingest before enablement."),
      gate("trusted_ci_pr_and_deploy_proof", "proof", "Trusted CI records the exact PR proof and successful deploy.", "Configure CI/provider proof before enabling the workflow."),
    ],
  ),
  manifest(
    base({
      id: "verify.cases.no-recurrence-after-deploy",
      kind: "verify",
      title: "Traffic-backed case non-recurrence",
      description: "Require approved deploy traffic, then verify that the exact case revision did not recur.",
      input_ports: {
        case_receipt: { contract: "case_trigger_receipt@1", required: true, description: "Original case id and revision for recurrence comparison." },
        deploy: { contract: "trusted_deploy_receipt@1", required: true, description: "Trusted deploy for the exact approved draft PR commit." },
      },
      output_contract: "case_recurrence_verification@1",
      output_value_paths: [{ path: ["passed"], type: "boolean" }],
      config_contract: fields({
        traffic_sample_event: { type: "string", required: true, format: "approved_event_name", description: "Exact approved event used to prove real deploy traffic." },
        observation_window_seconds: { type: "integer", required: true, minimum: 60, maximum: 2_592_000, description: "Minimum observation window." },
        max_wait_seconds: { type: "integer", required: true, minimum: 60, maximum: 2_592_000, description: "Maximum wait; must cover the observation window." },
        min_sample_size: { type: "integer", required: true, minimum: 1, maximum: 10_000_000, description: "Minimum approved traffic samples." },
      }, [{ kind: "field_gte", field: "max_wait_seconds", other_field: "observation_window_seconds" }]),
      principal_roles: roles("agentry_system", {
        callers: ["automation_runner"],
        evidence_sources: ["agentry_system", "trusted_ci"],
      }),
      requirement_templates: [
        requirementTemplate("recurrence_blueprint_available", "project_readiness", "The exact recurrence blueprint is available."),
        requirementTemplate("traffic_sample_blueprint_available", "project_readiness", "The exact deploy traffic sample blueprint is available."),
        requirementTemplate("event_approved:{traffic_sample_event}", "project_readiness", "The traffic event is approved."),
        requirementTemplate("event_observed:{traffic_sample_event}", "project_readiness", "The traffic event was observed in current proof."),
      ],
      authority: {
        telemetry_instruction_authority: "none",
        owner_goal_grants_authority: false,
        effect_authority: "workflow_policy",
        approval_floor: "none",
        approval_subject_port: null,
      },
      side_effect: sideEffect("agentry_record", "Persist one server-evaluated verification result.", ["runner_supplied_result", "zero_traffic_success"]),
      lineage: lineage(["case_revision_and_deploy_are_from_same_workflow_run", "approved_traffic_observed_after_exact_deploy"]),
      timing: { mode: "durable_wait", max_wait_seconds_config_field: "max_wait_seconds" },
    }),
    recurrenceVerificationConfig,
    (config) => {
      const parsed = recurrenceVerificationConfig.parse(config);
      return [
        gate("recurrence_blueprint_available", "project_readiness", "The exact recurrence blueprint is available.", "Upgrade Agentry until the canonical recurrence verifier is available."),
        gate("traffic_sample_blueprint_available", "project_readiness", "The exact deploy traffic sample blueprint is available.", "Upgrade Agentry until the canonical traffic verifier is available."),
        gate(`event_approved:${parsed.traffic_sample_event}`, "project_readiness", `${parsed.traffic_sample_event} is approved in the signal map.`, "Choose an approved event or update and re-verify the signal map."),
        gate(`event_observed:${parsed.traffic_sample_event}`, "project_readiness", `${parsed.traffic_sample_event} was observed in current proof.`, "Exercise the real event in a fresh proof before enabling the workflow."),
      ];
    },
  ),
]);

function gate(
  id: string,
  kind: AutomationWorkflowRequirement["kind"],
  requirement: string,
  nextAction: string,
): AutomationWorkflowRequirement {
  return { id, kind, requirement, next_action: nextAction };
}

export function automationWorkflowComponentKey(ref: { id: string; version: string }): string {
  return `${ref.id}@${ref.version}`;
}

export function listAutomationWorkflowComponents(): readonly AutomationWorkflowComponentManifest[] {
  return COMPONENTS;
}

export function getAutomationWorkflowComponent(
  ref: { id: string; version: string },
): AutomationWorkflowComponentManifest | null {
  const key = automationWorkflowComponentKey(ref);
  return COMPONENTS.find((component) =>
    automationWorkflowComponentKey(component.serializable) === key
  ) ?? null;
}

export async function serializeAutomationWorkflowComponent(
  component: AutomationWorkflowComponentManifest,
) {
  const inputContracts = Object.fromEntries(await Promise.all(
    Object.entries(component.serializable.input_ports).map(async ([port, definition]) => {
      const contract = getAutomationWorkflowDataContract(definition.contract);
      if (!contract) throw new Error(
        `component ${component.serializable.id} references unknown input contract ${definition.contract}`,
      );
      const serialized = await serializeAutomationWorkflowDataContract(contract);
      return [port, {
        ...definition,
        schema_hash: serialized.schema_hash,
        minimum_assurance: serialized.minimum_assurance,
      }] as const;
    }),
  ));
  const outputContract = getAutomationWorkflowDataContract(component.serializable.output_contract);
  if (!outputContract) throw new Error(
    `component ${component.serializable.id} references unknown output contract ${component.serializable.output_contract}`,
  );
  const serializedOutput = await serializeAutomationWorkflowDataContract(outputContract);
  const contractBoundComponent = {
    ...component.serializable,
    input_ports: inputContracts,
    output_contract_schema_hash: serializedOutput.schema_hash,
    output_minimum_assurance: serializedOutput.minimum_assurance,
  };
  return {
    ...contractBoundComponent,
    component_hash: await sha256Hex(canonicalJsonStringify(contractBoundComponent)),
  };
}

export async function serializeAutomationWorkflowComponentCatalog() {
  const components = await Promise.all(COMPONENTS.map(serializeAutomationWorkflowComponent));
  return {
    kind: "automation_workflow_component_catalog" as const,
    version_policy: "immutable_semver" as const,
    count: components.length,
    components,
  };
}
