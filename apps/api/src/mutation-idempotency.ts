import type { Context } from "hono";
import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import { eq } from "drizzle-orm";
import { mutationCommands } from "@agentry/db/schema";
import type { AppBindings } from "./env.js";
import { getDb } from "./db.js";

export interface MutationIdentity {
  id: string;
  actorUserId: string;
  projectId: string | null;
  action: string;
  idempotencyKeyHash: string;
  requestHash: string;
}

export async function mutationIdentity(
  c: Context<AppBindings>,
  input: {
    action: string;
    projectId?: string | null;
    request: unknown;
  },
): Promise<MutationIdentity> {
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  if (!idempotencyKey) {
    throw errors.preconditionRequired(
      "This mutation requires an Idempotency-Key header.",
      "Generate one stable 8-500 character key for this exact mutation and preserve it across transport retries. Use a new key for a different mutation.",
      { header: "Idempotency-Key", action: input.action },
    );
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 500) {
    throw errors.invalidPayload({
      reason: "Idempotency-Key must be 8-500 characters",
      action: input.action,
    });
  }
  const actorUserId = c.get("user").id;
  const projectId = input.projectId ?? null;
  const scope = {
    schema_version: "1",
    actor_user_id: actorUserId,
    project_id: projectId,
    action: input.action,
    idempotency_key: idempotencyKey,
  };
  const idempotencyKeyHash = await sha256Hex(canonicalJsonStringify(scope));
  const requestHash = await sha256Hex(canonicalJsonStringify({
    ...scope,
    request: input.request,
  }));
  return {
    id: `mutcmd_${idempotencyKeyHash}`,
    actorUserId,
    projectId,
    action: input.action,
    idempotencyKeyHash,
    requestHash,
  };
}

export async function loadMutationCommand(
  c: Context<AppBindings>,
  identity: MutationIdentity,
) {
  const row = (
    await getDb(c.env)
      .select()
      .from(mutationCommands)
      .where(eq(mutationCommands.id, identity.id))
      .limit(1)
  )[0];
  if (!row) return null;
  verifyMutationCommand(row, identity);
  return row;
}

export function mutationCommandValues(
  identity: MutationIdentity,
  input: {
    resourceType: string;
    resourceId?: string | null;
    response: Record<string, unknown>;
    createdAt?: number;
  },
): typeof mutationCommands.$inferInsert {
  return {
    id: identity.id,
    actorUserId: identity.actorUserId,
    projectId: identity.projectId,
    action: identity.action,
    idempotencyKeyHash: identity.idempotencyKeyHash,
    requestHash: identity.requestHash,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    responseJson: canonicalJsonStringify(input.response),
    createdAt: input.createdAt ?? Math.floor(Date.now() / 1_000),
  };
}

export function mutationResponse<T extends Record<string, unknown>>(
  row: typeof mutationCommands.$inferSelect,
): T {
  try {
    const parsed = JSON.parse(row.responseJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as T;
  } catch {
    throw errors.persistenceFailed(
      "The durable mutation response is malformed.",
      "Stop and inspect the command receipt before retrying; do not repeat the mutation with a new key.",
      { command_id: row.id, action: row.action },
    );
  }
}

export async function loadMutationWinner(
  c: Context<AppBindings>,
  identity: MutationIdentity,
  originalError: unknown,
) {
  const winner = await loadMutationCommand(c, identity);
  if (winner) return winner;
  throw originalError;
}

function verifyMutationCommand(
  row: typeof mutationCommands.$inferSelect,
  identity: MutationIdentity,
): void {
  if (
    row.actorUserId !== identity.actorUserId ||
    row.projectId !== identity.projectId ||
    row.action !== identity.action ||
    row.idempotencyKeyHash !== identity.idempotencyKeyHash
  ) {
    throw errors.persistenceFailed(
      "The deterministic mutation command resolved to a different authority scope.",
      "Stop and inspect command-store integrity; never merge or overwrite the conflicting receipt.",
      { command_id: row.id },
    );
  }
  if (row.requestHash !== identity.requestHash) {
    throw errors.conflict(
      "idempotency_key_reused",
      "This Idempotency-Key was already used with different mutation evidence.",
      "Replay the exact original request or use a new stable Idempotency-Key for the different mutation.",
      {
        command_id: row.id,
        action: row.action,
        original_request_hash: row.requestHash,
        received_request_hash: identity.requestHash,
      },
    );
  }
}
