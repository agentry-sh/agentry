import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  canonicalJsonStringify,
  uuidv7,
  type AutomationRunStatus,
} from "@agentrysh/shared";
import {
  automationRunEvents,
  automationRuns,
} from "@agentry/db/schema";
import type { getDb } from "./db.js";
import { automationWritesOpenForProject } from "./automation-deletion-boundary.js";

type AutomationDb = ReturnType<typeof getDb>;
export type AutomationHistoryTransaction = Parameters<
  Parameters<AutomationDb["transaction"]>[0]
>[0];
type AutomationRunInsert = typeof automationRuns.$inferInsert;
type AutomationRunRow = typeof automationRuns.$inferSelect;

/**
 * Mutable run fields that may accompany one history event. Identity,
 * authorization snapshots, trigger authority, request hashes, and creation
 * timestamps are deliberately absent: history mutations cannot rewrite the
 * authority that created a run.
 */
export type AtomicAutomationRunPatch = Partial<
  Pick<
    AutomationRunInsert,
    | "runnerProvider"
    | "runnerId"
    | "runnerCredentialId"
    | "model"
    | "branch"
    | "commitSha"
    | "prUrl"
    | "deploySha"
    | "summaryMd"
    | "evidenceJson"
    | "verificationJson"
    | "verificationStartedAt"
    | "prProofJson"
    | "prProofHash"
    | "prProofCredentialId"
    | "prProofAt"
    | "turnsUsed"
    | "costMicros"
    | "usageSequence"
    | "deadlineAt"
    | "lastHeartbeatAt"
    | "retryEligibleAt"
    | "errorCode"
    | "errorMessage"
    | "startedAt"
    | "finishedAt"
  >
>;

export interface AtomicAutomationRunMutation {
  runId: string;
  expectedStatus: AutomationRunStatus;
  nextStatus: AutomationRunStatus;
  patch?: AtomicAutomationRunPatch;
  /**
   * Required for a same-status evidence mutation. The guard must stop matching
   * after the write (for example `isNull(automationRuns.prProofHash)`) so a
   * replay cannot append the event twice.
   */
  guard?: SQL;
  /** Only authority-reducing deletion/lifecycle cleanup may bypass the fence. */
  allowDuringProjectDeletion?: boolean;
  event: {
    id?: string;
    name: string;
    actor: string;
    data?: Record<string, unknown>;
  };
  at: number;
}

export type AtomicAutomationRunMutationResult =
  | {
      applied: true;
      run: AutomationRunRow;
      eventId: string;
    }
  | {
      applied: false;
      run: null;
      eventId: null;
    };

export interface AutomationRunEventInput {
  id?: string;
  projectId: string;
  runId: string;
  name: string;
  fromStatus: AutomationRunStatus | null;
  toStatus: AutomationRunStatus;
  actor: string;
  data?: Record<string, unknown>;
  at: number;
}

/**
 * Run a compound automation ledger mutation in one interactive libSQL
 * transaction. Callers must check every compare-and-set result and throw on a
 * lost guard; the throw rolls all related authority, domain state, and history
 * writes back together.
 *
 * Use this only when a transition also owns another local row (for example a
 * claim, approval, action grant, case, receipt, or budget charge). A run-only
 * transition should use `mutateAutomationRunWithEvent` below.
 */
export async function atomicAutomationHistory<T>(
  db: AutomationDb,
  work: (tx: AutomationHistoryTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(work);
}

/** Append one canonical event from inside `atomicAutomationHistory`. */
export async function appendAutomationRunEvent(
  tx: AutomationHistoryTransaction,
  input: AutomationRunEventInput,
): Promise<string> {
  assertEventInput(input);
  const id = input.id ?? uuidv7();
  const inserted = await tx
    .insert(automationRunEvents)
    .values({
      id,
      projectId: input.projectId,
      runId: input.runId,
      event: input.name,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      actor: input.actor,
      dataJson: canonicalJsonStringify(input.data ?? {}),
      at: input.at,
    })
    .returning({ id: automationRunEvents.id });
  if (inserted.length !== 1) {
    throw new Error(`automation history event insert invariant failed: inserted=${inserted.length}`);
  }
  return id;
}

/**
 * Compare-and-set one automation run and append its immutable history event in
 * the same libSQL transaction.
 *
 * Invariants:
 * - a lost CAS writes neither state nor event;
 * - an event insert failure rolls the state mutation back;
 * - a successful mutation cannot commit without exactly one event;
 * - retrying a completed status transition is a no-op.
 *
 * This uses Drizzle/libSQL's atomic batch API. `changes()` in the event SELECT
 * observes the immediately preceding primary-key UPDATE in the same database
 * batch: zero changed rows yields zero events, while an event constraint error
 * rolls the entire batch back. A primary-key predicate caps the update at one.
 */
export async function mutateAutomationRunWithEvent(
  db: AutomationDb,
  input: AtomicAutomationRunMutation,
): Promise<AtomicAutomationRunMutationResult> {
  assertMutationInput(input);
  const eventId = input.event.id ?? uuidv7();
  const dataJson = canonicalJsonStringify(input.event.data ?? {});

  const mutation = db
    .update(automationRuns)
    .set({
      ...(input.patch ?? {}),
      status: input.nextStatus,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(automationRuns.id, input.runId),
        eq(automationRuns.status, input.expectedStatus),
        input.allowDuringProjectDeletion
          ? undefined
          : automationWritesOpenForProject(automationRuns.projectId),
        input.guard,
      ),
    )
    .returning();

  const eventWrite = db
    .insert(automationRunEvents)
    .select(
      db
        .select({
          id: sql<string>`${eventId}`.as("id"),
          projectId: automationRuns.projectId,
          runId: automationRuns.id,
          event: sql<string>`${input.event.name}`.as("event"),
          fromStatus: sql<string>`${input.expectedStatus}`.as("from_status"),
          toStatus: sql<string>`${input.nextStatus}`.as("to_status"),
          actor: sql<string>`${input.event.actor}`.as("actor"),
          dataJson: sql<string>`${dataJson}`.as("data_json"),
          at: sql<number>`${input.at}`.as("at"),
        })
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.id, input.runId),
            // libSQL batches execute sequentially in one transaction. This is
            // the row count of `mutation`, not a caller-supplied assertion.
            sql`changes() = 1`,
          ),
        ),
    )
    .returning({ id: automationRunEvents.id });

  const [changed, events] = await db.batch([mutation, eventWrite] as const);
  if (changed.length === 0 && events.length === 0) {
    return { applied: false, run: null, eventId: null };
  }
  if (changed.length !== 1 || events.length !== 1) {
    // Both statements already ran atomically. This can only indicate a broken
    // database/runtime `changes()` contract and must never be treated as a
    // successful history mutation.
    throw new Error(
      `automation history batch invariant failed: changed=${changed.length}, events=${events.length}`,
    );
  }
  return { applied: true, run: changed[0]!, eventId };
}

function assertMutationInput(input: AtomicAutomationRunMutation): void {
  if (!input.runId.trim()) throw new Error("automation history mutation requires runId");
  assertEventInput({
    projectId: "validation",
    runId: input.runId,
    name: input.event.name,
    fromStatus: input.expectedStatus,
    toStatus: input.nextStatus,
    actor: input.event.actor,
    data: input.event.data,
    at: input.at,
  });
  if (
    input.expectedStatus === input.nextStatus &&
    (!input.guard || !hasDefinedPatchValue(input.patch))
  ) {
    throw new Error(
      "same-status automation history mutations require a one-time guard and a state patch",
    );
  }
}

function assertEventInput(input: AutomationRunEventInput): void {
  if (!input.projectId.trim() || !input.runId.trim()) {
    throw new Error("automation history event requires projectId and runId");
  }
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(input.name)) {
    throw new Error("automation history event name must be a bounded canonical identifier");
  }
  if (!input.actor.trim() || input.actor.length > 256) {
    throw new Error("automation history event actor must be between 1 and 256 characters");
  }
  if (!Number.isSafeInteger(input.at) || input.at < 0) {
    throw new Error("automation history mutation timestamp must be a non-negative unix second");
  }
}

function hasDefinedPatchValue(patch: AtomicAutomationRunPatch | undefined): boolean {
  return Boolean(
    patch && Object.values(patch).some((value) => value !== undefined),
  );
}
