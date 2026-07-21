import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { redactArtifactText } from "./artifact-redaction.mjs";
import { AGENTRY_SELF_REPAIR_POLICY } from "./agentry-draft-subject.mjs";

export const SCHEDULER_USER_AGENT = "agentry-codex-cli-scheduler/1.0";
const CODEX_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "GH_TOKEN",
  "GIT_TERMINAL_PROMPT", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "NODE_EXTRA_CA_CERTS", "AGENTRY_URL", "AGENTRY_RUNNER_API_KEY",
  "AGENTRY_HTTP_USER_AGENT", "AGENTRY_AUTOMATION_PROJECT_ID",
  "AGENTRY_AUTOMATION_ID", "AGENTRY_AUTOMATION_RUNNER_ID",
  "AGENTRY_AUTOMATION_RUN_ID", "AGENTRY_AUTOMATION_OPERATION_STATE_FILE",
  "AGENTRY_AUTOMATION_LEASE_TOKEN", "AGENTRY_AUTOMATION_REPOSITORY",
  "AGENTRY_AUTOMATION_DEFAULT_BRANCH",
]);
const CODEX_FIXED_ARGV = Object.freeze([
  "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
  "--json", "--sandbox", "workspace-write",
  "-c", 'approval_policy="never"',
  "-c", 'web_search="disabled"',
  "-c", "sandbox_workspace_write.network_access=true",
  "-c", "features.network_proxy.enabled=true",
  "-c", 'features.network_proxy.domains={ "api.agentry.sh" = "allow", "api.github.com" = "allow", "github.com" = "allow" }',
  "-c", 'shell_environment_policy.inherit="all"',
  "-c", "shell_environment_policy.ignore_default_excludes=true",
  "-c", `shell_environment_policy.include_only=${JSON.stringify(CODEX_ENVIRONMENT_KEYS)}`,
]);
export const CODEX_DIRECT_INVOCATION = Object.freeze({
  executable: "codex",
  argv: Object.freeze([...CODEX_FIXED_ARGV, "--add-dir", "<agent-state-dir>", "-"]),
});

export function buildCodexInvocation(agentStateDir) {
  if (!isAbsolute(agentStateDir)) {
    throw new SchedulerError("Codex agent state directory must be absolute", {
      code: "state_boundary_invalid",
    });
  }
  return {
    executable: CODEX_DIRECT_INVOCATION.executable,
    argv: [...CODEX_FIXED_ARGV, "--add-dir", resolve(agentStateDir), "-"],
  };
}

export const RUN_STATE_SCHEMA_VERSION = "1";
export const PROMPT_PATH = fileURLToPath(
  new URL("../prompts/agentry-error-to-draft-pr.md", import.meta.url),
);

const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "escalated", "cancelled"]);
const CODEX_ACTIONABLE_STATUSES = new Set(["claimed", "running", "verifying"]);
const WAITING_RUN_STATUSES = new Set(["awaiting_approval", "draft_pr_opened"]);
const PASSTHROUGH_ENV = new Set([
  "PATH",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "NO_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

export class SchedulerError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SchedulerError";
    this.code = options.code ?? "scheduler_error";
  }
}

export class SchedulerBusyError extends SchedulerError {
  constructor(owner = null) {
    super("another scheduler invocation owns the automation lock", {
      code: "scheduler_lock_held",
    });
    this.name = "SchedulerBusyError";
    this.owner = owner;
  }
}

export class AgentryHttpError extends SchedulerError {
  constructor(status, code, message, nextAction) {
    super(`Agentry returned HTTP ${status}: ${message}`, {
      code: code || "agentry_http_error",
    });
    this.name = "AgentryHttpError";
    this.status = status;
    this.nextAction = nextAction ?? null;
  }
}

function requiredEnv(env, name) {
  const value = typeof env[name] === "string" ? env[name].trim() : "";
  if (!value) throw new SchedulerError(`${name} is required`, { code: "configuration_missing" });
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SchedulerError(`${name} must be an integer from ${minimum} through ${maximum}`, {
      code: "configuration_invalid",
    });
  }
  return parsed;
}

function safeText(value, name, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new SchedulerError(`${name} is invalid`, { code: "configuration_invalid" });
  }
  return value;
}

export function normalizeApiBase(value) {
  const url = new URL(value || "https://api.agentry.sh");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SchedulerError("AGENTRY_URL must use HTTPS, except for an explicit loopback development API", {
      code: "configuration_invalid",
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SchedulerError("AGENTRY_URL cannot contain credentials, query parameters, or a fragment", {
      code: "configuration_invalid",
    });
  }
  return url.toString().replace(/\/$/u, "");
}

function isWithin(child, parent) {
  const result = relative(resolve(parent), resolve(child));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== "..");
}

export function loadSchedulerConfig(env = process.env, options = {}) {
  const runnerKey = requiredEnv(env, "AGENTRY_RUNNER_API_KEY");
  if (!runnerKey.startsWith("agentry_runner_") || runnerKey.length < 32 || runnerKey.length > 1_000) {
    throw new SchedulerError("AGENTRY_RUNNER_API_KEY must be an automation-scoped agentry_runner_ credential", {
      code: "configuration_invalid",
    });
  }
  const runnerId = safeText(
    env.AGENTRY_AUTOMATION_RUNNER_ID?.trim() || AGENTRY_SELF_REPAIR_POLICY.runner_id,
    "AGENTRY_AUTOMATION_RUNNER_ID",
    300,
  );
  if (runnerId !== AGENTRY_SELF_REPAIR_POLICY.runner_id) {
    throw new SchedulerError(`AGENTRY_AUTOMATION_RUNNER_ID must be exactly ${AGENTRY_SELF_REPAIR_POLICY.runner_id}`, {
      code: "configuration_invalid",
    });
  }
  const githubToken = requiredEnv(env, "AGENTRY_AUTOMATION_GITHUB_TOKEN");
  if (githubToken.length < 20 || githubToken.length > 1_000 || /\s/u.test(githubToken)) {
    throw new SchedulerError("AGENTRY_AUTOMATION_GITHUB_TOKEN must be a dedicated repository-scoped token", {
      code: "configuration_invalid",
    });
  }
  const home = options.home ?? homedir();
  const repositoryRoot = resolve(options.repositoryRoot ?? process.cwd());
  const configuredStateDir = env.AGENTRY_AUTOMATION_STATE_DIR?.trim() ||
    join(home, ".local", "state", "agentry", "codex-automations", AGENTRY_SELF_REPAIR_POLICY.automation_id);
  if (!isAbsolute(configuredStateDir)) {
    throw new SchedulerError("AGENTRY_AUTOMATION_STATE_DIR must be absolute", { code: "configuration_invalid" });
  }
  const stateDir = resolve(configuredStateDir);
  if (isWithin(stateDir, repositoryRoot)) {
    throw new SchedulerError("AGENTRY_AUTOMATION_STATE_DIR must stay outside the repository", {
      code: "configuration_invalid",
    });
  }
  const automationHome = resolve(requiredEnv(env, "AGENTRY_AUTOMATION_HOME"));
  const codexHome = resolve(requiredEnv(env, "AGENTRY_AUTOMATION_CODEX_HOME"));
  for (const [name, path] of [
    ["AGENTRY_AUTOMATION_HOME", automationHome],
    ["AGENTRY_AUTOMATION_CODEX_HOME", codexHome],
  ]) {
    if (!isAbsolute(env[name].trim()) || isWithin(path, repositoryRoot)) {
      throw new SchedulerError(`${name} must be an absolute directory outside the repository`, {
        code: "configuration_invalid",
      });
    }
  }
  const interactiveHome = resolve(options.interactiveHome ?? env.HOME ?? homedir());
  const interactiveCodexHome = resolve(
    options.interactiveCodexHome ?? env.CODEX_HOME ?? join(interactiveHome, ".codex"),
  );
  if (
    automationHome === interactiveHome ||
    codexHome === interactiveCodexHome ||
    codexHome === automationHome
  ) {
    throw new SchedulerError("automation HOME and CODEX_HOME must be dedicated, distinct, and non-interactive", {
      code: "configuration_invalid",
    });
  }
  return {
    ...AGENTRY_SELF_REPAIR_POLICY,
    apiBase: normalizeApiBase(env.AGENTRY_URL),
    runnerKey,
    runnerId,
    githubToken,
    stateDir,
    automationHome,
    codexHome,
    repositoryRoot,
    promptPath: PROMPT_PATH,
    codexTimeoutSeconds: boundedInteger(
      env.AGENTRY_AUTOMATION_CODEX_TIMEOUT_SECONDS,
      3_000,
      60,
      3_300,
      "AGENTRY_AUTOMATION_CODEX_TIMEOUT_SECONDS",
    ),
    renewIntervalSeconds: boundedInteger(
      env.AGENTRY_AUTOMATION_RENEW_INTERVAL_SECONDS,
      300,
      60,
      900,
      "AGENTRY_AUTOMATION_RENEW_INTERVAL_SECONDS",
    ),
    maxLogBytes: boundedInteger(
      env.AGENTRY_AUTOMATION_MAX_LOG_BYTES,
      1024 * 1024,
      64 * 1024,
      5 * 1024 * 1024,
      "AGENTRY_AUTOMATION_MAX_LOG_BYTES",
    ),
  };
}

async function pathKind(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function ensureSecureStateRoot(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const metadata = await pathKind(stateDir);
  if (
    !metadata?.isDirectory() ||
    metadata.isSymbolicLink() ||
    await realpath(stateDir) !== resolve(stateDir)
  ) {
    throw new SchedulerError("automation state root must resolve exactly to a real directory without symlink redirection", {
      code: "state_boundary_invalid",
    });
  }
  await chmod(stateDir, 0o700);
}

export async function ensureExistingPrivateDirectory(path, label) {
  const metadata = await pathKind(path);
  if (
    !metadata?.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    await realpath(path) !== resolve(path)
  ) {
    throw new SchedulerError(`${label} must be an existing real directory with mode 0700`, {
      code: "state_boundary_invalid",
    });
  }
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await pathKind(path);
  if (
    !metadata?.isDirectory() ||
    metadata.isSymbolicLink() ||
    await realpath(path) !== resolve(path)
  ) {
    throw new SchedulerError("private runtime path must be a real directory", {
      code: "state_boundary_invalid",
    });
  }
  await chmod(path, 0o700);
}

async function atomicWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, mode);
}

export async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function readJson(path, maximum = 256 * 1024) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maximum) {
    throw new SchedulerError(`state file is not a bounded regular file: ${path}`, {
      code: "state_invalid",
    });
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function acquireSchedulerLock(stateDir, options = {}) {
  const lockDir = join(stateDir, "scheduler.lock");
  const currentHost = options.hostname ?? hostname();
  const currentPid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? processAlive;
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      const owner = {
        schema_version: "1",
        token,
        hostname: currentHost,
        pid: currentPid,
        acquired_at: Math.floor(Date.now() / 1000),
      };
      await atomicWriteJson(join(lockDir, "owner.json"), owner);
      return {
        owner,
        async release() {
          let observed;
          try {
            observed = await readJson(join(lockDir, "owner.json"), 16 * 1024);
          } catch {
            return;
          }
          if (observed?.token === token && observed?.pid === currentPid && observed?.hostname === currentHost) {
            await rm(lockDir, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = null;
      try {
        owner = await readJson(join(lockDir, "owner.json"), 16 * 1024);
      } catch {
        throw new SchedulerBusyError();
      }
      if (
        attempt === 0 &&
        owner?.hostname === currentHost &&
        Number.isInteger(owner?.pid) &&
        !isAlive(owner.pid)
      ) {
        const stale = join(stateDir, `scheduler.lock.stale.${Date.now()}.${randomUUID()}`);
        try {
          await rename(lockDir, stale);
          continue;
        } catch (renameError) {
          if (renameError?.code === "ENOENT") continue;
          throw new SchedulerBusyError(owner);
        }
      }
      throw new SchedulerBusyError(owner);
    }
  }
  throw new SchedulerBusyError();
}

export function stableIdempotencyKey(kind, automationId, occurrenceId) {
  const digest = createHash("sha256")
    .update(`${kind}\u0000${automationId}\u0000${occurrenceId}`, "utf8")
    .digest("hex");
  return `agentry-${kind}-${digest}`;
}

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,300}$/u.test(value)) {
    throw new SchedulerError(`${label} is not a safe state identifier`, { code: "state_invalid" });
  }
  return value;
}

export function provisionalStateForReceipt(config, receipt) {
  const receiptId = safeSegment(receipt?.id, "receipt id");
  const caseId = safeSegment(receipt?.trigger?.case_id, "case id");
  if (
    receipt.project_id !== config.project_id ||
    receipt.automation_id !== config.automation_id ||
    receipt.status !== "ready" ||
    receipt.trigger?.kind !== "unhandled_cases" ||
    !Number.isInteger(receipt.trigger?.case_revision) ||
    !Number.isInteger(receipt.trigger?.attempt)
  ) {
    throw new SchedulerError("ready receipt does not match the frozen self-repair binding", {
      code: "trigger_receipt_mismatch",
    });
  }
  const claimRequest = {
    automation_id: config.automation_id,
    trigger_receipt_id: receiptId,
    claimed_by: config.runnerId,
    lease_seconds: 3_600,
  };
  return {
    schema_version: RUN_STATE_SCHEMA_VERSION,
    phase: "claiming",
    project_id: config.project_id,
    automation_id: config.automation_id,
    repository: config.repository,
    default_branch: config.default_branch,
    receipt_id: receiptId,
    case_id: caseId,
    case_revision: receipt.trigger.case_revision,
    claim_idempotency_key: stableIdempotencyKey("claim", config.automation_id, receiptId),
    claim_request: claimRequest,
    claim_id: null,
    lease_token: null,
    lease_expires_at: null,
    run_idempotency_key: stableIdempotencyKey("run", config.automation_id, receiptId),
    run_request: null,
    run_id: null,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  };
}

export function provisionalStatePath(config, receiptId) {
  return join(config.stateDir, "receipts", safeSegment(receiptId, "receipt id"), "state.json");
}

export function runStatePath(config, runId) {
  return join(config.stateDir, "runs", safeSegment(runId, "run id"), "state.json");
}

export function runWorkspacePath(config, runId) {
  return join(config.stateDir, "runs", safeSegment(runId, "run id"), "repo");
}

export async function listStoredStates(config, kind) {
  const root = join(config.stateDir, kind === "run" ? "runs" : "receipts");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const states = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9._-]{1,300}$/u.test(entry.name)) continue;
    const path = join(root, entry.name, "state.json");
    try {
      const state = await readJson(path);
      validateStoredState(config, state, kind);
      states.push({ path, state });
    } catch (error) {
      throw new SchedulerError(`cannot recover ${kind} state ${entry.name}: ${error.message}`, {
        code: "state_recovery_failed",
      });
    }
  }
  return states;
}

function validateStoredState(config, state, kind) {
  if (
    state?.schema_version !== RUN_STATE_SCHEMA_VERSION ||
    state.project_id !== config.project_id ||
    state.automation_id !== config.automation_id ||
    state.repository !== config.repository ||
    state.default_branch !== config.default_branch
  ) {
    throw new SchedulerError("stored state does not match the frozen automation binding", {
      code: "state_binding_mismatch",
    });
  }
  safeSegment(state.receipt_id, "stored receipt id");
  safeSegment(state.case_id, "stored case id");
  if (kind === "run") {
    safeSegment(state.run_id, "stored run id");
    safeSegment(state.claim_id, "stored claim id");
    if (typeof state.lease_token !== "string" || !state.lease_token.startsWith("lease_")) {
      throw new SchedulerError("stored run state has no recoverable lease token", {
        code: "state_secret_missing",
      });
    }
  }
}

export async function promoteProvisionalState(config, provisionalPath, state, run) {
  const runId = safeSegment(run?.id, "run id");
  const targetDir = dirname(runStatePath(config, runId));
  const sourceDir = dirname(provisionalPath);
  await mkdir(targetDir, { recursive: true, mode: 0o700 });
  const existing = await pathKind(targetDir);
  if (!existing?.isDirectory() || existing.isSymbolicLink()) {
    throw new SchedulerError("run state target is not a safe directory", { code: "state_boundary_invalid" });
  }
  const promoted = {
    ...state,
    phase: "running",
    run_id: runId,
    run_request: state.run_request,
    updated_at: Math.floor(Date.now() / 1000),
  };
  await atomicWriteJson(runStatePath(config, runId), promoted);
  await rm(sourceDir, { recursive: true, force: true });
  return { path: runStatePath(config, runId), state: promoted };
}

function parsedApiError(body) {
  const root = body && typeof body === "object" ? body : {};
  const error = root.error && typeof root.error === "object" ? root.error : root;
  return {
    code: typeof error.code === "string" ? error.code.slice(0, 120) : null,
    message: typeof error.message === "string" ? error.message.slice(0, 1_000) : "request failed",
    nextAction: typeof error.next_action === "string" ? error.next_action.slice(0, 2_000) : null,
  };
}

async function boundedResponseJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SchedulerError("Agentry response exceeded the scheduler's 2 MiB boundary", {
        code: "api_response_too_large",
      });
    }
    chunks.push(Buffer.from(value));
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SchedulerError("Agentry returned non-JSON data", { code: "api_response_invalid" });
  }
}

export class AgentryRunnerClient {
  constructor(config, options = {}) {
    this.base = config.apiBase;
    this.key = config.runnerKey;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request(method, path, options = {}) {
    const target = new URL(path, `${this.base}/`);
    if (target.origin !== new URL(this.base).origin) {
      throw new SchedulerError("refusing a cross-origin Agentry request", { code: "api_origin_mismatch" });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    let response;
    try {
      response = await this.fetch(target, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.key}`,
          "User-Agent": SCHEDULER_USER_AGENT,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.headers ?? {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new SchedulerError("Agentry request timed out; replay only with the same frozen request and idempotency key", {
          code: "api_response_lost",
        });
      }
      throw new SchedulerError("Agentry request failed before a response was available; recover from durable state", {
        code: "api_response_lost",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = await boundedResponseJson(response);
    if (!response.ok) {
      const parsed = parsedApiError(body);
      throw new AgentryHttpError(response.status, parsed.code, parsed.message, parsed.nextAction);
    }
    return body;
  }

  get(path) {
    return this.request("GET", path);
  }

  post(path, body, headers = {}) {
    return this.request("POST", path, { body, headers });
  }
}

export async function listAll(client, firstPath, field, maximumPages = 20) {
  const values = [];
  let path = firstPath;
  for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
    const page = await client.get(path);
    if (!Array.isArray(page?.[field])) {
      throw new SchedulerError(`Agentry ${field} response is invalid`, { code: "api_response_invalid" });
    }
    values.push(...page[field]);
    if (!page.pagination?.has_more) return values;
    const followUp = page.pagination?.follow_up;
    if (followUp?.method !== "GET" || typeof followUp.href !== "string") {
      throw new SchedulerError(`Agentry ${field} pagination is missing its exact follow-up`, {
        code: "api_response_invalid",
      });
    }
    path = followUp.href;
  }
  throw new SchedulerError(`Agentry ${field} pagination exceeded ${maximumPages} pages`, {
    code: "api_pagination_limit",
  });
}

export function selectRunDisposition(run) {
  const status = run?.status;
  if (status === "queued") {
    throw new SchedulerError("a case-bound error-to-draft-PR run cannot be queued without its required claim", {
      code: "unexpected_queued_error_run",
    });
  }
  if (TERMINAL_RUN_STATUSES.has(status)) return "terminal";
  if (CODEX_ACTIONABLE_STATUSES.has(status)) return "invoke_codex";
  if (WAITING_RUN_STATUSES.has(status)) return status === "awaiting_approval" ? "renew_and_wait" : "wait";
  throw new SchedulerError(`unknown automation run status: ${String(status)}`, {
    code: "run_status_unknown",
  });
}

export function buildProviderEnvironment(parentEnv, githubToken) {
  const child = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (PASSTHROUGH_ENV.has(key) || key.startsWith("LC_")) child[key] = value;
  }
  if (githubToken) {
    const authorization = `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`, "utf8").toString("base64")}`;
    Object.assign(child, {
      GH_TOKEN: githubToken,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: authorization,
      GIT_AUTHOR_NAME: "Agentry Self Repair Runner",
      GIT_AUTHOR_EMAIL: "agentry-self-repair-runner-01@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Agentry Self Repair Runner",
      GIT_COMMITTER_EMAIL: "agentry-self-repair-runner-01@users.noreply.github.com",
    });
  }
  return child;
}

export function buildCodexEnvironment(parentEnv, config, operationStatePath, state) {
  const child = buildProviderEnvironment(parentEnv, config.githubToken);
  Object.assign(child, {
    HOME: config.automationHome,
    CODEX_HOME: config.codexHome,
    AGENTRY_URL: config.apiBase,
    AGENTRY_RUNNER_API_KEY: config.runnerKey,
    AGENTRY_HTTP_USER_AGENT: SCHEDULER_USER_AGENT,
    AGENTRY_AUTOMATION_PROJECT_ID: config.project_id,
    AGENTRY_AUTOMATION_ID: config.automation_id,
    AGENTRY_AUTOMATION_RUNNER_ID: config.runnerId,
    AGENTRY_AUTOMATION_RUN_ID: state.run_id,
    AGENTRY_AUTOMATION_OPERATION_STATE_FILE: operationStatePath,
    AGENTRY_AUTOMATION_LEASE_TOKEN: state.lease_token,
    AGENTRY_AUTOMATION_REPOSITORY: config.repository,
    AGENTRY_AUTOMATION_DEFAULT_BRANCH: config.default_branch,
  });
  return child;
}

export function buildDependencyEnvironment(parentEnv, dependencyHome, cacheDir) {
  const child = {};
  for (const key of [
    "PATH", "TMPDIR", "LANG", "LANGUAGE", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    if (typeof parentEnv[key] === "string") child[key] = parentEnv[key];
  }
  Object.assign(child, {
    HOME: dependencyHome,
    NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
    NPM_CONFIG_CACHE: cacheDir,
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  });
  return child;
}

export function redactAutomationText(value, exactValues = []) {
  let redacted = String(value);
  for (const secret of [...exactValues]
    .filter((item) => typeof item === "string" && item.length >= 8)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.split(secret).join("<redacted-exact>");
  }
  return redactArtifactText(redacted)
    .replace(/\blease_[A-Za-z0-9._-]{8,}\b/gu, "lease_<redacted>")
    .replace(/\baction_[A-Za-z0-9._-]{8,}\b/gu, "action_<redacted>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, "github_pat_<redacted>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu, "gh_<redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "sk-<redacted>");
}

export class BoundedRedactedLog {
  constructor(maximumBytes, exactValues = []) {
    this.maximumBytes = maximumBytes;
    this.exactValues = exactValues;
    this.buffer = Buffer.alloc(0);
    this.truncated = false;
  }

  append(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    this.buffer = Buffer.concat([this.buffer, value]);
    if (this.buffer.length > this.maximumBytes) {
      this.buffer = this.buffer.subarray(this.buffer.length - this.maximumBytes);
      this.truncated = true;
    }
  }

  finish() {
    const redacted = Buffer.from(
      redactAutomationText(this.buffer.toString("utf8"), this.exactValues),
      "utf8",
    );
    return redacted.length <= this.maximumBytes
      ? redacted.toString("utf8")
      : redacted.subarray(redacted.length - this.maximumBytes).toString("utf8");
  }
}

export async function runDirectCommand(executable, argv, options = {}) {
  if (typeof executable !== "string" || !Array.isArray(argv) || argv.some((arg) => typeof arg !== "string")) {
    throw new SchedulerError("direct command requires one executable and an argv array", {
      code: "command_invalid",
    });
  }
  const spawn = options.spawn ?? nodeSpawn;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const maximumBytes = options.maximumBytes ?? 256 * 1024;
  const exactValues = options.exactValues ?? [];
  const stdoutLog = new BoundedRedactedLog(maximumBytes, exactValues);
  const stderrLog = new BoundedRedactedLog(maximumBytes, exactValues);
  const processGroup = options.processGroup === true && process.platform !== "win32";
  const child = spawn(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: processGroup,
    windowsHide: true,
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdoutLog.append(chunk));
  child.stderr?.on("data", (chunk) => stderrLog.append(chunk));
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  const terminate = (signal) => {
    if (processGroup && Number.isInteger(child.pid)) {
      try {
        killProcess(-child.pid, signal);
        return;
      } catch (error) {
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
      }
    }
    child.kill(signal);
  };
  let timedOut = false;
  let forceKill = null;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        forceKill = setTimeout(() => terminate("SIGKILL"), 10_000);
        forceKill.unref?.();
      }, options.timeoutMs)
    : null;
  timeout?.unref?.();
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  if (timeout) clearTimeout(timeout);
  if (forceKill) clearTimeout(forceKill);
  return {
    ...result,
    timedOut,
    stdout: stdoutLog.finish(),
    stderr: stderrLog.finish(),
    truncated: stdoutLog.truncated || stderrLog.truncated,
  };
}

function normalizedRepository(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname.replace(/\.git$/u, "").replace(/\/+$/u, "")}`.toLowerCase();
}

export async function ensureIsolatedCheckout(config, state, options = {}) {
  const workspace = runWorkspacePath(config, state.run_id);
  const metadata = await pathKind(workspace);
  const gitEnvironment = buildProviderEnvironment(options.env ?? process.env, config.githubToken);
  const exactValues = [config.githubToken, gitEnvironment.GIT_CONFIG_VALUE_1];
  if (metadata) {
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SchedulerError("run workspace is not a safe directory", { code: "workspace_invalid" });
    }
    const remote = await runDirectCommand("git", ["-C", workspace, "remote", "get-url", "origin"], {
      ...options,
      env: gitEnvironment,
      exactValues,
    });
    if (remote.code !== 0 || normalizedRepository(remote.stdout.trim()) !== normalizedRepository(config.repository)) {
      throw new SchedulerError("persistent workspace origin does not match the frozen repository", {
        code: "workspace_repository_mismatch",
      });
    }
    return workspace;
  }

  const parent = dirname(workspace);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.repo.clone.${randomUUID()}`);
  const clone = await runDirectCommand(
    "git",
    ["clone", "--filter=blob:none", "--branch", config.default_branch, "--single-branch", "--", config.repository, temporary],
    {
      ...options,
      env: gitEnvironment,
      exactValues,
      maximumBytes: 256 * 1024,
    },
  );
  if (clone.code !== 0) {
    await rm(temporary, { recursive: true, force: true });
    throw new SchedulerError(`isolated git clone failed: ${clone.stderr.slice(-1_000)}`, {
      code: "workspace_clone_failed",
    });
  }
  try {
    await rename(temporary, workspace);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
  }
  return workspace;
}

export async function prepareWorkspaceDependencies(config, state, workspace, options = {}) {
  const runDir = dirname(runStatePath(config, state.run_id));
  const dependencyHome = join(runDir, "dependency-home");
  const cacheDir = join(runDir, "npm-cache");
  await ensurePrivateDirectory(dependencyHome);
  await ensurePrivateDirectory(cacheDir);
  const lockfile = join(workspace, "package-lock.json");
  const lockMetadata = await pathKind(lockfile);
  if (!lockMetadata?.isFile() || lockMetadata.isSymbolicLink()) {
    throw new SchedulerError("the frozen checkout must contain a regular package-lock.json", {
      code: "dependency_lock_missing",
    });
  }
  const env = buildDependencyEnvironment(options.env ?? process.env, dependencyHome, cacheDir);
  const result = await runDirectCommand(
    "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier"],
    {
      cwd: workspace,
      env,
      maximumBytes: options.maximumBytes ?? 256 * 1024,
      timeoutMs: options.timeoutMs ?? 15 * 60 * 1_000,
      processGroup: true,
      spawn: options.spawn,
    },
  );
  if (result.code !== 0 || result.timedOut) {
    const tail = redactAutomationText((result.stderr || result.stdout).slice(-1_000));
    throw new SchedulerError(
      `secret-free npm ci failed: ${tail}`,
      { code: result.timedOut ? "dependency_install_timeout" : "dependency_install_failed" },
    );
  }
  return result;
}

export async function readSchedulerPrompt(config, state) {
  const metadata = await stat(config.promptPath);
  if (!metadata.isFile() || metadata.size > 128 * 1024) {
    throw new SchedulerError("scheduler prompt artifact is missing or unbounded", {
      code: "prompt_invalid",
    });
  }
  const base = await readFile(config.promptPath, "utf8");
  const context = {
    source: "customer_scheduler_trusted_context",
    project_id: config.project_id,
    automation_id: config.automation_id,
    run_id: state.run_id,
    case_id: state.case_id,
    case_revision: state.case_revision,
    repository: config.repository,
    default_branch: config.default_branch,
    runner_id: config.runnerId,
    api_base: config.apiBase,
    user_agent: SCHEDULER_USER_AGENT,
    operation_state_file_env: "AGENTRY_AUTOMATION_OPERATION_STATE_FILE",
    lease_token_env: "AGENTRY_AUTOMATION_LEASE_TOKEN",
    runner_key_env: "AGENTRY_RUNNER_API_KEY",
  };
  return `${base.trim()}\n\n## Trusted scheduler context\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n`;
}

export async function persistCodexLog(config, state, stdoutContent, stderrContent, metadata) {
  const runDir = dirname(runStatePath(config, state.run_id));
  const logsDir = join(runDir, "logs");
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  await atomicWrite(join(logsDir, `${stamp}.codex.jsonl`), stdoutContent, 0o600);
  await atomicWrite(join(logsDir, `${stamp}.codex.stderr.log`), stderrContent, 0o600);
  await atomicWriteJson(join(logsDir, `${stamp}.metadata.json`), metadata);
}

export async function assertExecutable(executable, argv, options = {}) {
  const result = await runDirectCommand(executable, argv, {
    ...options,
    maximumBytes: 64 * 1024,
  });
  if (result.code !== 0) {
    throw new SchedulerError(`${executable} preflight failed: ${result.stderr.slice(-500)}`, {
      code: "executable_unavailable",
    });
  }
  return result.stdout.trim() || result.stderr.trim();
}
