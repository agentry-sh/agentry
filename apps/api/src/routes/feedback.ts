import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { errors, uuidv7 } from "@agentrysh/shared";
import { auditLog, feedback, mutationCommands } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import type { AppBindings } from "../env.js";
import type { User } from "@agentry/db/schema";
import { readBoundedJson } from "../bounded-json.js";
import { prepareAuditEvent } from "../audit.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";

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

// POST /v1/feedback — agent files a feedback item.
// Auth: API key (so it's tied to a user). project_id is optional context.
router.post("/v1/feedback", requireApiKey(), async (c) => {
  const user = c.get("user") as User;

  const body = await readBoundedJson(c, 16_384);
  const b = (body ?? {}) as Record<string, unknown>;

  const message = typeof b.message === "string" ? b.message.trim().slice(0, 4_000) : "";
  if (!message) {
    throw errors.invalidPayload({ reason: "message is required" });
  }

  const kindRaw = typeof b.kind === "string" ? b.kind : "other";
  const kind = (FEEDBACK_KINDS.includes(kindRaw as FeedbackKind) ? kindRaw : "other") as FeedbackKind;
  const fingerprint = optionalString(b.fingerprint, 240);
  const agentNote = optionalString(b.agent_note, 4_000);
  const toolName = optionalString(b.tool_name, 200);
  const attemptCount = typeof b.attempt_count === "number" && Number.isFinite(b.attempt_count)
    ? Math.floor(b.attempt_count)
    : null;
  const claudeSessionId = optionalString(b.claude_session_id, 200);

  const projectId = typeof b.project_id === "string" ? b.project_id : null;
  if (projectId) {
    // Verify the user owns the project — silently drop if they don't.
    await requireProjectAccess(c, projectId);
  }

  const identity = await mutationIdentity(c, {
    action: "feedback.create",
    projectId,
    request: {
      message,
      kind,
      project_id: projectId,
      agent_note: agentNote,
      tool_name: toolName,
      attempt_count: attemptCount,
      fingerprint,
      claude_session_id: claudeSessionId,
    },
  });
  const existingCommand = await loadMutationCommand(c, identity);
  if (existingCommand) {
    return c.json({
      ...mutationResponse<Record<string, unknown>>(existingCommand),
      idempotent_replay: true,
    });
  }

  const id = uuidv7();
  const now = Math.floor(Date.now() / 1000);
  const db = getDb(c.env);
  if (fingerprint) {
    const existing = await db
      .select()
      .from(feedback)
      .where(and(
        eq(feedback.userId, user.id),
        eq(feedback.fingerprint, fingerprint),
        eq(feedback.resolved, 0),
      ))
      .orderBy(desc(feedback.createdAt))
      .limit(1);

    const duplicate = existing[0];
    if (duplicate) {
      const durableResponse = {
        id: duplicate.id,
        received_at: duplicate.createdAt,
        fingerprint,
        deduped: true,
        next_action:
          "Feedback already recorded for this unresolved issue fingerprint. Tell the user once that it is logged, then continue the task.",
      };
      const audit = await prepareAuditEvent(c, {
        userId: user.id,
        projectId,
        action: "feedback.deduped",
        resourceType: "feedback",
        resourceId: duplicate.id,
        summary: `Deduplicated ${kind} feedback`,
        metadata: { command_id: identity.id, fingerprint },
      });
      try {
        await db.batch([
          db.insert(mutationCommands).values(mutationCommandValues(identity, {
            resourceType: "feedback",
            resourceId: duplicate.id,
            response: durableResponse,
            createdAt: now,
          })),
          db.insert(auditLog).values(audit.values),
        ] as const);
      } catch (error) {
        const winner = await loadMutationCommand(c, identity);
        if (winner) {
          return c.json({
            ...mutationResponse<Record<string, unknown>>(winner),
            idempotent_replay: true,
          });
        }
        throw error;
      }
      return c.json({ ...durableResponse, idempotent_replay: false });
    }
  }

  const feedbackValues = {
    id,
    userId: user.id,
    projectId,
    kind,
    message,
    agentNote,
    toolName,
    attemptCount,
    fingerprint,
    claudeSessionId,
    createdAt: now,
  } as const;
  const durableResponse = {
    id,
    received_at: now,
    fingerprint,
    deduped: false,
    next_action:
      "Feedback recorded. Tell the user: 'Thanks — I've logged that as feedback for the agentry team.' " +
      "Don't keep apologizing or revisit the same friction — file it once per distinct issue per session.",
  };
  const audit = await prepareAuditEvent(c, {
    userId: user.id,
    projectId,
    action: "feedback.created",
    resourceType: "feedback",
    resourceId: id,
    summary: `Created ${kind} feedback`,
    metadata: { command_id: identity.id, kind, fingerprint },
  });
  try {
    await db.batch([
      db.insert(feedback).values(feedbackValues),
      db.insert(mutationCommands).values(mutationCommandValues(identity, {
        resourceType: "feedback",
        resourceId: id,
        response: durableResponse,
        createdAt: now,
      })),
      db.insert(auditLog).values(audit.values),
    ] as const);
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner) {
      return c.json({
        ...mutationResponse<Record<string, unknown>>(winner),
        idempotent_replay: true,
      });
    }
    throw error;
  }

  return c.json({ ...durableResponse, idempotent_replay: false });
});

// GET /v1/feedback — list feedback the current user has filed.
// (Operator view for the project owner — there's no global admin path in v0.)
router.get("/v1/feedback", requireApiKey(), async (c) => {
  const user = c.get("user") as User;
  const limit = clamp(parseInt(c.req.query("limit") ?? "50", 10), 1, 500, 50);

  const resolvedRaw = c.req.query("resolved");
  const kindRaw = c.req.query("kind");
  const conditions = [eq(feedback.userId, user.id)];
  if (resolvedRaw === "true") conditions.push(eq(feedback.resolved, 1));
  else if (resolvedRaw === "false") conditions.push(eq(feedback.resolved, 0));
  if (kindRaw && FEEDBACK_KINDS.includes(kindRaw as FeedbackKind)) {
    conditions.push(eq(feedback.kind, kindRaw as FeedbackKind));
  }

  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(feedback)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(feedback.createdAt))
    .limit(limit);

  return c.json({
    count: rows.length,
    feedback: rows.map(serializeFeedback),
    next_action:
      rows.length === 0
        ? "No feedback filed yet."
        : "Surface the most recent items as a short markdown table. Group by kind if useful.",
  });
});

function serializeFeedback(row: typeof feedback.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    project_id: row.projectId,
    kind: row.kind,
    message: row.message,
    agent_note: row.agentNote,
    tool_name: row.toolName,
    attempt_count: row.attemptCount,
    fingerprint: row.fingerprint,
    claude_session_id: row.claudeSessionId,
    created_at: row.createdAt,
    resolved: row.resolved === 1,
    resolution: row.resolution,
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

export default router;
