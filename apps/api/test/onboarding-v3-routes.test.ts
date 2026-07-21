import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  apiKeys,
  onboardingProofSessions,
  projectMemberships,
  projects,
  users,
} from "@agentry/db/schema";
import { AgentryError, mintApiKey } from "@agentrysh/shared";
import type { AppBindings } from "../src/env.js";
import {
  createTestProjectCredential,
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/onboarding-v3-live-proof.js", () => ({
  verifyOnboardingV3LiveProof: (...args: unknown[]) => verifyMock(...args),
}));

const { default: onboardingRoutes } = await import("../src/routes/onboarding.js");

let env: TestEnv;
let app: Hono<AppBindings>;
let apiKey: string;
let projectId: string;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = new Hono<AppBindings>();
  app.onError((error, c) => {
    if (error instanceof AgentryError) {
      return c.json(error.toResponseBody(), error.status as 400);
    }
    throw error;
  });
  app.route("/", onboardingRoutes);

  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const suffix = crypto.randomUUID();
  const userId = `owner-${suffix}`;
  projectId = `project-${suffix}`;
  const minted = await mintApiKey();
  apiKey = minted.raw;
  await db.insert(users).values({ id: userId, email: `${suffix}@example.test` });
  await db.insert(apiKeys).values({
    id: `key-${suffix}`,
    userId,
    kind: "private",
    prefix: minted.prefix,
    keyHash: minted.hash,
  });
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "Lean onboarding route fixture",
  });
  await db.insert(projectMemberships).values({
    id: `membership-${suffix}`,
    projectId,
    userId,
    role: "owner",
  });

  verifyMock.mockImplementation(async (_env: unknown, input: any) => ({
    ok: true,
    receipt: receiptFor(input),
    remaining: {
      analytics: { blockers: [], milestones: [], properties: [] },
      safe_error: null,
      deploy: null,
    },
  }));
});

afterEach(() => {
  verifyMock.mockReset();
  disposeTestEnv(env);
});

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, { ...init, headers, body }), env);
}

function authHeaders(etag?: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(etag ? { "if-match": etag } : {}),
  };
}

function snapshot(seed: string) {
  return {
    git_head_sha: seed.repeat(40),
    source_fingerprint_sha256: seed.repeat(64),
    source_fingerprint_algorithm: "agentry-source-tree-sha256-v1" as const,
  };
}

function plan(boundary: "server_posthog" | "browser_posthog" = "server_posthog", seed = "a") {
  return {
    business_question: `Which customers reach durable value? ${seed}`,
    plan_markdown:
      "A customer enters, persists useful work, receives the valuable result, and production deploys that source.",
    source_snapshot: snapshot(seed),
    historical_evidence: {
      status: "historically_observed" as const,
      source: "posthog_cloud" as const,
      posthog_project_id: 42,
      observed_at: 200,
      window: { from: 100, to: 199 },
      query_receipt_sha256: "9".repeat(64),
      observations: [{
        kind: "analytics" as const,
        event: `result persisted ${seed}`,
        observed_properties: ["result_id"],
        row_count: 3,
      }],
    },
    milestones: [{
      event: `result persisted ${seed}`,
      meaning: "The customer's useful result exists durably.",
      posthog_boundary: boundary,
      properties: ["result_id"],
      targets: [{ file: "src/result.ts", anchor: "return storedResult" }],
    }],
    failures: [{
      marker: `result rejected safely ${seed}`,
      meaning: "Validation rejected bad input before mutation.",
      posthog_boundary: boundary,
      context: ["reason_code"],
      safe_live_proof: true,
      targets: [{ file: "src/result.ts", anchor: "return invalidInput" }],
    }],
    deploy: {
      environment: "production",
      sha_source: "git_head" as const,
      targets: [{ file: ".github/workflows/deploy.yml", anchor: "deploy production" }],
    },
  };
}

function receiptFor(input: any) {
  const safeFailure = input.plan.failures.find((failure: any) => failure.safe_live_proof);
  return {
    evidence_status: "source_verified",
    source_verified_at: Math.floor(Date.now() / 1_000),
    analytics: input.plan.milestones.map((milestone: any) => ({
      event: milestone.event,
      posthog_boundary: milestone.posthog_boundary,
      required_properties: milestone.properties,
      observed_properties: milestone.properties,
      row_count: 1,
    })),
    error: {
      marker: safeFailure.marker,
      posthog_boundary: safeFailure.posthog_boundary,
      required_context: safeFailure.context,
      observed_context: safeFailure.context,
      row_count: 1,
    },
    deploy: {
      environment: input.plan.deploy.environment,
      source_snapshot: input.implementation_source_snapshot,
      row_count: 1,
    },
  };
}

async function start(planValue = plan()) {
  const response = await call(`/v1/projects/${projectId}/onboarding`, {
    method: "POST",
    headers: authHeaders(),
    json: { intent: "start", plan: planValue },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<any>;
}

async function approve(planned: any) {
  const response = await call(`/v1/projects/${projectId}/onboarding/review`, {
    method: "POST",
    headers: authHeaders(planned.etag),
    json: { decision: "approve", plan_sha256: planned.plan_sha256 },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

async function beginProof(approved: any, finalSeed = "b") {
  const response = await call(`/v1/projects/${projectId}/onboarding/proof`, {
    method: "POST",
    headers: authHeaders(approved.etag),
    json: { implementation_source_snapshot: snapshot(finalSeed) },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<any>;
}

describe("lean onboarding routes", () => {
  it("serves only the public source helper and keeps state owner-only", async () => {
    const helper = await call("/v1/onboarding/source-snapshot.mjs");
    expect(helper.status).toBe(200);
    expect(helper.headers.get("content-type")).toContain("text/javascript");
    expect(helper.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(await helper.text()).toContain("agentry-source-tree-sha256-v1");
    const cached = await call("/v1/onboarding/source-snapshot.mjs", {
      headers: { "if-none-match": helper.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);

    const privateRead = await call(`/v1/projects/${projectId}/onboarding`);
    expect(privateRead.status).toBe(401);
    const oldPointer = await call(
      `/v1/projects/${projectId}/onboarding?view=pointer`,
      { headers: authHeaders() },
    );
    expect(oldPointer.status).toBe(400);
  });

  it("keeps historical evidence separate until source verification completes", async () => {
    const planned = await start();
    expect(planned).toMatchObject({
      status: "planned",
      installation_complete: false,
      evidence_status: {
        historical: "historically_observed",
        source: "pending",
      },
      next_action: {
        id: "review_exact_plan",
        requires_human: true,
        operation: {
          method: "POST",
          path: `/v1/projects/${projectId}/onboarding/review`,
        },
      },
    });

    const missingCas = await call(`/v1/projects/${projectId}/onboarding/review`, {
      method: "POST",
      headers: authHeaders(),
      json: { decision: "approve", plan_sha256: planned.plan_sha256 },
    });
    expect(missingCas.status).toBe(428);

    const approved = await approve(planned);
    await createTestProjectCredential(env, projectId, "ci_deploy");
    const envelope = await beginProof(approved);
    expect(envelope.state).toMatchObject({
      status: "proving",
      next_action: {
        id: "exercise_and_verify",
        requires_human: false,
        operation: {
          method: "POST",
          path: `/v1/projects/${projectId}/onboarding/verify`,
        },
      },
    });
    expect(envelope.one_time_markers.runtime.value).toMatch(/^agentry_proof_runtime_/);
    expect(envelope.one_time_markers.ci.value).toMatch(/^agentry_proof_ci_/);
    expect(envelope.one_time_markers.runtime).toMatchObject({
      property_name: "agentry_onboarding_proof",
      environment_variable: "AGENTRY_ONBOARDING_PROOF",
      browser_session_storage_key: "agentry_onboarding_proof",
    });
    expect(envelope.one_time_markers.ci.environment_variable).toBe(
      "AGENTRY_ONBOARDING_PROOF",
    );
    expect(JSON.stringify(envelope.state)).not.toContain(envelope.one_time_markers.runtime.value);

    const bodyRejected = await call(`/v1/projects/${projectId}/onboarding/verify`, {
      method: "POST",
      headers: authHeaders(envelope.state.etag),
      json: {},
    });
    expect(bodyRejected.status).toBe(400);

    verifyMock.mockResolvedValueOnce({
      ok: false,
      receipt: null,
      remaining: {
        analytics: {
          blockers: [],
          milestones: [{
            milestone_index: 0,
            event: "result persisted a",
            posthog_boundary: "server_posthog",
          }],
          properties: [],
        },
        safe_error: null,
        deploy: null,
      },
    });
    const incomplete = await call(`/v1/projects/${projectId}/onboarding/verify`, {
      method: "POST",
      headers: authHeaders(envelope.state.etag),
    });
    expect(incomplete.status).toBe(200);
    expect(await incomplete.json()).toMatchObject({
      ok: false,
      state: { status: "proving", etag: envelope.state.etag },
      remaining: {
        analytics: {
          milestones: [{ milestone_index: 0, event: "result persisted a" }],
        },
      },
    });

    const verifiedResponse = await call(`/v1/projects/${projectId}/onboarding/verify`, {
      method: "POST",
      headers: authHeaders(envelope.state.etag),
    });
    expect(verifiedResponse.status).toBe(200);
    const verified = await verifiedResponse.json() as any;
    expect(verified).toMatchObject({
      ok: true,
      state: {
        status: "verified",
        installation_complete: true,
        evidence_status: {
          historical: "historically_observed",
          source: "source_verified",
        },
        receipt: { evidence_status: "source_verified" },
        next_action: null,
      },
      remaining: {
        analytics: { blockers: [], milestones: [], properties: [] },
        safe_error: null,
        deploy: null,
      },
    });
    expect(JSON.stringify(verified)).not.toContain("baseline");
    expect(verified.state.plan.historical_evidence.observations[0]).not.toHaveProperty(
      "payload",
    );

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const session = (await db.select().from(onboardingProofSessions).where(eq(
      onboardingProofSessions.id,
      envelope.state.proof_session.proof_session_id,
    )))[0];
    expect(session?.status).toBe("completed");
  });

  it("replaces a plan from proving and revokes its old proof session", async () => {
    const approved = await approve(await start());
    await createTestProjectCredential(env, projectId, "ci_deploy");
    const firstEnvelope = await beginProof(approved);
    const envelope = await beginProof(firstEnvelope.state, "c");
    expect(envelope.state.proof_session.proof_session_id)
      .not.toBe(firstEnvelope.state.proof_session.proof_session_id);

    const replacementResponse = await call(`/v1/projects/${projectId}/onboarding`, {
      method: "POST",
      headers: authHeaders(envelope.state.etag),
      json: { intent: "start", plan: plan("server_posthog", "d") },
    });
    expect(replacementResponse.status).toBe(200);
    const replacement = await replacementResponse.json() as any;
    expect(replacement).toMatchObject({
      status: "planned",
      next_action: { id: "review_exact_plan" },
    });
    expect(replacement.onboarding_id).not.toBe(envelope.state.onboarding_id);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const restartedSession = (await db.select().from(onboardingProofSessions).where(eq(
      onboardingProofSessions.id,
      firstEnvelope.state.proof_session.proof_session_id,
    )))[0];
    expect(restartedSession).toMatchObject({
      status: "revoked",
      terminalReason: "proof_restarted",
    });
    const oldSession = (await db.select().from(onboardingProofSessions).where(eq(
      onboardingProofSessions.id,
      envelope.state.proof_session.proof_session_id,
    )))[0];
    expect(oldSession).toMatchObject({ status: "revoked", terminalReason: "plan_replaced" });
  });

  it("keeps the winning proof session active across concurrent same-ETag restarts", async () => {
    const approved = await approve(await start());
    await createTestProjectCredential(env, projectId, "ci_deploy");

    const proofCall = (seed: string) => call(`/v1/projects/${projectId}/onboarding/proof`, {
      method: "POST",
      headers: authHeaders(approved.etag),
      json: { implementation_source_snapshot: snapshot(seed) },
    });
    const outcomes = await Promise.allSettled([proofCall("c"), proofCall("d")]);
    const responses = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : []
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const loser = outcomes.find((outcome) =>
      outcome.status === "rejected" || outcome.value.status !== 201
    );
    expect(loser).toBeDefined();
    if (loser?.status === "fulfilled") {
      expect(loser.value.status).toBe(412);
    } else if (loser?.status === "rejected") {
      expect(loser.reason).toMatchObject({ code: "SQLITE_BUSY" });
    }

    const stateResponse = await call(`/v1/projects/${projectId}/onboarding`, {
      headers: authHeaders(),
    });
    expect(stateResponse.status).toBe(200);
    const state = await stateResponse.json() as any;
    expect(state.status).toBe("proving");

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const active = await db.select().from(onboardingProofSessions).where(and(
      eq(onboardingProofSessions.projectId, projectId),
      eq(onboardingProofSessions.status, "active"),
    ));
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(state.proof_session.proof_session_id);
  });

  it("lets the human replace the reviewed plan and replays the exact decision", async () => {
    const planned = await start();
    const request = {
      decision: "replace",
      plan_sha256: planned.plan_sha256,
      replacement_plan: plan("server_posthog", "c"),
    };
    const replacedResponse = await call(`/v1/projects/${projectId}/onboarding/review`, {
      method: "POST",
      headers: authHeaders(planned.etag),
      json: request,
    });
    expect(replacedResponse.status).toBe(200);
    const replaced = await replacedResponse.json() as any;
    expect(replaced).toMatchObject({
      status: "planned",
      revision: 2,
      next_action: { id: "review_exact_plan" },
    });
    expect(replaced.plan.business_question).toContain("c");

    const replay = await call(`/v1/projects/${projectId}/onboarding/review`, {
      method: "POST",
      headers: authHeaders(planned.etag),
      json: request,
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("x-agentry-idempotent-replay")).toBe("true");
    expect((await replay.json() as any).etag).toBe(replaced.etag);
  });

  it("uses customer PostHog for either runtime boundary and binds only CI deploy proof", async () => {
    const serverApproved = await approve(await start(plan("server_posthog")));
    await createTestProjectCredential(env, projectId, "ci_deploy");
    const serverProof = await beginProof(serverApproved, "b");
    expect(serverProof.state.status).toBe("proving");
    expect(Object.keys(serverProof.state.proof_session).sort()).toEqual([
      "expires_at",
      "proof_session_id",
      "started_at",
      "status",
    ]);

    const replacement = await call(`/v1/projects/${projectId}/onboarding`, {
      method: "POST",
      headers: authHeaders(serverProof.state.etag),
      json: { intent: "start", plan: plan("browser_posthog", "c") },
    });
    expect(replacement.status).toBe(200);
    const browserApproved = await approve(await replacement.json());
    const browserProof = await beginProof(browserApproved, "d");
    expect(browserProof.state.status).toBe("proving");
  });
});
