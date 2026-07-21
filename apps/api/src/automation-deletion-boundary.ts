import {
  eq,
  inArray,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { errors } from "@agentrysh/shared";
import {
  automationWorkflowBudgetCharges,
  automationWorkflowCommands,
  automationWorkflowEffectEvents,
  automationWorkflowEffects,
  automationWorkflowExecutionAuthorities,
  automationWorkflowProjectControls,
  automationWorkflowRevisions,
  automationWorkflowRunEvents,
  automationWorkflowRunLeases,
  automationWorkflowRuns,
  automationWorkflowRunStates,
  automationWorkflowSuspensions,
  automationWorkflowSystemNodeClaims,
  automationWorkflowTriggerReceipts,
  automationWorkflows,
  projectDeletionFences,
} from "@agentry/db/schema";
import type { AgentryDb } from "./db.js";

export const AUTOMATION_DELETION_MANIFEST_SAMPLE_LIMIT = 20;
const DELETION_MANIFEST_PROJECT_PAGE_SIZE = 50;

export type AutomationExternalEffectState =
  | "none_known"
  | "known"
  | "possible_or_unknown";

export type AutomationDeletionSampleKind =
  | "enabled_contract"
  | "enabled_schedule"
  | "active_runner_credential"
  | "ready_or_claimed_receipt"
  | "nonterminal_run"
  | "active_claim"
  | "pending_approval"
  | "draft_pr_grant"
  | "known_run_effect"
  | "known_deploy"
  | "workflow_v3_enabled_workflow"
  | "workflow_v3_trigger_receipt"
  | "workflow_v3_nonterminal_run"
  | "workflow_v3_active_lease"
  | "workflow_v3_active_system_node_claim"
  | "workflow_v3_pending_suspension"
  | "workflow_v3_effect";

export interface AutomationDeletionSample {
  project_id: string;
  kind: AutomationDeletionSampleKind;
  id: string;
  automation_id: string | null;
  run_id: string | null;
  status: string;
  external_effect_state: AutomationExternalEffectState;
  recorded_at: number | null;
  pr_url?: string;
  pr_proof_hash?: string;
  deploy_id?: string;
  deploy_sha?: string;
  provider_ref?: string;
}

export interface AutomationDeletionManifest {
  as_of: number;
  project_ids: string[];
  sample_limit: number;
  counts: {
    enabled_contracts: number;
    enabled_schedules: number;
    active_runner_credentials: number;
    ready_or_claimed_receipts: number;
    nonterminal_runs: number;
    active_claims: number;
    pending_approvals: number;
    issued_or_consumed_draft_pr_grants: number;
    known_pr_identifiers: number;
    known_pr_proof_identifiers: number;
    known_deploy_identifiers: number;
    known_external_effects: number;
    possible_or_unknown_external_effects: number;
    workflow_v3_project_controls: number;
    workflow_v3_workflows: number;
    workflow_v3_revisions: number;
    workflow_v3_execution_authorities: number;
    workflow_v3_trigger_receipts: number;
    workflow_v3_runs: number;
    workflow_v3_system_node_claims: number;
    workflow_v3_run_leases: number;
    workflow_v3_budget_charges: number;
    workflow_v3_run_states: number;
    workflow_v3_commands: number;
    workflow_v3_run_events: number;
    workflow_v3_suspensions: number;
    workflow_v3_effects: number;
    workflow_v3_effect_events: number;
    workflow_v3_enabled_workflows: number;
    workflow_v3_ready_trigger_receipts: number;
    workflow_v3_nonterminal_runs: number;
    workflow_v3_active_leases: number;
    workflow_v3_active_system_node_claims: number;
    workflow_v3_pending_suspensions: number;
    workflow_v3_external_reserved_effects: number;
    workflow_v3_external_indeterminate_effects: number;
    workflow_v3_external_manual_follow_up_effects: number;
    workflow_v3_external_succeeded_effects: number;
  };
  samples: AutomationDeletionSample[];
  samples_truncated: boolean;
  external_follow_up: {
    required: boolean;
    provider_state_reversible_by_agentry: false;
    actions: string[];
    note: string;
  };
}

const NONTERMINAL_RUN_STATUSES = [
  "queued",
  "claimed",
  "running",
  "draft_pr_opened",
  "awaiting_approval",
  "verifying",
] as const;

const WORKFLOW_V3_NONTERMINAL_RUN_STATUSES = [
  "running",
  "awaiting_component",
  "awaiting_approval",
  "effect_reserved",
  "effect_indeterminate",
  "waiting",
  "verifying",
] as const;

/** Correlated DB-clock fence predicate for every authority-creating transition. */
export function automationWritesOpenForProject(
  projectId: string | SQLWrapper,
) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${projectDeletionFences}
    WHERE ${projectDeletionFences.projectId} = ${projectId}
  )`;
}

/** Actionable preflight only; callers still need the correlated write predicate. */
export async function assertAutomationWritesOpen(
  db: AgentryDb,
  projectId: string,
): Promise<void> {
  const fence = (
    await db.select({
      commandId: projectDeletionFences.commandId,
      reason: projectDeletionFences.reason,
      createdAt: projectDeletionFences.createdAt,
    }).from(projectDeletionFences)
      .where(eq(projectDeletionFences.projectId, projectId))
      .limit(1)
  )[0];
  if (!fence) return;
  throw errors.conflict(
    "project_deletion_in_progress",
    "Project deletion has fenced all automation authority transitions.",
    "Stop runner, CI proof, claim, grant, report, and scheduler work. Resume the existing deletion with its original Idempotency-Key and follow the frozen external provider cleanup manifest.",
    {
      project_id: projectId,
      command_id: fence.commandId,
      reason: fence.reason,
      fenced_at: fence.createdAt,
      retryable: false,
    },
  );
}

/**
 * Delete workflow-v3 local state only after the caller has frozen and checked
 * the automation deletion manifest. Database guards require the project fence
 * to remain present throughout this dependency-ordered cleanup.
 */
export async function deleteAutomationWorkflowStateForProjects(
  db: AgentryDb,
  projectIds: string[],
): Promise<void> {
  const ids = [...new Set(projectIds)].sort();
  if (ids.length === 0) return;
  // Effects retain RESTRICT references to their immutable event chain and any
  // approval suspension. Run children must likewise disappear before the
  // immutable run root, which in turn retains its compiled revision.
  await db.delete(automationWorkflowEffects).where(inArray(automationWorkflowEffects.projectId, ids));
  await db.delete(automationWorkflowEffectEvents).where(inArray(automationWorkflowEffectEvents.projectId, ids));
  await db.delete(automationWorkflowSuspensions).where(inArray(automationWorkflowSuspensions.projectId, ids));
  await db.delete(automationWorkflowCommands).where(inArray(automationWorkflowCommands.projectId, ids));
  await db.delete(automationWorkflowRunEvents).where(inArray(automationWorkflowRunEvents.projectId, ids));
  await db.delete(automationWorkflowRunStates).where(inArray(automationWorkflowRunStates.projectId, ids));
  await db.delete(automationWorkflowRunLeases).where(inArray(automationWorkflowRunLeases.projectId, ids));
  await db.delete(automationWorkflowSystemNodeClaims)
    .where(inArray(automationWorkflowSystemNodeClaims.projectId, ids));
  await db.delete(automationWorkflowBudgetCharges).where(inArray(automationWorkflowBudgetCharges.projectId, ids));
  await db.delete(automationWorkflowRuns).where(inArray(automationWorkflowRuns.projectId, ids));
  await db.delete(automationWorkflowTriggerReceipts)
    .where(inArray(automationWorkflowTriggerReceipts.projectId, ids));
  await db.delete(automationWorkflows).where(inArray(automationWorkflows.projectId, ids));
  await db.delete(automationWorkflowExecutionAuthorities)
    .where(inArray(automationWorkflowExecutionAuthorities.projectId, ids));
  await db.delete(automationWorkflowRevisions).where(inArray(automationWorkflowRevisions.projectId, ids));
  await db.delete(automationWorkflowProjectControls)
    .where(inArray(automationWorkflowProjectControls.projectId, ids));
}

/**
 * Freeze the automation authority and external-effect inventory before local
 * project rows cascade. Output is deterministic and bounded, contains no raw
 * evidence or credentials, and is suitable for a durable deletion receipt.
 */
export async function automationDeletionManifest(
  db: AgentryDb,
  projectIds: string[],
): Promise<AutomationDeletionManifest> {
  const uniqueProjectIds = Array.from(new Set(projectIds)).sort();
  const nowResult = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const nowSeconds = Number(nowResult.rows[0]?.now_seconds ?? 0);
  if (uniqueProjectIds.length === 0) return emptyManifest(nowSeconds);

  const sampleLimit = AUTOMATION_DELETION_MANIFEST_SAMPLE_LIMIT;
  const counts = emptyCounts();
  let sampleCandidates: AutomationDeletionSample[] = [];

  for (
    let offset = 0;
    offset < uniqueProjectIds.length;
    offset += DELETION_MANIFEST_PROJECT_PAGE_SIZE
  ) {
    const page = uniqueProjectIds.slice(offset, offset + DELETION_MANIFEST_PROJECT_PAGE_SIZE);
    const summaryResult = await db.run(sql`
      ${automationInventorySql(page, nowSeconds)}
      SELECT
        (SELECT count(*) FROM enabled_contract_rows) AS enabled_contracts,
        (SELECT count(*) FROM enabled_schedule_rows) AS enabled_schedules,
        (SELECT count(*) FROM active_credential_rows) AS active_runner_credentials,
        (SELECT count(*) FROM ready_receipt_rows) AS ready_or_claimed_receipts,
        (SELECT count(*) FROM nonterminal_run_rows) AS nonterminal_runs,
        (SELECT count(*) FROM active_claim_rows) AS active_claims,
        (SELECT count(*) FROM pending_approval_rows) AS pending_approvals,
        (SELECT count(*) FROM active_grant_rows) AS issued_or_consumed_draft_pr_grants,
        (SELECT count(*) FROM known_run_rows WHERE pr_url IS NOT NULL) AS known_pr_identifiers,
        (SELECT count(*) FROM known_run_rows WHERE pr_proof_hash IS NOT NULL) AS known_pr_proof_identifiers,
        (
          (SELECT count(*) FROM known_deploy_rows) +
          (SELECT count(*) FROM known_deploy_run_ids)
        ) AS known_deploy_identifiers,
        (SELECT count(*) FROM known_external_run_ids) AS known_external_effects,
        (
          SELECT count(*)
          FROM possible_keys AS possible
          WHERE NOT EXISTS (
            SELECT 1 FROM known_keys AS known
            WHERE known.sample_key = possible.sample_key
          )
        ) AS possible_or_unknown_external_effects,
        (SELECT count(*) FROM workflow_v3_project_control_rows) AS workflow_v3_project_controls,
        (SELECT count(*) FROM workflow_v3_workflow_rows) AS workflow_v3_workflows,
        (SELECT count(*) FROM workflow_v3_revision_rows) AS workflow_v3_revisions,
        (SELECT count(*) FROM workflow_v3_execution_authority_rows) AS workflow_v3_execution_authorities,
        (SELECT count(*) FROM workflow_v3_trigger_receipt_rows) AS workflow_v3_trigger_receipts,
        (SELECT count(*) FROM workflow_v3_run_rows) AS workflow_v3_runs,
        (SELECT count(*) FROM workflow_v3_system_node_claim_rows) AS workflow_v3_system_node_claims,
        (SELECT count(*) FROM workflow_v3_lease_rows) AS workflow_v3_run_leases,
        (SELECT count(*) FROM workflow_v3_budget_charge_rows) AS workflow_v3_budget_charges,
        (SELECT count(*) FROM workflow_v3_run_state_rows) AS workflow_v3_run_states,
        (SELECT count(*) FROM workflow_v3_command_rows) AS workflow_v3_commands,
        (SELECT count(*) FROM workflow_v3_run_event_rows) AS workflow_v3_run_events,
        (SELECT count(*) FROM workflow_v3_suspension_rows) AS workflow_v3_suspensions,
        (SELECT count(*) FROM workflow_v3_effect_rows) AS workflow_v3_effects,
        (SELECT count(*) FROM workflow_v3_effect_event_rows) AS workflow_v3_effect_events,
        (SELECT count(*) FROM workflow_v3_enabled_workflow_rows) AS workflow_v3_enabled_workflows,
        (SELECT count(*) FROM workflow_v3_ready_trigger_receipt_rows) AS workflow_v3_ready_trigger_receipts,
        (SELECT count(*) FROM workflow_v3_nonterminal_run_rows) AS workflow_v3_nonterminal_runs,
        (SELECT count(*) FROM workflow_v3_active_lease_rows) AS workflow_v3_active_leases,
        (SELECT count(*) FROM workflow_v3_active_system_node_claim_rows)
          AS workflow_v3_active_system_node_claims,
        (SELECT count(*) FROM workflow_v3_pending_suspension_rows) AS workflow_v3_pending_suspensions,
        (SELECT count(*) FROM workflow_v3_external_effect_rows WHERE status = 'reserved')
          AS workflow_v3_external_reserved_effects,
        (SELECT count(*) FROM workflow_v3_external_effect_rows WHERE status = 'indeterminate')
          AS workflow_v3_external_indeterminate_effects,
        (SELECT count(*) FROM workflow_v3_external_effect_rows WHERE status = 'manual_follow_up')
          AS workflow_v3_external_manual_follow_up_effects,
        (SELECT count(*) FROM workflow_v3_external_effect_rows WHERE status = 'succeeded')
          AS workflow_v3_external_succeeded_effects
    `);
    const summary = manifestRows(summaryResult)[0] ?? {};
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[key] += manifestNumber(summary, key);
    }

    const sampleResult = await db.run(sql`
      ${automationInventorySql(page, nowSeconds)},
      all_candidates AS (
        SELECT
          project_id,
          'enabled_contract' AS kind,
          project_id AS id,
          NULL AS automation_id,
          NULL AS run_id,
          'enabled' AS status,
          'possible_or_unknown' AS external_effect_state,
          1 AS effect_priority,
          updated_at AS recorded_at,
          NULL AS pr_url,
          NULL AS pr_proof_hash,
          NULL AS deploy_id,
          NULL AS deploy_sha,
          NULL AS provider_ref,
          'enabled_contract:' || project_id AS sample_key
        FROM enabled_contract_rows
        UNION ALL
        SELECT
          project_id,
          'enabled_schedule',
          project_id || ':' || automation_id,
          automation_id,
          NULL,
          'enabled',
          'possible_or_unknown',
          1,
          updated_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'enabled_schedule:' || project_id || ':' || automation_id
        FROM enabled_schedule_rows
        UNION ALL
        SELECT
          project_id,
          'active_runner_credential',
          id,
          automation_id,
          NULL,
          'active',
          'possible_or_unknown',
          1,
          created_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'active_runner_credential:' || id
        FROM active_credential_rows
        UNION ALL
        SELECT
          project_id,
          'ready_or_claimed_receipt',
          id,
          automation_id,
          run_id,
          status,
          'possible_or_unknown',
          1,
          issued_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          CASE WHEN run_id IS NOT NULL THEN 'run:' || run_id ELSE 'ready_or_claimed_receipt:' || id END
        FROM ready_receipt_rows
        UNION ALL
        SELECT
          project_id,
          'nonterminal_run',
          id,
          automation_id,
          id,
          status,
          CASE
            WHEN pr_url IS NOT NULL OR pr_proof_hash IS NOT NULL OR deploy_sha IS NOT NULL
              THEN 'known'
            ELSE 'possible_or_unknown'
          END,
          CASE
            WHEN pr_url IS NOT NULL OR pr_proof_hash IS NOT NULL OR deploy_sha IS NOT NULL
              THEN 2
            ELSE 1
          END,
          created_at,
          pr_url,
          pr_proof_hash,
          NULL,
          deploy_sha,
          NULL,
          'run:' || id
        FROM nonterminal_run_rows
        UNION ALL
        SELECT
          project_id,
          'active_claim',
          id,
          automation_id,
          run_id,
          'active',
          'possible_or_unknown',
          1,
          acquired_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          CASE WHEN run_id IS NOT NULL THEN 'run:' || run_id ELSE 'active_claim:' || id END
        FROM active_claim_rows
        UNION ALL
        SELECT
          project_id,
          'pending_approval',
          id,
          automation_id,
          run_id,
          'pending',
          'possible_or_unknown',
          1,
          requested_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'run:' || run_id
        FROM pending_approval_rows
        UNION ALL
        SELECT
          project_id,
          'draft_pr_grant',
          id,
          automation_id,
          run_id,
          status,
          'possible_or_unknown',
          1,
          issued_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'run:' || run_id
        FROM active_grant_rows
        UNION ALL
        SELECT
          project_id,
          'known_run_effect',
          id,
          automation_id,
          id,
          status,
          'known',
          2,
          created_at,
          pr_url,
          pr_proof_hash,
          NULL,
          deploy_sha,
          NULL,
          'run:' || id
        FROM known_run_rows
        UNION ALL
        SELECT
          project_id,
          'known_deploy',
          id,
          NULL,
          run_id,
          'recorded',
          'known',
          2,
          received_at,
          NULL,
          NULL,
          id,
          sha,
          NULL,
          CASE
            WHEN run_id IS NOT NULL THEN 'run:' || run_id
            ELSE 'deploy:' || id
          END
        FROM known_deploy_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_enabled_workflow',
          project_id || ':' || automation_id,
          automation_id,
          NULL,
          'enabled',
          'possible_or_unknown',
          1,
          updated_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'workflow_v3_enabled_workflow:' || project_id || ':' || automation_id
        FROM workflow_v3_enabled_workflow_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_trigger_receipt',
          id,
          automation_id,
          consumed_run_id,
          status,
          'possible_or_unknown',
          1,
          issued_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          CASE
            WHEN consumed_run_id IS NOT NULL THEN 'workflow_v3_run:' || consumed_run_id
            ELSE 'workflow_v3_trigger_receipt:' || id
          END
        FROM workflow_v3_ready_trigger_receipt_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_nonterminal_run',
          run_id,
          automation_id,
          run_id,
          status,
          'possible_or_unknown',
          1,
          updated_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'workflow_v3_run:' || run_id
        FROM workflow_v3_nonterminal_run_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_active_lease',
          run_id || ':' || lease_epoch,
          automation_id,
          run_id,
          'active',
          'possible_or_unknown',
          1,
          renewed_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'workflow_v3_lease:' || run_id || ':' || lease_epoch
        FROM workflow_v3_active_lease_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_active_system_node_claim',
          id || ':' || claim_epoch,
          automation_id,
          run_id,
          'active',
          'none_known',
          0,
          claimed_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'workflow_v3_system_node_claim:' || id || ':' || claim_epoch
        FROM workflow_v3_active_system_node_claim_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_pending_suspension',
          id,
          automation_id,
          run_id,
          'pending',
          'possible_or_unknown',
          1,
          updated_at,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          'workflow_v3_suspension:' || id
        FROM workflow_v3_pending_suspension_rows
        UNION ALL
        SELECT
          project_id,
          'workflow_v3_effect',
          id,
          automation_id,
          run_id,
          status,
          CASE
            WHEN status = 'succeeded' THEN 'known'
            ELSE 'possible_or_unknown'
          END,
          CASE
            WHEN status = 'succeeded' THEN 2
            ELSE 1
          END,
          updated_at,
          NULL,
          NULL,
          NULL,
          NULL,
          provider_ref,
          'workflow_v3_effect:' || id
        FROM workflow_v3_risk_effect_rows
      ), ranked_candidates AS (
        SELECT
          *,
          row_number() OVER (
            PARTITION BY sample_key
            ORDER BY effect_priority DESC, kind, recorded_at DESC, id
          ) AS sample_rank
        FROM all_candidates
      )
      SELECT
        project_id,
        kind,
        id,
        automation_id,
        run_id,
        status,
        external_effect_state,
        recorded_at,
        pr_url,
        pr_proof_hash,
        deploy_id,
        deploy_sha,
        provider_ref
      FROM ranked_candidates
      WHERE sample_rank = 1
      ORDER BY effect_priority DESC, recorded_at DESC, project_id, kind, id
      LIMIT ${sampleLimit + 1}
    `);
    sampleCandidates = [
      ...sampleCandidates,
      ...manifestRows(sampleResult).map(automationSampleFromRow),
    ].sort(compareSamples).slice(0, sampleLimit + 1);
  }
  const externalRiskCount = legacyExternalRiskCount(counts) +
    counts.workflow_v3_enabled_workflows +
    counts.workflow_v3_ready_trigger_receipts +
    counts.workflow_v3_nonterminal_runs +
    counts.workflow_v3_active_leases +
    counts.workflow_v3_pending_suspensions +
    counts.workflow_v3_external_indeterminate_effects +
    counts.workflow_v3_external_manual_follow_up_effects +
    counts.workflow_v3_external_succeeded_effects;

  return {
    as_of: nowSeconds,
    project_ids: uniqueProjectIds,
    sample_limit: sampleLimit,
    counts,
    samples: sampleCandidates.slice(0, sampleLimit),
    samples_truncated: sampleCandidates.length > sampleLimit,
    external_follow_up: {
      required: externalRiskCount > 0,
      provider_state_reversible_by_agentry: false,
      actions: externalRiskCount > 0 ? [
        "Disable every matching customer scheduler invoking Codex CLI or Claude Code and every custom runner; deleting Agentry rows cannot stop an external scheduler.",
        "Disable matching GitHub Actions workflows and any ChatGPT Scheduled tasks copies in Scheduled, then inspect queued or in-progress jobs for the project.",
        "Revoke the runner's external repository/provider credentials, including GitHub app, personal access, deploy, and CI secrets; Agentry can revoke only its own project credential.",
        "Inspect every sampled or provider-known PR, proof, deploy, branch, and queued job, then close or revoke it in that provider when required by your retention policy.",
      ] : [],
      note: externalRiskCount > 0
        ? "Agentry fenced and may delete local automation authority, but it cannot disable Codex, Claude, GitHub, CI, repository, or provider state. Counts are complete for the frozen local inventory; samples are deterministic and bounded."
        : "No enabled or nonterminal local automation authority and no provider identifier was present when the deletion receipt was frozen.",
    },
  };
}

function emptyManifest(asOf: number): AutomationDeletionManifest {
  return {
    as_of: asOf,
    project_ids: [],
    sample_limit: AUTOMATION_DELETION_MANIFEST_SAMPLE_LIMIT,
    counts: emptyCounts(),
    samples: [],
    samples_truncated: false,
    external_follow_up: {
      required: false,
      provider_state_reversible_by_agentry: false,
      actions: [],
      note: "No project was selected for automation deletion inventory.",
    },
  };
}

function emptyCounts(): AutomationDeletionManifest["counts"] {
  return {
    enabled_contracts: 0,
    enabled_schedules: 0,
    active_runner_credentials: 0,
    ready_or_claimed_receipts: 0,
    nonterminal_runs: 0,
    active_claims: 0,
    pending_approvals: 0,
    issued_or_consumed_draft_pr_grants: 0,
    known_pr_identifiers: 0,
    known_pr_proof_identifiers: 0,
    known_deploy_identifiers: 0,
    known_external_effects: 0,
    possible_or_unknown_external_effects: 0,
    workflow_v3_project_controls: 0,
    workflow_v3_workflows: 0,
    workflow_v3_revisions: 0,
    workflow_v3_execution_authorities: 0,
    workflow_v3_trigger_receipts: 0,
    workflow_v3_runs: 0,
    workflow_v3_system_node_claims: 0,
    workflow_v3_run_leases: 0,
    workflow_v3_budget_charges: 0,
    workflow_v3_run_states: 0,
    workflow_v3_commands: 0,
    workflow_v3_run_events: 0,
    workflow_v3_suspensions: 0,
    workflow_v3_effects: 0,
    workflow_v3_effect_events: 0,
    workflow_v3_enabled_workflows: 0,
    workflow_v3_ready_trigger_receipts: 0,
    workflow_v3_nonterminal_runs: 0,
    workflow_v3_active_leases: 0,
    workflow_v3_active_system_node_claims: 0,
    workflow_v3_pending_suspensions: 0,
    workflow_v3_external_reserved_effects: 0,
    workflow_v3_external_indeterminate_effects: 0,
    workflow_v3_external_manual_follow_up_effects: 0,
    workflow_v3_external_succeeded_effects: 0,
  };
}

function legacyExternalRiskCount(counts: AutomationDeletionManifest["counts"]): number {
  return counts.enabled_contracts +
    counts.enabled_schedules +
    counts.active_runner_credentials +
    counts.ready_or_claimed_receipts +
    counts.nonterminal_runs +
    counts.active_claims +
    counts.pending_approvals +
    counts.issued_or_consumed_draft_pr_grants +
    counts.known_pr_identifiers +
    counts.known_pr_proof_identifiers +
    counts.known_deploy_identifiers +
    counts.known_external_effects +
    counts.possible_or_unknown_external_effects;
}

function automationInventorySql(projectIds: string[], nowSeconds: number) {
  const projectIdList = sql.join(projectIds.map((projectId) => sql`${projectId}`), sql`, `);
  const nonterminalStatusList = sql.join(
    NONTERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const workflowV3NonterminalStatusList = sql.join(
    WORKFLOW_V3_NONTERMINAL_RUN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  return sql`
    WITH enabled_contract_rows AS (
      SELECT project_id, document_json, updated_at
      FROM automation_contracts
      WHERE project_id IN (${projectIdList})
        AND enabled = 1
        AND paused_at IS NULL
    ), enabled_schedule_rows AS (
      SELECT
        contract.project_id,
        cast(json_extract(automation.value, '$.id') AS text) AS automation_id,
        contract.updated_at
      FROM enabled_contract_rows AS contract
      JOIN json_each(
        CASE
          WHEN json_valid(contract.document_json) THEN contract.document_json
          ELSE '{"automations":[]}'
        END,
        '$.automations'
      ) AS automation
      WHERE json_extract(
          CASE
            WHEN json_valid(contract.document_json) THEN contract.document_json
            ELSE '{}'
          END,
          '$.enabled'
        ) = 1
        AND json_type(automation.value, '$.id') = 'text'
        AND json_extract(automation.value, '$.enabled') = 1
        AND json_extract(automation.value, '$.trigger.kind') = 'schedule'
    ), active_credential_rows AS (
      SELECT id, project_id, automation_id, created_at
      FROM project_credentials
      WHERE project_id IN (${projectIdList})
        AND kind = 'automation_runner'
        AND revoked_at IS NULL
        AND expires_at > ${nowSeconds}
    ), ready_receipt_rows AS (
      SELECT id, project_id, automation_id, run_id, status, issued_at
      FROM automation_trigger_receipts
      WHERE project_id IN (${projectIdList})
        AND status IN ('ready', 'claimed')
    ), nonterminal_run_rows AS (
      SELECT
        id,
        project_id,
        automation_id,
        status,
        pr_url,
        pr_proof_hash,
        deploy_sha,
        created_at
      FROM automation_runs
      WHERE project_id IN (${projectIdList})
        AND status IN (${nonterminalStatusList})
    ), active_claim_rows AS (
      SELECT id, project_id, automation_id, run_id, acquired_at
      FROM case_claims
      WHERE project_id IN (${projectIdList})
        AND released_at IS NULL
    ), pending_approval_rows AS (
      SELECT id, project_id, automation_id, run_id, requested_at
      FROM automation_approvals
      WHERE project_id IN (${projectIdList})
        AND status = 'pending'
    ), active_grant_rows AS (
      SELECT id, project_id, automation_id, run_id, status, issued_at
      FROM automation_action_grants
      WHERE project_id IN (${projectIdList})
        AND status IN ('issued', 'consumed')
    ), known_run_rows AS (
      SELECT
        id,
        project_id,
        automation_id,
        status,
        pr_url,
        pr_proof_hash,
        deploy_sha,
        created_at
      FROM automation_runs
      WHERE project_id IN (${projectIdList})
        AND (pr_url IS NOT NULL OR pr_proof_hash IS NOT NULL OR deploy_sha IS NOT NULL)
    ), known_deploy_rows AS (
      SELECT
        id,
        project_id,
        automation_run_id AS run_id,
        sha,
        received_at
      FROM deploys
      WHERE project_id IN (${projectIdList})
    ), known_deploy_run_ids AS (
      SELECT id AS run_id FROM known_run_rows WHERE deploy_sha IS NOT NULL
      UNION
      SELECT run_id FROM known_deploy_rows WHERE run_id IS NOT NULL
    ), known_external_run_ids AS (
      SELECT id AS run_id FROM known_run_rows
      UNION
      SELECT run_id FROM known_deploy_rows WHERE run_id IS NOT NULL
    ), workflow_v3_project_control_rows AS (
      SELECT project_id
      FROM automation_workflow_project_controls
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_workflow_rows AS (
      SELECT project_id, automation_id, enabled, paused_at, updated_at
      FROM automation_workflows
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_revision_rows AS (
      SELECT id, project_id
      FROM automation_workflow_revisions
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_execution_authority_rows AS (
      SELECT id, project_id, automation_id, enabled_at
      FROM automation_workflow_execution_authorities
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_trigger_receipt_rows AS (
      SELECT id, project_id, automation_id, consumed_run_id, status, issued_at
      FROM automation_workflow_trigger_receipts
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_run_rows AS (
      SELECT id, project_id, automation_id, created_at
      FROM automation_workflow_runs
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_system_node_claim_rows AS (
      SELECT id, project_id, automation_id, run_id, claim_epoch, status,
        claimed_at, expires_at, updated_at
      FROM automation_workflow_system_node_claims
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_lease_rows AS (
      SELECT run_id, project_id, automation_id, lease_epoch, renewed_at, expires_at, released_at
      FROM automation_workflow_run_leases
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_budget_charge_rows AS (
      SELECT id, project_id
      FROM automation_workflow_budget_charges
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_run_state_rows AS (
      SELECT run_id, project_id, automation_id, status, updated_at
      FROM automation_workflow_run_states
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_command_rows AS (
      SELECT run_id, command_id, project_id
      FROM automation_workflow_commands
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_run_event_rows AS (
      SELECT id, project_id
      FROM automation_workflow_run_events
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_suspension_rows AS (
      SELECT id, project_id, automation_id, run_id, status, updated_at
      FROM automation_workflow_suspensions
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_effect_rows AS (
      SELECT id, project_id, automation_id, run_id, component_id, provider_target,
        status, provider_ref, updated_at
      FROM automation_workflow_effects
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_effect_event_rows AS (
      SELECT id, project_id
      FROM automation_workflow_effect_events
      WHERE project_id IN (${projectIdList})
    ), workflow_v3_enabled_workflow_rows AS (
      SELECT project_id, automation_id, updated_at
      FROM workflow_v3_workflow_rows
      WHERE enabled = 1 AND paused_at IS NULL
    ), workflow_v3_ready_trigger_receipt_rows AS (
      SELECT id, project_id, automation_id, consumed_run_id, status, issued_at
      FROM workflow_v3_trigger_receipt_rows
      WHERE status = 'ready'
    ), workflow_v3_nonterminal_run_rows AS (
      SELECT run_id, project_id, automation_id, status, updated_at
      FROM workflow_v3_run_state_rows
      WHERE status IN (${workflowV3NonterminalStatusList})
    ), workflow_v3_active_lease_rows AS (
      SELECT run_id, project_id, automation_id, lease_epoch, renewed_at
      FROM workflow_v3_lease_rows
      WHERE released_at IS NULL AND expires_at > ${nowSeconds}
    ), workflow_v3_active_system_node_claim_rows AS (
      SELECT id, project_id, automation_id, run_id, claim_epoch, claimed_at, expires_at
      FROM workflow_v3_system_node_claim_rows
      WHERE status = 'active' AND expires_at > ${nowSeconds}
    ), workflow_v3_pending_suspension_rows AS (
      SELECT id, project_id, automation_id, run_id, updated_at
      FROM workflow_v3_suspension_rows
      WHERE status = 'pending'
    ), workflow_v3_external_effect_rows AS (
      SELECT id, project_id, automation_id, run_id, component_id, provider_target,
        status,
        CASE
          WHEN component_id = 'effect.github.draft-pr' AND provider_target LIKE 'github:%'
            THEN provider_ref
          ELSE NULL
        END AS provider_ref,
        updated_at
      FROM workflow_v3_effect_rows
      WHERE NOT (component_id = 'effect.report.private' AND provider_target LIKE 'agentry:%')
    ), workflow_v3_risk_effect_rows AS (
      SELECT id, project_id, automation_id, run_id, status, provider_ref, updated_at
      FROM workflow_v3_external_effect_rows
      WHERE status IN ('indeterminate', 'manual_follow_up', 'succeeded')
    ), possible_keys AS (
      SELECT 'enabled_contract:' || project_id AS sample_key FROM enabled_contract_rows
      UNION
      SELECT 'enabled_schedule:' || project_id || ':' || automation_id FROM enabled_schedule_rows
      UNION
      SELECT 'active_runner_credential:' || id FROM active_credential_rows
      UNION
      SELECT CASE
        WHEN run_id IS NOT NULL THEN 'run:' || run_id
        ELSE 'ready_or_claimed_receipt:' || id
      END FROM ready_receipt_rows
      UNION
      SELECT 'run:' || id FROM nonterminal_run_rows
      UNION
      SELECT CASE
        WHEN run_id IS NOT NULL THEN 'run:' || run_id
        ELSE 'active_claim:' || id
      END FROM active_claim_rows
      UNION
      SELECT 'run:' || run_id FROM pending_approval_rows
      UNION
      SELECT 'run:' || run_id FROM active_grant_rows
    ), known_keys AS (
      SELECT 'run:' || id AS sample_key FROM known_run_rows
      UNION
      SELECT CASE
        WHEN run_id IS NOT NULL THEN 'run:' || run_id
        ELSE 'deploy:' || id
      END FROM known_deploy_rows
    )
  `;
}

function automationSampleFromRow(row: Record<string, unknown>): AutomationDeletionSample {
  const prUrl = nullableString(row.pr_url);
  const providerRef = nullableString(row.provider_ref);
  return sample({
    projectId: String(row.project_id),
    kind: String(row.kind) as AutomationDeletionSampleKind,
    id: String(row.id),
    automationId: nullableString(row.automation_id),
    runId: nullableString(row.run_id),
    status: String(row.status),
    externalEffectState: String(row.external_effect_state) as AutomationExternalEffectState,
    recordedAt: nullableNumber(row.recorded_at),
    prUrl: prUrl ? sanitizeExternalUrl(prUrl) : undefined,
    prProofHash: nullableString(row.pr_proof_hash) ?? undefined,
    deployId: nullableString(row.deploy_id) ?? undefined,
    deploySha: nullableString(row.deploy_sha) ?? undefined,
    providerRef: providerRef ? sanitizeProviderReference(providerRef) : undefined,
  });
}

function sample(input: {
  projectId: string;
  kind: AutomationDeletionSampleKind;
  id: string;
  automationId?: string | null;
  runId?: string | null;
  status: string;
  externalEffectState: AutomationExternalEffectState;
  recordedAt?: number | null;
  prUrl?: string;
  prProofHash?: string;
  deployId?: string;
  deploySha?: string;
  providerRef?: string;
}): AutomationDeletionSample {
  return {
    project_id: input.projectId,
    kind: input.kind,
    id: input.id,
    automation_id: input.automationId ?? null,
    run_id: input.runId ?? null,
    status: input.status,
    external_effect_state: input.externalEffectState,
    recorded_at: input.recordedAt ?? null,
    ...(input.prUrl ? { pr_url: input.prUrl } : {}),
    ...(input.prProofHash ? { pr_proof_hash: input.prProofHash } : {}),
    ...(input.deployId ? { deploy_id: input.deployId } : {}),
    ...(input.deploySha ? { deploy_sha: input.deploySha } : {}),
    ...(input.providerRef ? { provider_ref: input.providerRef } : {}),
  };
}

function compareSamples(left: AutomationDeletionSample, right: AutomationDeletionSample): number {
  return effectPriority(right.external_effect_state) - effectPriority(left.external_effect_state) ||
    (right.recorded_at ?? 0) - (left.recorded_at ?? 0) ||
    left.project_id.localeCompare(right.project_id) ||
    left.kind.localeCompare(right.kind) ||
    left.id.localeCompare(right.id);
}

function effectPriority(state: AutomationExternalEffectState): number {
  if (state === "known") return 2;
  if (state === "possible_or_unknown") return 1;
  return 0;
}

function sanitizeExternalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid_or_redacted_external_url";
  }
}

function sanitizeProviderReference(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 500) return "invalid_or_redacted_provider_reference";
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      !/^\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/u.test(url.pathname)
    ) return "invalid_or_redacted_provider_reference";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Provider receipts are deletion evidence, never a generic secret-bearing
    // string channel. New provider identifier shapes require an explicit
    // reviewed sanitizer before they may enter a durable deletion receipt.
  }
  return "invalid_or_redacted_provider_reference";
}

function manifestRows(result: { rows: Iterable<Record<string, unknown>> }): Record<string, unknown>[] {
  return Array.from(result.rows);
}

function manifestNumber(row: Record<string, unknown>, field: string): number {
  return Number(row[field] ?? 0);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
