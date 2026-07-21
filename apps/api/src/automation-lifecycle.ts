import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import {
  AUTOMATION_CONTRACT_SCHEMA_VERSION,
  AutomationContractSchema,
  AutomationDefinitionSchema,
  type AutomationRunStatus,
} from "@agentrysh/shared";
import {
  automationActionGrants,
  automationApprovals,
  automationContracts,
  automationRuns,
  automationSchedulerCursors,
  automationTriggerReceipts,
  caseClaims,
} from "@agentry/db/schema";
import {
  appendAutomationRunEvent,
  atomicAutomationHistory,
  type AutomationHistoryTransaction,
} from "./automation-atomic-history.js";
import { getDb } from "./db.js";
import type { Env } from "./env.js";
import {
  issueAutomationTriggerReceipts,
  type TriggerIssuanceResult,
} from "./automation-trigger-orchestration.js";
import { automationWritesOpenForProject } from "./automation-deletion-boundary.js";

const RUNNER_ACTIVE_STATUSES = ["queued", "claimed", "running", "awaiting_approval"] as const;
const ALL_NONTERMINAL_STATUSES = [
  "queued",
  "claimed",
  "running",
  "draft_pr_opened",
  "awaiting_approval",
  "verifying",
] as const;
const LIFECYCLE_RECORD_LIMIT = 500;
const LIFECYCLE_ERROR_LIMIT = 20;
const TRIGGER_CONTRACT_PAGE_SIZE = 200;
const TRIGGER_CONTRACT_PAGE_LIMIT = 6;
const TRIGGER_CONTRACT_SWEEP = "trigger_contracts";

export interface AutomationLifecycleSweepError {
  record_type: string;
  record_id: string;
  project_id: string | null;
  message: string;
}

export interface AutomationLifecycleSweepResult {
  overdue_runs: number;
  provider_wait_timeouts: number;
  verification_timeouts: number;
  killed_runs: number;
  expired_claims: number;
  expired_approvals: number;
  expired_action_grants: number;
  expired_receipts: number;
  error_count: number;
  error_limit: number;
  errors: AutomationLifecycleSweepError[];
  errors_truncated: boolean;
}

/**
 * Close abandoned authority on the minute. Every mutation is CAS-guarded, so
 * concurrent request handlers either win first or observe the sweep's durable
 * terminal state.
 */
export async function sweepAutomationLifecycle(
  env: Env,
  now = Math.floor(Date.now() / 1_000),
): Promise<AutomationLifecycleSweepResult> {
  const db = getDb(env);
  const result: AutomationLifecycleSweepResult = {
    overdue_runs: 0,
    provider_wait_timeouts: 0,
    verification_timeouts: 0,
    killed_runs: 0,
    expired_claims: 0,
    expired_approvals: 0,
    expired_action_grants: 0,
    expired_receipts: 0,
    error_count: 0,
    error_limit: LIFECYCLE_ERROR_LIMIT,
    errors: [],
    errors_truncated: false,
  };

  const expiredReady = await db
    .select({
      id: automationTriggerReceipts.id,
      projectId: automationTriggerReceipts.projectId,
    })
    .from(automationTriggerReceipts)
    .where(and(
      eq(automationTriggerReceipts.status, "ready"),
      lte(automationTriggerReceipts.expiresAt, now),
      automationWritesOpenForProject(automationTriggerReceipts.projectId),
    ))
    .orderBy(asc(automationTriggerReceipts.expiresAt), asc(automationTriggerReceipts.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const receipt of expiredReady) {
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "ready_receipt",
      recordId: receipt.id,
      projectId: receipt.projectId,
    }, () => atomicLifecycleTransition(db, async (tx) => {
      const changed = await tx.update(automationTriggerReceipts).set({ status: "expired" })
        .where(and(
          eq(automationTriggerReceipts.id, receipt.id),
          eq(automationTriggerReceipts.status, "ready"),
          lte(automationTriggerReceipts.expiresAt, now),
          automationWritesOpenForProject(automationTriggerReceipts.projectId),
        ))
        .returning({ id: automationTriggerReceipts.id });
      return changed.length === 1;
    }));
    if (isolated.ok && isolated.value) result.expired_receipts += 1;
  }

  const staleClaimedReceipts = await db
    .select()
    .from(automationTriggerReceipts)
    .where(
      and(
        eq(automationTriggerReceipts.status, "claimed"),
        lte(automationTriggerReceipts.expiresAt, now),
        isNull(automationTriggerReceipts.runId),
        automationWritesOpenForProject(automationTriggerReceipts.projectId),
      ),
    )
    .orderBy(asc(automationTriggerReceipts.expiresAt), asc(automationTriggerReceipts.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const receipt of staleClaimedReceipts) {
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "claimed_receipt",
      recordId: receipt.id,
      projectId: receipt.projectId,
    }, () => atomicLifecycleTransition(db, async (tx) => {
      const expired = await tx.update(automationTriggerReceipts).set({ status: "expired" })
        .where(and(
          eq(automationTriggerReceipts.id, receipt.id),
          eq(automationTriggerReceipts.status, "claimed"),
          isNull(automationTriggerReceipts.runId),
          lte(automationTriggerReceipts.expiresAt, now),
          automationWritesOpenForProject(automationTriggerReceipts.projectId),
        ))
        .returning({ id: automationTriggerReceipts.id });
      if (expired.length === 0) return false;
      if (receipt.claimId) {
        const released = await tx.update(caseClaims).set({
          releasedAt: now,
          releaseReason: "cancelled",
        }).where(and(
          eq(caseClaims.id, receipt.claimId),
          eq(caseClaims.triggerReceiptId, receipt.id),
          isNull(caseClaims.runId),
          isNull(caseClaims.releasedAt),
        )).returning({ id: caseClaims.id });
        if (released.length !== 1) {
          throw new Error(
            `expired claimed receipt ${receipt.id} did not release exactly one unstarted claim`,
          );
        }
      }
      return true;
    }));
    if (isolated.ok && isolated.value) result.expired_receipts += 1;
  }

  const expiredGrants = await db.select().from(automationActionGrants)
    .where(and(
      eq(automationActionGrants.status, "issued"),
      lte(automationActionGrants.expiresAt, now),
      automationWritesOpenForProject(automationActionGrants.projectId),
    ))
    .orderBy(asc(automationActionGrants.expiresAt), asc(automationActionGrants.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const grant of expiredGrants) {
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "action_grant",
      recordId: grant.id,
      projectId: grant.projectId,
    }, () => atomicLifecycleTransition(db, async (tx) => {
      const expired = await tx.update(automationActionGrants).set({ status: "expired" })
        .where(and(
          eq(automationActionGrants.id, grant.id),
          eq(automationActionGrants.projectId, grant.projectId),
          eq(automationActionGrants.automationId, grant.automationId),
          eq(automationActionGrants.runId, grant.runId),
          eq(automationActionGrants.status, "issued"),
          lte(automationActionGrants.expiresAt, now),
          automationWritesOpenForProject(automationActionGrants.projectId),
        ))
        .returning({ id: automationActionGrants.id });
      if (expired.length === 0) return false;
      const run = (
        await tx.select().from(automationRuns)
          .where(eq(automationRuns.id, grant.runId)).limit(1)
      )[0];
      if (
        run &&
        run.projectId === grant.projectId &&
        run.automationId === grant.automationId
      ) {
        await closeRunInTransaction(
          tx,
          grant.runId,
          "draft_pr_grant_expired",
          "Draft-PR pre-action authorization expired before consumption.",
          now,
          ["running"],
        );
      }
      return true;
    }));
    if (isolated.ok && isolated.value) result.expired_action_grants += 1;
  }

  const expiredApprovals = await db.select().from(automationApprovals)
    .where(and(
      eq(automationApprovals.status, "pending"),
      lte(automationApprovals.expiresAt, now),
      automationWritesOpenForProject(automationApprovals.projectId),
    ))
    .orderBy(asc(automationApprovals.expiresAt), asc(automationApprovals.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const approval of expiredApprovals) {
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "approval",
      recordId: approval.id,
      projectId: approval.projectId,
    }, () => atomicLifecycleTransition(db, async (tx) => {
      const expired = await tx.update(automationApprovals).set({
        status: "expired",
        decisionReason: "Approval expired before an owner decision.",
        decidedAt: now,
      }).where(and(
        eq(automationApprovals.id, approval.id),
        eq(automationApprovals.projectId, approval.projectId),
        eq(automationApprovals.automationId, approval.automationId),
        eq(automationApprovals.runId, approval.runId),
        eq(automationApprovals.status, "pending"),
        lte(automationApprovals.expiresAt, now),
        automationWritesOpenForProject(automationApprovals.projectId),
      )).returning({ id: automationApprovals.id });
      if (expired.length === 0) return false;
      const run = (
        await tx.select().from(automationRuns)
          .where(eq(automationRuns.id, approval.runId)).limit(1)
      )[0];
      if (
        run &&
        run.projectId === approval.projectId &&
        run.automationId === approval.automationId
      ) {
        await closeRunInTransaction(
          tx,
          approval.runId,
          "approval_expired",
          "Approval expired before an owner decision.",
          now,
          ["awaiting_approval"],
        );
      }
      return true;
    }));
    if (isolated.ok && isolated.value) result.expired_approvals += 1;
  }

  const overdue = await db.select().from(automationRuns)
    .where(and(
      inArray(automationRuns.status, [...RUNNER_ACTIVE_STATUSES, "draft_pr_opened"]),
      lte(automationRuns.deadlineAt, now),
      automationWritesOpenForProject(automationRuns.projectId),
    ))
    .orderBy(asc(automationRuns.deadlineAt), asc(automationRuns.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const run of overdue) {
    const providerWait = run.status === "draft_pr_opened";
    const isolated = await isolateLifecycleRecord(result, {
      recordType: providerWait ? "provider_wait_run" : "runner_deadline_run",
      recordId: run.id,
      projectId: run.projectId,
    }, () => closeRun(
      db,
      run.id,
      providerWait
        ? "automation_provider_wait_deadline_exceeded"
        : "automation_run_deadline_exceeded",
      providerWait
        ? "The immutable run deadline elapsed while waiting for trusted CI proof or deploy binding."
        : "Maximum runtime elapsed before a server-owned terminal outcome.",
      now,
      providerWait ? ["draft_pr_opened"] : [...RUNNER_ACTIVE_STATUSES],
      providerWait ? {
        deadline_at: run.deadlineAt,
        pr_proof_recorded: run.prProofAt !== null,
        deploy_bound: run.deploySha !== null,
      } : { deadline_at: run.deadlineAt },
    ));
    if (!isolated.ok || !isolated.value) continue;
    if (providerWait) result.provider_wait_timeouts += 1;
    else result.overdue_runs += 1;
  }

  // Once CI has bound a deploy, max_wait_seconds from the immutable run policy
  // replaces the runner runtime deadline. The sweep owns terminal closure even
  // if no runner or human calls the verification endpoint again.
  const verificationCandidates = await db.select().from(automationRuns)
    .where(and(
      eq(automationRuns.status, "verifying"),
      automationWritesOpenForProject(automationRuns.projectId),
      or(
        isNull(automationRuns.verificationStartedAt),
        gt(automationRuns.verificationStartedAt, now),
        sql`json_type(
          CASE
            WHEN json_valid(${automationRuns.policySnapshotJson})
              THEN ${automationRuns.policySnapshotJson}
            ELSE '{}'
          END,
          '$.verification'
        ) IS NOT 'object'`,
        sql`json_type(
          CASE
            WHEN json_valid(${automationRuns.policySnapshotJson})
              THEN ${automationRuns.policySnapshotJson}
            ELSE '{}'
          END,
          '$.verification.max_wait_seconds'
        ) IS NOT 'integer'`,
        sql`cast(json_extract(
          CASE
            WHEN json_valid(${automationRuns.policySnapshotJson})
              THEN ${automationRuns.policySnapshotJson}
            ELSE '{}'
          END,
          '$.verification.max_wait_seconds'
        ) AS integer) NOT BETWEEN 60 AND 2592000`,
        sql`${automationRuns.verificationStartedAt} + cast(json_extract(
          CASE
            WHEN json_valid(${automationRuns.policySnapshotJson})
              THEN ${automationRuns.policySnapshotJson}
            ELSE '{}'
          END,
          '$.verification.max_wait_seconds'
        ) AS integer) <= ${now}`,
      ),
    ))
    .orderBy(
      asc(sql`coalesce(${automationRuns.verificationStartedAt}, 0)`),
      asc(automationRuns.id),
    )
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const run of verificationCandidates) {
    const policy = AutomationDefinitionSchema.safeParse(safeJson(run.policySnapshotJson));
    const verification = policy.success ? policy.data.verification : null;
    const validClock = run.verificationStartedAt !== null &&
      run.verificationStartedAt <= now &&
      verification !== undefined &&
      verification !== null;
    const deadlineAt = validClock
      ? run.verificationStartedAt! + verification.max_wait_seconds
      : null;
    if (deadlineAt !== null && deadlineAt > now) continue;
    const invalid = !validClock;
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "verification_run",
      recordId: run.id,
      projectId: run.projectId,
    }, () => closeRun(
      db,
      run.id,
      invalid
        ? "automation_verification_state_invalid"
        : "automation_verification_max_wait_exceeded",
      invalid
        ? "The verifying run lacks a valid immutable verification policy or deploy-anchored start time."
        : "The immutable verification max-wait elapsed without a terminal server verification result.",
      now,
      ["verifying"],
      {
        verification_started_at: run.verificationStartedAt,
        max_wait_seconds: verification?.max_wait_seconds ?? null,
        verification_deadline_at: deadlineAt,
        checked_at: now,
      },
    ));
    if (isolated.ok && isolated.value) {
      result.verification_timeouts += 1;
    }
  }

  const expiredClaims = await db.select().from(caseClaims)
    .where(and(
      isNull(caseClaims.releasedAt),
      lte(caseClaims.expiresAt, now),
      automationWritesOpenForProject(caseClaims.projectId),
    ))
    .orderBy(asc(caseClaims.expiresAt), asc(caseClaims.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const claim of expiredClaims) {
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "case_claim",
      recordId: claim.id,
      projectId: claim.projectId,
    }, () => atomicLifecycleTransition(db, async (tx) => {
      const changed = await tx.update(caseClaims).set({
        releasedAt: now,
        releaseReason: "cancelled",
      }).where(and(
        eq(caseClaims.id, claim.id),
        isNull(caseClaims.releasedAt),
        lte(caseClaims.expiresAt, now),
        automationWritesOpenForProject(caseClaims.projectId),
      )).returning({ id: caseClaims.id });
      if (changed.length === 0) return false;
      if (claim.runId) {
        await closeRunInTransaction(
          tx,
          claim.runId,
          "case_claim_expired",
          "Case ownership lease expired while runner work was active.",
          now,
          [...RUNNER_ACTIVE_STATUSES],
        );
      }
      return true;
    }));
    if (isolated.ok && isolated.value) result.expired_claims += 1;
  }

  // Filter kill-switch candidates before LIMIT. Enabled runs therefore never
  // consume the bounded page or hide a disabled/missing policy behind them.
  const killCandidates = await db.select({
    id: automationRuns.id,
    projectId: automationRuns.projectId,
  }).from(automationRuns)
    .where(and(
      inArray(automationRuns.status, [...ALL_NONTERMINAL_STATUSES]),
      automationWritesOpenForProject(automationRuns.projectId),
      automationPolicyDisabledForRun(
        automationRuns.projectId,
        automationRuns.automationId,
      ),
    ))
    .orderBy(asc(automationRuns.updatedAt), asc(automationRuns.id))
    .limit(LIFECYCLE_RECORD_LIMIT);
  for (const run of killCandidates) {
    const isolated = await isolateLifecycleRecord(result, {
      recordType: "kill_switch_run",
      recordId: run.id,
      projectId: run.projectId,
    }, () => closeRun(
      db,
      run.id,
      "automation_kill_switch_active",
      "The project or automation kill switch is active.",
      now,
      [...ALL_NONTERMINAL_STATUSES],
      {},
      automationPolicyDisabledForRun(
        automationRuns.projectId,
        automationRuns.automationId,
      ),
      true,
    ));
    if (isolated.ok && isolated.value) {
      result.killed_runs += 1;
    }
  }
  return result;
}

function automationPolicyDisabledForRun(
  projectId: SQLWrapper,
  automationId: SQLWrapper,
) {
  return sql`NOT EXISTS (
    SELECT 1
    FROM (
      SELECT
        *,
        CASE
          WHEN json_valid(document_json) THEN document_json
          ELSE '{}'
        END AS safe_document_json
      FROM automation_contracts
    ) AS current_contract
    JOIN json_each(current_contract.safe_document_json, '$.automations') AS configured_automation
    WHERE current_contract.project_id = ${projectId}
      AND current_contract.schema_version = ${AUTOMATION_CONTRACT_SCHEMA_VERSION}
      AND current_contract.enabled = 1
      AND current_contract.paused_at IS NULL
      AND json_extract(current_contract.safe_document_json, '$.enabled') = 1
      AND json_extract(current_contract.safe_document_json, '$.schema_version') = ${AUTOMATION_CONTRACT_SCHEMA_VERSION}
      AND json_type(current_contract.safe_document_json, '$.revision') = 'integer'
      AND json_type(current_contract.safe_document_json, '$.summary') = 'text'
      AND json_type(current_contract.safe_document_json, '$.automations') = 'array'
      AND json_extract(configured_automation.value, '$.id') = ${automationId}
      AND json_extract(configured_automation.value, '$.enabled') = 1
      AND json_type(configured_automation.value, '$.name') = 'text'
      AND json_type(configured_automation.value, '$.runner') = 'object'
      AND json_type(configured_automation.value, '$.trigger') = 'object'
      AND json_type(configured_automation.value, '$.allowed_actions') = 'array'
      AND json_type(configured_automation.value, '$.scope') = 'object'
      AND json_type(configured_automation.value, '$.budgets') = 'object'
      AND json_type(configured_automation.value, '$.approvals') = 'object'
      AND json_type(configured_automation.value, '$.escalation') = 'object'
      AND json_type(configured_automation.value, '$.failure_policy') = 'object'
      AND json_type(configured_automation.value, '$.data_boundary') = 'object'
  )`;
}

export interface AutomationTriggerSweepResult {
  projects: number;
  automations: number;
  issued: number;
  replayed: number;
  skipped: number;
  pages: number;
  page_limit: number;
  rotation_completed: boolean;
  continuation_conflicts: number;
  error_count: number;
  error_limit: number;
  errors: Array<{ project_id: string; automation_id: string; message: string }>;
  errors_truncated: boolean;
}

export interface AutomationTriggerSweepOptions {
  /** A smaller deterministic budget is useful for interruption/restart proof. */
  page_limit?: number;
}

/**
 * Evaluate enabled configured triggers in bounded, durable keyset pages.
 *
 * A revision-guarded database cursor commits after every page. A killed Worker
 * can therefore restart in a fresh isolate without returning to the first
 * tenant, while a repeated page remains safe through trigger idempotency.
 */
export async function issueAllAutomationTriggers(
  env: Env,
  now = Math.floor(Date.now() / 1_000),
  options: AutomationTriggerSweepOptions = {},
): Promise<AutomationTriggerSweepResult> {
  const db = getDb(env);
  const pageLimit = options.page_limit ?? TRIGGER_CONTRACT_PAGE_LIMIT;
  if (
    !Number.isInteger(pageLimit) ||
    pageLimit < 1 ||
    pageLimit > TRIGGER_CONTRACT_PAGE_LIMIT
  ) {
    throw new Error(
      `automation trigger sweep page_limit must be an integer from 1 to ${TRIGGER_CONTRACT_PAGE_LIMIT}`,
    );
  }
  const result: AutomationTriggerSweepResult = {
    projects: 0,
    automations: 0,
    issued: 0,
    replayed: 0,
    skipped: 0,
    pages: 0,
    page_limit: pageLimit,
    rotation_completed: false,
    continuation_conflicts: 0,
    error_count: 0,
    error_limit: LIFECYCLE_ERROR_LIMIT,
    errors: [],
    errors_truncated: false,
  };

  let continuation = await readAutomationTriggerContinuation(db, now);
  for (let page = 0; page < pageLimit; page += 1) {
    const rows = await db.select().from(automationContracts)
      .where(and(
        eq(automationContracts.enabled, 1),
        automationWritesOpenForProject(automationContracts.projectId),
        ...(continuation.cursorProjectId === null
          ? []
          : [gt(automationContracts.projectId, continuation.cursorProjectId)]),
      ))
      .orderBy(asc(automationContracts.projectId))
      .limit(TRIGGER_CONTRACT_PAGE_SIZE);
    if (rows.length === 0) {
      if (continuation.cursorProjectId === null) {
        result.rotation_completed = true;
        break;
      }
      const reset = await advanceAutomationTriggerContinuation(
        db,
        continuation,
        null,
        now,
      );
      if (!reset) result.continuation_conflicts += 1;
      else result.rotation_completed = true;
      break;
    }
    result.pages += 1;
    for (const row of rows) {
      const parsed = AutomationContractSchema.safeParse(safeJson(row.documentJson));
      if (!parsed.success) {
        recordTriggerSweepError(result, row.projectId, "*", "Stored automation contract is invalid.");
        continue;
      }
      if (!parsed.data.enabled || row.pausedAt !== null) continue;
      result.projects += 1;
      for (const automation of parsed.data.automations.filter((candidate) => candidate.enabled)) {
        result.automations += 1;
        try {
          const issued: TriggerIssuanceResult = await issueAutomationTriggerReceipts(
            db,
            row.projectId,
            automation.id,
            now,
          );
          result.issued += issued.issuedCount;
          result.replayed += issued.replayedCount;
          result.skipped += issued.skipped.length;
        } catch (error) {
          recordTriggerSweepError(
            result,
            row.projectId,
            automation.id,
            boundedAutomationSweepErrorMessage(error),
          );
        }
      }
    }

    const rotationCompleted = rows.length < TRIGGER_CONTRACT_PAGE_SIZE;
    const nextCursor = rotationCompleted ? null : rows[rows.length - 1]!.projectId;
    const advanced = await advanceAutomationTriggerContinuation(
      db,
      continuation,
      nextCursor,
      now,
    );
    if (!advanced) {
      // Another invocation committed equal-or-newer progress. Stop instead of
      // using a stale local page boundary; the winner owns continuation.
      result.continuation_conflicts += 1;
      break;
    }
    continuation = advanced;
    if (rotationCompleted) {
      result.rotation_completed = true;
      break;
    }
  }
  return result;
}

interface AutomationTriggerContinuation {
  cursorProjectId: string | null;
  revision: number;
}

async function readAutomationTriggerContinuation(
  db: ReturnType<typeof getDb>,
  now: number,
): Promise<AutomationTriggerContinuation> {
  await db.insert(automationSchedulerCursors).values({
    sweepName: TRIGGER_CONTRACT_SWEEP,
    cursorProjectId: null,
    revision: 0,
    updatedAt: now,
  }).onConflictDoNothing({ target: automationSchedulerCursors.sweepName });
  const row = (
    await db.select({
      cursorProjectId: automationSchedulerCursors.cursorProjectId,
      revision: automationSchedulerCursors.revision,
    }).from(automationSchedulerCursors)
      .where(eq(automationSchedulerCursors.sweepName, TRIGGER_CONTRACT_SWEEP))
      .limit(1)
  )[0];
  if (!row) throw new Error("automation trigger continuation initialization failed");
  return row;
}

async function advanceAutomationTriggerContinuation(
  db: ReturnType<typeof getDb>,
  current: AutomationTriggerContinuation,
  cursorProjectId: string | null,
  now: number,
): Promise<AutomationTriggerContinuation | null> {
  const revision = current.revision + 1;
  const changed = await db.update(automationSchedulerCursors).set({
    cursorProjectId,
    revision,
    updatedAt: now,
  }).where(and(
    eq(automationSchedulerCursors.sweepName, TRIGGER_CONTRACT_SWEEP),
    eq(automationSchedulerCursors.revision, current.revision),
    current.cursorProjectId === null
      ? isNull(automationSchedulerCursors.cursorProjectId)
      : eq(automationSchedulerCursors.cursorProjectId, current.cursorProjectId),
  )).returning({
    cursorProjectId: automationSchedulerCursors.cursorProjectId,
    revision: automationSchedulerCursors.revision,
  });
  return changed[0] ?? null;
}

async function closeRun(
  db: ReturnType<typeof getDb>,
  runId: string,
  errorCode: string,
  errorMessage: string,
  now: number,
  allowedStatuses: readonly AutomationRunStatus[],
  eventData: Record<string, unknown> = {},
  transitionGuard?: SQLWrapper,
  guardMissIsNoop = false,
): Promise<boolean> {
  return atomicLifecycleTransition(db, (tx) => closeRunInTransaction(
    tx,
    runId,
    errorCode,
    errorMessage,
    now,
    allowedStatuses,
    eventData,
    transitionGuard,
    guardMissIsNoop,
  ));
}

async function closeRunInTransaction(
  tx: AutomationHistoryTransaction,
  runId: string,
  errorCode: string,
  errorMessage: string,
  now: number,
  allowedStatuses: readonly AutomationRunStatus[],
  eventData: Record<string, unknown> = {},
  transitionGuard?: SQLWrapper,
  guardMissIsNoop = false,
): Promise<boolean> {
  const run = (
    await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1)
  )[0];
  if (!run || !allowedStatuses.includes(run.status)) return false;
  const transitioned = await tx.update(automationRuns).set({
    status: "escalated",
    errorCode,
    errorMessage,
    finishedAt: now,
    updatedAt: now,
  }).where(and(
    eq(automationRuns.id, run.id),
    eq(automationRuns.status, run.status),
    automationWritesOpenForProject(automationRuns.projectId),
    ...(transitionGuard ? [transitionGuard] : []),
  )).returning({ id: automationRuns.id });
  if (transitioned.length === 0) {
    if (guardMissIsNoop) return false;
    throw new Error(`automation lifecycle close lost the run status guard for ${run.id}`);
  }
  if (transitioned.length !== 1) {
    throw new Error(`automation lifecycle close changed ${transitioned.length} runs for ${run.id}`);
  }

  await tx.update(caseClaims).set({ releasedAt: now, releaseReason: "escalated" })
    .where(and(
      eq(caseClaims.runId, run.id),
      eq(caseClaims.projectId, run.projectId),
      eq(caseClaims.automationId, run.automationId),
      isNull(caseClaims.releasedAt),
    ));
  await tx.update(automationApprovals).set({
    status: "cancelled",
    decisionReason: errorMessage,
    decidedAt: now,
  }).where(and(
    eq(automationApprovals.runId, run.id),
    eq(automationApprovals.projectId, run.projectId),
    eq(automationApprovals.automationId, run.automationId),
    eq(automationApprovals.status, "pending"),
  ));
  await tx.update(automationActionGrants).set({ status: "cancelled" }).where(and(
    eq(automationActionGrants.runId, run.id),
    eq(automationActionGrants.projectId, run.projectId),
    eq(automationActionGrants.automationId, run.automationId),
    eq(automationActionGrants.status, "issued"),
  ));
  await appendAutomationRunEvent(tx, {
    projectId: run.projectId,
    runId: run.id,
    name: "run.escalated",
    fromStatus: run.status,
    toStatus: "escalated",
    actor: "agentry_system",
    data: { error_code: errorCode, error_message: errorMessage, ...eventData },
    at: now,
  });
  return true;
}

async function isolateLifecycleRecord<T>(
  result: AutomationLifecycleSweepResult,
  evidence: { recordType: string; recordId: string; projectId?: string | null },
  work: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    result.error_count += 1;
    if (result.errors.length < result.error_limit) {
      result.errors.push({
        record_type: evidence.recordType,
        record_id: evidence.recordId,
        project_id: evidence.projectId ?? null,
        message: boundedAutomationSweepErrorMessage(error),
      });
    }
    result.errors_truncated = result.error_count > result.error_limit;
    return { ok: false };
  }
}

function recordTriggerSweepError(
  result: AutomationTriggerSweepResult,
  projectId: string,
  automationId: string,
  message: string,
): void {
  result.error_count += 1;
  if (result.errors.length < result.error_limit) {
    result.errors.push({
      project_id: projectId,
      automation_id: automationId,
      message: boundedLifecycleMessage(message),
    });
  }
  result.errors_truncated = result.error_count > result.error_limit;
}

export function boundedAutomationSweepErrorMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string" && candidate.message) {
      message = candidate.message;
    }
    current = candidate.cause;
  }
  // Query wrappers may append bound values after a newline. Lifecycle evidence
  // records the provider/database failure, never SQL parameters or secrets.
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "automation lifecycle record failed";
  return boundedLifecycleMessage(firstLine
    .replace(/\s+params:\s*.*$/i, "")
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/g, "://[REDACTED]@")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:agentry_(?:pk|server|ci|runner)|sk|whsec)_[A-Za-z0-9._-]+\b/g, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|ph[ctx]_[A-Za-z0-9._-]+)\b/g, "[REDACTED]")
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]"));
}

function boundedLifecycleMessage(message: string): string {
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

const LIFECYCLE_BUSY_RETRY_MS = [1, 4, 16, 64] as const;

/**
 * A scheduled sweep can overlap a preceding invocation. Local libSQL reports
 * that collision as SQLITE_BUSY before either callback can observe the other
 * sweep's CAS. Retry the whole transaction after a short bounded backoff; the
 * row guards then make the loser a no-op. Any other error (including a failed
 * history append) is surfaced immediately and rolls the transition back.
 */
async function atomicLifecycleTransition<T>(
  db: ReturnType<typeof getDb>,
  work: (tx: AutomationHistoryTransaction) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await atomicAutomationHistory(db, work);
    } catch (error) {
      const delayMs = LIFECYCLE_BUSY_RETRY_MS[attempt];
      if (delayMs === undefined || !isSqliteBusy(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (code.startsWith("SQLITE_BUSY") || message.includes("SQLITE_BUSY") || message.includes("database is locked")) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
