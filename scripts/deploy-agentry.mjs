#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AUTOMATION_RUN_ID_ENV,
  AUTOMATION_SOURCE_COMMIT_SHA_ENV,
  validateAutomationDeployBindingEnvironment,
  validateDeployTagEnvironment,
} from "./tag-agentry-deploy.mjs";

export const RELEASE_MODES = Object.freeze(["api", "auth", "redirect", "api-core-migration"]);
export const DEFAULT_MAINTENANCE_API_URL = "https://api.agentry.sh/";
export const DEFAULT_MAINTENANCE_DRAIN_SECONDS = 60;
export const MAX_MAINTENANCE_DRAIN_SECONDS = 900;
export const MAINTENANCE_PROOF_CONSECUTIVE = 3;
export const MAINTENANCE_PROOF_MAX_ATTEMPTS = 30;
export const MAINTENANCE_PROOF_INTERVAL_MS = 2_000;
export const HTTP_TIMEOUT_MS = 5_000;
export const MAX_SMOKE_RESPONSE_BYTES = 64 * 1024;
export const MAX_WRANGLER_OUTPUT_BYTES = 256 * 1024;
export const API_WORKER_NAME = "agentry-api";
export const API_WORKER_TARGET = "api.agentry.sh (custom domain)";
export const REVIEWED_LEGACY_BASELINE_FLAG = "--reviewed-legacy-baseline";
export const BOOTSTRAP_CI_ATTRIBUTION_FLAG = "--bootstrap-ci-attribution";

const RELEASE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAINTENANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;
const CI_KEY_PREFIX_PATTERN = /^agentry_(?:pk|sk|server|ci|runner)_/i;
const OWNER_KEY_PATTERN = /^agentry_sk_[A-Za-z0-9_-]{32}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,199}$/;
const LEGACY_REVIEW_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$/;
const LEGACY_REVIEW_ENV = "AGENTRY_LEGACY_BASELINE_REVIEW_REF";
const BOOTSTRAP_PROJECT_ENV = "AGENTRY_BOOTSTRAP_PROJECT_ID";
const BOOTSTRAP_KEY_FILE_ENV = "AGENTRY_BOOTSTRAP_CI_KEY_FILE";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROVIDER_DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const COMMON_CHILD_ENV_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_NO_WARNINGS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
]);
const CLOUDFLARE_CHILD_ENV_NAMES = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
  "CLOUDFLARE_API_BASE_URL",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_ACCESS_CLIENT_ID",
  "CLOUDFLARE_ACCESS_CLIENT_SECRET",
  "CLOUDFLARE_AUTH_USE_KEYRING",
  "WRANGLER_CF_AUTHORIZATION_TOKEN",
  "WRANGLER_CLIENT_ID",
  "WRANGLER_API_ENVIRONMENT",
  "WRANGLER_PROFILE",
  "WRANGLER_LOG",
  "WRANGLER_SEND_METRICS",
]);
const DATABASE_CHILD_ENV_NAMES = Object.freeze([
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  LEGACY_REVIEW_ENV,
]);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptRoot, "..");

class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

function defaultRunCommand(file, args, { cwd, env, capture = false }) {
  return spawnSync(file, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function checkedCommand(runCommand, file, args, options, label) {
  const result = runCommand(file, args, options);
  if (!result || result.status !== 0) {
    throw new ReleaseError(`${label} failed; release stopped`);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function trimTerminalNewline(value) {
  return value.replace(/(?:\r?\n)+$/, "");
}

function gitOutput(runCommand, repoRoot, env, args, label) {
  return checkedCommand(
    runCommand,
    "git",
    args,
    { cwd: repoRoot, env: buildChildEnvironment(env), capture: true },
    label,
  );
}

function exactSingleLine(value, label) {
  const normalized = trimTerminalNewline(value);
  if (!normalized || normalized.includes("\n") || normalized.includes("\r") || normalized.includes("\0")) {
    throw new ReleaseError(`${label} is not one exact nonempty line`);
  }
  return normalized;
}

function assertStrictAttributionReady(env, sha, { requireSourceFingerprint = false } = {}) {
  try {
    const validationEnv = { ...env, AGENTRY_DEPLOY_SHA: sha };
    if (requireSourceFingerprint) {
      validationEnv.AGENTRY_PROVIDER_DEPLOYMENT_ID = "preflight-deployment";
    } else {
      delete validationEnv.AGENTRY_PROVIDER_DEPLOYMENT_ID;
      delete validationEnv.AGENTRY_SOURCE_FINGERPRINT_SHA256;
    }
    const validated = validateDeployTagEnvironment(validationEnv);
    if (validated.sha !== sha) throw new Error("release SHA normalization mismatch");
    if (
      requireSourceFingerprint
      && validated.sourceFingerprintSha256 !== sourceFingerprint(env)
    ) {
      throw new Error("source fingerprint normalization mismatch");
    }
  } catch {
    throw new ReleaseError(
      "strict deploy attribution environment is invalid; release stopped before provider mutation",
    );
  }
}

function assertAutomationDeployBindingReady(env) {
  try {
    validateAutomationDeployBindingEnvironment(env);
  } catch {
    throw new ReleaseError(
      `optional automation deploy binding is invalid; set both ${AUTOMATION_RUN_ID_ENV} and ` +
      `${AUTOMATION_SOURCE_COMMIT_SHA_ENV} for the immutable PR-proof head, or omit both`,
    );
  }
}

function nonemptyEnvironmentValue(env, name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

function pathIsInside(parent, candidate) {
  const result = relative(parent, candidate);
  return result === "" || (!result.startsWith("..") && !isAbsolute(result));
}

function allowlistedEnvironment(env, names, extra = {}) {
  const child = {};
  for (const name of [...COMMON_CHILD_ENV_NAMES, ...names]) {
    if (typeof env[name] === "string") child[name] = env[name];
  }
  return { ...child, ...extra };
}

function buildChildEnvironment(env) {
  return allowlistedEnvironment(env, []);
}

function databaseChildEnvironment(env, extra) {
  return allowlistedEnvironment(env, DATABASE_CHILD_ENV_NAMES, extra);
}

function wranglerChildEnvironment(env, extra) {
  return allowlistedEnvironment(env, CLOUDFLARE_CHILD_ENV_NAMES, extra);
}

function taggerChildEnvironment(env, extra) {
  return allowlistedEnvironment(env, [
    "AGENTRY_CI_API_KEY",
    "AGENTRY_URL",
    "AGENTRY_ONBOARDING_PROOF",
    "GITHUB_ACTOR",
    AUTOMATION_RUN_ID_ENV,
    AUTOMATION_SOURCE_COMMIT_SHA_ENV,
  ], extra);
}

function sourceFingerprint(env) {
  const raw = typeof env.AGENTRY_SOURCE_FINGERPRINT_SHA256 === "string"
    ? env.AGENTRY_SOURCE_FINGERPRINT_SHA256.trim()
    : "";
  if (!SHA256_PATTERN.test(raw)) {
    throw new ReleaseError(
      "AGENTRY_SOURCE_FINGERPRINT_SHA256 must be the lowercase SHA-256 from the final source snapshot",
    );
  }
  return raw;
}

function prepareWranglerOutputCapture(repoRoot) {
  let directory;
  try {
    directory = mkdtempSync(join(tmpdir(), "agentry-wrangler-output-"));
    chmodSync(directory, 0o700);
    const file = join(directory, "output.ndjson");
    writeFileSync(file, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    const realDirectory = realpathSync(directory);
    let realRepo = resolve(repoRoot);
    try {
      realRepo = realpathSync(repoRoot);
    } catch {
      // Tests may use a synthetic repository path; resolve still preserves the boundary check.
    }
    if (pathIsInside(realRepo, realDirectory)) {
      throw new ReleaseError("Wrangler output must be outside the release repository");
    }
    return Object.freeze({ directory: realDirectory, file: realpathSync(file) });
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("protected Wrangler deploy output could not be prepared");
  }
}

function cleanupWranglerOutputCapture(capture) {
  rmSync(capture.directory, { recursive: true, force: true });
}

function wranglerWorkerVersionId(file, { expectedWorkerName, expectedTarget }) {
  let stat;
  let raw;
  try {
    stat = lstatSync(file);
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size < 2
      || stat.size > MAX_WRANGLER_OUTPUT_BYTES
      || (stat.mode & 0o077) !== 0
    ) {
      throw new Error("invalid output file");
    }
    raw = readFileSync(file, "utf8");
  } catch {
    throw new ReleaseError("Wrangler did not produce protected bounded deploy output");
  }
  const deployEntries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ReleaseError("Wrangler deploy output was not valid NDJSON");
    }
    if (parsed?.type === "deploy") deployEntries.push(parsed);
  }
  if (deployEntries.length !== 1) {
    throw new ReleaseError("Wrangler deploy output did not contain one exact Worker deploy receipt");
  }
  const receipt = deployEntries[0];
  if (
    receipt.version !== 1
    || receipt.worker_name !== expectedWorkerName
    || typeof receipt.version_id !== "string"
    || !PROVIDER_DEPLOYMENT_ID_PATTERN.test(receipt.version_id)
    || !Array.isArray(receipt.targets)
    || receipt.targets.length < 1
    || receipt.targets.some((target) =>
      typeof target !== "string"
      || target.length < 1
      || target.length > 2_048
      || /[\u0000\r\n]/.test(target))
    || !receipt.targets.includes(expectedTarget)
  ) {
    throw new ReleaseError(
      "Wrangler deploy receipt did not bind the expected Worker, production target, and bounded version ID",
    );
  }
  return receipt.version_id;
}

export function prepareBootstrapCredentialFilePath(value, repoRoot) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || !isAbsolute(raw) || raw.includes("\0")) {
    throw new ReleaseError(`${BOOTSTRAP_KEY_FILE_ENV} must be an absolute path outside the repository`);
  }
  let realParent;
  let realRepo;
  try {
    realParent = realpathSync(dirname(raw));
    realRepo = realpathSync(repoRoot);
  } catch {
    throw new ReleaseError(`${BOOTSTRAP_KEY_FILE_ENV} parent and release repository must already exist`);
  }
  const target = join(realParent, basename(raw));
  if (pathIsInside(realRepo, target)) {
    throw new ReleaseError(`${BOOTSTRAP_KEY_FILE_ENV} must be outside the release repository`);
  }
  try {
    lstatSync(target);
    throw new ReleaseError(`${BOOTSTRAP_KEY_FILE_ENV} already exists; bootstrap will not overwrite it`);
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw new ReleaseError(`${BOOTSTRAP_KEY_FILE_ENV} could not be validated`);
    }
  }
  return target;
}

export function openBootstrapCredentialSink(path) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new ReleaseError(
      `${BOOTSTRAP_KEY_FILE_ENV} could not be exclusively reserved with mode 0600`,
    );
  }
  let closed = false;
  return Object.freeze({
    write(credential) {
      if (closed) throw new ReleaseError("bootstrap CI credential sink is already closed");
      try {
        writeFileSync(descriptor, `${credential}\n`, { encoding: "utf8" });
        fsyncSync(descriptor);
      } catch {
        throw new ReleaseError(
          "the minted CI credential could not be durably written; inspect and revoke the new credential before any retry",
        );
      }
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(descriptor);
    },
  });
}

function releaseAuthority({
  mode,
  env,
  repoRoot,
  reviewedLegacyBaseline,
  bootstrapCiAttribution,
  prepareBootstrapCredentialFile,
}) {
  const reviewRef = typeof env[LEGACY_REVIEW_ENV] === "string"
    ? env[LEGACY_REVIEW_ENV].trim()
    : "";
  if (reviewedLegacyBaseline !== Boolean(reviewRef)) {
    throw new ReleaseError(
      `${REVIEWED_LEGACY_BASELINE_FLAG} and ${LEGACY_REVIEW_ENV} must be supplied together for the one-time legacy-baseline invocation`,
    );
  }
  if (reviewedLegacyBaseline) {
    if (mode !== "api-core-migration") {
      throw new ReleaseError(`${REVIEWED_LEGACY_BASELINE_FLAG} is valid only for api-core-migration`);
    }
    if (!LEGACY_REVIEW_REF_PATTERN.test(reviewRef)) {
      throw new ReleaseError(
        `${LEGACY_REVIEW_ENV} must be an 8-200 character nonsecret backup, change, or review reference`,
      );
    }
  }

  if (!bootstrapCiAttribution && (
    nonemptyEnvironmentValue(env, BOOTSTRAP_PROJECT_ENV)
    || nonemptyEnvironmentValue(env, BOOTSTRAP_KEY_FILE_ENV)
  )) {
    throw new ReleaseError(
      `${BOOTSTRAP_CI_ATTRIBUTION_FLAG} must accompany its bootstrap project and key-file environment`,
    );
  }
  if (!bootstrapCiAttribution) {
    return Object.freeze({ bootstrap: null });
  }
  if (mode !== "api-core-migration") {
    throw new ReleaseError(`${BOOTSTRAP_CI_ATTRIBUTION_FLAG} is valid only for api-core-migration`);
  }
  if (!reviewedLegacyBaseline) {
    throw new ReleaseError(
      `${BOOTSTRAP_CI_ATTRIBUTION_FLAG} requires ${REVIEWED_LEGACY_BASELINE_FLAG} and ${LEGACY_REVIEW_ENV}; deferred attribution is only valid for first reviewed legacy adoption`,
    );
  }
  if (nonemptyEnvironmentValue(env, "AGENTRY_CI_API_KEY")) {
    throw new ReleaseError(
      `${BOOTSTRAP_CI_ATTRIBUTION_FLAG} is only for a database with no project credentials; use the existing CI credential without this flag`,
    );
  }
  const ownerApiKey = typeof env.AGENTRY_PRIVATE_API_KEY === "string"
    ? env.AGENTRY_PRIVATE_API_KEY.trim()
    : "";
  if (!OWNER_KEY_PATTERN.test(ownerApiKey)) {
    throw new ReleaseError(
      `${BOOTSTRAP_CI_ATTRIBUTION_FLAG} requires a valid interactive AGENTRY_PRIVATE_API_KEY`,
    );
  }
  const projectId = typeof env[BOOTSTRAP_PROJECT_ENV] === "string"
    ? env[BOOTSTRAP_PROJECT_ENV].trim()
    : "";
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new ReleaseError(`${BOOTSTRAP_PROJECT_ENV} is invalid`);
  }
  const credentialFile = prepareBootstrapCredentialFile(env[BOOTSTRAP_KEY_FILE_ENV], repoRoot);
  return Object.freeze({
    bootstrap: Object.freeze({ ownerApiKey, projectId, credentialFile }),
  });
}

function assertReleaseCandidate({ runCommand, repoRoot, env, expectedSha = null }) {
  const branch = exactSingleLine(
    gitOutput(runCommand, repoRoot, env, ["symbolic-ref", "--quiet", "--short", "HEAD"], "git branch check"),
    "git branch",
  );
  if (branch !== "main") {
    throw new ReleaseError("release requires the checked-out branch to be exactly main");
  }

  const sha = exactSingleLine(
    gitOutput(runCommand, repoRoot, env, ["rev-parse", "--verify", "HEAD^{commit}"], "git HEAD check"),
    "git HEAD",
  ).toLowerCase();
  if (!RELEASE_SHA_PATTERN.test(sha)) {
    throw new ReleaseError("git HEAD is not an exact 40- or 64-hex commit");
  }
  const mainSha = exactSingleLine(
    gitOutput(
      runCommand,
      repoRoot,
      env,
      ["rev-parse", "--verify", "refs/heads/main^{commit}"],
      "git main check",
    ),
    "git main",
  ).toLowerCase();
  if (mainSha !== sha) {
    throw new ReleaseError("checked-out HEAD does not equal refs/heads/main");
  }
  if (expectedSha !== null && sha !== expectedSha) {
    throw new ReleaseError("release candidate HEAD changed during the release");
  }

  const configuredSha = typeof env.AGENTRY_DEPLOY_SHA === "string"
    ? env.AGENTRY_DEPLOY_SHA.trim().toLowerCase()
    : "";
  if (configuredSha && configuredSha !== sha) {
    throw new ReleaseError("AGENTRY_DEPLOY_SHA does not equal the exact release HEAD");
  }

  const message = exactSingleLine(
    gitOutput(
      runCommand,
      repoRoot,
      env,
      ["log", "-1", "--format=%s", sha],
      "git commit message check",
    ),
    "git commit message",
  );
  const status = trimTerminalNewline(gitOutput(
    runCommand,
    repoRoot,
    env,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    "git cleanliness check",
  ));
  if (status !== "") {
    throw new ReleaseError("release requires a clean tracked and untracked working tree");
  }

  return { branch, sha, message };
}

function verifyRelease({ runCommand, repoRoot, env }) {
  checkedCommand(
    runCommand,
    "npm",
    ["run", "release:verify"],
    { cwd: repoRoot, env: buildChildEnvironment(env) },
    "complete release verification",
  );
}

function prepareApi({ runCommand, repoRoot, env }) {
  const childEnv = buildChildEnvironment(env);
  checkedCommand(
    runCommand,
    "npm",
    ["-w", "@agentrysh/shared", "run", "build"],
    { cwd: repoRoot, env: childEnv },
    "shared build",
  );
  checkedCommand(
    runCommand,
    "npm",
    ["-w", "@agentry/db", "run", "build"],
    { cwd: repoRoot, env: childEnv },
    "database package build",
  );
  checkedCommand(
    runCommand,
    process.execPath,
    [join(repoRoot, "scripts/gen-workflow-manifest.mjs")],
    { cwd: repoRoot, env: childEnv },
    "workflow manifest generation",
  );
}

function prepareAuth({ runCommand, repoRoot, env }) {
  const childEnv = buildChildEnvironment(env);
  checkedCommand(
    runCommand,
    "npm",
    ["-w", "@agentry/auth", "run", "build"],
    { cwd: repoRoot, env: childEnv },
    "auth build",
  );
}

function prepareRedirect({ runCommand, repoRoot, env }) {
  const childEnv = buildChildEnvironment(env);
  checkedCommand(
    runCommand,
    "npm",
    ["-w", "@agentry/redirect", "run", "build"],
    { cwd: repoRoot, env: childEnv },
    "redirect build",
  );
}

function deployWorker({
  runCommand,
  repoRoot,
  env,
  sha,
  message,
  maintenance,
  expectedWorkerName,
  expectedTarget,
}) {
  const capture = prepareWranglerOutputCapture(repoRoot);
  const workerEnv = wranglerChildEnvironment(env, {
    AGENTRY_DEPLOY_SHA: sha,
    AGENTRY_CORE_DB_MAINTENANCE: maintenance,
    AGENTRY_ENVIRONMENT: "production",
    AGENTRY_DEPLOY_ENVIRONMENT: "production",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_OUTPUT_FILE_PATH: capture.file,
  });
  try {
    checkedCommand(
      runCommand,
      "npx",
      [
        "--no-install",
        "wrangler",
        "deploy",
        "--strict",
        "--var",
        `AGENTRY_DEPLOY_SHA:${sha}`,
        "--var",
        `AGENTRY_CORE_DB_MAINTENANCE:${maintenance}`,
        "--message",
        message,
      ],
      { cwd: join(repoRoot, "apps/api"), env: workerEnv },
      `Worker deploy (${maintenance === "off" ? "maintenance off" : "maintenance on"})`,
    );
    return wranglerWorkerVersionId(capture.file, { expectedWorkerName, expectedTarget });
  } finally {
    cleanupWranglerOutputCapture(capture);
  }
}

function deployAuthPages({ runCommand, repoRoot, env, sha, message }) {
  checkedCommand(
    runCommand,
    "npx",
    [
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
      sha,
      "--commit-message",
      message,
      "--commit-dirty=false",
    ],
    {
      cwd: join(repoRoot, "apps/auth"),
      env: wranglerChildEnvironment(env, {
        AGENTRY_DEPLOY_SHA: sha,
        AGENTRY_ENVIRONMENT: "production",
        AGENTRY_DEPLOY_ENVIRONMENT: "production",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        WRANGLER_LOG_SANITIZE: "true",
        GITHUB_REF_NAME: "main",
      }),
    },
    "auth Pages deploy",
  );
}

function deployRedirectWorker({ runCommand, repoRoot, env, sha, message }) {
  checkedCommand(
    runCommand,
    "npx",
    ["--no-install", "wrangler", "deploy", "--strict", "--message", message],
    {
      cwd: join(repoRoot, "apps/redirect"),
      env: wranglerChildEnvironment(env, {
        AGENTRY_DEPLOY_SHA: sha,
        AGENTRY_ENVIRONMENT: "production",
        AGENTRY_DEPLOY_ENVIRONMENT: "production",
        CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        WRANGLER_LOG_SANITIZE: "true",
        GITHUB_REF_NAME: "main",
      }),
    },
    "apex redirect Worker deploy",
  );
}

function recordDeploy({ runCommand, repoRoot, env, sha, providerDeploymentId = null }) {
  const modernIdentity = providerDeploymentId
    ? {
        AGENTRY_PROVIDER_DEPLOYMENT_ID: providerDeploymentId,
        AGENTRY_SOURCE_FINGERPRINT_SHA256: sourceFingerprint(env),
      }
    : {};
  checkedCommand(
    runCommand,
    process.execPath,
    [join(repoRoot, "scripts/tag-agentry-deploy.mjs")],
    {
      cwd: repoRoot,
      env: taggerChildEnvironment(env, {
        AGENTRY_DEPLOY_SHA: sha,
        AGENTRY_ENVIRONMENT: "production",
        AGENTRY_DEPLOY_ENVIRONMENT: "production",
        GITHUB_REF_NAME: "main",
        ...modernIdentity,
      }),
    },
    "strict deploy attribution",
  );
}

function normalizedMaintenanceApiUrl(value) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_MAINTENANCE_API_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ReleaseError("AGENTRY_MAINTENANCE_API_URL must be an absolute HTTPS URL");
  }
  const loopbackHttp = url.protocol === "http:" && [
    "localhost",
    "127.0.0.1",
    "[::1]",
  ].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopbackHttp)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new ReleaseError(
      "AGENTRY_MAINTENANCE_API_URL must be HTTPS (or loopback HTTP) without credentials or a fragment",
    );
  }
  return url.href;
}

function maintenanceDrainMs(value) {
  const raw = value === undefined ? String(DEFAULT_MAINTENANCE_DRAIN_SECONDS) : String(value);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new ReleaseError("AGENTRY_MAINTENANCE_DRAIN_SECONDS must be a positive integer");
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_MAINTENANCE_DRAIN_SECONDS) {
    throw new ReleaseError(
      `AGENTRY_MAINTENANCE_DRAIN_SECONDS must be 1-${MAX_MAINTENANCE_DRAIN_SECONDS}`,
    );
  }
  return seconds * 1_000;
}

function defaultMaintenanceId(sha) {
  return `core-${sha.slice(0, 12)}-${randomBytes(8).toString("hex")}`;
}

function normalizedMaintenanceId(value) {
  if (
    typeof value !== "string"
    || !MAINTENANCE_ID_PATTERN.test(value)
    || CI_KEY_PREFIX_PATTERN.test(value)
  ) {
    throw new ReleaseError("generated maintenance id was not a bounded nonsecret identifier");
  }
  return value;
}

async function proveMaintenance({
  fetchImpl,
  timeoutSignal,
  wait,
  apiUrl,
  maintenanceId,
}) {
  let consecutive = 0;
  for (let attempt = 0; attempt < MAINTENANCE_PROOF_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "user-agent": "agentry-release-maintenance-proof/1",
        },
        cache: "no-store",
        redirect: "manual",
        signal: timeoutSignal(HTTP_TIMEOUT_MS),
      });
    } catch {
      response = null;
    }

    if (response?.redirected) {
      await response.body?.cancel?.().catch(() => {});
      throw new ReleaseError("maintenance proof was redirected; API remains paused");
    }
    const observedId = response?.headers?.get("x-agentry-maintenance-id") ?? null;
    if (response?.status === 503 && observedId === maintenanceId) {
      consecutive += 1;
      await response.body?.cancel?.().catch(() => {});
      if (consecutive === MAINTENANCE_PROOF_CONSECUTIVE) return;
    } else {
      consecutive = 0;
      await response?.body?.cancel?.().catch(() => {});
    }

    if (attempt < MAINTENANCE_PROOF_MAX_ATTEMPTS - 1) {
      await wait(MAINTENANCE_PROOF_INTERVAL_MS);
    }
  }
  throw new ReleaseError("maintenance proof did not become stable; API remains paused");
}

async function readBoundedJson(response, label = "API smoke") {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SMOKE_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw new ReleaseError(`${label} response was oversized`);
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new ReleaseError(`${label} response was empty`);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_SMOKE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ReleaseError(`${label} response was oversized`);
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError(`${label} response could not be read`);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ReleaseError(`${label} response was not JSON`);
  }
}

async function smokeResumedApi({ fetchImpl, timeoutSignal, wait, apiUrl, sha }) {
  let lastFailure = "resumed API smoke request failed";
  for (let attempt = 0; attempt < MAINTENANCE_PROOF_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "GET",
        headers: {
          accept: "application/json",
          "cache-control": "no-store",
          "user-agent": "agentry-release-smoke/1",
        },
        cache: "no-store",
        redirect: "manual",
        signal: timeoutSignal(HTTP_TIMEOUT_MS),
      });
    } catch {
      response = null;
      lastFailure = "resumed API smoke request failed";
    }

    if (response?.redirected) {
      await response.body?.cancel?.().catch(() => {});
      throw new ReleaseError("resumed API smoke was redirected");
    }
    if (response?.status !== 200) {
      await response?.body?.cancel?.().catch(() => {});
      if (response) lastFailure = "resumed API smoke did not return HTTP 200";
    } else {
      const body = await readBoundedJson(response);
      if (body && typeof body === "object" && !Array.isArray(body) && body.deploy_sha === sha) {
        return;
      }
      lastFailure = "resumed API smoke did not report the exact release SHA";
    }

    if (attempt < MAINTENANCE_PROOF_MAX_ATTEMPTS - 1) {
      await wait(MAINTENANCE_PROOF_INTERVAL_MS);
    }
  }
  throw new ReleaseError(`${lastFailure} before the bounded propagation window expired`);
}

function proveBootstrapDatabaseEligibility({ runCommand, repoRoot, env, bootstrap }) {
  const childEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "TURSO_DATABASE_URL",
    "TURSO_AUTH_TOKEN",
    LEGACY_REVIEW_ENV,
  ]) {
    if (typeof env[name] === "string") childEnv[name] = env[name];
  }
  childEnv[BOOTSTRAP_PROJECT_ENV] = bootstrap.projectId;
  childEnv.AGENTRY_PRIVATE_API_KEY = bootstrap.ownerApiKey;
  const stdout = checkedCommand(
    runCommand,
    process.execPath,
    [join(repoRoot, "packages/db/scripts/verify-ci-attribution-bootstrap-eligibility.mjs")],
    {
      cwd: repoRoot,
      env: childEnv,
      capture: true,
    },
    "CI attribution bootstrap database eligibility",
  );
  let result;
  try {
    result = JSON.parse(exactSingleLine(stdout, "CI attribution bootstrap eligibility result"));
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError("CI attribution bootstrap eligibility result was not exact JSON");
  }
  const resultFields = [
    "ok",
    "eligibility",
    "adoption_state",
    "project_id",
    "owner_key_binding",
    "project_credentials",
  ];
  if (
    !result
    || typeof result !== "object"
    || Array.isArray(result)
    || JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(resultFields.sort())
    || result.ok !== true
    || result.eligibility !== "untracked_legacy_first_ci_credential"
    || !["untracked_legacy", "reviewed_legacy_retry"].includes(result.adoption_state)
    || result.project_id !== bootstrap.projectId
    || result.owner_key_binding !== "active_private_project_owner"
    || !["missing", "empty"].includes(result.project_credentials)
  ) {
    throw new ReleaseError(
      "CI attribution bootstrap database eligibility did not prove the exact legacy project, active private owner key, and zero project credentials",
    );
  }
}

async function bootstrapCredentialRequest({
  fetchImpl,
  timeoutSignal,
  url,
  ownerApiKey,
  method,
  body,
  sha,
}) {
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${ownerApiKey}`,
    "cache-control": "no-store",
    "user-agent": "agentry-release-ci-bootstrap/1",
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = `agentry-release-bootstrap-ci-${sha}`;
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
      signal: timeoutSignal(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new ReleaseError(
      method === "POST"
        ? "CI credential bootstrap response was unavailable; inspect project credentials and revoke any unrecoverable new key before retrying"
        : "CI credential inventory request failed before one-time bootstrap",
    );
  }
  if (response.redirected || response.status !== 200) {
    await response.body?.cancel?.().catch(() => {});
    throw new ReleaseError(
      method === "POST"
        ? `CI credential bootstrap failed with HTTP ${response.status}; inspect project credentials before retrying`
        : `CI credential inventory failed with HTTP ${response.status}`,
    );
  }
  return readBoundedJson(response, method === "POST" ? "CI credential bootstrap" : "CI credential inventory");
}

async function bootstrapCiCredential({
  fetchImpl,
  timeoutSignal,
  apiUrl,
  sha,
  bootstrap,
  openBootstrapCredentialFile,
}) {
  const endpoint = new URL(
    `/v1/projects/${encodeURIComponent(bootstrap.projectId)}/credentials`,
    apiUrl,
  ).toString();
  const inventory = await bootstrapCredentialRequest({
    fetchImpl,
    timeoutSignal,
    url: endpoint,
    ownerApiKey: bootstrap.ownerApiKey,
    method: "GET",
    sha,
  });
  if (
    !inventory
    || typeof inventory !== "object"
    || Array.isArray(inventory)
    || !Array.isArray(inventory.credentials)
  ) {
    throw new ReleaseError("CI credential inventory response was malformed");
  }
  if (inventory.credentials.length !== 0) {
    throw new ReleaseError(
      "one-time CI attribution bootstrap requires an empty project credential inventory; reconcile existing credentials without minting another",
    );
  }

  const sink = openBootstrapCredentialFile(bootstrap.credentialFile);
  try {
    const created = await bootstrapCredentialRequest({
      fetchImpl,
      timeoutSignal,
      url: endpoint,
      ownerApiKey: bootstrap.ownerApiKey,
      method: "POST",
      sha,
      body: {
        kind: "ci_deploy",
        name: `production-release-bootstrap-${sha.slice(0, 12)}`,
      },
    });
    if (
      !created
      || typeof created !== "object"
      || Array.isArray(created)
      || created.project_id !== bootstrap.projectId
      || created.kind !== "ci_deploy"
      || created.env_var !== "AGENTRY_CI_API_KEY"
      || created.active !== true
      || created.idempotent_replay !== false
      || typeof created.credential !== "string"
    ) {
      throw new ReleaseError("CI credential bootstrap response did not match the exact requested project and kind");
    }
    let validated;
    try {
      validated = validateDeployTagEnvironment({
        AGENTRY_CI_API_KEY: created.credential,
        AGENTRY_DEPLOY_SHA: sha,
        AGENTRY_URL: apiUrl,
      });
    } catch {
      throw new ReleaseError("CI credential bootstrap returned malformed attribution authority");
    }
    if (validated.projectId !== bootstrap.projectId || validated.sha !== sha) {
      throw new ReleaseError("CI credential bootstrap authority did not bind the exact project and release SHA");
    }
    sink.write(created.credential);
    return created.credential;
  } finally {
    sink.close();
  }
}

function databaseCommand({ runCommand, repoRoot, env, script, extraEnv = {}, extraArgs = [] }) {
  checkedCommand(
    runCommand,
    "npm",
    ["-w", "@agentry/db", "run", script, ...extraArgs],
    { cwd: repoRoot, env: databaseChildEnvironment(env, extraEnv) },
    script,
  );
}

async function releaseApi(context) {
  const candidate = context.releaseCandidate;
  prepareApi(context);
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  assertStrictAttributionReady(context.env, candidate.sha, { requireSourceFingerprint: true });
  const releaseEnv = {
    AGENTRY_DEPLOY_SHA: candidate.sha,
    AGENTRY_CORE_DB_MAINTENANCE: "off",
  };
  databaseCommand({
    ...context,
    script: "db:verify:core",
    extraEnv: releaseEnv,
  });
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  const apiUrl = normalizedMaintenanceApiUrl(context.env.AGENTRY_MAINTENANCE_API_URL);
  const providerDeploymentId = deployWorker({
    ...context,
    sha: candidate.sha,
    message: candidate.message,
    maintenance: "off",
    expectedWorkerName: API_WORKER_NAME,
    expectedTarget: API_WORKER_TARGET,
  });
  await smokeResumedApi({ ...context, apiUrl, sha: candidate.sha });
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  recordDeploy({ ...context, sha: candidate.sha, providerDeploymentId });
}

async function releaseAuth(context) {
  const candidate = context.releaseCandidate;
  prepareAuth(context);
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  assertStrictAttributionReady(context.env, candidate.sha);
  deployAuthPages({
    ...context,
    sha: candidate.sha,
    message: candidate.message,
  });
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  recordDeploy({ ...context, sha: candidate.sha });
}

async function releaseRedirect(context) {
  const candidate = context.releaseCandidate;
  prepareRedirect(context);
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  assertStrictAttributionReady(context.env, candidate.sha);
  deployRedirectWorker({
    ...context,
    sha: candidate.sha,
    message: candidate.message,
  });
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  recordDeploy({ ...context, sha: candidate.sha });
}

async function releaseApiWithCoreMigration(context) {
  const candidate = context.releaseCandidate;
  prepareApi(context);
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  sourceFingerprint(context.env);
  if (!context.releaseAuthority.bootstrap) {
    assertStrictAttributionReady(context.env, candidate.sha, { requireSourceFingerprint: true });
  }
  const apiUrl = normalizedMaintenanceApiUrl(context.env.AGENTRY_MAINTENANCE_API_URL);
  const drainMs = maintenanceDrainMs(context.env.AGENTRY_MAINTENANCE_DRAIN_SECONDS);
  const maintenanceId = normalizedMaintenanceId(context.maintenanceIdFactory(candidate.sha));
  const migrationEnv = {
    AGENTRY_DEPLOY_SHA: candidate.sha,
    AGENTRY_CORE_DB_MAINTENANCE: maintenanceId,
    AGENTRY_MAINTENANCE_API_URL: apiUrl,
    AGENTRY_MAINTENANCE_ID: maintenanceId,
  };

  if (context.releaseAuthority.bootstrap) {
    proveBootstrapDatabaseEligibility({
      ...context,
      bootstrap: context.releaseAuthority.bootstrap,
    });
    assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  }

  deployWorker({
    ...context,
    sha: candidate.sha,
    message: candidate.message,
    maintenance: maintenanceId,
    expectedWorkerName: API_WORKER_NAME,
    expectedTarget: API_WORKER_TARGET,
  });
  await proveMaintenance({
    ...context,
    apiUrl,
    maintenanceId,
  });
  await context.wait(drainMs);

  // Intentionally no finally/resume path: either database command failing must
  // leave the already-deployed maintenance fence active.
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  databaseCommand({
    ...context,
    script: "db:migrate:core",
    extraEnv: migrationEnv,
    extraArgs: context.reviewedLegacyBaseline
      ? ["--", REVIEWED_LEGACY_BASELINE_FLAG]
      : [],
  });
  databaseCommand({
    ...context,
    script: "db:verify:core",
    extraEnv: migrationEnv,
  });

  const resumedCandidate = assertReleaseCandidate({
    ...context,
    expectedSha: candidate.sha,
  });
  const providerDeploymentId = deployWorker({
    ...context,
    sha: candidate.sha,
    message: resumedCandidate.message,
    maintenance: "off",
    expectedWorkerName: API_WORKER_NAME,
    expectedTarget: API_WORKER_TARGET,
  });
  await smokeResumedApi({ ...context, apiUrl, sha: candidate.sha });
  assertReleaseCandidate({ ...context, expectedSha: candidate.sha });

  let attributionEnv = context.env;
  if (context.releaseAuthority.bootstrap) {
    const ciCredential = await bootstrapCiCredential({
      ...context,
      apiUrl,
      sha: candidate.sha,
      bootstrap: context.releaseAuthority.bootstrap,
    });
    attributionEnv = {
      ...context.env,
      AGENTRY_CI_API_KEY: ciCredential,
      AGENTRY_URL: apiUrl,
    };
    assertStrictAttributionReady(attributionEnv, candidate.sha, { requireSourceFingerprint: true });
    assertReleaseCandidate({ ...context, expectedSha: candidate.sha });
  }
  recordDeploy({
    ...context,
    env: attributionEnv,
    sha: candidate.sha,
    providerDeploymentId,
  });
}

export async function runAgentryDeploy({
  mode,
  reviewedLegacyBaseline = false,
  bootstrapCiAttribution = false,
  env = process.env,
  repoRoot = defaultRepoRoot,
  runCommand = defaultRunCommand,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
  wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  maintenanceIdFactory = defaultMaintenanceId,
  prepareBootstrapCredentialFile = prepareBootstrapCredentialFilePath,
  openBootstrapCredentialFile = openBootstrapCredentialSink,
  stdout = (message) => console.log(message),
  stderr = (message) => console.error(message),
} = {}) {
  try {
    if (!RELEASE_MODES.includes(mode)) {
      throw new ReleaseError(`mode must be exactly one of: ${RELEASE_MODES.join(", ")}`);
    }
    if (typeof fetchImpl !== "function") {
      throw new ReleaseError("release HTTP support is unavailable");
    }
    if (
      typeof prepareBootstrapCredentialFile !== "function"
      || typeof openBootstrapCredentialFile !== "function"
    ) {
      throw new ReleaseError("release bootstrap file support is unavailable");
    }
    const resolvedRepoRoot = resolve(repoRoot);
    const authority = releaseAuthority({
      mode,
      env,
      repoRoot: resolvedRepoRoot,
      reviewedLegacyBaseline,
      bootstrapCiAttribution,
      prepareBootstrapCredentialFile,
    });
    const releaseEnv = {
      ...env,
      AGENTRY_ENVIRONMENT: "production",
      AGENTRY_DEPLOY_ENVIRONMENT: "production",
    };
    if (authority.bootstrap) {
      delete releaseEnv.AGENTRY_PRIVATE_API_KEY;
      delete releaseEnv[BOOTSTRAP_PROJECT_ENV];
      delete releaseEnv[BOOTSTRAP_KEY_FILE_ENV];
    }
    const preparationContext = {
      env: releaseEnv,
      reviewedLegacyBaseline,
      releaseAuthority: authority,
      repoRoot: resolvedRepoRoot,
      runCommand,
      fetchImpl,
      timeoutSignal,
      wait,
      maintenanceIdFactory,
      openBootstrapCredentialFile,
    };
    const releaseCandidate = assertReleaseCandidate(preparationContext);
    assertAutomationDeployBindingReady(releaseEnv);
    verifyRelease(preparationContext);
    assertReleaseCandidate({
      ...preparationContext,
      expectedSha: releaseCandidate.sha,
    });
    const context = { ...preparationContext, releaseCandidate };

    if (mode === "api") await releaseApi(context);
    else if (mode === "auth") await releaseAuth(context);
    else if (mode === "redirect") await releaseRedirect(context);
    else await releaseApiWithCoreMigration(context);

    stdout(`deploy-agentry: ${mode} release completed`);
    return 0;
  } catch (error) {
    const message = error instanceof ReleaseError
      ? error.message
      : "unexpected release failure";
    stderr(`deploy-agentry: ${message}`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [mode, ...flags] = process.argv.slice(2);
  const allowedFlags = new Set([
    REVIEWED_LEGACY_BASELINE_FLAG,
    BOOTSTRAP_CI_ATTRIBUTION_FLAG,
  ]);
  const uniqueFlags = new Set(flags);
  const validFlags = flags.every((flag) => allowedFlags.has(flag))
    && uniqueFlags.size === flags.length;
  const reviewedLegacyBaseline = uniqueFlags.has(REVIEWED_LEGACY_BASELINE_FLAG);
  const bootstrapCiAttribution = uniqueFlags.has(BOOTSTRAP_CI_ATTRIBUTION_FLAG);
  if (!mode || !validFlags) {
    console.error(
      `deploy-agentry: usage: node scripts/deploy-agentry.mjs <${RELEASE_MODES.join("|")}> ` +
      `[${REVIEWED_LEGACY_BASELINE_FLAG}] [${BOOTSTRAP_CI_ATTRIBUTION_FLAG}]`,
    );
    process.exitCode = 1;
  } else {
    process.exitCode = await runAgentryDeploy({
      mode,
      reviewedLegacyBaseline,
      bootstrapCiAttribution,
    });
  }
}
