// Shared alert evaluation core. Called from the customer-facing
// POST /alerts/:id/evaluate route and from the cron sweep in index.ts.
// Evaluation is deterministic: run the alert's query blueprint (analytics via
// HogQL, operational via agentry_db SQL), sum the threshold column, compare,
// and fire alert.triggered / alert.recovered webhooks on state transitions only.

import { and, eq, isNull, sql } from "drizzle-orm";
import { canonicalJsonStringify, errors, sha256Hex } from "@agentrysh/shared";
import { alerts, projectDeletionFences, webhookDeliveries } from "@agentry/db/schema";
import type { Alert } from "@agentry/db/schema";
import { getDb } from "./db.js";
import {
  assertWebhookOutboxPersisted,
  dispatchPersistedWebhookDeliveries,
  prepareWebhookOutbox,
} from "./webhooks.js";
import { getQueryBlueprint, interpolateQuery } from "./query-blueprints.js";
import { hogQlRowsToObjects, isPosthogConfigured, runHogQl } from "./posthog.js";
import { runOperationalBlueprintRows } from "./operational-blueprints.js";
import type { Env } from "./env.js";
import { assertProjectExternalWritesOpen } from "./external-mutation-boundary.js";

export const VALID_ALERT_OPS = ["gt", "gte", "lt", "lte", "eq"] as const;
export type ThresholdOp = (typeof VALID_ALERT_OPS)[number];
export type AlertState = "triggered" | "recovered";

export interface AlertEvaluationResult {
  alertId: string;
  blueprintId: string;
  evaluatedAt: number;
  currentValue: number;
  triggered: boolean;
  transitionEvent: "alert.triggered" | "alert.recovered" | null;
  rowsCount: number;
}

export async function evaluateAlertRow(
  env: Env,
  a: Alert,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<AlertEvaluationResult> {
  const blueprint = getQueryBlueprint(a.recipeId);
  if (!blueprint) {
    throw errors.catalogInconsistent(
      `Alert references unknown query blueprint '${a.recipeId}'.`,
      { blueprint_id: a.recipeId, alert_id: a.id },
    );
  }
  const params = safeJsonObj(a.paramsJson) as Record<string, unknown>;
  // Keep timestamps truthful. CAS state, durable source_event_id, and stable
  // webhook identity provide concurrency control; incrementing an old value
  // to manufacture uniqueness can push alert times into the future after
  // repeated/manual evaluations.
  const now = Math.floor(Date.now() / 1000);
  const db = getDb(env);

  let rowsOut: Array<Record<string, unknown>>;
  if (blueprint.backend === "analytics") {
    if (!isPosthogConfigured(env)) {
      throw errors.posthogConnectionRequired({ operation: "evaluate_analytics_alert" });
    }
    let interpolated: string;
    try {
      interpolated = interpolateQuery(blueprint.query, params, blueprint.params);
    } catch (err) {
      throw errors.invalidPayload({
        reason: "stored alert params don't satisfy blueprint.params",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    const out = await runHogQl(env, a.projectId, interpolated);
    rowsOut = hogQlRowsToObjects(out.results, out.columns, blueprint.expected_columns);
  } else {
    rowsOut = await runOperationalBlueprintRows(env, db, a.projectId, blueprint, params);
  }

  let value = 0;
  for (const row of rowsOut) {
    const v = row[a.thresholdColumn];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) value += n;
  }

  const threshold = Number(a.thresholdValue);
  const op = a.thresholdOp as ThresholdOp;
  const triggered = compareThreshold(value, op, threshold);
  const nextState: AlertState = triggered ? "triggered" : "recovered";
  const previousState = (a.lastState as AlertState | null) ?? "recovered";
  const transitionEvent =
    previousState !== nextState
      ? nextState === "triggered"
        ? ("alert.triggered" as const)
        : ("alert.recovered" as const)
      : null;

  const evaluationIdentity = await sha256Hex(canonicalJsonStringify({
    alert_id: a.id,
    previous_evaluated_at: a.lastEvaluatedAt,
    previous_state: a.lastState,
    evaluated_at: now,
    value,
    next_state: nextState,
  }));
  const sourceEventId = `alert:${a.id}:${evaluationIdentity}`;
  const outbox = transitionEvent
    ? await prepareWebhookOutbox(
        env,
        a.projectId,
        transitionEvent,
        {
          alert_id: a.id,
          alert_name: a.name,
          blueprint_id: a.recipeId,
          threshold_column: a.thresholdColumn,
          threshold_op: a.thresholdOp,
          threshold_value: a.thresholdValue,
          current_value: value,
          evaluated_at: now,
          state: nextState,
          rows: rowsOut.slice(0, 20),
        },
        a.webhookId
          ? { sourceEventId, webhookId: a.webhookId }
          : { sourceEventId },
      )
    : null;

  const evaluationWrite = db
    .update(alerts)
    .set({
      lastEvaluatedAt: now,
      lastValue: String(value),
      lastState: nextState,
      ...(transitionEvent === "alert.triggered" ? { lastTriggeredAt: now } : {}),
    })
    .where(and(
      eq(alerts.id, a.id),
      eq(alerts.active, 1),
      a.lastEvaluatedAt === null
        ? isNull(alerts.lastEvaluatedAt)
        : eq(alerts.lastEvaluatedAt, a.lastEvaluatedAt),
      a.lastState === null
        ? isNull(alerts.lastState)
        : eq(alerts.lastState, a.lastState),
    ))
    .returning({ id: alerts.id });

  // Each INSERT...SELECT is guarded by the exact post-CAS alert state. libSQL
  // commits the update and every matching outbox row as one batch: a delivery
  // constraint failure rolls back the alert transition, while a concurrent
  // evaluator that lost the CAS inserts nothing.
  const deliveryWrites = (outbox?.deliveries ?? []).map((delivery) =>
    db
      .insert(webhookDeliveries)
      .select(
        db
          .select({
            id: sql<string>`CASE WHEN NOT EXISTS (
              SELECT 1 FROM ${projectDeletionFences}
              WHERE ${projectDeletionFences.projectId} = ${delivery.projectId}
            ) THEN ${delivery.id} ELSE NULL END`.as("id"),
            projectId: sql<string>`${delivery.projectId}`.as("project_id"),
            webhookId: sql<string | null>`${delivery.webhookId ?? null}`.as("webhook_id"),
            sourceEventId: sql<string>`${delivery.sourceEventId}`.as("source_event_id"),
            sourceEventHash: sql<string>`${delivery.sourceEventHash}`.as("source_event_hash"),
            event: sql<string>`${delivery.event}`.as("event"),
            payloadJson: sql<string>`${delivery.payloadJson}`.as("payload_json"),
            status: sql<string>`${delivery.status ?? "pending"}`.as("status"),
            attemptCount: sql<number>`${delivery.attemptCount ?? 0}`.as("attempt_count"),
            maxAttempts: sql<number>`${delivery.maxAttempts ?? 8}`.as("max_attempts"),
            nextAttemptAt: sql<number>`${delivery.nextAttemptAt}`.as("next_attempt_at"),
            lockedAt: sql<number | null>`${delivery.lockedAt ?? null}`.as("locked_at"),
            lockedBy: sql<string | null>`${delivery.lockedBy ?? null}`.as("locked_by"),
            lastAttemptAt: sql<number | null>`${delivery.lastAttemptAt ?? null}`.as("last_attempt_at"),
            deliveredAt: sql<number | null>`${delivery.deliveredAt ?? null}`.as("delivered_at"),
            lastStatusCode: sql<number | null>`${delivery.lastStatusCode ?? null}`.as("last_status_code"),
            lastError: sql<string | null>`${delivery.lastError ?? null}`.as("last_error"),
            createdAt: sql<number>`${delivery.createdAt}`.as("created_at"),
            updatedAt: sql<number>`${delivery.updatedAt}`.as("updated_at"),
          })
          .from(alerts)
          .where(and(
            eq(alerts.id, a.id),
            eq(alerts.active, 1),
            eq(alerts.lastEvaluatedAt, now),
            eq(alerts.lastState, nextState),
            eq(alerts.lastValue, String(value)),
            sql`changes() = 1`,
          )),
      )
      .onConflictDoNothing({
        target: [webhookDeliveries.webhookId, webhookDeliveries.sourceEventId],
      })
      .returning({ id: webhookDeliveries.id }),
  );

  let acquired;
  try {
    [acquired] = await db.batch(
      [evaluationWrite, ...deliveryWrites] as [
        typeof evaluationWrite,
        ...typeof deliveryWrites,
      ],
    );
  } catch (error) {
    await assertProjectExternalWritesOpen(env, a.projectId);
    throw error;
  }
  const wonEvaluation = acquired.length === 1;
  const durableTransition = wonEvaluation ? transitionEvent : null;

  if (durableTransition && outbox) {
    await assertWebhookOutboxPersisted(env, outbox);
    await dispatchPersistedWebhookDeliveries(
      env,
      outbox.deliveryIds,
      waitUntil,
    );
  }

  return {
    alertId: a.id,
    blueprintId: a.recipeId,
    evaluatedAt: now,
    currentValue: value,
    triggered,
    transitionEvent: durableTransition,
    rowsCount: rowsOut.length,
  };
}

// Cron sweep: evaluate every active alert across all projects. Analytics-backed
// alerts are skipped when PostHog isn't configured; individual failures are
// logged and never abort the sweep.
export async function evaluateAllActiveAlerts(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ evaluated: number; transitions: number; failures: number }> {
  const db = getDb(env);
  const rows = await db.select().from(alerts).where(eq(alerts.active, 1));
  let evaluated = 0;
  let transitions = 0;
  let failures = 0;
  for (const a of rows) {
    try {
      const result = await evaluateAlertRow(env, a, waitUntil);
      evaluated += 1;
      if (result.transitionEvent) transitions += 1;
    } catch (err) {
      failures += 1;
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          cron: "alert_sweep",
          alert_id: a.id,
          project_id: a.projectId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return { evaluated, transitions, failures };
}

export function compareThreshold(value: number, op: ThresholdOp, threshold: number): boolean {
  switch (op) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
  }
}

function safeJsonObj(s: string | null | undefined): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}
