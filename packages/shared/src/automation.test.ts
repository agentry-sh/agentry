import { describe, expect, it } from "vitest";
import {
  AutomationAllowedActionSchema,
  AutomationDefinitionSchema,
  RequestAutomationApprovalSchema,
} from "./automation.js";

const reportOnlyDefinition = {
  id: "weekly_report",
  name: "Weekly report",
  enabled: false,
  runner: { provider: "codex", mode: "draft_only" },
  trigger: {
    kind: "schedule",
    cron: "0 9 * * 1",
    timezone: "UTC",
    report_kind: "funnel_review",
    start_window_seconds: 900,
  },
  report_plan: {
    schema_version: "1",
    blueprint_id: "ordered_funnel_period_compare",
    params: {},
    period: { lookback_seconds: 604_800, offset_seconds: 0 },
    output_schema_version: "1",
  },
  allowed_actions: ["record_report", "escalate"],
  scope: {
    allowed_paths: [],
    forbidden_paths: ["**"],
    forbidden_change_types: ["dependencies"],
    max_files_changed: 0,
    max_changed_lines: 0,
    test_commands: [],
  },
  budgets: {
    max_runs_per_day: 4,
    max_prs_per_day: 0,
    max_attempts_per_case_revision: 1,
    max_turns_per_run: 24,
    max_runtime_seconds: 1_800,
    max_cost_usd_per_run: 5,
  },
  approvals: { required_for: [], expires_after_seconds: 86_400 },
  escalation: { destination: "project owner", instructions: "Stop and report evidence." },
};

describe("AutomationDefinitionSchema write capacity", () => {
  it("accepts an exact zero-file, zero-line scope for a report-only automation", () => {
    const parsed = AutomationDefinitionSchema.parse(reportOnlyDefinition);
    expect(parsed.scope).toMatchObject({ max_files_changed: 0, max_changed_lines: 0 });
    expect(parsed.budgets.max_prs_per_day).toBe(0);
  });

  it("requires positive file and line limits when draft_pr is authorized", () => {
    const result = AutomationDefinitionSchema.safeParse({
      ...reportOnlyDefinition,
      runner: {
        provider: "codex",
        repository: "https://github.com/example/app",
        default_branch: "main",
        mode: "draft_only",
      },
      trigger: {
        kind: "unhandled_cases",
        max_cases_per_sweep: 1,
        cooldown_seconds: 900,
        required_trust: "customer_posthog",
      },
      report_plan: undefined,
      allowed_actions: ["draft_pr", "escalate"],
      scope: {
        ...reportOnlyDefinition.scope,
        allowed_paths: ["src/**"],
        test_commands: ["npm test"],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      "draft_pr requires a positive max_files_changed limit",
      "draft_pr requires a positive max_changed_lines limit",
    ]));
  });
});

describe("automation authority boundary", () => {
  it("exposes only draft PRs, escalations, and reports as automation actions", () => {
    expect(AutomationAllowedActionSchema.options).toEqual([
      "draft_pr",
      "escalate",
      "record_report",
    ]);
    expect(AutomationAllowedActionSchema.safeParse("suppress_issue").success).toBe(false);
  });

  it("rejects PostHog issue mutation as an approval subject", () => {
    expect(RequestAutomationApprovalSchema.safeParse({
      action: "suppress_issue",
      reason: "Retired mutation authority must not be recoverable through approval.",
      subject: {
        kind: "suppress_issue",
        case_id: "case_123",
        case_revision: 1,
        rationale: "Retired mutation authority.",
      },
    }).success).toBe(false);
  });
});
