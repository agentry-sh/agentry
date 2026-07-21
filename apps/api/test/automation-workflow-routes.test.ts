import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  automationWorkflowRevisions,
  automationWorkflows,
  projectDeletionFences,
  projectMemberships,
} from "@agentry/db/schema";
import { AutomationContractSchema, uuidv7 } from "@agentrysh/shared";
import { buildWeeklyFunnelReviewWorkflow } from "../src/automation-workflow-presets.js";
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
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
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

async function setupProject() {
  const owner = await login(`workflow-owner-${crypto.randomUUID()}@example.com`);
  const response = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": `workflow-project-${crypto.randomUUID()}`,
    },
    json: {
      name: "Workflow route test",
      repo_url: "https://github.com/example/workflow-app",
      default_branch: "main",
    },
  });
  expect(response.status).toBe(200);
  const project = (await response.json()) as { id: string };
  return { owner, project };
}

async function addMember(projectId: string, invitedBy: string) {
  const member = await login(`workflow-member-${crypto.randomUUID()}@example.com`);
  await getDbForUrl(env.TURSO_DATABASE_URL).insert(projectMemberships).values({
    id: uuidv7(),
    projectId,
    userId: member.user_id,
    role: "member",
    invitedBy,
    createdAt: Math.floor(Date.now() / 1_000),
  });
  return member;
}

function weeklyWorkflow() {
  return buildWeeklyFunnelReviewWorkflow({
    automation_id: "weekly_funnel_review",
    name: "Weekly activation funnel review",
    runner: { provider: "codex" as const, environment: "production" },
    schedule: {
      cron: "0 9 * * 1",
      timezone: "Europe/Helsinki",
      start_window_seconds: 900,
    },
    funnel: {
      events: [
        "account_created",
        "project_created",
        "subscription_started",
        "first_value_reached",
      ],
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
  });
}

function legacyWeeklyContract() {
  return AutomationContractSchema.parse({
    schema_version: "2",
    revision: 1,
    enabled: false,
    summary: "Legacy weekly report attempting to claim a workflow-v3 id.",
    automations: [{
      id: "weekly_funnel_review",
      name: "Legacy weekly funnel review",
      enabled: true,
      runner: {
        provider: "codex",
        repository: "https://github.com/example/workflow-app",
        default_branch: "main",
        mode: "draft_only",
      },
      trigger: {
        kind: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/Helsinki",
        report_kind: "funnel_review",
        start_window_seconds: 900,
      },
      report_plan: {
        blueprint_id: "ordered_funnel_period_compare",
        params: {
          scheduled_for: { source: "schedule", field: "scheduled_for" },
          period_days: 7,
          funnel_events_json:
            "[\"account_created\",\"project_created\",\"subscription_started\",\"first_value_reached\"]",
          minimum_sample_size: 25,
        },
        period: { lookback_seconds: 604_800 },
      },
      allowed_actions: ["record_report"],
      scope: {},
      escalation: {
        destination: "project owner",
        instructions: "Review the bounded report and decide what to change.",
      },
    }],
  });
}

function workflowUrl(projectId: string, automationId = "weekly_funnel_review") {
  return `/v1/projects/${projectId}/automation-workflows/${automationId}`;
}

function auth(apiKey: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

describe("automation workflow v3 public control plane", () => {
  it("serves immutable component and data-contract catalogs only to authenticated users", async () => {
    expect((await call("/v1/automation-workflow-components")).status).toBe(401);
    expect((await call("/v1/automation-workflow-contracts")).status).toBe(401);

    const { owner, project } = await setupProject();
    const member = await addMember(project.id, owner.user_id);
    const componentsResponse = await call("/v1/automation-workflow-components", {
      headers: auth(member.api_key),
    });
    const contractsResponse = await call("/v1/automation-workflow-contracts", {
      headers: auth(member.api_key),
    });

    expect(componentsResponse.status).toBe(200);
    const components = (await componentsResponse.json()) as any;
    expect(components).toMatchObject({
      kind: "automation_workflow_component_catalog",
      version_policy: "immutable_semver",
    });
    expect(components.count).toBeGreaterThan(0);
    expect(components.components[0].component_hash).toMatch(/^[a-f0-9]{64}$/);

    expect(contractsResponse.status).toBe(200);
    const contracts = (await contractsResponse.json()) as any;
    expect(contracts).toMatchObject({
      kind: "automation_workflow_data_contract_catalog",
      version_policy: "immutable_integer",
    });
    expect(contracts.count).toBeGreaterThan(0);
    expect(contracts.contracts[0].schema_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("lets a member compile without writes and rejects secret material before reflection", async () => {
    const { owner, project } = await setupProject();
    const member = await addMember(project.id, owner.user_id);
    const compileUrl = `/v1/projects/${project.id}/automation-workflows/compile`;

    const compiledResponse = await call(compileUrl, {
      method: "POST",
      headers: auth(member.api_key),
      json: weeklyWorkflow(),
    });
    expect(compiledResponse.status).toBe(200);
    const compiled = (await compiledResponse.json()) as any;
    expect(compiled).toMatchObject({
      success: true,
      data: {
        kind: "automation_workflow_compile",
        schema_version: "3",
        candidate: { enabled: false },
        readiness: { ready_to_enable: false },
        compile_side_effects: {
          database_writes: false,
          workflow_saved: false,
          workflow_enabled: false,
        },
      },
    });

    const invalid = weeklyWorkflow();
    invalid.entry = "missing_trigger";
    const invalidResponse = await call(compileUrl, {
      method: "POST",
      headers: auth(member.api_key),
      json: invalid,
    });
    expect(invalidResponse.status).toBe(200);
    const invalidResult = (await invalidResponse.json()) as any;
    expect(invalidResult.success).toBe(false);
    expect(invalidResult.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "entry_not_found" }),
    ]));

    const secret = `github_pat_${"DO_NOT_REFLECT_THIS_SECRET".repeat(2)}`;
    const secretWorkflow = weeklyWorkflow();
    secretWorkflow.description = `Never persist ${secret} here.`;
    const secretResponse = await call(compileUrl, {
      method: "POST",
      headers: auth(member.api_key),
      json: secretWorkflow,
    });
    expect(secretResponse.status).toBe(400);
    const secretText = await secretResponse.text();
    expect(secretText).not.toContain(secret);
    expect(secretText).not.toContain("DO_NOT_REFLECT_THIS_SECRET");
    expect(JSON.parse(secretText)).toMatchObject({
      error: {
        code: "invalid_payload",
        details: {
          reason: "automation workflows must not contain secrets or credentials",
        },
      },
    });

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    expect(await db.select().from(automationWorkflows)).toHaveLength(0);
    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(0);
  });

  it("keeps compilation on the human project boundary", async () => {
    const { project } = await setupProject();
    const other = await setupProject();
    const compileUrl = `/v1/projects/${project.id}/automation-workflows/compile`;
    const runner = await createTestProjectCredential(
      env,
      project.id,
      "automation_runner",
      "weekly_funnel_review",
    );
    const ci = await createTestProjectCredential(env, project.id, "ci_deploy");

    for (const credential of [runner.credential, ci.credential]) {
      const response = await call(compileUrl, {
        method: "POST",
        headers: auth(credential),
        json: weeklyWorkflow(),
      });
      expect(response.status).toBe(401);
    }

    const crossProject = await call(compileUrl, {
      method: "POST",
      headers: auth(other.owner.api_key),
      json: weeklyWorkflow(),
    });
    expect(crossProject.status).toBe(403);
  });

  it("allows only an owner to save, requires URL/body id equality, and lets a member read with ETag", async () => {
    const { owner, project } = await setupProject();
    const member = await addMember(project.id, owner.user_id);
    const workflow = weeklyWorkflow();

    const memberSave = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(member.api_key),
      json: workflow,
    });
    expect(memberSave.status).toBe(403);

    const mismatch = await call(workflowUrl(project.id, "another_workflow"), {
      method: "PUT",
      headers: auth(owner.api_key),
      json: workflow,
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({
      error: {
        code: "invalid_payload",
        details: {
          automation_id: "another_workflow",
          workflow_id: "weekly_funnel_review",
        },
      },
    });

    const savedResponse = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key),
      json: workflow,
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as any;
    expect(saved).toMatchObject({
      kind: "automation_workflow",
      schema_version: "3",
      automation_id: "weekly_funnel_review",
      revision: 1,
      created: true,
      enabled: false,
      active_revision_id: null,
    });
    expect(savedResponse.headers.get("etag")).toBe(saved.etag);

    const memberRead = await call(workflowUrl(project.id), {
      headers: auth(member.api_key),
    });
    expect(memberRead.status).toBe(200);
    expect(memberRead.headers.get("etag")).toBe(saved.etag);
    expect(await memberRead.json()).toMatchObject({
      automation_id: "weekly_funnel_review",
      revision_id: saved.revision_id,
      etag: saved.etag,
      enabled: false,
    });

    const missing = await call(workflowUrl(project.id, "missing_workflow"), {
      headers: auth(member.api_key),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const legacyValidation = await call(
      `/v1/projects/${project.id}/automation-contract/validate`,
      {
        method: "POST",
        headers: auth(owner.api_key),
        json: legacyWeeklyContract(),
      },
    );
    expect(legacyValidation.status).toBe(200);
    expect(await legacyValidation.json()).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "automation_id_namespace_conflict",
          path: "automations.weekly_funnel_review.id",
        }),
      ]),
    });
  });

  it("uses exact strong ETags for every replacement and keeps replacements disabled", async () => {
    const { owner, project } = await setupProject();
    const firstResponse = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key),
      json: weeklyWorkflow(),
    });
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as any;

    const replacement = weeklyWorkflow();
    replacement.name = "Weekly activation funnel review v2";
    const missingIfMatch = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key),
      json: replacement,
    });
    expect(missingIfMatch.status).toBe(428);

    const malformedIfMatch = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key, { "if-match": first.etag.slice(1, -1) }),
      json: replacement,
    });
    expect(malformedIfMatch.status).toBe(400);
    expect(await malformedIfMatch.json()).toMatchObject({
      error: { code: "invalid_payload" },
    });

    const staleIfMatch = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key, { "if-match": `"${"f".repeat(64)}"` }),
      json: replacement,
    });
    expect(staleIfMatch.status).toBe(412);

    const replacedResponse = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key, { "if-match": first.etag }),
      json: replacement,
    });
    expect(replacedResponse.status).toBe(200);
    const replaced = (await replacedResponse.json()) as any;
    expect(replaced).toMatchObject({
      revision: 2,
      created: false,
      enabled: false,
      active_revision_id: null,
    });
    expect(replaced.etag).not.toBe(first.etag);
    expect(replacedResponse.headers.get("etag")).toBe(replaced.etag);
    expect(await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(automationWorkflowRevisions)).toHaveLength(2);
  });

  it("honors the project deletion fence and exposes only canonical fail-closed production routes", async () => {
    const { owner, project } = await setupProject();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(projectDeletionFences).values({
      projectId: project.id,
      commandId: `delete-${project.id}`,
      reason: "project_delete",
      actor: owner.user_id,
      createdAt: Math.floor(Date.now() / 1_000),
    });

    const fenced = await call(workflowUrl(project.id), {
      method: "PUT",
      headers: auth(owner.api_key),
      json: weeklyWorkflow(),
    });
    expect(fenced.status).toBe(409);
    expect(await fenced.json()).toMatchObject({
      error: { code: "project_deletion_in_progress" },
    });
    expect(await db.select().from(automationWorkflows)).toHaveLength(0);
    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(0);

    const enable = await call(`${workflowUrl(project.id)}/enable`, {
      method: "POST",
      headers: auth(owner.api_key),
      json: {},
    });
    const runs = await call(`${workflowUrl(project.id)}/runs`, {
      headers: auth(owner.api_key),
    });
    const staleSingularAlias = await call(`${workflowUrl(project.id)}/run`, {
      method: "POST",
      headers: auth(owner.api_key),
      json: {},
    });
    expect(enable.status).toBe(428);
    expect(runs.status).toBe(200);
    expect(await runs.json()).toMatchObject({
      kind: "automation_workflow_run_list",
      automation_id: "weekly_funnel_review",
      runs: [],
    });
    expect(staleSingularAlias.status).toBe(404);
  });
});
