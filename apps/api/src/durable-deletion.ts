import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { canonicalJsonStringify } from "@agentrysh/shared";
import { mutationCommands } from "@agentry/db/schema";
import type { AgentryDb } from "./db.js";

// A conservative provider-operation window prevents an exact retry from
// stealing cleanup ownership while the prior request can still mutate state.
export const DELETION_COMMAND_LEASE_SECONDS = 15 * 60;

export type DurableDeletionCommand = typeof mutationCommands.$inferSelect;
export type DurableDeletionLease = {
  command: DurableDeletionCommand;
  token: string;
};

export async function acquireDeletionCommandLease(
  db: AgentryDb,
  command: DurableDeletionCommand,
): Promise<DurableDeletionLease | null> {
  if (command.status === "succeeded") return null;
  const token = `deletionlease_${crypto.randomUUID()}`;
  const acquired = await db.update(mutationCommands).set({
    status: "in_progress",
    leaseToken: token,
    leaseExpiresAt: sql<number>`unixepoch() + ${DELETION_COMMAND_LEASE_SECONDS}`,
    attemptCount: command.attemptCount + 1,
    version: command.version + 1,
    updatedAt: sql<number>`unixepoch()`,
  }).where(and(
    eq(mutationCommands.id, command.id),
    eq(mutationCommands.version, command.version),
    ne(mutationCommands.status, "succeeded"),
    or(
      isNull(mutationCommands.leaseToken),
      isNull(mutationCommands.leaseExpiresAt),
      lte(mutationCommands.leaseExpiresAt, sql<number>`unixepoch()`),
    ),
  )).returning();
  return acquired[0] ? { command: acquired[0], token } : null;
}

export async function releaseDeletionCommandLease(
  db: AgentryDb,
  lease: DurableDeletionLease,
  input: {
    targetCount: number;
    processedCount: number;
    response: Record<string, unknown>;
    error?: Record<string, unknown> | null;
  },
): Promise<DurableDeletionCommand | null> {
  const released = await db.update(mutationCommands).set({
    status: "in_progress",
    targetCount: input.targetCount,
    processedCount: input.processedCount,
    responseJson: canonicalJsonStringify(input.response),
    errorJson: input.error ? canonicalJsonStringify(input.error) : null,
    leaseToken: null,
    leaseExpiresAt: null,
    version: lease.command.version + 1,
    updatedAt: sql<number>`unixepoch()`,
  }).where(and(
    eq(mutationCommands.id, lease.command.id),
    eq(mutationCommands.version, lease.command.version),
    eq(mutationCommands.leaseToken, lease.token),
    ne(mutationCommands.status, "succeeded"),
  )).returning();
  return released[0] ?? null;
}

export async function loadDeletionCommandById(
  db: AgentryDb,
  commandId: string,
): Promise<DurableDeletionCommand | null> {
  return (
    await db.select().from(mutationCommands)
      .where(eq(mutationCommands.id, commandId)).limit(1)
  )[0] ?? null;
}
