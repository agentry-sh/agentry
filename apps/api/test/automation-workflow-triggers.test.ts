import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  automationWorkflowExecutionAuthorities,
  automationWorkflowRuns,
  automationWorkflowTriggerReceipts,
  automationWorkflows,
  cases,
  posthogConnections,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import { canonicalJsonStringify, sha256Hex } from "@agentrysh/shared";
import { automationWorkflowHeadEtag } from "../src/automation-workflow-identities.js";
import { loadLiveOrderedFunnelExecutionAuthority } from "../src/automation-workflow-execution-authority.js";
import { pauseAutomationWorkflow } from "../src/automation-workflow-controls.js";
import {
  buildErrorToDraftPrWorkflow,
  buildWeeklyFunnelReviewWorkflow,
} from "../src/automation-workflow-presets.js";
import { saveDisabledAutomationWorkflow } from "../src/automation-workflow-store.js";
import {
  consumeAutomationWorkflowTriggerReceiptForRun,
  expireAutomationWorkflowTriggerReceipts,
  issueAutomationWorkflowTriggerReceipts,
  listAutomationWorkflowTriggerReceipts,
  loadAutomationWorkflowTriggerReceiptForStart,
  readAutomationWorkflowTriggerReceipt,
} from "../src/automation-workflow-triggers.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "workflow-trigger-owner";
const PROJECT_ID = "workflow-trigger-project";
const RUNNER_ID = "workflow-trigger-runner";

type Db = ReturnType<typeof getDbForUrl>;

let env: TestEnv;
let db: Db;
let now: number;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  now = Number((await db.run(sql`SELECT unixepoch() AS now_seconds`)).rows[0]?.now_seconds ?? 0);
  await db.insert(users).values({ id: OWNER_ID, email: "workflow-triggers@example.test" });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Workflow triggers",
  });
});

afterEach(() => disposeTestEnv(env));

function scheduleWorkflow() {
  return buildWeeklyFunnelReviewWorkflow({
    automation_id: "due_schedule",
    name: "Due schedule",
    runner: { provider: "codex" as const, environment: "production" },
    schedule: {
      cron: "* * * * *",
      timezone: "UTC",
      start_window_seconds: 900,
    },
    funnel: {
      events: ["account_created", "project_created"],
      period_days: 7,
      minimum_sample_size: 1,
    },
    budgets: {
      max_runs_per_day: 4,
      max_turns_per_run: 10,
      max_runtime_seconds: 600,
      max_cost_usd_per_run: 1,
    },
    escalation: { destination: "project owner", instructions: "Preserve evidence and stop." },
  });
}

function caseWorkflow() {
  return buildErrorToDraftPrWorkflow({
    automation_id: "trusted_cases",
    name: "Trusted cases",
    runner: {
      provider: "codex" as const,
      repository_provider: "github" as const,
      repository: "https://github.com/example/app",
      default_branch: "main",
      environment: "production",
    },
    trigger: { max_cases_per_sweep: 2, cooldown_seconds: 900 },
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
      max_turns_per_run: 20,
      max_runtime_seconds: 900,
      max_cost_usd_per_run: 2,
    },
    approval_expires_after_seconds: 3_600,
    deploy_wait_timeout_seconds: 3_600,
    traffic_sample_event: "request_completed",
    verification: {
      observation_window_seconds: 600,
      max_wait_seconds: 7_200,
      min_sample_size: 1,
    },
    escalation: { destination: "project owner", instructions: "Preserve evidence and stop." },
  });
}

async function saveAndActivate(workflow: ReturnType<typeof scheduleWorkflow> | ReturnType<typeof caseWorkflow>) {
  const saved = await saveDisabledAutomationWorkflow(db, {
    project_id: PROJECT_ID,
    actor_user_id: OWNER_ID,
    workflow,
    observed_at: now,
  });
  await insertRunner(workflow.id);
  const descriptor = await loadLiveOrderedFunnelExecutionAuthority();
  if (!descriptor) throw new Error("missing live ordered-funnel execution descriptor");
  const executionAuthorityId = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-test-automation-workflow-trigger-authority-v1",
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
    readinessHash: "e".repeat(64),
    ownerConfirmedCallerAssertionIdsJson: "[]",
    descriptorKind: descriptor.descriptor_kind,
    descriptorJson: descriptor.descriptor_json,
    descriptorHash: descriptor.descriptor_hash,
    runnerCredentialId: RUNNER_ID,
    enabledBy: OWNER_ID,
    enabledAt: now,
  });
  const etag = await automationWorkflowHeadEtag({
    project_id: PROJECT_ID,
    automation_id: workflow.id,
    current_revision_id: saved.workflow.revision_id,
    current_revision: saved.workflow.revision,
    workflow_hash: saved.workflow.workflow_hash,
    compile_hash: saved.workflow.compile_hash,
    enabled: true,
    active_revision_id: saved.workflow.revision_id,
    active_execution_authority_id: executionAuthorityId,
    paused_at: null,
    pause_reason: null,
    updated_at: now,
  });
  await db.update(automationWorkflows).set({
    enabled: 1,
    activeRevisionId: saved.workflow.revision_id,
    activeExecutionAuthorityId: executionAuthorityId,
    pausedAt: null,
    pauseReason: null,
    etag,
    updatedAt: now,
  }).where(and(
    eq(automationWorkflows.projectId, PROJECT_ID),
    eq(automationWorkflows.automationId, workflow.id),
  ));
  return {
    ...saved.workflow,
    execution_authority_id: executionAuthorityId,
    execution_descriptor_hash: descriptor.descriptor_hash,
  };
}

async function insertRunner(automationId: string) {
  await db.insert(projectCredentials).values({
    id: RUNNER_ID,
    projectId: PROJECT_ID,
    kind: "automation_runner",
    name: "Workflow trigger runner",
    prefix: "agentry_runner_workflow_trigger",
    tokenHash: "2".repeat(64),
    automationId,
    createdBy: OWNER_ID,
    createdAt: now,
    expiresAt: now + 86_400,
  });
}

describe("workflow-v3 durable trigger authority", () => {
  it("derives one exact schedule receipt, replays it, and exposes only immutable server facts", async () => {
    const workflow = await saveAndActivate(scheduleWorkflow());

    const first = await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    });
    expect(first).toMatchObject({
      trigger_kind: "schedule",
      issued_count: 1,
      replayed_count: 0,
      receipts: [{
        workflow_revision_id: workflow.revision_id,
        workflow_hash: workflow.workflow_hash,
        compile_hash: workflow.compile_hash,
        trigger_kind: "schedule",
        attempt: 1,
        source_trust: "agentry_system",
        status: "ready",
        consumed_run_id: null,
        trigger_output: { instruction_authority: "none" },
      }],
    });
    const receipt = first.receipts[0]!;
    expect(receipt.receipt_id).toMatch(/^awtr_[A-Za-z0-9-]+$/);
    expect(receipt.trigger_key).toBe(`schedule:${receipt.trigger_output.scheduled_for}`);
    expect(receipt.trigger_output.receipt_id).toBe(receipt.receipt_id);
    expect(receipt.trigger_output.window_start).toBe(receipt.available_at);
    expect(receipt.trigger_output.window_end).toBe(receipt.expires_at);
    expect(await sha256Hex(canonicalJsonStringify(receipt.trigger_output)))
      .toBe(receipt.trigger_output_hash);

    const replay = await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    });
    expect(replay).toMatchObject({ issued_count: 0, replayed_count: 1 });
    expect(replay.receipts).toEqual(first.receipts);
    expect(await readAutomationWorkflowTriggerReceipt(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      receipt_id: receipt.receipt_id,
    })).toEqual(receipt);
    expect(await listAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      status: "ready",
    })).toEqual([receipt]);
  });

  it("consumes only the exact receipt-bound run in one transaction and recovers by consumed_run_id", async () => {
    const workflow = await saveAndActivate(scheduleWorkflow());
    const receipt = (await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    })).receipts[0]!;
    const runId = "awrun_trigger_authority";
    const consumed = await db.transaction(async (tx) => {
      const at = Number((await tx.run(sql`SELECT unixepoch() AS now_seconds`)).rows[0]?.now_seconds ?? 0);
      const lookup = await loadAutomationWorkflowTriggerReceiptForStart(tx, {
        project_id: PROJECT_ID,
        automation_id: workflow.automation_id,
        receipt_id: receipt.receipt_id,
        at,
      });
      expect(lookup.outcome).toBe("ready");
      if (lookup.outcome !== "ready") throw new Error("expected ready receipt");
      const limitsJson = canonicalJsonStringify(workflow.workflow.limits);
      await tx.insert(automationWorkflowRuns).values({
        id: runId,
        projectId: PROJECT_ID,
        automationId: workflow.automation_id,
        workflowRevisionId: lookup.workflow_revision_id,
        workflowHash: lookup.workflow_hash,
        compileHash: lookup.compile_hash,
        executionAuthorityId: lookup.execution_authority_id,
        executionDescriptorHash: workflow.execution_descriptor_hash,
        triggerReceiptId: receipt.receipt_id,
        triggerKind: lookup.trigger_kind,
        triggerKey: lookup.trigger_key,
        triggerPayloadJson: lookup.trigger_output_json,
        triggerPayloadHash: lookup.trigger_output_hash,
        attempt: lookup.attempt,
        idempotencyKeyHash: "3".repeat(64),
        requestHash: "4".repeat(64),
        limitsJson,
        limitsHash: await sha256Hex(limitsJson),
        runnerCredentialId: RUNNER_ID,
        createdAt: at,
        updatedAt: at,
      });
      return consumeAutomationWorkflowTriggerReceiptForRun(tx, {
        project_id: PROJECT_ID,
        automation_id: workflow.automation_id,
        receipt_id: receipt.receipt_id,
        run_id: runId,
        at,
      });
    });
    expect(consumed).toMatchObject({
      consumed_run_id: runId,
      idempotent_replay: false,
      receipt: { status: "consumed", consumed_run_id: runId },
    });
    const lookup = await db.transaction(async (tx) => loadAutomationWorkflowTriggerReceiptForStart(tx, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      receipt_id: receipt.receipt_id,
      at: now,
    }));
    expect(lookup).toMatchObject({ outcome: "consumed", consumed_run_id: runId });
    await expect(db.insert(automationWorkflowRuns).values({
      id: "awrun_wrong_receipt_reuse",
      projectId: PROJECT_ID,
      automationId: workflow.automation_id,
      workflowRevisionId: workflow.revision_id,
      workflowHash: workflow.workflow_hash,
      compileHash: workflow.compile_hash,
      executionAuthorityId: workflow.execution_authority_id,
      executionDescriptorHash: workflow.execution_descriptor_hash,
      triggerReceiptId: receipt.receipt_id,
      triggerKind: "schedule",
      triggerKey: receipt.trigger_key,
      triggerPayloadJson: canonicalJsonStringify(receipt.trigger_output),
      triggerPayloadHash: receipt.trigger_output_hash,
      attempt: receipt.attempt,
      idempotencyKeyHash: "5".repeat(64),
      requestHash: "6".repeat(64),
      limitsJson: canonicalJsonStringify(workflow.workflow.limits),
      limitsHash: await sha256Hex(canonicalJsonStringify(workflow.workflow.limits)),
      runnerCredentialId: RUNNER_ID,
      createdAt: now,
      updatedAt: now,
    })).rejects.toThrow();
  });

  it("derives case identity, revision, and evidence hash only from active OAuth-backed rows", async () => {
    const workflow = await saveAndActivate(caseWorkflow());
    await db.insert(posthogConnections).values({
      id: "phconn-workflow-trigger",
      projectId: PROJECT_ID,
      authorizedByUserId: OWNER_ID,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: now + 86_400,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org-workflow-trigger",
      posthogEnvironmentId: 42,
      authorizedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(cases).values([
      {
        id: "case-trusted",
        projectId: PROJECT_ID,
        providerIssueId: "case-trusted",
        providerSnapshotHash: "a".repeat(64),
        providerProjectedAt: now,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "trusted-fingerprint",
        errorType: "TypeError",
        message: "Trusted failure",
        status: "active" as const,
        eventCount: 3,
        firstSeenAt: now - 60,
        lastSeenAt: now,
        lastDeploySha: "abcdef1",
        lastTrustLevel: "customer_posthog",
        lastCredentialKind: "posthog_oauth",
        revision: 2,
      },
      {
        id: "case-browser",
        projectId: PROJECT_ID,
        providerIssueId: "case-browser",
        providerSnapshotHash: "b".repeat(64),
        providerProjectedAt: now,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "browser-fingerprint",
        errorType: "Error",
        message: "Resolved failure",
        status: "resolved" as const,
        eventCount: 2,
        firstSeenAt: now - 30,
        lastSeenAt: now,
        lastTrustLevel: "customer_posthog",
        lastCredentialKind: "posthog_oauth",
        revision: 1,
      },
      {
        id: "case-onboarding-proof",
        projectId: PROJECT_ID,
        providerIssueId: "case-onboarding-proof",
        providerSnapshotHash: "c".repeat(64),
        providerProjectedAt: now,
        providerEventClassification: "onboarding_proof_exception" as const,
        fingerprint: "onboarding-proof-fingerprint",
        errorType: "ExpectedProofError",
        message: "Safe onboarding proof",
        status: "active" as const,
        eventCount: 1,
        firstSeenAt: now - 10,
        lastSeenAt: now,
        lastTrustLevel: "customer_posthog",
        lastCredentialKind: "posthog_oauth",
        revision: 1,
      },
    ]);

    const result = await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    });
    expect(result).toMatchObject({
      trigger_kind: "case",
      issued_count: 1,
      replayed_count: 0,
      receipts: [{
        trigger_key: "case:case-trusted:2",
        source_trust: "customer_posthog",
        trigger_output: {
          case_id: "case-trusted",
          case_revision: 2,
          source_trust: "customer_posthog",
          instruction_authority: "none",
        },
      }],
    });
    expect(result.receipts[0]!.trigger_output.snapshot_hash).toMatch(/^[a-f0-9]{64}$/);
    const replay = await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    });
    expect(replay).toMatchObject({ issued_count: 0, replayed_count: 1 });
    expect(replay.receipts).toEqual(result.receipts);

    await db.update(cases).set({
      providerEventClassification: "onboarding_proof_exception",
      revision: 3,
    }).where(eq(cases.id, "case-trusted"));
    await expect(db.transaction(async (tx) =>
      loadAutomationWorkflowTriggerReceiptForStart(tx, {
        project_id: PROJECT_ID,
        automation_id: workflow.automation_id,
        receipt_id: result.receipts[0]!.receipt_id,
        at: now,
      })
    )).rejects.toMatchObject({
      code: "automation_workflow_case_trigger_source_changed",
    });
  });

  it("materializes expiry and rejects identity mutation or unfenced deletion", async () => {
    const workflow = await saveAndActivate(scheduleWorkflow());
    const issued = await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    });
    const live = await db.select().from(automationWorkflowTriggerReceipts).where(
      eq(automationWorkflowTriggerReceipts.id, issued.receipts[0]!.receipt_id),
    ).limit(1);
    const base = live[0]!;
    const expiredId = "awtr_expiry_fixture";
    const scheduledFor = now - 123;
    const payloadJson = canonicalJsonStringify({
      receipt_id: expiredId,
      scheduled_for: scheduledFor,
      window_start: scheduledFor,
      window_end: now,
      instruction_authority: "none",
    });
    await db.insert(automationWorkflowTriggerReceipts).values({
      ...base,
      id: expiredId,
      triggerKey: `schedule:${scheduledFor}`,
      payloadJson,
      payloadHash: await sha256Hex(payloadJson),
      issuedAt: now,
      availableAt: scheduledFor,
      expiresAt: now,
      updatedAt: now,
    });
    const expiry = await expireAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    });
    expect(expiry.expired_count).toBe(1);
    expect(expiry.expired_at).toBeGreaterThanOrEqual(now);
    expect(expiry.expired_at).toBeLessThanOrEqual(now + 1);
    expect(await readAutomationWorkflowTriggerReceipt(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      receipt_id: expiredId,
    })).toMatchObject({ status: "expired" });
    await expect(db.update(automationWorkflowTriggerReceipts).set({
      payloadHash: "f".repeat(64),
    }).where(eq(automationWorkflowTriggerReceipts.id, base.id))).rejects.toThrow();
    await expect(db.delete(automationWorkflowTriggerReceipts).where(
      eq(automationWorkflowTriggerReceipts.id, base.id),
    )).rejects.toThrow();
  });

  it("atomically cancels ready receipts when the workflow kill switch closes authority", async () => {
    const workflow = await saveAndActivate(scheduleWorkflow());
    const receipt = (await issueAutomationWorkflowTriggerReceipts(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      observed_at: now,
    })).receipts[0]!;

    await pauseAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      actor_user_id: OWNER_ID,
      reason: "operator safety stop",
      observed_at: now,
    });
    const cancelled = await readAutomationWorkflowTriggerReceipt(db, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      receipt_id: receipt.receipt_id,
    });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancel_reason: "workflow_authority_changed",
      consumed_run_id: null,
    });
    await expect(db.transaction(async (tx) => loadAutomationWorkflowTriggerReceiptForStart(tx, {
      project_id: PROJECT_ID,
      automation_id: workflow.automation_id,
      receipt_id: receipt.receipt_id,
      at: now,
    }))).rejects.toMatchObject({
      code: "automation_workflow_trigger_receipt_cancelled",
    });
  });
});
