import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  CLI_CHECKPOINT_KINDS,
  CLI_SCHEMA_VERSION,
  POSTHOG_AUTH_CONTRACT,
  POSTHOG_CONNECTION_CONTRACT,
  discoverPosthogRegion,
  executeCli,
  normalizeOnboardingState,
  parseCliArgs,
  redactValue,
  runCli,
} from "../src/cli.js";

const OWNER_KEY = `agentry_sk_${"x".repeat(48)}`;

function ownerDependencies(extra = {}) {
  let credentials = {};
  return {
    ...extra,
    env: { ...(extra.env ?? {}), AGENTRY_PRIVATE_API_KEY: OWNER_KEY },
    credentialStore: {
      path: "/outside-repository/test-credentials.json",
      load: async () => credentials,
      save: async (value) => { credentials = value; },
    },
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "agentry-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function mockFetch(handler) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
}

function projectList(...projects) {
  return {
    projects: projects.map(([id, name]) => ({ id, name, role: "owner" })),
  };
}

function sourceSnapshot(seed = "a") {
  return {
    git_head_sha: seed.repeat(40),
    source_fingerprint_sha256: seed.repeat(64),
    source_fingerprint_algorithm: "agentry-source-tree-sha256-v1",
  };
}

function onboardingPlan() {
  return {
    business_question: "Do eligible users persist a useful result?",
    plan_markdown: "# Source-backed value flow\n\nPersist one useful result.",
    source_snapshot: sourceSnapshot(),
    historical_evidence: null,
    milestones: [{
      event: "result persisted",
      meaning: "The durable result exists.",
      posthog_boundary: "server_posthog",
      properties: ["result_kind"],
      targets: [{ file: "src/result.ts", anchor: "await persistResult(input)" }],
    }],
    failures: [{
      marker: "result persistence failed",
      meaning: "Persistence blocked the business result.",
      posthog_boundary: "server_posthog",
      context: ["result_kind"],
      safe_live_proof: true,
      targets: [{ file: "src/result.ts", anchor: "catch (error)" }],
    }],
    deploy: {
      environment: "production",
      sha_source: "git_head",
      targets: [{ file: ".github/workflows/deploy.yml", anchor: "deploy-production" }],
    },
  };
}

function onboardingAction(projectId, status) {
  const actions = {
    planned: ["review_exact_plan", true, "review"],
    approved: ["instrument_and_start_proof", false, "proof"],
    proving: ["exercise_and_verify", false, "verify"],
  };
  const [id, requiresHuman, suffix] = actions[status];
  return {
    id,
    instruction: `Perform the canonical ${status} action.`,
    requires_human: requiresHuman,
    operation: { method: "POST", path: `/v1/projects/${projectId}/onboarding/${suffix}` },
    checklist: ["Follow the exact current state and ETag."],
    completion_condition: `The ${status} action completes.`,
    guide_anchor: `https://github.com/agentry-sh/agentry/blob/main/INSTALL.md#${suffix}`,
  };
}

function plannedOnboardingState(projectId = "project-1") {
  return {
    contract_version: "3",
    project_id: projectId,
    onboarding_id: "onboarding-1",
    revision: 1,
    status: "planned",
    plan_sha256: "a".repeat(64),
    updated_at: 1_700_000_000,
    evidence_status: { historical: "not_established", source: "pending" },
    etag: '"onboarding-1:1"',
    installation_complete: false,
    next_action: onboardingAction(projectId, "planned"),
    plan: onboardingPlan(),
  };
}

function approvedOnboardingState(projectId = "project-1") {
  return {
    ...plannedOnboardingState(projectId),
    revision: 2,
    status: "approved",
    updated_at: 1_700_000_010,
    approved_at: 1_700_000_010,
    etag: '"onboarding-1:2"',
    next_action: onboardingAction(projectId, "approved"),
  };
}

function provingOnboardingState(projectId = "project-1") {
  return {
    ...plannedOnboardingState(projectId),
    revision: 3,
    status: "proving",
    updated_at: 1_700_000_020,
    etag: '"onboarding-1:3"',
    next_action: onboardingAction(projectId, "proving"),
    implementation_source_snapshot: sourceSnapshot("b"),
    proof_session: {
      proof_session_id: "proof-session-1",
      status: "open",
      started_at: 1_700_000_010,
      expires_at: 1_700_003_610,
    },
  };
}

function verifiedOnboardingState(projectId = "project-1") {
  const finalSnapshot = sourceSnapshot("b");
  return {
    ...plannedOnboardingState(projectId),
    revision: 4,
    status: "verified",
    updated_at: 1_700_000_100,
    etag: '"onboarding-1:4"',
    evidence_status: { historical: "not_established", source: "source_verified" },
    installation_complete: true,
    next_action: null,
    implementation_source_snapshot: finalSnapshot,
    proof_session: {
      proof_session_id: "proof-session-1",
      status: "satisfied",
      started_at: 1_700_000_010,
      expires_at: 1_700_003_610,
    },
    receipt: {
      evidence_status: "source_verified",
      source_verified_at: 1_700_000_100,
      analytics: [{
        event: "result persisted",
        posthog_boundary: "server_posthog",
        required_properties: ["result_kind"],
        observed_properties: ["result_kind"],
        row_count: 1,
      }],
      error: {
        marker: "result persistence failed",
        posthog_boundary: "server_posthog",
        required_context: ["result_kind"],
        observed_context: ["result_kind"],
        row_count: 1,
      },
      deploy: {
        environment: "production",
        source_snapshot: finalSnapshot,
        row_count: 1,
      },
    },
  };
}

function onboardingHttp({ state = null, mutate = null } = {}) {
  return mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects") return jsonResponse(projectList(["project-1", "Store"]));
    if (pathname.endsWith("/posthog-connection")) {
      return jsonResponse({ connection: { status: "active", region: "eu", posthog_project_id: 42 } });
    }
    if (pathname.endsWith("/onboarding") && call.method === "GET") {
      return state
        ? jsonResponse(state, 200, { etag: state.etag })
        : jsonResponse({ error: { code: "not_found" } }, 404);
    }
    if (call.method === "POST" && mutate) return mutate(call);
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });
}

test("argument parsing keeps the public command and option surface canonical", () => {
  assert.deepEqual(
    parseCliArgs([
      "connect",
      "posthog",
      "--json",
      "--non-interactive",
      "--project=project-1",
      "--posthog-project",
      "42",
      "--region",
      "eu",
    ]),
    {
      command: "connect posthog",
      options: {
        json: true,
        nonInteractive: true,
        projectId: "project-1",
        posthogProjectId: 42,
        region: "eu",
        apiUrl: null,
        createProjectName: null,
        checkpointFile: null,
        checkpointStdin: false,
        approvePlanSha256: null,
        verify: false,
      },
    },
  );
  assert.throws(
    () => parseCliArgs(["connect", "posthog", "--posthog-project", "not-numeric"]),
    /positive numeric PostHog environment ID/,
  );
  assert.equal(parseCliArgs(["--help"]).command, "help");
  assert.equal(parseCliArgs(["-h"]).command, "help");
  assert.equal(parseCliArgs(["--version"]).command, "version");
  assert.equal(parseCliArgs(["-V"]).command, "version");
  assert.equal(parseCliArgs(["onboard", "--json"]).options.nonInteractive, true);
  assert.throws(() => parseCliArgs(["auth", "complete"]), /Unknown command/);
  assert.throws(() => parseCliArgs(["login", "--handoff-code", "secret"]), /Unknown option/);
  assert.equal(
    parseCliArgs(["onboard", "--checkpoint-stdin", "--approve-plan", "a".repeat(64)]).options.approvePlanSha256,
    "a".repeat(64),
  );
  assert.throws(
    () => parseCliArgs(["status", "--verify"]),
    /require the onboard command/,
  );
  assert.throws(
    () => parseCliArgs(["onboard", "--checkpoint-stdin", "--checkpoint-file", "/tmp/input.json"]),
    /exactly one/,
  );
  assert.throws(
    () => parseCliArgs(["onboard", "--verify", "--checkpoint-stdin"]),
    /cannot be combined/,
  );
  assert.throws(
    () => parseCliArgs(["onboard", "--project", "project-1", "--create-project", "Store"]),
    /cannot be used together/,
  );
});

test("owner and OAuth credentials are never sent over non-loopback HTTP", async () => {
  let requests = 0;
  const response = await executeCli([
    "login",
    "--json",
    "--non-interactive",
    "--region",
    "us",
    "--api-url",
    "http://api.example.test",
  ], {
    fetch: async () => {
      requests += 1;
      throw new Error("plain HTTP request must not be attempted");
    },
    env: {},
    credentialStore: {
      path: "/outside-repository/credentials.json",
      load: async () => ({}),
      save: async () => {},
    },
  });

  assert.equal(response.status, "failed");
  assert.equal(response.error.code, "invalid_api_url");
  assert.match(response.error.message, /HTTPS outside localhost/);
  assert.equal(requests, 0);
});

test("PostHog login completes through one automatic browser-to-localhost return", async (t) => {
  const root = await temporaryDirectory(t);
  const path = join(root, ".agentry", "credentials.json");
  const pollToken = "opaque-poll-token-that-must-not-be-printed";
  const handoffTicket = `agentry_handoff_${"t".repeat(43)}`;
  const handoffVerifier = "v".repeat(43);
  const handoff = {
    redirectUri: "http://127.0.0.1:43123/agentry/posthog/callback/local-state",
    challenge: "c".repeat(43),
    verifier: handoffVerifier,
    wait: async () => ({ ticket: handoffTicket }),
    close: async () => {},
  };
  const authorizationId = "authorization-that-must-remain-in-the-credential-store";
  const apiKey = `agentry_sk_${"s".repeat(48)}`;
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/auth/posthog") {
      assert.deepEqual(call.body, {
        region: "eu",
        client_name: "Agentry CLI",
        distribution_surface: "cli",
        handoff_redirect_uri: handoff.redirectUri,
        handoff_challenge: handoff.challenge,
      });
      return jsonResponse({
        authorization_url: "https://eu.posthog.com/oauth/authorize/?state=browser-checkpoint",
        poll_token: pollToken,
        expires_in: 900,
        interval: 5,
      });
    }
    if (pathname === "/v1/auth/posthog/poll") {
      assert.deepEqual(call.body, {
        poll_token: pollToken,
        handoff_ticket: handoffTicket,
        handoff_verifier: handoffVerifier,
      });
      return jsonResponse({
        status: "ok",
        api_key: apiKey,
        prefix: "agentry_sk_",
        authorization_id: authorizationId,
        user: { id: "user-1", email: "builder@example.test" },
      });
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });
  const dependencies = {
    fetch: http.fetch,
    env: { AGENTRY_CREDENTIALS: path },
    now: () => 1_000_000,
    startPosthogLoopback: async () => handoff,
    openBrowser: async (url) => {
      assert.match(url, /^https:\/\/eu\.posthog\.com\/oauth\/authorize/);
      return true;
    },
  };

  const completed = await executeCli(
    ["login", "--region", "eu", "--api-url", "https://api.example.test"],
    dependencies,
  );
  assert.equal(completed.schema_version, CLI_SCHEMA_VERSION);
  assert.equal(completed.status, "completed");
  assert.equal(completed.command, "login");
  assert.equal(JSON.stringify(completed).includes(apiKey), false);
  assert.equal(JSON.stringify(completed).includes(authorizationId), false);
  assert.equal(JSON.stringify(completed).includes(handoffTicket), false);
  assert.equal(JSON.stringify(completed).includes(handoffVerifier), false);
  assert.equal(completed.result.posthog_authorization_pending_claim, true);
  const credentials = JSON.parse(await readFile(path, "utf8"));
  assert.equal(credentials.api_key, apiKey);
  assert.equal(credentials.pending_posthog_auth, undefined);
  assert.equal(credentials.pending_posthog_authorization_id, authorizationId);
  assert.deepEqual(credentials.user, { id: "user-1", email: "builder@example.test" });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, ".agentry"))).mode & 0o777, 0o700);
});

test("the real ephemeral loopback listener accepts one bound ticket and closes", async () => {
  const ticket = `agentry_handoff_${"l".repeat(43)}`;
  const apiKey = `agentry_sk_${"r".repeat(48)}`;
  let credentials = {};
  let redirectUri;
  let challenge;
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/auth/posthog") {
      redirectUri = call.body.handoff_redirect_uri;
      challenge = call.body.handoff_challenge;
      assert.match(
        redirectUri,
        /^http:\/\/127\.0\.0\.1:\d+\/agentry\/posthog\/callback\/[A-Za-z0-9_-]{22}$/,
      );
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      return jsonResponse({
        authorization_url: "https://us.posthog.com/oauth/authorize/?state=real-loopback",
        poll_token: "real-loopback-poll-token",
        expires_in: 30,
        interval: 5,
      });
    }
    if (pathname === "/v1/auth/posthog/poll") {
      assert.equal(call.body.handoff_ticket, ticket);
      assert.equal(
        createHash("sha256").update(call.body.handoff_verifier, "utf8").digest("base64url"),
        challenge,
      );
      return jsonResponse({
        status: "ok",
        api_key: apiKey,
        prefix: "agentry_sk_",
        authorization_id: "real-loopback-authorization",
        authorization_expires_at: 1_700_001_800,
        user: { id: "user-loopback", email: "loopback@example.test" },
      });
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });

  const completed = await executeCli(
    ["login", "--region", "us", "--api-url", "https://api.example.test"],
    {
      fetch: http.fetch,
      env: {},
      credentialStore: {
        path: "/outside-repository/credentials.json",
        load: async () => credentials,
        save: async (value) => { credentials = value; },
      },
      openBrowser: async (url) => {
        assert.match(url, /^https:\/\/us\.posthog\.com\/oauth\/authorize/);
        const callback = await fetch(`${redirectUri}?ticket=${ticket}`, { redirect: "error" });
        assert.equal(callback.status, 200);
        assert.match(await callback.text(), /return to the terminal/i);
        return true;
      },
    },
  );

  assert.equal(completed.status, "completed");
  assert.equal(credentials.api_key, apiKey);
  assert.equal(credentials.pending_posthog_authorization_id, "real-loopback-authorization");
});

test("onboard --json delegates the one-click PostHog sign-in to an interactive terminal", async () => {
  let credentials = {};
  let requests = 0;
  const response = await executeCli(["onboard", "--region", "us", "--json"], {
    fetch: async () => {
      requests += 1;
      throw new Error("JSON mode must not start a browser authorization without a local callback listener.");
    },
    env: {},
    now: () => 1_000_000,
    credentialStore: {
      path: "/outside-repository/credentials.json",
      load: async () => credentials,
      save: async (value) => { credentials = value; },
    },
  });

  assert.equal(response.command, "onboard");
  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "sign_in_with_posthog");
  assert.equal(response.checkpoint.kind, "human_checkpoint");
  assert.equal(response.checkpoint.resume.arguments[0], "onboard");
  assert.equal(response.checkpoint.resume.arguments.includes("--json"), true);
  assert.match(response.checkpoint.instruction, /agentry login/);
  assert.equal(requests, 0);
  assert.deepEqual(credentials, {});
});

test("interactive onboard signs in once, then claims the PostHog authorization", async () => {
  const apiKey = `agentry_sk_${"q".repeat(48)}`;
  const authorizationId = "authorization-resume-1";
  const ticket = `agentry_handoff_${"k".repeat(43)}`;
  const verifier = "v".repeat(43);
  const handoff = {
    redirectUri: "http://127.0.0.1:43210/agentry/posthog/callback/onboard",
    challenge: "c".repeat(43),
    verifier,
    wait: async () => ({ ticket }),
    close: async () => {},
  };
  let credentials = {};
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/auth/posthog") {
      return jsonResponse({
        poll_token: "poll-resume-1",
        authorization_url: "https://us.posthog.com/oauth/authorize/?state=resume",
        expires_in: 900,
        interval: 5,
      });
    }
    if (pathname === "/v1/auth/posthog/poll") {
      assert.deepEqual(call.body, {
        poll_token: "poll-resume-1",
        handoff_ticket: ticket,
        handoff_verifier: verifier,
      });
      return jsonResponse({
        status: "ok",
        api_key: apiKey,
        prefix: "agentry_sk_",
        authorization_id: authorizationId,
        user: { id: "user-resume" },
      });
    }
    assert.equal(call.headers.authorization, `Bearer ${apiKey}`);
    if (pathname === "/v1/projects" && call.method === "GET") {
      return jsonResponse(projectList(["project-1", "Store"]));
    }
    if (pathname.endsWith("/posthog-connection") && call.method === "POST") {
      assert.deepEqual(call.body, { intent: "claim", authorization_id: authorizationId });
      return jsonResponse({ connection: { status: "active", region: "us", posthog_project_id: 17 } });
    }
    if (pathname.endsWith("/onboarding") && call.method === "GET") {
      return jsonResponse({ error: { code: "not_found" } }, 404);
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });

  const response = await executeCli(
    ["onboard", "--region", "us", "--api-url", "https://api.example.test"],
    {
      fetch: http.fetch,
      env: {},
      now: () => 1_000_000,
      startPosthogLoopback: async () => handoff,
      openBrowser: async () => true,
      credentialStore: {
        path: "/outside-repository/credentials.json",
        load: async () => credentials,
        save: async (value) => { credentials = value; },
      },
    },
  );

  assert.equal(response.command, "onboard");
  assert.equal(response.checkpoint.id, "prepare_source_backed_plan");
  assert.equal(response.result.posthog_connection.status, "active");
  assert.equal(credentials.api_key, apiKey);
  assert.equal(credentials.project_id, "project-1");
  assert.equal(credentials.pending_posthog_auth, undefined);
  assert.equal(credentials.pending_posthog_authorization_id, undefined);
});

test("PostHog login resolves the region before creating an authorization", async () => {
  let credentials = {};
  let requested = false;
  const response = await executeCli(["login", "--json"], {
    env: {},
    now: () => 1_000_000,
    credentialStore: {
      path: "/outside-repository/credentials.json",
      load: async () => credentials,
      save: async (value) => { credentials = value; },
    },
    fetch: async () => {
      requested = true;
      throw new Error("Authorization must not start before region selection.");
    },
  });

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "select_posthog_region");
  assert.deepEqual(response.checkpoint.choices.map((choice) => choice.value), ["us", "eu"]);
  assert.equal(requested, false);
  assert.deepEqual(credentials, {});
});

test("PostHog login surfaces a provider denial returned to the local callback", async () => {
  let credentials = {};
  let completed = false;
  const response = await executeCli(
    ["login", "--region", "us", "--api-url", "https://api.example.test"],
    {
      env: {},
      now: () => 1_000_000,
      startPosthogLoopback: async () => ({
        redirectUri: "http://127.0.0.1:43123/agentry/posthog/callback/denied",
        challenge: "c".repeat(43),
        verifier: "v".repeat(43),
        wait: async () => ({ error: "posthog_consent_rejected" }),
        close: async () => {},
      }),
      openBrowser: async () => true,
      credentialStore: {
        path: "/outside-repository/credentials.json",
        load: async () => credentials,
        save: async (value) => { credentials = value; },
      },
      fetch: async (url) => {
        if (new URL(url).pathname === "/v1/auth/posthog") {
          return jsonResponse({
            poll_token: "agentry_poll_failed",
            authorization_url: "https://us.posthog.com/oauth/authorize/?state=failed",
            expires_in: 900,
            interval: 5,
          });
        }
        completed = true;
        throw new Error("A denied browser callback must not be completed.");
      },
    },
  );

  assert.equal(response.status, "failed");
  assert.equal(response.error.code, "posthog_consent_rejected");
  assert.equal(completed, false);
  assert.deepEqual(credentials, {});
});

test("status uses owner auth and returns only safe connection metadata", async () => {
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    assert.equal(call.headers.authorization, `Bearer ${OWNER_KEY}`);
    assert.match(call.headers["user-agent"], /^@agentrysh\/cli\//);
    if (pathname === "/v1/projects") {
      return jsonResponse(projectList(["project-1", "Store"], ["project-2", "Docs"]));
    }
    if (pathname.endsWith("project-1/posthog-connection")) {
      return jsonResponse({
        status: "active",
        region: "us",
        posthog_host: "https://us.posthog.com",
        posthog_project_id: 17,
        organization_id: "org-1",
        scopes: [
          "query:read",
          "error_tracking:read",
          "session_recording:read",
          "feature_flag:read",
          "survey:read",
          "experiment:read",
        ],
        capabilities: { version: "posthog-cloud-read-v2", query_read: true },
        access_token: "must-never-escape",
      });
    }
    if (pathname.endsWith("project-2/posthog-connection")) {
      return jsonResponse({ status: "detached" });
    }
    if (pathname.endsWith("/onboarding")) return jsonResponse({ error: { code: "not_found" } }, 404);
    throw new Error(`Unexpected path ${pathname}`);
  });

  const response = await executeCli(
    ["status", "--json", "--non-interactive"],
    ownerDependencies({ fetch: http.fetch }),
  );
  assert.equal(response.status, "completed");
  assert.deepEqual(response.result.projects.map((project) => project.posthog_connection.status), ["active", "detached"]);
  assert.deepEqual(response.result.projects.map((project) => project.onboarding), [null, null]);
  assert.equal(response.result.projects[0].posthog_connection.organization_id, "org-1");
  assert.equal(response.result.projects[0].posthog_connection.capabilities.query_read, true);
  assert.equal(JSON.stringify(response).includes("must-never-escape"), false);
});

test("PostHog region discovery is bounded and reports ambiguity instead of guessing", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "analytics.ts"), "posthog.init('pk', { api_host: 'https://eu.i.posthog.com' })\n");
  assert.deepEqual(
    await discoverPosthogRegion({ cwd: root, env: {} }),
    {
      region: "eu",
      source: "repository",
      ambiguous: false,
      matched_files: ["src/analytics.ts"],
    },
  );
  await writeFile(join(root, "src", "legacy.ts"), "const host = 'https://us.i.posthog.com'\n");
  const ambiguous = await discoverPosthogRegion({ cwd: root, env: {} });
  assert.equal(ambiguous.region, null);
  assert.equal(ambiguous.ambiguous, true);
});

test("connect requires a region checkpoint when no PostHog host can be inferred", async (t) => {
  const root = await temporaryDirectory(t);
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects") return jsonResponse(projectList(["project-1", "Store"]));
    if (pathname.endsWith("/posthog-connection") && call.method === "GET") {
      return jsonResponse({ status: "detached" });
    }
    throw new Error("Connect must not start before region selection.");
  });
  const response = await executeCli(
    ["connect", "posthog", "--project", "project-1", "--json", "--non-interactive"],
    ownerDependencies({ fetch: http.fetch, cwd: root }),
  );
  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "select_posthog_region");
  assert.deepEqual(response.checkpoint.choices.map((choice) => choice.value), ["us", "eu"]);
  assert.equal(http.calls.filter((call) => call.method === "POST").length, 0);
});

test("connect infers region, starts OAuth, and returns a resumable noninteractive checkpoint", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "posthog.config.ts"), "export const host = 'https://eu.i.posthog.com'\n");
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects") return jsonResponse(projectList(["project-1", "Store"]));
    if (pathname.endsWith("/posthog-connection") && call.method === "GET") {
      return jsonResponse({ status: "detached" });
    }
    if (pathname.endsWith("/posthog-connection") && call.method === "POST") {
      assert.deepEqual(call.body, {
        intent: "connect",
        region: "eu",
        posthog_project_id: 42,
      });
      return jsonResponse({
        status: "detached",
        region: "eu",
        authorization_url: "https://oauth.posthog.com/authorize?state=visible-browser-checkpoint",
        poll_interval_seconds: 3,
        expires_at: 2_000_000_000,
      });
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });
  const response = await executeCli(
    [
      "connect", "posthog", "--project", "project-1", "--posthog-project", "42",
      "--json", "--non-interactive",
    ],
    ownerDependencies({ fetch: http.fetch, cwd: root }),
  );
  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "authorize_posthog");
  assert.equal(response.checkpoint.kind, "human_checkpoint");
  assert.match(response.checkpoint.url, /^https:\/\/oauth\.posthog\.com/);
  assert.deepEqual(response.checkpoint.resume.arguments.slice(-4), [
    "--posthog-project", "42", "--json", "--non-interactive",
  ]);
});

test("connect claims the authorization created by PostHog sign-in and deletes it only after an active response", async () => {
  const authorizationId = "authorization-1";
  let credentials = {
    api_key: OWNER_KEY,
    pending_posthog_authorization_id: authorizationId,
  };
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects" && call.method === "GET") {
      return jsonResponse(projectList(["project-1", "Store"]));
    }
    if (pathname === "/v1/projects/project-1/posthog-connection" && call.method === "POST") {
      assert.deepEqual(call.body, { intent: "claim", authorization_id: authorizationId });
      return jsonResponse({
        connection: {
          status: "active",
          region: "eu",
          posthog_project_id: 42,
          scopes: ["query:read", "session_recording:read", "feature_flag:read", "survey:read", "experiment:read"],
        },
      });
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });

  const response = await executeCli(
    ["connect", "posthog", "--project", "project-1", "--json"],
    {
      fetch: http.fetch,
      env: {},
      credentialStore: {
        path: "/outside-repository/credentials.json",
        load: async () => credentials,
        save: async (value) => { credentials = value; },
      },
    },
  );

  assert.equal(response.status, "completed");
  assert.equal(response.result.posthog_connection.status, "active");
  assert.equal(credentials.pending_posthog_authorization_id, undefined);
  assert.equal(credentials.api_key, OWNER_KEY);
  assert.equal(credentials.project_id, "project-1");
  assert.equal(http.calls.filter((call) => call.url.endsWith("/posthog-connection") && call.method === "GET").length, 0);
});

test("onboard explicitly creates and persists the first repository project", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = join(root, "store-app");
  await mkdir(repository);
  let credentials = {};
  let projectCreateKey = null;
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects" && call.method === "GET") {
      return jsonResponse(projectList());
    }
    if (pathname === "/v1/projects" && call.method === "POST") {
      assert.deepEqual(call.body, { name: "Store App" });
      assert.match(call.headers["idempotency-key"], /^agentry-cli-project-/);
      projectCreateKey = call.headers["idempotency-key"];
      return jsonResponse({
        command_id: "mutation-command-1",
        id: "project-new",
        name: "Store App",
        role: "owner",
        idempotent_replay: false,
      });
    }
    if (pathname.endsWith("project-new/posthog-connection")) {
      return jsonResponse({ connection: { status: "active", region: "eu", posthog_project_id: 42 } });
    }
    if (pathname.endsWith("project-new/onboarding")) {
      return jsonResponse({ error: { code: "not_found" } }, 404);
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });
  const response = await executeCli(
    ["onboard", "--create-project", "Store App", "--json"],
    {
      fetch: http.fetch,
      cwd: repository,
      env: { AGENTRY_PRIVATE_API_KEY: OWNER_KEY },
      credentialStore: {
        path: join(root, "credentials.json"),
        load: async () => credentials,
        save: async (value) => { credentials = value; },
      },
    },
  );

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "prepare_source_backed_plan");
  assert.equal(response.result.project.id, "project-new");
  assert.equal(credentials.project_id, "project-new");
  assert.equal(credentials.pending_project_create, undefined);
  assert.ok(projectCreateKey);
  assert.equal(response.checkpoint.resume.arguments.includes("--create-project"), false);
  assert.equal(response.checkpoint.resume.arguments.includes("project-new"), true);
  assert.equal(JSON.stringify(response).includes(OWNER_KEY), false);
});

test("project creation retries reuse the saved Idempotency-Key", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = join(root, "retry-app");
  await mkdir(repository);
  let credentials = {};
  const keys = [];
  let attempts = 0;
  const fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const method = options.method ?? "GET";
    if (pathname === "/v1/projects" && method === "GET") {
      return jsonResponse(attempts
        ? projectList(["project-retry", "Retry App"])
        : projectList());
    }
    if (pathname === "/v1/projects" && method === "POST") {
      keys.push(options.headers["idempotency-key"]);
      attempts += 1;
      if (attempts === 1) throw new TypeError("simulated response loss");
      return jsonResponse({
        command_id: "mutation-command-retry",
        id: "project-retry",
        name: "Retry App",
        role: "owner",
        idempotent_replay: true,
      });
    }
    if (pathname.endsWith("project-retry/posthog-connection")) {
      return jsonResponse({ connection: { status: "active", region: "us", posthog_project_id: 17 } });
    }
    if (pathname.endsWith("project-retry/onboarding")) {
      return jsonResponse({ error: { code: "not_found" } }, 404);
    }
    throw new Error(`Unexpected request ${method} ${pathname}`);
  };
  const dependencies = {
    fetch,
    cwd: repository,
    env: { AGENTRY_PRIVATE_API_KEY: OWNER_KEY },
    credentialStore: {
      path: join(root, "credentials.json"),
      load: async () => credentials,
      save: async (value) => { credentials = value; },
    },
  };

  const failed = await executeCli(
    ["onboard", "--create-project", "Retry App", "--json"],
    dependencies,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "network_error");
  assert.ok(credentials.pending_project_create.idempotency_key);

  const recovered = await executeCli(
    ["onboard", "--create-project", "Retry App", "--json"],
    dependencies,
  );
  assert.equal(recovered.status, "action_required");
  assert.equal(recovered.result.project.id, "project-retry");
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("onboard starts v3 from one bounded stdin payload and returns the review checkpoint", async () => {
  const payload = { intent: "start", plan: onboardingPlan() };
  const planned = plannedOnboardingState();
  const http = onboardingHttp({
    state: null,
    mutate(call) {
      assert.equal(new URL(call.url).pathname, "/v1/projects/project-1/onboarding");
      assert.equal(call.headers["if-match"], undefined);
      assert.deepEqual(call.body, payload);
      return jsonResponse(planned, 201, { etag: planned.etag });
    },
  });
  const response = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: http.fetch,
      input: Readable.from([JSON.stringify(payload)]),
    }),
  );

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "review_exact_plan");
  assert.equal(response.checkpoint.kind, "human_checkpoint");
  assert.equal(response.result.actuation.input_source, "stdin");
  assert.equal(response.result.actuation.request_etag, null);
  assert.equal(response.result.actuation.response_etag, planned.etag);
  assert.equal(response.checkpoint.resume.arguments.includes("--checkpoint-stdin"), false);
  assert.equal(JSON.stringify(response).includes(OWNER_KEY), false);
});

test("runCli emits one machine-executable JSON envelope and no prompt text", async () => {
  const payload = { intent: "start", plan: onboardingPlan() };
  const planned = plannedOnboardingState();
  const http = onboardingHttp({
    state: null,
    mutate() {
      return jsonResponse(planned, 201, { etag: planned.etag });
    },
  });
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: http.fetch,
      input: Readable.from([JSON.stringify(payload)]),
      stdout: { write: (value) => { stdout += value; } },
      stderr: { write: (value) => { stderr += value; } },
    }),
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.equal(stdout.trim().split("\n").length, 1);
  const response = JSON.parse(stdout);
  assert.equal(response.schema_version, CLI_SCHEMA_VERSION);
  assert.equal(response.checkpoint.kind, "human_checkpoint");
  assert.equal(stdout.includes(OWNER_KEY), false);
});

test("onboard approves only an exact doubly-confirmed plan from an outside-repository file", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = join(root, "repository");
  const inputPath = join(root, "approve.json");
  await mkdir(repository);
  const planned = plannedOnboardingState();
  const payload = { decision: "approve", plan_sha256: planned.plan_sha256 };
  await writeFile(inputPath, JSON.stringify(payload));
  const approved = approvedOnboardingState();
  const http = onboardingHttp({
    state: planned,
    mutate(call) {
      assert.equal(new URL(call.url).pathname, "/v1/projects/project-1/onboarding/review");
      assert.equal(call.headers["if-match"], planned.etag);
      assert.deepEqual(call.body, payload);
      return jsonResponse(approved, 200, { etag: approved.etag });
    },
  });
  const response = await executeCli(
    [
      "onboard", "--project", "project-1", "--checkpoint-file", inputPath,
      "--approve-plan", planned.plan_sha256, "--json",
    ],
    ownerDependencies({ fetch: http.fetch, cwd: repository }),
  );

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "instrument_and_start_proof");
  assert.equal(response.checkpoint.kind, "agent_task");
  assert.equal(response.result.actuation.review_decision, "approve");
  assert.equal(response.result.actuation.input_source, "outside_repository_file");
  assert.equal(response.result.actuation.request_etag, planned.etag);
  assert.equal(response.result.onboarding.status, "approved");
  assert.equal(response.checkpoint.resume.arguments.includes("--approve-plan"), false);
  assert.equal(response.checkpoint.resume.arguments.includes("--checkpoint-file"), false);
});

test("onboard replaces a planned review without treating replacement as approval", async () => {
  const planned = plannedOnboardingState();
  const replacementPlan = {
    ...onboardingPlan(),
    business_question: "Do invited users reach a durable result?",
    source_snapshot: sourceSnapshot("c"),
  };
  const payload = {
    decision: "replace",
    plan_sha256: planned.plan_sha256,
    replacement_plan: replacementPlan,
  };
  const replaced = {
    ...plannedOnboardingState(),
    revision: 2,
    updated_at: 1_700_000_010,
    plan_sha256: "c".repeat(64),
    etag: '"onboarding-1:2"',
    plan: replacementPlan,
  };
  const http = onboardingHttp({
    state: planned,
    mutate(call) {
      assert.equal(call.headers["if-match"], planned.etag);
      assert.deepEqual(call.body, payload);
      return jsonResponse(replaced, 200, { etag: replaced.etag });
    },
  });
  const response = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: http.fetch,
      input: Readable.from([JSON.stringify(payload)]),
    }),
  );

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "review_exact_plan");
  assert.equal(response.checkpoint.kind, "human_checkpoint");
  assert.equal(response.result.actuation.review_decision, "replace");
  assert.equal(response.result.onboarding.plan_sha256, "c".repeat(64));
  assert.equal(response.result.onboarding.plan.business_question, replacementPlan.business_question);
});

test("onboard refuses implicit approval, repository-local payloads, and operation ambiguity", async (t) => {
  const root = await temporaryDirectory(t);
  const repository = join(root, "repository");
  await mkdir(repository);
  const planned = plannedOnboardingState();
  const approval = JSON.stringify({ decision: "approve", plan_sha256: planned.plan_sha256 });
  const inputPath = join(repository, "approval.json");
  await writeFile(inputPath, approval);

  const missingConfirmationHttp = onboardingHttp({ state: planned });
  const missingConfirmation = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: missingConfirmationHttp.fetch,
      input: Readable.from([approval]),
    }),
  );
  assert.equal(missingConfirmation.status, "failed");
  assert.equal(missingConfirmation.error.code, "plan_approval_confirmation_required");
  assert.equal(missingConfirmationHttp.calls.filter((call) => call.method === "POST").length, 0);

  const insideRepositoryHttp = onboardingHttp({ state: planned });
  const insideRepository = await executeCli(
    [
      "onboard", "--project", "project-1", "--checkpoint-file", inputPath,
      "--approve-plan", planned.plan_sha256, "--json",
    ],
    ownerDependencies({ fetch: insideRepositoryHttp.fetch, cwd: repository }),
  );
  assert.equal(insideRepository.status, "failed");
  assert.equal(insideRepository.error.code, "checkpoint_file_inside_repository");
  assert.equal(insideRepositoryHttp.calls.filter((call) => call.method === "POST").length, 0);

  const wrongOperationHttp = onboardingHttp({ state: planned });
  const wrongOperation = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: wrongOperationHttp.fetch,
      input: Readable.from([JSON.stringify({ intent: "start", plan: onboardingPlan() })]),
    }),
  );
  assert.equal(wrongOperation.status, "failed");
  assert.equal(wrongOperation.error.code, "checkpoint_payload_operation_mismatch");
  assert.equal(wrongOperationHttp.calls.filter((call) => call.method === "POST").length, 0);
});

test("onboard starts proof with the current ETag and returns distinct one-time markers", async () => {
  const approved = approvedOnboardingState();
  const proving = provingOnboardingState();
  const payload = { implementation_source_snapshot: sourceSnapshot("b") };
  const markers = {
    runtime: {
      property_name: "agentry_onboarding_proof",
      value: "agentry_proof_runtime_opaque-value",
      environment_variable: "AGENTRY_ONBOARDING_PROOF",
      browser_session_storage_key: "agentry_onboarding_proof",
    },
    ci: {
      header_name: "X-Agentry-Onboarding-Proof",
      value: "agentry_proof_ci_different-opaque-value",
      environment_variable: "AGENTRY_ONBOARDING_PROOF",
    },
  };
  const http = onboardingHttp({
    state: approved,
    mutate(call) {
      assert.equal(new URL(call.url).pathname, "/v1/projects/project-1/onboarding/proof");
      assert.equal(call.headers["if-match"], approved.etag);
      assert.deepEqual(call.body, payload);
      return jsonResponse({ state: proving, one_time_markers: markers }, 201, { etag: proving.etag });
    },
  });
  const response = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: http.fetch,
      input: Readable.from([JSON.stringify(payload)]),
    }),
  );

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "exercise_and_verify");
  assert.equal(response.checkpoint.kind, "external_action");
  assert.deepEqual(response.result.actuation.one_time_markers, markers);
  assert.equal(response.result.actuation.request_etag, approved.etag);
  assert.equal(response.checkpoint.resume.arguments.includes("--checkpoint-stdin"), false);
  assert.equal(JSON.stringify(response).includes(OWNER_KEY), false);
});

test("onboard performs only an explicitly requested bodyless verify and preserves remaining work", async () => {
  const proving = provingOnboardingState();
  const remaining = {
    analytics: {
      blockers: [],
      milestones: [{ milestone_index: 0, event: "result persisted", posthog_boundary: "server_posthog" }],
      properties: [],
    },
    safe_error: null,
    deploy: null,
  };
  const http = onboardingHttp({
    state: proving,
    mutate(call) {
      assert.equal(new URL(call.url).pathname, "/v1/projects/project-1/onboarding/verify");
      assert.equal(call.headers["if-match"], proving.etag);
      assert.equal(call.headers["content-type"], undefined);
      assert.equal(call.body, null);
      return jsonResponse({ ok: false, state: proving, remaining }, 200, { etag: proving.etag });
    },
  });
  const response = await executeCli(
    ["onboard", "--project", "project-1", "--verify", "--json"],
    ownerDependencies({ fetch: http.fetch }),
  );

  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.kind, "external_action");
  assert.equal(response.result.actuation.verified, false);
  assert.deepEqual(response.result.actuation.remaining, remaining);
  assert.equal(response.checkpoint.resume.arguments.includes("--verify"), false);
});

test("successful explicit verify returns the source_verified complete checkpoint", async () => {
  const proving = provingOnboardingState();
  const verified = verifiedOnboardingState();
  const remaining = {
    analytics: { blockers: [], milestones: [], properties: [] },
    safe_error: null,
    deploy: null,
  };
  const http = onboardingHttp({
    state: proving,
    mutate(call) {
      assert.equal(call.headers["if-match"], proving.etag);
      assert.equal(call.body, null);
      return jsonResponse({ ok: true, state: verified, remaining }, 200, { etag: verified.etag });
    },
  });
  const response = await executeCli(
    ["onboard", "--project", "project-1", "--verify", "--json"],
    ownerDependencies({ fetch: http.fetch }),
  );

  assert.equal(response.status, "completed");
  assert.equal(response.checkpoint.kind, "complete");
  assert.equal(response.result.actuation.verified, true);
  assert.equal(response.result.onboarding.evidence_status.source, "source_verified");
});

test("stale onboarding ETags fail once with structured recovery and never auto-retry", async () => {
  const planned = plannedOnboardingState();
  const payload = { decision: "approve", plan_sha256: planned.plan_sha256 };
  const http = onboardingHttp({
    state: planned,
    mutate(call) {
      assert.equal(call.headers["if-match"], planned.etag);
      return jsonResponse({
        error: {
          code: "onboarding_precondition_failed",
          message: "The onboarding state changed before this operation.",
          next_action: "Read current onboarding state and retry only if approval still applies.",
          retryable: false,
          request_id: "request-stale-1",
          details: { current_etag: '"onboarding-1:2"' },
        },
      }, 412);
    },
  });
  const response = await executeCli(
    [
      "onboard", "--project", "project-1", "--checkpoint-stdin",
      "--approve-plan", planned.plan_sha256, "--json",
    ],
    ownerDependencies({
      fetch: http.fetch,
      input: Readable.from([JSON.stringify(payload)]),
    }),
  );

  assert.equal(response.status, "failed");
  assert.equal(response.error.code, "onboarding_precondition_failed");
  assert.equal(response.error.http_status, 412);
  assert.equal(response.error.next_action, "Read current onboarding state and retry only if approval still applies.");
  assert.equal(response.error.details.retryable, false);
  assert.equal(response.error.details.request_id, "request-stale-1");
  assert.equal(http.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(JSON.stringify(response).includes(OWNER_KEY), false);
});

test("proof input is bounded and proving state rejects payload-driven verification", async () => {
  const approved = approvedOnboardingState();
  const oversizedHttp = onboardingHttp({ state: approved });
  const oversized = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: oversizedHttp.fetch,
      input: Readable.from([JSON.stringify({ implementation_source_snapshot: sourceSnapshot("b"), padding: "x".repeat(5_000) })]),
    }),
  );
  assert.equal(oversized.status, "failed");
  assert.equal(oversized.error.code, "checkpoint_input_too_large");
  assert.equal(oversizedHttp.calls.filter((call) => call.method === "POST").length, 0);

  const provingHttp = onboardingHttp({ state: provingOnboardingState() });
  const payloadVerify = await executeCli(
    ["onboard", "--project", "project-1", "--checkpoint-stdin", "--json"],
    ownerDependencies({
      fetch: provingHttp.fetch,
      input: Readable.from(["{}"]),
    }),
  );
  assert.equal(payloadVerify.status, "failed");
  assert.equal(payloadVerify.error.code, "verify_confirmation_required");
  assert.equal(provingHttp.calls.filter((call) => call.method === "POST").length, 0);
});

test("onboard exposes the server's exact next action without performing it", async () => {
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects") return jsonResponse(projectList(["project-1", "Store"]));
    if (pathname.endsWith("/posthog-connection")) {
      return jsonResponse({
        status: "active",
        region: "eu",
        posthog_project_id: 42,
      });
    }
    if (pathname.endsWith("/onboarding")) {
      assert.equal(call.method, "GET");
      return jsonResponse(plannedOnboardingState(), 200, { etag: '"onboarding-1:1"' });
    }
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });
  const response = await executeCli(
    ["onboard", "--project", "project-1", "--json", "--non-interactive"],
    ownerDependencies({ fetch: http.fetch }),
  );
  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "review_exact_plan");
  assert.equal(response.checkpoint.kind, "human_checkpoint");
  assert.equal(response.checkpoint.requires_human, true);
  assert.equal(response.result.onboarding.next_action.operation.method, "POST");
  assert.equal(response.result.onboarding.evidence_status.source, "pending");
  assert.equal(response.result.onboarding.plan.business_question, "Do eligible users persist a useful result?");
  assert.match(response.result.onboarding.next_action.guide_anchor, /INSTALL\.md/);
  assert.equal(http.calls.filter((call) => call.method === "POST").length, 0);
});

test("onboard classifies deploy and real-path proof as an external action", async () => {
  const proving = {
    ...plannedOnboardingState(),
    revision: 3,
    status: "proving",
    etag: '"onboarding-1:3"',
    next_action: onboardingAction("project-1", "proving"),
    implementation_source_snapshot: sourceSnapshot("b"),
    proof_session: {
      proof_session_id: "proof-session-1",
      status: "open",
      started_at: 1_700_000_010,
      expires_at: 1_700_003_610,
    },
  };
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects") return jsonResponse(projectList(["project-1", "Store"]));
    if (pathname.endsWith("/posthog-connection")) {
      return jsonResponse({ connection: { status: "active", region: "eu", posthog_project_id: 42 } });
    }
    if (pathname.endsWith("/onboarding")) return jsonResponse(proving, 200, { etag: proving.etag });
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });

  const response = await executeCli(
    ["onboard", "--project", "project-1", "--json"],
    ownerDependencies({ fetch: http.fetch }),
  );
  assert.equal(response.status, "action_required");
  assert.equal(response.checkpoint.id, "exercise_and_verify");
  assert.equal(response.checkpoint.kind, "external_action");
  assert.equal(response.checkpoint.requires_human, false);
});

test("onboard completes only with source_verified evidence and emits a complete checkpoint", async () => {
  const finalSnapshot = sourceSnapshot("b");
  const verified = {
    ...plannedOnboardingState(),
    revision: 4,
    status: "verified",
    etag: '"onboarding-1:4"',
    evidence_status: { historical: "not_established", source: "source_verified" },
    installation_complete: true,
    next_action: null,
    implementation_source_snapshot: finalSnapshot,
    proof_session: {
      proof_session_id: "proof-session-1",
      status: "satisfied",
      started_at: 1_700_000_010,
      expires_at: 1_700_003_610,
    },
    receipt: {
      evidence_status: "source_verified",
      source_verified_at: 1_700_000_100,
      analytics: [{
        event: "result persisted",
        posthog_boundary: "server_posthog",
        required_properties: ["result_kind"],
        observed_properties: ["result_kind"],
        row_count: 1,
      }],
      error: {
        marker: "result persistence failed",
        posthog_boundary: "server_posthog",
        required_context: ["result_kind"],
        observed_context: ["result_kind"],
        row_count: 1,
      },
      deploy: {
        environment: "production",
        source_snapshot: finalSnapshot,
        row_count: 1,
      },
    },
  };
  const http = mockFetch((call) => {
    const pathname = new URL(call.url).pathname;
    if (pathname === "/v1/projects") return jsonResponse(projectList(["project-1", "Store"]));
    if (pathname.endsWith("/posthog-connection")) {
      return jsonResponse({ connection: { status: "active", region: "eu", posthog_project_id: 42 } });
    }
    if (pathname.endsWith("/onboarding")) return jsonResponse(verified, 200, { etag: verified.etag });
    throw new Error(`Unexpected request ${call.method} ${pathname}`);
  });

  const response = await executeCli(
    ["onboard", "--project", "project-1", "--json"],
    ownerDependencies({ fetch: http.fetch }),
  );
  assert.equal(response.status, "completed");
  assert.equal(response.checkpoint.kind, "complete");
  assert.equal(response.result.onboarding.evidence_status.source, "source_verified");
  assert.equal(response.result.onboarding.receipt.evidence_status, "source_verified");
});

test("onboarding response validation rejects generic verified aliases and ETag drift", () => {
  const state = plannedOnboardingState();
  assert.throws(
    () => normalizeOnboardingState({ ...state, status: "source_verified" }, "project-1"),
    /does not match contract v3/,
  );
  assert.throws(
    () => normalizeOnboardingState(state, "project-1", '"onboarding-1:2"'),
    /ETag header does not match/,
  );
  assert.deepEqual(CLI_CHECKPOINT_KINDS, [
    "agent_task",
    "human_checkpoint",
    "external_action",
    "complete",
  ]);
});

test("redaction removes credential material even from unexpected API error text", () => {
  const value = redactValue({
    message: `bad Bearer token ${OWNER_KEY}`,
    api_key: OWNER_KEY,
    nested: { access_token: "posthog-token" },
  });
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(OWNER_KEY), false);
  assert.equal(serialized.includes("posthog-token"), false);
  assert.match(serialized, /REDACTED/);
});

test("the canonical PostHog connection contract stays narrow", () => {
  assert.equal(POSTHOG_AUTH_CONTRACT.startPath, "/v1/auth/posthog");
  assert.equal(POSTHOG_AUTH_CONTRACT.pollPath, "/v1/auth/posthog/poll");
  const handoff = {
    redirectUri: "http://127.0.0.1:43123/agentry/posthog/callback/test",
    challenge: "c".repeat(43),
  };
  assert.deepEqual(POSTHOG_AUTH_CONTRACT.start("eu", handoff), {
    region: "eu",
    client_name: "Agentry CLI",
    distribution_surface: "cli",
    handoff_redirect_uri: handoff.redirectUri,
    handoff_challenge: handoff.challenge,
  });
  assert.deepEqual(POSTHOG_AUTH_CONTRACT.poll("opaque", "ticket", "verifier"), {
    poll_token: "opaque",
    handoff_ticket: "ticket",
    handoff_verifier: "verifier",
  });
  assert.equal(
    POSTHOG_CONNECTION_CONTRACT.path("project/id"),
    "/v1/projects/project%2Fid/posthog-connection",
  );
  assert.deepEqual(POSTHOG_CONNECTION_CONTRACT.connect("us", 17), {
    intent: "connect",
    region: "us",
    posthog_project_id: 17,
  });
  assert.deepEqual(POSTHOG_CONNECTION_CONTRACT.claim("authorization-1"), {
    intent: "claim",
    authorization_id: "authorization-1",
  });
});
