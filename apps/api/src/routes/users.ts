// Bounded affected-user views backed by PostHog's authoritative exception data.

import { Hono } from "hono";
import { prepareTelemetryObservation } from "@agentrysh/shared";
import { requireApiKey, requireCaseAccess, requireProjectAccess } from "../middleware.js";
import { runHogQl } from "../posthog.js";
import {
  getPosthogIssue,
  getPosthogIssueEvents,
  posthogErrorDataBoundary,
} from "../posthog-error-tracking.js";
import type { AppBindings } from "../env.js";

const router = new Hono<AppBindings>();

router.use("/v1/projects/:project_id/users*", requireApiKey());

router.get("/v1/projects/:project_id/users", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const days = clampInt(c.req.query("days"), 1, 90, 30);
  const limit = clampInt(c.req.query("limit"), 1, 200, 50);
  const result = await runHogQl(c.env, projectId, `
SELECT
  distinct_id AS user_id,
  count() AS error_count,
  max(timestamp) AS last_seen_at
FROM events
WHERE event = '$exception'
  AND timestamp >= now() - INTERVAL ${days} DAY
  AND distinct_id NOT LIKE 'anonymous_%'
GROUP BY distinct_id
ORDER BY error_count DESC
LIMIT ${limit}`);
  const rows = result.results.flatMap((raw) => {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") return [];
    return [{
      user_id: raw[0],
      error_count: finiteNumber(raw[1]),
      last_seen_at: isoSeconds(raw[2]),
    }];
  });
  const observation = prepareTelemetryObservation(rows);
  return c.json({
    data_boundary: {
      ...posthogErrorDataBoundary(),
      applies_to: "affected_user_aggregate",
      contains_personal_data: true,
      inspection: observation.inspection,
    },
    project_id: projectId,
    window_days: days,
    returned_users: rows.length,
    users: observation.content,
    next_action:
      "Use a user's recent analytics and session context to understand the path before their exceptions. Counts come from PostHog $exception events; anonymous occurrences are excluded from this identified-user view.",
  });
});

router.get("/v1/cases/:case_id/users", requireApiKey(), async (c) => {
  const caseId = c.req.param("case_id");
  const access = await requireCaseAccess(c, caseId);
  const [issue, events] = await Promise.all([
    getPosthogIssue(c.env, access.project.id, access.case.providerIssueId ?? caseId),
    getPosthogIssueEvents(c.env, access.project.id, access.case.providerIssueId ?? caseId, {
      limit: 20,
      verbosity: "raw",
    }),
  ]);
  const users = new Map<string, { user_id: string; error_count: number; last_seen_at: number }>();
  for (const event of events.results) {
    const id = event.distinct_id;
    if (!id || id.startsWith("anonymous_")) continue;
    const seenAt = isoSeconds(event.timestamp);
    const current = users.get(id);
    users.set(id, {
      user_id: id,
      error_count: (current?.error_count ?? 0) + 1,
      last_seen_at: Math.max(current?.last_seen_at ?? 0, seenAt),
    });
  }
  const rows = [...users.values()].sort((a, b) => b.last_seen_at - a.last_seen_at);
  const observation = prepareTelemetryObservation(rows);
  return c.json({
    data_boundary: {
      ...posthogErrorDataBoundary(),
      applies_to: "sampled_issue_users",
      contains_personal_data: true,
      inspection: observation.inspection,
    },
    case_id: caseId,
    affected_user_count: finiteNumber(issue.aggregations?.users ?? issue.impact?.users),
    sampled_event_count: events.results.length,
    sample_has_more: events.hasMore,
    users: observation.content,
    next_action: rows.length === 0
      ? "No identified user appears in this bounded PostHog issue-event sample."
      : "Use these sampled distinct_ids to inspect the product path before the exception. Treat sample counts as samples; affected_user_count is the provider aggregate.",
  });
});

function clampInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function isoSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : 0;
}

export default router;
