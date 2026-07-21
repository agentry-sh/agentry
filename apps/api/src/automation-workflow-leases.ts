import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  automationWorkflowRunLeases,
  automationWorkflowRuns,
  automationWorkflowRunStates,
} from "@agentry/db/schema";
import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import type { getDb } from "./db.js";
import {
  automationWritesOpenForProject,
} from "./automation-deletion-boundary.js";
import { assertAutomationWorkflowAuthorityOpen } from "./automation-workflow-controls.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Db | Transaction;

const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,500}$/u;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "escalated",
  "cancelled",
  "quarantined",
]);

function assertObservedAtMatchesDatabase(now: number, observedAt?: number): void {
  if (observedAt === undefined) return;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw errors.invalidPayload({ reason: "observed_at must be a nonnegative integer" });
  }
  if (Math.abs(observedAt - now) > 1) {
    throw errors.invalidPayload({
      reason: "observed_at must match the database clock within one second",
    });
  }
}

async function databaseNow(db: ReadDb, observedAt?: number): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("database clock did not return unix seconds");
  assertObservedAtMatchesDatabase(now, observedAt);
  return now;
}

function validateToken(token: string): string {
  if (!LEASE_TOKEN.test(token)) {
    throw errors.invalidPayload({
      reason: "lease_token must contain 32-500 URL-safe opaque characters",
    });
  }
  return token;
}

function validateLeaseSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 30 || value > 3_600) {
    throw errors.invalidPayload({ reason: "lease_seconds must be an integer from 30 to 3600" });
  }
  return value;
}

async function loadRunForLease(db: ReadDb, runId: string) {
  return (
    await db.select({
      run: automationWorkflowRuns,
      state: automationWorkflowRunStates,
    }).from(automationWorkflowRuns).innerJoin(
      automationWorkflowRunStates,
      eq(automationWorkflowRunStates.runId, automationWorkflowRuns.id),
    ).where(eq(automationWorkflowRuns.id, runId)).limit(1)
  )[0] ?? null;
}

async function latestLease(db: ReadDb, runId: string) {
  return (
    await db.select().from(automationWorkflowRunLeases).where(
      eq(automationWorkflowRunLeases.runId, runId),
    ).orderBy(desc(automationWorkflowRunLeases.leaseEpoch)).limit(1)
  )[0] ?? null;
}

export type AutomationWorkflowLeaseReceipt = {
  run_id: string;
  lease_epoch: number;
  holder_principal: "automation_runner";
  holder_credential_id: string;
  expires_at: number;
  replayed: boolean;
};

export type AutomationWorkflowPublicLease = {
  run_id: string;
  lease_epoch: number;
  lease_version: number;
  holder_principal: "agentry_system" | "automation_runner" | "trusted_ci";
  holder_credential_id: string | null;
  status: "active" | "expired" | "released";
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
};

export type DurableAutomationWorkflowLeaseReleaseReceipt = {
  kind: "automation_workflow_lease_release_receipt";
  schema_version: "1";
  run_id: string;
  lease_epoch: number;
  lease_version: number;
  holder_principal: "agentry_system" | "automation_runner" | "trusted_ci";
  holder_credential_id: string | null;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
  released_at: number;
  release_reason: string;
};

export type AutomationWorkflowLeaseReleaseReceipt =
  DurableAutomationWorkflowLeaseReleaseReceipt & {
    receipt_hash: string;
    idempotent_replay: boolean;
  };

function publicLease(
  row: typeof automationWorkflowRunLeases.$inferSelect,
  now: number,
): AutomationWorkflowPublicLease {
  const status = row.releasedAt !== null
    ? "released"
    : row.expiresAt <= now
      ? "expired"
      : "active";
  return {
    run_id: row.runId,
    lease_epoch: row.leaseEpoch,
    lease_version: row.version,
    holder_principal: row.holderPrincipal as AutomationWorkflowPublicLease["holder_principal"],
    holder_credential_id: row.holderCredentialId,
    status,
    acquired_at: row.acquiredAt,
    renewed_at: row.renewedAt,
    expires_at: row.expiresAt,
    released_at: row.releasedAt,
    release_reason: row.releaseReason,
  };
}

export async function automationWorkflowLeaseReleaseReceiptHash(
  receipt: DurableAutomationWorkflowLeaseReleaseReceipt,
): Promise<string> {
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-lease-release-receipt-v1",
    ...receipt,
  }));
}

async function leaseReleaseReceipt(
  row: typeof automationWorkflowRunLeases.$inferSelect,
  idempotentReplay: boolean,
): Promise<AutomationWorkflowLeaseReleaseReceipt> {
  if (row.releasedAt === null || row.releaseReason === null) {
    throw errors.persistenceFailed(
      "The workflow lease release has no complete persisted terminal state.",
      "Reload the current lease and do not treat it as released until released_at and release_reason are both durable.",
      { run_id: row.runId, lease_epoch: row.leaseEpoch },
    );
  }
  const durable: DurableAutomationWorkflowLeaseReleaseReceipt = {
    kind: "automation_workflow_lease_release_receipt",
    schema_version: "1",
    run_id: row.runId,
    lease_epoch: row.leaseEpoch,
    lease_version: row.version,
    holder_principal: row.holderPrincipal as DurableAutomationWorkflowLeaseReleaseReceipt["holder_principal"],
    holder_credential_id: row.holderCredentialId,
    acquired_at: row.acquiredAt,
    renewed_at: row.renewedAt,
    expires_at: row.expiresAt,
    released_at: row.releasedAt,
    release_reason: row.releaseReason,
  };
  return {
    ...durable,
    receipt_hash: await automationWorkflowLeaseReleaseReceiptHash(durable),
    idempotent_replay: idempotentReplay,
  };
}

/**
 * Return only the latest public fencing metadata. The bearer token and its
 * persisted hash never cross this read boundary.
 */
export async function readAutomationWorkflowRunLease(
  db: ReadDb,
  runId: string,
): Promise<AutomationWorkflowPublicLease | null> {
  const now = await databaseNow(db);
  const row = await latestLease(db, runId);
  return row ? publicLease(row, now) : null;
}

/**
 * Acquire or take over a run lease. The runner supplies the opaque token so an
 * exact retry after response loss can prove the same lease without Agentry
 * escrowing a recoverable bearer secret.
 */
export async function acquireAutomationWorkflowRunLease(
  db: Db,
  input: {
    run_id: string;
    holder_credential_id: string;
    lease_token: string;
    lease_seconds: number;
    observed_at?: number;
  },
): Promise<AutomationWorkflowLeaseReceipt> {
  const token = validateToken(input.lease_token);
  const leaseSeconds = validateLeaseSeconds(input.lease_seconds);
  const tokenHash = await sha256Hex(token);

  return db.transaction(async (tx) => {
    const now = await databaseNow(tx);
    const loaded = await loadRunForLease(tx, input.run_id);
    if (!loaded) throw errors.notFound("automation_workflow_run");
    if (loaded.run.runnerCredentialId !== input.holder_credential_id) throw errors.forbidden();
    if (TERMINAL_RUN_STATUSES.has(loaded.state.status)) {
      throw errors.conflict(
        "automation_workflow_run_terminal",
        `Workflow run is already ${loaded.state.status}.`,
        "Read the terminal receipt; a terminal run cannot issue new execution authority.",
        { run_id: input.run_id },
      );
    }
    await assertAutomationWorkflowAuthorityOpen(
      tx,
      loaded.run.projectId,
      loaded.run.automationId,
      loaded.run.workflowRevisionId,
      input.holder_credential_id,
      loaded.run.executionAuthorityId,
    );
    const current = await latestLease(tx, input.run_id);
    if (
      current &&
      current.releasedAt === null &&
      current.expiresAt > now &&
      current.holderPrincipal === "automation_runner" &&
      current.holderCredentialId === input.holder_credential_id &&
      current.tokenHash === tokenHash
    ) {
      return {
        run_id: input.run_id,
        lease_epoch: current.leaseEpoch,
        holder_principal: "automation_runner",
        holder_credential_id: input.holder_credential_id,
        expires_at: current.expiresAt,
        replayed: true,
      };
    }
    assertObservedAtMatchesDatabase(now, input.observed_at);

    if (current && current.releasedAt === null && current.expiresAt > now) {
      throw errors.conflict(
        "automation_workflow_lease_busy",
        "Another unexpired fenced worker owns this workflow run.",
        "Wait until the reported lease expiry, then acquire a new epoch; never reuse the other worker's token.",
        { run_id: input.run_id, lease_epoch: current.leaseEpoch, expires_at: current.expiresAt },
      );
    }

    const epoch = (current?.leaseEpoch ?? 0) + 1;
    const expiresAt = now + leaseSeconds;
    const inserted = await tx.insert(automationWorkflowRunLeases).select(
      tx.select({
        runId: automationWorkflowRuns.id,
        projectId: automationWorkflowRuns.projectId,
        automationId: automationWorkflowRuns.automationId,
        leaseEpoch: sql<number>`${epoch}`.as("lease_epoch"),
        version: sql<number>`1`.as("version"),
        holderPrincipal: sql<string>`'automation_runner'`.as("holder_principal"),
        holderCredentialId: sql<string>`${input.holder_credential_id}`.as("holder_credential_id"),
        tokenHash: sql<string>`${tokenHash}`.as("token_hash"),
        acquiredAt: sql<number>`${now}`.as("acquired_at"),
        renewedAt: sql<number>`${now}`.as("renewed_at"),
        expiresAt: sql<number>`${expiresAt}`.as("expires_at"),
        releasedAt: sql<null>`NULL`.as("released_at"),
        releaseReason: sql<null>`NULL`.as("release_reason"),
      }).from(automationWorkflowRuns).where(and(
        eq(automationWorkflowRuns.id, input.run_id),
        automationWritesOpenForProject(automationWorkflowRuns.projectId),
      )),
    ).onConflictDoNothing().returning({ runId: automationWorkflowRunLeases.runId });
    if (inserted.length !== 1) {
      throw errors.conflict(
        "automation_workflow_lease_contention",
        "Another worker acquired the next lease epoch concurrently.",
        "Reload the current run lease before attempting work.",
        { run_id: input.run_id },
      );
    }
    return {
      run_id: input.run_id,
      lease_epoch: epoch,
      holder_principal: "automation_runner",
      holder_credential_id: input.holder_credential_id,
      expires_at: expiresAt,
      replayed: false,
    };
  });
}

export async function renewAutomationWorkflowRunLease(
  db: Db,
  input: {
    run_id: string;
    lease_epoch: number;
    holder_credential_id: string;
    lease_token: string;
    lease_seconds: number;
    observed_at?: number;
  },
): Promise<AutomationWorkflowLeaseReceipt> {
  const tokenHash = await sha256Hex(validateToken(input.lease_token));
  const leaseSeconds = validateLeaseSeconds(input.lease_seconds);
  return db.transaction(async (tx) => {
    const now = await databaseNow(tx, input.observed_at);
    const loaded = await loadRunForLease(tx, input.run_id);
    if (!loaded) throw errors.notFound("automation_workflow_run");
    if (loaded.run.runnerCredentialId !== input.holder_credential_id) throw errors.forbidden();
    if (TERMINAL_RUN_STATUSES.has(loaded.state.status)) {
      throw errors.conflict(
        "automation_workflow_run_terminal",
        `Workflow run is already ${loaded.state.status}.`,
        "Read the terminal receipt; a terminal run cannot renew execution authority.",
        { run_id: input.run_id },
      );
    }
    await assertAutomationWorkflowAuthorityOpen(
      tx,
      loaded.run.projectId,
      loaded.run.automationId,
      loaded.run.workflowRevisionId,
      input.holder_credential_id,
      loaded.run.executionAuthorityId,
    );
    const current = await latestLease(tx, input.run_id);
    if (!current || current.leaseEpoch !== input.lease_epoch) {
      throw errors.conflict(
        "automation_workflow_lease_stale",
        "The supplied lease epoch is no longer current.",
        "Discard all work from the stale worker and load the current run action.",
        { run_id: input.run_id, current_lease_epoch: current?.leaseEpoch ?? null },
      );
    }
    const expiresAt = now + leaseSeconds;
    if (expiresAt <= current.expiresAt) {
      throw errors.conflict(
        "automation_workflow_lease_not_extended",
        "The requested renewal would not extend the current lease expiry.",
        "Renew later or request a duration that moves expires_at forward; never shorten a live lease.",
        { run_id: input.run_id, lease_epoch: input.lease_epoch, current_expires_at: current.expiresAt },
      );
    }
    const changed = await tx.update(automationWorkflowRunLeases).set({
      version: current.version + 1,
      renewedAt: now,
      expiresAt,
    }).where(and(
      eq(automationWorkflowRunLeases.runId, input.run_id),
      eq(automationWorkflowRunLeases.leaseEpoch, input.lease_epoch),
      eq(automationWorkflowRunLeases.version, current.version),
      eq(automationWorkflowRunLeases.holderPrincipal, "automation_runner"),
      eq(automationWorkflowRunLeases.holderCredentialId, input.holder_credential_id),
      eq(automationWorkflowRunLeases.tokenHash, tokenHash),
      isNull(automationWorkflowRunLeases.releasedAt),
      gt(automationWorkflowRunLeases.expiresAt, now),
      automationWritesOpenForProject(automationWorkflowRunLeases.projectId),
    )).returning({ runId: automationWorkflowRunLeases.runId });
    if (changed.length !== 1) {
      throw errors.conflict(
        "automation_workflow_lease_stale",
        "The lease expired, was released, or lost its compare-and-set race.",
        "Stop work and acquire a new lease epoch before reading another action.",
        { run_id: input.run_id, lease_epoch: input.lease_epoch },
      );
    }
    return {
      run_id: input.run_id,
      lease_epoch: input.lease_epoch,
      holder_principal: "automation_runner",
      holder_credential_id: input.holder_credential_id,
      expires_at: expiresAt,
      replayed: false,
    };
  });
}

export async function releaseAutomationWorkflowRunLease(
  db: Db,
  input: {
    run_id: string;
    lease_epoch: number;
    holder_credential_id: string;
    lease_token: string;
    reason: string;
    observed_at?: number;
  },
): Promise<AutomationWorkflowLeaseReleaseReceipt> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw errors.invalidPayload({ reason: "release reason must contain 1-1000 characters" });
  }
  const tokenHash = await sha256Hex(validateToken(input.lease_token));
  return db.transaction(async (tx) => {
    const now = await databaseNow(tx, input.observed_at);
    const current = await latestLease(tx, input.run_id);
    if (!current || current.leaseEpoch !== input.lease_epoch) {
      throw errors.conflict(
        "automation_workflow_lease_stale",
        "The supplied lease epoch is no longer current.",
        "Read the current run projection. Release only its exact current lease, or keep the prior release receipt if that epoch already closed.",
        { run_id: input.run_id, current_lease_epoch: current?.leaseEpoch ?? null },
      );
    }
    if (
      current.holderPrincipal !== "automation_runner" ||
      current.holderCredentialId !== input.holder_credential_id ||
      current.tokenHash !== tokenHash
    ) {
      throw errors.forbidden();
    }
    if (current.releasedAt !== null) {
      if (current.releaseReason !== reason) {
        throw errors.conflict(
          "automation_workflow_lease_release_request_mismatch",
          "The current lease epoch was already released with a different reason.",
          "Keep the existing durable release receipt. Do not rewrite release history; use a new lease epoch for later work.",
          { run_id: input.run_id, lease_epoch: input.lease_epoch },
        );
      }
      return leaseReleaseReceipt(current, true);
    }
    if (now < current.renewedAt) {
      throw errors.conflict(
        "automation_workflow_lease_time_regressed",
        "The lease release time precedes its latest renewal.",
        "Use the database clock and retry without a caller-supplied timestamp.",
        { run_id: input.run_id, lease_epoch: input.lease_epoch },
      );
    }
    const changed = await tx.update(automationWorkflowRunLeases).set({
      version: current.version + 1,
      releasedAt: now,
      releaseReason: reason,
    }).where(and(
      eq(automationWorkflowRunLeases.runId, input.run_id),
      eq(automationWorkflowRunLeases.leaseEpoch, input.lease_epoch),
      eq(automationWorkflowRunLeases.version, current.version),
      eq(automationWorkflowRunLeases.holderPrincipal, "automation_runner"),
      eq(automationWorkflowRunLeases.holderCredentialId, input.holder_credential_id),
      eq(automationWorkflowRunLeases.tokenHash, tokenHash),
      isNull(automationWorkflowRunLeases.releasedAt),
    )).returning();
    if (changed.length !== 1) {
      throw errors.conflict(
        "automation_workflow_lease_stale",
        "The lease was released or changed by another request first.",
        "Replay the exact release request to recover its durable receipt, or read the current lease before taking more work.",
        { run_id: input.run_id, lease_epoch: input.lease_epoch },
      );
    }
    return leaseReleaseReceipt(changed[0]!, false);
  });
}

/** Transaction-local runner fence check used immediately before command commit. */
export async function assertAutomationWorkflowRunLease(
  db: ReadDb,
  input: {
    run_id: string;
    lease_epoch: number;
    holder_credential_id: string;
    lease_token: string;
    observed_at: number;
  },
) {
  const now = await databaseNow(db, input.observed_at);
  const loaded = await loadRunForLease(db, input.run_id);
  if (!loaded) throw errors.notFound("automation_workflow_run");
  if (loaded.run.runnerCredentialId !== input.holder_credential_id) throw errors.forbidden();
  await assertAutomationWorkflowAuthorityOpen(
    db,
    loaded.run.projectId,
    loaded.run.automationId,
    loaded.run.workflowRevisionId,
    input.holder_credential_id,
    loaded.run.executionAuthorityId,
  );
  const tokenHash = await sha256Hex(validateToken(input.lease_token));
  const lease = (
    await db.select().from(automationWorkflowRunLeases).where(and(
      eq(automationWorkflowRunLeases.runId, input.run_id),
      eq(automationWorkflowRunLeases.leaseEpoch, input.lease_epoch),
      eq(automationWorkflowRunLeases.holderPrincipal, "automation_runner"),
      eq(automationWorkflowRunLeases.holderCredentialId, input.holder_credential_id),
      eq(automationWorkflowRunLeases.tokenHash, tokenHash),
      isNull(automationWorkflowRunLeases.releasedAt),
      gt(automationWorkflowRunLeases.expiresAt, now),
    )).limit(1)
  )[0] ?? null;
  const latest = await latestLease(db, input.run_id);
  if (!lease || latest?.leaseEpoch !== input.lease_epoch) {
    throw errors.conflict(
      "automation_workflow_lease_stale",
      "The runner command is not fenced by the current unexpired lease epoch.",
      "Discard the stale result and acquire the current run before submitting another command.",
      { run_id: input.run_id, lease_epoch: input.lease_epoch },
    );
  }
  return lease;
}
