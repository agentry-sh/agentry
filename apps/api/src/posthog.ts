// Bounded, read-only PostHog Cloud access through one customer OAuth connection.

import { AgentryError, errors } from "@agentrysh/shared";
import type { Env } from "./env.js";
import { getPosthogConnectionAccess } from "./posthog-connection.js";

const POSTHOG_READ_TIMEOUT_MS = 10_000;
const POSTHOG_QUERY_TIMEOUT_MS = 45_000;
const POSTHOG_RESPONSE_LIMIT_BYTES = 1_048_576;
const POSTHOG_USER_AGENT = "agentry-api/1.0";

/**
 * Reports whether this deployment can decrypt customer OAuth connections.
 * Per-project readiness is enforced by getPosthogConnectionAccess().
 */
export function isPosthogConfigured(env: Env): boolean {
  return Boolean(env.AGENTRY_TOKEN_ENC_KEY);
}

async function fetchPosthogRead(
  url: string,
  init: RequestInit,
  operation: string,
  timeoutMs = POSTHOG_READ_TIMEOUT_MS,
): Promise<{ response: Response; bodyText: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (!next.value) continue;
        total += next.value.byteLength;
        if (total > POSTHOG_RESPONSE_LIMIT_BYTES) {
          controller.abort();
          throw errors.posthogUpstreamFailed({
            operation: `${operation} response body`,
            status: 502,
            body: `response exceeded ${POSTHOG_RESPONSE_LIMIT_BYTES} bytes`,
            nextAction: "Narrow the requested PostHog read window or page size, then retry.",
          });
        }
        chunks.push(next.value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { response, bodyText: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (error instanceof AgentryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw errors.posthogUpstreamFailed({
      operation,
      status: timedOut || /abort|timeout|timed out/i.test(message) ? 504 : 502,
      body: message,
      nextAction: "Retry this bounded read with backoff. Reconnect PostHog if authorization has expired.",
    });
  } finally {
    clearTimeout(timer);
  }
}

function parsePosthogJson<T>(bodyText: string, operation: string): T {
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw errors.posthogUpstreamFailed({
      operation,
      status: 502,
      body: "PostHog returned malformed JSON",
      nextAction: "Retry once. If this repeats, treat it as an upstream API compatibility issue.",
    });
  }
}

export interface RunHogQlOpts {
  cacheBust?: boolean;
  timeoutMs?: number;
}

export async function runHogQl(
  env: Env,
  projectId: string,
  query: string,
  opts: RunHogQlOpts = {},
): Promise<{ results: unknown[]; columns: string[] | null; types: string[] | null }> {
  const access = await getPosthogConnectionAccess(env, projectId);
  const effectiveQuery = opts.cacheBust
    ? `/* agentry_cache_bust_${Date.now()} */ ${query}`
    : query;
  const url = `${access.posthog_host}/api/environments/${access.posthog_project_id}/query/`;
  const { response, bodyText } = await fetchPosthogRead(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${access.access_token}`,
        "content-type": "application/json",
        "user-agent": POSTHOG_USER_AGENT,
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query: effectiveQuery },
        name: opts.cacheBust ? "agentry_cache_bust_hogql" : "agentry_hogql",
        client_query_id: crypto.randomUUID(),
      }),
    },
    "HogQL query",
    opts.timeoutMs ?? POSTHOG_QUERY_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw errors.posthogUpstreamFailed({
      operation: "HogQL query",
      status: response.status,
      body: bodyText,
      nextAction:
        "Fix invalid HogQL or reconnect the project's PostHog OAuth connection. Retry upstream failures with backoff.",
    });
  }
  const json = parsePosthogJson<{
    results?: unknown[];
    columns?: string[];
    types?: string[];
  }>(bodyText, "HogQL query");
  return {
    results: json.results ?? [],
    columns: json.columns ?? null,
    types: json.types ?? null,
  };
}

export function hogQlRowsToObjects(
  results: unknown[] | null | undefined,
  actualColumns: string[] | null | undefined,
  fallbackColumns: string[] = [],
): Array<Record<string, unknown>> {
  const columns = actualColumns && actualColumns.length > 0
    ? actualColumns
    : fallbackColumns;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of results ?? []) {
    if (Array.isArray(row)) {
      const object: Record<string, unknown> = {};
      for (let index = 0; index < row.length; index++) {
        object[columns[index] ?? `col_${index}`] = row[index];
      }
      rows.push(object);
    } else if (row && typeof row === "object") {
      rows.push(row as Record<string, unknown>);
    }
  }
  return rows;
}

interface PosthogReadOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface PosthogProjectReadOptions {
  query?: Record<string, string | number | boolean | undefined>;
}

// PostHog's Error Tracking query endpoints use POST for structured read filters.
// Every other POST is rejected before loading an OAuth token.
const POSTHOG_READ_ONLY_POST_PATHS = new Set([
  "error_tracking/query/issues",
  "error_tracking/query/issue",
  "error_tracking/query/issue_events",
]);

function normalizedPosthogApiPath(pathSuffix: string): string {
  return pathSuffix.replace(/^\/+/, "").replace(/\/+$/, "");
}

function posthogWriteNotAuthorized(operation: string): AgentryError {
  return new AgentryError({
    status: 403,
    code: "posthog_write_not_authorized",
    message: "Agentry's PostHog OAuth connection is read-only.",
    nextAction:
      "Send telemetry and source maps directly to PostHog. Perform PostHog mutations with separately authorized human credentials.",
    details: { operation, oauth_authority: "read_only" },
  });
}

function assertPosthogReadOnlyRequest(
  method: NonNullable<PosthogReadOptions["method"]>,
  pathSuffix: string,
): void {
  if (method === "GET") return;
  if (POSTHOG_READ_ONLY_POST_PATHS.has(normalizedPosthogApiPath(pathSuffix))) return;
  throw posthogWriteNotAuthorized(`${method} ${pathSuffix}`);
}

export async function posthogTeamApi<T = unknown>(
  env: Env,
  projectId: string,
  pathSuffix: string,
  opts: PosthogReadOptions = {},
): Promise<{ teamId: number; status: number; data: T }> {
  const method = opts.method ?? "GET";
  assertPosthogReadOnlyRequest(method, pathSuffix);
  const access = await getPosthogConnectionAccess(env, projectId);
  const query = opts.query && Object.keys(opts.query).length > 0
    ? "?" + Object.entries(opts.query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&")
    : "";
  const normalizedPath = normalizedPosthogApiPath(pathSuffix);
  const url = `${access.posthog_host}/api/environments/${access.posthog_project_id}/${normalizedPath}${normalizedPath ? "/" : ""}${query}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${access.access_token}`,
    "user-agent": POSTHOG_USER_AGENT,
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const operation = `${method} ${pathSuffix}`;
  const { response, bodyText } = await fetchPosthogRead(
    url,
    { method, headers, body },
    operation,
  );
  if (!response.ok) {
    if (response.status === 404) throw errors.notFound("posthog_resource");
    throw errors.posthogUpstreamFailed({
      operation,
      status: response.status,
      body: bodyText,
    });
  }
  const data = bodyText
    ? parsePosthogJson<T>(bodyText, operation)
    : undefined as T;
  return { teamId: access.posthog_project_id, status: response.status, data };
}

/**
 * Executes a bounded GET against PostHog's project-scoped resource API.
 * Unlike posthogTeamApi this helper cannot express a non-GET request, keeping
 * feature flags, surveys, experiments, and recordings observational only.
 */
export async function posthogProjectApi<T = unknown>(
  env: Env,
  projectId: string,
  pathSuffix: string,
  opts: PosthogProjectReadOptions = {},
): Promise<{ teamId: number; posthogHost: string; status: number; data: T }> {
  const access = await getPosthogConnectionAccess(env, projectId);
  const normalizedPath = normalizedPosthogApiPath(pathSuffix);
  const query = opts.query && Object.keys(opts.query).length > 0
    ? "?" + Object.entries(opts.query)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&")
    : "";
  const url = `${access.posthog_host}/api/projects/${access.posthog_project_id}/${normalizedPath}${normalizedPath ? "/" : ""}${query}`;
  const operation = `GET ${pathSuffix}`;
  const { response, bodyText } = await fetchPosthogRead(
    url,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${access.access_token}`,
        accept: "application/json",
        "user-agent": POSTHOG_USER_AGENT,
      },
    },
    operation,
  );
  if (!response.ok) {
    if (response.status === 404) throw errors.notFound("posthog_resource");
    throw errors.posthogUpstreamFailed({
      operation,
      status: response.status,
      body: bodyText,
    });
  }
  const data = bodyText
    ? parsePosthogJson<T>(bodyText, operation)
    : undefined as T;
  return {
    teamId: access.posthog_project_id,
    posthogHost: access.posthog_host,
    status: response.status,
    data,
  };
}
