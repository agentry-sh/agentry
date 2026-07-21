import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errors, uuidv7 } from "@agentrysh/shared";
import { cases, deploys } from "@agentry/db/schema";
import { CUSTOMER_ANALYTICS_HOGQL_FILTER } from "../src/customer-data.js";
import {
  createTestProjectCredential,
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const runHogQlMock = vi.hoisted(() => vi.fn());
const fireWebhooksMock = vi.hoisted(() => vi.fn());
const getPosthogIssueEventsMock = vi.hoisted(() => vi.fn());

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
    runHogQl: (...args: unknown[]) => runHogQlMock(...args),
  };
});

vi.mock("../src/webhooks.js", async () => {
  const actual = await vi.importActual<typeof import("../src/webhooks.js")>("../src/webhooks.js");
  return {
    ...actual,
    fireWebhooks: (...args: unknown[]) => fireWebhooksMock(...args),
  };
});

vi.mock("../src/posthog-error-tracking.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog-error-tracking.js")>(
    "../src/posthog-error-tracking.js",
  );
  return {
    ...actual,
    getPosthogIssueEvents: (...args: unknown[]) => getPosthogIssueEventsMock(...args),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = createApp();
  runHogQlMock.mockReset();
  fireWebhooksMock.mockReset();
  getPosthogIssueEventsMock.mockReset();
  fireWebhooksMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  disposeTestEnv(env);
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

describe("agent-facing analytics endpoints", () => {
  it("runs ad-hoc analytics queries and discovers event names and property keys", async () => {
    const user = await signup("analytics-agent@example.com");
    const project = await createProject(user.apiKey, "analytics-agent");

    runHogQlMock
      .mockResolvedValueOnce({
        columns: ["version"],
        types: ["String"],
        results: [["1.2.3"]],
      })
      .mockResolvedValueOnce({
        columns: ["event", "c", "last_seen"],
        types: ["String", "UInt64", "UInt64"],
        results: [
          ["signup_completed", 12, 1710000000],
          ["page_view", 99, 1710000100],
        ],
      })
      .mockResolvedValueOnce({
        columns: ["event", "prop_keys"],
        types: ["String", "Array(String)"],
        results: [
          ["signup_completed", ["plan", "source"]],
          ["purchase", ["amount"]],
        ],
      });

    const query = await call(`/v1/projects/${project.id}/analytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { query: "SELECT version()" },
    });
    expect(query.status).toBe(200);
    const queryJson = (await query.json()) as {
      columns: string[];
      rows: Array<{ version: string }>;
      row_count: number;
      freshness?: {
        source: string;
        consistency: string;
        cache_bust: boolean;
        retry_after_ms: number;
        next_action: string;
      };
      customer_data_filter?: {
        applied: boolean;
        include_synthetic: boolean;
        mode: string;
        hogql_where: string;
      };
      next_action?: string;
      results?: unknown;
    };
    expect(queryJson.columns).toEqual(["version"]);
    expect(queryJson.rows).toEqual([{ version: "1.2.3" }]);
    expect(queryJson.row_count).toBe(1);
    expect(queryJson.freshness).toEqual(expect.objectContaining({
      source: "customer_posthog_cloud_hogql",
      consistency: "eventual",
      cache_bust: true,
      retry_after_ms: 30_000,
    }));
    expect(queryJson.freshness?.next_action).toContain("re-query");
    expect(queryJson.customer_data_filter).toEqual(expect.objectContaining({
      applied: false,
      include_synthetic: false,
      mode: "no_events_table_reference",
      hogql_where: CUSTOMER_ANALYTICS_HOGQL_FILTER,
    }));
    expect(queryJson.next_action).toContain("Check freshness");
    expect(queryJson.results).toBeUndefined();
    expect(runHogQlMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      project.id,
      "SELECT version()",
      { cacheBust: true },
    );

    const names = await call(`/v1/projects/${project.id}/event-names`, {
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(names.status).toBe(200);
    const namesJson = (await names.json()) as {
      server_emitted: string[];
      analytics_events: Array<{ event: string; count: number }>;
      analytics_read: { ok: boolean; status: string; row_count: number };
      next_action?: string;
    };
    expect(namesJson.server_emitted).toContain("case.created");
    expect(namesJson.analytics_events).toEqual([
      { event: "signup_completed", count: 12, last_seen: 1710000000 },
      { event: "page_view", count: 99, last_seen: 1710000100 },
    ]);
    expect(namesJson.analytics_read).toEqual(expect.objectContaining({
      ok: true,
      status: "complete",
      row_count: 2,
    }));
    expect(namesJson.next_action ?? "").toContain("signal-map");
    expect(namesJson.next_action ?? "").toContain("verified onboarding receipt");
    expect(namesJson.next_action ?? "").toContain("analytics_read.ok");
    expect(namesJson.next_action ?? "").toContain("webhook subscription");

    const keys = await call(
      `/v1/projects/${project.id}/event-property-keys?events=signup_completed,purchase,missing`,
      {
        headers: { authorization: `Bearer ${user.apiKey}` },
      },
    );
    expect(keys.status).toBe(200);
    const keysJson = (await keys.json()) as {
      keys: Record<string, string[]>;
      analytics_read: {
        ok: boolean;
        status: string;
        row_count: number;
        requested_event_count?: number;
        observed_event_count?: number;
        missing_events?: string[];
      };
      next_action: string;
    };
    expect(keysJson.keys).toEqual({
      signup_completed: ["plan", "source"],
      purchase: ["amount"],
      missing: [],
    });
    expect(keysJson.analytics_read).toEqual(expect.objectContaining({
      ok: true,
      status: "partial",
      row_count: 2,
      requested_event_count: 3,
      observed_event_count: 2,
      missing_events: ["missing"],
    }));
    expect(keysJson.next_action).toContain("analytics_read.ok");
    expect(keysJson.next_action).toContain("analytics_read.status is partial");
    expect(keysJson.next_action).toContain("query-blueprint");
    expect(keysJson.next_action).not.toMatch(/recipe/i);

    const tooManyEvents = Array.from({ length: 51 }, (_, index) => `event_${index}`).join(",");
    const tooMany = await call(`/v1/projects/${project.id}/event-property-keys?events=${tooManyEvents}`, {
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(tooMany.status).toBe(400);
  });

  it("filters ad-hoc event HogQL by default and allows an explicit synthetic opt-out", async () => {
    const user = await signup("analytics-filter@example.com");
    const project = await createProject(user.apiKey, "analytics-filter");

    const rawQuery =
      "SELECT e.event, count() AS users FROM events e WHERE e.event = 'signup_completed' GROUP BY e.event";
    runHogQlMock
      .mockResolvedValueOnce({
        columns: ["event", "users"],
        types: ["String", "UInt64"],
        results: [["signup_completed", 2]],
      })
      .mockResolvedValueOnce({
        columns: ["event", "users"],
        types: ["String", "UInt64"],
        results: [["install.verify.http.synthetic", 1]],
      });

    const filtered = await call(`/v1/projects/${project.id}/analytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { query: rawQuery },
    });
    expect(filtered.status).toBe(200);
    const filteredJson = (await filtered.json()) as {
      rows: Array<{ event: string; users: number }>;
      customer_data_filter: {
        applied: boolean;
        include_synthetic: boolean;
        mode: string;
        hogql_where: string;
      };
    };
    expect(filteredJson.rows).toEqual([{ event: "signup_completed", users: 2 }]);
    expect(filteredJson.customer_data_filter).toEqual(expect.objectContaining({
      applied: true,
      include_synthetic: false,
      mode: "server_enforced",
      hogql_where: CUSTOMER_ANALYTICS_HOGQL_FILTER,
    }));
    expect(runHogQlMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      project.id,
      `SELECT e.event, count() AS users FROM (SELECT uuid, event, properties, timestamp, distinct_id, elements_chain, created_at, person_id FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}) AS e WHERE e.event = 'signup_completed' GROUP BY e.event`,
      { cacheBust: true },
    );

    const included = await call(`/v1/projects/${project.id}/analytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { query: rawQuery, include_synthetic: true },
    });
    expect(included.status).toBe(200);
    const includedJson = (await included.json()) as {
      customer_data_filter: {
        applied: boolean;
        include_synthetic: boolean;
        mode: string;
      };
    };
    expect(includedJson.customer_data_filter).toEqual(expect.objectContaining({
      applied: false,
      include_synthetic: true,
      mode: "disabled_by_request",
    }));
    expect(runHogQlMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      project.id,
      rawQuery,
      { cacheBust: true },
    );

    const invalid = await call(`/v1/projects/${project.id}/analytics/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { query: rawQuery, include_synthetic: "true" },
    });
    expect(invalid.status).toBe(400);
    expect(runHogQlMock).toHaveBeenCalledTimes(2);
  });

  it("does not turn analytics metadata read failures into empty coverage", async () => {
    const user = await signup("analytics-metadata-failure@example.com");
    const project = await createProject(user.apiKey, "analytics-metadata-failure");

    runHogQlMock.mockRejectedValueOnce(errors.posthogUpstreamFailed({
      operation: "event metadata",
      status: 502,
      body: "upstream unavailable",
    }));
    const names = await call(`/v1/projects/${project.id}/event-names`, {
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(names.status).toBe(502);
    const namesJson = (await names.json()) as { error?: { code?: string } };
    expect(namesJson.error?.code).toBe("posthog_upstream_failed");

    runHogQlMock.mockRejectedValueOnce(errors.posthogUpstreamFailed({
      operation: "event property metadata",
      status: 502,
      body: "upstream unavailable",
    }));
    const keys = await call(`/v1/projects/${project.id}/event-property-keys?events=signup_completed`, {
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(keys.status).toBe(502);
    const keysJson = (await keys.json()) as { error?: { code?: string } };
    expect(keysJson.error?.code).toBe("posthog_upstream_failed");
  });

});

describe("query blueprints", () => {
  it("lists query blueprints, serves details, and runs analytics blueprints with validation", async () => {
    const user = await signup("blueprints-analytics@example.com");
    const project = await createProject(user.apiKey, "blueprints-analytics");

    const list = await call("/v1/query-blueprints?category=events");
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as {
      blueprints: Array<{ id: string; category: string }>;
    };
    expect(listJson.blueprints.length).toBeGreaterThan(0);
    expect(listJson.blueprints.every((recipe) => recipe.category === "events")).toBe(true);

    const detail = await call("/v1/query-blueprints/active_users_daily");
    expect(detail.status).toBe(200);
    const detailJson = (await detail.json()) as { id: string; backend: string };
    expect(detailJson).toEqual(expect.objectContaining({ id: "active_users_daily", backend: "analytics" }));

    const missing = await call("/v1/query-blueprints/no_such_recipe");
    expect(missing.status).toBe(404);

    runHogQlMock.mockResolvedValueOnce({
      columns: ["day", "dau"],
      types: ["Date", "UInt64"],
      results: [["2026-05-20", 8]],
    });
    const run = await call(`/v1/projects/${project.id}/query-blueprints/active_users_daily/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { days: 7 } },
    });
    expect(run.status).toBe(200);
    const runJson = (await run.json()) as {
      backend: string;
      rows: Array<{ day: string; dau: number }>;
      row_count: number;
      freshness?: { source: string; retry_after_ms: number; next_action: string };
      next_action: string;
    };
    expect(runJson.backend).toBe("analytics");
    expect(runJson.rows).toEqual([{ day: "2026-05-20", dau: 8 }]);
    expect(runJson.row_count).toBe(1);
    expect(runJson.freshness).toEqual(expect.objectContaining({
      source: "posthog_hogql",
      retry_after_ms: 30_000,
    }));
    expect(runJson.freshness?.next_action).toContain("re-run");
    expect(runJson.next_action).toContain("check freshness");

    const invalid = await call(`/v1/projects/${project.id}/query-blueprints/active_users_daily/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { days: "seven" } },
    });
    expect(invalid.status).toBe(400);
  });

  it("does not silently default required semantic query blueprint params", async () => {
    const user = await signup("blueprints-required-params@example.com");
    const project = await createProject(user.apiKey, "blueprints-required-params");

    const retention = await call(`/v1/projects/${project.id}/query-blueprints/weekly_retention/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { weeks: 8, signup_event: "signup_completed" } },
    });
    expect(retention.status).toBe(400);
    const retentionJson = (await retention.json()) as {
      error?: { details?: { detail?: string }; message?: string };
    };
    expect(
      retentionJson.error?.details?.detail ?? retentionJson.error?.message ?? "",
    ).toContain("activity_event");

    const conversion = await call(`/v1/projects/${project.id}/query-blueprints/conversion_rate/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { event_a: "signup_completed" } },
    });
    expect(conversion.status).toBe(400);
    const conversionJson = (await conversion.json()) as {
      error?: { details?: { detail?: string }; message?: string };
    };
    expect(
      conversionJson.error?.details?.detail ?? conversionJson.error?.message ?? "",
    ).toContain("event_b");

    expect(runHogQlMock).not.toHaveBeenCalled();
  });

  it("requires event B to occur after event A for conversion_rate", async () => {
    const user = await signup("blueprints-conversion@example.com");
    const project = await createProject(user.apiKey, "blueprints-conversion");

    runHogQlMock.mockResolvedValueOnce({
      columns: ["users_a", "users_b", "conversion_pct"],
      types: ["UInt64", "UInt64", "Float64"],
      results: [[2, 1, 50]],
    });

    const res = await call(`/v1/projects/${project.id}/query-blueprints/conversion_rate/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { event_a: "signup_completed", event_b: "checkout_completed", days: 30 } },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: Array<{ users_a: number; users_b: number; conversion_pct: number }>;
    };
    expect(json.rows).toEqual([{ users_a: 2, users_b: 1, conversion_pct: 50 }]);

    expect(runHogQlMock).toHaveBeenCalledTimes(1);
    expect(runHogQlMock.mock.calls[0]?.[1]).toBe(project.id);
    const query = String(runHogQlMock.mock.calls[0]?.[2] ?? "");
    expect(query).toContain("event = 'signup_completed'");
    expect(query).toContain("e.event = 'checkout_completed'");
    expect(query).toContain("min(timestamp) AS event_a_at");
    expect(query).toContain("JOIN a ON a.distinct_id = e.distinct_id");
    expect(query).toContain("e.timestamp > a.event_a_at");
    expect(query).not.toContain("distinct_id IN (SELECT distinct_id FROM a)");
  });

  it("returns bounded drop-off users for replay follow-up", async () => {
    const user = await signup("blueprints-dropoff-users@example.com");
    const project = await createProject(user.apiKey, "blueprints-dropoff-users");

    runHogQlMock.mockResolvedValueOnce({
      columns: [
        "distinct_id",
        "entry_at",
        "last_seen_at",
        "minutes_observed",
        "session_id",
        "session_recording_id",
      ],
      types: ["String", "DateTime", "DateTime", "Int64", "String", "String"],
      results: [
        [
          "user-123",
          "2026-06-22T10:00:00Z",
          "2026-06-22T10:08:00Z",
          8,
          "session-123",
          "replay-123",
        ],
      ],
    });

    const res = await call(`/v1/projects/${project.id}/query-blueprints/funnel_dropoff_users/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: {
        params: {
          entry_event: "onboarding_started",
          completion_event: "onboarding_completed",
          days: 7,
          limit: 10,
        },
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: Array<{
        distinct_id: string;
        entry_at: string;
        last_seen_at: string;
        minutes_observed: number;
        session_id: string;
        session_recording_id: string;
      }>;
      render_hint: { notes?: string[] };
    };
    expect(json.rows).toEqual([
      {
        distinct_id: "user-123",
        entry_at: "2026-06-22T10:00:00Z",
        last_seen_at: "2026-06-22T10:08:00Z",
        minutes_observed: 8,
        session_id: "session-123",
        session_recording_id: "replay-123",
      },
    ]);
    expect(json.render_hint.notes?.join(" ")).toContain("investigation candidates");
    expect(json.render_hint.notes?.join(" ")).toContain("does not fetch or store replay snapshots");

    expect(runHogQlMock).toHaveBeenCalledTimes(1);
    expect(runHogQlMock.mock.calls[0]?.[1]).toBe(project.id);
    const query = String(runHogQlMock.mock.calls[0]?.[2] ?? "");
    expect(query).toContain("event = 'onboarding_started'");
    expect(query).toContain("e.event = 'onboarding_completed'");
    expect(query).toContain("completion.distinct_id IS NULL");
    expect(query).toContain("LIMIT 10");
    expect(query).toContain("properties['$session_id']");
    expect(query).toContain("properties['$session_recording_id']");
  });

  it("runs cohort and retention query blueprints with PostHog-safe aggregation shapes", async () => {
    const user = await signup("blueprints-cohorts@example.com");
    const project = await createProject(user.apiKey, "blueprints-cohorts");

    runHogQlMock
      .mockResolvedValueOnce({
        columns: ["cohort_week", "users"],
        types: ["Date", "UInt64"],
        results: [["2026-06-01", 3]],
      })
      .mockResolvedValueOnce({
        columns: ["cohort_week", "week_offset", "cohort_size", "retained_users", "retention_pct"],
        types: ["Date", "Int64", "UInt64", "UInt64", "Float64"],
        results: [["2026-06-01", 0, 3, 3, 100]],
      });

    const cohorts = await call(`/v1/projects/${project.id}/query-blueprints/users_by_cohort_signup_week/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { weeks: 12, signup_event: "signup_completed" } },
    });
    expect(cohorts.status).toBe(200);
    const cohortsJson = (await cohorts.json()) as {
      rows: Array<{ cohort_week: string; users: number }>;
    };
    expect(cohortsJson.rows).toEqual([{ cohort_week: "2026-06-01", users: 3 }]);

    const retention = await call(`/v1/projects/${project.id}/query-blueprints/weekly_retention/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { weeks: 8, signup_event: "signup_completed", activity_event: "core_product_used" } },
    });
    expect(retention.status).toBe(200);
    const retentionJson = (await retention.json()) as {
      rows: Array<{
        cohort_week: string;
        week_offset: number;
        cohort_size: number;
        retained_users: number;
        retention_pct: number;
      }>;
    };
    expect(retentionJson.rows).toEqual([
      {
        cohort_week: "2026-06-01",
        week_offset: 0,
        cohort_size: 3,
        retained_users: 3,
        retention_pct: 100,
      },
    ]);

    expect(runHogQlMock).toHaveBeenCalledTimes(2);
    expect(runHogQlMock.mock.calls[0]?.[1]).toBe(project.id);
    expect(runHogQlMock.mock.calls[1]?.[1]).toBe(project.id);
    const cohortQuery = String(runHogQlMock.mock.calls[0]?.[2] ?? "");
    const retentionQuery = String(runHogQlMock.mock.calls[1]?.[2] ?? "");
    expect(cohortQuery).toContain("INTERVAL 12 WEEK");
    expect(retentionQuery).toContain("INTERVAL 8 WEEK");
    expect(cohortQuery).toContain("event = 'signup_completed'");
    expect(retentionQuery).toContain("event = 'signup_completed'");
    expect(retentionQuery).toContain("event = 'core_product_used'");
    for (const query of [cohortQuery, retentionQuery]) {
      expect(query).not.toMatch(/toMonday\s*\(\s*(?:toDate(?:Time)?\s*\(\s*)?min\s*\(/i);
      expect(query).not.toMatch(/toDate(?:Time)?\s*\(\s*min\s*\(/i);
    }
    expect(cohortQuery).toContain("min(timestamp) AS first_seen_at");
    expect(retentionQuery).toContain("min(timestamp) AS first_seen_at");
    expect(cohortQuery).toContain("toMonday(first_seen_at) AS cohort_week");
    expect(retentionQuery).toContain("toMonday(first_seen_at) AS cohort");
    expect(retentionQuery).toContain("toMonday(timestamp) AS active_week");
    expect(retentionQuery).toContain("cohort_size");
    expect(retentionQuery).toContain("retention_pct");
  });

  it("runs the case-backed query blueprint handlers and enforces required params", async () => {
    const user = await signup("blueprints-cases@example.com");
    const project = await createProject(user.apiKey, "blueprints-cases");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(cases).values([
      {
        id: uuidv7(),
        projectId: project.id,
        providerIssueId: "issue-open",
        providerSnapshotHash: "a".repeat(64),
        providerProjectedAt: now - 10,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "fp-open",
        errorType: "TypeError",
        message: "open case",
        status: "active" as const,
        eventCount: 3,
        firstSeenAt: now - 30,
        lastSeenAt: now - 10,
        lastDeploySha: "deploy-1",
      },
      {
        id: uuidv7(),
        projectId: project.id,
        providerIssueId: "issue-resolved",
        providerSnapshotHash: "b".repeat(64),
        providerProjectedAt: now - 3500,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "fp-resolved",
        errorType: "ReferenceError",
        message: "resolved case",
        status: "resolved",
        eventCount: 9,
        firstSeenAt: now - 3600,
        lastSeenAt: now - 3500,
        lastDeploySha: "deploy-older",
      },
      {
        id: uuidv7(),
        projectId: project.id,
        providerIssueId: "issue-verify",
        providerSnapshotHash: "c".repeat(64),
        providerProjectedAt: now - 5,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "fp-verify",
        errorType: "AgentryVerifyError",
        message: "Synthetic test event from /v1/projects/:id/install/verify",
        status: "active" as const,
        eventCount: 99,
        firstSeenAt: now - 5,
        lastSeenAt: now - 5,
        lastDeploySha: "agentry-verify",
      },
    ]);
    const ciCredential = await createTestProjectCredential(env, project.id, "ci_deploy");
    await db.insert(deploys).values([
      {
        id: uuidv7(),
        projectId: project.id,
        sha: "deploy-1",
        trustLevel: "trusted_ci" as const,
        credentialKind: "ci_deploy" as const,
        credentialId: ciCredential.id,
        receivedAt: now - 60,
      },
      {
        id: uuidv7(),
        projectId: project.id,
        sha: "agentry-verify-test",
        branch: "agentry-verify",
        environment: "agentry-verify",
        message: "synthetic deploy from install verify",
        actor: "agentry",
        extraJson: JSON.stringify({ synthetic: true, source: "install_verify_http" }),
        trustLevel: "trusted_ci" as const,
        credentialKind: "ci_deploy" as const,
        credentialId: ciCredential.id,
        receivedAt: now - 1,
      },
    ]);

    const openCases = await call(`/v1/projects/${project.id}/query-blueprints/active_cases_top/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(openCases.status).toBe(200);
    const openCasesJson = (await openCases.json()) as {
      rows: Array<{ fingerprint?: string; message: string; event_count: number }>;
    };
    expect(openCasesJson.rows).toHaveLength(1);
    expect(openCasesJson.rows[0]?.message).toBe("open case");
    expect(openCasesJson.rows[0]?.event_count).toBe(3);

    runHogQlMock.mockResolvedValueOnce({
      columns: ["user_id", "error_count", "last_seen_at"],
      results: [["user-1", 2, new Date((now - 10) * 1000).toISOString()]],
    });

    const topUsers = await call(`/v1/projects/${project.id}/query-blueprints/top_users_by_errors/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
      json: { params: { days: 7 } },
    });
    expect(topUsers.status).toBe(200);
    const topUsersJson = (await topUsers.json()) as {
      rows: Array<{ user_id: string; error_count: number }>;
    };
    expect(topUsersJson.rows[0]).toEqual(expect.objectContaining({ user_id: "user-1", error_count: 2 }));

    runHogQlMock.mockResolvedValueOnce({
      columns: ["unique_users", "total_events"],
      results: [[1, 2]],
    });

    const uniqueUsers = await call(`/v1/projects/${project.id}/query-blueprints/unique_users_24h/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(uniqueUsers.status).toBe(200);
    const uniqueUsersJson = (await uniqueUsers.json()) as {
      rows: Array<{ unique_users: number; total_events: number }>;
    };
    expect(uniqueUsersJson.rows[0]).toEqual({ unique_users: 1, total_events: 2 });

    const missingFingerprint = await call(
      `/v1/projects/${project.id}/query-blueprints/users_affected_by_case/run`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${user.apiKey}` },
      },
    );
    expect(missingFingerprint.status).toBe(400);

    getPosthogIssueEventsMock.mockResolvedValueOnce({
      results: [
        {
          uuid: "event-1",
          distinct_id: "user-1",
          timestamp: new Date((now - 20) * 1000).toISOString(),
          properties: {},
        },
        {
          uuid: "event-2",
          distinct_id: "user-1",
          timestamp: new Date((now - 10) * 1000).toISOString(),
          properties: {},
        },
      ],
      hasMore: false,
      limit: 20,
      offset: 0,
      nextOffset: null,
    });

    const affectedUsers = await call(
      `/v1/projects/${project.id}/query-blueprints/users_affected_by_case/run`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${user.apiKey}` },
        json: { params: { fingerprint: "fp-open" } },
      },
    );
    expect(affectedUsers.status).toBe(200);
    const affectedUsersJson = (await affectedUsers.json()) as {
      rows: Array<{ user_id: string; error_count: number }>;
    };
    expect(affectedUsersJson.rows[0]).toEqual(expect.objectContaining({ user_id: "user-1", error_count: 2 }));

    runHogQlMock.mockResolvedValueOnce({
      columns: ["hour", "errors"],
      results: [[new Date((now - 3600) * 1000).toISOString(), 2]],
    });

    const byHour = await call(`/v1/projects/${project.id}/query-blueprints/errors_by_hour_24h/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(byHour.status).toBe(200);
    const byHourJson = (await byHour.json()) as {
      rows: Array<{ errors: number }>;
    };
    expect(byHourJson.rows.reduce((sum, row) => sum + Number(row.errors), 0)).toBe(2);

    const afterDeploy = await call(`/v1/projects/${project.id}/query-blueprints/errors_after_last_deploy/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(afterDeploy.status).toBe(200);
    const afterDeployJson = (await afterDeploy.json()) as {
      rows: Array<{ message: string; last_deploy_sha: string | null }>;
      render_hint?: { notes?: string[] };
    };
    expect(afterDeployJson.rows).toEqual([
      expect.objectContaining({ message: "open case", last_deploy_sha: "deploy-1" }),
    ]);
    expect(afterDeployJson.render_hint?.notes?.join(" ")).toContain("recorded customer deploy");

    const deployFrequency = await call(`/v1/projects/${project.id}/query-blueprints/deploy_frequency_30d/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(deployFrequency.status).toBe(200);
    const deployFrequencyJson = (await deployFrequency.json()) as {
      rows: Array<{ deploys: number }>;
    };
    expect(deployFrequencyJson.rows[0]?.deploys).toBe(1);
  });

  it("returns no errors_after_last_deploy rows when no deploy baseline exists", async () => {
    const user = await signup("blueprints-no-deploy-baseline@example.com");
    const project = await createProject(user.apiKey, "blueprints-no-deploy-baseline");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const now = Math.floor(Date.now() / 1000);

    await db.insert(cases).values({
      id: uuidv7(),
      projectId: project.id,
      providerIssueId: "issue-no-deploy",
      providerSnapshotHash: "d".repeat(64),
      providerProjectedAt: now - 20,
      providerEventClassification: "customer_exception",
      fingerprint: "fp-no-deploy",
      errorType: "TypeError",
      message: "case without deploy baseline",
      status: "active",
      eventCount: 1,
      firstSeenAt: now - 30,
      lastSeenAt: now - 20,
    });
    const res = await call(`/v1/projects/${project.id}/query-blueprints/errors_after_last_deploy/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: Array<{ message: string; latest_deploy_sha?: string | null; attribution?: string }>;
      row_count: number;
    };
    expect(json.rows).toEqual([]);
    expect(json.row_count).toBe(0);
  });

  it("includes latest deploy sha and attribution for errors_after_last_deploy rows", async () => {
    const user = await signup("blueprints-deploy-attribution@example.com");
    const project = await createProject(user.apiKey, "blueprints-deploy-attribution");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const now = Math.floor(Date.now() / 1000);

    const ciCredential = await createTestProjectCredential(env, project.id, "ci_deploy");
    await db.insert(deploys).values({
      id: uuidv7(),
      projectId: project.id,
      sha: "deploy-latest",
      trustLevel: "trusted_ci",
      credentialKind: "ci_deploy",
      credentialId: ciCredential.id,
      receivedAt: now - 60,
    });
    await db.insert(cases).values([
      {
        id: uuidv7(),
        projectId: project.id,
        providerIssueId: "issue-sha-match",
        providerSnapshotHash: "e".repeat(64),
        providerProjectedAt: now - 20,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "fp-sha-match",
        errorType: "TypeError",
        message: "sha matched case",
        status: "active" as const,
        eventCount: 2,
        firstSeenAt: now - 30,
        lastSeenAt: now - 20,
        lastDeploySha: "deploy-latest",
      },
      {
        id: uuidv7(),
        projectId: project.id,
        providerIssueId: "issue-time-only",
        providerSnapshotHash: "f".repeat(64),
        providerProjectedAt: now - 10,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "fp-time-only",
        errorType: "ReferenceError",
        message: "time only case",
        status: "active" as const,
        eventCount: 1,
        firstSeenAt: now - 20,
        lastSeenAt: now - 10,
      },
    ]);

    const res = await call(`/v1/projects/${project.id}/query-blueprints/errors_after_last_deploy/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      rows: Array<{
        message: string;
        last_deploy_sha: string | null;
        latest_deploy_sha: string | null;
        attribution: string;
      }>;
    };
    expect(json.rows).toEqual([
      expect.objectContaining({
        message: "time only case",
        last_deploy_sha: null,
        latest_deploy_sha: "deploy-latest",
        attribution: "time_after_latest_no_sha",
      }),
      expect.objectContaining({
        message: "sha matched case",
        last_deploy_sha: "deploy-latest",
        latest_deploy_sha: "deploy-latest",
        attribution: "sha_match",
      }),
    ]);
  });
});
