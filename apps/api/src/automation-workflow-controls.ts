import { and, eq, gt, isNull, notLike, sql } from "drizzle-orm";
import {
  automationWorkflowExecutionAuthorities,
  automationWorkflowProjectControls,
  automationWorkflowRevisions,
  automationWorkflows,
  projectDeletionFences,
  projectCredentials,
} from "@agentry/db/schema";
import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import type { getDb } from "./db.js";
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "./automation-deletion-boundary.js";
import {
  loadAutomationWorkflow,
} from "./automation-workflow-store.js";
import {
  automationWorkflowHeadEtag,
  automationWorkflowProjectControlEtag,
} from "./automation-workflow-identities.js";
import { loadLiveOrderedFunnelExecutionAuthority } from "./automation-workflow-execution-authority.js";
import { readAutomationWorkflowReadiness } from "./automation-workflow-readiness.js";

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Db | Transaction;

async function databaseNow(db: ReadDb, observedAt?: number): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("database clock did not return unix seconds");
  if (observedAt === undefined) return now;
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw errors.invalidPayload({ reason: "observed_at must be a nonnegative integer" });
  }
  if (Math.abs(observedAt - now) > 1) {
    throw errors.invalidPayload({
      reason: "observed_at must match the database clock within one second",
    });
  }
  return now;
}

export type AutomationWorkflowAuthority = {
  open: boolean;
  reason:
    | "open"
    | "project_deletion_fenced"
    | "project_control_missing"
    | "project_paused"
    | "workflow_missing"
    | "workflow_disabled"
    | "workflow_paused"
    | "active_revision_mismatch"
    | "execution_authority_missing"
    | "execution_authority_mismatch"
    | "runner_credential_inactive";
  project_revision: number | null;
  project_paused_at: number | null;
  project_pause_reason: string | null;
  workflow_etag: string | null;
  workflow_enabled: boolean | null;
  workflow_paused_at: number | null;
  workflow_pause_reason: string | null;
  active_revision_id: string | null;
  active_execution_authority_id: string | null;
  runner_credential_id: string | null;
  runner_credential_active: boolean | null;
  deletion_fence: null | {
    command_id: string;
    reason: "project_delete" | "account_delete";
    fenced_at: number;
  };
};

export type AutomationWorkflowProjectControl = {
  kind: "automation_workflow_project_control";
  schema_version: "1";
  project_id: string;
  revision: number;
  etag: string;
  paused: boolean;
  paused_at: number | null;
  pause_reason: string | null;
  updated_at: number;
  next_action: string;
};

export async function readAutomationWorkflowProjectControl(
  db: ReadDb,
  projectId: string,
): Promise<AutomationWorkflowProjectControl | null> {
  const row = (
    await db.select().from(automationWorkflowProjectControls).where(
      eq(automationWorkflowProjectControls.projectId, projectId),
    ).limit(1)
  )[0] ?? null;
  if (!row) return null;
  return {
    kind: "automation_workflow_project_control",
    schema_version: "1",
    project_id: row.projectId,
    revision: row.revision,
    etag: row.etag,
    paused: row.pausedAt !== null,
    paused_at: row.pausedAt,
    pause_reason: row.pauseReason,
    updated_at: row.updatedAt,
    next_action: row.pausedAt === null
      ? "Project workflow authority is open. Inspect each workflow readiness and exact revision before enabling it."
      : "Project workflow authority is paused. Resolve the stated reason, then an owner may resume with this exact ETag.",
  };
}

/**
 * Live authority is deliberately separate from the frozen run policy. Missing
 * control state fails closed, and an old run may proceed only while its exact
 * immutable revision remains the active revision of the workflow head.
 */
export async function readAutomationWorkflowAuthority(
  db: ReadDb,
  projectId: string,
  automationId: string,
  workflowRevisionId: string,
  runnerCredentialId?: string,
  executionAuthorityId?: string | null,
): Promise<AutomationWorkflowAuthority> {
  const deletionFence = (
    await db.select({
      commandId: projectDeletionFences.commandId,
      reason: projectDeletionFences.reason,
      createdAt: projectDeletionFences.createdAt,
    }).from(projectDeletionFences).where(
      eq(projectDeletionFences.projectId, projectId),
    ).limit(1)
  )[0] ?? null;
  const projectControl = (
    await db.select().from(automationWorkflowProjectControls).where(
      eq(automationWorkflowProjectControls.projectId, projectId),
    ).limit(1)
  )[0] ?? null;
  const workflow = (
    await db.select().from(automationWorkflows).where(and(
      eq(automationWorkflows.projectId, projectId),
      eq(automationWorkflows.automationId, automationId),
    )).limit(1)
  )[0] ?? null;
  const executionAuthority = !workflow?.activeExecutionAuthorityId || executionAuthorityId === null
    ? null
    : (
        await db.select({
          id: automationWorkflowExecutionAuthorities.id,
          runnerCredentialId: automationWorkflowExecutionAuthorities.runnerCredentialId,
        })
          .from(automationWorkflowExecutionAuthorities)
          .innerJoin(
            automationWorkflowRevisions,
            and(
              eq(automationWorkflowRevisions.id, automationWorkflowExecutionAuthorities.workflowRevisionId),
              eq(automationWorkflowRevisions.projectId, automationWorkflowExecutionAuthorities.projectId),
              eq(automationWorkflowRevisions.automationId, automationWorkflowExecutionAuthorities.automationId),
              eq(automationWorkflowRevisions.workflowHash, automationWorkflowExecutionAuthorities.workflowHash),
              eq(automationWorkflowRevisions.compileHash, automationWorkflowExecutionAuthorities.compileHash),
            ),
          )
          .where(and(
            eq(automationWorkflowExecutionAuthorities.id, workflow.activeExecutionAuthorityId),
            eq(automationWorkflowExecutionAuthorities.projectId, projectId),
            eq(automationWorkflowExecutionAuthorities.automationId, automationId),
            eq(automationWorkflowExecutionAuthorities.workflowRevisionId, workflowRevisionId),
            executionAuthorityId !== undefined
              ? eq(automationWorkflowExecutionAuthorities.id, executionAuthorityId)
              : undefined,
            runnerCredentialId
              ? eq(automationWorkflowExecutionAuthorities.runnerCredentialId, runnerCredentialId)
              : undefined,
          )).limit(1)
      )[0] ?? null;
  const effectiveRunnerCredentialId = runnerCredentialId ?? executionAuthority?.runnerCredentialId;
  const runnerCredentialActive = effectiveRunnerCredentialId === undefined
    ? null
    : (
        await db.select({ id: projectCredentials.id }).from(projectCredentials).where(and(
          eq(projectCredentials.id, effectiveRunnerCredentialId),
          eq(projectCredentials.projectId, projectId),
          eq(projectCredentials.kind, "automation_runner"),
          eq(projectCredentials.automationId, automationId),
          isNull(projectCredentials.revokedAt),
          gt(projectCredentials.expiresAt, sql`unixepoch()`),
          notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
        )).limit(1)
      ).length === 1;
  const reason: AutomationWorkflowAuthority["reason"] = deletionFence
    ? "project_deletion_fenced"
    : !projectControl
      ? "project_control_missing"
      : projectControl.pausedAt !== null
        ? "project_paused"
        : !workflow
          ? "workflow_missing"
          : workflow.pausedAt !== null
            ? "workflow_paused"
            : workflow.enabled !== 1
              ? "workflow_disabled"
              : workflow.activeRevisionId !== workflowRevisionId
                ? "active_revision_mismatch"
                : !workflow.activeExecutionAuthorityId
                  ? "execution_authority_missing"
                  : (executionAuthorityId !== undefined &&
                      workflow.activeExecutionAuthorityId !== executionAuthorityId) ||
                      !executionAuthority
                    ? "execution_authority_mismatch"
                : runnerCredentialActive === false
                  ? "runner_credential_inactive"
                  : "open";
  return {
    open: reason === "open",
    reason,
    project_revision: projectControl?.revision ?? null,
    project_paused_at: projectControl?.pausedAt ?? null,
    project_pause_reason: projectControl?.pauseReason ?? null,
    workflow_etag: workflow?.etag ?? null,
    workflow_enabled: workflow ? workflow.enabled === 1 : null,
    workflow_paused_at: workflow?.pausedAt ?? null,
    workflow_pause_reason: workflow?.pauseReason ?? null,
    active_revision_id: workflow?.activeRevisionId ?? null,
    active_execution_authority_id: workflow?.activeExecutionAuthorityId ?? null,
    runner_credential_id: effectiveRunnerCredentialId ?? null,
    runner_credential_active: runnerCredentialActive,
    deletion_fence: deletionFence ? {
      command_id: deletionFence.commandId,
      reason: deletionFence.reason,
      fenced_at: deletionFence.createdAt,
    } : null,
  };
}

export async function assertAutomationWorkflowAuthorityOpen(
  db: ReadDb,
  projectId: string,
  automationId: string,
  workflowRevisionId: string,
  runnerCredentialId?: string,
  executionAuthorityId?: string | null,
): Promise<void> {
  const authority = await readAutomationWorkflowAuthority(
    db,
    projectId,
    automationId,
    workflowRevisionId,
    runnerCredentialId,
    executionAuthorityId,
  );
  if (!authority.open) {
    if (authority.reason === "project_deletion_fenced") {
      throw errors.conflict(
        "project_deletion_in_progress",
        "Project deletion has fenced all automation authority transitions.",
        "Stop runner, system-advance, and provider work. Resume the existing deletion with its original Idempotency-Key and follow the frozen external provider cleanup manifest.",
        {
          project_id: projectId,
          automation_id: automationId,
          workflow_revision_id: workflowRevisionId,
          command_id: authority.deletion_fence?.command_id ?? null,
          reason: authority.deletion_fence?.reason ?? null,
          fenced_at: authority.deletion_fence?.fenced_at ?? null,
          retryable: false,
        },
      );
    }
    if (authority.reason === "runner_credential_inactive") {
      throw errors.conflict(
        "automation_workflow_runner_credential_inactive",
        "The frozen runner credential is revoked, expired, disabled, or no longer bound to this workflow run.",
        "Stop all execution for this run. An owner must restore one exact active runner credential before a new run can execute; preserve already-started provider receipts for settlement or reconciliation only.",
        {
          project_id: projectId,
          automation_id: automationId,
          workflow_revision_id: workflowRevisionId,
          runner_credential_id: runnerCredentialId ?? null,
        },
      );
    }
    if (
      authority.reason === "execution_authority_missing" ||
      authority.reason === "execution_authority_mismatch"
    ) {
      throw errors.conflict(
        "automation_workflow_execution_authority_inactive",
        "The run's immutable execution authority is missing or no longer matches the active workflow head.",
        "Do not advance or query analytics. Pause the workflow, then save, review, and enable a new exact revision.",
        {
          project_id: projectId,
          automation_id: automationId,
          workflow_revision_id: workflowRevisionId,
          execution_authority_id: executionAuthorityId ?? null,
          active_execution_authority_id: authority.active_execution_authority_id,
          authority_reason: authority.reason,
          retryable: false,
        },
      );
    }
    throw errors.conflict(
      "automation_workflow_kill_switch_active",
      "The project or workflow kill switch is active for this run revision.",
      "Do not start or advance work. An owner may inspect the pause reason; already-started provider effects remain reconciliation-only.",
      {
        project_id: projectId,
        automation_id: automationId,
        workflow_revision_id: workflowRevisionId,
        authority_reason: authority.reason,
        project_pause_reason: authority.project_pause_reason,
        workflow_pause_reason: authority.workflow_pause_reason,
      },
    );
  }
}

function boundedReason(reasonInput: string): string {
  const reason = reasonInput.trim();
  if (reason.length < 1 || reason.length > 1_000) {
    throw errors.invalidPayload({ reason: "pause reason must contain 1-1000 characters" });
  }
  return reason;
}

/** Emergency project-wide kill switch. It intentionally needs no ETag. */
export async function pauseAutomationWorkflowProject(
  db: Db,
  input: {
    project_id: string;
    actor_user_id: string;
    reason: string;
    observed_at?: number;
  },
) {
  const reason = boundedReason(input.reason);
  await assertAutomationWritesOpen(db, input.project_id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = (
      await db.select().from(automationWorkflowProjectControls).where(
        eq(automationWorkflowProjectControls.projectId, input.project_id),
      ).limit(1)
    )[0] ?? null;
    if (!current) {
      throw errors.conflict(
        "automation_workflow_control_missing",
        "The workflow project control row is missing, so execution is already fail-closed.",
        "Repair the workflow control plane before attempting to enable or resume workflows.",
        { project_id: input.project_id },
      );
    }
    if (current.pausedAt !== null && current.pauseReason === reason) {
      return {
        project_id: input.project_id,
        paused: true,
        paused_at: current.pausedAt,
        pause_reason: current.pauseReason,
        revision: current.revision,
        etag: current.etag,
      };
    }
    const now = await databaseNow(db, input.observed_at);
    const revision = current.revision + 1;
    const etag = await automationWorkflowProjectControlEtag({
      project_id: input.project_id,
      revision,
      paused_at: now,
      pause_reason: reason,
      updated_at: now,
    });
    const changed = await db.update(automationWorkflowProjectControls).set({
      revision,
      etag,
      pausedAt: now,
      pauseReason: reason,
      updatedBy: input.actor_user_id,
      updatedAt: now,
    }).where(and(
      eq(automationWorkflowProjectControls.projectId, input.project_id),
      eq(automationWorkflowProjectControls.revision, current.revision),
      eq(automationWorkflowProjectControls.etag, current.etag),
      automationWritesOpenForProject(automationWorkflowProjectControls.projectId),
    )).returning({ projectId: automationWorkflowProjectControls.projectId });
    if (changed.length === 1) {
      return {
        project_id: input.project_id,
        paused: true,
        paused_at: now,
        pause_reason: reason,
        revision,
        etag,
      };
    }
  }
  throw errors.conflict(
    "automation_workflow_pause_contention",
    "The workflow project control kept changing while the emergency pause was applied.",
    "Retry the emergency pause immediately.",
    { project_id: input.project_id },
  );
}

/** Conditional recovery from a project-wide emergency pause. */
export async function resumeAutomationWorkflowProject(
  db: Db,
  input: {
    project_id: string;
    actor_user_id: string;
    expected_etag: string;
    observed_at?: number;
  },
) {
  await assertAutomationWritesOpen(db, input.project_id);
  const current = (
    await db.select().from(automationWorkflowProjectControls).where(
      eq(automationWorkflowProjectControls.projectId, input.project_id),
    ).limit(1)
  )[0] ?? null;
  if (!current) throw errors.conflict(
    "automation_workflow_control_missing",
    "The workflow project control row is missing, so execution is fail-closed.",
    "Save a disabled workflow to initialize the control plane before attempting resume.",
    { project_id: input.project_id },
  );
  if (current.etag !== input.expected_etag) {
    throw errors.preconditionFailed(
      "The workflow project control changed before resume.",
      "Reload project workflow control, review its pause state, and retry only with the new exact ETag.",
      { current_etag: current.etag, current_revision: current.revision },
    );
  }
  if (current.pausedAt === null) {
    return readAutomationWorkflowProjectControl(db, input.project_id);
  }
  const now = await databaseNow(db, input.observed_at);
  const revision = current.revision + 1;
  const etag = await automationWorkflowProjectControlEtag({
    project_id: input.project_id,
    revision,
    paused_at: null,
    pause_reason: null,
    updated_at: now,
  });
  const changed = await db.update(automationWorkflowProjectControls).set({
    revision,
    etag,
    pausedAt: null,
    pauseReason: null,
    updatedBy: input.actor_user_id,
    updatedAt: now,
  }).where(and(
    eq(automationWorkflowProjectControls.projectId, input.project_id),
    eq(automationWorkflowProjectControls.revision, current.revision),
    eq(automationWorkflowProjectControls.etag, current.etag),
    automationWritesOpenForProject(automationWorkflowProjectControls.projectId),
  )).returning({ projectId: automationWorkflowProjectControls.projectId });
  if (changed.length !== 1) throw errors.preconditionFailed(
    "The workflow project control changed during resume.",
    "Reload project workflow control and retry only after reviewing its current state.",
    { project_id: input.project_id },
  );
  return readAutomationWorkflowProjectControl(db, input.project_id);
}

/** Activate exactly the current immutable revision after external readiness proof. */
export async function enableAutomationWorkflow(
  db: Db,
  input: {
    project_id: string;
    automation_id: string;
    workflow_revision_id: string;
    actor_user_id: string;
    expected_etag: string;
    readiness_hash: string;
    owner_confirmed_caller_assertion_ids: string[];
    observed_at?: number;
  },
) {
  await assertAutomationWritesOpen(db, input.project_id);
  const loaded = await loadAutomationWorkflow(db, input.project_id, input.automation_id);
  if (!loaded) throw errors.notFound("automation_workflow");
  if (loaded.etag !== input.expected_etag) {
    throw errors.preconditionFailed(
      "The automation workflow changed before enablement.",
      "Reload the workflow, review its exact immutable revision and readiness, then retry with its current ETag.",
      { current_etag: loaded.etag, current_revision_id: loaded.revision_id },
    );
  }
  if (loaded.revision_id !== input.workflow_revision_id) {
    throw errors.conflict(
      "automation_workflow_enable_revision_mismatch",
      "Enablement named a different immutable workflow revision.",
      "Use the revision_id from the same workflow GET and readiness response as If-Match.",
      { current_revision_id: loaded.revision_id, requested_revision_id: input.workflow_revision_id },
    );
  }
  const confirmations = [...new Set(input.owner_confirmed_caller_assertion_ids)].sort();
  const readiness = await readAutomationWorkflowReadiness(db, {
    project_id: input.project_id,
    automation_id: input.automation_id,
    expected_revision_id: input.workflow_revision_id,
    expected_etag: input.expected_etag,
    owner_confirmed_caller_assertion_ids: confirmations,
    ...(input.observed_at === undefined ? {} : { observed_at: input.observed_at }),
  });
  if (readiness.status !== "ready" || readiness.readiness_hash !== input.readiness_hash) {
    throw errors.preconditionFailed(
      "Workflow readiness changed before its execution authority could be minted.",
      "Re-read readiness with the same explicit confirmations, review every exact check, and retry with its current readiness_hash and ETag.",
      {
        current_readiness_hash: readiness.readiness_hash,
        received_readiness_hash: input.readiness_hash,
        status: readiness.status,
        blockers: readiness.blockers,
      },
    );
  }
  const executionAuthority = await loadLiveOrderedFunnelExecutionAuthority();
  const exactBlueprintEvidence = executionAuthority
    ? `query_blueprint:ordered_funnel_period_compare:${executionAuthority.descriptor_hash}`
    : null;
  const blueprintCheck = readiness.checks.find(
    (check) => check.id === "ordered_funnel_blueprint_available",
  );
  if (
    !executionAuthority ||
    !exactBlueprintEvidence ||
    blueprintCheck?.status !== "ready" ||
    !blueprintCheck.evidence_ids.includes(exactBlueprintEvidence)
  ) {
    throw errors.conflict(
      "automation_workflow_execution_descriptor_not_ready",
      "Readiness did not prove the exact ordered-funnel execution descriptor being enabled.",
      "Keep the workflow disabled. Restore the reviewed blueprint and runtime descriptor, then re-read readiness and explicitly enable its new hash.",
      {
        readiness_hash: readiness.readiness_hash,
        execution_descriptor_hash: executionAuthority?.descriptor_hash ?? null,
        evidence_ids: blueprintCheck?.evidence_ids ?? [],
      },
    );
  }
  const projectControl = await readAutomationWorkflowProjectControl(db, input.project_id);
  if (!projectControl || projectControl.paused) {
    throw errors.conflict(
      "automation_workflow_project_kill_switch_active",
      "Project workflow authority is paused or missing.",
      "Read project workflow control and resolve its pause before enabling an individual workflow.",
      { project_id: input.project_id, pause_reason: projectControl?.pause_reason ?? null },
    );
  }
  const now = await databaseNow(db, input.observed_at);
  const credentials = await db.select({ id: projectCredentials.id }).from(projectCredentials).where(and(
    eq(projectCredentials.projectId, input.project_id),
    eq(projectCredentials.kind, "automation_runner"),
    eq(projectCredentials.automationId, input.automation_id),
    isNull(projectCredentials.revokedAt),
    gt(projectCredentials.expiresAt, now),
    notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
  )).limit(2);
  if (credentials.length !== 1) {
    throw errors.conflict(
      "automation_workflow_runner_credential_ambiguous",
      credentials.length === 0
        ? "The workflow has no active exact runner credential."
        : "The workflow has more than one active runner credential.",
      "Keep the workflow disabled until exactly one active automation_runner credential is bound to this automation id.",
      { automation_id: input.automation_id, active_runner_credentials: credentials.length },
    );
  }
  const confirmationsJson = canonicalJsonStringify(confirmations);
  const executionAuthorityId = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-execution-authority-v1",
    project_id: loaded.project_id,
    automation_id: loaded.automation_id,
    workflow_revision_id: loaded.revision_id,
    workflow_hash: loaded.workflow_hash,
    compile_hash: loaded.compile_hash,
    readiness_hash: readiness.readiness_hash,
    owner_confirmed_caller_assertion_ids: confirmations,
    descriptor_kind: executionAuthority.descriptor_kind,
    descriptor_hash: executionAuthority.descriptor_hash,
    runner_credential_id: credentials[0]!.id,
    enabled_by: input.actor_user_id,
    enabled_at: now,
  }));
  const insertedAuthority = await db.insert(automationWorkflowExecutionAuthorities).values({
    id: executionAuthorityId,
    projectId: loaded.project_id,
    automationId: loaded.automation_id,
    workflowRevisionId: loaded.revision_id,
    workflowHash: loaded.workflow_hash,
    compileHash: loaded.compile_hash,
    readinessHash: readiness.readiness_hash,
    ownerConfirmedCallerAssertionIdsJson: confirmationsJson,
    descriptorKind: executionAuthority.descriptor_kind,
    descriptorJson: executionAuthority.descriptor_json,
    descriptorHash: executionAuthority.descriptor_hash,
    runnerCredentialId: credentials[0]!.id,
    enabledBy: input.actor_user_id,
    enabledAt: now,
  }).onConflictDoNothing().returning({ id: automationWorkflowExecutionAuthorities.id });
  if (insertedAuthority.length !== 1) {
    throw errors.preconditionFailed(
      "The exact execution authority already exists but is not bound to this workflow head.",
      "Reload workflow control and readiness before retrying enablement; never reuse an authority receipt through a different request.",
      { execution_authority_id: executionAuthorityId },
    );
  }
  const etag = await automationWorkflowHeadEtag({
    project_id: loaded.project_id,
    automation_id: loaded.automation_id,
    current_revision_id: loaded.revision_id,
    current_revision: loaded.revision,
    workflow_hash: loaded.workflow_hash,
    compile_hash: loaded.compile_hash,
    enabled: true,
    active_revision_id: loaded.revision_id,
    active_execution_authority_id: executionAuthorityId,
    paused_at: null,
    pause_reason: null,
    updated_at: now,
  });
  const changed = await db.update(automationWorkflows).set({
    enabled: 1,
    activeRevisionId: loaded.revision_id,
    activeExecutionAuthorityId: executionAuthorityId,
    pausedAt: null,
    pauseReason: null,
    etag,
    updatedBy: input.actor_user_id,
    updatedAt: now,
  }).where(and(
    eq(automationWorkflows.projectId, input.project_id),
    eq(automationWorkflows.automationId, input.automation_id),
    eq(automationWorkflows.currentRevisionId, input.workflow_revision_id),
    eq(automationWorkflows.etag, input.expected_etag),
    automationWritesOpenForProject(automationWorkflows.projectId),
  )).returning({ projectId: automationWorkflows.projectId });
  if (changed.length !== 1) throw errors.preconditionFailed(
    "The automation workflow changed during enablement.",
    "Reload the workflow and readiness; never enable a revision that lost its compare-and-set race.",
    { automation_id: input.automation_id },
  );
  return {
    workflow: await loadAutomationWorkflow(db, input.project_id, input.automation_id),
    runner_credential_id: credentials[0]!.id,
    execution_authority_id: executionAuthorityId,
    execution_descriptor_hash: executionAuthority.descriptor_hash,
  };
}

/** Emergency automation-specific kill switch. It intentionally needs no ETag. */
export async function pauseAutomationWorkflow(
  db: Db,
  input: {
    project_id: string;
    automation_id: string;
    actor_user_id: string;
    reason: string;
    observed_at?: number;
  },
) {
  const reason = boundedReason(input.reason);
  await assertAutomationWritesOpen(db, input.project_id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await loadAutomationWorkflow(db, input.project_id, input.automation_id);
    if (!loaded) throw errors.notFound("automation_workflow");
    if (!loaded.enabled && loaded.paused_at !== null && loaded.pause_reason === reason) {
      return {
        project_id: input.project_id,
        automation_id: input.automation_id,
        enabled: false,
        paused_at: loaded.paused_at,
        pause_reason: loaded.pause_reason,
        etag: loaded.etag,
      };
    }
    const now = await databaseNow(db, input.observed_at);
    const etag = await automationWorkflowHeadEtag({
      project_id: loaded.project_id,
      automation_id: loaded.automation_id,
      current_revision_id: loaded.revision_id,
      current_revision: loaded.revision,
      workflow_hash: loaded.workflow_hash,
      compile_hash: loaded.compile_hash,
      enabled: false,
      active_revision_id: null,
      active_execution_authority_id: null,
      paused_at: now,
      pause_reason: reason,
      updated_at: now,
    });
    const changed = await db.update(automationWorkflows).set({
      enabled: 0,
      activeRevisionId: null,
      activeExecutionAuthorityId: null,
      etag,
      pausedAt: now,
      pauseReason: reason,
      updatedBy: input.actor_user_id,
      updatedAt: now,
    }).where(and(
      eq(automationWorkflows.projectId, input.project_id),
      eq(automationWorkflows.automationId, input.automation_id),
      eq(automationWorkflows.etag, loaded.etag),
      automationWritesOpenForProject(automationWorkflows.projectId),
    )).returning({ projectId: automationWorkflows.projectId });
    if (changed.length === 1) {
      return {
        project_id: input.project_id,
        automation_id: input.automation_id,
        enabled: false,
        paused_at: now,
        pause_reason: reason,
        etag,
      };
    }
  }
  throw errors.conflict(
    "automation_workflow_pause_contention",
    "The workflow kept changing while the emergency pause was applied.",
    "Retry the emergency pause immediately.",
    { project_id: input.project_id, automation_id: input.automation_id },
  );
}
