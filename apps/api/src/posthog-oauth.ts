import {
  base64url,
  constantTimeEqual,
  fromBase64url,
  sha256Hex,
} from "@agentrysh/shared";
import { z } from "zod";
import type { Env } from "./env.js";

export const POSTHOG_OAUTH_REGIONS = ["us", "eu"] as const;
export type PosthogOauthRegion = typeof POSTHOG_OAUTH_REGIONS[number];

export const POSTHOG_OAUTH_SCOPES = [
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
] as const;

export const POSTHOG_OAUTH_CLIENT_PATH =
  "/v1/integrations/posthog/oauth/client" as const;
export const POSTHOG_OAUTH_CALLBACK_PATH =
  "/v1/integrations/posthog/oauth/callback" as const;

const PROVIDER_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const MAX_JWKS_BODY_BYTES = 65_536;
const MAX_JWKS_KEYS = 16;
const MAX_ID_TOKEN_CHARACTERS = 32_768;
const MAX_JWT_HEADER_BYTES = 4_096;
const MAX_JWT_PAYLOAD_BYTES = 16_384;
const MAX_JWT_SIGNATURE_BYTES = 512;
const MIN_RSA_MODULUS_BYTES = 256;
const MAX_RSA_MODULUS_BYTES = 512;
const MAX_RSA_EXPONENT_BYTES = 8;
const OIDC_CLOCK_SKEW_SECONDS = 60;
const MAX_SCOPED_ORGANIZATIONS = 20;
const MAX_SCOPED_PROJECTS = 100;

const IdTokenSchema = z.string().min(1).max(MAX_ID_TOKEN_CHARACTERS);

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(8_192),
  expires_in: z.number().int().positive().max(31_536_000),
  token_type: z.string().regex(/^Bearer$/i),
  scope: z.string().min(1).max(16_384),
  id_token: IdTokenSchema.optional(),
  scoped_organizations: z.array(z.string().uuid()).max(MAX_SCOPED_ORGANIZATIONS).optional(),
  scoped_teams: z.array(z.number().int().positive()).max(MAX_SCOPED_PROJECTS).optional(),
}).passthrough();

const CodeTokenResponseSchema = TokenResponseSchema.extend({
  id_token: IdTokenSchema,
});

const JwkSchema = z.object({
  kty: z.literal("RSA"),
  use: z.literal("sig"),
  alg: z.literal("RS256"),
  kid: z.string().min(1).max(256),
  n: z.string().min(1).max(1_024).regex(/^[A-Za-z0-9_-]+$/),
  e: z.string().min(1).max(16).regex(/^[A-Za-z0-9_-]+$/),
  key_ops: z.array(z.string().min(1).max(32)).max(8).optional(),
}).passthrough();

const JwksSchema = z.object({
  // Parse the bounded set before selecting an RS256 signing key. PostHog may
  // publish keys for another supported algorithm during a rotation; those
  // keys must never become eligible for this verifier, but their presence
  // should not make an otherwise valid RS256 key unusable.
  keys: z.array(z.unknown()).min(1).max(MAX_JWKS_KEYS),
}).passthrough();

export type PosthogOauthTokens = z.output<typeof TokenResponseSchema>;
export type PosthogOauthCodeTokens = z.output<typeof CodeTokenResponseSchema>;

export type PosthogOidcIdentity = {
  issuer: string;
  subject: string;
  email: string | null;
  email_verified: boolean | null;
};

export type PosthogScopedProject = {
  organization_id: string | null;
  posthog_project_id: number;
};

export type PosthogCapabilitySnapshot = {
  version: "posthog-cloud-read-v2";
  checked_at: number;
  project_read: true;
  query_read: true;
  event_definitions_read: boolean;
  property_definitions_read: boolean;
  error_tracking_read: boolean;
  session_recordings_read: boolean;
  feature_flags_read: boolean;
  surveys_read: boolean;
  experiments_read: boolean;
  issues: Array<{
    capability:
      | "event_definitions_read"
      | "property_definitions_read"
      | "error_tracking_read"
      | "session_recordings_read"
      | "feature_flags_read"
      | "surveys_read"
      | "experiments_read";
    upstream_status: number;
  }>;
};

type OptionalPosthogReadCapability = PosthogCapabilitySnapshot["issues"][number]["capability"];

export class PosthogOauthProviderError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly oauthCode: string | null;
  readonly bodyExcerpt: string;

  constructor(input: {
    operation: string;
    status: number;
    oauthCode?: string | null;
    bodyExcerpt?: string;
  }) {
    super(`PostHog ${input.operation} failed with status ${input.status}.`);
    this.name = "PosthogOauthProviderError";
    this.operation = input.operation;
    this.status = input.status;
    this.oauthCode = input.oauthCode ?? null;
    this.bodyExcerpt = input.bodyExcerpt?.slice(0, 400) ?? "";
  }
}

export function posthogCloudBaseUrl(region: PosthogOauthRegion): string {
  return region === "us" ? "https://us.posthog.com" : "https://eu.posthog.com";
}

export function posthogOauthClientId(env: Env, requestOrigin: string): string {
  return env.POSTHOG_OAUTH_CLIENT_ID?.trim() ||
    `${posthogOauthOrigin(env, requestOrigin)}${POSTHOG_OAUTH_CLIENT_PATH}`;
}

export function posthogOauthRedirectUri(env: Env, requestOrigin: string): string {
  const configured = env.POSTHOG_OAUTH_REDIRECT_URI?.trim();
  if (configured) return validatedRedirectUri(configured);
  return `${posthogOauthOrigin(env, requestOrigin)}${POSTHOG_OAUTH_CALLBACK_PATH}`;
}

export function posthogOauthOrigin(env: Env, requestOrigin: string): string {
  const configured = env.AGENTRY_URL?.trim();
  if (configured) return validatedOrigin(configured);
  if (env.AGENTRY_ENVIRONMENT === "production") {
    throw new Error("AGENTRY_URL must define the trusted production OAuth origin");
  }
  return validatedOrigin(requestOrigin);
}

function validatedOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("request origin must be an exact origin");
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname) && url.hostname !== "test") {
    throw new Error("OAuth request origin must use HTTPS outside loopback/test");
  }
  return url.origin;
}

function validatedRedirectUri(value: string): string {
  const url = new URL(value);
  if (
    url.username || url.password || url.search || url.hash ||
    url.pathname !== POSTHOG_OAUTH_CALLBACK_PATH ||
    (url.protocol !== "https:" && !isLoopback(url.hostname) && url.hostname !== "test")
  ) {
    throw new Error(
      `POSTHOG_OAUTH_REDIRECT_URI must be an exact HTTPS ${POSTHOG_OAUTH_CALLBACK_PATH} URL`,
    );
  }
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export async function createPosthogOauthAuthorization(input: {
  env: Env;
  request_origin: string;
  region: PosthogOauthRegion;
}): Promise<{
  authorization_url: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  state_sha256: string;
  nonce: string;
  nonce_sha256: string;
  code_verifier: string;
  code_challenge: string;
  scopes: string[];
}> {
  const state = randomBase64url(32);
  const nonce = randomBase64url(32);
  const codeVerifier = randomBase64url(32);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64url(new Uint8Array(challengeBytes));
  const clientId = posthogOauthClientId(input.env, input.request_origin);
  const redirectUri = posthogOauthRedirectUri(input.env, input.request_origin);
  // PostHog's canonical OAuth endpoints include a trailing slash. In
  // particular, relying on Django's APPEND_SLASH redirect for the token POST
  // can discard the request body, so keep both browser and back-channel calls
  // on the exact provider path.
  const url = new URL("/oauth/authorize/", posthogCloudBaseUrl(input.region));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", POSTHOG_OAUTH_SCOPES.join(" "));
  url.searchParams.set("required_access_level", "project");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  return {
    authorization_url: url.toString(),
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    state_sha256: await sha256Hex(state),
    nonce,
    nonce_sha256: await sha256Hex(nonce),
    code_verifier: codeVerifier,
    code_challenge: codeChallenge,
    scopes: [...POSTHOG_OAUTH_SCOPES],
  };
}

function randomBase64url(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function exchangePosthogOauthCode(input: {
  region: PosthogOauthRegion;
  code: string;
  code_verifier: string;
  client_id: string;
  redirect_uri: string;
}): Promise<PosthogOauthCodeTokens> {
  return await postToken(input.region, "oauth_code_exchange", CodeTokenResponseSchema, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.code_verifier,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
  });
}

export async function refreshPosthogOauthTokens(input: {
  region: PosthogOauthRegion;
  refresh_token: string;
  client_id: string;
}): Promise<PosthogOauthTokens> {
  return await postToken(input.region, "oauth_token_refresh", TokenResponseSchema, {
    grant_type: "refresh_token",
    refresh_token: input.refresh_token,
    client_id: input.client_id,
  });
}

async function postToken<T>(
  region: PosthogOauthRegion,
  operation: string,
  schema: z.ZodType<T>,
  body: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${posthogCloudBaseUrl(region)}/oauth/token/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "agentry-api/1.0",
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const parsed = await readBoundedProviderJson(response);
  if (!response.ok) throw providerError(operation, response.status, parsed);
  const tokens = schema.safeParse(parsed);
  if (!tokens.success) {
    throw new PosthogOauthProviderError({
      operation,
      status: 502,
      bodyExcerpt: "PostHog returned a malformed OAuth token response.",
    });
  }
  return tokens.data;
}

export async function verifyPosthogOidcIdentity(input: {
  region: PosthogOauthRegion;
  id_token: string;
  client_id: string;
  nonce: string;
}): Promise<PosthogOidcIdentity> {
  if (!IdTokenSchema.safeParse(input.id_token).success) {
    throw invalidOidcToken("The ID token is missing or exceeds the bounded token limit.");
  }
  if (!isBoundedExactString(input.client_id, 8_192)) {
    throw invalidOidcToken("The expected OAuth client ID is invalid.");
  }
  if (
    !isBoundedExactString(input.nonce, 512) ||
    !/^[A-Za-z0-9_-]+$/.test(input.nonce)
  ) {
    throw invalidOidcToken("The expected OIDC nonce is invalid.");
  }

  const parsed = parseOidcJwt(input.id_token);
  const verificationKey = await fetchPosthogOidcVerificationKey(
    input.region,
    parsed.kid,
  );

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      verificationKey.jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw oidcJwksError("PostHog published an unusable RS256 verification key.");
  }

  if (parsed.signature.byteLength !== verificationKey.modulusBytes) {
    throw invalidOidcToken("The ID token signature length is invalid.");
  }
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      parsed.signature,
      new TextEncoder().encode(parsed.signingInput),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw invalidOidcToken("The ID token signature is invalid.");
  }

  const claims = parsed.claims;
  const issuer = boundedClaimString(claims.iss, 2_048);
  const expectedIssuer = posthogCloudBaseUrl(input.region);
  if (issuer !== expectedIssuer) {
    throw invalidOidcToken("The ID token issuer does not match the PostHog region.");
  }

  const audience = claims.aud;
  const audienceMatches = typeof audience === "string"
    ? audience === input.client_id
    : Array.isArray(audience) && audience.length === 1 &&
      audience[0] === input.client_id;
  if (!audienceMatches) {
    throw invalidOidcToken("The ID token audience does not match the OAuth client.");
  }

  const tokenNonce = boundedClaimString(claims.nonce, 512);
  if (tokenNonce === null || !constantTimeEqual(tokenNonce, input.nonce)) {
    throw invalidOidcToken("The ID token nonce does not match the OAuth request.");
  }

  const subject = boundedClaimString(claims.sub, 512);
  if (subject === null) {
    throw invalidOidcToken("The ID token subject is missing or invalid.");
  }

  const issuedAt = numericDate(claims.iat);
  const expiresAt = numericDate(claims.exp);
  const notBefore = claims.nbf === undefined ? null : numericDate(claims.nbf);
  if (issuedAt === null || expiresAt === null || (claims.nbf !== undefined && notBefore === null)) {
    throw invalidOidcToken("The ID token time claims are missing or invalid.");
  }
  const now = Math.floor(Date.now() / 1_000);
  if (expiresAt <= now - OIDC_CLOCK_SKEW_SECONDS) {
    throw invalidOidcToken("The ID token has expired.");
  }
  if (issuedAt > now + OIDC_CLOCK_SKEW_SECONDS) {
    throw invalidOidcToken("The ID token was issued in the future.");
  }
  if (notBefore !== null && notBefore > now + OIDC_CLOCK_SKEW_SECONDS) {
    throw invalidOidcToken("The ID token is not valid yet.");
  }
  if (issuedAt > expiresAt || (notBefore !== null && notBefore > expiresAt)) {
    throw invalidOidcToken("The ID token time claims are inconsistent.");
  }

  const email = claims.email === undefined
    ? null
    : boundedClaimString(claims.email, 320);
  if (claims.email !== undefined && email === null) {
    throw invalidOidcToken("The ID token email metadata is invalid.");
  }
  const emailVerified = claims.email_verified === undefined
    ? null
    : claims.email_verified;
  if (emailVerified !== null && typeof emailVerified !== "boolean") {
    throw invalidOidcToken("The ID token email verification metadata is invalid.");
  }

  return {
    issuer,
    subject,
    email,
    email_verified: emailVerified,
  };
}

type ParsedOidcJwt = {
  kid: string;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
};

function parseOidcJwt(idToken: string): ParsedOidcJwt {
  const segments = idToken.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw invalidOidcToken("The ID token is not a compact JWT.");
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const header = parseJwtJsonObject(
    decodeCanonicalBase64url(headerSegment, MAX_JWT_HEADER_BYTES),
    "header",
  );
  const claims = parseJwtJsonObject(
    decodeCanonicalBase64url(payloadSegment, MAX_JWT_PAYLOAD_BYTES),
    "payload",
  );
  const signature = decodeCanonicalBase64url(
    signatureSegment,
    MAX_JWT_SIGNATURE_BYTES,
  );

  if (header.alg !== "RS256") {
    throw invalidOidcToken("The ID token must use RS256.");
  }
  if (header.typ !== undefined && header.typ !== "JWT") {
    throw invalidOidcToken("The ID token type header is invalid.");
  }
  // No JOSE extension is needed for a compact, provider-signed ID token. Fail
  // closed instead of accidentally ignoring a critical processing rule.
  if (header.crit !== undefined || header.b64 !== undefined) {
    throw invalidOidcToken("The ID token uses an unsupported JOSE extension.");
  }
  const kid = boundedClaimString(header.kid, 256);
  if (kid === null) {
    throw invalidOidcToken("The ID token signing key ID is missing or invalid.");
  }
  return {
    kid,
    claims,
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature,
  };
}

function decodeCanonicalBase64url(value: string, maxBytes: number): Uint8Array {
  if (!value || value.includes("=") || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidOidcToken("The ID token contains invalid base64url data.");
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(value);
  } catch {
    throw invalidOidcToken("The ID token contains invalid base64url data.");
  }
  if (bytes.byteLength > maxBytes || base64url(bytes) !== value) {
    throw invalidOidcToken("The ID token contains non-canonical or oversized data.");
  }
  return bytes;
}

function parseJwtJsonObject(bytes: Uint8Array, part: "header" | "payload"): Record<string, unknown> {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalidOidcToken(`The ID token ${part} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidOidcToken(`The ID token ${part} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

async function fetchPosthogOidcVerificationKey(
  region: PosthogOauthRegion,
  kid: string,
): Promise<{ jwk: JsonWebKey; modulusBytes: number }> {
  const jwksUrl = `${posthogCloudBaseUrl(region)}/.well-known/jwks.json`;
  let response: Response;
  try {
    response = await fetch(jwksUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "agentry-api/1.0",
      },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw oidcJwksError("The PostHog OIDC key set could not be fetched.");
  }
  if (!response.ok) {
    await readBoundedProviderJson(
      response,
      MAX_JWKS_BODY_BYTES,
      "read_oidc_jwks_response",
    ).catch(() => null);
    throw oidcJwksError("PostHog did not return its OIDC key set.");
  }

  let document: unknown;
  try {
    document = await readBoundedProviderJson(
      response,
      MAX_JWKS_BODY_BYTES,
      "read_oidc_jwks_response",
    );
  } catch {
    throw oidcJwksError("PostHog returned an unreadable OIDC key set.");
  }
  const jwks = JwksSchema.safeParse(document);
  if (!jwks.success) {
    throw oidcJwksError("PostHog returned a malformed or oversized OIDC key set.");
  }
  const matches = jwks.data.keys.flatMap((value) => {
    const parsed = JwkSchema.safeParse(value);
    if (!parsed.success || parsed.data.kid !== kid) return [];
    if (
      parsed.data.key_ops !== undefined &&
      (parsed.data.key_ops.length !== 1 || parsed.data.key_ops[0] !== "verify")
    ) return [];
    return [parsed.data];
  });
  if (matches.length === 0) {
    throw invalidOidcToken("No eligible PostHog RS256 key matches the ID token.");
  }
  if (matches.length !== 1) {
    throw oidcJwksError("PostHog returned duplicate OIDC signing key IDs.");
  }

  const selected = matches[0]!;
  const modulus = decodeJwkInteger(
    selected.n,
    MIN_RSA_MODULUS_BYTES,
    MAX_RSA_MODULUS_BYTES,
  );
  const exponent = decodeJwkInteger(selected.e, 1, MAX_RSA_EXPONENT_BYTES);
  if (!modulus || !exponent || modulus[0] === 0 || exponent[0] === 0) {
    throw oidcJwksError("PostHog returned malformed RSA key material.");
  }
  let exponentValue = 0n;
  for (const byte of exponent) exponentValue = (exponentValue << 8n) | BigInt(byte);
  if (exponentValue < 3n || exponentValue % 2n === 0n) {
    throw oidcJwksError("PostHog returned an invalid RSA public exponent.");
  }

  return {
    modulusBytes: modulus.byteLength,
    // Import only the fields this verifier has validated. In particular, do
    // not honor provider-supplied URLs, embedded keys, or broader operations.
    jwk: {
      kty: "RSA",
      use: "sig",
      alg: "RS256",
      n: selected.n,
      e: selected.e,
      key_ops: ["verify"],
      ext: true,
    },
  };
}

function decodeJwkInteger(
  value: string,
  minBytes: number,
  maxBytes: number,
): Uint8Array | null {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64url(value);
  } catch {
    return null;
  }
  if (
    bytes.byteLength < minBytes ||
    bytes.byteLength > maxBytes ||
    base64url(bytes) !== value
  ) return null;
  return bytes;
}

function isBoundedExactString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundedClaimString(value: unknown, max: number): string | null {
  return isBoundedExactString(value, max) ? value : null;
}

function numericDate(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function invalidOidcToken(reason: string): PosthogOauthProviderError {
  return new PosthogOauthProviderError({
    operation: "verify_oidc_identity",
    status: 401,
    oauthCode: "invalid_id_token",
    bodyExcerpt: reason,
  });
}

function oidcJwksError(reason: string): PosthogOauthProviderError {
  return new PosthogOauthProviderError({
    operation: "fetch_oidc_jwks",
    status: 502,
    oauthCode: "jwks_unavailable",
    bodyExcerpt: reason,
  });
}

export async function revokePosthogOauthToken(input: {
  region: PosthogOauthRegion;
  token: string;
  token_type_hint: "access_token" | "refresh_token";
  client_id: string;
}): Promise<boolean> {
  const response = await fetch(`${posthogCloudBaseUrl(input.region)}/oauth/revoke/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "agentry-api/1.0",
    },
    body: JSON.stringify({
      token: input.token,
      token_type_hint: input.token_type_hint,
      client_id: input.client_id,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (response.ok) return true;
  // Revocation is deliberately best-effort during detach. Local ciphertext is
  // still destroyed; the response tells the owner whether provider revocation
  // was confirmed so they can check PostHog if needed.
  await readBoundedProviderJson(response).catch(() => null);
  return false;
}

export function resolvePosthogScopedProject(
  tokens: PosthogOauthTokens,
): PosthogScopedProject | null {
  // `required_access_level=project` delegates project choice to PostHog. The
  // token's provider-issued scope binding is the identity proof; querying the
  // project collection would unnecessarily read other project metadata and a
  // detail response includes the application's ingestion `api_token`.
  const scopedProjects = tokens.scoped_teams ?? [];
  const scopedOrganizations = tokens.scoped_organizations ?? [];
  if (scopedProjects.length !== 1 || scopedOrganizations.length > 1) return null;
  return {
    posthog_project_id: scopedProjects[0]!,
    organization_id: scopedOrganizations[0] ?? null,
  };
}

export async function verifyPosthogReadCapabilities(input: {
  region: PosthogOauthRegion;
  access_token: string;
  posthog_project_id: number;
}): Promise<PosthogCapabilitySnapshot> {
  const base = `/api/environments/${input.posthog_project_id}`;
  // This constant query proves query authority without reading a customer row.
  await providerJson(input, "verify_query_read", `${base}/query/`, {
    method: "POST",
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: "SELECT 1 AS agentry_connection_check" } }),
  });

  const checks = await Promise.all([
    optionalReadCapability(input, "event_definitions_read", `/api/projects/${input.posthog_project_id}/event_definitions/?limit=1`),
    optionalReadCapability(input, "property_definitions_read", `/api/projects/${input.posthog_project_id}/property_definitions/?limit=1`),
    optionalReadCapability(input, "error_tracking_read", `${base}/error_tracking/issues/?limit=1`),
    optionalReadCapability(input, "session_recordings_read", `/api/projects/${input.posthog_project_id}/session_recordings/?limit=1`),
    optionalReadCapability(input, "feature_flags_read", `/api/projects/${input.posthog_project_id}/feature_flags/?limit=1`),
    optionalReadCapability(input, "surveys_read", `/api/projects/${input.posthog_project_id}/surveys/?limit=1`),
    optionalReadCapability(input, "experiments_read", `/api/projects/${input.posthog_project_id}/experiments/?limit=1`),
  ]);
  const issues = checks.flatMap((item) => item.ok ? [] : [{
    capability: item.capability,
    upstream_status: item.status,
  }]);
  return {
    version: "posthog-cloud-read-v2",
    checked_at: Math.floor(Date.now() / 1_000),
    project_read: true,
    query_read: true,
    event_definitions_read: checks[0]!.ok,
    property_definitions_read: checks[1]!.ok,
    error_tracking_read: checks[2]!.ok,
    session_recordings_read: checks[3]!.ok,
    feature_flags_read: checks[4]!.ok,
    surveys_read: checks[5]!.ok,
    experiments_read: checks[6]!.ok,
    issues,
  };
}

async function optionalReadCapability(
  auth: { region: PosthogOauthRegion; access_token: string },
  capability: OptionalPosthogReadCapability,
  path: string,
): Promise<{ capability: typeof capability; ok: boolean; status: number }> {
  try {
    await providerJson(auth, `verify_${capability}`, path);
    return { capability, ok: true, status: 200 };
  } catch (error) {
    if (error instanceof PosthogOauthProviderError && error.status < 500) {
      return { capability, ok: false, status: error.status };
    }
    throw error;
  }
}

async function providerJson(
  auth: { region: PosthogOauthRegion; access_token: string },
  operation: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const url = new URL(path, posthogCloudBaseUrl(auth.region));
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${auth.access_token}`);
  headers.set("accept", "application/json");
  headers.set("user-agent", "agentry-api/1.0");
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const parsed = await readBoundedProviderJson(response);
  if (!response.ok) throw providerError(operation, response.status, parsed);
  return parsed;
}

function providerError(operation: string, status: number, value: unknown): PosthogOauthProviderError {
  const body = record(value);
  return new PosthogOauthProviderError({
    operation,
    status,
    oauthCode: stringValue(body.error, 200) ?? stringValue(body.code, 200),
    bodyExcerpt: JSON.stringify(value).slice(0, 400),
  });
}

async function readBoundedProviderJson(
  response: Response,
  maxBytes = MAX_PROVIDER_BODY_BYTES,
  operation = "read_provider_response",
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new PosthogOauthProviderError({
      operation,
      status: 502,
      bodyExcerpt: "PostHog response exceeded the bounded response limit.",
    });
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PosthogOauthProviderError({
          operation,
          status: 502,
          bodyExcerpt: "PostHog response exceeded the bounded response limit.",
        });
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
  } catch {
    throw new PosthogOauthProviderError({
      operation: operation === "read_provider_response"
        ? "parse_provider_response"
        : operation,
      status: 502,
      bodyExcerpt: "PostHog returned a non-JSON response.",
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}
