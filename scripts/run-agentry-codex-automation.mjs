#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AgentryHttpError,
  AgentryRunnerClient,
  CODEX_DIRECT_INVOCATION,
  SchedulerBusyError,
  SchedulerError,
  acquireSchedulerLock,
  assertExecutable,
  atomicWriteJson,
  buildCodexInvocation,
  buildCodexEnvironment,
  buildDependencyEnvironment,
  ensureIsolatedCheckout,
  ensureExistingPrivateDirectory,
  ensurePrivateDirectory,
  ensureSecureStateRoot,
  listAll,
  listStoredStates,
  loadSchedulerConfig,
  persistCodexLog,
  prepareWorkspaceDependencies,
  promoteProvisionalState,
  provisionalStateForReceipt,
  provisionalStatePath,
  readSchedulerPrompt,
  redactAutomationText,
  runDirectCommand,
  selectRunDisposition,
} from "./lib/agentry-codex-scheduler.mjs";

const NONTERMINAL_STATUSES = [
  "queued",
  "claimed",
  "running",
  "awaiting_approval",
  "draft_pr_opened",
  "verifying",
];
const ACTIVATION_BLOCKERS = Object.freeze([
  "no authoritative Codex turn/cost accounting",
  "no active-process lease/kill-switch watchdog",
  "raw runner/provider credentials still reach model-generated commands",
  "draft-only GitHub identity and merge fence not proved",
]);

function parseArgs(argv) {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--once")) return { mode: "once" };
  if (argv.length === 1 && argv[0] === "--preflight") return { mode: "preflight" };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { mode: "help" };
  throw new SchedulerError(
    "usage: node scripts/run-agentry-codex-automation.mjs [--once|--preflight|--help]",
    { code: "arguments_invalid" },
  );
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function encoded(value) {
  return encodeURIComponent(value);
}

async function preflight(config) {
  await ensureSecureStateRoot(config.stateDir);
  await ensureExistingPrivateDirectory(config.automationHome, "AGENTRY_AUTOMATION_HOME");
  await ensureExistingPrivateDirectory(config.codexHome, "AGENTRY_AUTOMATION_CODEX_HOME");
  await access(config.promptPath);
  const childEnv = buildDependencyEnvironment(
    process.env,
    config.automationHome,
    join(config.stateDir, "preflight-npm-cache"),
  );
  childEnv.CODEX_HOME = config.codexHome;
  const versions = {};
  versions.node = process.version;
  versions.git = await assertExecutable("git", ["--version"], { env: childEnv });
  versions.gh = await assertExecutable("gh", ["--version"], { env: childEnv });
  versions.codex = await assertExecutable("codex", ["--version"], { env: childEnv });
  versions.npm = await assertExecutable("npm", ["--version"], { env: childEnv });
  output({
    ok: true,
    mode: "preflight",
    side_effects: {
      agentry_api_requests: 0,
      scheduler_registered: false,
      automation_enabled: false,
      credential_created: false,
      provider_mutation: false,
    },
    binding: {
      project_id: config.project_id,
      automation_id: config.automation_id,
      repository: config.repository,
      default_branch: config.default_branch,
    },
    invocation: CODEX_DIRECT_INVOCATION,
    versions,
    state_dir: config.stateDir,
    activation_ready: false,
    activation_blockers: ACTIVATION_BLOCKERS,
    not_checked: [
      "live runner credential binding",
      "contract or automation enablement",
      "provider permissions or branch rules",
      "Agentry or GitHub network access",
    ],
  });
}

async function listRemoteNonterminalRuns(client, config) {
  const runs = [];
  for (const status of NONTERMINAL_STATUSES) {
    const path = `/v1/projects/${encoded(config.project_id)}/automation-runs?automation_id=${encoded(config.automation_id)}&status=${encoded(status)}&limit=50`;
    runs.push(...await listAll(client, path, "runs"));
  }
  return runs;
}

async function renewClaim(client, statePath, state) {
  if (!state.claim_id || !state.lease_token) {
    throw new SchedulerError("a nonterminal case run has no recoverable lease state", {
      code: "state_secret_missing",
    });
  }
  const renewed = await client.post(
    `/v1/cases/${encoded(state.case_id)}/claims/${encoded(state.claim_id)}/renew`,
    { lease_seconds: 3_600 },
    { "X-Agentry-Lease-Token": state.lease_token },
  );
  if (renewed?.claim_id !== state.claim_id || !Number.isInteger(renewed?.expires_at)) {
    throw new SchedulerError("claim renewal response does not match the durable run state", {
      code: "api_response_invalid",
    });
  }
  const updated = {
    ...state,
    lease_expires_at: renewed.expires_at,
    updated_at: Math.floor(Date.now() / 1000),
  };
  await atomicWriteJson(statePath, updated);
  return updated;
}

async function recoverProvisional(client, config, record) {
  let state = record.state;
  const claim = await client.post(
    `/v1/cases/${encoded(state.case_id)}/claims`,
    state.claim_request,
    { "Idempotency-Key": state.claim_idempotency_key },
  );
  if (
    (state.claim_id !== null && claim?.id !== state.claim_id) ||
    claim?.case_id !== state.case_id ||
    claim?.automation_id !== state.automation_id ||
    claim?.trigger_receipt_id !== state.receipt_id ||
    typeof claim?.lease_token !== "string" ||
    !claim.lease_token.startsWith("lease_")
  ) {
    throw new SchedulerError("claim replay does not match the frozen receipt state", {
      code: "claim_recovery_mismatch",
    });
  }
  state = {
    ...state,
    phase: "starting_run",
    claim_id: claim.id,
    lease_token: claim.lease_token,
    lease_expires_at: claim.expires_at,
    run_request: {
      automation_id: config.automation_id,
      trigger_receipt_id: state.receipt_id,
      case_id: state.case_id,
      claim_id: claim.id,
      runner: {
        provider: "codex",
        id: config.runnerId,
      },
    },
    updated_at: Math.floor(Date.now() / 1000),
  };
  await atomicWriteJson(record.path, state);

  if (state.lease_expires_at <= Math.floor(Date.now() / 1000) + 60) {
    state = await renewClaim(client, record.path, state);
  }
  const run = await client.post(
    `/v1/projects/${encoded(config.project_id)}/automation-runs`,
    state.run_request,
    {
      "Idempotency-Key": state.run_idempotency_key,
      "X-Agentry-Lease-Token": state.lease_token,
    },
  );
  if (
    typeof run?.id !== "string" ||
    run.project_id !== config.project_id ||
    run.automation_id !== config.automation_id ||
    run.case_id !== state.case_id ||
    run.trigger_receipt_id !== state.receipt_id
  ) {
    throw new SchedulerError("run replay does not match the frozen claim and receipt state", {
      code: "run_recovery_mismatch",
    });
  }
  return promoteProvisionalState(config, record.path, state, run);
}

async function createRunFromReadyReceipt(client, config) {
  try {
    await client.post(
      `/v1/projects/${encoded(config.project_id)}/automation-triggers/issue`,
      { automation_id: config.automation_id },
    );
  } catch (error) {
    if (!(error instanceof SchedulerError) || error.code !== "api_response_lost") throw error;
    // The issue operation derives durable receipts from server state. After
    // response loss, the canonical recovery is a receipt read, never a second
    // caller-authored trigger fact.
  }

  const receipts = await listAll(
    client,
    `/v1/projects/${encoded(config.project_id)}/automation-trigger-receipts?automation_id=${encoded(config.automation_id)}&status=ready&limit=50`,
    "receipts",
  );
  const ready = receipts
    .filter((receipt) => receipt?.status === "ready")
    .sort((left, right) =>
      (left.validity?.issued_at ?? 0) - (right.validity?.issued_at ?? 0) ||
      String(left.id).localeCompare(String(right.id))
    )[0];
  if (!ready) return null;
  const state = provisionalStateForReceipt(config, ready);
  const path = provisionalStatePath(config, ready.id);
  await atomicWriteJson(path, state);
  return recoverProvisional(client, config, { path, state });
}

async function invokeCodex(client, config, record, run) {
  let state = record.state;
  if (["claimed", "running"].includes(run.status)) {
    state = await renewClaim(client, record.path, state);
  }
  const agentStateDir = join(dirname(record.path), "agent-state");
  await ensurePrivateDirectory(agentStateDir);
  const operationStatePath = join(agentStateDir, "operations.json");
  try {
    await access(operationStatePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWriteJson(operationStatePath, {
      schema_version: "1",
      run_id: state.run_id,
      operations: {},
    });
  }
  const childEnv = buildCodexEnvironment(process.env, config, operationStatePath, state);
  const workspace = await ensureIsolatedCheckout(config, state, { env: childEnv });
  await prepareWorkspaceDependencies(config, state, workspace, {
    env: process.env,
    maximumBytes: config.maxLogBytes,
  });
  const prompt = await readSchedulerPrompt(config, state);
  const exactValues = Object.entries(childEnv)
    .filter(([key]) => /(KEY|TOKEN|SECRET|CREDENTIAL)|GIT_CONFIG_VALUE_1/u.test(key))
    .map(([, value]) => value)
    .filter((value) => typeof value === "string" && value.length >= 8);
  const startedAt = Math.floor(Date.now() / 1000);
  const invocation = buildCodexInvocation(agentStateDir);
  const result = await runDirectCommand(
    invocation.executable,
    invocation.argv,
    {
      cwd: workspace,
      env: childEnv,
      stdin: prompt,
      maximumBytes: config.maxLogBytes,
      exactValues,
      timeoutMs: config.codexTimeoutSeconds * 1_000,
      processGroup: true,
    },
  );
  const finishedAt = Math.floor(Date.now() / 1000);
  await persistCodexLog(config, state, result.stdout, result.stderr, {
    schema_version: "1",
    run_id: state.run_id,
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: result.code,
    signal: result.signal,
    timed_out: result.timedOut,
    log_tail_truncated: result.truncated,
    invocation,
  });
  let observedStatus = run.status;
  try {
    const current = await client.get(`/v1/automation-runs/${encoded(state.run_id)}`);
    observedStatus = current.status;
  } catch (error) {
    if (!(error instanceof SchedulerError) || error.code !== "api_response_lost") throw error;
  }
  state = {
    ...state,
    last_observed_status: observedStatus,
    last_codex_exit_code: result.code,
    last_codex_finished_at: finishedAt,
    updated_at: finishedAt,
  };
  await atomicWriteJson(record.path, state);
  if (result.timedOut) {
    throw new SchedulerError("Codex exceeded its bounded scheduler runtime; the durable run and workspace remain resumable", {
      code: "codex_timeout",
    });
  }
  if (result.code !== 0) {
    throw new SchedulerError("Codex exited unsuccessfully; the durable run and isolated workspace remain resumable", {
      code: "codex_failed",
    });
  }
  output({
    ok: true,
    action: "codex_invoked",
    run_id: state.run_id,
    previous_status: run.status,
    observed_status: observedStatus,
    log_tail_truncated: result.truncated,
    workspace_persistent: true,
  });
}

async function runOnce(config) {
  if (ACTIVATION_BLOCKERS.length > 0) {
    throw new SchedulerError(
      `execution is deliberately blocked: ${ACTIVATION_BLOCKERS.join("; ")}`,
      { code: "automation_activation_blocked" },
    );
  }
  await ensureSecureStateRoot(config.stateDir);
  const lock = await acquireSchedulerLock(config.stateDir);
  try {
    const client = new AgentryRunnerClient(config);
    const provisionals = await listStoredStates(config, "provisional");
    if (provisionals.length > 1) {
      throw new SchedulerError("multiple unfinished receipt claims require human reconciliation", {
        code: "multiple_provisional_claims",
      });
    }
    if (provisionals.length === 1) {
      const promoted = await recoverProvisional(client, config, provisionals[0]);
      const run = await client.get(`/v1/automation-runs/${encoded(promoted.state.run_id)}`);
      await invokeCodex(client, config, promoted, run);
      return;
    }

    const [stored, remote] = await Promise.all([
      listStoredStates(config, "run"),
      listRemoteNonterminalRuns(client, config),
    ]);
    const storedByRun = new Map(stored.map((record) => [record.state.run_id, record]));
    const unknown = remote.filter((run) => !storedByRun.has(run.id));
    if (unknown.length > 0) {
      throw new SchedulerError(
        "Agentry has a nonterminal run without its secret-bearing local recovery state; stop and reconcile it before starting more work",
        { code: "remote_run_state_missing" },
      );
    }
    if (remote.length > 0) {
      const detailed = [];
      for (const summary of remote) {
        detailed.push(await client.get(`/v1/automation-runs/${encoded(summary.id)}`));
      }
      detailed.sort((left, right) =>
        (left.created_at ?? 0) - (right.created_at ?? 0) || String(left.id).localeCompare(String(right.id))
      );
      for (const run of detailed) {
        const disposition = selectRunDisposition(run);
        const record = storedByRun.get(run.id);
        if (disposition === "renew_and_wait") {
          await renewClaim(client, record.path, record.state);
        }
      }
      const actionable = detailed.find((run) => selectRunDisposition(run) === "invoke_codex");
      if (actionable) {
        await invokeCodex(client, config, storedByRun.get(actionable.id), actionable);
        return;
      }
      output({
        ok: true,
        action: "waiting",
        runs: detailed.map((run) => ({ run_id: run.id, status: run.status })),
        next_wake_required: detailed.some((run) => run.status === "awaiting_approval"),
      });
      return;
    }

    const created = await createRunFromReadyReceipt(client, config);
    if (!created) {
      output({ ok: true, action: "no_eligible_receipt", provider_invoked: false });
      return;
    }
    const run = await client.get(`/v1/automation-runs/${encoded(created.state.run_id)}`);
    await invokeCodex(client, config, created, run);
  } finally {
    await lock.release();
  }
}

function help() {
  process.stdout.write(`Agentry customer-owned Codex automation runner\n\n`);
  process.stdout.write(`  --preflight  Validate static local paths, token shapes, prompt, fixed binding, and binaries without an API call.\n`);
  process.stdout.write(`  --once       Fail closed while the documented activation blockers remain.\n`);
  process.stdout.write(`  --help       Show this help.\n\n`);
  process.stdout.write(`This program never registers a scheduler, enables a contract, creates credentials, merges, deploys, or records CI proof.\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    help();
  } else {
    const config = loadSchedulerConfig();
    if (args.mode === "preflight") await preflight(config);
    else await runOnce(config);
  }
} catch (error) {
  if (error instanceof SchedulerBusyError) {
    output({ ok: true, action: "skipped_concurrent_wake", code: error.code });
  } else {
    const exact = [
      process.env.AGENTRY_RUNNER_API_KEY,
      process.env.AGENTRY_AUTOMATION_LEASE_TOKEN,
      process.env.GH_TOKEN,
      process.env.GITHUB_TOKEN,
      process.env.AGENTRY_AUTOMATION_GITHUB_TOKEN,
      process.env.OPENAI_API_KEY,
    ];
    const message = redactAutomationText(error instanceof Error ? error.message : String(error), exact);
    const nextAction = error instanceof AgentryHttpError && error.nextAction
      ? redactAutomationText(error.nextAction, exact)
      : null;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code ?? "scheduler_error",
      message,
      ...(nextAction ? { next_action: nextAction } : {}),
    })}\n`);
    process.exitCode = 1;
  }
}
