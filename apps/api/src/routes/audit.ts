// Read-side of the audit log.
//
// GET /v1/audit/recent?hours=24
// Lists the user's audit-log rows in the last N hours (default 24, max 720).
// Filterable by action prefix (e.g. "project.") and resource_type.

import { Hono } from "hono";
import { and, desc, eq, gte, like, sql } from "drizzle-orm";
import { auditLog } from "@agentry/db/schema";
import { errors, TELEMETRY_DATA_BOUNDARY } from "@agentrysh/shared";
import { getDb } from "../db.js";
import { requireApiKey } from "../middleware.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.get("/v1/audit/recent", requireApiKey(), async (c) => {
  const user = c.get("user");
  const hoursRaw = c.req.query("hours");
  const hours = hoursRaw ? Number(hoursRaw) : 24;
  if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
    throw errors.invalidPayload({
      reason: "hours must be 1..720 (max 30 days). default 24.",
    });
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 500);
  const actionPrefix = c.req.query("action_prefix")?.trim();
  const resourceType = c.req.query("resource_type")?.trim();
  const projectId = c.req.query("project_id")?.trim();
  const operationId = c.req.query("operation_id")?.trim();
  const includeAttempts = c.req.query("include_attempts") === "true";
  const since = Math.floor(Date.now() / 1000) - Math.floor(hours * 3600);

  const conds = [
    sql`(${auditLog.userId} = ${user.id} OR EXISTS (
      SELECT 1 FROM project_memberships audit_membership
      WHERE audit_membership.project_id = ${auditLog.projectId}
        AND audit_membership.user_id = ${user.id}
    ))`,
    gte(auditLog.at, since),
  ];
  if (actionPrefix) conds.push(like(auditLog.action, `${actionPrefix}%`));
  if (resourceType) conds.push(eq(auditLog.resourceType, resourceType));
  if (projectId) conds.push(eq(auditLog.projectId, projectId));
  if (operationId) conds.push(eq(auditLog.operationId, operationId));
  if (!includeAttempts) {
    conds.push(eq(auditLog.phase, "succeeded"));
  }

  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.occurredAtMs), desc(auditLog.id))
    .limit(limit);

  return c.json({
    hours,
    since,
    count: rows.length,
    actions: rows.map((r) => {
      const metadata = r.metadataJson ? safeJson(r.metadataJson) : null;
      return {
      id: r.id,
      at: r.at,
      occurred_at_ms: r.occurredAtMs,
      action: r.action,
      resource_type: r.resourceType,
      resource_id: r.resourceId,
      project_id: r.projectId,
      actor: { type: "user", id: r.userId },
      summary: r.summary,
      ip: r.ip,
      ua: r.ua ? r.ua.slice(0, 80) : null,
      phase: r.phase,
      operation_id: r.operationId,
      request_hash: r.requestHash,
      metadata,
    };
    }),
    include_attempts: includeAttempts,
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      applies_to: ["actions[].summary", "actions[].metadata"],
      upstream_source: "audit_log",
      response_view: "bounded_transformed",
      raw_upstream_content_returned: false,
    },
    next_action:
      rows.length === 0
        ? `No agent-driven changes in the last ${hours}h.`
        : includeAttempts
          ? `Last ${rows.length} mutation event${rows.length === 1 ? "" : "s"}, newest first. Reconcile intent or indeterminate operations by operation_id before retrying any external side effect.`
          : `Last ${rows.length} completed mutation${rows.length === 1 ? "" : "s"}, newest first. Pass include_attempts=true to include intent/failed/indeterminate saga events; use operation_id to reconcile incomplete external mutations.`,
  });
});

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default router;
