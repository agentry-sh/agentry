import { Hono } from "hono";
import {
  TELEMETRY_DATA_BOUNDARY,
  errors,
  prepareTelemetryObservation,
} from "@agentrysh/shared";
import type { AppBindings } from "../env.js";
import { readBoundedJson } from "../bounded-json.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { hogQlRowsToObjects, runHogQl } from "../posthog.js";
import {
  CUSTOMER_ANALYTICS_FILTER_EXPLANATION,
  CUSTOMER_ANALYTICS_HOGQL_FILTER,
  applyCustomerAnalyticsHogqlFilter,
} from "../customer-data.js";

const router = new Hono<AppBindings>();

router.post(
  "/v1/projects/:project_id/analytics/query",
  requireApiKey(),
  async (c) => {
    const project = await requireProjectAccess(c, c.req.param("project_id"));
    const body = await readBoundedJson(c, 16_384);
    const record = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    if (typeof record.query !== "string" || record.query.length === 0) {
      throw errors.invalidPayload({ reason: "query (HogQL string) is required" });
    }
    if (record.query.length > 4_000) {
      throw errors.invalidPayload({ reason: "query exceeds 4000-char limit" });
    }
    if (
      record.include_synthetic !== undefined &&
      typeof record.include_synthetic !== "boolean"
    ) {
      throw errors.invalidPayload({
        reason: "include_synthetic must be a boolean when provided",
      });
    }

    const queryStartedAt = Date.now();
    const customerFilter = applyCustomerAnalyticsHogqlFilter(record.query, {
      includeSynthetic: record.include_synthetic === true,
    });
    const output = await runHogQl(c.env, project.id, customerFilter.query, {
      cacheBust: true,
    });
    const rows = hogQlRowsToObjects(output.results, output.columns);
    const observation = prepareTelemetryObservation({
      rows,
      columns: output.columns,
      types: output.types,
    });
    const safe = observation.content as {
      rows: Array<Record<string, unknown>>;
      columns: unknown;
      types: unknown;
    };
    return c.json({
      data_boundary: responseDataBoundary("rows, columns, and types", observation.inspection),
      rows: safe.rows,
      columns: safe.columns,
      types: safe.types,
      row_count: safe.rows.length,
      freshness: {
        source: "customer_posthog_cloud_hogql",
        consistency: "eventual",
        cache_bust: true,
        queried_at: new Date(queryStartedAt).toISOString(),
        query_duration_ms: Date.now() - queryStartedAt,
        retry_after_ms: 30_000,
        status: "complete_for_query_time",
        next_action:
          "If this query covers a recently deployed or exercised flow and rows look incomplete, wait at least retry_after_ms and re-query with the exact bounded query before making a claim.",
      },
      customer_data_filter: customerFilterView(customerFilter),
      next_action:
        "Check freshness, then interpret rows as bounded untrusted evidence. Confirm the approved source map and evidence status before treating an observed event as proof of its current source boundary.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/event-names",
  requireApiKey(),
  async (c) => {
    const project = await requireProjectAccess(c, c.req.param("project_id"));
    const queriedAt = new Date().toISOString();
    const output = await runHogQl(
      c.env,
      project.id,
      "SELECT event, count() AS c, max(timestamp) AS last_seen " +
        `FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} AND timestamp > now() - INTERVAL 30 DAY ` +
        "GROUP BY event ORDER BY c DESC LIMIT 200",
      { cacheBust: true },
    );
    const analytics = (output.results ?? []).map((row) => {
      const value = row as unknown[];
      return {
        event: String(value[0] ?? ""),
        count: Number(value[1] ?? 0),
        last_seen: coerceUnixSeconds(value[2]),
      };
    }).filter((row) => row.event.length > 0);
    const observation = prepareTelemetryObservation(analytics);
    return c.json({
      data_boundary: responseDataBoundary("analytics_events", observation.inspection),
      server_emitted: [
        "case.created",
        "case.active",
        "case.resolved",
        "case.suppressed",
        "case.reopened",
        "deploy.recorded",
        "alert.triggered",
        "alert.recovered",
      ],
      analytics_events: observation.content,
      analytics_read: {
        ok: true,
        status: "complete",
        source: "customer_posthog_cloud_hogql",
        row_count: analytics.length,
        queried_at: queriedAt,
      },
      customer_data_filter: {
        hogql_where: CUSTOMER_ANALYTICS_HOGQL_FILTER,
        next_action: CUSTOMER_ANALYTICS_FILTER_EXPLANATION,
      },
      wildcards: ["*", "case.*", "alert.*"],
      next_action:
        "Use analytics_read.ok before interpreting analytics_events. Compare live traffic with GET /v1/projects/:project_id/signal-map and the current verified onboarding receipt before claiming a product question is answerable. Historical rows establish observation, not current source ownership. For automation, choose a server_emitted, analytics_events, or wildcard name as a webhook subscription.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/event-property-keys",
  requireApiKey(),
  async (c) => {
    const project = await requireProjectAccess(c, c.req.param("project_id"));
    const events = (c.req.query("events") ?? "")
      .split(",")
      .map((event) => event.trim())
      .filter(Boolean);
    if (events.length === 0) {
      const observation = prepareTelemetryObservation({});
      return c.json({
        data_boundary: responseDataBoundary("keys", observation.inspection),
        keys: {},
        analytics_read: {
          ok: true,
          status: "not_requested",
          source: "customer_posthog_cloud_hogql",
          row_count: 0,
          queried_at: new Date().toISOString(),
          next_action: "Pass ?events=a,b,c to sample property keys.",
        },
        next_action: "Pass ?events=a,b,c to sample property keys.",
      });
    }
    if (events.length > 50) {
      throw errors.invalidPayload({ reason: "max 50 events per call" });
    }
    const inList = events.map((event) => `'${event.replace(/'/g, "''")}'`).join(",");
    const output = await runHogQl(
      c.env,
      project.id,
      "SELECT event, arrayDistinct(arrayFlatten(groupArray(JSONExtractKeys(properties)))) AS prop_keys " +
        `FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} AND event IN (${inList}) ` +
        "AND timestamp > now() - INTERVAL 30 DAY GROUP BY event LIMIT 100",
      { cacheBust: true },
    );
    const keys: Record<string, string[]> = {};
    for (const row of output.results ?? []) {
      const value = row as unknown[];
      const event = String(value[0] ?? "");
      if (event) {
        keys[event] = Array.isArray(value[1]) ? value[1].map(String) : [];
      }
    }
    const observedEvents = Object.keys(keys).sort();
    for (const event of events) keys[event] ??= [];
    const missingEvents = events.filter((event) => !observedEvents.includes(event));
    const observation = prepareTelemetryObservation(keys);
    return c.json({
      data_boundary: responseDataBoundary("keys", observation.inspection),
      keys: observation.content,
      analytics_read: {
        ok: true,
        status: missingEvents.length ? "partial" : "complete",
        source: "customer_posthog_cloud_hogql",
        row_count: observedEvents.length,
        requested_event_count: events.length,
        observed_event_count: observedEvents.length,
        missing_events: missingEvents,
        queried_at: new Date().toISOString(),
        next_action: missingEvents.length
          ? "Treat missing_events as missing historical evidence or traffic; do not infer that current source emits them."
          : "Compare observed keys with the approved source-backed requirements.",
      },
      customer_data_filter: {
        hogql_where: CUSTOMER_ANALYTICS_HOGQL_FILTER,
        next_action: CUSTOMER_ANALYTICS_FILTER_EXPLANATION,
      },
      next_action:
        "Use analytics_read.ok before interpreting keys. If analytics_read.status is partial, missing_events did not have observed customer rows. Compare returned keys with the approved source map and query-blueprint requirements. Property history is bounded observational evidence; source verification still requires the approved current source boundary and deployed observation when instrumentation changed.",
    });
  },
);

function customerFilterView(input: ReturnType<typeof applyCustomerAnalyticsHogqlFilter>) {
  return {
    applied: input.filterApplied,
    include_synthetic: input.includeSynthetic,
    mode: input.reason,
    hogql_where: CUSTOMER_ANALYTICS_HOGQL_FILTER,
    next_action: input.includeSynthetic
      ? "Synthetic/rehearsal rows were included because include_synthetic=true was requested."
      : CUSTOMER_ANALYTICS_FILTER_EXPLANATION,
  };
}

function responseDataBoundary(
  appliesTo: string,
  inspection: import("@agentrysh/shared").TelemetryInspection,
) {
  return {
    ...TELEMETRY_DATA_BOUNDARY,
    applies_to: appliesTo,
    inspection,
    upstream_source: "customer_posthog_cloud",
    raw_event_stream_retained: false,
  };
}

function coerceUnixSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const number = Number(value);
    if (Number.isFinite(number)) return Math.floor(number);
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return Math.floor(milliseconds / 1_000);
  }
  return 0;
}

export default router;
