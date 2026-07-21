import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "@agentrysh/shared";
import {
  auditLog,
  projectMemberships,
  publicQueryPublications,
} from "@agentry/db/schema";
import { __clearRateLimitForTests } from "../src/rate-limit.js";
import { disposeTestEnv, getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

const runHogQlMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>("../src/posthog.js");
  return {
    ...actual,
    isPosthogConfigured: () => true,
    ensurePosthogForProject: async () => ({ posthogProjectId: 4242, provisioned: false }),
    runHogQl: (...args: unknown[]) => runHogQlMock(...args),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = createApp();
  runHogQlMock.mockReset();
  runHogQlMock.mockResolvedValue({
    columns: ["day", "dau"],
    types: ["Date", "UInt64"],
    results: [["2026-05-20", 5]],
  });
  __clearRateLimitForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  __clearRateLimitForTests();
  disposeTestEnv(env);
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  const method = init?.method ?? "GET";
  if (
    !headers.has("idempotency-key") &&
    ((method === "POST" && /^\/v1\/projects\/[^/]+\/public-queries$/.test(path)) ||
      (method === "DELETE" && /^\/v1\/projects\/[^/]+\/public-queries\/[^/]+$/.test(path)))
  ) {
    headers.set("idempotency-key", `public-query-test-${crypto.randomUUID()}`);
  }
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`http://test${path}`, {
      method,
      headers,
      body,
    }),
    env,
  );
}

async function signup(
  email: string,
): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    api_key: string;
    user_id: string;
  };
  expect(data).not.toHaveProperty("public_api_key");
  return {
    apiKey: data.api_key,
    userId: data.user_id,
  };
}

async function createProject(
  apiKey: string,
  name: string,
): Promise<{ id: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: { name },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function addMember(
  projectId: string,
  ownerUserId: string,
  memberUserId: string,
  role: "owner" | "member" = "member",
): Promise<void> {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(projectMemberships).values({
    id: uuidv7(),
    projectId,
    userId: memberUserId,
    role,
    invitedBy: ownerUserId,
    createdAt: Math.floor(Date.now() / 1000),
  });
}

describe("public query publications", () => {
  it("commits publication state and audit history atomically", async () => {
    const owner = await signup("public-atomic-owner@example.com");
    const project = await createProject(owner.apiKey, "public-atomic-dashboard");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);

    await db.run(sql`
      CREATE TRIGGER reject_publication_mint_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'publication.minted'
      BEGIN
        SELECT RAISE(ABORT, 'forced publication audit failure');
      END
    `);
    const failedPublish = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 7 } },
    });
    expect(failedPublish.status).toBe(500);
    expect(await db.select().from(publicQueryPublications).where(
      eq(publicQueryPublications.projectId, project.id),
    )).toHaveLength(0);
    expect((await db.select().from(auditLog).where(eq(auditLog.projectId, project.id)))
      .filter((row) => row.action === "publication.minted")).toHaveLength(0);

    await db.run(sql`DROP TRIGGER reject_publication_mint_audit`);
    const published = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 7 } },
    });
    expect(published.status).toBe(200);
    const publication = await published.json() as { id: string };

    await db.run(sql`
      CREATE TRIGGER reject_publication_revoke_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'publication.revoked'
      BEGIN
        SELECT RAISE(ABORT, 'forced publication revoke audit failure');
      END
    `);
    const failedRevoke = await call(
      `/v1/projects/${project.id}/public-queries/${publication.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${owner.apiKey}` } },
    );
    expect(failedRevoke.status).toBe(500);
    const afterFailedRevoke = (await db.select().from(publicQueryPublications).where(
      eq(publicQueryPublications.id, publication.id),
    ))[0];
    expect(afterFailedRevoke?.revokedAt).toBeNull();

    await db.run(sql`DROP TRIGGER reject_publication_revoke_audit`);
    const revoked = await call(
      `/v1/projects/${project.id}/public-queries/${publication.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${owner.apiKey}` } },
    );
    expect(revoked.status).toBe(200);
  });

  it("publishes, lists, serves, and revokes a public query", async () => {
    const owner = await signup("public-owner@example.com");
    const project = await createProject(owner.apiKey, "public-dashboard");

    const publish = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: {
        blueprint_id: "active_users_daily",
        params: { days: 7 },
        description: "Daily active users for the public status page",
      },
    });
    expect(publish.status).toBe(200);
    const publication = (await publish.json()) as {
      id: string;
      blueprint_id: string;
      public_url: string;
      description: string | null;
      publication_safety: {
        status: string;
        public_access: string;
        identifier_columns: string[];
      };
    };
    expect(publication.blueprint_id).toBe("active_users_daily");
    expect(publication.description).toContain("public status page");
    expect(publication.publication_safety).toEqual(expect.objectContaining({
      status: "safe_aggregate",
      public_access: "allowed",
      identifier_columns: [],
    }));

    const list = await call(`/v1/projects/${project.id}/public-queries`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as {
      count: number;
      publications: Array<{ id: string; blueprint_id: string }>;
    };
    expect(listJson.count).toBe(1);
    expect(listJson.publications[0]?.id).toBe(publication.id);

    const publicPath = new URL(publication.public_url).pathname;
    const served = await call(publicPath);
    expect(served.status).toBe(200);
    const servedJson = (await served.json()) as {
      publication_id: string;
      blueprint_id: string;
      columns: string[];
      rows: Array<{ day: string; dau: number }>;
      row_count: number;
      freshness?: {
        source: string;
        consistency: string;
        cache_bust: boolean;
        retry_after_ms: number;
        next_action: string;
      };
      publication_safety: {
        status: string;
        public_access: string;
      };
      results?: unknown;
    };
    expect(servedJson.publication_id).toBe(publication.id);
    expect(servedJson.blueprint_id).toBe("active_users_daily");
    expect(servedJson.columns).toEqual(["day", "dau"]);
    expect(servedJson.rows).toEqual([{ day: "2026-05-20", dau: 5 }]);
    expect(servedJson.row_count).toBe(1);
    expect(servedJson.publication_safety).toEqual(expect.objectContaining({
      status: "safe_aggregate",
      public_access: "allowed",
    }));
    expect(servedJson.freshness).toEqual(expect.objectContaining({
      source: "posthog_hogql",
      consistency: "eventual",
      cache_bust: true,
      retry_after_ms: 30000,
    }));
    expect(servedJson.freshness?.next_action).toContain("fetch this same public URL again");
    expect(servedJson.results).toBeUndefined();
    expect(runHogQlMock).toHaveBeenCalledWith(
      expect.anything(),
      project.id,
      expect.any(String),
      { cacheBust: true },
    );

    const revoke = await call(`/v1/projects/${project.id}/public-queries/${publication.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(revoke.status).toBe(200);

    const afterRevoke = await call(publicPath);
    expect(afterRevoke.status).toBe(410);
  });

  it("lets members list publications but not create them, while the returned URL is directly public", async () => {
    const owner = await signup("owner-team@example.com");
    const member = await signup("member-team@example.com");
    const project = await createProject(owner.apiKey, "shared-dashboard");

    await addMember(project.id, owner.userId, member.userId);

    const publish = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 14 } },
    });
    expect(publish.status).toBe(200);
    const publication = (await publish.json()) as { id: string; public_url: string };

    const list = await call(`/v1/projects/${project.id}/public-queries`, {
      headers: { authorization: `Bearer ${member.apiKey}` },
    });
    expect(list.status).toBe(200);

    const memberAudit = await call(
      `/v1/audit/recent?project_id=${project.id}&action_prefix=publication.`,
      { headers: { authorization: `Bearer ${member.apiKey}` } },
    );
    expect(memberAudit.status).toBe(200);
    const memberAuditJson = (await memberAudit.json()) as {
      count: number;
      actions: Array<{ actor: { type: string; id: string } }>;
      data_boundary: { instruction_authority: string };
    };
    expect(memberAuditJson.count).toBe(1);
    expect(memberAuditJson.actions[0]?.actor).toEqual({ type: "user", id: owner.userId });
    expect(memberAuditJson.data_boundary.instruction_authority).toBe("none");

    const memberCreate = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${member.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 14 } },
    });
    expect(memberCreate.status).toBe(403);

    const publicPath = new URL(publication.public_url).pathname;
    const noKey = await call(publicPath);
    expect(noKey.status).toBe(200);
  });

  it("attributes publication mutations to the authenticated co-owner", async () => {
    const creator = await signup("publication-creator@example.com");
    const coOwner = await signup("publication-co-owner@example.com");
    const project = await createProject(creator.apiKey, "co-owned-publication");
    await addMember(project.id, creator.userId, coOwner.userId, "owner");

    const publish = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${coOwner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 7 } },
    });
    expect(publish.status).toBe(200);
    const publication = await publish.json() as { id: string };

    const revoke = await call(
      `/v1/projects/${project.id}/public-queries/${publication.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${coOwner.apiKey}` } },
    );
    expect(revoke.status).toBe(200);

    const rows = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, project.id));
    const publicationRows = rows.filter((row) =>
      row.action === "publication.minted" || row.action === "publication.revoked"
    );
    expect(publicationRows).toHaveLength(2);
    expect(publicationRows.every((row) => row.userId === coOwner.userId)).toBe(true);
    expect(publicationRows.every((row) => row.userId !== creator.userId)).toBe(true);
  });

  it("validates publish payloads and exposes publication audit history", async () => {
    const owner = await signup("audited-owner@example.com");
    const project = await createProject(owner.apiKey, "audited-dashboard");

    const invalid = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: "seven" } },
    });
    expect(invalid.status).toBe(400);
    const invalidJson = (await invalid.json()) as {
      error: { code: string; details?: { reason?: string } };
    };
    expect(invalidJson.error.code).toBe("invalid_payload");
    expect(invalidJson.error.details?.reason ?? "").toContain("blueprint.params");

    const publish = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 21 } },
    });
    expect(publish.status).toBe(200);
    const publication = (await publish.json()) as { id: string };

    const revoke = await call(`/v1/projects/${project.id}/public-queries/${publication.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(revoke.status).toBe(200);

    const audit = await call("/v1/audit/recent?action_prefix=publication.&resource_type=publication", {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(audit.status).toBe(200);
    const auditJson = (await audit.json()) as {
      count: number;
      actions: Array<{ action: string; resource_id: string | null; metadata: unknown }>;
    };
    expect(auditJson.count).toBe(2);
    expect(auditJson.actions.map((entry) => entry.action)).toEqual([
      "publication.revoked",
      "publication.minted",
    ]);
    expect(auditJson.actions[1]?.resource_id).toBe(publication.id);
  });

  it("rejects non-analytics blueprint ids with server-side guidance", async () => {
    const owner = await signup("workflow-blueprint-owner@example.com");
    const project = await createProject(owner.apiKey, "workflow-blueprint-dashboard");

    const workflowBlueprint = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_cases_top", params: { limit: 10 } },
    });
    expect(workflowBlueprint.status).toBe(422);
    const workflowJson = (await workflowBlueprint.json()) as {
      error: {
        code: string;
        message: string;
        next_action?: string;
        details?: Record<string, unknown>;
      };
    };
    expect(workflowJson.error.code).toBe("unsupported_operation");
    expect(workflowJson.error.message).toContain("operational-backed");
    expect(workflowJson.error.next_action ?? "").toContain("analytics-backed query blueprints");
    expect(workflowJson.error.details?.backend).toBe("operational");

    const unknownBlueprint = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "definitely-not-a-blueprint", params: { days: 7 } },
    });
    expect(unknownBlueprint.status).toBe(404);
  });

  it("rejects identifier-bearing and arbitrary-segment analytics publications", async () => {
    const owner = await signup("private-analytics-owner@example.com");
    const project = await createProject(owner.apiKey, "private-analytics-dashboard");

    const attempts = [
      {
        blueprint_id: "funnel_dropoff_users",
        params: {
          entry_event: "onboarding_started",
          completion_event: "onboarding_completed",
          days: 7,
          limit: 25,
        },
        status: "private_identifiers",
        violation: "identifier_columns",
      },
      {
        blueprint_id: "funnel_3_step_by_property",
        params: {
          step1: "page_view",
          step2: "signup_started",
          step3: "signup_completed",
          segment_property: "email",
          days: 30,
        },
        status: "private_dynamic_segment",
        violation: "arbitrary_segment_property",
      },
    ];

    for (const attempt of attempts) {
      const response = await call(`/v1/projects/${project.id}/public-queries`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner.apiKey}` },
        json: {
          blueprint_id: attempt.blueprint_id,
          params: attempt.params,
        },
      });
      expect(response.status).toBe(422);
      const json = (await response.json()) as {
        error: {
          code: string;
          message: string;
          next_action?: string;
          details?: {
            publication_safety?: { status?: string; public_access?: string };
            publication_safety_violations?: string[];
          };
        };
      };
      expect(json.error.code).toBe("unsupported_operation");
      expect(json.error.message).toContain("publication_safety");
      expect(json.error.next_action).toContain("owner-authenticated");
      expect(json.error.details?.publication_safety).toEqual(expect.objectContaining({
        status: attempt.status,
        public_access: "denied",
      }));
      expect(json.error.details?.publication_safety_violations).toContain(
        attempt.violation,
      );
    }

    const list = await call(`/v1/projects/${project.id}/public-queries`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(expect.objectContaining({ count: 0, publications: [] }));

    // Fail closed for a publication minted before this policy existed (or
    // inserted out of band): the public read must not execute its HogQL.
    const legacyPublicationId = uuidv7();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(publicQueryPublications).values({
      id: legacyPublicationId,
      userId: owner.userId,
      projectId: project.id,
      recipeId: "funnel_dropoff_users",
      paramsJson: JSON.stringify(attempts[0]?.params ?? {}),
      createdAt: Math.floor(Date.now() / 1000),
    });
    runHogQlMock.mockClear();

    const legacyRead = await call(`/v1/public/q/${legacyPublicationId}`);
    expect(legacyRead.status).toBe(422);
    const legacyJson = (await legacyRead.json()) as {
      error: { code: string; details?: { publication_safety_violations?: string[] } };
    };
    expect(legacyJson.error.code).toBe("unsupported_operation");
    expect(legacyJson.error.details?.publication_safety_violations).toContain(
      "identifier_columns",
    );
    expect(runHogQlMock).not.toHaveBeenCalled();
  });

  it("rate-limits hot public dashboards per publication and IP", async () => {
    const owner = await signup("rate-limit-owner@example.com");
    const project = await createProject(owner.apiKey, "rate-limited-dashboard");

    const publish = await call(`/v1/projects/${project.id}/public-queries`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.apiKey}` },
      json: { blueprint_id: "active_users_daily", params: { days: 3 } },
    });
    expect(publish.status).toBe(200);
    const publication = (await publish.json()) as { public_url: string };
    const publicPath = new URL(publication.public_url).pathname;

    for (let i = 0; i < 60; i++) {
      const okRes = await call(publicPath, {
        headers: { "x-real-ip": "203.0.113.9" },
      });
      expect(okRes.status).toBe(200);
    }

    const limited = await call(publicPath, {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    const limitedJson = (await limited.json()) as { error: { code: string } };
    expect(limitedJson.error.code).toBe("rate_limited");
  });
});
