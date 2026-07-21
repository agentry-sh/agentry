import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  AutomationContractSchema,
  AutomationDefinitionSchema,
  uuidv7,
} from "@agentrysh/shared";
import {
  automationContracts,
  automationRunEvents,
  automationRunReportSources,
  automationRuns,
  automationTriggerReceipts,
} from "@agentry/db/schema";
import {
  createTestProjectCredential,
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";
import { seedVerifiedOnboardingReadiness } from "./onboarding-readiness-fixture.js";

const runHogQlMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>(
    "../src/posthog.js",
  );
  return {
    ...actual,
    isPosthogConfigured: () => true,
    runHogQl: (...args: unknown[]) => runHogQlMock(...args),
  };
});

const { createApp } = await import("../src/index.js");
const { automationContractEtag } = await import("../src/automation-contracts.js");
const { getQueryBlueprint } = await import("../src/query-blueprints.js");

const AUTOMATION_ID = "weekly_funnel";
const BLUEPRINT_ID = "ordered_funnel_period_compare";
const APPROVED_EVENTS = [
  "signup_started",
  "signup_completed",
  "activation_completed",
  "first_value_reached",
] as const;
const APPROVED_PLAN_HASH = "verified-automation-report-plan";
const PERIOD_SECONDS = 7 * 86_400;

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true, fileDb: true });
  app = createApp();
  runHogQlMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  disposeTestEnv(env);
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
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

async function loginAndCreateProject() {
  const login = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email: `report-source-${crypto.randomUUID()}@example.com` },
  });
  expect(login.status).toBe(200);
  const auth = await login.json() as { api_key: string; user_id: string };
  const created = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.api_key}`,
      "idempotency-key": `report-source-project-${crypto.randomUUID()}`,
    },
    json: {
      name: "automation report source",
      repo_url: "https://github.com/example/app",
      default_branch: "main",
    },
  });
  expect(created.status).toBe(200);
  const project = await created.json() as { id: string };
  return { ...auth, project };
}

function reportPolicy() {
  return AutomationDefinitionSchema.parse({
    id: AUTOMATION_ID,
    name: "Weekly funnel report",
    enabled: true,
    runner: {
      provider: "codex",
      repository: "https://github.com/example/app",
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
      blueprint_id: BLUEPRINT_ID,
      params: {
        scheduled_for: { source: "schedule", field: "scheduled_for" },
        period_days: 7,
        funnel_events_json: JSON.stringify(APPROVED_EVENTS),
        minimum_sample_size: 20,
      },
      period: { lookback_seconds: PERIOD_SECONDS },
    },
    allowed_actions: ["record_report", "escalate"],
    scope: {},
    budgets: { max_runtime_seconds: 1_800, max_prs_per_day: 0 },
    approvals: {},
    escalation: {
      destination: "project owner",
      instructions: "Review the bounded aggregate report.",
    },
  });
}

async function saveTelemetryReadiness(projectId: string) {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  await seedVerifiedOnboardingReadiness({
    db,
    project_id: projectId,
    approved_events: APPROVED_EVENTS,
    approved_plan_hash: APPROVED_PLAN_HASH,
  });
}

async function seedRun(options: { telemetryReady?: boolean } = {}) {
  const state = await loginAndCreateProject();
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  if (options.telemetryReady !== false) await saveTelemetryReadiness(state.project.id);
  const policy = reportPolicy();
  const contract = AutomationContractSchema.parse({
    schema_version: "2",
    revision: 1,
    enabled: true,
    summary: "Run one source-bound weekly funnel review.",
    automations: [policy],
  });
  const etag = await automationContractEtag(contract);
  await db.insert(automationContracts).values({
    projectId: state.project.id,
    schemaVersion: "2",
    revision: 1,
    enabled: 1,
    etag,
    documentJson: JSON.stringify(contract),
    createdBy: state.user_id,
    updatedBy: state.user_id,
  });
  const runner = await createTestProjectCredential(
    env,
    state.project.id,
    "automation_runner",
    AUTOMATION_ID,
  );
  const otherRunner = await createTestProjectCredential(
    env,
    state.project.id,
    "automation_runner",
    AUTOMATION_ID,
  );
  const now = Math.floor(Date.now() / 1_000);
  const scheduledFor = now - 60;
  const runId = uuidv7();
  const receiptId = uuidv7();
  await db.insert(automationTriggerReceipts).values({
    id: receiptId,
    projectId: state.project.id,
    automationId: AUTOMATION_ID,
    contractRevision: 1,
    contractEtag: etag,
    triggerKind: "schedule",
    triggerKey: `schedule:1:${Math.floor(scheduledFor / 60)}`,
    scheduledFor,
    requiredTrust: "agentry_system",
    sourceTrust: "agentry_system",
    snapshotJson: JSON.stringify({ scheduled_for: scheduledFor }),
    snapshotHash: "schedule-snapshot-hash",
    status: "consumed",
    runId,
    issuedAt: scheduledFor,
    notBeforeAt: scheduledFor,
    expiresAt: scheduledFor + 3_600,
    consumedAt: now,
  });
  await db.insert(automationRuns).values({
    id: runId,
    projectId: state.project.id,
    automationId: AUTOMATION_ID,
    contractRevision: 1,
    contractEtag: etag,
    policySnapshotJson: JSON.stringify(policy),
    triggerReceiptId: receiptId,
    triggerKind: "schedule",
    triggerRef: String(scheduledFor),
    triggerSnapshotJson: JSON.stringify({ scheduled_for: scheduledFor }),
    idempotencyKeyHash: `run-idem-${runId}`,
    requestHash: `run-request-${runId}`,
    status: "running",
    runnerProvider: "codex",
    runnerId: `credential:${runner.id}`,
    runnerCredentialId: runner.id,
    deadlineAt: now + 1_800,
    lastHeartbeatAt: now,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return {
    ...state,
    db,
    policy,
    runId,
    scheduledFor,
    periodStart: scheduledFor - PERIOD_SECONDS,
    periodEnd: scheduledFor,
    runner,
    otherRunner,
  };
}

function resultRow(
  state: Awaited<ReturnType<typeof seedRun>>,
  period: "prior" | "current",
  sampleReady: boolean | 0 | 1,
  readinessStatus = sampleReady ? "ready" : "insufficient_entry_sample",
) {
  const current = period === "current";
  const ready = sampleReady === true || sampleReady === 1;
  const sampleSize = ready ? 30 : 10;
  const windowEnd = current ? state.periodEnd : state.periodStart;
  const windowStart = windowEnd - PERIOD_SECONDS;
  return {
    period,
    window_start: new Date(windowStart * 1_000).toISOString(),
    window_end: new Date(windowEnd * 1_000).toISOString(),
    funnel_events_json: JSON.stringify(APPROVED_EVENTS),
    observed_users_json: JSON.stringify([sampleSize, 8, 6, 4]),
    counts_json: JSON.stringify([sampleSize, 8, 6, 4]),
    conversion_percentages_json: JSON.stringify([83.33, 80, 75]),
    overall_conversion_pct: 66.67,
    sample_size: sampleSize,
    minimum_sample_size: 20,
    all_selected_events_observed: true,
    sample_ready: sampleReady,
    readiness_status: readinessStatus,
  };
}

function mockRows(
  state: Awaited<ReturnType<typeof seedRun>>,
  currentReady: boolean | 0 | 1 = true,
) {
  const blueprint = getQueryBlueprint(BLUEPRINT_ID)!;
  runHogQlMock.mockResolvedValueOnce({
    columns: blueprint.expected_columns,
    results: [
      resultRow(state, "prior", true),
      resultRow(state, "current", currentReady),
    ],
  });
}

function reportSourceRequest(
  state: Awaited<ReturnType<typeof seedRun>>,
  options: { credential?: string; key?: string; blueprintId?: string } = {},
) {
  return call(`/v1/automation-runs/${state.runId}/report-source`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.credential ?? state.runner.credential}`,
      "idempotency-key": options.key ?? "report-source-week-2026-07-13",
    },
    json: { blueprint_id: options.blueprintId ?? BLUEPRINT_ID },
  });
}

describe("automation scheduled report source", () => {
  it("requires report_plan only for schedule definitions", () => {
    const valid = reportPolicy();
    const missingPlan = { ...valid, report_plan: undefined };
    expect(AutomationDefinitionSchema.safeParse(missingPlan).success).toBe(false);

    const nonSchedule = {
      ...valid,
      trigger: {
        kind: "unhandled_cases",
        max_cases_per_sweep: 10,
        cooldown_seconds: 300,
        required_trust: "customer_posthog",
      },
      allowed_actions: ["escalate"],
    };
    expect(AutomationDefinitionSchema.safeParse(nonSchedule).success).toBe(false);
  });

  it("saves a disabled candidate with readiness warnings but blocks enablement until telemetry is verified", async () => {
    const state = await loginAndCreateProject();
    const contract = AutomationContractSchema.parse({
      schema_version: "2",
      revision: 1,
      enabled: false,
      summary: "Candidate source-bound weekly funnel review.",
      automations: [reportPolicy()],
    });
    const blocked = await call(
      `/v1/projects/${state.project.id}/automation-contract/validate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${state.api_key}` },
        json: contract,
      },
    );
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({
      valid: true,
      issues: [],
      warnings: [{ code: "report_blueprint_not_ready" }],
    });

    const saved = await call(
      `/v1/projects/${state.project.id}/automation-contract`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${state.api_key}` },
        json: contract,
      },
    );
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as { etag: string };
    const prematureEnable = await call(
      `/v1/projects/${state.project.id}/automation-contract/enable`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.api_key}`,
          "if-match": savedBody.etag,
        },
      },
    );
    expect(prematureEnable.status).toBe(409);
    expect(await prematureEnable.json()).toMatchObject({
      error: {
        code: "automation_contract_stale",
        details: { issues: [{ code: "report_blueprint_not_ready" }] },
      },
    });

    await saveTelemetryReadiness(state.project.id);
    const ready = await call(
      `/v1/projects/${state.project.id}/automation-contract/validate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${state.api_key}` },
        json: contract,
      },
    );
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ valid: true, issues: [] });
  });

  it("materializes one exact server-owned aggregate for only the bound runner", async () => {
    const state = await seedRun();
    const ownerDenied = await reportSourceRequest(state, {
      credential: state.api_key,
    });
    expect(ownerDenied.status).toBe(403);
    const otherRunnerDenied = await reportSourceRequest(state, {
      credential: state.otherRunner.credential,
    });
    expect(otherRunnerDenied.status).toBe(403);
    expect(runHogQlMock).not.toHaveBeenCalled();

    mockRows(state, 1);
    const first = await reportSourceRequest(state);
    expect(first.status).toBe(200);
    const firstJson = await first.json() as any;
    expect(firstJson).toMatchObject({
      blueprint_id: BLUEPRINT_ID,
      readiness: {
        status: "ready",
        checks: {
          exact_row_count: true,
          exact_row_identity_order: true,
          all_sample_gates_passed: true,
        },
      },
      source: {
        scheduled_for: state.scheduledFor,
        period_start: state.periodStart,
        period_end: state.periodEnd,
        row_count: 2,
        input_readiness: {
          source: "verified_onboarding_plan",
          onboarding_verified: true,
          selected_events_observed_by_onboarding_proof: true,
        },
      },
      idempotent_replay: false,
    });
    expect(firstJson.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstJson.source.rows.map((row: any) => row.sample_ready)).toEqual([
      true,
      true,
    ]);
    expect(runHogQlMock).toHaveBeenCalledTimes(1);
    const executedQuery = String(runHogQlMock.mock.calls[0]?.[2]);
    expect(executedQuery).toContain(new Date(state.scheduledFor * 1_000).toISOString());
    expect(executedQuery).not.toMatch(/\bnow\s*\(/i);

    const replay = await reportSourceRequest(state);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      source_hash: firstJson.source_hash,
      idempotent_replay: true,
    });
    expect(runHogQlMock).toHaveBeenCalledTimes(1);

    const changed = await reportSourceRequest(state, {
      blueprintId: "funnel_3_step",
    });
    expect(changed.status).toBe(409);
    expect((await changed.json() as any).error.code).toBe("idempotency_key_reused");
    const anotherKey = await reportSourceRequest(state, {
      key: "another-source-key-for-the-same-run",
    });
    expect(anotherKey.status).toBe(409);
    expect((await anotherKey.json() as any).error.code).toBe(
      "report_source_already_materialized",
    );

    const runRead = await call(`/v1/automation-runs/${state.runId}`, {
      headers: { authorization: `Bearer ${state.api_key}` },
    });
    expect(runRead.status).toBe(200);
    expect(await runRead.json()).toMatchObject({
      report_source: { source_hash: firstJson.source_hash },
    });
    expect((await state.db.select().from(automationRunReportSources)).length).toBe(1);
    expect((await state.db.select().from(automationRunEvents)).map((event) => event.event))
      .toContain("report.source_materialized");
  });

  it("records exactly one report only when its source hash, period, and readiness match", async () => {
    const state = await seedRun();
    mockRows(state);
    const sourceResponse = await reportSourceRequest(state);
    expect(sourceResponse.status).toBe(200);
    const source = await sourceResponse.json() as any;
    const body = {
      summary_md: "Activation improved; a human should review the bounded comparison.",
      evidence: {
        report: {
          kind: "funnel_review",
          period_start: state.periodStart,
          period_end: state.periodEnd,
          source_hash: source.source_hash,
          findings: [{
            kind: "metric",
            metric: "overall_conversion_pct",
            unit: "percent",
            prior_value: 60,
            current_value: 66.67,
            change: 6.67,
            source_columns: ["overall_conversion_pct"],
          }],
        },
      },
    };
    const wrongPeriod = await call(
      `/v1/automation-runs/${state.runId}/actions/record-report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.runner.credential}`,
          "idempotency-key": "record-weekly-report-2026-07-13",
        },
        json: {
          ...body,
          evidence: {
            report: { ...body.evidence.report, period_start: state.periodStart - 1 },
          },
        },
      },
    );
    expect(wrongPeriod.status).toBe(409);

    const record = await call(
      `/v1/automation-runs/${state.runId}/actions/record-report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.runner.credential}`,
          "idempotency-key": "record-weekly-report-2026-07-13",
        },
        json: body,
      },
    );
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({
      status: "succeeded",
      idempotent_replay: false,
      control: {
        verification: {
          kind: "report_recorded",
          source_hash: source.source_hash,
          passed: true,
        },
      },
    });

    const replay = await call(
      `/v1/automation-runs/${state.runId}/actions/record-report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.runner.credential}`,
          "idempotency-key": "record-weekly-report-2026-07-13",
        },
        json: body,
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: "succeeded",
      idempotent_replay: true,
    });

    const changed = await call(
      `/v1/automation-runs/${state.runId}/actions/record-report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.runner.credential}`,
          "idempotency-key": "record-weekly-report-2026-07-13",
        },
        json: { ...body, summary_md: "Changed after commit." },
      },
    );
    expect(changed.status).toBe(409);
    expect((await changed.json() as any).error.code).toBe("idempotency_key_reused");
    const reportEvents = (await state.db.select().from(automationRunEvents))
      .filter((event) => event.event === "report.recorded");
    expect(reportEvents).toHaveLength(1);
  });

  it("persists blocked readiness but refuses findings when either exact period lacks sample", async () => {
    const state = await seedRun();
    mockRows(state, false);
    const response = await reportSourceRequest(state);
    expect(response.status).toBe(200);
    const source = await response.json() as any;
    expect(source.readiness).toMatchObject({
      status: "blocked",
      checks: { all_sample_gates_passed: false },
    });
    const record = await call(
      `/v1/automation-runs/${state.runId}/actions/record-report`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.runner.credential}`,
          "idempotency-key": "record-blocked-weekly-report",
        },
        json: {
          summary_md: "A claim that must not be accepted.",
          evidence: {
            report: {
              kind: "funnel_review",
              period_start: state.periodStart,
              period_end: state.periodEnd,
              source_hash: source.source_hash,
              findings: [{
                kind: "hypothesis",
                rank: 1,
                title: "Conversion improved",
                rationale: "This claim must remain blocked because the exact sample gate failed.",
                expected_impact: "unknown",
                confidence: "low",
                evidence_columns: ["overall_conversion_pct"],
                suggested_human_next_step: "Wait for enough real traffic and review a future run.",
              }],
            },
          },
        },
      },
    );
    expect(record.status).toBe(409);
    expect((await record.json() as any).error.code).toBe("report_source_not_ready");
    const run = (await state.db.select().from(automationRuns)
      .where(eq(automationRuns.id, state.runId)).limit(1))[0]!;
    expect(run.status).toBe("running");
  });

  it("fails before querying without verified telemetry and never persists unsafe source text", async () => {
    const noTelemetry = await seedRun({ telemetryReady: false });
    const missing = await reportSourceRequest(noTelemetry);
    expect(missing.status).toBe(428);
    expect(runHogQlMock).not.toHaveBeenCalled();
    expect((await noTelemetry.db.select().from(automationRunReportSources)).length).toBe(0);

    const unsafe = await seedRun();
    const blueprint = getQueryBlueprint(BLUEPRINT_ID)!;
    const rows = [
      resultRow(unsafe, "prior", true),
      resultRow(
        unsafe,
        "current",
        true,
        "Bearer ghp_abcdefghijklmnopqrstuvwxyz123456",
      ),
    ];
    runHogQlMock.mockResolvedValueOnce({
      columns: blueprint.expected_columns,
      results: rows,
    });
    const rejected = await reportSourceRequest(unsafe);
    expect(rejected.status).toBe(409);
    expect((await rejected.json() as any).error.code).toBe("report_source_unsafe");
    expect((await unsafe.db.select().from(automationRunReportSources)
      .where(eq(automationRunReportSources.runId, unsafe.runId))).length).toBe(0);
    expect((await unsafe.db.select().from(automationRunEvents)
      .where(eq(automationRunEvents.runId, unsafe.runId))).length).toBe(0);
  });
});
