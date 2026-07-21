import { describe, expect, it } from "vitest";
import { canonicalJsonStringify, sha256Hex } from "@agentrysh/shared";
import { compileAutomationWorkflow } from "../src/automation-workflow-compiler.js";
import {
  executeAutomationWorkflowCommand,
  replayAutomationWorkflowRun,
  type AutomationWorkflowActor,
  type AutomationWorkflowRunEvent,
  type AutomationWorkflowRunState,
  type AutomationWorkflowRuntimeCommand,
} from "../src/automation-workflow-runtime.js";
import {
  buildErrorToDraftPrWorkflow,
  buildWeeklyFunnelReviewWorkflow,
} from "../src/automation-workflow-presets.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const system: AutomationWorkflowActor = { principal: "agentry_system", credential_id: null };
const runner: AutomationWorkflowActor = { principal: "automation_runner", credential_id: "runner-1" };
const owner: AutomationWorkflowActor = { principal: "human_project_owner", credential_id: "owner-1" };
const trustedCi: AutomationWorkflowActor = { principal: "trusted_ci", credential_id: null };

function weeklyBindings() {
  return {
    automation_id: "weekly_funnel_review",
    name: "Weekly activation funnel review",
    runner: { provider: "codex" as const, environment: "production" },
    schedule: { cron: "0 9 * * 1", timezone: "Europe/Helsinki", start_window_seconds: 900 },
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
    escalation: { destination: "project owner", instructions: "Report missing evidence and stop." },
  };
}

function errorBindings() {
  return {
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
    verification: { observation_window_seconds: 3_600, max_wait_seconds: 86_400, min_sample_size: 50 },
    escalation: { destination: "project owner", instructions: "Preserve evidence and stop." },
  };
}

function scheduleReceipt() {
  return {
    receipt_id: "schedule-1",
    scheduled_for: 100,
    window_start: 100,
    window_end: 1_000,
    instruction_authority: "none",
  };
}

function funnelSource(readiness: "ready" | "insufficient_sample" = "ready") {
  const events = weeklyBindings().funnel.events;
  return {
    source_hash: HASH_A,
    current_period: { start: 700, end: 1_300 },
    previous_period: { start: 100, end: 700 },
    events,
    current: { observed_users: 100, steps: events.map((event, index) => ({ event, users: 100 - index * 10 })) },
    previous: { observed_users: 90, steps: events.map((event, index) => ({ event, users: 90 - index * 10 })) },
    readiness: { status: readiness, limitations: readiness === "ready" ? [] : ["sample too small"] },
    instruction_authority: "none",
  };
}

function caseReceipt() {
  return {
    receipt_id: "case-receipt-1",
    case_id: "case-1",
    case_revision: 3,
    snapshot_hash: HASH_A,
    source_trust: "customer_posthog",
    issued_at: 100,
    expires_at: 1_000_000,
    instruction_authority: "none",
  };
}

async function compiledWeekly() {
  const result = await compileAutomationWorkflow(buildWeeklyFunnelReviewWorkflow(weeklyBindings()));
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.data;
}

async function compiledError(approvalExpiresAfterSeconds = 86_400) {
  const bindings = errorBindings();
  bindings.approval_expires_after_seconds = approvalExpiresAfterSeconds;
  const result = await compileAutomationWorkflow(buildErrorToDraftPrWorkflow(bindings));
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.data;
}

async function runCommand(
  compiled: Awaited<ReturnType<typeof compiledWeekly>>,
  state: AutomationWorkflowRunState | null,
  events: AutomationWorkflowRunEvent[],
  command: AutomationWorkflowRuntimeCommand,
) {
  const result = await executeAutomationWorkflowCommand(compiled, state, command);
  events.push(...result.events);
  return result;
}

async function rehashEvent(event: AutomationWorkflowRunEvent) {
  event.payload_hash = await sha256Hex(canonicalJsonStringify(event.payload));
  const { event_id: _eventId, ...envelope } = event;
  event.event_id = await sha256Hex(canonicalJsonStringify(envelope));
}

async function awaitingWeeklyAgent(
  compiled: Awaited<ReturnType<typeof compiledWeekly>>,
  runId: string,
  events: AutomationWorkflowRunEvent[],
) {
  let result = await runCommand(compiled, null, events, {
    kind: "start",
    command_id: `${runId}-start`,
    expected_revision: 0,
    at: 100,
    actor: system,
    run_id: runId,
    project_id: "project-1",
    automation_id: compiled.workflow.id,
    workflow_revision: 1,
    trigger_output: scheduleReceipt(),
  });
  result = await runCommand(compiled, result.state, events, {
    kind: "component_succeeded",
    command_id: `${runId}-query`,
    expected_revision: result.state.revision,
    at: 101,
    actor: system,
    node_id: "funnel_source",
    output: funnelSource(),
  });
  return result;
}

async function reservedErrorEffect(
  compiled: Awaited<ReturnType<typeof compiledError>>,
  runId: string,
  events: AutomationWorkflowRunEvent[],
) {
  let result = await runCommand(compiled, null, events, {
    kind: "start", command_id: `${runId}-start`, expected_revision: 0, at: 100, actor: system,
    run_id: runId, project_id: "project-1", automation_id: compiled.workflow.id,
    workflow_revision: 1, trigger_output: caseReceipt(),
  });
  result = await runCommand(compiled, result.state, events, {
    kind: "component_succeeded", command_id: `${runId}-evidence`, expected_revision: result.state.revision,
    at: 101, actor: system, node_id: "case_evidence",
    output: {
      case_id: "case-1", case_revision: 3, evidence_hash: HASH_B,
      error: { type: "TypeError", message: "boom", event_count: 4, first_seen_at: 50, last_seen_at: 90 },
      last_deploy_sha: null, instruction_authority: "none",
    },
  });
  result = await runCommand(compiled, result.state, events, {
    kind: "component_succeeded", command_id: `${runId}-proposal`, expected_revision: result.state.revision,
    at: 102, actor: runner, node_id: "diagnose_fix",
    usage: {
      sequence: 1, turns_used: 4, cost_micros: 500_000,
      touched_files: ["src/fix.ts"], changed_line_churn: 5,
    },
    output: {
      proposal_hash: HASH_C, evidence_hash: HASH_B, repository: "https://github.com/example/app",
      base_sha: "abcdef1", head_sha: "abcdef2", branch: "agentry/fix-case-1",
      changed_files: [{ path: "src/fix.ts", added_lines: 4, deleted_lines: 1 }],
      tests: [{ command: "npm test", status: "passed", exit_code: 0 }],
      summary: "Bounded fix", instruction_authority: "none",
    },
  });
  result = await runCommand(compiled, result.state, events, {
    kind: "approval_decided", command_id: `${runId}-approve`, expected_revision: result.state.revision,
    at: 103, actor: owner, node_id: "approve_draft_pr", decision: "approved", reason: "Reviewed exact diff and tests.",
  });
  return result;
}

describe("automation workflow v3 event runtime", () => {
  it("executes and deterministically replays a complete typed weekly workflow", async () => {
    const compiled = await compiledWeekly();
    const events: AutomationWorkflowRunEvent[] = [];
    let result = await runCommand(compiled, null, events, {
      kind: "start",
      command_id: "start-1",
      expected_revision: 0,
      at: 100,
      actor: system,
      run_id: "run-1",
      project_id: "project-1",
      automation_id: compiled.workflow.id,
      workflow_revision: 1,
      trigger_output: scheduleReceipt(),
    });
    expect(result.next_action).toMatchObject({ kind: "execute_component", node_id: "funnel_source" });

    result = await runCommand(compiled, result.state, events, {
      kind: "component_succeeded",
      command_id: "query-1",
      expected_revision: result.state.revision,
      at: 101,
      actor: system,
      node_id: "funnel_source",
      output: funnelSource(),
    });
    expect(result.next_action).toMatchObject({ kind: "execute_component", node_id: "review_funnel" });

    result = await runCommand(compiled, result.state, events, {
      kind: "component_succeeded",
      command_id: "agent-1",
      expected_revision: result.state.revision,
      at: 102,
      actor: runner,
      node_id: "review_funnel",
      usage: {
        sequence: 1,
        turns_used: 2,
        cost_micros: 125_000,
        touched_files: [],
        changed_line_churn: 0,
      },
      output: {
        report_hash: HASH_B,
        source_hash: HASH_A,
        findings: [{ kind: "metric", statement: "Activation improved.", evidence_paths: ["current.steps"] }],
        limitations: [],
        instruction_authority: "none",
      },
    });
    expect(result.next_action).toMatchObject({ kind: "execute_component", node_id: "record_private_report" });

    result = await runCommand(compiled, result.state, events, {
      kind: "component_succeeded",
      command_id: "report-1",
      expected_revision: result.state.revision,
      at: 103,
      actor: system,
      node_id: "record_private_report",
      output: {
        report_id: "report-1",
        source_hash: HASH_A,
        report_hash: HASH_B,
        visibility: "private",
        recorded_at: 103,
        instruction_authority: "none",
      },
    });
    expect(result.state.status).toBe("completed");
    expect(result.next_action).toBeNull();
    expect(result.state.terminal).toMatchObject({ outcome: "complete", result_node_id: "record_private_report" });
    expect(result.state).toMatchObject({
      active_runtime_seconds: 3,
      usage_sequence: 1,
      turns_used: 2,
      cost_micros: 125_000,
      changed_files: [],
      changed_line_churn: 0,
    });

    const replayed = await replayAutomationWorkflowRun(compiled, events);
    expect(replayed).toEqual(result.state);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events[0]!.prior_event_hash).toBeNull();
    expect(events.slice(1).map((event) => event.prior_event_hash)).toEqual(
      events.slice(0, -1).map((event) => event.event_id),
    );
  });

  it("rejects untyped output and detects event payload tampering", async () => {
    const compiled = await compiledWeekly();
    const started = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start",
      command_id: "start-2",
      expected_revision: 0,
      at: 100,
      actor: system,
      run_id: "run-2",
      project_id: "project-1",
      automation_id: compiled.workflow.id,
      workflow_revision: 1,
      trigger_output: scheduleReceipt(),
    });
    await expect(executeAutomationWorkflowCommand(compiled, started.state, {
      kind: "component_succeeded",
      command_id: "bad-query",
      expected_revision: started.state.revision,
      at: 101,
      actor: system,
      node_id: "funnel_source",
      output: { ...funnelSource(), unexpected: true },
    })).rejects.toMatchObject({ code: "component_output_invalid" });

    const tampered = structuredClone(started.events);
    tampered[0]!.payload.project_id = "another-project";
    await expect(replayAutomationWorkflowRun(compiled, tampered)).rejects.toThrow("payload hash mismatch");
  });

  it("rejects rehashed illegal transitions, output metadata, actors, and broken event chains", async () => {
    const compiled = await compiledWeekly();
    const started = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start",
      command_id: "start-replay-guards",
      expected_revision: 0,
      at: 100,
      actor: system,
      run_id: "run-replay-guards",
      project_id: "project-1",
      automation_id: compiled.workflow.id,
      workflow_revision: 1,
      trigger_output: scheduleReceipt(),
    });

    const unhashedEnvelopeTamper = structuredClone(started.events.slice(0, 1));
    unhashedEnvelopeTamper[0]!.actor = owner;
    await expect(replayAutomationWorkflowRun(compiled, unhashedEnvelopeTamper)).rejects.toThrow("identity hash mismatch");

    const wrongActor = structuredClone(started.events.slice(0, 1));
    wrongActor[0]!.actor = owner;
    await rehashEvent(wrongActor[0]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongActor)).rejects.toThrow("actor principal is not authorized");

    const wrongEdge = structuredClone(started.events.slice(0, 2));
    wrongEdge[1]!.payload.next_node_id = "complete";
    await rehashEvent(wrongEdge[1]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongEdge)).rejects.toThrow("next_node_id does not match the legal transition");

    const wrongOutputHash = structuredClone(started.events.slice(0, 2));
    wrongOutputHash[1]!.payload.output_hash = HASH_A;
    await rehashEvent(wrongOutputHash[1]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongOutputHash)).rejects.toThrow("output_hash does not match the legal transition");

    const wrongComponent = structuredClone(started.events.slice(0, 2));
    wrongComponent[1]!.component_hash = HASH_A;
    await rehashEvent(wrongComponent[1]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongComponent)).rejects.toThrow("component hash mismatch");

    const wrongSchema = structuredClone(started.events.slice(0, 2));
    wrongSchema[1]!.payload_schema_ref = "unexpected_contract@1";
    await rehashEvent(wrongSchema[1]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongSchema)).rejects.toThrow("output contract mismatch");

    const extraPayloadField = structuredClone(started.events.slice(0, 2));
    extraPayloadField[1]!.payload.unexpected = true;
    await rehashEvent(extraPayloadField[1]!);
    await expect(replayAutomationWorkflowRun(compiled, extraPayloadField)).rejects.toThrow("payload fields do not match");

    const brokenChain = structuredClone(started.events.slice(0, 2));
    brokenChain[1]!.prior_event_hash = HASH_A;
    await rehashEvent(brokenChain[1]!);
    await expect(replayAutomationWorkflowRun(compiled, brokenChain)).rejects.toThrow("prior hash chain is broken");

    const regressedTime = structuredClone(started.events.slice(0, 2));
    regressedTime[1]!.at = 99;
    await rehashEvent(regressedTime[1]!);
    await expect(replayAutomationWorkflowRun(compiled, regressedTime)).rejects.toThrow("time is not monotonic");
  });

  it("rejects regressed command time and closes elapsed deadlines at the exact boundary", async () => {
    const compiled = await compiledWeekly();
    const started = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start",
      command_id: "start-time-guards",
      expected_revision: 0,
      at: 100,
      actor: system,
      run_id: "run-time-guards",
      project_id: "project-1",
      automation_id: compiled.workflow.id,
      workflow_revision: 1,
      trigger_output: scheduleReceipt(),
    });

    await expect(executeAutomationWorkflowCommand(compiled, started.state, {
      kind: "component_succeeded",
      command_id: "backdated-query",
      expected_revision: started.state.revision,
      at: 99,
      actor: system,
      node_id: "funnel_source",
      output: funnelSource(),
    })).rejects.toMatchObject({ code: "command_time_regressed" });

    const atDeadline = await executeAutomationWorkflowCommand(compiled, started.state, {
      kind: "tick",
      command_id: "deadline-tick",
      expected_revision: started.state.revision,
      at: started.state.elapsed_deadline_at,
      actor: system,
    });
    expect(atDeadline.state.status).toBe("quarantined");
    expect(atDeadline.state.terminal).toMatchObject({ reason: "elapsed_deadline_exceeded" });

    await expect(executeAutomationWorkflowCommand(compiled, null, {
      kind: "start",
      command_id: "expired-schedule",
      expected_revision: 0,
      at: scheduleReceipt().window_end,
      actor: system,
      run_id: "run-expired-schedule",
      project_id: "project-1",
      automation_id: compiled.workflow.id,
      workflow_revision: 1,
      trigger_output: scheduleReceipt(),
    })).rejects.toMatchObject({ code: "trigger_receipt_not_eligible" });
  });

  it("freezes approval subjects and reconciles an indeterminate external effect before continuing", async () => {
    const compiled = await compiledError(300);
    const events: AutomationWorkflowRunEvent[] = [];
    let result = await runCommand(compiled, null, events, {
      kind: "start", command_id: "start-error", expected_revision: 0, at: 100, actor: system,
      run_id: "run-error", project_id: "project-1", automation_id: compiled.workflow.id,
      workflow_revision: 1, trigger_output: caseReceipt(),
    });
    result = await runCommand(compiled, result.state, events, {
      kind: "component_succeeded", command_id: "evidence", expected_revision: result.state.revision,
      at: 101, actor: system, node_id: "case_evidence",
      output: {
        case_id: "case-1", case_revision: 3, evidence_hash: HASH_B,
        error: { type: "TypeError", message: "boom", event_count: 4, first_seen_at: 50, last_seen_at: 90 },
        last_deploy_sha: null, instruction_authority: "none",
      },
    });
    result = await runCommand(compiled, result.state, events, {
      kind: "component_succeeded", command_id: "proposal", expected_revision: result.state.revision,
      at: 102, actor: runner, node_id: "diagnose_fix",
      usage: {
        sequence: 1,
        turns_used: 4,
        cost_micros: 500_000,
        touched_files: ["src/fix.ts"],
        changed_line_churn: 5,
      },
      output: {
        proposal_hash: HASH_C, evidence_hash: HASH_B, repository: "https://github.com/example/app",
        base_sha: "abcdef1", head_sha: "abcdef2", branch: "agentry/fix-case-1",
        changed_files: [{ path: "src/fix.ts", added_lines: 4, deleted_lines: 1 }],
        tests: [{ command: "npm test", status: "passed", exit_code: 0 }],
        summary: "Bounded fix", instruction_authority: "none",
      },
    });
    expect(result.next_action).toMatchObject({ kind: "await_approval", node_id: "approve_draft_pr", subject_hash: expect.any(String) });

    result = await runCommand(compiled, result.state, events, {
      kind: "approval_decided", command_id: "approve", expected_revision: result.state.revision,
      at: 103, actor: owner, node_id: "approve_draft_pr", decision: "approved", reason: "Reviewed exact diff and tests.",
    });
    expect(result.next_action).toMatchObject({ kind: "execute_effect", node_id: "create_draft_pr" });
    const intentHash = (result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "execute_effect" }>).intent_hash;

    await expect(executeAutomationWorkflowCommand(compiled, result.state, {
      kind: "effect_call_started", command_id: "effect-after-approval-expiry",
      expected_revision: result.state.revision, at: result.state.approvals.create_draft_pr!.expires_at,
      actor: runner, node_id: "create_draft_pr", intent_hash: intentHash,
    })).rejects.toMatchObject({ code: "effect_approval_expired" });

    result = await runCommand(compiled, result.state, events, {
      kind: "effect_call_started", command_id: "effect-start", expected_revision: result.state.revision,
      at: 104, actor: runner, node_id: "create_draft_pr", intent_hash: intentHash,
    });
    expect(result.next_action).toMatchObject({
      kind: "reconcile_effect",
      intent_hash: intentHash,
      next_reconcile_at: 1_004,
    });
    const reconcileAt = (result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "reconcile_effect" }>).next_reconcile_at;
    await expect(executeAutomationWorkflowCommand(compiled, result.state, {
      kind: "effect_call_started", command_id: "blind-retry", expected_revision: result.state.revision,
      at: 105, actor: runner, node_id: "create_draft_pr", intent_hash: intentHash,
    })).rejects.toMatchObject({ code: "effect_indeterminate" });

    await expect(executeAutomationWorkflowCommand(compiled, result.state, {
      kind: "effect_reconciled", command_id: "effect-reconcile-early", expected_revision: result.state.revision,
      at: reconcileAt - 1, actor: trustedCi, node_id: "create_draft_pr", intent_hash: intentHash, outcome: "absent",
    })).rejects.toMatchObject({ code: "effect_reconciliation_not_due" });

    result = await runCommand(compiled, result.state, events, {
      kind: "effect_reconciled", command_id: "effect-reconcile", expected_revision: result.state.revision,
      at: reconcileAt, actor: trustedCi, node_id: "create_draft_pr", intent_hash: intentHash, outcome: "found",
      output: {
        intent_id: "intent-1", proposal_hash: HASH_C, provider: "github",
        provider_target: "https://github.com/example/app", pr_number: 7,
        pr_url: "https://github.com/example/app/pull/7", head_sha: "abcdef2",
        recorded_at: reconcileAt, instruction_authority: "none",
      },
    });
    expect(result.next_action).toMatchObject({ kind: "suspended", suspension: "wait", node_id: "wait_for_deploy" });
    expect(result.state.effects.create_draft_pr).toMatchObject({ status: "succeeded", intent_hash: intentHash });
    const waitingState = result.state;
    if (waitingState.pending?.kind !== "wait") throw new Error("expected wait pending state");
    await expect(executeAutomationWorkflowCommand(compiled, waitingState, {
      kind: "wait_resolved", command_id: "late-deploy", expected_revision: waitingState.revision,
      at: waitingState.pending.deadline_at, actor: system, node_id: "wait_for_deploy", outcome: "ready",
      output: {
        draft_pr_intent_id: "intent-1", source_commit_sha: "abcdef2", deploy_sha: "abcdef2",
        provider_proof_hash: HASH_A, received_at: waitingState.pending.deadline_at, source_trust: "trusted_ci",
        instruction_authority: "none",
      },
    })).rejects.toMatchObject({ code: "wait_expired" });
    const timedOut = await executeAutomationWorkflowCommand(compiled, waitingState, {
      kind: "wait_resolved", command_id: "deploy-timeout", expected_revision: waitingState.revision,
      at: waitingState.pending.deadline_at, actor: system, node_id: "wait_for_deploy", outcome: "timeout",
    });
    expect(timedOut.state.status).toBe("escalated");
    expect(await replayAutomationWorkflowRun(compiled, [...events, ...timedOut.events])).toEqual(timedOut.state);

    result = await runCommand(compiled, result.state, events, {
      kind: "wait_resolved", command_id: "deploy-observed", expected_revision: result.state.revision,
      at: reconcileAt + 1, actor: system, node_id: "wait_for_deploy", outcome: "ready",
      output: {
        draft_pr_intent_id: "intent-1", source_commit_sha: "abcdef2", deploy_sha: "abcdef2",
        provider_proof_hash: HASH_A, received_at: reconcileAt + 1, source_trust: "trusted_ci",
        instruction_authority: "none",
      },
    });
    expect(result.next_action).toMatchObject({ kind: "suspended", suspension: "verify", node_id: "verify_no_recurrence" });

    result = await runCommand(compiled, result.state, events, {
      kind: "verification_resolved", command_id: "verification-pass", expected_revision: result.state.revision,
      at: reconcileAt + 2, actor: system, node_id: "verify_no_recurrence", outcome: "pass",
      output: {
        passed: true, case_id: "case-1", case_revision: 3, deploy_sha: "abcdef2",
        window_start: reconcileAt + 1, window_end: reconcileAt + 2, traffic_sample_size: 50, recurrence_count: 0,
        checked_at: reconcileAt + 2, reason: "No recurrence after observed traffic.", instruction_authority: "none",
      },
    });
    expect(result.state.status).toBe("completed");
    expect(result.state.active_runtime_seconds).toBe(3);
    expect(await replayAutomationWorkflowRun(compiled, events)).toEqual(result.state);
  });

  it("requires canonical adapter usage and enforces every aggregate agent budget", async () => {
    const compiled = await compiledWeekly();
    const report = {
      report_hash: HASH_B,
      source_hash: HASH_A,
      findings: [{ kind: "metric", statement: "Activation improved.", evidence_paths: ["current.steps"] }],
      limitations: [],
      instruction_authority: "none",
    };

    const preAgentEvents: AutomationWorkflowRunEvent[] = [];
    const awaitingAgent = await awaitingWeeklyAgent(compiled, "run-usage-validation", preAgentEvents);
    await expect(executeAutomationWorkflowCommand(compiled, awaitingAgent.state, {
      kind: "component_succeeded", command_id: "usage-missing", expected_revision: awaitingAgent.state.revision,
      at: 102, actor: runner, node_id: "review_funnel", output: report,
    })).rejects.toMatchObject({ code: "agent_usage_required" });
    await expect(executeAutomationWorkflowCommand(compiled, awaitingAgent.state, {
      kind: "component_domain_failed", command_id: "domain-usage-missing", expected_revision: awaitingAgent.state.revision,
      at: 102, actor: runner, node_id: "review_funnel", error: { code: "analysis_failed", message: "No bounded result." },
    })).rejects.toMatchObject({ code: "agent_usage_required" });
    await expect(executeAutomationWorkflowCommand(compiled, awaitingAgent.state, {
      kind: "component_succeeded", command_id: "usage-noncanonical", expected_revision: awaitingAgent.state.revision,
      at: 102, actor: runner, node_id: "review_funnel", output: report,
      usage: {
        sequence: 1, turns_used: 1, cost_micros: 1,
        touched_files: ["src/z.ts", "src/a.ts"], changed_line_churn: 0,
      },
    })).rejects.toMatchObject({ code: "agent_usage_invalid" });

    const started = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start", command_id: "usage-unexpected-start", expected_revision: 0, at: 100, actor: system,
      run_id: "run-usage-unexpected", project_id: "project-1", automation_id: compiled.workflow.id,
      workflow_revision: 1, trigger_output: scheduleReceipt(),
    });
    await expect(executeAutomationWorkflowCommand(compiled, started.state, {
      kind: "component_succeeded", command_id: "usage-unexpected", expected_revision: started.state.revision,
      at: 101, actor: system, node_id: "funnel_source", output: funnelSource(),
      usage: { sequence: 1, turns_used: 1, cost_micros: 1, touched_files: [], changed_line_churn: 0 },
    })).rejects.toMatchObject({ code: "agent_usage_unexpected" });

    const domainEvents: AutomationWorkflowRunEvent[] = [];
    const domainPending = await awaitingWeeklyAgent(compiled, "run-domain-usage", domainEvents);
    const domainFailed = await runCommand(compiled, domainPending.state, domainEvents, {
      kind: "component_domain_failed", command_id: "domain-usage-recorded", expected_revision: domainPending.state.revision,
      at: 102, actor: runner, node_id: "review_funnel",
      error: { code: "analysis_failed", message: "No bounded result." },
      usage: { sequence: 1, turns_used: 2, cost_micros: 10_000, touched_files: [], changed_line_churn: 0 },
    });
    expect(domainFailed.events.map((event) => event.event)).toEqual([
      "run.usage_recorded", "node.domain_failed", "run.escalated",
    ]);
    expect(await replayAutomationWorkflowRun(compiled, domainEvents)).toEqual(domainFailed.state);

    const cases = [
      {
        suffix: "turns",
        usage: { sequence: 1, turns_used: 25, cost_micros: 0, touched_files: [] as string[], changed_line_churn: 0 },
        reason: "turn_budget_exceeded",
      },
      {
        suffix: "cost",
        usage: { sequence: 1, turns_used: 1, cost_micros: 5_000_001, touched_files: [] as string[], changed_line_churn: 0 },
        reason: "cost_budget_exceeded",
      },
      {
        suffix: "files",
        usage: { sequence: 1, turns_used: 1, cost_micros: 1, touched_files: ["src/new.ts"], changed_line_churn: 0 },
        reason: "workspace_file_budget_exceeded",
      },
      {
        suffix: "lines",
        usage: { sequence: 1, turns_used: 1, cost_micros: 1, touched_files: [] as string[], changed_line_churn: 1 },
        reason: "workspace_line_budget_exceeded",
      },
    ];
    let turnBudgetEvents: AutomationWorkflowRunEvent[] = [];
    for (const budgetCase of cases) {
      const events: AutomationWorkflowRunEvent[] = [];
      const pending = await awaitingWeeklyAgent(compiled, `run-budget-${budgetCase.suffix}`, events);
      const result = await runCommand(compiled, pending.state, events, {
        kind: "component_succeeded", command_id: `budget-${budgetCase.suffix}`, expected_revision: pending.state.revision,
        at: 102, actor: runner, node_id: "review_funnel", output: report, usage: budgetCase.usage,
      });
      expect(result.state.status).toBe("quarantined");
      expect(result.state.terminal).toMatchObject({ reason: budgetCase.reason });
      expect(result.events.map((event) => event.event)).toEqual(["run.usage_recorded", "run.quarantined"]);
      expect(await replayAutomationWorkflowRun(compiled, events)).toEqual(result.state);
      if (budgetCase.suffix === "turns") turnBudgetEvents = events;
    }

    const usageIndex = turnBudgetEvents.findIndex((event) => event.event === "run.usage_recorded");
    const tamperedUsage = structuredClone(turnBudgetEvents.slice(0, usageIndex + 1));
    tamperedUsage[usageIndex]!.payload.sequence = 2;
    await rehashEvent(tamperedUsage[usageIndex]!);
    await expect(replayAutomationWorkflowRun(compiled, tamperedUsage)).rejects.toThrow("not the next contiguous");
  });

  it("never reopens an absent indeterminate effect and quarantines at the reconciliation ceiling", async () => {
    const compiled = await compiledError();
    const events: AutomationWorkflowRunEvent[] = [];
    let result = await reservedErrorEffect(compiled, "run-effect-absent", events);
    const intentHash = (result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "execute_effect" }>).intent_hash;
    result = await runCommand(compiled, result.state, events, {
      kind: "effect_call_started", command_id: "absent-call-started", expected_revision: result.state.revision,
      at: 104, actor: runner, node_id: "create_draft_pr", intent_hash: intentHash,
    });

    for (let reconciliation = 1; reconciliation <= 3; reconciliation += 1) {
      const action = result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "reconcile_effect" }>;
      expect(action).toMatchObject({
        kind: "reconcile_effect",
        intent_hash: intentHash,
        reconciliation_count: reconciliation - 1,
      });
      result = await runCommand(compiled, result.state, events, {
        kind: "effect_reconciled", command_id: `absent-${reconciliation}`, expected_revision: result.state.revision,
        at: action.next_reconcile_at, actor: trustedCi, node_id: "create_draft_pr",
        intent_hash: intentHash, outcome: "absent",
      });
      if (reconciliation < 3) {
        expect(result.state.status).toBe("effect_indeterminate");
        expect(result.next_action).toMatchObject({
          kind: "reconcile_effect",
          reconciliation_count: reconciliation,
          next_reconcile_at: action.next_reconcile_at + compiled.workflow.limits.retry_backoff_seconds,
        });
      }
    }

    expect(result.state.status).toBe("quarantined");
    expect(result.state.terminal).toMatchObject({
      reason: "effect_reconciliation_exhausted_manual_follow_up_required",
    });
    expect(events.filter((event) => event.event === "effect.call_started")).toHaveLength(1);
    expect(events.filter((event) => event.event === "effect.intent_reserved")).toHaveLength(1);
    expect(events.filter((event) => event.event === "effect.reconciled_absent")).toHaveLength(2);
    expect(events.filter((event) => event.event === "effect.reconciliation_exhausted")).toHaveLength(1);
    expect(await replayAutomationWorkflowRun(compiled, events)).toEqual(result.state);
  });

  it("records unknown reconciliation separately, validates it strictly, and applies the same ceiling", async () => {
    const compiled = await compiledError();
    const events: AutomationWorkflowRunEvent[] = [];
    let result = await reservedErrorEffect(compiled, "run-effect-unknown", events);
    const intentHash = (result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "execute_effect" }>).intent_hash;
    result = await runCommand(compiled, result.state, events, {
      kind: "effect_call_started", command_id: "unknown-call-started", expected_revision: result.state.revision,
      at: 104, actor: runner, node_id: "create_draft_pr", intent_hash: intentHash,
    });
    const firstAction = result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "reconcile_effect" }>;

    await expect(executeAutomationWorkflowCommand(compiled, result.state, {
      kind: "effect_reconciled", command_id: "unknown-too-early", expected_revision: result.state.revision,
      at: firstAction.next_reconcile_at - 1, actor: trustedCi, node_id: "create_draft_pr",
      intent_hash: intentHash, outcome: "unknown",
    })).rejects.toMatchObject({ code: "effect_reconciliation_not_due" });
    await expect(executeAutomationWorkflowCommand(compiled, result.state, {
      kind: "effect_reconciled", command_id: "unknown-invalid-outcome", expected_revision: result.state.revision,
      at: firstAction.next_reconcile_at, actor: trustedCi, node_id: "create_draft_pr",
      intent_hash: intentHash, outcome: "ambiguous" as "unknown",
    })).rejects.toMatchObject({ code: "effect_reconciliation_outcome_invalid" });
    await expect(executeAutomationWorkflowCommand(compiled, result.state, {
      kind: "effect_reconciled", command_id: "unknown-with-receipt", expected_revision: result.state.revision,
      at: firstAction.next_reconcile_at, actor: trustedCi, node_id: "create_draft_pr",
      intent_hash: intentHash, outcome: "unknown", output: { unexpected: true },
    })).rejects.toMatchObject({ code: "effect_receipt_unexpected" });

    for (let reconciliation = 1; reconciliation <= 3; reconciliation += 1) {
      const action = result.next_action as Extract<NonNullable<typeof result.next_action>, { kind: "reconcile_effect" }>;
      result = await runCommand(compiled, result.state, events, {
        kind: "effect_reconciled", command_id: `unknown-${reconciliation}`, expected_revision: result.state.revision,
        at: action.next_reconcile_at, actor: trustedCi, node_id: "create_draft_pr",
        intent_hash: intentHash, outcome: "unknown",
      });
      if (reconciliation < 3) {
        expect(result.events.map((event) => event.event)).toEqual(["effect.reconciliation_unknown"]);
        expect(result.state).toMatchObject({ status: "effect_indeterminate" });
        expect(result.next_action).toMatchObject({
          kind: "reconcile_effect",
          reconciliation_count: reconciliation,
          next_reconcile_at: action.next_reconcile_at + compiled.workflow.limits.retry_backoff_seconds,
        });
      }
    }

    expect(result.state.status).toBe("quarantined");
    expect(result.state.terminal).toMatchObject({
      reason: "effect_reconciliation_exhausted_manual_follow_up_required",
    });
    expect(events.filter((event) => event.event === "effect.reconciliation_unknown")).toHaveLength(2);
    expect(events.filter((event) => event.event === "effect.reconciled_absent")).toHaveLength(0);
    expect(events.filter((event) => event.event === "effect.reconciliation_exhausted")).toHaveLength(1);
    expect(events.filter((event) => event.event === "effect.call_started")).toHaveLength(1);
    expect(await replayAutomationWorkflowRun(compiled, events)).toEqual(result.state);

    const unknownIndex = events.findIndex((event) => event.event === "effect.reconciliation_unknown");
    const wrongBackoff = structuredClone(events.slice(0, unknownIndex + 1));
    wrongBackoff[unknownIndex]!.payload.next_reconcile_at = (
      wrongBackoff[unknownIndex]!.payload.next_reconcile_at as number
    ) + 1;
    await rehashEvent(wrongBackoff[unknownIndex]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongBackoff)).rejects.toThrow("does not match the frozen backoff");

    const extraOutcome = structuredClone(events.slice(0, unknownIndex + 1));
    extraOutcome[unknownIndex]!.payload.outcome = "unknown";
    await rehashEvent(extraOutcome[unknownIndex]!);
    await expect(replayAutomationWorkflowRun(compiled, extraOutcome)).rejects.toThrow("payload fields do not match");

    const wrongActor = structuredClone(events.slice(0, unknownIndex + 1));
    wrongActor[unknownIndex]!.actor = runner;
    await rehashEvent(wrongActor[unknownIndex]!);
    await expect(replayAutomationWorkflowRun(compiled, wrongActor)).rejects.toThrow("actor principal is not authorized");
  });

  it("lets owner cancellation and system quarantine override exhausted time gates", async () => {
    const compiled = await compiledWeekly();
    const cancelStarted = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start", command_id: "terminal-override-cancel-start", expected_revision: 0, at: 100, actor: system,
      run_id: "run-terminal-override-cancel", project_id: "project-1", automation_id: compiled.workflow.id,
      workflow_revision: 1, trigger_output: scheduleReceipt(),
    });
    const cancelled = await executeAutomationWorkflowCommand(compiled, cancelStarted.state, {
      kind: "cancel", command_id: "terminal-override-cancel", expected_revision: cancelStarted.state.revision,
      at: cancelStarted.state.elapsed_deadline_at, actor: owner, reason: "Owner revoked coordination authority.",
    });
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.terminal).toMatchObject({ reason: "Owner revoked coordination authority." });

    const quarantineStarted = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start", command_id: "terminal-override-quarantine-start", expected_revision: 0, at: 100, actor: system,
      run_id: "run-terminal-override-quarantine", project_id: "project-1", automation_id: compiled.workflow.id,
      workflow_revision: 1, trigger_output: scheduleReceipt(),
    });
    const quarantined = await executeAutomationWorkflowCommand(compiled, quarantineStarted.state, {
      kind: "quarantine", command_id: "terminal-override-quarantine", expected_revision: quarantineStarted.state.revision,
      at: quarantineStarted.state.elapsed_deadline_at + 1, actor: system, reason: "Operator kill switch engaged.",
    });
    expect(quarantined.state.status).toBe("quarantined");
    expect(quarantined.state.terminal).toMatchObject({ reason: "Operator kill switch engaged." });
  });

  it("settles an already-started effect before deadline or kill-switch quarantine", async () => {
    const compiled = await compiledError();
    const elapsedEvents: AutomationWorkflowRunEvent[] = [];
    let elapsed = await reservedErrorEffect(compiled, "run-effect-elapsed-settlement", elapsedEvents);
    const elapsedIntent = (elapsed.next_action as Extract<NonNullable<typeof elapsed.next_action>, { kind: "execute_effect" }>).intent_hash;
    elapsed = await runCommand(compiled, elapsed.state, elapsedEvents, {
      kind: "effect_call_started", command_id: "elapsed-effect-start", expected_revision: elapsed.state.revision,
      at: 104, actor: runner, node_id: "create_draft_pr", intent_hash: elapsedIntent,
    });
    const elapsedAt = elapsed.state.elapsed_deadline_at;
    elapsed = await runCommand(compiled, elapsed.state, elapsedEvents, {
      kind: "effect_receipt_recorded", command_id: "elapsed-effect-receipt", expected_revision: elapsed.state.revision,
      at: elapsedAt, actor: runner, node_id: "create_draft_pr", intent_hash: elapsedIntent,
      output: {
        intent_id: "intent-elapsed", proposal_hash: HASH_C, provider: "github",
        provider_target: "https://github.com/example/app", pr_number: 8,
        pr_url: "https://github.com/example/app/pull/8", head_sha: "abcdef2",
        recorded_at: elapsedAt, instruction_authority: "none",
      },
    });
    expect(elapsed.events.map((event) => event.event)).toEqual(["effect.completed", "run.quarantined"]);
    expect(elapsed.state.effects.create_draft_pr).toMatchObject({ status: "succeeded" });
    expect(elapsed.state.terminal).toMatchObject({ reason: "elapsed_deadline_exceeded" });
    expect(elapsed.events.some((event) => event.event === "wait.registered")).toBe(false);
    expect(await replayAutomationWorkflowRun(compiled, elapsedEvents)).toEqual(elapsed.state);

    const killEvents: AutomationWorkflowRunEvent[] = [];
    let killed = await reservedErrorEffect(compiled, "run-effect-kill-settlement", killEvents);
    const killedIntent = (killed.next_action as Extract<NonNullable<typeof killed.next_action>, { kind: "execute_effect" }>).intent_hash;
    killed = await runCommand(compiled, killed.state, killEvents, {
      kind: "effect_call_started", command_id: "kill-effect-start", expected_revision: killed.state.revision,
      at: 104, actor: runner, node_id: "create_draft_pr", intent_hash: killedIntent,
    });
    const due = (killed.next_action as Extract<NonNullable<typeof killed.next_action>, { kind: "reconcile_effect" }>).next_reconcile_at;
    const settledUnderKill = await executeAutomationWorkflowCommand(compiled, killed.state, {
      kind: "effect_reconciled", command_id: "kill-effect-found", expected_revision: killed.state.revision,
      at: due, actor: trustedCi, node_id: "create_draft_pr", intent_hash: killedIntent, outcome: "found",
      output: {
        intent_id: "intent-kill", proposal_hash: HASH_C, provider: "github",
        provider_target: "https://github.com/example/app", pr_number: 9,
        pr_url: "https://github.com/example/app/pull/9", head_sha: "abcdef2",
        recorded_at: due, instruction_authority: "none",
      },
    }, { halt_after_effect_settlement_reason: "kill_switch_active" });
    killEvents.push(...settledUnderKill.events);
    expect(settledUnderKill.events.map((event) => event.event)).toEqual(["effect.completed", "run.quarantined"]);
    expect(settledUnderKill.state.effects.create_draft_pr).toMatchObject({ status: "succeeded" });
    expect(settledUnderKill.state.terminal).toMatchObject({ reason: "kill_switch_active" });
    expect(await replayAutomationWorkflowRun(compiled, killEvents)).toEqual(settledUnderKill.state);
  });

  it("accepts a stable persisted request hash override without changing legacy callers", async () => {
    const compiled = await compiledWeekly();
    const requestHash = "d".repeat(64);
    const result = await executeAutomationWorkflowCommand(compiled, null, {
      kind: "start", command_id: "stable-request-hash", expected_revision: 0, at: 100, actor: system,
      run_id: "run-stable-request-hash", project_id: "project-1", automation_id: compiled.workflow.id,
      workflow_revision: 1, trigger_output: scheduleReceipt(),
    }, { request_hash: requestHash });
    expect(result.events.every((event) => event.request_hash === requestHash)).toBe(true);

    await expect(executeAutomationWorkflowCommand(compiled, null, {
      kind: "start", command_id: "bad-request-hash", expected_revision: 0, at: 100, actor: system,
      run_id: "run-bad-request-hash", project_id: "project-1", automation_id: compiled.workflow.id,
      workflow_revision: 1, trigger_output: scheduleReceipt(),
    }, { request_hash: "D".repeat(64) })).rejects.toMatchObject({ code: "request_hash_invalid" });
  });

  it("records verifier timeout separately from a negative verification result", async () => {
    const compiled = await compiledError();
    expect(compiled.workflow.nodes.find((node) => node.id === "verify_no_recurrence")).toMatchObject({
      kind: "verify",
      on_fail: "escalate",
      on_timeout: "escalate",
      on_error: "escalate",
    });
  });
});
