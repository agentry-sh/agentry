#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { loadAgentryCredentials } from "./lib/agentry-credentials.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const USER_AGENT = process.env.AGENTRY_QUERY_PERF_USER_AGENT ?? "agentry-query-perf-test/1.0";
const DEFAULT_TIMEOUT_MS = 75_000;
const DEFAULT_RUNS = 5;
const DEFAULT_WARMUPS = 1;
const DEFAULT_BUNDLE_RUNS = 3;

const PREFERRED_BLUEPRINT_RUNS = [
  "active_cases_top",
  "errors_by_hour_24h",
  "errors_after_last_deploy",
  "top_users_by_errors",
  "unique_users_24h",
  "deploy_frequency_30d",
  "top_events_30d",
  "active_users_daily",
  "event_count_per_day",
  "conversion_rate",
  "funnel_3_step",
];

function usageText() {
  return [
    "Usage: node scripts/run-query-side-performance-test.mjs [options]",
    "",
    "Read-only benchmark for Agentry query-side endpoints. Measures time until",
    "the full response body is downloaded and JSON parsed, not just first byte.",
    "",
    "Options:",
    `  --runs <n>          Measured runs per endpoint. Defaults to ${DEFAULT_RUNS}.`,
    `  --warmups <n>       Warm-up runs per endpoint, excluded from stats. Defaults to ${DEFAULT_WARMUPS}.`,
    `  --bundle-runs <n>   Parallel daily-use bundle runs. Defaults to ${DEFAULT_BUNDLE_RUNS}.`,
    `  --timeout-ms <n>    Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
    "  --project-id <id>   Project id. Defaults to AGENTRY_PROJECT_ID.",
    "  --api <url>         Override AGENTRY_URL / credentials server_url.",
    "  --out-dir <path>    Artifact directory. Defaults to tmp/query-side-perf-<timestamp>.",
    "  --skip-hogql        Skip PostHog-backed analytics query/blueprint endpoints.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    runs: DEFAULT_RUNS,
    warmups: DEFAULT_WARMUPS,
    bundleRuns: DEFAULT_BUNDLE_RUNS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    projectId: null,
    api: null,
    outDir: null,
    skipHogql: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usageText());
      process.exit(0);
    } else if (arg === "--runs") {
      out.runs = Number(argv[++i]);
    } else if (arg === "--warmups") {
      out.warmups = Number(argv[++i]);
    } else if (arg === "--bundle-runs") {
      out.bundleRuns = Number(argv[++i]);
    } else if (arg === "--timeout-ms") {
      out.timeoutMs = Number(argv[++i]);
    } else if (arg === "--project-id") {
      out.projectId = String(argv[++i] ?? "");
    } else if (arg === "--api") {
      out.api = String(argv[++i] ?? "");
    } else if (arg === "--out-dir") {
      out.outDir = String(argv[++i] ?? "");
    } else if (arg === "--skip-hogql") {
      out.skipHogql = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  for (const [name, value] of Object.entries({
    runs: out.runs,
    warmups: out.warmups,
    bundleRuns: out.bundleRuns,
    timeoutMs: out.timeoutMs,
  })) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`--${name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)} must be an integer >= 0`);
    }
  }
  if (out.runs < 1) throw new Error("--runs must be >= 1");
  if (out.timeoutMs < 1_000) throw new Error("--timeout-ms must be >= 1000");
  return out;
}


function resolveProjectBinding(options, credentials) {
  const projectId = options.projectId || process.env.AGENTRY_PROJECT_ID?.trim() || null;
  const api = options.api || process.env.AGENTRY_URL || credentials.serverUrl;
  return { projectId, api };
}

function fail(message, detail) {
  const error = new Error(detail ? `${message}\n${JSON.stringify(detail, null, 2)}` : message);
  error.detail = detail;
  throw error;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function byteLength(text) {
  return Buffer.byteLength(text ?? "", "utf8");
}

function statusCounts(samples) {
  const out = {};
  for (const sample of samples) {
    const key = String(sample.status ?? 0);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function shapeSummary(json) {
  if (json == null) return { kind: "empty", top_level_keys: [], item_counts: {} };
  if (Array.isArray(json)) return { kind: "array", top_level_keys: [], item_counts: { array: json.length } };
  if (typeof json !== "object") return { kind: typeof json, top_level_keys: [], item_counts: {} };

  const counts = {};
  for (const [key, value] of Object.entries(json)) {
    if (Array.isArray(value)) counts[key] = value.length;
  }
  if (Array.isArray(json.rows)) counts.rows = json.rows.length;
  if (Array.isArray(json.cases)) counts.cases = json.cases.length;
  if (Array.isArray(json.deploys)) counts.deploys = json.deploys.length;
  if (Array.isArray(json.analytics_events)) counts.analytics_events = json.analytics_events.length;
  if (Array.isArray(json.blueprints)) counts.blueprints = json.blueprints.length;
  if (Array.isArray(json.suggestions)) counts.suggestions = json.suggestions.length;
  if (json.keys && typeof json.keys === "object" && !Array.isArray(json.keys)) {
    counts.keyed_events = Object.keys(json.keys).length;
    counts.property_keys = Object.values(json.keys)
      .filter(Array.isArray)
      .reduce((sum, values) => sum + values.length, 0);
  }
  if (typeof json.row_count === "number") counts.row_count = json.row_count;
  if (typeof json.count === "number") counts.count = json.count;

  return {
    kind: "object",
    top_level_keys: Object.keys(json).sort(),
    item_counts: counts,
  };
}

function summarizeEndpoint(endpoint, samples) {
  const measured = samples.filter((sample) => sample.phase === "measured");
  const ok = measured.filter((sample) => sample.accepted);
  const totals = measured.map((sample) => sample.total_ms);
  const header = measured.map((sample) => sample.header_ms);
  const bodyAndParse = measured.map((sample) => sample.body_and_parse_ms);
  const parse = measured.map((sample) => sample.parse_ms);
  const sizes = measured.map((sample) => sample.bytes);
  const last = measured[measured.length - 1] ?? samples[samples.length - 1] ?? null;

  return {
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    category: endpoint.category,
    auth: endpoint.auth,
    backend: endpoint.backend ?? null,
    description: endpoint.description,
    accepted_statuses: endpoint.acceptedStatuses ?? null,
    runs: measured.length,
    ok_runs: ok.length,
    failed_runs: measured.length - ok.length,
    status_counts: statusCounts(measured),
    latency_ms: {
      min: round(totals.length ? Math.min(...totals) : 0),
      p50: round(percentile(totals, 50)),
      p95: round(percentile(totals, 95)),
      max: round(totals.length ? Math.max(...totals) : 0),
      mean: round(mean(totals)),
    },
    header_ms: {
      p50: round(percentile(header, 50)),
      p95: round(percentile(header, 95)),
    },
    body_and_parse_ms: {
      p50: round(percentile(bodyAndParse, 50)),
      p95: round(percentile(bodyAndParse, 95)),
    },
    parse_ms: {
      p50: round(percentile(parse, 50), 3),
      p95: round(percentile(parse, 95), 3),
    },
    bytes: {
      mean: Math.round(mean(sizes)),
      max: sizes.length ? Math.max(...sizes) : 0,
    },
    shape: last?.shape ?? null,
    error: last?.error ?? null,
  };
}

function redactErrorText(value) {
  if (typeof value !== "string") return value;
  // Historical artifacts may still contain a retired public-ingest token.
  return value
    .replace(/agentry_sk_[A-Za-z0-9._-]+/g, "agentry_sk_<redacted>")
    .replace(/agentry_pk_[A-Za-z0-9._-]+/g, "agentry_pk_<redacted>")
    .replace(/agp_[A-Za-z0-9._-]+/g, "agp_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer <redacted>");
}

async function requestOnce(baseUrl, endpoint, { apiKey, timeoutMs, phase, run }) {
  const url = /^https?:\/\//i.test(endpoint.path) ? endpoint.path : `${baseUrl}${endpoint.path}`;
  const headers = {
    "user-agent": USER_AGENT,
    accept: "application/json",
  };
  if (endpoint.body !== undefined) headers["content-type"] = "application/json";
  if (endpoint.auth === "api_key") headers.authorization = `Bearer ${apiKey}`;

  const started = performance.now();
  let headerAt = started;
  let text = "";
  let json = null;
  let parseMs = 0;
  try {
    const response = await fetch(url, {
      method: endpoint.method,
      headers,
      body: endpoint.body === undefined ? undefined : JSON.stringify(endpoint.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    headerAt = performance.now();
    text = await response.text();
    const bodyReadAt = performance.now();
    try {
      const parseStarted = performance.now();
      json = text ? JSON.parse(text) : null;
      parseMs = performance.now() - parseStarted;
    } catch (error) {
      json = null;
      parseMs = performance.now() - bodyReadAt;
    }
    const finished = performance.now();
    const accepted = response.ok || (endpoint.acceptedStatuses ?? []).includes(response.status);
    return {
      endpoint_id: endpoint.id,
      phase,
      run,
      ok: response.ok,
      accepted,
      status: response.status,
      total_ms: finished - started,
      header_ms: headerAt - started,
      body_and_parse_ms: finished - headerAt,
      parse_ms: parseMs,
      bytes: byteLength(text),
      shape: shapeSummary(json),
      json,
      error: response.ok
        ? null
        : {
            code: typeof json?.error?.code === "string" ? json.error.code : null,
            message: redactErrorText(typeof json?.error?.message === "string" ? json.error.message : text.slice(0, 300)),
          },
    };
  } catch (error) {
    const finished = performance.now();
    return {
      endpoint_id: endpoint.id,
      phase,
      run,
      ok: false,
      accepted: false,
      status: 0,
      total_ms: finished - started,
      header_ms: headerAt - started,
      body_and_parse_ms: finished - headerAt,
      parse_ms: 0,
      bytes: byteLength(text),
      shape: null,
      json: null,
      error: {
        name: error instanceof Error ? error.name : "FetchError",
        message: redactErrorText(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

async function probeJson(baseUrl, endpoint, opts) {
  return (await probeSample(baseUrl, endpoint, opts)).json;
}

async function probeSample(baseUrl, endpoint, opts) {
  return requestOnce(baseUrl, endpoint, { ...opts, phase: "discovery", run: 1 });
}

function defaultParams(blueprint) {
  const params = {};
  for (const param of Array.isArray(blueprint?.params) ? blueprint.params : []) {
    if (Object.prototype.hasOwnProperty.call(param, "default")) {
      params[param.name] = param.default;
    }
  }
  return params;
}

function paramsForBlueprint(blueprint, selectedEvents) {
  const params = defaultParams(blueprint);
  const event1 = selectedEvents[0];
  const event2 = selectedEvents[1] ?? event1;
  const event3 = selectedEvents[2] ?? event2;

  for (const param of Array.isArray(blueprint?.params) ? blueprint.params : []) {
    if (!param?.required || params[param.name] != null) continue;
    if (param.name === "event_name") params[param.name] = event1;
    else if (param.name === "event_a") params[param.name] = event1;
    else if (param.name === "event_b") params[param.name] = event2;
    else if (param.name === "step1") params[param.name] = event1;
    else if (param.name === "step2") params[param.name] = event2;
    else if (param.name === "step3") params[param.name] = event3;
    else if (param.name === "signup_event") params[param.name] = event1;
    else if (param.name === "activity_event") params[param.name] = event2;
  }

  const missing = (blueprint.params ?? [])
    .filter((param) => param.required && params[param.name] == null)
    .map((param) => param.name);
  return missing.length > 0 ? null : params;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const str = typeof value === "string" ? value.trim() : "";
    if (!str || seen.has(str)) continue;
    seen.add(str);
    out.push(str);
  }
  return out;
}

function buildEndpoint({
  id,
  method = "GET",
  path: endpointPath,
  category,
  auth = "api_key",
  description,
  body,
  backend,
  acceptedStatuses,
}) {
  return { id, method, path: endpointPath, category, auth, description, body, backend, acceptedStatuses };
}

function buildRawAnalyticsQuery(filter, kind) {
  if (!filter) return null;
  if (kind === "counts") {
    return [
      "SELECT event, count() AS occurrences, max(timestamp) AS last_seen",
      "FROM events",
      `WHERE ${filter} AND timestamp > now() - INTERVAL 30 DAY`,
      "GROUP BY event",
      "ORDER BY occurrences DESC",
      "LIMIT 200",
    ].join("\n");
  }
  return [
    "SELECT event, timestamp, distinct_id",
    "FROM events",
    `WHERE ${filter} AND timestamp > now() - INTERVAL 30 DAY`,
    "ORDER BY timestamp DESC",
    "LIMIT 500",
  ].join("\n");
}

async function discover(baseUrl, projectId, apiKey, timeoutMs, skipHogql) {
  const opts = { apiKey, timeoutMs };
  const onboardingEndpoint = buildEndpoint({
    id: "onboarding_state.discovery",
    path: `/v1/projects/${projectId}/onboarding`,
    category: "readiness",
    description: "Read-only discovery of the current server-owned onboarding state.",
    acceptedStatuses: [404],
  });
  const eventNamesEndpoint = buildEndpoint({
    id: "event_names.discovery",
    path: `/v1/projects/${projectId}/event-names`,
    category: "analytics",
    description: "Discovery read for observed events and customer filter.",
  });
  const casesEndpoint = buildEndpoint({
    id: "cases.discovery",
    path: `/v1/projects/${projectId}/cases?status=all&limit=200`,
    category: "cases",
    description: "Discovery read for case detail target.",
  });
  const usersEndpoint = buildEndpoint({
    id: "users.discovery",
    path: `/v1/projects/${projectId}/users?days=30&limit=50`,
    category: "users",
    description: "Discovery read for distinct_id summary target.",
  });
  const blueprintsEndpoint = buildEndpoint({
    id: "query_blueprints.discovery",
    path: "/v1/query-blueprints",
    category: "blueprints",
    auth: "none",
    description: "Discovery read for blueprint runs.",
  });

  const [onboardingSample, eventNames, cases, users, blueprints] = await Promise.all([
    probeSample(baseUrl, onboardingEndpoint, opts),
    skipHogql ? Promise.resolve(null) : probeJson(baseUrl, eventNamesEndpoint, opts),
    probeJson(baseUrl, casesEndpoint, opts),
    probeJson(baseUrl, usersEndpoint, opts),
    probeJson(baseUrl, blueprintsEndpoint, opts),
  ]);

  const onboarding = onboardingSample.status === 200 ? onboardingSample.json : null;
  const approvedEvents = uniqueStrings(
    onboarding?.status === "source_verified" && Array.isArray(onboarding?.plan?.milestones)
      ? onboarding.plan.milestones.map((milestone) => milestone?.event)
      : [],
  );
  const observedEvents = uniqueStrings(
    Array.isArray(eventNames?.analytics_events)
      ? eventNames.analytics_events.map((item) => item?.event)
      : [],
  );
  const selectedEvents = uniqueStrings([...approvedEvents, ...observedEvents]).slice(0, 50);
  const caseId = Array.isArray(cases?.cases) && cases.cases.length > 0 ? cases.cases[0]?.id : null;
  const distinctId = Array.isArray(users?.users) && users.users.length > 0 ? users.users[0]?.distinct_id ?? users.users[0]?.user_id : null;
  const customerFilter =
    typeof eventNames?.customer_data_filter?.hogql_where === "string"
      ? eventNames.customer_data_filter.hogql_where
      : null;
  const blueprintList = Array.isArray(blueprints?.blueprints) ? blueprints.blueprints : [];

  return {
    selected_events: selectedEvents,
    onboarding_available: onboardingSample.status === 200,
    onboarding_status: typeof onboarding?.status === "string" ? onboarding.status : null,
    case_id: typeof caseId === "string" ? caseId : null,
    distinct_id: typeof distinctId === "string" ? distinctId : null,
    customer_filter_available: Boolean(customerFilter),
    customer_filter: customerFilter,
    blueprints: blueprintList,
  };
}

function buildEndpoints({ projectId, discovery, skipHogql }) {
  const endpoints = [
    buildEndpoint({
      id: "cases_list_full",
      path: `/v1/projects/${projectId}/cases?status=all&limit=200`,
      category: "cases",
      description: "Max-size case list read.",
    }),
    buildEndpoint({
      id: "deploys_list_full",
      path: `/v1/projects/${projectId}/deploys?limit=200`,
      category: "deploys",
      description: "Max-size deploy list read.",
    }),
    buildEndpoint({
      id: "project_health",
      path: `/v1/projects/${projectId}/health`,
      category: "project",
      description: "Project PostHog connection and control-plane health summary.",
    }),
    buildEndpoint({
      id: "next_steps",
      path: `/v1/projects/${projectId}/next-steps`,
      category: "project",
      description: "State-aware suggested workflows.",
    }),
    buildEndpoint({
      id: "users_list",
      path: `/v1/projects/${projectId}/users?days=30&limit=50`,
      category: "users",
      description: "Top affected users list.",
    }),
    buildEndpoint({
      id: "query_blueprints_list",
      path: "/v1/query-blueprints",
      category: "blueprints",
      auth: "none",
      description: "All deterministic query templates.",
    }),
    buildEndpoint({
      id: "query_blueprint_detail_top_events",
      path: "/v1/query-blueprints/top_events_30d",
      category: "blueprints",
      auth: "none",
      description: "Single query-blueprint detail.",
    }),
  ];

  if (discovery.onboarding_available) {
    endpoints.unshift(
      buildEndpoint({
        id: "onboarding_state",
        path: `/v1/projects/${projectId}/onboarding`,
        category: "readiness",
        description: "Current canonical onboarding state; this benchmark never mutates or synthesizes readiness.",
      }),
    );
  }

  if (discovery.case_id) {
    endpoints.push(
      buildEndpoint({
        id: "case_detail",
        path: `/v1/cases/${discovery.case_id}`,
        category: "cases",
        description: "Full PostHog-backed case detail with deploy context and affected users.",
      }),
      buildEndpoint({
        id: "case_users",
        path: `/v1/cases/${discovery.case_id}/users`,
        category: "users",
        description: "Affected users for one case.",
      }),
    );
  }

  if (discovery.distinct_id) {
    endpoints.push(
      buildEndpoint({
        id: "user_summary",
        path: `/v1/projects/${projectId}/users/${encodeURIComponent(discovery.distinct_id)}/summary`,
        category: "users",
        description: "Composed user dossier for one distinct_id.",
      }),
    );
  }

  if (!skipHogql) {
    endpoints.push(
      buildEndpoint({
        id: "event_names",
        path: `/v1/projects/${projectId}/event-names`,
        category: "analytics",
        backend: "posthog_hogql",
        description: "Observed event names and operational event catalog.",
      }),
    );
    if (discovery.selected_events.length > 0) {
      endpoints.push(buildEndpoint({
        id: "event_property_keys",
        path: `/v1/projects/${projectId}/event-property-keys?events=${encodeURIComponent(discovery.selected_events.join(","))}`,
        category: "analytics",
        backend: "posthog_hogql",
        description: "Property-key sampling for source-verified or historically observed events.",
      }));
    }

    const countsQuery = buildRawAnalyticsQuery(discovery.customer_filter, "counts");
    const recentQuery = buildRawAnalyticsQuery(discovery.customer_filter, "recent");
    if (countsQuery) {
      endpoints.push(
        buildEndpoint({
          id: "raw_analytics_event_counts_30d",
          method: "POST",
          path: `/v1/projects/${projectId}/analytics/query`,
          category: "analytics",
          backend: "posthog_hogql",
          description: "Custom HogQL aggregate over 30-day events, limit 200.",
          body: { query: countsQuery },
        }),
      );
    }
    if (recentQuery) {
      endpoints.push(
        buildEndpoint({
          id: "raw_analytics_recent_events_500",
          method: "POST",
          path: `/v1/projects/${projectId}/analytics/query`,
          category: "analytics",
          backend: "posthog_hogql",
          description: "Custom HogQL recent event rows, limit 500, omitting properties.",
          body: { query: recentQuery },
        }),
      );
    }
  }

  const blueprintsById = new Map(discovery.blueprints.map((blueprint) => [blueprint.id, blueprint]));
  for (const blueprintId of PREFERRED_BLUEPRINT_RUNS) {
    const blueprint = blueprintsById.get(blueprintId);
    if (!blueprint) continue;
    if (skipHogql && blueprint.backend === "analytics") continue;
    const params = paramsForBlueprint(blueprint, discovery.selected_events);
    if (!params) continue;
    endpoints.push(
      buildEndpoint({
        id: `blueprint_run_${blueprintId}`,
        method: "POST",
        path: `/v1/projects/${projectId}/query-blueprints/${blueprintId}/run`,
        category: "blueprints",
        backend: blueprint.backend,
        description: `Run query blueprint ${blueprintId}.`,
        body: { params },
      }),
    );
  }

  return endpoints;
}

async function benchmarkEndpoint(baseUrl, endpoint, opts) {
  const samples = [];
  for (let i = 0; i < opts.warmups; i += 1) {
    samples.push(await requestOnce(baseUrl, endpoint, {
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      phase: "warmup",
      run: i + 1,
    }));
  }
  for (let i = 0; i < opts.runs; i += 1) {
    const sample = await requestOnce(baseUrl, endpoint, {
      apiKey: opts.apiKey,
      timeoutMs: opts.timeoutMs,
      phase: "measured",
      run: i + 1,
    });
    samples.push(sample);
  }
  return { endpoint, samples, summary: summarizeEndpoint(endpoint, samples) };
}

async function benchmarkBundle(baseUrl, bundleEndpoints, opts) {
  const runs = [];
  for (let i = 0; i < opts.bundleRuns; i += 1) {
    const started = performance.now();
    const samples = await Promise.all(bundleEndpoints.map((endpoint) =>
      requestOnce(baseUrl, endpoint, {
        apiKey: opts.apiKey,
        timeoutMs: opts.timeoutMs,
        phase: "bundle",
        run: i + 1,
      }),
    ));
    const finished = performance.now();
    runs.push({
      run: i + 1,
      ok: samples.every((sample) => sample.accepted),
      total_ms: finished - started,
      endpoint_count: bundleEndpoints.length,
      bytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
      http_failed_endpoints: samples.filter((sample) => !sample.ok).map((sample) => sample.endpoint_id),
      unaccepted_endpoints: samples.filter((sample) => !sample.accepted).map((sample) => sample.endpoint_id),
    });
  }
  const timings = runs.map((run) => run.total_ms);
  return {
    runs,
    summary: {
      runs: runs.length,
      ok_runs: runs.filter((run) => run.ok).length,
      endpoint_count: bundleEndpoints.length,
      endpoint_ids: bundleEndpoints.map((endpoint) => endpoint.id),
      latency_ms: {
        min: round(timings.length ? Math.min(...timings) : 0),
        p50: round(percentile(timings, 50)),
        p95: round(percentile(timings, 95)),
        max: round(timings.length ? Math.max(...timings) : 0),
        mean: round(mean(timings)),
      },
      bytes: {
        mean: Math.round(mean(runs.map((run) => run.bytes))),
        max: runs.length ? Math.max(...runs.map((run) => run.bytes)) : 0,
      },
    },
  };
}

function buildMarkdown(summary) {
  const lines = [
    "# Query-Side Performance Test",
    "",
    `Run ID: \`${summary.run_id}\``,
    `Target API: \`${summary.base_url}\``,
    `Project ID: \`${summary.project_id}\``,
    `Status: ${summary.ok ? "PASS" : "FAIL"}`,
    `Measured at: ${summary.started_at}`,
    `Measured runs per endpoint: ${summary.options.runs} after ${summary.options.warmups} warm-up run(s)`,
    "",
    "## Slowest Endpoints By p95",
    "",
    "| Endpoint | Backend | Accepted | p50 ms | p95 ms | Max ms | Mean bytes | Shape |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];

  for (const endpoint of [...summary.endpoints].sort((a, b) => b.latency_ms.p95 - a.latency_ms.p95)) {
    const shapeBits = endpoint.shape
      ? Object.entries(endpoint.shape.item_counts ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")
      : "";
    lines.push(
      `| \`${endpoint.id}\` | ${endpoint.backend ?? endpoint.category} | ${endpoint.ok_runs}/${endpoint.runs} | ${endpoint.latency_ms.p50} | ${endpoint.latency_ms.p95} | ${endpoint.latency_ms.max} | ${endpoint.bytes.mean} | ${shapeBits || endpoint.shape?.kind || ""} |`,
    );
  }

  if (summary.bundle?.summary?.runs) {
    lines.push(
      "",
      "## Parallel Daily-Use Bundle",
      "",
      `Endpoints: ${summary.bundle.summary.endpoint_ids.map((id) => `\`${id}\``).join(", ")}`,
      "",
      `- Runs: ${summary.bundle.summary.ok_runs}/${summary.bundle.summary.runs} OK`,
      `- p50: ${summary.bundle.summary.latency_ms.p50}ms`,
      `- p95: ${summary.bundle.summary.latency_ms.p95}ms`,
      `- max: ${summary.bundle.summary.latency_ms.max}ms`,
      `- mean bytes: ${summary.bundle.summary.bytes.mean}`,
    );
  }

  if (summary.failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const failure of summary.failures) {
      lines.push(`- \`${failure.id}\`: ${JSON.stringify(failure.status_counts)} ${failure.error?.message ?? ""}`);
    }
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- Timings measure fetch start to full body read plus JSON parse.",
    "- Raw response bodies are not written to disk; artifacts contain timing and shape metadata only.",
    "- PostHog/HogQL-backed endpoints are expected to be slower and have a 45s upstream contract.",
  );

  return `${lines.join("\n")}\n`;
}

function stripRawSamples(results) {
  return results.map(({ endpoint, samples, summary }) => ({
    endpoint,
    summary,
    samples: samples.map(({ json, ...sample }) => sample),
  }));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = loadAgentryCredentials();
  if (!credentials.apiKey) {
    fail("No API key available. Set AGENTRY_PRIVATE_API_KEY or create ~/.agentry/credentials.json.");
  }

  const binding = resolveProjectBinding(options, credentials);
  if (!binding.projectId) {
    fail("No project id available. Set AGENTRY_PROJECT_ID or pass --project-id.");
  }

  const startedAt = Date.now();
  const runId = `query-side-perf-${new Date(startedAt).toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
  const outDir = path.resolve(REPO_ROOT, options.outDir ?? path.join("tmp", runId));
  mkdirSync(outDir, { recursive: true });

  console.log(`Query-side performance test: ${binding.api}`);
  console.log(`Project: ${binding.projectId}`);
  console.log("Running discovery...");

  const discovery = await discover(
    binding.api,
    binding.projectId,
    credentials.apiKey,
    options.timeoutMs,
    options.skipHogql,
  );
  const endpoints = buildEndpoints({
    projectId: binding.projectId,
    discovery,
    skipHogql: options.skipHogql,
  });

  const summary = {
    ok: false,
    run_id: runId,
    base_url: binding.api,
    project_id: binding.projectId,
    started_at: new Date(startedAt).toISOString(),
    finished_at: null,
    duration_ms: 0,
    out_dir: outDir,
    user_agent: USER_AGENT,
    options,
    discovery: {
      selected_event_count: discovery.selected_events.length,
      onboarding_available: discovery.onboarding_available,
      onboarding_status: discovery.onboarding_status,
      has_case_detail_target: Boolean(discovery.case_id),
      has_user_summary_target: Boolean(discovery.distinct_id),
      customer_filter_available: discovery.customer_filter_available,
      blueprint_count: discovery.blueprints.length,
    },
    endpoints: [],
    bundle: null,
    failures: [],
  };

  const results = [];
  for (const [index, endpoint] of endpoints.entries()) {
    console.log(`[${index + 1}/${endpoints.length}] ${endpoint.id}`);
    const result = await benchmarkEndpoint(binding.api, endpoint, {
      apiKey: credentials.apiKey,
      timeoutMs: options.timeoutMs,
      runs: options.runs,
      warmups: options.warmups,
    });
    results.push(result);
    summary.endpoints.push(result.summary);
  }

  if (options.bundleRuns > 0) {
    const bundleIds = new Set([
      "onboarding_state",
      "event_names",
      "event_property_keys",
      "cases_list_full",
      "deploys_list_full",
      "project_health",
      "next_steps",
      "query_blueprints_list",
    ]);
    const bundleEndpoints = endpoints.filter((endpoint) => bundleIds.has(endpoint.id));
    console.log(`Parallel bundle (${bundleEndpoints.length} endpoints)`);
    summary.bundle = await benchmarkBundle(binding.api, bundleEndpoints, {
      apiKey: credentials.apiKey,
      timeoutMs: options.timeoutMs,
      bundleRuns: options.bundleRuns,
    });
  }

  summary.failures = summary.endpoints.filter((endpoint) => endpoint.failed_runs > 0);
  summary.ok = summary.failures.length === 0 && (!summary.bundle || summary.bundle.summary.ok_runs === summary.bundle.summary.runs);
  summary.finished_at = new Date().toISOString();
  summary.duration_ms = Date.now() - startedAt;

  writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(outDir, "samples.json"), `${JSON.stringify(stripRawSamples(results), null, 2)}\n`);
  writeFileSync(path.join(outDir, "summary.md"), buildMarkdown(summary));

  console.log("");
  console.log(buildMarkdown(summary));
  console.log(`Artifacts: ${outDir}`);

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
