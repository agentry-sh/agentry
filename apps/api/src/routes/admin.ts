// Admin-only endpoints for plan administration, retention, and product feedback.
// Auth: ADMIN_TOKEN env secret. If unset, all /admin/* requests get 404 to
// avoid advertising the surface.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { errors } from "@agentrysh/shared";
import { feedback, projects, users } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { invalidateUserAuthCache } from "../middleware.js";
import { applyRetention } from "../retention.js";
import type { AppBindings } from "../env.js";
import { readBoundedJson } from "../bounded-json.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const expected = c.env.ADMIN_TOKEN;
    // If no admin token is configured, refuse with 404 — don't leak that the
    // surface exists.
    if (!expected || expected.length === 0) throw errors.notFound("route");

    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    const presented = m?.[1]?.trim() ?? "";
    if (!presented || !timingSafeEqual(presented, expected)) {
      throw errors.unauthorized();
    }
    await next();
  };
}

const router = new Hono<AppBindings>();

const FEEDBACK_KINDS = [
  "missing_feature",
  "bug",
  "agent_discovered_bug",
  "ux_friction",
  "answer_contract_proposal",
  "other",
] as const;

type FeedbackKind = typeof FEEDBACK_KINDS[number];

// GET /admin/feedback — operator view of agent-filed product feedback.
// This is the product-wide queue Henrik receives from customer agents via
// POST /v1/feedback. The user-scoped GET /v1/feedback intentionally remains
// tenant-scoped; this admin route is the private cross-user view.
router.get("/admin/feedback", requireAdmin(), async (c) => {
  const limit = clamp(parseInt(c.req.query("limit") ?? "100", 10), 1, 500, 100);
  const resolvedRaw = c.req.query("resolved");
  const kindRaw = c.req.query("kind");
  const userId = optionalString(c.req.query("user_id"), 200);
  const projectId = optionalString(c.req.query("project_id"), 200);
  const q = optionalString(c.req.query("q"), 200);

  const conditions: SQL[] = [];
  if (resolvedRaw === "true") conditions.push(eq(feedback.resolved, 1));
  else if (resolvedRaw === "false") conditions.push(eq(feedback.resolved, 0));
  if (kindRaw && FEEDBACK_KINDS.includes(kindRaw as FeedbackKind)) {
    conditions.push(eq(feedback.kind, kindRaw as FeedbackKind));
  }
  if (userId) conditions.push(eq(feedback.userId, userId));
  if (projectId) conditions.push(eq(feedback.projectId, projectId));
  if (q) {
    const needle = `%${q.toLowerCase()}%`;
    conditions.push(sql`(
      lower(${feedback.message}) like ${needle}
      or lower(${feedback.agentNote}) like ${needle}
      or lower(${feedback.toolName}) like ${needle}
      or lower(${feedback.fingerprint}) like ${needle}
      or lower(${users.email}) like ${needle}
      or lower(${projects.name}) like ${needle}
    )`);
  }

  const where = conditions.length === 0
    ? sql`1 = 1`
    : conditions.length === 1
      ? conditions[0]!
      : and(...conditions)!;

  const db = getDb(c.env);
  const rows = await db
    .select({
      feedback,
      userEmail: users.email,
      userGithubUsername: users.githubUsername,
      userPlan: users.plan,
      projectName: projects.name,
      projectRepoUrl: projects.repoUrl,
    })
    .from(feedback)
    .leftJoin(users, eq(users.id, feedback.userId))
    .leftJoin(projects, eq(projects.id, feedback.projectId))
    .where(where)
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  const serialized = rows.map((row) => serializeAdminFeedback(row));

  return c.json({
    count: serialized.length,
    limit,
    filters: {
      resolved: resolvedRaw === "true" || resolvedRaw === "false" ? resolvedRaw === "true" : null,
      kind: kindRaw && FEEDBACK_KINDS.includes(kindRaw as FeedbackKind) ? kindRaw : null,
      user_id: userId,
      project_id: projectId,
      q,
    },
    summary: summarizeFeedback(serialized),
    feedback: serialized,
    next_action:
      serialized.length === 0
        ? "No agent-filed feedback matches these filters."
        : "Review the newest agent-filed feedback first. Use kind, fingerprint, tool_name, user, and project to cluster duplicates before deciding what to fix.",
  });
});

// POST /admin/retention/sweep — force the same plan-based retention sweep the
// daily cron runs. Useful after plan changes or migration/backfill work.
router.post("/admin/retention/sweep", requireAdmin(), async (c) => {
  const result = await applyRetention(c.env);
  return c.json(result);
});

// GET /admin/plans — what plans exist + their limits. Cheap convenience.
router.get("/admin/plans", requireAdmin(), async (_c) => {
  const { PLANS } = await import("../plans.js");
  return Response.json({ plans: PLANS });
});

// PATCH /admin/users/:user_id/plan — move a user between plans.
// Body: { plan: "free" | "nerve" }
router.patch("/admin/users/:user_id/plan", requireAdmin(), async (c: Context<AppBindings>) => {
  const userId = c.req.param("user_id");
  if (!userId) throw errors.notFound("user");
  const body = await readBoundedJson(c, 4_096);
  const planId = (body as { plan?: unknown })?.plan;
  if (typeof planId !== "string" || !(planId === "free" || planId === "nerve")) {
    throw errors.invalidPayload({ reason: "plan must be one of: free, nerve" });
  }

  const db = getDb(c.env);
  const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!existing[0]) throw errors.notFound("user");

  await db.update(users).set({ plan: planId }).where(eq(users.id, userId));
  invalidateUserAuthCache(userId);
  return c.json({ user_id: userId, plan: planId });
});

export default router;

type AdminFeedbackRow = {
  feedback: typeof feedback.$inferSelect;
  userEmail: string | null;
  userGithubUsername: string | null;
  userPlan: string | null;
  projectName: string | null;
  projectRepoUrl: string | null;
};

type SerializedAdminFeedback = ReturnType<typeof serializeAdminFeedback>;

function serializeAdminFeedback(row: AdminFeedbackRow) {
  return {
    id: row.feedback.id,
    kind: row.feedback.kind,
    message: row.feedback.message,
    agent_note: row.feedback.agentNote,
    tool_name: row.feedback.toolName,
    attempt_count: row.feedback.attemptCount,
    fingerprint: row.feedback.fingerprint,
    claude_session_id: row.feedback.claudeSessionId,
    created_at: row.feedback.createdAt,
    resolved: row.feedback.resolved === 1,
    resolution: row.feedback.resolution,
    user: {
      id: row.feedback.userId,
      email: row.userEmail,
      github_username: row.userGithubUsername,
      plan: row.userPlan,
    },
    project: {
      id: row.feedback.projectId,
      name: row.projectName,
      repo_url: row.projectRepoUrl,
    },
  };
}

function summarizeFeedback(rows: SerializedAdminFeedback[]) {
  const byKind = new Map<string, number>();
  const byTool = new Map<string, number>();
  let open = 0;
  let resolved = 0;
  for (const row of rows) {
    if (row.resolved) resolved += 1;
    else open += 1;
    byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
    if (row.tool_name) byTool.set(row.tool_name, (byTool.get(row.tool_name) ?? 0) + 1);
  }
  return {
    open,
    resolved,
    by_kind: Object.fromEntries([...byKind.entries()].sort((a, b) => b[1] - a[1])),
    by_tool: Object.fromEntries([...byTool.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
  };
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
