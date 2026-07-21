import {
  and,
  asc,
  eq,
  gt,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  automationSchedulerCursors,
  automationWorkflowProjectControls,
  automationWorkflows,
} from "@agentry/db/schema";
import { AgentryError } from "@agentrysh/shared";
import { automationWritesOpenForProject } from "./automation-deletion-boundary.js";
import { getDb } from "./db.js";
import type { Env } from "./env.js";
import { issueAutomationWorkflowTriggerReceipts } from "./automation-workflow-triggers.js";

const SWEEP_NAME = "workflow_v3_trigger_receipts";
const DEFAULT_WORKFLOW_LIMIT = 100;
const MAX_WORKFLOW_LIMIT = 500;
const ERROR_LIMIT = 20;

type Db = ReturnType<typeof getDb>;

type SweepCursor = {
  project_id: string;
  automation_id: string;
};

type SweepContinuation = {
  cursor: SweepCursor | null;
  encoded_cursor: string | null;
  revision: number;
};

export interface AutomationWorkflowTriggerSweepOptions {
  /** Maximum eligible workflows evaluated by one invocation. */
  workflow_limit?: number;
}

export interface AutomationWorkflowTriggerSweepResult {
  kind: "automation_workflow_trigger_sweep";
  schema_version: "1";
  projects: number;
  workflows: number;
  workflow_limit: number;
  issued: number;
  replayed: number;
  skipped: number;
  rotation_completed: boolean;
  continuation_conflicts: number;
  error_count: number;
  error_limit: number;
  errors: Array<{
    project_id: string;
    automation_id: string;
    code: string;
    message: string;
    next_action: string;
    retryable: boolean;
  }>;
  errors_truncated: boolean;
  next_action: string;
}

/**
 * Evaluate one bounded, durable page of workflow-v3 trigger eligibility.
 *
 * This scheduler boundary may only ask the trigger-authority service to issue
 * immutable receipts. It never starts a run, leases runner work, calls a
 * customer agent/provider, advances a node, or executes/reconciles an effect.
 * The issuance service reloads and rechecks exact live authority inside its
 * transaction, so a pause or revision change after this read still fails
 * closed. Per-workflow failures are recorded and do not stop eligible siblings.
 */
export async function sweepAutomationWorkflowTriggerEligibility(
  env: Env,
  options: AutomationWorkflowTriggerSweepOptions = {},
): Promise<AutomationWorkflowTriggerSweepResult> {
  const workflowLimit = options.workflow_limit ?? DEFAULT_WORKFLOW_LIMIT;
  if (
    !Number.isInteger(workflowLimit) ||
    workflowLimit < 1 ||
    workflowLimit > MAX_WORKFLOW_LIMIT
  ) {
    throw new Error(
      `workflow-v3 trigger sweep workflow_limit must be an integer from 1 to ${MAX_WORKFLOW_LIMIT}`,
    );
  }

  const db = getDb(env);
  const result: AutomationWorkflowTriggerSweepResult = {
    kind: "automation_workflow_trigger_sweep",
    schema_version: "1",
    projects: 0,
    workflows: 0,
    workflow_limit: workflowLimit,
    issued: 0,
    replayed: 0,
    skipped: 0,
    rotation_completed: false,
    continuation_conflicts: 0,
    error_count: 0,
    error_limit: ERROR_LIMIT,
    errors: [],
    errors_truncated: false,
    next_action: "The bounded sweep completed. Customer runners may start only exact ready receipts with their automation-scoped runner credential.",
  };

  const continuation = await readContinuation(db);
  const cursorPredicate = continuation.cursor === null
    ? undefined
    : or(
      gt(automationWorkflows.projectId, continuation.cursor.project_id),
      and(
        eq(automationWorkflows.projectId, continuation.cursor.project_id),
        gt(automationWorkflows.automationId, continuation.cursor.automation_id),
      ),
    );

  // Read one look-ahead row so an exact-size final page can reset the cursor
  // immediately instead of spending the next minute on an empty tail page.
  const selected = await db.select({
    projectId: automationWorkflows.projectId,
    automationId: automationWorkflows.automationId,
  }).from(automationWorkflows).innerJoin(
    automationWorkflowProjectControls,
    eq(automationWorkflowProjectControls.projectId, automationWorkflows.projectId),
  ).where(and(
    eq(automationWorkflows.enabled, 1),
    isNull(automationWorkflows.pausedAt),
    eq(automationWorkflows.activeRevisionId, automationWorkflows.currentRevisionId),
    isNull(automationWorkflowProjectControls.pausedAt),
    automationWritesOpenForProject(automationWorkflows.projectId),
    cursorPredicate,
  )).orderBy(
    asc(automationWorkflows.projectId),
    asc(automationWorkflows.automationId),
  ).limit(workflowLimit + 1);

  const hasMore = selected.length > workflowLimit;
  const page = selected.slice(0, workflowLimit);
  const projects = new Set<string>();
  for (const row of page) {
    projects.add(row.projectId);
    result.workflows += 1;
    try {
      const issuance = await issueAutomationWorkflowTriggerReceipts(db, {
        project_id: row.projectId,
        automation_id: row.automationId,
      });
      result.issued += issuance.issued_count;
      result.replayed += issuance.replayed_count;
      result.skipped += issuance.skipped.length;
    } catch (error) {
      recordFailure(result, row.projectId, row.automationId, error);
    }
  }
  result.projects = projects.size;

  const nextCursor = hasMore && page.length > 0
    ? {
      project_id: page[page.length - 1]!.projectId,
      automation_id: page[page.length - 1]!.automationId,
    }
    : null;
  const advanced = await advanceContinuation(db, continuation, nextCursor);
  if (!advanced) {
    // An overlapping invocation committed equal-or-newer progress. Receipts
    // remain safe through issuance idempotency; the winner owns continuation.
    result.continuation_conflicts = 1;
  } else {
    result.rotation_completed = nextCursor === null;
  }
  if (result.error_count > 0) {
    result.next_action = "Inspect the bounded per-workflow errors and repair only those workflows. Other eligible workflows were still evaluated, and no run or external effect was started.";
  } else if (!result.rotation_completed) {
    result.next_action = "The sweep made bounded progress. Let the next minute invocation resume from the durable continuation; do not synthesize receipts or start provider work from the scheduler.";
  }
  return result;
}

async function readContinuation(db: Db, repairAttempt = 0): Promise<SweepContinuation> {
  const now = await databaseNow(db);
  await db.insert(automationSchedulerCursors).values({
    sweepName: SWEEP_NAME,
    cursorProjectId: null,
    revision: 0,
    updatedAt: now,
  }).onConflictDoNothing({ target: automationSchedulerCursors.sweepName });
  const row = (
    await db.select({
      encodedCursor: automationSchedulerCursors.cursorProjectId,
      revision: automationSchedulerCursors.revision,
    }).from(automationSchedulerCursors).where(
      eq(automationSchedulerCursors.sweepName, SWEEP_NAME),
    ).limit(1)
  )[0];
  if (!row) throw new Error("workflow-v3 trigger sweep continuation initialization failed");
  try {
    return {
      cursor: decodeCursor(row.encodedCursor),
      encoded_cursor: row.encodedCursor,
      revision: row.revision,
    };
  } catch (error) {
    // Continuation carries no trigger authority. Resetting a malformed value is
    // safer than permanently wedging the scheduler, and receipt idempotency
    // makes re-evaluating from the beginning harmless.
    if (repairAttempt >= 2) throw error;
    const repaired = await db.update(automationSchedulerCursors).set({
      cursorProjectId: null,
      revision: row.revision + 1,
      updatedAt: await databaseNow(db),
    }).where(and(
      eq(automationSchedulerCursors.sweepName, SWEEP_NAME),
      eq(automationSchedulerCursors.revision, row.revision),
      row.encodedCursor === null
        ? isNull(automationSchedulerCursors.cursorProjectId)
        : eq(automationSchedulerCursors.cursorProjectId, row.encodedCursor),
    )).returning({ sweepName: automationSchedulerCursors.sweepName });
    if (repaired.length === 1) {
      return { cursor: null, encoded_cursor: null, revision: row.revision + 1 };
    }
    return readContinuation(db, repairAttempt + 1);
  }
}

async function advanceContinuation(
  db: Db,
  current: SweepContinuation,
  next: SweepCursor | null,
): Promise<boolean> {
  const encoded = encodeCursor(next);
  const changed = await db.update(automationSchedulerCursors).set({
    cursorProjectId: encoded,
    revision: current.revision + 1,
    updatedAt: await databaseNow(db),
  }).where(and(
    eq(automationSchedulerCursors.sweepName, SWEEP_NAME),
    eq(automationSchedulerCursors.revision, current.revision),
    current.encoded_cursor === null
      ? isNull(automationSchedulerCursors.cursorProjectId)
      : eq(automationSchedulerCursors.cursorProjectId, current.encoded_cursor),
  )).returning({ sweepName: automationSchedulerCursors.sweepName });
  return changed.length === 1;
}

function encodeCursor(cursor: SweepCursor | null): string | null {
  return cursor === null ? null : JSON.stringify([cursor.project_id, cursor.automation_id]);
}

function decodeCursor(encoded: string | null): SweepCursor | null {
  if (encoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("workflow-v3 trigger sweep continuation is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    parsed[0].length === 0 ||
    typeof parsed[1] !== "string" ||
    parsed[1].length === 0
  ) {
    throw new Error("workflow-v3 trigger sweep continuation is invalid");
  }
  return { project_id: parsed[0], automation_id: parsed[1] };
}

async function databaseNow(db: Db): Promise<number> {
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(clock.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("database clock did not return unix seconds");
  }
  return now;
}

function recordFailure(
  result: AutomationWorkflowTriggerSweepResult,
  projectId: string,
  automationId: string,
  error: unknown,
): void {
  result.error_count += 1;
  if (result.errors.length < result.error_limit) {
    const isAgentryError = error instanceof AgentryError;
    result.errors.push({
      project_id: projectId,
      automation_id: automationId,
      code: isAgentryError
        ? error.code
        : "automation_workflow_trigger_sweep_record_failed",
      message: safeErrorMessage(error),
      next_action: isAgentryError && error.nextAction
        ? safeErrorMessage(error.nextAction)
        : "Inspect this workflow and retry through the next bounded eligibility sweep. Do not synthesize a receipt or start work without one.",
      retryable: isAgentryError ? error.status >= 500 : true,
    });
  }
  result.errors_truncated = result.error_count > result.error_limit;
}

function safeErrorMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { message?: unknown; cause?: unknown };
    if (typeof candidate.message === "string" && candidate.message.length > 0) {
      message = candidate.message;
    }
    current = candidate.cause;
  }
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "workflow-v3 trigger eligibility failed";
  const redacted = firstLine
    .replace(/\s+params:\s*.*$/iu, "")
    .replace(/:\/\/[^/\s:@]+:[^@\s/]+@/gu, "://[REDACTED]@")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:agentry_(?:pk|server|ci|runner)|sk|whsec)_[A-Za-z0-9._-]+\b/gu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|ph[ctx]_[A-Za-z0-9._-]+)\b/gu, "[REDACTED]")
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]");
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 497)}...`;
}
