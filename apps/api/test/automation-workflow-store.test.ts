import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  automationContracts,
  automationWorkflowRevisions,
  automationWorkflows,
  projectDeletionFences,
  projects,
  users,
} from "@agentry/db/schema";
import { AutomationContractSchema } from "@agentrysh/shared";
import { deleteAutomationWorkflowStateForProjects } from "../src/automation-deletion-boundary.js";
import {
  loadAutomationWorkflow,
  saveDisabledAutomationWorkflow,
} from "../src/automation-workflow-store.js";
import { buildWeeklyFunnelReviewWorkflow } from "../src/automation-workflow-presets.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "workflow-store-owner";
const PROJECT_ID = "workflow-store-project";
const BASE = 1_900_000_000;

type Db = ReturnType<typeof getDbForUrl>;
let env: TestEnv;
let db: Db;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(users).values({ id: OWNER_ID, email: "workflow-store@example.test" });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Workflow store",
  });
});

afterEach(() => disposeTestEnv(env));

function weeklyWorkflow() {
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
      max_runs_per_day: 2,
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

function legacyWeeklyContract() {
  return AutomationContractSchema.parse({
    schema_version: "2",
    revision: 1,
    enabled: true,
    summary: "Legacy weekly report with the same project-wide automation id.",
    automations: [{
      id: "weekly_funnel_review",
      name: "Legacy weekly funnel review",
      enabled: true,
      runner: {
        provider: "codex",
        repository: "https://github.com/example/app",
        default_branch: "main",
        mode: "draft_only",
      },
      trigger: {
        kind: "schedule",
        cron: "0 9 * * 1",
        timezone: "Europe/Helsinki",
        report_kind: "funnel_review",
        start_window_seconds: 900,
      },
      report_plan: {
        blueprint_id: "ordered_funnel_period_compare",
        params: {
          scheduled_for: { source: "schedule", field: "scheduled_for" },
          period_days: 7,
          funnel_events_json:
            "[\"account_created\",\"project_created\",\"subscription_started\",\"first_value_reached\"]",
          minimum_sample_size: 25,
        },
        period: { lookback_seconds: 604_800 },
      },
      allowed_actions: ["record_report"],
      scope: {},
      escalation: {
        destination: "project owner",
        instructions: "Review the bounded report and decide what to change.",
      },
    }],
  });
}

describe("automation workflow v3 store", () => {
  it("creates a canonical disabled immutable revision and loads the same artifact", async () => {
    const saved = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE,
    });

    expect(saved.created).toBe(true);
    expect(saved.workflow).toMatchObject({
      kind: "automation_workflow",
      schema_version: "3",
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      revision: 1,
      enabled: false,
      active_revision_id: null,
      updated_at: BASE,
    });
    expect(saved.workflow.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(saved.workflow.workflow_hash).toHaveLength(64);
    expect(saved.workflow.compile_hash).toHaveLength(64);
    expect(Object.keys(saved.workflow.component_hashes)).toHaveLength(4);

    const loaded = await loadAutomationWorkflow(db, PROJECT_ID, "weekly_funnel_review");
    expect(loaded).toEqual(saved.workflow);

    const revisions = await db.select().from(automationWorkflowRevisions);
    const heads = await db.select().from(automationWorkflows);
    expect(revisions).toHaveLength(1);
    expect(heads).toHaveLength(1);
    await expect(db.update(automationWorkflowRevisions).set({
      workflowHash: "b".repeat(64),
    })).rejects.toThrow();
  });

  it("requires exact replacement ETags, preserves history, and disables every replacement", async () => {
    const first = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE,
    });

    await expect(saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE + 1,
    })).rejects.toMatchObject({ status: 428, code: "precondition_required" });

    await expect(saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      expected_etag: `"${"f".repeat(64)}"`,
      observed_at: BASE + 1,
    })).rejects.toMatchObject({ status: 412, code: "precondition_failed" });

    const replacement = weeklyWorkflow();
    replacement.name = "Weekly activation funnel review v2";
    const second = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: replacement,
      expected_etag: first.workflow.etag,
      observed_at: BASE + 2,
    });

    expect(second.created).toBe(false);
    expect(second.workflow.revision).toBe(2);
    expect(second.workflow.revision_id).not.toBe(first.workflow.revision_id);
    expect(second.workflow.etag).not.toBe(first.workflow.etag);
    expect(second.workflow.enabled).toBe(false);
    expect(second.workflow.active_revision_id).toBeNull();
    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(2);
  });

  it("creates a new explicit revision even when content is identical", async () => {
    const first = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE,
    });
    const second = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      expected_etag: first.workflow.etag,
      observed_at: BASE + 1,
    });

    expect(second.workflow.revision).toBe(2);
    expect(second.workflow.workflow_hash).toBe(first.workflow.workflow_hash);
    expect(second.workflow.compile_hash).toBe(first.workflow.compile_hash);
    expect(second.workflow.etag).not.toBe(first.workflow.etag);
  });

  it("rejects compile failures and secret-like workflow text without writing", async () => {
    const invalid = weeklyWorkflow();
    invalid.entry = "missing_trigger";
    await expect(saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: invalid,
      observed_at: BASE,
    })).rejects.toMatchObject({ status: 422, code: "automation_workflow_compile_failed" });

    const secret = weeklyWorkflow();
    secret.description = "Never persist agentry_sk_1234567890 in a workflow.";
    await expect(saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: secret,
      observed_at: BASE,
    })).rejects.toMatchObject({ status: 400, code: "automation_workflow_contains_secret" });

    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(0);
    expect(await db.select().from(automationWorkflows)).toHaveLength(0);
  });

  it("reserves one project-wide automation id across v2 and workflow v3", async () => {
    const legacy = legacyWeeklyContract();
    await db.insert(automationContracts).values({
      projectId: PROJECT_ID,
      schemaVersion: legacy.schema_version,
      revision: legacy.revision,
      enabled: 1,
      etag: '"legacy-v2-etag"',
      documentJson: JSON.stringify(legacy),
      createdBy: OWNER_ID,
      updatedBy: OWNER_ID,
      createdAt: BASE,
      updatedAt: BASE,
    });

    await expect(saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE + 1,
    })).rejects.toMatchObject({
      status: 409,
      code: "automation_id_namespace_conflict",
    });
    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(0);
    expect(await db.select().from(automationWorkflows)).toHaveLength(0);
  });

  it("cannot create a revision after the project deletion fence closes", async () => {
    await db.insert(projectDeletionFences).values({
      projectId: PROJECT_ID,
      commandId: "delete-workflow-store-project",
      reason: "project_delete",
      actor: OWNER_ID,
      createdAt: BASE,
    });

    await expect(saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE + 1,
    })).rejects.toMatchObject({ status: 409, code: "project_deletion_in_progress" });
    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(0);
    expect(await db.select().from(automationWorkflows)).toHaveLength(0);
  });

  it("deletes disabled workflow-v3 metadata only while the project fence is held", async () => {
    await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: BASE,
    });
    await db.insert(projectDeletionFences).values({
      projectId: PROJECT_ID,
      commandId: "delete-disabled-workflow-project",
      reason: "project_delete",
      actor: OWNER_ID,
      createdAt: BASE + 1,
    });

    await deleteAutomationWorkflowStateForProjects(db, [PROJECT_ID]);
    expect(await db.select().from(automationWorkflowRevisions)).toHaveLength(0);
    expect(await db.select().from(automationWorkflows)).toHaveLength(0);
  });

});
