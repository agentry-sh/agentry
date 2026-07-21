import { describe, expect, it } from "vitest";
import {
  compileAutomationWorkflow,
} from "../src/automation-workflow-compiler.js";
import {
  getAutomationWorkflowComponent,
  serializeAutomationWorkflowComponentCatalog,
} from "../src/automation-workflow-components.js";
import {
  buildErrorToDraftPrWorkflow,
  buildWeeklyFunnelReviewWorkflow,
} from "../src/automation-workflow-presets.js";

function errorBindings() {
  return {
    automation_id: "repair_production_case",
    name: "Repair trusted production case",
    runner: {
      provider: "codex" as const,
      repository_provider: "github" as const,
      repository: "https://github.com/example/app",
      default_branch: "main",
      environment: "production",
    },
    trigger: {
      max_cases_per_sweep: 3,
      cooldown_seconds: 900,
    },
    scope: {
      allowed_paths: ["src/**", "test/**"],
      test_commands: ["npm test"],
      max_files_changed: 5,
      max_changed_lines: 240,
    },
    budgets: {
      max_runs_per_day: 4,
      max_prs_per_day: 1,
      max_attempts_per_case_revision: 2,
      max_turns_per_run: 24,
      max_runtime_seconds: 1_800,
      max_cost_usd_per_run: 5,
    },
    approval_expires_after_seconds: 86_400,
    deploy_wait_timeout_seconds: 43_200,
    traffic_sample_event: "request_completed",
    verification: {
      observation_window_seconds: 3_600,
      max_wait_seconds: 86_400,
      min_sample_size: 50,
    },
    escalation: {
      destination: "project owner",
      instructions: "Preserve evidence, explain the failed gate, and stop.",
    },
  };
}

function weeklyBindings() {
  return {
    automation_id: "weekly_funnel_review",
    name: "Weekly activation funnel review",
    runner: {
      provider: "codex" as const,
      environment: "production",
    },
    schedule: {
      cron: "0 9 * * 1",
      timezone: "Europe/Helsinki",
      start_window_seconds: 900,
    },
    funnel: {
      events: ["account_created", "project_created", "subscription_started", "first_value_reached"],
      period_days: 7,
      minimum_sample_size: 25,
    },
    budgets: {
      max_runs_per_day: 2,
      max_turns_per_run: 24,
      max_runtime_seconds: 1_800,
      max_cost_usd_per_run: 5,
    },
    escalation: {
      destination: "project owner",
      instructions: "Report the missing evidence and stop.",
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("automation workflow v3 compiler", () => {
  it("compiles the current error automation as typed primitives with exact approval", async () => {
    const workflow = buildErrorToDraftPrWorkflow(errorBindings());
    expect(workflow.nodes.map((node) => node.kind)).toEqual([
      "trigger",
      "query",
      "agent_task",
      "approval",
      "effect",
      "wait",
      "verify",
      "terminal",
      "terminal",
    ]);

    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      kind: "automation_workflow_compile",
      schema_version: "3",
      candidate: { enabled: false },
      readiness: { ready_for_owner_review: true, ready_to_enable: false },
      compile_side_effects: {
        database_writes: false,
        workflow_saved: false,
        workflow_enabled: false,
        credential_minted: false,
        scheduler_registered: false,
        provider_action_started: false,
      },
    });
    expect(result.data.principals.required).toEqual(expect.arrayContaining([
      "automation_runner",
      "human_project_owner",
      "trusted_ci",
      "customer_posthog",
    ]));
    expect(result.data.policy.runtime_invariants).toEqual(expect.arrayContaining([
      "active_case_revision_claim_owned_by_runner",
      "case_revision_and_deploy_are_from_same_workflow_run",
      "exact_unexpired_approval_grant_for_proposal",
    ]));
    expect(result.data.policy.forbidden_effects).toEqual(expect.arrayContaining([
      "merge",
      "deploy",
      "direct_push",
      "runner_supplied_result",
    ]));
    const workspace = result.data.policy.declared_side_effects.find((effect) =>
      effect.node_id === "diagnose_fix"
    );
    expect(workspace?.workspace_policy).toMatchObject({
      path_semantics: "repository_relative_glob",
      deny_precedence: true,
      forbidden_paths: expect.arrayContaining([
        ".env*",
        "secrets/**",
        "**/secrets/**",
        "credentials*",
        "**/credentials*",
        ".github/workflows/**",
      ]),
      forbidden_change_types: expect.arrayContaining([
        "dependencies",
        "database_migrations",
        "authentication",
        "permissions",
      ]),
    });
    const draftPr = result.data.policy.declared_side_effects.find((effect) =>
      effect.node_id === "create_draft_pr"
    );
    expect(draftPr?.mutation_protocol).toEqual({
      intent_identity: "compile_hash+component_hash+run_id+node_id+canonical_input_hash+provider_target",
      reservation: "durable_unique_intent_before_provider_call",
      authorization_cardinality: "one_authorized_intent_per_run_node",
      provider_retry_safety: "adapter_specific_idempotency_or_reconciliation_required",
      uncertain_outcome: "indeterminate_until_reconciled",
      retry_policy: "reconcile_existing_intent_before_any_repeat",
      replay_policy: "return_persisted_receipt_without_repeating_provider_effect",
    });
    expect(result.data.policy.time_limits).toEqual({
      max_active_runtime_seconds: 1_800,
      max_elapsed_seconds: 217_800,
    });
    expect(workflow.nodes.find((node) => node.id === "wait_for_deploy")).toMatchObject({
      config: { timeout_seconds: 43_200 },
    });
  });

  it("compiles the current weekly automation and binds the report to its immutable source", async () => {
    const workflow = buildWeeklyFunnelReviewWorkflow(weeklyBindings());
    const effect = workflow.nodes.find((node) => node.id === "record_private_report");
    expect(effect).toMatchObject({
      kind: "effect",
      inputs: {
        source: { node_id: "funnel_source" },
        report: { node_id: "review_funnel" },
      },
    });

    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const reportNode = result.data.resolved_nodes.find((node) =>
      node.node_id === "record_private_report"
    );
    expect(reportNode?.input_ports).toMatchObject({
      source: { contract: "ordered_funnel_source@1", required: true },
      report: { contract: "funnel_review_report@1", required: true },
    });
    expect(result.data.requirements.map((gate) => gate.id)).toEqual(expect.arrayContaining([
      "runner_credential_bound",
      "scheduler_execution_configured",
      "workflow_runtime_adapter_available",
      "ordered_funnel_blueprint_available",
    ]));
  });

  it("produces stable workflow, component, and compile hashes", async () => {
    const workflow = buildWeeklyFunnelReviewWorkflow(weeklyBindings());
    const first = await compileAutomationWorkflow(workflow);
    const second = await compileAutomationWorkflow(clone(workflow));
    expect(first).toEqual(second);
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.workflow_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.data.compile_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.data.resolved_components.every((component) =>
      /^[a-f0-9]{64}$/.test(component.component_hash)
    )).toBe(true);
  });

  it("rejects unknown components, kind mismatches, and invalid component config", async () => {
    const unknown = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    unknown.nodes[0].component.id = "trigger.future.unknown";
    const unknownResult = await compileAutomationWorkflow(unknown);
    expect(unknownResult.success).toBe(false);
    if (!unknownResult.success) {
      expect(unknownResult.issues.map((entry) => entry.code)).toContain("unknown_component");
    }

    const wrongKind = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    wrongKind.nodes[0].component.id = "query.analytics.ordered-funnel-period-compare";
    const wrongKindResult = await compileAutomationWorkflow(wrongKind);
    expect(wrongKindResult.success).toBe(false);
    if (!wrongKindResult.success) {
      expect(wrongKindResult.issues.map((entry) => entry.code)).toContain("component_kind_mismatch");
    }

    const badConfig = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    badConfig.nodes[1].config.period_days = 0;
    const badConfigResult = await compileAutomationWorkflow(badConfig);
    expect(badConfigResult.success).toBe(false);
    if (!badConfigResult.success) {
      expect(badConfigResult.issues).toContainEqual(expect.objectContaining({
        code: "component_config_invalid",
        path: ["nodes", 1, "config", "period_days"],
      }));
    }
  });

  it("rejects incompatible input contracts and unknown condition paths", async () => {
    const badInputs = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    badInputs.nodes[4].inputs.source = { node_id: "scheduled" };
    const badInputsResult = await compileAutomationWorkflow(badInputs);
    expect(badInputsResult.success).toBe(false);
    if (!badInputsResult.success) {
      expect(badInputsResult.issues.map((entry) => entry.code)).toContain(
        "component_input_contract_mismatch",
      );
    }

    const badCondition = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    badCondition.nodes[2].predicate.value.path = ["agent_says_go"];
    const badConditionResult = await compileAutomationWorkflow(badCondition);
    expect(badConditionResult.success).toBe(false);
    if (!badConditionResult.success) {
      expect(badConditionResult.issues.map((entry) => entry.code)).toContain("condition_path_unknown");
    }
  });

  it("rejects a missing approval and every alternate path that bypasses it", async () => {
    const missing = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    delete missing.nodes[4].approval_node_id;
    const missingResult = await compileAutomationWorkflow(missing);
    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "approval_required",
        "approval_unused",
      ]));
    }

    const bypass = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    bypass.nodes[0].on_error = "create_draft_pr";
    const bypassResult = await compileAutomationWorkflow(bypass);
    expect(bypassResult.success).toBe(false);
    if (!bypassResult.success) {
      expect(bypassResult.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "approval_bypass",
        "reference_bypass",
      ]));
    }

    const denied = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    denied.nodes[3].on_rejected = "create_draft_pr";
    const deniedResult = await compileAutomationWorkflow(denied);
    expect(deniedResult.success).toBe(false);
    if (!deniedResult.success) {
      expect(deniedResult.issues.map((entry) => entry.code)).toContain(
        "approval_denial_bypass",
      );
    }
  });

  it("requires every data producer to dominate its consumer", async () => {
    const workflow = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    workflow.nodes[0].on_error = "record_private_report";
    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.filter((entry) => entry.code === "reference_bypass").length).toBeGreaterThanOrEqual(2);
    }
  });

  it("does not expose component outputs on error exits or from built-in control nodes", async () => {
    const afterError = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    afterError.nodes[1].on_error = "review_funnel";
    const afterErrorResult = await compileAutomationWorkflow(afterError);
    expect(afterErrorResult.success).toBe(false);
    if (!afterErrorResult.success) {
      expect(afterErrorResult.issues.map((entry) => entry.code)).toContain(
        "reference_output_unavailable",
      );
    }

    const builtInResult = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    builtInResult.nodes[5].terminal.result = { node_id: "source_ready" };
    const builtInResultCompile = await compileAutomationWorkflow(builtInResult);
    expect(builtInResultCompile.success).toBe(false);
    if (!builtInResultCompile.success) {
      expect(builtInResultCompile.issues.map((entry) => entry.code)).toContain(
        "reference_source_has_no_output",
      );
    }
  });

  it("forbids ad hoc approvals on effects without an approver contract", async () => {
    const workflow = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    workflow.nodes[3].next = "approve_report";
    workflow.nodes.splice(4, 0, {
      id: "approve_report",
      kind: "approval",
      subject: { node_id: "review_funnel" },
      expires_after_seconds: 86_400,
      on_approved: "record_private_report",
      on_rejected: "escalate",
      on_expired: "escalate",
    });
    workflow.nodes[5].approval_node_id = "approve_report";
    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "approval_not_supported",
        "approval_unused",
      ]));
    }
  });

  it("requires an exact repository binding for code-changing components", async () => {
    const workflow = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    delete workflow.runner.repository_provider;
    delete workflow.runner.repository;
    delete workflow.runner.default_branch;
    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((entry) => entry.code)).toContain("runner_repository_required");
    }

    const invalidPath = errorBindings();
    invalidPath.scope.allowed_paths = ["../**"];
    expect(() => buildErrorToDraftPrWorkflow(invalidPath)).toThrow(
      /repository-relative glob/,
    );

    const secretRepository = errorBindings();
    secretRepository.runner.repository = "https://github.com/example/app?token=secret";
    expect(() => buildErrorToDraftPrWorkflow(secretRepository)).toThrow(
      /without credentials, query parameters, fragments/,
    );

    const invalidBranch = errorBindings();
    invalidBranch.runner.default_branch = "--upload-pack=oops";
    expect(() => buildErrorToDraftPrWorkflow(invalidBranch)).toThrow(
      /conservative Git branch ref/,
    );

    const narrowAggregate = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    narrowAggregate.limits.max_files_changed_per_run = 4;
    const narrowAggregateResult = await compileAutomationWorkflow(narrowAggregate);
    expect(narrowAggregateResult.success).toBe(false);
    if (!narrowAggregateResult.success) {
      expect(narrowAggregateResult.issues.map((entry) => entry.code)).toContain(
        "workspace_budget_exceeded",
      );
    }

    const noCostLimit = clone(buildWeeklyFunnelReviewWorkflow(weeklyBindings())) as any;
    delete noCostLimit.limits.max_cost_usd_per_run;
    const noCostLimitResult = await compileAutomationWorkflow(noCostLimit);
    expect(noCostLimitResult.success).toBe(false);
    if (!noCostLimitResult.success) {
      expect(noCostLimitResult.issues.map((entry) => entry.code)).toContain(
        "agent_cost_limit_required",
      );
    }
  });

  it("enforces one aggregate external-effect budget across repeated blocks", async () => {
    const workflow = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    workflow.nodes[4].next = "approve_second_pr";
    workflow.nodes.splice(5, 0, {
      id: "approve_second_pr",
      kind: "approval",
      subject: { node_id: "diagnose_fix" },
      expires_after_seconds: 86_400,
      on_approved: "create_second_pr",
      on_rejected: "escalate",
      on_expired: "escalate",
    });
    workflow.nodes.splice(6, 0, {
      id: "create_second_pr",
      kind: "effect",
      component: { id: "effect.github.draft-pr", version: "1.0.0" },
      config: {},
      inputs: { proposal: { node_id: "diagnose_fix" } },
      approval_node_id: "approve_second_pr",
      next: "wait_for_deploy",
      on_error: "escalate",
    });
    workflow.nodes[7].inputs.draft_pr = { node_id: "create_second_pr" };
    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((entry) => entry.code)).toContain(
        "external_effect_budget_exceeded",
      );
    }
  });

  it("rejects elapsed deadlines shorter than active plus suspended windows", async () => {
    const workflow = clone(buildErrorToDraftPrWorkflow(errorBindings())) as any;
    workflow.limits.max_elapsed_seconds -= 1;
    const result = await compileAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((entry) => entry.code)).toContain(
        "elapsed_budget_exceeded",
      );
    }
  });

  it("publishes immutable component manifests with machine-readable cross-field rules", async () => {
    const catalog = await serializeAutomationWorkflowComponentCatalog();
    expect(catalog).toMatchObject({
      kind: "automation_workflow_component_catalog",
      version_policy: "immutable_semver",
      count: 10,
    });
    const funnel = catalog.components.find((component) =>
      component.id === "query.analytics.ordered-funnel-period-compare"
    );
    expect(funnel?.config_contract.rules).toContainEqual({
      kind: "distinct_items",
      field: "events",
    });
    const verify = catalog.components.find((component) =>
      component.id === "verify.cases.no-recurrence-after-deploy"
    );
    expect(verify?.config_contract.rules).toContainEqual({
      kind: "field_gte",
      field: "max_wait_seconds",
      other_field: "observation_window_seconds",
    });

    const component = getAutomationWorkflowComponent({
      id: "effect.github.draft-pr",
      version: "1.0.0",
    });
    expect(component).not.toBeNull();
    expect(Object.isFrozen(component)).toBe(true);
    expect(Object.isFrozen(component?.serializable)).toBe(true);
    expect(Object.isFrozen(component?.serializable.side_effect.forbidden)).toBe(true);
  });
});
