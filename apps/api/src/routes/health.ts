import { Hono } from "hono";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  cases,
  deploys,
  posthogConnections,
  projectCredentials,
  webhooks,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.get("/v1/projects/:project_id/health", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);
  const now = Math.floor(Date.now() / 1_000);

  const [connectionRows, projectionRows, credentialRows, hookRows] = await Promise.all([
    db.select({
      status: posthogConnections.status,
      posthogHost: posthogConnections.posthogHost,
      posthogProjectId: posthogConnections.posthogEnvironmentId,
      lastVerifiedAt: posthogConnections.lastVerifiedAt,
      lastUsedAt: posthogConnections.lastUsedAt,
      caseProjectionLastAttemptAt: posthogConnections.caseProjectionLastAttemptAt,
      caseProjectionLastCompletedAt: posthogConnections.caseProjectionLastCompletedAt,
    }).from(posthogConnections)
      .where(eq(posthogConnections.projectId, projectId))
      .limit(1),
    db.all<{
      last_projected_at: number | null;
      last_deploy_at: number | null;
      active_cases: number | string | null;
      projected_cases: number | string | null;
    }>(sql`
      SELECT
        (SELECT max(${cases.providerProjectedAt}) FROM ${cases} WHERE ${cases.projectId} = ${projectId}) AS last_projected_at,
        (SELECT max(${deploys.receivedAt}) FROM ${deploys} WHERE ${deploys.projectId} = ${projectId}) AS last_deploy_at,
        (SELECT count(*) FROM ${cases} WHERE ${cases.projectId} = ${projectId} AND ${cases.status} = 'active') AS active_cases,
        (SELECT count(*) FROM ${cases} WHERE ${cases.projectId} = ${projectId} AND ${cases.providerIssueId} IS NOT NULL) AS projected_cases
    `),
    db.select({
      kind: projectCredentials.kind,
      automationId: projectCredentials.automationId,
    }).from(projectCredentials).where(and(
      eq(projectCredentials.projectId, projectId),
      isNull(projectCredentials.revokedAt),
      gt(projectCredentials.expiresAt, now),
    )),
    db.select().from(webhooks).where(eq(webhooks.projectId, projectId)),
  ]);

  const connection = connectionRows[0] ?? null;
  const projection = projectionRows[0] ?? null;
  const lastCaseDataChangeAt = projection?.last_projected_at ?? null;
  const lastCompletedSweepAt = connection?.caseProjectionLastCompletedAt ?? null;
  const completedSweepAge = lastCompletedSweepAt === null
    ? null
    : Math.max(0, now - lastCompletedSweepAt);
  const ciCredentialActive = credentialRows.some((row) => row.kind === "ci_deploy");
  const runnerCredentialCount = credentialRows.filter((row) =>
    row.kind === "automation_runner" && row.automationId !== null
  ).length;

  const status = connection?.status !== "active"
    ? "blocked"
    : lastCompletedSweepAt === null || completedSweepAge !== null && completedSweepAge > 3_600
      ? "degraded"
      : "healthy";
  const nextAction = connection === null || connection.status === "detached"
    ? `Connect PostHog Cloud at POST /v1/projects/${encodeURIComponent(projectId)}/posthog-connection.`
    : connection.status === "reauth_required"
        ? `Reconnect PostHog Cloud at POST /v1/projects/${encodeURIComponent(projectId)}/posthog-connection.`
        : lastCompletedSweepAt === null
          ? "Complete the first bounded Error Tracking sweep. An empty PostHog issue result is healthy evidence and does not require a local case row."
          : completedSweepAge !== null && completedSweepAge > 3_600
            ? "Refresh the bounded Error Tracking projection from PostHog; do not copy or queue the raw event stream."
            : "Control-plane health is current. Continue bounded PostHog reads and trusted deploy attribution.";

  return c.json({
    project_id: projectId,
    status,
    posthog: {
      connection_status: connection?.status ?? "detached",
      host: connection?.posthogHost ?? null,
      posthog_project_id: connection?.posthogProjectId ?? null,
      last_verified_at: connection?.lastVerifiedAt ?? null,
      last_used_at: connection?.lastUsedAt ?? null,
    },
    case_projection: {
      last_attempted_sweep_at: connection?.caseProjectionLastAttemptAt ?? null,
      last_completed_sweep_at: lastCompletedSweepAt,
      seconds_since_completed_sweep: completedSweepAge,
      last_case_data_change_at: lastCaseDataChangeAt,
      active_cases: Number(projection?.active_cases ?? 0),
      projected_cases: Number(projection?.projected_cases ?? 0),
      authoritative_data_plane: "customer_posthog",
    },
    deploy_control: {
      last_deploy_at: projection?.last_deploy_at ?? null,
      ci_credential_active: ciCredentialActive,
      active_runner_credentials: runnerCredentialCount,
    },
    webhooks: hookRows.map((webhook) => ({
      id: webhook.id,
      url: webhook.url,
      active: webhook.active === 1,
      last_status: webhook.lastStatus,
      last_error: webhook.lastError,
      last_fired_at: webhook.lastFiredAt,
    })),
    next_action: nextAction,
  });
});

export default router;
