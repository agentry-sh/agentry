import { and, eq, sql } from "drizzle-orm";
import {
  automationWorkflowRuns,
  automationWorkflowRunStates,
  automationWorkflowSystemNodeClaims,
} from "@agentry/db/schema";
import {
  base64url,
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import type { getDb } from "./db.js";
import { assertAutomationWritesOpen } from "./automation-deletion-boundary.js";
import { assertAutomationWorkflowAuthorityOpen } from "./automation-workflow-controls.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Db | Transaction;
type ClaimRow = typeof automationWorkflowSystemNodeClaims.$inferSelect;

const CLAIM_SECONDS = 300;
const HASH = /^[a-f0-9]{64}$/u;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export type AutomationWorkflowSystemNodeClaim = Readonly<{
  claim_id: string;
  run_id: string;
  run_revision: number;
  node_id: string;
  input_hash: string;
  claim_epoch: number;
  claim_token: string;
  claimed_at: number;
  expires_at: number;
}>;

export type AcquireAutomationWorkflowSystemNodeClaimResult =
  | { outcome: "acquired"; claim: AutomationWorkflowSystemNodeClaim }
  | { outcome: "already_completed"; claim_id: string; completed_at: number };

async function databaseNow(db: ReadDb): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("database clock did not return unix seconds");
  return now;
}

function validateInput(input: {
  run_id: string;
  run_revision: number;
  node_id: string;
  input_hash: string;
}): void {
  if (!Number.isSafeInteger(input.run_revision) || input.run_revision < 1) {
    throw errors.invalidPayload({ reason: "system-node run_revision must be a positive integer" });
  }
  if (!NODE_ID.test(input.node_id)) {
    throw errors.invalidPayload({ reason: "system-node node_id is invalid" });
  }
  if (!HASH.test(input.input_hash)) {
    throw errors.invalidPayload({ reason: "system-node input_hash must be a lowercase SHA-256 hash" });
  }
}

function rawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `awsys_${base64url(bytes)}`;
}

async function claimIdentity(input: {
  run_id: string;
  run_revision: number;
  node_id: string;
  input_hash: string;
}): Promise<string> {
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-system-node-claim-v1",
    ...input,
  }));
}

async function loadClaim(db: ReadDb, id: string): Promise<ClaimRow | null> {
  return (
    await db.select().from(automationWorkflowSystemNodeClaims).where(
      eq(automationWorkflowSystemNodeClaims.id, id),
    ).limit(1)
  )[0] ?? null;
}

function claimReceipt(
  row: ClaimRow,
  token: string,
): AutomationWorkflowSystemNodeClaim {
  return {
    claim_id: row.id,
    run_id: row.runId,
    run_revision: row.runRevision,
    node_id: row.nodeId,
    input_hash: row.inputHash,
    claim_epoch: row.claimEpoch,
    claim_token: token,
    claimed_at: row.claimedAt,
    expires_at: row.expiresAt,
  };
}

/** Acquire before any network read; one current epoch owns this exact input. */
export async function acquireAutomationWorkflowSystemNodeClaim(
  db: Db,
  input: {
    run_id: string;
    run_revision: number;
    node_id: string;
    input_hash: string;
  },
): Promise<AcquireAutomationWorkflowSystemNodeClaimResult> {
  validateInput(input);
  const id = await claimIdentity(input);
  const token = rawToken();
  const tokenHash = await sha256Hex(token);
  return db.transaction(async (tx) => {
    const now = await databaseNow(tx);
    const loaded = (
      await tx.select({
        run: automationWorkflowRuns,
        state: automationWorkflowRunStates,
      }).from(automationWorkflowRuns).innerJoin(
        automationWorkflowRunStates,
        eq(automationWorkflowRunStates.runId, automationWorkflowRuns.id),
      ).where(eq(automationWorkflowRuns.id, input.run_id)).limit(1)
    )[0] ?? null;
    if (!loaded) throw errors.notFound("automation_workflow_run");
    if (loaded.state.stateVersion !== input.run_revision) {
      throw errors.conflict(
        "automation_workflow_system_node_claim_stale",
        "The run advanced before this exact system-node input could be claimed.",
        "Re-read the run and follow its current next_action; do not execute the stale input.",
        {
          run_id: input.run_id,
          expected_revision: input.run_revision,
          current_revision: loaded.state.stateVersion,
          retryable: true,
        },
      );
    }
    if (!loaded.run.executionAuthorityId || !loaded.run.executionDescriptorHash) {
      throw errors.conflict(
        "automation_workflow_execution_authority_missing",
        "This run has no durable system execution authority.",
        "Pause the workflow and enable a newly reviewed revision. Never execute an unpinned legacy run.",
        { run_id: input.run_id, retryable: false },
      );
    }
    await assertAutomationWritesOpen(tx as unknown as Db, loaded.run.projectId);
    await assertAutomationWorkflowAuthorityOpen(
      tx,
      loaded.run.projectId,
      loaded.run.automationId,
      loaded.run.workflowRevisionId,
      loaded.run.runnerCredentialId,
      loaded.run.executionAuthorityId,
    );

    const current = await loadClaim(tx, id);
    if (current?.status === "completed") {
      return {
        outcome: "already_completed",
        claim_id: current.id,
        completed_at: current.completedAt!,
      };
    }
    if (current?.status === "active" && current.expiresAt > now) {
      throw errors.conflict(
        "automation_workflow_system_node_claim_active",
        "Another system-advance request owns this exact node input.",
        "Wait until retry_at, then replay system advance. Do not fan out another analytics read.",
        {
          run_id: input.run_id,
          node_id: input.node_id,
          run_revision: input.run_revision,
          claim_epoch: current.claimEpoch,
          retry_at: current.expiresAt,
          retryable: true,
        },
      );
    }

    const expiresAt = now + CLAIM_SECONDS;
    if (!current) {
      const inserted = await tx.insert(automationWorkflowSystemNodeClaims).values({
        id,
        projectId: loaded.run.projectId,
        automationId: loaded.run.automationId,
        runId: loaded.run.id,
        runRevision: input.run_revision,
        nodeId: input.node_id,
        inputHash: input.input_hash,
        claimEpoch: 1,
        claimTokenHash: tokenHash,
        status: "active",
        claimedAt: now,
        expiresAt,
        releasedAt: null,
        completedAt: null,
        updatedAt: now,
      }).onConflictDoNothing().returning({ id: automationWorkflowSystemNodeClaims.id });
      if (inserted.length !== 1) {
        const winner = await loadClaim(tx, id);
        throw errors.conflict(
          "automation_workflow_system_node_claim_contention",
          "Another system-advance request won the node claim race.",
          "Reload the run and wait until the winning claim expires before replaying advance.",
          {
            run_id: input.run_id,
            node_id: input.node_id,
            retry_at: winner?.expiresAt ?? expiresAt,
            retryable: true,
          },
        );
      }
      const row = await loadClaim(tx, id);
      if (!row) throw new Error("inserted system-node claim disappeared");
      return { outcome: "acquired", claim: claimReceipt(row, token) };
    }

    const nextEpoch = current.claimEpoch + 1;
    const changed = await tx.update(automationWorkflowSystemNodeClaims).set({
      claimEpoch: nextEpoch,
      claimTokenHash: tokenHash,
      status: "active",
      claimedAt: now,
      expiresAt,
      releasedAt: null,
      completedAt: null,
      updatedAt: now,
    }).where(and(
      eq(automationWorkflowSystemNodeClaims.id, id),
      eq(automationWorkflowSystemNodeClaims.claimEpoch, current.claimEpoch),
      eq(automationWorkflowSystemNodeClaims.claimTokenHash, current.claimTokenHash),
      eq(automationWorkflowSystemNodeClaims.status, current.status),
    )).returning({ id: automationWorkflowSystemNodeClaims.id });
    if (changed.length !== 1) {
      const winner = await loadClaim(tx, id);
      throw errors.conflict(
        "automation_workflow_system_node_claim_contention",
        "Another system-advance request took over the recoverable node claim.",
        "Reload the run and wait until retry_at before replaying advance.",
        {
          run_id: input.run_id,
          node_id: input.node_id,
          retry_at: winner?.expiresAt ?? expiresAt,
          retryable: true,
        },
      );
    }
    const row = await loadClaim(tx, id);
    if (!row) throw new Error("taken-over system-node claim disappeared");
    return { outcome: "acquired", claim: claimReceipt(row, token) };
  });
}

async function transitionClaim(
  db: Db,
  input: { claim: AutomationWorkflowSystemNodeClaim; status: "released" | "completed" },
): Promise<void> {
  const tokenHash = await sha256Hex(input.claim.claim_token);
  await db.transaction(async (tx) => {
    const now = await databaseNow(tx);
    const changes = await tx.update(automationWorkflowSystemNodeClaims).set({
      status: input.status,
      releasedAt: input.status === "released" ? now : null,
      completedAt: input.status === "completed" ? now : null,
      updatedAt: now,
    }).where(and(
      eq(automationWorkflowSystemNodeClaims.id, input.claim.claim_id),
      eq(automationWorkflowSystemNodeClaims.claimEpoch, input.claim.claim_epoch),
      eq(automationWorkflowSystemNodeClaims.claimTokenHash, tokenHash),
      eq(automationWorkflowSystemNodeClaims.status, "active"),
    )).returning({ id: automationWorkflowSystemNodeClaims.id });
    if (changes.length === 1) return;
    const current = await loadClaim(tx, input.claim.claim_id);
    if (
      current?.claimEpoch === input.claim.claim_epoch &&
      current.claimTokenHash === tokenHash &&
      current.status === input.status
    ) return;
    throw errors.conflict(
      "automation_workflow_system_node_claim_fence_lost",
      "The system worker no longer owns this node-claim epoch.",
      "Discard this worker's result. Re-read the run; only the current claim epoch may release or complete the input.",
      {
        run_id: input.claim.run_id,
        node_id: input.claim.node_id,
        claim_epoch: input.claim.claim_epoch,
        current_claim_epoch: current?.claimEpoch ?? null,
        current_status: current?.status ?? null,
        retryable: true,
      },
    );
  });
}

export async function releaseAutomationWorkflowSystemNodeClaim(
  db: Db,
  claim: AutomationWorkflowSystemNodeClaim,
): Promise<void> {
  await transitionClaim(db, { claim, status: "released" });
}

export async function completeAutomationWorkflowSystemNodeClaim(
  db: Db,
  claim: AutomationWorkflowSystemNodeClaim,
): Promise<void> {
  await transitionClaim(db, { claim, status: "completed" });
}
