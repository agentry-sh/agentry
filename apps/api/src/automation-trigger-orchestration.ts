import { and, desc, eq, gt, isNotNull, lte, ne, sql } from "drizzle-orm";
import {
  TELEMETRY_DATA_BOUNDARY,
  canonicalJsonStringify,
  cronMatches,
  cronOccurrenceEpochMinute,
  errors,
  prepareTelemetryObservation,
  sha256Hex,
  uuidv7,
  type AutomationDefinition,
} from "@agentrysh/shared";
import {
  alerts,
  automationContracts,
  automationTriggerReceipts,
  automationTriggerStates,
  caseClaims,
  cases,
  posthogConnections,
  type AutomationTriggerReceipt,
  type AutomationTriggerState,
} from "@agentry/db/schema";
import type { getDb } from "./db.js";
import {
  findAutomation,
  isAutomationContractEnabled,
  loadAutomationContract,
  type LoadedAutomationContract,
} from "./automation-contracts.js";
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "./automation-deletion-boundary.js";

type Db = ReturnType<typeof getDb>;

export interface TriggerIssuanceResult {
  automationId: string;
  triggerKind: "alert" | "unhandled_cases" | "schedule";
  receipts: AutomationTriggerReceipt[];
  issuedCount: number;
  replayedCount: number;
  skipped: Array<{ code: string; reason: string; details?: Record<string, unknown> }>;
  cooldownUntil: number | null;
}

interface IssueContext {
  db: Db;
  projectId: string;
  loaded: LoadedAutomationContract;
  automation: AutomationDefinition;
  now: number;
  triggerHash: string;
  state: AutomationTriggerState | null;
}

const RECEIPT_LIFETIME_SECONDS = 3_600;
const TERMINAL_OR_ACTIVE_RUN_BLOCK_SQL = sql.raw(
  "('queued','claimed','running','draft_pr_opened','awaiting_approval','verifying','succeeded','escalated')",
);

/**
 * Issue durable, single-use trigger receipts from server-observed state.
 * Runners can request a sweep, but they cannot supply trigger facts, case
 * revisions, trust labels, alert outcomes, or schedule occurrences.
 */
export async function issueAutomationTriggerReceipts(
  db: Db,
  projectId: string,
  automationId: string,
  now = Math.floor(Date.now() / 1_000),
): Promise<TriggerIssuanceResult> {
  await assertAutomationWritesOpen(db, projectId);
  const loaded = await loadAutomationContract(db, projectId);
  if (!loaded || !isAutomationContractEnabled(loaded)) {
    throw errors.conflict(
      "automation_paused",
      "The project has no enabled automation v2 contract.",
      "Stop unattended work. Ask an owner to save and explicitly enable a valid contract, then request a new trigger receipt.",
      { project_id: projectId, paused_at: loaded?.row.pausedAt ?? null },
    );
  }
  const automation = findAutomation(loaded, automationId);
  if (!automation || !automation.enabled) {
    throw errors.conflict(
      "automation_disabled",
      "The requested automation is absent or disabled in the current contract.",
      "Reload the contract and select an enabled automation id. Do not substitute another automation's authority.",
      { automation_id: automationId, contract_revision: loaded.row.revision },
    );
  }

  await expireAndCancelStaleReceipts(db, projectId, automation.id, loaded.row.etag, now);
  const triggerHash = await sha256Hex(canonicalJsonStringify(automation.trigger));
  const rawState = (
    await db
      .select()
      .from(automationTriggerStates)
      .where(and(
        eq(automationTriggerStates.projectId, projectId),
        eq(automationTriggerStates.automationId, automation.id),
      ))
      .limit(1)
  )[0] ?? null;
  const state = stateMatchesPolicy(rawState, loaded, triggerHash) ? rawState : null;
  const context: IssueContext = {
    db,
    projectId,
    loaded,
    automation,
    now,
    triggerHash,
    state,
  };

  if (automation.trigger.kind === "unhandled_cases") {
    return issueUnhandledCaseReceipts(context);
  }
  if (automation.trigger.kind === "alert") {
    return issueAlertReceipt(context);
  }
  return issueScheduleReceipt(context);
}

async function issueUnhandledCaseReceipts(context: IssueContext): Promise<TriggerIssuanceResult> {
  const { db, projectId, loaded, automation, now, triggerHash, state } = context;
  if (automation.trigger.kind !== "unhandled_cases") throw new Error("unreachable trigger kind");

  const currentReady = await db
    .select()
    .from(automationTriggerReceipts)
    .where(and(
      eq(automationTriggerReceipts.projectId, projectId),
      eq(automationTriggerReceipts.automationId, automation.id),
      eq(automationTriggerReceipts.contractEtag, loaded.row.etag),
      eq(automationTriggerReceipts.status, "ready"),
      gt(automationTriggerReceipts.expiresAt, now),
      sql`EXISTS (
        SELECT 1 FROM ${cases} AS current_case
        WHERE current_case.id = ${automationTriggerReceipts.caseId}
          AND current_case.project_id = ${projectId}
          AND current_case.revision = ${automationTriggerReceipts.caseRevision}
          AND current_case.status = 'active'
          AND current_case.provider_event_classification = 'customer_exception'
      )`,
    ))
    .orderBy(desc(automationTriggerReceipts.issuedAt))
    .limit(automation.trigger.max_cases_per_sweep);

  if (state?.cooldownUntil && state.cooldownUntil > now) {
    return {
      automationId: automation.id,
      triggerKind: "unhandled_cases",
      receipts: currentReady,
      issuedCount: 0,
      replayedCount: currentReady.length,
      skipped: [{
        code: "trigger_cooldown_active",
        reason: "The server-owned sweep cooldown has not elapsed.",
        details: { cooldown_until: state.cooldownUntil },
      }],
      cooldownUntil: state.cooldownUntil,
    };
  }

  const trustCondition = automation.trigger.required_trust === "customer_posthog"
      ? and(
        eq(cases.lastTrustLevel, "customer_posthog"),
        eq(cases.lastCredentialKind, "posthog_oauth"),
        sql`EXISTS (
          SELECT 1 FROM ${posthogConnections} AS active_posthog_connection
          WHERE active_posthog_connection.project_id = ${cases.projectId}
            AND active_posthog_connection.status = 'active'
        )`,
      )
    : undefined;
  const maximumAttempts = automation.budgets.max_attempts_per_case_revision;
  const retryBackoff = automation.failure_policy.retry_backoff_seconds;
  const candidates = await db
    .select()
    .from(cases)
    .where(and(
      eq(cases.projectId, projectId),
      eq(cases.status, "active"),
      eq(cases.providerEventClassification, "customer_exception"),
      trustCondition,
      sql`NOT EXISTS (
        SELECT 1 FROM case_claims AS active_claim
        WHERE active_claim.case_id = ${cases.id}
          AND active_claim.case_revision = ${cases.revision}
          AND active_claim.released_at IS NULL
          AND active_claim.expires_at > ${now}
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM automation_trigger_receipts AS ready_receipt
        WHERE ready_receipt.case_id = ${cases.id}
          AND ready_receipt.case_revision = ${cases.revision}
          AND ready_receipt.automation_id = ${automation.id}
          AND ready_receipt.status = 'ready'
          AND ready_receipt.expires_at > ${now}
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM automation_runs AS blocking_run
        WHERE blocking_run.case_id = ${cases.id}
          AND blocking_run.case_revision = ${cases.revision}
          AND blocking_run.automation_id = ${automation.id}
          AND (
            blocking_run.status IN ${TERMINAL_OR_ACTIVE_RUN_BLOCK_SQL}
            OR COALESCE(
              blocking_run.retry_eligible_at,
              blocking_run.updated_at + ${retryBackoff}
            ) > ${now}
          )
      )`,
      sql`COALESCE((
        SELECT MAX(previous_claim.attempt)
        FROM case_claims AS previous_claim
        WHERE previous_claim.case_id = ${cases.id}
          AND previous_claim.case_revision = ${cases.revision}
      ), 0) < ${maximumAttempts}`,
    ))
    .orderBy(desc(cases.lastSeenAt), desc(cases.id))
    .limit(automation.trigger.max_cases_per_sweep);

  const receipts: AutomationTriggerReceipt[] = [...currentReady];
  let issuedCount = 0;
  let replayedCount = currentReady.length;
  for (const caseRow of candidates) {
    const attempt = await nextCaseAttempt(
      db,
      caseRow.id,
      caseRow.revision,
    );
    if (attempt > maximumAttempts) continue;
    const triggerKey = caseTriggerKey(
      loaded.row.revision,
      caseRow.id,
      caseRow.revision,
      attempt,
      Math.floor(now / automation.trigger.cooldown_seconds),
    );
    const observation = prepareTelemetryObservation({
      error_type: caseRow.errorType,
      message: caseRow.message,
      event_count: caseRow.eventCount,
      first_seen_at: caseRow.firstSeenAt,
      last_seen_at: caseRow.lastSeenAt,
      last_deploy_sha: caseRow.lastDeploySha,
    });
    const snapshot = await triggerSnapshot(
      {
        trigger_kind: "unhandled_cases",
        project_id: projectId,
        automation_id: automation.id,
        contract_revision: loaded.row.revision,
        contract_etag: loaded.row.etag,
        case_id: caseRow.id,
        case_revision: caseRow.revision,
        attempt,
        required_trust: automation.trigger.required_trust,
        observed_trust: caseRow.lastTrustLevel,
      },
      observation,
      "case telemetry",
    );
    const inserted = await insertReceiptIdempotently(db, {
      id: uuidv7(),
      projectId,
      automationId: automation.id,
      contractRevision: loaded.row.revision,
      contractEtag: loaded.row.etag,
      triggerKind: "unhandled_cases",
      triggerKey,
      caseId: caseRow.id,
      caseRevision: caseRow.revision,
      attempt,
      alertId: null,
      scheduledFor: null,
      requiredTrust: automation.trigger.required_trust,
      sourceTrust: caseRow.lastTrustLevel,
      snapshotJson: snapshot.json,
      snapshotHash: snapshot.hash,
      status: "ready",
      claimId: null,
      runId: null,
      issuedAt: now,
      notBeforeAt: now,
      expiresAt: now + RECEIPT_LIFETIME_SECONDS,
      claimedAt: null,
      consumedAt: null,
      cancelledAt: null,
      cancelReason: null,
    });
    if (receipts.some((receipt) => receipt.id === inserted.receipt.id)) continue;
    receipts.push(inserted.receipt);
    if (inserted.inserted) issuedCount += 1;
    else replayedCount += 1;
  }

  const cooldownUntil = issuedCount > 0
    ? now + automation.trigger.cooldown_seconds
    : state?.cooldownUntil ?? null;
  await upsertTriggerState(context, {
    triggerRef: "project_open_cases",
    cooldownUntil,
    lastReceiptAt: issuedCount > 0 ? now : state?.lastReceiptAt ?? null,
  });
  return {
    automationId: automation.id,
    triggerKind: "unhandled_cases",
    receipts,
    issuedCount,
    replayedCount,
    skipped: receipts.length === 0
      ? [{ code: "no_eligible_cases", reason: "No active case satisfies trust, ownership, retry, classification, and attempt-budget gates." }]
      : [],
    cooldownUntil,
  };
}

async function issueAlertReceipt(context: IssueContext): Promise<TriggerIssuanceResult> {
  const { db, projectId, loaded, automation, now, state } = context;
  if (automation.trigger.kind !== "alert") throw new Error("unreachable trigger kind");
  const alert = (
    await db
      .select()
      .from(alerts)
      .where(and(
        eq(alerts.id, automation.trigger.alert_id),
        eq(alerts.projectId, projectId),
      ))
      .limit(1)
  )[0];
  if (!alert || alert.active !== 1) {
    throw errors.conflict(
      "alert_trigger_unavailable",
      "The configured alert does not exist in this project or is inactive.",
      "Ask an owner to repair the alert_id or re-enable the alert, then request a new trigger receipt.",
      { alert_id: automation.trigger.alert_id },
    );
  }

  const evaluatedAt = alert.lastEvaluatedAt;
  const observedNewEvaluation = evaluatedAt !== null && evaluatedAt !== state?.lastSourceEvaluatedAt;
  const nextConsecutive = observedNewEvaluation
    ? alert.lastState === "triggered"
      ? (state?.consecutiveBreaches ?? 0) + 1
      : 0
    : state?.consecutiveBreaches ?? 0;
  const baseState = {
    triggerRef: alert.id,
    lastSourceEvaluatedAt: evaluatedAt ?? state?.lastSourceEvaluatedAt ?? null,
    lastOutcome: alert.lastState ?? null,
    consecutiveBreaches: nextConsecutive,
    cooldownUntil: state?.cooldownUntil ?? null,
    lastReceiptAt: state?.lastReceiptAt ?? null,
  };

  if (evaluatedAt === null) {
    await upsertTriggerState(context, baseState);
    return skippedResult(automation.id, "alert", "alert_not_evaluated", "The alert has no server evaluation yet.");
  }
  if (alert.lastState !== "triggered") {
    await upsertTriggerState(context, { ...baseState, cooldownUntil: null });
    return skippedResult(automation.id, "alert", "alert_not_breaching", "The latest server evaluation is recovered.");
  }
  if (!observedNewEvaluation) {
    const triggerKey = alertTriggerKey(loaded.row.revision, alert.id, evaluatedAt);
    const existing = await receiptByTriggerKey(db, projectId, automation.id, triggerKey);
    await upsertTriggerState(context, baseState);
    return existing
      ? replayResult(automation.id, "alert", existing, state?.cooldownUntil ?? null)
      : skippedResult(
        automation.id,
        "alert",
        "alert_evaluation_already_observed",
        "This alert evaluation was already observed and did not produce a receipt.",
      );
  }
  if (nextConsecutive < automation.trigger.min_consecutive_breaches) {
    await upsertTriggerState(context, baseState);
    return skippedResult(
      automation.id,
      "alert",
      "consecutive_breach_gate_not_met",
      "The alert has not reached the configured consecutive-breach threshold.",
      {
        observed: nextConsecutive,
        required: automation.trigger.min_consecutive_breaches,
      },
    );
  }
  if (state?.cooldownUntil && state.cooldownUntil > now) {
    await upsertTriggerState(context, baseState);
    return skippedResult(
      automation.id,
      "alert",
      "trigger_cooldown_active",
      "The server-owned alert cooldown has not elapsed.",
      { cooldown_until: state.cooldownUntil },
      state.cooldownUntil,
    );
  }

  const triggerKey = alertTriggerKey(loaded.row.revision, alert.id, evaluatedAt);
  const observation = prepareTelemetryObservation({
    alert_name: alert.name,
    description: alert.description,
    blueprint_id: alert.recipeId,
    params: safeJson(alert.paramsJson),
    threshold: {
      column: alert.thresholdColumn,
      operator: alert.thresholdOp,
      value: alert.thresholdValue,
    },
    last_value: alert.lastValue,
    last_state: alert.lastState,
  });
  const snapshot = await triggerSnapshot(
    {
      trigger_kind: "alert",
      project_id: projectId,
      automation_id: automation.id,
      contract_revision: loaded.row.revision,
      contract_etag: loaded.row.etag,
      alert_id: alert.id,
      evaluated_at: evaluatedAt,
      consecutive_breaches: nextConsecutive,
      required_trust: automation.trigger.required_trust,
      observed_trust: "agentry_system",
    },
    observation,
    "alert definition, params, and query result annotation",
  );
  const inserted = await insertReceiptIdempotently(db, {
    id: uuidv7(),
    projectId,
    automationId: automation.id,
    contractRevision: loaded.row.revision,
    contractEtag: loaded.row.etag,
    triggerKind: "alert",
    triggerKey,
    caseId: null,
    caseRevision: null,
    attempt: null,
    alertId: alert.id,
    scheduledFor: null,
    requiredTrust: automation.trigger.required_trust,
    sourceTrust: "agentry_system",
    snapshotJson: snapshot.json,
    snapshotHash: snapshot.hash,
    status: "ready",
    claimId: null,
    runId: null,
    issuedAt: now,
    notBeforeAt: now,
    expiresAt: now + RECEIPT_LIFETIME_SECONDS,
    claimedAt: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
  });
  const cooldownUntil = now + automation.trigger.cooldown_seconds;
  await upsertTriggerState(context, {
    ...baseState,
    cooldownUntil,
    lastReceiptAt: now,
  });
  return {
    automationId: automation.id,
    triggerKind: "alert",
    receipts: [inserted.receipt],
    issuedCount: inserted.inserted ? 1 : 0,
    replayedCount: inserted.inserted ? 0 : 1,
    skipped: [],
    cooldownUntil,
  };
}

async function issueScheduleReceipt(context: IssueContext): Promise<TriggerIssuanceResult> {
  const { db, projectId, loaded, automation, now, state } = context;
  if (automation.trigger.kind !== "schedule") throw new Error("unreachable trigger kind");
  const scheduledFor = findLatestScheduleOccurrence(
    automation.trigger.cron,
    automation.trigger.timezone,
    now,
    automation.trigger.start_window_seconds,
  );
  if (scheduledFor === null) {
    await upsertTriggerState(context, {
      triggerRef: `${automation.trigger.cron}@${automation.trigger.timezone}`,
      lastScheduleSlot: state?.lastScheduleSlot ?? null,
    });
    return skippedResult(
      automation.id,
      "schedule",
      "schedule_not_due",
      "No cron occurrence falls inside the configured start window.",
    );
  }
  const slot = Math.floor(scheduledFor / 60);
  const triggerKey = scheduleTriggerKey(loaded.row.revision, slot);
  const existing = await receiptByTriggerKey(db, projectId, automation.id, triggerKey);
  if (existing) {
    await upsertTriggerState(context, {
      triggerRef: `${automation.trigger.cron}@${automation.trigger.timezone}`,
      lastScheduleSlot: Math.max(state?.lastScheduleSlot ?? 0, slot),
      lastReceiptAt: state?.lastReceiptAt ?? existing.issuedAt,
    });
    return replayResult(automation.id, "schedule", existing, null);
  }

  const snapshot = await triggerSnapshot(
    {
      trigger_kind: "schedule",
      project_id: projectId,
      automation_id: automation.id,
      contract_revision: loaded.row.revision,
      contract_etag: loaded.row.etag,
      scheduled_for: scheduledFor,
      cron: automation.trigger.cron,
      timezone: automation.trigger.timezone,
      report_kind: automation.trigger.report_kind,
      observed_trust: "agentry_system",
    },
    prepareTelemetryObservation({}),
    "none; schedule occurrence contains only server-evaluated control data",
  );
  const inserted = await insertReceiptIdempotently(db, {
    id: uuidv7(),
    projectId,
    automationId: automation.id,
    contractRevision: loaded.row.revision,
    contractEtag: loaded.row.etag,
    triggerKind: "schedule",
    triggerKey,
    caseId: null,
    caseRevision: null,
    attempt: null,
    alertId: null,
    scheduledFor,
    requiredTrust: "agentry_system",
    sourceTrust: "agentry_system",
    snapshotJson: snapshot.json,
    snapshotHash: snapshot.hash,
    status: "ready",
    claimId: null,
    runId: null,
    issuedAt: now,
    notBeforeAt: scheduledFor,
    expiresAt: scheduledFor + automation.trigger.start_window_seconds,
    claimedAt: null,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
  });
  await upsertTriggerState(context, {
    triggerRef: `${automation.trigger.cron}@${automation.trigger.timezone}`,
    lastScheduleSlot: slot,
    lastReceiptAt: now,
  });
  return {
    automationId: automation.id,
    triggerKind: "schedule",
    receipts: [inserted.receipt],
    issuedCount: inserted.inserted ? 1 : 0,
    replayedCount: inserted.inserted ? 0 : 1,
    skipped: [],
    cooldownUntil: null,
  };
}

/** Find the latest matching cron minute that remains within the start window. */
export function findLatestScheduleOccurrence(
  cron: string,
  timezone: string,
  nowEpochSeconds: number,
  startWindowSeconds: number,
): number | null {
  const currentMinute = cronOccurrenceEpochMinute(new Date(nowEpochSeconds * 1_000));
  const maximumLookbackMinutes = Math.ceil(startWindowSeconds / 60);
  for (let offset = 0; offset <= maximumLookbackMinutes; offset += 1) {
    const candidateMinute = currentMinute - offset;
    const candidateSeconds = candidateMinute * 60;
    if (nowEpochSeconds - candidateSeconds >= startWindowSeconds) break;
    if (cronMatches(cron, timezone, new Date(candidateSeconds * 1_000))) {
      return candidateSeconds;
    }
  }
  return null;
}

export function caseTriggerKey(
  contractRevision: number,
  caseId: string,
  caseRevision: number,
  attempt: number,
  issuanceWindow: number,
): string {
  return `contract:${contractRevision}:case:${caseId}:revision:${caseRevision}:attempt:${attempt}:window:${issuanceWindow}`;
}

export function alertTriggerKey(
  contractRevision: number,
  alertId: string,
  evaluatedAt: number,
): string {
  return `contract:${contractRevision}:alert:${alertId}:evaluated:${evaluatedAt}`;
}

export function scheduleTriggerKey(contractRevision: number, occurrenceEpochMinute: number): string {
  return `contract:${contractRevision}:schedule:${occurrenceEpochMinute}`;
}

async function nextCaseAttempt(
  db: Db,
  caseId: string,
  caseRevision: number,
): Promise<number> {
  const claimAttempt = await db
    .select({ attempt: caseClaims.attempt })
    .from(caseClaims)
    .where(and(
      eq(caseClaims.caseId, caseId),
      eq(caseClaims.caseRevision, caseRevision),
    ))
    .orderBy(desc(caseClaims.attempt))
    .limit(1);
  return (claimAttempt[0]?.attempt ?? 0) + 1;
}

async function triggerSnapshot(
  control: Record<string, unknown>,
  observation: ReturnType<typeof prepareTelemetryObservation>,
  appliesTo: string,
): Promise<{ json: string; hash: string }> {
  const snapshot = {
    schema_version: "1",
    authority: {
      classification: "server_issued_trigger_eligibility",
      grants: ["claim_or_start_exact_occurrence_once"],
      does_not_grant: ["code_change", "draft_pr", "merge", "deploy", "case_status_change"],
    },
    control,
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      classification: "authority_free_observation",
      applies_to: appliesTo,
      inspection: observation.inspection,
    },
    observation: observation.content,
  };
  const json = canonicalJsonStringify(snapshot);
  return { json, hash: await sha256Hex(json) };
}

async function insertReceiptIdempotently(
  db: Db,
  receipt: typeof automationTriggerReceipts.$inferInsert,
): Promise<{ receipt: AutomationTriggerReceipt; inserted: boolean }> {
  const exact = receipt as AutomationTriggerReceipt;
  await db.run(sql`
    INSERT INTO ${automationTriggerReceipts} (
      id, project_id, automation_id, contract_revision, contract_etag,
      trigger_kind, trigger_key, case_id, case_revision, attempt, alert_id,
      scheduled_for, required_trust, source_trust, snapshot_json,
      snapshot_hash, status, claim_id, run_id, issued_at, not_before_at,
      expires_at, claimed_at, consumed_at, cancelled_at, cancel_reason
    )
    SELECT
      ${exact.id}, ${exact.projectId}, ${exact.automationId},
      ${exact.contractRevision}, ${exact.contractEtag}, ${exact.triggerKind},
      ${exact.triggerKey}, ${exact.caseId}, ${exact.caseRevision},
      ${exact.attempt}, ${exact.alertId}, ${exact.scheduledFor},
      ${exact.requiredTrust}, ${exact.sourceTrust}, ${exact.snapshotJson},
      ${exact.snapshotHash}, ${exact.status}, ${exact.claimId}, ${exact.runId},
      ${exact.issuedAt}, ${exact.notBeforeAt}, ${exact.expiresAt},
      ${exact.claimedAt}, ${exact.consumedAt}, ${exact.cancelledAt},
      ${exact.cancelReason}
    WHERE ${automationWritesOpenForProject(exact.projectId)}
      AND EXISTS (
        SELECT 1 FROM ${automationContracts}
        WHERE ${automationContracts.projectId} = ${exact.projectId}
          AND ${automationContracts.etag} = ${exact.contractEtag}
          AND ${automationContracts.enabled} = 1
          AND ${automationContracts.pausedAt} IS NULL
      )
    ON CONFLICT(project_id, automation_id, trigger_key) DO NOTHING
  `);
  const winner = await receiptByTriggerKey(
    db,
    exact.projectId,
    exact.automationId,
    exact.triggerKey,
  );
  if (winner) return { receipt: winner, inserted: winner.id === exact.id };
  await assertAutomationWritesOpen(db, exact.projectId);
  throw errors.conflict(
    "automation_trigger_authority_changed",
    "The automation contract changed before the trigger receipt could be issued.",
    "Reload the current contract and request another server eligibility sweep; do not synthesize a receipt.",
    { project_id: exact.projectId, automation_id: exact.automationId },
  );
}

async function receiptByTriggerKey(
  db: Db,
  projectId: string,
  automationId: string,
  triggerKey: string,
): Promise<AutomationTriggerReceipt | null> {
  return (
    await db
      .select()
      .from(automationTriggerReceipts)
      .where(and(
        eq(automationTriggerReceipts.projectId, projectId),
        eq(automationTriggerReceipts.automationId, automationId),
        eq(automationTriggerReceipts.triggerKey, triggerKey),
      ))
      .limit(1)
  )[0] ?? null;
}

async function expireAndCancelStaleReceipts(
  db: Db,
  projectId: string,
  automationId: string,
  currentContractEtag: string,
  now: number,
): Promise<void> {
  await expireReadyTriggerReceipts(db, projectId, { now, automationId });
  await db
    .update(automationTriggerReceipts)
    .set({ status: "cancelled", cancelledAt: now, cancelReason: "contract_changed" })
    .where(and(
      eq(automationTriggerReceipts.projectId, projectId),
      eq(automationTriggerReceipts.automationId, automationId),
      eq(automationTriggerReceipts.status, "ready"),
      ne(automationTriggerReceipts.contractEtag, currentContractEtag),
      automationWritesOpenForProject(automationTriggerReceipts.projectId),
    ));
}

/** Materialize deterministic expiry so list/detail status is never ambiguous. */
export async function expireReadyTriggerReceipts(
  db: Db,
  projectId: string,
  options: { now?: number; automationId?: string } = {},
): Promise<void> {
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  await db
    .update(automationTriggerReceipts)
    .set({ status: "expired" })
    .where(and(
      eq(automationTriggerReceipts.projectId, projectId),
      options.automationId
        ? eq(automationTriggerReceipts.automationId, options.automationId)
        : undefined,
      eq(automationTriggerReceipts.status, "ready"),
      lte(automationTriggerReceipts.expiresAt, now),
      automationWritesOpenForProject(automationTriggerReceipts.projectId),
    ));
}

function stateMatchesPolicy(
  state: AutomationTriggerState | null,
  loaded: LoadedAutomationContract,
  triggerHash: string,
): state is AutomationTriggerState {
  return Boolean(
    state &&
    state.contractRevision === loaded.row.revision &&
    state.contractEtag === loaded.row.etag &&
    state.triggerHash === triggerHash,
  );
}

async function upsertTriggerState(
  context: IssueContext,
  values: Partial<typeof automationTriggerStates.$inferInsert> & { triggerRef: string },
): Promise<void> {
  const { db, projectId, loaded, automation, now, triggerHash } = context;
  const base: typeof automationTriggerStates.$inferInsert = {
    projectId,
    automationId: automation.id,
    contractRevision: loaded.row.revision,
    contractEtag: loaded.row.etag,
    triggerHash,
    triggerKind: automation.trigger.kind,
    triggerRef: values.triggerRef,
    lastSourceEvaluatedAt: values.lastSourceEvaluatedAt ?? null,
    lastOutcome: values.lastOutcome ?? null,
    consecutiveBreaches: values.consecutiveBreaches ?? 0,
    cooldownUntil: values.cooldownUntil ?? null,
    lastReceiptAt: values.lastReceiptAt ?? null,
    lastScheduleSlot: values.lastScheduleSlot ?? null,
    updatedAt: now,
  };
  await db
    .insert(automationTriggerStates)
    .values(base)
    .onConflictDoUpdate({
      target: [automationTriggerStates.projectId, automationTriggerStates.automationId],
      set: {
        contractRevision: base.contractRevision,
        contractEtag: base.contractEtag,
        triggerHash: base.triggerHash,
        triggerKind: base.triggerKind,
        triggerRef: base.triggerRef,
        lastSourceEvaluatedAt: base.lastSourceEvaluatedAt,
        lastOutcome: base.lastOutcome,
        consecutiveBreaches: base.consecutiveBreaches,
        cooldownUntil: base.cooldownUntil,
        lastReceiptAt: base.lastReceiptAt,
        lastScheduleSlot: base.lastScheduleSlot,
        updatedAt: base.updatedAt,
      },
      // A sweep may pause after reading state while a newer evaluation or
      // schedule slot commits. Do not let that delayed snapshot regress the
      // monotonic trigger projection. Contract revisions dominate; within one
      // revision, compare the server-owned source cursor for that trigger kind.
      setWhere: sql`
        excluded.contract_revision > ${automationTriggerStates.contractRevision}
        OR (
          excluded.contract_revision = ${automationTriggerStates.contractRevision}
          AND (
            (
              excluded.trigger_kind = 'alert'
              AND coalesce(excluded.last_source_evaluated_at, -1) >=
                  coalesce(${automationTriggerStates.lastSourceEvaluatedAt}, -1)
            )
            OR (
              excluded.trigger_kind = 'schedule'
              AND coalesce(excluded.last_schedule_slot, -1) >=
                  coalesce(${automationTriggerStates.lastScheduleSlot}, -1)
            )
            OR (
              excluded.trigger_kind = 'unhandled_cases'
              AND excluded.updated_at >= ${automationTriggerStates.updatedAt}
            )
          )
        )
      `,
    });
}

function skippedResult(
  automationId: string,
  triggerKind: "alert" | "schedule",
  code: string,
  reason: string,
  details?: Record<string, unknown>,
  cooldownUntil: number | null = null,
): TriggerIssuanceResult {
  return {
    automationId,
    triggerKind,
    receipts: [],
    issuedCount: 0,
    replayedCount: 0,
    skipped: [{ code, reason, ...(details ? { details } : {}) }],
    cooldownUntil,
  };
}

function replayResult(
  automationId: string,
  triggerKind: "alert" | "schedule",
  receipt: AutomationTriggerReceipt,
  cooldownUntil: number | null,
): TriggerIssuanceResult {
  return {
    automationId,
    triggerKind,
    receipts: [receipt],
    issuedCount: 0,
    replayedCount: 1,
    skipped: [],
    cooldownUntil,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}
