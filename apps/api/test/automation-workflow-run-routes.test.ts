import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  automationWorkflowRuns,
  automationWorkflowSystemNodeClaims,
  automationWorkflowTriggerReceipts,
} from "@agentry/db/schema";
import { enableAutomationWorkflow } from "../src/automation-workflow-controls.js";
import { buildWeeklyFunnelReviewWorkflow } from "../src/automation-workflow-presets.js";
import { readAutomationWorkflowReadiness } from "../src/automation-workflow-readiness.js";
import { saveDisabledAutomationWorkflow } from "../src/automation-workflow-store.js";
import { MUTATION_ROUTE_POLICIES } from "../src/mutation-route-policy.js";
import {
  createTestProjectCredential,
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";
import { seedVerifiedOnboardingReadiness } from "./onboarding-readiness-fixture.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const posthogMocks = vi.hoisted(() => ({ runHogQl: vi.fn() }));

vi.mock("../src/posthog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/posthog.js")>();
  return {
    ...actual,
    isPosthogConfigured: () => true,
    runHogQl: (...args: unknown[]) => posthogMocks.runHogQl(...args),
  };
});

const { createApp } = await import("../src/index.js");

const AUTOMATION_ID = "due_schedule";
const RUNTIME_MUTATIONS = [
  "DELETE /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/trigger-receipts/issue",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease/renew",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/commands",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/cancel",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/advance",
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/effects/:effect_id/reconcile",
] as const;

type ActiveFixture = Awaited<ReturnType<typeof setupActiveWorkflow>>;

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  posthogMocks.runHogQl.mockReset();
  env = await makeTestEnv({ withEncKey: true, fileDb: true });
  app = createApp();
});

afterEach(() => disposeTestEnv(env));

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

async function login(email: string) {
  const response = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { api_key: string; user_id: string };
}

async function setupProject(name = "Workflow runtime route test") {
  const owner = await login(`workflow-runtime-route-${crypto.randomUUID()}@example.com`);
  const response = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": `workflow-project-${crypto.randomUUID()}`,
    },
    json: {
      name,
      repo_url: "https://github.com/example/workflow-app",
      default_branch: "main",
    },
  });
  expect(response.status).toBe(200);
  const project = (await response.json()) as { id: string };
  return { owner, project };
}

function dueScheduleWorkflow() {
  return buildWeeklyFunnelReviewWorkflow({
    automation_id: AUTOMATION_ID,
    name: "Due schedule",
    runner: { provider: "codex" as const, environment: "production" },
    schedule: {
      cron: "* * * * *",
      timezone: "UTC",
      start_window_seconds: 900,
    },
    funnel: {
      events: ["account_created", "project_created"],
      period_days: 7,
      minimum_sample_size: 1,
    },
    budgets: {
      max_runs_per_day: 4,
      max_turns_per_run: 10,
      max_runtime_seconds: 600,
      max_cost_usd_per_run: 1,
    },
    escalation: {
      destination: "project owner",
      instructions: "Preserve the exact evidence and stop.",
    },
  });
}

function auth(apiKey: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

function workflowBase(projectId: string) {
  return `/v1/projects/${projectId}/automation-workflows/${AUTOMATION_ID}`;
}

async function setupActiveWorkflow() {
  const { owner, project } = await setupProject();
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const saved = await saveDisabledAutomationWorkflow(db, {
    project_id: project.id,
    actor_user_id: owner.user_id,
    workflow: dueScheduleWorkflow(),
  });
  const runner = await createTestProjectCredential(
    env,
    project.id,
    "automation_runner",
    AUTOMATION_ID,
  );
  await seedVerifiedOnboardingReadiness({
    db,
    project_id: project.id,
    approved_events: ["account_created", "project_created"],
    approved_plan_hash: `workflow-route-plan:${project.id}`,
  });
  const confirmations = ["scheduler_execution_configured"];
  const readiness = await readAutomationWorkflowReadiness(db, {
    project_id: project.id,
    automation_id: AUTOMATION_ID,
    expected_revision_id: saved.workflow.revision_id,
    expected_etag: saved.workflow.etag,
    owner_confirmed_caller_assertion_ids: confirmations,
  });
  expect(readiness.status).toBe("ready");
  await enableAutomationWorkflow(db, {
    project_id: project.id,
    automation_id: AUTOMATION_ID,
    workflow_revision_id: saved.workflow.revision_id,
    actor_user_id: owner.user_id,
    expected_etag: saved.workflow.etag,
    readiness_hash: readiness.readiness_hash,
    owner_confirmed_caller_assertion_ids: confirmations,
  });
  return { owner, project, runner, db };
}

async function issueReceipt(fixture: ActiveFixture) {
  const response = await call(`${workflowBase(fixture.project.id)}/trigger-receipts/issue`, {
    method: "POST",
    headers: auth(fixture.runner.credential),
    json: {},
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    receipts: Array<{ receipt_id: string; status: string }>;
  };
  expect(body.receipts).toHaveLength(1);
  expect(body.receipts[0]).toMatchObject({ status: "ready" });
  return body.receipts[0]!;
}

async function startRun(
  fixture: ActiveFixture,
  triggerReceiptId: string,
  idempotencyKey = `workflow-start-${crypto.randomUUID()}`,
) {
  return call(`${workflowBase(fixture.project.id)}/runs`, {
    method: "POST",
    headers: auth(fixture.runner.credential, { "idempotency-key": idempotencyKey }),
    json: { trigger_receipt_id: triggerReceiptId },
  });
}

describe("automation workflow v3 runtime HTTP boundary", () => {
  it("admits one concurrent /advance analytics reader and recovers from the durable claim", async () => {
    const fixture = await setupActiveWorkflow();
    const receipt = await issueReceipt(fixture);
    const started = await startRun(fixture, receipt.receipt_id);
    expect(started.status).toBe(201);
    const start = (await started.json()) as { run_id: string; committed_revision: number };
    const persistedReceipt = (
      await fixture.db.select().from(automationWorkflowTriggerReceipts).where(
        eq(automationWorkflowTriggerReceipts.id, receipt.receipt_id),
      ).limit(1)
    )[0]!;
    const payload = JSON.parse(persistedReceipt.payloadJson) as { scheduled_for: number };
    const duration = 7 * 86_400;
    const eventsJson = JSON.stringify(["account_created", "project_created"]);
    const columns = [
      "period",
      "window_start",
      "window_end",
      "funnel_events_json",
      "observed_users_json",
      "counts_json",
      "conversion_percentages_json",
      "overall_conversion_pct",
      "sample_size",
      "minimum_sample_size",
      "all_selected_events_observed",
      "sample_ready",
      "readiness_status",
    ];
    const providerOutput = {
      columns,
      results: [
        [
          "prior",
          new Date((payload.scheduled_for - (2 * duration)) * 1_000).toISOString(),
          new Date((payload.scheduled_for - duration) * 1_000).toISOString(),
          eventsJson,
          "[10,8]",
          "[10,8]",
          "[80]",
          80,
          10,
          1,
          1,
          1,
          "ready",
        ],
        [
          "current",
          new Date((payload.scheduled_for - duration) * 1_000).toISOString(),
          new Date(payload.scheduled_for * 1_000).toISOString(),
          eventsJson,
          "[12,9]",
          "[12,9]",
          "[75]",
          75,
          12,
          1,
          1,
          1,
          "ready",
        ],
      ],
    };
    let enterProvider!: () => void;
    let releaseProvider!: () => void;
    const providerEntered = new Promise<void>((resolve) => { enterProvider = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    posthogMocks.runHogQl.mockImplementationOnce(async () => {
      enterProvider();
      await providerRelease;
      return providerOutput;
    });

    const advancePath = `${workflowBase(fixture.project.id)}/runs/${start.run_id}/advance`;
    const first = call(advancePath, {
      method: "POST",
      headers: auth(fixture.runner.credential),
      json: {},
    });
    await providerEntered;
    const concurrent = await call(advancePath, {
      method: "POST",
      headers: auth(fixture.runner.credential),
      json: {},
    });
    expect(concurrent.status).toBe(409);
    expect(concurrent.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await concurrent.json()).toMatchObject({
      error: {
        code: "automation_workflow_system_node_claim_active",
        retryable: true,
        details: { retryable: true, retry_at: expect.any(Number) },
      },
    });
    expect(posthogMocks.runHogQl).toHaveBeenCalledTimes(1);

    releaseProvider();
    const committed = await first;
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({
      kind: "automation_workflow_system_advance",
      steps_committed: 1,
      stopped_reason: "customer_runner",
    });
    expect(posthogMocks.runHogQl).toHaveBeenCalledTimes(1);
    const claims = await fixture.db.select().from(automationWorkflowSystemNodeClaims);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      runId: start.run_id,
      runRevision: start.committed_revision,
      status: "completed",
      claimEpoch: 1,
    });

    const replay = await call(advancePath, {
      method: "POST",
      headers: auth(fixture.runner.credential),
      json: {},
    });
    expect(replay.status).toBe(200);
    expect(posthogMocks.runHogQl).toHaveBeenCalledTimes(1);
  });

  it("allows runtime reads to the owner or exact runner but reserves run starts for that exact runner", async () => {
    const fixture = await setupActiveWorkflow();
    const receipt = await issueReceipt(fixture);
    const ci = await createTestProjectCredential(env, fixture.project.id, "ci_deploy");
    const wrongAutomation = await createTestProjectCredential(
      env,
      fixture.project.id,
      "automation_runner",
      "another_workflow",
    );

    for (const credential of [fixture.owner.api_key, fixture.runner.credential]) {
      const response = await call(`${workflowBase(fixture.project.id)}/trigger-receipts`, {
        headers: auth(credential),
      });
      expect(response.status).toBe(200);
    }

    for (const credential of [ci.credential, wrongAutomation.credential]) {
      const response = await call(`${workflowBase(fixture.project.id)}/trigger-receipts`, {
        headers: auth(credential),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "credential_scope_denied" },
      });
    }

    const startPath = `${workflowBase(fixture.project.id)}/runs`;
    const request = {
      method: "POST" as const,
      headers: { "idempotency-key": "runtime-auth-boundary-0001" },
      json: { trigger_receipt_id: receipt.receipt_id },
    };
    expect((await call(startPath, request)).status).toBe(401);
    expect((await call(startPath, {
      ...request,
      headers: auth(fixture.owner.api_key, request.headers),
    })).status).toBe(401);
    for (const credential of [ci.credential, wrongAutomation.credential]) {
      const response = await call(startPath, {
        ...request,
        headers: auth(credential, request.headers),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "credential_scope_denied" },
      });
    }
  });

  it("requires an Idempotency-Key and rejects caller-authored trigger facts without consuming the receipt", async () => {
    const fixture = await setupActiveWorkflow();
    const receipt = await issueReceipt(fixture);
    const startPath = `${workflowBase(fixture.project.id)}/runs`;

    const missingKey = await call(startPath, {
      method: "POST",
      headers: auth(fixture.runner.credential),
      json: { trigger_receipt_id: receipt.receipt_id },
    });
    expect(missingKey.status).toBe(428);
    expect(await missingKey.json()).toMatchObject({
      error: {
        code: "precondition_required",
        details: { header: "Idempotency-Key" },
      },
    });

    const callerFacts = await call(startPath, {
      method: "POST",
      headers: auth(fixture.runner.credential, {
        "idempotency-key": "runtime-caller-facts-0001",
      }),
      json: {
        trigger_receipt_id: receipt.receipt_id,
        trigger_output: {
          scheduled_for: 0,
          instruction_authority: "caller_must_not_control_this",
        },
      },
    });
    expect(callerFacts.status).toBe(400);
    expect(await callerFacts.json()).toMatchObject({
      error: { code: "invalid_payload" },
    });

    expect(await fixture.db.select().from(automationWorkflowRuns)).toHaveLength(0);
    const persistedReceipt = (
      await fixture.db.select().from(automationWorkflowTriggerReceipts).where(
        eq(automationWorkflowTriggerReceipts.id, receipt.receipt_id),
      ).limit(1)
    )[0]!;
    expect(persistedReceipt).toMatchObject({
      status: "ready",
      consumedRunId: null,
      consumedAt: null,
    });
  });

  it("recovers an exact start after response loss and projects one durable run with its executable next action", async () => {
    const fixture = await setupActiveWorkflow();
    const receipt = await issueReceipt(fixture);
    const idempotencyKey = "runtime-response-loss-start-0001";

    const firstResponse = await startRun(fixture, receipt.receipt_id, idempotencyKey);
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json()) as any;
    expect(first).toMatchObject({
      kind: "automation_workflow_command_receipt",
      schema_version: "1",
      idempotent_replay: false,
      recovery: {
        method: "GET",
        path: expect.stringContaining(`/automation-workflows/${AUTOMATION_ID}/runs/`),
      },
    });

    // Simulate a lost first response: the caller knows only its original exact
    // receipt id and stable Idempotency-Key and sends the same request again.
    const replayResponse = await startRun(fixture, receipt.receipt_id, idempotencyKey);
    expect(replayResponse.status).toBe(200);
    const replay = (await replayResponse.json()) as any;
    expect(replay).toEqual({ ...first, idempotent_replay: true });
    expect(await fixture.db.select().from(automationWorkflowRuns)).toHaveLength(1);

    const runPath = `${workflowBase(fixture.project.id)}/runs/${first.run_id}`;
    for (const credential of [fixture.runner.credential, fixture.owner.api_key]) {
      const readResponse = await call(runPath, { headers: auth(credential) });
      expect(readResponse.status).toBe(200);
      expect(await readResponse.json()).toMatchObject({
        kind: "automation_workflow_run",
        project_id: fixture.project.id,
        automation_id: AUTOMATION_ID,
        run_id: first.run_id,
        trigger_receipt_id: receipt.receipt_id,
        runner_credential_id: fixture.runner.id,
        execution_authority_id: expect.stringMatching(/^[a-f0-9]{64}$/),
        execution_descriptor_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        authority: { open: true },
        state: { revision: first.committed_revision },
        next_action: {
          required_principal: "agentry_system",
          method: "POST",
          path: `${runPath}/advance`,
          expected_revision: first.committed_revision,
          lease_required: false,
          lease: null,
        },
      });
    }

    const listResponse = await call(`${workflowBase(fixture.project.id)}/runs`, {
      headers: auth(fixture.runner.credential),
    });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      kind: "automation_workflow_run_list",
      runs: [{
        run_id: first.run_id,
        trigger_receipt_id: receipt.receipt_id,
        read: { method: "GET", path: runPath },
      }],
    });

    const consumedResponse = await call(
      `${workflowBase(fixture.project.id)}/trigger-receipts/${receipt.receipt_id}`,
      { headers: auth(fixture.runner.credential) },
    );
    expect(consumedResponse.status).toBe(200);
    expect(await consumedResponse.json()).toMatchObject({
      receipt_id: receipt.receipt_id,
      status: "consumed",
      consumed_run_id: first.run_id,
    });
  });

  it("fails closed on internal command kinds and preserves human/runner command authority", async () => {
    const fixture = await setupActiveWorkflow();
    const receipt = await issueReceipt(fixture);
    const started = await startRun(fixture, receipt.receipt_id);
    expect(started.status).toBe(201);
    const start = (await started.json()) as { run_id: string; committed_revision: number };
    const commandPath = `${workflowBase(fixture.project.id)}/runs/${start.run_id}/commands`;

    for (const kind of ["start", "tick", "verify", "cancel", "effect_reconciled"]) {
      const response = await call(commandPath, {
        method: "POST",
        headers: auth(fixture.runner.credential),
        json: {
          kind,
          command_id: `forbidden-${kind}`,
          expected_revision: start.committed_revision,
          node_id: "query_funnel",
        },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: {
          code: "invalid_payload",
          details: { reason: expect.stringContaining("kind must be one of") },
        },
      });
    }

    const ownerCannotExecute = await call(commandPath, {
      method: "POST",
      headers: auth(fixture.owner.api_key),
      json: {
        kind: "component_succeeded",
        command_id: "owner-must-not-execute",
        expected_revision: start.committed_revision,
        node_id: "query_funnel",
        output: {},
        lease: {
          lease_epoch: 1,
          lease_token: "owner-cannot-hold-runner-lease-0001",
        },
      },
    });
    expect(ownerCannotExecute.status).toBe(403);
    expect(await ownerCannotExecute.json()).toMatchObject({
      error: { code: "credential_scope_denied" },
    });

    const runnerCannotApprove = await call(commandPath, {
      method: "POST",
      headers: auth(fixture.runner.credential),
      json: {
        kind: "approval_decided",
        command_id: "runner-must-not-approve",
        expected_revision: start.committed_revision,
        node_id: "approve_effect",
        decision: "approved",
        reason: "A runner cannot grant its own effect authority.",
      },
    });
    expect(runnerCannotApprove.status).toBe(403);
    expect(await runnerCannotApprove.json()).toMatchObject({
      error: { code: "credential_scope_denied" },
    });

    const persisted = (
      await fixture.db.select().from(automationWorkflowRuns).where(and(
        eq(automationWorkflowRuns.projectId, fixture.project.id),
        eq(automationWorkflowRuns.id, start.run_id),
      )).limit(1)
    );
    expect(persisted).toHaveLength(1);
    const read = await call(`${workflowBase(fixture.project.id)}/runs/${start.run_id}`, {
      headers: auth(fixture.runner.credential),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      state: { revision: start.committed_revision },
    });
  });

  it("keeps every workflow runtime mutation in the executable policy inventory", () => {
    const registered = new Set(((app as unknown as {
      routes: Array<{ method: string; path: string }>;
    }).routes ?? [])
      .map((route) => `${route.method} ${route.path}`)
      .filter((route) => (route.startsWith("POST ") || route.startsWith("DELETE ")) &&
        route.includes("/automation-workflows/:automation_id/") && (
        route.includes("/runs") || route.includes("/trigger-receipts/issue")
      )));

    expect([...registered].sort()).toEqual([...RUNTIME_MUTATIONS].sort());
    for (const route of RUNTIME_MUTATIONS) {
      const policy = MUTATION_ROUTE_POLICIES[route];
      expect(policy, `${route} must fail the global drift test when unclassified`).toBeDefined();
      expect(policy!.retry.rationale).not.toHaveLength(0);
      expect(policy!.body.kind).toBe("json");
      expect(policy!.body.max_bytes).toBeGreaterThan(0);
    }
  });
});
