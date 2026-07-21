import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AUTOMATION_RUN_ID_ENV,
  AUTOMATION_SOURCE_COMMIT_SHA_ENV,
  MAX_ATTEMPTS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  runDeployTag,
  validateAutomationDeployBindingEnvironment,
  validateDeployTagEnvironment,
} from "./tag-agentry-deploy.mjs";

const PROJECT_ID = "018f0000-0000-7000-8000-000000000001";
const TOKEN = "a".repeat(32);
const CI_KEY = `agentry_ci_${PROJECT_ID}.${TOKEN}`;
const SHA_40 = "0123456789abcdef0123456789abcdef01234567";
const SHA_64 = `${SHA_40}0123456789abcdef01234567`;
const SOURCE_FINGERPRINT = "b".repeat(64);
const PROVIDER_DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const ONBOARDING_PROOF = `agentry_proof_ci_${"p".repeat(43)}`;
const AUTOMATION_RUN_ID = "018f0000-0000-7000-8000-000000000042";
const AUTOMATION_SOURCE_SHA = "c".repeat(40);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "tag-agentry-deploy.mjs");

function acceptedResponse(overrides = {}, init = {}) {
  return new Response(JSON.stringify({
    id: "deploy_accepted",
    project_id: PROJECT_ID,
    sha: SHA_40,
    idempotent_replay: false,
    ...overrides,
  }), { status: 200, ...init });
}

async function invoke({
  env = {},
  sequence = [acceptedResponse()],
  gitValue = () => null,
} = {}) {
  const calls = [];
  const waits = [];
  const timeouts = [];
  const stdout = [];
  const stderr = [];
  let index = 0;
  const code = await runDeployTag({
    env: {
      AGENTRY_CI_API_KEY: CI_KEY,
      AGENTRY_DEPLOY_SHA: SHA_40,
      AGENTRY_PROVIDER_DEPLOYMENT_ID: PROVIDER_DEPLOYMENT_ID,
      AGENTRY_SOURCE_FINGERPRINT_SHA256: SOURCE_FINGERPRINT,
      ...env,
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const item = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (typeof item === "function") return await item(url, options);
      if (item instanceof Error) throw item;
      return item;
    },
    gitValue,
    timeoutSignal: (ms) => {
      timeouts.push(ms);
      return new AbortController().signal;
    },
    wait: async (ms) => {
      waits.push(ms);
    },
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  });
  return { code, calls, waits, timeouts, stdout, stderr };
}

test("uses a 10 second timeout and three-attempt retry bound", () => {
  assert.equal(REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(MAX_ATTEMPTS, 3);
});

test("pure environment validation returns only bounded nonsecret release metadata", () => {
  const validated = validateDeployTagEnvironment({
    AGENTRY_CI_API_KEY: CI_KEY,
    AGENTRY_DEPLOY_SHA: SHA_40.toUpperCase(),
    AGENTRY_PROVIDER_DEPLOYMENT_ID: PROVIDER_DEPLOYMENT_ID,
    AGENTRY_SOURCE_FINGERPRINT_SHA256: SOURCE_FINGERPRINT.toUpperCase(),
    AGENTRY_URL: "https://self-host.example/private/base?secret=must-not-survive",
  });
  assert.deepEqual(validated, {
    projectId: PROJECT_ID,
    sha: SHA_40,
    endpoint: "https://self-host.example/v1/deploys/",
    providerDeploymentId: PROVIDER_DEPLOYMENT_ID,
    sourceFingerprintSha256: SOURCE_FINGERPRINT,
    automationRunId: null,
    sourceCommitSha: null,
  });
  assert.equal(Object.isFrozen(validated), true);
  const serialized = JSON.stringify(validated);
  assert.doesNotMatch(serialized, /agentry_ci_|must-not-survive/);
  assert.doesNotMatch(serialized, new RegExp(TOKEN));
});

test("validates the optional automation deploy binding as an exact both-or-neither pair", () => {
  const binding = validateAutomationDeployBindingEnvironment({
    [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
    [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA.toUpperCase(),
  });
  assert.deepEqual(binding, {
    automationRunId: AUTOMATION_RUN_ID,
    sourceCommitSha: AUTOMATION_SOURCE_SHA,
  });
  assert.equal(Object.isFrozen(binding), true);

  for (const env of [
    { [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID },
    { [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA },
    {
      [AUTOMATION_RUN_ID_ENV]: "not-a-run-id",
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: "not-a-commit",
    },
  ]) {
    assert.throws(() => validateAutomationDeployBindingEnvironment(env));
  }
});

test("includes a distinct PR-head automation binding without changing deploy idempotency", async () => {
  const result = await invoke({
    env: {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA.toUpperCase(),
    },
    sequence: [acceptedResponse({
      automation_run_id: AUTOMATION_RUN_ID,
      source_commit_sha: AUTOMATION_SOURCE_SHA,
    })],
  });
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.equal(result.calls.length, 1);
  assert.equal(
    result.calls[0].options.headers["idempotency-key"],
    `cloudflare-worker:${PROVIDER_DEPLOYMENT_ID}`,
  );
  const payload = JSON.parse(result.calls[0].options.body);
  assert.notEqual(payload.sha, payload.source_commit_sha);
  assert.deepEqual(payload, {
    sha: SHA_40,
    environment: "production",
    provider_deployment_id: PROVIDER_DEPLOYMENT_ID,
    source_fingerprint_sha256: SOURCE_FINGERPRINT,
    automation_run_id: AUTOMATION_RUN_ID,
    source_commit_sha: AUTOMATION_SOURCE_SHA,
  });
});

test("fails closed before fetch on partial or malformed automation binding inputs", async (t) => {
  const invalid = [
    {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: undefined,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: undefined,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: "018f0000-0000-4000-8000-000000000042",
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA,
    },
    {
      [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
      [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: "f".repeat(39),
    },
  ];
  for (const env of invalid) {
    await t.test(JSON.stringify(env), async () => {
      const result = await invoke({ env });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 0);
      assert.match(result.stderr.join("\n"), /AGENTRY_AUTOMATION_/);
    });
  }
});

test("requires the accepted response to retain the submitted automation binding", async (t) => {
  for (const [name, responseBinding] of [
    ["missing", {}],
    ["wrong run", {
      automation_run_id: "018f0000-0000-7000-8000-000000000043",
      source_commit_sha: AUTOMATION_SOURCE_SHA,
    }],
    ["wrong commit", {
      automation_run_id: AUTOMATION_RUN_ID,
      source_commit_sha: "d".repeat(40),
    }],
  ]) {
    await t.test(name, async () => {
      const result = await invoke({
        env: {
          [AUTOMATION_RUN_ID_ENV]: AUTOMATION_RUN_ID,
          [AUTOMATION_SOURCE_COMMIT_SHA_ENV]: AUTOMATION_SOURCE_SHA,
        },
        sequence: [acceptedResponse(responseBinding)],
      });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 1);
      assert.match(result.stderr.join("\n"), /did not match the submitted release/);
    });
  }
});

test("pure environment validation fails without network or output side effects", () => {
  const invalid = [
    {},
    { AGENTRY_CI_API_KEY: CI_KEY },
    { AGENTRY_CI_API_KEY: "malformed", AGENTRY_DEPLOY_SHA: SHA_40 },
    { AGENTRY_CI_API_KEY: CI_KEY, AGENTRY_DEPLOY_SHA: "unknown" },
    { AGENTRY_CI_API_KEY: CI_KEY, AGENTRY_DEPLOY_SHA: SHA_40, AGENTRY_URL: "file:///tmp/agentry" },
    { AGENTRY_CI_API_KEY: CI_KEY, AGENTRY_DEPLOY_SHA: SHA_40, AGENTRY_URL: "http://api.agentry.sh" },
    { AGENTRY_CI_API_KEY: CI_KEY, AGENTRY_DEPLOY_SHA: SHA_40, AGENTRY_URL: "http://self-host.example" },
  ];
  for (const env of invalid) {
    assert.throws(() => validateDeployTagEnvironment(env));
  }
});

test("permits HTTP only for explicit loopback development targets", () => {
  for (const value of [
    "http://localhost:8787/private/base",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ]) {
    const validated = validateDeployTagEnvironment({
      AGENTRY_CI_API_KEY: CI_KEY,
      AGENTRY_DEPLOY_SHA: SHA_40,
      AGENTRY_URL: value,
    });
    assert.match(validated.endpoint, /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):8787\/v1\/deploys\/$/);
  }
});

test("fails closed before fetch when AGENTRY_CI_API_KEY is missing or malformed", async (t) => {
  const malformed = [
    undefined,
    "",
    "agentry_ci_missing-separator",
    `agentry_ci_.${TOKEN}`,
    `agentry_ci_${PROJECT_ID}.short`,
    `agentry_pk_${PROJECT_ID}.${TOKEN}`,
    `agentry_ci_${PROJECT_ID}.${"a".repeat(33)}`,
    `agentry_ci_${PROJECT_ID}.${"!".repeat(32)}`,
  ];
  for (const value of malformed) {
    await t.test(String(value), async () => {
      const result = await invoke({ env: { AGENTRY_CI_API_KEY: value } });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 0);
      assert.match(result.stderr.join("\n"), /AGENTRY_CI_API_KEY (?:is required|is malformed)/);
    });
  }
});

test("requires explicit exact AGENTRY_DEPLOY_SHA without provider or git fallback", async (t) => {
  const invalid = [
    undefined,
    "",
    "unknown",
    "abcdef0",
    "g".repeat(40),
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
  ];
  for (const value of invalid) {
    await t.test(String(value), async () => {
      let gitCalls = 0;
      const result = await invoke({
        env: {
          AGENTRY_DEPLOY_SHA: value,
          GITHUB_SHA: SHA_40,
          COMMIT_REF: SHA_40,
        },
        gitValue: () => {
          gitCalls += 1;
          return SHA_40;
        },
      });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 0);
      assert.equal(gitCalls, 0);
      assert.match(result.stderr.join("\n"), /AGENTRY_DEPLOY_SHA (?:is required|must be exactly)/);
    });
  }
});

test("accepts exact release identities and binds attribution to the provider deployment", async (t) => {
  for (const sha of [SHA_40.toUpperCase(), SHA_64.toUpperCase()]) {
    await t.test(`${sha.length} hex`, async () => {
      const normalized = sha.toLowerCase();
      const result = await invoke({
        env: { AGENTRY_DEPLOY_SHA: sha },
        sequence: [acceptedResponse({ sha: normalized })],
      });
      assert.equal(result.code, 0);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].url, "https://api.agentry.sh/v1/deploys/");
      assert.equal(result.calls[0].options.method, "POST");
      assert.equal(result.calls[0].options.headers.authorization, `Bearer ${CI_KEY}`);
      assert.equal(
        result.calls[0].options.headers["idempotency-key"],
        `cloudflare-worker:${PROVIDER_DEPLOYMENT_ID}`,
      );
      assert.deepEqual(JSON.parse(result.calls[0].options.body), {
        sha: normalized,
        environment: "production",
        provider_deployment_id: PROVIDER_DEPLOYMENT_ID,
        source_fingerprint_sha256: SOURCE_FINGERPRINT,
      });
      assert.equal(result.timeouts[0], 10_000);
    });
  }
});

test("requires provider deployment ID and final source fingerprint as one exact pair", async (t) => {
  const invalid = [
    {
      AGENTRY_PROVIDER_DEPLOYMENT_ID: undefined,
      AGENTRY_SOURCE_FINGERPRINT_SHA256: SOURCE_FINGERPRINT,
    },
    {
      AGENTRY_PROVIDER_DEPLOYMENT_ID: PROVIDER_DEPLOYMENT_ID,
      AGENTRY_SOURCE_FINGERPRINT_SHA256: undefined,
    },
    {
      AGENTRY_PROVIDER_DEPLOYMENT_ID: "short",
      AGENTRY_SOURCE_FINGERPRINT_SHA256: SOURCE_FINGERPRINT,
    },
    {
      AGENTRY_PROVIDER_DEPLOYMENT_ID: PROVIDER_DEPLOYMENT_ID,
      AGENTRY_SOURCE_FINGERPRINT_SHA256: "f".repeat(63),
    },
  ];
  for (const env of invalid) {
    await t.test(JSON.stringify(env), async () => {
      const result = await invoke({ env });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 0);
      assert.match(
        result.stderr.join("\n"),
        /AGENTRY_(?:PROVIDER_DEPLOYMENT_ID|SOURCE_FINGERPRINT_SHA256)/,
      );
    });
  }
});

test("forwards only a valid temporary CI onboarding proof marker", async () => {
  const result = await invoke({
    env: { AGENTRY_ONBOARDING_PROOF: ONBOARDING_PROOF },
  });
  assert.equal(result.code, 0);
  assert.equal(
    result.calls[0].options.headers["x-agentry-onboarding-proof"],
    ONBOARDING_PROOF,
  );
  assert.equal(JSON.stringify(JSON.parse(result.calls[0].options.body)).includes(ONBOARDING_PROOF), false);

  const invalid = await invoke({
    env: { AGENTRY_ONBOARDING_PROOF: "not-a-proof-marker" },
  });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.calls.length, 0);
  assert.match(invalid.stderr.join("\n"), /AGENTRY_ONBOARDING_PROOF is malformed/);
});

test("same-SHA cleanup deploys use distinct provider idempotency identities", async () => {
  const first = await invoke();
  const cleanupProviderId = "22222222-2222-4222-8222-222222222222";
  const cleanup = await invoke({
    env: { AGENTRY_PROVIDER_DEPLOYMENT_ID: cleanupProviderId },
  });
  assert.equal(first.code, 0);
  assert.equal(cleanup.code, 0);
  assert.equal(JSON.parse(first.calls[0].options.body).sha, SHA_40);
  assert.equal(JSON.parse(cleanup.calls[0].options.body).sha, SHA_40);
  assert.notEqual(
    first.calls[0].options.headers["idempotency-key"],
    cleanup.calls[0].options.headers["idempotency-key"],
  );
  assert.equal(
    cleanup.calls[0].options.headers["idempotency-key"],
    `cloudflare-worker:${cleanupProviderId}`,
  );
});

test("retries response loss, 429, and 5xx with an identical idempotent request", async () => {
  const result = await invoke({
    sequence: [
      new Error("connection reset"),
      new Response("rate limited", { status: 429 }),
      acceptedResponse(),
    ],
  });
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.waits, [250, 1_000]);
  assert.deepEqual(result.timeouts, [10_000, 10_000, 10_000]);
  const semanticRequests = result.calls.map(({ url, options }) => ({
    url,
    method: options.method,
    headers: options.headers,
    body: options.body,
  }));
  assert.deepEqual(semanticRequests[1], semanticRequests[0]);
  assert.deepEqual(semanticRequests[2], semanticRequests[0]);
});

test("retries a lost 200 response body with the same request", async () => {
  const lostBody = new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error("socket lost"));
    },
  }), { status: 200 });
  const result = await invoke({ sequence: [lostBody, acceptedResponse()] });
  assert.equal(result.code, 0);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.waits, [250]);
  assert.equal(result.calls[1].options.body, result.calls[0].options.body);
  assert.deepEqual(result.calls[1].options.headers, result.calls[0].options.headers);
});

test("stops after the bounded retry count", async () => {
  const secretBody = `do-not-print-${CI_KEY}`;
  const result = await invoke({
    sequence: [
      new Response(secretBody, { status: 500 }),
      new Response(secretBody, { status: 502 }),
      new Response(secretBody, { status: 503 }),
    ],
  });
  assert.equal(result.code, 1);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.waits, [250, 1_000]);
  const output = [...result.stdout, ...result.stderr].join("\n");
  assert.doesNotMatch(output, /do-not-print/);
  assert.doesNotMatch(output, new RegExp(TOKEN));
});

test("does not retry non-200, non-retryable HTTP responses", async (t) => {
  for (const status of [201, 400, 401, 403, 409]) {
    await t.test(String(status), async () => {
      const result = await invoke({
        sequence: [new Response("private response body", { status })],
      });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.waits, []);
      assert.match(result.stderr.join("\n"), new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(result.stderr.join("\n"), /private response body/);
    });
  }
});

test("accepts both a matching original response and a matching idempotent replay", async (t) => {
  for (const replay of [false, true]) {
    await t.test(replay ? "replay" : "original", async () => {
      const result = await invoke({
        sequence: [acceptedResponse({ idempotent_replay: replay })],
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr.length, 0);
      assert.equal(result.stdout.length, 1);
      assert.equal(result.stdout[0].includes("idempotent replay"), replay);
    });
  }
});

test("rejects 200 JSON that does not match the credential-bound project and exact SHA", async (t) => {
  const cases = [
    ["wrong project", acceptedResponse({ project_id: "another-project" })],
    ["wrong sha", acceptedResponse({ sha: "f".repeat(40) })],
    ["empty id", acceptedResponse({ id: "  " })],
    ["missing id", acceptedResponse({ id: undefined })],
    ["array", new Response("[]", { status: 200 })],
    ["invalid json", new Response("not json", { status: 200 })],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async () => {
      const result = await invoke({ sequence: [response] });
      assert.equal(result.code, 1);
      assert.equal(result.calls.length, 1);
      assert.equal(result.stdout.length, 0);
    });
  }
});

test("bounds response reads and never prints the CI key or response body", async () => {
  const sentinel = `response-secret-${CI_KEY}`;
  const oversized = JSON.stringify({
    id: "deploy_accepted",
    project_id: PROJECT_ID,
    sha: SHA_40,
    sentinel,
    padding: "x".repeat(MAX_RESPONSE_BYTES),
  });
  const result = await invoke({
    sequence: [new Response(oversized, { status: 200 })],
  });
  assert.equal(result.code, 1);
  const output = [...result.stdout, ...result.stderr].join("\n");
  assert.doesNotMatch(output, /response-secret/);
  assert.doesNotMatch(output, new RegExp(TOKEN));
  assert.match(output, /oversized deploy response/);
});

test("does not print thrown network details even after retries", async () => {
  const leaked = `network said ${CI_KEY} and a very large private body`;
  const result = await invoke({
    sequence: [new Error(leaked), new Error(leaked), new Error(leaked)],
  });
  assert.equal(result.code, 1);
  const output = [...result.stdout, ...result.stderr].join("\n");
  assert.doesNotMatch(output, /network said|very large private body/);
  assert.doesNotMatch(output, new RegExp(TOKEN));
});

test("uses git only for optional bounded metadata, never for release identity", async () => {
  const gitCalls = [];
  const values = new Map([
    ["rev-parse --abbrev-ref HEAD", "feature/release"],
    ["config user.name", "Release Agent"],
    ["log -1 --pretty=%s", "Ship exact release"],
  ]);
  const result = await invoke({
    gitValue: (args) => {
      gitCalls.push(args.join(" "));
      return values.get(args.join(" ")) ?? null;
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(gitCalls, [
    "rev-parse --abbrev-ref HEAD",
    "config user.name",
    "log -1 --pretty=%s",
  ]);
  const payload = JSON.parse(result.calls[0].options.body);
  assert.equal(payload.sha, SHA_40);
  assert.equal(payload.branch, "feature/release");
  assert.equal(payload.actor, "Release Agent");
  assert.equal(payload.message, "Ship exact release");
});

test("metadata git children receive no CI credential, proof marker, or unrelated release secret", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentry-deploy-tag-git-env-"));
  const fakeGit = join(cwd, "git");
  const capturedEnvironment = join(cwd, "git-child-environment.txt");
  const proof = ONBOARDING_PROOF;
  const unrelatedSecret = "unrelated-release-secret-must-not-reach-git";
  try {
    writeFileSync(fakeGit, [
      "#!/bin/sh",
      `/usr/bin/env >> ${JSON.stringify(capturedEnvironment)}`,
      `printf '%s\\n' '---' >> ${JSON.stringify(capturedEnvironment)}`,
      "case \"$1\" in",
      "  rev-parse) printf '%s\\n' 'main' ;;",
      "  config) printf '%s\\n' 'Release Agent' ;;",
      "  log) printf '%s\\n' 'Ship exact release' ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(fakeGit, 0o700);

    const calls = [];
    const stderr = [];
    const code = await runDeployTag({
      env: {
        PATH: cwd,
        HOME: cwd,
        LANG: "C",
        AGENTRY_CI_API_KEY: CI_KEY,
        AGENTRY_DEPLOY_SHA: SHA_40,
        AGENTRY_PROVIDER_DEPLOYMENT_ID: PROVIDER_DEPLOYMENT_ID,
        AGENTRY_SOURCE_FINGERPRINT_SHA256: SOURCE_FINGERPRINT,
        AGENTRY_ONBOARDING_PROOF: proof,
        UNRELATED_RELEASE_SECRET: unrelatedSecret,
      },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return acceptedResponse();
      },
      timeoutSignal: () => new AbortController().signal,
      wait: async () => {},
      stdout: () => {},
      stderr: (message) => stderr.push(message),
    });

    assert.equal(code, 0, stderr.join("\n"));
    assert.equal(calls.length, 1);
    const childEnvironment = readFileSync(capturedEnvironment, "utf8");
    const childEnvironmentLines = childEnvironment.split(/\r?\n/);
    assert.ok(childEnvironmentLines.includes(`PATH=${cwd}`));
    assert.ok(childEnvironmentLines.includes(`HOME=${cwd}`));
    assert.doesNotMatch(childEnvironment, /AGENTRY_CI_API_KEY|AGENTRY_ONBOARDING_PROOF/);
    assert.doesNotMatch(childEnvironment, new RegExp(TOKEN));
    assert.doesNotMatch(childEnvironment, new RegExp(proof));
    assert.doesNotMatch(childEnvironment, new RegExp(unrelatedSecret));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the executable exits nonzero and ignores local env files", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agentry-deploy-tag-"));
  try {
    writeFileSync(join(cwd, ".env"), [
      `AGENTRY_CI_API_KEY=${CI_KEY}`,
      `AGENTRY_DEPLOY_SHA=${SHA_40}`,
    ].join("\n"));
    const child = spawnSync(process.execPath, [SCRIPT], {
      cwd,
      env: {
        HOME: cwd,
        PATH: process.env.PATH ?? "",
      },
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /AGENTRY_CI_API_KEY is required/);
    assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, new RegExp(TOKEN));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
