import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  automationWorkflowRevisions,
  automationWorkflows,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import { canonicalJsonStringify, sha256Hex } from "@agentrysh/shared";
import { automationWorkflowHeadEtag } from "../src/automation-workflow-identities.js";
import {
  assertLiveOrderedFunnelExecutionAuthority,
  loadLiveOrderedFunnelExecutionAuthority,
} from "../src/automation-workflow-execution-authority.js";
import {
  buildErrorToDraftPrWorkflow,
  buildWeeklyFunnelReviewWorkflow,
} from "../src/automation-workflow-presets.js";
import { readAutomationWorkflowReadiness } from "../src/automation-workflow-readiness.js";
import { saveDisabledAutomationWorkflow } from "../src/automation-workflow-store.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";
import { seedVerifiedOnboardingReadiness } from "./onboarding-readiness-fixture.js";

const OWNER_ID = "workflow-readiness-owner";
const PROJECT_ID = "workflow-readiness-project";

type Db = ReturnType<typeof getDbForUrl>;
let env: TestEnv;
let db: Db;
let now: number;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  now = Number(clock.rows[0]?.now_seconds ?? 0);
  await db.insert(users).values({
    id: OWNER_ID,
    email: "workflow-readiness@example.test",
  });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Workflow readiness",
  });
});

afterEach(() => disposeTestEnv(env));

const events = [
  "account_created",
  "project_created",
  "subscription_started",
  "first_value_reached",
];

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
      events,
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

async function insertRunner(id: string, automationId = "weekly_funnel_review") {
  await db.insert(projectCredentials).values({
    id,
    projectId: PROJECT_ID,
    kind: "automation_runner",
    name: id,
    prefix: `agentry_runner_${id}`,
    tokenHash: await sha256Hex(`runner-token:${id}`),
    automationId,
    createdBy: OWNER_ID,
    createdAt: now,
    expiresAt: now + 86_400,
  });
}

function checksById(readiness: Awaited<ReturnType<typeof readAutomationWorkflowReadiness>>) {
  return Object.fromEntries(readiness.checks.map((check) => [check.id, check]));
}

describe("automation workflow v3 readiness", () => {
  it("freezes the exact query builder and materializer contract and fails closed on drift", async () => {
    const live = await loadLiveOrderedFunnelExecutionAuthority();
    expect(live).not.toBeNull();
    expect(live).toMatchObject({
      descriptor_kind: "ordered_funnel_period_compare",
      descriptor: {
        schema_version: "1",
        kind: "ordered_funnel_period_compare",
        execution_semantics_version: 1,
        query_builder_execution_version: 1,
        materializer_execution_version: 1,
        prepared_query_probes: [
          { ordered_event_count: 2, query_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
          { ordered_event_count: 20, query_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        ],
      },
      descriptor_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(live!.descriptor.materializer_semantics_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(live!.descriptor.prepared_query_probes[0]?.query_hash)
      .not.toBe(live!.descriptor.prepared_query_probes[1]?.query_hash);
    expect(live!.descriptor_json).toBe(canonicalJsonStringify(live!.descriptor));
    expect(await sha256Hex(live!.descriptor_json)).toBe(live!.descriptor_hash);

    await expect(assertLiveOrderedFunnelExecutionAuthority({
      authority_id: "authority-reviewed",
      expected_descriptor_json: live!.descriptor_json,
      expected_descriptor_hash: live!.descriptor_hash,
    })).resolves.toEqual(live);
    await expect(assertLiveOrderedFunnelExecutionAuthority({
      authority_id: "authority-reviewed",
      expected_descriptor_json: live!.descriptor_json,
      expected_descriptor_hash: "f".repeat(64),
    })).rejects.toMatchObject({
      status: 409,
      code: "automation_workflow_execution_descriptor_drift",
      details: { retryable: false },
    });
  });

  it("returns exact revision-bound blockers before authority is complete", async () => {
    const saved = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: now,
    });

    const readiness = await readAutomationWorkflowReadiness(db, {
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      expected_revision_id: saved.workflow.revision_id,
      expected_etag: saved.workflow.etag,
      observed_at: now,
    });
    const checks = checksById(readiness);

    expect(readiness).toMatchObject({
      kind: "automation_workflow_readiness",
      schema_version: "3",
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      revision_id: saved.workflow.revision_id,
      revision: 1,
      etag: saved.workflow.etag,
      workflow_hash: saved.workflow.workflow_hash,
      compile_hash: saved.workflow.compile_hash,
      status: "blocked",
      owner_confirmed_caller_assertion_ids: [],
    });
    expect(readiness.readiness_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(checks.workflow_runtime_adapter_available).toMatchObject({
      status: "ready",
      blocker: null,
    });
    expect(checks.ordered_funnel_blueprint_available).toMatchObject({
      status: "ready",
      blocker: null,
    });
    const liveAuthority = await loadLiveOrderedFunnelExecutionAuthority();
    expect(checks.ordered_funnel_blueprint_available?.evidence_ids).toEqual([
      `query_blueprint:ordered_funnel_period_compare:${liveAuthority?.descriptor_hash}`,
    ]);
    expect(checks.runner_credential_bound?.blocker?.code)
      .toBe("automation_workflow_runner_credential_missing");
    expect(checks.scheduler_execution_configured?.blocker?.code)
      .toBe("automation_workflow_caller_assertion_required");
    expect(checks.signal_map_saved?.blocker?.code)
      .toBe("automation_workflow_verified_signal_map_missing");
    expect(readiness.blockers.map((blocker) => blocker.check_id)).toEqual(
      expect.arrayContaining([
        "runner_credential_bound",
        "scheduler_execution_configured",
        "signal_map_saved",
      ]),
    );

    await expect(readAutomationWorkflowReadiness(db, {
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      expected_etag: `"${"f".repeat(64)}"`,
    })).rejects.toMatchObject({ status: 412, code: "precondition_failed" });

    await expect(readAutomationWorkflowReadiness(db, {
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      owner_confirmed_caller_assertion_ids: ["not_a_requirement"],
    })).rejects.toMatchObject({
      status: 422,
      code: "automation_workflow_caller_assertion_unknown",
    });
  });

  it("becomes ready only with one exact runner, verified signals, and the exact owner assertion", async () => {
    const saved = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: now,
    });
    await seedVerifiedOnboardingReadiness({
      db,
      project_id: PROJECT_ID,
      approved_events: events,
      approved_plan_hash: "workflow-readiness-plan",
    });
    await insertRunner("runner-one");

    const input = {
      project_id: PROJECT_ID,
      automation_id: "weekly_funnel_review",
      expected_revision_id: saved.workflow.revision_id,
      expected_etag: saved.workflow.etag,
      owner_confirmed_caller_assertion_ids: ["scheduler_execution_configured"],
    };
    const first = await readAutomationWorkflowReadiness(db, input);
    const second = await readAutomationWorkflowReadiness(db, {
      ...input,
      owner_confirmed_caller_assertion_ids: [
        "scheduler_execution_configured",
        "scheduler_execution_configured",
      ],
    });

    expect(first.status).toBe("ready");
    expect(first.blockers).toEqual([]);
    expect(first.checks.every((check) => check.status === "ready")).toBe(true);
    expect(first.owner_confirmed_caller_assertion_ids).toEqual([
      "scheduler_execution_configured",
    ]);
    expect(first.readiness_hash).toBe(second.readiness_hash);
    expect(checksById(first).runner_credential_bound?.evidence_ids)
      .toEqual([expect.stringContaining("credential:automation_runner:runner-one:")]);
    expect(first.next_action).toContain("same explicit caller assertion ids");

    await insertRunner("runner-two");
    const ambiguous = await readAutomationWorkflowReadiness(db, input);
    expect(ambiguous.status).toBe("blocked");
    expect(checksById(ambiguous).runner_credential_bound).toMatchObject({
      status: "blocked",
      blocker: { code: "automation_workflow_runner_credential_ambiguous" },
    });
    expect(ambiguous.readiness_hash).not.toBe(first.readiness_hash);
  });

  it("keeps every non-scheduled-funnel component set blocked even when adapters exist", async () => {
    await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: errorWorkflow(),
      observed_at: now,
    });

    const readiness = await readAutomationWorkflowReadiness(db, {
      project_id: PROJECT_ID,
      automation_id: "repair_production_case",
    });
    expect(checksById(readiness).workflow_runtime_adapter_available).toMatchObject({
      status: "blocked",
      blocker: { code: "automation_workflow_component_set_not_enabled" },
    });
    expect(checksById(readiness).workflow_runtime_adapter_available?.blocker?.message)
      .toContain("effect.github.draft-pr@1.0.0");
  });

  it("fails closed when a future persisted compilation adds an unknown requirement", async () => {
    const saved = await saveDisabledAutomationWorkflow(db, {
      project_id: PROJECT_ID,
      actor_user_id: OWNER_ID,
      workflow: weeklyWorkflow(),
      observed_at: now,
    });
    const original = (
      await db.select().from(automationWorkflowRevisions).where(
        eq(automationWorkflowRevisions.id, saved.workflow.revision_id),
      ).limit(1)
    )[0]!;
    const compiled = JSON.parse(original.compiledJson) as Record<string, unknown> & {
      requirements: Array<Record<string, unknown>>;
    };
    compiled.requirements.push({
      id: "future_authority_gate",
      kind: "runtime",
      requirement: "A future runtime authority gate is satisfied.",
      next_action: "Install the future reviewed evaluator.",
      required_by_node_ids: ["$workflow"],
    });
    compiled.requirements.sort((left, right) => String(left.id).localeCompare(String(right.id)));
    delete compiled.compile_hash;
    const compileHash = await sha256Hex(canonicalJsonStringify(compiled));
    compiled.compile_hash = compileHash;
    const revisionId = "awfr_future_readiness_requirement";
    await db.insert(automationWorkflowRevisions).values({
      ...original,
      id: revisionId,
      revision: 2,
      compiledJson: canonicalJsonStringify(compiled),
      compileHash,
      createdAt: now + 1,
    });
    const etag = await automationWorkflowHeadEtag({
      project_id: PROJECT_ID,
      automation_id: saved.workflow.automation_id,
      current_revision_id: revisionId,
      current_revision: 2,
      workflow_hash: saved.workflow.workflow_hash,
      compile_hash: compileHash,
      enabled: false,
      active_revision_id: null,
      paused_at: null,
      pause_reason: null,
      updated_at: now + 1,
    });
    await db.update(automationWorkflows).set({
      currentRevisionId: revisionId,
      currentRevision: 2,
      etag,
      updatedAt: now + 1,
    }).where(and(
      eq(automationWorkflows.projectId, PROJECT_ID),
      eq(automationWorkflows.automationId, saved.workflow.automation_id),
    ));

    const readiness = await readAutomationWorkflowReadiness(db, {
      project_id: PROJECT_ID,
      automation_id: saved.workflow.automation_id,
    });
    expect(readiness.revision_id).toBe(revisionId);
    expect(checksById(readiness).future_authority_gate).toMatchObject({
      status: "blocked",
      blocker: { code: "automation_workflow_requirement_not_supported" },
    });
  });
});
