import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  API_WORKER_NAME,
  API_WORKER_TARGET,
  BOOTSTRAP_CI_ATTRIBUTION_FLAG,
  DEFAULT_MAINTENANCE_DRAIN_SECONDS,
  MAINTENANCE_PROOF_CONSECUTIVE,
  MAINTENANCE_PROOF_INTERVAL_MS,
  MAINTENANCE_PROOF_MAX_ATTEMPTS,
  REVIEWED_LEGACY_BASELINE_FLAG,
  openBootstrapCredentialSink,
  prepareBootstrapCredentialFilePath,
  runAgentryDeploy,
} from "./deploy-agentry.mjs";
import {
  AUTOMATION_RUN_ID_ENV,
  AUTOMATION_SOURCE_COMMIT_SHA_ENV,
} from "./tag-agentry-deploy.mjs";

const ROOT = "/release/repo";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const STALE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FOREIGN_SHA = "ffffffffffffffffffffffffffffffffffffffff";
const MESSAGE = "Ship exact release";
const MAINTENANCE_ID = "core-test-maintenance-0001";
const CI_KEY = `agentry_ci_018f0000-0000-7000-8000-000000000001.${"a".repeat(32)}`;
const PROJECT_ID = "018f0000-0000-7000-8000-000000000001";
const OWNER_KEY = `agentry_sk_${"b".repeat(32)}`;
const SOURCE_FINGERPRINT = "c".repeat(64);
const ONBOARDING_PROOF = `agentry_proof_ci_${"p".repeat(43)}`;
const AUTOMATION_RUN_ID = "018f0000-0000-7000-8000-000000000042";
const AUTOMATION_SOURCE_SHA = "dddddddddddddddddddddddddddddddddddddddd";
const WORKER_VERSION_IDS = Object.freeze([
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
]);

function commandKey(file, args) {
  return `${file} ${args.join(" ")}`;
}

function harness({
  branch = "main",
  status = "",
  fail = () => false,
  fetchSequence = [resumedSmokeResponse()],
  env = {},
  bootstrapFile = null,
  bootstrapEligibilityOutput = JSON.stringify({
    ok: true,
    eligibility: "untracked_legacy_first_ci_credential",
    adoption_state: "untracked_legacy",
    project_id: PROJECT_ID,
    owner_key_binding: "active_private_project_owner",
    project_credentials: "missing",
  }),
  repoRoot = ROOT,
  wranglerOutput = ({ index }) => ({
    type: "deploy",
    version: 1,
    worker_name: API_WORKER_NAME,
    version_id: WORKER_VERSION_IDS[index] ?? `worker-version-${index}`,
    targets: [API_WORKER_TARGET],
  }),
} = {}) {
  const calls = [];
  const fetchCalls = [];
  const waits = [];
  const stdout = [];
  const stderr = [];
  const timeline = [];
  const bootstrapWrites = [];
  const bootstrapOpens = [];
  let bootstrapCloses = 0;
  let fetchIndex = 0;
  let workerDeployIndex = 0;
  const runCommand = (file, args, options) => {
    const call = { file, args: [...args], cwd: options.cwd, env: options.env, capture: options.capture === true };
    calls.push(call);
    timeline.push({ type: "command", call });
    const key = commandKey(file, args);
    if (fail(call, key)) return { status: 1, stdout: "", stderr: "private failure" };
    if (file === "git") {
      if (args[0] === "symbolic-ref") return { status: 0, stdout: `${branch}\n`, stderr: "" };
      if (args[0] === "rev-parse") return { status: 0, stdout: `${SHA}\n`, stderr: "" };
      if (args[0] === "log") return { status: 0, stdout: `${MESSAGE}\n`, stderr: "" };
      if (args[0] === "status") return { status: 0, stdout: status, stderr: "" };
    }
    if (file === process.execPath && args[0]?.endsWith("verify-ci-attribution-bootstrap-eligibility.mjs")) {
      return { status: 0, stdout: `${bootstrapEligibilityOutput}\n`, stderr: "" };
    }
    const wranglerIndex = args.indexOf("wrangler");
    if (
      file === "npx"
      && wranglerIndex >= 0
      && args[wranglerIndex + 1] === "deploy"
      && options.env.WRANGLER_OUTPUT_FILE_PATH
    ) {
      call.wranglerOutputMode = statSync(options.env.WRANGLER_OUTPUT_FILE_PATH).mode & 0o777;
      const output = wranglerOutput({ index: workerDeployIndex, call });
      workerDeployIndex += 1;
      if (output !== null) {
        const lines = Array.isArray(output) ? output : [output];
        writeFileSync(
          options.env.WRANGLER_OUTPUT_FILE_PATH,
          `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
          { mode: 0o600 },
        );
      }
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    timeline.push({ type: "fetch", url, options });
    const response = fetchSequence[Math.min(fetchIndex, fetchSequence.length - 1)];
    fetchIndex += 1;
    if (response instanceof Error) throw response;
    if (!response) throw new Error("unexpected fetch");
    return response;
  };
  return {
    calls,
    fetchCalls,
    waits,
    stdout,
    stderr,
    timeline,
    bootstrapWrites,
    bootstrapOpens,
    get bootstrapCloses() { return bootstrapCloses; },
    options: {
      env: {
        AGENTRY_CI_API_KEY: CI_KEY,
        AGENTRY_SOURCE_FINGERPRINT_SHA256: SOURCE_FINGERPRINT,
        ...env,
      },
      repoRoot,
      runCommand,
      fetchImpl,
      wait: async (ms) => { waits.push(ms); },
      maintenanceIdFactory: () => MAINTENANCE_ID,
      prepareBootstrapCredentialFile: bootstrapFile
        ? (value, repoRoot) => {
            assert.equal(value, bootstrapFile);
            assert.equal(repoRoot, ROOT);
            return bootstrapFile;
          }
        : undefined,
      openBootstrapCredentialFile: bootstrapFile
        ? (path) => {
            bootstrapOpens.push(path);
            timeline.push({ type: "bootstrap_open", path });
            return {
              write(credential) {
                bootstrapWrites.push(credential);
                timeline.push({ type: "bootstrap_write" });
              },
              close() {
                bootstrapCloses += 1;
                timeline.push({ type: "bootstrap_close" });
              },
            };
          }
        : undefined,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

test("every mode refuses missing or malformed attribution authority before provider mutation", async (t) => {
  for (const mode of ["api", "auth", "redirect", "api-core-migration"]) {
    for (const value of [undefined, "agentry_ci_bad.short"]) {
      await t.test(`${mode}: ${String(value)}`, async () => {
        const run = harness({ env: { AGENTRY_CI_API_KEY: value } });
        const code = await runAgentryDeploy({ mode, ...run.options });
        assert.equal(code, 1);
        assert.equal(providerCalls(run.calls).length, 0);
        assert.equal(run.fetchCalls.length, 0);
        assert.match(run.stderr.join("\n"), /strict deploy attribution environment is invalid/);
      });
    }
  }
});

test("every mode rejects an incomplete or malformed automation binding before provider mutation", async (t) => {
  const invalidBindings = [
    {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: undefined,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: undefined,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: SHA,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: "not-an-automation-run",
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: SHA,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: "a".repeat(39),
    },
  ];
  for (const mode of ["api", "auth", "redirect", "api-core-migration"]) {
    for (const binding of invalidBindings) {
      await t.test(`${mode}: ${JSON.stringify(binding)}`, async () => {
        const run = harness({ env: binding });
        const code = await runAgentryDeploy({ mode, ...run.options });
        assert.equal(code, 1);
        assert.equal(providerCalls(run.calls).length, 0);
        assert.equal(
          run.calls.some(({ file, args }) =>
            file === "npm" && args.join(" ") === "run release:verify"),
          false,
        );
        assert.match(run.stderr.join("\n"), /optional automation deploy binding is invalid/);
        assert.doesNotMatch(run.stderr.join("\n"), new RegExp(CI_KEY));
      });
    }
  }
});

test("forwards a distinct PR-head binding only to post-success deploy attribution", async () => {
  assert.notEqual(AUTOMATION_SOURCE_SHA, SHA);
  const run = harness({
    env: {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA.toUpperCase(),
      AGENTRY_RUNNER_API_KEY: "runner-secret-must-not-reach-release-children",
    },
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 0, run.stderr.join("\n"));

  const attribution = run.calls.find(({ file, args }) =>
    file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"));
  assert.ok(attribution);
  assert.equal(attribution.env[AUTOMATION_RUN_ID_ENV], AUTOMATION_RUN_ID);
  assert.equal(
    attribution.env[AUTOMATION_SOURCE_COMMIT_SHA_ENV],
    AUTOMATION_SOURCE_SHA.toUpperCase(),
  );
  assert.equal(attribution.env.AGENTRY_RUNNER_API_KEY, undefined);

  for (const call of run.calls.filter((candidate) => candidate !== attribution)) {
    assert.equal(call.env[AUTOMATION_RUN_ID_ENV], undefined);
    assert.equal(call.env[AUTOMATION_SOURCE_COMMIT_SHA_ENV], undefined);
    assert.equal(call.env.AGENTRY_RUNNER_API_KEY, undefined);
  }
});

function providerCalls(calls) {
  return calls.filter(({ file, args }) =>
    (file === "npx" && args.includes("wrangler"))
    || (file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")));
}

function successfulMaintenanceResponses() {
  return Array.from({ length: MAINTENANCE_PROOF_CONSECUTIVE }, () => new Response("paused", {
    status: 503,
    headers: { "x-agentry-maintenance-id": MAINTENANCE_ID },
  }));
}

function resumedSmokeResponse(deploySha = SHA) {
  return new Response(JSON.stringify({ name: "Agentry", deploy_sha: deploySha }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function repeatedSmokeResponses(deploySha, count = MAINTENANCE_PROOF_MAX_ATTEMPTS) {
  return Array.from({ length: count }, () => resumedSmokeResponse(deploySha));
}

function bootstrapInventoryResponse(credentials = []) {
  return new Response(JSON.stringify({ credentials }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bootstrapCredentialResponse(overrides = {}) {
  return new Response(JSON.stringify({
    id: "credential-bootstrap",
    project_id: PROJECT_ID,
    kind: "ci_deploy",
    env_var: "AGENTRY_CI_API_KEY",
    active: true,
    idempotent_replay: false,
    credential: CI_KEY,
    ...overrides,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("every mode refuses a wrong branch or dirty tree before a provider call", async (t) => {
  for (const mode of ["api", "auth", "redirect", "api-core-migration"]) {
    await t.test(`${mode}: wrong branch`, async () => {
      const run = harness({ branch: "feature/release" });
      const code = await runAgentryDeploy({ mode, ...run.options });
      assert.equal(code, 1);
      assert.equal(providerCalls(run.calls).length, 0);
      assert.match(run.stderr.join("\n"), /branch to be exactly main/);
    });
    await t.test(`${mode}: dirty tree`, async () => {
      const run = harness({ status: "?? untracked-release-file\n" });
      const code = await runAgentryDeploy({ mode, ...run.options });
      assert.equal(code, 1);
      assert.equal(providerCalls(run.calls).length, 0);
      assert.match(run.stderr.join("\n"), /clean tracked and untracked working tree/);
      assert.doesNotMatch(run.stderr.join("\n"), /untracked-release-file/);
    });
  }
});

test("api verifies core DB, deploys strict maintenance-off Worker, and attributes exact HEAD", async () => {
  const run = harness({
    env: {
      AGENTRY_ENVIRONMENT: "development",
      AGENTRY_DEPLOY_ENVIRONMENT: "staging",
      AGENTRY_ONBOARDING_PROOF: ONBOARDING_PROOF,
      AGENTRY_SERVER_API_KEY: "server-secret-must-stay-provider-managed",
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_PUBLIC_API_KEY: "public-key-must-not-reach-children",
      AGENTRY_RUNNER_API_KEY: "runner-key-must-not-reach-children",
      TURSO_DATABASE_URL: "libsql://production.example.test",
      TURSO_AUTH_TOKEN: "database-token",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      CF_ACCOUNT_ID: "legacy-cloudflare-account",
      CF_API_TOKEN: "legacy-cloudflare-token",
      CF_API_KEY: "legacy-cloudflare-global-key",
      CF_EMAIL: "legacy-cloudflare@example.test",
      UNRELATED_RELEASE_SECRET: "unrelated-secret",
    },
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 0);

  const releaseGates = run.calls.filter(({ file, args }) =>
    file === "npm" && args.join(" ") === "run release:verify");
  const verify = run.calls.find(({ file, args }) =>
    file === "npm" && args.join(" ") === "-w @agentry/db run db:verify:core");
  const worker = run.calls.find(({ file, args }) => file === "npx" && args.includes("deploy"));
  const attribution = run.calls.find(({ file, args }) =>
    file === process.execPath && args[0] === `${ROOT}/scripts/tag-agentry-deploy.mjs`);
  assert.equal(releaseGates.length, 1);
  assert.ok(verify);
  assert.deepEqual(worker.args, [
    "--no-install",
    "wrangler",
    "deploy",
    "--strict",
    "--var",
    `AGENTRY_DEPLOY_SHA:${SHA}`,
    "--var",
    "AGENTRY_CORE_DB_MAINTENANCE:off",
    "--message",
    MESSAGE,
  ]);
  assert.equal(worker.cwd, `${ROOT}/apps/api`);
  assert.equal(worker.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(worker.env.AGENTRY_CORE_DB_MAINTENANCE, "off");
  assert.equal(worker.env.AGENTRY_ENVIRONMENT, "production");
  assert.equal(worker.env.AGENTRY_DEPLOY_ENVIRONMENT, "production");
  assert.equal(worker.env.CLOUDFLARE_API_TOKEN, "cloudflare-token");
  assert.equal(worker.env.CF_ACCOUNT_ID, "legacy-cloudflare-account");
  assert.equal(worker.env.CF_API_TOKEN, "legacy-cloudflare-token");
  assert.equal(worker.env.CF_API_KEY, "legacy-cloudflare-global-key");
  assert.equal(worker.env.CF_EMAIL, "legacy-cloudflare@example.test");
  assert.equal(worker.env.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(worker.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
  assert.equal(worker.env.WRANGLER_LOG_SANITIZE, "true");
  assert.equal(worker.env.WRANGLER_OUTPUT_FILE_PATH.startsWith(`${ROOT}/`), false);
  assert.equal(worker.wranglerOutputMode, 0o600);
  assert.equal(existsSync(worker.env.WRANGLER_OUTPUT_FILE_PATH), false);
  assert.equal(worker.env.AGENTRY_SERVER_API_KEY, undefined);
  assert.equal(worker.env.AGENTRY_CI_API_KEY, undefined);
  assert.equal(worker.env.AGENTRY_PRIVATE_API_KEY, undefined);
  assert.equal(worker.env.AGENTRY_ONBOARDING_PROOF, undefined);
  assert.equal(worker.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, undefined);
  assert.equal(worker.env.TURSO_AUTH_TOKEN, undefined);
  assert.equal(worker.env.UNRELATED_RELEASE_SECRET, undefined);
  assert.ok(run.calls.indexOf(releaseGates[0]) < run.calls.indexOf(verify));
  assert.ok(run.calls.indexOf(verify) < run.calls.indexOf(worker));
  assert.ok(attribution);
  assert.equal(attribution.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(attribution.env.AGENTRY_ENVIRONMENT, "production");
  assert.equal(attribution.env.AGENTRY_DEPLOY_ENVIRONMENT, "production");
  assert.equal(attribution.env.GITHUB_REF_NAME, "main");
  assert.equal(attribution.env.AGENTRY_PROVIDER_DEPLOYMENT_ID, WORKER_VERSION_IDS[0]);
  assert.equal(attribution.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, SOURCE_FINGERPRINT);
  assert.equal(attribution.env.AGENTRY_ONBOARDING_PROOF, ONBOARDING_PROOF);
  assert.equal(attribution.env.AGENTRY_CI_API_KEY, CI_KEY);
  assert.equal(attribution.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(attribution.env.CF_ACCOUNT_ID, undefined);
  assert.equal(attribution.env.CF_API_TOKEN, undefined);
  assert.equal(attribution.env.CF_API_KEY, undefined);
  assert.equal(attribution.env.CF_EMAIL, undefined);
  assert.equal(attribution.env.AGENTRY_SERVER_API_KEY, undefined);
  assert.equal(attribution.env.AGENTRY_PRIVATE_API_KEY, undefined);
  assert.equal(attribution.env.TURSO_AUTH_TOKEN, undefined);
  assert.equal(attribution.env.UNRELATED_RELEASE_SECRET, undefined);
  const buildAndTestCalls = run.calls.filter(({ file, args }) =>
    file === "git"
    || file === "npm" && !args.includes("@agentry/db")
    || file === process.execPath && args[0]?.endsWith("gen-workflow-manifest.mjs"));
  for (const call of buildAndTestCalls) {
    assert.equal(call.env.AGENTRY_CI_API_KEY, undefined);
    assert.equal(call.env.AGENTRY_SERVER_API_KEY, undefined);
    assert.equal(call.env.AGENTRY_PRIVATE_API_KEY, undefined);
    assert.equal(call.env.AGENTRY_PUBLIC_API_KEY, undefined);
    assert.equal(call.env.AGENTRY_RUNNER_API_KEY, undefined);
    assert.equal(call.env.AGENTRY_ONBOARDING_PROOF, undefined);
    assert.equal(call.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, undefined);
    assert.equal(call.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(call.env.CF_ACCOUNT_ID, undefined);
    assert.equal(call.env.CF_API_TOKEN, undefined);
    assert.equal(call.env.CF_API_KEY, undefined);
    assert.equal(call.env.CF_EMAIL, undefined);
    assert.equal(call.env.TURSO_AUTH_TOKEN, undefined);
  }
  assert.equal(verify.env.TURSO_DATABASE_URL, "libsql://production.example.test");
  assert.equal(verify.env.TURSO_AUTH_TOKEN, "database-token");
  assert.equal(verify.env.AGENTRY_CI_API_KEY, undefined);
  assert.equal(verify.env.AGENTRY_SERVER_API_KEY, undefined);
  assert.equal(verify.env.AGENTRY_ONBOARDING_PROOF, undefined);
  assert.ok(run.calls.indexOf(worker) < run.calls.indexOf(attribution));
  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.fetchCalls[0].url, "https://api.agentry.sh/");
  assert.equal(run.fetchCalls[0].options.method, "GET");
  const workerIndex = run.timeline.findIndex(({ type, call }) => type === "command" && call === worker);
  const smokeIndex = run.timeline.findIndex(({ type }) => type === "fetch");
  const attributionIndex = run.timeline.findIndex(({ type, call }) => type === "command" && call === attribution);
  assert.ok(workerIndex < smokeIndex && smokeIndex < attributionIndex);
});

test("API releases require the final source fingerprint before Cloudflare mutation", async (t) => {
  for (const mode of ["api", "api-core-migration"]) {
    await t.test(mode, async () => {
      const run = harness({
        env: { AGENTRY_SOURCE_FINGERPRINT_SHA256: undefined },
      });
      const code = await runAgentryDeploy({ mode, ...run.options });
      assert.equal(code, 1);
      assert.equal(providerCalls(run.calls).length, 0);
      assert.match(run.stderr.join("\n"), /strict deploy attribution|final source snapshot/);
    });
  }
});

test("an invalid CI proof marker is rejected before Cloudflare mutation", async () => {
  const run = harness({
    env: { AGENTRY_ONBOARDING_PROOF: "agentry_proof_runtime_wrong-boundary" },
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 1);
  assert.equal(providerCalls(run.calls).length, 0);
  assert.match(run.stderr.join("\n"), /strict deploy attribution environment is invalid/);
});

test("API attribution fails closed when Wrangler omits or corrupts its deploy receipt", async (t) => {
  const cases = [
    ["missing", () => null],
    ["wrong type", () => ({ type: "command-failed", version: 1 })],
    ["missing version", () => ({
      type: "deploy",
      version: 1,
      worker_name: API_WORKER_NAME,
      targets: [API_WORKER_TARGET],
    })],
    ["wrong worker", () => ({
      type: "deploy",
      version: 1,
      worker_name: "unrelated-worker",
      version_id: WORKER_VERSION_IDS[0],
      targets: [API_WORKER_TARGET],
    })],
    ["wrong production target", () => ({
      type: "deploy",
      version: 1,
      worker_name: API_WORKER_NAME,
      version_id: WORKER_VERSION_IDS[0],
      targets: ["preview.agentry.workers.dev"],
    })],
    ["multiple deploys", () => [
      {
        type: "deploy",
        version: 1,
        worker_name: API_WORKER_NAME,
        version_id: WORKER_VERSION_IDS[0],
        targets: [API_WORKER_TARGET],
      },
      {
        type: "deploy",
        version: 1,
        worker_name: API_WORKER_NAME,
        version_id: WORKER_VERSION_IDS[1],
        targets: [API_WORKER_TARGET],
      },
    ]],
  ];
  for (const [name, wranglerOutput] of cases) {
    await t.test(name, async () => {
      const run = harness({ wranglerOutput });
      const code = await runAgentryDeploy({ mode: "api", ...run.options });
      assert.equal(code, 1);
      assert.equal(
        run.calls.filter(({ file, args }) => file === "npx" && args.includes("deploy")).length,
        1,
      );
      assert.equal(
        run.calls.some(({ file, args }) =>
          file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")),
        false,
      );
      assert.match(run.stderr.join("\n"), /Wrangler/);
    });
  }
});

test("same-SHA cleanup release attributes the new Cloudflare Worker version", async () => {
  const first = harness();
  const cleanupVersion = "33333333-3333-4333-8333-333333333333";
  const cleanup = harness({
    wranglerOutput: () => ({
      type: "deploy",
      version: 1,
      worker_name: API_WORKER_NAME,
      version_id: cleanupVersion,
      targets: [API_WORKER_TARGET],
    }),
  });
  assert.equal(await runAgentryDeploy({ mode: "api", ...first.options }), 0);
  assert.equal(await runAgentryDeploy({ mode: "api", ...cleanup.options }), 0);
  const firstTag = first.calls.find(({ file, args }) =>
    file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"));
  const cleanupTag = cleanup.calls.find(({ file, args }) =>
    file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"));
  assert.equal(firstTag.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(cleanupTag.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(firstTag.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, SOURCE_FINGERPRINT);
  assert.equal(cleanupTag.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, SOURCE_FINGERPRINT);
  assert.equal(firstTag.env.AGENTRY_PROVIDER_DEPLOYMENT_ID, WORKER_VERSION_IDS[0]);
  assert.equal(cleanupTag.env.AGENTRY_PROVIDER_DEPLOYMENT_ID, cleanupVersion);
});

test("ordinary API release waits through stale and foreign roots before attributing the exact SHA", async () => {
  const run = harness({
    fetchSequence: [
      resumedSmokeResponse(STALE_SHA),
      resumedSmokeResponse(FOREIGN_SHA),
      resumedSmokeResponse(),
    ],
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 0, run.stderr.join("\n"));
  assert.equal(run.fetchCalls.length, 3);
  assert.deepEqual(run.waits, [MAINTENANCE_PROOF_INTERVAL_MS, MAINTENANCE_PROOF_INTERVAL_MS]);
  assert.equal(
    run.calls.filter(({ file, args }) =>
      file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")).length,
    1,
  );
});

test("ordinary API release fails closed when foreign SHA propagation exhausts", async () => {
  const run = harness({
    fetchSequence: repeatedSmokeResponses(FOREIGN_SHA),
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 1);
  assert.equal(run.fetchCalls.length, MAINTENANCE_PROOF_MAX_ATTEMPTS);
  assert.deepEqual(
    run.waits,
    Array.from(
      { length: MAINTENANCE_PROOF_MAX_ATTEMPTS - 1 },
      () => MAINTENANCE_PROOF_INTERVAL_MS,
    ),
  );
  assert.equal(
    run.calls.filter(({ file, args }) => file === "npx" && args.includes("deploy")).length,
    1,
  );
  assert.equal(
    run.calls.some(({ file, args }) =>
      file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")),
    false,
  );
  assert.match(run.stderr.join("\n"), /exact release SHA/);
});

test("ordinary API release fails closed when non-200 propagation responses exhaust", async () => {
  const run = harness({
    fetchSequence: Array.from(
      { length: MAINTENANCE_PROOF_MAX_ATTEMPTS },
      () => new Response("temporarily unavailable", { status: 503 }),
    ),
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 1);
  assert.equal(run.fetchCalls.length, MAINTENANCE_PROOF_MAX_ATTEMPTS);
  assert.equal(run.waits.length, MAINTENANCE_PROOF_MAX_ATTEMPTS - 1);
  assert.equal(
    run.calls.some(({ file, args }) =>
      file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")),
    false,
  );
  assert.match(run.stderr.join("\n"), /did not return HTTP 200.*bounded propagation window/);
});

test("the API npm lifecycle cannot bypass release verification or preparation", () => {
  const packageJson = JSON.parse(readFileSync(
    new URL("../apps/api/package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(packageJson.scripts.predeploy, undefined);
  assert.equal(packageJson.scripts.deploy, "node ../../scripts/deploy-agentry.mjs api");
  assert.doesNotMatch(packageJson.scripts.deploy, /prepared/i);
});

test("a failed complete release gate causes no provider or attribution mutation", async () => {
  const run = harness({
    fail: ({ file, args }) =>
      file === "npm" && args.join(" ") === "run release:verify",
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 1);
  assert.equal(providerCalls(run.calls).length, 0);
  assert.equal(run.fetchCalls.length, 0);
  assert.match(run.stderr.join("\n"), /complete release verification failed/);
});

test("auth builds and deploys exact clean main metadata before attribution", async () => {
  const run = harness({
    env: {
      AGENTRY_ENVIRONMENT: "development",
      AGENTRY_DEPLOY_ENVIRONMENT: "staging",
    },
  });
  const code = await runAgentryDeploy({ mode: "auth", ...run.options });
  assert.equal(code, 0);
  const releaseGates = run.calls.filter(({ file, args }) =>
    file === "npm" && args.join(" ") === "run release:verify");
  const build = run.calls.find(({ file, args }) =>
    file === "npm" && args.join(" ") === "-w @agentry/auth run build");
  const pages = run.calls.find(({ file, args }) => file === "npx");
  assert.equal(releaseGates.length, 1);
  assert.ok(build);
  assert.deepEqual(pages.args, [
    "--no-install",
    "wrangler",
    "pages",
    "deploy",
    "./dist",
    "--project-name",
    "agentry-auth",
    "--branch",
    "main",
    "--commit-hash",
    SHA,
    "--commit-message",
    MESSAGE,
    "--commit-dirty=false",
  ]);
  assert.equal(pages.cwd, `${ROOT}/apps/auth`);
  assert.equal(pages.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(pages.env.GITHUB_REF_NAME, "main");
  assert.equal(pages.env.AGENTRY_ENVIRONMENT, "production");
  assert.equal(pages.env.AGENTRY_DEPLOY_ENVIRONMENT, "production");
  assert.ok(run.calls.indexOf(releaseGates[0]) < run.calls.indexOf(build));
  assert.ok(run.calls.indexOf(build) < run.calls.indexOf(pages));
  const attribution = run.calls.find(({ file, args }) =>
    file === process.execPath && args[0] === `${ROOT}/scripts/tag-agentry-deploy.mjs`);
  assert.ok(attribution);
  assert.equal(attribution.env.AGENTRY_ENVIRONMENT, "production");
  assert.equal(attribution.env.AGENTRY_DEPLOY_ENVIRONMENT, "production");
});

test("redirect builds and deploys the apex Worker before attribution", async () => {
  const run = harness();
  const code = await runAgentryDeploy({ mode: "redirect", ...run.options });
  assert.equal(code, 0, run.stderr.join("\n"));

  const build = run.calls.find(({ file, args }) =>
    file === "npm" && args.join(" ") === "-w @agentry/redirect run build");
  const worker = run.calls.find(({ file, args, cwd }) =>
    file === "npx" && cwd === `${ROOT}/apps/redirect` && args.includes("deploy"));
  const attribution = run.calls.find(({ file, args }) =>
    file === process.execPath && args[0] === `${ROOT}/scripts/tag-agentry-deploy.mjs`);

  assert.ok(build);
  assert.ok(worker);
  assert.deepEqual(worker.args, [
    "--no-install",
    "wrangler",
    "deploy",
    "--strict",
    "--message",
    MESSAGE,
  ]);
  assert.equal(worker.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(worker.env.GITHUB_REF_NAME, "main");
  assert.ok(attribution);
  assert.ok(run.calls.indexOf(build) < run.calls.indexOf(worker));
  assert.ok(run.calls.indexOf(worker) < run.calls.indexOf(attribution));
});

test("api-core-migration proves maintenance, drains, migrates and verifies, then resumes the identical candidate", async () => {
  assert.equal(DEFAULT_MAINTENANCE_DRAIN_SECONDS, 60);
  const responses = [
    ...successfulMaintenanceResponses(),
    new Response(JSON.stringify({ name: "Agentry", deploy_sha: SHA }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const run = harness({
    env: {
      AGENTRY_MAINTENANCE_API_URL: "https://api.agentry.sh/",
      AGENTRY_MAINTENANCE_DRAIN_SECONDS: "7",
    },
    fetchSequence: responses,
  });
  const code = await runAgentryDeploy({ mode: "api-core-migration", ...run.options });
  assert.equal(code, 0);

  const releaseGates = run.calls.filter(({ file, args }) =>
    file === "npm" && args.join(" ") === "run release:verify");
  const workers = run.calls.filter(({ file, args }) => file === "npx" && args.includes("deploy"));
  assert.equal(releaseGates.length, 1);
  assert.equal(workers.length, 2);
  assert.ok(run.calls.indexOf(releaseGates[0]) < run.calls.indexOf(workers[0]));
  const pausedArgs = workers[0].args;
  const resumedArgs = workers[1].args;
  assert.deepEqual(
    pausedArgs.map((value) => value === `AGENTRY_CORE_DB_MAINTENANCE:${MAINTENANCE_ID}` ? "MAINTENANCE" : value),
    resumedArgs.map((value) => value === "AGENTRY_CORE_DB_MAINTENANCE:off" ? "MAINTENANCE" : value),
  );
  assert.equal(workers[0].env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(workers[0].env.AGENTRY_CORE_DB_MAINTENANCE, MAINTENANCE_ID);
  assert.equal(workers[1].env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(workers[1].env.AGENTRY_CORE_DB_MAINTENANCE, "off");
  assert.equal(workers[0].wranglerOutputMode, 0o600);
  assert.equal(workers[1].wranglerOutputMode, 0o600);
  assert.notEqual(
    workers[0].env.WRANGLER_OUTPUT_FILE_PATH,
    workers[1].env.WRANGLER_OUTPUT_FILE_PATH,
  );

  const databaseCalls = run.calls.filter(({ file, args }) =>
    file === "npm" && args.includes("@agentry/db") && args.some((arg) => arg.startsWith("db:")));
  assert.deepEqual(databaseCalls.map(({ args }) => args.at(-1)), [
    "db:migrate:core",
    "db:verify:core",
  ]);
  for (const call of databaseCalls) {
    assert.equal(call.env.AGENTRY_MAINTENANCE_API_URL, "https://api.agentry.sh/");
    assert.equal(call.env.AGENTRY_MAINTENANCE_ID, MAINTENANCE_ID);
    assert.equal(call.env.AGENTRY_DEPLOY_SHA, SHA);
    assert.equal(call.env.AGENTRY_CI_API_KEY, undefined);
    assert.equal(call.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, undefined);
  }
  const attribution = run.calls.find(({ file, args }) =>
    file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"));
  assert.equal(attribution.env.AGENTRY_PROVIDER_DEPLOYMENT_ID, WORKER_VERSION_IDS[1]);
  assert.equal(attribution.env.AGENTRY_SOURCE_FINGERPRINT_SHA256, SOURCE_FINGERPRINT);
  assert.equal(run.fetchCalls.length, MAINTENANCE_PROOF_CONSECUTIVE + 1);
  for (const call of run.fetchCalls.slice(0, MAINTENANCE_PROOF_CONSECUTIVE)) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.redirect, "manual");
    assert.equal(call.options.headers["cache-control"], "no-store");
  }
  assert.deepEqual(run.waits, [2_000, 2_000, 7_000]);
});

test("maintenance proof waits through a previously paused deployment until the exact candidate is stable", async () => {
  const previousMaintenanceId = "core-aaaaaaaaaaaa-1111111111111111";
  const previousResponses = Array.from({ length: 2 }, () => new Response("previously paused", {
    status: 503,
    headers: { "x-agentry-maintenance-id": previousMaintenanceId },
  }));
  const run = harness({
    env: {
      AGENTRY_MAINTENANCE_API_URL: "https://api.agentry.sh/",
      AGENTRY_MAINTENANCE_DRAIN_SECONDS: "1",
    },
    fetchSequence: [
      ...previousResponses,
      ...successfulMaintenanceResponses(),
      resumedSmokeResponse(),
    ],
  });

  const code = await runAgentryDeploy({ mode: "api-core-migration", ...run.options });
  assert.equal(code, 0, run.stderr.join("\n"));
  assert.equal(run.fetchCalls.length, 2 + MAINTENANCE_PROOF_CONSECUTIVE + 1);
  assert.deepEqual(run.waits, [2_000, 2_000, 2_000, 2_000, 1_000]);
  assert.equal(
    run.calls.filter(({ file, args }) => file === "npm" && args.includes("db:migrate:core")).length,
    1,
  );
});

test("reviewed legacy baseline authority is an explicit flag and environment pair passed only to migration", async (t) => {
  const invalid = [
    {
      name: "flag without review reference",
      options: { reviewedLegacyBaseline: true },
      env: {},
    },
    {
      name: "review reference without flag",
      options: {},
      env: { AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:change-1234" },
    },
    {
      name: "malformed review reference",
      options: { reviewedLegacyBaseline: true },
      env: { AGENTRY_LEGACY_BASELINE_REVIEW_REF: "short" },
    },
  ];
  for (const item of invalid) {
    await t.test(item.name, async () => {
      const run = harness({ env: item.env });
      const code = await runAgentryDeploy({
        mode: "api-core-migration",
        ...item.options,
        ...run.options,
      });
      assert.equal(code, 1);
      assert.equal(providerCalls(run.calls).length, 0);
      assert.equal(run.fetchCalls.length, 0);
      assert.match(run.stderr.join("\n"), /reviewed-legacy-baseline|LEGACY_BASELINE_REVIEW_REF/);
    });
  }

  const wrongMode = harness({
    env: { AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:change-1234" },
  });
  assert.equal(await runAgentryDeploy({
    mode: "api",
    reviewedLegacyBaseline: true,
    ...wrongMode.options,
  }), 1);
  assert.equal(providerCalls(wrongMode.calls).length, 0);

  const run = harness({
    env: { AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:change-1234" },
    fetchSequence: [...successfulMaintenanceResponses(), resumedSmokeResponse()],
  });
  const code = await runAgentryDeploy({
    mode: "api-core-migration",
    reviewedLegacyBaseline: true,
    ...run.options,
  });
  assert.equal(code, 0);
  const databaseCalls = run.calls.filter(({ file, args }) =>
    file === "npm" && args.includes("@agentry/db") && args.some((arg) => arg.startsWith("db:")));
  assert.deepEqual(databaseCalls.map(({ args }) => args), [
    ["-w", "@agentry/db", "run", "db:migrate:core", "--", REVIEWED_LEGACY_BASELINE_FLAG],
    ["-w", "@agentry/db", "run", "db:verify:core"],
  ]);
  assert.equal(
    databaseCalls[0].env.AGENTRY_LEGACY_BASELINE_REVIEW_REF,
    "backup:change-1234",
  );
});

test("one-time bootstrap migrates and verifies, resumes exact SHA, captures the first CI key, then attributes that SHA", async () => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const run = harness({
    bootstrapFile,
    env: {
      AGENTRY_CI_API_KEY: undefined,
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
      AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:production-cutover-1234",
      TURSO_DATABASE_URL: "libsql://production.example.test",
      TURSO_AUTH_TOKEN: "database-token-must-stay-in-db-children",
      UNRELATED_RELEASE_SECRET: "must-not-reach-bootstrap-child",
    },
    fetchSequence: [
      ...successfulMaintenanceResponses(),
      resumedSmokeResponse(),
      bootstrapInventoryResponse(),
      bootstrapCredentialResponse(),
    ],
  });
  const code = await runAgentryDeploy({
    mode: "api-core-migration",
    reviewedLegacyBaseline: true,
    bootstrapCiAttribution: true,
    ...run.options,
  });
  assert.equal(code, 0, run.stderr.join("\n"));

  const workers = run.calls.filter(({ file, args }) => file === "npx" && args.includes("deploy"));
  assert.equal(workers.length, 2);
  assert.equal(workers[0].env.AGENTRY_CORE_DB_MAINTENANCE, MAINTENANCE_ID);
  assert.equal(workers[1].env.AGENTRY_CORE_DB_MAINTENANCE, "off");
  assert.equal(workers[0].env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(workers[1].env.AGENTRY_DEPLOY_SHA, SHA);
  const eligibilityIndex = run.timeline.findIndex(({ type, call }) =>
    type === "command"
    && call.file === process.execPath
    && call.args[0]?.endsWith("verify-ci-attribution-bootstrap-eligibility.mjs"));
  const firstWorkerIndex = run.timeline.findIndex(({ type, call }) =>
    type === "command" && call.file === "npx" && call.args.includes("deploy"));
  assert.ok(eligibilityIndex >= 0 && eligibilityIndex < firstWorkerIndex);

  const migration = run.calls.find(({ file, args }) =>
    file === "npm" && args.includes("db:migrate:core"));
  const verification = run.calls.find(({ file, args }) =>
    file === "npm" && args.includes("db:verify:core"));
  assert.deepEqual(migration.args.slice(-2), ["--", REVIEWED_LEGACY_BASELINE_FLAG]);
  assert.ok(run.calls.indexOf(migration) < run.calls.indexOf(verification));
  assert.ok(run.calls.indexOf(verification) < run.calls.indexOf(workers[1]));

  assert.equal(run.fetchCalls.length, MAINTENANCE_PROOF_CONSECUTIVE + 3);
  const smoke = run.fetchCalls[MAINTENANCE_PROOF_CONSECUTIVE];
  const inventory = run.fetchCalls[MAINTENANCE_PROOF_CONSECUTIVE + 1];
  const create = run.fetchCalls[MAINTENANCE_PROOF_CONSECUTIVE + 2];
  assert.equal(run.fetchCalls.some(({ url }) => url.endsWith("/v1/projects")), false);
  assert.equal(smoke.options.method, "GET");
  assert.equal(inventory.options.method, "GET");
  assert.equal(create.options.method, "POST");
  assert.equal(
    inventory.url,
    `https://api.agentry.sh/v1/projects/${PROJECT_ID}/credentials`,
  );
  assert.equal(inventory.options.headers.authorization, `Bearer ${OWNER_KEY}`);
  assert.equal(
    create.options.headers["idempotency-key"],
    `agentry-release-bootstrap-ci-${SHA}`,
  );
  assert.deepEqual(JSON.parse(create.options.body), {
    kind: "ci_deploy",
    name: `production-release-bootstrap-${SHA.slice(0, 12)}`,
  });

  assert.deepEqual(run.bootstrapOpens, [bootstrapFile]);
  assert.deepEqual(run.bootstrapWrites, [CI_KEY]);
  assert.equal(run.bootstrapCloses, 1);
  const attribution = run.calls.find(({ file, args }) =>
    file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"));
  assert.ok(attribution);
  assert.equal(attribution.env.AGENTRY_CI_API_KEY, CI_KEY);
  assert.equal(attribution.env.AGENTRY_DEPLOY_SHA, SHA);
  assert.equal(attribution.env.AGENTRY_URL, "https://api.agentry.sh/");
  for (const call of run.calls) {
    const isEligibilityChild = call.file === process.execPath
      && call.args[0]?.endsWith("verify-ci-attribution-bootstrap-eligibility.mjs");
    assert.equal(call.env.AGENTRY_PRIVATE_API_KEY, isEligibilityChild ? OWNER_KEY : undefined);
    assert.equal(
      call.env.AGENTRY_BOOTSTRAP_PROJECT_ID,
      isEligibilityChild ? PROJECT_ID : undefined,
    );
    assert.equal(call.env.AGENTRY_BOOTSTRAP_CI_KEY_FILE, undefined);
    if (isEligibilityChild) {
      assert.equal(call.env.TURSO_DATABASE_URL, "libsql://production.example.test");
      assert.equal(call.env.TURSO_AUTH_TOKEN, "database-token-must-stay-in-db-children");
      assert.equal(call.env.AGENTRY_CI_API_KEY, undefined);
      assert.equal(call.env.UNRELATED_RELEASE_SECRET, undefined);
    }
  }
  const writeIndex = run.timeline.findIndex(({ type }) => type === "bootstrap_write");
  const tagIndex = run.timeline.findIndex(({ type, call }) =>
    type === "command" && call.file === process.execPath && call.args[0]?.endsWith("tag-agentry-deploy.mjs"));
  assert.ok(writeIndex >= 0 && writeIndex < tagIndex);
  const output = [...run.stdout, ...run.stderr].join("\n");
  assert.doesNotMatch(output, new RegExp(OWNER_KEY));
  assert.doesNotMatch(output, new RegExp(CI_KEY));
});

test("fail-paused bootstrap retry stays fenced, uses DB ownership proof, and resumes only after migration", async () => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const run = harness({
    bootstrapFile,
    env: {
      AGENTRY_CI_API_KEY: undefined,
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
      AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:fail-paused-retry-20260713",
    },
    bootstrapEligibilityOutput: JSON.stringify({
      ok: true,
      eligibility: "untracked_legacy_first_ci_credential",
      adoption_state: "reviewed_legacy_retry",
      project_id: PROJECT_ID,
      owner_key_binding: "active_private_project_owner",
      project_credentials: "empty",
    }),
    fetchSequence: [
      ...successfulMaintenanceResponses(),
      resumedSmokeResponse(),
      bootstrapInventoryResponse(),
      bootstrapCredentialResponse(),
    ],
  });

  const code = await runAgentryDeploy({
    mode: "api-core-migration",
    reviewedLegacyBaseline: true,
    bootstrapCiAttribution: true,
    ...run.options,
  });
  assert.equal(code, 0, run.stderr.join("\n"));
  assert.equal(run.fetchCalls.some(({ url }) => url.endsWith("/v1/projects")), false);

  const eligibilityIndex = run.timeline.findIndex(({ type, call }) =>
    type === "command"
    && call.file === process.execPath
    && call.args[0]?.endsWith("verify-ci-attribution-bootstrap-eligibility.mjs"));
  const workerIndexes = run.timeline
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === "command"
      && entry.call.file === "npx"
      && entry.call.args.includes("deploy"));
  const migrationIndex = run.timeline.findIndex(({ type, call }) =>
    type === "command" && call.file === "npm" && call.args.includes("db:migrate:core"));
  const firstFetchIndex = run.timeline.findIndex(({ type }) => type === "fetch");
  assert.equal(workerIndexes.length, 2);
  assert.ok(eligibilityIndex >= 0 && eligibilityIndex < workerIndexes[0].index);
  assert.ok(workerIndexes[0].index < firstFetchIndex);
  assert.ok(firstFetchIndex < migrationIndex && migrationIndex < workerIndexes[1].index);
  assert.equal(workerIndexes[0].entry.call.env.AGENTRY_CORE_DB_MAINTENANCE, MAINTENANCE_ID);
  assert.equal(workerIndexes[1].entry.call.env.AGENTRY_CORE_DB_MAINTENANCE, "off");
  assert.equal(
    run.timeline.slice(0, migrationIndex).some(({ type, call }) =>
      type === "command"
      && call.file === "npx"
      && call.args.includes("AGENTRY_CORE_DB_MAINTENANCE:off")),
    false,
  );
});

test("bootstrap authority is rejected before provider mutation unless every explicit guard is present", async (t) => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const baselineEnv = {
    AGENTRY_CI_API_KEY: undefined,
    AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
    AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
    AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
    AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:bootstrap-authority-20260712",
  };
  const cases = [
    ["missing owner key", { ...baselineEnv, AGENTRY_PRIVATE_API_KEY: undefined }],
    ["missing project id", { ...baselineEnv, AGENTRY_BOOTSTRAP_PROJECT_ID: undefined }],
    ["missing key file", { ...baselineEnv, AGENTRY_BOOTSTRAP_CI_KEY_FILE: undefined }],
    ["existing CI key", { ...baselineEnv, AGENTRY_CI_API_KEY: CI_KEY }],
  ];
  for (const [name, env] of cases) {
    await t.test(name, async () => {
      const run = harness({ bootstrapFile, env });
      const code = await runAgentryDeploy({
        mode: "api-core-migration",
        reviewedLegacyBaseline: true,
        bootstrapCiAttribution: true,
        ...run.options,
      });
      assert.equal(code, 1);
      assert.equal(providerCalls(run.calls).length, 0);
      assert.equal(run.fetchCalls.length, 0);
    });
  }
  const wrongMode = harness({ bootstrapFile, env: baselineEnv });
  assert.equal(await runAgentryDeploy({
    mode: "api",
    reviewedLegacyBaseline: true,
    bootstrapCiAttribution: true,
    ...wrongMode.options,
  }), 1);
  assert.equal(providerCalls(wrongMode.calls).length, 0);

  const strayEnv = harness({
    bootstrapFile,
    env: {
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
    },
  });
  assert.equal(await runAgentryDeploy({ mode: "api-core-migration", ...strayEnv.options }), 1);
  assert.equal(providerCalls(strayEnv.calls).length, 0);
  assert.match(strayEnv.stderr.join("\n"), new RegExp(BOOTSTRAP_CI_ATTRIBUTION_FLAG));

  const unreviewed = harness({
    bootstrapFile,
    env: {
      AGENTRY_CI_API_KEY: undefined,
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
    },
  });
  assert.equal(await runAgentryDeploy({
    mode: "api-core-migration",
    bootstrapCiAttribution: true,
    ...unreviewed.options,
  }), 1);
  assert.equal(providerCalls(unreviewed.calls).length, 0);
  assert.equal(unreviewed.fetchCalls.length, 0);
  assert.match(unreviewed.stderr.join("\n"), /requires --reviewed-legacy-baseline/);
});

test("bootstrap requires the database child to attest exact project ownership before Cloudflare mutation", async (t) => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const env = {
    AGENTRY_CI_API_KEY: undefined,
    AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
    AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
    AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
    AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:bootstrap-preflight-20260712",
  };

  await t.test("database eligibility command failure", async () => {
    const run = harness({
      bootstrapFile,
      env,
      fail: ({ file, args }) =>
        file === process.execPath
        && args[0]?.endsWith("verify-ci-attribution-bootstrap-eligibility.mjs"),
    });
    assert.equal(await runAgentryDeploy({
      mode: "api-core-migration",
      reviewedLegacyBaseline: true,
      bootstrapCiAttribution: true,
      ...run.options,
    }), 1);
    assert.equal(run.fetchCalls.length, 0);
    assert.equal(providerCalls(run.calls).length, 0);
    assert.match(run.stderr.join("\n"), /database eligibility/);
  });

  await t.test("malformed database eligibility proof", async () => {
    const run = harness({ bootstrapFile, env, bootstrapEligibilityOutput: "{}" });
    assert.equal(await runAgentryDeploy({
      mode: "api-core-migration",
      reviewedLegacyBaseline: true,
      bootstrapCiAttribution: true,
      ...run.options,
    }), 1);
    assert.equal(run.fetchCalls.length, 0);
    assert.equal(providerCalls(run.calls).length, 0);
    assert.match(run.stderr.join("\n"), /did not prove the exact legacy project/);
  });

  const validProof = {
    ok: true,
    eligibility: "untracked_legacy_first_ci_credential",
    adoption_state: "untracked_legacy",
    project_id: PROJECT_ID,
    owner_key_binding: "active_private_project_owner",
    project_credentials: "missing",
  };
  const ownershipFailures = [
    ["wrong project", { ...validProof, project_id: "another-project" }],
    ["owner key not bound", { ...validProof, owner_key_binding: "missing" }],
    ["secret-bearing extra field", { ...validProof, owner_key_hash: "c".repeat(64) }],
  ];
  for (const [name, proof] of ownershipFailures) {
    await t.test(name, async () => {
      const run = harness({
        bootstrapFile,
        env,
        bootstrapEligibilityOutput: JSON.stringify(proof),
      });
      assert.equal(await runAgentryDeploy({
        mode: "api-core-migration",
        reviewedLegacyBaseline: true,
        bootstrapCiAttribution: true,
        ...run.options,
      }), 1);
      assert.equal(run.fetchCalls.length, 0);
      assert.equal(providerCalls(run.calls).length, 0);
      assert.doesNotMatch(run.stderr.join("\n"), new RegExp(OWNER_KEY));
    });
  }
});

test("bootstrap refuses a nonempty credential inventory and never mints or attributes another key", async () => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const run = harness({
    bootstrapFile,
    env: {
      AGENTRY_CI_API_KEY: undefined,
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
      AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:bootstrap-inventory-20260712",
    },
    fetchSequence: [
      ...successfulMaintenanceResponses(),
      resumedSmokeResponse(),
      bootstrapInventoryResponse([{ id: "existing-server-key", kind: "server_ingest", active: true }]),
    ],
  });
  const code = await runAgentryDeploy({
    mode: "api-core-migration",
    reviewedLegacyBaseline: true,
    bootstrapCiAttribution: true,
    ...run.options,
  });
  assert.equal(code, 1);
  assert.equal(run.bootstrapOpens.length, 0);
  assert.equal(run.bootstrapWrites.length, 0);
  assert.equal(
    run.calls.some(({ file, args }) =>
      file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")),
    false,
  );
  assert.match(run.stderr.join("\n"), /empty project credential inventory/);
});

test("bootstrap reserves its secret file before mint and preserves an empty recovery marker on lost response", async () => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const run = harness({
    bootstrapFile,
    env: {
      AGENTRY_CI_API_KEY: undefined,
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
      AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:bootstrap-lost-response-20260712",
    },
    fetchSequence: [
      ...successfulMaintenanceResponses(),
      resumedSmokeResponse(),
      bootstrapInventoryResponse(),
      new Error(`lost response containing ${CI_KEY}`),
    ],
  });
  const code = await runAgentryDeploy({
    mode: "api-core-migration",
    reviewedLegacyBaseline: true,
    bootstrapCiAttribution: true,
    ...run.options,
  });
  assert.equal(code, 1);
  assert.deepEqual(run.bootstrapOpens, [bootstrapFile]);
  assert.deepEqual(run.bootstrapWrites, []);
  assert.equal(run.bootstrapCloses, 1);
  assert.equal(
    run.calls.some(({ file, args }) =>
      file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")),
    false,
  );
  const output = [...run.stdout, ...run.stderr].join("\n");
  assert.match(output, /inspect project credentials/);
  assert.doesNotMatch(output, new RegExp(CI_KEY));
});

test("bootstrap cannot inspect or mint credentials before migration, verification, and exact-SHA smoke are green", async (t) => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const env = {
    AGENTRY_CI_API_KEY: undefined,
    AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
    AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
    AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
    AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:bootstrap-gates-20260712",
  };
  for (const failingScript of ["db:migrate:core", "db:verify:core"]) {
    await t.test(failingScript, async () => {
      const run = harness({
        bootstrapFile,
        env,
        fetchSequence: successfulMaintenanceResponses(),
        fail: ({ file, args }) =>
          file === "npm" && args.includes(failingScript),
      });
      const code = await runAgentryDeploy({
        mode: "api-core-migration",
        reviewedLegacyBaseline: true,
        bootstrapCiAttribution: true,
        ...run.options,
      });
      assert.equal(code, 1);
      assert.equal(run.fetchCalls.length, MAINTENANCE_PROOF_CONSECUTIVE);
      assert.equal(run.bootstrapOpens.length, 0);
      assert.equal(run.bootstrapWrites.length, 0);
    });
  }

  await t.test("wrong resumed SHA", async () => {
    const run = harness({
      bootstrapFile,
      env,
      fetchSequence: [
        ...successfulMaintenanceResponses(),
        ...repeatedSmokeResponses(FOREIGN_SHA),
      ],
    });
    const code = await runAgentryDeploy({
      mode: "api-core-migration",
      reviewedLegacyBaseline: true,
      bootstrapCiAttribution: true,
      ...run.options,
    });
    assert.equal(code, 1);
    assert.equal(
      run.fetchCalls.length,
      MAINTENANCE_PROOF_CONSECUTIVE + MAINTENANCE_PROOF_MAX_ATTEMPTS,
    );
    assert.equal(run.bootstrapOpens.length, 0);
    assert.equal(run.bootstrapWrites.length, 0);
    assert.match(run.stderr.join("\n"), /exact release SHA/);
  });
});

test("bootstrap attribution failure remains nonzero after preserving the new CI key", async () => {
  const bootstrapFile = "/secure/agentry-production-ci-key";
  const run = harness({
    bootstrapFile,
    env: {
      AGENTRY_CI_API_KEY: undefined,
      AGENTRY_PRIVATE_API_KEY: OWNER_KEY,
      AGENTRY_BOOTSTRAP_PROJECT_ID: PROJECT_ID,
      AGENTRY_BOOTSTRAP_CI_KEY_FILE: bootstrapFile,
      AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:bootstrap-attribution-20260712",
    },
    fetchSequence: [
      ...successfulMaintenanceResponses(),
      resumedSmokeResponse(),
      bootstrapInventoryResponse(),
      bootstrapCredentialResponse(),
    ],
    fail: ({ file, args }) =>
      file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"),
  });
  const code = await runAgentryDeploy({
    mode: "api-core-migration",
    reviewedLegacyBaseline: true,
    bootstrapCiAttribution: true,
    ...run.options,
  });
  assert.equal(code, 1);
  assert.deepEqual(run.bootstrapWrites, [CI_KEY]);
  assert.equal(run.bootstrapCloses, 1);
  assert.match(run.stderr.join("\n"), /strict deploy attribution failed/);
  assert.doesNotMatch(run.stderr.join("\n"), new RegExp(CI_KEY));
});

test("bootstrap credential file is exclusive, mode 0600, and cannot be inside the repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentry-release-bootstrap-"));
  const repo = join(directory, "repo");
  const secrets = join(directory, "secrets");
  mkdirSync(repo);
  mkdirSync(secrets);
  try {
    assert.throws(
      () => prepareBootstrapCredentialFilePath(join(repo, "ci-key"), repo),
      /outside the release repository/,
    );
    const existing = join(secrets, "existing");
    writeFileSync(existing, "do-not-overwrite");
    assert.throws(
      () => prepareBootstrapCredentialFilePath(existing, repo),
      /already exists/,
    );

    const target = prepareBootstrapCredentialFilePath(join(secrets, "ci-key"), repo);
    const sink = openBootstrapCredentialSink(target);
    sink.write(CI_KEY);
    sink.close();
    assert.equal(readFileSync(target, "utf8"), `${CI_KEY}\n`);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.throws(() => openBootstrapCredentialSink(target), /exclusively reserved/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("strict attribution failure makes an otherwise successful release nonzero", async () => {
  const run = harness({
    fail: ({ file, args }) => file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs"),
  });
  const code = await runAgentryDeploy({ mode: "api", ...run.options });
  assert.equal(code, 1);
  assert.match(run.stderr.join("\n"), /strict deploy attribution failed/);
});

test("a migration or verification failure never deploys the maintenance-off resume", async (t) => {
  for (const failingScript of ["db:migrate:core", "db:verify:core"]) {
    await t.test(failingScript, async () => {
      const run = harness({
        fetchSequence: successfulMaintenanceResponses(),
        fail: ({ file, args }) =>
          file === "npm" && args.join(" ") === `-w @agentry/db run ${failingScript}`,
      });
      const code = await runAgentryDeploy({ mode: "api-core-migration", ...run.options });
      assert.equal(code, 1);
      const workers = run.calls.filter(({ file, args }) => file === "npx" && args.includes("deploy"));
      assert.equal(workers.length, 1);
      assert.equal(workers[0].env.AGENTRY_CORE_DB_MAINTENANCE, MAINTENANCE_ID);
      assert.ok(workers[0].args.includes(`AGENTRY_CORE_DB_MAINTENANCE:${MAINTENANCE_ID}`));
      assert.equal(
        run.calls.some(({ file, args }) =>
          file === process.execPath && args[0]?.endsWith("tag-agentry-deploy.mjs")),
        false,
      );
    });
  }
});
