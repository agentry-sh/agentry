#!/usr/bin/env node

// Live smoke for Agentry's hard-cut control plane. Runtime analytics and errors
// live in the customer's PostHog project, so this deliberately exercises
// project ownership, OAuth discovery, trusted CI evidence, and bounded cleanup
// without manufacturing an Agentry ingest key or posting telemetry to Agentry.

import { loadAgentryCredentials } from "./lib/agentry-credentials.mjs";
import { deleteProjectDurably } from "./lib/durable-project-delete.mjs";

const credentials = loadAgentryCredentials();
const baseUrl = process.env.AGENTRY_URL ?? credentials.serverUrl;
const explicitApiKey = credentials.apiKey;
const explicitEmail = process.env.AGENTRY_TEST_EMAIL ?? null;
const startedAt = Date.now();
const runId = `control-plane-smoke-${startedAt}`;
const USER_AGENT = process.env.AGENTRY_LIVE_TEST_USER_AGENT ?? "agentry-control-plane-smoke/2";

function fail(message, detail) {
  throw new Error(detail ? `${message}\n${JSON.stringify(detail, null, 2)}` : message);
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail);
}

async function http(method, path, { headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "user-agent": USER_AGENT, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.AGENTRY_LIVE_HTTP_TIMEOUT_MS ?? 60_000)),
  });
  const responseText = await response.text();
  let json = null;
  try {
    json = responseText ? JSON.parse(responseText) : null;
  } catch {
    // Some discovery callbacks intentionally return HTML.
  }
  return { status: response.status, headers: response.headers, text: responseText, json };
}

async function resolveApiKey() {
  if (explicitApiKey) return explicitApiKey;
  if (explicitEmail || baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost")) {
    const login = await http("POST", "/v1/auth/_test/login", {
      headers: { "content-type": "application/json" },
      body: { email: explicitEmail ?? `control-plane-smoke+${startedAt}@agentry.dev` },
    });
    if (login.status === 200 && login.json?.api_key) return login.json.api_key;
    fail("Could not mint a local test owner key", login.json ?? login.text);
  }
  fail(
    "No owner key available. Set AGENTRY_PRIVATE_API_KEY, configure ~/.agentry/credentials.json, or use AGENTRY_TEST_EMAIL against a test-login-enabled local API.",
  );
}

async function main() {
  const apiKey = await resolveApiKey();
  let projectId = null;
  try {
    const project = await http("POST", "/v1/projects", {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `${runId}-project`,
      },
      body: {
        name: runId,
        repo_url: "https://example.com/agentry-control-plane-smoke",
        local_path: `/tmp/${runId}`,
      },
    });
    assert(project.status === 200 && typeof project.json?.id === "string", "Project creation failed", project.json ?? project.text);
    assert(project.json.public_api_key === undefined, "Project creation exposed a retired runtime-ingest key", project.json);
    assert(project.json.analytics === undefined, "Project creation claimed Agentry-hosted analytics provisioning", project.json);
    projectId = project.json.id;

    const connection = await http("GET", `/v1/projects/${projectId}/posthog-connection`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert(connection.status === 200, "PostHog connection state read failed", connection.json ?? connection.text);
    assert(connection.json?.connection?.status === "detached", "Fresh project did not start detached from customer PostHog", connection.json);

    const oauthClient = await http("GET", "/v1/integrations/posthog/oauth/client");
    assert(oauthClient.status === 200, "PostHog OAuth client discovery failed", oauthClient.json ?? oauthClient.text);
    assert(
      Array.isArray(oauthClient.json?.["com.posthog"]?.scopes) &&
        oauthClient.json["com.posthog"].scopes.every((scope) => scope.endsWith(":read")),
      "PostHog OAuth metadata did not expose a read-only scope ceiling",
      oauthClient.json,
    );

    const credential = await http("POST", `/v1/projects/${projectId}/credentials`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `${runId}-ci-credential`,
      },
      body: { kind: "ci_deploy", name: `${runId}-ci` },
    });
    assert(
      credential.status === 200 && typeof credential.json?.credential === "string" &&
        credential.json.credential.startsWith("agentry_ci_"),
      "CI credential creation failed",
      credential.json ?? credential.text,
    );

    const deploy = await http("POST", "/v1/deploys/", {
      headers: {
        authorization: `Bearer ${credential.json.credential}`,
        "content-type": "application/json",
        "idempotency-key": `${runId}-deploy`,
      },
      body: {
        sha: "a".repeat(40),
        branch: "main",
        environment: "production",
        actor: "agentry-control-plane-smoke",
        ci_run_id: runId,
      },
    });
    assert(deploy.status === 200, "Trusted CI deploy write failed", deploy.json ?? deploy.text);

    const deploys = await http("GET", `/v1/projects/${projectId}/deploys?limit=5`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    assert(
      deploys.status === 200 && Array.isArray(deploys.json?.deploys) &&
        deploys.json.deploys.some((row) =>
          row.evidence?.sha === "a".repeat(40) &&
          row.emitter?.trust_level === "trusted_ci" &&
          row.control?.attribution_authority === "credential_bound_ci"
        ),
      "Trusted deploy was not readable through the owner boundary",
      deploys.json ?? deploys.text,
    );

    console.log(JSON.stringify({
      ok: true,
      surface: "control_plane",
      project_id: projectId,
      posthog_connection: "detached",
      oauth_scope: "read_only",
      deploy_evidence: "trusted_ci",
    }, null, 2));
  } finally {
    if (projectId) {
      const deletion = await deleteProjectDurably({
        idempotencyKey: `${runId}-delete`,
        maxWaitMs: Number(process.env.AGENTRY_CLEANUP_WAIT_MS ?? 120_000),
        acceptNotFound: true,
        attempt: ({ idempotencyKey }) => http("DELETE", `/v1/projects/${projectId}`, {
          headers: {
            authorization: `Bearer ${apiKey}`,
            "idempotency-key": idempotencyKey,
          },
        }),
      });
      assert(deletion.deletion_complete === true, "Project cleanup did not complete", deletion);
    }
  }
}

await main();
