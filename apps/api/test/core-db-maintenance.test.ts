import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

const boundaryMocks = vi.hoisted(() => ({
  getDb: vi.fn(() => {
    throw new Error("database access must remain fenced during maintenance");
  }),
  applyRetention: vi.fn(),
  evaluateAllActiveAlerts: vi.fn(),
  processDueWebhookDeliveries: vi.fn(),
  sweepAutomationLifecycle: vi.fn(),
  issueAllAutomationTriggers: vi.fn(),
}));

vi.mock("../src/db.js", () => ({ getDb: boundaryMocks.getDb }));

vi.mock("../src/retention.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/retention.js")>(),
  applyRetention: boundaryMocks.applyRetention,
}));

vi.mock("../src/alert-evaluation.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/alert-evaluation.js")>(),
  evaluateAllActiveAlerts: boundaryMocks.evaluateAllActiveAlerts,
}));

vi.mock("../src/webhooks.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/webhooks.js")>(),
  processDueWebhookDeliveries: boundaryMocks.processDueWebhookDeliveries,
}));

vi.mock("../src/automation-lifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/automation-lifecycle.js")>(),
  sweepAutomationLifecycle: boundaryMocks.sweepAutomationLifecycle,
  issueAllAutomationTriggers: boundaryMocks.issueAllAutomationTriggers,
}));

const worker = (await import("../src/index.js")).default;

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function envWithMaintenance(value?: unknown): Env {
  return {
    TURSO_DATABASE_URL: "libsql://must-not-be-opened.invalid",
    TURSO_AUTH_TOKEN: "must-not-be-read",
    ...(value === undefined ? {} : { AGENTRY_CORE_DB_MAINTENANCE: value }),
  } as Env;
}

describe("core database maintenance boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses every HTTP method before Hono or database access", async () => {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

    for (const method of methods) {
      const response = await worker.fetch(
        new Request("https://api.agentry.test/v1/projects", { method }),
        envWithMaintenance("core-schema-2026-07-11"),
        executionContext(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-agentry-maintenance-id"))
        .toBe("core-schema-2026-07-11");
      expect(response.headers.get("x-agentry-request-id")).toBeNull();
      expect(await response.json()).toEqual({
        error: {
          code: "core_db_maintenance",
          message: "Agentry is temporarily unavailable while core database maintenance is in progress.",
          next_action: "Honor Retry-After and retry the same request without changing its credentials or payload.",
          retryable: true,
          details: { maintenance_id: "core-schema-2026-07-11" },
        },
      });
    }

    expect(boundaryMocks.getDb).not.toHaveBeenCalled();
  });

  it("fails closed with a bounded safe id for every malformed non-off value", async () => {
    for (const value of ["", " off ", "line\nbreak", "x".repeat(65), null, false]) {
      const response = await worker.fetch(
        new Request("https://api.agentry.test/"),
        envWithMaintenance(value),
        executionContext(),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("x-agentry-maintenance-id"))
        .toBe("invalid-maintenance-value");
      expect(JSON.stringify(await response.json()).length).toBeLessThan(512);
    }
    expect(boundaryMocks.getDb).not.toHaveBeenCalled();
  });

  it("treats a non-literal off spelling as an active maintenance id", async () => {
    const response = await worker.fetch(
      new Request("https://api.agentry.test/"),
      envWithMaintenance("OFF"),
      executionContext(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("x-agentry-maintenance-id")).toBe("OFF");
    expect(boundaryMocks.getDb).not.toHaveBeenCalled();
  });

  it("returns immediately from every configured cron without work", async () => {
    for (const cron of ["* * * * *", "*/15 * * * *", "10 1 * * *"]) {
      const ctx = executionContext();
      await worker.scheduled(
        {
          cron,
          scheduledTime: Date.now(),
          noRetry: vi.fn(),
        } as unknown as ScheduledController,
        envWithMaintenance("core-schema-2026-07-11"),
        ctx,
      );
      expect(ctx.waitUntil).not.toHaveBeenCalled();
    }

    expect(boundaryMocks.getDb).not.toHaveBeenCalled();
    expect(boundaryMocks.applyRetention).not.toHaveBeenCalled();
    expect(boundaryMocks.evaluateAllActiveAlerts).not.toHaveBeenCalled();
    expect(boundaryMocks.processDueWebhookDeliveries).not.toHaveBeenCalled();
    expect(boundaryMocks.sweepAutomationLifecycle).not.toHaveBeenCalled();
    expect(boundaryMocks.issueAllAutomationTriggers).not.toHaveBeenCalled();
  });

  it("keeps normal HTTP behavior when the binding is absent or exactly off", async () => {
    for (const value of [undefined, "off"] as const) {
      const response = await worker.fetch(
        new Request("https://api.agentry.test/"),
        envWithMaintenance(value),
        executionContext(),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-agentry-maintenance-id")).toBeNull();
      expect(await response.text()).toContain("Agentry");
    }
    expect(boundaryMocks.getDb).not.toHaveBeenCalled();
  });

});
