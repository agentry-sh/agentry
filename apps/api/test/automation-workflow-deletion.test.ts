import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
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
  projectCredentials,
  projectDeletionFences,
  projects,
  users,
} from "@agentry/db/schema";
import {
  automationDeletionManifest,
  deleteAutomationWorkflowStateForProjects,
} from "../src/automation-deletion-boundary.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "workflow-deletion-owner";
const PROJECT_ID = "workflow-deletion-project";
const AUTOMATION_ID = "workflow-deletion-automation";
const REVISION_ID = "workflow-deletion-revision";
const RUN_ID = "awrun_workflow_deletion";
const EFFECT_ID = "awfeffect_workflow_deletion";
const RUNNER_CREDENTIAL_ID = "workflow-deletion-runner";
const LIMITS = {
  max_runs_per_day: 3,
  max_attempts_per_trigger: 2,
  max_turns_per_run: 20,
  max_active_runtime_seconds: 600,
  max_elapsed_seconds: 3_600,
  max_cost_usd_per_run: 5,
  retry_backoff_seconds: 60,
  max_external_effects_per_run: 2,
  max_external_effects_per_day: 5,
  max_files_changed_per_run: 5,
  max_changed_lines_per_run: 200,
} as const;
const LIMITS_JSON = JSON.stringify(LIMITS);

const hash = (digit: string) => digit.repeat(64);
const EXECUTION_AUTHORITY_ID = hash("a");
const EXECUTION_DESCRIPTOR_HASH = hash("b");

type Db = ReturnType<typeof getDbForUrl>;
let env: TestEnv;
let db: Db;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(users).values({ id: OWNER_ID, email: "workflow-deletion@example.test" });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Workflow deletion",
  });
});

afterEach(() => disposeTestEnv(env));

describe("workflow-v3 deletion inventory", () => {
  it("accounts for disabled control-plane history without inventing external cleanup", async () => {
    await seedWorkflowHead(false);

    const manifest = await automationDeletionManifest(db, [PROJECT_ID]);

    expect(manifest.counts).toMatchObject({
      workflow_v3_project_controls: 1,
      workflow_v3_workflows: 1,
      workflow_v3_revisions: 1,
      workflow_v3_execution_authorities: 0,
      workflow_v3_runs: 0,
      workflow_v3_enabled_workflows: 0,
      workflow_v3_nonterminal_runs: 0,
      workflow_v3_active_leases: 0,
      workflow_v3_effects: 0,
    });
    expect(manifest.samples).toEqual([]);
    expect(manifest.external_follow_up.required).toBe(false);
  });

  it("freezes every runtime table and deletes the complete graph in dependency order", async () => {
    await seedWorkflowHead(true);
    await withRuntimeTriggersDisabled(() => seedRuntimeGraph());

    const frozen = await automationDeletionManifest(db, [PROJECT_ID]);
    expect(frozen.counts).toMatchObject({
      workflow_v3_project_controls: 1,
      workflow_v3_workflows: 1,
      workflow_v3_revisions: 1,
      workflow_v3_execution_authorities: 1,
      workflow_v3_trigger_receipts: 1,
      workflow_v3_runs: 1,
      workflow_v3_system_node_claims: 1,
      workflow_v3_run_leases: 1,
      workflow_v3_budget_charges: 2,
      workflow_v3_run_states: 1,
      workflow_v3_commands: 1,
      workflow_v3_run_events: 2,
      workflow_v3_suspensions: 1,
      workflow_v3_effects: 1,
      workflow_v3_effect_events: 3,
      workflow_v3_enabled_workflows: 1,
      workflow_v3_ready_trigger_receipts: 0,
      workflow_v3_nonterminal_runs: 1,
      workflow_v3_active_leases: 1,
      workflow_v3_active_system_node_claims: 1,
      workflow_v3_pending_suspensions: 1,
      workflow_v3_external_reserved_effects: 0,
      workflow_v3_external_indeterminate_effects: 0,
      workflow_v3_external_manual_follow_up_effects: 0,
      workflow_v3_external_succeeded_effects: 1,
    });
    expect(new Set(frozen.samples.map((entry) => entry.kind))).toEqual(new Set([
      "active_runner_credential",
      "workflow_v3_enabled_workflow",
      "workflow_v3_nonterminal_run",
      "workflow_v3_active_lease",
      "workflow_v3_active_system_node_claim",
      "workflow_v3_pending_suspension",
      "workflow_v3_effect",
    ]));
    expect(frozen.samples.find((entry) => entry.kind === "workflow_v3_effect")).toMatchObject({
      id: EFFECT_ID,
      external_effect_state: "known",
      provider_ref: "https://github.com/acme/app/pull/42",
    });
    expect(frozen.external_follow_up.required).toBe(true);

    const repeated = await automationDeletionManifest(db, [PROJECT_ID]);
    expect({ ...repeated, as_of: frozen.as_of }).toEqual(frozen);

    await expect(deleteAutomationWorkflowStateForProjects(db, [PROJECT_ID]))
      .rejects.toThrow();
    expect(await rowCount(automationWorkflowEffects)).toBe(1);

    await db.insert(projectDeletionFences).values({
      projectId: PROJECT_ID,
      commandId: "delete-workflow-runtime",
      reason: "project_delete",
      actor: OWNER_ID,
    });
    await deleteAutomationWorkflowStateForProjects(db, [PROJECT_ID]);

    for (const table of workflowV3Tables()) expect(await rowCount(table)).toBe(0);
    expect(await rowCount(projects)).toBe(1);
    const foreignKeyCheck = await db.run(sql`PRAGMA foreign_key_check`);
    expect(Array.from(foreignKeyCheck.rows)).toEqual([]);
  });

  it("counts Agentry-private effects as local history rather than provider cleanup", async () => {
    await seedWorkflowHead(true);
    await withRuntimeTriggersDisabled(() => seedRuntimeGraph({
      componentId: "effect.report.private",
      providerTarget: "agentry:private-report",
      providerRef: "private-report-id-must-not-enter-the-manifest",
    }));

    const manifest = await automationDeletionManifest(db, [PROJECT_ID]);
    expect(manifest.counts.workflow_v3_effects).toBe(1);
    expect(manifest.counts.workflow_v3_external_succeeded_effects).toBe(0);
    expect(manifest.samples.some((entry) => entry.kind === "workflow_v3_effect")).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("private-report-id-must-not-enter-the-manifest");
  });
});

async function seedWorkflowHead(enabled: boolean): Promise<void> {
  const now = await databaseNow();
  await db.insert(automationWorkflowProjectControls).values({
    projectId: PROJECT_ID,
    revision: 1,
    etag: "workflow-project-control-etag",
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(automationWorkflowRevisions).values({
    id: REVISION_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    revision: 1,
    schemaVersion: "3",
    workflowJson: JSON.stringify({ limits: LIMITS }),
    workflowHash: hash("1"),
    compiledJson: "{}",
    compileHash: hash("2"),
    componentHashesJson: "{}",
    createdBy: OWNER_ID,
    createdAt: now,
  });
  await db.insert(automationWorkflows).values({
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    currentRevisionId: REVISION_ID,
    currentRevision: 1,
    activeRevisionId: enabled ? REVISION_ID : null,
    etag: "workflow-head-etag",
    enabled: enabled ? 1 : 0,
    createdBy: OWNER_ID,
    updatedBy: OWNER_ID,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedRuntimeGraph(effect: {
  componentId: string;
  providerTarget: string;
  providerRef: string;
} = {
  componentId: "effect.github.draft-pr",
  providerTarget: "github:acme/app",
  providerRef: "https://github.com/acme/app/pull/42?token=redacted#receipt",
}): Promise<void> {
  const now = await databaseNow();
  const requestHash = hash("5");
  const stateHash = hash("7");
  const runStartedEventId = hash("b");
  const waitRegisteredEventId = hash("d");
  const waitDeadlineAt = now + 300;
  await db.insert(projectCredentials).values({
    id: RUNNER_CREDENTIAL_ID,
    projectId: PROJECT_ID,
    kind: "automation_runner",
    name: "Workflow deletion runner",
    prefix: "agentry_runner_workflow_deletion",
    tokenHash: hash("8"),
    automationId: AUTOMATION_ID,
    createdBy: OWNER_ID,
    createdAt: now,
    expiresAt: now + 3_600,
  });
  await db.insert(automationWorkflowExecutionAuthorities).values({
    id: EXECUTION_AUTHORITY_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    workflowRevisionId: REVISION_ID,
    workflowHash: hash("1"),
    compileHash: hash("2"),
    readinessHash: hash("3"),
    ownerConfirmedCallerAssertionIdsJson: "[]",
    descriptorKind: "ordered_funnel_period_compare",
    descriptorJson: JSON.stringify({ kind: "ordered_funnel_period_compare", schema_version: "1" }),
    descriptorHash: EXECUTION_DESCRIPTOR_HASH,
    runnerCredentialId: RUNNER_CREDENTIAL_ID,
    enabledBy: OWNER_ID,
    enabledAt: now,
  });
  await db.update(automationWorkflows).set({
    activeExecutionAuthorityId: EXECUTION_AUTHORITY_ID,
  }).where(eq(automationWorkflows.automationId, AUTOMATION_ID));
  await db.insert(automationWorkflowTriggerReceipts).values({
    id: "workflow-trigger-receipt",
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    workflowRevisionId: REVISION_ID,
    workflowHash: hash("1"),
    compileHash: hash("2"),
    executionAuthorityId: EXECUTION_AUTHORITY_ID,
    triggerNodeId: "schedule_trigger",
    componentId: "trigger.schedule.cron",
    componentVersion: "1.0.0",
    componentHash: hash("9"),
    outputContract: "schedule_trigger_receipt@1",
    outputSchemaHash: hash("a"),
    triggerKind: "schedule",
    triggerKey: "2026-07-13T09:00:00Z",
    attempt: 1,
    payloadJson: "{}",
    payloadHash: hash("3"),
    sourceTrust: "agentry_system",
    status: "consumed",
    consumedRunId: RUN_ID,
    issuedAt: now,
    availableAt: now,
    expiresAt: now + 3_600,
    consumedAt: now,
    updatedAt: now,
  });
  await db.insert(automationWorkflowRuns).values({
    id: RUN_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    workflowRevisionId: REVISION_ID,
    workflowHash: hash("1"),
    compileHash: hash("2"),
    executionAuthorityId: EXECUTION_AUTHORITY_ID,
    executionDescriptorHash: EXECUTION_DESCRIPTOR_HASH,
    triggerReceiptId: "workflow-trigger-receipt",
    triggerKind: "schedule",
    triggerKey: "2026-07-13T09:00:00Z",
    triggerPayloadJson: "{}",
    triggerPayloadHash: hash("3"),
    attempt: 1,
    idempotencyKeyHash: hash("4"),
    requestHash,
    limitsJson: LIMITS_JSON,
    limitsHash: hash("6"),
    runnerCredentialId: RUNNER_CREDENTIAL_ID,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(automationWorkflowRunEvents).values({
    id: runStartedEventId,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    sequence: 1,
    commandId: "workflow-start-command",
    requestHash,
    eventVersion: "1",
    event: "run.started",
    workflowHash: hash("1"),
    compileHash: hash("2"),
    payloadJson: JSON.stringify({
      project_id: PROJECT_ID,
      automation_id: AUTOMATION_ID,
      workflow_revision: 1,
      started_at: now,
      elapsed_deadline_at: now + LIMITS.max_elapsed_seconds,
    }),
    payloadHash: hash("c"),
    actorPrincipal: "agentry_system",
    at: now,
  });
  await db.insert(automationWorkflowRunEvents).values({
    id: waitRegisteredEventId,
    priorEventHash: runStartedEventId,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    sequence: 2,
    commandId: "workflow-start-command",
    requestHash,
    eventVersion: "1",
    event: "wait.registered",
    nodeId: "wait_for_window",
    workflowHash: hash("1"),
    compileHash: hash("2"),
    payloadJson: JSON.stringify({
      input_hash: hash("e"),
      started_at: now,
      deadline_at: waitDeadlineAt,
      next_check_at: now,
    }),
    payloadHash: hash("e"),
    actorPrincipal: "agentry_system",
    at: now,
  });
  await db.insert(automationWorkflowCommands).values({
    runId: RUN_ID,
    commandId: "workflow-start-command",
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    requestHash,
    expectedRevision: 0,
    committedRevision: 2,
    firstSequence: 1,
    lastSequence: 2,
    actorPrincipal: "agentry_system",
    responseJson: "{\"ok\":true}",
    responseHash: hash("d"),
    committedStateHash: stateHash,
    createdAt: now,
  });
  await db.insert(automationWorkflowRunStates).values({
    runId: RUN_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    workflowRevisionId: REVISION_ID,
    workflowHash: hash("1"),
    compileHash: hash("2"),
    stateVersion: 2,
    status: "waiting",
    currentNodeId: "wait_for_window",
    stateJson: "{}",
    stateHash,
    readyAt: now,
    elapsedDeadlineAt: now + 3_600,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(automationWorkflowSystemNodeClaims).values({
    id: hash("4"),
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    runRevision: 2,
    nodeId: "wait_for_window",
    inputHash: hash("e"),
    claimEpoch: 1,
    claimTokenHash: hash("5"),
    status: "active",
    claimedAt: now,
    expiresAt: now + 300,
    updatedAt: now,
  });
  await db.insert(automationWorkflowRunLeases).values({
    runId: RUN_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    leaseEpoch: 1,
    version: 1,
    holderPrincipal: "automation_runner",
    holderCredentialId: RUNNER_CREDENTIAL_ID,
    tokenHash: hash("a"),
    acquiredAt: now,
    renewedAt: now,
    expiresAt: now + 600,
  });
  await db.insert(automationWorkflowSuspensions).values({
    id: "workflow-wait-suspension",
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    nodeId: "wait_for_window",
    kind: "wait",
    status: "pending",
    version: 1,
    bindingHash: null,
    subjectJson: null,
    subjectHash: null,
    nextCheckAt: now,
    deadlineAt: waitDeadlineAt,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(automationWorkflowBudgetCharges).values({
    id: "workflow-run-charge",
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    kind: "run",
    subjectKey: "workflow-trigger-receipt",
    createdAt: now,
  });

  const effectEventIds = [hash("e"), hash("f"), hash("9")];
  await db.insert(automationWorkflowEffectEvents).values({
    id: effectEventIds[0]!,
    idempotencyKeyHash: hash("0"),
    effectId: EFFECT_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    sequence: 1,
    event: "effect.intent_reserved",
    effectAttempt: 0,
    reconciliationCount: 0,
    payloadJson: "{}",
    payloadHash: hash("3"),
    actorPrincipal: "agentry_system",
    at: now,
  });
  await db.insert(automationWorkflowEffects).values({
    id: EFFECT_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    nodeId: "open_draft_pr",
    componentId: effect.componentId,
    componentVersion: "1.0.0",
    componentHash: hash("8"),
    inputHash: hash("a"),
    intentHash: hash("b"),
    providerTarget: effect.providerTarget,
    providerOperationKey: hash("b"),
    createdEventId: effectEventIds[0]!,
    lastEventId: effectEventIds[0]!,
    status: "reserved",
    version: 1,
    callAttempt: 0,
    maxCallAttempts: 1,
    maxReconciliations: 3,
    reconciliationCount: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(automationWorkflowBudgetCharges).values({
    id: "workflow-effect-charge",
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    kind: "external_effect_call",
    subjectKey: "open_draft_pr:1",
    nodeId: "open_draft_pr",
    effectAttempt: 1,
    createdAt: now + 1,
  });
  const intentPayload = JSON.stringify({ intent_hash: hash("b") });
  await db.insert(automationWorkflowEffectEvents).values({
    id: effectEventIds[1]!,
    idempotencyKeyHash: hash("1"),
    priorEventHash: effectEventIds[0]!,
    effectId: EFFECT_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    sequence: 2,
    event: "effect.call_started",
    effectAttempt: 1,
    reconciliationCount: 0,
    leaseEpoch: 1,
    payloadJson: intentPayload,
    payloadHash: hash("4"),
    actorPrincipal: "automation_runner",
    actorCredentialId: RUNNER_CREDENTIAL_ID,
    at: now + 1,
  });
  await db.update(automationWorkflowEffects).set({
    lastEventId: effectEventIds[1]!,
    status: "indeterminate",
    version: 2,
    callAttempt: 1,
    reconcileAfterAt: now + 61,
    updatedAt: now + 1,
    callStartedAt: now + 1,
  }).where(eq(automationWorkflowEffects.id, EFFECT_ID));
  await db.insert(automationWorkflowEffectEvents).values({
    id: effectEventIds[2]!,
    idempotencyKeyHash: hash("2"),
    priorEventHash: effectEventIds[1]!,
    effectId: EFFECT_ID,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    runId: RUN_ID,
    sequence: 3,
    event: "effect.completed",
    effectAttempt: 1,
    reconciliationCount: 0,
    leaseEpoch: 1,
    payloadJson: intentPayload,
    payloadHash: hash("5"),
    actorPrincipal: "automation_runner",
    actorCredentialId: RUNNER_CREDENTIAL_ID,
    at: now + 2,
  });
  await db.update(automationWorkflowEffects).set({
    lastEventId: effectEventIds[2]!,
    status: "succeeded",
    version: 3,
    reconcileAfterAt: null,
    providerRef: effect.providerRef,
    receiptJson: "{\"pr_url\":\"https://github.com/acme/app/pull/42\"}",
    receiptHash: hash("c"),
    updatedAt: now + 2,
    completedAt: now + 2,
  }).where(eq(automationWorkflowEffects.id, EFFECT_ID));
}

async function databaseNow(): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  return Number(result.rows[0]?.now_seconds ?? 0);
}

async function withRuntimeTriggersDisabled<T>(operation: () => Promise<T>): Promise<T> {
  // This test inventories deletion of a deliberately synthetic graph; runtime
  // authorization and cross-ledger validity are covered by their own suites.
  // Restore the exact trigger SQL before observing or deleting any rows.
  const snapshot = await db.run(sql`
    SELECT name, sql
      FROM sqlite_master
     WHERE type = 'trigger'
       AND name LIKE 'automation_workflow_%'
     ORDER BY name
  `);
  const triggers = snapshot.rows.map((row) => ({ name: String(row.name), sql: String(row.sql) }));
  expect(triggers.length).toBeGreaterThan(10);
  for (const trigger of triggers) {
    await db.run(sql.raw(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`));
  }
  try {
    return await operation();
  } finally {
    for (const trigger of triggers) await db.run(sql.raw(trigger.sql));
    const restored = await db.run(sql`
      SELECT name, sql
        FROM sqlite_master
       WHERE type = 'trigger'
         AND name LIKE 'automation_workflow_%'
       ORDER BY name
    `);
    expect(restored.rows.map((row) => ({ name: String(row.name), sql: String(row.sql) }))).toEqual(triggers);
  }
}

function workflowV3Tables() {
  return [
    automationWorkflowEffects,
    automationWorkflowEffectEvents,
    automationWorkflowSuspensions,
    automationWorkflowCommands,
    automationWorkflowRunEvents,
    automationWorkflowRunStates,
    automationWorkflowRunLeases,
    automationWorkflowSystemNodeClaims,
    automationWorkflowBudgetCharges,
    automationWorkflowRuns,
    automationWorkflowTriggerReceipts,
    automationWorkflows,
    automationWorkflowExecutionAuthorities,
    automationWorkflowRevisions,
    automationWorkflowProjectControls,
  ] as const;
}

async function rowCount(table: SQLiteTable): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(table);
  return Number(rows[0]?.count ?? 0);
}
