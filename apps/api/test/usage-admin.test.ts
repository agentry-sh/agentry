import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  cases,
  deploys,
  feedback,
  users,
} from "@agentry/db/schema";
import {
  createTestProjectCredential,
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
  env = {
    ...(await makeTestEnv({ fileDb: true })),
    ADMIN_TOKEN: "admin-secret",
  };
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
  overrideEnv: TestEnv = env,
  overrideApp: ReturnType<typeof createApp> = app,
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  const method = init?.method ?? "GET";
  if (method === "POST" && path === "/v1/feedback" && !headers.has("idempotency-key")) {
    headers.set("idempotency-key", `usage-feedback-${crypto.randomUUID()}`);
  }
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return overrideApp.fetch(
    new Request(`http://test${path}`, {
      method,
      headers,
      body,
    }),
    overrideEnv,
  );
}

async function signup(email: string): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { api_key: string; user_id: string };
  return { apiKey: data.api_key, userId: data.user_id };
}

async function createProject(apiKey: string, name: string): Promise<{ id: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: { name },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function seedRetentionRows(opts: {
  projectId: string;
  oldTs: number;
  freshTs: number;
}): Promise<void> {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(cases).values([
    {
      id: `${opts.projectId}-old-case`,
      projectId: opts.projectId,
      providerIssueId: `${opts.projectId}-old-case`,
      providerSnapshotHash: "a".repeat(64),
      providerProjectedAt: opts.oldTs,
      providerEventClassification: "customer_exception" as const,
      fingerprint: "old-fingerprint",
      errorType: "OldError",
      message: "old error",
      eventCount: 1,
      firstSeenAt: opts.oldTs,
      lastSeenAt: opts.oldTs,
    },
    {
      id: `${opts.projectId}-mixed-case`,
      projectId: opts.projectId,
      providerIssueId: `${opts.projectId}-mixed-case`,
      providerSnapshotHash: "b".repeat(64),
      providerProjectedAt: opts.freshTs,
      providerEventClassification: "customer_exception" as const,
      fingerprint: "mixed-fingerprint",
      errorType: "MixedError",
      message: "mixed error",
      eventCount: 2,
      firstSeenAt: opts.oldTs,
      lastSeenAt: opts.freshTs,
    },
  ]);
  const ciCredential = await createTestProjectCredential(env, opts.projectId, "ci_deploy");
  await db.insert(deploys).values([
    {
      id: `${opts.projectId}-old-deploy`,
      projectId: opts.projectId,
      sha: "old-sha",
      trustLevel: "trusted_ci" as const,
      credentialKind: "ci_deploy" as const,
      credentialId: ciCredential.id,
      receivedAt: opts.oldTs,
    },
    {
      id: `${opts.projectId}-fresh-deploy`,
      projectId: opts.projectId,
      sha: "fresh-sha",
      trustLevel: "trusted_ci" as const,
      credentialKind: "ci_deploy" as const,
      credentialId: ciCredential.id,
      receivedAt: opts.freshTs,
    },
  ]);
}

describe("admin surfaces", () => {
  it("hides admin routes when no token is configured and rejects the wrong token otherwise", async () => {
    const bareEnv = await makeTestEnv();
    const bareApp = createApp();
    const hidden = await call("/admin/plans", {}, bareEnv, bareApp);
    expect(hidden.status).toBe(404);

    const unauthorized = await call("/admin/plans", {
      headers: { authorization: "Bearer definitely-wrong" },
    });
    expect(unauthorized.status).toBe(401);
  });

  it("lists the product-wide agent feedback queue without changing tenant-scoped feedback reads", async () => {
    const alpha = await signup("alpha-feedback@example.com");
    const beta = await signup("beta-feedback@example.com");
    const alphaProject = await createProject(alpha.apiKey, "alpha-feedback-project");
    const betaProject = await createProject(beta.apiKey, "beta-feedback-project");

    const alphaFeedback = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${alpha.apiKey}` },
      json: {
        kind: "ux_friction",
        message: "Agent got stuck choosing between install recipes.",
        agent_note: "The picker produced two equal candidates and no tie-breaker.",
        tool_name: "agentry_install",
        attempt_count: 3,
        fingerprint: "install:recipe-tie",
        project_id: alphaProject.id,
      },
    });
    expect(alphaFeedback.status).toBe(200);

    const betaFeedback = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${beta.apiKey}` },
      json: {
        kind: "answer_contract_proposal",
        message: "Need an answer contract for ranking enterprise accounts by onboarding risk.",
        tool_name: "agentry_send_feedback",
        fingerprint: "answer-contract:onboarding-risk",
        project_id: betaProject.id,
      },
    });
    expect(betaFeedback.status).toBe(200);
    const betaFeedbackBody = (await betaFeedback.json()) as { id: string };

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db
      .update(feedback)
      .set({ resolved: 1, resolution: "Answer contract added to backlog." })
      .where(eq(feedback.id, betaFeedbackBody.id));

    const alphaScoped = await call("/v1/feedback", {
      headers: { authorization: `Bearer ${alpha.apiKey}` },
    });
    expect(alphaScoped.status).toBe(200);
    const alphaScopedJson = (await alphaScoped.json()) as { count: number; feedback: Array<{ message: string }> };
    expect(alphaScopedJson.count).toBe(1);
    expect(alphaScopedJson.feedback[0]?.message).toContain("install recipes");

    const adminQueue = await call("/admin/feedback?limit=10", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(adminQueue.status).toBe(200);
    const adminJson = (await adminQueue.json()) as {
      count: number;
      summary: { open: number; resolved: number; by_kind: Record<string, number>; by_tool: Record<string, number> };
      feedback: Array<{
        kind: string;
        message: string;
        fingerprint: string | null;
        resolved: boolean;
        resolution: string | null;
        user: { id: string | null; email: string | null };
        project: { id: string | null; name: string | null };
      }>;
    };
    expect(adminJson.count).toBe(2);
    expect(adminJson.summary.open).toBe(1);
    expect(adminJson.summary.resolved).toBe(1);
    expect(adminJson.summary.by_kind).toMatchObject({ ux_friction: 1, answer_contract_proposal: 1 });
    expect(adminJson.summary.by_tool).toMatchObject({ agentry_install: 1, agentry_send_feedback: 1 });
    expect(adminJson.feedback.map((item) => item.user.email).sort()).toEqual([
      "alpha-feedback@example.com",
      "beta-feedback@example.com",
    ]);
    expect(adminJson.feedback.find((item) => item.fingerprint === "answer-contract:onboarding-risk")?.resolution)
      .toBe("Answer contract added to backlog.");
    expect(adminJson.feedback.find((item) => item.project.id === alphaProject.id)?.project.name)
      .toBe("alpha-feedback-project");

    const openUx = await call("/admin/feedback?resolved=false&kind=ux_friction&q=tie", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(openUx.status).toBe(200);
    const openUxJson = (await openUx.json()) as { count: number; feedback: Array<{ fingerprint: string | null }> };
    expect(openUxJson.count).toBe(1);
    expect(openUxJson.feedback[0]?.fingerprint).toBe("install:recipe-tie");
  });

  it("exposes the free and Nerve control-plane plans without event usage", async () => {
    const plans = await call("/admin/plans", {
      headers: { authorization: "Bearer " + env.ADMIN_TOKEN },
    });
    expect(plans.status).toBe(200);
    const plansJson = (await plans.json()) as { plans: Record<string, unknown> };
    expect(Object.keys(plansJson.plans)).toEqual(["free", "nerve"]);

    for (const retiredPath of [
      "/admin/usage",
      "/admin/usage/snapshots",
      "/admin/usage/snapshot",
      "/admin/usage/example-user",
    ]) {
      const response = await call(retiredPath, {
        method: retiredPath.endsWith("/snapshot") ? "POST" : "GET",
        headers: { authorization: "Bearer " + env.ADMIN_TOKEN },
      });
      expect(response.status, retiredPath).toBe(404);
    }
  });
  it("updates user plans without exposing event-usage admin surfaces", async () => {
    const user = await signup("snapshot-admin@example.com");
    const patchPlan = await call(`/admin/users/${user.userId}/plan`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
      json: { plan: "nerve" },
    });
    expect(patchPlan.status).toBe(200);
    expect(await patchPlan.json()).toMatchObject({ plan: "nerve" });
    const [updated] = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select({ plan: users.plan })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(updated?.plan).toBe("nerve");
  });

  it("applies the fixed control-plane retention window equally to free and Nerve data", async () => {
    const free = await signup("retention-free@example.com");
    const nerve = await signup("retention-nerve@example.com");
    const freeProject = await createProject(free.apiKey, "retention-free-project");
    const nerveProject = await createProject(nerve.apiKey, "retention-nerve-project");

    const now = new Date();
    const oldDate = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000);
    const freshDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const oldTs = Math.floor(oldDate.getTime() / 1000);
    const freshTs = Math.floor(freshDate.getTime() / 1000);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.update(users).set({ plan: "nerve" }).where(eq(users.id, nerve.userId));
    await seedRetentionRows({
      projectId: freeProject.id,
      oldTs,
      freshTs,
    });
    await seedRetentionRows({
      projectId: nerveProject.id,
      oldTs,
      freshTs,
    });

    const sweep = await call("/admin/retention/sweep", {
      method: "POST",
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    });
    expect(sweep.status).toBe(200);
    const sweepJson = (await sweep.json()) as {
      deleted: {
        cases: number;
        deploys: number;
      };
    };
    expect(sweepJson.deleted.cases).toBeGreaterThanOrEqual(1);
    expect(sweepJson.deleted.deploys).toBeGreaterThanOrEqual(1);

    const freeCases = await db.select().from(cases).where(eq(cases.projectId, freeProject.id));
    expect(freeCases).toHaveLength(1);
    expect(freeCases[0]?.fingerprint).toBe("mixed-fingerprint");
    expect(freeCases[0]?.eventCount).toBe(2);
    expect(freeCases[0]?.firstSeenAt).toBe(oldTs);
    expect(freeCases[0]?.lastSeenAt).toBe(freshTs);

    const freeDeployRows = await db.select().from(deploys).where(eq(deploys.projectId, freeProject.id));
    expect(freeDeployRows.map((row) => row.sha)).toEqual(["fresh-sha"]);
    const nerveCases = await db.select().from(cases).where(eq(cases.projectId, nerveProject.id));
    expect(nerveCases).toHaveLength(1);
    expect(nerveCases[0]?.fingerprint).toBe("mixed-fingerprint");
  });

});
