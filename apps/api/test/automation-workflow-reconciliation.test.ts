import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desc, eq, sql } from "drizzle-orm";
import {
  automationWorkflowCommands,
  automationWorkflowBudgetCharges,
  automationWorkflowEffectEvents,
  automationWorkflowEffects,
  automationWorkflowExecutionAuthorities,
  automationWorkflowRunEvents,
  automationWorkflowRunLeases,
  automationWorkflowRuns,
  automationWorkflowRunStates,
  automationWorkflowTriggerReceipts,
  automationWorkflows,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import { canonicalJsonStringify, sha256Hex } from "@agentrysh/shared";
import { automationWorkflowCodeFixProposalHash } from "../src/automation-workflow-adapters.js";
import { pauseAutomationWorkflow } from "../src/automation-workflow-controls.js";
import { loadLiveOrderedFunnelExecutionAuthority } from "../src/automation-workflow-execution-authority.js";
import { automationWorkflowHeadEtag } from "../src/automation-workflow-identities.js";
import { synchronizeAutomationWorkflowMaterializations } from "../src/automation-workflow-materializations.js";
import { buildErrorToDraftPrWorkflow } from "../src/automation-workflow-presets.js";
import {
  planAutomationWorkflowEffectReconciliation,
  reconcileAutomationWorkflowEffect as reconcileAutomationWorkflowEffectService,
  type ReconcileAutomationWorkflowEffectInput,
} from "../src/automation-workflow-reconciliation.js";
import {
  executeAutomationWorkflowCommand,
  type AutomationWorkflowRunEvent,
  type AutomationWorkflowRunState,
  type AutomationWorkflowRuntimeCommand,
  type AutomationWorkflowRuntimeResult,
} from "../src/automation-workflow-runtime.js";
import {
  applyAutomationWorkflowCommand,
} from "../src/automation-workflow-service.js";
import {
  loadAutomationWorkflowRevision,
  saveDisabledAutomationWorkflow,
  type StoredAutomationWorkflowRevision,
} from "../src/automation-workflow-store.js";
import {
  createTestProjectCredential,
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "workflow-reconcile-owner";
const PROJECT_ID = "workflow-reconcile-project";
const AUTOMATION_ID = "repair_production_case";
const RUNNER_TOKEN = `runner-lease-${"x".repeat(40)}`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

type Db = ReturnType<typeof getDbForUrl>;
let env: TestEnv;
let db: Db;

type RuntimeTrigger = Readonly<{ name: string; table_name: string; sql: string }>;

const HISTORICAL_SEED_TABLES = new Set([
  "automation_workflow_runs",
  "automation_workflow_trigger_receipts",
  "automation_workflow_run_events",
  "automation_workflow_run_states",
  "automation_workflow_run_leases",
  "automation_workflow_commands",
  "automation_workflow_suspensions",
  "automation_workflow_effects",
  "automation_workflow_effect_events",
  "automation_workflow_budget_charges",
]);

const historicalSeedTriggers = new Map<string, readonly RuntimeTrigger[]>();

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function runtimeTriggerSnapshot(): Promise<RuntimeTrigger[]> {
  const result = await db.run(sql`
    SELECT name, tbl_name AS table_name, sql
      FROM sqlite_master
     WHERE type = 'trigger'
     ORDER BY name
  `);
  return result.rows.flatMap((row) => {
    const name = String(row.name ?? "");
    const tableName = String(row.table_name ?? "");
    const triggerSql = String(row.sql ?? "");
    return HISTORICAL_SEED_TABLES.has(tableName) && name.length > 0 && triggerSql.startsWith("CREATE TRIGGER")
      ? [{ name, table_name: tableName, sql: triggerSql }]
      : [];
  });
}

async function assertRuntimeTriggersRestored(expected: readonly RuntimeTrigger[]): Promise<void> {
  expect(await runtimeTriggerSnapshot()).toEqual(expected);
}

async function withRuntimeTriggersDisabled<T>(operation: () => Promise<T>): Promise<{
  value: T;
  triggers: readonly RuntimeTrigger[];
}> {
  const triggers = await runtimeTriggerSnapshot();
  expect(triggers.length).toBeGreaterThan(10);
  for (const trigger of triggers) {
    await db.run(sql.raw(`DROP TRIGGER ${quoteSqliteIdentifier(trigger.name)}`));
  }
  try {
    return { value: await operation(), triggers };
  } finally {
    for (const trigger of triggers) await db.run(sql.raw(trigger.sql));
    await assertRuntimeTriggersRestored(triggers);
  }
}

async function reconcileAutomationWorkflowEffect(
  source: Db,
  input: ReconcileAutomationWorkflowEffectInput,
) {
  const expected = historicalSeedTriggers.get(input.effect_id);
  if (expected) await assertRuntimeTriggersRestored(expected);
  return reconcileAutomationWorkflowEffectService(source, input);
}

beforeEach(async () => {
  historicalSeedTriggers.clear();
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(users).values({ id: OWNER_ID, email: "workflow-reconcile@example.test" });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Workflow reconciliation",
  });
});

afterEach(async () => {
  historicalSeedTriggers.clear();
  await disposeTestEnv(env);
});

function workflow() {
  return buildErrorToDraftPrWorkflow({
    automation_id: AUTOMATION_ID,
    name: "Repair trusted production case",
    runner: {
      provider: "codex",
      repository_provider: "github",
      repository: "https://github.com/example/app",
      default_branch: "main",
      environment: "production",
    },
    trigger: { max_cases_per_sweep: 3, cooldown_seconds: 900 },
    scope: {
      allowed_paths: ["src/**", "test/**"],
      test_commands: ["npm test"],
      max_files_changed: 5,
      max_changed_lines: 240,
    },
    budgets: {
      max_runs_per_day: 4,
      max_prs_per_day: 1,
      max_attempts_per_case_revision: 2,
      max_turns_per_run: 24,
      max_runtime_seconds: 1_800,
      max_cost_usd_per_run: 5,
    },
    approval_expires_after_seconds: 86_400,
    deploy_wait_timeout_seconds: 43_200,
    traffic_sample_event: "request_completed",
    verification: {
      observation_window_seconds: 3_600,
      max_wait_seconds: 86_400,
      min_sample_size: 50,
    },
    escalation: { destination: "project owner", instructions: "Preserve evidence and stop." },
  });
}

type HistoricalCommandResult = Readonly<{
  command: AutomationWorkflowRuntimeCommand;
  request_hash: string;
  result: AutomationWorkflowRuntimeResult;
}>;

async function executeHistoricalCommand(
  revision: StoredAutomationWorkflowRevision,
  priorState: AutomationWorkflowRunState | null,
  command: AutomationWorkflowRuntimeCommand,
): Promise<HistoricalCommandResult> {
  const requestHash = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-reconciliation-test-kernel-command-v1",
    command,
  }));
  return {
    command,
    request_hash: requestHash,
    result: await executeAutomationWorkflowCommand(
      revision.compiled,
      priorState,
      command,
      { request_hash: requestHash },
    ),
  };
}

function eventInsert(run: typeof automationWorkflowRuns.$inferSelect, event: AutomationWorkflowRunEvent) {
  return {
    id: event.event_id,
    priorEventHash: event.prior_event_hash,
    projectId: run.projectId,
    automationId: run.automationId,
    runId: run.id,
    sequence: event.sequence,
    commandId: event.command_id,
    requestHash: event.request_hash,
    eventVersion: event.event_version,
    event: event.event,
    workflowHash: event.workflow_hash,
    compileHash: event.compile_hash,
    nodeId: event.node_id,
    componentHash: event.component_hash,
    payloadSchemaRef: event.payload_schema_ref,
    payloadJson: canonicalJsonStringify(event.payload),
    payloadHash: event.payload_hash,
    actorPrincipal: event.actor.principal,
    actorCredentialId: event.actor.credential_id,
    at: event.at,
  };
}

async function seedHistoricalIndeterminateRun(input: {
  revision: StoredAutomationWorkflowRevision;
  runner_credential_id: string;
  execution_authority_id: string;
  execution_descriptor_hash: string;
  setup_at: number;
}) {
  const { revision, setup_at: at } = input;
  const runDigest = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-reconciliation-test-run-v1",
    project_id: PROJECT_ID,
    automation_id: AUTOMATION_ID,
    setup_at: at,
  }));
  const runId = `awrun_${runDigest}`;
  const triggerOutput = {
    receipt_id: "case-receipt-1",
    case_id: "case-1",
    case_revision: 3,
    snapshot_hash: HASH_A,
    source_trust: "customer_posthog" as const,
    issued_at: at - 60,
    expires_at: at + 3_600,
    instruction_authority: "none" as const,
  };
  const started = await executeHistoricalCommand(revision, null, {
    kind: "start",
    command_id: `start:${runDigest}`,
    expected_revision: 0,
    run_id: runId,
    project_id: PROJECT_ID,
    automation_id: AUTOMATION_ID,
    workflow_revision: revision.revision,
    trigger_output: triggerOutput,
    at,
    actor: { principal: "agentry_system", credential_id: null },
  });
  const queried = await executeHistoricalCommand(revision, started.result.state, {
    kind: "component_succeeded",
    command_id: "record-case-evidence",
    expected_revision: started.result.state.revision,
    node_id: "case_evidence",
    output: {
      case_id: "case-1",
      case_revision: 3,
      evidence_hash: HASH_B,
      error: {
        type: "TypeError",
        message: "boom",
        event_count: 4,
        first_seen_at: at - 100,
        last_seen_at: at - 10,
      },
      last_deploy_sha: null,
      instruction_authority: "none",
    },
    at,
    actor: { principal: "agentry_system", credential_id: null },
  });
  const proposal = {
    proposal_hash: HASH_A,
    evidence_hash: HASH_B,
    repository: "https://github.com/example/app",
    base_sha: "abcdef1",
    head_sha: "abcdef2",
    branch: "agentry/fix-case-1",
    changed_files: [{ path: "src/fix.ts", added_lines: 4, deleted_lines: 1 }],
    tests: [{ command: "npm test", status: "passed" as const, exit_code: 0 }],
    summary: "Bounded exact fix",
    instruction_authority: "none" as const,
  };
  proposal.proposal_hash = await automationWorkflowCodeFixProposalHash(proposal);
  const proposed = await executeHistoricalCommand(revision, queried.result.state, {
    kind: "component_succeeded",
    command_id: "prepare-proposal",
    expected_revision: queried.result.state.revision,
    node_id: "diagnose_fix",
    output: proposal,
    usage: {
      sequence: 1,
      turns_used: 4,
      cost_micros: 500_000,
      touched_files: ["src/fix.ts"],
      changed_line_churn: 5,
    },
    at,
    actor: { principal: "automation_runner", credential_id: input.runner_credential_id },
  });
  const approved = await executeHistoricalCommand(revision, proposed.result.state, {
    kind: "approval_decided",
    command_id: "approve-proposal",
    expected_revision: proposed.result.state.revision,
    node_id: "approve_draft_pr",
    decision: "approved",
    reason: "Reviewed the exact bounded diff and test receipt.",
    at,
    actor: { principal: "human_project_owner", credential_id: OWNER_ID },
  });
  const intentHash = approved.result.state.effects.create_draft_pr!.intent_hash;
  const called = await executeHistoricalCommand(revision, approved.result.state, {
    kind: "effect_call_started",
    command_id: "start-draft-pr-call",
    expected_revision: approved.result.state.revision,
    node_id: "create_draft_pr",
    intent_hash: intentHash,
    at,
    actor: { principal: "automation_runner", credential_id: input.runner_credential_id },
  });
  expect(called.result.next_action).toMatchObject({ kind: "reconcile_effect" });

  const commands = [started, queried, proposed, approved, called];
  const limitsJson = canonicalJsonStringify(revision.workflow.limits);
  const triggerPayloadJson = canonicalJsonStringify(triggerOutput);
  const triggerPayloadHash = await sha256Hex(triggerPayloadJson);
  const stateJson = canonicalJsonStringify(called.result.state);
  const stateHash = await sha256Hex(stateJson);
  await db.transaction(async (tx) => {
    const triggerNode = revision.workflow.nodes.find((node) => node.id === revision.workflow.entry);
    const resolvedTrigger = revision.compiled.resolved_nodes.find(
      (node) => node.node_id === revision.workflow.entry,
    );
    if (!triggerNode || triggerNode.kind !== "trigger" || !resolvedTrigger) {
      throw new Error("historical reconciliation fixture has no resolved trigger");
    }
    await tx.insert(automationWorkflowTriggerReceipts).values({
      id: triggerOutput.receipt_id,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: revision.revision_id,
      workflowHash: revision.workflow_hash,
      compileHash: revision.compile_hash,
      executionAuthorityId: input.execution_authority_id,
      triggerNodeId: triggerNode.id,
      componentId: triggerNode.component.id,
      componentVersion: triggerNode.component.version,
      componentHash: resolvedTrigger.component_hash,
      outputContract: resolvedTrigger.output_contract,
      outputSchemaHash: resolvedTrigger.output_contract_schema_hash,
      triggerKind: "case",
      triggerKey: `case:${triggerOutput.case_id}:${triggerOutput.case_revision}`,
      attempt: 1,
      payloadJson: triggerPayloadJson,
      payloadHash: triggerPayloadHash,
      sourceTrust: "customer_posthog",
      status: "consumed",
      consumedRunId: runId,
      issuedAt: triggerOutput.issued_at,
      availableAt: triggerOutput.issued_at,
      expiresAt: triggerOutput.expires_at,
      consumedAt: at,
      updatedAt: at,
    });
    const insertedRuns = await tx.insert(automationWorkflowRuns).values({
      id: runId,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: revision.revision_id,
      workflowHash: revision.workflow_hash,
      compileHash: revision.compile_hash,
      executionAuthorityId: input.execution_authority_id,
      executionDescriptorHash: input.execution_descriptor_hash,
      triggerReceiptId: triggerOutput.receipt_id,
      triggerKind: "case",
      triggerKey: `case:${triggerOutput.case_id}:${triggerOutput.case_revision}`,
      triggerPayloadJson,
      triggerPayloadHash,
      attempt: 1,
      idempotencyKeyHash: await sha256Hex("historical-reconciliation-start-idempotency"),
      requestHash: started.request_hash,
      limitsJson,
      limitsHash: await sha256Hex(limitsJson),
      runnerCredentialId: input.runner_credential_id,
      createdAt: at,
      updatedAt: at,
    }).returning();
    expect(insertedRuns).toHaveLength(1);
    const run = insertedRuns[0]!;
    await tx.insert(automationWorkflowBudgetCharges).values([
      {
        id: await sha256Hex(`workflow-run:${runId}`),
        projectId: PROJECT_ID,
        automationId: AUTOMATION_ID,
        runId,
        kind: "run",
        subjectKey: "run",
        nodeId: null,
        effectAttempt: null,
        createdAt: at,
      },
      {
        id: await sha256Hex(`workflow-effect:${runId}:create_draft_pr:1`),
        projectId: PROJECT_ID,
        automationId: AUTOMATION_ID,
        runId,
        kind: "external_effect_call",
        subjectKey: "create_draft_pr:1",
        nodeId: "create_draft_pr",
        effectAttempt: 1,
        createdAt: at,
      },
    ]);
    await tx.insert(automationWorkflowRunEvents).values(
      commands.flatMap((entry) => entry.result.events.map((event) => eventInsert(run, event))),
    );
    await tx.insert(automationWorkflowRunStates).values({
      runId,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: revision.revision_id,
      workflowHash: revision.workflow_hash,
      compileHash: revision.compile_hash,
      stateVersion: called.result.state.revision,
      status: called.result.state.status,
      currentNodeId: called.result.state.current_node_id,
      stateJson,
      stateHash,
      readyAt: called.result.state.effects.create_draft_pr!.next_reconcile_at,
      activeRuntimeSeconds: called.result.state.active_runtime_seconds,
      usageSequence: called.result.state.usage_sequence,
      turnsUsed: called.result.state.turns_used,
      costMicros: called.result.state.cost_micros,
      filesChanged: called.result.state.changed_files.length,
      changedLineChurn: called.result.state.changed_line_churn,
      elapsedDeadlineAt: called.result.state.elapsed_deadline_at,
      createdAt: at,
      updatedAt: at,
    });
    await tx.insert(automationWorkflowRunLeases).values({
      runId,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      leaseEpoch: 1,
      version: 1,
      holderPrincipal: "automation_runner",
      holderCredentialId: input.runner_credential_id,
      tokenHash: await sha256Hex(RUNNER_TOKEN),
      acquiredAt: at,
      renewedAt: at,
      expiresAt: at + 7_200,
      releasedAt: null,
      releaseReason: null,
    });
    let priorState: AutomationWorkflowRunState | null = null;
    for (const entry of commands) {
      await synchronizeAutomationWorkflowMaterializations(tx, {
        run,
        revision,
        prior_state: priorState,
        result: entry.result,
        lease_epoch: entry === called ? 1 : null,
      });
      priorState = entry.result.state;
    }
  });
  return { run_id: runId, proposal, called: called.result, intent_hash: intentHash };
}

type IndeterminateFixture = Awaited<ReturnType<typeof indeterminateFixture>>;

async function indeterminateFixture(settlementBoundary: "live" | "pause" | "terminal" = "pause") {
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(clock.rows[0]?.now_seconds ?? 0);
  const setupAt = now - 900;
  const saved = await saveDisabledAutomationWorkflow(db, {
    project_id: PROJECT_ID,
    actor_user_id: OWNER_ID,
    workflow: workflow(),
    observed_at: setupAt - 10,
  });
  const runner = await createTestProjectCredential(env, PROJECT_ID, "automation_runner", AUTOMATION_ID);
  const descriptor = await loadLiveOrderedFunnelExecutionAuthority();
  if (!descriptor) throw new Error("missing live ordered-funnel execution descriptor");
  const enabledClock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const enabledAt = Number(enabledClock.rows[0]?.now_seconds ?? now);
  const executionAuthorityId = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-test-workflow-reconciliation-execution-authority-v1",
    project_id: PROJECT_ID,
    automation_id: AUTOMATION_ID,
    workflow_revision_id: saved.workflow.revision_id,
    workflow_hash: saved.workflow.workflow_hash,
    compile_hash: saved.workflow.compile_hash,
    descriptor_hash: descriptor.descriptor_hash,
    runner_credential_id: runner.id,
  }));
  await db.insert(automationWorkflowExecutionAuthorities).values({
    id: executionAuthorityId,
    projectId: PROJECT_ID,
    automationId: AUTOMATION_ID,
    workflowRevisionId: saved.workflow.revision_id,
    workflowHash: saved.workflow.workflow_hash,
    compileHash: saved.workflow.compile_hash,
    readinessHash: "e".repeat(64),
    ownerConfirmedCallerAssertionIdsJson: "[]",
    descriptorKind: descriptor.descriptor_kind,
    descriptorJson: descriptor.descriptor_json,
    descriptorHash: descriptor.descriptor_hash,
    runnerCredentialId: runner.id,
    enabledBy: OWNER_ID,
    enabledAt,
  });
  const etag = await automationWorkflowHeadEtag({
    project_id: PROJECT_ID,
    automation_id: AUTOMATION_ID,
    current_revision_id: saved.workflow.revision_id,
    current_revision: saved.workflow.revision,
    workflow_hash: saved.workflow.workflow_hash,
    compile_hash: saved.workflow.compile_hash,
    enabled: true,
    active_revision_id: saved.workflow.revision_id,
    active_execution_authority_id: executionAuthorityId,
    paused_at: null,
    pause_reason: null,
    updated_at: enabledAt,
  });
  await db.update(automationWorkflows).set({
    enabled: 1,
    activeRevisionId: saved.workflow.revision_id,
    activeExecutionAuthorityId: executionAuthorityId,
    etag,
    pausedAt: null,
    pauseReason: null,
    updatedBy: OWNER_ID,
    updatedAt: enabledAt,
  }).where(eq(automationWorkflows.projectId, PROJECT_ID));

  const ci = await createTestProjectCredential(env, PROJECT_ID, "ci_deploy");
  const revision = await loadAutomationWorkflowRevision(db, PROJECT_ID, saved.workflow.revision_id);
  if (!revision) throw new Error("missing test workflow revision");
  const seeded = await withRuntimeTriggersDisabled(() => seedHistoricalIndeterminateRun({
    revision,
    runner_credential_id: runner.id,
    execution_authority_id: executionAuthorityId,
    execution_descriptor_hash: descriptor.descriptor_hash,
    setup_at: setupAt,
  }));
  const { run_id: runId, proposal, called, intent_hash: intentHash } = seeded.value;
  historicalSeedTriggers.set(
    `awfx_${await sha256Hex(canonicalJsonStringify({
      namespace: "agentry-automation-workflow-effect-v1",
      run_id: runId,
      node_id: "create_draft_pr",
    }))}`,
    seeded.triggers,
  );
  await assertRuntimeTriggersRestored(seeded.triggers);
  if (settlementBoundary === "terminal") {
    await applyAutomationWorkflowCommand(db, {
      run_id: runId,
      actor: { principal: "human_project_owner", credential_id: OWNER_ID },
      command: {
        kind: "cancel",
        command_id: "cancel-after-indeterminate-call",
        expected_revision: called.state.revision,
        reason: "Stop workflow coordination but preserve provider reconciliation.",
      },
    });
  } else if (settlementBoundary === "pause") {
    await pauseAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      automation_id: AUTOMATION_ID,
      actor_user_id: OWNER_ID,
      reason: "Test the reconciliation-only kill-switch path.",
    });
  }
  const effect = (
    await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.runId, runId),
    ).limit(1)
  )[0]!;
  const currentClock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const reconcileAt = Number(currentClock.rows[0]?.now_seconds ?? 0);
  historicalSeedTriggers.set(effect.id, seeded.triggers);
  await assertRuntimeTriggersRestored(seeded.triggers);
  return {
    now: reconcileAt,
    run_id: runId,
    effect,
    proposal,
    runner,
    ci,
    intent_hash: intentHash,
    reconcile_at: reconcileAt,
    run_revision: called.state.revision,
    trigger_snapshot: seeded.triggers,
  };
}

function evidence(
  fixture: IndeterminateFixture,
  at: number,
  result: "found" | "not_found" | "unknown",
  providerRef: string | null = null,
) {
  return {
    provider: "github" as const,
    provider_operation_key: fixture.effect.providerOperationKey,
    provider_target: fixture.effect.providerTarget,
    intent_marker: fixture.intent_hash,
    expected_head_sha: fixture.proposal.head_sha,
    lookup_started_at: at - 1,
    lookup_completed_at: at,
    lookup_result: result,
    matched_provider_ref: providerRef,
  };
}

function orderedBySequence<T extends { sequence: number }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => left.sequence - right.sequence);
}

describe("independent automation workflow effect reconciliation", () => {
  it("rejects every evidence-free generic live reconciliation claim without changing either ledger", async () => {
    const fixture = await indeterminateFixture("live");
    const runEventsBefore = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEventsBefore = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    const effectBefore = (
      await db.select().from(automationWorkflowEffects).where(
        eq(automationWorkflowEffects.id, fixture.effect.id),
      ).limit(1)
    )[0]!;
    for (const outcome of ["found", "absent", "unknown"] as const) {
      await expect(applyAutomationWorkflowCommand(db, {
        run_id: fixture.run_id,
        actor: { principal: "trusted_ci", credential_id: fixture.ci.id },
        observed_at: fixture.reconcile_at,
        command: {
          kind: "effect_reconciled",
          command_id: `generic-live-${outcome}`,
          expected_revision: fixture.run_revision,
          node_id: "create_draft_pr",
          intent_hash: fixture.intent_hash,
          outcome,
          ...(outcome === "found" ? { output: { caller_claim: true } } : {}),
        },
      } as never)).rejects.toMatchObject({
        status: 409,
        code: "automation_workflow_effect_reconciliation_dedicated_service_required",
      });
    }
    expect(orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ))).toEqual(runEventsBefore);
    expect(orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ))).toEqual(effectEventsBefore);
    expect((await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.id, fixture.effect.id),
    ).limit(1))[0]).toEqual(effectBefore);
  });

  it("rejects caller-selected reconciliation time that drifts from the database clock", async () => {
    const fixture = await indeterminateFixture("live");
    const runEventsBefore = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEventsBefore = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    await expect(reconcileAutomationWorkflowEffect(db, {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "caller-selected-future-clock",
      outcome: "unknown",
      evidence: evidence(fixture, fixture.reconcile_at + 30, "unknown"),
      actor: { principal: "agentry_system", credential_id: null },
      observed_at: fixture.reconcile_at + 30,
    })).rejects.toMatchObject({
      status: 400,
      code: "invalid_payload",
      details: { reason: "observed_at must match the database clock within one second" },
    });
    expect(orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ))).toEqual(runEventsBefore);
    expect(orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ))).toEqual(effectEventsBefore);
  });

  it("rejects the generic command while paused so only the dedicated effect ledger can settle it", async () => {
    const fixture = await indeterminateFixture("pause");
    const runStateBefore = (
      await db.select().from(automationWorkflowRunStates).where(
        eq(automationWorkflowRunStates.runId, fixture.run_id),
      ).limit(1)
    )[0]!;
    const effectEventsBefore = await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    );
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: fixture.run_id,
      actor: { principal: "agentry_system", credential_id: null },
      observed_at: fixture.reconcile_at,
      command: {
        kind: "effect_reconciled",
        command_id: "generic-paused-unknown",
        expected_revision: fixture.run_revision,
        node_id: "create_draft_pr",
        intent_hash: fixture.intent_hash,
        outcome: "unknown",
      },
    } as never)).rejects.toMatchObject({
      status: 409,
      code: "automation_workflow_effect_reconciliation_dedicated_service_required",
    });
    expect((await db.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, fixture.run_id),
    ).limit(1))[0]).toEqual(runStateBefore);
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    )).toEqual(effectEventsBefore);
  });

  it("settles the original runner's exact late receipt while paused, then quarantines before downstream work", async () => {
    const fixture = await indeterminateFixture("pause");
    const runEventsBefore = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const receipt = await applyAutomationWorkflowCommand(db, {
      run_id: fixture.run_id,
      actor: { principal: "automation_runner", credential_id: fixture.runner.id },
      observed_at: fixture.now,
      command: {
        kind: "effect_receipt_recorded",
        command_id: "runner-records-exact-pr-receipt",
        expected_revision: fixture.run_revision,
        node_id: "create_draft_pr",
        intent_hash: fixture.intent_hash,
        output: {
          intent_id: fixture.intent_hash,
          proposal_hash: fixture.proposal.proposal_hash,
          provider: "github",
          provider_target: fixture.effect.providerTarget,
          pr_number: 9,
          pr_url: "https://github.com/example/app/pull/9",
          head_sha: fixture.proposal.head_sha,
          // Caller time is non-authorizing. The command transaction replaces
          // this stable retry sentinel with its database second.
          recorded_at: 0,
          instruction_authority: "none",
        },
      },
    });
    expect(receipt.state.effects.create_draft_pr).toMatchObject({ status: "succeeded" });
    expect((receipt.state.outputs.create_draft_pr?.payload as Record<string, unknown>).recorded_at)
      .toBe(fixture.now);
    expect(receipt.state.status).toBe("quarantined");
    expect(receipt.next_action).toBeNull();
    const runEvents = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    expect(runEvents.slice(runEventsBefore.length).map((event) => event.event)).toEqual([
      "effect.completed",
      "run.quarantined",
    ]);
    expect(runEvents.slice(runEventsBefore.length).some((event) => event.event === "wait.registered")).toBe(false);
  });

  it("atomically settles a live found effect across both ledgers and never reauthorizes the provider call", async () => {
    const fixture = await indeterminateFixture("live");
    const prUrl = "https://github.com/example/app/pull/17";
    const input: ReconcileAutomationWorkflowEffectInput = {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "live-find-exact-draft-pr",
      outcome: "found",
      actor: { principal: "trusted_ci", credential_id: fixture.ci.id },
      observed_at: fixture.reconcile_at,
      evidence: evidence(fixture, fixture.reconcile_at, "found", prUrl),
      output: {
        intent_id: fixture.intent_hash,
        proposal_hash: fixture.proposal.proposal_hash,
        provider: "github",
        provider_target: fixture.effect.providerTarget,
        pr_number: 17,
        pr_url: prUrl,
        head_sha: fixture.proposal.head_sha,
        recorded_at: 0,
        instruction_authority: "none",
      },
    };
    const runEventsBefore = await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    );
    const effectEventsBefore = await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    );

    const receipt = await reconcileAutomationWorkflowEffect(db, input);
    expect(receipt).toMatchObject({
      effect_status: "succeeded",
      provider_ref: prUrl,
      provider_call_authorized: false,
      idempotent_replay: false,
    });
    const runEvents = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEvents = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    const completed = runEvents.slice(runEventsBefore.length).find((event) => event.event === "effect.completed")!;
    const boundEffectEvent = effectEvents.slice(effectEventsBefore.length)[0]!;
    const boundPayload = JSON.parse(boundEffectEvent.payloadJson) as Record<string, unknown>;
    expect(completed).toBeDefined();
    expect(boundEffectEvent.event).toBe("effect.completed");
    expect(boundPayload).toMatchObject({
      request_hash: receipt.request_hash,
      workflow_event_id: completed.id,
      workflow_event_payload_hash: completed.payloadHash,
      workflow_command_id: completed.commandId,
      workflow_request_hash: completed.requestHash,
      evidence: input.evidence,
    });
    expect(completed.requestHash).toBe(receipt.request_hash);
    const runProjection = (
      await db.select().from(automationWorkflowRunStates).where(
        eq(automationWorkflowRunStates.runId, fixture.run_id),
      ).limit(1)
    )[0]!;
    expect(runProjection.status).toBe("waiting");
    const settled = (
      await db.select().from(automationWorkflowEffects).where(
        eq(automationWorkflowEffects.id, fixture.effect.id),
      ).limit(1)
    )[0]!;
    expect(settled).toMatchObject({ status: "succeeded", callAttempt: 1, providerRef: prUrl });
    expect(JSON.parse(settled.receiptJson!)).toMatchObject({ recorded_at: fixture.reconcile_at });
    const reconciliationCommand = (
      await db.select().from(automationWorkflowCommands).where(
        eq(automationWorkflowCommands.runId, fixture.run_id),
      )
    ).find((command) => command.actorPrincipal === "trusted_ci")!;
    expect(JSON.parse(reconciliationCommand.responseJson)).toMatchObject({ effect_call: null });

    await pauseAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      automation_id: AUTOMATION_ID,
      actor_user_id: OWNER_ID,
      reason: "Close authority after the reconciliation response was committed.",
    });
    await db.update(projectCredentials).set({
      revokedAt: fixture.now,
      revokeReason: "Response-loss replay must not need fresh mutation authority.",
    }).where(eq(projectCredentials.id, fixture.ci.id));
    const replacementCi = await createTestProjectCredential(env, PROJECT_ID, "ci_deploy");
    const replay = await reconcileAutomationWorkflowEffect(db, {
      ...input,
      actor: { principal: "trusted_ci", credential_id: replacementCi.id },
      observed_at: fixture.reconcile_at + 30,
    });
    expect({ ...replay, idempotent_replay: false }).toEqual(receipt);
    expect(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    )).toHaveLength(runEvents.length);
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    )).toHaveLength(effectEvents.length);
    await expect(reconcileAutomationWorkflowEffect(db, {
      ...input,
      actor: { principal: "trusted_ci", credential_id: replacementCi.id },
      evidence: { ...input.evidence, lookup_started_at: fixture.reconcile_at - 2 },
    })).rejects.toMatchObject({
      status: 409,
      code: "automation_workflow_reconciliation_idempotency_key_reused",
    });
  });

  it("atomically records live absence in both ledgers from the frozen workflow backoff", async () => {
    const fixture = await indeterminateFixture("live");
    const runEventsBefore = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEventsBefore = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    const createdPayload = JSON.parse(effectEventsBefore.find((event) => event.id === fixture.effect.createdEventId)!.payloadJson);
    expect(createdPayload.frozen_adapter_policy).toMatchObject({
      protocol_version: "1",
      semantic_validator_version: 1,
      reconciliation_policy: {
        backoff_source: "frozen_workflow_limit",
        max_provider_call_attempts: 1,
        max_automatic_reconciliations: 3,
      },
    });
    expect(createdPayload.frozen_adapter_policy_hash).toBe(
      await sha256Hex(canonicalJsonStringify(createdPayload.frozen_adapter_policy)),
    );

    const first = await reconcileAutomationWorkflowEffect(db, {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "live-absence-lookup-one",
      outcome: "definitively_absent",
      evidence: evidence(fixture, fixture.reconcile_at, "not_found"),
      actor: { principal: "agentry_system", credential_id: null },
      observed_at: fixture.reconcile_at,
    });
    expect(first).toMatchObject({
      effect_status: "indeterminate",
      reconciliation_count: 1,
      next_reconcile_at: fixture.reconcile_at + 900,
      provider_call_authorized: false,
    });
    const runEvents = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEvents = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    expect(runEvents.slice(runEventsBefore.length).map((event) => event.event)).toEqual(["effect.reconciled_absent"]);
    expect(effectEvents.slice(effectEventsBefore.length).map((event) => event.event)).toEqual(["effect.reconciled_absent"]);
    const runProjection = (
      await db.select().from(automationWorkflowRunStates).where(
        eq(automationWorkflowRunStates.runId, fixture.run_id),
      ).limit(1)
    )[0]!;
    const state = JSON.parse(runProjection.stateJson) as AutomationWorkflowRunState;
    const effect = (
      await db.select().from(automationWorkflowEffects).where(
        eq(automationWorkflowEffects.id, fixture.effect.id),
      ).limit(1)
    )[0]!;
    expect(runProjection.status).toBe("effect_indeterminate");
    expect(state.effects.create_draft_pr).toMatchObject({
      reconciliation_count: 1,
      next_reconcile_at: fixture.reconcile_at + 900,
    });
    expect(effect).toMatchObject({
      status: "indeterminate",
      callAttempt: 1,
      reconciliationCount: 1,
      reconcileAfterAt: fixture.reconcile_at + 900,
    });
  });

  it("atomically records a live unknown lookup in both ledgers without provider reauthorization", async () => {
    const fixture = await indeterminateFixture("live");
    const runEventsBefore = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEventsBefore = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    const receipt = await reconcileAutomationWorkflowEffect(db, {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "live-unknown-lookup-one",
      outcome: "unknown",
      evidence: evidence(fixture, fixture.reconcile_at, "unknown"),
      actor: { principal: "trusted_ci", credential_id: fixture.ci.id },
      observed_at: fixture.reconcile_at,
    });
    expect(receipt).toMatchObject({
      effect_status: "indeterminate",
      reconciliation_count: 1,
      next_reconcile_at: fixture.reconcile_at + 900,
      provider_call_authorized: false,
    });
    const runEvents = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEvents = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    expect(runEvents.slice(runEventsBefore.length).map((event) => event.event)).toEqual([
      "effect.reconciliation_unknown",
    ]);
    expect(effectEvents.slice(effectEventsBefore.length).map((event) => event.event)).toEqual([
      "effect.reconciliation_unknown",
    ]);
    expect((await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.id, fixture.effect.id),
    ).limit(1))[0]).toMatchObject({
      status: "indeterminate",
      callAttempt: 1,
      reconciliationCount: 1,
      reconcileAfterAt: fixture.reconcile_at + 900,
    });
  });

  it("uses the same atomic bridge under a closed authority and quarantines after effect settlement", async () => {
    const fixture = await indeterminateFixture("pause");
    const runEventsBefore = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const effectEventsBefore = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    const receipt = await reconcileAutomationWorkflowEffect(db, {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "paused-unknown-atomic-bridge",
      outcome: "unknown",
      evidence: evidence(fixture, fixture.reconcile_at, "unknown"),
      actor: { principal: "agentry_system", credential_id: null },
      observed_at: fixture.reconcile_at,
    });
    expect(receipt).toMatchObject({
      effect_status: "indeterminate",
      reconciliation_count: 1,
      provider_call_authorized: false,
    });
    const runEvents = orderedBySequence(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    ));
    const appendedRunEvents = runEvents.slice(runEventsBefore.length);
    expect(appendedRunEvents.map((event) => event.event)).toEqual([
      "effect.reconciliation_unknown",
      "run.quarantined",
    ]);
    expect(JSON.parse(appendedRunEvents[1]!.payloadJson)).toMatchObject({ reason: "kill_switch_active" });
    const effectEvents = orderedBySequence(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    ));
    expect(effectEvents.slice(effectEventsBefore.length).map((event) => event.event)).toEqual([
      "effect.reconciliation_unknown",
    ]);
    const boundPayload = JSON.parse(effectEvents.at(-1)!.payloadJson);
    expect(boundPayload.workflow_event_id).toBe(appendedRunEvents[0]!.id);
    expect(boundPayload.workflow_request_hash).toBe(appendedRunEvents[0]!.requestHash);
    expect((await db.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, fixture.run_id),
    ).limit(1))[0]).toMatchObject({ status: "quarantined" });
    expect((await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.id, fixture.effect.id),
    ).limit(1))[0]).toMatchObject({
      status: "indeterminate",
      callAttempt: 1,
      reconciliationCount: 1,
    });
  });

  it("leaves both ledgers and projections unchanged when live provider evidence fails binding", async () => {
    const fixture = await indeterminateFixture("live");
    const runEventsBefore = await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    );
    const effectEventsBefore = await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    );
    const runStateBefore = (
      await db.select().from(automationWorkflowRunStates).where(
        eq(automationWorkflowRunStates.runId, fixture.run_id),
      ).limit(1)
    )[0]!;
    const effectBefore = (
      await db.select().from(automationWorkflowEffects).where(
        eq(automationWorkflowEffects.id, fixture.effect.id),
      ).limit(1)
    )[0]!;
    const commandsBefore = await db.select().from(automationWorkflowCommands).where(
      eq(automationWorkflowCommands.runId, fixture.run_id),
    );

    await expect(reconcileAutomationWorkflowEffect(db, {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "live-mismatched-evidence",
      outcome: "unknown",
      evidence: {
        ...evidence(fixture, fixture.reconcile_at, "unknown"),
        expected_head_sha: "deadbee",
      },
      actor: { principal: "agentry_system", credential_id: null },
      observed_at: fixture.reconcile_at,
    })).rejects.toMatchObject({
      status: 422,
      code: "automation_workflow_reconciliation_evidence_mismatch",
    });
    expect(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    )).toEqual(runEventsBefore);
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    )).toEqual(effectEventsBefore);
    expect((await db.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, fixture.run_id),
    ).limit(1))[0]).toEqual(runStateBefore);
    expect((await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.id, fixture.effect.id),
    ).limit(1))[0]).toEqual(effectBefore);
    expect(await db.select().from(automationWorkflowCommands).where(
      eq(automationWorkflowCommands.runId, fixture.run_id),
    )).toEqual(commandsBefore);
  });

  it("settles an exact found PR after run terminal without reviving the workflow and replays one immutable receipt", async () => {
    const fixture = await indeterminateFixture("terminal");
    const prUrl = "https://github.com/example/app/pull/7";
    const input: ReconcileAutomationWorkflowEffectInput = {
      project_id: PROJECT_ID,
      effect_id: fixture.effect.id,
      idempotency_key: "find-exact-draft-pr",
      outcome: "found",
      actor: { principal: "trusted_ci", credential_id: fixture.ci.id },
      observed_at: fixture.reconcile_at,
      evidence: evidence(fixture, fixture.reconcile_at, "found", prUrl),
      output: {
        intent_id: fixture.intent_hash,
        proposal_hash: fixture.proposal.proposal_hash,
        provider: "github",
        provider_target: fixture.effect.providerTarget,
        pr_number: 7,
        pr_url: prUrl,
        head_sha: fixture.proposal.head_sha,
        recorded_at: fixture.reconcile_at,
        instruction_authority: "none",
      },
    };
    const runEventsBefore = await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    );
    const runStateBefore = (
      await db.select().from(automationWorkflowRunStates).where(
        eq(automationWorkflowRunStates.runId, fixture.run_id),
      ).limit(1)
    )[0]!;
    expect(runStateBefore.status).toBe("cancelled");

    const receipt = await reconcileAutomationWorkflowEffect(db, input);
    expect(receipt).toMatchObject({
      requested_outcome: "found",
      effective_outcome: "found",
      effect_status: "succeeded",
      reconciliation_count: 0,
      next_reconcile_at: null,
      provider_ref: prUrl,
      receipt_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      provider_call_authorized: false,
      idempotent_replay: false,
    });
    const settled = (
      await db.select().from(automationWorkflowEffects).where(
        eq(automationWorkflowEffects.id, fixture.effect.id),
      ).limit(1)
    )[0]!;
    expect(settled).toMatchObject({ status: "succeeded", providerRef: prUrl, callAttempt: 1 });
    expect(await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, fixture.run_id),
    )).toHaveLength(runEventsBefore.length);
    expect((await db.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, fixture.run_id),
    ).limit(1))[0]).toEqual(runStateBefore);

    const replay = await reconcileAutomationWorkflowEffect(db, {
      ...input,
      observed_at: fixture.reconcile_at + 100,
    });
    expect({ ...replay, idempotent_replay: false }).toEqual(receipt);
    expect(replay.idempotent_replay).toBe(true);

    await expect(reconcileAutomationWorkflowEffect(db, {
      ...input,
      evidence: { ...input.evidence, lookup_started_at: fixture.reconcile_at - 2 },
    })).rejects.toMatchObject({
      status: 409,
      code: "automation_workflow_reconciliation_idempotency_key_reused",
    });
  });

  it("keeps the first two lookups indeterminate and requires manual follow-up at the frozen third lookup", () => {
    const base = {
      requested_outcome: "unknown" as const,
      max_reconciliations: 3,
      call_started_at: 1_000,
      now: 2_000,
      retry_backoff_seconds: 900,
      absence_consistency_window_seconds: 60,
    };
    expect(planAutomationWorkflowEffectReconciliation({
      ...base,
      reconciliation_count: 0,
    })).toMatchObject({
      event: "effect.reconciliation_unknown",
      status: "indeterminate",
      reconciliation_count: 1,
      next_reconcile_at: 2_900,
    });
    expect(planAutomationWorkflowEffectReconciliation({
      ...base,
      reconciliation_count: 1,
    })).toMatchObject({
      event: "effect.reconciliation_unknown",
      status: "indeterminate",
      reconciliation_count: 2,
      next_reconcile_at: 2_900,
    });
    expect(planAutomationWorkflowEffectReconciliation({
      ...base,
      reconciliation_count: 2,
    })).toEqual({
      event: "effect.reconciliation_exhausted",
      effective_outcome: "unknown",
      status: "manual_follow_up",
      reconciliation_count: 3,
      next_reconcile_at: null,
    });
  });

  it("requires trusted CI to present an exact active project-bound ci_deploy credential", async () => {
    const fixture = await indeterminateFixture("pause");
    const otherProjectId = "workflow-reconcile-other-project";
    await db.insert(projects).values({
      id: otherProjectId,
      userId: OWNER_ID,
      name: "Other workflow reconciliation project",
    });
    const wrongProject = await createTestProjectCredential(env, otherProjectId, "ci_deploy");
    const revoked = await createTestProjectCredential(env, PROJECT_ID, "ci_deploy");
    const expired = await createTestProjectCredential(env, PROJECT_ID, "ci_deploy");
    await db.update(projectCredentials).set({
      revokedAt: fixture.now,
      revokeReason: "test revocation",
    }).where(eq(projectCredentials.id, revoked.id));
    await db.update(projectCredentials).set({
      expiresAt: fixture.reconcile_at,
    }).where(eq(projectCredentials.id, expired.id));
    const before = await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    );
    const invalidCredentials = [
      ["wrong-project", wrongProject.id],
      ["wrong-kind", fixture.runner.id],
      ["revoked", revoked.id],
      ["expired", expired.id],
    ] as const;
    for (const [label, credentialId] of invalidCredentials) {
      await expect(reconcileAutomationWorkflowEffect(db, {
        project_id: PROJECT_ID,
        effect_id: fixture.effect.id,
        idempotency_key: `invalid-ci-${label}`,
        outcome: "unknown",
        evidence: evidence(fixture, fixture.reconcile_at, "unknown"),
        actor: { principal: "trusted_ci", credential_id: credentialId },
        observed_at: fixture.reconcile_at,
      })).rejects.toMatchObject({
        status: 403,
        code: "automation_workflow_reconciliation_ci_credential_invalid",
      });
    }
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    )).toEqual(before);
  });

  it("enforces the same trusted-CI credential binding in the effect-event trigger", async () => {
    const fixture = await indeterminateFixture("pause");
    const prior = (
      await db.select().from(automationWorkflowEffectEvents).where(
        eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
      ).orderBy(desc(automationWorkflowEffectEvents.sequence)).limit(1)
    )[0]!;
    const payloadJson = canonicalJsonStringify({
      request_hash: HASH_A,
      evidence: { lookup_result: "unknown" },
    });
    const before = await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    );
    await expect(db.insert(automationWorkflowEffectEvents).values({
      id: await sha256Hex("invalid-ci-effect-event"),
      idempotencyKeyHash: await sha256Hex("invalid-ci-effect-idempotency"),
      priorEventHash: prior.id,
      effectId: fixture.effect.id,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      runId: fixture.run_id,
      sequence: prior.sequence + 1,
      event: "effect.reconciliation_unknown",
      effectAttempt: fixture.effect.callAttempt,
      reconciliationCount: fixture.effect.reconciliationCount + 1,
      leaseEpoch: null,
      payloadJson,
      payloadHash: await sha256Hex(payloadJson),
      actorPrincipal: "trusted_ci",
      actorCredentialId: fixture.runner.id,
      at: fixture.reconcile_at,
    })).rejects.toMatchObject({
      cause: {
        code: "SQLITE_CONSTRAINT_TRIGGER",
        message: expect.stringContaining("automation workflow effect event chain, lease, or transition evidence is invalid"),
      },
    });
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    )).toEqual(before);
  });

  it("rejects a nonterminal effect-ledger reconciliation with no exact workflow-event cross-link", async () => {
    const fixture = await indeterminateFixture("live");
    const prior = (
      await db.select().from(automationWorkflowEffectEvents).where(
        eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
      ).orderBy(desc(automationWorkflowEffectEvents.sequence)).limit(1)
    )[0]!;
    const payloadJson = canonicalJsonStringify({
      request_hash: HASH_A,
      evidence: { lookup_result: "unknown" },
    });
    const before = await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    );
    await expect(db.insert(automationWorkflowEffectEvents).values({
      id: await sha256Hex("unbound-live-effect-reconciliation"),
      idempotencyKeyHash: await sha256Hex("unbound-live-effect-idempotency"),
      priorEventHash: prior.id,
      effectId: fixture.effect.id,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      runId: fixture.run_id,
      sequence: prior.sequence + 1,
      event: "effect.reconciliation_unknown",
      effectAttempt: fixture.effect.callAttempt,
      reconciliationCount: fixture.effect.reconciliationCount + 1,
      leaseEpoch: null,
      payloadJson,
      payloadHash: await sha256Hex(payloadJson),
      actorPrincipal: "agentry_system",
      actorCredentialId: null,
      at: fixture.reconcile_at,
    })).rejects.toMatchObject({
      cause: {
        code: "SQLITE_CONSTRAINT_TRIGGER",
        message: expect.stringContaining("automation workflow effect event chain, lease, or transition evidence is invalid"),
      },
    });
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, fixture.effect.id),
    )).toEqual(before);
  });

  it("coerces premature absence to unknown and never changes provider call authority", () => {
    expect(planAutomationWorkflowEffectReconciliation({
      requested_outcome: "definitively_absent",
      reconciliation_count: 0,
      max_reconciliations: 3,
      call_started_at: 1_000,
      now: 1_059,
      retry_backoff_seconds: 900,
      absence_consistency_window_seconds: 60,
    })).toEqual({
      event: "effect.reconciliation_unknown",
      effective_outcome: "unknown",
      status: "indeterminate",
      reconciliation_count: 1,
      next_reconcile_at: 1_959,
    });
    expect(planAutomationWorkflowEffectReconciliation({
      requested_outcome: "unknown",
      reconciliation_count: 0,
      max_reconciliations: 3,
      call_started_at: 1_000,
      now: 1_400,
      retry_backoff_seconds: 900,
      backoff_deadline_at: 1_500,
      absence_consistency_window_seconds: 60,
    }).next_reconcile_at).toBe(1_500);
  });

  it("rejects runner reconciliation authority before reading any effect", async () => {
    await expect(reconcileAutomationWorkflowEffect(db, {
      project_id: PROJECT_ID,
      effect_id: `awfx_${HASH_A}`,
      idempotency_key: "runner-cannot-reconcile",
      outcome: "unknown",
      evidence: {
        provider: "github",
        provider_operation_key: HASH_A,
        provider_target: "https://github.com/example/app",
        intent_marker: HASH_A,
        expected_head_sha: "abcdef2",
        lookup_started_at: 100,
        lookup_completed_at: 101,
        lookup_result: "unknown",
        matched_provider_ref: null,
      },
      actor: { principal: "automation_runner", credential_id: "runner-1" },
    } as never)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});
