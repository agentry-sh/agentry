import { z } from "zod";
import {
  isValidCronExpression,
  isValidTimeZone,
  validateAutomationWorkflow,
  AutomationWorkflowGitBranchSchema,
  AutomationWorkflowRepositoryUrlSchema,
  type AutomationWorkflowDefinition,
} from "@agentrysh/shared";
import {
  AUTOMATION_WORKFLOW_COMPONENT_VERSION,
  AutomationWorkflowCommandTextSchema,
  AutomationWorkflowRepositoryRelativeGlobSchema,
} from "./automation-workflow-components.js";

export const AUTOMATION_WORKFLOW_PRESET_VERSION = "3.0.0" as const;
export const AUTOMATION_WORKFLOW_PRESET_IDS = [
  "error-to-draft-pr",
  "weekly-funnel-review",
] as const;

const automationId = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const eventName = z.string().min(1).max(200).regex(
  /^[^\s\u0000-\u001F\u007F]+$/u,
  "event names cannot contain whitespace or control characters",
);
const runnerProvider = z.enum(["codex", "claude_code", "github_actions", "custom"]);
const codeRunner = z.object({
  provider: runnerProvider,
  repository_provider: z.enum(["github", "gitlab", "bitbucket", "custom"]),
  repository: AutomationWorkflowRepositoryUrlSchema,
  default_branch: AutomationWorkflowGitBranchSchema,
  environment: boundedText(100).optional(),
}).strict();
const reportRunner = z.object({
  provider: runnerProvider,
  environment: boundedText(100).optional(),
}).strict();
const escalation = z.object({
  destination: boundedText(500),
  instructions: boundedText(2_000),
}).strict();

const commonLimits = z.object({
  max_runs_per_day: z.number().int().min(1).max(1_000),
  max_turns_per_run: z.number().int().min(1).max(500),
  max_runtime_seconds: z.number().int().min(60).max(86_400),
  max_cost_usd_per_run: z.number().positive().max(10_000),
}).strict();

export const ErrorToDraftPrWorkflowBindingsSchema = z.object({
  automation_id: automationId,
  name: boundedText(200),
  runner: codeRunner,
  trigger: z.object({
    max_cases_per_sweep: z.number().int().min(1).max(100),
    cooldown_seconds: z.number().int().min(60).max(604_800),
  }).strict(),
  scope: z.object({
    allowed_paths: z.array(AutomationWorkflowRepositoryRelativeGlobSchema).min(1).max(100),
    test_commands: z.array(AutomationWorkflowCommandTextSchema).min(1).max(30),
    max_files_changed: z.number().int().min(1).max(100),
    max_changed_lines: z.number().int().min(1).max(10_000),
  }).strict(),
  budgets: commonLimits.extend({
    max_prs_per_day: z.number().int().min(1).max(100),
    max_attempts_per_case_revision: z.number().int().min(1).max(20),
  }).strict(),
  approval_expires_after_seconds: z.number().int().min(300).max(2_592_000),
  deploy_wait_timeout_seconds: z.number().int().min(60).max(2_592_000),
  traffic_sample_event: eventName,
  verification: z.object({
    observation_window_seconds: z.number().int().min(60).max(2_592_000),
    max_wait_seconds: z.number().int().min(60).max(2_592_000),
    min_sample_size: z.number().int().min(1).max(10_000_000),
  }).strict().refine(
    (value) => value.max_wait_seconds >= value.observation_window_seconds,
    { path: ["max_wait_seconds"], message: "must be at least observation_window_seconds" },
  ),
  escalation,
}).strict();

export const WeeklyFunnelReviewWorkflowBindingsSchema = z.object({
  automation_id: automationId,
  name: boundedText(200),
  runner: reportRunner,
  schedule: z.object({
    cron: boundedText(200).refine(
      isValidCronExpression,
      "must be a valid conservative five-field cron expression",
    ),
    timezone: boundedText(100).refine(
      isValidTimeZone,
      "must be a valid IANA time zone",
    ),
    start_window_seconds: z.number().int().min(60).max(86_400),
  }).strict(),
  funnel: z.object({
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
  }),
  budgets: commonLimits,
  escalation,
}).strict();

export type ErrorToDraftPrWorkflowBindings = z.infer<typeof ErrorToDraftPrWorkflowBindingsSchema>;
export type WeeklyFunnelReviewWorkflowBindings = z.infer<typeof WeeklyFunnelReviewWorkflowBindingsSchema>;

const component = (id: string) => ({
  id,
  version: AUTOMATION_WORKFLOW_COMPONENT_VERSION,
});

function checkedPreset(input: unknown, presetId: string): AutomationWorkflowDefinition {
  const validated = validateAutomationWorkflow(input);
  if (!validated.success) {
    throw new Error(
      `automation workflow preset ${presetId}@${AUTOMATION_WORKFLOW_PRESET_VERSION} is structurally invalid: ${JSON.stringify(validated.issues)}`,
    );
  }
  return validated.data;
}

export function buildErrorToDraftPrWorkflow(
  input: ErrorToDraftPrWorkflowBindings,
): AutomationWorkflowDefinition {
  const bindings = ErrorToDraftPrWorkflowBindingsSchema.parse(input);
  const workflow = {
    schema_version: "3",
    id: bindings.automation_id,
    name: bindings.name,
    description: "Prepare one bounded draft fix for one trusted unhandled case, require exact owner approval, then wait for deploy and traffic-backed recurrence proof.",
    runner: bindings.runner,
    limits: {
      max_runs_per_day: bindings.budgets.max_runs_per_day,
      max_attempts_per_trigger: bindings.budgets.max_attempts_per_case_revision,
      max_turns_per_run: bindings.budgets.max_turns_per_run,
      max_active_runtime_seconds: bindings.budgets.max_runtime_seconds,
      max_elapsed_seconds:
        bindings.budgets.max_runtime_seconds +
        bindings.approval_expires_after_seconds +
        bindings.deploy_wait_timeout_seconds +
        bindings.verification.max_wait_seconds,
      max_cost_usd_per_run: bindings.budgets.max_cost_usd_per_run,
      retry_backoff_seconds: 900,
      max_external_effects_per_run: 1,
      max_external_effects_per_day: bindings.budgets.max_prs_per_day,
      max_files_changed_per_run: bindings.scope.max_files_changed,
      max_changed_lines_per_run: bindings.scope.max_changed_lines,
    },
    entry: "case_trigger",
    nodes: [
      {
        id: "case_trigger",
        kind: "trigger",
        component: component("trigger.cases.unhandled"),
        config: {
          max_cases_per_sweep: bindings.trigger.max_cases_per_sweep,
          cooldown_seconds: bindings.trigger.cooldown_seconds,
          required_trust: "customer_posthog",
        },
        next: "case_evidence",
        on_error: "escalate",
      },
      {
        id: "case_evidence",
        kind: "query",
        component: component("query.cases.claimed-evidence"),
        config: {},
        inputs: { case_receipt: { node_id: "case_trigger" } },
        next: "diagnose_fix",
        on_error: "escalate",
      },
      {
        id: "diagnose_fix",
        kind: "agent_task",
        component: component("agent.code-fix"),
        config: bindings.scope,
        inputs: { evidence: { node_id: "case_evidence" } },
        next: "approve_draft_pr",
        on_error: "escalate",
      },
      {
        id: "approve_draft_pr",
        kind: "approval",
        subject: { node_id: "diagnose_fix" },
        expires_after_seconds: bindings.approval_expires_after_seconds,
        on_approved: "create_draft_pr",
        on_rejected: "escalate",
        on_expired: "escalate",
      },
      {
        id: "create_draft_pr",
        kind: "effect",
        component: component("effect.github.draft-pr"),
        config: {},
        inputs: { proposal: { node_id: "diagnose_fix" } },
        approval_node_id: "approve_draft_pr",
        next: "wait_for_deploy",
        on_error: "escalate",
      },
      {
        id: "wait_for_deploy",
        kind: "wait",
        component: component("wait.deploy.observed"),
        config: { timeout_seconds: bindings.deploy_wait_timeout_seconds },
        inputs: { draft_pr: { node_id: "create_draft_pr" } },
        on_ready: "verify_no_recurrence",
        on_timeout: "escalate",
        on_error: "escalate",
      },
      {
        id: "verify_no_recurrence",
        kind: "verify",
        component: component("verify.cases.no-recurrence-after-deploy"),
        config: {
          traffic_sample_event: bindings.traffic_sample_event,
          observation_window_seconds: bindings.verification.observation_window_seconds,
          max_wait_seconds: bindings.verification.max_wait_seconds,
          min_sample_size: bindings.verification.min_sample_size,
        },
        inputs: {
          case_receipt: { node_id: "case_trigger" },
          deploy: { node_id: "wait_for_deploy" },
        },
        on_pass: "complete",
        on_fail: "escalate",
        on_timeout: "escalate",
        on_error: "escalate",
      },
      {
        id: "complete",
        kind: "terminal",
        terminal: {
          outcome: "complete",
          result: { node_id: "verify_no_recurrence" },
        },
      },
      {
        id: "escalate",
        kind: "terminal",
        terminal: {
          outcome: "escalate",
          destination: bindings.escalation.destination,
          instructions: bindings.escalation.instructions,
        },
      },
    ],
  };
  return checkedPreset(workflow, "error-to-draft-pr");
}

export function buildWeeklyFunnelReviewWorkflow(
  input: WeeklyFunnelReviewWorkflowBindings,
): AutomationWorkflowDefinition {
  const bindings = WeeklyFunnelReviewWorkflowBindingsSchema.parse(input);
  const workflow = {
    schema_version: "3",
    id: bindings.automation_id,
    name: bindings.name,
    description: "Compare one approved ordered funnel across adjacent periods and record a private source-bound report of evidence and bounded hypotheses.",
    runner: bindings.runner,
    limits: {
      max_runs_per_day: bindings.budgets.max_runs_per_day,
      max_attempts_per_trigger: 1,
      max_turns_per_run: bindings.budgets.max_turns_per_run,
      max_active_runtime_seconds: bindings.budgets.max_runtime_seconds,
      max_elapsed_seconds: bindings.budgets.max_runtime_seconds,
      max_cost_usd_per_run: bindings.budgets.max_cost_usd_per_run,
      retry_backoff_seconds: 900,
      max_external_effects_per_run: 0,
      max_external_effects_per_day: 0,
      max_files_changed_per_run: 0,
      max_changed_lines_per_run: 0,
    },
    entry: "scheduled",
    nodes: [
      {
        id: "scheduled",
        kind: "trigger",
        component: component("trigger.schedule.cron"),
        config: bindings.schedule,
        next: "funnel_source",
        on_error: "escalate",
      },
      {
        id: "funnel_source",
        kind: "query",
        component: component("query.analytics.ordered-funnel-period-compare"),
        config: bindings.funnel,
        inputs: { schedule: { node_id: "scheduled" } },
        next: "source_ready",
        on_error: "escalate",
      },
      {
        id: "source_ready",
        kind: "condition",
        predicate: {
          value: { node_id: "funnel_source", path: ["readiness", "status"] },
          operator: "eq",
          expected: "ready",
        },
        on_true: "review_funnel",
        on_false: "escalate",
        on_error: "escalate",
      },
      {
        id: "review_funnel",
        kind: "agent_task",
        component: component("agent.funnel-review"),
        config: {},
        inputs: { source: { node_id: "funnel_source" } },
        next: "record_private_report",
        on_error: "escalate",
      },
      {
        id: "record_private_report",
        kind: "effect",
        component: component("effect.report.private"),
        config: {},
        inputs: {
          source: { node_id: "funnel_source" },
          report: { node_id: "review_funnel" },
        },
        next: "complete",
        on_error: "escalate",
      },
      {
        id: "complete",
        kind: "terminal",
        terminal: {
          outcome: "complete",
          result: { node_id: "record_private_report" },
        },
      },
      {
        id: "escalate",
        kind: "terminal",
        terminal: {
          outcome: "escalate",
          destination: bindings.escalation.destination,
          instructions: bindings.escalation.instructions,
        },
      },
    ],
  };
  return checkedPreset(workflow, "weekly-funnel-review");
}
