import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { projectCredentials } from "@agentry/db/schema";
import { buildWeeklyFunnelReviewWorkflow } from "../src/automation-workflow-presets.js";
import {
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

function authorization(apiKey: string, idempotencyKey?: string) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
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

async function setupWorkflow() {
  const login = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email: `workflow-credential-${crypto.randomUUID()}@example.test` },
  });
  expect(login.status).toBe(200);
  const owner = await login.json() as { api_key: string; user_id: string };
  const created = await call("/v1/projects", {
    method: "POST",
    headers: authorization(owner.api_key, `create-project-${crypto.randomUUID()}`),
    json: {
      name: "Workflow credential compatibility",
      repo_url: "https://github.com/example/app",
      default_branch: "main",
    },
  });
  expect(created.status).toBe(200);
  const project = await created.json() as { id: string };
  const saved = await call(
    `/v1/projects/${project.id}/automation-workflows/weekly_funnel_review`,
    {
      method: "PUT",
      headers: authorization(owner.api_key),
      json: weeklyWorkflow(),
    },
  );
  expect(saved.status).toBe(200);
  return { owner, project };
}

async function createRunner(
  apiKey: string,
  projectId: string,
  idempotencyKey: string,
  name: string,
) {
  return call(`/v1/projects/${projectId}/credentials`, {
    method: "POST",
    headers: authorization(apiKey, idempotencyKey),
    json: {
      kind: "automation_runner",
      name,
      automation_id: "weekly_funnel_review",
    },
  });
}

describe("workflow v3 runner credential compatibility", () => {
  it("binds the existing credential API to a saved v3 id and preserves singular active authority", async () => {
    const { owner, project } = await setupWorkflow();

    const firstResponse = await createRunner(
      owner.api_key,
      project.id,
      "workflow-runner-first",
      "weekly funnel runner",
    );
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as {
      id: string;
      credential: string;
      automation_id: string;
      runner_id: string;
      active: boolean;
    };
    expect(first).toMatchObject({
      automation_id: "weekly_funnel_review",
      runner_id: `credential:${first.id}`,
      active: true,
    });
    expect(first.credential).toMatch(/^agentry_runner_/);

    const duplicateResponse = await createRunner(
      owner.api_key,
      project.id,
      "workflow-runner-duplicate",
      "unintended second runner",
    );
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toMatchObject({
      error: {
        code: "automation_workflow_runner_credential_exists",
        details: {
          automation_id: "weekly_funnel_review",
          active_credentials: [{ credential_id: first.id }],
        },
      },
    });

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
    const now = Number(clock.rows[0]?.now_seconds ?? 0);
    const activeBefore = await db.select().from(projectCredentials).where(and(
      eq(projectCredentials.projectId, project.id),
      eq(projectCredentials.kind, "automation_runner"),
      eq(projectCredentials.automationId, "weekly_funnel_review"),
      isNull(projectCredentials.revokedAt),
      gt(projectCredentials.expiresAt, now),
    ));
    expect(activeBefore).toHaveLength(1);

    const revoke = await call(`/v1/project-credentials/${first.id}/revoke`, {
      method: "POST",
      headers: authorization(owner.api_key, "workflow-runner-revoke"),
      json: { reason: "Rotate the workflow runner deliberately." },
    });
    expect(revoke.status).toBe(200);

    const replacementResponse = await createRunner(
      owner.api_key,
      project.id,
      "workflow-runner-replacement",
      "replacement weekly funnel runner",
    );
    expect(replacementResponse.status).toBe(200);
    const replacement = await replacementResponse.json() as { id: string; credential: string };
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.credential).toMatch(/^agentry_runner_/);

    const activeAfter = await db.select().from(projectCredentials).where(and(
      eq(projectCredentials.projectId, project.id),
      eq(projectCredentials.kind, "automation_runner"),
      eq(projectCredentials.automationId, "weekly_funnel_review"),
      isNull(projectCredentials.revokedAt),
      gt(projectCredentials.expiresAt, now),
    ));
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter[0]?.id).toBe(replacement.id);
  });
});
