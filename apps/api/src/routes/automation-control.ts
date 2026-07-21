import { Hono } from "hono";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import {
  AutomationContractSchema,
  AutomationDefinitionSchema,
  errors,
  type AutomationDefinition,
} from "@agentrysh/shared";
import {
  automationApprovals,
  automationActionGrants,
  automationBudgetCharges,
  automationContracts,
  automationRuns,
  automationTriggerReceipts,
  caseClaims,
  cases,
  projectCredentials,
  projectMemberships,
} from "@agentry/db/schema";
import {
  automationBudgetAvailableAt,
  automationBudgetReleaseIndex,
  automationBudgetWindowStart,
} from "../automation-budgets.js";
import { automationContractEtag } from "../automation-contracts.js";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";

const router = new Hono<AppBindings>();

const RUN_STATUS_ORDER = [
  "queued",
  "claimed",
  "running",
  "awaiting_approval",
  "draft_pr_opened",
  "verifying",
  "succeeded",
  "failed",
  "escalated",
  "cancelled",
] as const;
const NONTERMINAL_RUN_STATUSES = [
  "queued",
  "claimed",
  "running",
  "awaiting_approval",
  "draft_pr_opened",
  "verifying",
] as const;
const PR_CAPABLE_RUN_STATUSES = ["queued", "claimed", "running", "awaiting_approval"] as const;
const RUNNER_ACTIVE_STATUSES = ["queued", "claimed", "running", "awaiting_approval"] as const;
const MAX_ATTENTION_ITEMS = 100;
const QUERY_SENTINEL_LIMIT = MAX_ATTENTION_ITEMS + 1;
const MAX_LIVE_POLICY_ROWS = 500;

router.use("/v1/projects/:project_id/automation-control", requireApiKey());

router.get("/v1/projects/:project_id/automation-control", async (c) => {
  const asOf = Math.floor(Date.now() / 1_000);
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);
  const viewer = c.get("user");
  const db = getDb(c.env);
  const membership = (
    await db
      .select({ role: projectMemberships.role })
      .from(projectMemberships)
      .where(and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, viewer.id),
      ))
      .limit(1)
  )[0];
  // requireProjectAccess already proved membership. Failing closed here avoids
  // inferring owner authority from the legacy projects.user_id pointer.
  if (!membership) throw errors.forbidden();
  const isOwner = membership.role === "owner";
  const windowStart = automationBudgetWindowStart(asOf);

  // Parse one contract-row read and validate every duplicated row field against
  // its document. The broader aggregate is intentionally eventual-consistency;
  // `as_of` fixes clock math but does not claim a cross-table transaction.
  const rawContract = (
    await db
      .select()
      .from(automationContracts)
      .where(eq(automationContracts.projectId, projectId))
      .limit(1)
  )[0] ?? null;
  const parsedContract = rawContract
    ? AutomationContractSchema.safeParse(safeJson(rawContract.documentJson))
    : null;
  const contractDocument = parsedContract?.success ? parsedContract.data : null;
  const expectedEtag = contractDocument ? await automationContractEtag(contractDocument) : null;
  const contractConsistent = rawContract === null || Boolean(
    contractDocument &&
    rawContract.schemaVersion === contractDocument.schema_version &&
    rawContract.revision === contractDocument.revision &&
    (rawContract.enabled === 1) === contractDocument.enabled &&
    rawContract.etag === expectedEtag,
  );
  const automations = contractConsistent && contractDocument
    ? [...contractDocument.automations].sort((left, right) => left.id.localeCompare(right.id))
    : [];
  const globallyEnabled = Boolean(
    contractConsistent &&
    contractDocument &&
    rawContract?.schemaVersion === "2" &&
    rawContract.enabled === 1 &&
    rawContract.pausedAt === null &&
    contractDocument.enabled,
  );
  const disabledAutomationIds = globallyEnabled
    ? automations.filter((automation) => !automation.enabled).map((automation) => automation.id)
    : [];
  const killSwitchRunPredicate = !globallyEnabled
    ? inArray(automationRuns.status, [...NONTERMINAL_RUN_STATUSES])
    : disabledAutomationIds.length > 0
      ? and(
          inArray(automationRuns.status, [...NONTERMINAL_RUN_STATUSES]),
          inArray(automationRuns.automationId, disabledAutomationIds),
        )
      : null;

  const [
    runCountRows,
    receiptCountRows,
    claimCountRows,
    approvalCountRows,
    budgetCountRows,
    credentialRows,
    approvalAttentionRows,
    runAttentionRows,
    livePolicyRows,
    scheduledReportRows,
  ] = await Promise.all([
    db
      .select({
        automationId: automationRuns.automationId,
        status: automationRuns.status,
        total: sql<number>`count(*)`,
      })
      .from(automationRuns)
      .where(eq(automationRuns.projectId, projectId))
      .groupBy(automationRuns.automationId, automationRuns.status),
    db
      .select({
        automationId: automationTriggerReceipts.automationId,
        status: automationTriggerReceipts.status,
        total: sql<number>`count(*)`,
      })
      .from(automationTriggerReceipts)
      .where(and(
        eq(automationTriggerReceipts.projectId, projectId),
        inArray(automationTriggerReceipts.status, ["ready", "claimed"]),
        gt(automationTriggerReceipts.expiresAt, asOf),
      ))
      .groupBy(automationTriggerReceipts.automationId, automationTriggerReceipts.status),
    db
      .select({
        automationId: caseClaims.automationId,
        total: sql<number>`count(*)`,
      })
      .from(caseClaims)
      .where(and(
        eq(caseClaims.projectId, projectId),
        isNull(caseClaims.releasedAt),
        gt(caseClaims.expiresAt, asOf),
      ))
      .groupBy(caseClaims.automationId),
    db
      .select({
        automationId: automationApprovals.automationId,
        actionable: sql<number>`sum(CASE WHEN ${automationApprovals.expiresAt} > ${asOf} THEN 1 ELSE 0 END)`,
        expired: sql<number>`sum(CASE WHEN ${automationApprovals.expiresAt} <= ${asOf} THEN 1 ELSE 0 END)`,
      })
      .from(automationApprovals)
      .where(and(
        eq(automationApprovals.projectId, projectId),
        eq(automationApprovals.status, "pending"),
      ))
      .groupBy(automationApprovals.automationId),
    db
      .select({
        automationId: automationBudgetCharges.automationId,
        kind: automationBudgetCharges.kind,
        used: sql<number>`count(*)`,
      })
      .from(automationBudgetCharges)
      .where(and(
        eq(automationBudgetCharges.projectId, projectId),
        gte(automationBudgetCharges.createdAt, windowStart),
      ))
      .groupBy(automationBudgetCharges.automationId, automationBudgetCharges.kind),
    db
      .select({
        automationId: projectCredentials.automationId,
        total: sql<number>`count(*)`,
        active: sql<number>`sum(CASE WHEN ${projectCredentials.revokedAt} IS NULL AND ${projectCredentials.expiresAt} > ${asOf} THEN 1 ELSE 0 END)`,
        expiring: sql<number>`sum(CASE WHEN ${projectCredentials.revokedAt} IS NULL AND ${projectCredentials.expiresAt} > ${asOf} AND ${projectCredentials.expiresAt} <= ${asOf + 604_800} THEN 1 ELSE 0 END)`,
        expired: sql<number>`sum(CASE WHEN ${projectCredentials.revokedAt} IS NULL AND ${projectCredentials.expiresAt} <= ${asOf} THEN 1 ELSE 0 END)`,
        revoked: sql<number>`sum(CASE WHEN ${projectCredentials.revokedAt} IS NOT NULL THEN 1 ELSE 0 END)`,
        nextExpiryAt: sql<number | null>`min(CASE WHEN ${projectCredentials.revokedAt} IS NULL AND ${projectCredentials.expiresAt} > ${asOf} THEN ${projectCredentials.expiresAt} END)`,
        lastUsedAt: sql<number | null>`max(CASE WHEN ${projectCredentials.revokedAt} IS NULL AND ${projectCredentials.expiresAt} > ${asOf} THEN ${projectCredentials.lastUsedAt} END)`,
      })
      .from(projectCredentials)
      .where(and(
        eq(projectCredentials.projectId, projectId),
        eq(projectCredentials.kind, "automation_runner"),
        isNotNull(projectCredentials.automationId),
      ))
      .groupBy(projectCredentials.automationId),
    db
      .select({
        id: automationApprovals.id,
        runId: automationApprovals.runId,
        automationId: automationApprovals.automationId,
        action: automationApprovals.action,
        requestedAt: automationApprovals.requestedAt,
        expiresAt: automationApprovals.expiresAt,
      })
      .from(automationApprovals)
      .where(and(
        eq(automationApprovals.projectId, projectId),
        eq(automationApprovals.status, "pending"),
      ))
      .orderBy(
        sql<number>`CASE WHEN ${automationApprovals.expiresAt} <= ${asOf} THEN 0 ELSE 1 END`,
        asc(automationApprovals.expiresAt),
        asc(automationApprovals.requestedAt),
        asc(automationApprovals.id),
      )
      .limit(QUERY_SENTINEL_LIMIT),
    db
      .select({
        id: automationRuns.id,
        automationId: automationRuns.automationId,
        status: automationRuns.status,
        caseId: automationRuns.caseId,
        caseRevision: automationRuns.caseRevision,
        runnerCredentialId: automationRuns.runnerCredentialId,
        prProofAt: automationRuns.prProofAt,
        deploySha: automationRuns.deploySha,
        verificationStartedAt: automationRuns.verificationStartedAt,
        policySnapshotJson: automationRuns.policySnapshotJson,
        deadlineAt: automationRuns.deadlineAt,
        createdAt: automationRuns.createdAt,
        updatedAt: automationRuns.updatedAt,
      })
      .from(automationRuns)
      .where(and(
        eq(automationRuns.projectId, projectId),
        inArray(automationRuns.status, [
          ...NONTERMINAL_RUN_STATUSES,
          "failed",
          "escalated",
        ]),
      ))
      // Priority is applied in SQL before LIMIT so a flood of recent healthy
      // runs cannot hide an older broken authority binding or overdue lease.
      .orderBy(
        sql<number>`CASE
          ${killSwitchRunPredicate ? sql`WHEN ${killSwitchRunPredicate} THEN -1` : sql``}
          WHEN ${automationRuns.status} IN ('queued','claimed','running','awaiting_approval','draft_pr_opened','verifying')
            AND (
              ${automationRuns.runnerCredentialId} IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM ${projectCredentials}
                WHERE ${projectCredentials.id} = ${automationRuns.runnerCredentialId}
                  AND ${projectCredentials.projectId} = ${automationRuns.projectId}
                  AND ${projectCredentials.kind} = 'automation_runner'
                  AND ${projectCredentials.automationId} = ${automationRuns.automationId}
                  AND ${projectCredentials.revokedAt} IS NULL
                  AND ${projectCredentials.expiresAt} > ${asOf}
              )
              OR (${automationRuns.caseId} IS NOT NULL AND (
                NOT EXISTS (
                  SELECT 1 FROM ${cases}
                  WHERE ${cases.id} = ${automationRuns.caseId}
                    AND ${cases.projectId} = ${automationRuns.projectId}
                    AND ${cases.revision} = ${automationRuns.caseRevision}
                    AND ${cases.status} = 'active'
                )
                OR NOT EXISTS (
                  SELECT 1 FROM ${caseClaims}
                  WHERE ${caseClaims.runId} = ${automationRuns.id}
                    AND ${caseClaims.projectId} = ${automationRuns.projectId}
                    AND ${caseClaims.caseId} = ${automationRuns.caseId}
                    AND ${caseClaims.caseRevision} = ${automationRuns.caseRevision}
                    AND ${caseClaims.automationId} = ${automationRuns.automationId}
                    AND ${caseClaims.credentialId} = ${automationRuns.runnerCredentialId}
                    AND ${caseClaims.releasedAt} IS NULL
                    AND ${caseClaims.expiresAt} > ${asOf}
                )
              ))
            ) THEN 0
          WHEN ${automationRuns.status} IN ('queued','claimed','running','awaiting_approval')
            AND ${automationRuns.deadlineAt} <= ${asOf} THEN 1
          WHEN ${automationRuns.status} = 'awaiting_approval' THEN 2
          WHEN ${automationRuns.status} = 'running' AND EXISTS (
            SELECT 1 FROM ${automationActionGrants}
            WHERE ${automationActionGrants.runId} = ${automationRuns.id}
              AND ${automationActionGrants.projectId} = ${automationRuns.projectId}
              AND ${automationActionGrants.automationId} = ${automationRuns.automationId}
              AND ${automationActionGrants.status} = 'issued'
          ) THEN 3
          WHEN ${automationRuns.status} = 'draft_pr_opened' THEN 4
          WHEN ${automationRuns.status} = 'verifying' THEN 5
          WHEN ${automationRuns.status} = 'escalated' THEN 6
          WHEN ${automationRuns.status} = 'failed' THEN 7
          ELSE 8 END`,
        asc(automationRuns.updatedAt),
        asc(automationRuns.id),
      )
      .limit(QUERY_SENTINEL_LIMIT),
    db
      .select({
        id: automationRuns.id,
        automationId: automationRuns.automationId,
        status: automationRuns.status,
        policySnapshotJson: automationRuns.policySnapshotJson,
        createdAt: automationRuns.createdAt,
      })
      .from(automationRuns)
      .where(and(
        eq(automationRuns.projectId, projectId),
        inArray(automationRuns.status, [...PR_CAPABLE_RUN_STATUSES]),
      ))
      .orderBy(asc(automationRuns.automationId), asc(automationRuns.createdAt), asc(automationRuns.id))
      .limit(MAX_LIVE_POLICY_ROWS + 1),
    db
      .select({
        id: automationRuns.id,
        automationId: automationRuns.automationId,
        createdAt: automationRuns.createdAt,
        finishedAt: automationRuns.finishedAt,
        updatedAt: automationRuns.updatedAt,
      })
      .from(automationRuns)
      .where(and(
        eq(automationRuns.projectId, projectId),
        eq(automationRuns.triggerKind, "schedule"),
        eq(automationRuns.status, "succeeded"),
      ))
      .orderBy(desc(automationRuns.finishedAt), desc(automationRuns.updatedAt), desc(automationRuns.id))
      .limit(QUERY_SENTINEL_LIMIT),
  ]);

  const boundedAttentionRuns = runAttentionRows.slice(0, MAX_ATTENTION_ITEMS);
  const attentionRunIds = boundedAttentionRuns.map((run) => run.id);
  const attentionRunAutomationById = new Map(
    boundedAttentionRuns.map((run) => [run.id, run.automationId]),
  );
  const attentionCaseIds = boundedAttentionRuns
    .map((run) => run.caseId)
    .filter((id): id is string => id !== null);
  const attentionCredentialIds = boundedAttentionRuns
    .map((run) => run.runnerCredentialId)
    .filter((id): id is string => id !== null);
  const [attentionCaseRows, attentionClaimRows, attentionCredentialRows, attentionGrantRows, attentionRunApprovals] =
    attentionRunIds.length === 0
      ? [[], [], [], [], []] as const
      : await Promise.all([
          attentionCaseIds.length === 0
            ? Promise.resolve([])
            : db
                .select({ id: cases.id, projectId: cases.projectId, revision: cases.revision, status: cases.status })
                .from(cases)
                .where(and(eq(cases.projectId, projectId), inArray(cases.id, attentionCaseIds)))
                .limit(MAX_ATTENTION_ITEMS),
          db
            .select({
              id: caseClaims.id,
              runId: caseClaims.runId,
              caseId: caseClaims.caseId,
              caseRevision: caseClaims.caseRevision,
              automationId: caseClaims.automationId,
              credentialId: caseClaims.credentialId,
              expiresAt: caseClaims.expiresAt,
            })
            .from(caseClaims)
            .where(and(
              eq(caseClaims.projectId, projectId),
              inArray(caseClaims.runId, attentionRunIds),
              isNull(caseClaims.releasedAt),
              gt(caseClaims.expiresAt, asOf),
            ))
            .orderBy(desc(caseClaims.acquiredAt), desc(caseClaims.id))
            .limit(QUERY_SENTINEL_LIMIT),
          attentionCredentialIds.length === 0
            ? Promise.resolve([])
            : db
                .select({
                  id: projectCredentials.id,
                  projectId: projectCredentials.projectId,
                  kind: projectCredentials.kind,
                  automationId: projectCredentials.automationId,
                  expiresAt: projectCredentials.expiresAt,
                  revokedAt: projectCredentials.revokedAt,
                })
                .from(projectCredentials)
                .where(and(
                  eq(projectCredentials.projectId, projectId),
                  inArray(projectCredentials.id, attentionCredentialIds),
                ))
                .limit(MAX_ATTENTION_ITEMS),
          db
            .select({
              id: automationActionGrants.id,
              runId: automationActionGrants.runId,
              automationId: automationActionGrants.automationId,
              status: automationActionGrants.status,
              expiresAt: automationActionGrants.expiresAt,
              issuedAt: automationActionGrants.issuedAt,
            })
            .from(automationActionGrants)
            .where(and(
              eq(automationActionGrants.projectId, projectId),
              inArray(automationActionGrants.runId, attentionRunIds),
              eq(automationActionGrants.action, "draft_pr"),
              inArray(automationActionGrants.status, ["issued", "consumed"]),
            ))
            .orderBy(asc(automationActionGrants.expiresAt), asc(automationActionGrants.id))
            .limit(QUERY_SENTINEL_LIMIT),
          db
            .select({
              id: automationApprovals.id,
              runId: automationApprovals.runId,
              automationId: automationApprovals.automationId,
            })
            .from(automationApprovals)
            .where(and(
              eq(automationApprovals.projectId, projectId),
              inArray(automationApprovals.runId, attentionRunIds),
              eq(automationApprovals.status, "pending"),
              gt(automationApprovals.expiresAt, asOf),
            ))
            .orderBy(asc(automationApprovals.expiresAt), asc(automationApprovals.id))
            .limit(MAX_ATTENTION_ITEMS * 2),
        ]);

  const latestRunRows = await Promise.all(automations.map(async (automation) => (
    await db
      .select({
        id: automationRuns.id,
        status: automationRuns.status,
        triggerKind: automationRuns.triggerKind,
        createdAt: automationRuns.createdAt,
        startedAt: automationRuns.startedAt,
        updatedAt: automationRuns.updatedAt,
        finishedAt: automationRuns.finishedAt,
        deadlineAt: automationRuns.deadlineAt,
        turnsUsed: automationRuns.turnsUsed,
        costMicros: automationRuns.costMicros,
      })
      .from(automationRuns)
      .where(and(
        eq(automationRuns.projectId, projectId),
        eq(automationRuns.automationId, automation.id),
      ))
      .orderBy(desc(automationRuns.createdAt), desc(automationRuns.id))
      .limit(1)
  )[0] ?? null));

  const runCounts = nestedCountMap(runCountRows);
  const receiptCounts = nestedCountMap(receiptCountRows);
  const claimCounts = new Map(claimCountRows.map((row) => [row.automationId, Number(row.total ?? 0)]));
  const approvalCounts = new Map(approvalCountRows.map((row) => [row.automationId, {
    actionable: Number(row.actionable ?? 0),
    expired: Number(row.expired ?? 0),
  }]));
  const budgetCounts = nestedCountMap(budgetCountRows.map((row) => ({
    automationId: row.automationId,
    status: row.kind,
    total: row.used,
  })));
  const credentialHealth = new Map(credentialRows.map((row) => [row.automationId!, {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    expiring: Number(row.expiring ?? 0),
    expired: Number(row.expired ?? 0),
    revoked: Number(row.revoked ?? 0),
    next_expiry_at: row.nextExpiryAt === null ? null : Number(row.nextExpiryAt),
    last_used_at: row.lastUsedAt === null ? null : Number(row.lastUsedAt),
  }]));

  const livePolicyByAutomation = new Map<string, {
    rows: number;
    invalid: number;
    prLimits: Set<number>;
  }>();
  const livePolicyQueryTruncated = livePolicyRows.length > MAX_LIVE_POLICY_ROWS;
  for (const row of livePolicyRows.slice(0, MAX_LIVE_POLICY_ROWS)) {
    const state = livePolicyByAutomation.get(row.automationId) ?? {
      rows: 0,
      invalid: 0,
      prLimits: new Set<number>(),
    };
    state.rows += 1;
    const parsed = AutomationDefinitionSchema.safeParse(safeJson(row.policySnapshotJson));
    if (!parsed.success) {
      state.invalid += 1;
    } else if (parsed.data.allowed_actions.includes("draft_pr")) {
      state.prLimits.add(parsed.data.budgets.max_prs_per_day);
    }
    livePolicyByAutomation.set(row.automationId, state);
  }

  const budgetStateCache = new Map<string, Promise<Awaited<ReturnType<typeof budgetState>>>>();
  const getBudgetState = (
    automationId: string,
    kind: "run" | "draft_pr",
    limit: number,
    policySource: string,
  ) => {
    const key = `${automationId}:${kind}:${limit}:${policySource}`;
    const existing = budgetStateCache.get(key);
    if (existing) return existing;
    const created = budgetState(
      db,
      projectId,
      automationId,
      kind,
      limit,
      Number(budgetCounts.get(automationId)?.get(kind) ?? 0),
      asOf,
      policySource,
    );
    budgetStateCache.set(key, created);
    return created;
  };

  const automationRows = await Promise.all(automations.map(async (automation, index) => {
    const effectiveEnabled = globallyEnabled && automation.enabled;
    const statusCounts = runCounts.get(automation.id) ?? new Map<string, number>();
    const receipts = receiptCounts.get(automation.id) ?? new Map<string, number>();
    const approvals = approvalCounts.get(automation.id) ?? { actionable: 0, expired: 0 };
    const credentials = credentialHealth.get(automation.id) ?? {
      total: 0,
      active: 0,
      expiring: 0,
      expired: 0,
      revoked: 0,
      next_expiry_at: null,
      last_used_at: null,
    };
    const credentialStatus = credentials.active === 0
      ? credentials.total === 0 ? "missing" : "inactive"
      : credentials.expiring > 0 ? "expiring" : "healthy";
    const currentRunBudget = await getBudgetState(
      automation.id,
      "run",
      automation.budgets.max_runs_per_day,
      "current_contract_for_new_runs",
    );
    const currentPrBudget = await getBudgetState(
      automation.id,
      "draft_pr",
      automation.budgets.max_prs_per_day,
      "current_contract_for_future_run_snapshots",
    );
    const livePolicy = livePolicyByAutomation.get(automation.id);
    const liveLimits = livePolicy ? [...livePolicy.prLimits].sort((left, right) => left - right) : [];
    const liveCapacities = livePolicyQueryTruncated || livePolicy?.invalid || liveLimits.length === 0
      ? []
      : await Promise.all(liveLimits.map((limit) => getBudgetState(
          automation.id,
          "draft_pr",
          limit,
          "immutable_run_snapshot",
        )));
    const livePrCapacity = livePolicyQueryTruncated
      ? {
          status: "inconsistent" as const,
          can_assume_available: false,
          live_run_count: livePolicy?.rows ?? 0,
          invalid_snapshot_count: livePolicy?.invalid ?? 0,
          policy_source: "immutable_run_snapshots" as const,
          query_truncated: true,
          capacities: [],
        }
      : livePolicy?.invalid
      ? {
          status: "inconsistent" as const,
          can_assume_available: false,
          live_run_count: livePolicy.rows,
          invalid_snapshot_count: livePolicy.invalid,
          policy_source: "immutable_run_snapshots" as const,
          query_truncated: false,
          capacities: [],
        }
      : liveLimits.length === 0
        ? {
            status: "no_pr_capable_live_runs" as const,
            can_assume_available: false,
            live_run_count: livePolicy?.rows ?? 0,
            invalid_snapshot_count: 0,
            policy_source: "immutable_run_snapshots" as const,
            query_truncated: false,
            capacities: [],
          }
        : {
            status: liveLimits.length === 1 ? "single_policy" as const : "mixed_policy" as const,
            can_assume_available: liveLimits.length === 1 && liveCapacities[0]?.available === true,
            live_run_count: livePolicy?.rows ?? 0,
            invalid_snapshot_count: 0,
            policy_source: "immutable_run_snapshots" as const,
            query_truncated: false,
            capacities: liveCapacities,
          };
    const latest = latestRunRows[index];
    return {
      id: automation.id,
      name: automation.name,
      template_ref: automation.template_ref ?? null,
      template_ref_authority: "descriptive_provenance" as const,
      configured_enabled: automation.enabled,
      effective_enabled: effectiveEnabled,
      trigger: serializeTrigger(automation),
      activity: {
        runs_by_status: Object.fromEntries(RUN_STATUS_ORDER.map((status) => [
          status,
          Number(statusCounts.get(status) ?? 0),
        ])),
        active_runs: NONTERMINAL_RUN_STATUSES.reduce(
          (total, status) => total + Number(statusCounts.get(status) ?? 0),
          0,
        ),
        ready_trigger_receipts: Number(receipts.get("ready") ?? 0),
        claimed_trigger_receipts: Number(receipts.get("claimed") ?? 0),
        active_case_claims: claimCounts.get(automation.id) ?? 0,
        pending_approvals: effectiveEnabled ? approvals.actionable : 0,
        blocked_pending_approvals: effectiveEnabled ? 0 : approvals.actionable,
        expired_pending_approvals: approvals.expired,
      },
      rolling_24h_budgets: {
        window_start: windowStart,
        window_end: asOf,
        new_run_current_policy: currentRunBudget,
        draft_pr_current_policy_for_future_runs: currentPrBudget,
        draft_pr_live_run_policies: livePrCapacity,
        per_run_limits: {
          max_attempts_per_case_revision: automation.budgets.max_attempts_per_case_revision,
          max_turns: automation.budgets.max_turns_per_run,
          max_runtime_seconds: automation.budgets.max_runtime_seconds,
          max_cost_usd: automation.budgets.max_cost_usd_per_run ?? null,
        },
      },
      runner_credentials: {
        status: credentialStatus,
        ...credentials,
      },
      latest_run: latest ? {
        id: latest.id,
        status: latest.status,
        trigger_kind: latest.triggerKind,
        created_at: latest.createdAt,
        started_at: latest.startedAt,
        updated_at: latest.updatedAt,
        finished_at: latest.finishedAt,
        deadline_at: latest.deadlineAt,
        turns_used: latest.turnsUsed,
        cost_usd: latest.costMicros / 1_000_000,
        usage_source: "runner_attested_unverified",
        href: `/v1/automation-runs/${latest.id}`,
      } : null,
      links: {
        runs: `/v1/projects/${projectId}/automation-runs?automation_id=${encodeURIComponent(automation.id)}`,
        toggle: `/v1/projects/${projectId}/automation-contract/automations/${encodeURIComponent(automation.id)}`,
      },
    };
  }));

  const attentionCandidates: InternalAttentionSeed[] = [];
  if (rawContract && !contractConsistent) {
    attentionCandidates.push(controlAttention(
      "contract_inconsistent",
      "critical",
      -100,
      rawContract.updatedAt,
      `/v1/projects/${projectId}/automation-contract`,
    ));
  } else if (!rawContract) {
    attentionCandidates.push(controlAttention(
      "contract_not_configured",
      "info",
      80,
      asOf,
      `/v1/projects/${projectId}/automation-contract/validate`,
    ));
  } else if (!globallyEnabled) {
    attentionCandidates.push(controlAttention(
      rawContract.pausedAt === null ? "contract_disabled" : "contract_paused",
      "warning",
      -90,
      rawContract.updatedAt,
      `/v1/projects/${projectId}/automation-contract`,
    ));
  }

  const automationById = new Map(automationRows.map((automation) => [automation.id, automation]));
  const caseById = new Map(attentionCaseRows.map((row) => [row.id, row]));
  const claimByRun = new Map<string, typeof attentionClaimRows[number]>();
  for (const claim of attentionClaimRows) {
    if (claim.runId && !claimByRun.has(claim.runId)) claimByRun.set(claim.runId, claim);
  }
  const credentialById = new Map(attentionCredentialRows.map((row) => [row.id, row]));
  const grantByRun = new Map(attentionGrantRows
    .filter((row) => attentionRunAutomationById.get(row.runId) === row.automationId)
    .map((row) => [row.runId, row]));
  const pendingApprovalRuns = new Set(attentionRunApprovals
    .filter((row) => attentionRunAutomationById.get(row.runId) === row.automationId)
    .map((row) => row.runId));

  for (const automation of automationRows) {
    if (automation.effective_enabled && automation.runner_credentials.active === 0) {
      attentionCandidates.push(controlAttention(
        `runner_credential_${automation.runner_credentials.status}`,
        "critical",
        15,
        asOf,
        `/v1/projects/${projectId}/credentials`,
        automation.id,
      ));
    }
    if (automation.effective_enabled && automation.rolling_24h_budgets.new_run_current_policy.available === false) {
      attentionCandidates.push(controlAttention(
        "new_run_budget_unavailable",
        "warning",
        35,
        automation.rolling_24h_budgets.new_run_current_policy.available_at ?? asOf,
        `/v1/projects/${projectId}/automation-runs?automation_id=${encodeURIComponent(automation.id)}`,
        automation.id,
      ));
    }
    const livePr = automation.rolling_24h_budgets.draft_pr_live_run_policies;
    if (livePr.status === "inconsistent" || livePr.status === "mixed_policy") {
      attentionCandidates.push(controlAttention(
        `live_pr_budget_${livePr.status}`,
        livePr.status === "inconsistent" ? "critical" : "warning",
        livePr.status === "inconsistent" ? 5 : 25,
        asOf,
        `/v1/projects/${projectId}/automation-runs?automation_id=${encodeURIComponent(automation.id)}`,
        automation.id,
      ));
    }
  }

  // Exactly one primary attention item per run. Lower rank wins.
  const attentionByRun = new Map<string, InternalAttentionSeed>();
  const secondaryReasonsByRun = new Map<string, Set<string>>();
  const offerRunAttention = (item: InternalAttentionSeed) => {
    if (!item.run_id) return;
    const current = attentionByRun.get(item.run_id);
    if (!current) {
      attentionByRun.set(item.run_id, item);
      return;
    }
    const secondary = secondaryReasonsByRun.get(item.run_id) ?? new Set<string>();
    if (compareAttention(item, current) < 0) {
      if (current.kind !== item.kind) secondary.add(current.kind);
      secondary.delete(item.kind);
      attentionByRun.set(item.run_id, item);
    } else if (item.kind !== current.kind) {
      secondary.add(item.kind);
    }
    secondaryReasonsByRun.set(item.run_id, secondary);
  };
  for (const approval of approvalAttentionRows.slice(0, MAX_ATTENTION_ITEMS)) {
    if (!automationById.get(approval.automationId)?.effective_enabled) continue;
    const expired = approval.expiresAt <= asOf;
    offerRunAttention({
      id: `approval:${approval.id}`,
      kind: expired ? "approval_expired" : "approval_pending",
      severity: expired ? "critical" : "warning",
      priority: expired ? 1 : 20,
      sort_at: approval.expiresAt,
      automation_id: approval.automationId,
      run_id: approval.runId,
      approval_id: approval.id,
      action: approval.action,
      href: `/v1/automation-runs/${approval.runId}`,
      expires_at: approval.expiresAt,
    });
  }
  for (const run of boundedAttentionRuns) {
    const nonterminal = NONTERMINAL_RUN_STATUSES.includes(
      run.status as typeof NONTERMINAL_RUN_STATUSES[number],
    );
    const automation = automationById.get(run.automationId);
    if (nonterminal && !globallyEnabled) {
      offerRunAttention(runAttention(run, "global_kill_switch_active_run", "critical", -80, run.updatedAt));
    } else if (nonterminal && !automation?.effective_enabled) {
      offerRunAttention(runAttention(run, "automation_kill_switch_active_run", "critical", -70, run.updatedAt));
    }

    if (nonterminal) {
      const credential = run.runnerCredentialId ? credentialById.get(run.runnerCredentialId) : null;
      if (!credential || credential.projectId !== projectId || credential.kind !== "automation_runner" ||
          credential.automationId !== run.automationId || credential.revokedAt !== null || credential.expiresAt <= asOf) {
        offerRunAttention(runAttention(run, "runner_credential_binding_invalid", "critical", -60, run.updatedAt));
      }
      if (run.caseId !== null) {
        const caseRow = caseById.get(run.caseId);
        const claim = claimByRun.get(run.id);
        if (!caseRow || caseRow.revision !== run.caseRevision || caseRow.status !== "active") {
          offerRunAttention({
            ...runAttention(run, "case_revision_or_state_changed", "critical", -55, run.updatedAt),
            case_id: run.caseId,
            case_revision: run.caseRevision ?? undefined,
          });
        } else if (!claim || claim.caseId !== run.caseId || claim.caseRevision !== run.caseRevision ||
            claim.automationId !== run.automationId || claim.credentialId !== run.runnerCredentialId) {
          offerRunAttention({
            ...runAttention(run, "case_claim_not_active", "critical", -50, run.updatedAt),
            case_id: run.caseId,
            case_revision: run.caseRevision ?? undefined,
          });
        }
      }
    }

    const grant = grantByRun.get(run.id);
    if (grant?.status === "issued") {
      offerRunAttention({
        ...runAttention(
          run,
          grant.expiresAt <= asOf ? "draft_pr_grant_expired" : "draft_pr_grant_ready",
          grant.expiresAt <= asOf ? "critical" : "warning",
          grant.expiresAt <= asOf ? -40 : 35,
          grant.expiresAt,
        ),
        grant_id: grant.id,
        expires_at: grant.expiresAt,
      });
    }

    const runnerDeadlineExceeded = RUNNER_ACTIVE_STATUSES.includes(
      run.status as typeof RUNNER_ACTIVE_STATUSES[number],
    ) && run.deadlineAt <= asOf;
    if (runnerDeadlineExceeded) {
      offerRunAttention(runAttention(run, "run_deadline_exceeded", "critical", -30, run.deadlineAt));
    } else if (run.status === "awaiting_approval" && !pendingApprovalRuns.has(run.id)) {
      offerRunAttention(runAttention(run, "approval_record_missing", "critical", 25, run.updatedAt));
    } else if (run.status === "draft_pr_opened") {
      if (run.deadlineAt <= asOf) {
        offerRunAttention(runAttention(
          run,
          "provider_wait_deadline_exceeded",
          "critical",
          -35,
          run.deadlineAt,
        ));
      } else if (run.prProofAt === null) {
        offerRunAttention(runAttention(run, "draft_pr_awaiting_ci_proof", "warning", 40, run.updatedAt));
      } else if (run.deploySha === null) {
        offerRunAttention({
          ...runAttention(run, "proven_pr_awaiting_deploy", "warning", 45, run.prProofAt),
          proof_recorded_at: run.prProofAt,
        });
      } else {
        offerRunAttention(runAttention(run, "deploy_binding_state_inconsistent", "critical", -45, run.updatedAt));
      }
    } else if (run.status === "verifying") {
      const policy = AutomationDefinitionSchema.safeParse(safeJson(run.policySnapshotJson));
      const verification = policy.success ? policy.data.verification : null;
      if (!verification || run.verificationStartedAt === null) {
        offerRunAttention(runAttention(run, "verification_clock_inconsistent", "critical", -45, run.updatedAt));
      } else {
        const readyAt = run.verificationStartedAt + verification.observation_window_seconds;
        const maxWaitAt = run.verificationStartedAt + verification.max_wait_seconds;
        const kind = asOf >= maxWaitAt
          ? "verification_overdue"
          : asOf >= readyAt
            ? "verification_ready"
            : "verification_observation_pending";
        offerRunAttention({
          ...runAttention(
            run,
            kind,
            asOf >= maxWaitAt ? "critical" : asOf >= readyAt ? "warning" : "info",
            asOf >= maxWaitAt ? -25 : asOf >= readyAt ? 50 : 85,
            asOf >= maxWaitAt ? maxWaitAt : readyAt,
          ),
          verification_ready_at: readyAt,
          verification_max_wait_at: maxWaitAt,
        });
      }
    } else if (run.status === "escalated") {
      offerRunAttention(runAttention(run, "run_escalated", "warning", 60, run.updatedAt));
    } else if (run.status === "failed") {
      offerRunAttention(runAttention(run, "run_failed", "warning", 70, run.updatedAt));
    }
  }
  for (const report of scheduledReportRows.slice(0, MAX_ATTENTION_ITEMS)) {
    offerRunAttention({
      id: `report:${report.id}`,
      kind: "scheduled_report_ready",
      severity: "info",
      priority: 90,
      sort_at: report.finishedAt ?? report.updatedAt,
      automation_id: report.automationId,
      run_id: report.id,
      href: `/v1/automation-runs/${report.id}`,
      review_state: "unacknowledged_no_durable_ledger",
      finished_at: report.finishedAt ?? undefined,
    });
  }
  attentionCandidates.push(...[...attentionByRun.entries()].map(([runId, item]) => {
    const secondary = [...(secondaryReasonsByRun.get(runId) ?? [])].sort();
    return secondary.length > 0 ? { ...item, secondary_reasons: secondary } : item;
  }));
  attentionCandidates.sort(compareAttention);
  const attention = attentionCandidates
    .slice(0, MAX_ATTENTION_ITEMS)
    .map((item) => finalizeAttention(item, projectId, isOwner));
  const attentionSourceTruncated =
    approvalAttentionRows.length > MAX_ATTENTION_ITEMS ||
    runAttentionRows.length > MAX_ATTENTION_ITEMS ||
    livePolicyRows.length > MAX_LIVE_POLICY_ROWS ||
    scheduledReportRows.length > MAX_ATTENTION_ITEMS ||
    attentionClaimRows.length > MAX_ATTENTION_ITEMS ||
    attentionGrantRows.length > MAX_ATTENTION_ITEMS;

  const totalActiveRuns = runCountRows.reduce((total, row) =>
    NONTERMINAL_RUN_STATUSES.includes(row.status as typeof NONTERMINAL_RUN_STATUSES[number])
      ? total + Number(row.total ?? 0)
      : total,
  0);
  const totalPendingApprovals = approvalCountRows.reduce(
    (total, row) => total + Number(row.actionable ?? 0) + Number(row.expired ?? 0),
    0,
  );
  const totalReadyReceipts = receiptCountRows.reduce(
    (total, row) => row.status === "ready" ? total + Number(row.total ?? 0) : total,
    0,
  );

  const contractState = !rawContract
    ? "not_configured"
    : !contractConsistent
      ? "inconsistent"
      : globallyEnabled
        ? "enabled"
        : rawContract.pausedAt !== null
          ? "paused"
          : "disabled";
  const capabilities = {
    read_control: true,
    update_contract: isOwner,
    enable_contract: isOwner,
    pause_contract: isOwner,
    toggle_automation: isOwner,
    manage_credentials: isOwner,
    decide_approvals: isOwner,
    cancel_runs: isOwner,
  };

  return c.json({
    kind: "automation_control",
    project_id: projectId,
    as_of: asOf,
    consistency: {
      model: "eventual_read",
      clock_math_uses_single_as_of: true,
      cross_table_transaction: false,
    },
    control_boundary: {
      source: "agentry_control_plane",
      telemetry_evidence_included: false,
      raw_runner_output_included: false,
      runner_attested_control_metadata: ["latest_run.turns_used", "latest_run.cost_usd"],
      bounded_human_authored_descriptions: ["contract.summary", "automations[].name"],
      secret_columns_included: false,
      free_text_authority: "none",
    },
    viewer: {
      user_id: viewer.id,
      role: membership.role,
      capabilities,
    },
    contract: {
      configured: rawContract !== null,
      valid: rawContract === null ? null : contractConsistent,
      state: contractState,
      schema_version: rawContract?.schemaVersion ?? null,
      revision: rawContract?.revision ?? null,
      etag: rawContract?.etag ?? null,
      stored_enabled: rawContract?.enabled === 1,
      document_enabled: contractDocument?.enabled ?? false,
      effective_enabled: globallyEnabled,
      paused_at: rawContract?.pausedAt ?? null,
      summary: contractDocument?.summary.slice(0, 2_000) ?? null,
      summary_authority: "description_only",
      created_at: rawContract?.createdAt ?? null,
      updated_at: rawContract?.updatedAt ?? null,
    },
    summary: {
      configured_automations: automations.length,
      effective_enabled_automations: automationRows.filter((automation) => automation.effective_enabled).length,
      active_runs: totalActiveRuns,
      pending_approval_records: totalPendingApprovals,
      actionable_pending_approvals: automationRows.reduce(
        (total, automation) => total + automation.activity.pending_approvals,
        0,
      ),
      ready_trigger_receipts: totalReadyReceipts,
      active_case_claims: claimCountRows.reduce((total, row) => total + Number(row.total ?? 0), 0),
      attention_items: attention.length,
    },
    attention,
    attention_review: {
      durable_acknowledgement_supported: false,
      item_ids_stable: true,
      note: "No review ledger exists in the current no-new-table contract; use stable item ids and source cursors for handoff.",
    },
    automations: automationRows,
    controls: controlLinks(projectId, capabilities, rawContract?.etag ?? null, {
      configured: rawContract !== null,
      contract_valid: contractConsistent,
      globally_enabled: globallyEnabled,
    }),
    bounds: {
      max_automations: 50,
      max_latest_runs_per_automation: 1,
      max_attention_items: MAX_ATTENTION_ITEMS,
      max_live_policy_rows: MAX_LIVE_POLICY_ROWS,
    },
    truncation: {
      attention: {
        candidate_count: attentionCandidates.length,
        candidate_count_exact: !attentionSourceTruncated,
        returned: attention.length,
        truncated: attentionCandidates.length > MAX_ATTENTION_ITEMS || attentionSourceTruncated,
        source_query_truncated: attentionSourceTruncated,
        query_priority_applied_before_limit: true,
        continuation: attentionSourceTruncated
          ? {
              mode: "restart_each_source_with_keyset_pagination",
              complete_when: "Every returned pagination.has_more is false for both source operations.",
              operations: [
                {
                  operation_id: "list_automation_runs",
                  method: "GET",
                  href: `/v1/projects/${projectId}/automation-runs?limit=200`,
                  cursor_response_path: "pagination.next_cursor",
                  follow_up_response_path: "pagination.follow_up",
                },
                {
                  operation_id: "list_automation_approvals",
                  method: "GET",
                  href: `/v1/projects/${projectId}/automation-approvals?status=pending&limit=200`,
                  cursor_response_path: "pagination.next_cursor",
                  follow_up_response_path: "pagination.follow_up",
                },
              ],
            }
          : null,
      },
      live_run_policy_rows: {
        returned: Math.min(livePolicyRows.length, MAX_LIVE_POLICY_ROWS),
        truncated: livePolicyRows.length > MAX_LIVE_POLICY_ROWS,
        continuation: livePolicyRows.length > MAX_LIVE_POLICY_ROWS
          ? {
              operation_id: "list_automation_runs",
              method: "GET",
              href: `/v1/projects/${projectId}/automation-runs?limit=200`,
              cursor_response_path: "pagination.next_cursor",
              follow_up_response_path: "pagination.follow_up",
              note: "Page the complete run inventory and inspect each immutable policy snapshot; the control aggregate deliberately does not pretend its bounded cross-table read is pageable.",
            }
          : null,
      },
    },
    next_action: !rawContract
      ? isOwner
        ? "Validate and save a version 2 automation contract; saving remains disabled until an owner explicitly enables its ETag."
        : "No automation contract is configured. Ask a project owner to validate and save one before scheduling unattended work."
      : !contractConsistent
        ? "The saved contract is inconsistent. Keep automation disabled and have an owner replace it with a validated version 2 contract."
        : attention.length > 0
          ? "Review the attention queue in order. Use only controls marked allowed for this viewer."
          : "No control-plane attention is required at this as_of time.",
  });
});

function nestedCountMap(
  rows: Array<{ automationId: string; status: string; total: number | null }>,
): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const values = result.get(row.automationId) ?? new Map<string, number>();
    values.set(row.status, Number(row.total ?? 0));
    result.set(row.automationId, values);
  }
  return result;
}

async function budgetState(
  db: ReturnType<typeof getDb>,
  projectId: string,
  automationId: string,
  kind: "run" | "draft_pr",
  limit: number,
  used: number,
  asOf: number,
  policySource: string,
) {
  if (limit <= 0) {
    return {
      kind,
      policy_source: policySource,
      limit,
      used,
      remaining: 0,
      available: false,
      policy_blocked: true,
      available_at: null,
    };
  }
  const releaseIndex = automationBudgetReleaseIndex(used, limit);
  if (releaseIndex === null) {
    return {
      kind,
      policy_source: policySource,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      available: true,
      policy_blocked: false,
      available_at: null,
    };
  }
  const charge = (
    await db
      .select({ createdAt: automationBudgetCharges.createdAt })
      .from(automationBudgetCharges)
      .where(and(
        eq(automationBudgetCharges.projectId, projectId),
        eq(automationBudgetCharges.automationId, automationId),
        eq(automationBudgetCharges.kind, kind),
        gte(automationBudgetCharges.createdAt, automationBudgetWindowStart(asOf)),
      ))
      .orderBy(asc(automationBudgetCharges.createdAt), asc(automationBudgetCharges.id))
      .limit(1)
      .offset(releaseIndex)
  )[0];
  return {
    kind,
    policy_source: policySource,
    limit,
    used,
    remaining: 0,
    available: false,
    policy_blocked: false,
    available_at: charge ? automationBudgetAvailableAt(charge.createdAt) : null,
    ...(charge ? {} : { inconsistent: true }),
  };
}

function serializeTrigger(automation: AutomationDefinition) {
  if (automation.trigger.kind === "alert") {
    return {
      kind: "alert" as const,
      alert_id: automation.trigger.alert_id,
      cooldown_seconds: automation.trigger.cooldown_seconds,
      min_consecutive_breaches: automation.trigger.min_consecutive_breaches,
      required_trust: automation.trigger.required_trust,
    };
  }
  if (automation.trigger.kind === "schedule") {
    return {
      kind: "schedule" as const,
      cron: automation.trigger.cron,
      timezone: automation.trigger.timezone,
      report_kind: automation.trigger.report_kind,
      start_window_seconds: automation.trigger.start_window_seconds,
    };
  }
  return {
    kind: "unhandled_cases" as const,
    max_cases_per_sweep: automation.trigger.max_cases_per_sweep,
    cooldown_seconds: automation.trigger.cooldown_seconds,
    required_trust: automation.trigger.required_trust,
  };
}

type InternalAttentionSeed = {
  id: string;
  kind: string;
  severity: "critical" | "warning" | "info";
  priority: number;
  sort_at: number;
  href: string;
  automation_id?: string;
  run_id?: string;
  approval_id?: string;
  action?: string;
  grant_id?: string;
  case_id?: string;
  case_revision?: number;
  expires_at?: number;
  deadline_at?: number;
  proof_recorded_at?: number;
  verification_ready_at?: number;
  verification_max_wait_at?: number;
  review_state?: string;
  finished_at?: number;
  secondary_reasons?: string[];
};

type AttentionOperation = {
  operation_id: string;
  method: "GET" | "POST" | "PUT" | "PATCH";
  href?: string;
  href_template?: string;
  allowed: boolean;
  required_principal: "human_owner_or_member" | "human_owner" | "ci_deploy";
  required_headers: string[];
  required_fields: string[];
};

type InternalAttention = Omit<InternalAttentionSeed, "priority" | "sort_at"> & {
  message: string;
  next_action: string;
  operator_remediation_required: boolean;
  operation: AttentionOperation;
};

function runAttention(
  run: { id: string; automationId: string; deadlineAt: number },
  kind: string,
  severity: InternalAttentionSeed["severity"],
  priority: number,
  sortAt: number,
): InternalAttentionSeed {
  return {
    id: `run:${run.id}:${kind}`,
    kind,
    severity,
    priority,
    sort_at: sortAt,
    automation_id: run.automationId,
    run_id: run.id,
    href: `/v1/automation-runs/${run.id}`,
    deadline_at: run.deadlineAt,
  };
}

function controlAttention(
  kind: string,
  severity: InternalAttentionSeed["severity"],
  priority: number,
  sortAt: number,
  href: string,
  automationId?: string,
): InternalAttentionSeed {
  return {
    id: automationId ? `${kind}:${automationId}` : kind,
    kind,
    severity,
    priority,
    sort_at: sortAt,
    href,
    ...(automationId ? { automation_id: automationId } : {}),
  };
}

function compareAttention(left: InternalAttentionSeed, right: InternalAttentionSeed): number {
  return left.priority - right.priority ||
    left.sort_at - right.sort_at ||
    left.id.localeCompare(right.id);
}

function stripAttentionOrdering(item: InternalAttentionSeed) {
  const { priority: _priority, sort_at: _sortAt, ...safe } = item;
  return safe;
}

function finalizeAttention(
  item: InternalAttentionSeed,
  projectId: string,
  isOwner: boolean,
): InternalAttention {
  const safe = stripAttentionOrdering(item);
  const readRun = (): AttentionOperation => ({
    operation_id: "get_automation_run",
    method: "GET",
    href: item.run_id ? `/v1/automation-runs/${item.run_id}` : item.href,
    allowed: true,
    required_principal: "human_owner_or_member",
    required_headers: [],
    required_fields: [],
  });
  const cancelRun = (): AttentionOperation => ({
    operation_id: "cancel_automation_run",
    method: "POST",
    href: item.run_id ? `/v1/automation-runs/${item.run_id}/cancel` : undefined,
    href_template: item.run_id ? undefined : "/v1/automation-runs/{run_id}/cancel",
    allowed: isOwner,
    required_principal: "human_owner",
    required_headers: ["Idempotency-Key"],
    required_fields: ["reason"],
  });
  const guidance = (() => {
    if (item.kind === "contract_inconsistent") return {
      message: "The stored contract row and canonical version 2 document do not agree; unattended authority remains invalid.",
      next_action: "Read the contract, keep it disabled, then have an owner replace it with a newly validated canonical document.",
      operator_remediation_required: true,
      operation: {
        operation_id: "get_automation_contract",
        method: "GET",
        href: `/v1/projects/${projectId}/automation-contract`,
        allowed: true,
        required_principal: "human_owner_or_member",
        required_headers: [],
        required_fields: [],
      } satisfies AttentionOperation,
    };
    if (item.kind === "contract_not_configured") return {
      message: "No version 2 automation contract is configured for this project.",
      next_action: "Render a disabled immutable playbook candidate, then validate the complete candidate before any owner save or enable decision.",
      operator_remediation_required: true,
      operation: {
        operation_id: "validate_automation_contract",
        method: "POST",
        href: `/v1/projects/${projectId}/automation-contract/validate`,
        allowed: true,
        required_principal: "human_owner_or_member",
        required_headers: [],
        required_fields: ["schema_version", "summary", "automations"],
      } satisfies AttentionOperation,
    };
    if (item.kind === "contract_disabled" || item.kind === "contract_paused") return {
      message: item.kind === "contract_paused"
        ? "The global automation kill switch is paused."
        : "The automation contract is saved but globally disabled.",
      next_action: "Read the exact contract and ETag. Only an owner may deliberately enable it after resolving every readiness and credential gate.",
      operator_remediation_required: true,
      operation: {
        operation_id: "get_automation_contract",
        method: "GET",
        href: `/v1/projects/${projectId}/automation-contract`,
        allowed: true,
        required_principal: "human_owner_or_member",
        required_headers: [],
        required_fields: [],
      } satisfies AttentionOperation,
    };
    if (item.kind.startsWith("runner_credential_")) return {
      message: `Automation ${item.automation_id ?? "unknown"} has no usable exact-bound runner credential.`,
      next_action: "An owner must create one automation_runner credential bound to this exact automation_id, place it only in that scheduler, and verify the old credential is absent or revoked.",
      operator_remediation_required: true,
      operation: {
        operation_id: "create_project_credential",
        method: "POST",
        href: `/v1/projects/${projectId}/credentials`,
        allowed: isOwner,
        required_principal: "human_owner",
        required_headers: ["Idempotency-Key"],
        required_fields: ["kind", "name", "automation_id"],
      } satisfies AttentionOperation,
    };
    if (item.kind === "approval_pending" && item.approval_id) return {
      message: `Approval ${item.approval_id} is pending for one immutable run action.`,
      next_action: "Read the bound run, evidence, subject hash, and expiry; then an owner must explicitly approve or reject this approval record.",
      operator_remediation_required: true,
      operation: {
        operation_id: "decide_automation_approval",
        method: "POST",
        href: `/v1/automation-approvals/${item.approval_id}/decide`,
        allowed: isOwner,
        required_principal: "human_owner",
        required_headers: [],
        required_fields: ["decision", "reason"],
      } satisfies AttentionOperation,
    };
    if (item.kind === "verification_ready" || item.kind === "verification_overdue") return {
      message: item.kind === "verification_overdue"
        ? "The immutable verification maximum wait has elapsed without a terminal proof result."
        : "The immutable observation window is complete and server-owned verification is ready.",
      next_action: "Execute the bodyless verify operation. Zero traffic remains pending until the deadline and never counts as success.",
      operator_remediation_required: true,
      operation: {
        operation_id: "verify_automation_run",
        method: "POST",
        href: `/v1/automation-runs/${item.run_id}/verify`,
        allowed: true,
        required_principal: "human_owner_or_member",
        required_headers: [],
        required_fields: [],
      } satisfies AttentionOperation,
    };
    if (item.kind === "draft_pr_awaiting_ci_proof") return {
      message: "A draft PR was recorded, but no independent trusted-CI provider proof is bound to the run.",
      next_action: "The trusted CI boundary must record the exact provider-observed PR proof; do not accept runner text or a human comment as proof.",
      operator_remediation_required: true,
      operation: {
        operation_id: "record_automation_pr_proof",
        method: "POST",
        href: `/v1/automation-runs/${item.run_id}/pr-proof`,
        allowed: false,
        required_principal: "ci_deploy",
        required_headers: [],
        required_fields: ["provider", "repository", "pr_number", "pr_url", "head_sha", "base_branch", "state"],
      } satisfies AttentionOperation,
    };
    if (item.kind === "proven_pr_awaiting_deploy") return {
      message: "Trusted CI proved the draft PR, but no exact successful deploy is bound to its source commit.",
      next_action: "After that exact commit deploys successfully, the trusted CI boundary must record one deploy with automation_run_id and source_commit_sha using a stable Idempotency-Key.",
      operator_remediation_required: true,
      operation: {
        operation_id: "record_deploy",
        method: "POST",
        href: "/v1/deploys/",
        allowed: false,
        required_principal: "ci_deploy",
        required_headers: ["Idempotency-Key"],
        required_fields: ["sha", "environment", "automation_run_id", "source_commit_sha"],
      } satisfies AttentionOperation,
    };
    if (item.kind === "verification_observation_pending") return {
      message: "The run is inside its immutable post-deploy observation window.",
      next_action: "Wait until verification_ready_at, then re-read this control view or call the run read; do not pollute the window or claim success early.",
      operator_remediation_required: false,
      operation: readRun(),
    };
    if (item.kind === "scheduled_report_ready") return {
      message: "A private source-bound scheduled report is ready for human review.",
      next_action: "Read the run and its immutable report source. Treat findings as evidence only; publication, messaging, and follow-on changes require separate human work.",
      operator_remediation_required: false,
      operation: readRun(),
    };
    if (item.kind === "new_run_budget_unavailable") return {
      message: "The current contract's rolling 24-hour run budget has no available capacity.",
      next_action: "Page the automation's run history and wait for the reported availability time; do not bypass or reset durable budget charges.",
      operator_remediation_required: false,
      operation: {
        operation_id: "list_automation_runs",
        method: "GET",
        href: item.href,
        allowed: true,
        required_principal: "human_owner_or_member",
        required_headers: [],
        required_fields: [],
      } satisfies AttentionOperation,
    };
    if (item.kind === "live_pr_budget_inconsistent" || item.kind === "live_pr_budget_mixed_policy") return {
      message: item.kind === "live_pr_budget_inconsistent"
        ? "Live draft-PR runs contain an invalid or incompletely inspected immutable budget snapshot."
        : "Live draft-PR runs use more than one immutable budget limit.",
      next_action: "Page every live run and inspect its immutable policy snapshot before authorizing another PR; current-contract limits cannot rewrite existing runs.",
      operator_remediation_required: true,
      operation: {
        operation_id: "list_automation_runs",
        method: "GET",
        href: item.href,
        allowed: true,
        required_principal: "human_owner_or_member",
        required_headers: [],
        required_fields: [],
      } satisfies AttentionOperation,
    };
    const cancellationKinds = new Set([
      "global_kill_switch_active_run",
      "automation_kill_switch_active_run",
      "runner_credential_binding_invalid",
      "case_revision_or_state_changed",
      "case_claim_not_active",
      "draft_pr_grant_expired",
      "run_deadline_exceeded",
      "approval_record_missing",
      "provider_wait_deadline_exceeded",
      "deploy_binding_state_inconsistent",
      "verification_clock_inconsistent",
    ]);
    if (cancellationKinds.has(item.kind)) return {
      message: `Run ${item.run_id ?? "unknown"} has unsafe or expired local authority: ${item.kind}.`,
      next_action: "An owner must inspect the immutable run and cancel its local authority with one stable Idempotency-Key; reconcile any external PR or deploy separately.",
      operator_remediation_required: true,
      operation: cancelRun(),
    };
    if (item.kind === "approval_expired") return {
      message: `Approval ${item.approval_id ?? "unknown"} expired and no longer grants action authority.`,
      next_action: "Read the run and choose an explicit terminal or new eligible workflow; do not reuse or reinterpret the expired approval.",
      operator_remediation_required: true,
      operation: readRun(),
    };
    if (item.kind === "draft_pr_grant_ready") return {
      message: "One exact draft-PR action grant is issued and time-bounded.",
      next_action: "Read the run and grant before any action. The grant permits exactly one draft PR and never merge, deploy, direct push, or workflow edits.",
      operator_remediation_required: true,
      operation: readRun(),
    };
    return {
      message: `Run ${item.run_id ?? "unknown"} requires review: ${item.kind}.`,
      next_action: "Read the immutable run, evidence boundary, and policy snapshot before choosing any separate mutation.",
      operator_remediation_required: item.severity !== "info",
      operation: readRun(),
    };
  })();
  return { ...safe, ...guidance };
}

function controlLinks(
  projectId: string,
  capabilities: Record<string, boolean>,
  etag: string | null,
  state: {
    configured: boolean;
    contract_valid: boolean;
    globally_enabled: boolean;
  },
) {
  return {
    read_contract: {
      operation_id: "get_automation_contract",
      method: "GET",
      href: `/v1/projects/${projectId}/automation-contract`,
      allowed: state.configured && state.contract_valid,
      required_principal: "human_owner_or_member",
      required_headers: [],
      required_fields: [],
    },
    list_runs: {
      operation_id: "list_automation_runs",
      method: "GET",
      href: `/v1/projects/${projectId}/automation-runs`,
      allowed: true,
      required_principal: "human_owner_or_member",
      required_headers: [],
      required_fields: [],
    },
    list_approvals: {
      operation_id: "list_automation_approvals",
      method: "GET",
      href: `/v1/projects/${projectId}/automation-approvals`,
      allowed: true,
      required_principal: "human_owner_or_member",
      required_headers: [],
      required_fields: [],
    },
    validate_contract: {
      operation_id: "validate_automation_contract",
      method: "POST",
      href: `/v1/projects/${projectId}/automation-contract/validate`,
      allowed: true,
      required_principal: "human_owner_or_member",
      required_headers: [],
      required_fields: ["schema_version", "summary", "automations"],
    },
    save_contract: {
      operation_id: "put_automation_contract",
      method: "PUT",
      href: `/v1/projects/${projectId}/automation-contract`,
      allowed: capabilities.update_contract,
      required_principal: "human_owner",
      required_headers: state.configured ? ["If-Match"] : [],
      required_fields: ["schema_version", "summary", "automations"],
      etag,
    },
    enable_contract: {
      operation_id: "enable_automation_contract",
      method: "POST",
      href: `/v1/projects/${projectId}/automation-contract/enable`,
      allowed: capabilities.enable_contract && state.configured && state.contract_valid && !state.globally_enabled,
      required_principal: "human_owner",
      required_headers: ["If-Match"],
      required_fields: [],
      etag,
    },
    pause_contract: {
      operation_id: "pause_automation_contract",
      method: "POST",
      href: `/v1/projects/${projectId}/automation-contract/pause`,
      allowed: capabilities.pause_contract && state.configured && state.contract_valid && state.globally_enabled,
      required_principal: "human_owner",
      required_headers: [],
      required_fields: ["reason"],
    },
    toggle_automation: {
      operation_id: "set_automation_enabled",
      method: "PATCH",
      href_template: `/v1/projects/${projectId}/automation-contract/automations/{automation_id}`,
      allowed: capabilities.toggle_automation && state.configured && state.contract_valid,
      required_principal: "human_owner",
      required_headers: ["If-Match"],
      required_fields: ["enabled", "reason"],
      etag,
    },
    decide_approval: {
      operation_id: "decide_automation_approval",
      method: "POST",
      href_template: "/v1/automation-approvals/{approval_id}/decide",
      allowed: capabilities.decide_approvals && state.globally_enabled,
      required_principal: "human_owner",
      required_headers: [],
      required_fields: ["decision", "reason"],
    },
    cancel_run: {
      operation_id: "cancel_automation_run",
      method: "POST",
      href_template: "/v1/automation-runs/{run_id}/cancel",
      allowed: capabilities.cancel_runs,
      required_principal: "human_owner",
      required_headers: ["Idempotency-Key"],
      required_fields: ["reason"],
    },
    list_credentials: {
      operation_id: "list_project_credentials",
      method: "GET",
      href: `/v1/projects/${projectId}/credentials`,
      allowed: capabilities.manage_credentials,
      required_principal: "human_owner",
      required_headers: [],
      required_fields: [],
    },
    create_credential: {
      operation_id: "create_project_credential",
      method: "POST",
      href: `/v1/projects/${projectId}/credentials`,
      allowed: capabilities.manage_credentials,
      required_principal: "human_owner",
      required_headers: ["Idempotency-Key"],
      required_fields: ["kind", "name"],
      conditional_fields: {
        automation_runner: ["automation_id"],
      },
    },
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export default router;
