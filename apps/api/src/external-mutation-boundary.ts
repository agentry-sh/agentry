import { and, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  projectDeletionFences,
  projects,
  webhookDeliveries,
} from "@agentry/db/schema";
import { AgentryError } from "@agentrysh/shared";
import type { AgentryDb } from "./db.js";
import { getDb } from "./db.js";
import type { Env } from "./env.js";

// Longer than every current external control-plane provider request budget. An
// intent without a terminal audit row remains potentially in flight until this
// DB-clock deadline. Afterward it is retained as unknown external state; it is
// never reclassified as a definite provider failure.
export const EXTERNAL_MUTATION_ACTIVE_WINDOW_SECONDS = 15 * 60;
export const EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT = 20;
export const MAX_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000;
export const WEBHOOK_DELIVERY_DRAIN_SAFETY_SECONDS =
  Math.ceil(MAX_WEBHOOK_DELIVERY_TIMEOUT_MS / 1_000) + 1;

const WEBHOOK_CANCELLED_BEFORE_SEND = "project_deletion_fenced_before_webhook_send";
const WEBHOOK_OUTCOME_UNKNOWN = "project_deletion_webhook_outcome_unknown";

export type ExternalMutationState =
  | "active"
  | "retained_external_state"
  | "external_state_unknown"
  | "completed_without_retained_resource"
  | "failed_without_provider_effect";

export interface ExternalMutationOperation {
  operation_id: string;
  project_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  state: ExternalMutationState;
  intent_at_ms: number;
  terminal_at_ms: number | null;
  active_until: number | null;
}

export interface ExternalMutationManifest {
  as_of: number;
  active_window_seconds: number;
  total_operations: number;
  counts: Record<ExternalMutationState, number>;
  counts_by_action: Array<{
    action: string;
    total: number;
    active: number;
    retained_external_state: number;
    external_state_unknown: number;
    completed_without_retained_resource: number;
    failed_without_provider_effect: number;
  }>;
  counts_by_action_limit: number;
  counts_by_action_truncated: boolean;
  operations: ExternalMutationOperation[];
  operations_truncated: boolean;
  active_until: number | null;
  retry_after_seconds: number | null;
  audit_handoff: {
    endpoint: string;
    available_until_account_deletion: boolean;
    note: string;
  };
}

// Keep every SQL statement comfortably below D1/libSQL bind limits and keep
// the merge accumulator constant-sized even for accounts with many projects.
const DELETION_MANIFEST_PROJECT_PAGE_SIZE = 50;

export interface WebhookDeliveryDrainState {
  drained: boolean;
  as_of: number;
  timeout_ms: number;
  safety_seconds: number;
  active_until: number | null;
  retry_after_seconds: number | null;
  active_delivery_count: number;
  cancelled_without_send_count: number;
  known_delivered_after_fence_count: number;
  known_delivered_delivery_ids: string[];
  unknown_outcome_count: number;
  unknown_outcome_delivery_ids: string[];
  operation_ids_truncated: boolean;
  external_follow_up: {
    required: boolean;
    note: string;
  };
}

/**
 * Cancel work that has not reached the network and wait for a request that
 * crossed the final pre-send authority check. The fence timestamp and the
 * fetch AbortController share one bounded deadline. A worker that fails to
 * publish its result by that deadline is cancelled locally and reported as an
 * unknown receiver outcome rather than being described as definitely absent.
 */
export async function webhookDeliveryDrainState(
  db: AgentryDb,
  projectIds: string[],
): Promise<WebhookDeliveryDrainState> {
  const uniqueProjectIds = Array.from(new Set(projectIds)).sort();
  const nowResult = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const nowSeconds = Number(nowResult.rows[0]?.now_seconds ?? 0);
  if (uniqueProjectIds.length === 0) {
    return emptyWebhookDeliveryDrain(nowSeconds);
  }

  const fencedProject = sql`EXISTS (
    SELECT 1 FROM ${projectDeletionFences}
    WHERE ${projectDeletionFences.projectId} = ${webhookDeliveries.projectId}
  )`;
  const attemptCrossedFence = sql`${webhookDeliveries.lastAttemptAt} >= (
    SELECT ${projectDeletionFences.createdAt} FROM ${projectDeletionFences}
    WHERE ${projectDeletionFences.projectId} = ${webhookDeliveries.projectId}
  )`;

  // A completed request may publish retrying/dead-letter state just after the
  // fence. Preserve that ambiguity before cancelling future attempts.
  await db.update(webhookDeliveries).set({
    status: "cancelled",
    lockedAt: null,
    lockedBy: null,
    lastError: WEBHOOK_OUTCOME_UNKNOWN,
    updatedAt: nowSeconds,
  }).where(and(
    inArray(webhookDeliveries.projectId, uniqueProjectIds),
    inArray(webhookDeliveries.status, ["pending", "retrying", "failed"]),
    isNotNull(webhookDeliveries.lastAttemptAt),
    attemptCrossedFence,
    fencedProject,
  ));
  await db.update(webhookDeliveries).set({
    status: "cancelled",
    lockedAt: null,
    lockedBy: null,
    lastError: WEBHOOK_CANCELLED_BEFORE_SEND,
    updatedAt: nowSeconds,
  }).where(and(
    inArray(webhookDeliveries.projectId, uniqueProjectIds),
    inArray(webhookDeliveries.status, ["pending", "retrying", "failed"]),
    fencedProject,
  ));

  // Once the bounded fetch deadline is past, a still-delivering row is no
  // longer allowed to keep local authority. Preserve it as unknown and let a
  // stale worker's lease CAS fail if it eventually reports back.
  await db.update(webhookDeliveries).set({
    status: "cancelled",
    lockedAt: null,
    lockedBy: null,
    lastError: WEBHOOK_OUTCOME_UNKNOWN,
    updatedAt: nowSeconds,
  }).where(and(
    inArray(webhookDeliveries.projectId, uniqueProjectIds),
    eq(webhookDeliveries.status, "delivering"),
    sql`EXISTS (
      SELECT 1 FROM ${projectDeletionFences}
      WHERE ${projectDeletionFences.projectId} = ${webhookDeliveries.projectId}
        AND ${nowSeconds} >= ${projectDeletionFences.createdAt} + ${WEBHOOK_DELIVERY_DRAIN_SAFETY_SECONDS}
    )`,
  ));

  const knownOutcome = and(
    eq(webhookDeliveries.status, "succeeded"),
    isNotNull(webhookDeliveries.deliveredAt),
    gte(webhookDeliveries.deliveredAt, projectDeletionFences.createdAt),
  );
  const unknownOutcome = or(
    eq(webhookDeliveries.lastError, WEBHOOK_OUTCOME_UNKNOWN),
    and(
      inArray(webhookDeliveries.status, ["cancelled", "retrying", "failed", "dead_letter"]),
      isNotNull(webhookDeliveries.lastAttemptAt),
      gte(webhookDeliveries.lastAttemptAt, projectDeletionFences.createdAt),
    ),
  );
  const [summary, knownSample, unknownSample] = await Promise.all([
    db.select({
      activeCount: sql<number>`sum(CASE WHEN ${webhookDeliveries.status} = 'delivering' THEN 1 ELSE 0 END)`,
      activeUntil: sql<number | null>`max(CASE WHEN ${webhookDeliveries.status} = 'delivering' THEN ${projectDeletionFences.createdAt} + ${WEBHOOK_DELIVERY_DRAIN_SAFETY_SECONDS} ELSE NULL END)`,
      cancelledWithoutSendCount: sql<number>`sum(CASE WHEN ${webhookDeliveries.lastError} = ${WEBHOOK_CANCELLED_BEFORE_SEND} THEN 1 ELSE 0 END)`,
      knownCount: sql<number>`sum(CASE WHEN ${knownOutcome} THEN 1 ELSE 0 END)`,
      unknownCount: sql<number>`sum(CASE WHEN ${unknownOutcome} THEN 1 ELSE 0 END)`,
    }).from(webhookDeliveries)
      .innerJoin(
        projectDeletionFences,
        eq(projectDeletionFences.projectId, webhookDeliveries.projectId),
      )
      .where(inArray(webhookDeliveries.projectId, uniqueProjectIds)),
    db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
      .innerJoin(
        projectDeletionFences,
        eq(projectDeletionFences.projectId, webhookDeliveries.projectId),
      )
      .where(and(
        inArray(webhookDeliveries.projectId, uniqueProjectIds),
        knownOutcome,
      ))
      .orderBy(webhookDeliveries.id)
      .limit(EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT),
    db.select({ id: webhookDeliveries.id }).from(webhookDeliveries)
      .innerJoin(
        projectDeletionFences,
        eq(projectDeletionFences.projectId, webhookDeliveries.projectId),
      )
      .where(and(
        inArray(webhookDeliveries.projectId, uniqueProjectIds),
        unknownOutcome,
      ))
      .orderBy(webhookDeliveries.id)
      .limit(EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT),
  ]);
  const activeCount = Number(summary[0]?.activeCount ?? 0);
  const activeUntil = summary[0]?.activeUntil === null || summary[0]?.activeUntil === undefined
    ? null
    : Number(summary[0].activeUntil);
  const cancelledWithoutSendCount = Number(summary[0]?.cancelledWithoutSendCount ?? 0);
  const knownCount = Number(summary[0]?.knownCount ?? 0);
  const unknownCount = Number(summary[0]?.unknownCount ?? 0);
  const knownDeliveredIds = knownSample.map((row) => row.id);
  const unknownIds = unknownSample.map((row) => row.id);
  const retryAfter = activeUntil === null
    ? null
    : Math.max(1, activeUntil - nowSeconds);
  const externalFollowUpRequired = knownCount > 0 || unknownCount > 0;
  return {
    drained: activeCount === 0,
    as_of: nowSeconds,
    timeout_ms: MAX_WEBHOOK_DELIVERY_TIMEOUT_MS,
    safety_seconds: WEBHOOK_DELIVERY_DRAIN_SAFETY_SECONDS,
    active_until: activeUntil,
    retry_after_seconds: retryAfter,
    active_delivery_count: activeCount,
    cancelled_without_send_count: cancelledWithoutSendCount,
    known_delivered_after_fence_count: knownCount,
    known_delivered_delivery_ids: knownDeliveredIds,
    unknown_outcome_count: unknownCount,
    unknown_outcome_delivery_ids: unknownIds,
    operation_ids_truncated:
      knownCount > EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT ||
      unknownCount > EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT,
    external_follow_up: {
      required: externalFollowUpRequired,
      note: externalFollowUpRequired
        ? "A webhook receiver may retain deliveries that crossed the deletion fence. Known delivered and unknown-outcome delivery ids are bounded samples; reconcile receiver data under that receiver's retention policy."
        : "Queued webhook deliveries were cancelled before send, and no pre-fence delivery has an unresolved receiver outcome.",
    },
  };
}

function emptyWebhookDeliveryDrain(nowSeconds: number): WebhookDeliveryDrainState {
  return {
    drained: true,
    as_of: nowSeconds,
    timeout_ms: MAX_WEBHOOK_DELIVERY_TIMEOUT_MS,
    safety_seconds: WEBHOOK_DELIVERY_DRAIN_SAFETY_SECONDS,
    active_until: null,
    retry_after_seconds: null,
    active_delivery_count: 0,
    cancelled_without_send_count: 0,
    known_delivered_after_fence_count: 0,
    known_delivered_delivery_ids: [],
    unknown_outcome_count: 0,
    unknown_outcome_delivery_ids: [],
    operation_ids_truncated: false,
    external_follow_up: {
      required: false,
      note: "No project webhook delivery required deletion-time draining.",
    },
  };
}

export async function assertProjectExternalWritesOpen(
  env: Env,
  projectId: string,
): Promise<void> {
  const db = getDb(env);
  const row = (
    await db.select({
      projectId: projects.id,
      fenceCommandId: projectDeletionFences.commandId,
      fenceReason: projectDeletionFences.reason,
      fencedAt: projectDeletionFences.createdAt,
    }).from(projects)
      .leftJoin(
        projectDeletionFences,
        eq(projectDeletionFences.projectId, projects.id),
      )
      .where(eq(projects.id, projectId))
      .limit(1)
  )[0];
  if (!row) {
    throw new AgentryError({
      status: 410,
      code: "project_external_writes_closed",
      message: "This project was deleted, so Agentry will not start another external write.",
      nextAction:
        "Stop using this project's CI, runner, webhook, and automation control-plane credentials. Customer telemetry continues to follow the customer's own PostHog retention and access policy.",
      details: {
        project_id: projectId,
        state: "deleted",
        retryable: false,
      },
    });
  }
  if (row.fenceCommandId) {
    throw new AgentryError({
      status: 409,
      code: "project_deletion_in_progress",
      message: "Project deletion has fenced all new external writes.",
      nextAction:
        "Do not retry control-plane writes for this project. Let the owner resume the existing deletion command with its original Idempotency-Key; Agentry will detach OAuth without deleting the customer's PostHog project.",
      details: {
        project_id: projectId,
        command_id: row.fenceCommandId,
        reason: row.fenceReason,
        fenced_at: row.fencedAt,
        state: "deletion_fenced",
        retryable: false,
      },
    });
  }
}

export async function externalMutationManifest(
  db: AgentryDb,
  projectIds: string[],
): Promise<ExternalMutationManifest> {
  const uniqueProjectIds = Array.from(new Set(projectIds)).sort();
  const nowResult = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const nowSeconds = Number(nowResult.rows[0]?.now_seconds ?? 0);
  const stateNames: ExternalMutationState[] = [
    "active",
    "retained_external_state",
    "external_state_unknown",
    "completed_without_retained_resource",
    "failed_without_provider_effect",
  ];
  const counts = Object.fromEntries(stateNames.map((state) => [state, 0])) as Record<
    ExternalMutationState,
    number
  >;
  let totalOperations = 0;
  let activeUntil: number | null = null;
  let operationCandidates: ExternalMutationOperation[] = [];
  const actionCounts = new Map<string, Record<ExternalMutationState, number>>();

  for (
    let offset = 0;
    offset < uniqueProjectIds.length;
    offset += DELETION_MANIFEST_PROJECT_PAGE_SIZE
  ) {
    const page = uniqueProjectIds.slice(offset, offset + DELETION_MANIFEST_PROJECT_PAGE_SIZE);
    const summaryResult = await db.run(sql`
      ${externalMutationClassificationSql(page, nowSeconds)}
      SELECT
        count(*) AS total_operations,
        sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN state = 'retained_external_state' THEN 1 ELSE 0 END) AS retained_external_state,
        sum(CASE WHEN state = 'external_state_unknown' THEN 1 ELSE 0 END) AS external_state_unknown,
        sum(CASE WHEN state = 'completed_without_retained_resource' THEN 1 ELSE 0 END) AS completed_without_retained_resource,
        sum(CASE WHEN state = 'failed_without_provider_effect' THEN 1 ELSE 0 END) AS failed_without_provider_effect,
        max(active_until) AS active_until
      FROM classified
    `);
    const summary = resultRows(summaryResult)[0] ?? {};
    totalOperations += numberField(summary, "total_operations");
    for (const state of stateNames) counts[state] += numberField(summary, state);
    const pageActiveUntil = nullableNumberField(summary, "active_until");
    if (pageActiveUntil !== null) {
      activeUntil = Math.max(activeUntil ?? 0, pageActiveUntil);
    }

    const actionResult = await db.run(sql`
      ${externalMutationClassificationSql(page, nowSeconds)}
      SELECT
        action,
        count(*) AS total,
        sum(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
        sum(CASE WHEN state = 'retained_external_state' THEN 1 ELSE 0 END) AS retained_external_state,
        sum(CASE WHEN state = 'external_state_unknown' THEN 1 ELSE 0 END) AS external_state_unknown,
        sum(CASE WHEN state = 'completed_without_retained_resource' THEN 1 ELSE 0 END) AS completed_without_retained_resource,
        sum(CASE WHEN state = 'failed_without_provider_effect' THEN 1 ELSE 0 END) AS failed_without_provider_effect
      FROM classified
      GROUP BY action
      ORDER BY action
      LIMIT ${EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT + 1}
    `);
    for (const row of resultRows(actionResult)) {
      const action = String(row.action);
      const current = actionCounts.get(action) ?? Object.fromEntries(
        stateNames.map((state) => [state, 0]),
      ) as Record<ExternalMutationState, number>;
      for (const state of stateNames) current[state] += numberField(row, state);
      actionCounts.set(action, current);
    }
    trimLexicographicMap(actionCounts, EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT + 1);

    const sampleResult = await db.run(sql`
      ${externalMutationClassificationSql(page, nowSeconds)}
      SELECT
        operation_id,
        project_id,
        action,
        resource_type,
        resource_id,
        state,
        intent_at_ms,
        terminal_at_ms,
        active_until
      FROM classified
      ORDER BY intent_at_ms DESC, operation_id
      LIMIT ${EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT + 1}
    `);
    operationCandidates = [
      ...operationCandidates,
      ...resultRows(sampleResult).map(externalOperationFromRow),
    ].sort(compareExternalOperations).slice(0, EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT + 1);
  }

  const boundedActionCounts = [...actionCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    as_of: nowSeconds,
    active_window_seconds: EXTERNAL_MUTATION_ACTIVE_WINDOW_SECONDS,
    total_operations: totalOperations,
    counts,
    counts_by_action: boundedActionCounts
      .slice(0, EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT)
      .map(([action, actionStates]) => ({
        action,
        total: Object.values(actionStates).reduce((sum, count) => sum + count, 0),
        ...actionStates,
      })),
    counts_by_action_limit: EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT,
    counts_by_action_truncated:
      boundedActionCounts.length > EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT,
    operations: operationCandidates.slice(0, EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT),
    operations_truncated: totalOperations > EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT,
    active_until: activeUntil,
    retry_after_seconds: activeUntil === null ? null : Math.max(1, activeUntil - nowSeconds),
    audit_handoff: {
      endpoint: "/v1/audit/recent?project_id=:project_id&include_attempts=true",
      available_until_account_deletion: true,
      note:
        "Inspect the full immutable operation timelines before account deletion removes owner authority. The terminal deletion receipt keeps bounded counts and a deterministic most-recent sample only.",
    },
  };
}

function externalMutationClassificationSql(projectIds: string[], nowSeconds: number) {
  const projectIdList = sql.join(projectIds.map((projectId) => sql`${projectId}`), sql`, `);
  return sql`
    WITH external_intents AS (
      SELECT
        intent.operation_id,
        intent.project_id,
        intent.action,
        intent.resource_type,
        intent.resource_id,
        intent.occurred_at_ms AS intent_at_ms,
        CASE
          WHEN json_type(
            CASE WHEN json_valid(intent.metadata_json) THEN intent.metadata_json ELSE '{}' END,
            '$."$agentry_external_mutation".retained_resource_on_success'
          ) = 'false' THEN 0
          ELSE 1
        END AS retains_resource
      FROM audit_log AS intent
      WHERE intent.project_id IN (${projectIdList})
        AND intent.phase = 'intent'
        AND json_type(
          CASE WHEN json_valid(intent.metadata_json) THEN intent.metadata_json ELSE '{}' END,
          '$."$agentry_external_mutation"'
        ) = 'object'
    ), timelines AS (
      SELECT
        intent.operation_id,
        intent.project_id,
        intent.action,
        intent.resource_type,
        intent.resource_id AS intent_resource_id,
        intent.intent_at_ms,
        intent.retains_resource,
        count(terminal.id) AS terminal_count,
        max(terminal.phase) AS terminal_phase,
        max(terminal.resource_id) AS terminal_resource_id,
        max(terminal.occurred_at_ms) AS terminal_at_ms
      FROM external_intents AS intent
      LEFT JOIN audit_log AS terminal
        ON terminal.operation_id = intent.operation_id
       AND terminal.phase <> 'intent'
      GROUP BY
        intent.operation_id,
        intent.project_id,
        intent.action,
        intent.resource_type,
        intent.resource_id,
        intent.intent_at_ms,
        intent.retains_resource
    ), classified AS (
      SELECT
        operation_id,
        project_id,
        action,
        resource_type,
        CASE
          WHEN terminal_count = 1 THEN coalesce(terminal_resource_id, intent_resource_id)
          ELSE intent_resource_id
        END AS resource_id,
        CASE
          WHEN terminal_count > 1 THEN 'external_state_unknown'
          WHEN terminal_count = 0
            AND ((intent_at_ms + 999) / 1000) + ${EXTERNAL_MUTATION_ACTIVE_WINDOW_SECONDS} > ${nowSeconds}
            THEN 'active'
          WHEN terminal_count = 0 THEN 'external_state_unknown'
          WHEN terminal_phase = 'failed' THEN 'failed_without_provider_effect'
          WHEN terminal_phase = 'indeterminate' THEN 'external_state_unknown'
          WHEN retains_resource = 0 THEN 'completed_without_retained_resource'
          ELSE 'retained_external_state'
        END AS state,
        intent_at_ms,
        CASE WHEN terminal_count = 1 THEN terminal_at_ms ELSE NULL END AS terminal_at_ms,
        CASE
          WHEN terminal_count = 0
            AND ((intent_at_ms + 999) / 1000) + ${EXTERNAL_MUTATION_ACTIVE_WINDOW_SECONDS} > ${nowSeconds}
            THEN ((intent_at_ms + 999) / 1000) + ${EXTERNAL_MUTATION_ACTIVE_WINDOW_SECONDS}
          ELSE NULL
        END AS active_until
      FROM timelines
    )
  `;
}

function externalOperationFromRow(row: Record<string, unknown>): ExternalMutationOperation {
  return {
    operation_id: String(row.operation_id),
    project_id: String(row.project_id),
    action: String(row.action),
    resource_type: String(row.resource_type),
    resource_id: row.resource_id === null || row.resource_id === undefined
      ? null
      : String(row.resource_id),
    state: String(row.state) as ExternalMutationState,
    intent_at_ms: numberField(row, "intent_at_ms"),
    terminal_at_ms: nullableNumberField(row, "terminal_at_ms"),
    active_until: nullableNumberField(row, "active_until"),
  };
}

function compareExternalOperations(
  left: ExternalMutationOperation,
  right: ExternalMutationOperation,
): number {
  return right.intent_at_ms - left.intent_at_ms ||
    left.operation_id.localeCompare(right.operation_id);
}

function trimLexicographicMap<T>(values: Map<string, T>, limit: number): void {
  const retained = new Set([...values.keys()].sort().slice(0, limit));
  for (const key of values.keys()) if (!retained.has(key)) values.delete(key);
}

function resultRows(result: { rows: Iterable<Record<string, unknown>> }): Record<string, unknown>[] {
  return Array.from(result.rows);
}

function numberField(row: Record<string, unknown>, field: string): number {
  return Number(row[field] ?? 0);
}

function nullableNumberField(row: Record<string, unknown>, field: string): number | null {
  const value = row[field];
  return value === null || value === undefined ? null : Number(value);
}
