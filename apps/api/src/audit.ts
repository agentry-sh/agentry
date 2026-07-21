// Durable, append-only audit events for agent-driven mutations.
//
// Audit writes are fail-closed. External mutations should use
// auditedExternalMutation so a durable intent exists before the side effect;
// local database mutations should use the atomic DB helper. A completed event
// never updates its intent row: history is an append-only operation timeline.

import {
  AgentryError,
  canonicalJsonStringify,
  errors,
  prepareTelemetryObservation,
  sha256Hex,
} from "@agentrysh/shared";
import { eq, sql } from "drizzle-orm";
import { auditLog, projectDeletionFences, projects } from "@agentry/db/schema";
import type { Context } from "hono";
import type { AppBindings } from "./env.js";
import { getDb } from "./db.js";

export type AuditAction =
  | "publication.minted"
  | "publication.revoked"
  | "project.created"
  | "project.deleted"
  | "account.deleted"
  | "owner_key.created"
  | "owner_key.revoked"
  | "project_credential.created"
  | "project_credential.revoked"
  | "webhook.created"
  | "webhook.test_enqueued"
  | "alert.created"
  | "feedback.created"
  | "feedback.deduped"
  | "invite.created"
  | "invite.accepted"
  | "billing.checkout_session.created"
  | "billing.portal_session.created";

export type AuditResourceType =
  | "publication"
  | "project"
  | "account"
  | "owner_key"
  | "project_credential"
  | "webhook"
  | "webhook_delivery"
  | "alert"
  | "feedback"
  | "invite"
  | "billing_session";

export interface AuditInput {
  userId: string;
  projectId?: string | null;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string | number | null;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export type AuditPhase = "intent" | "succeeded" | "failed" | "indeterminate";

export interface AuditOperation {
  operationId: string;
  requestHash: string;
  input: AuditInput;
  intentReplay?: boolean;
}

export interface AuditReceipt {
  id: string;
  operationId: string;
  requestHash: string;
  phase: AuditPhase;
  idempotentReplay: boolean;
}

export interface PreparedAuditEvent {
  receipt: AuditReceipt;
  values: typeof auditLog.$inferInsert;
  input: AuditInput;
  resourceId: string | null;
  summary: string | null;
  metadata: Record<string, unknown>;
}

const EXPLICIT_NO_EXTERNAL_EFFECT = Symbol("agentry.explicit_no_external_effect");

/**
 * Mark a trusted, locally classified failure as proving the provider effect
 * never started. HTTP status, error code, and caller-supplied details are not
 * sufficient: only code holding this module capability can make the claim.
 */
export function markExternalFailureWithoutEffect<T extends Error>(error: T): T {
  Object.defineProperty(error, EXPLICIT_NO_EXTERNAL_EFFECT, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}

/** Persist intent before an external side effect. */
export async function beginAudit(
  c: Context<AppBindings>,
  input: AuditInput,
): Promise<AuditOperation> {
  const operation = await operationFor(c, input);
  const receipt = await appendAuditEvent(c, operation, "intent", input);
  return { ...operation, intentReplay: receipt.idempotentReplay };
}

export async function completeAudit(
  c: Context<AppBindings>,
  operation: AuditOperation,
  input: AuditInput = operation.input,
): Promise<AuditReceipt> {
  return appendAuditEvent(c, operation, "succeeded", input);
}

export async function failAudit(
  c: Context<AppBindings>,
  operation: AuditOperation,
  error: unknown,
): Promise<AuditReceipt> {
  return appendFailureAudit(c, operation, "failed", error);
}

export async function indeterminateAudit(
  c: Context<AppBindings>,
  operation: AuditOperation,
  error: unknown,
): Promise<AuditReceipt> {
  return appendFailureAudit(c, operation, "indeterminate", error);
}

async function appendFailureAudit(
  c: Context<AppBindings>,
  operation: AuditOperation,
  phase: "failed" | "indeterminate",
  error: unknown,
): Promise<AuditReceipt> {
  const errorObservation = prepareTelemetryObservation({
    error: error instanceof Error ? error.message : String(error),
  }, { max_string_chars: 1_000 });
  return appendAuditEvent(c, operation, phase, {
    ...operation.input,
    metadata: {
      ...(operation.input.metadata ?? {}),
      failure: errorObservation.content,
      failure_inspection: errorObservation.inspection,
    },
  });
}

/**
 * Saga boundary for provider mutations. Intent commits before the effect.
 * Success/failure append afterward; a missing completion is a visible pending
 * operation for reconciliation, never an invisible mutation.
 */
export async function auditedExternalMutation<T>(
  c: Context<AppBindings>,
  input: AuditInput,
  effect: () => Promise<T>,
  completedInput: (value: T) => AuditInput = () => input,
  options: { retainedResourceOnSuccess?: boolean } = {},
): Promise<T> {
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  if (!idempotencyKey) {
    throw errors.preconditionRequired(
      "Provider mutations require an Idempotency-Key header.",
      "Generate one stable 8-500 character key for this exact intended mutation and preserve it across transport retries. Never reuse it for a different payload.",
      { header: "Idempotency-Key" },
    );
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 500) {
    throw errors.invalidPayload({
      reason: "Idempotency-Key must be 8-500 characters for provider mutations",
    });
  }
  const externalInput = externalAuditInput(input, options);
  const operation = await beginAudit(c, externalInput);
  if (operation.intentReplay) {
    throw errors.conflict(
      "audit_operation_replayed",
      "This idempotency key already has a durable provider-mutation intent, so Agentry will not execute the external side effect again.",
      "Read the audit operation and provider resource to reconcile its outcome. Reuse this key only to inspect the original operation; use a new key only after proving the original side effect failed.",
      { operation_id: operation.operationId, request_hash: operation.requestHash },
    );
  }
  let value: T;
  try {
    value = await effect();
  } catch (error) {
    try {
      if (isDefinitiveExternalFailure(error)) {
        await failAudit(c, operation, error);
      } else {
        await indeterminateAudit(c, operation, error);
      }
    } catch (auditFailure) {
      console.error(JSON.stringify({
        audit_failure: true,
        operation_id: operation.operationId,
        mutation_error: error instanceof Error ? error.message : String(error),
        audit_error: auditFailure instanceof Error ? auditFailure.message : String(auditFailure),
      }));
    }
    throw error;
  }

  // Deliberately complete outside the provider-effect catch. If the provider
  // succeeded but the completion append fails, the durable intent must remain
  // pending/ambiguous for reconciliation; recording a failed provider action
  // would be false history and could trigger an unsafe retry.
  await completeAudit(c, operation, externalAuditInput(completedInput(value), options));
  return value;
}

function isDefinitiveExternalFailure(error: unknown): boolean {
  return error instanceof AgentryError &&
    (error as AgentryError & { [EXPLICIT_NO_EXTERNAL_EFFECT]?: boolean })[EXPLICIT_NO_EXTERNAL_EFFECT] === true;
}

function externalAuditInput(
  input: AuditInput,
  options: { retainedResourceOnSuccess?: boolean },
): AuditInput {
  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      $agentry_external_mutation: {
        schema_version: "1",
        effect: "provider_mutation",
        // Conservative default: provider resources/settings remain until a
        // call site explicitly proves this is a hard delete.
        retained_resource_on_success: options.retainedResourceOnSuccess !== false,
      },
    },
  };
}

async function operationFor(
  c: Context<AppBindings>,
  input: AuditInput,
): Promise<AuditOperation> {
  const prepared = prepareTelemetryObservation({
    summary: input.summary ?? null,
    metadata: input.metadata ?? {},
  }, { max_string_chars: 4_000 });
  const accepted = prepared.content as {
    summary: string | null;
    metadata: Record<string, unknown>;
  };
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  const requestIdentity = idempotencyKey
    ? `idempotency:${idempotencyKey}`
    : `request:${c.get("requestId") ?? c.req.header("x-agentry-request-id") ?? crypto.randomUUID()}`;
  const identityShape = {
    user_id: input.userId,
    project_id: input.projectId ?? null,
    action: input.action,
    resource_type: input.resourceType,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    request_identity: requestIdentity,
  };
  const operationId = `auditop_${await sha256Hex(canonicalJsonStringify(identityShape))}`;
  const requestHash = await sha256Hex(canonicalJsonStringify({
    ...identityShape,
    resource_id: input.resourceId ?? null,
    summary: accepted.summary,
    metadata: accepted.metadata,
  }));
  return {
    operationId,
    requestHash,
    input,
  };
}

async function appendAuditEvent(
  c: Context<AppBindings>,
  operation: AuditOperation,
  phase: AuditPhase,
  input: AuditInput,
): Promise<AuditReceipt> {
  const db = getDb(c.env);
  const prepared = await prepareAuditEvent(c, input, phase, operation);
  const { id } = prepared.receipt;
  const existing = (
    await db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1)
  )[0];
  if (existing) {
    verifyPreparedAudit(existing, prepared);
    return { ...prepared.receipt, idempotentReplay: true };
  }
  try {
    if (phase === "intent" && input.projectId) {
      // One SQLite statement is the linearization point against deletion.
      // If this insert wins, deletion observes the durable intent and waits;
      // if the fence wins, no provider intent exists and no effect may start.
      const insertResult = await db.run(sql`
        INSERT OR IGNORE INTO audit_log (
          id, user_id, project_id, operation_id, request_hash, phase,
          action, resource_type, resource_id, summary, metadata_json, ip, ua
        )
        SELECT
          ${String(prepared.values.id)}, ${String(prepared.values.userId)},
          ${input.projectId}, ${String(prepared.values.operationId)},
          ${String(prepared.values.requestHash)}, ${String(prepared.values.phase)},
          ${String(prepared.values.action)}, ${String(prepared.values.resourceType)},
          ${prepared.values.resourceId ?? null}, ${prepared.values.summary ?? null},
          ${prepared.values.metadataJson ?? null}, ${prepared.values.ip ?? null},
          ${prepared.values.ua ?? null}
        WHERE EXISTS (
          SELECT 1 FROM projects WHERE id = ${input.projectId}
        ) AND NOT EXISTS (
          SELECT 1 FROM project_deletion_fences WHERE project_id = ${input.projectId}
        )
      `);
      const insertedOrWinner = (
        await db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1)
      )[0];
      if (insertedOrWinner) {
        verifyPreparedAudit(insertedOrWinner, prepared);
        return {
          ...prepared.receipt,
          idempotentReplay: Number(insertResult.rowsAffected ?? 0) !== 1,
        };
      }
      const [project, fence] = await Promise.all([
        db.select({ id: projects.id }).from(projects)
          .where(eq(projects.id, input.projectId)).limit(1),
        db.select().from(projectDeletionFences)
          .where(eq(projectDeletionFences.projectId, input.projectId)).limit(1),
      ]);
      if (fence[0]) {
        throw errors.conflict(
          "project_deletion_in_progress",
          "Project deletion fenced this provider mutation before its durable intent could commit.",
          "Do not call the provider or retry this mutation. Resume the existing deletion command with its original Idempotency-Key.",
          {
            project_id: input.projectId,
            command_id: fence[0].commandId,
            reason: fence[0].reason,
            retryable: false,
          },
        );
      }
      if (!project[0]) {
        throw new AgentryError({
          status: 410,
          code: "project_external_writes_closed",
          message: "The project was deleted before this provider mutation could reserve authority.",
          nextAction: "Do not call the provider. Choose or create an active project before starting a new mutation.",
          details: { project_id: input.projectId, retryable: false },
        });
      }
      throw errors.persistenceFailed(
        "Provider mutation intent was not persisted.",
        "Stop before the provider call and retry the same request only after database health is restored.",
        { project_id: input.projectId, operation_id: operation.operationId },
      );
    }
    await db.insert(auditLog).values(prepared.values);
  } catch (error) {
    const winner = (
      await db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1)
    )[0];
    if (winner) {
      verifyPreparedAudit(winner, prepared);
      return { ...prepared.receipt, idempotentReplay: true };
    }
    if (error instanceof AgentryError) throw error;
    throw errors.persistenceFailed(
      "audit event could not be persisted",
      "Stop the mutation workflow and retry with the same idempotency-key or x-agentry-request-id. Do not report success without a durable audit event.",
      { operation_id: operation.operationId, phase, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  return prepared.receipt;
}

/**
 * Materialize an immutable audit row without writing it. Local database
 * commands use this to batch current-state and history writes in one libSQL
 * transaction; provider commands use appendAuditEvent's saga path instead.
 */
export async function prepareAuditEvent(
  c: Context<AppBindings>,
  input: AuditInput,
  phase: AuditPhase = "succeeded",
  suppliedOperation?: AuditOperation,
): Promise<PreparedAuditEvent> {
  const operation = suppliedOperation ?? await operationFor(c, input);
  const resourceId = input.resourceId === undefined || input.resourceId === null
    ? null
    : String(input.resourceId);
  const content = prepareTelemetryObservation({
    summary: input.summary ?? null,
    metadata: input.metadata ?? {},
  }, { max_string_chars: 4_000 });
  const accepted = content.content as { summary: string | null; metadata: Record<string, unknown> };
  const metadata = {
    ...accepted.metadata,
    $agentry_audit: {
      schema_version: "2",
      operation_id: operation.operationId,
      request_hash: operation.requestHash,
      phase,
      append_only: true,
      content_inspection: content.inspection,
    },
  };
  // One immutable row per operation phase. Reusing an idempotency key with a
  // different payload resolves to this same id and fails the content check
  // below instead of silently becoming a second operation.
  const id = `audit_${await sha256Hex(`${operation.operationId}:${phase}`)}`;
  const ip = c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  const ua = c.req.header("user-agent") ?? null;
  return {
    receipt: {
      id,
      operationId: operation.operationId,
      requestHash: operation.requestHash,
      phase,
      idempotentReplay: false,
    },
    values: {
      id,
      userId: input.userId,
      projectId: input.projectId ?? null,
      operationId: operation.operationId,
      requestHash: operation.requestHash,
      phase,
      action: input.action,
      resourceType: input.resourceType,
      resourceId,
      summary: accepted.summary,
      metadataJson: canonicalJsonStringify(metadata),
      ip,
      ua,
      occurredAtMs: Date.now(),
    },
    input,
    resourceId,
    summary: accepted.summary,
    metadata,
  };
}

function verifyPreparedAudit(
  existing: typeof auditLog.$inferSelect,
  prepared: PreparedAuditEvent,
): void {
  verifyExisting(
    existing,
    prepared.input,
    prepared.resourceId,
    prepared.summary,
    prepared.metadata,
  );
}

/**
 * Verify a transaction-local insert winner before treating a deterministic
 * audit conflict as an exact replay. Callers must never accept
 * onConflictDoNothing without this full immutable-content comparison.
 */
export function verifyPreparedAuditRow(
  existing: typeof auditLog.$inferSelect,
  prepared: PreparedAuditEvent,
): void {
  verifyPreparedAudit(existing, prepared);
}

/** Insert a prepared row or prove that the deterministic winner is identical. */
export async function insertPreparedAuditExactly(
  db: ReturnType<typeof getDb>,
  prepared: PreparedAuditEvent,
): Promise<void> {
  const inserted = await db.insert(auditLog)
    .values(prepared.values)
    .onConflictDoNothing()
    .returning({ id: auditLog.id });
  if (inserted.length === 1) return;
  const existing = (
    await db.select().from(auditLog)
      .where(eq(auditLog.id, prepared.receipt.id)).limit(1)
  )[0];
  if (!existing) {
    throw errors.persistenceFailed(
      "deterministic audit insert lost without a readable winner",
      "Stop the mutation workflow and restore database consistency before retrying the same operation.",
      { audit_id: prepared.receipt.id, operation_id: prepared.receipt.operationId },
    );
  }
  verifyPreparedAudit(existing, prepared);
}

function verifyExisting(
  existing: typeof auditLog.$inferSelect,
  input: AuditInput,
  resourceId: string | null,
  summary: string | null,
  metadata: Record<string, unknown>,
): void {
  let existingEnvelope: {
    $agentry_audit?: { operation_id?: string; request_hash?: string };
  } = {};
  try {
    existingEnvelope = JSON.parse(existing.metadataJson ?? "{}") as typeof existingEnvelope;
  } catch {
    // The integrity error below gives the caller the canonical recovery path.
  }
  const requestedEnvelope = metadata.$agentry_audit as {
    operation_id?: string;
    request_hash?: string;
  } | undefined;
  if (
    existingEnvelope.$agentry_audit?.operation_id === requestedEnvelope?.operation_id &&
    existingEnvelope.$agentry_audit?.request_hash !== requestedEnvelope?.request_hash
  ) {
    throw errors.conflict(
      "idempotency_key_reused",
      "This idempotency key was already used with a different mutation payload.",
      "Replay the exact original request or use a new stable idempotency key for the new mutation.",
      { operation_id: requestedEnvelope?.operation_id },
    );
  }
  const same = existing.userId === input.userId &&
    existing.projectId === (input.projectId ?? null) &&
    existing.action === input.action &&
    existing.resourceType === input.resourceType &&
    existing.resourceId === resourceId &&
    existing.summary === summary &&
    existing.metadataJson === canonicalJsonStringify(metadata);
  if (!same) {
    throw errors.persistenceFailed(
      "deterministic audit id resolved to different content",
      "Stop and investigate audit-store integrity; never overwrite or merge the conflicting event.",
      { audit_id: existing.id },
    );
  }
}
