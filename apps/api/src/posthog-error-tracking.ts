import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  TELEMETRY_DATA_BOUNDARY,
  canonicalJsonStringify,
  errors,
  prepareTelemetryObservation,
  sha256Hex,
} from "@agentrysh/shared";
import type { CaseStatus, StackFrame, TelemetryInspection } from "@agentrysh/shared";
import {
  automationRuns,
  automationTriggerReceipts,
  caseClaims,
  caseMutationCommands,
  cases,
  posthogConnections,
  projectDeletionFences,
  webhookDeliveries,
} from "@agentry/db/schema";
import type { Env } from "./env.js";
import { getDb } from "./db.js";
import {
  ONBOARDING_PROOF_ANALYTICS_PROPERTY,
  ONBOARDING_PROOF_ERROR_MARKER_PROPERTY,
} from "./customer-data.js";
import { posthogTeamApi } from "./posthog.js";
import {
  assertWebhookOutboxPersisted,
  dispatchPersistedWebhookDeliveries,
  prepareWebhookOutbox,
} from "./webhooks.js";

const MAX_PROVIDER_ERROR_CHARS = 2_000;
const MAX_CASE_PROJECTION_PAGES = 5;
const MAX_CASE_CLASSIFICATION_EVENTS = 20;

export type PosthogCaseEventClassification =
  | "unclassified"
  | "customer_exception"
  | "onboarding_proof_exception";

export const POSTHOG_EXCEPTION_EVENT = "$exception";

export interface PosthogIssueAggregations {
  occurrences?: number;
  users?: number;
  sessions?: number;
}

export interface PosthogIssueSummary {
  id: string;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
  library?: string | null;
  source?: string | null;
  function?: string | null;
  aggregations?: PosthogIssueAggregations | null;
  impact?: PosthogIssueAggregations | null;
  latest_release?: {
    version?: string;
    commit_id?: string;
  } | null;
}

export interface PosthogIssueEvent {
  uuid?: string;
  distinct_id?: string;
  timestamp?: string;
  properties?: Record<string, unknown>;
}

export interface PosthogIssueListResponse {
  results: PosthogIssueSummary[];
  hasMore: boolean;
  limit: number;
  offset: number;
  nextOffset?: number | null;
}

export interface PosthogIssueEventsResponse {
  results: PosthogIssueEvent[];
  hasMore: boolean;
  limit: number;
  offset: number;
  nextOffset?: number | null;
}

export interface ProjectedPosthogCase {
  row: typeof cases.$inferSelect;
  issue: PosthogIssueSummary;
  latestEvent: PosthogIssueEvent | null;
  changed: boolean;
  created: boolean;
}

function boundedProviderError(value: unknown): string {
  const observation = prepareTelemetryObservation(
    value instanceof Error ? value.message : String(value),
    { max_string_chars: MAX_PROVIDER_ERROR_CHARS },
  );
  return String(observation.content);
}

export async function listPosthogIssues(
  env: Env,
  projectId: string,
  input: {
    status?: "active" | "resolved" | "suppressed" | "all";
    searchQuery?: string;
    release?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<PosthogIssueListResponse> {
  const limit = Math.max(1, Math.min(100, input.limit ?? 50));
  const offset = Math.max(0, input.offset ?? 0);
  const response = await posthogTeamApi<PosthogIssueListResponse>(
    env,
    projectId,
    "error_tracking/query/issues/",
    {
      method: "POST",
      body: {
        status: input.status ?? "active",
        filterTestAccounts: false,
        orderBy: "last_seen",
        orderDirection: "DESC",
        limit,
        offset,
        volumeResolution: 0,
        ...(input.searchQuery ? { searchQuery: input.searchQuery } : {}),
        ...(input.release ? { release: input.release } : {}),
        ...(input.dateFrom || input.dateTo
          ? { dateRange: { date_from: input.dateFrom ?? "-3650d", date_to: input.dateTo ?? null } }
          : {}),
      },
    },
  );
  return normalizeIssueList(response.data, limit, offset);
}

export async function getPosthogIssue(
  env: Env,
  projectId: string,
  issueId: string,
): Promise<PosthogIssueSummary> {
  const response = await posthogTeamApi<PosthogIssueSummary>(
    env,
    projectId,
    "error_tracking/query/issue/",
    {
      method: "POST",
      body: {
        issueId,
        filterTestAccounts: false,
        includeSparkline: false,
        volumeResolution: 0,
        dateRange: { date_from: "-3650d", date_to: null },
      },
    },
  );
  assertIssue(response.data);
  return response.data;
}

export async function getPosthogIssueEvents(
  env: Env,
  projectId: string,
  issueId: string,
  input: { limit?: number; offset?: number; verbosity?: "summary" | "stack" | "raw" } = {},
): Promise<PosthogIssueEventsResponse> {
  const limit = Math.max(1, Math.min(20, input.limit ?? 5));
  const offset = Math.max(0, input.offset ?? 0);
  const response = await posthogTeamApi<PosthogIssueEventsResponse>(
    env,
    projectId,
    "error_tracking/query/issue_events/",
    {
      method: "POST",
      body: {
        issueId,
        filterTestAccounts: false,
        dateRange: { date_from: "-3650d", date_to: null },
        orderDirection: "DESC",
        limit,
        offset,
        verbosity: input.verbosity ?? "raw",
        onlyAppFrames: false,
      },
    },
  );
  return normalizeIssueEvents(response.data, limit, offset);
}

function normalizeIssueList(
  value: unknown,
  limit: number,
  offset: number,
): PosthogIssueListResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedProvider("issue list");
  }
  const row = value as Partial<PosthogIssueListResponse>;
  if (!Array.isArray(row.results)) throw malformedProvider("issue list results");
  const results = row.results.slice(0, limit);
  for (const issue of results) assertIssue(issue);
  return {
    results,
    hasMore: row.hasMore === true,
    limit: Number.isSafeInteger(row.limit) ? Number(row.limit) : limit,
    offset: Number.isSafeInteger(row.offset) ? Number(row.offset) : offset,
    nextOffset: Number.isSafeInteger(row.nextOffset) ? Number(row.nextOffset) : null,
  };
}

function normalizeIssueEvents(
  value: unknown,
  limit: number,
  offset: number,
): PosthogIssueEventsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedProvider("issue events");
  }
  const row = value as Partial<PosthogIssueEventsResponse>;
  if (!Array.isArray(row.results)) throw malformedProvider("issue event results");
  return {
    results: row.results.filter((event): event is PosthogIssueEvent =>
      Boolean(event && typeof event === "object" && !Array.isArray(event))).slice(0, limit),
    hasMore: row.hasMore === true,
    limit: Number.isSafeInteger(row.limit) ? Number(row.limit) : limit,
    offset: Number.isSafeInteger(row.offset) ? Number(row.offset) : offset,
    nextOffset: Number.isSafeInteger(row.nextOffset) ? Number(row.nextOffset) : null,
  };
}

function assertIssue(value: unknown): asserts value is PosthogIssueSummary {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !(value as { id: string }).id ||
    (value as { id: string }).id.length > 500
  ) {
    throw malformedProvider("issue");
  }
  // Do not silently turn a new or malformed provider lifecycle value into an
  // active customer case. PostHog remains authoritative, so an unknown value
  // stops projection until the adapter is deliberately updated.
  providerStatus((value as PosthogIssueSummary).status);
}

function malformedProvider(resource: string) {
  return errors.posthogUpstreamFailed({
    operation: `read PostHog ${resource}`,
    status: 502,
    body: `PostHog returned a malformed ${resource} response`,
    nextAction:
      "Stop interpreting case data and run the pinned PostHog provider conformance suite before retrying.",
  });
}

function providerStatus(status: string | null | undefined): CaseStatus {
  switch (status) {
    case "active":
      return "active";
    case "resolved":
    case "pending_release":
      return "resolved";
    case "suppressed":
    case "archived":
      return "suppressed";
    default:
      throw malformedProvider("issue status");
  }
}

function isoSeconds(value: string | null | undefined, fallback: number): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : fallback;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasOwnProperty(value: Record<string, unknown>, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function observedEventClassification(
  events: readonly PosthogIssueEvent[],
): PosthogCaseEventClassification {
  if (events.length === 0) return "unclassified";
  for (const event of events.slice(0, MAX_CASE_CLASSIFICATION_EVENTS)) {
    const properties = recordOf(event.properties);
    // Never persist either marker value. Presence alone is enough to keep the
    // entire PostHog issue out of customer inventory and unattended work.
    if (
      hasOwnProperty(properties, ONBOARDING_PROOF_ANALYTICS_PROPERTY) ||
      hasOwnProperty(properties, ONBOARDING_PROOF_ERROR_MARKER_PROPERTY)
    ) {
      return "onboarding_proof_exception";
    }
  }
  return "customer_exception";
}

function projectionClassification(
  before: typeof cases.$inferSelect | undefined,
  events: readonly PosthogIssueEvent[],
): PosthogCaseEventClassification {
  if (before?.providerEventClassification === "onboarding_proof_exception") {
    return "onboarding_proof_exception";
  }
  const observed = observedEventClassification(events);
  return observed === "unclassified"
    ? before?.providerEventClassification ?? "unclassified"
    : observed;
}

function stringOrNull(value: unknown, max = 8_000): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function urlWithoutQueryOrFragment(value: unknown): string | null {
  const raw = stringOrNull(value, 2_000);
  if (!raw) return null;
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

function stripUrlQueriesAndFragmentsInText(value: string | null): string | null {
  if (!value) return value;
  return value.replace(/https?:\/\/[^\s<>"']+/giu, (url) =>
    urlWithoutQueryOrFragment(url) ?? "[REDACTED_URL]"
  );
}

function boundedStackFrame(value: unknown): StackFrame | null {
  const frame = recordOf(value);
  if (Object.keys(frame).length === 0) return null;
  return {
    filename: urlWithoutQueryOrFragment(frame.filename),
    function: stringOrNull(frame.function, 500),
    lineno: finiteInteger(frame.lineno),
    colno: finiteInteger(frame.colno),
    in_app: typeof frame.in_app === "boolean" ? frame.in_app : null,
    context_line: stringOrNull(frame.context_line, 2_000),
  };
}

function boundedRequestEvidence(value: unknown): Record<string, unknown> | null {
  const request = recordOf(value);
  if (Object.keys(request).length === 0) return null;
  const method = stringOrNull(request.method, 20);
  const url = urlWithoutQueryOrFragment(request.url ?? request.uri);
  const path = urlWithoutQueryOrFragment(request.path);
  return method || url || path ? { method, url, path } : null;
}

function firstException(properties: Record<string, unknown>): Record<string, unknown> {
  const list = properties.$exception_list;
  return Array.isArray(list) ? recordOf(list[0]) : {};
}

function latestEventProjection(event: PosthogIssueEvent | null) {
  const properties = recordOf(event?.properties);
  const exception = firstException(properties);
  const stacktrace = recordOf(exception.stacktrace);
  const rawFrames = Array.isArray(stacktrace.frames) ? stacktrace.frames : [];
  const frames = rawFrames
    .slice(0, 100)
    .map(boundedStackFrame)
    .filter((frame): frame is StackFrame => frame !== null);
  return {
    eventId: stringOrNull(event?.uuid, 200),
    errorType: stringOrNull(exception.type, 200),
    message: stringOrNull(exception.value, 8_000),
    deploySha: stringOrNull(
      properties.deploy_sha ?? properties.$exception_release,
      500,
    ),
    environment: stringOrNull(properties.environment ?? properties.$environment, 200),
    frames,
    properties,
  };
}

function issueCount(issue: PosthogIssueSummary): number {
  const raw = issue.aggregations?.occurrences ?? issue.impact?.occurrences ?? 0;
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
}

function issueSnapshot(
  issue: PosthogIssueSummary,
  latest: ReturnType<typeof latestEventProjection>,
  providerEventClassification: PosthogCaseEventClassification,
) {
  const issueName = stringOrNull(issue.name, 200);
  const issueDescription = stringOrNull(issue.description, 8_000);
  const latestRelease = stringOrNull(
    issue.latest_release?.commit_id ?? issue.latest_release?.version,
    500,
  );
  const evidence = prepareTelemetryObservation({
    error_type: stripUrlQueriesAndFragmentsInText(latest.errorType ?? issueName ?? "Error"),
    message: stripUrlQueriesAndFragmentsInText(
      latest.message ?? issueDescription ?? issueName ?? "",
    ),
    last_deploy_sha: stripUrlQueriesAndFragmentsInText(latest.deploySha ?? latestRelease),
    last_environment: stripUrlQueriesAndFragmentsInText(latest.environment),
    last_provider_event_id: stripUrlQueriesAndFragmentsInText(latest.eventId),
  }, {
    max_depth: 2,
    max_nodes: 16,
    max_object_keys: 8,
    max_array_items: 1,
    max_string_chars: 8_000,
  }).content;
  return {
    provider_issue_id: issue.id,
    provider_event_classification: providerEventClassification,
    status: providerStatus(issue.status),
    event_count: issueCount(issue),
    first_seen_at: isoSeconds(issue.first_seen, 0),
    last_seen_at: isoSeconds(issue.last_seen, 0),
    // PostHog may merge several fingerprints into one issue. Its issue id is
    // therefore the only stable one-to-one grouping key for this projection.
    fingerprint: issue.id,
    error_type: evidence.error_type ?? "Error",
    message: evidence.message ?? "",
    last_deploy_sha: evidence.last_deploy_sha,
    last_environment: evidence.last_environment,
    last_provider_event_id: evidence.last_provider_event_id,
    last_trust_level: "customer_posthog" as const,
    last_credential_kind: "posthog_oauth" as const,
  };
}

export async function projectPosthogIssue(
  env: Env,
  projectId: string,
  issue: PosthogIssueSummary,
  latestEvent: PosthogIssueEvent | null,
  options: {
    waitUntil?: (promise: Promise<unknown>) => void;
    classificationEvents?: readonly PosthogIssueEvent[];
  } = {},
): Promise<ProjectedPosthogCase> {
  assertIssue(issue);
  const db = getDb(env);
  const latest = latestEventProjection(latestEvent);
  const before = (
    await db.select().from(cases).where(and(
      eq(cases.projectId, projectId),
      eq(cases.providerIssueId, issue.id),
    )).limit(1)
  )[0];
  const classificationEvents = options.classificationEvents
    ?? (latestEvent ? [latestEvent] : []);
  const classification = projectionClassification(before, classificationEvents);
  const snapshot = issueSnapshot(issue, latest, classification);
  const snapshotHash = await sha256Hex(canonicalJsonStringify(snapshot));
  if (before?.providerSnapshotHash === snapshotHash) {
    return { row: before, issue, latestEvent, changed: false, created: false };
  }

  const created = !before;
  const nextRevision = before ? before.revision + 1 : 1;
  const eventName = created
    ? "case.created"
    : before.status !== snapshot.status
      ? before.status !== "active" && snapshot.status === "active"
        ? "case.reopened"
        : `case.${snapshot.status}`
      : null;
  const sourceEventId = `posthog-issue:${issue.id}:${snapshotHash}`;
  const outbox = eventName && classification === "customer_exception"
    ? await prepareWebhookOutbox(
        env,
        projectId,
        eventName,
        {
          case_id: issue.id,
          provider_issue_id: issue.id,
          fingerprint: snapshot.fingerprint,
          error_type: snapshot.error_type,
          message: snapshot.message,
          status: snapshot.status,
          previous_status: before?.status ?? null,
          event_count: snapshot.event_count,
          last_deploy_sha: snapshot.last_deploy_sha,
          trust_level: snapshot.last_trust_level,
          credential_kind: snapshot.last_credential_kind,
        },
        { sourceEventId },
      )
    : null;
  const projectedAt = Math.floor(Date.now() / 1_000);

  const committed = await db.transaction(async (tx) => {
    const fence = (
      await tx.select({ projectId: projectDeletionFences.projectId })
        .from(projectDeletionFences)
        .where(eq(projectDeletionFences.projectId, projectId)).limit(1)
    )[0];
    if (fence) throw errors.conflict(
      "project_deletion_in_progress",
      "The project was fenced while its PostHog issue projection was committing.",
      "Stop projection and resume the exact deletion command.",
      { project_id: projectId },
    );

    if (before) {
      const updated = await tx.update(cases).set({
        providerSnapshotHash: snapshotHash,
        providerProjectedAt: projectedAt,
        lastProviderEventId: snapshot.last_provider_event_id,
        providerEventClassification: snapshot.provider_event_classification,
        fingerprint: snapshot.fingerprint,
        errorType: snapshot.error_type,
        message: snapshot.message,
        status: snapshot.status,
        eventCount: snapshot.event_count,
        firstSeenAt: snapshot.first_seen_at,
        lastSeenAt: snapshot.last_seen_at,
        lastDeploySha: snapshot.last_deploy_sha,
        lastEnvironment: snapshot.last_environment,
        lastTrustLevel: snapshot.last_trust_level,
        lastCredentialKind: snapshot.last_credential_kind,
        revision: nextRevision,
      }).where(and(
        eq(cases.id, before.id),
        eq(cases.revision, before.revision),
      )).returning({ id: cases.id });
      if (updated.length !== 1) {
        throw errors.conflict(
          "case_projection_contention",
          "The local case control projection changed concurrently.",
          "Re-read the PostHog issue and retry its projection; never overwrite the newer revision.",
          { case_id: before.id, expected_revision: before.revision },
        );
      }
    } else {
      const inserted = await tx.insert(cases).values({
        id: issue.id,
        projectId,
        providerIssueId: issue.id,
        providerSnapshotHash: snapshotHash,
        providerProjectedAt: projectedAt,
        lastProviderEventId: snapshot.last_provider_event_id,
        providerEventClassification: snapshot.provider_event_classification,
        fingerprint: snapshot.fingerprint,
        errorType: snapshot.error_type,
        message: snapshot.message,
        status: snapshot.status,
        eventCount: snapshot.event_count,
        firstSeenAt: snapshot.first_seen_at,
        lastSeenAt: snapshot.last_seen_at,
        lastDeploySha: snapshot.last_deploy_sha,
        lastEnvironment: snapshot.last_environment,
        agentSummary: null,
        prUrl: null,
        lastTrustLevel: snapshot.last_trust_level,
        lastCredentialKind: snapshot.last_credential_kind,
        revision: 1,
      }).onConflictDoNothing().returning({ id: cases.id });
      if (inserted.length !== 1) return false;
    }

    for (const delivery of outbox?.deliveries ?? []) {
      await tx.insert(webhookDeliveries).values(delivery).onConflictDoNothing({
        target: [webhookDeliveries.webhookId, webhookDeliveries.sourceEventId],
      });
    }
    return true;
  });

  if (!committed) {
    const winner = (
      await db.select().from(cases).where(and(
        eq(cases.projectId, projectId),
        eq(cases.providerIssueId, issue.id),
      )).limit(1)
    )[0];
    if (!winner) {
      throw errors.internal("Concurrent PostHog issue projection did not return its winning row");
    }
    if (winner.providerSnapshotHash === snapshotHash) {
      return { row: winner, issue, latestEvent, changed: false, created: false };
    }
    // The first insert raced a different provider snapshot. Re-enter once as
    // an ordinary revision-CAS update against the winning row.
    return projectPosthogIssue(env, projectId, issue, latestEvent, options);
  }

  if (outbox) {
    await assertWebhookOutboxPersisted(env, outbox);
    await dispatchPersistedWebhookDeliveries(
      env,
      outbox.deliveryIds,
      options.waitUntil,
    );
  }
  const row = (
    await db.select().from(cases).where(and(
      eq(cases.projectId, projectId),
      eq(cases.providerIssueId, issue.id),
    )).limit(1)
  )[0];
  if (!row) throw errors.internal("PostHog issue projection did not return a case control row");
  return { row, issue, latestEvent, changed: true, created };
}

export async function synchronizePosthogIssue(
  env: Env,
  projectId: string,
  issueId: string,
  options: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<ProjectedPosthogCase> {
  const [issue, events] = await Promise.all([
    getPosthogIssue(env, projectId, issueId),
    getPosthogIssueEvents(env, projectId, issueId, {
      limit: MAX_CASE_CLASSIFICATION_EVENTS,
      verbosity: "raw",
    }),
  ]);
  return projectPosthogIssue(env, projectId, issue, events.results[0] ?? null, {
    ...options,
    classificationEvents: events.results,
  });
}

export async function synchronizePosthogCasesForProject(
  env: Env,
  projectId: string,
  options: {
    status?: "active" | "resolved" | "suppressed" | "all";
    limit?: number;
    offset?: number;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<{ page: PosthogIssueListResponse; projected: number; changed: number }> {
  const page = await listPosthogIssues(env, projectId, options);
  let changed = 0;
  for (const issue of page.results) {
    const existing = (
      await getDb(env).select().from(cases).where(and(
        eq(cases.projectId, projectId),
        eq(cases.providerIssueId, issue.id),
      )).limit(1)
    )[0];
    const issueLastSeen = isoSeconds(issue.last_seen, 0);
    const issueStatus = providerStatus(issue.status);
    const needsEvent = !existing ||
      existing.lastSeenAt !== issueLastSeen ||
      existing.status !== issueStatus ||
      existing.eventCount !== issueCount(issue);
    if (!needsEvent) continue;
    const eventPage = needsEvent
      ? await getPosthogIssueEvents(env, projectId, issue.id, {
          limit: MAX_CASE_CLASSIFICATION_EVENTS,
          verbosity: "raw",
        })
      : null;
    const projected = await projectPosthogIssue(
      env,
      projectId,
      issue,
      eventPage?.results[0] ?? null,
      {
        waitUntil: options.waitUntil,
        classificationEvents: eventPage?.results ?? [],
      },
    );
    if (projected.changed) changed += 1;
  }
  return { page, projected: page.results.length, changed };
}

export async function synchronizeAllPosthogCasesForProject(
  env: Env,
  projectId: string,
  options: {
    status?: "active" | "resolved" | "suppressed" | "all";
    pageSize?: number;
    cursor?: number;
    waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
): Promise<{
  pages: number;
  projected: number;
  changed: number;
  truncated: boolean;
  has_more: boolean;
  cursor: number | null;
}> {
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 100));
  let offset = Math.max(0, options.cursor ?? 0);
  let pages = 0;
  let projected = 0;
  let changed = 0;
  for (;;) {
    const result = await synchronizePosthogCasesForProject(env, projectId, {
      status: options.status,
      limit: pageSize,
      offset,
      waitUntil: options.waitUntil,
    });
    pages += 1;
    projected += result.projected;
    changed += result.changed;
    if (!result.page.hasMore) {
      return { pages, projected, changed, truncated: false, has_more: false, cursor: null };
    }
    const nextOffset = result.page.nextOffset ?? offset + result.page.results.length;
    if (nextOffset <= offset || result.page.results.length === 0) {
      throw malformedProvider("issue list pagination");
    }
    if (pages >= MAX_CASE_PROJECTION_PAGES) {
      return {
        pages,
        projected,
        changed,
        truncated: true,
        has_more: true,
        cursor: nextOffset,
      };
    }
    offset = nextOffset;
  }
}

type CaseProjectionSweepConnection = {
  id: string;
  projectId: string;
  posthogHost: string;
  posthogEnvironmentId: number | null;
  version: number;
  offset: number;
  lastAttemptAt: number | null;
  lastCompletedAt: number | null;
};

function sweepConnectionCas(connection: CaseProjectionSweepConnection) {
  return and(
    eq(posthogConnections.id, connection.id),
    eq(posthogConnections.projectId, connection.projectId),
    eq(posthogConnections.status, "active"),
    eq(posthogConnections.version, connection.version),
    eq(posthogConnections.posthogHost, connection.posthogHost),
    connection.posthogEnvironmentId === null
      ? isNull(posthogConnections.posthogEnvironmentId)
      : eq(posthogConnections.posthogEnvironmentId, connection.posthogEnvironmentId),
    eq(posthogConnections.caseProjectionOffset, connection.offset),
  );
}

async function reconcileStaleSweepProviderIdentity(
  env: Env,
  swept: CaseProjectionSweepConnection,
): Promise<boolean> {
  const db = getDb(env);
  return await db.transaction(async (tx) => {
    const current = (
      await tx.select({
        id: posthogConnections.id,
        status: posthogConnections.status,
        posthogHost: posthogConnections.posthogHost,
        posthogEnvironmentId: posthogConnections.posthogEnvironmentId,
        version: posthogConnections.version,
        updatedAt: posthogConnections.updatedAt,
      }).from(posthogConnections)
        .where(eq(posthogConnections.projectId, swept.projectId))
        .limit(1)
    )[0] ?? null;
    if (!current) return true;
    if (
      current.posthogHost === swept.posthogHost
      && current.posthogEnvironmentId === swept.posthogEnvironmentId
    ) return false;

    // A reconnect may win after this sweep read from the previous provider.
    // Purge any late projection and invalidate the new identity's cursor so
    // its next sweep always rebuilds from page zero.
    await tx.delete(caseMutationCommands)
      .where(eq(caseMutationCommands.projectId, swept.projectId));
    await tx.delete(caseClaims)
      .where(eq(caseClaims.projectId, swept.projectId));
    await tx.delete(automationTriggerReceipts).where(and(
      eq(automationTriggerReceipts.projectId, swept.projectId),
      isNotNull(automationTriggerReceipts.caseId),
    ));
    await tx.update(automationRuns).set({
      caseId: null,
      caseRevision: null,
    }).where(and(
      eq(automationRuns.projectId, swept.projectId),
      isNotNull(automationRuns.caseId),
    ));
    await tx.delete(cases).where(eq(cases.projectId, swept.projectId));
    const remaining = await tx.select({ id: cases.id }).from(cases)
      .where(eq(cases.projectId, swept.projectId)).limit(1);
    if (remaining[0]) throw new Error("PostHog provider identity reconciliation left a case projection behind.");

    const winner = await tx.update(posthogConnections).set({
      caseProjectionOffset: 0,
      caseProjectionLastAttemptAt: null,
      caseProjectionLastCompletedAt: null,
      version: current.version + 1,
      updatedAt: Math.max(Math.floor(Date.now() / 1_000), current.updatedAt),
    }).where(and(
      eq(posthogConnections.id, current.id),
      eq(posthogConnections.status, current.status),
      eq(posthogConnections.version, current.version),
      eq(posthogConnections.posthogHost, current.posthogHost),
      current.posthogEnvironmentId === null
        ? isNull(posthogConnections.posthogEnvironmentId)
        : eq(posthogConnections.posthogEnvironmentId, current.posthogEnvironmentId),
    )).returning({ id: posthogConnections.id });
    if (winner.length !== 1) {
      throw new Error("PostHog provider identity reconciliation lost connection contention.");
    }
    return true;
  });
}

export async function sweepPosthogCaseProjections(
  env: Env,
  options: { projectLimit?: number; issueLimit?: number } = {},
): Promise<{ projects: number; projected: number; changed: number; errors: Array<{ project_id: string; error: string }> }> {
  const projectLimit = Math.max(1, Math.min(100, options.projectLimit ?? 25));
  const issueLimit = Math.max(1, Math.min(100, options.issueLimit ?? 100));
  const db = getDb(env);
  const connections = await db.select({
    id: posthogConnections.id,
    projectId: posthogConnections.projectId,
    posthogHost: posthogConnections.posthogHost,
    posthogEnvironmentId: posthogConnections.posthogEnvironmentId,
    version: posthogConnections.version,
    offset: posthogConnections.caseProjectionOffset,
    lastAttemptAt: posthogConnections.caseProjectionLastAttemptAt,
    lastCompletedAt: posthogConnections.caseProjectionLastCompletedAt,
  })
    .from(posthogConnections)
    .where(eq(posthogConnections.status, "active"))
    // NULL attempts sort first in SQLite. Persisting every attempt makes this a
    // durable round-robin across active connections instead of repeatedly
    // starving every project after the first batch.
    .orderBy(
      asc(posthogConnections.caseProjectionLastAttemptAt),
      asc(posthogConnections.createdAt),
      asc(posthogConnections.id),
    )
    .limit(projectLimit);
  let projected = 0;
  let changed = 0;
  const failures: Array<{ project_id: string; error: string }> = [];
  for (const connection of connections) {
    const attemptedAt = Math.max(
      1,
      Math.floor(Date.now() / 1_000),
      (connection.lastAttemptAt ?? 0) + 1,
      connection.lastCompletedAt ?? 0,
    );
    try {
      const result = await synchronizePosthogCasesForProject(env, connection.projectId, {
        status: "all",
        limit: issueLimit,
        offset: connection.offset,
      });
      if (result.page.offset !== connection.offset) {
        throw malformedProvider("issue list pagination offset");
      }
      let nextOffset = 0;
      if (result.page.hasMore) {
        nextOffset = result.page.nextOffset
          ?? connection.offset + result.page.results.length;
        if (result.page.results.length === 0 || nextOffset <= connection.offset) {
          throw malformedProvider("issue list pagination cursor");
        }
      }
      const winner = await db.update(posthogConnections).set({
        caseProjectionOffset: nextOffset,
        caseProjectionLastAttemptAt: attemptedAt,
        ...(result.page.hasMore
          ? {}
          : { caseProjectionLastCompletedAt: attemptedAt }),
        version: connection.version + 1,
      }).where(sweepConnectionCas(connection))
        .returning({ id: posthogConnections.id });
      if (winner.length !== 1) {
        throw new Error(
          "PostHog connection changed while its case projection cursor was committing.",
        );
      }
      projected += result.projected;
      changed += result.changed;
    } catch (error) {
      // A broken or reauthorization-required project must not monopolize every
      // minute. Preserve its page cursor, record the attempt best-effort, and
      // let the durable least-recently-attempted ordering move on.
      let failure = error;
      try {
        const identityChanged = await reconcileStaleSweepProviderIdentity(env, connection);
        if (identityChanged) {
          failure = new Error(
            "PostHog provider identity changed during the case projection sweep; stale projections were discarded and the cursor was reset.",
          );
        } else {
          const winner = await db.update(posthogConnections).set({
            caseProjectionLastAttemptAt: attemptedAt,
            version: connection.version + 1,
          }).where(sweepConnectionCas(connection))
            .returning({ id: posthogConnections.id });
          if (winner.length !== 1) {
            failure = new Error(
              "PostHog connection changed while its failed case projection attempt was committing; no stale cursor was written.",
            );
          }
        }
      } catch (reconciliationError) {
        failure = new Error(
          `PostHog provider identity reconciliation failed: ${boundedProviderError(reconciliationError)}`,
        );
      }
      failures.push({ project_id: connection.projectId, error: boundedProviderError(failure) });
    }
  }
  return { projects: connections.length, projected, changed, errors: failures.slice(0, 20) };
}

export function posthogEventObservation(event: PosthogIssueEvent): {
  evidence: Record<string, unknown>;
  inspection: TelemetryInspection;
  emitter: {
    trust_level: "customer_posthog";
    credential_kind: "posthog_oauth";
    credential_id: null;
  };
  received_at: number;
  deploy_sha: string | null;
  environment: string | null;
} {
  const projected = latestEventProjection(event);
  const props = projected.properties;
  const exception = firstException(props);
  const observation = prepareTelemetryObservation({
    message: exception.value ?? "",
    stack: projected.frames,
    breadcrumbs: props.$exception_breadcrumbs ?? null,
    request: boundedRequestEvidence(props.$exception_request),
    tags: props.$exception_tags ?? props.tags ?? null,
    extra: props.$exception_extra ?? props.extra ?? null,
    distinct_id: event.distinct_id ?? null,
    session_id: props.$session_id ?? null,
    current_url: urlWithoutQueryOrFragment(props.$current_url),
  }, {
    max_depth: 8,
    max_nodes: 2_000,
    max_object_keys: 50,
    max_array_items: 100,
    max_string_chars: 8_000,
  });
  const metadata = prepareTelemetryObservation({
    deploy_sha: stripUrlQueriesAndFragmentsInText(projected.deploySha),
    environment: stripUrlQueriesAndFragmentsInText(projected.environment),
  }, {
    max_depth: 2,
    max_nodes: 8,
    max_object_keys: 4,
    max_array_items: 1,
    max_string_chars: 500,
  }).content;
  return {
    evidence: observation.content as Record<string, unknown>,
    inspection: observation.inspection,
    emitter: {
      trust_level: "customer_posthog",
      credential_kind: "posthog_oauth",
      credential_id: null,
    },
    received_at: isoSeconds(event.timestamp, 0),
    deploy_sha: metadata.deploy_sha,
    environment: metadata.environment,
  };
}

export function posthogErrorDataBoundary() {
  return {
    ...TELEMETRY_DATA_BOUNDARY,
    provider: "posthog_cloud",
    authority: "provider_issue_and_sampled_exception_evidence",
    persistence: "bounded_control_projection_only",
    raw_event_stream_retained: false,
  };
}
