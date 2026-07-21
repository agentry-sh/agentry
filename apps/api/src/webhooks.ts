// Durable outbound webhooks.
//
// The database outbox is the source of truth. fireWebhooks only matches
// subscriptions and persists one delivery row per subscriber; delivery is an
// immediate best-effort optimization plus a scheduled retry sweep.
//
// Signing follows the Standard Webhooks message shape:
//   signed content = `${webhook-id}.${webhook-timestamp}.${raw-body}`
//   webhook-signature = `v1,<base64 hmac-sha256>`
// A delivery id identifies one event delivery. It is never the subscription id.

import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  TELEMETRY_DATA_BOUNDARY,
  base64url,
  canonicalJsonStringify,
  errors,
  mergeTelemetryInspections,
  prepareTelemetryObservation,
  sha256Hex,
  uuidv7,
} from "@agentrysh/shared";
import {
  projectDeletionFences,
  projects,
  webhookDeliveries,
  webhookRecipientSets,
  webhooks,
  type Webhook,
  type WebhookDelivery,
} from "@agentry/db/schema";
import type { Env } from "./env.js";
import { getDb } from "./db.js";
import { decryptToken, encryptToken } from "./secret-encryption.js";
import {
  assertProjectExternalWritesOpen,
  MAX_WEBHOOK_DELIVERY_TIMEOUT_MS,
} from "./external-mutation-boundary.js";

export type WebhookEvent = string;

export const SERVER_EVENTS: readonly string[] = [
  "case.created",
  "case.active",
  "case.resolved",
  "case.suppressed",
  "case.reopened",
  "deploy.recorded",
  "alert.triggered",
  "alert.recovered",
] as const;

const DELIVERY_TIMEOUT_MS = MAX_WEBHOOK_DELIVERY_TIMEOUT_MS;
const DELIVERY_LOCK_SECONDS = 120;
const DEFAULT_MAX_ATTEMPTS = 8;
const WEBHOOK_ERROR_BODY_MAX_BYTES = 4_096;

export interface MintedSecret {
  raw: string;
  prefix: string;
  hash: string;
}

export async function mintSigningSecret(): Promise<MintedSecret> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const raw = `whsec_${base64url(bytes)}`;
  return { raw, prefix: raw.slice(0, 12), hash: await sha256Hex(raw) };
}

function decodeSigningSecret(secret: string): Uint8Array {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - encoded.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function signWebhookPayload(
  deliveryId: string,
  timestamp: number,
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSigningSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const content = `${deliveryId}.${timestamp}.${body}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(content));
  return bytesToBase64(new Uint8Array(signature));
}

export async function persistWebhook(
  env: Env,
  input: {
    id: string;
    projectId: string;
    url: string;
    description: string | null;
    events: WebhookEvent[];
    secret: MintedSecret;
  },
): Promise<void> {
  const values = await prepareWebhook(env, input);
  await getDb(env).insert(webhooks).values(values);
}

export async function prepareWebhook(
  env: Env,
  input: {
    id: string;
    projectId: string;
    url: string;
    description: string | null;
    events: WebhookEvent[];
    secret: MintedSecret;
    createdAt?: number;
  },
): Promise<typeof webhooks.$inferInsert> {
  const enc = await encryptToken(env, input.secret.raw);
  return {
    id: input.id,
    projectId: input.projectId,
    url: input.url,
    description: input.description,
    events: JSON.stringify(input.events),
    signingSecretPrefix: input.secret.prefix,
    signingSecretHash: input.secret.hash,
    signingSecretEnc: enc.enc,
    signingSecretIv: enc.iv,
    createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
    active: 1,
  };
}

export function matchesAny(subscriptions: string[], event: string): boolean {
  for (const subscription of subscriptions) {
    if (subscription === "*" || subscription === event) return true;
    if (subscription.endsWith(".*") && event.startsWith(subscription.slice(0, -1))) return true;
  }
  return false;
}

export async function recoverWebhookSigningSecret(env: Env, hookRow: Webhook): Promise<string | null> {
  if (!hookRow.signingSecretIv || !hookRow.signingSecretEnc) return null;
  try {
    return await decryptToken(env, hookRow.signingSecretEnc, hookRow.signingSecretIv);
  } catch {
    return null;
  }
}

function retryDelaySeconds(attempt: number): number {
  // 1m, 2m, 4m, 8m, 16m, 32m, 64m; capped at six hours.
  return Math.min(21_600, 60 * 2 ** Math.max(0, attempt - 1));
}

async function recordDeliveryFailure(
  env: Env,
  delivery: WebhookDelivery,
  attempt: number,
  statusCode: number,
  errorMessage: string,
): Promise<boolean> {
  const db = getDb(env);
  const now = Math.floor(Date.now() / 1000);
  const terminal = attempt >= delivery.maxAttempts;
  // Receiver bodies and network errors are remote-controlled text. Persist
  // only a bounded display view so a failed webhook cannot poison the next
  // operator or agent that inspects delivery health.
  const errorObservation = prepareTelemetryObservation(errorMessage, {
    max_string_chars: 2_000,
  });
  const displayError = String(errorObservation.content);
  const completed = await db
    .update(webhookDeliveries)
    .set({
      status: terminal ? "dead_letter" : "retrying",
      attemptCount: attempt,
      nextAttemptAt: terminal ? now : now + retryDelaySeconds(attempt),
      lockedAt: null,
      lockedBy: null,
      lastAttemptAt: now,
      lastStatusCode: statusCode || null,
      lastError: displayError,
      updatedAt: now,
    })
    .where(deliveryLeaseGuard(delivery))
    .returning({ id: webhookDeliveries.id });
  // A newer worker reclaimed the expired lease while this HTTP request was in
  // flight. Its result is authoritative; the stale worker must not overwrite
  // state or report a misleading completion result.
  if (completed.length !== 1) return false;
  return true;
}

function deliveryLeaseGuard(delivery: WebhookDelivery) {
  return and(
    eq(webhookDeliveries.id, delivery.id),
    eq(webhookDeliveries.status, "delivering"),
    eq(webhookDeliveries.attemptCount, delivery.attemptCount),
    delivery.lockedBy === null
      ? isNull(webhookDeliveries.lockedBy)
      : eq(webhookDeliveries.lockedBy, delivery.lockedBy),
    delivery.lockedAt === null
      ? isNull(webhookDeliveries.lockedAt)
      : eq(webhookDeliveries.lockedAt, delivery.lockedAt),
  );
}

function activeSubscriptionForDelivery() {
  return sql`EXISTS (
    SELECT 1 FROM ${webhooks}
    WHERE ${webhooks.id} = ${webhookDeliveries.webhookId}
      AND ${webhooks.projectId} = ${webhookDeliveries.projectId}
      AND ${webhooks.active} = 1
  )`;
}

function projectOpenForDelivery() {
  return sql`EXISTS (
    SELECT 1 FROM ${projects}
    WHERE ${projects.id} = ${webhookDeliveries.projectId}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${projectDeletionFences}
    WHERE ${projectDeletionFences.projectId} = ${webhookDeliveries.projectId}
  )`;
}

function deliverySendAuthority() {
  return sql`${activeSubscriptionForDelivery()} AND ${projectOpenForDelivery()}`;
}

async function cancelInactiveDelivery(
  env: Env,
  deliveryId: string,
  delivery?: WebhookDelivery,
): Promise<boolean> {
  const db = getDb(env);
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .update(webhookDeliveries)
    .set({
      status: "cancelled",
      lockedAt: null,
      lockedBy: null,
      lastError: "webhook_disabled_before_send",
      updatedAt: now,
    })
    .where(delivery
      ? and(deliveryLeaseGuard(delivery), sql`NOT ${deliverySendAuthority()}`)
      : and(
          eq(webhookDeliveries.id, deliveryId),
          or(
            and(
              inArray(webhookDeliveries.status, ["pending", "retrying", "failed"]),
              sql`NOT ${deliverySendAuthority()}`,
            ),
            and(
              eq(webhookDeliveries.status, "delivering"),
              sql`NOT ${activeSubscriptionForDelivery()}`,
            ),
          ),
        ))
    .returning({ id: webhookDeliveries.id });
  return rows.length === 1;
}

async function acquireDelivery(
  env: Env,
  deliveryId: string,
  workerId: string,
): Promise<WebhookDelivery | null> {
  const db = getDb(env);
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .update(webhookDeliveries)
    .set({ status: "delivering", lockedAt: now, lockedBy: workerId, updatedAt: now })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        deliverySendAuthority(),
        or(
          and(
            inArray(webhookDeliveries.status, ["pending", "retrying", "failed"]),
            lte(webhookDeliveries.nextAttemptAt, now),
            or(isNull(webhookDeliveries.lockedAt), lt(webhookDeliveries.lockedAt, now - DELIVERY_LOCK_SECONDS)),
          ),
          and(
            eq(webhookDeliveries.status, "delivering"),
            lt(webhookDeliveries.lockedAt, now - DELIVERY_LOCK_SECONDS),
          ),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function processWebhookDelivery(
  env: Env,
  deliveryId: string,
  workerId = `worker_${uuidv7()}`,
): Promise<"delivered" | "retrying" | "dead_letter" | "skipped"> {
  const delivery = await acquireDelivery(env, deliveryId, workerId);
  if (!delivery) {
    await cancelInactiveDelivery(env, deliveryId);
    return "skipped";
  }

  const attempt = delivery.attemptCount + 1;
  const db = getDb(env);
  if (!isCanonicalWebhookPayload(delivery.payloadJson)) {
    const recorded = await recordDeliveryFailure(
      env,
      delivery,
      delivery.maxAttempts,
      0,
      "legacy webhook payload blocked: regenerate the event under schema_version 2",
    );
    return recorded ? "dead_letter" : "skipped";
  }
  const hook = delivery.webhookId
    ? (await db.select().from(webhooks).where(and(
        eq(webhooks.id, delivery.webhookId),
        eq(webhooks.projectId, delivery.projectId),
        eq(webhooks.active, 1),
      )).limit(1))[0]
    : undefined;
  if (!hook) {
    await cancelInactiveDelivery(env, deliveryId, delivery);
    return "skipped";
  }
  const secret = await recoverWebhookSigningSecret(env, hook);
  if (!secret) {
    const recorded = await recordDeliveryFailure(
      env,
      delivery,
      attempt,
      0,
      "signing secret is unavailable",
    );
    return recorded
      ? attempt >= delivery.maxAttempts ? "dead_letter" : "retrying"
      : "skipped";
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhookPayload(delivery.id, timestamp, delivery.payloadJson, secret);
  // Re-check both subscription activity and the exact delivery lease as the
  // final local linearization point before the irreversible network call. A
  // concurrent disable cancels delivering rows, so a worker that lost either
  // authority must not send.
  const sendAuthority = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(deliveryLeaseGuard(delivery), deliverySendAuthority()))
    .limit(1);
  if (sendAuthority.length !== 1) {
    await cancelInactiveDelivery(env, deliveryId, delivery);
    return "skipped";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  let statusCode = 0;
  let errorMessage: string | null = null;
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      // The configured URL is validated at registration. Following a redirect
      // would discard that validation, leak the signed body cross-origin, and
      // turn a public endpoint into an SSRF hop to a private destination.
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "agentry-webhook/1",
        "webhook-id": delivery.id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": `v1,${signature}`,
        "x-agentry-event": delivery.event,
        "x-agentry-subscription-id": hook.id,
      },
      body: delivery.payloadJson,
      signal: controller.signal,
    });
    statusCode = response.status;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      errorMessage = `redirect ${response.status} blocked`;
    } else if (!response.ok) {
      const responseText = await readBoundedWebhookErrorBody(response);
      errorMessage = `non-2xx ${response.status}: ${responseText.slice(0, 300)}`;
    } else {
      // Receiver bodies are never part of the delivery contract. Cancel while
      // the request deadline is still active so a 2xx with an endless or huge
      // body cannot leave an unbounded subrequest behind.
      await response.body?.cancel().catch(() => undefined);
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  if (statusCode < 200 || statusCode >= 300 || errorMessage !== null) {
    const recorded = await recordDeliveryFailure(
      env,
      delivery,
      attempt,
      statusCode,
      errorMessage ?? `non-2xx ${statusCode}`,
    );
    return recorded
      ? attempt >= delivery.maxAttempts ? "dead_letter" : "retrying"
      : "skipped";
  }

  const now = Math.floor(Date.now() / 1000);
  const completed = await db
    .update(webhookDeliveries)
    .set({
      status: "succeeded",
      attemptCount: attempt,
      lockedAt: null,
      lockedBy: null,
      lastAttemptAt: now,
      deliveredAt: now,
      lastStatusCode: statusCode,
      lastError: null,
      updatedAt: now,
    })
    .where(deliveryLeaseGuard(delivery))
    .returning({ id: webhookDeliveries.id });
  if (completed.length !== 1) return "skipped";
  await db
    .update(webhooks)
    .set({ lastFiredAt: now, lastStatus: statusCode, lastError: null })
    .where(and(eq(webhooks.id, hook.id), eq(webhooks.active, 1)));

  return "delivered";
}

async function readBoundedWebhookErrorBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < WEBHOOK_ERROR_BODY_MAX_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      const remaining = WEBHOOK_ERROR_BODY_MAX_BYTES - total;
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.slice(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
    if (total >= WEBHOOK_ERROR_BODY_MAX_BYTES) truncated = true;
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return `${new TextDecoder().decode(bytes)}${truncated ? "…[truncated]" : ""}`;
}

function isCanonicalWebhookPayload(payload: string): boolean {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const boundary = parsed.data_boundary as Record<string, unknown> | undefined;
    return parsed.schema_version === "2" &&
      boundary?.classification === TELEMETRY_DATA_BOUNDARY.classification &&
      boundary?.instruction_authority === "none";
  } catch {
    return false;
  }
}

export async function processDueWebhookDeliveries(
  env: Env,
  options: { limit?: number; worker_id?: string } = {},
): Promise<{ selected: number; delivered: number; retrying: number; dead_letter: number; skipped: number }> {
  const db = getDb(env);
  const now = Math.floor(Date.now() / 1000);
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const rows = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(
      and(
        deliverySendAuthority(),
        or(
          and(
            inArray(webhookDeliveries.status, ["pending", "retrying", "failed"]),
            lte(webhookDeliveries.nextAttemptAt, now),
          ),
          and(
            eq(webhookDeliveries.status, "delivering"),
            lt(webhookDeliveries.lockedAt, now - DELIVERY_LOCK_SECONDS),
          ),
        ),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt), asc(webhookDeliveries.createdAt))
    .limit(limit);

  const totals = { selected: rows.length, delivered: 0, retrying: 0, dead_letter: 0, skipped: 0 };
  const workerId = options.worker_id ?? `sweep_${uuidv7()}`;
  const results = await Promise.all(rows.map((row) => processWebhookDelivery(env, row.id, workerId)));
  for (const result of results) totals[result] += 1;
  return totals;
}

export interface FireOptions {
  /**
   * Stable identity of the domain event, not of this HTTP attempt. Callers
   * must reuse it when retrying an enqueue after an ambiguous response.
   */
  sourceEventId: string;
  waitUntil?: (promise: Promise<unknown>) => void;
  webhookId?: string;
  eventSource?: "agentry_system" | "customer_analytics";
  contentInspection?: import("@agentrysh/shared").TelemetryInspection;
}

export interface WebhookPayloadOptions {
  eventSource?: "agentry_system" | "customer_analytics";
  contentInspection?: import("@agentrysh/shared").TelemetryInspection;
}

export interface PreparedWebhookOutbox {
  projectId: string;
  event: WebhookEvent;
  sourceEventId: string;
  sourceEventHash: string;
  recipientSetId: string;
  recipientWebhookIds: string[];
  deliveryIds: string[];
  deliveries: Array<typeof webhookDeliveries.$inferInsert>;
}

function canonicalWebhookPayloadCore(
  projectId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  options: WebhookPayloadOptions,
) {
  const observation = prepareTelemetryObservation(data);
  const deliveryInspection = mergeTelemetryInspections([
    observation.inspection,
    ...(options.contentInspection ? [options.contentInspection] : []),
  ]);
  return {
    event,
    event_source: options.eventSource ?? "agentry_system",
    project_id: projectId,
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      applies_to: "data",
      delivery_signature_authenticates_transport_not_data_authority: true,
    },
    data: observation.content,
    data_inspection: deliveryInspection,
  };
}

/** Canonical request hash bound to one durable source_event_id. */
export async function webhookSourceEventHash(
  projectId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  options: WebhookPayloadOptions = {},
): Promise<string> {
  return sha256Hex(canonicalJsonStringify(
    canonicalWebhookPayloadCore(projectId, event, data, options),
  ));
}

/**
 * Build the canonical, authority-free payload persisted in the webhook outbox.
 * Callers that commit domain state and an outbox row in one database batch use
 * this helper so their atomic path has the same wire contract as fireWebhooks.
 */
export function buildWebhookDeliveryPayload(
  deliveryId: string,
  sourceEventId: string,
  projectId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  createdAt: number,
  options: WebhookPayloadOptions = {},
): string {
  return canonicalJsonStringify({
    schema_version: "2",
    id: deliveryId,
    source_event_id: sourceEventId,
    created_at: createdAt,
    ...canonicalWebhookPayloadCore(projectId, event, data, options),
  });
}

/**
 * Resolve the exact subscriber set and build deterministic delivery rows.
 * No delivery is inserted here, allowing callers such as alert evaluation to
 * batch the domain-state CAS and the outbox writes in one transaction.
 */
export async function prepareWebhookOutbox(
  env: Env,
  projectId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  options: FireOptions,
): Promise<PreparedWebhookOutbox> {
  assertSourceEventId(options.sourceEventId);
  await assertProjectExternalWritesOpen(env, projectId);
  const db = getDb(env);
  const sourceEventHash = await webhookSourceEventHash(projectId, event, data, options);

  const existingDeliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(and(
      eq(webhookDeliveries.projectId, projectId),
      eq(webhookDeliveries.sourceEventId, options.sourceEventId),
    ));
  if (existingDeliveries.some((row) => row.sourceEventHash !== sourceEventHash)) {
    throwSourceEventReuse(options.sourceEventId, event);
  }

  const recipientSetDigest = await sha256Hex(canonicalJsonStringify({
    project_id: projectId,
    source_event_id: options.sourceEventId,
  }));
  const recipientSetId = `whrs_${recipientSetDigest}`;
  let recipientSet = (
    await db
      .select()
      .from(webhookRecipientSets)
      .where(and(
        eq(webhookRecipientSets.projectId, projectId),
        eq(webhookRecipientSets.sourceEventId, options.sourceEventId),
      ))
      .limit(1)
  )[0];

  if (!recipientSet) {
    let recipientWebhookIds: string[];
    if (existingDeliveries.length > 0) {
      // Upgrade compatibility: delivery rows created before recipient-set
      // reservations existed are themselves the frozen historical set.
      recipientWebhookIds = existingDeliveries
        .map((row) => row.webhookId)
        .filter((id): id is string => id !== null)
        .sort();
    } else {
      const where = options.webhookId
        ? and(
            eq(webhooks.id, options.webhookId),
            eq(webhooks.projectId, projectId),
            eq(webhooks.active, 1),
          )
        : and(eq(webhooks.projectId, projectId), eq(webhooks.active, 1));
      const rows = await db.select().from(webhooks).where(where);
      recipientWebhookIds = rows
        .filter((row) => {
          if (options.webhookId) return true;
          let subscriptions: string[];
          try {
            subscriptions = JSON.parse(row.events) as string[];
          } catch {
            return false;
          }
          return matchesAny(subscriptions, event);
        })
        .map((row) => row.id)
        .sort();
    }
    const createdAt = Math.floor(Date.now() / 1000);
    await db
      .insert(webhookRecipientSets)
      .select(db.select({
        id: sql<string>`${recipientSetId}`.as("id"),
        projectId: projects.id,
        sourceEventId: sql<string>`${options.sourceEventId}`.as("source_event_id"),
        sourceEventHash: sql<string>`${sourceEventHash}`.as("source_event_hash"),
        event: sql<string>`${event}`.as("event"),
        webhookIdsJson: sql<string>`${canonicalJsonStringify(recipientWebhookIds)}`.as("webhook_ids_json"),
        createdAt: sql<number>`${createdAt}`.as("created_at"),
      }).from(projects).where(and(
        eq(projects.id, projectId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${projectDeletionFences}
          WHERE ${projectDeletionFences.projectId} = ${projects.id}
        )`,
      )))
      .onConflictDoNothing({
        target: [webhookRecipientSets.projectId, webhookRecipientSets.sourceEventId],
      });
    recipientSet = (
      await db
        .select()
        .from(webhookRecipientSets)
        .where(and(
          eq(webhookRecipientSets.projectId, projectId),
          eq(webhookRecipientSets.sourceEventId, options.sourceEventId),
        ))
        .limit(1)
    )[0];
  }
  if (!recipientSet) {
    await assertProjectExternalWritesOpen(env, projectId);
    throw errors.persistenceFailed(
      "The webhook recipient set could not be reserved.",
      "Retry with the same source_event_id before committing the source mutation.",
      { source_event_id: options.sourceEventId },
    );
  }
  if (recipientSet.sourceEventHash !== sourceEventHash || recipientSet.event !== event) {
    throwSourceEventReuse(options.sourceEventId, event);
  }
  const recipientWebhookIds = parseRecipientWebhookIds(recipientSet.webhookIdsJson);
  const existingByWebhook = new Map(
    existingDeliveries
      .filter((row): row is typeof row & { webhookId: string } => row.webhookId !== null)
      .map((row) => [row.webhookId, row]),
  );
  const missingIds = recipientWebhookIds.filter((id) => !existingByWebhook.has(id));
  const missingHooks = missingIds.length === 0
    ? []
    : await db.select().from(webhooks).where(and(
        eq(webhooks.projectId, projectId),
        inArray(webhooks.id, missingIds),
      ));
  const hooksById = new Map(missingHooks.map((hook) => [hook.id, hook]));

  const deliveries = await Promise.all(recipientWebhookIds.map(async (webhookId) => {
    const existing = existingByWebhook.get(webhookId);
    if (existing) return existing;
    const hook = hooksById.get(webhookId);
    if (!hook) {
      throw errors.persistenceFailed(
        "A reserved webhook recipient no longer has a durable subscription tombstone.",
        "Restore or reconcile the webhook subscription before retrying this source_event_id.",
        { source_event_id: options.sourceEventId, webhook_id: webhookId },
      );
    }
    const digest = await sha256Hex(canonicalJsonStringify({
      project_id: projectId,
      webhook_id: webhookId,
      source_event_id: options.sourceEventId,
    }));
    const id = `whd_${digest.slice(0, 16)}-${digest.slice(16, 32)}-${digest.slice(32)}`;
    return {
      id,
      projectId,
      webhookId,
      sourceEventId: options.sourceEventId,
      sourceEventHash,
      event,
      payloadJson: buildWebhookDeliveryPayload(
        id,
        options.sourceEventId,
        projectId,
        event,
        data,
        recipientSet.createdAt,
        options,
      ),
      status: "pending" as const,
      attemptCount: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      nextAttemptAt: recipientSet.createdAt,
      createdAt: recipientSet.createdAt,
      updatedAt: recipientSet.createdAt,
    };
  }));
  return {
    projectId,
    event,
    sourceEventId: options.sourceEventId,
    sourceEventHash,
    recipientSetId: recipientSet.id,
    recipientWebhookIds,
    deliveryIds: deliveries.map((delivery) => delivery.id),
    deliveries,
  };
}

/**
 * Build a delivery insert whose NOT NULL identity is conditional on the
 * project still existing without a deletion fence. This statement and fence
 * insertion therefore have one SQLite order: if the fence wins, the whole
 * caller batch fails instead of committing a domain mutation with a new
 * outbound side effect behind teardown.
 */
export function guardedWebhookDeliveryInsert(
  db: ReturnType<typeof getDb>,
  delivery: PreparedWebhookOutbox["deliveries"][number],
) {
  const authority = sql`EXISTS (
    SELECT 1 FROM ${projects}
    WHERE ${projects.id} = ${delivery.projectId}
  ) AND NOT EXISTS (
    SELECT 1 FROM ${projectDeletionFences}
    WHERE ${projectDeletionFences.projectId} = ${delivery.projectId}
  )`;
  return db.insert(webhookDeliveries).select(db.select({
    id: sql<string>`CASE WHEN ${authority} THEN ${delivery.id} ELSE NULL END`.as("id"),
    projectId: sql<string>`${delivery.projectId}`.as("project_id"),
    webhookId: sql<string | null>`${delivery.webhookId ?? null}`.as("webhook_id"),
    sourceEventId: sql<string>`${delivery.sourceEventId}`.as("source_event_id"),
    sourceEventHash: sql<string>`${delivery.sourceEventHash}`.as("source_event_hash"),
    event: sql<string>`${delivery.event}`.as("event"),
    payloadJson: sql<string>`${delivery.payloadJson}`.as("payload_json"),
    status: sql<string>`${delivery.status ?? "pending"}`.as("status"),
    attemptCount: sql<number>`${delivery.attemptCount ?? 0}`.as("attempt_count"),
    maxAttempts: sql<number>`${delivery.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}`.as("max_attempts"),
    nextAttemptAt: sql<number>`${delivery.nextAttemptAt ?? delivery.createdAt}`.as("next_attempt_at"),
    lockedAt: sql<number | null>`${delivery.lockedAt ?? null}`.as("locked_at"),
    lockedBy: sql<string | null>`${delivery.lockedBy ?? null}`.as("locked_by"),
    lastAttemptAt: sql<number | null>`${delivery.lastAttemptAt ?? null}`.as("last_attempt_at"),
    deliveredAt: sql<number | null>`${delivery.deliveredAt ?? null}`.as("delivered_at"),
    lastStatusCode: sql<number | null>`${delivery.lastStatusCode ?? null}`.as("last_status_code"),
    lastError: sql<string | null>`${delivery.lastError ?? null}`.as("last_error"),
    createdAt: sql<number>`${delivery.createdAt}`.as("created_at"),
    updatedAt: sql<number>`${delivery.updatedAt ?? delivery.createdAt}`.as("updated_at"),
  }).from(projects).where(eq(projects.id, delivery.projectId)));
}

function throwSourceEventReuse(sourceEventId: string, event: WebhookEvent): never {
  throw errors.conflict(
    "webhook_source_event_reused",
    "The webhook source_event_id is already bound to different event evidence.",
    "Reuse source_event_id only when retrying the exact same domain event. Mint a new source event id for new evidence.",
    { source_event_id: sourceEventId, event },
  );
}

function parseRecipientWebhookIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(parsed).size === parsed.length
    ) {
      return [...parsed].sort();
    }
  } catch {
    // Fall through to the durable-state error below.
  }
  throw errors.persistenceFailed(
    "The webhook recipient set is malformed.",
    "Do not rematch current subscriptions. Reconcile the saved recipient set before retrying the source event.",
  );
}

function assertSourceEventId(sourceEventId: string): void {
  if (
    typeof sourceEventId !== "string" ||
    sourceEventId.length < 1 ||
    sourceEventId.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(sourceEventId)
  ) {
    throw errors.invalidPayload({
      reason: "source_event_id must be a 1-256 character stable identifier using letters, numbers, dot, underscore, colon, slash, or hyphen",
    });
  }
}

export async function assertWebhookOutboxPersisted(
  env: Env,
  outbox: PreparedWebhookOutbox,
): Promise<void> {
  const db = getDb(env);
  const recipientSet = (
    await db
      .select()
      .from(webhookRecipientSets)
      .where(eq(webhookRecipientSets.id, outbox.recipientSetId))
      .limit(1)
  )[0];
  if (
    !recipientSet ||
    recipientSet.projectId !== outbox.projectId ||
    recipientSet.sourceEventId !== outbox.sourceEventId ||
    recipientSet.sourceEventHash !== outbox.sourceEventHash ||
    canonicalJsonStringify(parseRecipientWebhookIds(recipientSet.webhookIdsJson)) !==
      canonicalJsonStringify(outbox.recipientWebhookIds)
  ) {
    throw errors.persistenceFailed(
      "The webhook recipient set did not match the prepared source event.",
      "Retry with the same source_event_id. Do not rematch current subscriptions.",
      { source_event_id: outbox.sourceEventId },
    );
  }
  if (outbox.deliveryIds.length === 0) return;
  const rows = await db
    .select({
      id: webhookDeliveries.id,
      sourceEventHash: webhookDeliveries.sourceEventHash,
    })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.id, outbox.deliveryIds));
  if (
    rows.length !== outbox.deliveryIds.length ||
    rows.some((row) => row.sourceEventHash !== outbox.sourceEventHash)
  ) {
    throw errors.persistenceFailed(
      "The webhook outbox did not contain the complete canonical delivery set.",
      "Retry with the same source_event_id. Do not execute the source mutation again until the outbox is reconciled.",
      { source_event_id: outbox.sourceEventId, expected_deliveries: outbox.deliveryIds.length },
    );
  }
}

/**
 * Start delivery only after the caller has durably committed every returned
 * id. This helper never inserts outbox rows; it only schedules the first
 * attempt. Scheduled sweeps remain the recovery path when the immediate
 * attempt fails or the isolate terminates.
 */
export async function dispatchPersistedWebhookDeliveries(
  env: Env,
  deliveryIds: string[],
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  if (deliveryIds.length === 0) return;

  const immediate = Promise.allSettled(
    deliveryIds.map((id) => processWebhookDelivery(env, id)),
  );
  if (waitUntil) waitUntil(immediate);
  else await immediate;
}

export async function fireWebhooks(
  env: Env,
  projectId: string,
  event: WebhookEvent,
  data: Record<string, unknown>,
  options: FireOptions,
): Promise<string[]> {
  const outbox = await prepareWebhookOutbox(env, projectId, event, data, options);
  const db = getDb(env);
  // One multi-row statement is the atomic outbox boundary. A constraint error
  // rolls back every new subscriber row; exact retries no-op on the unique
  // (webhook_id, source_event_id) key and retain the same delivery ids.
  if (outbox.deliveries.length > 0) {
    try {
      await db.batch(outbox.deliveries.map((delivery) =>
        guardedWebhookDeliveryInsert(db, delivery).onConflictDoNothing({
          target: [webhookDeliveries.webhookId, webhookDeliveries.sourceEventId],
        })
      ) as [ReturnType<typeof guardedWebhookDeliveryInsert>, ...ReturnType<typeof guardedWebhookDeliveryInsert>[]]);
    } catch (error) {
      await assertProjectExternalWritesOpen(env, projectId);
      throw error;
    }
  }
  await assertWebhookOutboxPersisted(env, outbox);

  await dispatchPersistedWebhookDeliveries(
    env,
    outbox.deliveryIds,
    options.waitUntil,
  );
  return outbox.deliveryIds;
}

export async function replayWebhookDelivery(env: Env, projectId: string, deliveryId: string) {
  await assertProjectExternalWritesOpen(env, projectId);
  const db = getDb(env);
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.projectId, projectId)))
    .limit(1);
  const delivery = rows[0];
  if (!delivery) return null;
  if (delivery.status === "succeeded") return { delivery, replayed: false as const, reason: "already_succeeded" };
  if (!delivery.webhookId || !(
    await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(and(
        eq(webhooks.id, delivery.webhookId),
        eq(webhooks.projectId, projectId),
        eq(webhooks.active, 1),
      ))
      .limit(1)
  )[0]) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "cancelled",
        lockedAt: null,
        lockedBy: null,
        lastError: "webhook_disabled_before_replay",
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return {
      delivery: { ...delivery, status: "cancelled" as const },
      replayed: false as const,
      reason: "webhook_disabled",
    };
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .update(webhookDeliveries)
    .set({
      status: "retrying",
      nextAttemptAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(webhookDeliveries.id, deliveryId));
  const result = await processWebhookDelivery(env, deliveryId, `manual_replay_${uuidv7()}`);
  return { delivery: { ...delivery, status: "retrying" as const }, replayed: true as const, result };
}
