import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import {
  automationRuns,
  automationTriggerReceipts,
  caseClaims,
  caseMutationCommands,
  cases,
  posthogConnections,
  posthogOauthAttempts,
  type PosthogConnection,
  type PosthogOauthAttempt,
} from "@agentry/db/schema";
import { AgentryError, base64url, sha256Hex, uuidv7 } from "@agentrysh/shared";
import type { Env } from "./env.js";
import { getDb } from "./db.js";
import { decryptSecret, encryptSecret } from "./secret-encryption.js";
import {
  createPosthogOauthAuthorization,
  exchangePosthogOauthCode,
  PosthogOauthProviderError,
  POSTHOG_OAUTH_SCOPES,
  posthogCloudBaseUrl,
  refreshPosthogOauthTokens,
  resolvePosthogScopedProject,
  revokePosthogOauthToken,
  verifyPosthogOidcIdentity,
  verifyPosthogReadCapabilities,
  type PosthogCapabilitySnapshot,
  type PosthogOauthRegion,
  type PosthogOauthTokens,
  type PosthogScopedProject,
} from "./posthog-oauth.js";
import {
  refreshPosthogIdentityMetadata,
  resolveExistingPosthogUser,
  resolveOrCreatePosthogUser,
} from "./posthog-identity.js";

const OAUTH_ATTEMPT_TTL_SECONDS = 10 * 60;
const OAUTH_HANDOFF_TTL_SECONDS = 5 * 60;
const OAUTH_CLAIM_WINDOW_SECONDS = 30 * 60;
const ACCESS_TOKEN_SKEW_SECONDS = 60;
const REFRESH_LEASE_TTL_SECONDS = 30;
const REFRESH_WAIT_ATTEMPTS = 6;
const OAUTH_TERMINAL_RETENTION_SECONDS = 24 * 60 * 60;

class PosthogProviderIdentityReconciliationError extends Error {
  constructor() {
    super(
      "The previous PostHog provider case projection could not be safely discarded; the existing connection was left unchanged.",
    );
    this.name = "PosthogProviderIdentityReconciliationError";
  }
}

type ConnectionStatus = PosthogConnection["status"];

export type PosthogConnectionView = {
  status: ConnectionStatus;
  region: PosthogOauthRegion | null;
  posthog_host: string | null;
  posthog_project_id: number | null;
  organization_id: string | null;
  scopes: string[];
  connected_at: number | null;
  last_verified_at: number | null;
  capabilities: PosthogCapabilitySnapshot | null;
  next_action: string | null;
};

export type PosthogConnectionAccess = {
  connection_id: string;
  project_id: string;
  region: PosthogOauthRegion;
  posthog_host: string;
  posthog_project_id: number;
  access_token: string;
  scopes: string[];
  version: number;
};

export type PosthogOauthCallbackResult =
  | { outcome: "active"; project_id: string; connection: PosthogConnectionView }
  | { outcome: "already_authorized"; project_id: string; connection: PosthogConnectionView }
  | {
      outcome: "authorization_ready";
      project_id: null;
      handoff_redirect_uri: string;
      handoff_ticket: string | null;
    }
  | { outcome: "in_progress"; project_id: string | null }
  | { outcome: "expired"; project_id: string | null; handoff_redirect_uri?: string }
  | {
      outcome: "failed";
      project_id: string | null;
      error_code: string;
      handoff_redirect_uri?: string;
    };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: string): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === "string");
}

function parseCapability(value: string): PosthogCapabilitySnapshot | null {
  try {
    const parsed = JSON.parse(value) as Partial<PosthogCapabilitySnapshot>;
    return parsed?.version === "posthog-cloud-read-v2" &&
      typeof parsed.checked_at === "number" &&
      parsed.project_read === true &&
      parsed.query_read === true &&
      parsed.event_definitions_read === true &&
      parsed.property_definitions_read === true &&
      parsed.error_tracking_read === true &&
      parsed.session_recordings_read === true &&
      parsed.feature_flags_read === true &&
      parsed.surveys_read === true &&
      parsed.experiments_read === true
      ? parsed as PosthogCapabilitySnapshot
      : null;
  } catch {
    return null;
  }
}

export function posthogConnectionView(row: PosthogConnection | null): PosthogConnectionView {
  if (!row) {
    return {
      status: "detached",
      region: null,
      posthog_host: null,
      posthog_project_id: null,
      organization_id: null,
      scopes: [],
      connected_at: null,
      last_verified_at: null,
      capabilities: null,
      next_action: "Connect a customer-owned PostHog Cloud project.",
    };
  }
  const status = row.status;
  const nextAction = status === "reauth_required"
      ? "Reconnect PostHog. The previous OAuth credentials were destroyed."
      : status === "detached"
        ? "Connect a customer-owned PostHog Cloud project."
        : null;
  return {
    status,
    region: row.posthogRegion,
    posthog_host: row.posthogHost,
    posthog_project_id: row.posthogEnvironmentId,
    organization_id: row.posthogOrganizationId,
    scopes: status === "detached" ? [] : parseStringArray(row.grantedScopesJson),
    connected_at: status === "detached" ? null : row.authorizedAt,
    last_verified_at: row.lastVerifiedAt,
    capabilities: parseCapability(row.capabilitySnapshotJson),
    next_action: nextAction,
  };
}

export async function readPosthogConnection(
  env: Env,
  projectId: string,
): Promise<PosthogConnectionView> {
  const row = await loadConnection(env, projectId);
  return posthogConnectionView(row);
}

async function loadConnection(env: Env, projectId: string): Promise<PosthogConnection | null> {
  const rows = await getDb(env)
    .select()
    .from(posthogConnections)
    .where(eq(posthogConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

function randomPollToken(): string {
  return `agentry_poll_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function randomHandoffTicket(): string {
  return `agentry_handoff_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function normalizePosthogHandoffRedirectUri(value: string): string | null {
  if (value.length > 256) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) || port < 1_024 || port > 65_535 ||
    url.username || url.password || url.search || url.hash ||
    !/^\/agentry\/posthog\/callback\/[A-Za-z0-9_-]{22}$/.test(url.pathname)
  ) return null;
  return url.toString();
}

export function normalizePosthogHandoffChallenge(value: string): string | null {
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(normalized) ? normalized : null;
}

export async function hashPosthogHandoffTicket(
  attemptId: string,
  ticket: string,
): Promise<string> {
  return await sha256Hex(`posthog-loopback-ticket-v1\0${attemptId}\0${ticket}`);
}

export async function posthogHandoffVerifierChallenge(verifier: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function beginPosthogBootstrap(input: {
  env: Env;
  request_origin: string;
  region: PosthogOauthRegion;
  client_name: string | null;
  distribution_surface: string | null;
  handoff_redirect_uri: string;
  handoff_challenge: string;
}): Promise<{
  authorization_url: string;
  poll_token: string;
  expires_in: number;
  interval: number;
  next_action: string;
}> {
  const handoffRedirectUri = normalizePosthogHandoffRedirectUri(input.handoff_redirect_uri);
  const handoffChallenge = normalizePosthogHandoffChallenge(input.handoff_challenge);
  if (!handoffRedirectUri || !handoffChallenge) {
    throw new AgentryError({
      status: 400,
      code: "invalid_posthog_handoff",
      message: "PostHog sign-in requires a bound localhost callback.",
      nextAction: "Upgrade the Agentry CLI and retry from an interactive terminal.",
    });
  }
  const authorization = await createPosthogOauthAuthorization({
    env: input.env,
    request_origin: input.request_origin,
    region: input.region,
  });
  const [verifier, nonce] = await Promise.all([
    encryptSecret(input.env, authorization.code_verifier),
    encryptSecret(input.env, authorization.nonce),
  ]);
  const pollToken = randomPollToken();
  const db = getDb(input.env);
  const now = nowSeconds();
  const expiresAt = now + OAUTH_ATTEMPT_TTL_SECONDS;
  await db.insert(posthogOauthAttempts).values({
    id: uuidv7(),
    mode: "bootstrap",
    projectId: null,
    userId: null,
    pollTokenHash: await sha256Hex(pollToken),
    handoffRedirectUri,
    handoffChallenge,
    stateHash: authorization.state_sha256,
    oauthClientId: authorization.client_id,
    pkceVerifierCiphertext: verifier.ciphertext,
    pkceVerifierIv: verifier.iv,
    oidcNonceHash: authorization.nonce_sha256,
    oidcNonceCiphertext: nonce.ciphertext,
    oidcNonceIv: nonce.iv,
    redirectUri: authorization.redirect_uri,
    requestedScopesJson: JSON.stringify(authorization.scopes),
    posthogRegionHint: input.region,
    clientName: input.client_name,
    distributionSurface: input.distribution_surface,
    status: "pending",
    expiresAt,
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  return {
    authorization_url: authorization.authorization_url,
    poll_token: pollToken,
    expires_in: OAUTH_ATTEMPT_TTL_SECONDS,
    interval: 5,
    next_action: "Open authorization_url and approve read-only PostHog access once. The browser will return automatically to the initiating CLI.",
  };
}

export async function beginPosthogConnection(input: {
  env: Env;
  project_id: string;
  user_id: string;
  request_origin: string;
  region: PosthogOauthRegion;
  posthog_project_id?: number;
}): Promise<{
  connection: PosthogConnectionView;
  authorization_url: string;
  poll_interval_seconds: number;
  expires_at: number;
}> {
  const authorization = await createPosthogOauthAuthorization({
    env: input.env,
    request_origin: input.request_origin,
    region: input.region,
  });
  const [verifier, nonce] = await Promise.all([
    encryptSecret(input.env, authorization.code_verifier),
    encryptSecret(input.env, authorization.nonce),
  ]);
  const db = getDb(input.env);
  const now = nowSeconds();
  const expiresAt = now + OAUTH_ATTEMPT_TTL_SECONDS;
  await db.transaction(async (tx) => {
    await tx.update(posthogOauthAttempts).set({
      status: "expired",
      pkceVerifierCiphertext: null,
      pkceVerifierIv: null,
      oidcNonceCiphertext: null,
      oidcNonceIv: null,
      expiredAt: now,
      updatedAt: now,
      version: sql`${posthogOauthAttempts.version} + 1`,
    }).where(and(
      eq(posthogOauthAttempts.mode, "connect"),
      eq(posthogOauthAttempts.projectId, input.project_id),
      eq(posthogOauthAttempts.status, "pending"),
    ));
    await tx.insert(posthogOauthAttempts).values({
      id: uuidv7(),
      mode: "connect",
      projectId: input.project_id,
      userId: input.user_id,
      pollTokenHash: null,
      stateHash: authorization.state_sha256,
      oauthClientId: authorization.client_id,
      pkceVerifierCiphertext: verifier.ciphertext,
      pkceVerifierIv: verifier.iv,
      oidcNonceHash: authorization.nonce_sha256,
      oidcNonceCiphertext: nonce.ciphertext,
      oidcNonceIv: nonce.iv,
      redirectUri: authorization.redirect_uri,
      requestedScopesJson: JSON.stringify(authorization.scopes),
      posthogRegionHint: input.region,
      posthogEnvironmentIdHint: input.posthog_project_id ?? null,
      status: "pending",
      expiresAt,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
  });
  return {
    connection: posthogConnectionView(await loadConnection(input.env, input.project_id)),
    authorization_url: authorization.authorization_url,
    poll_interval_seconds: 3,
    expires_at: expiresAt,
  };
}

async function claimOauthAttempt(
  env: Env,
  state: string,
): Promise<PosthogOauthAttempt | { terminal: PosthogOauthAttempt | null }> {
  const db = getDb(env);
  const stateHash = await sha256Hex(state);
  const existing = (
    await db.select().from(posthogOauthAttempts)
      .where(eq(posthogOauthAttempts.stateHash, stateHash)).limit(1)
  )[0];
  if (!existing) return { terminal: null };
  const now = nowSeconds();
  if (existing.status === "pending" && existing.expiresAt <= now) {
    await db.update(posthogOauthAttempts).set({
      status: "expired",
      pkceVerifierCiphertext: null,
      pkceVerifierIv: null,
      oidcNonceCiphertext: null,
      oidcNonceIv: null,
      expiredAt: now,
      updatedAt: now,
      version: existing.version + 1,
    }).where(and(
      eq(posthogOauthAttempts.id, existing.id),
      eq(posthogOauthAttempts.status, "pending"),
      eq(posthogOauthAttempts.version, existing.version),
    ));
    const expired = (
      await db.select().from(posthogOauthAttempts)
        .where(eq(posthogOauthAttempts.id, existing.id)).limit(1)
    )[0] ?? existing;
    return { terminal: expired };
  }
  if (existing.status !== "pending") return { terminal: existing };
  const claimed = await db.update(posthogOauthAttempts).set({
    status: "exchanging",
    exchangeStartedAt: now,
    updatedAt: now,
    version: existing.version + 1,
  }).where(and(
    eq(posthogOauthAttempts.id, existing.id),
    eq(posthogOauthAttempts.status, "pending"),
    eq(posthogOauthAttempts.version, existing.version),
  )).returning();
  if (claimed[0]) return claimed[0];
  const terminal = (
    await db.select().from(posthogOauthAttempts)
      .where(eq(posthogOauthAttempts.id, existing.id)).limit(1)
  )[0] ?? null;
  return { terminal };
}

async function callbackTerminalResult(
  env: Env,
  attempt: PosthogOauthAttempt | null,
): Promise<PosthogOauthCallbackResult> {
  if (!attempt) return { outcome: "failed", project_id: null, error_code: "invalid_oauth_state" };
  const handoff = attempt.mode === "bootstrap" && attempt.handoffRedirectUri
    ? { handoff_redirect_uri: attempt.handoffRedirectUri }
    : {};
  if (attempt.status === "expired") {
    return { outcome: "expired", project_id: attempt.projectId, ...handoff };
  }
  if (attempt.status === "failed") {
    return {
      outcome: "failed",
      project_id: attempt.projectId,
      error_code: attempt.errorCode ?? "posthog_oauth_failed",
      ...handoff,
    };
  }
  if (attempt.status === "exchanging" || attempt.status === "pending") {
    return { outcome: "in_progress", project_id: attempt.projectId };
  }
  if (attempt.status === "authorized" && attempt.mode === "bootstrap") {
    // The raw ticket is deliberately not recoverable from storage. Replaying
    // this provider callback cannot redirect a usable ticket; the CLI restarts.
    if (!attempt.handoffRedirectUri) {
      return { outcome: "failed", project_id: null, error_code: "posthog_handoff_missing" };
    }
    return {
      outcome: "authorization_ready",
      project_id: null,
      handoff_redirect_uri: attempt.handoffRedirectUri,
      handoff_ticket: null,
    };
  }
  if (!attempt.projectId) {
    return {
      outcome: "failed",
      project_id: null,
      error_code: "oauth_connection_missing",
    };
  }
  const row = await loadConnection(env, attempt.projectId);
  if (!row || row.id !== attempt.connectionId) {
    return { outcome: "failed", project_id: attempt.projectId, error_code: "oauth_connection_missing" };
  }
  return {
    outcome: "already_authorized",
    project_id: attempt.projectId,
    connection: posthogConnectionView(row),
  };
}

function safeOauthErrorCode(value: string | undefined): string {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80);
  return normalized && /^[a-z]/.test(normalized) ? `posthog_${normalized}` : "posthog_oauth_failed";
}

async function failOauthAttempt(
  env: Env,
  attempt: PosthogOauthAttempt,
  errorCode: string,
  error?: PosthogOauthProviderError,
): Promise<void> {
  const now = nowSeconds();
  await getDb(env).update(posthogOauthAttempts).set({
    status: "failed",
    pkceVerifierCiphertext: null,
    pkceVerifierIv: null,
    oidcNonceCiphertext: null,
    oidcNonceIv: null,
    handoffCodeHash: null,
    handoffExpiresAt: null,
    handoffFailureCount: 0,
    errorCode,
    errorMetadataJson: JSON.stringify(error ? {
      operation: error.operation,
      upstream_status: error.status,
      oauth_code: error.oauthCode,
    } : {}),
    failedAt: now,
    updatedAt: now,
    version: attempt.version + 1,
  }).where(and(
    eq(posthogOauthAttempts.id, attempt.id),
    eq(posthogOauthAttempts.status, "exchanging"),
    eq(posthogOauthAttempts.version, attempt.version),
  ));
}

async function bestEffortRevokeTokens(
  attempt: Pick<PosthogOauthAttempt, "posthogRegionHint" | "oauthClientId">,
  tokens: PosthogOauthTokens,
): Promise<void> {
  if (!attempt.posthogRegionHint) return;
  await Promise.all([
    revokePosthogOauthToken({
      region: attempt.posthogRegionHint,
      token: tokens.access_token,
      token_type_hint: "access_token",
      client_id: attempt.oauthClientId,
    }),
    revokePosthogOauthToken({
      region: attempt.posthogRegionHint,
      token: tokens.refresh_token,
      token_type_hint: "refresh_token",
      client_id: attempt.oauthClientId,
    }),
  ]).catch(() => {});
}

export async function expirePosthogOauthAttempt(
  env: Env,
  attempt: PosthogOauthAttempt,
  now = nowSeconds(),
): Promise<{ expired: boolean; revocation_attempts: number }> {
  if (
    !(["pending", "exchanging", "authorized"] as const).includes(
      attempt.status as "pending" | "exchanging" | "authorized",
    ) ||
    attempt.expiresAt > now
  ) {
    return { expired: false, revocation_attempts: 0 };
  }
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  if (
    attempt.status === "authorized" &&
    attempt.pendingAccessTokenCiphertext &&
    attempt.pendingAccessTokenIv &&
    attempt.pendingRefreshTokenCiphertext &&
    attempt.pendingRefreshTokenIv
  ) {
    [accessToken, refreshToken] = await Promise.all([
      decryptSecret(
        env,
        attempt.pendingAccessTokenCiphertext,
        attempt.pendingAccessTokenIv,
      ).catch(() => null),
      decryptSecret(
        env,
        attempt.pendingRefreshTokenCiphertext,
        attempt.pendingRefreshTokenIv,
      ).catch(() => null),
    ]);
  }
  const changed = await getDb(env).update(posthogOauthAttempts).set({
    status: "expired",
    pkceVerifierCiphertext: null,
    pkceVerifierIv: null,
    oidcNonceCiphertext: null,
    oidcNonceIv: null,
    pendingAccessTokenCiphertext: null,
    pendingAccessTokenIv: null,
    pendingRefreshTokenCiphertext: null,
    pendingRefreshTokenIv: null,
    pendingAccessTokenExpiresAt: null,
    handoffCodeHash: null,
    handoffExpiresAt: null,
    handoffFailureCount: 0,
    authorizedAt: null,
    errorCode: null,
    errorMetadataJson: "{}",
    failedAt: null,
    expiredAt: now,
    updatedAt: now,
    version: attempt.version + 1,
  }).where(and(
    eq(posthogOauthAttempts.id, attempt.id),
    eq(posthogOauthAttempts.status, attempt.status),
    eq(posthogOauthAttempts.version, attempt.version),
    lte(posthogOauthAttempts.expiresAt, now),
  )).returning({ id: posthogOauthAttempts.id });
  if (!changed[0]) return { expired: false, revocation_attempts: 0 };

  let revocationAttempts = 0;
  if (attempt.posthogRegionHint && accessToken) {
    revocationAttempts += 1;
    await revokePosthogOauthToken({
      region: attempt.posthogRegionHint,
      token: accessToken,
      token_type_hint: "access_token",
      client_id: attempt.oauthClientId,
    }).catch(() => false);
  }
  if (attempt.posthogRegionHint && refreshToken) {
    revocationAttempts += 1;
    await revokePosthogOauthToken({
      region: attempt.posthogRegionHint,
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: attempt.oauthClientId,
    }).catch(() => false);
  }
  return { expired: true, revocation_attempts: revocationAttempts };
}

export async function sweepPosthogOauthAttempts(
  env: Env,
  options: { expiry_limit?: number; purge_limit?: number } = {},
): Promise<{
  expired: number;
  purged: number;
  revocation_attempts: number;
}> {
  const db = getDb(env);
  const now = nowSeconds();
  const expiryLimit = Math.max(1, Math.min(options.expiry_limit ?? 50, 200));
  const purgeLimit = Math.max(1, Math.min(options.purge_limit ?? 100, 500));
  const expiring = await db.select().from(posthogOauthAttempts).where(and(
    inArray(posthogOauthAttempts.status, ["pending", "exchanging", "authorized"]),
    lte(posthogOauthAttempts.expiresAt, now),
  )).orderBy(asc(posthogOauthAttempts.expiresAt)).limit(expiryLimit);

  let expired = 0;
  let revocationAttempts = 0;
  for (const attempt of expiring) {
    const result = await expirePosthogOauthAttempt(env, attempt, now);
    if (result.expired) expired += 1;
    revocationAttempts += result.revocation_attempts;
  }

  const terminal = await db.select({ id: posthogOauthAttempts.id })
    .from(posthogOauthAttempts)
    .where(and(
      inArray(posthogOauthAttempts.status, ["claimed", "failed", "expired"]),
      lt(posthogOauthAttempts.updatedAt, now - OAUTH_TERMINAL_RETENTION_SECONDS),
    ))
    .orderBy(asc(posthogOauthAttempts.updatedAt))
    .limit(purgeLimit);
  if (terminal.length > 0) {
    await db.delete(posthogOauthAttempts).where(inArray(
      posthogOauthAttempts.id,
      terminal.map((row) => row.id),
    ));
  }
  return {
    expired,
    purged: terminal.length,
    revocation_attempts: revocationAttempts,
  };
}

function exactScopeSet(value: string): string[] | null {
  const scopes = value.trim().split(/\s+/).filter(Boolean);
  const expected = [...POSTHOG_OAUTH_SCOPES];
  if (scopes.length !== expected.length || new Set(scopes).size !== scopes.length) {
    return null;
  }
  const granted = new Set(scopes);
  return expected.every((scope) => granted.has(scope)) ? expected : null;
}

function grantedScopes(
  tokens: PosthogOauthTokens,
  attempt: PosthogOauthAttempt,
): string[] | null {
  const requested = parseStringArray(attempt.requestedScopesJson);
  if (
    requested.length !== POSTHOG_OAUTH_SCOPES.length ||
    new Set(requested).size !== requested.length ||
    !POSTHOG_OAUTH_SCOPES.every((scope) => requested.includes(scope))
  ) {
    return null;
  }
  return exactScopeSet(tokens.scope);
}

function hasExactRequiredScopes(scopes: string[]): boolean {
  return scopes.length === POSTHOG_OAUTH_SCOPES.length &&
    new Set(scopes).size === scopes.length &&
    POSTHOG_OAUTH_SCOPES.every((scope) => scopes.includes(scope));
}

function tokenExpiry(tokens: PosthogOauthTokens, now: number): number {
  return now + tokens.expires_in;
}

function activeConnectionValues(input: {
  project_id: string;
  user_id: string;
  oauth_client_id: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  access_token_expires_at: number;
  granted_scopes_json: string;
  region: PosthogOauthRegion;
  organization_id: string | null;
  posthog_project_id: number;
  capability_snapshot_json: string;
  capabilities_observed_at: number;
  now: number;
}) {
  return {
    id: uuidv7(),
    projectId: input.project_id,
    authorizedByUserId: input.user_id,
    detachedByUserId: null,
    oauthClientId: input.oauth_client_id,
    status: "active" as const,
    accessTokenCiphertext: input.access_token_ciphertext,
    accessTokenIv: input.access_token_iv,
    refreshTokenCiphertext: input.refresh_token_ciphertext,
    refreshTokenIv: input.refresh_token_iv,
    accessTokenExpiresAt: input.access_token_expires_at,
    grantedScopesJson: input.granted_scopes_json,
    posthogHost: posthogCloudBaseUrl(input.region),
    posthogRegion: input.region,
    posthogOrganizationId: input.organization_id,
    posthogEnvironmentId: input.posthog_project_id,
    capabilitySnapshotJson: input.capability_snapshot_json,
    capabilitiesObservedAt: input.capabilities_observed_at,
    externalOwnership: "customer_owned" as const,
    externalDeletionPolicy: "detach_only" as const,
    authorizedAt: input.now,
    tokenRefreshedAt: null,
    refreshLeaseToken: null,
    refreshLeaseExpiresAt: null,
    lastVerifiedAt: input.capabilities_observed_at,
    lastUsedAt: null,
    reauthRequiredAt: null,
    detachedAt: null,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

type ConnectionStore = Pick<
  ReturnType<typeof getDb>,
  "select" | "insert" | "update" | "delete"
>;

async function upsertActiveConnection(
  tx: ConnectionStore,
  values: ReturnType<typeof activeConnectionValues>,
): Promise<PosthogConnection> {
    const existing = (
      await tx.select({
        posthogHost: posthogConnections.posthogHost,
        posthogEnvironmentId: posthogConnections.posthogEnvironmentId,
      }).from(posthogConnections)
        .where(eq(posthogConnections.projectId, values.projectId))
        .limit(1)
    )[0] ?? null;
    const providerIdentityChanged = existing !== null && (
      existing.posthogHost !== values.posthogHost
      || existing.posthogEnvironmentId !== values.posthogEnvironmentId
    );

    if (providerIdentityChanged) {
      try {
        // Cases are a replaceable projection of one provider identity. Remove
        // their live control rows in the same transaction that changes the
        // binding. Historical automation runs remain immutable, but lose the
        // now-untrusted case pointer just as the schema's SET NULL FK requires.
        await tx.delete(caseMutationCommands)
          .where(eq(caseMutationCommands.projectId, values.projectId));
        await tx.delete(caseClaims)
          .where(eq(caseClaims.projectId, values.projectId));
        await tx.delete(automationTriggerReceipts).where(and(
          eq(automationTriggerReceipts.projectId, values.projectId),
          isNotNull(automationTriggerReceipts.caseId),
        ));
        await tx.update(automationRuns).set({
          caseId: null,
          caseRevision: null,
        }).where(and(
          eq(automationRuns.projectId, values.projectId),
          isNotNull(automationRuns.caseId),
        ));
        await tx.delete(cases).where(eq(cases.projectId, values.projectId));
        const remaining = await tx.select({ id: cases.id }).from(cases)
          .where(eq(cases.projectId, values.projectId)).limit(1);
        if (remaining[0]) throw new PosthogProviderIdentityReconciliationError();
      } catch (error) {
        if (error instanceof PosthogProviderIdentityReconciliationError) throw error;
        throw new PosthogProviderIdentityReconciliationError();
      }
    }

    const rows = await tx.insert(posthogConnections).values(values).onConflictDoUpdate({
      target: posthogConnections.projectId,
      set: {
        authorizedByUserId: values.authorizedByUserId,
        detachedByUserId: null,
        oauthClientId: values.oauthClientId,
        status: values.status,
        accessTokenCiphertext: values.accessTokenCiphertext,
        accessTokenIv: values.accessTokenIv,
        refreshTokenCiphertext: values.refreshTokenCiphertext,
        refreshTokenIv: values.refreshTokenIv,
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        grantedScopesJson: values.grantedScopesJson,
        posthogHost: values.posthogHost,
        posthogRegion: values.posthogRegion,
        posthogOrganizationId: values.posthogOrganizationId,
        posthogEnvironmentId: values.posthogEnvironmentId,
        capabilitySnapshotJson: values.capabilitySnapshotJson,
        capabilitiesObservedAt: values.capabilitiesObservedAt,
        authorizedAt: values.authorizedAt,
        tokenRefreshedAt: null,
        refreshLeaseToken: null,
        refreshLeaseExpiresAt: null,
        lastVerifiedAt: values.lastVerifiedAt,
        lastUsedAt: null,
        reauthRequiredAt: null,
        detachedAt: null,
        ...(providerIdentityChanged
          ? {
              caseProjectionOffset: 0,
              caseProjectionLastAttemptAt: null,
              caseProjectionLastCompletedAt: null,
            }
          : {}),
        updatedAt: values.updatedAt,
        version: sql`${posthogConnections.version} + 1`,
      },
    }).returning();
    const row = rows[0];
    if (!row) throw new Error("PostHog connection upsert returned no row.");
    return row;
}

async function saveAuthenticatedConnection(input: {
  env: Env;
  attempt: PosthogOauthAttempt;
  tokens: PosthogOauthTokens;
  selected: PosthogScopedProject;
  capabilities: PosthogCapabilitySnapshot;
}): Promise<PosthogConnection> {
  const { attempt } = input;
  const region = attempt.posthogRegionHint;
  const projectId = attempt.projectId;
  const userId = attempt.userId;
  if (attempt.mode !== "connect" || !region || !projectId || !userId) {
    throw new Error("Authenticated PostHog OAuth attempt is missing its authority binding.");
  }
  const now = nowSeconds();
  const [access, refresh] = await Promise.all([
    encryptSecret(input.env, input.tokens.access_token),
    encryptSecret(input.env, input.tokens.refresh_token),
  ]);
  const scopes = grantedScopes(input.tokens, attempt);
  if (!scopes) throw new Error("PostHog OAuth scopes changed before connection settlement.");
  const scopesJson = JSON.stringify(scopes);
  const capabilityJson = JSON.stringify(input.capabilities);
  const values = activeConnectionValues({
    project_id: projectId,
    user_id: userId,
    oauth_client_id: attempt.oauthClientId,
    access_token_ciphertext: access.ciphertext,
    access_token_iv: access.iv,
    refresh_token_ciphertext: refresh.ciphertext,
    refresh_token_iv: refresh.iv,
    access_token_expires_at: tokenExpiry(input.tokens, now),
    granted_scopes_json: scopesJson,
    region,
    organization_id: input.selected.organization_id,
    posthog_project_id: input.selected.posthog_project_id,
    capability_snapshot_json: capabilityJson,
    capabilities_observed_at: input.capabilities.checked_at,
    now,
  });
  return await getDb(input.env).transaction(async (tx) => {
    const row = await upsertActiveConnection(tx, values);
    const attempts = await tx.update(posthogOauthAttempts).set({
      status: "claimed",
      pkceVerifierCiphertext: null,
      pkceVerifierIv: null,
      oidcNonceCiphertext: null,
      oidcNonceIv: null,
      connectionId: row.id,
      grantedScopesJson: scopesJson,
      posthogHost: values.posthogHost,
      posthogOrganizationId: values.posthogOrganizationId,
      posthogEnvironmentId: values.posthogEnvironmentId,
      capabilitySnapshotJson: capabilityJson,
      capabilitiesObservedAt: input.capabilities.checked_at,
      authorizedAt: now,
      claimedAt: now,
      updatedAt: now,
      version: attempt.version + 1,
    }).where(and(
      eq(posthogOauthAttempts.id, attempt.id),
      eq(posthogOauthAttempts.status, "exchanging"),
      eq(posthogOauthAttempts.version, attempt.version),
    )).returning({ id: posthogOauthAttempts.id });
    if (!attempts[0]) {
      throw new Error("PostHog OAuth attempt was superseded before authorization settled.");
    }
    return row;
  });
}

async function saveBootstrapAuthorization(input: {
  env: Env;
  attempt: PosthogOauthAttempt;
  user_id: string;
  tokens: PosthogOauthTokens;
  selected: PosthogScopedProject;
  capabilities: PosthogCapabilitySnapshot;
  handoff_code_hash: string;
}): Promise<void> {
  if (input.attempt.mode !== "bootstrap" || input.attempt.projectId !== null) {
    throw new Error("Bootstrap PostHog OAuth attempt has invalid authority state.");
  }
  const region = input.attempt.posthogRegionHint;
  if (!region) throw new Error("PostHog OAuth attempt is missing its region binding.");
  const now = nowSeconds();
  const accessExpiresAt = tokenExpiry(input.tokens, now);
  const handoffExpiresAt = Math.min(
    now + OAUTH_HANDOFF_TTL_SECONDS,
    accessExpiresAt - ACCESS_TOKEN_SKEW_SECONDS,
  );
  const [access, refresh] = await Promise.all([
    encryptSecret(input.env, input.tokens.access_token),
    encryptSecret(input.env, input.tokens.refresh_token),
  ]);
  const scopes = grantedScopes(input.tokens, input.attempt);
  if (!scopes) throw new Error("PostHog OAuth scopes changed before bootstrap settlement.");
  const rows = await getDb(input.env).update(posthogOauthAttempts).set({
    status: "authorized",
    userId: input.user_id,
    handoffCodeHash: input.handoff_code_hash,
    handoffExpiresAt,
    handoffFailureCount: 0,
    pkceVerifierCiphertext: null,
    pkceVerifierIv: null,
    oidcNonceCiphertext: null,
    oidcNonceIv: null,
    pendingAccessTokenCiphertext: access.ciphertext,
    pendingAccessTokenIv: access.iv,
    pendingRefreshTokenCiphertext: refresh.ciphertext,
    pendingRefreshTokenIv: refresh.iv,
    pendingAccessTokenExpiresAt: accessExpiresAt,
    grantedScopesJson: JSON.stringify(scopes),
    posthogHost: posthogCloudBaseUrl(region),
    posthogOrganizationId: input.selected.organization_id,
    posthogEnvironmentId: input.selected.posthog_project_id,
    capabilitySnapshotJson: JSON.stringify(input.capabilities),
    capabilitiesObservedAt: input.capabilities.checked_at,
    expiresAt: handoffExpiresAt,
    authorizedAt: now,
    updatedAt: now,
    version: input.attempt.version + 1,
  }).where(and(
    eq(posthogOauthAttempts.id, input.attempt.id),
    eq(posthogOauthAttempts.mode, "bootstrap"),
    eq(posthogOauthAttempts.status, "exchanging"),
    eq(posthogOauthAttempts.version, input.attempt.version),
    isNull(posthogOauthAttempts.projectId),
  )).returning({ id: posthogOauthAttempts.id });
  if (!rows[0]) {
    throw new Error("PostHog bootstrap authorization was superseded before settlement.");
  }
}

function invalidAuthorizationClaim(
  status: 404 | 409 | 410,
  code: string,
  message: string,
  nextAction: string,
): AgentryError {
  return new AgentryError({ status, code, message, nextAction });
}

export async function claimPosthogAuthorization(input: {
  env: Env;
  authorization_id: string;
  project_id: string;
  user_id: string;
}): Promise<{
  connection: PosthogConnectionView;
  authorization_id: string;
  idempotent_replay: boolean;
  next_action: string;
}> {
  const db = getDb(input.env);
  const attempt = (
    await db.select().from(posthogOauthAttempts).where(and(
      eq(posthogOauthAttempts.id, input.authorization_id),
      eq(posthogOauthAttempts.mode, "bootstrap"),
      eq(posthogOauthAttempts.userId, input.user_id),
    )).limit(1)
  )[0];
  if (!attempt) {
    throw invalidAuthorizationClaim(
      404,
      "posthog_authorization_not_found",
      "The PostHog authorization is missing or does not belong to this owner.",
      "Start a new PostHog authorization and poll it with the same local owner session.",
    );
  }

  if (attempt.status === "claimed" && attempt.projectId === input.project_id) {
    const row = await loadConnection(input.env, input.project_id);
    if (row && row.id === attempt.connectionId) {
      return {
        connection: posthogConnectionView(row),
        authorization_id: attempt.id,
        idempotent_replay: true,
        next_action: "Delete the local authorization_id and continue onboarding.",
      };
    }
  }

  const now = nowSeconds();
  if (
    attempt.status === "expired" ||
    attempt.expiresAt <= now ||
    (attempt.pendingAccessTokenExpiresAt !== null &&
      attempt.pendingAccessTokenExpiresAt <= now + ACCESS_TOKEN_SKEW_SECONDS)
  ) {
    if (attempt.status === "authorized") {
      await db.update(posthogOauthAttempts).set({
        status: "expired",
        pendingAccessTokenCiphertext: null,
        pendingAccessTokenIv: null,
        pendingRefreshTokenCiphertext: null,
        pendingRefreshTokenIv: null,
        pendingAccessTokenExpiresAt: null,
        authorizedAt: null,
        expiredAt: now,
        updatedAt: now,
        version: attempt.version + 1,
      }).where(and(
        eq(posthogOauthAttempts.id, attempt.id),
        eq(posthogOauthAttempts.status, "authorized"),
        eq(posthogOauthAttempts.version, attempt.version),
      ));
    }
    throw invalidAuthorizationClaim(
      410,
      "posthog_authorization_expired",
      "The one-time PostHog authorization has expired.",
      "Start and complete a new PostHog authorization, then claim its new authorization_id.",
    );
  }
  if (attempt.status !== "authorized" || attempt.pollConsumedAt === null) {
    throw invalidAuthorizationClaim(
      409,
      "posthog_authorization_not_claimable",
      "The PostHog authorization is not ready to be claimed.",
      "Complete browser consent and successfully poll before claiming the returned authorization_id.",
    );
  }
  if (
    !attempt.posthogRegionHint ||
    !attempt.posthogHost ||
    attempt.posthogHost !== posthogCloudBaseUrl(attempt.posthogRegionHint) ||
    !attempt.posthogEnvironmentId ||
    !attempt.capabilitiesObservedAt ||
    !attempt.pendingAccessTokenCiphertext ||
    !attempt.pendingAccessTokenIv ||
    !attempt.pendingRefreshTokenCiphertext ||
    !attempt.pendingRefreshTokenIv ||
    !attempt.pendingAccessTokenExpiresAt
  ) {
    throw invalidAuthorizationClaim(
      409,
      "posthog_authorization_incomplete",
      "The stored PostHog authorization is incomplete and cannot be moved into a project.",
      "Start a new PostHog authorization; the incomplete grant will not be exposed or reused.",
    );
  }

  const values = activeConnectionValues({
    project_id: input.project_id,
    user_id: input.user_id,
    oauth_client_id: attempt.oauthClientId,
    access_token_ciphertext: attempt.pendingAccessTokenCiphertext,
    access_token_iv: attempt.pendingAccessTokenIv,
    refresh_token_ciphertext: attempt.pendingRefreshTokenCiphertext,
    refresh_token_iv: attempt.pendingRefreshTokenIv,
    access_token_expires_at: attempt.pendingAccessTokenExpiresAt,
    granted_scopes_json: attempt.grantedScopesJson,
    region: attempt.posthogRegionHint,
    organization_id: attempt.posthogOrganizationId,
    posthog_project_id: attempt.posthogEnvironmentId,
    capability_snapshot_json: attempt.capabilitySnapshotJson,
    capabilities_observed_at: attempt.capabilitiesObservedAt,
    now,
  });
  const row = await db.transaction(async (tx) => {
    const connected = await upsertActiveConnection(tx, values);
    const claimed = await tx.update(posthogOauthAttempts).set({
      status: "claimed",
      projectId: input.project_id,
      connectionId: connected.id,
      pendingAccessTokenCiphertext: null,
      pendingAccessTokenIv: null,
      pendingRefreshTokenCiphertext: null,
      pendingRefreshTokenIv: null,
      pendingAccessTokenExpiresAt: null,
      handoffCodeHash: null,
      handoffExpiresAt: null,
      handoffFailureCount: 0,
      claimedAt: now,
      updatedAt: now,
      version: attempt.version + 1,
    }).where(and(
      eq(posthogOauthAttempts.id, attempt.id),
      eq(posthogOauthAttempts.mode, "bootstrap"),
      eq(posthogOauthAttempts.status, "authorized"),
      eq(posthogOauthAttempts.userId, input.user_id),
      eq(posthogOauthAttempts.version, attempt.version),
      isNull(posthogOauthAttempts.projectId),
      isNotNull(posthogOauthAttempts.pollConsumedAt),
    )).returning({ id: posthogOauthAttempts.id });
    if (!claimed[0]) {
      throw invalidAuthorizationClaim(
        409,
        "posthog_authorization_claim_conflict",
        "The PostHog authorization changed before its project claim could commit.",
        "Read the project connection. If it is not active, start a new PostHog authorization.",
      );
    }
    return connected;
  });
  return {
    connection: posthogConnectionView(row),
    authorization_id: attempt.id,
    idempotent_replay: false,
    next_action: "Delete the local authorization_id and continue onboarding.",
  };
}

export async function settlePosthogOauthCallback(input: {
  env: Env;
  state: string;
  code?: string;
  provider_error?: string;
}): Promise<PosthogOauthCallbackResult> {
  const claim = await claimOauthAttempt(input.env, input.state);
  if ("terminal" in claim) return await callbackTerminalResult(input.env, claim.terminal);
  const attempt = claim;
  if (input.provider_error || !input.code) {
    const errorCode = safeOauthErrorCode(input.provider_error ?? "callback_code_missing");
    await failOauthAttempt(input.env, attempt, errorCode);
    return failedCallback(attempt, errorCode);
  }
  if (
    !attempt.posthogRegionHint ||
    !attempt.pkceVerifierCiphertext ||
    !attempt.pkceVerifierIv ||
    !attempt.oidcNonceCiphertext ||
    !attempt.oidcNonceIv
  ) {
    await failOauthAttempt(input.env, attempt, "posthog_oauth_attempt_invalid");
    return failedCallback(attempt, "posthog_oauth_attempt_invalid");
  }

  let tokens: PosthogOauthTokens | null = null;
  try {
    const [verifier, nonce] = await Promise.all([
      decryptSecret(
        input.env,
        attempt.pkceVerifierCiphertext,
        attempt.pkceVerifierIv,
      ),
      decryptSecret(
        input.env,
        attempt.oidcNonceCiphertext,
        attempt.oidcNonceIv,
      ),
    ]);
    const exchanged = await exchangePosthogOauthCode({
      region: attempt.posthogRegionHint,
      code: input.code,
      code_verifier: verifier,
      client_id: attempt.oauthClientId,
      redirect_uri: attempt.redirectUri,
    });
    tokens = exchanged;
    const oidcIdentity = await verifyPosthogOidcIdentity({
      region: attempt.posthogRegionHint,
      id_token: exchanged.id_token,
      client_id: attempt.oauthClientId,
      nonce,
    });
    const scopes = grantedScopes(tokens, attempt);
    if (!scopes) {
      await failOauthAttempt(input.env, attempt, "posthog_required_read_scope_missing");
      await bestEffortRevokeTokens(attempt, tokens);
      return failedCallback(attempt, "posthog_required_read_scope_missing");
    }
    // `required_access_level=project` makes PostHog's consent screen the
    // project selector. Resolve identity from that provider-issued binding;
    // never enumerate projects or read their ingestion API tokens.
    const selected = resolvePosthogScopedProject(tokens);
    if (
      !selected ||
      (attempt.posthogEnvironmentIdHint !== null &&
        attempt.posthogEnvironmentIdHint !== selected.posthog_project_id)
    ) {
      await failOauthAttempt(input.env, attempt, "posthog_single_project_consent_required");
      await bestEffortRevokeTokens(attempt, tokens);
      return failedCallback(attempt, "posthog_single_project_consent_required");
    }
    const capabilities = await verifyPosthogReadCapabilities({
      region: attempt.posthogRegionHint,
      access_token: tokens.access_token,
      posthog_project_id: selected.posthog_project_id,
    });
    if (capabilities.issues.length) {
      await failOauthAttempt(input.env, attempt, "posthog_required_read_capability_missing");
      await bestEffortRevokeTokens(attempt, tokens);
      return failedCallback(attempt, "posthog_required_read_capability_missing");
    }
    if (attempt.mode === "bootstrap") {
      const principal = await resolveOrCreatePosthogUser(input.env, oidcIdentity);
      if (!attempt.handoffRedirectUri || !attempt.handoffChallenge) {
        throw new Error("PostHog bootstrap attempt lost its localhost handoff binding.");
      }
      const handoffTicket = randomHandoffTicket();
      await saveBootstrapAuthorization({
        env: input.env,
        attempt,
        user_id: principal.userId,
        tokens,
        selected,
        capabilities,
        handoff_code_hash: await hashPosthogHandoffTicket(attempt.id, handoffTicket),
      });
      return {
        outcome: "authorization_ready",
        project_id: null,
        handoff_redirect_uri: attempt.handoffRedirectUri,
        handoff_ticket: handoffTicket,
      };
    }

    const principal = await resolveExistingPosthogUser(input.env, oidcIdentity);
    if (!principal || principal.userId !== attempt.userId) {
      await failOauthAttempt(input.env, attempt, "posthog_identity_mismatch");
      await bestEffortRevokeTokens(attempt, tokens);
      return failedCallback(attempt, "posthog_identity_mismatch");
    }
    await refreshPosthogIdentityMetadata(
      input.env,
      principal.identityId,
      principal.userId,
      oidcIdentity,
    );
    const row = await saveAuthenticatedConnection({
      env: input.env,
      attempt,
      tokens,
      selected,
      capabilities,
    });
    if (!attempt.projectId) {
      throw new Error("Authenticated PostHog OAuth attempt lost its project binding.");
    }
    return {
      outcome: "active",
      project_id: attempt.projectId,
      connection: posthogConnectionView(row),
    };
  } catch (error) {
    const providerError = error instanceof PosthogOauthProviderError ? error : undefined;
    const errorCode = error instanceof PosthogProviderIdentityReconciliationError
      ? "posthog_provider_identity_reconciliation_failed"
      : providerError
        ? safeOauthErrorCode(providerError.oauthCode ?? providerError.operation)
        : "posthog_oauth_settlement_failed";
    await failOauthAttempt(input.env, attempt, errorCode, providerError);
    if (tokens) await bestEffortRevokeTokens(attempt, tokens);
    return failedCallback(attempt, errorCode);
  }
}

function failedCallback(
  attempt: PosthogOauthAttempt,
  errorCode: string,
): PosthogOauthCallbackResult {
  return {
    outcome: "failed",
    project_id: attempt.projectId,
    error_code: errorCode,
    ...(attempt.mode === "bootstrap" && attempt.handoffRedirectUri
      ? { handoff_redirect_uri: attempt.handoffRedirectUri }
      : {}),
  };
}

function connectionStateError(row: PosthogConnection | null, expected: string): AgentryError {
  return new AgentryError({
    status: 409,
    code: "posthog_connection_state_conflict",
    message: `PostHog connection must be ${expected} for this operation.`,
    nextAction: row?.status === "reauth_required" || row?.status === "detached" || !row
      ? "Start a new PostHog connection and complete browser authorization."
      : "Read the current PostHog connection state and perform only its next_action.",
    details: { expected_status: expected, actual_status: row?.status ?? "detached" },
  });
}

function providerApiError(error: PosthogOauthProviderError): AgentryError {
  return new AgentryError({
    status: error.status >= 500 ? 502 : 424,
    code: "posthog_upstream_failed",
    message: `PostHog ${error.operation} failed with status ${error.status}.`,
    nextAction: error.status === 401 || error.status === 403
      ? "Reconnect PostHog and approve every requested read scope."
      : "Retry with backoff. If this persists, inspect the PostHog Cloud service status and the selected project.",
    details: {
      operation: error.operation,
      upstream_status: error.status,
      oauth_code: error.oauthCode,
    },
  });
}

async function markConnectionReauthRequired(
  env: Env,
  row: PosthogConnection,
): Promise<boolean> {
  const now = nowSeconds();
  const changed = await getDb(env).update(posthogConnections).set({
    status: "reauth_required",
    accessTokenCiphertext: null,
    accessTokenIv: null,
    refreshTokenCiphertext: null,
    refreshTokenIv: null,
    accessTokenExpiresAt: null,
    refreshLeaseToken: null,
    refreshLeaseExpiresAt: null,
    reauthRequiredAt: now,
    detachedAt: null,
    updatedAt: now,
    version: row.version + 1,
  }).where(and(
    eq(posthogConnections.id, row.id),
    eq(posthogConnections.version, row.version),
    eq(posthogConnections.status, "active"),
  )).returning({ id: posthogConnections.id });
  return Boolean(changed[0]);
}

async function accessTokenForConnection(
  env: Env,
  initial: PosthogConnection,
  retries = REFRESH_WAIT_ATTEMPTS,
): Promise<{ row: PosthogConnection; accessToken: string }> {
  if (initial.status !== "active") throw connectionStateError(initial, "active");
  if (
    !initial.accessTokenCiphertext || !initial.accessTokenIv ||
    !initial.refreshTokenCiphertext || !initial.refreshTokenIv ||
    !initial.accessTokenExpiresAt
  ) throw connectionStateError(initial, "active with OAuth credentials");
  const now = nowSeconds();
  if (initial.accessTokenExpiresAt > now + ACCESS_TOKEN_SKEW_SECONDS) {
    return {
      row: initial,
      accessToken: await decryptSecret(
        env,
        initial.accessTokenCiphertext,
        initial.accessTokenIv,
      ),
    };
  }

  const leaseToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const leased = (
    await getDb(env).update(posthogConnections).set({
      refreshLeaseToken: leaseToken,
      refreshLeaseExpiresAt: now + REFRESH_LEASE_TTL_SECONDS,
      updatedAt: now,
      version: initial.version + 1,
    }).where(and(
      eq(posthogConnections.id, initial.id),
      eq(posthogConnections.version, initial.version),
      eq(posthogConnections.status, "active"),
      sql`(${posthogConnections.refreshLeaseToken} IS NULL
        OR ${posthogConnections.refreshLeaseExpiresAt} <= ${now})`,
    )).returning()
  )[0];
  if (!leased) {
    const current = await loadConnection(env, initial.projectId);
    if (!current) throw connectionStateError(null, "active");
    if (current.status !== "active") throw connectionStateError(current, "active");
    if (retries <= 0) {
      throw new AgentryError({
        status: 503,
        code: "posthog_token_refresh_in_progress",
        message: "Another request is refreshing the PostHog authorization.",
        nextAction: "Retry this read with short backoff.",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 25 * (REFRESH_WAIT_ATTEMPTS - retries + 1)));
    return await accessTokenForConnection(env, current, retries - 1);
  }

  const releaseLease = async (): Promise<void> => {
    await getDb(env).update(posthogConnections).set({
      refreshLeaseToken: null,
      refreshLeaseExpiresAt: null,
      updatedAt: nowSeconds(),
      version: leased.version + 1,
    }).where(and(
      eq(posthogConnections.id, leased.id),
      eq(posthogConnections.version, leased.version),
      eq(posthogConnections.refreshLeaseToken, leaseToken),
      eq(posthogConnections.status, "active"),
    ));
  };

  const refreshToken = await decryptSecret(
    env,
    leased.refreshTokenCiphertext!,
    leased.refreshTokenIv!,
  ).catch(async (error) => {
    await releaseLease();
    throw error;
  });
  let tokens: PosthogOauthTokens;
  try {
    tokens = await refreshPosthogOauthTokens({
      region: leased.posthogRegion,
      refresh_token: refreshToken,
      client_id: leased.oauthClientId,
    });
  } catch (error) {
    if (
      error instanceof PosthogOauthProviderError &&
      (error.status === 400 || error.status === 401 || error.status === 403)
    ) {
      const marked = await markConnectionReauthRequired(env, leased);
      if (!marked && retries > 0) {
        const current = await loadConnection(env, leased.projectId);
        if (current) return await accessTokenForConnection(env, current, retries - 1);
      }
      throw new AgentryError({
        status: 401,
        code: "posthog_reauthorization_required",
        message: "PostHog OAuth authorization is no longer usable.",
        nextAction: "Start a new PostHog connection and complete browser authorization.",
      });
    }
    await releaseLease();
    if (error instanceof PosthogOauthProviderError) throw providerApiError(error);
    throw error;
  }
  const scopes = exactScopeSet(tokens.scope);
  if (!scopes) {
    await revokeRefreshedTokens(leased, tokens);
    await markConnectionReauthRequired(env, leased);
    throw new AgentryError({
      status: 401,
      code: "posthog_reauthorization_required",
      message: "PostHog OAuth authorization no longer grants every required read scope.",
      nextAction: "Start a new PostHog connection and approve every requested read scope.",
    });
  }
  let access: Awaited<ReturnType<typeof encryptSecret>>;
  let refresh: Awaited<ReturnType<typeof encryptSecret>>;
  try {
    [access, refresh] = await Promise.all([
      encryptSecret(env, tokens.access_token),
      encryptSecret(env, tokens.refresh_token),
    ]);
  } catch (error) {
    await releaseLease();
    throw error;
  }
  const refreshedAt = nowSeconds();
  const updated = await getDb(env).update(posthogConnections).set({
    accessTokenCiphertext: access.ciphertext,
    accessTokenIv: access.iv,
    refreshTokenCiphertext: refresh.ciphertext,
    refreshTokenIv: refresh.iv,
    accessTokenExpiresAt: tokenExpiry(tokens, refreshedAt),
    grantedScopesJson: JSON.stringify(scopes),
    tokenRefreshedAt: refreshedAt,
    refreshLeaseToken: null,
    refreshLeaseExpiresAt: null,
    updatedAt: refreshedAt,
    version: leased.version + 1,
  }).where(and(
    eq(posthogConnections.id, leased.id),
    eq(posthogConnections.version, leased.version),
    eq(posthogConnections.refreshLeaseToken, leaseToken),
    eq(posthogConnections.status, "active"),
  )).returning();
  if (updated[0]) return { row: updated[0], accessToken: tokens.access_token };
  await revokeRefreshedTokens(leased, tokens);
  if (retries <= 0) throw connectionStateError(await loadConnection(env, leased.projectId), leased.status);
  const current = await loadConnection(env, leased.projectId);
  if (!current) throw connectionStateError(null, leased.status);
  return await accessTokenForConnection(env, current, retries - 1);
}

async function revokeRefreshedTokens(
  row: PosthogConnection,
  tokens: PosthogOauthTokens,
): Promise<void> {
  await Promise.all([
    revokePosthogOauthToken({
      region: row.posthogRegion,
      token: tokens.access_token,
      token_type_hint: "access_token",
      client_id: row.oauthClientId,
    }),
    revokePosthogOauthToken({
      region: row.posthogRegion,
      token: tokens.refresh_token,
      token_type_hint: "refresh_token",
      client_id: row.oauthClientId,
    }),
  ]).catch(() => {});
}

export async function getPosthogConnectionAccess(
  env: Env,
  projectId: string,
): Promise<PosthogConnectionAccess> {
  const initial = await loadConnection(env, projectId);
  if (!initial || initial.status !== "active") throw connectionStateError(initial, "active");
  if (!hasExactRequiredScopes(parseStringArray(initial.grantedScopesJson))) {
    await markConnectionReauthRequired(env, initial);
    throw new AgentryError({
      status: 401,
      code: "posthog_reauthorization_required",
      message: "PostHog OAuth authorization does not grant every required read scope.",
      nextAction: "Reconnect PostHog and approve every requested read scope.",
    });
  }
  const { row, accessToken } = await accessTokenForConnection(env, initial);
  if (
    row.status !== "active" || !row.posthogEnvironmentId
  ) throw connectionStateError(row, "active");
  void getDb(env).update(posthogConnections).set({ lastUsedAt: nowSeconds() })
    .where(and(eq(posthogConnections.id, row.id), eq(posthogConnections.version, row.version)))
    .catch(() => {});
  return {
    connection_id: row.id,
    project_id: row.projectId,
    region: row.posthogRegion,
    posthog_host: row.posthogHost,
    posthog_project_id: row.posthogEnvironmentId,
    access_token: accessToken,
    scopes: parseStringArray(row.grantedScopesJson),
    version: row.version,
  };
}

export async function detachPosthogConnection(input: {
  env: Env;
  project_id: string;
  user_id: string;
}): Promise<{
  connection: PosthogConnectionView;
  revocation_confirmed: boolean | null;
  customer_posthog_data_affected: false;
  next_action: string | null;
}> {
  const db = getDb(input.env);
  const initial = await loadConnection(input.env, input.project_id);
  if (!initial || initial.status === "detached") {
    return {
      connection: posthogConnectionView(initial),
      revocation_confirmed: null,
      customer_posthog_data_affected: false,
      next_action: null,
    };
  }
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  if (initial.accessTokenCiphertext && initial.accessTokenIv) {
    accessToken = await decryptSecret(input.env, initial.accessTokenCiphertext, initial.accessTokenIv)
      .catch(() => null);
  }
  if (initial.refreshTokenCiphertext && initial.refreshTokenIv) {
    refreshToken = await decryptSecret(input.env, initial.refreshTokenCiphertext, initial.refreshTokenIv)
      .catch(() => null);
  }
  const now = nowSeconds();
  const detached = await db.transaction(async (tx) => {
    await tx.update(posthogOauthAttempts).set({
      status: "expired",
      pkceVerifierCiphertext: null,
      pkceVerifierIv: null,
      oidcNonceCiphertext: null,
      oidcNonceIv: null,
      connectionId: null,
      errorCode: null,
      errorMetadataJson: "{}",
      expiredAt: now,
      updatedAt: now,
      version: sql`${posthogOauthAttempts.version} + 1`,
    }).where(and(
      eq(posthogOauthAttempts.projectId, input.project_id),
      inArray(posthogOauthAttempts.status, ["pending", "exchanging"]),
    ));
    const rows = await tx.update(posthogConnections).set({
      status: "detached",
      detachedByUserId: input.user_id,
      accessTokenCiphertext: null,
      accessTokenIv: null,
      refreshTokenCiphertext: null,
      refreshTokenIv: null,
      accessTokenExpiresAt: null,
      refreshLeaseToken: null,
      refreshLeaseExpiresAt: null,
      grantedScopesJson: "[]",
      posthogOrganizationId: null,
      posthogEnvironmentId: null,
      capabilitySnapshotJson: "{}",
      capabilitiesObservedAt: null,
      lastVerifiedAt: null,
      reauthRequiredAt: null,
      detachedAt: now,
      updatedAt: now,
      version: initial.version + 1,
    }).where(and(
      eq(posthogConnections.id, initial.id),
      eq(posthogConnections.version, initial.version),
    )).returning();
    if (!rows[0]) throw connectionStateError(initial, initial.status);
    return rows[0];
  });

  const confirmations: boolean[] = [];
  if (accessToken) {
    confirmations.push(await revokePosthogOauthToken({
      region: initial.posthogRegion,
      token: accessToken,
      token_type_hint: "access_token",
      client_id: initial.oauthClientId,
    }).catch(() => false));
  }
  if (refreshToken) {
    confirmations.push(await revokePosthogOauthToken({
      region: initial.posthogRegion,
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: initial.oauthClientId,
    }).catch(() => false));
  }
  const revocationConfirmed = confirmations.length > 0
    ? confirmations.every(Boolean)
    : null;
  return {
    connection: posthogConnectionView(detached),
    revocation_confirmed: revocationConfirmed,
    customer_posthog_data_affected: false,
    next_action: revocationConfirmed === false
      ? "Local OAuth ciphertext was destroyed. Review authorized applications in PostHog because provider revocation was not confirmed."
      : null,
  };
}
