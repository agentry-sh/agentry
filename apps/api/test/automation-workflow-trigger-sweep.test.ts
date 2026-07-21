import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  automationSchedulerCursors,
  automationWorkflowExecutionAuthorities,
  automationWorkflowEffects,
  automationWorkflowRuns,
  automationWorkflowTriggerReceipts,
  automationWorkflows,
  projectDeletionFences,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import { canonicalJsonStringify, sha256Hex } from "@agentrysh/shared";
import { loadLiveOrderedFunnelExecutionAuthority } from "../src/automation-workflow-execution-authority.js";
import { automationWorkflowHeadEtag } from "../src/automation-workflow-identities.js";
import {
  pauseAutomationWorkflowProject,
} from "../src/automation-workflow-controls.js";
import { buildWeeklyFunnelReviewWorkflow } from "../src/automation-workflow-presets.js";
import { saveDisabledAutomationWorkflow } from "../src/automation-workflow-store.js";

const triggerAuthorityMock = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock("../src/automation-workflow-triggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/automation-workflow-triggers.js")>();
  return {
    ...actual,
    issueAutomationWorkflowTriggerReceipts: triggerAuthorityMock.issue,
  };
});

import { sweepAutomationWorkflowTriggerEligibility } from "../src/automation-workflow-trigger-sweep.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "workflow-trigger-sweep-owner";
const originalTriggerAuthority = await vi.importActual<
  typeof import("../src/automation-workflow-triggers.js")
>("../src/automation-workflow-triggers.js");

type Db = ReturnType<typeof getDbForUrl>;
type TriggerIssue = typeof originalTriggerAuthority.issueAutomationWorkflowTriggerReceipts;

let env: TestEnv;
let db: Db;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(users).values({
    id: OWNER_ID,
    email: "workflow-trigger-sweep@example.test",
  });
  triggerAuthorityMock.issue.mockReset();
  triggerAuthorityMock.issue.mockImplementation((...args: Parameters<TriggerIssue>) => (
    originalTriggerAuthority.issueAutomationWorkflowTriggerReceipts(...args)
  ));
});

afterEach(() => disposeTestEnv(env));

async function databaseNow(): Promise<number> {
  return Number((await db.run(sql`SELECT unixepoch() AS now_seconds`)).rows[0]?.now_seconds ?? 0);
}

async function createProject(projectId: string): Promise<void> {
  await db.insert(projects).values({
    id: projectId,
    userId: OWNER_ID,
    name: projectId,
  });
}

function scheduleWorkflow(automationId: string) {
  return buildWeeklyFunnelReviewWorkflow({
    automation_id: automationId,
    name: automationId,
    runner: { provider: "codex" as const, environment: "production" },
    schedule: {
      cron: "* * * * *",
      timezone: "UTC",
      start_window_seconds: 900,
    },
    funnel: {
      events: ["account_created", "first_value_reached"],
      period_days: 7,
      minimum_sample_size: 1,
    },
    budgets: {
      max_runs_per_day: 4,
      max_turns_per_run: 10,
      max_runtime_seconds: 600,
      max_cost_usd_per_run: 1,
    },
    escalation: {
      destination: "project owner",
      instructions: "Preserve exact evidence and stop.",
    },
  });
}

async function saveWorkflow(
  projectId: string,
  automationId: string,
  enabled = true,
) {
  const now = await databaseNow();
  const saved = await saveDisabledAutomationWorkflow(db, {
    project_id: projectId,
    actor_user_id: OWNER_ID,
    workflow: scheduleWorkflow(automationId),
    observed_at: now,
  });
  if (!enabled) return saved.workflow;
  const runnerCredentialId = `runner_${(await sha256Hex(`${projectId}:${automationId}`)).slice(0, 32)}`;
  await db.insert(projectCredentials).values({
    id: runnerCredentialId,
    projectId,
    kind: "automation_runner",
    name: `${automationId} sweep runner`,
    prefix: `agentry_runner_${automationId}`,
    tokenHash: await sha256Hex(`runner-token:${projectId}:${automationId}`),
    automationId,
    createdBy: OWNER_ID,
    createdAt: now,
    expiresAt: now + 86_400,
  });
  const descriptor = await loadLiveOrderedFunnelExecutionAuthority();
  if (!descriptor) throw new Error("missing live ordered-funnel execution descriptor");
  const executionAuthorityId = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-test-automation-workflow-sweep-authority-v1",
    project_id: projectId,
    automation_id: automationId,
    workflow_revision_id: saved.workflow.revision_id,
    workflow_hash: saved.workflow.workflow_hash,
    compile_hash: saved.workflow.compile_hash,
    descriptor_hash: descriptor.descriptor_hash,
    runner_credential_id: runnerCredentialId,
  }));
  await db.insert(automationWorkflowExecutionAuthorities).values({
    id: executionAuthorityId,
    projectId,
    automationId,
    workflowRevisionId: saved.workflow.revision_id,
    workflowHash: saved.workflow.workflow_hash,
    compileHash: saved.workflow.compile_hash,
    readinessHash: "e".repeat(64),
    ownerConfirmedCallerAssertionIdsJson: "[]",
    descriptorKind: descriptor.descriptor_kind,
    descriptorJson: descriptor.descriptor_json,
    descriptorHash: descriptor.descriptor_hash,
    runnerCredentialId,
    enabledBy: OWNER_ID,
    enabledAt: now,
  });
  const etag = await automationWorkflowHeadEtag({
    project_id: projectId,
    automation_id: automationId,
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
    etag,
    pausedAt: null,
    pauseReason: null,
    updatedAt: now,
  }).where(and(
    eq(automationWorkflows.projectId, projectId),
    eq(automationWorkflows.automationId, automationId),
  ));
  return saved.workflow;
}

describe("workflow-v3 trigger eligibility sweep", () => {
  it("enumerates only exact enabled workflows with open project authority", async () => {
    await createProject("sweep-a-open");
    await createProject("sweep-b-disabled");
    await createProject("sweep-c-project-paused");
    await createProject("sweep-d-deletion-fenced");
    await saveWorkflow("sweep-a-open", "due_open");
    await saveWorkflow("sweep-b-disabled", "disabled", false);
    await saveWorkflow("sweep-c-project-paused", "project_paused");
    await pauseAutomationWorkflowProject(db, {
      project_id: "sweep-c-project-paused",
      actor_user_id: OWNER_ID,
      reason: "emergency stop",
    });
    await saveWorkflow("sweep-d-deletion-fenced", "deletion_fenced");
    await db.insert(projectDeletionFences).values({
      projectId: "sweep-d-deletion-fenced",
      commandId: "delete-command",
      reason: "project_delete",
      actor: OWNER_ID,
      createdAt: await databaseNow(),
    });

    const swept = await sweepAutomationWorkflowTriggerEligibility(env, {
      workflow_limit: 20,
    });

    expect(swept).toMatchObject({
      kind: "automation_workflow_trigger_sweep",
      schema_version: "1",
      projects: 1,
      workflows: 1,
      issued: 1,
      replayed: 0,
      error_count: 0,
      rotation_completed: true,
    });
    expect(triggerAuthorityMock.issue).toHaveBeenCalledTimes(1);
    expect(triggerAuthorityMock.issue.mock.calls[0]?.[1]).toEqual({
      project_id: "sweep-a-open",
      automation_id: "due_open",
    });
    expect(await db.select({
      projectId: automationWorkflowTriggerReceipts.projectId,
      automationId: automationWorkflowTriggerReceipts.automationId,
    }).from(automationWorkflowTriggerReceipts)).toEqual([{
      projectId: "sweep-a-open",
      automationId: "due_open",
    }]);
  });

  it("isolates one workflow failure, redacts its evidence, and never creates runs or effects", async () => {
    await createProject("sweep-isolation");
    await saveWorkflow("sweep-isolation", "a_fails");
    await saveWorkflow("sweep-isolation", "b_succeeds");
    triggerAuthorityMock.issue.mockImplementation((...args: Parameters<TriggerIssue>) => {
      const input = args[1];
      if (input.automation_id === "a_fails") {
        throw new Error("Bearer agentry_runner_do-not-record failed\nparams: secret=do-not-record");
      }
      return originalTriggerAuthority.issueAutomationWorkflowTriggerReceipts(...args);
    });

    const swept = await sweepAutomationWorkflowTriggerEligibility(env, {
      workflow_limit: 20,
    });

    expect(swept).toMatchObject({
      workflows: 2,
      issued: 1,
      error_count: 1,
      errors_truncated: false,
      errors: [{
        project_id: "sweep-isolation",
        automation_id: "a_fails",
        message: "Bearer [REDACTED] failed",
      }],
    });
    expect(triggerAuthorityMock.issue.mock.calls.map((call) => call[1].automation_id))
      .toEqual(["a_fails", "b_succeeds"]);
    expect(await db.select().from(automationWorkflowRuns)).toHaveLength(0);
    expect(await db.select().from(automationWorkflowEffects)).toHaveLength(0);
    expect(await db.select().from(automationWorkflowTriggerReceipts)).toHaveLength(1);
    expect(swept.next_action).toContain("no run or external effect was started");
  });

  it("resumes a bounded composite cursor and rotates without starving later workflows", async () => {
    await createProject("sweep-cursor");
    await saveWorkflow("sweep-cursor", "a_first");
    await saveWorkflow("sweep-cursor", "b_second");
    await saveWorkflow("sweep-cursor", "c_third");

    const first = await sweepAutomationWorkflowTriggerEligibility(env, { workflow_limit: 1 });
    const second = await sweepAutomationWorkflowTriggerEligibility(env, { workflow_limit: 1 });
    const third = await sweepAutomationWorkflowTriggerEligibility(env, { workflow_limit: 1 });

    expect([first.workflows, second.workflows, third.workflows]).toEqual([1, 1, 1]);
    expect([first.rotation_completed, second.rotation_completed, third.rotation_completed])
      .toEqual([false, false, true]);
    expect(triggerAuthorityMock.issue.mock.calls.map((call) => call[1].automation_id))
      .toEqual(["a_first", "b_second", "c_third"]);
    const cursor = (
      await db.select().from(automationSchedulerCursors).where(
        eq(automationSchedulerCursors.sweepName, "workflow_v3_trigger_receipts"),
      ).limit(1)
    )[0]!;
    expect(cursor).toMatchObject({ cursorProjectId: null, revision: 3 });

    triggerAuthorityMock.issue.mockClear();
    const nextRotation = await sweepAutomationWorkflowTriggerEligibility(env, {
      workflow_limit: 1,
    });
    expect(nextRotation.rotation_completed).toBe(false);
    expect(triggerAuthorityMock.issue.mock.calls.map((call) => call[1].automation_id))
      .toEqual(["a_first"]);
    expect(await db.select({
      automationId: automationWorkflowTriggerReceipts.automationId,
    }).from(automationWorkflowTriggerReceipts).orderBy(
      asc(automationWorkflowTriggerReceipts.automationId),
    )).toEqual([
      { automationId: "a_first" },
      { automationId: "b_second" },
      { automationId: "c_third" },
    ]);
  });

  it("repairs a malformed non-authorizing continuation and safely re-evaluates from the start", async () => {
    await createProject("sweep-cursor-recovery");
    await saveWorkflow("sweep-cursor-recovery", "recoverable");
    await db.insert(automationSchedulerCursors).values({
      sweepName: "workflow_v3_trigger_receipts",
      cursorProjectId: "not-json",
      revision: 7,
      updatedAt: await databaseNow(),
    });

    const swept = await sweepAutomationWorkflowTriggerEligibility(env, {
      workflow_limit: 1,
    });

    expect(swept).toMatchObject({
      workflows: 1,
      issued: 1,
      rotation_completed: true,
      error_count: 0,
    });
    expect(triggerAuthorityMock.issue.mock.calls[0]?.[1]).toEqual({
      project_id: "sweep-cursor-recovery",
      automation_id: "recoverable",
    });
    const cursor = (
      await db.select().from(automationSchedulerCursors).where(
        eq(automationSchedulerCursors.sweepName, "workflow_v3_trigger_receipts"),
      ).limit(1)
    )[0]!;
    expect(cursor).toMatchObject({ cursorProjectId: null, revision: 9 });
  });
});
