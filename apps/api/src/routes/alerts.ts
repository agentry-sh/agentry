// Alerts: owner-configured definitions of "run this query blueprint + check
// threshold". Owners may evaluate one explicitly on demand, while the platform
// cron evaluates every active alert every 15 minutes. Automation runners never
// poll these owner routes: they consume exact server-issued alert receipts.

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  TELEMETRY_DATA_BOUNDARY,
  errors,
  prepareTelemetryObservation,
  uuidv7,
} from "@agentrysh/shared";
import { alerts, auditLog, mutationCommands } from "@agentry/db/schema";
import { getDb } from "../db.js";
import {
  requireApiKey,
  requireProjectAccess,
  requireProjectOwner,
  waitUntilOf,
} from "../middleware.js";
import { getQueryBlueprint, interpolateQuery } from "../query-blueprints.js";
import { evaluateAlertRow, VALID_ALERT_OPS } from "../alert-evaluation.js";
import type { ThresholdOp } from "../alert-evaluation.js";
import type { AppBindings } from "../env.js";
import { readBoundedJson } from "../bounded-json.js";
import { prepareAuditEvent } from "../audit.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";

const router = new Hono<AppBindings>();

router.post("/v1/projects/:project_id/alerts", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);

  const body = await readBoundedJson(c, 16_384);
  const acceptedObservation = prepareTelemetryObservation(body);
  const b = acceptedObservation.content as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.slice(0, 200) : null;
  const blueprintId = typeof b.blueprint_id === "string" ? b.blueprint_id : null;
  const thresholdColumn = typeof b.threshold_column === "string" ? b.threshold_column : null;
  const thresholdOp = typeof b.threshold_op === "string" ? b.threshold_op : null;
  const thresholdValueRaw = b.threshold_value;
  if (!name || !blueprintId || !thresholdColumn || !thresholdOp) {
    throw errors.invalidPayload({
      reason: "name, blueprint_id, threshold_column, and threshold_op are required",
    });
  }
  if (!VALID_ALERT_OPS.includes(thresholdOp as ThresholdOp)) {
    throw errors.invalidPayload({ reason: `threshold_op must be one of ${VALID_ALERT_OPS.join(", ")}` });
  }
  if (thresholdValueRaw === undefined || thresholdValueRaw === null) {
    throw errors.invalidPayload({ reason: "threshold_value is required" });
  }
  const blueprint = getQueryBlueprint(blueprintId);
  if (!blueprint) {
    throw errors.invalidPayload({ reason: `blueprint_id "${blueprintId}" not found` });
  }
  const params = b.params && typeof b.params === "object" ? (b.params as Record<string, unknown>) : {};
  const description = typeof b.description === "string" ? b.description.slice(0, 500) : null;
  const webhookId = typeof b.webhook_id === "string" ? b.webhook_id : null;
  if (blueprint.backend === "analytics") {
    try {
      interpolateQuery(blueprint.query, params, blueprint.params);
    } catch (err) {
      throw errors.invalidPayload({
        reason: "params don't satisfy blueprint.params",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const db = getDb(c.env);
  const identity = await mutationIdentity(c, {
    action: "alert.create",
    projectId,
    request: {
      name,
      blueprint_id: blueprintId,
      params,
      description,
      webhook_id: webhookId,
      threshold: {
        column: thresholdColumn,
        op: thresholdOp,
        value: String(thresholdValueRaw),
      },
    },
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) {
    return c.json({
      ...mutationResponse<Record<string, unknown>>(existing),
      idempotent_replay: true,
    });
  }

  const id = uuidv7();
  const createdAt = Math.floor(Date.now() / 1000);
  const alertValues = {
    id,
    projectId,
    name,
    description,
    recipeId: blueprintId,
    paramsJson: JSON.stringify(params),
    thresholdColumn,
    thresholdOp,
    thresholdValue: String(thresholdValueRaw),
    webhookId,
    active: 1,
    createdAt,
    lastState: "recovered",
  } as const;
  const durableResponse = {
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      classification: "authenticated_annotation",
      applies_to: "name, description, and params",
      inspection: acceptedObservation.inspection,
    },
    id,
    name,
    blueprint_id: blueprintId,
    backend: blueprint.backend,
    threshold: { column: thresholdColumn, op: thresholdOp, value: String(thresholdValueRaw) },
    next_action:
      "Alert created. agentry evaluates every active alert on a ~15-minute platform cron and fires alert.triggered when the threshold crosses and alert.recovered once it clears. " +
      "For an on-demand check, POST /v1/projects/:project_id/alerts/" + id + "/evaluate. " +
      "For unattended automation, configure an alert trigger in automation v2; the server issues an exact alert receipt and the bound runner consumes it with AGENTRY_RUNNER_API_KEY instead of polling this owner route.",
  };
  const audit = await prepareAuditEvent(c, {
    userId: c.get("user").id,
    projectId,
    action: "alert.created",
    resourceType: "alert",
    resourceId: id,
    summary: `Created alert ${name}`,
    metadata: {
      command_id: identity.id,
      blueprint_id: blueprintId,
      webhook_id: webhookId,
    },
  });
  try {
    await db.batch([
      db.insert(alerts).values(alertValues),
      db.insert(mutationCommands).values(mutationCommandValues(identity, {
        resourceType: "alert",
        resourceId: id,
        response: durableResponse,
        createdAt,
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

router.get("/v1/projects/:project_id/alerts", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const state = c.req.query("state");
  if (state !== undefined && state !== "triggered" && state !== "recovered") {
    throw errors.invalidPayload({ reason: "state must be 'triggered' or 'recovered'" });
  }
  const includeInactive = c.req.query("include_inactive") === "true";
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.projectId, projectId),
        state ? eq(alerts.lastState, state) : undefined,
        includeInactive ? undefined : eq(alerts.active, 1),
      ),
    );
  const alertObservation = prepareTelemetryObservation(rows.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    blueprint_id: a.recipeId,
    params: safeJsonObj(a.paramsJson),
    threshold: { column: a.thresholdColumn, op: a.thresholdOp, value: a.thresholdValue },
    webhook_id: a.webhookId,
    active: a.active === 1,
    last_evaluated_at: a.lastEvaluatedAt,
    last_triggered_at: a.lastTriggeredAt,
    last_value: a.lastValue,
    last_state: a.lastState,
  })));
  return c.json({
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      classification: "authenticated_annotation",
      applies_to: "alerts",
      inspection: alertObservation.inspection,
    },
    state_filter: state ?? null,
    alerts: alertObservation.content,
    next_action:
      state === "triggered"
        ? "These alerts are currently breaching their thresholds. Review them as a human owner/member; unattended automation consumes exact server-issued alert receipts rather than this list."
        : "This is the human alert-definition view. For unattended automation, use an enabled automation-v2 alert trigger and its exact server-issued receipt.",
  });
});

router.delete("/v1/projects/:project_id/alerts/:id", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  const id = c.req.param("id");
  await requireProjectOwner(c, projectId);
  const db = getDb(c.env);
  const before = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  if (!before[0] || before[0].projectId !== projectId) throw errors.notFound("alert");
  if (before[0].active !== 1) return c.json({ ok: true, id, idempotent_replay: true });
  const disabled = await db
    .update(alerts)
    .set({ active: 0 })
    .where(and(eq(alerts.id, id), eq(alerts.active, 1)))
    .returning({ id: alerts.id });
  if (disabled.length !== 1) {
    throw errors.conflict(
      "alert_disable_conflict",
      "The alert changed while it was being disabled.",
      "Re-read alerts with include_inactive=true before retrying.",
      { alert_id: id },
    );
  }
  return c.json({ ok: true, id, idempotent_replay: false });
});

router.post(
  "/v1/projects/:project_id/alerts/:id/evaluate",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const alertId = c.req.param("id");
    await requireProjectOwner(c, projectId);

    const db = getDb(c.env);
    const rows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
    const a = rows[0];
    if (!a || a.projectId !== projectId) throw errors.notFound("alert");
    if (a.active !== 1) {
      throw errors.conflict(
        "alert_disabled",
        "This alert is disabled and cannot be evaluated.",
        "Read active alerts or re-create an explicit replacement definition.",
        { alert_id: a.id },
      );
    }

    const result = await evaluateAlertRow(c.env, a, waitUntilOf(c));

    return c.json({
      alert_id: result.alertId,
      blueprint_id: result.blueprintId,
      evaluated_at: result.evaluatedAt,
      current_value: result.currentValue,
      threshold: { column: a.thresholdColumn, op: a.thresholdOp, value: a.thresholdValue },
      triggered: result.triggered,
      transition_event: result.transitionEvent,
      rows_count: result.rowsCount,
      next_action: result.transitionEvent === "alert.triggered"
        ? "Threshold crossed and alert.triggered was emitted."
        : result.transitionEvent === "alert.recovered"
        ? "Threshold recovered and alert.recovered was emitted."
        : result.triggered
        ? "Threshold is still breached. No new webhook was emitted because the alert was already triggered."
        : "Threshold is clear. No new webhook was emitted because the alert was already recovered.",
    });
  },
);

function safeJsonObj(s: string | null | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

export default router;
