import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accountDeletionFences,
  alerts,
  feedback,
  mutationCommands,
  projectDeletionFences,
  projects,
  publicQueryPublications,
  webhooks,
} from "@agentry/db/schema";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", () => ({
  getDb: (env: { TURSO_DATABASE_URL: string }) => getDbForUrl(env.TURSO_DATABASE_URL),
}));

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ enableTestLogin: true, withEncKey: true, fileDb: true });
  app = createApp();
});

async function call(
  path: string,
  init: { method?: string; apiKey?: string; idempotencyKey?: string; body?: unknown } = {},
) {
  const headers = new Headers();
  if (init.apiKey) headers.set("authorization", `Bearer ${init.apiKey}`);
  if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://test${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }), env);
}

async function signup(email: string) {
  const response = await call("/v1/auth/_test/login", { body: { email } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ api_key: string; user_id: string }>;
}

async function createProject(apiKey: string, key = `project-${crypto.randomUUID()}`) {
  const response = await call("/v1/projects", {
    apiKey,
    idempotencyKey: key,
    body: { name: "mutation replay project" },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string; idempotent_replay: boolean }>;
}

describe("local mutation exact replay", () => {
  it("replays publication mint/revoke and rejects changed evidence", async () => {
    const owner = await signup("publication-replay@example.com");
    const project = await createProject(owner.api_key);
    const mintKey = "publication-mint-replay-1";
    const body = { blueprint_id: "active_users_daily", params: { days: 7 }, description: "weekly view" };
    const first = await call(`/v1/projects/${project.id}/public-queries`, {
      apiKey: owner.api_key,
      idempotencyKey: mintKey,
      body,
    });
    const replay = await call(`/v1/projects/${project.id}/public-queries`, {
      apiKey: owner.api_key,
      idempotencyKey: mintKey,
      body,
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = await first.json() as { id: string; public_url: string };
    expect(await replay.json()).toMatchObject({
      id: firstBody.id,
      public_url: firstBody.public_url,
      idempotent_replay: true,
    });
    const changed = await call(`/v1/projects/${project.id}/public-queries`, {
      apiKey: owner.api_key,
      idempotencyKey: mintKey,
      body: { ...body, description: "changed" },
    });
    expect(changed.status).toBe(409);

    const revokeKey = "publication-revoke-replay-1";
    const revokePath = `/v1/projects/${project.id}/public-queries/${firstBody.id}`;
    const revoked = await call(revokePath, {
      method: "DELETE",
      apiKey: owner.api_key,
      idempotencyKey: revokeKey,
    });
    const revokeReplay = await call(revokePath, {
      method: "DELETE",
      apiKey: owner.api_key,
      idempotencyKey: revokeKey,
    });
    expect(revoked.status).toBe(200);
    expect(revokeReplay.status).toBe(200);
    expect(await revokeReplay.json()).toMatchObject({ id: firstBody.id, idempotent_replay: true });
    const rows = await getDbForUrl(env.TURSO_DATABASE_URL).select()
      .from(publicQueryPublications).where(eq(publicQueryPublications.projectId, project.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it("replays alert and feedback creates without duplicates", async () => {
    const owner = await signup("local-replay@example.com");
    const project = await createProject(owner.api_key);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);

    const cases: Array<{
      path: string;
      key: string;
      body: Record<string, unknown>;
      changedBody: Record<string, unknown>;
      table: { count: () => Promise<number> };
    }> = [
      {
        path: `/v1/projects/${project.id}/alerts`,
        key: "alert-create-replay-1",
        body: {
          name: "open cases",
          blueprint_id: "active_users_daily",
          threshold_column: "dau",
          threshold_op: "gt",
          threshold_value: 0,
        },
        changedBody: {
          name: "changed alert",
          blueprint_id: "active_users_daily",
          threshold_column: "dau",
          threshold_op: "gt",
          threshold_value: 0,
        },
        table: { count: async () => (await db.select().from(alerts).where(eq(alerts.projectId, project.id))).length },
      },
      {
        path: "/v1/feedback",
        key: "feedback-create-replay-1",
        body: { project_id: project.id, kind: "bug", message: "one durable feedback item" },
        changedBody: { project_id: project.id, kind: "bug", message: "changed feedback" },
        table: { count: async () => (await db.select().from(feedback).where(eq(feedback.projectId, project.id))).length },
      },
    ];

    for (const testCase of cases) {
      const first = await call(testCase.path, {
        apiKey: owner.api_key,
        idempotencyKey: testCase.key,
        body: testCase.body,
      });
      const replay = await call(testCase.path, {
        apiKey: owner.api_key,
        idempotencyKey: testCase.key,
        body: testCase.body,
      });
      expect(first.status, testCase.path).toBe(200);
      expect(replay.status, testCase.path).toBe(200);
      const firstBody = await first.json() as { id?: string; invite_id?: string; invite_url?: string };
      expect(await replay.json()).toMatchObject({
        ...(firstBody.id ? { id: firstBody.id } : { invite_id: firstBody.invite_id }),
        ...(firstBody.invite_url ? { invite_url: firstBody.invite_url } : {}),
        idempotent_replay: true,
      });
      expect(await testCase.table.count(), testCase.path).toBe(1);
      const changed = await call(testCase.path, {
        apiKey: owner.api_key,
        idempotencyKey: testCase.key,
        body: testCase.changedBody,
      });
      expect(changed.status, testCase.path).toBe(409);
    }
  });

  it("linearizes project creation against the account-deletion fence and preserves exact retry", async () => {
    const owner = await signup("project-fence@example.com");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(accountDeletionFences).values({
      userId: owner.user_id,
      commandId: "account-delete-fence-command",
    });
    const key = "project-create-after-account-fence";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call("/v1/projects", {
        apiKey: owner.api_key,
        idempotencyKey: key,
        body: { name: "must not exist" },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "account_deletion_in_progress" } });
    }
    expect(await db.select().from(projects).where(eq(projects.userId, owner.user_id))).toHaveLength(0);
    expect(await db.select().from(mutationCommands).where(and(
      eq(mutationCommands.actorUserId, owner.user_id),
      eq(mutationCommands.action, "project.create"),
    ))).toHaveLength(0);
  });

  it("has one legal winner when project creation races the account fence", async () => {
    const owner = await signup("project-fence-race@example.com");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const key = "project-create-account-fence-race";
    const createPromise = call("/v1/projects", {
      apiKey: owner.api_key,
      idempotencyKey: key,
      body: { name: "race project" },
    });
    const fencePromise = db.insert(accountDeletionFences).values({
      userId: owner.user_id,
      commandId: "account-delete-race-command",
    }).onConflictDoNothing();
    const [response] = await Promise.all([createPromise, fencePromise]);
    expect([200, 409]).toContain(response.status);
    const created = await db.select().from(projects).where(eq(projects.userId, owner.user_id));
    const commands = await db.select().from(mutationCommands).where(and(
      eq(mutationCommands.actorUserId, owner.user_id),
      eq(mutationCommands.action, "project.create"),
    ));
    if (response.status === 200) {
      const first = await response.json() as { id: string };
      expect(created).toHaveLength(1);
      expect(commands).toHaveLength(1);
      const lostResponseRetry = await call("/v1/projects", {
        apiKey: owner.api_key,
        idempotencyKey: key,
        body: { name: "race project" },
      });
      expect(lostResponseRetry.status).toBe(200);
      expect(await lostResponseRetry.json()).toMatchObject({ id: first.id, idempotent_replay: true });
    } else {
      expect(created).toHaveLength(0);
      expect(commands).toHaveLength(0);
    }
  });

  it("linearizes webhook creation against a committed project-deletion fence", async () => {
    const owner = await signup("webhook-fence@example.com");
    const project = await createProject(owner.api_key);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(projectDeletionFences).values({
      projectId: project.id,
      commandId: "project-delete-fence-command",
      reason: "project_delete",
      actor: owner.user_id,
    });
    const key = "webhook-create-after-project-fence";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call(`/v1/projects/${project.id}/webhooks`, {
        apiKey: owner.api_key,
        idempotencyKey: key,
        body: { url: "https://hooks.example.com/fenced", events: ["case.created"] },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "project_deletion_in_progress" } });
    }
    expect(await db.select().from(webhooks).where(eq(webhooks.projectId, project.id))).toHaveLength(0);
    expect(await db.select().from(mutationCommands).where(and(
      eq(mutationCommands.projectId, project.id),
      eq(mutationCommands.action, "webhook.create"),
    ))).toHaveLength(0);
  });

  it("has one legal winner when webhook creation races the project fence", async () => {
    const owner = await signup("webhook-fence-race@example.com");
    const project = await createProject(owner.api_key);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const key = "webhook-create-project-fence-race";
    const createPromise = call(`/v1/projects/${project.id}/webhooks`, {
      apiKey: owner.api_key,
      idempotencyKey: key,
      body: { url: "https://hooks.example.com/race", events: ["case.created"] },
    });
    const fencePromise = db.insert(projectDeletionFences).values({
      projectId: project.id,
      commandId: "project-delete-race-command",
      reason: "project_delete",
      actor: owner.user_id,
    }).onConflictDoNothing();
    const [response] = await Promise.all([createPromise, fencePromise]);
    expect([200, 409]).toContain(response.status);
    const rows = await db.select().from(webhooks).where(eq(webhooks.projectId, project.id));
    const commands = await db.select().from(mutationCommands).where(and(
      eq(mutationCommands.projectId, project.id),
      eq(mutationCommands.action, "webhook.create"),
    ));
    expect(rows.length).toBe(response.status === 200 ? 1 : 0);
    expect(commands.length).toBe(response.status === 200 ? 1 : 0);
    const lostResponseRetry = await call(`/v1/projects/${project.id}/webhooks`, {
      apiKey: owner.api_key,
      idempotencyKey: key,
      body: { url: "https://hooks.example.com/race", events: ["case.created"] },
    });
    // Once deletion has fenced the project, retry cannot start or create a
    // second receiver even if the first side won immediately before the fence.
    expect(lostResponseRetry.status).toBe(409);
    expect(await db.select().from(webhooks).where(eq(webhooks.projectId, project.id))).toHaveLength(rows.length);
  });
});
