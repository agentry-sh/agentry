import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestProjectCredential, makeTestEnv, type TestEnv } from "./setup.js";

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
  env = await makeTestEnv();
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

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

async function signup(email: string): Promise<string> {
  const response = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { api_key: string }).api_key;
}

async function createProject(apiKey: string, name: string): Promise<{ id: string }> {
  const response = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `typed-project-${crypto.randomUUID()}`,
    },
    json: { name },
  });
  expect(response.status).toBe(200);
  return await response.json() as { id: string };
}

async function setup() {
  const apiKey = await signup(`typed-${crypto.randomUUID()}@example.com`);
  const project = await createProject(apiKey, "typed-endpoints");
  return { apiKey, project };
}

describe("customer-owned runtime telemetry boundary", () => {
  for (const [method, path] of [
    ["POST", "/v1/logs/"],
    ["POST", "/v1/analytics/"],
    ["GET", "/v1/analytics/browser-config"],
    ["POST", "/v1/track/"],
    ["POST", "/v1/store/"],
  ] as const) {
    it(`does not expose ${method} ${path}`, async () => {
      expect((await call(path, { method })).status).toBe(404);
    });
  }

  for (const path of ["/v1/logs/", "/v1/analytics/"]) {
    it(`does not advertise browser CORS for ${path}`, async () => {
      const response = await call(path, {
        method: "OPTIONS",
        headers: {
          origin: "https://customer.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  }
});

describe("trusted deploy evidence", () => {
  it("accepts one CI-authenticated deploy and makes exact replay idempotent", async () => {
    const { apiKey, project } = await setup();
    const ci = await createTestProjectCredential(env, project.id, "ci_deploy");
    const headers = {
      authorization: `Bearer ${ci.credential}`,
      "idempotency-key": "typed-deploy-abc123-0001",
    };
    const payload = {
      sha: "abc123",
      branch: "main",
      environment: "production",
      actor: "release-bot",
      ci_run_id: "12345",
    };
    const first = await call("/v1/deploys/", { method: "POST", headers, json: payload });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ idempotent_replay: false });

    const replay = await call("/v1/deploys/", { method: "POST", headers, json: payload });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotent_replay: true });

    const list = await call(`/v1/projects/${project.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      deploys: [{
        evidence: {
          sha: "abc123",
          branch: "main",
          actor: "release-bot",
          extra: { ci_run_id: "12345" },
        },
      }],
    });
  });

  it("rejects deploy evidence without a sha", async () => {
    const { project } = await setup();
    const ci = await createTestProjectCredential(env, project.id, "ci_deploy");
    const response = await call("/v1/deploys/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ci.credential}`,
        "idempotency-key": "typed-deploy-missing-sha-0002",
      },
      json: { branch: "main" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_payload" } });
  });
});

describe("project creation response", () => {
  it("does not issue runtime telemetry keys or proxy URLs", async () => {
    const apiKey = await signup("typed-project-boundary@example.com");
    const response = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": `typed-project-boundary-${crypto.randomUUID()}`,
      },
      json: { name: "typed-project-boundary" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.deploys_url).toMatch(/\/v1\/deploys\/$/);
    expect(body).not.toHaveProperty("public_api_key");
    expect(body).not.toHaveProperty("logs_url");
    expect(body).not.toHaveProperty("analytics_url");
  });
});
