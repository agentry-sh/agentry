// Coverage for dynamic webhook matching, PostHog-backed alert transitions,
// and the feedback endpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runHogQlMock = vi.hoisted(() => vi.fn());
import { makeTestEnv, type TestEnv } from "./setup.js";
import { matchesAny } from "../src/webhooks.js";

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
    requirePosthogReadyBinding: async (_env: unknown, projectId: string) => ({
      projectId,
      posthogProjectId: 4242,
      posthogProjectResourceId: 14_242,
      posthogHost: "https://posthog.example.com",
      posthogOrgId: "org_test",
    }),
    runHogQl: (...args: unknown[]) => runHogQlMock(...args),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;
let outboundCalls: Array<{ url: string; init: RequestInit }>;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true });
  app = createApp();
  outboundCalls = [];
  runHogQlMock.mockReset();
  runHogQlMock.mockResolvedValue({ columns: ["dau"], results: [] });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    outboundCalls.push({ url, init: init ?? {} });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  const method = init?.method ?? "GET";
  if (
    method === "POST" &&
    /^\/v1\/projects\/[^/]+\/webhooks(?:\/[^/]+\/test)?$/.test(path) &&
    !headers.has("idempotency-key")
  ) {
    headers.set("idempotency-key", `dynamic-webhook-${crypto.randomUUID()}`);
  }
  if (
    !headers.has("idempotency-key") &&
    ((method === "POST" && path === "/v1/feedback") ||
      (method === "POST" && /^\/v1\/projects\/[^/]+\/alerts$/.test(path)))
  ) {
    headers.set("idempotency-key", `dynamic-control-${crypto.randomUUID()}`);
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

async function signup(email: string): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/_test/login", { method: "POST", json: { email } });
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

async function setup() {
  const { apiKey, userId } = await signup(`u-${Math.random()}@example.com`);
  const proj = await createProject(apiKey, "p");
  return { apiKey, userId, proj };
}

// Several test paths fire webhooks via waitUntil (fire-and-forget) — drain the
// async work by ticking a few times. Single setTimeout(0) is not enough when
// the same test triggers multiple webhooks back-to-back.
async function flushAsync() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// Wait until outboundCalls reaches `expected` or 200ms pass. Stable polling
// for tests that trigger multiple webhook deliveries in a row.
async function waitForCalls(predicate: (count: number) => boolean, timeoutMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(outboundCalls.length)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// matchesAny — pure unit
// ---------------------------------------------------------------------------

describe("matchesAny", () => {
  it("exact match", () => {
    expect(matchesAny(["case.created"], "case.created")).toBe(true);
    expect(matchesAny(["case.created"], "case.resolved")).toBe(false);
  });

  it("wildcard '*' matches anything", () => {
    expect(matchesAny(["*"], "case.created")).toBe(true);
    expect(matchesAny(["*"], "signup_completed")).toBe(true);
    expect(matchesAny(["*"], "")).toBe(true);
  });

  it("prefix wildcard 'foo.*' matches namespace", () => {
    expect(matchesAny(["case.*"], "case.created")).toBe(true);
    expect(matchesAny(["case.*"], "case.resolved")).toBe(true);
    expect(matchesAny(["case.*"], "deploy.recorded")).toBe(false);
  });

  it("mixed subscriptions match if any matches", () => {
    expect(matchesAny(["alert.*", "signup_completed"], "signup_completed")).toBe(true);
    expect(matchesAny(["alert.*", "signup_completed"], "alert.triggered")).toBe(true);
    expect(matchesAny(["alert.*", "signup_completed"], "purchase")).toBe(false);
  });

  it("no subscription matches → false", () => {
    expect(matchesAny([], "case.created")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Alert transitions
// ---------------------------------------------------------------------------

describe("alert transitions", () => {
  it("emits alert.triggered once per breach and alert.recovered once the threshold clears", async () => {
    const { apiKey, proj } = await setup();
    await call(`/v1/projects/${proj.id}/webhooks`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { url: "https://hooks.example.com/alerts", events: ["alert.*"] },
    });

    const create = await call(`/v1/projects/${proj.id}/alerts`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        name: "errors-spiking",
        blueprint_id: "active_users_daily",
        threshold_column: "dau",
        threshold_op: "gt",
        threshold_value: 10,
      },
    });
    expect(create.status).toBe(200);
    const alert = (await create.json()) as { id: string };

    outboundCalls.length = 0;
    runHogQlMock.mockResolvedValueOnce({ columns: ["dau"], results: [{ dau: 12 }] });
    const first = await call(`/v1/projects/${proj.id}/alerts/${alert.id}/evaluate`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { transition_event: string | null; triggered: boolean };
    expect(firstBody.triggered).toBe(true);
    expect(firstBody.transition_event).toBe("alert.triggered");
    await waitForCalls((n) => n >= 1);

    const firstHooks = outboundCalls.filter((c) => c.url.includes("/alerts"));
    expect(firstHooks).toHaveLength(1);
    expect((JSON.parse(String(firstHooks[0]!.init.body)) as { event: string }).event).toBe("alert.triggered");

    outboundCalls.length = 0;
    runHogQlMock.mockResolvedValueOnce({ columns: ["dau"], results: [{ dau: 15 }] });
    const second = await call(`/v1/projects/${proj.id}/alerts/${alert.id}/evaluate`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { transition_event: string | null; triggered: boolean };
    expect(secondBody.triggered).toBe(true);
    expect(secondBody.transition_event).toBeNull();
    await flushAsync();
    expect(outboundCalls.filter((c) => c.url.includes("/alerts"))).toHaveLength(0);

    runHogQlMock.mockResolvedValueOnce({ columns: ["dau"], results: [{ dau: 3 }] });
    const third = await call(`/v1/projects/${proj.id}/alerts/${alert.id}/evaluate`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(third.status).toBe(200);
    const thirdBody = (await third.json()) as { transition_event: string | null; triggered: boolean };
    expect(thirdBody.triggered).toBe(false);
    expect(thirdBody.transition_event).toBe("alert.recovered");
    await waitForCalls((n) => n >= 1);

    const recoveredHooks = outboundCalls.filter((c) => c.url.includes("/alerts"));
    expect(recoveredHooks).toHaveLength(1);
    expect((JSON.parse(String(recoveredHooks[0]!.init.body)) as { event: string }).event).toBe("alert.recovered");
  });
});

// ---------------------------------------------------------------------------
// Feedback endpoint
// ---------------------------------------------------------------------------

describe("feedback", () => {
  it("POST /v1/feedback requires auth", async () => {
    const res = await call("/v1/feedback", {
      method: "POST",
      json: { kind: "bug", message: "x" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/feedback persists with user attribution and coerces unknown kind", async () => {
    const { apiKey, userId, proj } = await setup();
    const res = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        kind: "definitely_not_a_real_kind",
        message: "wish I could query by tag",
        agent_note: "user tried to run a stale workflow example with no matching query blueprint",
        tool_name: "query_blueprint_run",
        attempt_count: 3,
        fingerprint: "empty_query_blueprint:tag-query",
        project_id: proj.id,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      received_at: number;
      fingerprint: string | null;
      deduped: boolean;
      next_action: string;
    };
    expect(body.id).toMatch(/-/);
    expect(body.received_at).toBeGreaterThan(0);
    expect(body.fingerprint).toBe("empty_query_blueprint:tag-query");
    expect(body.deduped).toBe(false);

    // Now GET it back — verify userId is attached and kind was coerced to "other".
    const list = await call("/v1/feedback", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      count: number;
      feedback: Array<{
        id: string;
        user_id: string | null;
        project_id: string | null;
        kind: string;
        message: string;
        agent_note: string | null;
        tool_name: string | null;
        attempt_count: number | null;
        fingerprint: string | null;
      }>;
    };
    expect(data.count).toBe(1);
    const item = data.feedback[0]!;
    expect(item.user_id).toBe(userId);
    expect(item.project_id).toBe(proj.id);
    expect(item.kind).toBe("other");
    expect(item.message).toBe("wish I could query by tag");
    expect(item.agent_note).toContain("stale workflow example");
    expect(item.tool_name).toBe("query_blueprint_run");
    expect(item.attempt_count).toBe(3);
    expect(item.fingerprint).toBe("empty_query_blueprint:tag-query");
  });

  it("POST /v1/feedback records agent-discovered Agentry product defects and dedupes unresolved fingerprints", async () => {
    const { apiKey, proj } = await setup();
    const payload = {
      kind: "agent_discovered_bug",
      message: "Filtered OpenAPI lookup returned available methods but no operation for a concrete path.",
      project_id: proj.id,
      fingerprint: "agent_discovered_bug:openapi-filtered-operation-missing",
      tool_name: "install_feedback_checkpoint",
      attempt_count: 1,
      agent_note: JSON.stringify({
        source: "agent_discovered_product_defect",
        flow: "install",
        surface: "openapi_schema",
        expected: "path+method returns operation",
        actual: "available methods only",
        workaround_used: true,
      }),
    };

    const first = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: payload,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { id: string; deduped: boolean; fingerprint: string };
    expect(firstBody.deduped).toBe(false);
    expect(firstBody.fingerprint).toBe(payload.fingerprint);

    const duplicate = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { ...payload, message: "same issue seen again" },
    });
    expect(duplicate.status).toBe(200);
    const duplicateBody = (await duplicate.json()) as {
      id: string;
      deduped: boolean;
      fingerprint: string;
      next_action: string;
    };
    expect(duplicateBody.id).toBe(firstBody.id);
    expect(duplicateBody.deduped).toBe(true);
    expect(duplicateBody.fingerprint).toBe(payload.fingerprint);
    expect(duplicateBody.next_action).toContain("already recorded");

    const list = await call("/v1/feedback?kind=agent_discovered_bug", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { count: number; feedback: Array<{ kind: string; fingerprint: string | null }> };
    expect(listBody.count).toBe(1);
    expect(listBody.feedback[0]?.kind).toBe("agent_discovered_bug");
    expect(listBody.feedback[0]?.fingerprint).toBe(payload.fingerprint);
  });

  it("POST /v1/feedback rejects missing message", async () => {
    const { apiKey } = await setup();
    const res = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      json: { kind: "bug" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /v1/feedback rejects project_id owned by another user (tenancy)", async () => {
    const a = await setup();
    const b = await signup("intruder@example.com");
    const res = await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${b.apiKey}` },
      json: { kind: "bug", message: "x", project_id: a.proj.id },
    });
    expect(res.status).toBe(403);
  });

  it("GET /v1/feedback filters by kind and resolved", async () => {
    const { apiKey } = await setup();
    for (const k of ["bug", "bug", "missing_feature"] as const) {
      await call("/v1/feedback", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        json: { kind: k, message: `${k}-msg` },
      });
    }

    const onlyBugs = await call("/v1/feedback?kind=bug", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const bugsData = (await onlyBugs.json()) as { count: number };
    expect(bugsData.count).toBe(2);

    const onlyMissing = await call("/v1/feedback?kind=missing_feature", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const missingData = (await onlyMissing.json()) as { count: number };
    expect(missingData.count).toBe(1);

    // Default resolved=0; explicit resolved=false also matches.
    const unresolved = await call("/v1/feedback?resolved=false", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const unresData = (await unresolved.json()) as { count: number };
    expect(unresData.count).toBe(3);

    const resolved = await call("/v1/feedback?resolved=true", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const resData = (await resolved.json()) as { count: number };
    expect(resData.count).toBe(0);
  });

  it("does not leak feedback from another user", async () => {
    const a = await setup();
    await call("/v1/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${a.apiKey}` },
      json: { kind: "bug", message: "mine" },
    });
    const b = await signup("other@example.com");
    const list = await call("/v1/feedback", {
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    const data = (await list.json()) as { count: number };
    expect(data.count).toBe(0);
  });
});
