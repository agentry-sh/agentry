import { z } from "zod";
import { isValidCronExpression, isValidTimeZone } from "./cron.js";

const httpsUrl = (max: number) => z.string().url().max(max).refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  },
  "must be an absolute HTTPS URL without embedded credentials",
);

/**
 * Automation contracts are durable policy, not prompts. Keep every field that
 * grants authority structured and machine-checkable. Free text is descriptive
 * only and must never expand the actions granted by this schema.
 */
export const AUTOMATION_CONTRACT_SCHEMA_VERSION = "2" as const;

export const AutomationTrustLevelSchema = z.enum([
  "customer_posthog",
  "trusted_ci",
  "agentry_system",
]);

export const AutomationRunStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "draft_pr_opened",
  "awaiting_approval",
  "verifying",
  "succeeded",
  "failed",
  "escalated",
  "cancelled",
]);

export const AutomationAllowedActionSchema = z.enum([
  "draft_pr",
  "escalate",
  "record_report",
]);

const AutomationRunnerSchema = z.object({
  provider: z.enum(["codex", "claude_code", "github_actions", "custom"]),
  // Checkout identity is required only for code-changing automations. A
  // scheduled aggregate report must not need repository access merely to
  // satisfy the shared runner shape.
  repository: httpsUrl(500).optional(),
  default_branch: z.string().min(1).max(200).optional(),
  environment: z.string().min(1).max(100).optional(),
  // v2 deliberately has no merge or deploy mode. The runner may only prepare
  // reviewable work; GitHub/CI and the human retain merge authority.
  mode: z.literal("draft_only").default("draft_only"),
}).strict();

const AutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("alert"),
    alert_id: z.string().min(1).max(200),
    cooldown_seconds: z.number().int().min(60).max(604_800).default(3_600),
    min_consecutive_breaches: z.number().int().min(1).max(100).default(1),
    required_trust: z.literal("server_evaluated").default("server_evaluated"),
  }).strict(),
  z.object({
    kind: z.literal("unhandled_cases"),
    max_cases_per_sweep: z.number().int().min(1).max(100).default(10),
    cooldown_seconds: z.number().int().min(60).max(604_800).default(3_600),
    required_trust: z
      .enum(["any", "customer_posthog"])
      .default("customer_posthog"),
  }).strict(),
  z.object({
    kind: z.literal("schedule"),
    cron: z.string().min(5).max(200),
    timezone: z.string().min(1).max(100).default("UTC"),
    report_kind: z.enum(["funnel_review", "reliability_review", "custom"]),
    start_window_seconds: z.number().int().min(60).max(86_400).default(900),
  }).strict(),
]);

const AutomationReportPlanParamSchema = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.object({
    source: z.literal("schedule"),
    field: z.enum([
      "scheduled_for",
      "period_start",
      "period_end",
      "previous_period_start",
      "previous_period_end",
    ]),
  }).strict(),
]);

const AutomationReportPlanParamsSchema = z
  .record(AutomationReportPlanParamSchema)
  .superRefine((params, ctx) => {
    if (Object.keys(params).length > 50) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "report_plan.params supports at most 50 entries",
      });
    }
  });

/**
 * A report plan is executable server policy, not a runner-selected query.
 * Literal params are frozen into the run policy snapshot. Schedule bindings
 * are resolved only from the consumed server receipt; the runner never gets a
 * generic analytics/HogQL capability.
 */
export const AutomationReportPlanSchema = z.object({
  schema_version: z.literal("1").default("1"),
  blueprint_id: z.string().min(1).max(200),
  params: AutomationReportPlanParamsSchema.default({}),
  period: z.object({
    lookback_seconds: z.number().int().min(60).max(31_622_400),
    offset_seconds: z.number().int().min(0).max(31_622_400).default(0),
  }).strict(),
  output_schema_version: z.literal("1").default("1"),
}).strict();

const AutomationScopeSchema = z.object({
  allowed_paths: z.array(z.string().min(1).max(500)).max(100).default([]),
  forbidden_paths: z.array(z.string().min(1).max(500)).max(100).default([
    ".env*",
    "**/secrets/**",
    "**/credentials*",
    ".github/workflows/**",
  ]),
  forbidden_change_types: z.array(
    z.enum([
      "dependencies",
      "database_migrations",
      "infrastructure",
      "authentication",
      "billing",
      "permissions",
    ]),
  ).max(20).default([
    "dependencies",
    "database_migrations",
    "infrastructure",
    "authentication",
    "billing",
    "permissions",
  ]),
  // Zero is a real no-write capacity for report-only automations. Draft-PR
  // policies are required to opt into positive limits below.
  max_files_changed: z.number().int().min(0).max(100).default(10),
  max_changed_lines: z.number().int().min(0).max(10_000).default(400),
  test_commands: z.array(z.string().min(1).max(500)).max(30).default([]),
}).strict();

const AutomationBudgetsSchema = z.object({
  max_runs_per_day: z.number().int().min(1).max(1_000).default(10),
  max_prs_per_day: z.number().int().min(0).max(100).default(2),
  max_attempts_per_case_revision: z.number().int().min(1).max(20).default(2),
  max_turns_per_run: z.number().int().min(1).max(500).default(30),
  max_runtime_seconds: z.number().int().min(60).max(86_400).default(1_800),
  max_cost_usd_per_run: z.number().min(0).max(10_000).optional(),
}).strict();

const AutomationApprovalsSchema = z.object({
  required_for: z.array(z.literal("draft_pr")).max(10).default([]),
  expires_after_seconds: z.number().int().min(300).max(2_592_000).default(86_400),
}).strict();

const runVerificationParam = <T extends string>(field: T) => z.object({
  source: z.literal("run"),
  field: z.literal(field),
}).strict();

/**
 * Draft-PR verification is intentionally one canonical proof pair. The
 * outcome checks recurrence of the exact claimed case after the exact trusted
 * deploy. The independent sample query proves that approved real traffic was
 * observed for that deploy. Owners can tune time/sample limits and choose the
 * approved traffic event, but cannot swap either proof primitive.
 */
const AutomationVerificationSchema = z.object({
  outcome: z.object({
    blueprint_id: z.literal("automation_case_recurrence_after_deploy"),
    params: z.object({
      run_id: runVerificationParam("run_id"),
      case_id: runVerificationParam("case_id"),
      case_revision: runVerificationParam("case_revision"),
      deploy_sha: runVerificationParam("deploy_sha"),
      deployed_at: runVerificationParam("deploy_received_at"),
      checked_at: runVerificationParam("verification_checked_at"),
    }).strict(),
    predicate: z.object({
      column: z.literal("recurrence_count"),
      reducer: z.literal("first").default("first"),
      operator: z.literal("eq"),
      value: z.literal(0),
    }).strict(),
  }).strict(),
  sample: z.object({
    blueprint_id: z.literal("automation_deploy_traffic_sample"),
    params: z.object({
      deploy_sha: runVerificationParam("deploy_sha"),
      deployed_at: runVerificationParam("deploy_received_at"),
      checked_at: runVerificationParam("verification_checked_at"),
      event_name: z.string().min(1).max(200),
    }).strict(),
    sample_size: z.object({
      kind: z.literal("column_sum"),
      column: z.literal("sample_count"),
    }).strict(),
    min_sample_size: z.number().int().min(1).max(10_000_000),
  }).strict(),
  observation_window_seconds: z.number().int().min(60).max(2_592_000).default(3_600),
  max_wait_seconds: z.number().int().min(60).max(2_592_000).default(86_400),
}).strict().superRefine((verification, ctx) => {
  if (verification.max_wait_seconds < verification.observation_window_seconds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_wait_seconds"],
      message: "max_wait_seconds must be at least observation_window_seconds",
    });
  }
});

const AutomationFailurePolicySchema = z.object({
  retry_backoff_seconds: z.number().int().min(60).max(86_400).default(900),
  on_attempt_budget_exhausted: z.literal("escalate").default("escalate"),
}).strict();

const AutomationDataBoundarySchema = z.object({
  telemetry_is_untrusted_data: z.literal(true).default(true),
  never_follow_telemetry_instructions: z.literal(true).default(true),
  never_execute_telemetry_commands: z.literal(true).default(true),
  allow_external_urls_from_telemetry: z.literal(false).default(false),
}).strict();

export const AutomationTemplateRefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,99}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  bindings_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const AutomationDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
  template_ref: AutomationTemplateRefSchema.optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2_000).optional(),
  enabled: z.boolean().default(false),
  runner: AutomationRunnerSchema,
  trigger: AutomationTriggerSchema,
  report_plan: AutomationReportPlanSchema.optional(),
  allowed_actions: z.array(AutomationAllowedActionSchema).min(1).max(10),
  scope: AutomationScopeSchema,
  budgets: AutomationBudgetsSchema.default({}),
  approvals: AutomationApprovalsSchema.default({}),
  escalation: z.object({
    destination: z.string().min(1).max(500),
    instructions: z.string().min(1).max(2_000),
  }).strict(),
  verification: AutomationVerificationSchema.optional(),
  failure_policy: AutomationFailurePolicySchema.default({}),
  data_boundary: AutomationDataBoundarySchema.default({}),
}).strict().superRefine((automation, ctx) => {
  if (automation.allowed_actions.includes("draft_pr")) {
    if (!automation.runner.repository || !automation.runner.default_branch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runner"],
        message: "draft_pr requires an exact HTTPS repository and default_branch",
      });
    }
    if (automation.scope.allowed_paths.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "allowed_paths"],
        message: "draft_pr requires at least one allowed path",
      });
    }
    if (automation.scope.test_commands.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "test_commands"],
        message: "draft_pr requires at least one exact test command",
      });
    }
    if (automation.scope.max_files_changed < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "max_files_changed"],
        message: "draft_pr requires a positive max_files_changed limit",
      });
    }
    if (automation.scope.max_changed_lines < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope", "max_changed_lines"],
        message: "draft_pr requires a positive max_changed_lines limit",
      });
    }
    if (automation.trigger.kind !== "unhandled_cases") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "kind"],
        message: "draft_pr automations must use an unhandled_cases trigger",
      });
    } else if (automation.trigger.required_trust !== "customer_posthog") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "required_trust"],
        message: "draft_pr automations require customer_posthog case provenance",
      });
    }
  }
  for (const action of automation.approvals.required_for) {
    if (!automation.allowed_actions.includes(action)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approvals", "required_for"],
        message: `${action} cannot require approval unless it is also in allowed_actions`,
      });
    }
  }
  const draftsPr = automation.allowed_actions.includes("draft_pr");
  if (draftsPr && !automation.verification) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verification"],
      message: "the canonical outcome-plus-traffic verification is required for draft_pr",
    });
  }
  if (!draftsPr && automation.verification) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verification"],
      message: "post-deploy verification is supported only by draft_pr automations",
    });
  }
  if (
    automation.trigger.kind === "schedule" &&
    !automation.allowed_actions.includes("record_report")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_actions"],
      message: "every scheduled report must allow record_report",
    });
  }
  if (
    automation.allowed_actions.includes("record_report") &&
    automation.trigger.kind !== "schedule"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_actions"],
      message: "record_report is supported only by a schedule trigger",
    });
  }
  if (automation.trigger.kind === "schedule") {
    if (!automation.report_plan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["report_plan"],
        message: "schedule automations require an immutable report_plan",
      });
    }
    if (!isValidCronExpression(automation.trigger.cron)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "cron"],
        message: "cron must be a valid conservative five-field expression",
      });
    }
    if (!isValidTimeZone(automation.trigger.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["trigger", "timezone"],
        message: "timezone must be a valid IANA time zone",
      });
    }
  } else if (automation.report_plan) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["report_plan"],
      message: "report_plan is supported only by a schedule trigger",
    });
  }
});

export const AutomationContractSchema = z.object({
  schema_version: z.literal(AUTOMATION_CONTRACT_SCHEMA_VERSION).default(
    AUTOMATION_CONTRACT_SCHEMA_VERSION,
  ),
  revision: z.number().int().min(1).default(1),
  enabled: z.boolean().default(false),
  summary: z.string().min(1).max(2_000),
  automations: z.array(AutomationDefinitionSchema).min(1).max(50),
  notes: z.array(z.string().max(2_000)).max(20).default([]),
}).strict().superRefine((contract, ctx) => {
  const seen = new Set<string>();
  contract.automations.forEach((automation, index) => {
    if (seen.has(automation.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["automations", index, "id"],
        message: `duplicate automation id: ${automation.id}`,
      });
    }
    seen.add(automation.id);
  });
});

const AutomationVerificationWindowSchema = z.object({
  start_at: z.number().int().nonnegative(),
  end_at: z.number().int().nonnegative(),
  bounds: z.literal("[start,end)"),
}).strict();

const AutomationVerificationSampleResultSchema = z.object({
  state: z.enum(["sufficient", "insufficient"]),
  blueprint_id: z.literal("automation_deploy_traffic_sample"),
  event_name: z.string().min(1).max(200),
  sample_count: z.number().int().nonnegative(),
  min_sample_size: z.number().int().positive(),
  rows: z.array(z.record(z.unknown())).max(1),
  window: AutomationVerificationWindowSchema,
  input_readiness: z.record(z.unknown()).nullable(),
  data_boundary: z.record(z.unknown()),
}).strict();

const AutomationVerificationOutcomeResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("not_executed"),
    blueprint_id: z.literal("automation_case_recurrence_after_deploy"),
    reason: z.literal("sample_gate_not_met"),
    rows: z.array(z.record(z.unknown())).max(0),
    window: AutomationVerificationWindowSchema,
    data_boundary: z.record(z.unknown()),
  }).strict(),
  z.object({
    state: z.literal("evaluated"),
    blueprint_id: z.literal("automation_case_recurrence_after_deploy"),
    recurrence_count: z.number().int().nonnegative(),
    predicate: z.object({
      column: z.literal("recurrence_count"),
      reducer: z.literal("first"),
      operator: z.literal("eq"),
      value: z.literal(0),
    }).strict(),
    passed: z.boolean(),
    rows: z.array(z.record(z.unknown())).max(1),
    window: AutomationVerificationWindowSchema,
    data_boundary: z.record(z.unknown()),
  }).strict(),
]);

const AutomationTrustedDeployResultSchema = z.object({
  id: z.string().min(1).max(200),
  sha: z.string().min(1).max(200),
  source_commit_sha: z.string().min(1).max(200).nullable(),
  received_at: z.number().int().nonnegative(),
  credential_id: z.string().min(1).max(200).nullable(),
  credential_kind: z.literal("ci_deploy"),
  trust_level: z.literal("trusted_ci"),
}).strict();

export const AutomationVerificationResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending_sample"),
    checked_at: z.number().int().nonnegative(),
    trusted_deploy: AutomationTrustedDeployResultSchema,
    sample: AutomationVerificationSampleResultSchema,
    outcome: AutomationVerificationOutcomeResultSchema,
    retry_after_seconds: z.number().int().nonnegative(),
    deadline_at: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    state: z.literal("complete"),
    checked_at: z.number().int().nonnegative(),
    trusted_deploy: AutomationTrustedDeployResultSchema,
    sample: AutomationVerificationSampleResultSchema,
    outcome: AutomationVerificationOutcomeResultSchema,
    passed: z.boolean(),
  }).strict(),
]);

export const ClaimCaseRequestSchema = z.object({
  automation_id: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
  trigger_receipt_id: z.string().min(1).max(200),
  claimed_by: z.string().min(1).max(300),
  lease_seconds: z.number().int().min(60).max(3_600).default(900),
}).strict();

export const RenewCaseClaimRequestSchema = z.object({
  lease_seconds: z.number().int().min(60).max(3_600).default(900),
}).strict();

export const ReleaseCaseClaimRequestSchema = z.object({
  reason: z.enum(["completed", "failed", "escalated", "cancelled", "superseded"]),
}).strict();

export const AutomationTestEvidenceSchema = z.object({
  command: z.string().min(1).max(500),
  status: z.enum(["passed", "failed", "skipped"]),
  exit_code: z.number().int().min(-1).max(255).optional(),
  duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
  output_excerpt: z.string().max(4_000).optional(),
}).strict().superRefine((test, ctx) => {
  if (test.status === "passed" && test.exit_code !== undefined && test.exit_code !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exit_code"],
      message: "a passed test must have exit_code 0 when exit_code is provided",
    });
  }
  if (test.status === "failed" && test.exit_code === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["exit_code"],
      message: "a failed test cannot have exit_code 0",
    });
  }
});

export const AutomationRunEvidenceSchema = z.object({
  change_types: z.array(z.enum([
    "application_code",
    "tests",
    "documentation",
    "dependencies",
    "database_migrations",
    "infrastructure",
    "authentication",
    "billing",
    "permissions",
  ])).max(20).default([]),
  changed_files: z.array(z.string().min(1).max(500)).max(200).default([]),
  changed_lines: z.object({
    added: z.number().int().nonnegative().max(100_000),
    deleted: z.number().int().nonnegative().max(100_000),
  }).strict().optional(),
  tests: z.array(AutomationTestEvidenceSchema).max(50).default([]),
  ci: z.object({
    status: z.enum(["pending", "passed", "failed", "cancelled"]),
    url: httpsUrl(1_000).optional(),
  }).strict().optional(),
  artifacts: z.array(z.object({
    kind: z.enum(["log", "diff", "report", "screenshot", "other"]),
    url: httpsUrl(1_000),
    label: z.string().max(300).optional(),
  }).strict()).max(50).default([]),
  report: z.object({
    kind: z.enum(["funnel_review", "reliability_review", "custom"]),
    period_start: z.number().int().nonnegative(),
    period_end: z.number().int().nonnegative(),
    source_hash: z.string().regex(/^[a-f0-9]{64}$/),
    findings: z.array(z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("metric"),
        metric: z.string().regex(/^[a-z][a-z0-9_.-]{0,199}$/),
        unit: z.enum(["count", "percent", "ratio", "seconds", "currency"]),
        prior_value: z.number().finite().nullable(),
        current_value: z.number().finite().nullable(),
        change: z.number().finite().nullable(),
        source_columns: z.array(z.string().min(1).max(200)).min(1).max(20),
      }).strict(),
      z.object({
        kind: z.literal("hypothesis"),
        rank: z.number().int().min(1).max(100),
        title: z.string().min(1).max(300),
        rationale: z.string().min(1).max(2_000),
        expected_impact: z.enum(["low", "medium", "high", "unknown"]),
        confidence: z.enum(["low", "medium", "high"]),
        evidence_columns: z.array(z.string().min(1).max(200)).min(1).max(20),
        suggested_human_next_step: z.string().min(1).max(1_000),
      }).strict(),
      z.object({
        kind: z.literal("readiness_gap"),
        code: z.string().regex(/^[a-z][a-z0-9_.-]{0,199}$/),
        message: z.string().min(1).max(2_000),
        required_signal: z.string().min(1).max(200).optional(),
      }).strict(),
    ])).max(100),
    limitations: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  }).strict().optional(),
}).strict();

export const StartAutomationRunRequestSchema = z.object({
  automation_id: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
  trigger_receipt_id: z.string().min(1).max(200),
  case_id: z.string().min(1).max(200).optional(),
  claim_id: z.string().min(1).max(200).optional(),
  runner: z.object({
    provider: z.enum(["codex", "claude_code", "github_actions", "custom"]),
    id: z.string().min(1).max(300),
    model: z.string().min(1).max(200).optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.case_id) !== Boolean(value.claim_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: value.case_id ? ["claim_id"] : ["case_id"],
      message: "case_id and claim_id must be provided together",
    });
  }
});

export const UpdateAutomationRunRequestSchema = z.object({
  status: z.enum(["running", "failed", "escalated", "cancelled"]),
  summary_md: z.string().max(20_000).optional(),
  evidence: AutomationRunEvidenceSchema.optional(),
  error: z.object({
    code: z.string().min(1).max(200),
    message: z.string().min(1).max(4_000),
  }).optional(),
}).strict();

export const CancelAutomationRunRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export const DraftPrApprovalSubjectSchema = z.object({
  kind: z.literal("draft_pr"),
  branch: z.string().min(1).max(300),
  commit_sha: z.string().regex(/^[a-f0-9]{7,64}$/i),
  change_types: AutomationRunEvidenceSchema.shape.change_types,
  changed_files: AutomationRunEvidenceSchema.shape.changed_files,
  changed_lines: z.object({
    added: z.number().int().nonnegative().max(100_000),
    deleted: z.number().int().nonnegative().max(100_000),
  }),
  tests: AutomationRunEvidenceSchema.shape.tests,
}).strict();

export const IssueAutomationTriggersRequestSchema = z.object({
  automation_id: z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/),
}).strict();

export const AuthorizeDraftPrRequestSchema = z.object({
  subject: DraftPrApprovalSubjectSchema,
}).strict();

export const ConsumeDraftPrGrantRequestSchema = z.object({
  grant_id: z.string().min(1).max(200),
  pr_url: httpsUrl(1_000),
}).strict();

export const RecordAutomationPrProofSchema = z.object({
  vcs_provider: z.enum(["github", "gitlab", "bitbucket"]),
  repository: httpsUrl(500),
  pr_url: httpsUrl(1_000),
  pr_number: z.number().int().positive(),
  draft: z.literal(true),
  head_sha: z.string().regex(/^[a-f0-9]{7,64}$/i),
  head_branch: z.string().min(1).max(300),
  base_branch: z.string().min(1).max(300),
  change_types: AutomationRunEvidenceSchema.shape.change_types,
  changed_files: AutomationRunEvidenceSchema.shape.changed_files,
  changed_lines: z.object({
    added: z.number().int().nonnegative().max(100_000),
    deleted: z.number().int().nonnegative().max(100_000),
  }),
  tests: z.array(AutomationTestEvidenceSchema).max(50),
  ci_url: httpsUrl(1_000).optional(),
}).strict();

export const ReportAutomationUsageSchema = z.object({
  sequence: z.number().int().positive(),
  turns_used: z.number().int().nonnegative().max(1_000_000),
  cost_usd: z.number().nonnegative().max(1_000_000).optional(),
}).strict();

export const RecordAutomationReportSchema = z.object({
  summary_md: z.string().min(1).max(20_000),
  evidence: AutomationRunEvidenceSchema.refine(
    (value) => value.report !== undefined,
    "evidence.report is required",
  ),
}).strict();

export const MaterializeAutomationReportSourceSchema = z.object({
  blueprint_id: z.string().min(1).max(200),
}).strict();

export const AutomationApprovalSubjectSchema = DraftPrApprovalSubjectSchema;

export const RequestAutomationApprovalSchema = z.object({
  action: z.literal("draft_pr"),
  reason: z.string().min(1).max(2_000),
  subject: AutomationApprovalSubjectSchema,
}).strict();

export const DecideAutomationApprovalSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().min(1).max(2_000),
}).strict();

export type AutomationTrustLevel = z.infer<typeof AutomationTrustLevelSchema>;
export type AutomationRunStatus = z.infer<typeof AutomationRunStatusSchema>;
export type AutomationAllowedAction = z.infer<typeof AutomationAllowedActionSchema>;
export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;
export type AutomationReportPlan = z.infer<typeof AutomationReportPlanSchema>;
export type AutomationContract = z.infer<typeof AutomationContractSchema>;
export type AutomationVerificationResult = z.infer<typeof AutomationVerificationResultSchema>;
export type ClaimCaseRequest = z.infer<typeof ClaimCaseRequestSchema>;
export type RenewCaseClaimRequest = z.infer<typeof RenewCaseClaimRequestSchema>;
export type ReleaseCaseClaimRequest = z.infer<typeof ReleaseCaseClaimRequestSchema>;
export type AutomationRunEvidence = z.infer<typeof AutomationRunEvidenceSchema>;
export type AutomationApprovalSubject = z.infer<typeof AutomationApprovalSubjectSchema>;
export type StartAutomationRunRequest = z.infer<typeof StartAutomationRunRequestSchema>;
export type UpdateAutomationRunRequest = z.infer<typeof UpdateAutomationRunRequestSchema>;
export type CancelAutomationRunRequest = z.infer<typeof CancelAutomationRunRequestSchema>;
export type RecordAutomationReport = z.infer<typeof RecordAutomationReportSchema>;
export type MaterializeAutomationReportSource = z.infer<
  typeof MaterializeAutomationReportSourceSchema
>;
export type RecordAutomationPrProof = z.infer<typeof RecordAutomationPrProofSchema>;
export type RequestAutomationApproval = z.infer<typeof RequestAutomationApprovalSchema>;
export type DecideAutomationApproval = z.infer<typeof DecideAutomationApprovalSchema>;
