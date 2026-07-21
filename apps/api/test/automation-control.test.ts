import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  AutomationContractSchema,
  uuidv7,
  type AutomationContract,
} from "@agentrysh/shared";
import {
  automationApprovals,
  automationBudgetCharges,
  automationContracts,
  automationRuns,
  projectMemberships,
} from "@agentry/db/schema";
import {
  createTestProjectCredential,
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) => getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");
const { automationContractEtag } = await import("../src/automation-contracts.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true, fileDb: true });
  app = createApp();
});

afterEach(() => disposeTestEnv(env));

async function call(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  }), env);
}

async function login(email: string) {
  const response = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { api_key: string; user_id: string };
}

async function setupProject() {
  const owner = await login(`control-owner-${Math.random()}@example.com`);
  const response = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": `automation-control-project-${crypto.randomUUID()}`,
    },
    json: {
      name: "automation-control",
      repo_url: "https://github.com/example/control-app",
      default_branch: "main",
    },
  });
  expect(response.status).toBe(200);
  const project = (await response.json()) as { id: string };
  return { owner, project };
}

function contractDocument(): AutomationContract {
  return AutomationContractSchema.parse({
    schema_version: "2",
    revision: 1,
    enabled: true,
    summary: "Bounded automation control test.",
    automations: [
      {
        id: "auto_fix",
        name: "Auto-fix",
        enabled: true,
        runner: {
          provider: "codex",
          repository: "https://github.com/example/control-app",
          default_branch: "main",
          mode: "draft_only",
        },
        trigger: {
          kind: "unhandled_cases",
          max_cases_per_sweep: 5,
          cooldown_seconds: 300,
          required_trust: "customer_posthog",
        },
        allowed_actions: ["draft_pr", "escalate"],
        scope: {
          allowed_paths: ["src/**", "test/**"],
          test_commands: ["npm test"],
          max_files_changed: 5,
          max_changed_lines: 200,
        },
        budgets: {
          max_runs_per_day: 2,
          max_prs_per_day: 1,
          max_attempts_per_case_revision: 2,
          max_turns_per_run: 20,
          max_runtime_seconds: 1_800,
        },
        approvals: { required_for: ["draft_pr"], expires_after_seconds: 86_400 },
        escalation: { destination: "owner", instructions: "Stop and escalate." },
        verification: {
          outcome: {
            blueprint_id: "automation_case_recurrence_after_deploy",
            params: {
              run_id: { source: "run", field: "run_id" },
              case_id: { source: "run", field: "case_id" },
              case_revision: { source: "run", field: "case_revision" },
              deploy_sha: { source: "run", field: "deploy_sha" },
              deployed_at: { source: "run", field: "deploy_received_at" },
              checked_at: { source: "run", field: "verification_checked_at" },
            },
            predicate: { column: "recurrence_count", operator: "eq", value: 0 },
          },
          sample: {
            blueprint_id: "automation_deploy_traffic_sample",
            params: {
              deploy_sha: { source: "run", field: "deploy_sha" },
              deployed_at: { source: "run", field: "deploy_received_at" },
              checked_at: { source: "run", field: "verification_checked_at" },
              event_name: "request_completed",
            },
            sample_size: { kind: "column_sum", column: "sample_count" },
            min_sample_size: 1,
          },
          observation_window_seconds: 3_600,
          max_wait_seconds: 86_400,
        },
      },
      {
        id: "weekly_report",
        name: "Weekly report",
        enabled: false,
        runner: {
          provider: "codex",
          repository: "https://github.com/example/control-app",
          default_branch: "main",
          mode: "draft_only",
        },
        trigger: {
          kind: "schedule",
          cron: "0 9 * * 1",
          timezone: "UTC",
          report_kind: "funnel_review",
          start_window_seconds: 900,
        },
        report_plan: {
          blueprint_id: "ordered_funnel_period_compare",
          params: {
            scheduled_for: { source: "schedule", field: "scheduled_for" },
            period_days: 7,
            funnel_events_json: "[\"account_created\",\"workspace_created\",\"subscription_started\"]",
            minimum_sample_size: 10,
          },
          period: { lookback_seconds: 604_800 },
        },
        allowed_actions: ["record_report", "escalate"],
        scope: { allowed_paths: [], test_commands: [] },
        budgets: {
          max_runs_per_day: 1,
          max_prs_per_day: 0,
          max_attempts_per_case_revision: 1,
          max_turns_per_run: 10,
          max_runtime_seconds: 900,
        },
        approvals: { required_for: [], expires_after_seconds: 86_400 },
        escalation: { destination: "owner", instructions: "Stop and escalate." },
      },
    ],
  });
}

async function saveContract(projectId: string, userId: string, contract = contractDocument()) {
  const etag = await automationContractEtag(contract);
  const now = Math.floor(Date.now() / 1_000);
  await getDbForUrl(env.TURSO_DATABASE_URL).insert(automationContracts).values({
    projectId,
    schemaVersion: contract.schema_version,
    revision: contract.revision,
    enabled: contract.enabled ? 1 : 0,
    etag,
    documentJson: JSON.stringify(contract),
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
    pausedAt: null,
    pauseReason: null,
  });
  return { contract, etag, now };
}

function runValues(input: {
  id: string;
  projectId: string;
  policy: AutomationContract["automations"][number];
  status:
    | "queued"
    | "claimed"
    | "running"
    | "draft_pr_opened"
    | "awaiting_approval"
    | "verifying"
    | "succeeded"
    | "failed"
    | "escalated"
    | "cancelled";
  createdAt: number;
  runnerCredentialId?: string | null;
  triggerKind?: "unhandled_cases" | "schedule";
  verificationStartedAt?: number | null;
  deadlineAt?: number;
  finishedAt?: number | null;
}) {
  return {
    id: input.id,
    projectId: input.projectId,
    automationId: input.policy.id,
    contractRevision: 1,
    contractEtag: '"contract-etag"',
    policySnapshotJson: JSON.stringify(input.policy),
    caseId: null,
    caseRevision: null,
    triggerReceiptId: `receipt_${input.id}`,
    triggerKind: input.triggerKind ?? "unhandled_cases" as const,
    triggerRef: null,
    triggerSnapshotJson: JSON.stringify({ hostile_telemetry: "DO_NOT_LEAK_TRIGGER" }),
    idempotencyKeyHash: `idempotency_${input.id}`,
    requestHash: `request_${input.id}`,
    attempt: 1,
    status: input.status,
    runnerProvider: "codex",
    runnerId: "runner",
    runnerCredentialId: input.runnerCredentialId ?? null,
    model: null,
    branch: null,
    commitSha: null,
    prUrl: null,
    deploySha: null,
    summaryMd: "DO_NOT_LEAK_SUMMARY",
    evidenceJson: JSON.stringify({ findings: ["DO_NOT_LEAK_EVIDENCE"] }),
    verificationStartedAt: input.verificationStartedAt ?? null,
    turnsUsed: 3,
    costMicros: 250_000,
    usageSequence: 1,
    deadlineAt: input.deadlineAt ?? input.createdAt + 3_600,
    lastHeartbeatAt: input.createdAt,
    retryEligibleAt: null,
    errorCode: null,
    errorMessage: "DO_NOT_LEAK_ERROR",
    startedAt: input.createdAt,
    finishedAt: input.finishedAt ?? null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

describe("GET automation-control", () => {
  it("returns a bounded missing-contract snapshot to an owner and rejects runner credentials", async () => {
    const { owner, project } = await setupProject();
    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      viewer: {
        role: "owner",
        capabilities: { read_control: true, update_contract: true, pause_contract: true },
      },
      contract: { configured: false, valid: null, state: "not_configured", etag: null },
      summary: { configured_automations: 0 },
      automations: [],
      control_boundary: {
        telemetry_evidence_included: false,
        raw_runner_output_included: false,
        secret_columns_included: false,
      },
    });

    await saveContract(project.id, owner.user_id);
    const runner = await createTestProjectCredential(env, project.id, "automation_runner", "auto_fix");
    const denied = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${runner.credential}` },
    });
    expect(denied.status).toBe(401);
  });

  it("aggregates control-only state, exact budget availability, and one attention item per run", async () => {
    const { owner, project } = await setupProject();
    const { contract, etag, now } = await saveContract(project.id, owner.user_id);
    const runner = await createTestProjectCredential(env, project.id, "automation_runner", "auto_fix");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const firstRunId = uuidv7();
    const secondRunId = uuidv7();
    const firstPolicy = contract.automations[0]!;
    const secondPolicy = AutomationContractSchema.parse({
      ...contract,
      automations: [{
        ...firstPolicy,
        budgets: { ...firstPolicy.budgets, max_prs_per_day: 2 },
      }],
    }).automations[0]!;
    await db.insert(automationRuns).values([
      runValues({
        id: firstRunId,
        projectId: project.id,
        policy: firstPolicy,
        status: "awaiting_approval",
        createdAt: now - 20,
        runnerCredentialId: runner.id,
      }),
      runValues({
        id: secondRunId,
        projectId: project.id,
        policy: secondPolicy,
        status: "running",
        createdAt: now - 10,
        runnerCredentialId: runner.id,
      }),
    ]);
    await db.insert(automationBudgetCharges).values([
      { id: uuidv7(), projectId: project.id, automationId: "auto_fix", runId: firstRunId, kind: "run", createdAt: now - 100 },
      { id: uuidv7(), projectId: project.id, automationId: "auto_fix", runId: secondRunId, kind: "run", createdAt: now - 50 },
      { id: uuidv7(), projectId: project.id, automationId: "auto_fix", runId: firstRunId, kind: "draft_pr", createdAt: now - 25 },
    ]);
    const approvalId = uuidv7();
    await db.insert(automationApprovals).values({
      id: approvalId,
      projectId: project.id,
      automationId: "auto_fix",
      runId: firstRunId,
      action: "draft_pr",
      status: "pending",
      requestedBy: "runner",
      decidedBy: null,
      requestReason: "DO_NOT_LEAK_APPROVAL_REASON",
      decisionReason: null,
      subjectHash: "subject",
      subjectJson: JSON.stringify({ hostile: "DO_NOT_LEAK_SUBJECT" }),
      requestedAt: now - 5,
      decidedAt: null,
      expiresAt: now + 600,
    });

    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.contract).toMatchObject({
      configured: true,
      valid: true,
      state: "enabled",
      etag,
      summary: "Bounded automation control test.",
    });
    expect(body.as_of).toEqual(expect.any(Number));
    expect(body.summary).toMatchObject({
      configured_automations: 2,
      effective_enabled_automations: 1,
      active_runs: 2,
      pending_approval_records: 1,
      actionable_pending_approvals: 1,
    });
    const autoFix = body.automations.find((automation: any) => automation.id === "auto_fix");
    expect(autoFix).toMatchObject({
      effective_enabled: true,
      trigger: { kind: "unhandled_cases", required_trust: "customer_posthog" },
      activity: { active_runs: 2, pending_approvals: 1 },
      runner_credentials: { status: "expiring", active: 1 },
      latest_run: { id: secondRunId, status: "running", turns_used: 3, cost_usd: 0.25 },
    });
    expect(autoFix.rolling_24h_budgets.new_run_current_policy).toMatchObject({
      policy_source: "current_contract_for_new_runs",
      limit: 2,
      used: 2,
      remaining: 0,
      available: false,
      policy_blocked: false,
      available_at: now - 100 + 86_401,
    });
    expect(autoFix.rolling_24h_budgets.draft_pr_live_run_policies).toMatchObject({
      status: "mixed_policy",
      can_assume_available: false,
      live_run_count: 2,
    });
    expect(autoFix.rolling_24h_budgets.draft_pr_live_run_policies.capacities)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ limit: 1, used: 1, available: false }),
        expect.objectContaining({ limit: 2, used: 1, available: true, remaining: 1 }),
      ]));
    const weekly = body.automations.find((automation: any) => automation.id === "weekly_report");
    expect(weekly.rolling_24h_budgets.draft_pr_current_policy_for_future_runs)
      .toMatchObject({ limit: 0, available: false, policy_blocked: true, available_at: null });

    const firstRunAttention = body.attention.filter((item: any) => item.run_id === firstRunId);
    expect(firstRunAttention).toEqual([
      expect.objectContaining({
        kind: "approval_pending",
        approval_id: approvalId,
        action: "draft_pr",
        message: expect.any(String),
        next_action: expect.any(String),
        operator_remediation_required: true,
        operation: expect.objectContaining({
          operation_id: "decide_automation_approval",
          method: "POST",
          required_fields: ["decision", "reason"],
        }),
      }),
    ]);
    expect(body.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "live_pr_budget_mixed_policy", automation_id: "auto_fix" }),
      expect.objectContaining({ kind: "new_run_budget_unavailable", automation_id: "auto_fix" }),
    ]));
    expect(body.bounds).toMatchObject({ max_attention_items: 100, max_latest_runs_per_automation: 1 });
    expect(body.truncation.attention.truncated).toBe(false);
    expect(body.controls.cancel_run.required_headers).toEqual(["Idempotency-Key"]);
    expect(body.controls).not.toHaveProperty("manage_credentials");
    expect(body.controls.list_credentials).toMatchObject({
      operation_id: "list_project_credentials",
      method: "GET",
      required_headers: [],
    });
    expect(body.controls.create_credential).toMatchObject({
      operation_id: "create_project_credential",
      method: "POST",
      required_headers: ["Idempotency-Key"],
      conditional_fields: { automation_runner: ["automation_id"] },
    });

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      "DO_NOT_LEAK_TRIGGER",
      "DO_NOT_LEAK_SUMMARY",
      "DO_NOT_LEAK_EVIDENCE",
      "DO_NOT_LEAK_ERROR",
      "DO_NOT_LEAK_APPROVAL_REASON",
      "DO_NOT_LEAK_SUBJECT",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("prioritizes kill switches over approvals and makes paused approvals non-actionable", async () => {
    const { owner, project } = await setupProject();
    const disabledContract = AutomationContractSchema.parse({
      ...contractDocument(),
      enabled: false,
    });
    const { contract, now } = await saveContract(project.id, owner.user_id, disabledContract);
    const runner = await createTestProjectCredential(env, project.id, "automation_runner", "auto_fix");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const runId = uuidv7();
    await db.insert(automationRuns).values(runValues({
      id: runId,
      projectId: project.id,
      policy: contract.automations[0]!,
      status: "awaiting_approval",
      createdAt: now - 10,
      runnerCredentialId: runner.id,
    }));
    await db.insert(automationApprovals).values({
      id: uuidv7(),
      projectId: project.id,
      automationId: "auto_fix",
      runId,
      action: "draft_pr",
      status: "pending",
      requestedBy: "runner",
      decidedBy: null,
      requestReason: "non-authoritative reason",
      decisionReason: null,
      subjectHash: "subject",
      subjectJson: "{}",
      requestedAt: now - 5,
      decidedAt: null,
      expiresAt: now + 600,
    });

    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.contract).toMatchObject({ state: "disabled", effective_enabled: false });
    expect(body.summary).toMatchObject({
      pending_approval_records: 1,
      actionable_pending_approvals: 0,
    });
    expect(body.automations.find((automation: any) => automation.id === "auto_fix").activity)
      .toMatchObject({ pending_approvals: 0, blocked_pending_approvals: 1 });
    expect(body.controls.decide_approval.allowed).toBe(false);
    expect(body.controls.cancel_run.allowed).toBe(true);
    expect(body.attention.filter((item: any) => item.run_id === runId)).toEqual([
      expect.objectContaining({ kind: "global_kill_switch_active_run", severity: "critical" }),
    ]);
  });

  it("applies kill-switch priority before the bounded attention query limit", async () => {
    const { owner, project } = await setupProject();
    const { contract, now } = await saveContract(project.id, owner.user_id);
    const autoFixRunner = await createTestProjectCredential(
      env,
      project.id,
      "automation_runner",
      "auto_fix",
    );
    const reportRunner = await createTestProjectCredential(
      env,
      project.id,
      "automation_runner",
      "weekly_report",
    );
    const healthyPolicy = contract.automations[0]!;
    const disabledPolicy = contract.automations[1]!;
    const healthyRuns = Array.from({ length: 101 }, (_, index) => runValues({
      id: uuidv7(),
      projectId: project.id,
      policy: healthyPolicy,
      status: "running",
      createdAt: now - index,
      deadlineAt: now + 3_600,
      runnerCredentialId: autoFixRunner.id,
    }));
    const disabledRunId = uuidv7();
    await getDbForUrl(env.TURSO_DATABASE_URL).insert(automationRuns).values([
      ...healthyRuns,
      runValues({
        id: disabledRunId,
        projectId: project.id,
        policy: disabledPolicy,
        status: "running",
        triggerKind: "schedule",
        createdAt: now - 500,
        deadlineAt: now + 3_600,
        runnerCredentialId: reportRunner.id,
      }),
    ]);

    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.attention).toContainEqual(expect.objectContaining({
      kind: "automation_kill_switch_active_run",
      run_id: disabledRunId,
    }));
    expect(body.truncation.attention).toMatchObject({
      source_query_truncated: true,
      query_priority_applied_before_limit: true,
      candidate_count_exact: false,
      continuation: {
        mode: "restart_each_source_with_keyset_pagination",
        operations: expect.arrayContaining([
          expect.objectContaining({
            operation_id: "list_automation_runs",
            cursor_response_path: "pagination.next_cursor",
          }),
          expect.objectContaining({
            operation_id: "list_automation_approvals",
            cursor_response_path: "pagination.next_cursor",
          }),
        ]),
      },
    });
  });

  it("surfaces verification clocks and completed scheduled reports without runner output", async () => {
    const { owner, project } = await setupProject();
    const { contract, now } = await saveContract(project.id, owner.user_id);
    const runner = await createTestProjectCredential(env, project.id, "automation_runner", "auto_fix");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const verificationRunId = uuidv7();
    const reportRunId = uuidv7();
    const verificationPolicy = contract.automations[0]!;
    const reportPolicy = contract.automations[1]!;
    await db.insert(automationRuns).values([
      runValues({
        id: verificationRunId,
        projectId: project.id,
        policy: verificationPolicy,
        status: "verifying",
        createdAt: now - 90_100,
        runnerCredentialId: runner.id,
        verificationStartedAt: now - verificationPolicy.verification!.max_wait_seconds - 1,
      }),
      runValues({
        id: reportRunId,
        projectId: project.id,
        policy: reportPolicy,
        status: "succeeded",
        triggerKind: "schedule",
        createdAt: now - 20,
        finishedAt: now - 10,
      }),
    ]);

    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.attention).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "verification_overdue",
        run_id: verificationRunId,
        verification_ready_at: expect.any(Number),
        verification_max_wait_at: expect.any(Number),
      }),
      expect.objectContaining({
        kind: "scheduled_report_ready",
        run_id: reportRunId,
        review_state: "unacknowledged_no_durable_ledger",
      }),
    ]));
    expect(body.attention_review).toMatchObject({
      durable_acknowledgement_supported: false,
      item_ids_stable: true,
    });
    expect(JSON.stringify(body)).not.toContain("DO_NOT_LEAK_SUMMARY");
  });

  it("lets members read while every mutation capability and control is false", async () => {
    const { owner, project } = await setupProject();
    await saveContract(project.id, owner.user_id);
    const member = await login(`control-member-${Math.random()}@example.com`);
    await getDbForUrl(env.TURSO_DATABASE_URL).insert(projectMemberships).values({
      id: uuidv7(),
      projectId: project.id,
      userId: member.user_id,
      role: "member",
      invitedBy: owner.user_id,
      createdAt: Math.floor(Date.now() / 1_000),
    });

    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${member.api_key}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.viewer.role).toBe("member");
    expect(body.viewer.capabilities.read_control).toBe(true);
    for (const [capability, allowed] of Object.entries(body.viewer.capabilities)) {
      if (capability !== "read_control") expect(allowed).toBe(false);
    }
    for (const control of [
      "save_contract",
      "enable_contract",
      "pause_contract",
      "toggle_automation",
      "decide_approval",
      "cancel_run",
      "list_credentials",
      "create_credential",
    ]) {
      expect(body.controls[control].allowed).toBe(false);
    }
  });

  it("keyset-pages runs and approvals without silent truncation or same-second skips", async () => {
    const { owner, project } = await setupProject();
    const { contract, now } = await saveContract(project.id, owner.user_id);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const runIds = [uuidv7(), uuidv7(), uuidv7()];
    await db.insert(automationRuns).values(runIds.map((id) => runValues({
      id,
      projectId: project.id,
      policy: contract.automations[0]!,
      status: "queued",
      createdAt: now,
    })));
    await db.insert(automationApprovals).values(runIds.map((runId, index) => ({
      id: uuidv7(),
      projectId: project.id,
      automationId: contract.automations[0]!.id,
      runId,
      action: "draft_pr" as const,
      status: "pending" as const,
      requestedBy: "runner",
      decidedBy: null,
      requestReason: `reason-${index}`,
      decisionReason: null,
      subjectHash: `subject-${index}`,
      subjectJson: "{}",
      requestedAt: now,
      decidedAt: null,
      expiresAt: now + 3_600,
    })));

    const collect = async (firstPath: string, field: "runs" | "approvals") => {
      const ids: string[] = [];
      let path: string | null = firstPath;
      for (let page = 0; path && page < 10; page += 1) {
        const response = await call(path, {
          headers: { authorization: `Bearer ${owner.api_key}` },
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        expect(body.pagination).toMatchObject({
          kind: "descending_keyset",
          sort: "timestamp_desc_id_desc",
          limit: 1,
        });
        ids.push(...body[field].map((row: { id: string }) => row.id));
        path = body.pagination.follow_up?.href ?? null;
        expect(body.pagination.has_more).toBe(Boolean(path));
      }
      return ids;
    };

    const listedRunIds = await collect(
      `/v1/projects/${project.id}/automation-runs?automation_id=auto_fix&limit=1`,
      "runs",
    );
    expect(listedRunIds).toHaveLength(3);
    expect(new Set(listedRunIds)).toEqual(new Set(runIds));

    const listedApprovalIds = await collect(
      `/v1/projects/${project.id}/automation-approvals?status=pending&limit=1`,
      "approvals",
    );
    expect(listedApprovalIds).toHaveLength(3);
    expect(new Set(listedApprovalIds).size).toBe(3);

    const malformed = await call(
      `/v1/projects/${project.id}/automation-runs?cursor=not-a-real-cursor`,
      { headers: { authorization: `Bearer ${owner.api_key}` } },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_payload" } });
  });

  it("fails closed when a stored contract cannot be validated", async () => {
    const { owner, project } = await setupProject();
    const { etag: corruptRowEtag } = await saveContract(project.id, owner.user_id);
    await getDbForUrl(env.TURSO_DATABASE_URL)
      .update(automationContracts)
      .set({ documentJson: JSON.stringify({ schema_version: "2", enabled: true }) })
      .where(eq(automationContracts.projectId, project.id));

    const response = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(response.status).toBe(200);
    const inconsistent = (await response.json()) as any;
    expect(inconsistent).toMatchObject({
      contract: {
        configured: true,
        valid: false,
        state: "inconsistent",
        effective_enabled: false,
      },
      automations: [],
      attention: [expect.objectContaining({ kind: "contract_inconsistent", severity: "critical" })],
    });
    expect(inconsistent.controls).toMatchObject({
      read_contract: { allowed: false },
      save_contract: { allowed: true, required_headers: ["If-Match"] },
      enable_contract: { allowed: false },
      pause_contract: { allowed: false },
      toggle_automation: { allowed: false },
      decide_approval: { allowed: false },
      cancel_run: { allowed: true },
    });

    const repair = await call(`/v1/projects/${project.id}/automation-contract`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "if-match": corruptRowEtag,
      },
      json: { ...contractDocument(), enabled: false },
    });
    expect(repair.status).toBe(200);
    const repairedContract = (await repair.json()) as { etag: string; revision: number };
    expect(repairedContract).toMatchObject({ revision: 2, etag: expect.any(String) });

    const reread = await call(`/v1/projects/${project.id}/automation-control`, {
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(reread.status).toBe(200);
    expect(await reread.json()).toMatchObject({
      contract: {
        configured: true,
        valid: true,
        state: "paused",
        revision: 2,
        etag: repairedContract.etag,
        stored_enabled: false,
        document_enabled: false,
        effective_enabled: false,
      },
      attention: [expect.objectContaining({ kind: "contract_paused" })],
    });
  });
});
