import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { base64url } from "@agentrysh/shared";
import {
  caseMutationCommands,
  cases,
  identities,
  posthogConnections,
  posthogOauthAttempts,
} from "@agentry/db/schema";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";
import { decryptSecret } from "../src/secret-encryption.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");
const { getPosthogConnectionAccess } = await import("../src/posthog-connection.js");

const FULL_PROVIDER_SCOPE = [
  "openid",
  "email",
  "project:read",
  "query:read",
  "event_definition:read",
  "property_definition:read",
  "error_tracking:read",
  "session_recording:read",
  "feature_flag:read",
  "survey:read",
  "experiment:read",
].join(" ");

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let apiKey: string;
let projectId: string;
let providerCalls: Array<{ url: URL; method: string; body: unknown; authorization: string | null }>;
let oidcSigningKey: CryptoKey;
let oidcPublicJwk: JsonWebKey;
let currentOidcNonce = "";
let currentOidcSubject = "posthog-connection-test-user";

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]) as CryptoKeyPair;
  oidcSigningKey = pair.privateKey;
  oidcPublicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
});

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  env.POSTHOG_OAUTH_CLIENT_ID = "https://api.agentry.test/v1/integrations/posthog/oauth/client";
  env.POSTHOG_OAUTH_REDIRECT_URI = "https://api.agentry.test/v1/integrations/posthog/oauth/callback";
  app = createApp();
  providerCalls = [];
  currentOidcNonce = "";
  currentOidcSubject = "posthog-connection-test-user";
  vi.stubGlobal("fetch", vi.fn(providerFetchFor(42)));

  const login = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email: `oauth-${crypto.randomUUID()}@example.com` },
  });
  expect(login.status).toBe(200);
  const loginBody = (await login.json()) as { api_key: string; user_id: string };
  apiKey = loginBody.api_key;
  await getDbForUrl(env.TURSO_DATABASE_URL).update(identities).set({
    issuer: "https://us.posthog.com",
    subject: "posthog-connection-test-user",
  }).where(eq(identities.userId, loginBody.user_id));
  const project = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `oauth-project-${crypto.randomUUID()}`,
    },
    json: { name: "Existing PostHog app" },
  });
  expect(project.status).toBe(200);
  projectId = ((await project.json()) as { id: string }).id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  disposeTestEnv(env);
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function encodedJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedIdToken(issuer: string): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = encodedJson({ alg: "RS256", typ: "JWT", kid: "connection-test-key" });
  const payload = encodedJson({
    iss: issuer,
    aud: env.POSTHOG_OAUTH_CLIENT_ID,
    sub: currentOidcSubject,
    nonce: currentOidcNonce,
    iat: now - 5,
    exp: now + 300,
    email: "owner@example.test",
    email_verified: true,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    oidcSigningKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function providerFetchFor(posthogProjectId: number) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body = request.body ? await request.clone().json().catch(() => null) : null;
    providerCalls.push({
      url,
      method: request.method,
      body,
      authorization: request.headers.get("authorization"),
    });
    if (url.pathname === "/oauth/token/") {
      const refreshing = (body as Record<string, unknown> | null)?.grant_type === "refresh_token";
      return json({
        access_token: refreshing
          ? "oauth-access-refreshed"
          : posthogProjectId === 42 ? "oauth-access-secret" : `oauth-access-${posthogProjectId}`,
        refresh_token: refreshing
          ? "oauth-refresh-refreshed"
          : posthogProjectId === 42 ? "oauth-refresh-secret" : `oauth-refresh-${posthogProjectId}`,
        expires_in: 3_600,
        token_type: "Bearer",
        scope: FULL_PROVIDER_SCOPE,
        scoped_teams: [posthogProjectId],
        ...(!refreshing ? { id_token: await signedIdToken(url.origin) } : {}),
      });
    }
    if (url.pathname === "/.well-known/jwks.json") {
      return json({
        keys: [{
          ...oidcPublicJwk,
          kid: "connection-test-key",
          use: "sig",
          alg: "RS256",
          key_ops: ["verify"],
        }],
      });
    }
    if (url.pathname === "/oauth/revoke/") return json({ revoked: true });
    if (url.pathname === `/api/environments/${posthogProjectId}/query/`) {
      return json({ columns: ["agentry_connection_check"], results: [[1]] });
    }
    if (
      url.pathname === `/api/projects/${posthogProjectId}/event_definitions/` ||
      url.pathname === `/api/projects/${posthogProjectId}/property_definitions/` ||
      url.pathname === `/api/environments/${posthogProjectId}/error_tracking/issues/` ||
      url.pathname === `/api/projects/${posthogProjectId}/session_recordings/` ||
      url.pathname === `/api/projects/${posthogProjectId}/feature_flags/` ||
      url.pathname === `/api/projects/${posthogProjectId}/surveys/` ||
      url.pathname === `/api/projects/${posthogProjectId}/experiments/`
    ) return json({ results: [] });
    return json({ error: "unexpected provider path", path: url.pathname }, 404);
  };
}

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, {
    ...init,
    headers,
    body,
  }), env);
}

function ownerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

async function authorizePosthog(
  region: "us" | "eu",
  posthogProjectId: number,
): Promise<Response> {
  const started = await call(`/v1/projects/${projectId}/posthog-connection`, {
    method: "POST",
    headers: ownerHeaders(),
    json: { intent: "connect", region, posthog_project_id: posthogProjectId },
  });
  expect(started.status).toBe(200);
  const authorization = new URL(
    ((await started.json()) as { authorization_url: string }).authorization_url,
  );
  currentOidcNonce = authorization.searchParams.get("nonce") ?? "";
  return await call(
    `/v1/integrations/posthog/oauth/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=provider-code`,
  );
}

async function seedProjectedCase(): Promise<void> {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const now = Math.floor(Date.now() / 1_000);
  await db.update(posthogConnections).set({
    caseProjectionOffset: 17,
    caseProjectionLastAttemptAt: now,
    caseProjectionLastCompletedAt: now,
  }).where(eq(posthogConnections.projectId, projectId));
  await db.insert(cases).values({
    id: "old-provider-issue",
    projectId,
    providerIssueId: "old-provider-issue",
    providerSnapshotHash: "a".repeat(64),
    providerProjectedAt: now,
    providerEventClassification: "customer_exception",
    fingerprint: "old-provider-issue",
    errorType: "Error",
    message: "old provider projection",
    status: "active",
    eventCount: 1,
    firstSeenAt: now - 10,
    lastSeenAt: now,
    lastTrustLevel: "customer_posthog",
    lastCredentialKind: "posthog_oauth",
    revision: 1,
  });
  await db.insert(caseMutationCommands).values({
    id: "old-case-command",
    projectId,
    caseId: "old-provider-issue",
    actorUserId: "old-actor",
    idempotencyKeyHash: "b".repeat(64),
    requestHash: "c".repeat(64),
    expectedRevision: 1,
    committedRevision: 2,
    responseJson: "{}",
    createdAt: now,
  });
}

describe("customer-owned PostHog OAuth connection", () => {
  it("serves public client metadata with read-only scopes", async () => {
    const response = await call("/v1/integrations/posthog/oauth/client");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      client_id: env.POSTHOG_OAUTH_CLIENT_ID,
      redirect_uris: [env.POSTHOG_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    const posthogMetadata = body["com.posthog"] as { scopes?: unknown };
    expect(posthogMetadata.scopes).toEqual(expect.arrayContaining([
      "query:read",
      "error_tracking:read",
      "session_recording:read",
      "feature_flag:read",
      "survey:read",
      "experiment:read",
    ]));
    expect(posthogMetadata.scopes).toEqual(
      expect.not.arrayContaining([expect.stringContaining(":write")]),
    );
  });

  it("uses one PostHog approval to create the user and return authority only to the initiating localhost CLI", async () => {
    currentOidcSubject = `bootstrap-${crypto.randomUUID()}`;
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    )));
    const handoffRedirect = `http://127.0.0.1:43123/agentry/posthog/callback/${"a".repeat(22)}`;
    const start = await call("/v1/auth/posthog", {
      method: "POST",
      json: {
        region: "us",
        client_name: "Agentry CLI",
        distribution_surface: "cli",
        handoff_redirect_uri: handoffRedirect,
        handoff_challenge: challenge,
      },
    });
    expect(start.status).toBe(200);
    const started = await start.json() as {
      authorization_url: string;
      poll_token: string;
    };
    const authorization = new URL(started.authorization_url);
    currentOidcNonce = authorization.searchParams.get("nonce") ?? "";
    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual(
      FULL_PROVIDER_SCOPE.split(" "),
    );

    const callback = await call(
      `/v1/integrations/posthog/oauth/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=bootstrap-code`,
    );
    expect(callback.status).toBe(303);
    const returned = new URL(callback.headers.get("location")!);
    expect(`${returned.origin}${returned.pathname}`).toBe(handoffRedirect);
    const ticket = returned.searchParams.get("ticket");
    expect(ticket).toMatch(/^agentry_handoff_[A-Za-z0-9_-]{43}$/);
    expect(returned.toString()).not.toContain("oauth-access-secret");

    const wrongTerminal = await call("/v1/auth/posthog/poll", {
      method: "POST",
      json: {
        poll_token: started.poll_token,
        handoff_ticket: ticket,
        handoff_verifier: base64url(crypto.getRandomValues(new Uint8Array(32))),
      },
    });
    expect(wrongTerminal.status).toBe(400);

    const completed = await call("/v1/auth/posthog/poll", {
      method: "POST",
      json: {
        poll_token: started.poll_token,
        handoff_ticket: ticket,
        handoff_verifier: verifier,
      },
    });
    expect(completed.status).toBe(200);
    const owner = await completed.json() as {
      status: string;
      api_key: string;
      authorization_id: string;
      user: { id: string; email: string | null };
    };
    expect(owner).toMatchObject({
      status: "ok",
      user: { email: "owner@example.test" },
    });
    expect(owner.api_key).toMatch(/^agentry_sk_/);
    expect((await call("/v1/me", {
      headers: { authorization: `Bearer ${owner.api_key}` },
    })).status).toBe(200);

    const replay = await call(
      `/v1/integrations/posthog/oauth/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=bootstrap-code`,
    );
    expect(replay.status).toBe(303);
    const replayTarget = new URL(replay.headers.get("location")!);
    expect(replayTarget.searchParams.get("ticket")).toBeNull();
    expect(replayTarget.searchParams.get("error")).toBe("posthog_handoff_replayed");

    const secondPoll = await call("/v1/auth/posthog/poll", {
      method: "POST",
      json: {
        poll_token: started.poll_token,
        handoff_ticket: ticket,
        handoff_verifier: verifier,
      },
    });
    expect(secondPoll.status).toBe(400);
  });

  it("connects one existing environment, exposes no secret, and detaches without deleting PostHog data", async () => {
    const started = await call(`/v1/projects/${projectId}/posthog-connection`, {
      method: "POST",
      headers: ownerHeaders(),
      json: { intent: "connect", region: "us", posthog_project_id: 42 },
    });
    expect(started.status).toBe(200);
    const startBody = await started.json() as {
      authorization_url: string;
      expires_at: number;
      connection: { status: string };
    };
    expect(startBody.connection.status).toBe("detached");
    const authorization = new URL(startBody.authorization_url);
    expect(authorization.origin).toBe("https://us.posthog.com");
    expect(authorization.searchParams.get("client_id")).toBe(env.POSTHOG_OAUTH_CLIENT_ID);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).not.toBeNull();
    expect(authorization.searchParams.get("scope")).not.toContain(":write");
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    currentOidcNonce = authorization.searchParams.get("nonce") ?? "";

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const attempt = (
      await db.select().from(posthogOauthAttempts)
        .where(eq(posthogOauthAttempts.projectId, projectId)).limit(1)
    )[0]!;
    expect(attempt.stateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt.stateHash).not.toContain(state!);
    expect(attempt.pkceVerifierCiphertext).not.toContain("oauth");
    expect(attempt.oauthClientId).toBe(env.POSTHOG_OAUTH_CLIENT_ID);

    const callback = await call(
      `/v1/integrations/posthog/oauth/callback?state=${encodeURIComponent(state!)}&code=provider-code`,
    );
    expect(callback.status, await callback.clone().text()).toBe(200);
    expect(await callback.text()).toContain("PostHog connected");

    const read = await call(`/v1/projects/${projectId}/posthog-connection`, {
      headers: ownerHeaders(),
    });
    expect(read.status).toBe(200);
    const readText = await read.text();
    expect(readText).not.toContain("oauth-access-secret");
    expect(readText).not.toContain("oauth-refresh-secret");
    expect(readText).not.toContain("phc_public-project-token");
    expect(readText).not.toContain("project_token_sha256");
    expect(readText).not.toContain("selection_candidates");
    expect(JSON.parse(readText)).toMatchObject({
      connection: {
        status: "active",
        region: "us",
        posthog_host: "https://us.posthog.com",
        posthog_project_id: 42,
        organization_id: null,
        capabilities: {
          version: "posthog-cloud-read-v2",
          query_read: true,
          error_tracking_read: true,
          session_recordings_read: true,
          feature_flags_read: true,
          surveys_read: true,
          experiments_read: true,
        },
      },
    });

    const connection = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(connection.accessTokenCiphertext).not.toContain("oauth-access-secret");
    expect(connection.refreshTokenCiphertext).not.toContain("oauth-refresh-secret");
    expect(await decryptSecret(
      env,
      connection.accessTokenCiphertext!,
      connection.accessTokenIv!,
    )).toBe("oauth-access-secret");
    expect(await decryptSecret(
      env,
      connection.refreshTokenCiphertext!,
      connection.refreshTokenIv!,
    )).toBe("oauth-refresh-secret");
    expect(connection.accessTokenExpiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1_000) + 3_500,
    );
    expect(connection.externalOwnership).toBe("customer_owned");
    expect(connection.externalDeletionPolicy).toBe("detach_only");
    expect(providerCalls.filter((entry) => entry.url.pathname !== "/oauth/token/"))
      .toSatisfy((calls: typeof providerCalls) =>
        calls.filter((entry) => entry.url.pathname.startsWith("/api/")).every((entry) =>
          entry.authorization === "Bearer oauth-access-secret"
        )
      );
    expect(providerCalls.some((entry) =>
      entry.url.pathname === "/api/projects/" ||
      entry.url.pathname.startsWith("/api/organizations/")
    )).toBe(false);

    const detached = await call(`/v1/projects/${projectId}/posthog-connection`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(detached.status).toBe(200);
    expect(await detached.json()).toMatchObject({
      connection: { status: "detached" },
      revocation_confirmed: true,
      customer_posthog_data_affected: false,
    });
    expect(providerCalls.filter((entry) => entry.url.pathname === "/oauth/revoke/")).toHaveLength(2);
    expect(providerCalls.some((entry) => /delete/i.test(entry.method))).toBe(false);
    const after = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(after).toMatchObject({
      status: "detached",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      posthogEnvironmentId: null,
    });
  });

  it("rotates and re-encrypts both provider tokens at their exact expiry", async () => {
    const started = await call(`/v1/projects/${projectId}/posthog-connection`, {
      method: "POST",
      headers: ownerHeaders(),
      json: { intent: "connect", region: "us", posthog_project_id: 42 },
    });
    const authorization = new URL(
      ((await started.json()) as { authorization_url: string }).authorization_url,
    );
    currentOidcNonce = authorization.searchParams.get("nonce") ?? "";
    const callback = await call(
      `/v1/integrations/posthog/oauth/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=provider-code`,
    );
    expect(callback.status).toBe(200);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.update(posthogConnections).set({
      accessTokenExpiresAt: Math.floor(Date.now() / 1_000) - 1,
    }).where(eq(posthogConnections.projectId, projectId));

    providerCalls.length = 0;
    const accesses = await Promise.all(
      Array.from({ length: 5 }, () => getPosthogConnectionAccess(env, projectId)),
    );
    expect(accesses.every((access) => access.access_token === "oauth-access-refreshed")).toBe(true);
    const connection = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(await decryptSecret(
      env,
      connection.accessTokenCiphertext!,
      connection.accessTokenIv!,
    )).toBe("oauth-access-refreshed");
    expect(await decryptSecret(
      env,
      connection.refreshTokenCiphertext!,
      connection.refreshTokenIv!,
    )).toBe("oauth-refresh-refreshed");
    expect(connection.accessTokenExpiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1_000) + 3_500,
    );
    expect(connection.refreshLeaseToken).toBeNull();
    expect(connection.refreshLeaseExpiresAt).toBeNull();
    expect(providerCalls.filter((entry) => entry.url.pathname === "/oauth/token/")).toHaveLength(1);
  });

  it("requires reauthorization when an active grant predates the first-class resource scopes", async () => {
    expect((await authorizePosthog("us", 42)).status).toBe(200);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.update(posthogConnections).set({
      grantedScopesJson: JSON.stringify([
        "project:read",
        "query:read",
        "event_definition:read",
        "property_definition:read",
        "error_tracking:read",
      ]),
    }).where(eq(posthogConnections.projectId, projectId));

    await expect(getPosthogConnectionAccess(env, projectId)).rejects.toMatchObject({
      code: "posthog_reauthorization_required",
      status: 401,
    });
    const connection = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(connection).toMatchObject({
      status: "reauth_required",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
    });
  });

  it("hard-cuts old case control projections and sweep state when OAuth rebinds to another provider identity", async () => {
    expect((await authorizePosthog("us", 42)).status).toBe(200);
    await seedProjectedCase();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const before = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;

    vi.mocked(globalThis.fetch).mockImplementation(providerFetchFor(43));
    const rebound = await authorizePosthog("us", 43);
    expect(rebound.status).toBe(200);

    const connection = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(connection).toMatchObject({
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogEnvironmentId: 43,
      caseProjectionOffset: 0,
      caseProjectionLastAttemptAt: null,
      caseProjectionLastCompletedAt: null,
    });
    expect(connection.version).toBe(before.version + 1);
    expect(await db.select().from(cases).where(eq(cases.projectId, projectId))).toEqual([]);
    expect(await db.select().from(caseMutationCommands)
      .where(eq(caseMutationCommands.projectId, projectId))).toEqual([]);
  });

  it("preserves completed sweep evidence when OAuth reconnects to the same provider identity", async () => {
    expect((await authorizePosthog("us", 42)).status).toBe(200);
    await seedProjectedCase();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const before = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;

    expect((await authorizePosthog("us", 42)).status).toBe(200);

    const connection = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(connection).toMatchObject({
      posthogHost: "https://us.posthog.com",
      posthogEnvironmentId: 42,
      caseProjectionOffset: 17,
      caseProjectionLastAttemptAt: before.caseProjectionLastAttemptAt,
      caseProjectionLastCompletedAt: before.caseProjectionLastCompletedAt,
    });
    expect(await db.select().from(cases).where(eq(cases.projectId, projectId))).toHaveLength(1);
  });

  it("fails the new OAuth binding without disturbing the old identity when projection reconciliation cannot commit", async () => {
    expect((await authorizePosthog("us", 42)).status).toBe(200);
    await seedProjectedCase();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.run(sql`
      CREATE TRIGGER reject_provider_projection_reconciliation
      BEFORE DELETE ON cases
      BEGIN
        SELECT RAISE(ABORT, 'projection reconciliation blocked');
      END
    `);

    vi.mocked(globalThis.fetch).mockImplementation(providerFetchFor(43));
    const rebound = await authorizePosthog("us", 43);
    expect(rebound.status).toBe(400);
    expect(await rebound.text()).toContain("posthog_provider_identity_reconciliation_failed");

    const connection = (
      await db.select().from(posthogConnections)
        .where(eq(posthogConnections.projectId, projectId)).limit(1)
    )[0]!;
    expect(connection).toMatchObject({
      status: "active",
      posthogHost: "https://us.posthog.com",
      posthogEnvironmentId: 42,
      caseProjectionOffset: 17,
    });
    expect(await db.select().from(cases).where(eq(cases.projectId, projectId))).toHaveLength(1);
    expect(await db.select().from(caseMutationCommands)
      .where(eq(caseMutationCommands.projectId, projectId))).toHaveLength(1);
    expect(providerCalls.filter((entry) => entry.url.pathname === "/oauth/revoke/")).toHaveLength(2);
  });

  it("rejects authorization that is not scoped to exactly one PostHog project", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const fallback = providerFetchFor(42);
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/oauth/token/") return json({
        access_token: "multi-access",
        refresh_token: "multi-refresh",
        expires_in: 3_600,
        token_type: "Bearer",
        scope: FULL_PROVIDER_SCOPE,
        scoped_teams: [42, 43],
        id_token: await signedIdToken(url.origin),
      });
      return fallback(input, init);
    });

    const started = await call(`/v1/projects/${projectId}/posthog-connection`, {
      method: "POST",
      headers: ownerHeaders(),
      json: { intent: "connect", region: "us" },
    });
    const authorization = new URL(((await started.json()) as { authorization_url: string }).authorization_url);
    currentOidcNonce = authorization.searchParams.get("nonce") ?? "";
    const callback = await call(
      `/v1/integrations/posthog/oauth/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=multi-code`,
    );
    expect(callback.status).toBe(400);
    expect(await callback.text()).toContain("posthog_single_project_consent_required");

    const pending = await call(`/v1/projects/${projectId}/posthog-connection`, {
      headers: ownerHeaders(),
    });
    expect(await pending.json()).toMatchObject({
      connection: {
        status: "detached",
        region: null,
        posthog_project_id: null,
      },
    });
  });
});
