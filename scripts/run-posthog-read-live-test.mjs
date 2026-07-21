#!/usr/bin/env node

// Authenticated, read-only smoke for an already-connected PostHog project.
// It never creates fixtures, changes provider state, detaches OAuth, or prints
// response records. An empty resource list proves connectivity and response
// shape only; it is not evidence that the product uses that PostHog feature.

import { loadAgentryCredentials } from "./lib/agentry-credentials.mjs";
import { pathToFileURL } from "node:url";

const REQUIRED_SCOPES = [
  "openid",
  "email",
  "project:read",
  "query:read",
  "event_definition:read",
  "property_definition:read",
  "error_tracking:read",
  "session_recording:read",
  "feature_flag:read",
  "survey:read",
  "experiment:read",
];
const REQUIRED_CAPABILITIES = [
  "project_read",
  "query_read",
  "event_definitions_read",
  "property_definitions_read",
  "error_tracking_read",
  "session_recordings_read",
  "feature_flags_read",
  "surveys_read",
  "experiments_read",
];
const RESOURCES = [
  {
    name: "session_recordings",
    path: "session-recordings",
    listKey: "session_recordings",
    detailKey: "session_recording",
  },
  {
    name: "feature_flags",
    path: "feature-flags",
    listKey: "feature_flags",
    detailKey: "feature_flag",
  },
  {
    name: "surveys",
    path: "surveys",
    listKey: "surveys",
    detailKey: "survey",
  },
  {
    name: "experiments",
    path: "experiments",
    listKey: "experiments",
    detailKey: "experiment",
  },
];
const RECORDING_CONTENT_KEYS = new Set([
  "content",
  "dom",
  "events",
  "network",
  "recording_content",
  "snapshot_data",
  "snapshots",
  "sources",
  "viewers",
]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SURVEY_RESPONSE_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function usage() {
  return [
    "Usage: node scripts/run-posthog-read-live-test.mjs [--project-id <id>] [--api <url>]",
    "",
    "Requires an existing owner credential and an Agentry project whose PostHog",
    "OAuth connection is already active. AGENTRY_PROJECT_ID supplies the project",
    "when --project-id is omitted. The owner key is loaded from",
    "AGENTRY_PRIVATE_API_KEY or ~/.agentry/credentials.json.",
    "",
    "Set both AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE and",
    "AGENTRY_POSTHOG_SURVEY_RESPONSES_UNTIL to opt into a bounded response read.",
    "Without both variables, only aggregate survey statistics are read.",
    "",
    "Empty lists are reported as connectivity_only: they prove the read boundary",
    "works, but do not prove runtime recording, flag use, survey rendering, or",
    "experiment exposure.",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { projectId: null, api: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--project-id") {
      options.projectId = requiredOptionValue(argv, ++index, "--project-id");
      continue;
    }
    if (arg === "--api") {
      options.api = requiredOptionValue(argv, ++index, "--api");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  return options;
}

function requiredOptionValue(argv, index, option) {
  const value = String(argv[index] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.\n${usage()}`);
  }
  return value;
}

function fail(message, detail) {
  const suffix = detail ? `\n${JSON.stringify(detail, null, 2)}` : "";
  throw new Error(`${message}${suffix}`);
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail);
}

export function validatedBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("AGENTRY_URL / --api must be an absolute URL.");
  }
  assert(
    !url.username && !url.password && !url.search && !url.hash && url.pathname === "/",
    "AGENTRY_URL / --api must be an exact origin without credentials, path, query, or fragment.",
  );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  assert(
    url.protocol === "https:" || (url.protocol === "http:" && loopback),
    "AGENTRY_URL / --api must use HTTPS outside loopback.",
  );
  return url.origin;
}

function boundedIntegerEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  assert(
    Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${name} must be an integer from ${minimum} through ${maximum}.`,
  );
  return parsed;
}

function safeRequestError(error) {
  return error instanceof Error ? { name: error.name } : { name: "unknown_error" };
}

async function readBoundedText(response, path) {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared)) {
    assert(
      Number(declared) <= MAX_RESPONSE_BYTES,
      "Live read exceeded the bounded response limit.",
      { path, status: response.status },
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail("Live read exceeded the bounded response limit.", {
          path,
          status: response.status,
        });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Live read returned invalid UTF-8.", { path, status: response.status });
  }
}

function createClient({ baseUrl, apiKey, timeoutMs, userAgent }) {
  async function request(method, path, { body, readBody = true } = {}) {
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "user-agent": userAgent,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      fail("Live request failed before a response was received.", {
        method,
        path,
        ...safeRequestError(error),
      });
    }
    if (!readBody) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, json: null };
    }
    const text = await readBoundedText(response, path);
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      fail("Live request did not return JSON.", { method, path, status: response.status });
    }
    return { status: response.status, json };
  }
  return { request };
}

function assertOk(result, method, path) {
  assert(result.status === 200, "Live read returned a non-200 response.", {
    method,
    path,
    status: result.status,
    error_code: typeof result.json?.error === "string" ? result.json.error : undefined,
  });
  assert(
    result.json && typeof result.json === "object" && !Array.isArray(result.json),
    "Live read did not return a JSON object.",
    { method, path, status: result.status },
  );
}

function assertReadBoundary(body, label) {
  assert(body.freshness?.source === "customer_posthog_cloud_api", `${label} freshness source is invalid.`);
  assert(body.freshness?.consistency === "provider_read", `${label} consistency is invalid.`);
  assert(
    body.freshness?.status === "complete_for_query_time",
    `${label} did not report complete provider-read status.`,
  );
  assert(
    body.data_boundary?.upstream_source === "customer_posthog_cloud" &&
      body.data_boundary?.raw_event_stream_retained === false &&
      body.data_boundary?.resource_snapshot_retained === false &&
      body.data_boundary?.session_recording_content_returned === false &&
      body.data_boundary?.provider_mutations_authorized === false,
    `${label} data boundary is not the read-only v2 contract.`,
  );
}

export function findForbiddenKey(value, forbidden, path = "$") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], forbidden, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) return `${path}.${key}`;
    const found = findForbiddenKey(child, forbidden, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export function safeResourceId(value, label) {
  const text = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string"
      ? value
      : "";
  assert(
    text.length > 0 && text.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(text),
    `${label} returned an invalid resource id.`,
  );
  return text;
}

export function surveyResponseWindow(env = process.env) {
  const since = env.AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE?.trim() || null;
  const until = env.AGENTRY_POSTHOG_SURVEY_RESPONSES_UNTIL?.trim() || null;
  assert(
    Boolean(since) === Boolean(until),
    "Set both AGENTRY_POSTHOG_SURVEY_RESPONSES_SINCE and AGENTRY_POSTHOG_SURVEY_RESPONSES_UNTIL, or neither.",
  );
  if (!since || !until) return null;
  const sinceEpoch = Date.parse(since);
  const untilEpoch = Date.parse(until);
  assert(
    Number.isFinite(sinceEpoch) && Number.isFinite(untilEpoch),
    "Survey response window values must be ISO-8601 dates or date-times.",
  );
  assert(
    untilEpoch >= sinceEpoch && untilEpoch - sinceEpoch <= MAX_SURVEY_RESPONSE_WINDOW_MS,
    "Survey response window must be ordered and no longer than 90 days.",
  );
  return { since, until };
}

async function assertUnavailable(client, unavailable) {
  for (const entry of unavailable) {
    const result = await client.request(entry.method, entry.path, {
      ...(entry.body === undefined ? {} : { body: entry.body }),
      readBody: false,
    });
    assert(result.status === 404, "A retired or mutating PostHog route is still reachable.", {
      method: entry.method,
      path: entry.path,
      status: result.status,
    });
  }
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = loadAgentryCredentials();
  const projectId = options.projectId || process.env.AGENTRY_PROJECT_ID?.trim() || null;
  const apiKey = credentials.apiKey;
  assert(projectId, "No project id available. Set AGENTRY_PROJECT_ID or pass --project-id.");
  assert(
    projectId.length <= 200 && /^[A-Za-z0-9_-]+$/.test(projectId),
    "The Agentry project id is invalid.",
  );
  assert(
    typeof apiKey === "string" && apiKey.startsWith("agentry_sk_") && apiKey.length <= 512,
    "No owner credential available. Set AGENTRY_PRIVATE_API_KEY or configure ~/.agentry/credentials.json.",
  );

  const baseUrl = validatedBaseUrl(options.api || credentials.serverUrl);
  const timeoutMs = boundedIntegerEnv(
    "AGENTRY_LIVE_HTTP_TIMEOUT_MS",
    DEFAULT_TIMEOUT_MS,
    1_000,
    120_000,
  );
  const userAgent = process.env.AGENTRY_POSTHOG_LIVE_TEST_USER_AGENT?.trim() ||
    "agentry-posthog-read-live-test/1.0";
  assert(userAgent.length <= 200 && !/[\r\n]/.test(userAgent), "Live-test User-Agent is invalid.");
  const responseWindow = surveyResponseWindow();
  const client = createClient({ baseUrl, apiKey, timeoutMs, userAgent });
  const projectPath = `/v1/projects/${encodeURIComponent(projectId)}`;

  const connectionPath = `${projectPath}/posthog-connection`;
  const connectionResult = await client.request("GET", connectionPath);
  assertOk(connectionResult, "GET", connectionPath);
  const connection = connectionResult.json.connection;
  assert(connection?.status === "active", "PostHog connection is not active.", {
    status: connection?.status ?? null,
  });
  const scopes = Array.isArray(connection.scopes) ? connection.scopes : [];
  assert(
    JSON.stringify([...new Set(scopes)].sort()) === JSON.stringify([...REQUIRED_SCOPES].sort()),
    "PostHog connection does not have the exact v2 OAuth scope set.",
    { granted_scope_count: scopes.length, required_scope_count: REQUIRED_SCOPES.length },
  );
  const capabilities = connection.capabilities;
  assert(
    capabilities?.version === "posthog-cloud-read-v2",
    "PostHog capability snapshot is not v2.",
  );
  for (const capability of REQUIRED_CAPABILITIES) {
    assert(capabilities[capability] === true, `Required capability ${capability} is not active.`);
  }
  assert(
    Array.isArray(capabilities.issues) && capabilities.issues.length === 0,
    "PostHog v2 capability snapshot reports read gaps.",
    { issue_count: Array.isArray(capabilities.issues) ? capabilities.issues.length : null },
  );

  const summary = {};
  const firstIds = {};
  for (const resource of RESOURCES) {
    const listPath = `${projectPath}/${resource.path}?limit=1&offset=0`;
    const listResult = await client.request("GET", listPath);
    assertOk(listResult, "GET", listPath);
    assertReadBoundary(listResult.json, resource.name);
    const items = listResult.json[resource.listKey];
    assert(Array.isArray(items), `${resource.name} list is not an array.`);

    if (resource.name === "session_recordings") {
      const forbiddenPath = findForbiddenKey(items, RECORDING_CONTENT_KEYS);
      assert(!forbiddenPath, "Session-recording list exposed replay content.", {
        forbidden_path: forbiddenPath,
      });
    }

    const first = items[0] ?? null;
    if (!first) {
      summary[resource.name] = {
        page_count: 0,
        detail_checked: false,
        evidence: "connectivity_only",
      };
      continue;
    }
    const id = safeResourceId(first.id, resource.name);
    firstIds[resource.name] = id;
    const detailPath = `${projectPath}/${resource.path}/${encodeURIComponent(id)}`;
    const detailResult = await client.request("GET", detailPath);
    assertOk(detailResult, "GET", detailPath);
    assertReadBoundary(detailResult.json, `${resource.name} detail`);
    assert(
      detailResult.json[resource.detailKey] &&
        typeof detailResult.json[resource.detailKey] === "object" &&
        !Array.isArray(detailResult.json[resource.detailKey]),
      `${resource.name} detail is not an object.`,
    );
    if (resource.name === "session_recordings") {
      const forbiddenPath = findForbiddenKey(
        detailResult.json[resource.detailKey],
        RECORDING_CONTENT_KEYS,
      );
      assert(!forbiddenPath, "Session-recording detail exposed replay content.", {
        forbidden_path: forbiddenPath,
      });
    }
    summary[resource.name] = {
      page_count: items.length,
      detail_checked: true,
      evidence: "live_provider_state",
    };
  }

  const surveyId = firstIds.surveys ?? null;
  if (surveyId) {
    const statsPath = `${projectPath}/surveys/${encodeURIComponent(surveyId)}/stats`;
    const statsResult = await client.request("GET", statsPath);
    assertOk(statsResult, "GET", statsPath);
    assertReadBoundary(statsResult.json, "survey stats");
    assert(
      statsResult.json.stats && typeof statsResult.json.stats === "object" &&
        !Array.isArray(statsResult.json.stats),
      "Survey stats response is not an object.",
    );
    assert(
      !findForbiddenKey(statsResult.json.stats, new Set(["raw_responses"])),
      "Survey stats exposed raw response rows.",
    );
    summary.survey_stats = { checked: true, evidence: "aggregate_provider_state" };

    if (responseWindow) {
      const query = new URLSearchParams({
        since: responseWindow.since,
        until: responseWindow.until,
        limit: "10",
        offset: "0",
      });
      const responsesPath = `${projectPath}/surveys/${encodeURIComponent(surveyId)}/responses?${query}`;
      const responsesResult = await client.request("GET", responsesPath);
      assertOk(responsesResult, "GET", responsesPath);
      assertReadBoundary(responsesResult.json, "survey responses");
      assert(Array.isArray(responsesResult.json.responses), "Survey responses are not an array.");
      summary.survey_responses = {
        checked: true,
        page_count: responsesResult.json.responses.length,
        evidence: responsesResult.json.responses.length === 0
          ? "connectivity_only"
          : "bounded_redacted_provider_rows",
      };
    } else {
      summary.survey_responses = { checked: false, reason: "explicit_window_not_set" };
    }
  } else {
    summary.survey_stats = { checked: false, reason: "no_survey_in_first_page" };
    summary.survey_responses = {
      checked: false,
      reason: responseWindow ? "no_survey_in_first_page" : "explicit_window_not_set",
    };
  }

  // Mutation probes use a deliberately nonexistent ID and invalid empty body.
  // If any retired route still exists, the test fails without targeting a real
  // provider resource. The snapshot probe uses the first recording only when
  // one was already returned, and always discards the response body.
  const sentinel = "agentry-live-smoke-nonexistent";
  const recordingForSnapshot = firstIds.session_recordings ?? sentinel;
  await assertUnavailable(client, [
    { method: "GET", path: `${projectPath}/session-recordings/${encodeURIComponent(recordingForSnapshot)}/snapshots` },
    { method: "GET", path: `${projectPath}/session-replays` },
    { method: "GET", path: `${projectPath}/session-replays/${sentinel}` },
    { method: "GET", path: `${projectPath}/session-replays/${sentinel}/snapshots` },
    { method: "GET", path: `${projectPath}/ab-tests` },
    { method: "GET", path: `${projectPath}/posthog/session-replay/status` },
    { method: "POST", path: `${projectPath}/posthog/session-replay/configure`, body: {} },
    { method: "POST", path: `${projectPath}/feature-flags`, body: {} },
    { method: "POST", path: `${projectPath}/feature-flags/evaluate`, body: {} },
    { method: "PATCH", path: `${projectPath}/feature-flags/${sentinel}`, body: {} },
    { method: "DELETE", path: `${projectPath}/feature-flags/${sentinel}` },
    { method: "POST", path: `${projectPath}/surveys`, body: {} },
    { method: "PATCH", path: `${projectPath}/surveys/${sentinel}`, body: {} },
    { method: "DELETE", path: `${projectPath}/surveys/${sentinel}` },
    { method: "POST", path: `${projectPath}/experiments`, body: {} },
    { method: "PATCH", path: `${projectPath}/experiments/${sentinel}`, body: {} },
    { method: "DELETE", path: `${projectPath}/experiments/${sentinel}` },
    { method: "PATCH", path: `${projectPath}/session-recordings/${sentinel}`, body: {} },
    { method: "DELETE", path: `${projectPath}/session-recordings/${sentinel}` },
  ]);

  console.log(JSON.stringify({
    ok: true,
    surface: "posthog_read_only_v2",
    project_id: projectId,
    connection: {
      status: "active",
      region: connection.region,
      posthog_project_id: connection.posthog_project_id,
      scope_count: scopes.length,
      capability_version: capabilities.version,
    },
    resources: summary,
    retired_and_mutating_routes: "unavailable_404",
    note: "Empty lists are connectivity-only evidence, not proof of runtime feature use.",
  }, null, 2));
}

const isDirectExecution = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) await main();
