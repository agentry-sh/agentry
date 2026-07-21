import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __clearRateLimitForTests } from "../src/rate-limit.js";
import {
  getQueryBlueprintTemplate,
  prepareQueryBlueprintExecution,
} from "../src/query-blueprint-catalog.js";
import { CUSTOMER_ANALYTICS_HOGQL_FILTER } from "../src/customer-data.js";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";
import {
  seedApprovedOnboardingPlan,
  seedVerifiedOnboardingReadiness,
} from "./onboarding-readiness-fixture.js";

const runHogQlMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>(
    "../src/posthog.js",
  );
  return {
    ...actual,
    isPosthogConfigured: () => true,
    runHogQl: (...args: unknown[]) => runHogQlMock(...args),
  };
});

const { createApp } = await import("../src/index.js");

const BLUEPRINT_ID = "ordered_funnel_period_compare";
const APPROVED_EVENTS = [
  "signup_started",
  "signup_completed",
  "activation_completed",
  "first_value_reached",
] as const;
const APPROVED_PLAN_HASH = "approved-funnel-plan-v1";
const VALID_PARAMS = {
  scheduled_for: "2026-07-13T00:00:00.000Z",
  period_days: 7,
  funnel_events_json: JSON.stringify(APPROVED_EVENTS),
  minimum_sample_size: 20,
};

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = createApp();
  runHogQlMock.mockReset();
  __clearRateLimitForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  __clearRateLimitForTests();
});

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

async function signup(email: string): Promise<{ apiKey: string }> {
  const response = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { api_key: string };
  return { apiKey: body.api_key };
}

async function createProject(apiKey: string): Promise<{ id: string }> {
  const response = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: { name: "exact-funnel-report" },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string }>;
}

async function saveSignalMap(
  projectId: string,
  events: readonly string[] = APPROVED_EVENTS,
) {
  await seedApprovedOnboardingPlan({
    db: getDbForUrl(env.TURSO_DATABASE_URL),
    project_id: projectId,
    approved_events: events,
    approved_plan_hash: APPROVED_PLAN_HASH,
  });
}

async function saveVerifiedOnboarding(projectId: string) {
  await seedVerifiedOnboardingReadiness({
    db: getDbForUrl(env.TURSO_DATABASE_URL),
    project_id: projectId,
    approved_events: APPROVED_EVENTS,
    approved_plan_hash: APPROVED_PLAN_HASH,
  });
}

function resultRow(
  period: "prior" | "current",
  sampleSize: number,
  sampleReady: boolean,
) {
  const current = period === "current";
  return {
    period,
    window_start: current ? "2026-07-06T00:00:00.000Z" : "2026-06-29T00:00:00.000Z",
    window_end: current ? "2026-07-13T00:00:00.000Z" : "2026-07-06T00:00:00.000Z",
    funnel_events_json: JSON.stringify(APPROVED_EVENTS),
    observed_users_json: JSON.stringify([sampleSize, Math.max(1, sampleSize - 5), Math.max(1, sampleSize - 10), 1]),
    counts_json: JSON.stringify([sampleSize, Math.max(0, sampleSize - 5), Math.max(0, sampleSize - 10), Math.max(0, sampleSize - 12)]),
    conversion_percentages_json: JSON.stringify([75, 66.67, 50]),
    overall_conversion_pct: 50,
    sample_size: sampleSize,
    minimum_sample_size: VALID_PARAMS.minimum_sample_size,
    all_selected_events_observed: true,
    sample_ready: sampleReady,
    readiness_status: sampleReady ? "ready" : "insufficient_entry_sample",
  };
}

async function runBlueprint(
  projectId: string,
  apiKey: string,
  params: Record<string, unknown> = VALID_PARAMS,
) {
  return call(`/v1/projects/${projectId}/query-blueprints/${BLUEPRINT_ID}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    json: { params },
  });
}

describe("exact scheduled funnel comparison blueprint", () => {
  it("publishes a strict machine-readable exact-window contract", async () => {
    const blueprint = getQueryBlueprintTemplate(BLUEPRINT_ID);
    expect(blueprint).not.toBeNull();
    expect(blueprint).toMatchObject({
      backend: "analytics",
      strict_params: true,
      required_event_list_param: "funnel_events_json",
      query_builder: "ordered_funnel_period_compare",
      automation_readiness: {
        kind: "all_rows_boolean",
        column: "sample_ready",
        expected_rows: 2,
        row_identity: { column: "period", values: ["prior", "current"] },
      },
      publication_safety: {
        status: "private_automation",
        public_access: "denied",
      },
    });
    expect(blueprint?.params.map((param) => param.name)).toEqual([
      "scheduled_for",
      "period_days",
      "funnel_events_json",
      "minimum_sample_size",
    ]);
    expect(blueprint?.query).toContain("generated server-side");

    const prepared = prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      scheduled_for: "2026-07-13T03:00:00+03:00",
    });
    expect(prepared.params.scheduled_for).toBe("2026-07-13T00:00:00.000Z");
    expect(prepared.query).toContain(
      "parseDateTimeBestEffort('2026-07-13T00:00:00.000Z'",
    );
    expect(prepared.query).toContain("toBool(");
    expect(prepared.query).toContain("timestamp >= prior_start");
    expect(prepared.query).toContain("timestamp < anchor");
    expect(prepared.query).toContain(CUSTOMER_ANALYTICS_HOGQL_FILTER);
    expect(prepared.query).toContain("s4 AS (");
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      moving_lookback_days: 7,
    })).toThrow(/unknown param/);
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      scheduled_for: "2026-07-13 00:00:00",
    })).toThrow(/RFC3339/);
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      scheduled_for: "2026-02-30T00:00:00Z",
    })).toThrow(/RFC3339/);
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      scheduled_for: "2026-07-13T00:00:00.123Z",
    })).toThrow(/whole second/);
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      period_days: 7.5,
    })).toThrow(/integer/);
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      minimum_sample_size: 0,
    })).toThrow(/at least 1/);
    const twoStep = prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      funnel_events_json: JSON.stringify(["started", "completed"]),
    });
    expect(twoStep.query).toContain("s2 AS (");
    expect(twoStep.query).not.toContain("s3 AS (");
    const twentyEvents = Array.from({ length: 20 }, (_, index) => `step_${index + 1}`);
    expect(prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      funnel_events_json: JSON.stringify(twentyEvents),
    }).query).toContain("s20 AS (");
    expect(() => prepareQueryBlueprintExecution(blueprint!, {
      ...VALID_PARAMS,
      funnel_events_json: JSON.stringify([...twentyEvents, "step_21"]),
    })).toThrow(/2 to 20/);

    const detail = await call(`/v1/query-blueprints/${BLUEPRINT_ID}`);
    expect(detail.status).toBe(200);
    const detailJson = await detail.json() as Record<string, unknown>;
    expect(detailJson).toMatchObject({
      strict_params: true,
      required_event_list_param: "funnel_events_json",
      automation_readiness: {
        row_identity: { values: ["prior", "current"] },
      },
      publishable: false,
    });
    expect(String(detailJson.next_action)).toContain("trigger receipt");
  });

  it("fails closed before querying when the onboarding plan is absent, unverified, or replaced", async () => {
    const owner = await signup("funnel-readiness-owner@example.com");
    const project = await createProject(owner.apiKey);

    const noSignalMap = await runBlueprint(project.id, owner.apiKey);
    expect(noSignalMap.status).toBe(428);
    expect(runHogQlMock).not.toHaveBeenCalled();

    await saveSignalMap(project.id);
    const noVerifiedOnboarding = await runBlueprint(project.id, owner.apiKey);
    expect(noVerifiedOnboarding.status).toBe(428);

    await saveVerifiedOnboarding(project.id);
    await saveSignalMap(project.id, [...APPROVED_EVENTS, "new_value_step"]);
    const replaced = await runBlueprint(project.id, owner.apiKey);
    expect(replaced.status).toBe(428);
    expect(runHogQlMock).not.toHaveBeenCalled();
  });

  it("rejects ambiguous, unapproved, synthetic, and malformed params", async () => {
    const owner = await signup("funnel-input-owner@example.com");
    const project = await createProject(owner.apiKey);
    await saveVerifiedOnboarding(project.id);

    const duplicate = await runBlueprint(project.id, owner.apiKey, {
      ...VALID_PARAMS,
      funnel_events_json: JSON.stringify([
        APPROVED_EVENTS[0],
        APPROVED_EVENTS[0],
      ]),
    });
    expect(duplicate.status).toBe(400);

    const unapproved = await runBlueprint(project.id, owner.apiKey, {
      ...VALID_PARAMS,
      funnel_events_json: JSON.stringify([...APPROVED_EVENTS, "purchase_completed"]),
    });
    expect(unapproved.status).toBe(412);

    const synthetic = await runBlueprint(project.id, owner.apiKey, {
      ...VALID_PARAMS,
      funnel_events_json: JSON.stringify([...APPROVED_EVENTS.slice(0, 3), "install.verify.synthetic"]),
    });
    expect(synthetic.status).toBe(412);

    const unknown = await runBlueprint(project.id, owner.apiKey, {
      ...VALID_PARAMS,
      days: 14,
    });
    expect(unknown.status).toBe(400);

    const movingAnchor = await runBlueprint(project.id, owner.apiKey, {
      ...VALID_PARAMS,
      scheduled_for: "now",
    });
    expect(movingAnchor.status).toBe(400);
    expect(runHogQlMock).not.toHaveBeenCalled();
  });

  it("runs exactly once and reports two-row readiness without moving sparse windows", async () => {
    const owner = await signup("funnel-run-owner@example.com");
    const project = await createProject(owner.apiKey);
    await saveVerifiedOnboarding(project.id);

    const blueprint = getQueryBlueprintTemplate(BLUEPRINT_ID)!;
    runHogQlMock.mockResolvedValueOnce({
      columns: blueprint.expected_columns,
      results: [
        resultRow("prior", 30, true),
        resultRow("current", 8, false),
      ],
    });

    const response = await runBlueprint(project.id, owner.apiKey, {
      ...VALID_PARAMS,
      scheduled_for: "2026-07-13T03:00:00+03:00",
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      row_count: number;
      input_readiness: {
        selected_events: string[];
        synthetic_rows: string;
      };
      automation_readiness: {
        ready: boolean;
        observed_row_identity: string[];
        failing_rows: string[];
        row_identity_matches: boolean;
      };
      next_action: string;
    };
    expect(body.row_count).toBe(2);
    expect(body.input_readiness).toMatchObject({
      selected_events: APPROVED_EVENTS,
      synthetic_rows: "server_excluded",
    });
    expect(body.automation_readiness).toMatchObject({
      ready: false,
      observed_row_identity: ["prior", "current"],
      failing_rows: ["current"],
      row_identity_matches: true,
    });
    expect(body.next_action).toContain("Do not generate or publish");
    expect(body.next_action).toContain("Keep the exact scheduled_for");
    expect(runHogQlMock).toHaveBeenCalledTimes(1);
    const query = String(runHogQlMock.mock.calls[0]?.[2] ?? "");
    expect(query).toContain("2026-07-13T00:00:00.000Z");
    expect(query).not.toContain("2026-07-13T03:00:00+03:00");
    expect(query).not.toMatch(/\bnow\s*\(/i);
    expect(runHogQlMock.mock.calls[0]?.[3]).toEqual({ cacheBust: true });
  });
});
