#!/usr/bin/env node
// Record a deploy only after the release wrapper has proved and exported the
// exact deployed commit, final source fingerprint, and provider receipt.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_ATTEMPTS = 3;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const AUTOMATION_RUN_ID_ENV = "AGENTRY_AUTOMATION_RUN_ID";
export const AUTOMATION_SOURCE_COMMIT_SHA_ENV = "AGENTRY_AUTOMATION_SOURCE_COMMIT_SHA";

const DEFAULT_AGENTRY_URL = "https://api.agentry.sh";
const RETRY_DELAYS_MS = [250, 1_000];
const RELEASE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SOURCE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;
const PROVIDER_DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const ONBOARDING_PROOF_PATTERN = /^agentry_proof_ci_[A-Za-z0-9_-]{32,200}$/;
const CI_KEY_PATTERN = /^agentry_ci_([A-Za-z0-9][A-Za-z0-9_:-]{0,199})\.([A-Za-z0-9_-]{32})$/;
const AUTOMATION_RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_CHILD_ENV_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
]);

class DeployTagError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = "DeployTagError";
    this.retryable = retryable;
  }
}

function requiredCiCredential(env) {
  const raw = typeof env.AGENTRY_CI_API_KEY === "string"
    ? env.AGENTRY_CI_API_KEY.trim()
    : "";
  if (!raw) {
    throw new DeployTagError("AGENTRY_CI_API_KEY is required for deploy attribution");
  }
  const match = CI_KEY_PATTERN.exec(raw);
  if (!match) {
    throw new DeployTagError("AGENTRY_CI_API_KEY is malformed");
  }
  return { raw, projectId: match[1] };
}

function requiredReleaseSha(env) {
  const raw = typeof env.AGENTRY_DEPLOY_SHA === "string"
    ? env.AGENTRY_DEPLOY_SHA.trim()
    : "";
  if (!raw) {
    throw new DeployTagError("AGENTRY_DEPLOY_SHA is required for deploy attribution");
  }
  if (!RELEASE_SHA_PATTERN.test(raw)) {
    throw new DeployTagError("AGENTRY_DEPLOY_SHA must be exactly 40 or 64 hexadecimal characters");
  }
  return raw.toLowerCase();
}

function optionalModernDeployIdentity(env) {
  const rawProviderId = typeof env.AGENTRY_PROVIDER_DEPLOYMENT_ID === "string"
    ? env.AGENTRY_PROVIDER_DEPLOYMENT_ID.trim()
    : "";
  const rawFingerprint = typeof env.AGENTRY_SOURCE_FINGERPRINT_SHA256 === "string"
    ? env.AGENTRY_SOURCE_FINGERPRINT_SHA256.trim()
    : "";
  if (Boolean(rawProviderId) !== Boolean(rawFingerprint)) {
    throw new DeployTagError(
      "AGENTRY_PROVIDER_DEPLOYMENT_ID and AGENTRY_SOURCE_FINGERPRINT_SHA256 are required together",
    );
  }
  if (!rawProviderId) {
    return { providerDeploymentId: null, sourceFingerprintSha256: null };
  }
  if (!PROVIDER_DEPLOYMENT_ID_PATTERN.test(rawProviderId)) {
    throw new DeployTagError("AGENTRY_PROVIDER_DEPLOYMENT_ID is malformed");
  }
  if (!SOURCE_FINGERPRINT_PATTERN.test(rawFingerprint)) {
    throw new DeployTagError(
      "AGENTRY_SOURCE_FINGERPRINT_SHA256 must be exactly 64 hexadecimal characters",
    );
  }
  return {
    providerDeploymentId: rawProviderId,
    sourceFingerprintSha256: rawFingerprint.toLowerCase(),
  };
}

/**
 * Optional trusted-CI binding for the exact Agentry repair run and its
 * immutable PR-proof head. A merge or squash release can deploy a different
 * commit, so this source identity is validated independently from deploy.sha.
 */
export function validateAutomationDeployBindingEnvironment(env) {
  const rawRunId = typeof env[AUTOMATION_RUN_ID_ENV] === "string"
    ? env[AUTOMATION_RUN_ID_ENV].trim()
    : "";
  const rawSourceCommitSha = typeof env[AUTOMATION_SOURCE_COMMIT_SHA_ENV] === "string"
    ? env[AUTOMATION_SOURCE_COMMIT_SHA_ENV].trim()
    : "";
  if (Boolean(rawRunId) !== Boolean(rawSourceCommitSha)) {
    throw new DeployTagError(
      `${AUTOMATION_RUN_ID_ENV} and ${AUTOMATION_SOURCE_COMMIT_SHA_ENV} are required together`,
    );
  }
  if (!rawRunId) {
    return Object.freeze({ automationRunId: null, sourceCommitSha: null });
  }
  if (!AUTOMATION_RUN_ID_PATTERN.test(rawRunId)) {
    throw new DeployTagError(`${AUTOMATION_RUN_ID_ENV} must be an exact lowercase UUIDv7 run id`);
  }
  if (!RELEASE_SHA_PATTERN.test(rawSourceCommitSha)) {
    throw new DeployTagError(
      `${AUTOMATION_SOURCE_COMMIT_SHA_ENV} must be exactly 40 or 64 hexadecimal characters`,
    );
  }
  const sourceCommitSha = rawSourceCommitSha.toLowerCase();
  return Object.freeze({ automationRunId: rawRunId, sourceCommitSha });
}

function optionalOnboardingProof(env) {
  const raw = typeof env.AGENTRY_ONBOARDING_PROOF === "string"
    ? env.AGENTRY_ONBOARDING_PROOF.trim()
    : "";
  if (!raw) return null;
  if (!ONBOARDING_PROOF_PATTERN.test(raw)) {
    throw new DeployTagError("AGENTRY_ONBOARDING_PROOF is malformed");
  }
  return raw;
}

function deployEndpoint(rawBaseUrl) {
  const value = typeof rawBaseUrl === "string" && rawBaseUrl.trim()
    ? rawBaseUrl.trim()
    : DEFAULT_AGENTRY_URL;
  if (value.length > 2_048) {
    throw new DeployTagError("AGENTRY_URL is invalid");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DeployTagError("AGENTRY_URL is invalid");
  }
  const loopbackHttp = url.protocol === "http:" && [
    "localhost",
    "127.0.0.1",
    "[::1]",
  ].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopbackHttp) || url.username || url.password) {
    throw new DeployTagError("AGENTRY_URL is invalid");
  }
  return new URL("/v1/deploys/", url).toString();
}

export function validateDeployTagEnvironment(env) {
  const credential = requiredCiCredential(env);
  const sha = requiredReleaseSha(env);
  const endpoint = deployEndpoint(env.AGENTRY_URL);
  const modernIdentity = optionalModernDeployIdentity(env);
  const automationBinding = validateAutomationDeployBindingEnvironment(env);
  optionalOnboardingProof(env);
  return Object.freeze({
    projectId: credential.projectId,
    sha,
    endpoint,
    ...modernIdentity,
    ...automationBinding,
  });
}

function boundedValue(value, maxLength) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function gitChildEnvironment(env) {
  const child = {};
  for (const name of GIT_CHILD_ENV_NAMES) {
    if (typeof env[name] === "string") child[name] = env[name];
  }
  return child;
}

function defaultGitValue(args, maxLength, env = process.env) {
  try {
    return boundedValue(
      execFileSync("git", args, {
        encoding: "utf8",
        env: gitChildEnvironment(env),
        stdio: ["ignore", "pipe", "ignore"],
      }),
      maxLength,
    );
  } catch {
    return null;
  }
}

function releaseMetadata(env, gitValue) {
  const environment = boundedValue(
    env.AGENTRY_DEPLOY_ENVIRONMENT ?? env.AGENTRY_ENVIRONMENT,
    100,
  ) ?? "production";
  const branch = boundedValue(env.GITHUB_REF_NAME, 200)
    ?? gitValue(["rev-parse", "--abbrev-ref", "HEAD"], 200, env);
  const actor = boundedValue(env.GITHUB_ACTOR, 200)
    ?? gitValue(["config", "user.name"], 200, env);
  const message = gitValue(["log", "-1", "--pretty=%s"], 4_000, env);
  return { environment, branch, actor, message };
}

function deployPayload(sha, metadata, modernIdentity, automationBinding) {
  return Object.fromEntries(
    Object.entries({
      sha,
      ...metadata,
      provider_deployment_id: modernIdentity.providerDeploymentId,
      source_fingerprint_sha256: modernIdentity.sourceFingerprintSha256,
      automation_run_id: automationBinding.automationRunId,
      source_commit_sha: automationBinding.sourceCommitSha,
    }).filter(([, value]) => value !== null),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw new DeployTagError("Agentry returned an oversized deploy response");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    throw new DeployTagError("Agentry returned an empty deploy response");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      let part;
      try {
        part = await reader.read();
      } catch {
        throw new DeployTagError("Agentry deploy response was lost", { retryable: true });
      }
      if (part.done) break;
      received += part.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new DeployTagError("Agentry returned an oversized deploy response");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DeployTagError("Agentry returned invalid deploy JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeployTagError("Agentry returned an invalid deploy response");
  }
  return parsed;
}

function assertMatchingResponse(response, {
  projectId,
  sha,
  automationRunId,
  sourceCommitSha,
}) {
  if (
    typeof response.id !== "string"
    || !response.id.trim()
    || response.project_id !== projectId
    || response.sha !== sha
    || (automationRunId !== null && response.automation_run_id !== automationRunId)
    || (sourceCommitSha !== null && response.source_commit_sha !== sourceCommitSha)
  ) {
    throw new DeployTagError("Agentry deploy response did not match the submitted release");
  }
}

async function submitDeploy({
  endpoint,
  headers,
  body,
  fetchImpl,
  timeoutSignal,
  wait,
  projectId,
  sha,
  automationRunId,
  sourceCommitSha,
}) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body,
        signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new DeployTagError("Agentry deploy request failed after bounded retries");
      }
      await wait(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      await response.body?.cancel?.().catch(() => {});
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new DeployTagError(
          `Agentry deploy request failed with retryable HTTP ${response.status} after bounded retries`,
        );
      }
      await wait(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel?.().catch(() => {});
      throw new DeployTagError(`Agentry deploy request failed with HTTP ${response.status}`);
    }

    let parsed;
    try {
      parsed = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof DeployTagError && error.retryable && attempt < MAX_ATTEMPTS - 1) {
        await wait(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw error;
    }
    assertMatchingResponse(parsed, {
      projectId,
      sha,
      automationRunId,
      sourceCommitSha,
    });
    return parsed;
  }
  throw new DeployTagError("Agentry deploy request failed after bounded retries");
}

export async function runDeployTag({
  env = process.env,
  fetchImpl = globalThis.fetch,
  gitValue = defaultGitValue,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  wait = sleep,
  stdout = (message) => console.log(message),
  stderr = (message) => console.error(message),
} = {}) {
  try {
    const validated = validateDeployTagEnvironment(env);
    const ciKey = env.AGENTRY_CI_API_KEY.trim();
    const {
      projectId,
      sha,
      endpoint,
      providerDeploymentId,
      sourceFingerprintSha256,
      automationRunId,
      sourceCommitSha,
    } = validated;
    const metadata = releaseMetadata(env, gitValue);
    const body = JSON.stringify(deployPayload(sha, metadata, {
      providerDeploymentId,
      sourceFingerprintSha256,
    }, {
      automationRunId,
      sourceCommitSha,
    }));
    const proof = optionalOnboardingProof(env);
    const headers = {
      authorization: `Bearer ${ciKey}`,
      "content-type": "application/json",
      "idempotency-key": providerDeploymentId
        ? `cloudflare-worker:${providerDeploymentId}`
        : `agentry-deploy-${sha}`,
      "user-agent": "agentry-deploy-script/2.0",
    };
    if (proof) headers["x-agentry-onboarding-proof"] = proof;
    Object.freeze(headers);

    const response = await submitDeploy({
      endpoint,
      headers,
      body,
      fetchImpl,
      timeoutSignal,
      wait,
      projectId,
      sha,
      automationRunId,
      sourceCommitSha,
    });
    const replay = response.idempotent_replay === true ? " (idempotent replay)" : "";
    stdout(`tag-agentry-deploy: recorded ${sha.slice(0, 12)}${replay}`);
    return 0;
  } catch (error) {
    const message = error instanceof DeployTagError
      ? error.message
      : "unexpected deploy attribution failure";
    stderr(`tag-agentry-deploy: ${message}`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runDeployTag();
}
