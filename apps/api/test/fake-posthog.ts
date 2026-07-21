import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The fake models only the PostHog Cloud authority Agentry still has:
 * project-scoped OAuth and bounded reads. Keep unsupported provider surfaces
 * absent so a test cannot accidentally make a retired Agentry proxy look real.
 */
export const FAKE_POSTHOG_READ_SCOPES = [
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
] as const;

export interface FakePosthogEvent {
  uuid?: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface FakePosthogIssue {
  id: string;
  name: string;
  description: string;
  status: "active" | "resolved" | "suppressed";
  first_seen: string;
  last_seen: string;
  aggregations: { occurrences: number; users: number; sessions?: number };
  impact?: { occurrences: number; users: number; sessions?: number };
  latest_release?: { version?: string; commit_id?: string } | null;
  eventUuids?: string[];
}

export interface FakePosthogProjectState {
  posthogProjectId: number;
  organizationId: string | null;
  authorizationCode: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  eventDefinitions: Array<Record<string, unknown>>;
  propertyDefinitions: Array<Record<string, unknown>>;
  capturedEvents: FakePosthogEvent[];
  errorIssues: FakePosthogIssue[];
  sessionRecordings: Array<Record<string, unknown>>;
  featureFlags: Array<Record<string, unknown>>;
  surveys: Array<Record<string, unknown>>;
  surveyResponses: Record<string, Array<Record<string, unknown>>>;
  surveyStats: Record<string, Record<string, unknown>>;
  experiments: Array<Record<string, unknown>>;
}

export interface FakePosthogRequest {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown>;
}

export interface FakePosthogUnexpectedRequest {
  method: string;
  path: string;
}

interface QueryResult {
  results: unknown[];
  columns: string[];
  types: string[];
}

const defaultOrganizationId = "11111111-1111-4111-8111-111111111111";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function parseSqlLiteral(query: string, field: string): string | null {
  const match = query.match(new RegExp(`${field}\\s*=\\s*'((?:''|[^'])*)'`, "i"));
  return match?.[1]?.replace(/''/g, "'") ?? null;
}

function parsePropertyLiteral(query: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = query.match(
    new RegExp(`properties\\.${escaped}\\s*=\\s*'((?:''|[^'])*)'`, "i"),
  );
  return match?.[1]?.replace(/''/g, "'") ?? null;
}

function parseSqlInList(query: string): string[] {
  const match = query.match(/event IN \(([^)]+)\)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((token) => token.trim().replace(/^'|'$/g, "").replace(/''/g, "'"))
    .filter(Boolean);
}

function publicIssue(issue: FakePosthogIssue): Omit<FakePosthogIssue, "eventUuids"> {
  const { eventUuids: _eventUuids, ...value } = issue;
  return value;
}

function numberOption(value: unknown, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
}

export class FakePosthogServer {
  readonly requests: FakePosthogRequest[] = [];
  readonly oauthTokenRequests: Array<{
    grant_type: string;
    client_id: string | null;
  }> = [];
  readonly oauthRevocationRequests: Array<{
    token_type_hint: string | null;
  }> = [];
  readonly queryRequests: Array<{
    project_id: number;
    query: string;
  }> = [];
  readonly unexpectedRequests: FakePosthogUnexpectedRequest[] = [];

  #server: Server | null = null;
  #projects = new Map<number, FakePosthogProjectState>();
  #revokedTokens = new Set<string>();

  baseUrl = "";

  addProject(
    input: Partial<FakePosthogProjectState> & { posthogProjectId?: number } = {},
  ): FakePosthogProjectState {
    const posthogProjectId = input.posthogProjectId ?? 42;
    if (this.#projects.has(posthogProjectId)) {
      throw new Error(`Fake PostHog project ${posthogProjectId} already exists.`);
    }
    const state: FakePosthogProjectState = {
      posthogProjectId,
      organizationId: input.organizationId === undefined
        ? defaultOrganizationId
        : input.organizationId,
      authorizationCode: input.authorizationCode ?? `provider-code-${posthogProjectId}`,
      accessToken: input.accessToken ?? `pha_read_${posthogProjectId}`,
      refreshToken: input.refreshToken ?? `phr_read_${posthogProjectId}`,
      scopes: input.scopes ? [...input.scopes] : [...FAKE_POSTHOG_READ_SCOPES],
      eventDefinitions: structuredClone(input.eventDefinitions ?? []),
      propertyDefinitions: structuredClone(input.propertyDefinitions ?? []),
      capturedEvents: structuredClone(input.capturedEvents ?? []),
      errorIssues: structuredClone(input.errorIssues ?? []),
      sessionRecordings: structuredClone(input.sessionRecordings ?? []),
      featureFlags: structuredClone(input.featureFlags ?? []),
      surveys: structuredClone(input.surveys ?? []),
      surveyResponses: structuredClone(input.surveyResponses ?? {}),
      surveyStats: structuredClone(input.surveyStats ?? {}),
      experiments: structuredClone(input.experiments ?? []),
    };
    this.#projects.set(posthogProjectId, state);
    return state;
  }

  getProject(posthogProjectId: number): FakePosthogProjectState | null {
    return this.#projects.get(posthogProjectId) ?? null;
  }

  requireProject(posthogProjectId: number): FakePosthogProjectState {
    const project = this.getProject(posthogProjectId);
    if (!project) throw new Error(`No fake PostHog project ${posthogProjectId} exists.`);
    return project;
  }

  /**
   * Simulates customer-owned telemetry already present in PostHog. This is a
   * local state helper, not an Agentry-facing capture endpoint.
   */
  pushEvent(
    posthogProjectId: number,
    event: Omit<FakePosthogEvent, "timestamp"> & { timestamp?: string },
  ): void {
    const project = this.requireProject(posthogProjectId);
    if (
      event.uuid &&
      project.capturedEvents.some((candidate) => candidate.uuid === event.uuid)
    ) return;
    project.capturedEvents.push({
      ...structuredClone(event),
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
  }

  /** Adds provider-owned Error Tracking read state without exposing a mutation route. */
  pushIssue(posthogProjectId: number, issue: FakePosthogIssue): void {
    this.requireProject(posthogProjectId).errorIssues.push(structuredClone(issue));
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.#server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) => {
      this.#server!.close((error) => error ? reject(error) : resolve());
    });
    this.#server = null;
    this.baseUrl = "";
    this.requests.length = 0;
    this.oauthTokenRequests.length = 0;
    this.oauthRevocationRequests.length = 0;
    this.queryRequests.length = 0;
    this.unexpectedRequests.length = 0;
    this.#projects.clear();
    this.#revokedTokens.clear();
  }

  private recordRequest(
    method: string,
    url: URL,
    body: Record<string, unknown>,
  ): void {
    const recordedBody = url.pathname.startsWith("/oauth/")
      ? Object.fromEntries(
        ["grant_type", "client_id", "token_type_hint"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      )
      : structuredClone(body);
    this.requests.push({
      method,
      path: url.pathname,
      query: url.search,
      body: recordedBody,
    });
  }

  private projectForToken(token: string): FakePosthogProjectState | null {
    if (!token || this.#revokedTokens.has(token)) return null;
    for (const project of this.#projects.values()) {
      if (project.accessToken === token) return project;
    }
    return null;
  }

  private authorizedProject(
    req: IncomingMessage,
    res: ServerResponse,
    posthogProjectId: number,
  ): FakePosthogProjectState | null {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const project = this.projectForToken(token);
    if (!project) {
      sendJson(res, 401, { error: "invalid_oauth_token" });
      return null;
    }
    if (project.posthogProjectId !== posthogProjectId) {
      sendJson(res, 403, { error: "oauth_token_not_scoped_to_project" });
      return null;
    }
    return project;
  }

  private tokenResponse(
    project: FakePosthogProjectState,
    includeIdToken: boolean,
  ): Record<string, unknown> {
    return {
      access_token: project.accessToken,
      refresh_token: project.refreshToken,
      expires_in: 3_600,
      token_type: "Bearer",
      scope: project.scopes.join(" "),
      ...(includeIdToken ? { id_token: "fake.header.signature" } : {}),
      scoped_teams: [project.posthogProjectId],
      ...(project.organizationId
        ? { scoped_organizations: [project.organizationId] }
        : {}),
    };
  }

  private handleToken(res: ServerResponse, body: Record<string, unknown>): void {
    const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
    this.oauthTokenRequests.push({
      grant_type: grantType,
      client_id: typeof body.client_id === "string" ? body.client_id : null,
    });
    let project: FakePosthogProjectState | undefined;
    if (grantType === "authorization_code" && typeof body.code === "string") {
      project = [...this.#projects.values()].find(
        (candidate) => candidate.authorizationCode === body.code,
      );
    } else if (
      grantType === "refresh_token" &&
      typeof body.refresh_token === "string" &&
      !this.#revokedTokens.has(body.refresh_token)
    ) {
      project = [...this.#projects.values()].find(
        (candidate) => candidate.refreshToken === body.refresh_token,
      );
    }
    if (!project) {
      sendJson(res, 400, { error: "invalid_grant" });
      return;
    }
    sendJson(
      res,
      200,
      this.tokenResponse(project, grantType === "authorization_code"),
    );
  }

  private handleRevocation(res: ServerResponse, body: Record<string, unknown>): void {
    this.oauthRevocationRequests.push({
      token_type_hint: typeof body.token_type_hint === "string"
        ? body.token_type_hint
        : null,
    });
    const token = typeof body.token === "string" ? body.token : "";
    const known = [...this.#projects.values()].some(
      (project) => project.accessToken === token || project.refreshToken === token,
    );
    if (!known) {
      sendJson(res, 400, { error: "invalid_token" });
      return;
    }
    this.#revokedTokens.add(token);
    sendJson(res, 200, {});
  }

  private handleHogQl(project: FakePosthogProjectState, query: string): QueryResult {
    if (/SELECT\s+1\b/i.test(query)) {
      const alias = query.match(/SELECT\s+1\s+AS\s+([a-zA-Z0-9_]+)/i)?.[1] ?? "one";
      return { results: [[1]], columns: [alias], types: ["UInt8"] };
    }

    if (query.includes("properties.$agentry_safe_error_message AS message")) {
      const sessionId = parsePropertyLiteral(
        query,
        "$agentry_onboarding_proof_session_id",
      );
      const rows = project.capturedEvents
        .filter((event) => event.event === "agentry_safe_error_proof")
        .filter((event) => !sessionId ||
          event.properties.$agentry_onboarding_proof_session_id === sessionId)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 100)
        .map((event) => [
          event.properties.$agentry_safe_error_message ?? null,
          event.properties.$agentry_tags ?? null,
          event.properties.$agentry_extra ?? null,
        ]);
      return {
        results: rows,
        columns: ["message", "tags", "extra"],
        types: ["String", "String", "String"],
      };
    }

    if (query.includes("count() AS n, min(timestamp) AS first_seen")) {
      const distinctId = parseSqlLiteral(query, "distinct_id");
      const events = project.capturedEvents
        .filter((event) => !distinctId || event.distinct_id === distinctId)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      return {
        results: [[
          events.length,
          events[0]?.timestamp ?? null,
          events.at(-1)?.timestamp ?? null,
        ]],
        columns: ["n", "first_seen", "last_seen"],
        types: ["UInt64", "DateTime", "DateTime"],
      };
    }

    if (query.includes("SELECT event, timestamp FROM events")) {
      const distinctId = parseSqlLiteral(query, "distinct_id");
      return {
        results: project.capturedEvents
          .filter((event) => !distinctId || event.distinct_id === distinctId)
          .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
          .slice(0, 20)
          .map((event) => [event.event, event.timestamp]),
        columns: ["event", "timestamp"],
        types: ["String", "DateTime"],
      };
    }

    if (query.includes("SELECT event, count() AS c")) {
      const requestedEvents = new Set(parseSqlInList(query));
      const aggregated = new Map<string, { count: number; lastSeen: string }>();
      for (const event of project.capturedEvents) {
        if (requestedEvents.size > 0 && !requestedEvents.has(event.event)) continue;
        const current = aggregated.get(event.event) ?? { count: 0, lastSeen: "" };
        current.count += 1;
        if (!current.lastSeen || event.timestamp > current.lastSeen) {
          current.lastSeen = event.timestamp;
        }
        aggregated.set(event.event, current);
      }
      return {
        results: [...aggregated.entries()]
          .map(([event, value]) => [event, value.count, value.lastSeen])
          .sort((left, right) => Number(right[1]) - Number(left[1]))
          .slice(0, 200),
        columns: ["event", "c", "last_seen"],
        types: ["String", "UInt64", "DateTime"],
      };
    }

    if (query.includes("JSONExtractKeys(properties)")) {
      const requestedEvents = new Set(parseSqlInList(query));
      const keysByEvent = new Map<string, Set<string>>();
      for (const event of project.capturedEvents) {
        if (requestedEvents.size > 0 && !requestedEvents.has(event.event)) continue;
        const keys = keysByEvent.get(event.event) ?? new Set<string>();
        Object.keys(event.properties).forEach((key) => keys.add(key));
        keysByEvent.set(event.event, keys);
      }
      return {
        results: [...keysByEvent.entries()].map(([event, keys]) => [
          event,
          [...keys].sort(),
        ]),
        columns: ["event", "prop_keys"],
        types: ["String", "Array(String)"],
      };
    }

    return { results: [], columns: [], types: [] };
  }

  private handleErrorTrackingRead(
    res: ServerResponse,
    project: FakePosthogProjectState,
    resource: string,
    body: Record<string, unknown>,
  ): void {
    if (resource === "issues") {
      const status = typeof body.status === "string" ? body.status : "active";
      const search = typeof body.searchQuery === "string"
        ? body.searchQuery.toLowerCase()
        : "";
      const limit = numberOption(body.limit, 50, 100);
      const offset = numberOption(body.offset, 0, Number.MAX_SAFE_INTEGER);
      const filtered = project.errorIssues
        .filter((issue) => status === "all" || issue.status === status)
        .filter((issue) => !search ||
          `${issue.name} ${issue.description}`.toLowerCase().includes(search))
        .sort((left, right) => right.last_seen.localeCompare(left.last_seen));
      const results = filtered.slice(offset, offset + limit).map(publicIssue);
      const nextOffset = offset + results.length;
      sendJson(res, 200, {
        results,
        hasMore: nextOffset < filtered.length,
        limit,
        offset,
        nextOffset: nextOffset < filtered.length ? nextOffset : null,
      });
      return;
    }

    const issueId = typeof body.issueId === "string" ? body.issueId : "";
    const issue = project.errorIssues.find((candidate) => candidate.id === issueId);
    if (!issue) {
      sendJson(res, 404, { error: "unknown_error_issue" });
      return;
    }
    if (resource === "issue") {
      sendJson(res, 200, publicIssue(issue));
      return;
    }

    const limit = numberOption(body.limit, 5, 20);
    const offset = numberOption(body.offset, 0, Number.MAX_SAFE_INTEGER);
    const eventIds = new Set(issue.eventUuids ?? []);
    const all = project.capturedEvents
      .filter((event) =>
        eventIds.has(event.uuid ?? "") ||
        event.properties.$exception_issue_id === issue.id
      )
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const results = all.slice(offset, offset + limit);
    const nextOffset = offset + results.length;
    sendJson(res, 200, {
      results,
      hasMore: nextOffset < all.length,
      limit,
      offset,
      nextOffset: nextOffset < all.length ? nextOffset : null,
    });
  }

  private requireScope(
    res: ServerResponse,
    project: FakePosthogProjectState,
    scope: string,
  ): boolean {
    if (project.scopes.includes(scope)) return true;
    sendJson(res, 403, {
      error: "insufficient_scope",
      required_scope: scope,
    });
    return false;
  }

  private handleResourceList(
    res: ServerResponse,
    url: URL,
    values: Array<Record<string, unknown>>,
  ): void {
    const limit = numberOption(url.searchParams.get("limit"), 100, 100);
    const offset = numberOption(
      url.searchParams.get("offset"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const results = values.slice(offset, offset + limit);
    const nextOffset = offset + results.length;
    const previousOffset = Math.max(0, offset - limit);
    const pageUrl = (pageOffset: number): string => {
      const next = new URL(url.pathname, this.baseUrl);
      next.searchParams.set("limit", String(limit));
      next.searchParams.set("offset", String(pageOffset));
      return next.toString();
    };
    sendJson(res, 200, {
      count: values.length,
      next: nextOffset < values.length ? pageUrl(nextOffset) : null,
      previous: offset > 0 ? pageUrl(previousOffset) : null,
      results,
    });
  }

  private handleResourceDetail(
    res: ServerResponse,
    values: Array<Record<string, unknown>>,
    resourceId: string,
  ): void {
    const value = values.find((candidate) => String(candidate.id) === resourceId);
    if (!value) {
      sendJson(res, 404, { error: "unknown_posthog_resource" });
      return;
    }
    sendJson(res, 200, value);
  }

  private handleSurveyResponses(
    res: ServerResponse,
    project: FakePosthogProjectState,
    surveyId: string,
    url: URL,
  ): void {
    const limit = numberOption(url.searchParams.get("limit"), 100, 500);
    const offset = numberOption(
      url.searchParams.get("offset"),
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const values = (project.surveyResponses[surveyId] ?? []).filter((response) => {
      const submittedAt = typeof response.submitted_at === "string"
        ? response.submitted_at
        : "";
      return (!since || submittedAt >= since) && (!until || submittedAt <= until);
    });
    const results = values.slice(offset, offset + limit);
    sendJson(res, 200, {
      results,
      has_more: offset + results.length < values.length,
      limit,
      offset,
    });
  }

  private rejectUnsupported(res: ServerResponse, method: string, path: string): void {
    this.unexpectedRequests.push({ method, path });
    sendJson(res, 405, {
      error: "fake_posthog_route_not_allowed",
      detail: "The read-only PostHog fake does not implement this provider surface.",
      method,
      path,
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    try {
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method)
        ? await readJson(req)
        : {};
      this.recordRequest(method, url, body);

      if (method === "POST" && url.pathname === "/oauth/token/") {
        this.handleToken(res, body);
        return;
      }
      if (method === "POST" && url.pathname === "/oauth/revoke/") {
        this.handleRevocation(res, body);
        return;
      }

      const path = url.pathname.split("/").filter(Boolean);
      const family = path[1];
      const posthogProjectId = Number(path[2]);
      if (
        path[0] !== "api" ||
        !["environments", "projects"].includes(family ?? "") ||
        !Number.isInteger(posthogProjectId) ||
        posthogProjectId <= 0
      ) {
        this.rejectUnsupported(res, method, url.pathname);
        return;
      }
      const isHogQlRead = family === "environments" && method === "POST" &&
        path[3] === "query" && path.length === 4;
      const isDefinitionRead = family === "projects" && method === "GET" &&
        path.length === 4 &&
        (path[3] === "event_definitions" || path[3] === "property_definitions");
      const isErrorCapabilityRead = family === "environments" && method === "GET" &&
        path[3] === "error_tracking" && path[4] === "issues" && path.length === 5;
      const isErrorQueryRead = family === "environments" && method === "POST" &&
        path[3] === "error_tracking" && path[4] === "query" &&
        ["issues", "issue", "issue_events"].includes(path[5] ?? "") &&
        path.length === 6;
      const isSessionRecordingRead = family === "projects" && method === "GET" &&
        path[3] === "session_recordings" && [4, 5].includes(path.length);
      const isFeatureFlagRead = family === "projects" && method === "GET" &&
        path[3] === "feature_flags" && [4, 5].includes(path.length);
      const isSurveyRead = family === "projects" && method === "GET" &&
        path[3] === "surveys" && (
          [4, 5].includes(path.length) ||
          (path.length === 6 && ["responses", "stats"].includes(path[5] ?? ""))
        );
      const isExperimentRead = family === "projects" && method === "GET" &&
        path[3] === "experiments" && [4, 5].includes(path.length);
      if (
        !isHogQlRead && !isDefinitionRead &&
        !isErrorCapabilityRead && !isErrorQueryRead &&
        !isSessionRecordingRead && !isFeatureFlagRead &&
        !isSurveyRead && !isExperimentRead
      ) {
        this.rejectUnsupported(res, method, url.pathname);
        return;
      }
      const project = this.authorizedProject(req, res, posthogProjectId);
      if (!project) return;

      if (isHogQlRead) {
        const query = String(
          (body.query as { query?: unknown } | undefined)?.query ?? "",
        );
        this.queryRequests.push({ project_id: posthogProjectId, query });
        sendJson(res, 200, this.handleHogQl(project, query));
        return;
      }

      if (isDefinitionRead) {
        const results = path[3] === "event_definitions"
          ? project.eventDefinitions
          : project.propertyDefinitions;
        const limit = numberOption(url.searchParams.get("limit"), 100, 100);
        sendJson(res, 200, { count: results.length, results: results.slice(0, limit) });
        return;
      }

      if (isErrorCapabilityRead) {
        const limit = numberOption(url.searchParams.get("limit"), 50, 100);
        sendJson(res, 200, {
          count: project.errorIssues.length,
          results: project.errorIssues.slice(0, limit).map(publicIssue),
        });
        return;
      }

      if (isErrorQueryRead) {
        this.handleErrorTrackingRead(res, project, path[5]!, body);
        return;
      }

      if (isSessionRecordingRead) {
        if (!this.requireScope(res, project, "session_recording:read")) return;
        if (path.length === 4) {
          this.handleResourceList(res, url, project.sessionRecordings);
        } else {
          this.handleResourceDetail(res, project.sessionRecordings, path[4]!);
        }
        return;
      }

      if (isFeatureFlagRead) {
        if (!this.requireScope(res, project, "feature_flag:read")) return;
        if (path.length === 4) {
          this.handleResourceList(res, url, project.featureFlags);
        } else {
          this.handleResourceDetail(res, project.featureFlags, path[4]!);
        }
        return;
      }

      if (isSurveyRead) {
        if (!this.requireScope(res, project, "survey:read")) return;
        if (path.length === 4) {
          this.handleResourceList(res, url, project.surveys);
        } else if (path.length === 5) {
          this.handleResourceDetail(res, project.surveys, path[4]!);
        } else if (path[5] === "responses") {
          if (!this.requireScope(res, project, "query:read")) return;
          this.handleSurveyResponses(res, project, path[4]!, url);
        } else {
          const stats = project.surveyStats[path[4]!];
          if (!stats) {
            sendJson(res, 404, { error: "unknown_survey_stats" });
          } else {
            sendJson(res, 200, stats);
          }
        }
        return;
      }

      if (isExperimentRead) {
        if (!this.requireScope(res, project, "experiment:read")) return;
        if (path.length === 4) {
          this.handleResourceList(res, url, project.experiments);
        } else {
          this.handleResourceDetail(res, project.experiments, path[4]!);
        }
        return;
      }

      this.rejectUnsupported(res, method, url.pathname);
    } catch (error) {
      sendJson(res, 400, {
        error: "invalid_fake_posthog_request",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
