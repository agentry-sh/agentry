import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { canonicalJsonStringify, sha256Hex } from "@agentrysh/shared";
import {
  automationWorkflowBudgetCharges,
  automationWorkflowCommands,
  automationWorkflowEffectEvents,
  automationWorkflowEffects,
  automationWorkflowExecutionAuthorities,
  automationWorkflowRunEvents,
  automationWorkflowRunLeases,
  automationWorkflowRuns,
  automationWorkflowRunStates,
  automationWorkflowSuspensions,
  automationWorkflowTriggerReceipts,
  automationWorkflows,
  cases,
  posthogConnections,
  projectDeletionFences,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import {
  automationWorkflowCodeFixProposalHash,
  automationWorkflowFunnelSourceHash,
  automationWorkflowFunnelReportHash,
} from "../src/automation-workflow-adapters.js";
import { loadLiveOrderedFunnelExecutionAuthority } from "../src/automation-workflow-execution-authority.js";
import {
  pauseAutomationWorkflow,
  pauseAutomationWorkflowProject,
} from "../src/automation-workflow-controls.js";
import { automationWorkflowHeadEtag } from "../src/automation-workflow-identities.js";
import {
  acquireAutomationWorkflowRunLease,
  automationWorkflowLeaseReleaseReceiptHash,
  assertAutomationWorkflowRunLease,
  readAutomationWorkflowRunLease,
  releaseAutomationWorkflowRunLease,
  renewAutomationWorkflowRunLease,
} from "../src/automation-workflow-leases.js";
import {
  buildErrorToDraftPrWorkflow,
  buildWeeklyFunnelReviewWorkflow,
} from "../src/automation-workflow-presets.js";
import {
  applyAutomationWorkflowCommand,
  readAutomationWorkflowEffect,
  readAutomationWorkflowRun,
  startAutomationWorkflowRun,
} from "../src/automation-workflow-service.js";
import {
  loadAutomationWorkflow,
  saveDisabledAutomationWorkflow,
} from "../src/automation-workflow-store.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "workflow-runtime-owner";
const PROJECT_ID = "workflow-runtime-project";
const RUNNER_ID = "runner-credential-1";
const RUNNER_TOKEN_A = "lease-token-a-0123456789-ABCDEFGHIJ";
const RUNNER_TOKEN_B = "lease-token-b-0123456789-ABCDEFGHIJ";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const system = { principal: "agentry_system" as const, credential_id: null };
const owner = { principal: "human_project_owner" as const, credential_id: OWNER_ID };
const runner = { principal: "automation_runner" as const, credential_id: RUNNER_ID };

type Db = ReturnType<typeof getDbForUrl>;
type TestTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

let env: TestEnv;
let db: Db;
let base: number;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  base = Number(clock.rows[0]?.now_seconds ?? 0);
  await db.insert(users).values({
    id: OWNER_ID,
    email: "workflow-runtime@example.test",
  });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Workflow runtime",
  });
});

afterEach(() => disposeTestEnv(env));

function weeklyWorkflow(maxRunsPerDay = 2) {
  return buildWeeklyFunnelReviewWorkflow({
    automation_id: "weekly_funnel_review",
    name: "Weekly activation funnel review",
    runner: { provider: "codex" as const, environment: "production" },
    schedule: {
      cron: "0 9 * * 1",
      timezone: "Europe/Helsinki",
      start_window_seconds: 900,
    },
    funnel: {
      events: ["account_created", "project_created", "subscription_started", "first_value_reached"],
      period_days: 7,
      minimum_sample_size: 25,
    },
    budgets: {
      max_runs_per_day: maxRunsPerDay,
      max_turns_per_run: 24,
      max_runtime_seconds: 1_800,
      max_cost_usd_per_run: 5,
    },
    escalation: {
      destination: "project owner",
      instructions: "Report the missing evidence and stop.",
    },
  });
}

function errorWorkflow() {
  return buildErrorToDraftPrWorkflow({
    automation_id: "repair_production_case",
    name: "Repair trusted production case",
    runner: {
      provider: "codex" as const,
      repository_provider: "github" as const,
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
    escalation: {
      destination: "project owner",
      instructions: "Preserve exact evidence and stop.",
    },
  });
}

async function saveAndActivate(workflow: ReturnType<typeof weeklyWorkflow> | ReturnType<typeof errorWorkflow>) {
  const saved = await saveDisabledAutomationWorkflow(db, {
    project_id: PROJECT_ID,
    actor_user_id: OWNER_ID,
    workflow,
    observed_at: base,
  });
  const activatedAt = base;
  await db.insert(projectCredentials).values({
    id: RUNNER_ID,
    projectId: PROJECT_ID,
    kind: "automation_runner",
    name: "Workflow runtime runner",
    prefix: "agentry_runner_workflow_runtime",
    tokenHash: "c".repeat(64),
    automationId: workflow.id,
    createdBy: OWNER_ID,
    createdAt: base,
    expiresAt: base + 200_000,
  });
  const descriptor = await loadLiveOrderedFunnelExecutionAuthority();
  if (!descriptor) throw new Error("missing live ordered-funnel execution descriptor");
  const readinessHash = "e".repeat(64);
  const executionAuthorityId = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-test-automation-workflow-execution-authority-v1",
    project_id: PROJECT_ID,
    automation_id: workflow.id,
    workflow_revision_id: saved.workflow.revision_id,
    workflow_hash: saved.workflow.workflow_hash,
    compile_hash: saved.workflow.compile_hash,
    descriptor_hash: descriptor.descriptor_hash,
    runner_credential_id: RUNNER_ID,
  }));
  await db.insert(automationWorkflowExecutionAuthorities).values({
    id: executionAuthorityId,
    projectId: PROJECT_ID,
    automationId: workflow.id,
    workflowRevisionId: saved.workflow.revision_id,
    workflowHash: saved.workflow.workflow_hash,
    compileHash: saved.workflow.compile_hash,
    readinessHash,
    ownerConfirmedCallerAssertionIdsJson: "[]",
    descriptorKind: descriptor.descriptor_kind,
    descriptorJson: descriptor.descriptor_json,
    descriptorHash: descriptor.descriptor_hash,
    runnerCredentialId: RUNNER_ID,
    enabledBy: OWNER_ID,
    enabledAt: activatedAt,
  });
  const etag = await automationWorkflowHeadEtag({
    project_id: saved.workflow.project_id,
    automation_id: saved.workflow.automation_id,
    current_revision_id: saved.workflow.revision_id,
    current_revision: saved.workflow.revision,
    workflow_hash: saved.workflow.workflow_hash,
    compile_hash: saved.workflow.compile_hash,
    enabled: true,
    active_revision_id: saved.workflow.revision_id,
    active_execution_authority_id: executionAuthorityId,
    paused_at: null,
    pause_reason: null,
    updated_at: activatedAt,
  });
  const activated = await db.update(automationWorkflows).set({
    enabled: 1,
    activeRevisionId: saved.workflow.revision_id,
    activeExecutionAuthorityId: executionAuthorityId,
    pausedAt: null,
    pauseReason: null,
    etag,
    updatedBy: OWNER_ID,
    updatedAt: activatedAt,
  }).where(and(
    eq(automationWorkflows.projectId, PROJECT_ID),
    eq(automationWorkflows.automationId, workflow.id),
  )).returning({ projectId: automationWorkflows.projectId });
  expect(activated).toHaveLength(1);
  if (workflow.id === "repair_production_case") {
    await db.insert(posthogConnections).values({
      id: "phconn-workflow-runtime",
      projectId: PROJECT_ID,
      authorizedByUserId: OWNER_ID,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: base + 200_000,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org-workflow-runtime",
      posthogEnvironmentId: 42,
      authorizedAt: base - 3_600,
      createdAt: base - 3_600,
      updatedAt: base - 3_600,
    });
    await db.insert(cases).values({
      id: "case-1",
      projectId: PROJECT_ID,
      providerIssueId: "case-1",
      providerSnapshotHash: "a".repeat(64),
      providerProjectedAt: base - 10,
      providerEventClassification: "customer_exception",
      fingerprint: "workflow-runtime-case",
      errorType: "TypeError",
      message: "boom",
      status: "active",
      eventCount: 4,
      firstSeenAt: base - 100,
      lastSeenAt: base - 10,
      lastDeploySha: null,
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
      revision: 3,
    });
  }
  return saved.workflow;
}

async function databaseNow(): Promise<number> {
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  return Number(clock.rows[0]?.now_seconds ?? 0);
}

function databaseAt(source: Db, at: number): Db {
  const transaction = (callback: (tx: TestTransaction) => unknown) => source.transaction(async (tx) => {
    const clocked = new Proxy(tx, {
      get(target, property) {
        if (property === "run") return async () => ({ rows: [{ now_seconds: at }] });
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return callback(clocked);
  });
  return new Proxy(source, {
    get(target, property) {
      if (property === "run") return async () => ({ rows: [{ now_seconds: at }] });
      if (property === "transaction") return transaction;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function withRuntimePersistenceTriggersDisabled<T>(operation: () => Promise<T>): Promise<T> {
  const snapshot = await db.run(sql`
    SELECT name, sql
      FROM sqlite_master
     WHERE type = 'trigger'
       AND tbl_name IN (
         'automation_workflow_runs', 'automation_workflow_run_events',
         'automation_workflow_run_states', 'automation_workflow_run_leases',
         'automation_workflow_commands', 'automation_workflow_suspensions',
         'automation_workflow_effects', 'automation_workflow_effect_events',
         'automation_workflow_budget_charges', 'automation_workflow_trigger_receipts'
       )
     ORDER BY name
  `);
  const triggers = snapshot.rows.map((row) => ({
    name: String(row.name),
    sql: String(row.sql),
  }));
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
         AND tbl_name IN (
           'automation_workflow_runs', 'automation_workflow_run_events',
           'automation_workflow_run_states', 'automation_workflow_run_leases',
           'automation_workflow_commands', 'automation_workflow_suspensions',
           'automation_workflow_effects', 'automation_workflow_effect_events',
           'automation_workflow_budget_charges', 'automation_workflow_trigger_receipts'
         )
       ORDER BY name
    `);
    expect(restored.rows.map((row) => ({ name: String(row.name), sql: String(row.sql) }))).toEqual(triggers);
  }
}

async function waitUntilDatabaseTime(target: number): Promise<number> {
  let now = await databaseNow();
  while (now < target) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    now = await databaseNow();
  }
  return now;
}

function scheduleReceipt(receiptId: string, now: number) {
  return {
    receipt_id: receiptId,
    scheduled_for: now,
    window_start: now - 1,
    window_end: now + 60,
    instruction_authority: "none",
  };
}

function caseReceipt(receiptId: string, now: number) {
  return {
    receipt_id: receiptId,
    case_id: "case-1",
    case_revision: 3,
    snapshot_hash: HASH_A,
    source_trust: "customer_posthog",
    issued_at: now,
    expires_at: now + 600,
    instruction_authority: "none",
  };
}

async function ensureTriggerReceipt(
  source: Db,
  automationId: string,
  triggerOutput: ReturnType<typeof scheduleReceipt> | ReturnType<typeof caseReceipt>,
  at: number,
) {
  const existing = (
    await source.select().from(automationWorkflowTriggerReceipts).where(
      eq(automationWorkflowTriggerReceipts.id, triggerOutput.receipt_id),
    ).limit(1)
  )[0] ?? null;
  if (existing) return;
  const workflow = await loadAutomationWorkflow(source, PROJECT_ID, automationId);
  if (!workflow) throw new Error(`missing workflow ${automationId}`);
  if (!workflow.active_execution_authority_id) throw new Error(`missing workflow execution authority ${automationId}`);
  const entry = workflow.workflow.nodes.find((node) => node.id === workflow.workflow.entry);
  const resolved = workflow.compiled.resolved_nodes.find((node) => node.node_id === workflow.workflow.entry);
  if (!entry || entry.kind !== "trigger" || !resolved) throw new Error("missing compiled trigger entry");
  const isSchedule = "scheduled_for" in triggerOutput;
  const triggerKey = isSchedule
    ? `schedule:${triggerOutput.scheduled_for}`
    : `case:${triggerOutput.case_id}:${triggerOutput.case_revision}`;
  const payloadJson = canonicalJsonStringify(triggerOutput);
  await source.insert(automationWorkflowTriggerReceipts).values({
    id: triggerOutput.receipt_id,
    projectId: PROJECT_ID,
    automationId,
    workflowRevisionId: workflow.revision_id,
    workflowHash: workflow.workflow_hash,
    compileHash: workflow.compile_hash,
    executionAuthorityId: workflow.active_execution_authority_id,
    triggerNodeId: entry.id,
    componentId: entry.component.id,
    componentVersion: entry.component.version,
    componentHash: resolved.component_hash,
    outputContract: resolved.output_contract,
    outputSchemaHash: resolved.output_contract_schema_hash,
    triggerKind: isSchedule ? "schedule" : "case",
    triggerKey,
    attempt: 1,
    payloadJson,
    payloadHash: await sha256Hex(payloadJson),
    sourceTrust: isSchedule ? "agentry_system" : "customer_posthog",
    status: "ready",
    consumedRunId: null,
    issuedAt: isSchedule ? at : triggerOutput.issued_at,
    availableAt: isSchedule ? triggerOutput.window_start : triggerOutput.issued_at,
    expiresAt: isSchedule ? triggerOutput.window_end : triggerOutput.expires_at,
    consumedAt: null,
    cancelledAt: null,
    cancelReason: null,
    updatedAt: isSchedule ? at : triggerOutput.issued_at,
  });
}

async function startWeekly(
  idempotencyKey: string,
  receiptId: string,
  now: number,
  triggerOutput = scheduleReceipt(receiptId, now),
) {
  await ensureTriggerReceipt(db, "weekly_funnel_review", triggerOutput, await databaseNow());
  return startAutomationWorkflowRun(db, {
    project_id: PROJECT_ID,
    automation_id: "weekly_funnel_review",
    idempotency_key: idempotencyKey,
    trigger_receipt_id: receiptId,
    runner_credential_id: RUNNER_ID,
    observed_at: now,
  });
}

async function startCaseWorkflow(
  source: Db,
  idempotencyKey: string,
  triggerOutput: ReturnType<typeof caseReceipt>,
  at: number,
) {
  await ensureTriggerReceipt(source, "repair_production_case", triggerOutput, at);
  return startAutomationWorkflowRun(source, {
    project_id: PROJECT_ID,
    automation_id: "repair_production_case",
    idempotency_key: idempotencyKey,
    trigger_receipt_id: triggerOutput.receipt_id,
    runner_credential_id: RUNNER_ID,
    observed_at: at,
  });
}

async function funnelSource(schedule: ReturnType<typeof scheduleReceipt>) {
  const names = ["account_created", "project_created", "subscription_started", "first_value_reached"];
  const source = {
    source_hash: HASH_A,
    current_period: { start: schedule.scheduled_for - 604_800, end: schedule.scheduled_for },
    previous_period: {
      start: schedule.scheduled_for - 1_209_600,
      end: schedule.scheduled_for - 604_800,
    },
    events: names,
    current: {
      observed_users: 100,
      steps: names.map((event, index) => ({ event, users: 100 - index * 10 })),
    },
    previous: {
      observed_users: 90,
      steps: names.map((event, index) => ({ event, users: 90 - index * 10 })),
    },
    readiness: { status: "ready", limitations: [] as string[] },
    instruction_authority: "none",
  };
  source.source_hash = await automationWorkflowFunnelSourceHash({
    schedule,
    config: {
      events: names,
      period_days: 7,
      minimum_sample_size: 25,
    },
    source,
  });
  return source;
}

async function funnelReport(sourceHash: string) {
  const report = {
    report_hash: HASH_B,
    source_hash: sourceHash,
    findings: [{
      kind: "metric",
      statement: "Activation improved in the bounded comparison.",
      evidence_paths: ["current.steps", "previous.steps"],
    }],
    limitations: ["Descriptive evidence only."],
    instruction_authority: "none",
  };
  report.report_hash = await automationWorkflowFunnelReportHash(report);
  return report;
}

async function codeFixProposal() {
  const proposal = {
    proposal_hash: HASH_B,
    evidence_hash: HASH_B,
    repository: "https://github.com/example/app",
    base_sha: "abcdef1",
    head_sha: "abcdef2",
    branch: "agentry/fix-case-1",
    changed_files: [{ path: "src/fix.ts", added_lines: 4, deleted_lines: 1 }],
    tests: [{ command: "npm test", status: "passed", exit_code: 0 }],
    summary: "Bounded exact fix",
    instruction_authority: "none",
  };
  proposal.proposal_hash = await automationWorkflowCodeFixProposalHash(proposal);
  return proposal;
}

async function counts(runId?: string) {
  const commands = runId
    ? await db.select().from(automationWorkflowCommands).where(
      eq(automationWorkflowCommands.runId, runId),
    )
    : await db.select().from(automationWorkflowCommands);
  const events = runId
    ? await db.select().from(automationWorkflowRunEvents).where(
      eq(automationWorkflowRunEvents.runId, runId),
    )
    : await db.select().from(automationWorkflowRunEvents);
  const states = runId
    ? await db.select().from(automationWorkflowRunStates).where(
      eq(automationWorkflowRunStates.runId, runId),
    )
    : await db.select().from(automationWorkflowRunStates);
  return {
    runs: (await db.select().from(automationWorkflowRuns)).length,
    charges: (await db.select().from(automationWorkflowBudgetCharges)).length,
    commands: commands.length,
    events: events.length,
    states: states.length,
  };
}

describe("automation workflow runtime service", () => {
  it("projects exact recoverable work and returns a hash-verifiable lease release receipt", async () => {
    await saveAndActivate(weeklyWorkflow());
    const startedAt = await databaseNow();
    const trigger = scheduleReceipt("schedule-recovery-projection", startedAt);
    let receipt = await startWeekly(
      "recovery-projection-start",
      trigger.receipt_id,
      startedAt,
      trigger,
    );

    let projected = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(projected?.next_action).toMatchObject({
      runtime: { kind: "execute_component", node_id: "funnel_source" },
      required_principal: "agentry_system",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/automation-workflows/weekly_funnel_review/runs/${receipt.run_id}/advance`,
      expected_revision: receipt.state.revision,
      lease_required: false,
      lease: null,
      effect_id: null,
      suspension_id: null,
    });

    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "recovery-funnel-source",
        expected_revision: receipt.state.revision,
        node_id: "funnel_source",
        output: await funnelSource(trigger),
      },
      actor: system,
      observed_at: await databaseNow(),
    });
    projected = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(projected?.next_action).toMatchObject({
      runtime: { kind: "execute_component", node_id: "review_funnel" },
      required_principal: "automation_runner",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/automation-workflows/weekly_funnel_review/runs/${receipt.run_id}/commands`,
      expected_revision: receipt.state.revision,
      lease_required: true,
      lease: {
        current: null,
        acquire: {
          method: "POST",
          path: `/v1/projects/${PROJECT_ID}/automation-workflows/weekly_funnel_review/runs/${receipt.run_id}/lease`,
        },
        renew: {
          method: "POST",
          path: `/v1/projects/${PROJECT_ID}/automation-workflows/weekly_funnel_review/runs/${receipt.run_id}/lease/renew`,
        },
        release: {
          method: "DELETE",
          path: `/v1/projects/${PROJECT_ID}/automation-workflows/weekly_funnel_review/runs/${receipt.run_id}/lease`,
        },
      },
    });

    const leaseAt = await databaseNow();
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: leaseAt,
    });
    projected = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(projected?.next_action?.lease?.current).toMatchObject({
      run_id: receipt.run_id,
      lease_epoch: lease.lease_epoch,
      holder_principal: "automation_runner",
      holder_credential_id: RUNNER_ID,
      status: "active",
      released_at: null,
      release_reason: null,
    });
    expect(JSON.stringify(projected)).not.toContain(RUNNER_TOKEN_A);
    expect(JSON.stringify(projected)).not.toContain("token_hash");

    const releaseInput = {
      run_id: receipt.run_id,
      lease_epoch: lease.lease_epoch,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      reason: "Yield the exact runner work after checkpointing it.",
      observed_at: await databaseNow(),
    };
    const released = await releaseAutomationWorkflowRunLease(db, releaseInput);
    expect(released).toMatchObject({
      kind: "automation_workflow_lease_release_receipt",
      schema_version: "1",
      run_id: receipt.run_id,
      lease_epoch: lease.lease_epoch,
      lease_version: 2,
      holder_credential_id: RUNNER_ID,
      release_reason: releaseInput.reason,
      receipt_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      idempotent_replay: false,
    });
    const {
      receipt_hash: receiptHash,
      idempotent_replay: _idempotentReplay,
      ...durableRelease
    } = released;
    expect(await automationWorkflowLeaseReleaseReceiptHash(durableRelease)).toBe(receiptHash);
    const replay = await releaseAutomationWorkflowRunLease(db, {
      ...releaseInput,
      observed_at: await databaseNow(),
    });
    expect({ ...replay, idempotent_replay: false }).toEqual(released);
    expect(replay.idempotent_replay).toBe(true);
    expect(await readAutomationWorkflowRunLease(db, receipt.run_id)).toMatchObject({
      status: "released",
      release_reason: releaseInput.reason,
    });
    await expect(releaseAutomationWorkflowRunLease(db, {
      ...releaseInput,
      reason: "Try to rewrite immutable release history.",
      observed_at: await databaseNow(),
    })).rejects.toMatchObject({
      code: "automation_workflow_lease_release_request_mismatch",
    });
  });

  it("binds approval, effect, and reconciliation recovery to durable materialization ids", async () => {
    await saveAndActivate(errorWorkflow());
    const startedAt = await databaseNow();
    let receipt = await startCaseWorkflow(
      db,
      "materialization-recovery-start",
      caseReceipt("case-materialization-recovery", startedAt),
      startedAt,
    );
    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "materialization-case-source",
        expected_revision: receipt.state.revision,
        node_id: "case_evidence",
        output: {
          case_id: "case-1",
          case_revision: 3,
          evidence_hash: HASH_B,
          error: {
            type: "TypeError",
            message: "boom",
            event_count: 4,
            first_seen_at: startedAt - 100,
            last_seen_at: startedAt - 10,
          },
          last_deploy_sha: null,
          instruction_authority: "none",
        },
      },
      actor: system,
      observed_at: await databaseNow(),
    });
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: await databaseNow(),
    });
    const proposal = await codeFixProposal();
    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "materialization-proposal",
        expected_revision: receipt.state.revision,
        node_id: "diagnose_fix",
        output: proposal,
        usage: {
          sequence: 1,
          turns_used: 4,
          cost_micros: 500_000,
          touched_files: ["src/fix.ts"],
          changed_line_churn: 5,
        },
      },
      actor: runner,
      lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: await databaseNow(),
    });

    let projected = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(projected?.next_action).toMatchObject({
      runtime: { kind: "await_approval", node_id: "approve_draft_pr" },
      required_principal: "human_project_owner",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/automation-workflows/repair_production_case/runs/${receipt.run_id}/commands`,
      expected_revision: receipt.state.revision,
      lease_required: false,
      suspension_id: expect.any(String),
      suspension_kind: "approval",
      suspension_status: "pending",
      effect_id: null,
    });
    expect(projected?.next_action?.timing.expires_at).toBe(
      (projected?.next_action?.runtime as { expires_at: number }).expires_at,
    );

    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "approval_decided",
        command_id: "materialization-approval",
        expected_revision: receipt.state.revision,
        node_id: "approve_draft_pr",
        decision: "approved",
        reason: "Approve the exact bounded provider intent.",
      },
      actor: owner,
      observed_at: await databaseNow(),
    });
    projected = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(projected?.next_action).toMatchObject({
      runtime: { kind: "execute_effect", node_id: "create_draft_pr" },
      required_principal: "automation_runner",
      lease_required: true,
      effect_id: expect.any(String),
      effect_status: "reserved",
      suspension_id: expect.any(String),
      suspension_kind: "approval",
      suspension_status: "approved",
    });
    const effectId = projected!.next_action!.effect_id!;
    let effect = await readAutomationWorkflowEffect(
      db,
      PROJECT_ID,
      "repair_production_case",
      receipt.run_id,
      effectId,
    );
    expect(effect).toMatchObject({
      effect_id: effectId,
      status: "reserved",
      provider_call_authorized: false,
      reconciliation: {
        count: 0,
        due: false,
        operation: null,
        last_provider_evidence: null,
      },
      ledger: { event_count: 1, last_event: { event: "effect.intent_reserved" } },
    });
    expect(JSON.stringify(effect)).not.toContain("receipt_json");

    const intentHash = (receipt.next_action as { intent_hash: string }).intent_hash;
    const called = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "effect_call_started",
        command_id: "materialization-effect-call",
        expected_revision: receipt.state.revision,
        node_id: "create_draft_pr",
        intent_hash: intentHash,
      },
      actor: runner,
      lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: await databaseNow(),
    });
    projected = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(projected?.next_action).toMatchObject({
      runtime: { kind: "reconcile_effect", node_id: "create_draft_pr" },
      required_principal: "trusted_ci",
      method: "POST",
      path: `/v1/projects/${PROJECT_ID}/automation-workflows/repair_production_case/runs/${receipt.run_id}/effects/${effectId}/reconcile`,
      expected_revision: called.state.revision,
      lease_required: false,
      effect_id: effectId,
      effect_status: "indeterminate",
      suspension_status: "approved",
    });
    effect = await readAutomationWorkflowEffect(
      db,
      PROJECT_ID,
      "repair_production_case",
      receipt.run_id,
      effectId,
    );
    expect(effect).toMatchObject({
      status: "indeterminate",
      provider_call_authorized: false,
      provider: {
        operation_key: intentHash,
        call_attempt: 1,
        maximum_call_attempts: 1,
      },
      reconciliation: {
        count: 0,
        maximum: 3,
        remaining: 3,
        operation: {
          method: "POST",
          path: `/v1/projects/${PROJECT_ID}/automation-workflows/repair_production_case/runs/${receipt.run_id}/effects/${effectId}/reconcile`,
          required_principal: "trusted_ci",
          idempotency_key_required: true,
        },
      },
      ledger: { event_count: 2, last_event: { event: "effect.call_started" } },
    });
  });

  it("atomically persists one start and replays only the exact logical request", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const trigger = scheduleReceipt("schedule-atomic-1", now);
    const started = await startWeekly("start-atomic-key", trigger.receipt_id, now, trigger);

    expect(started).toMatchObject({
      kind: "automation_workflow_command_receipt",
      schema_version: "1",
      expected_revision: 0,
      idempotent_replay: false,
      state: {
        project_id: PROJECT_ID,
        automation_id: "weekly_funnel_review",
        status: "awaiting_component",
        current_node_id: "funnel_source",
      },
    });
    expect(await counts(started.run_id)).toEqual({
      runs: 1,
      charges: 1,
      commands: 1,
      events: started.committed_revision,
      states: 1,
    });

    const replay = await startWeekly("start-atomic-key", trigger.receipt_id, now + 30, trigger);
    expect(replay).toMatchObject({
      run_id: started.run_id,
      command_id: started.command_id,
      request_hash: started.request_hash,
      state_hash: started.state_hash,
      idempotent_replay: true,
    });
    expect(await counts(started.run_id)).toEqual({
      runs: 1,
      charges: 1,
      commands: 1,
      events: started.committed_revision,
      states: 1,
    });

    const differentReceipt = {
      ...trigger,
      receipt_id: "schedule-atomic-different",
      scheduled_for: trigger.scheduled_for + 1,
    };
    await expect(startWeekly(
      "start-atomic-key",
      differentReceipt.receipt_id,
      now + 31,
      differentReceipt,
    )).rejects.toMatchObject({ code: "idempotency_key_reused" });
    expect(await counts(started.run_id)).toEqual({
      runs: 1,
      charges: 1,
      commands: 1,
      events: started.committed_revision,
      states: 1,
    });
  });

  it("does not freeze a legacy-disabled runner credential into a new run", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const trigger = scheduleReceipt("schedule-legacy-disabled-runner", now);
    // Freeze a valid server-issued receipt first; disabling the runner must
    // still close start authority even for already-issued work.
    await ensureTriggerReceipt(db, "weekly_funnel_review", trigger, now);
    await db.update(projectCredentials).set({
      tokenHash: `legacy-disabled:${"f".repeat(64)}`,
    }).where(eq(projectCredentials.id, RUNNER_ID));

    await expect(startWeekly(
      "legacy-disabled-runner-start",
      trigger.receipt_id,
      now,
      trigger,
    )).rejects.toMatchObject({
      code: "automation_workflow_trigger_authority_closed",
      details: {
        authority_reason: "runner_credential_inactive",
        receipt_id: trigger.receipt_id,
      },
    });
    expect(await db.select().from(automationWorkflowRuns)).toHaveLength(0);
    expect(await db.select().from(automationWorkflowBudgetCharges)).toHaveLength(0);
  });

  it("enforces the aggregate run budget over the inclusive rolling 24-hour window", async () => {
    await saveAndActivate(weeklyWorkflow(1));
    const firstAt = await databaseNow();
    await startWeekly("rolling-run-key-1", "schedule-rolling-1", firstAt);
    const secondAt = await databaseNow();
    const secondTrigger = {
      ...scheduleReceipt("schedule-rolling-2", secondAt),
      scheduled_for: secondAt + 1,
    };
    await expect(startWeekly(
      "rolling-run-key-2",
      "schedule-rolling-2",
      secondAt,
      secondTrigger,
    )).rejects.toMatchObject({ code: "automation_workflow_daily_run_budget_exhausted" });
    expect(await counts()).toMatchObject({ runs: 1, charges: 1 });
  });

  it("does not over-allocate the aggregate run budget under concurrent admission", async () => {
    await saveAndActivate(weeklyWorkflow(1));
    const now = await databaseNow();
    const first = scheduleReceipt("schedule-race-1", now);
    const second = {
      ...scheduleReceipt("schedule-race-2", now),
      scheduled_for: now + 1,
    };
    const results = await Promise.allSettled([
      startWeekly("run-budget-race-1", first.receipt_id, now, first),
      startWeekly("run-budget-race-2", second.receipt_id, now, second),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await counts()).toMatchObject({ runs: 1, charges: 1, commands: 1, states: 1 });
  });

  it("treats observed_at only as DB-clock skew evidence on every authority path", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const stale = now - 30;
    await expect(startWeekly(
      "stale-clock-start",
      "schedule-stale-clock",
      stale,
      scheduleReceipt("schedule-stale-clock", now),
    )).rejects.toMatchObject({ code: "invalid_payload" });
    expect(await counts()).toMatchObject({ runs: 0, charges: 0 });

    const trigger = scheduleReceipt("schedule-stale-clock", now);
    const started = await startWeekly("clock-authority-start", trigger.receipt_id, now, trigger);
    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: stale,
    })).rejects.toMatchObject({ code: "invalid_payload" });
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: await databaseNow(),
    });
    await expect(assertAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      lease_epoch: lease.lease_epoch,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      observed_at: stale,
    })).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: {
        kind: "component_domain_failed",
        command_id: "stale-clock-command",
        expected_revision: started.state.revision,
        node_id: "funnel_source",
        error: { code: "query_failed", message: "Caller time cannot backdate runtime authority." },
      },
      actor: system,
      observed_at: stale,
    })).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(pauseAutomationWorkflowProject(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      reason: "Reject a backdated project pause.",
      observed_at: stale,
    })).rejects.toMatchObject({ code: "invalid_payload" });
    await expect(pauseAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      actor_user_id: OWNER_ID,
      reason: "Reject a future workflow pause.",
      observed_at: now + 30,
    })).rejects.toMatchObject({ code: "invalid_payload" });
    expect(await counts(started.run_id)).toMatchObject({ commands: 1, events: started.committed_revision });
    expect(await db.select().from(automationWorkflowRunLeases).where(
      eq(automationWorkflowRunLeases.runId, started.run_id),
    )).toHaveLength(1);
  });

  it("replays, renews, expires, and fences lease epochs using hash-only tokens", async () => {
    await saveAndActivate(weeklyWorkflow());
    const startedAt = await databaseNow();
    const trigger = scheduleReceipt("schedule-lease", startedAt);
    let receipt = await startWeekly("lease-start-key", trigger.receipt_id, startedAt, trigger);
    const source = await funnelSource(trigger);
    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "lease-funnel-source",
        expected_revision: receipt.state.revision,
        node_id: "funnel_source",
        output: source,
      },
      actor: system,
      observed_at: startedAt,
    });
    const acquiredAt = await databaseNow();
    const acquired = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 30,
      observed_at: acquiredAt,
    });
    expect(acquired).toMatchObject({
      lease_epoch: 1,
      expires_at: acquiredAt + 30,
      replayed: false,
    });

    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_B,
      lease_seconds: 30,
      observed_at: acquiredAt,
    })).rejects.toMatchObject({ code: "automation_workflow_lease_busy" });

    const replay = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 30,
      observed_at: acquiredAt + 10_000,
    });
    expect(replay).toMatchObject({ lease_epoch: 1, expires_at: acquiredAt + 30, replayed: true });

    const renewAt = await waitUntilDatabaseTime(acquiredAt + 1);
    const renewed = await renewAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      lease_epoch: 1,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 30,
      observed_at: renewAt,
    });
    expect(renewed).toMatchObject({ lease_epoch: 1, expires_at: renewAt + 30 });

    const takeoverAt = await waitUntilDatabaseTime(renewed.expires_at);
    const takeover = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_B,
      lease_seconds: 30,
      observed_at: takeoverAt,
    });
    expect(takeover).toMatchObject({
      lease_epoch: 2,
      expires_at: takeoverAt + 30,
      replayed: false,
    });

    await expect(renewAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      lease_epoch: 1,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 30,
      observed_at: takeoverAt,
    })).rejects.toMatchObject({ code: "automation_workflow_lease_stale" });
    await expect(assertAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      lease_epoch: 1,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      observed_at: takeoverAt,
    })).rejects.toMatchObject({ code: "automation_workflow_lease_stale" });

    const report = await funnelReport(source.source_hash);
    const agentCommand = {
      kind: "component_succeeded" as const,
      command_id: "lease-fenced-agent-result",
      expected_revision: receipt.state.revision,
      node_id: "review_funnel",
      output: report,
      usage: {
        sequence: 1,
        turns_used: 2,
        cost_micros: 125_000,
        touched_files: [] as string[],
        changed_line_churn: 0,
      },
    };
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: agentCommand,
      actor: runner,
      lease: { lease_epoch: acquired.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: takeoverAt,
    })).rejects.toMatchObject({ code: "automation_workflow_lease_stale" });
    const committed = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: agentCommand,
      actor: runner,
      lease: { lease_epoch: takeover.lease_epoch, lease_token: RUNNER_TOKEN_B },
      observed_at: takeoverAt,
    });
    expect(committed.state).toMatchObject({
      usage_sequence: 1,
      turns_used: 2,
      cost_micros: 125_000,
    });

    const rows = await db.select().from(automationWorkflowRunLeases).where(
      eq(automationWorkflowRunLeases.runId, receipt.run_id),
    );
    expect(rows.map((row) => row.leaseEpoch)).toEqual([1, 2]);
    expect(rows.every((row) => row.tokenHash.length === 64)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(RUNNER_TOKEN_A);
    expect(JSON.stringify(rows)).not.toContain(RUNNER_TOKEN_B);
  }, 45_000);

  it("revokes live runner work at the frozen credential boundary while retaining its lease history", async () => {
    await saveAndActivate(weeklyWorkflow());
    const startedAt = await databaseNow();
    const trigger = scheduleReceipt("schedule-credential-fence", startedAt);
    let receipt = await startWeekly(
      "credential-fence-start",
      trigger.receipt_id,
      startedAt,
      trigger,
    );
    const source = await funnelSource(trigger);
    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "credential-fence-source",
        expected_revision: receipt.state.revision,
        node_id: "funnel_source",
        output: source,
      },
      actor: system,
      observed_at: startedAt,
    });
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: startedAt,
    });
    const report = await funnelReport(source.source_hash);
    const command = (suffix: string) => ({
      kind: "component_succeeded" as const,
      command_id: `credential-fence-${suffix}`,
      expected_revision: receipt.state.revision,
      node_id: "review_funnel",
      output: report,
      usage: {
        sequence: 1,
        turns_used: 2,
        cost_micros: 125_000,
        touched_files: [] as string[],
        changed_line_churn: 0,
      },
    });
    const assertInactive = async (suffix: string) => {
      await expect(assertAutomationWorkflowRunLease(db, {
        run_id: receipt.run_id,
        lease_epoch: lease.lease_epoch,
        holder_credential_id: RUNNER_ID,
        lease_token: RUNNER_TOKEN_A,
        observed_at: startedAt,
      })).rejects.toMatchObject({ code: "automation_workflow_runner_credential_inactive" });
      await expect(applyAutomationWorkflowCommand(db, {
        run_id: receipt.run_id,
        command: command(suffix),
        actor: runner,
        lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
        observed_at: startedAt,
      })).rejects.toMatchObject({ code: "automation_workflow_runner_credential_inactive" });
    };
    const before = await counts(receipt.run_id);

    await db.update(projectCredentials).set({
      revokedAt: startedAt,
      revokeReason: "Test live runner revocation",
    }).where(eq(projectCredentials.id, RUNNER_ID));
    const revokedProjection = await readAutomationWorkflowRun(db, PROJECT_ID, receipt.run_id);
    expect(revokedProjection).toMatchObject({
      authority: {
        open: false,
        reason: "runner_credential_inactive",
        runner_credential_id: RUNNER_ID,
        runner_credential_active: false,
      },
      execution_control: {
        execution_authorized: false,
        next_action_suppressed: true,
        recovery: {
          mode: "restore_authority_or_cancel",
          cancel_run: { allowed: true },
          settle_already_started_effect: { allowed: true },
        },
      },
      next_action: null,
    });
    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: startedAt,
    })).rejects.toMatchObject({ code: "automation_workflow_runner_credential_inactive" });
    await assertInactive("revoked");

    await db.update(projectCredentials).set({
      revokedAt: null,
      revokeReason: null,
      expiresAt: startedAt,
    }).where(eq(projectCredentials.id, RUNNER_ID));
    await assertInactive("expired");

    await db.update(projectCredentials).set({
      expiresAt: base + 200_000,
      tokenHash: `legacy-disabled:${"d".repeat(64)}`,
    }).where(eq(projectCredentials.id, RUNNER_ID));
    await assertInactive("legacy-disabled");
    expect(await counts(receipt.run_id)).toEqual(before);

    await db.update(projectCredentials).set({
      tokenHash: "c".repeat(64),
    }).where(eq(projectCredentials.id, RUNNER_ID));
    const committed = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: command("active"),
      actor: runner,
      lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: startedAt,
    });
    expect(committed.state).toMatchObject({ usage_sequence: 1, turns_used: 2 });
    expect(await db.select().from(automationWorkflowRunLeases).where(
      eq(automationWorkflowRunLeases.runId, receipt.run_id),
    )).toHaveLength(1);
  });

  it("fails closed instead of replaying a live lease for a legacy-null execution authority", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const trigger = scheduleReceipt("schedule-legacy-null-authority", now);
    const started = await startWeekly(
      "legacy-null-authority-start",
      trigger.receipt_id,
      now,
      trigger,
    );
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: now,
    });

    // Simulate a pre-authority legacy root while preserving a historical live
    // lease. Runtime must not reinterpret that receipt as current authority.
    await withRuntimePersistenceTriggersDisabled(async () => {
      await db.update(automationWorkflowRuns).set({
        executionAuthorityId: null,
        executionDescriptorHash: null,
      }).where(eq(automationWorkflowRuns.id, started.run_id));
    });

    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: now,
    })).rejects.toMatchObject({
      code: "automation_workflow_execution_authority_inactive",
      details: {
        authority_reason: "execution_authority_mismatch",
        execution_authority_id: null,
      },
    });
    await expect(renewAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      lease_epoch: lease.lease_epoch,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 180,
      observed_at: now,
    })).rejects.toMatchObject({ code: "automation_workflow_execution_authority_inactive" });
    await expect(readAutomationWorkflowRun(db, PROJECT_ID, started.run_id)).rejects.toMatchObject({
      code: "persistence_failed",
    });
  });

  it("keeps exact receipts recoverable while a project kill switch blocks starts, leases, and work", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const trigger = scheduleReceipt("schedule-project-pause", now);
    const blockedTrigger = {
      ...scheduleReceipt("schedule-project-pause-new", now),
      scheduled_for: now + 1,
    };
    const started = await startWeekly("project-pause-start", trigger.receipt_id, now, trigger);
    await ensureTriggerReceipt(db, "weekly_funnel_review", blockedTrigger, now);
    const sourceCommand = {
      kind: "component_succeeded" as const,
      command_id: "project-pause-source-committed",
      expected_revision: started.state.revision,
      node_id: "funnel_source",
      output: await funnelSource(trigger),
    };
    const advanced = await applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: sourceCommand,
      actor: system,
      observed_at: now,
    });
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: now,
    });
    await pauseAutomationWorkflowProject(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      reason: "Emergency project stop",
      observed_at: now,
    });

    const replay = await startWeekly("project-pause-start", trigger.receipt_id, base + 13, trigger);
    expect(replay).toMatchObject({
      run_id: started.run_id,
      idempotent_replay: true,
      next_action: null,
    });
    const commandReplay = await applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: sourceCommand,
      actor: system,
      observed_at: now + 100,
    });
    expect(commandReplay).toMatchObject({
      command_id: sourceCommand.command_id,
      idempotent_replay: true,
      next_action: null,
      effect_call: null,
    });
    const pausedProjection = await readAutomationWorkflowRun(db, PROJECT_ID, started.run_id);
    expect(pausedProjection).toMatchObject({
      authority: {
        open: false,
        reason: "project_paused",
        project_pause_reason: "Emergency project stop",
      },
      execution_control: {
        execution_authorized: false,
        next_action_suppressed: true,
        recovery: {
          mode: "restore_authority_or_cancel",
          cancel_run: { allowed: true },
          settle_already_started_effect: { allowed: true },
          reconcile_already_started_effect: { allowed: true },
        },
      },
      next_action: null,
    });
    // An exact acquire retry is historical evidence only once the kill switch
    // closes; it must not replay the still-unexpired lease as live authority.
    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: now,
    })).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });
    await expect(startWeekly(
      "project-pause-new-start",
      blockedTrigger.receipt_id,
      now,
      blockedTrigger,
    )).rejects.toMatchObject({ code: "automation_workflow_trigger_receipt_cancelled" });
    await expect(renewAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      lease_epoch: lease.lease_epoch,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: now,
    })).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: {
        kind: "component_domain_failed",
        command_id: "blocked-project-work",
        expected_revision: started.state.revision,
        node_id: "funnel_source",
        error: { code: "query_failed", message: "No new work should be accepted." },
      },
      actor: system,
      observed_at: now,
    })).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });
    const cancelled = await applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: {
        kind: "cancel",
        command_id: "cancel-behind-project-kill-switch",
        expected_revision: advanced.state.revision,
        reason: "Stop this run while project execution authority is closed.",
      },
      actor: owner,
      observed_at: await databaseNow(),
    });
    expect(cancelled.state.status).toBe("cancelled");
  });

  it("keeps exact receipts recoverable while a workflow kill switch blocks starts and work", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const trigger = scheduleReceipt("schedule-workflow-pause", now);
    const blockedTrigger = {
      ...scheduleReceipt("schedule-workflow-pause-new", now),
      scheduled_for: now + 1,
    };
    const started = await startWeekly("workflow-pause-start", trigger.receipt_id, now, trigger);
    await ensureTriggerReceipt(db, "weekly_funnel_review", blockedTrigger, now);
    await pauseAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      actor_user_id: OWNER_ID,
      reason: "Stop only this workflow",
      observed_at: now,
    });

    const replay = await startWeekly("workflow-pause-start", trigger.receipt_id, base + 13, trigger);
    expect(replay).toMatchObject({
      run_id: started.run_id,
      idempotent_replay: true,
      next_action: null,
    });
    const pausedProjection = await readAutomationWorkflowRun(db, PROJECT_ID, started.run_id);
    expect(pausedProjection).toMatchObject({
      authority: {
        open: false,
        reason: "workflow_paused",
        workflow_enabled: false,
        workflow_pause_reason: "Stop only this workflow",
      },
      execution_control: {
        execution_authorized: false,
        next_action_suppressed: true,
        recovery: {
          mode: "restore_authority_or_cancel",
          cancel_run: { allowed: true },
          settle_already_started_effect: { allowed: true },
        },
      },
      next_action: null,
    });
    await expect(startWeekly(
      "workflow-pause-new-start",
      blockedTrigger.receipt_id,
      now,
      blockedTrigger,
    )).rejects.toMatchObject({ code: "automation_workflow_trigger_receipt_cancelled" });
    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: now,
    })).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: {
        kind: "component_domain_failed",
        command_id: "blocked-workflow-work",
        expected_revision: started.state.revision,
        node_id: "funnel_source",
        error: { code: "query_failed", message: "No new work should be accepted." },
      },
      actor: system,
      observed_at: now,
    })).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });
    const quarantined = await applyAutomationWorkflowCommand(db, {
      run_id: started.run_id,
      command: {
        kind: "quarantine",
        command_id: "quarantine-behind-workflow-kill-switch",
        expected_revision: started.state.revision,
        reason: "Freeze the run while workflow execution authority is closed.",
      },
      actor: system,
      observed_at: await databaseNow(),
    });
    expect(quarantined.state.status).toBe("quarantined");
  });

  it("treats the project deletion fence as closed live authority without turning replay into a grant", async () => {
    await saveAndActivate(weeklyWorkflow());
    const now = await databaseNow();
    const trigger = scheduleReceipt("schedule-project-deletion-fence", now);
    const started = await startWeekly(
      "project-deletion-fence-start",
      trigger.receipt_id,
      now,
      trigger,
    );
    await db.insert(projectDeletionFences).values({
      projectId: PROJECT_ID,
      commandId: "project-delete-command-live-authority",
      reason: "project_delete",
      actor: OWNER_ID,
      createdAt: now,
    });

    const projected = await readAutomationWorkflowRun(db, PROJECT_ID, started.run_id);
    expect(projected).toMatchObject({
      authority: {
        open: false,
        reason: "project_deletion_fenced",
        deletion_fence: {
          command_id: "project-delete-command-live-authority",
          reason: "project_delete",
          fenced_at: now,
        },
      },
      execution_control: {
        execution_authorized: false,
        next_action_suppressed: true,
        recovery: {
          mode: "continue_project_deletion",
          deletion_command_id: "project-delete-command-live-authority",
          cancel_run: { allowed: false },
          settle_already_started_effect: { allowed: false },
          reconcile_already_started_effect: { allowed: false },
        },
      },
      next_action: null,
    });

    const replay = await startWeekly(
      "project-deletion-fence-start",
      trigger.receipt_id,
      now + 100,
      trigger,
    );
    expect(replay).toMatchObject({
      run_id: started.run_id,
      idempotent_replay: true,
      next_action: null,
      effect_call: null,
    });
    await expect(acquireAutomationWorkflowRunLease(db, {
      run_id: started.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
    })).rejects.toMatchObject({ code: "project_deletion_in_progress" });
  });

  it("does not charge or authorize an effect request that emits only deadline quarantine", async () => {
    await saveAndActivate(errorWorkflow());
    const current = await databaseNow();
    const historicalAt = current - 1_810;
    const prepared = await withRuntimePersistenceTriggersDisabled(async () => {
      const historicalDb = databaseAt(db, historicalAt);
      let receipt = await startCaseWorkflow(
        historicalDb,
        "expired-effect-start-key",
        caseReceipt("case-expired-effect-1", historicalAt),
        historicalAt,
      );
      receipt = await applyAutomationWorkflowCommand(historicalDb, {
        run_id: receipt.run_id,
        command: {
          kind: "component_succeeded",
          command_id: "expired-case-evidence-success",
          expected_revision: receipt.state.revision,
          node_id: "case_evidence",
          output: {
            case_id: "case-1",
            case_revision: 3,
            evidence_hash: HASH_B,
            error: {
              type: "TypeError",
              message: "boom",
              event_count: 4,
              first_seen_at: historicalAt - 100,
              last_seen_at: historicalAt - 10,
            },
            last_deploy_sha: null,
            instruction_authority: "none",
          },
        },
        actor: system,
        observed_at: historicalAt,
      });
      const lease = await acquireAutomationWorkflowRunLease(historicalDb, {
        run_id: receipt.run_id,
        holder_credential_id: RUNNER_ID,
        lease_token: RUNNER_TOKEN_A,
        lease_seconds: 3_600,
        observed_at: historicalAt,
      });
      const proposal = await codeFixProposal();
      receipt = await applyAutomationWorkflowCommand(historicalDb, {
        run_id: receipt.run_id,
        command: {
          kind: "component_succeeded",
          command_id: "expired-diagnose-fix-success",
          expected_revision: receipt.state.revision,
          node_id: "diagnose_fix",
          output: proposal,
          usage: {
            sequence: 1,
            turns_used: 4,
            cost_micros: 500_000,
            touched_files: ["src/fix.ts"],
            changed_line_churn: 5,
          },
        },
        actor: runner,
        lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
        observed_at: historicalAt,
      });
      receipt = await applyAutomationWorkflowCommand(historicalDb, {
        run_id: receipt.run_id,
        command: {
          kind: "approval_decided",
          command_id: "expired-approval-valid-owner",
          expected_revision: receipt.state.revision,
          node_id: "approve_draft_pr",
          decision: "approved",
          reason: "Prepare an exact effect whose elapsed authority is already closed.",
        },
        actor: owner,
        observed_at: historicalAt,
      });
      return {
        receipt,
        lease,
        intent_hash: (receipt.next_action as { intent_hash: string }).intent_hash,
      };
    });

    const beforeCharges = await db.select().from(automationWorkflowBudgetCharges).where(and(
      eq(automationWorkflowBudgetCharges.runId, prepared.receipt.run_id),
      eq(automationWorkflowBudgetCharges.kind, "external_effect_call"),
    ));
    expect(beforeCharges).toHaveLength(0);
    const callAt = await databaseNow();
    const quarantined = await applyAutomationWorkflowCommand(db, {
      run_id: prepared.receipt.run_id,
      command: {
        kind: "effect_call_started",
        command_id: "expired-draft-pr-call-started",
        expected_revision: prepared.receipt.state.revision,
        node_id: "create_draft_pr",
        intent_hash: prepared.intent_hash,
      },
      actor: runner,
      lease: { lease_epoch: prepared.lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: callAt,
    });

    expect(quarantined.state.status).toBe("quarantined");
    expect(quarantined.effect_call).toBeNull();
    expect(await db.select().from(automationWorkflowBudgetCharges).where(and(
      eq(automationWorkflowBudgetCharges.runId, prepared.receipt.run_id),
      eq(automationWorkflowBudgetCharges.kind, "external_effect_call"),
    ))).toHaveLength(0);
    expect((await db.select().from(automationWorkflowRunEvents).where(and(
      eq(automationWorkflowRunEvents.runId, prepared.receipt.run_id),
      eq(automationWorkflowRunEvents.commandId, "expired-draft-pr-call-started"),
    ))).map((event) => event.event)).toEqual(["run.quarantined"]);
    const effect = (await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.runId, prepared.receipt.run_id),
    ))[0]!;
    expect(effect.status).toBe("reserved");
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, effect.id),
    )).toHaveLength(1);
    const durable = (await db.select().from(automationWorkflowCommands).where(and(
      eq(automationWorkflowCommands.runId, prepared.receipt.run_id),
      eq(automationWorkflowCommands.commandId, "expired-draft-pr-call-started"),
    )))[0]!;
    expect(JSON.parse(durable.responseJson).effect_call).toBeNull();
  });

  it("commits suspension/effect materializations with the ledger and never reauthorizes an effect replay", async () => {
    await saveAndActivate(errorWorkflow());
    const startedAt = await databaseNow();
    let receipt = await startCaseWorkflow(
      db,
      "effect-start-key",
      caseReceipt("case-effect-1", startedAt),
      startedAt,
    );
    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "case-evidence-success",
        expected_revision: receipt.state.revision,
        node_id: "case_evidence",
        output: {
          case_id: "case-1",
          case_revision: 3,
          evidence_hash: HASH_B,
          error: {
            type: "TypeError",
            message: "boom",
            event_count: 4,
            first_seen_at: base - 100,
            last_seen_at: base - 10,
          },
          last_deploy_sha: null,
          instruction_authority: "none",
        },
      },
      actor: system,
      observed_at: await databaseNow(),
    });
    const leaseAt = await databaseNow();
    const lease = await acquireAutomationWorkflowRunLease(db, {
      run_id: receipt.run_id,
      holder_credential_id: RUNNER_ID,
      lease_token: RUNNER_TOKEN_A,
      lease_seconds: 120,
      observed_at: leaseAt,
    });
    const proposal = await codeFixProposal();
    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "component_succeeded",
        command_id: "diagnose-fix-success",
        expected_revision: receipt.state.revision,
        node_id: "diagnose_fix",
        output: proposal,
        usage: {
          sequence: 1,
          turns_used: 4,
          cost_micros: 500_000,
          touched_files: ["src/fix.ts"],
          changed_line_churn: 5,
        },
      },
      actor: runner,
      lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: await databaseNow(),
    });
    expect(receipt.next_action).toMatchObject({
      kind: "await_approval",
      node_id: "approve_draft_pr",
    });
    const pending = (
      await db.select().from(automationWorkflowSuspensions).where(
        eq(automationWorkflowSuspensions.runId, receipt.run_id),
      )
    )[0]!;
    expect(pending).toMatchObject({ kind: "approval", status: "pending", version: 1 });

    const beforeFailedApproval = await counts(receipt.run_id);
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "approval_decided",
        command_id: "approval-missing-owner",
        expected_revision: receipt.state.revision,
        node_id: "approve_draft_pr",
        decision: "approved",
        reason: "This missing actor must fail its durable materialization.",
      },
      actor: { principal: "human_project_owner", credential_id: "missing-owner" },
      observed_at: await databaseNow(),
    })).rejects.toThrow();
    expect(await counts(receipt.run_id)).toEqual(beforeFailedApproval);
    expect((await db.select().from(automationWorkflowSuspensions).where(
      eq(automationWorkflowSuspensions.id, pending.id),
    ))[0]).toMatchObject({ status: "pending", version: 1 });

    receipt = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "approval_decided",
        command_id: "approval-valid-owner",
        expected_revision: receipt.state.revision,
        node_id: "approve_draft_pr",
        decision: "approved",
        reason: "Reviewed the exact proposal and tests.",
      },
      actor: owner,
      observed_at: await databaseNow(),
    });
    expect(receipt.next_action).toMatchObject({ kind: "execute_effect", node_id: "create_draft_pr" });
    const intentHash = (receipt.next_action as { intent_hash: string }).intent_hash;
    expect((await db.select().from(automationWorkflowSuspensions).where(
      eq(automationWorkflowSuspensions.id, pending.id),
    ))[0]).toMatchObject({ status: "approved", version: 2, decisionBy: OWNER_ID });
    expect((await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.runId, receipt.run_id),
    ))[0]).toMatchObject({
      nodeId: "create_draft_pr",
      intentHash,
      status: "reserved",
      callAttempt: 0,
    });

    const callCommand = {
      kind: "effect_call_started" as const,
      command_id: "draft-pr-call-started",
      expected_revision: receipt.state.revision,
      node_id: "create_draft_pr",
      intent_hash: intentHash,
    };
    const callAt = await databaseNow();
    const fresh = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: callCommand,
      actor: runner,
      lease: { lease_epoch: lease.lease_epoch, lease_token: RUNNER_TOKEN_A },
      observed_at: callAt,
    });
    expect(fresh.effect_call).toMatchObject({
      intent_hash: intentHash,
      call_authorized: true,
      reconcile_only: false,
      lease_epoch: lease.lease_epoch,
    });

    const replay = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: callCommand,
      actor: runner,
      observed_at: base + 200,
    });
    expect(replay).toMatchObject({ idempotent_replay: true });
    expect(replay.effect_call).toMatchObject({
      intent_hash: intentHash,
      call_authorized: false,
      reconcile_only: true,
      lease_epoch: lease.lease_epoch,
    });

    const effect = (await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.runId, receipt.run_id),
    ))[0]!;
    expect(effect).toMatchObject({ status: "indeterminate", callAttempt: 1, version: 2 });
    expect(await db.select().from(automationWorkflowEffectEvents).where(
      eq(automationWorkflowEffectEvents.effectId, effect.id),
    )).toHaveLength(2);
    expect(await db.select().from(automationWorkflowBudgetCharges).where(and(
      eq(automationWorkflowBudgetCharges.runId, receipt.run_id),
      eq(automationWorkflowBudgetCharges.kind, "external_effect_call"),
    ))).toHaveLength(1);

    const durable = (
      await db.select().from(automationWorkflowCommands).where(and(
        eq(automationWorkflowCommands.runId, receipt.run_id),
        eq(automationWorkflowCommands.commandId, callCommand.command_id),
      ))
    )[0]!;
    expect(JSON.parse(durable.responseJson).effect_call).toMatchObject({
      call_authorized: false,
      reconcile_only: true,
    });

    const settleAt = await databaseNow();
    const pullRequestReceipt = {
      intent_id: intentHash,
      proposal_hash: proposal.proposal_hash,
      provider: "github",
      provider_target: "https://github.com/example/app",
      pr_number: 7,
      pr_url: "https://github.com/example/app/pull/7",
      head_sha: proposal.head_sha,
      recorded_at: settleAt,
      instruction_authority: "none",
    };
    let settled = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "effect_receipt_recorded",
        command_id: "draft-pr-receipt-recorded",
        expected_revision: fresh.state.revision,
        node_id: "create_draft_pr",
        intent_hash: intentHash,
        output: pullRequestReceipt,
      },
      actor: runner,
      observed_at: settleAt,
    });
    expect(settled.next_action).toMatchObject({
      kind: "suspended",
      suspension: "wait",
      node_id: "wait_for_deploy",
    });
    expect((await db.select().from(automationWorkflowEffects).where(
      eq(automationWorkflowEffects.id, effect.id),
    ))[0]).toMatchObject({
      status: "succeeded",
      callAttempt: 1,
      providerRef: pullRequestReceipt.pr_url,
    });
    const waitSuspension = (
      await db.select().from(automationWorkflowSuspensions).where(and(
        eq(automationWorkflowSuspensions.runId, receipt.run_id),
        eq(automationWorkflowSuspensions.nodeId, "wait_for_deploy"),
      ))
    )[0]!;
    expect(waitSuspension).toMatchObject({ kind: "wait", status: "pending", version: 1 });

    const waitAt = await databaseNow();
    const deployReceipt = {
      draft_pr_intent_id: intentHash,
      source_commit_sha: proposal.head_sha,
      deploy_sha: proposal.head_sha,
      provider_proof_hash: HASH_A,
      received_at: waitAt,
      source_trust: "trusted_ci",
      instruction_authority: "none",
    };
    const beforeBadWait = await counts(receipt.run_id);
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "wait_resolved",
        command_id: "deploy-proof-wrong-head",
        expected_revision: settled.state.revision,
        node_id: "wait_for_deploy",
        outcome: "ready",
        output: { ...deployReceipt, deploy_sha: "abcdef3" },
      },
      actor: system,
      observed_at: waitAt,
    })).rejects.toMatchObject({ code: "automation_workflow_adapter_output_invalid" });
    expect(await counts(receipt.run_id)).toEqual(beforeBadWait);
    expect((await db.select().from(automationWorkflowSuspensions).where(
      eq(automationWorkflowSuspensions.id, waitSuspension.id),
    ))[0]).toMatchObject({ status: "pending", version: 1 });

    settled = await applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "wait_resolved",
        command_id: "deploy-proof-observed",
        expected_revision: settled.state.revision,
        node_id: "wait_for_deploy",
        outcome: "ready",
        output: deployReceipt,
      },
      actor: system,
      observed_at: waitAt,
    });
    expect(settled.next_action).toMatchObject({
      kind: "suspended",
      suspension: "verify",
      node_id: "verify_no_recurrence",
    });
    expect((await db.select().from(automationWorkflowSuspensions).where(
      eq(automationWorkflowSuspensions.id, waitSuspension.id),
    ))[0]).toMatchObject({ status: "ready", version: 2 });
    const verifySuspension = (
      await db.select().from(automationWorkflowSuspensions).where(and(
        eq(automationWorkflowSuspensions.runId, receipt.run_id),
        eq(automationWorkflowSuspensions.nodeId, "verify_no_recurrence"),
      ))
    )[0]!;
    expect(verifySuspension).toMatchObject({ kind: "verify", status: "pending", version: 1 });

    const verifyAt = await databaseNow();
    const beforeShortVerification = await counts(receipt.run_id);
    await expect(applyAutomationWorkflowCommand(db, {
      run_id: receipt.run_id,
      command: {
        kind: "verification_resolved",
        command_id: "verification-window-too-short",
        expected_revision: settled.state.revision,
        node_id: "verify_no_recurrence",
        outcome: "pass",
        output: {
          passed: true,
          case_id: "case-1",
          case_revision: 3,
          deploy_sha: proposal.head_sha,
          window_start: waitAt,
          window_end: verifyAt,
          traffic_sample_size: 50,
          recurrence_count: 0,
          checked_at: verifyAt,
          reason: "The sample is deliberately too short for the frozen policy.",
          instruction_authority: "none",
        },
      },
      actor: system,
      observed_at: verifyAt,
    })).rejects.toMatchObject({ code: "automation_workflow_adapter_output_invalid" });
    expect(await counts(receipt.run_id)).toEqual(beforeShortVerification);
    expect((await db.select().from(automationWorkflowSuspensions).where(
      eq(automationWorkflowSuspensions.id, verifySuspension.id),
    ))[0]).toMatchObject({ status: "pending", version: 1 });
  });
});
