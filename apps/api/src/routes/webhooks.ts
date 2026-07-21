import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  TELEMETRY_DATA_BOUNDARY,
  containsUnsafeTelemetryControls,
  errors,
  mergeTelemetryInspections,
  prepareTelemetryObservation,
  sha256Hex,
  uuidv7,
} from "@agentrysh/shared";
import {
  auditLog,
  mutationCommands,
  projectDeletionFences,
  projects,
  webhookDeliveries,
  webhooks,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess, requireProjectOwner, waitUntilOf } from "../middleware.js";
import {
  SERVER_EVENTS,
  assertWebhookOutboxPersisted,
  dispatchPersistedWebhookDeliveries,
  mintSigningSecret,
  prepareWebhook,
  prepareWebhookOutbox,
  recoverWebhookSigningSecret,
  replayWebhookDelivery,
} from "../webhooks.js";
import { assertProjectExternalWritesOpen } from "../external-mutation-boundary.js";
import type { AppBindings } from "../env.js";
import { prepareAuditEvent } from "../audit.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";
import { readBoundedJson } from "../bounded-json.js";

const router = new Hono<AppBindings>();

router.use("/v1/projects/:project_id/webhooks/*", requireApiKey());
router.use("/v1/projects/:project_id/webhooks", requireApiKey());
router.use("/v1/projects/:project_id/webhook-deliveries/*", requireApiKey());
router.use("/v1/projects/:project_id/webhook-deliveries", requireApiKey());

// Register a webhook
router.post("/v1/projects/:project_id/webhooks", async (c) => {
  if (!c.env.AGENTRY_TOKEN_ENC_KEY) {
    throw errors.configurationMissing(
      "token_encryption_key_missing",
      "Webhooks require AGENTRY_TOKEN_ENC_KEY to encrypt signing secrets at rest. " +
        "Set this via `wrangler secret put AGENTRY_TOKEN_ENC_KEY` (32-byte base64url AES-256 key).",
      "Set AGENTRY_TOKEN_ENC_KEY to a 32-byte base64url AES-256 key with `wrangler secret put AGENTRY_TOKEN_ENC_KEY`, redeploy Agentry, then retry webhook registration.",
    );
  }
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  await assertProjectExternalWritesOpen(c.env, projectId);

  const body = await readBoundedJson(c, 16_384);
  const b = body as Record<string, unknown> | null;
  const rawUrl = typeof b?.url === "string" ? b.url : null;
  const url = validateWebhookUrl(rawUrl);
  // Free-form: any non-empty string is a valid subscription. Wildcards "*" and
  // "prefix.*" are supported. Server-emitted names (case.*, deploy.recorded,
  // alert.*) are listed in SERVER_EVENTS for discovery; analytics event names
  // are whatever the customer emits.
  const eventsRaw = Array.isArray(b?.events) ? (b.events as unknown[]) : [];
  const filtered: string[] = [];
  for (const e of eventsRaw) {
    if (typeof e !== "string") continue;
    const trimmed = e.trim();
    if (trimmed.length > 200) {
      throw errors.invalidPayload({ reason: "webhook event names cannot exceed 200 characters" });
    }
    if (trimmed !== e || containsUnsafeTelemetryControls(trimmed)) {
      throw errors.invalidPayload({
        reason: "webhook event names cannot contain surrounding whitespace, controls, or bidirectional formatting characters",
      });
    }
    if (trimmed.length > 0) filtered.push(trimmed);
  }
  if (filtered.length === 0) {
    throw errors.invalidPayload({
      reason:
        "events must be a non-empty array of strings. " +
        `Server-emitted names: ${SERVER_EVENTS.join(", ")}. ` +
        "Analytics event names are also subscribable (signup_completed, purchase, etc.). " +
        "Wildcards: \"*\" matches all events, \"case.*\" matches the case namespace.",
    });
  }
  const events = Array.from(new Set(filtered)).sort();
  const description = typeof b?.description === "string" ? b.description.slice(0, 500) : null;
  const identity = await mutationIdentity(c, {
    action: "webhook.create",
    projectId,
    request: { url, events, description },
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) return replayWebhookCreate(c, existing);

  const id = uuidv7();
  const secret = await mintSigningSecret();
  const createdAt = Math.floor(Date.now() / 1_000);
  const webhookValues = await prepareWebhook(c.env, {
    id,
    projectId,
    url,
    description,
    events,
    secret,
    createdAt,
  });
  const durableResponse = {
    id,
    url,
    events,
    description,
    signing_secret_prefix: secret.prefix,
    next_action:
      "Store this signing_secret. Your endpoint must verify webhook-id, webhook-timestamp, and webhook-signature over '<webhook-id>.<webhook-timestamp>.<raw-body>' with HMAC-SHA256. Exact retries with this Idempotency-Key recover the same encrypted signing secret. Test with POST /v1/projects/:project_id/webhooks/:id/test and its own stable Idempotency-Key.",
  };
  const commandValues = mutationCommandValues(identity, {
    resourceType: "webhook",
    resourceId: id,
    response: durableResponse,
    createdAt,
  });
  const audit = await prepareAuditEvent(c, {
    userId: c.get("user").id,
    projectId,
    action: "webhook.created",
    resourceType: "webhook",
    resourceId: id,
    summary: `Registered webhook ${url}`,
    metadata: { command_id: identity.id, events },
  });
  const db = getDb(c.env);
  const webhookWrite = db.insert(webhooks).select(
    db.select({
      id: sql<string>`${String(webhookValues.id)}`.as("id"),
      projectId: sql<string>`${String(webhookValues.projectId)}`.as("project_id"),
      url: sql<string>`${String(webhookValues.url)}`.as("url"),
      description: sql<string | null>`${webhookValues.description ?? null}`.as("description"),
      events: sql<string>`${String(webhookValues.events)}`.as("events"),
      signingSecretPrefix: sql<string>`${String(webhookValues.signingSecretPrefix)}`.as("signing_secret_prefix"),
      signingSecretHash: sql<string>`${String(webhookValues.signingSecretHash)}`.as("signing_secret_hash"),
      signingSecretEnc: sql<string | null>`${webhookValues.signingSecretEnc ?? null}`.as("signing_secret_enc"),
      signingSecretIv: sql<string | null>`${webhookValues.signingSecretIv ?? null}`.as("signing_secret_iv"),
      active: sql<number>`${Number(webhookValues.active ?? 1)}`.as("active"),
      createdAt: sql<number>`${Number(webhookValues.createdAt ?? createdAt)}`.as("created_at"),
      lastFiredAt: sql<null>`NULL`.as("last_fired_at"),
      lastStatus: sql<null>`NULL`.as("last_status"),
      lastError: sql<null>`NULL`.as("last_error"),
    })
      .from(projects)
      .where(and(
        eq(projects.id, projectId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${projectDeletionFences}
          WHERE ${projectDeletionFences.projectId} = ${projectId}
        )`,
      )),
  );
  const guardedCommandValues = {
    ...commandValues,
    action: sql<string>`CASE WHEN EXISTS (
      SELECT 1 FROM ${webhooks} WHERE ${webhooks.id} = ${id}
    ) THEN ${commandValues.action} ELSE NULL END`,
  };
  try {
    await db.batch([
      webhookWrite,
      db.insert(mutationCommands).values(guardedCommandValues),
      db.insert(auditLog).values(audit.values),
    ] as const);
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner) return replayWebhookCreate(c, winner);
    await assertProjectExternalWritesOpen(c.env, projectId);
    throw error;
  }

  return c.json({
    ...durableResponse,
    signing_secret: secret.raw,
    idempotent_replay: false,
  });
});

router.get("/v1/projects/:project_id/webhooks", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const db = getDb(c.env);
  const includeInactive = c.req.query("include_inactive") === "true";
  const rows = await db.select().from(webhooks).where(and(
    eq(webhooks.projectId, projectId),
    includeInactive ? undefined : eq(webhooks.active, 1),
  ));
  const deliveryHealth = await db.all<{
    webhook_id: string | null;
    pending: number | string;
    failed: number | string;
    dead_letter: number | string;
  }>(sql`
    SELECT
      webhook_id,
      sum(CASE WHEN status IN ('pending', 'retrying', 'delivering') THEN 1 ELSE 0 END) AS pending,
      sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      sum(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter
    FROM ${webhookDeliveries}
    WHERE ${webhookDeliveries.projectId} = ${projectId}
    GROUP BY webhook_id
  `);
  const healthByWebhook = new Map(deliveryHealth.map((row) => [row.webhook_id, row]));
  const serializedWebhooks = rows.map((w) => {
    const errorObservation = prepareTelemetryObservation(w.lastError);
    return {
      id: w.id,
      url: w.url,
      description: w.description,
      events: safeJsonArray<string>(w.events),
      signing_secret_prefix: w.signingSecretPrefix,
      active: w.active === 1,
      created_at: w.createdAt,
      last_fired_at: w.lastFiredAt,
      last_status: w.lastStatus,
      last_error: errorObservation.content,
      last_error_inspection: errorObservation.inspection,
      delivery_health: {
        pending: Number(healthByWebhook.get(w.id)?.pending ?? 0),
        failed: Number(healthByWebhook.get(w.id)?.failed ?? 0),
        dead_letter: Number(healthByWebhook.get(w.id)?.dead_letter ?? 0),
      },
    };
  });
  return c.json({
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      classification: "external_response",
      applies_to: "webhooks[].last_error",
      inspection: mergeTelemetryInspections(
        serializedWebhooks.map((webhook) => webhook.last_error_inspection),
      ),
    },
    webhooks: serializedWebhooks,
    next_action:
      "If dead_letter is non-zero, inspect GET /v1/projects/:project_id/webhook-deliveries?status=dead_letter, " +
      "fix the receiver, then replay the failed delivery. Pending deliveries retry automatically.",
  });
});

router.get("/v1/projects/:project_id/webhook-deliveries", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const status = c.req.query("status");
  const allowedStatuses = [
    "pending",
    "delivering",
    "retrying",
    "succeeded",
    "failed",
    "dead_letter",
    "cancelled",
  ] as const;
  if (status && !allowedStatuses.includes(status as typeof allowedStatuses[number])) {
    throw errors.invalidPayload({ reason: `unknown delivery status: ${status}`, allowed: allowedStatuses });
  }
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
  const webhookId = c.req.query("webhook_id");
  const conditions = [eq(webhookDeliveries.projectId, projectId)];
  if (status) conditions.push(eq(webhookDeliveries.status, status as typeof allowedStatuses[number]));
  if (webhookId) conditions.push(eq(webhookDeliveries.webhookId, webhookId));
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...conditions))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
  const serializedDeliveries = rows.map(serializeDelivery);
  return c.json({
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      classification: "external_response",
      applies_to: "deliveries[].last_error",
      inspection: mergeTelemetryInspections(
        serializedDeliveries.map((delivery) => delivery.last_error_inspection),
      ),
    },
    deliveries: serializedDeliveries,
    next_action:
      rows.some((row) => row.status === "dead_letter")
        ? "Fix the receiver, then POST /v1/projects/:project_id/webhook-deliveries/:delivery_id/replay. The delivery keeps its id so receiver idempotency remains valid."
        : "No dead-letter action is required. Pending and retrying deliveries are processed automatically.",
  });
});

router.delete("/v1/projects/:project_id/webhooks/:id", async (c) => {
  const projectId = c.req.param("project_id");
  const id = c.req.param("id");
  await requireProjectOwner(c, projectId);
  const db = getDb(c.env);
  const before = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  if (!before[0] || before[0].projectId !== projectId) throw errors.notFound("webhook");
  if (before[0].active !== 1) {
    return c.json({ ok: true, id, idempotent_replay: true, next_action: "Webhook is already disabled; historical deliveries remain queryable." });
  }
  const now = Math.floor(Date.now() / 1000);
  const cancelDeliveries = db
    .update(webhookDeliveries)
    .set({ status: "cancelled", lockedAt: null, lockedBy: null, updatedAt: now })
    .where(
      and(
        eq(webhookDeliveries.webhookId, id),
        inArray(webhookDeliveries.status, ["pending", "delivering", "retrying", "failed"]),
      ),
    );
  const disableWebhook = db
    .update(webhooks)
    .set({ active: 0, lastError: "disabled_by_owner" })
    .where(and(eq(webhooks.id, id), eq(webhooks.active, 1)))
    .returning({ id: webhooks.id });
  const [, disabled] = await db.batch([cancelDeliveries, disableWebhook] as const);
  if (disabled.length !== 1) {
    throw errors.conflict(
      "webhook_disable_conflict",
      "The webhook changed while it was being disabled.",
      "Re-read active and historical webhooks with include_inactive=true before retrying.",
      { webhook_id: id },
    );
  }
  return c.json({
    ok: true,
    id,
    idempotent_replay: false,
    next_action: "Webhook disabled. No new deliveries will be created; historical deliveries remain queryable with include_inactive=true.",
  });
});

router.post("/v1/projects/:project_id/webhooks/:id/test", async (c) => {
  const projectId = c.req.param("project_id");
  const id = c.req.param("id");
  await requireProjectOwner(c, projectId);
  await assertProjectExternalWritesOpen(c.env, projectId);
  const identity = await mutationIdentity(c, {
    action: "webhook.test",
    projectId,
    request: { webhook_id: id, event: "case.created" },
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing?.status === "succeeded") {
    return c.json({
      ...mutationResponse<Record<string, unknown>>(existing),
      idempotent_replay: true,
    });
  }
  const hook = (
    await getDb(c.env)
      .select({ active: webhooks.active })
      .from(webhooks)
      .where(and(eq(webhooks.id, id), eq(webhooks.projectId, projectId)))
      .limit(1)
  )[0];
  if (!hook) throw errors.notFound("webhook");
  if (hook.active !== 1) {
    throw errors.conflict(
      "webhook_disabled",
      "A disabled webhook cannot be tested or receive new deliveries.",
      "Create a new active webhook subscription if this destination should receive events again.",
      { webhook_id: id },
    );
  }
  // The source event is bound to the complete request, not only the reusable
  // Idempotency-Key. The command intent is persisted before reserving a
  // recipient set so a crash or concurrent different-target request cannot
  // make one command deliver another command's webhook test.
  const sourceEventId = `webhook-test:${identity.requestHash}`;
  const db = getDb(c.env);
  const createdAt = Math.floor(Date.now() / 1_000);
  const intentValues = mutationCommandValues(identity, {
    resourceType: "webhook_delivery",
    resourceId: sourceEventId,
    response: {},
    createdAt,
  });
  await db
    .insert(mutationCommands)
    .values({
      ...intentValues,
      status: "intent",
      createdAt: sql<number>`unixepoch()`,
      updatedAt: sql<number>`unixepoch()`,
    })
    .onConflictDoNothing();

  const leaseToken = uuidv7();
  const leased = await db
    .update(mutationCommands)
    .set({
      status: "in_progress",
      leaseToken,
      leaseExpiresAt: sql<number>`unixepoch() + 60`,
      attemptCount: sql`${mutationCommands.attemptCount} + 1`,
      version: sql`${mutationCommands.version} + 1`,
      updatedAt: sql<number>`unixepoch()`,
    })
    .where(and(
      eq(mutationCommands.id, identity.id),
      eq(mutationCommands.requestHash, identity.requestHash),
      or(
        eq(mutationCommands.status, "intent"),
        and(
          inArray(mutationCommands.status, ["in_progress", "failed", "indeterminate"]),
          or(
            isNull(mutationCommands.leaseExpiresAt),
            lte(mutationCommands.leaseExpiresAt, sql<number>`unixepoch()`),
          ),
        ),
      ),
    ))
    .returning({ id: mutationCommands.id });
  if (leased.length !== 1) {
    const winner = await loadMutationCommand(c, identity);
    if (winner?.status === "succeeded") {
      return c.json({
        ...mutationResponse<Record<string, unknown>>(winner),
        idempotent_replay: true,
      });
    }
    throw errors.conflict(
      "mutation_in_progress",
      "This exact webhook test command is already in progress.",
      "Retry the exact request with the same Idempotency-Key after the current 60-second lease expires or completes. Do not change the webhook id.",
      { command_id: identity.id, lease_expires_at: winner?.leaseExpiresAt ?? null },
    );
  }
  const outbox = await prepareWebhookOutbox(
    c.env,
    projectId,
    "case.created",
    {
      synthetic: true,
      message: "This is a synthetic test event from POST /webhooks/:id/test.",
    },
    {
      sourceEventId,
      webhookId: id,
    },
  );
  const durableResponse = {
    ok: true,
    delivery_ids: outbox.deliveryIds,
    source_event_id: sourceEventId,
    next_action:
      "Test delivery was durably enqueued. Read the same delivery ids from GET /v1/projects/:project_id/webhook-deliveries; a 2xx receiver succeeds and failures retry automatically.",
  };
  const completedValues = mutationCommandValues(identity, {
    resourceType: "webhook_delivery",
    resourceId: sourceEventId,
    response: durableResponse,
    createdAt,
  });
  const audit = await prepareAuditEvent(c, {
    userId: c.get("user").id,
    projectId,
    action: "webhook.test_enqueued",
    resourceType: "webhook_delivery",
    resourceId: sourceEventId,
    summary: "Enqueued one synthetic webhook test",
    metadata: {
      command_id: identity.id,
      webhook_id: id,
      delivery_ids: outbox.deliveryIds,
    },
  });
  try {
    const delivery = outbox.deliveries[0];
    if (!delivery || outbox.deliveries.length !== 1) {
      throw errors.persistenceFailed(
        "A targeted webhook test did not resolve to exactly one durable recipient.",
        "Stop and reconcile the reserved recipient set; never reinterpret it against current subscriptions.",
        { command_id: identity.id, delivery_count: outbox.deliveries.length },
      );
    }
    const commandWrite = db
      .update(mutationCommands)
      .set({
        resourceType: completedValues.resourceType,
        resourceId: completedValues.resourceId,
        responseJson: completedValues.responseJson,
        status: "succeeded",
        leaseToken: null,
        leaseExpiresAt: null,
        errorJson: null,
        version: sql`${mutationCommands.version} + 1`,
        updatedAt: sql<number>`unixepoch()`,
      })
      .where(and(
        eq(mutationCommands.id, identity.id),
        eq(mutationCommands.requestHash, identity.requestHash),
        eq(mutationCommands.status, "in_progress"),
        eq(mutationCommands.leaseToken, leaseToken),
      ))
      .returning({ id: mutationCommands.id });
    // `changes()` observes the immediately preceding command CAS in this
    // atomic batch. A lost lease produces NULL for a NOT NULL delivery field,
    // aborting the entire command + outbox + audit commit.
    const deliveryWrite = db.insert(webhookDeliveries).select(
      db.select({
        id: sql<string>`CASE WHEN changes() = 1 AND NOT EXISTS (
          SELECT 1 FROM ${projectDeletionFences}
          WHERE ${projectDeletionFences.projectId} = ${projectId}
        ) THEN ${delivery.id} ELSE NULL END`.as("id"),
        projectId: sql<string>`CASE WHEN changes() = 1 THEN ${delivery.projectId} ELSE NULL END`.as("project_id"),
        webhookId: sql<string | null>`${delivery.webhookId ?? null}`.as("webhook_id"),
        sourceEventId: sql<string>`${delivery.sourceEventId}`.as("source_event_id"),
        sourceEventHash: sql<string>`${delivery.sourceEventHash}`.as("source_event_hash"),
        event: sql<string>`${delivery.event}`.as("event"),
        payloadJson: sql<string>`${delivery.payloadJson}`.as("payload_json"),
        status: sql<typeof delivery.status>`${delivery.status}`.as("status"),
        attemptCount: sql<number>`${delivery.attemptCount ?? 0}`.as("attempt_count"),
        maxAttempts: sql<number>`${delivery.maxAttempts ?? 8}`.as("max_attempts"),
        nextAttemptAt: sql<number>`${delivery.nextAttemptAt ?? createdAt}`.as("next_attempt_at"),
        lockedAt: sql<null>`NULL`.as("locked_at"),
        lockedBy: sql<null>`NULL`.as("locked_by"),
        lastAttemptAt: sql<null>`NULL`.as("last_attempt_at"),
        deliveredAt: sql<null>`NULL`.as("delivered_at"),
        lastStatusCode: sql<null>`NULL`.as("last_status_code"),
        lastError: sql<null>`NULL`.as("last_error"),
        createdAt: sql<number>`${delivery.createdAt ?? createdAt}`.as("created_at"),
        updatedAt: sql<number>`${delivery.updatedAt ?? createdAt}`.as("updated_at"),
      }).from(mutationCommands).where(eq(mutationCommands.id, identity.id)),
    ).returning({ id: webhookDeliveries.id });
    const [completed, inserted] = await db.batch([
      commandWrite,
      deliveryWrite,
      db.insert(auditLog).values(audit.values),
    ] as const);
    if (completed.length !== 1 || inserted.length !== 1) {
      throw errors.persistenceFailed(
        "The webhook test command did not commit one exact command and delivery.",
        "Retry the exact request with the same Idempotency-Key; never dispatch an incomplete outbox.",
        { command_id: identity.id },
      );
    }
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner?.status === "succeeded") {
      return c.json({
        ...mutationResponse<Record<string, unknown>>(winner),
        idempotent_replay: true,
      });
    }
    await assertProjectExternalWritesOpen(c.env, projectId);
    throw error;
  }
  await assertWebhookOutboxPersisted(c.env, outbox);
  await dispatchPersistedWebhookDeliveries(
    c.env,
    outbox.deliveryIds,
    waitUntilOf(c),
  );
  return c.json({
    ...durableResponse,
    idempotent_replay: false,
  });
});

router.post("/v1/projects/:project_id/webhook-deliveries/:delivery_id/replay", async (c) => {
  const projectId = c.req.param("project_id");
  const deliveryId = c.req.param("delivery_id");
  await requireProjectOwner(c, projectId);
  const result = await replayWebhookDelivery(c.env, projectId, deliveryId);
  if (!result) throw errors.notFound("webhook_delivery");
  if (!result.replayed) {
    throw errors.invalidPayload({
      reason: "a succeeded delivery cannot be replayed; receiver idempotency already considers it complete",
      delivery_id: deliveryId,
    });
  }
  return c.json({
    delivery_id: deliveryId,
    replayed: true,
    result: result.result,
    next_action:
      result.result === "delivered"
        ? "Replay succeeded. No further action is required."
        : "Replay did not succeed; inspect the delivery error. Automatic retries remain bounded by max_attempts.",
  });
});

async function replayWebhookCreate(
  c: Parameters<typeof loadMutationCommand>[0],
  command: typeof mutationCommands.$inferSelect,
) {
  const response = mutationResponse<Record<string, unknown> & { id: string }>(command);
  if (
    command.action !== "webhook.create" ||
    command.resourceType !== "webhook" ||
    !command.projectId ||
    typeof response.id !== "string" ||
    command.resourceId !== response.id
  ) {
    throw webhookCreateReplayIntegrityFailure(command, response.id, "command_resource_binding");
  }
  const hook = (
    await getDb(c.env)
      .select()
      .from(webhooks)
      .where(and(
        eq(webhooks.id, response.id),
        eq(webhooks.projectId, command.projectId),
      ))
      .limit(1)
  )[0];
  if (!hook) {
    throw webhookCreateReplayIntegrityFailure(command, response.id, "webhook_project_binding");
  }
  const signingSecret = await recoverWebhookSigningSecret(c.env, hook);
  if (!signingSecret) {
    throw webhookCreateReplayIntegrityFailure(command, hook.id, "signing_secret_ciphertext");
  }
  const responsePrefix = response.signing_secret_prefix;
  const recoveredHash = await sha256Hex(signingSecret);
  if (
    recoveredHash !== hook.signingSecretHash ||
    signingSecret.slice(0, 12) !== hook.signingSecretPrefix ||
    typeof responsePrefix !== "string" ||
    responsePrefix !== hook.signingSecretPrefix
  ) {
    throw webhookCreateReplayIntegrityFailure(command, hook.id, "signing_secret_binding");
  }
  return c.json({
    ...response,
    signing_secret: signingSecret,
    active: hook.active === 1,
    idempotent_replay: true,
  });
}

function webhookCreateReplayIntegrityFailure(
  command: typeof mutationCommands.$inferSelect,
  webhookId: unknown,
  integrityCheck: string,
) {
  return errors.persistenceFailed(
    "The webhook creation receipt failed signing-secret integrity verification.",
    "Stop and inspect the command and webhook stores. Do not use recovered secret material or create a duplicate webhook with a new Idempotency-Key.",
    {
      command_id: command.id,
      webhook_id: typeof webhookId === "string" ? webhookId : null,
      integrity_check: integrityCheck,
    },
  );
}

function safeJsonArray<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function validateWebhookUrl(raw: string | null): string {
  if (!raw) throw errors.invalidPayload({ reason: "url is required" });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw errors.invalidPayload({ reason: "url must be a valid absolute HTTPS URL" });
  }
  if (parsed.protocol !== "https:") {
    throw errors.invalidPayload({ reason: "webhook destinations must use HTTPS" });
  }
  if (parsed.username || parsed.password) {
    throw errors.invalidPayload({ reason: "webhook URLs cannot contain credentials" });
  }
  const hostname = parsed.hostname.toLowerCase();
  const unsafeHostname =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
    hostname.includes(":");
  if (unsafeHostname) {
    throw errors.invalidPayload({
      reason: "webhook destinations must use a public DNS hostname; localhost, private/internal names, and IP literals are not allowed",
    });
  }
  parsed.hash = "";
  return parsed.toString();
}

function serializeDelivery(row: typeof webhookDeliveries.$inferSelect) {
  const errorObservation = prepareTelemetryObservation(row.lastError);
  return {
    id: row.id,
    webhook_id: row.webhookId,
    source_event_id: row.sourceEventId,
    source_event_hash: row.sourceEventHash,
    event: row.event,
    status: row.status,
    attempt_count: row.attemptCount,
    max_attempts: row.maxAttempts,
    next_attempt_at: row.nextAttemptAt,
    last_attempt_at: row.lastAttemptAt,
    delivered_at: row.deliveredAt,
    last_status_code: row.lastStatusCode,
    last_error: errorObservation.content,
    last_error_inspection: errorObservation.inspection,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export default router;
