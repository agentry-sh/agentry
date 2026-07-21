import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBindings, Env } from "../src/env.js";

const {
  apiErrorHandler,
  apiObservabilityMiddleware,
  createApp,
} = await import("../src/index.js");

const VALID_REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";
const env: Env = {
  TURSO_DATABASE_URL: ":memory:",
  TURSO_AUTH_TOKEN: "",
};

function observabilityHarness() {
  const app = new Hono<AppBindings>();
  app.use("*", apiObservabilityMiddleware());
  app.onError(apiErrorHandler);
  app.get("/v1/capabilities", (c) => c.json({ ok: true }));
  app.get("/v1/projects/:project_id/cases", (c) => c.json({ ok: true }));
  app.get("/direct-503", (c) => c.json({ ok: false }, 503));
  app.get("/coded-503", (c) => c.json({
    error: { code: "analytics_not_configured", message: "not configured" },
  }, 503));
  app.get("/boom", () => {
    throw new Error("Bearer customer-secret-must-not-escape");
  });
  return app;
}

async function call(
  app: Hono<AppBindings>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.fetch(new Request(`http://test${path}`, init), env);
}

function loggedRequest(): Record<string, unknown> {
  const records = vi.mocked(console.log).mock.calls.flatMap((call) => {
    const value = call[0];
    if (typeof value !== "string") return [];
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return typeof parsed.request_id === "string" && typeof parsed.route === "string"
        ? [parsed]
        : [];
    } catch {
      return [];
    }
  });
  expect(records).toHaveLength(1);
  return records[0]!;
}

describe("global backend structured request logging", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits exactly one bounded request log with the canonical route", async () => {
    const app = observabilityHarness();
    const response = await call(
      app,
      "/v1/projects/019e43d2-6e5a-7c39-b916-9f71ea581143/cases",
    );

    expect(response.status).toBe(200);
    expect(loggedRequest()).toMatchObject({
      route: "/v1/projects/:project_id/cases",
      method: "GET",
      status: 200,
    });
  });

  it("normalizes an unknown path to the bounded unmatched route", async () => {
    const response = await call(observabilityHarness(), "/private/raw/path?token=secret");

    expect(response.status).toBe(404);
    expect(loggedRequest()).toMatchObject({
      route: "unmatched",
      status: 404,
    });
    expect(JSON.stringify(loggedRequest())).not.toContain("private/raw/path");
    expect(JSON.stringify(loggedRequest())).not.toContain("token=secret");
  });

  it("accepts only a canonical UUID request id and replaces arbitrary input", async () => {
    const app = observabilityHarness();
    const accepted = await call(app, "/v1/capabilities", {
      headers: { "x-agentry-request-id": VALID_REQUEST_ID.toUpperCase() },
    });

    expect(accepted.headers.get("x-agentry-request-id")).toBe(VALID_REQUEST_ID);
    expect(loggedRequest()).toMatchObject({ request_id: VALID_REQUEST_ID });

    vi.mocked(console.log).mockClear();
    const rejected = await call(app, "/v1/capabilities", {
      headers: { "x-agentry-request-id": "raw-user-and-secret-value" },
    });
    const replacement = rejected.headers.get("x-agentry-request-id");

    expect(replacement).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(replacement).not.toBe("raw-user-and-secret-value");
    expect(loggedRequest()).toMatchObject({ request_id: replacement });
    expect(JSON.stringify(loggedRequest())).not.toContain("raw-user-and-secret-value");
  });

  it("logs a direct 5xx once at the settled response boundary", async () => {
    const response = await call(observabilityHarness(), "/direct-503");

    expect(response.status).toBe(503);
    expect(loggedRequest()).toMatchObject({
      route: "/direct-503",
      status: 503,
    });
  });

  it("retains a bounded source-known code from a direct JSON error", async () => {
    const response = await call(observabilityHarness(), "/coded-503");

    expect(response.status).toBe(503);
    expect(loggedRequest()).toMatchObject({
      route: "/coded-503",
      status: 503,
      error_code: "analytics_not_configured",
    });
  });

  it("logs an unhandled exception without exposing its raw message", async () => {
    const response = await call(observabilityHarness(), "/boom");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("customer-secret-must-not-escape");
    expect(loggedRequest()).toMatchObject({
      route: "/boom",
      status: 500,
      error_code: "unhandled",
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls))
      .not.toContain("customer-secret-must-not-escape");
  });

  it("logs the real non-mutating PostHog redemption rejection", async () => {
    const response = await call(createApp(), "/v1/auth/posthog/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(loggedRequest()).toMatchObject({
      route: "/v1/auth/posthog/poll",
      status: 400,
      error_code: "invalid_payload",
    });
  });
});
