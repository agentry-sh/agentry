import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AgentryRunnerClient,
  BoundedRedactedLog,
  CODEX_DIRECT_INVOCATION,
  SCHEDULER_USER_AGENT,
  SchedulerBusyError,
  acquireSchedulerLock,
  atomicWriteJson,
  buildCodexInvocation,
  buildCodexEnvironment,
  buildDependencyEnvironment,
  buildProviderEnvironment,
  ensureSecureStateRoot,
  loadSchedulerConfig,
  prepareWorkspaceDependencies,
  provisionalStateForReceipt,
  redactAutomationText,
  runDirectCommand,
  selectRunDisposition,
  stableIdempotencyKey,
} from "./agentry-codex-scheduler.mjs";
import {
  AUTOMATION_KEYCHAIN_ITEMS,
  keychainSchedulerEnvironment,
  readKeychainSecret,
} from "./agentry-automation-keychain.mjs";

const RUNNER_KEY = `agentry_runner_${"r".repeat(48)}`;
const DEDICATED_GITHUB_TOKEN = `github_pat_${"d".repeat(60)}`;
const AMBIENT_GITHUB_TOKEN = `ghp_${"a".repeat(48)}`;

function environment(stateDir) {
  return {
    PATH: process.env.PATH,
    HOME: "/tmp/fake-home",
    AGENTRY_AUTOMATION_HOME: "/tmp/fake-automation-home",
    AGENTRY_AUTOMATION_CODEX_HOME: "/tmp/fake-codex-home",
    AGENTRY_RUNNER_API_KEY: RUNNER_KEY,
    AGENTRY_AUTOMATION_RUNNER_ID: "agentry-self-repair-runner-01",
    AGENTRY_AUTOMATION_GITHUB_TOKEN: DEDICATED_GITHUB_TOKEN,
    AGENTRY_AUTOMATION_STATE_DIR: stateDir,
  };
}

async function withTemp(callback) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "agentry-codex-scheduler-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("loads the exact self-repair binding and requires dedicated scheduler credentials", async () => {
  await withTemp(async (root) => {
    const stateDir = join(root, "state");
    const config = loadSchedulerConfig(environment(stateDir), {
      home: root,
      repositoryRoot: join(root, "repository"),
    });
    assert.equal(config.project_id, "019e43d2-6e5a-7c39-b916-9f71ea581143");
    assert.equal(config.automation_id, "agentry_production_error_repair");
    assert.equal(config.repository, "https://github.com/agentry-sh/agentry");
    assert.equal(config.githubToken, DEDICATED_GITHUB_TOKEN);

    const missingDedicated = environment(stateDir);
    delete missingDedicated.AGENTRY_AUTOMATION_GITHUB_TOKEN;
    missingDedicated.GH_TOKEN = AMBIENT_GITHUB_TOKEN;
    missingDedicated.GITHUB_TOKEN = AMBIENT_GITHUB_TOKEN;
    assert.throws(
      () => loadSchedulerConfig(missingDedicated, { home: root, repositoryRoot: join(root, "repository") }),
      /AGENTRY_AUTOMATION_GITHUB_TOKEN is required/,
    );

    assert.throws(
      () => loadSchedulerConfig(environment(join(root, "repository", "state")), {
        home: root,
        repositoryRoot: join(root, "repository"),
      }),
      /must stay outside the repository/,
    );
  });
});

test("maps only the dedicated GitHub token and strips every ambient owner credential", async () => {
  await withTemp(async (root) => {
    const config = loadSchedulerConfig(environment(join(root, "state")), {
      home: root,
      repositoryRoot: join(root, "repository"),
    });
    const parent = {
      ...environment(join(root, "state")),
      GH_TOKEN: AMBIENT_GITHUB_TOKEN,
      GITHUB_TOKEN: AMBIENT_GITHUB_TOKEN,
      AGENTRY_PRIVATE_API_KEY: `agentry_sk_${"x".repeat(48)}`,
      AGENTRY_CI_API_KEY: `agentry_ci_${"x".repeat(48)}`,
      AGENTRY_SERVER_API_KEY: `agentry_server_${"x".repeat(48)}`,
      AGENTRY_PUBLIC_API_KEY: `agentry_pk_${"x".repeat(48)}`,
      RANDOM_OWNER_SECRET: "must-not-pass",
      GIT_AUTHOR_NAME: "Interactive Owner",
    };
    const provider = buildProviderEnvironment(parent, config.githubToken);
    assert.equal(provider.GH_TOKEN, DEDICATED_GITHUB_TOKEN);
    assert.equal(provider.GITHUB_TOKEN, undefined);
    assert.equal(provider.AGENTRY_PRIVATE_API_KEY, undefined);
    assert.equal(provider.AGENTRY_CI_API_KEY, undefined);
    assert.equal(provider.AGENTRY_SERVER_API_KEY, undefined);
    assert.equal(provider.RANDOM_OWNER_SECRET, undefined);
    assert.equal(provider.GIT_CONFIG_NOSYSTEM, "1");
    assert.match(provider.GIT_CONFIG_VALUE_1, /^Authorization: Basic /u);
    assert.equal(provider.GIT_AUTHOR_NAME, "Agentry Self Repair Runner");
    assert.doesNotMatch(provider.GIT_CONFIG_VALUE_1, new RegExp(AMBIENT_GITHUB_TOKEN, "u"));

    const operationPath = join(root, "state", "runs", "run-1", "agent-state", "operations.json");
    const child = buildCodexEnvironment(parent, config, operationPath, {
      run_id: "run-1",
      lease_token: `lease_${"l".repeat(48)}`,
    });
    assert.equal(child.AGENTRY_RUNNER_API_KEY, RUNNER_KEY);
    assert.equal(child.AGENTRY_PRIVATE_API_KEY, undefined);
    assert.equal(child.AGENTRY_CI_API_KEY, undefined);
    assert.equal(child.GH_TOKEN, DEDICATED_GITHUB_TOKEN);
    assert.equal(child.GITHUB_TOKEN, undefined);
    assert.equal(child.HOME, config.automationHome);
    assert.equal(child.CODEX_HOME, config.codexHome);
    assert.equal(child.AGENTRY_AUTOMATION_OPERATION_STATE_FILE, operationPath);
    assert.equal(child.AGENTRY_AUTOMATION_RUN_STATE_FILE, undefined);
  });
});

test("freezes the exact direct Codex argv without shell interpolation", async () => {
  const invocation = buildCodexInvocation("/private/agent-state");
  assert.equal(CODEX_DIRECT_INVOCATION.executable, "codex");
  assert.deepEqual(invocation.argv.slice(-3), ["--add-dir", "/private/agent-state", "-"]);
  assert.ok(invocation.argv.includes("--ignore-user-config"));
  assert.ok(invocation.argv.includes("--ignore-rules"));
  assert.ok(invocation.argv.includes("--strict-config"));
  assert.ok(invocation.argv.includes("workspace-write"));
  assert.ok(invocation.argv.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(invocation.argv.some((arg) => arg.includes('"api.agentry.sh" = "allow"')));
  const calls = [];
  function fakeSpawn(executable, argv, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    calls.push({ executable, argv, options });
    setImmediate(() => {
      child.stdout.end("ok\n");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  }
  const injectionShapedArg = "$(touch /tmp/must-not-run)";
  const result = await runDirectCommand("codex", ["exec", injectionShapedArg], {
    spawn: fakeSpawn,
    stdin: "prompt",
    env: { PATH: "/usr/bin" },
  });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv, ["exec", injectionShapedArg]);
  assert.equal(calls[0].options.shell, false);
});

test("times out an entire Unix process group instead of only the direct child", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows has no negative-PID process-group signal");
    return;
  }
  const signals = [];
  let directChildKills = 0;
  let child;
  function fakeSpawn(_executable, _argv, options) {
    child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { directChildKills += 1; };
    assert.equal(options.detached, true);
    return child;
  }
  const result = await runDirectCommand("codex", ["exec", "-"], {
    spawn: fakeSpawn,
    processGroup: true,
    timeoutMs: 5,
    killProcess(pid, signal) {
      signals.push({ pid, signal });
      setImmediate(() => child.emit("close", null, signal));
    },
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, [{ pid: -4321, signal: "SIGTERM" }]);
  assert.equal(directChildKills, 0);
});

test("prepares cold dependencies with npm ci and no inherited authority", async () => {
  await withTemp(async (root) => {
    const stateDir = join(root, "state");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "package-lock.json"), "{}\n");
    const config = loadSchedulerConfig(environment(stateDir), {
      home: root,
      repositoryRoot: join(root, "repository"),
    });
    const calls = [];
    function fakeSpawn(executable, argv, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      calls.push({ executable, argv, options });
      setImmediate(() => {
        child.stdout.end("installed\n");
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }
    await prepareWorkspaceDependencies(config, { run_id: "run-1" }, workspace, {
      env: {
        PATH: "/usr/bin",
        GH_TOKEN: DEDICATED_GITHUB_TOKEN,
        AGENTRY_RUNNER_API_KEY: RUNNER_KEY,
        OPENAI_API_KEY: "owner-openai-secret",
        NPM_TOKEN: "registry-secret",
      },
      spawn: fakeSpawn,
    });
    assert.equal(calls[0].executable, "npm");
    assert.deepEqual(calls[0].argv, [
      "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
    ]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.detached, process.platform !== "win32");
    for (const key of ["GH_TOKEN", "AGENTRY_RUNNER_API_KEY", "OPENAI_API_KEY", "NPM_TOKEN"]) {
      assert.equal(calls[0].options.env[key], undefined);
    }
    assert.equal(calls[0].options.env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
    assert.equal(calls[0].options.env.NPM_CONFIG_USERCONFIG, process.platform === "win32" ? "NUL" : "/dev/null");
  });
});

test("uses stable response-loss keys and validates exact receipt authority", async () => {
  await withTemp(async (root) => {
    const config = loadSchedulerConfig(environment(join(root, "state")), {
      home: root,
      repositoryRoot: join(root, "repository"),
    });
    const receipt = {
      id: "019f-receipt-1",
      project_id: config.project_id,
      automation_id: config.automation_id,
      status: "ready",
      trigger: {
        kind: "unhandled_cases",
        case_id: "019f-case-1",
        case_revision: 4,
        attempt: 1,
      },
    };
    const state = provisionalStateForReceipt(config, receipt);
    assert.equal(state.claim_request.trigger_receipt_id, receipt.id);
    assert.equal(state.claim_request.claimed_by, config.runnerId);
    assert.equal(state.claim_idempotency_key, stableIdempotencyKey("claim", config.automation_id, receipt.id));
    assert.equal(state.run_idempotency_key, stableIdempotencyKey("run", config.automation_id, receipt.id));
    assert.equal(state.claim_request.lease_seconds, 3_600);

    assert.throws(
      () => provisionalStateForReceipt(config, { ...receipt, project_id: "other-project" }),
      /does not match the frozen self-repair binding/,
    );
  });
});

test("provides an atomic single-owner lock and recovers only a provably dead same-host lock", async () => {
  await withTemp(async (root) => {
    await ensureSecureStateRoot(root);
    const first = await acquireSchedulerLock(root, { hostname: "host-a", pid: 1234, isProcessAlive: () => true });
    await assert.rejects(
      acquireSchedulerLock(root, { hostname: "host-a", pid: 5678, isProcessAlive: () => true }),
      SchedulerBusyError,
    );
    await first.release();

    const lockDir = join(root, "scheduler.lock");
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(join(lockDir, "owner.json"), JSON.stringify({
      schema_version: "1",
      token: "old-token",
      hostname: "host-a",
      pid: 9999,
      acquired_at: 1,
    }), { mode: 0o600 });
    const recovered = await acquireSchedulerLock(root, {
      hostname: "host-a",
      pid: 5678,
      isProcessAlive: () => false,
    });
    assert.equal(recovered.owner.pid, 5678);
    await recovered.release();
  });
});

test("rejects state paths redirected through an ancestor symlink", async () => {
  await withTemp(async (root) => {
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias, "dir");
    await assert.rejects(
      ensureSecureStateRoot(join(alias, "state")),
      /without symlink redirection/,
    );
  });
});

test("writes recovery state mode 0600 and redacts bounded split secrets", async () => {
  await withTemp(async (root) => {
    const path = join(root, "state.json");
    await atomicWriteJson(path, { lease_token: `lease_${"l".repeat(48)}` });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.match(await readFile(path, "utf8"), /lease_/u);

    const secret = `agentry_runner_${"s".repeat(48)}`;
    const log = new BoundedRedactedLog(256, [secret]);
    log.append(`before ${secret.slice(0, 20)}`);
    log.append(`${secret.slice(20)} after ${`action_${"a".repeat(40)}`}`);
    const text = log.finish();
    assert.doesNotMatch(text, new RegExp(secret, "u"));
    assert.doesNotMatch(text, /action_a{10}/u);
    assert.match(text, /<redacted/u);

    const boundarySecret = `agentry_runner_${"b".repeat(48)}`;
    const boundary = new BoundedRedactedLog(4_096, [boundarySecret]);
    boundary.append(`${"x".repeat(1_000)}${boundarySecret}${"y".repeat(1_993)}`);
    const boundaryText = boundary.finish();
    assert.doesNotMatch(boundaryText, new RegExp(boundarySecret, "u"));
    assert.match(boundaryText, /<redacted-exact>/u);

    const huge = new BoundedRedactedLog(64, []);
    huge.append("x".repeat(4_096));
    const bounded = huge.finish();
    assert.ok(Buffer.byteLength(bounded) <= 64);
    assert.equal(huge.truncated, true);
  });
});

test("authenticates direct API reads with the custom User-Agent and runner key", async () => {
  const calls = [];
  const config = {
    apiBase: "https://api.agentry.sh",
    runnerKey: RUNNER_KEY,
  };
  const client = new AgentryRunnerClient(config, {
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(await client.get("/v1/projects/project/automation-runs"), { runs: [] });
  assert.equal(calls[0].options.headers["User-Agent"], SCHEDULER_USER_AGENT);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${RUNNER_KEY}`);
  assert.equal(calls[0].options.redirect, "error");
});

test("handles only known resumable, waiting, and terminal run states", () => {
  assert.equal(selectRunDisposition({ status: "running" }), "invoke_codex");
  assert.equal(selectRunDisposition({ status: "verifying" }), "invoke_codex");
  assert.equal(selectRunDisposition({ status: "awaiting_approval" }), "renew_and_wait");
  assert.equal(selectRunDisposition({ status: "draft_pr_opened" }), "wait");
  assert.equal(selectRunDisposition({ status: "succeeded" }), "terminal");
  assert.throws(() => selectRunDisposition({ status: "queued" }), /cannot be queued/);
  assert.throws(() => selectRunDisposition({ status: "invented" }), /unknown automation run status/);
});

test("redacts dedicated and ambient credential forms from surfaced errors", () => {
  const value = `Bearer ${RUNNER_KEY} ${DEDICATED_GITHUB_TOKEN} ${AMBIENT_GITHUB_TOKEN}`;
  const redacted = redactAutomationText(value, [RUNNER_KEY, DEDICATED_GITHUB_TOKEN, AMBIENT_GITHUB_TOKEN]);
  assert.doesNotMatch(redacted, new RegExp(RUNNER_KEY, "u"));
  assert.doesNotMatch(redacted, new RegExp(DEDICATED_GITHUB_TOKEN, "u"));
  assert.doesNotMatch(redacted, new RegExp(AMBIENT_GITHUB_TOKEN, "u"));
});

test("loads scheduler secrets from fixed Keychain items with direct argv and never prints them", () => {
  const calls = [];
  const secret = `agentry_runner_${"k".repeat(48)}`;
  const observed = readKeychainSecret(AUTOMATION_KEYCHAIN_ITEMS.runner, {
    home: "/Users/operator",
    spawnSync(executable, argv, options) {
      calls.push({ executable, argv, options });
      return { status: 0, stdout: `${secret}\n`, stderr: "" };
    },
  });
  assert.equal(observed, secret);
  assert.equal(calls[0].executable, "/usr/bin/security");
  assert.deepEqual(calls[0].argv, [
    "find-generic-password",
    "-s",
    AUTOMATION_KEYCHAIN_ITEMS.runner.service,
    "-a",
    AUTOMATION_KEYCHAIN_ITEMS.runner.account,
    "-w",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.stdio[1], "pipe");
});

test("Keychain launcher removes ambient owner and GitHub authority before mapping exact secrets", () => {
  const runner = RUNNER_KEY;
  const github = DEDICATED_GITHUB_TOKEN;
  const env = keychainSchedulerEnvironment({
    AGENTRY_PRIVATE_API_KEY: `agentry_sk_${"o".repeat(48)}`,
    AGENTRY_CI_API_KEY: `agentry_ci_${"c".repeat(48)}`,
    AGENTRY_SERVER_API_KEY: `agentry_server_${"s".repeat(48)}`,
    GH_TOKEN: AMBIENT_GITHUB_TOKEN,
    GITHUB_TOKEN: AMBIENT_GITHUB_TOKEN,
    PATH: "/usr/bin",
  }, { runner, github });
  assert.equal(env.AGENTRY_RUNNER_API_KEY, runner);
  assert.equal(env.AGENTRY_AUTOMATION_GITHUB_TOKEN, github);
  assert.equal(env.AGENTRY_PRIVATE_API_KEY, undefined);
  assert.equal(env.AGENTRY_CI_API_KEY, undefined);
  assert.equal(env.AGENTRY_SERVER_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});
