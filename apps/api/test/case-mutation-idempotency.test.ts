import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  caseMutationCommands,
  cases,
  webhookDeliveries,
} from "@agentry/db/schema";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");

describe("case PATCH durable command receipts", () => {
  let env: TestEnv;
  let app: ReturnType<typeof createApp>;
  let realFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    env = await makeTestEnv({ withEncKey: true });
    app = createApp();
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch;
  });

  afterEach(async () => {
    await settleBackgroundDeliveries();
    globalThis.fetch = realFetch;
    vi.clearAllMocks();
  });

  it("replays an exact lost response with the old If-Match without reapplying state or outbox", async () => {
    const fixture = await setupCase("exact-replay");

    const first = await patchCase(fixture, {
      key: "case-command-exact-replay-0001",
      revision: 1,
      body: { agent_summary: "fixed once", pr_url: "https://github.com/example/app/pull/1" },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"2"');
    expect(await first.json()).toMatchObject({
      revision: 2,
      status: "active",
      agent_summary: "fixed once",
      idempotent_replay: false,
    });

    const replay = await patchCase(fixture, {
      key: "case-command-exact-replay-0001",
      revision: 1,
      body: { agent_summary: "fixed once", pr_url: "https://github.com/example/app/pull/1" },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("etag")).toBe('"2"');
    expect(await replay.json()).toMatchObject({
      revision: 2,
      status: "active",
      agent_summary: "fixed once",
      idempotent_replay: true,
    });

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, fixture.caseId));
    const commands = await db
      .select()
      .from(caseMutationCommands)
      .where(eq(caseMutationCommands.caseId, fixture.caseId));
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.projectId, fixture.projectId));
    expect(caseRow).toMatchObject({
      revision: 2,
      status: "active",
      agentSummary: "fixed once",
      prUrl: "https://github.com/example/app/pull/1",
    });
    expect(commands).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  it("rejects changed payload reuse before treating the old If-Match as stale", async () => {
    const fixture = await setupCase("changed-reuse");
    const first = await patchCase(fixture, {
      key: "case-command-changed-reuse-0001",
      revision: 1,
      body: { agent_summary: "first annotation" },
    });
    expect(first.status).toBe(200);

    const changed = await patchCase(fixture, {
      key: "case-command-changed-reuse-0001",
      revision: 1,
      body: { agent_summary: "changed annotation" },
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "idempotency_key_reused" },
    });
  });

  it("returns one committed result for concurrent exact retries", async () => {
    const fixture = await setupCase("concurrent");
    const request = {
      key: "case-command-concurrent-retry-0001",
      revision: 1,
      body: { agent_summary: "one owner command" },
    } as const;

    const responses = await Promise.all([
      patchCase(fixture, request),
      patchCase(fixture, request),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as Array<{
      revision: number;
      idempotent_replay: boolean;
    }>;
    expect(bodies.map((body) => body.revision)).toEqual([2, 2]);
    expect(bodies.map((body) => body.idempotent_replay).sort()).toEqual([false, true]);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    expect(await db.select().from(caseMutationCommands)).toHaveLength(1);
    expect(
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.projectId, fixture.projectId)),
    ).toHaveLength(0);
    expect((await db.select().from(cases).where(eq(cases.id, fixture.caseId)))[0])
      .toMatchObject({ revision: 2, status: "active", agentSummary: "one owner command" });
  });

  it("rolls the annotation back when the command receipt cannot persist", async () => {
    const fixture = await setupCase("receipt-rollback");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.run(sql`
      CREATE TRIGGER reject_case_mutation_receipt
      BEFORE INSERT ON case_mutation_commands
      BEGIN
        SELECT RAISE(ABORT, 'forced command receipt failure');
      END
    `);

    const failed = await patchCase(fixture, {
      key: "case-command-receipt-rollback-0001",
      revision: 1,
      body: { agent_summary: "must roll back" },
    });
    expect(failed.status).toBe(500);
    expect((await db.select().from(cases).where(eq(cases.id, fixture.caseId)))[0])
      .toMatchObject({ revision: 1, status: "active", agentSummary: null });
    expect(await db.select().from(caseMutationCommands)).toHaveLength(0);
    expect(
      await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.projectId, fixture.projectId)),
    ).toHaveLength(0);

    await db.run(sql`DROP TRIGGER reject_case_mutation_receipt`);
    const retry = await patchCase(fixture, {
      key: "case-command-receipt-rollback-0001",
      revision: 1,
      body: { agent_summary: "must roll back" },
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      revision: 2,
      status: "active",
      agent_summary: "must roll back",
      idempotent_replay: false,
    });
  });

  it("rejects provider lifecycle fields instead of silently ignoring them", async () => {
    const fixture = await setupCase("provider-lifecycle-rejected");
    const response = await patchCase(fixture, {
      key: "case-provider-lifecycle-rejected-0001",
      revision: 1,
      body: { status: "resolved", agent_summary: "Attempted lifecycle write." },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_payload" },
    });
    const [row] = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(cases)
      .where(eq(cases.id, fixture.caseId));
    expect(row).toMatchObject({ revision: 1, status: "active", agentSummary: null });
  });

  async function setupCase(label: string): Promise<{
    apiKey: string;
    projectId: string;
    caseId: string;
  }> {
    const login = await call("/v1/auth/_test/login", {
      method: "POST",
      json: { email: `case-command-${label}@example.com` },
    });
    expect(login.status).toBe(200);
    const { api_key: apiKey } = await login.json() as { api_key: string };
    const project = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `case-command-project-${crypto.randomUUID()}`,
      },
      json: { name: `case-command-${label}` },
    });
    expect(project.status).toBe(200);
    const { id: projectId } = await project.json() as { id: string };
    const caseId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1_000);
    await getDbForUrl(env.TURSO_DATABASE_URL).insert(cases).values({
      id: caseId,
      projectId,
      providerIssueId: caseId,
      providerSnapshotHash: "a".repeat(64),
      providerProjectedAt: now,
      providerEventClassification: "customer_exception",
      fingerprint: caseId,
      errorType: "CaseCommandError",
      message: `case command ${label}`,
      status: "active",
      eventCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
      revision: 1,
    });
    return { apiKey, projectId, caseId };
  }

  async function patchCase(
    fixture: { apiKey: string; caseId: string },
    input: { key: string; revision: number; body: Record<string, unknown> },
  ): Promise<Response> {
    return call(`/v1/cases/${fixture.caseId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${fixture.apiKey}`,
        "idempotency-key": input.key,
        "if-match": `"${input.revision}"`,
      },
      json: input.body,
    });
  }

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
    return app.fetch(
      new Request(`http://test${path}`, {
        method: init?.method ?? "GET",
        headers,
        body,
      }),
      env,
    );
  }

  async function settleBackgroundDeliveries(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await getDbForUrl(env.TURSO_DATABASE_URL)
        .select({ status: webhookDeliveries.status })
        .from(webhookDeliveries);
      if (rows.every((row) => row.status !== "pending" && row.status !== "delivering")) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});
