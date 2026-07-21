// Shared executor for operational (agentry_db-backed) query blueprints.
// Used by the blueprint run route and by alert evaluation so both surfaces
// run the exact same deterministic SQL per blueprint id.

import { and, eq, gte, isNotNull, notLike, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { errors } from "@agentrysh/shared";
import { automationRuns, cases, deploys, posthogConnections, projectCredentials } from "@agentry/db/schema";
import type { getDb } from "./db.js";
import type { Env } from "./env.js";
import { runHogQl } from "./posthog.js";
import {
  getPosthogIssueEvents,
  listPosthogIssues,
  type PosthogIssueEvent,
} from "./posthog-error-tracking.js";
import {
  prepareQueryBlueprintExecution,
  type QueryBlueprint,
} from "./query-blueprints.js";
import {
  CUSTOMER_CASE_SQL,
  TRUSTED_CUSTOMER_DEPLOY_SQL,
  customerCaseFilter,
  customerDeployFilter,
} from "./customer-data.js";

type Db = ReturnType<typeof getDb>;
const trustedDeployCredential = alias(projectCredentials, "trusted_deploy_credential");

export async function runOperationalBlueprintRows(
  env: Env,
  db: Db,
  projectId: string,
  blueprint: QueryBlueprint,
  params: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  if (blueprint.strict_params) {
    try {
      params = prepareQueryBlueprintExecution(blueprint, params).params;
    } catch (error) {
      throw errors.invalidPayload({
        reason: "params don't satisfy blueprint.params",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(500, Math.floor(params.limit)))
      : Number(blueprint.params.find((p) => p.name === "limit")?.default ?? 50);

  switch (blueprint.id) {
    case "automation_case_recurrence_after_deploy": {
      const runId = requiredString(params.run_id, "run_id");
      const caseId = requiredString(params.case_id, "case_id");
      const caseRevision = requiredInt(params.case_revision, "case_revision");
      const deploySha = requiredString(params.deploy_sha, "deploy_sha");
      const deployedAt = exactTimestampSeconds(params.deployed_at, "deployed_at");
      const checkedAt = exactTimestampSeconds(params.checked_at, "checked_at");

      const bindings = await db
        .select({
          runId: automationRuns.id,
          fingerprint: cases.fingerprint,
          deployId: deploys.id,
        })
        .from(automationRuns)
        .innerJoin(
          cases,
          and(
            eq(cases.id, automationRuns.caseId),
            eq(cases.projectId, automationRuns.projectId),
          ),
        )
        .innerJoin(
          posthogConnections,
          and(
            eq(posthogConnections.projectId, cases.projectId),
            eq(posthogConnections.status, "active"),
          ),
        )
        .innerJoin(
          deploys,
          and(
            eq(deploys.automationRunId, automationRuns.id),
            eq(deploys.projectId, automationRuns.projectId),
          ),
        )
        .innerJoin(
          trustedDeployCredential,
          and(
            eq(trustedDeployCredential.id, deploys.credentialId),
            eq(trustedDeployCredential.projectId, deploys.projectId),
            eq(trustedDeployCredential.kind, "ci_deploy"),
            notLike(trustedDeployCredential.tokenHash, "legacy-disabled:%"),
          ),
        )
        .where(and(
          eq(automationRuns.id, runId),
          eq(automationRuns.projectId, projectId),
          eq(automationRuns.caseId, caseId),
          eq(automationRuns.caseRevision, caseRevision),
          eq(automationRuns.deploySha, deploySha),
          isNotNull(automationRuns.commitSha),
          eq(cases.id, caseId),
          eq(cases.projectId, projectId),
          gte(cases.revision, caseRevision),
          eq(cases.lastTrustLevel, "customer_posthog"),
          eq(cases.lastCredentialKind, "posthog_oauth"),
          customerCaseFilter,
          eq(deploys.projectId, projectId),
          eq(deploys.automationRunId, runId),
          eq(deploys.sha, deploySha),
          eq(deploys.receivedAt, deployedAt),
          eq(deploys.sourceCommitSha, automationRuns.commitSha),
          eq(deploys.trustLevel, "trusted_ci"),
          eq(deploys.credentialKind, "ci_deploy"),
          isNotNull(deploys.credentialId),
          customerDeployFilter,
        ))
        .limit(2);
      if (bindings.length !== 1) {
        throw errors.conflict(
          "verification_binding_mismatch",
          bindings.length === 0
            ? "The run, claimed case revision, and exact trusted CI deploy do not form one valid verification binding."
            : "More than one trusted deploy matches the exact verification binding.",
          "Stop verification and reconcile the durable run, case claim, and CI deploy record. Never substitute another run, case revision, deploy SHA, source commit, or deploy timestamp.",
          {
            run_id: runId,
            case_id: caseId,
            case_revision: caseRevision,
            deploy_sha: deploySha,
            deployed_at: deployedAt,
            matches: bindings.length,
          },
        );
      }
      const recurrenceCount = await providerOccurrenceCountForReleaseWindow(
        env,
        projectId,
        caseId,
        deploySha,
        deployedAt,
        checkedAt,
      );
      return [{ recurrence_count: recurrenceCount }];
    }
    case "active_cases_top": {
      return db.all<Record<string, unknown>>(sql`
        SELECT id, error_type, message, event_count, last_seen_at, last_deploy_sha
        FROM cases
        WHERE project_id = ${projectId}
          AND ${sql.raw(CUSTOMER_CASE_SQL)}
          AND status = 'active'
        ORDER BY event_count DESC
        LIMIT ${limit}
      `);
    }
    case "top_users_by_errors": {
      const days = clampInt(params.days, 1, 90, 7);
      return hogQlRows(await runHogQl(env, projectId, `
SELECT distinct_id AS user_id,
       count() AS error_count,
       max(timestamp) AS last_seen_at
FROM events
WHERE event = '$exception'
  AND timestamp > now() - INTERVAL ${days} DAY
  AND distinct_id NOT LIKE 'anonymous_%'
GROUP BY distinct_id
ORDER BY error_count DESC
LIMIT ${limit}`));
    }
    case "unique_users_24h": {
      return hogQlRows(await runHogQl(env, projectId, `
SELECT count(DISTINCT distinct_id) AS unique_users, count() AS total_events
FROM events
WHERE event = '$exception'
  AND timestamp > now() - INTERVAL 24 HOUR
  AND distinct_id NOT LIKE 'anonymous_%'`));
    }
    case "users_affected_by_case": {
      const issueId = typeof params.fingerprint === "string" ? params.fingerprint : "";
      if (!issueId) {
        throw errors.invalidPayload({ reason: "param 'fingerprint' must be the PostHog issue id returned as the case fingerprint" });
      }
      const page = await getPosthogIssueEvents(env, projectId, issueId, {
        limit: Math.min(20, limit),
        verbosity: "raw",
      });
      return sampledIssueUsers(page.results).slice(0, limit);
    }
    case "errors_by_hour_24h": {
      return hogQlRows(await runHogQl(env, projectId, `
SELECT toStartOfHour(timestamp) AS hour, count() AS errors
FROM events
WHERE event = '$exception' AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour`));
    }
    case "errors_after_last_deploy": {
      return db.all<Record<string, unknown>>(sql`
        WITH latest_deploy AS (
          SELECT received_at AS deploy_ts, sha AS deploy_sha
          FROM deploys
          WHERE project_id = ${projectId}
            AND ${sql.raw(TRUSTED_CUSTOMER_DEPLOY_SQL)}
          ORDER BY received_at DESC
          LIMIT 1
        )
        SELECT
          id,
          error_type,
          message,
          event_count,
          first_seen_at,
          last_deploy_sha,
          (SELECT deploy_sha FROM latest_deploy) AS latest_deploy_sha,
          CASE
            WHEN last_deploy_sha = (SELECT deploy_sha FROM latest_deploy) THEN 'sha_match'
            WHEN last_deploy_sha IS NULL OR last_deploy_sha = '' THEN 'time_after_latest_no_sha'
            ELSE 'time_after_latest_different_sha'
          END AS attribution
        FROM cases
        WHERE project_id = ${projectId}
          AND ${sql.raw(CUSTOMER_CASE_SQL)}
          AND (SELECT deploy_ts FROM latest_deploy) IS NOT NULL
          AND first_seen_at >= (SELECT deploy_ts FROM latest_deploy)
        ORDER BY first_seen_at DESC
      `);
    }
    case "errors_by_deploy": {
      const days = clampInt(params.days, 1, 90, 14);
      return hogQlRows(await runHogQl(env, projectId, `
SELECT coalesce(
         nullIf(toString(properties.deploy_sha), ''),
         nullIf(toString(properties.$exception_release), ''),
         '(release property missing)'
       ) AS deploy_sha,
       count() AS error_events,
       min(timestamp) AS first_error_at,
       max(timestamp) AS last_error_at
FROM events
WHERE event = '$exception' AND timestamp > now() - INTERVAL ${days} DAY
GROUP BY deploy_sha
ORDER BY last_error_at DESC`));
    }
    case "deploy_frequency_30d": {
      return db.all<Record<string, unknown>>(sql`
        SELECT date(received_at, 'unixepoch') AS day, count(*) AS deploys
        FROM deploys
        WHERE project_id = ${projectId}
          AND ${sql.raw(TRUSTED_CUSTOMER_DEPLOY_SQL)}
          AND received_at > unixepoch() - 30 * 86400
        GROUP BY day
        ORDER BY day
      `);
    }
    default:
      throw errors.catalogInconsistent(
        `Query blueprint ${blueprint.id} has no handler.`,
        { blueprint_id: blueprint.id, backend: blueprint.backend },
      );
  }
}

async function providerOccurrenceCountForReleaseWindow(
  env: Env,
  projectId: string,
  issueId: string,
  release: string,
  fromSeconds: number,
  toSeconds: number,
): Promise<number> {
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await listPosthogIssues(env, projectId, {
      status: "all",
      release,
      dateFrom: new Date(fromSeconds * 1_000).toISOString(),
      dateTo: new Date(toSeconds * 1_000).toISOString(),
      limit: 100,
      offset,
    });
    const issue = page.results.find((row) => row.id === issueId);
    if (issue) {
      const count = issue.aggregations?.occurrences ?? issue.impact?.occurrences ?? 0;
      return Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
    }
    if (!page.hasMore || page.nextOffset === null || page.nextOffset === undefined) return 0;
    offset = page.nextOffset;
  }
  throw errors.posthogUpstreamFailed({
    operation: "bounded issue recurrence lookup",
    status: 502,
    body: "PostHog returned more than 1,000 issues for the exact release/window without locating the claimed issue.",
  });
}

function hogQlRows(output: {
  results: unknown[];
  columns: string[] | null;
}): Array<Record<string, unknown>> {
  if (!output.columns) {
    throw errors.posthogUpstreamFailed({
      operation: "operational error blueprint",
      status: 502,
      body: "PostHog returned rows without a column contract.",
    });
  }
  return output.results.flatMap((raw) => {
    if (!Array.isArray(raw) || raw.length !== output.columns!.length) return [];
    return [Object.fromEntries(output.columns!.map((column, index) => [column, raw[index]]))];
  });
}

function sampledIssueUsers(events: PosthogIssueEvent[]): Array<Record<string, unknown>> {
  const users = new Map<string, {
    user_id: string;
    error_count: number;
    last_seen_at: string | null;
  }>();
  for (const event of events) {
    const id = event.distinct_id;
    if (!id || id.startsWith("anonymous_")) continue;
    const current = users.get(id);
    users.set(id, {
      user_id: id,
      error_count: (current?.error_count ?? 0) + 1,
      last_seen_at: !current?.last_seen_at || (event.timestamp ?? "") > current.last_seen_at
        ? event.timestamp ?? null
        : current.last_seen_at,
    });
  }
  return [...users.values()].sort((left, right) =>
    (right.last_seen_at ?? "").localeCompare(left.last_seen_at ?? "")
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw errors.invalidPayload({ reason: `param '${name}' must be a non-empty string` });
  }
  return value;
}

function requiredInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw errors.invalidPayload({ reason: `param '${name}' must be an integer` });
  }
  return value;
}

function exactTimestampSeconds(value: unknown, name: string): number {
  const input = requiredString(value, name);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) {
    throw errors.invalidPayload({
      reason: `param '${name}' must be an exact whole-second RFC3339 timestamp`,
    });
  }
  return milliseconds / 1_000;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
