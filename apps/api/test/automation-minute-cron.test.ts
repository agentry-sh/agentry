import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

const sweepMocks = vi.hoisted(() => ({
  webhooks: vi.fn(),
  oauthAttempts: vi.fn(),
  lifecycle: vi.fn(),
  triggers: vi.fn(),
  workflowTriggers: vi.fn(),
  errorProjections: vi.fn(),
}));

vi.mock("../src/webhooks.js", async () => {
  const actual = await vi.importActual<typeof import("../src/webhooks.js")>(
    "../src/webhooks.js",
  );
  return { ...actual, processDueWebhookDeliveries: sweepMocks.webhooks };
});

vi.mock("../src/automation-lifecycle.js", async () => {
  const actual = await vi.importActual<typeof import("../src/automation-lifecycle.js")>(
    "../src/automation-lifecycle.js",
  );
  return {
    ...actual,
    sweepAutomationLifecycle: sweepMocks.lifecycle,
    issueAllAutomationTriggers: sweepMocks.triggers,
  };
});

vi.mock("../src/automation-workflow-trigger-sweep.js", () => ({
  sweepAutomationWorkflowTriggerEligibility: sweepMocks.workflowTriggers,
}));

vi.mock("../src/posthog-error-tracking.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog-error-tracking.js")>(
    "../src/posthog-error-tracking.js",
  );
  return {
    ...actual,
    sweepPosthogCaseProjections: sweepMocks.errorProjections,
  };
});

vi.mock("../src/posthog-connection.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog-connection.js")>(
    "../src/posthog-connection.js",
  );
  return {
    ...actual,
    sweepPosthogOauthAttempts: sweepMocks.oauthAttempts,
  };
});

const worker = (await import("../src/index.js")).default;

describe("minute automation and delivery cron isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepMocks.oauthAttempts.mockResolvedValue({ expired: 0, purged: 0 });
    sweepMocks.workflowTriggers.mockResolvedValue({
      workflows: 0,
      issued: 0,
      error_count: 0,
    });
    sweepMocks.errorProjections.mockResolvedValue({ projects: 0, projected: 0, changed: 0, errors: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts and awaits every sweep when lifecycle rejects", async () => {
    let releaseWebhook!: () => void;
    const webhookHeld = new Promise<void>((resolve) => {
      releaseWebhook = resolve;
    });
    sweepMocks.webhooks.mockImplementation(async () => {
      await webhookHeld;
      return { processed: 1 };
    });
    sweepMocks.lifecycle.mockRejectedValue(new Error(
      "forced lifecycle failure token=must_not_escape\nparams: sk_must_not_escape",
    ));
    sweepMocks.triggers.mockResolvedValue({ projects: 1, issued: 1 });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await worker.scheduled(
      {
        cron: "* * * * *",
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as unknown as ScheduledController,
      {} as Env,
      ctx,
    );
    expect(pending).toHaveLength(1);
    await vi.waitFor(() => {
      expect(sweepMocks.webhooks).toHaveBeenCalledTimes(1);
      expect(sweepMocks.oauthAttempts).toHaveBeenCalledTimes(1);
      expect(sweepMocks.lifecycle).toHaveBeenCalledTimes(1);
      expect(sweepMocks.triggers).toHaveBeenCalledTimes(1);
      expect(sweepMocks.workflowTriggers).toHaveBeenCalledTimes(1);
    });

    let rootSettled = false;
    void pending[0]!.finally(() => {
      rootSettled = true;
    });
    await Promise.resolve();
    expect(rootSettled).toBe(false);

    releaseWebhook();
    await expect(pending[0]).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining("automation_lifecycle"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("token=[REDACTED]"));
    expect(error.mock.calls.flat().join("\n")).not.toContain("must_not_escape");
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"webhook_deliveries":{"status":"fulfilled"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"posthog_oauth_attempts":{"status":"fulfilled"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"posthog_errors":{"status":"fulfilled"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"automation_triggers":{"status":"fulfilled"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"automation_workflow_triggers":{"status":"fulfilled"'));

  });

  it("captures every independently rejected subsystem", async () => {
    sweepMocks.webhooks.mockRejectedValue(new Error("webhook sweep failed"));
    sweepMocks.oauthAttempts.mockRejectedValue(new Error("oauth attempt sweep failed"));
    sweepMocks.errorProjections.mockRejectedValue(new Error("PostHog projection sweep failed"));
    sweepMocks.lifecycle.mockRejectedValue(new Error("lifecycle sweep failed"));
    sweepMocks.triggers.mockRejectedValue(new Error("trigger sweep failed"));
    sweepMocks.workflowTriggers.mockRejectedValue(new Error("workflow trigger sweep failed"));
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await worker.scheduled(
      {
        cron: "* * * * *",
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as unknown as ScheduledController,
      {} as Env,
      ctx,
    );
    await expect(pending[0]).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(6);
    expect(new Set(error.mock.calls.map((call) => {
      const record = JSON.parse(String(call[0])) as { sweep?: string };
      return record.sweep;
    }))).toEqual(new Set([
      "webhook_deliveries",
      "posthog_oauth_attempts",
      "posthog_errors",
      "automation_lifecycle",
      "automation_triggers",
      "automation_workflow_triggers",
    ]));
  });

  it("captures fulfilled lifecycle record failures without failing sibling sweeps", async () => {
    sweepMocks.webhooks.mockResolvedValue({ processed: 1 });
    sweepMocks.lifecycle.mockResolvedValue({
      error_count: 2,
      error_limit: 20,
      errors: [{ record_type: "runner_deadline_run", record_id: "run_bad" }],
      errors_truncated: false,
    });
    sweepMocks.triggers.mockResolvedValue({ projects: 1, issued: 1, error_count: 0 });
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    } as unknown as ExecutionContext;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await worker.scheduled(
      {
        cron: "* * * * *",
        scheduledTime: Date.now(),
        noRetry: () => undefined,
      } as unknown as ScheduledController,
      {} as Env,
      ctx,
    );
    await expect(pending[0]).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      sweep: "automation_lifecycle",
      error_count: 2,
      errors_truncated: false,
    });
    expect(sweepMocks.triggers).toHaveBeenCalledTimes(1);
  });
});
