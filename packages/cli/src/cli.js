import { createInterface } from "node:readline/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as nodeFs } from "node:fs";
import { homedir as nodeHomedir, platform as nodePlatform } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const CLI_VERSION = "0.1.1";
export const CLI_SCHEMA_VERSION = "agentry.cli.v1";
export const DEFAULT_API_URL = "https://api.agentry.sh";
export const POSTHOG_CONNECTION_STATES = Object.freeze([
  "detached",
  "active",
  "reauth_required",
]);
export const CLI_CHECKPOINT_KINDS = Object.freeze([
  "agent_task",
  "human_checkpoint",
  "external_action",
  "complete",
]);
const ONBOARDING_CONTRACT_VERSION = "3";
const ONBOARDING_STATUSES = Object.freeze([
  "planned",
  "approved",
  "proving",
  "verified",
]);
const ONBOARDING_ACTIONS = Object.freeze({
  planned: {
    id: "review_exact_plan",
    requiresHuman: true,
    suffix: "review",
  },
  approved: {
    id: "instrument_and_start_proof",
    requiresHuman: false,
    suffix: "proof",
  },
  proving: {
    id: "exercise_and_verify",
    requiresHuman: false,
    suffix: "verify",
  },
});
const ONBOARDING_PLAN_INPUT_MAX_BYTES = 512 * 1_024;
const ONBOARDING_PROOF_INPUT_MAX_BYTES = 4 * 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// This is intentionally the only client-side assumption about the canonical
// backend resource. Keeping it here makes contract drift obvious in tests.
export const POSTHOG_CONNECTION_CONTRACT = Object.freeze({
  path(projectId) {
    return `/v1/projects/${encodeURIComponent(projectId)}/posthog-connection`;
  },
  connect(region, posthogProjectId) {
    return {
      intent: "connect",
      region,
      ...(posthogProjectId ? { posthog_project_id: posthogProjectId } : {}),
    };
  },
  claim(authorizationId) {
    return {
      intent: "claim",
      authorization_id: authorizationId,
    };
  },
});

export const POSTHOG_AUTH_CONTRACT = Object.freeze({
  startPath: "/v1/auth/posthog",
  pollPath: "/v1/auth/posthog/poll",
  start(region, handoff) {
    return {
      region,
      client_name: "Agentry CLI",
      distribution_surface: "cli",
      handoff_redirect_uri: handoff.redirectUri,
      handoff_challenge: handoff.challenge,
    };
  },
  poll(pollToken, handoffTicket, handoffVerifier) {
    return {
      poll_token: pollToken,
      handoff_ticket: handoffTicket,
      handoff_verifier: handoffVerifier,
    };
  },
});

const SECRET_KEY = /^(?:api_key|access_token|refresh_token|poll_token|handoff_ticket|handoff_verifier|authorization_id|pending_posthog_authorization_id|client_secret|authorization|cookie|secret)$/i;
const AGENTRY_SECRET = /\bagentry_(?:sk|pk|server|ci|runner)_[A-Za-z0-9._-]+\b/gi;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const TOKEN_QUERY = /([?&](?:access_token|refresh_token|token)=)[^&#\s]+/gi;
const REGION_HOST_PATTERNS = Object.freeze([
  { region: "us", pattern: /https?:\/\/(?:us\.i\.|us\.|app\.)posthog\.com\b/i },
  { region: "eu", pattern: /https?:\/\/(?:eu\.i\.|eu\.)posthog\.com\b/i },
]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "tmp",
  "vendor",
]);
const SCANNED_EXTENSIONS = new Set([
  ".cjs", ".cts", ".env", ".go", ".html", ".java", ".js", ".json",
  ".jsx", ".kt", ".mjs", ".mts", ".php", ".py", ".rb", ".rs", ".swift",
  ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);

class CliError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.nextAction = options.nextAction ?? null;
    this.httpStatus = options.httpStatus ?? null;
    this.details = options.details ?? null;
  }
}

class ApiError extends CliError {
  constructor(status, body) {
    const apiError = body && typeof body === "object" && body.error && typeof body.error === "object"
      ? body.error
      : body;
    const code = stringValue(apiError?.code) ?? `http_${status}`;
    const message = stringValue(apiError?.message) ?? `Agentry API request failed with HTTP ${status}.`;
    const nextAction = stringValue(apiError?.next_action) ?? stringValue(body?.next_action);
    const details = apiError?.details && typeof apiError.details === "object"
      ? {
          ...apiError.details,
          ...(typeof apiError.retryable === "boolean" ? { retryable: apiError.retryable } : {}),
          ...(stringValue(apiError.request_id) ? { request_id: stringValue(apiError.request_id) } : {}),
        }
      : null;
    super(code, message, { httpStatus: status, nextAction, details });
    this.body = body;
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerValue(value) {
  return Number.isInteger(value) ? value : null;
}

function posthogProjectIdValue(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function projectNameValue(value) {
  const name = stringValue(value);
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new CliError(
      "invalid_project_name",
      "--create-project must be a non-empty project name of at most 100 characters without control characters.",
    );
  }
  return name;
}

function redactString(value) {
  return value
    .replace(AGENTRY_SECRET, "[REDACTED]")
    .replace(BEARER_SECRET, "Bearer [REDACTED]")
    .replace(TOKEN_QUERY, "$1[REDACTED]");
}

export function redactValue(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function normalizeApiUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("invalid_api_url", "Agentry API URL must be an absolute HTTP(S) URL.");
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new CliError("invalid_api_url", "Agentry API URL must be an HTTP(S) URL without embedded credentials.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])
    .has(url.hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new CliError(
      "invalid_api_url",
      "Agentry API URL must use HTTPS outside localhost.",
      {
        nextAction:
          "Use an https:// Agentry API URL. Plain HTTP is allowed only for a loopback development server.",
      },
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function parseFlagValue(argv, index, name) {
  const argument = argv[index];
  if (argument === name) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliError("missing_option_value", `${name} requires a value.`);
    }
    return { value, consumed: 2 };
  }
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) throw new CliError("missing_option_value", `${name} requires a value.`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseCliArgs(argv) {
  const options = {
    json: false,
    nonInteractive: false,
    projectId: null,
    posthogProjectId: null,
    region: null,
    apiUrl: null,
    createProjectName: null,
    checkpointFile: null,
    checkpointStdin: false,
    approvePlanSha256: null,
    verify: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length;) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      positionals.push("help");
      index += 1;
      continue;
    }
    if (argument === "--version" || argument === "-V") {
      positionals.push("version");
      index += 1;
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      index += 1;
      continue;
    }
    if (argument === "--non-interactive") {
      options.nonInteractive = true;
      index += 1;
      continue;
    }
    if (argument === "--checkpoint-stdin") {
      options.checkpointStdin = true;
      index += 1;
      continue;
    }
    if (argument === "--verify") {
      options.verify = true;
      index += 1;
      continue;
    }
    const project = parseFlagValue(argv, index, "--project");
    if (project) {
      options.projectId = project.value;
      index += project.consumed;
      continue;
    }
    const posthogProject = parseFlagValue(argv, index, "--posthog-project");
    if (posthogProject) {
      options.posthogProjectId = posthogProjectIdValue(posthogProject.value);
      if (!options.posthogProjectId) {
        throw new CliError("invalid_posthog_project_id", "--posthog-project must be a positive numeric PostHog environment ID.");
      }
      index += posthogProject.consumed;
      continue;
    }
    const region = parseFlagValue(argv, index, "--region");
    if (region) {
      if (!new Set(["us", "eu"]).has(region.value)) {
        throw new CliError("invalid_posthog_region", "--region must be either us or eu.");
      }
      options.region = region.value;
      index += region.consumed;
      continue;
    }
    const apiUrl = parseFlagValue(argv, index, "--api-url");
    if (apiUrl) {
      options.apiUrl = apiUrl.value;
      index += apiUrl.consumed;
      continue;
    }
    const createProject = parseFlagValue(argv, index, "--create-project");
    if (createProject) {
      options.createProjectName = projectNameValue(createProject.value);
      index += createProject.consumed;
      continue;
    }
    const checkpointFile = parseFlagValue(argv, index, "--checkpoint-file");
    if (checkpointFile) {
      options.checkpointFile = checkpointFile.value;
      index += checkpointFile.consumed;
      continue;
    }
    const approvePlan = parseFlagValue(argv, index, "--approve-plan");
    if (approvePlan) {
      if (!SHA256_PATTERN.test(approvePlan.value)) {
        throw new CliError("invalid_plan_sha256", "--approve-plan must be the exact lowercase plan SHA-256.");
      }
      options.approvePlanSha256 = approvePlan.value;
      index += approvePlan.consumed;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new CliError("unknown_option", `Unknown option: ${argument}`);
    }
    positionals.push(argument);
    index += 1;
  }

  const command = positionals.join(" ");
  if (!new Set(["", "help", "login", "status", "connect posthog", "onboard", "version"]).has(command)) {
    throw new CliError("unknown_command", `Unknown command: ${command || "(none)"}`);
  }
  const onboardingOnlyOption = options.createProjectName
    || options.checkpointFile
    || options.checkpointStdin
    || options.approvePlanSha256
    || options.verify;
  if (onboardingOnlyOption && command !== "onboard") {
    throw new CliError("onboarding_option_without_onboard", "Project creation and checkpoint actuation options require the onboard command.");
  }
  if (options.projectId && options.createProjectName) {
    throw new CliError("ambiguous_project_selection", "--project and --create-project cannot be used together.");
  }
  if (options.checkpointFile && options.checkpointStdin) {
    throw new CliError("ambiguous_checkpoint_input", "Use exactly one of --checkpoint-file or --checkpoint-stdin.");
  }
  if (options.verify && (options.checkpointFile || options.checkpointStdin || options.approvePlanSha256)) {
    throw new CliError("ambiguous_onboarding_action", "--verify cannot be combined with checkpoint input or --approve-plan.");
  }
  // JSON mode is the agent/chat interface and must never prompt or wait in the
  // foreground. --non-interactive remains accepted as an explicit assertion.
  if (options.json) options.nonInteractive = true;
  return { command: command || "help", options };
}

function credentialPath(env, homedir) {
  return stringValue(env.AGENTRY_CREDENTIALS) ?? join(homedir, ".agentry", "credentials.json");
}

export function createCredentialStore({ fs = nodeFs, env = process.env, homedir = nodeHomedir() } = {}) {
  const path = credentialPath(env, homedir);

  async function load() {
    let raw;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw new CliError("credentials_read_failed", `Could not read ${path}.`, {
        nextAction: "Fix the credentials file permissions or set AGENTRY_CREDENTIALS to a readable path.",
      });
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      throw new CliError("credentials_invalid", `Credentials at ${path} are not valid JSON.`, {
        nextAction: "Move the invalid file aside, then run agentry login again.",
      });
    }
  }

  async function save(value) {
    const directory = dirname(path);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => {});
    const temporary = join(directory, `.credentials.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.chmod(0o600).catch(() => {});
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, path);
      await fs.chmod(path, 0o600).catch(() => {});
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
      throw new CliError("credentials_write_failed", `Could not securely write ${path}.`, {
        nextAction: "Check that the credentials directory is writable, then retry.",
        details: { cause: error?.code ?? "unknown" },
      });
    }
  }

  return { path, load, save };
}

function commandResume(command, options, extra = []) {
  const args = command.split(" ");
  if (options.projectId) args.push("--project", options.projectId);
  if (options.createProjectName) args.push("--create-project", options.createProjectName);
  if (options.region) args.push("--region", options.region);
  if (options.posthogProjectId) args.push("--posthog-project", String(options.posthogProjectId));
  if (options.apiUrl) args.push("--api-url", options.apiUrl);
  if (options.checkpointFile) args.push("--checkpoint-file", options.checkpointFile);
  if (options.checkpointStdin) args.push("--checkpoint-stdin");
  if (options.approvePlanSha256) args.push("--approve-plan", options.approvePlanSha256);
  if (options.verify) args.push("--verify");
  args.push(...extra, "--json", "--non-interactive");
  return { command: "agentry", arguments: args };
}

function clearOnboardingActionOptions(options) {
  return {
    ...options,
    createProjectName: null,
    checkpointFile: null,
    checkpointStdin: false,
    approvePlanSha256: null,
    verify: false,
  };
}

function checkpoint(id, instruction, options = {}) {
  const requiresHuman = options.requiresHuman ?? false;
  const kind = options.kind ?? (requiresHuman ? "human_checkpoint" : "agent_task");
  if (!CLI_CHECKPOINT_KINDS.includes(kind)) {
    throw new CliError("invalid_checkpoint_kind", `Unknown CLI checkpoint kind: ${kind}.`);
  }
  return {
    id,
    kind,
    instruction,
    requires_human: requiresHuman,
    project_id: options.projectId ?? null,
    url: options.url ?? null,
    choices: options.choices ?? null,
    retry_after_seconds: options.retryAfterSeconds ?? null,
    expires_at: options.expiresAt ?? null,
    resume: options.resume ?? null,
  };
}

function envelope(command, status, { checkpoint: nextCheckpoint = null, result = null, error = null } = {}) {
  return redactValue({
    schema_version: CLI_SCHEMA_VERSION,
    command,
    status,
    checkpoint: nextCheckpoint,
    result,
    error,
  });
}

function errorEnvelope(command, error) {
  const normalized = error instanceof CliError
    ? error
    : new CliError("unexpected_error", error instanceof Error ? error.message : "Unexpected CLI failure.");
  return envelope(command, "failed", {
    error: {
      code: normalized.code,
      message: normalized.message,
      next_action: normalized.nextAction,
      http_status: normalized.httpStatus,
      details: normalized.details,
    },
  });
}

async function apiRequest(context, method, path, {
  body,
  allowError = false,
  requestHeaders = {},
} = {}) {
  const headers = {
    accept: "application/json",
    "user-agent": `@agentrysh/cli/${CLI_VERSION}`,
  };
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (typeof value === "string" && value) headers[name.toLowerCase()] = value;
  }
  if (context.apiKey) headers.authorization = `Bearer ${context.apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  let response;
  try {
    response = await context.fetch(`${context.apiUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new CliError("network_error", `Could not reach Agentry at ${context.apiUrl}.`, {
      nextAction: "Check the network and AGENTRY_URL, then retry the same command.",
      details: { cause: error?.name ?? "network failure" },
    });
  }

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliError("invalid_api_response", `Agentry returned non-JSON data with HTTP ${response.status}.`, {
        httpStatus: response.status,
        nextAction: "Retry once; if this persists, verify AGENTRY_URL points to the Agentry API.",
      });
    }
  }
  if (!response.ok && !allowError) throw new ApiError(response.status, parsed);
  return { ok: response.ok, status: response.status, body: parsed, headers: response.headers };
}

async function loadExecutionContext(options, dependencies) {
  const env = dependencies.env ?? process.env;
  const store = dependencies.credentialStore ?? createCredentialStore({
    fs: dependencies.fs ?? nodeFs,
    env,
    homedir: dependencies.homedir ?? nodeHomedir(),
  });
  let credentials = await store.load();
  const environmentKey = stringValue(env.AGENTRY_PRIVATE_API_KEY);
  const fileKey = stringValue(credentials.api_key);
  const apiKey = environmentKey ?? fileKey;
  if (apiKey && !apiKey.startsWith("agentry_sk_")) {
    throw new CliError("invalid_private_api_key", "The configured owner credential is not an AGENTRY_PRIVATE_API_KEY.", {
      nextAction: "Use an agentry_sk_ owner key or run agentry login to sign in with PostHog.",
    });
  }
  const apiUrl = normalizeApiUrl(
    options.apiUrl
      ?? stringValue(env.AGENTRY_URL)
      ?? stringValue(credentials.api_url)
      ?? DEFAULT_API_URL,
  );
  return {
    ...dependencies,
    env,
    store,
    credentials,
    apiKey,
    credentialSource: environmentKey ? "environment" : fileKey ? "credentials_file" : null,
    apiUrl,
    fetch: dependencies.fetch ?? globalThis.fetch,
    fs: dependencies.fs ?? nodeFs,
    cwd: dependencies.cwd ?? process.cwd(),
    now: dependencies.now ?? (() => Date.now()),
    sleep: dependencies.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))),
    report: dependencies.report ?? (() => {}),
    choose: dependencies.choose ?? null,
    input: dependencies.input ?? process.stdin,
    output: dependencies.output ?? process.stderr,
  };
}

async function saveCredentials(context, nextCredentials) {
  await context.store.save(nextCredentials);
  context.credentials = nextCredentials;
  context.apiKey = stringValue(context.env.AGENTRY_PRIVATE_API_KEY) ?? stringValue(nextCredentials.api_key);
  context.credentialSource = stringValue(context.env.AGENTRY_PRIVATE_API_KEY)
    ? "environment"
    : stringValue(nextCredentials.api_key)
      ? "credentials_file"
      : null;
}

function posthogHandoffChallenge(verifier) {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

async function startPosthogLoopback(context) {
  if (typeof context.startPosthogLoopback === "function") {
    return await context.startPosthogLoopback();
  }
  const verifier = randomBytes(32).toString("base64url");
  const challenge = posthogHandoffChallenge(verifier);
  const callbackPath = `/agentry/posthog/callback/${randomBytes(16).toString("base64url")}`;
  let settle;
  const callback = new Promise((resolveCallback) => { settle = resolveCallback; });
  let settled = false;
  const server = createServer((request, response) => {
    const host = request.headers.host;
    const address = server.address();
    const expectedHost = typeof address === "object" && address ? `127.0.0.1:${address.port}` : null;
    if (request.method !== "GET" || !host || host !== expectedHost) {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== callbackPath || settled) {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    const ticket = stringValue(url.searchParams.get("ticket"));
    const error = stringValue(url.searchParams.get("error"));
    if ((!ticket || !/^agentry_handoff_[A-Za-z0-9_-]{43}$/.test(ticket)) && !error) {
      response.writeHead(400, { "cache-control": "no-store" }).end("Invalid Agentry callback.");
      return;
    }
    settled = true;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    }).end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Agentry sign-in complete</title><main><h1>Agentry sign-in complete</h1><p>You can close this tab and return to the terminal.</p></main></html>");
    settle(error ? { error } : { ticket });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new CliError("posthog_loopback_unavailable", "Could not create the local PostHog sign-in callback.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    challenge,
    verifier,
    async wait(expiresInSeconds) {
      let timeout;
      try {
        return await Promise.race([
          callback,
          new Promise((resolveTimeout) => {
            timeout = setTimeout(
              () => resolveTimeout({ error: "posthog_authorization_expired" }),
              Math.max(1, expiresInSeconds) * 1_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    async close() {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

async function openPosthogAuthorization(context, authorizationUrl) {
  if (typeof context.openBrowser === "function") {
    return await context.openBrowser(authorizationUrl);
  }
  const platform = nodePlatform();
  const command = platform === "darwin"
    ? ["open", [authorizationUrl]]
    : platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", authorizationUrl]]
      : ["xdg-open", [authorizationUrl]];
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function beginPosthogLogin(context, options, command) {
  const resolved = await resolvePosthogRegion(context, options, null, command);
  if (resolved.response) return resolved;
  const handoff = await startPosthogLoopback(context);
  try {
    const response = await apiRequest(context, "POST", POSTHOG_AUTH_CONTRACT.startPath, {
      body: POSTHOG_AUTH_CONTRACT.start(resolved.region, handoff),
    });
    const body = response.body;
    const pollToken = stringValue(body?.poll_token);
    const authorizationUrl = stringValue(body?.authorization_url);
    const expiresIn = integerValue(body?.expires_in);
    if (!pollToken || !authorizationUrl || !expiresIn || expiresIn < 1) {
      throw new CliError("invalid_posthog_authorization", "Agentry returned an incomplete PostHog sign-in response.", {
        nextAction: "Retry agentry login; if this persists, inspect the live PostHog auth OpenAPI contract.",
      });
    }
    return {
      pending: {
        poll_token: pollToken,
        authorization_url: authorizationUrl,
        expires_in: expiresIn,
        region: resolved.region,
      },
      handoff,
    };
  } catch (error) {
    await handoff.close().catch(() => {});
    throw error;
  }
}

async function finishPosthogLogin(context, pending, handoff) {
  const callback = await handoff.wait(pending.expires_in);
  if (callback.error) {
    throw new CliError(callback.error, "PostHog sign-in did not complete.", {
      nextAction: "Run agentry login again and approve the fresh PostHog authorization.",
    });
  }
  const response = await apiRequest(context, "POST", POSTHOG_AUTH_CONTRACT.pollPath, {
    body: POSTHOG_AUTH_CONTRACT.poll(
      pending.poll_token,
      callback.ticket,
      handoff.verifier,
    ),
    allowError: true,
  });
  if (response.body?.status === "ok") return completePosthogLogin(context, response.body);
  if (!response.ok) throw new ApiError(response.status, response.body);
  throw new CliError("invalid_posthog_authorization", "Agentry returned an unexpected PostHog sign-in state.");
}

async function completePosthogLogin(context, body, command = "login") {
  const apiKey = stringValue(body?.api_key);
  const authorizationId = stringValue(body?.authorization_id);
  const userId = stringValue(body?.user?.id);
  const userEmail = stringValue(body?.user?.email);
  if (!apiKey?.startsWith("agentry_sk_") || !authorizationId || !userId) {
    throw new CliError(
      "invalid_posthog_authorization",
      "Agentry completed PostHog sign-in without returning an owner key and claimable authorization.",
    );
  }
  const { pending_posthog_auth: _pending, ...existing } = context.credentials;
  await saveCredentials(context, {
    ...existing,
    schema_version: 1,
    api_url: context.apiUrl,
    api_key: apiKey,
    pending_posthog_authorization_id: authorizationId,
    user: {
      id: userId,
      ...(userEmail ? { email: userEmail } : {}),
    },
  });
  return envelope(command, "completed", {
    result: {
      authenticated: true,
      credential_source: "credentials_file",
      credential_path: context.store.path,
      posthog_authorization_pending_claim: true,
      user: context.credentials.user,
    },
  });
}

async function loginCommand(context, options, command = "login") {
  if (context.apiKey) {
    return envelope("login", "completed", {
      result: {
        authenticated: true,
        credential_source: context.credentialSource,
        credential_path: context.credentialSource === "credentials_file" ? context.store.path : null,
        posthog_authorization_pending_claim: Boolean(stringValue(context.credentials.pending_posthog_authorization_id)),
      },
    });
  }

  if (options.nonInteractive) {
    const resolved = await resolvePosthogRegion(context, options, null, command);
    if (resolved.response) {
      return command === "login"
        ? resolved.response
        : { ...resolved.response, command };
    }
    return posthogLoginCheckpoint(options, command);
  }

  const started = await beginPosthogLogin(context, options, command);
  if (started.response) {
    return command === "login"
      ? started.response
      : { ...started.response, command };
  }
  const { pending, handoff } = started;
  try {
    const opened = await openPosthogAuthorization(context, pending.authorization_url);
    context.report(opened
      ? "PostHog sign-in opened in your browser. Approve read-only access once; this terminal will finish automatically."
      : `Open this URL to sign in with PostHog:\n${pending.authorization_url}`);
    return await finishPosthogLogin(context, pending, handoff);
  } finally {
    await handoff.close().catch(() => {});
  }
}

function posthogLoginCheckpoint(options, command) {
  return envelope(command, "action_required", {
    checkpoint: checkpoint(
      "sign_in_with_posthog",
      "Run `agentry login` in an interactive terminal. It opens PostHog, accepts one read-only approval, and returns to the same terminal automatically; then rerun the resume command.",
      {
        requiresHuman: true,
        kind: "human_checkpoint",
        resume: commandResume(command, options),
      },
    ),
    result: { authenticated: false },
  });
}

async function listProjects(context) {
  const response = await apiRequest(context, "GET", "/v1/projects");
  const projects = Array.isArray(response.body?.projects) ? response.body.projects : [];
  return projects
    .filter((project) => stringValue(project?.id))
    .map((project) => ({
      id: project.id,
      name: stringValue(project.name) ?? project.id,
      role: stringValue(project.role),
      repo_url: stringValue(project.repo_url),
      local_path: stringValue(project.local_path),
    }));
}

async function persistProjectSelection(context, projectId) {
  if (context.credentials.project_id === projectId) return;
  await saveCredentials(context, { ...context.credentials, project_id: projectId });
}

function repositoryProjectName(cwd) {
  return projectNameValue(basename(resolve(cwd)) || "agentry-project");
}

async function createRepositoryProject(context, name) {
  const pending = context.credentials.pending_project_create;
  let idempotencyKey;
  if (pending !== undefined) {
    if (
      !pending
      || typeof pending !== "object"
      || pending.api_url !== context.apiUrl
      || pending.name !== name
      || !stringValue(pending.idempotency_key)
    ) {
      throw new CliError(
        "project_creation_pending_mismatch",
        "A different project creation is already pending in the secure CLI state.",
        {
          nextAction: "Retry the exact original --create-project name, or inspect and remove the stale pending_project_create entry outside the repository.",
        },
      );
    }
    idempotencyKey = pending.idempotency_key;
  } else {
    idempotencyKey = `agentry-cli-project-${randomBytes(16).toString("hex")}`;
    await saveCredentials(context, {
      ...context.credentials,
      pending_project_create: {
        api_url: context.apiUrl,
        name,
        idempotency_key: idempotencyKey,
      },
    });
  }

  const response = await apiRequest(context, "POST", "/v1/projects", {
    body: { name },
    requestHeaders: { "idempotency-key": idempotencyKey },
  });
  const id = stringValue(response.body?.id);
  const returnedName = stringValue(response.body?.name);
  if (
    !id
    || returnedName !== name
    || response.body?.role !== "owner"
    || !stringValue(response.body?.command_id)
    || typeof response.body?.idempotent_replay !== "boolean"
  ) {
    throw new CliError("invalid_project_create_response", "Agentry returned an invalid project creation response.", {
      nextAction: "Retry with the same --create-project value so the saved Idempotency-Key recovers the exact result.",
    });
  }
  const { pending_project_create: _pending, ...credentials } = context.credentials;
  await saveCredentials(context, { ...credentials, project_id: id });
  return {
    id,
    name: returnedName,
    role: "owner",
    repo_url: null,
    local_path: null,
  };
}

async function chooseItem(context, instruction, choices) {
  if (context.choose) return context.choose({ instruction, choices });
  const interface_ = createInterface({ input: context.input, output: context.output });
  try {
    context.output.write(`${instruction}\n`);
    choices.forEach((choice, index) => context.output.write(`  ${index + 1}) ${choice.label}\n`));
    const answer = await interface_.question("Selection: ");
    const selected = Number.parseInt(answer, 10);
    return Number.isInteger(selected) && selected >= 1 && selected <= choices.length
      ? choices[selected - 1].value
      : null;
  } finally {
    interface_.close();
  }
}

async function resolveProject(context, options, command, projects = null) {
  const available = projects ?? await listProjects(context);
  if (options.createProjectName && context.credentials.pending_project_create !== undefined) {
    return {
      project: await createRepositoryProject(context, options.createProjectName),
      created: true,
    };
  }
  if (options.createProjectName && available.length > 0) {
    throw new CliError(
      "project_creation_not_applicable",
      "--create-project is allowed only when this account has no Agentry projects.",
      { nextAction: "Select an existing project with --project, without --create-project." },
    );
  }
  const requested = options.projectId
    ?? stringValue(context.env.AGENTRY_PROJECT_ID)
    ?? stringValue(context.credentials.project_id);
  if (requested) {
    const project = available.find((candidate) => candidate.id === requested);
    if (!project) {
      throw new CliError("project_not_accessible", `Project ${requested} is not accessible with this owner credential.`, {
        nextAction: "Run agentry status and choose one of the returned project IDs.",
      });
    }
    await persistProjectSelection(context, project.id);
    return { project };
  }
  if (available.length === 0) {
    const suggestedName = repositoryProjectName(context.cwd);
    let createName = options.createProjectName;
    if (!createName && command === "onboard" && !options.nonInteractive) {
      const decision = await chooseItem(
        context,
        `No Agentry project exists. Create ${suggestedName} for this repository?`,
        [
          { value: "create", label: `Create ${suggestedName}` },
          { value: "stop", label: "Stop without creating" },
        ],
      );
      if (decision === "create") createName = suggestedName;
    }
    if (createName) {
      return { project: await createRepositoryProject(context, createName), created: true };
    }
    return {
      response: envelope(command, "action_required", {
        checkpoint: checkpoint(
          "create_agentry_project",
          `Create an Agentry project for this repository by rerunning with --create-project ${JSON.stringify(suggestedName)}.`,
          {
            requiresHuman: false,
            resume: commandResume(command, options),
          },
        ),
        result: { projects: [], suggested_project_name: suggestedName },
      }),
    };
  }
  if (available.length === 1) {
    await persistProjectSelection(context, available[0].id);
    return { project: available[0] };
  }
  const localMatches = available.filter((project) => {
    if (!project.local_path) return false;
    try {
      return resolve(project.local_path) === resolve(context.cwd);
    } catch {
      return false;
    }
  });
  if (localMatches.length === 1) {
    await persistProjectSelection(context, localMatches[0].id);
    return { project: localMatches[0] };
  }
  const choices = available.map((project) => ({ value: project.id, label: `${project.name} (${project.id})` }));
  if (options.nonInteractive) {
    return {
      response: envelope(command, "action_required", {
        checkpoint: checkpoint(
          "select_agentry_project",
          "Choose an Agentry project and rerun with --project <id>.",
          { requiresHuman: true, choices, resume: commandResume(command, options) },
        ),
        result: { projects: available },
      }),
    };
  }
  const selected = await chooseItem(context, "Choose the Agentry project for this repository:", choices);
  if (!selected) {
    throw new CliError("project_selection_invalid", "No valid Agentry project was selected.", {
      nextAction: "Rerun with --project <id>.",
    });
  }
  const project = available.find((candidate) => candidate.id === selected);
  await persistProjectSelection(context, project.id);
  return { project };
}

export function normalizePosthogConnection(body) {
  const source = body?.connection && typeof body.connection === "object" ? body.connection : body;
  const status = stringValue(source?.status);
  if (!POSTHOG_CONNECTION_STATES.includes(status)) {
    throw new CliError("invalid_posthog_connection_response", "Agentry returned an unknown PostHog connection state.", {
      nextAction: "Compare the CLI connection contract with the live PostHog connection OpenAPI operation.",
      details: { received_status: status },
    });
  }
  return {
    status,
    region: new Set(["us", "eu"]).has(source.region) ? source.region : null,
    posthog_host: stringValue(source.posthog_host),
    posthog_project_id: posthogProjectIdValue(source.posthog_project_id),
    organization_id: stringValue(source.organization_id),
    scopes: Array.isArray(source.scopes) ? source.scopes.filter((scope) => typeof scope === "string") : [],
    connected_at: integerValue(source.connected_at),
    last_verified_at: integerValue(source.last_verified_at),
    capabilities: source.capabilities && typeof source.capabilities === "object" && !Array.isArray(source.capabilities)
      ? source.capabilities
      : null,
    authorization_url: stringValue(body?.authorization_url) ?? stringValue(source.authorization_url),
    poll_interval_seconds: integerValue(body?.poll_interval_seconds) ?? integerValue(source.poll_interval_seconds) ?? 3,
    expires_at: integerValue(body?.expires_at) ?? integerValue(source.expires_at),
    next_action: stringValue(body?.next_action) ?? stringValue(source.next_action),
  };
}

async function readPosthogConnection(context, projectId) {
  const response = await apiRequest(
    context,
    "GET",
    POSTHOG_CONNECTION_CONTRACT.path(projectId),
    { allowError: true },
  );
  if (response.status === 404) {
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
      authorization_url: null,
      poll_interval_seconds: 3,
      expires_at: null,
      next_action: null,
    };
  }
  if (!response.ok) throw new ApiError(response.status, response.body);
  return normalizePosthogConnection(response.body);
}

function regionFromText(text) {
  const matches = new Set();
  for (const { region, pattern } of REGION_HOST_PATTERNS) {
    if (pattern.test(text)) matches.add(region);
  }
  return matches;
}

function shouldScanFile(name) {
  return name.startsWith(".env") || SCANNED_EXTENSIONS.has(extname(name).toLowerCase());
}

export async function discoverPosthogRegion({ cwd = process.cwd(), fs = nodeFs, env = process.env } = {}) {
  const regions = new Set();
  const sources = [];
  const environmentValues = [
    env.POSTHOG_HOST,
    env.NEXT_PUBLIC_POSTHOG_HOST,
    env.PUBLIC_POSTHOG_HOST,
    env.VITE_POSTHOG_HOST,
  ].filter((value) => typeof value === "string");
  for (const value of environmentValues) {
    for (const region of regionFromText(value)) regions.add(region);
  }
  if (regions.size === 1) return { region: [...regions][0], source: "environment", ambiguous: false };
  if (regions.size > 1) return { region: null, source: "environment", ambiguous: true };

  const root = resolve(cwd);
  const queue = [root];
  let scanned = 0;
  while (queue.length && scanned < 3_000) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile() || !shouldScanFile(entry.name) || scanned >= 3_000) continue;
      scanned += 1;
      try {
        const stats = await fs.stat(absolute);
        if (stats.size > 512_000) continue;
        const text = await fs.readFile(absolute, "utf8");
        for (const region of regionFromText(text)) {
          regions.add(region);
          sources.push(relative(root, absolute));
        }
      } catch {
        // Discovery is best effort; unreadable and binary-looking files do not
        // block an explicit --region selection.
      }
    }
  }
  return {
    region: regions.size === 1 ? [...regions][0] : null,
    source: regions.size ? "repository" : null,
    ambiguous: regions.size > 1,
    matched_files: [...new Set(sources)].slice(0, 20),
  };
}

async function resolvePosthogRegion(context, options, projectId, command, connectionRegion = null) {
  if (options.region) return { region: options.region, source: "option" };
  if (new Set(["us", "eu"]).has(connectionRegion)) {
    return { region: connectionRegion, source: "connection" };
  }
  const discovered = await discoverPosthogRegion({ cwd: context.cwd, fs: context.fs, env: context.env });
  if (discovered.region) return discovered;
  const choices = [
    { value: "us", label: "PostHog US Cloud" },
    { value: "eu", label: "PostHog EU Cloud" },
  ];
  if (options.nonInteractive) {
    return {
      response: envelope(command, "action_required", {
        checkpoint: checkpoint(
          "select_posthog_region",
          discovered.ambiguous
            ? "Conflicting PostHog Cloud hosts were found. Confirm the intended region and rerun with --region us|eu."
            : "No PostHog Cloud host was found. Choose the region and rerun with --region us|eu.",
          {
            requiresHuman: true,
            projectId,
            choices,
            resume: commandResume(command, options),
          },
        ),
        result: {
          detected_region: null,
          detection_source: discovered.source,
          matched_files: discovered.matched_files ?? [],
        },
      }),
    };
  }
  const region = await chooseItem(context, "Choose the PostHog Cloud region:", choices);
  if (!region) {
    throw new CliError("posthog_region_selection_invalid", "No valid PostHog region was selected.", {
      nextAction: "Rerun with --region us or --region eu.",
    });
  }
  return { region, source: "human" };
}

function publicConnection(connection) {
  return {
    status: connection.status,
    region: connection.region,
    posthog_host: connection.posthog_host,
    posthog_project_id: connection.posthog_project_id,
    organization_id: connection.organization_id,
    scopes: connection.scopes,
    connected_at: connection.connected_at,
    last_verified_at: connection.last_verified_at,
    capabilities: connection.capabilities,
    next_action: connection.next_action,
  };
}

async function claimPendingPosthogAuthorization(context, projectId) {
  const authorizationId = stringValue(context.credentials.pending_posthog_authorization_id);
  if (!authorizationId) return null;
  const response = await apiRequest(
    context,
    "POST",
    POSTHOG_CONNECTION_CONTRACT.path(projectId),
    { body: POSTHOG_CONNECTION_CONTRACT.claim(authorizationId) },
  );
  const connection = normalizePosthogConnection(response.body);
  if (connection.status !== "active") {
    throw new CliError(
      "posthog_authorization_claim_incomplete",
      "Agentry accepted the PostHog authorization claim without returning an active connection.",
      { nextAction: "Keep the saved authorization pending and inspect the live PostHog connection contract before retrying." },
    );
  }
  const { pending_posthog_authorization_id: _claimed, ...credentials } = context.credentials;
  await saveCredentials(context, { ...credentials, project_id: projectId });
  return connection;
}

function posthogAuthorizationCheckpoint(command, options, projectId, connection) {
  return envelope(command, "action_required", {
    checkpoint: checkpoint(
      connection.status === "reauth_required" ? "reauthorize_posthog" : "authorize_posthog",
      "Open the PostHog authorization URL, approve the requested access, then rerun the resume command.",
      {
        requiresHuman: true,
        kind: "human_checkpoint",
        projectId,
        url: connection.authorization_url,
        retryAfterSeconds: connection.poll_interval_seconds,
        expiresAt: connection.expires_at,
        resume: commandResume(command, options),
      },
    ),
    result: { posthog_connection: publicConnection(connection) },
  });
}

async function initiatePosthogConnection(context, options, projectId, command, connectionRegion = null) {
  const region = await resolvePosthogRegion(context, options, projectId, command, connectionRegion);
  if (region.response) return region;
  const response = await apiRequest(
    context,
    "POST",
    POSTHOG_CONNECTION_CONTRACT.path(projectId),
    { body: POSTHOG_CONNECTION_CONTRACT.connect(region.region, options.posthogProjectId) },
  );
  return { connection: normalizePosthogConnection(response.body), detectedRegion: region };
}

async function ensurePosthogConnection(context, options, projectId, command) {
  const claimed = await claimPendingPosthogAuthorization(context, projectId);
  if (claimed) return { connection: claimed };
  let connection = await readPosthogConnection(context, projectId);
  if (connection.status === "active") return { connection };

  if (new Set(["detached", "reauth_required"]).has(connection.status) && !connection.authorization_url) {
    const initiated = await initiatePosthogConnection(context, options, projectId, command, connection.region);
    if (initiated.response) return initiated;
    connection = initiated.connection;
    if (connection.status === "active") return { connection };
  }

  if (!connection.authorization_url) {
    throw new CliError("posthog_authorization_url_missing", "PostHog authorization is required but Agentry returned no authorization URL.", {
      nextAction: connection.next_action ?? "Retry the connection and inspect the live PostHog connection contract.",
    });
  }
  if (options.nonInteractive) {
    return { response: posthogAuthorizationCheckpoint(command, options, projectId, connection) };
  }

  context.report(`Open this URL to authorize PostHog:\n${connection.authorization_url}`);
  const deadline = connection.expires_at ?? Math.floor(context.now() / 1000) + 600;
  const pollInterval = Math.max(1, connection.poll_interval_seconds);
  while (Math.floor(context.now() / 1000) < deadline) {
    await context.sleep(pollInterval * 1_000);
    connection = await readPosthogConnection(context, projectId);
    if (connection.status === "active") return { connection };
    if (connection.status === "reauth_required") break;
  }
  return { response: posthogAuthorizationCheckpoint(command, options, projectId, connection) };
}

async function requireAuthentication(context, options, command, { interactiveLogin = false } = {}) {
  if (context.apiKey) return null;
  if (interactiveLogin) {
    const login = await loginCommand(context, options);
    if (login.status === "completed") return null;
    return login;
  }
  return envelope(command, "action_required", {
    checkpoint: checkpoint(
      "login_required",
      "Run agentry login to sign in with PostHog, then rerun this command.",
      { requiresHuman: true, resume: commandResume(command, options) },
    ),
    result: { authenticated: false },
  });
}

async function statusCommand(context, options) {
  const unauthenticated = await requireAuthentication(context, options, "status");
  if (unauthenticated) return unauthenticated;
  let projects = await listProjects(context);
  if (options.projectId) {
    const resolved = await resolveProject(context, options, "status", projects);
    if (resolved.response) return resolved.response;
    projects = [resolved.project];
  }
  const withConnections = await Promise.all(projects.map(async (project) => ({
    ...project,
    posthog_connection: publicConnection(await readPosthogConnection(context, project.id)),
    onboarding: await readOnboardingState(context, project.id),
  })));
  if (!withConnections.length) {
    return envelope("status", "action_required", {
      checkpoint: checkpoint(
        "create_agentry_project",
        "Create an Agentry project for this repository before connecting PostHog.",
        { requiresHuman: false },
      ),
      result: {
        authenticated: true,
        credential_source: context.credentialSource,
        api_url: context.apiUrl,
        projects: [],
      },
    });
  }
  return envelope("status", "completed", {
    result: {
      authenticated: true,
      credential_source: context.credentialSource,
      api_url: context.apiUrl,
      projects: withConnections,
    },
  });
}

async function connectPosthogCommand(context, options) {
  const command = "connect posthog";
  const unauthenticated = await requireAuthentication(context, options, command);
  if (unauthenticated) return unauthenticated;
  const resolved = await resolveProject(context, options, command);
  if (resolved.response) return resolved.response;
  const project = resolved.project;
  const ensured = await ensurePosthogConnection(context, options, project.id, command);
  if (ensured.response) return ensured.response;
  return envelope(command, "completed", {
    result: {
      project: { id: project.id, name: project.name },
      posthog_connection: publicConnection(ensured.connection),
    },
  });
}

function invalidOnboardingState(reason, details = null) {
  return new CliError(
    "invalid_onboarding_response",
    `Agentry returned onboarding state that does not match contract v${ONBOARDING_CONTRACT_VERSION}: ${reason}`,
    {
      nextAction: "Read the filtered onboarding OpenAPI contract and update the CLI before continuing.",
      details,
    },
  );
}

function normalizeOnboardingNextAction(action, status, projectId) {
  const expected = ONBOARDING_ACTIONS[status];
  if (!expected || !action || typeof action !== "object" || Array.isArray(action)) {
    throw invalidOnboardingState(`${status} state has no valid next_action.`);
  }
  const id = stringValue(action.id);
  const instruction = stringValue(action.instruction);
  const completionCondition = stringValue(action.completion_condition);
  const guideAnchor = stringValue(action.guide_anchor);
  const checklist = Array.isArray(action.checklist)
    ? action.checklist.filter((item) => typeof item === "string" && item.trim())
    : [];
  const operation = action.operation;
  const expectedPath = `/v1/projects/${projectId}/onboarding/${expected.suffix}`;
  if (
    id !== expected.id
    || !instruction
    || action.requires_human !== expected.requiresHuman
    || !operation
    || typeof operation !== "object"
    || Array.isArray(operation)
    || operation.method !== "POST"
    || operation.path !== expectedPath
    || checklist.length !== action.checklist?.length
    || !checklist.length
    || !completionCondition
    || !guideAnchor
  ) {
    throw invalidOnboardingState(`${status} next_action is not the canonical ${expected.id} action.`, {
      received_action_id: id,
    });
  }
  return {
    id,
    instruction,
    requires_human: action.requires_human,
    operation: { method: "POST", path: expectedPath },
    checklist,
    completion_condition: completionCondition,
    guide_anchor: guideAnchor,
  };
}

export function normalizeOnboardingState(state, projectId, etagHeader = null) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw invalidOnboardingState("response body is not an object.");
  }
  const contractVersion = stringValue(state.contract_version);
  const responseProjectId = stringValue(state.project_id);
  const onboardingId = stringValue(state.onboarding_id);
  const status = stringValue(state.status);
  const revision = integerValue(state.revision);
  const planSha256 = stringValue(state.plan_sha256);
  const updatedAt = integerValue(state.updated_at);
  const bodyEtag = stringValue(state.etag);
  const responseEtag = stringValue(etagHeader);
  const plan = state.plan;
  if (contractVersion !== ONBOARDING_CONTRACT_VERSION) {
    throw invalidOnboardingState("contract_version is missing or unsupported.", {
      received_contract_version: contractVersion,
    });
  }
  if (!responseProjectId || responseProjectId !== projectId) {
    throw invalidOnboardingState("project_id does not match the requested project.", {
      requested_project_id: projectId,
      received_project_id: responseProjectId,
    });
  }
  if (
    !onboardingId
    || !ONBOARDING_STATUSES.includes(status)
    || !revision
    || revision < 1
    || !planSha256
    || !/^[a-f0-9]{64}$/.test(planSha256)
    || updatedAt === null
    || updatedAt < 0
    || !bodyEtag
    || !/^"[A-Za-z0-9._:-]+"$/.test(bodyEtag)
    || !plan
    || typeof plan !== "object"
    || Array.isArray(plan)
  ) {
    throw invalidOnboardingState("required state identity or plan fields are invalid.", {
      received_status: status,
    });
  }
  if (responseEtag && responseEtag !== bodyEtag) {
    throw invalidOnboardingState("response ETag header does not match state.etag.");
  }
  const historical = stringValue(state.evidence_status?.historical);
  const source = stringValue(state.evidence_status?.source);
  if (!new Set(["not_established", "historically_observed"]).has(historical)) {
    throw invalidOnboardingState("evidence_status.historical is invalid.");
  }
  const planHasHistoricalEvidence = plan.historical_evidence !== null;
  if (
    planHasHistoricalEvidence !== (historical === "historically_observed")
  ) {
    throw invalidOnboardingState("historical evidence status does not match plan.historical_evidence.");
  }

  const verified = status === "verified";
  if (
    state.installation_complete !== verified
    || source !== (verified ? "source_verified" : "pending")
    || (verified && state.next_action !== null)
    || (verified && state.receipt?.evidence_status !== "source_verified")
    || (verified && state.proof_session?.status !== "satisfied")
  ) {
    throw invalidOnboardingState("completion and source evidence do not match status.", {
      received_status: status,
      received_source_evidence: source,
    });
  }
  if (
    (status === "approved" && (integerValue(state.approved_at) === null || state.approved_at < 0))
    || (status === "proving" && (
      !state.implementation_source_snapshot
      || typeof state.implementation_source_snapshot !== "object"
      || state.proof_session?.status !== "open"
    ))
    || (verified && (
      !state.implementation_source_snapshot
      || typeof state.implementation_source_snapshot !== "object"
    ))
  ) {
    throw invalidOnboardingState(`${status} state is missing its status-specific evidence.`);
  }

  const normalized = {
    contract_version: contractVersion,
    project_id: responseProjectId,
    onboarding_id: onboardingId,
    revision,
    status,
    plan_sha256: planSha256,
    updated_at: updatedAt,
    evidence_status: { historical, source },
    etag: bodyEtag,
    installation_complete: state.installation_complete,
    next_action: verified
      ? null
      : normalizeOnboardingNextAction(state.next_action, status, responseProjectId),
    plan,
  };
  for (const field of [
    "approved_at",
    "implementation_source_snapshot",
    "proof_session",
    "receipt",
  ]) {
    if (state[field] !== undefined) normalized[field] = state[field];
  }
  return normalized;
}

async function readOnboardingState(context, projectId) {
  const response = await apiRequest(
    context,
    "GET",
    `/v1/projects/${encodeURIComponent(projectId)}/onboarding`,
    { allowError: true },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status, response.body);
  return normalizeOnboardingState(
    response.body,
    projectId,
    response.headers?.get?.("etag") ?? null,
  );
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requireExactKeys(value, expectedKeys, label) {
  const object = plainObject(value);
  const actual = object ? Object.keys(object).sort() : [];
  const expected = [...expectedKeys].sort();
  if (!object || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CliError("invalid_checkpoint_payload", `${label} must contain exactly: ${expected.join(", ")}.`, {
      nextAction: "Fetch the filtered onboarding OpenAPI contract and rebuild this one checkpoint payload.",
      details: { expected_keys: expected, received_keys: actual },
    });
  }
  return object;
}

function validateSourceSnapshot(value, label) {
  const snapshot = requireExactKeys(value, [
    "git_head_sha",
    "source_fingerprint_algorithm",
    "source_fingerprint_sha256",
  ], label);
  if (
    !(snapshot.git_head_sha === null || (
      typeof snapshot.git_head_sha === "string"
      && /^[a-f0-9]{7,64}$/.test(snapshot.git_head_sha)
    ))
    || snapshot.source_fingerprint_algorithm !== "agentry-source-tree-sha256-v1"
    || typeof snapshot.source_fingerprint_sha256 !== "string"
    || !SHA256_PATTERN.test(snapshot.source_fingerprint_sha256)
  ) {
    throw new CliError("invalid_checkpoint_payload", `${label} is not a canonical onboarding source snapshot.`);
  }
  return snapshot;
}

function validatePlanShape(value, label) {
  const plan = requireExactKeys(value, [
    "business_question",
    "deploy",
    "failures",
    "historical_evidence",
    "milestones",
    "plan_markdown",
    "source_snapshot",
  ], label);
  if (
    !stringValue(plan.business_question)
    || !stringValue(plan.plan_markdown)
    || !Array.isArray(plan.milestones)
    || !plan.milestones.length
    || !Array.isArray(plan.failures)
    || !plan.failures.length
    || !plainObject(plan.deploy)
    || !(plan.historical_evidence === null || plainObject(plan.historical_evidence))
  ) {
    throw new CliError("invalid_checkpoint_payload", `${label} is missing its complete value flow, failures, deploy boundary, or evidence field.`);
  }
  validateSourceSnapshot(plan.source_snapshot, `${label}.source_snapshot`);
  return plan;
}

function validateStartPayload(value) {
  const payload = requireExactKeys(value, ["intent", "plan"], "Onboarding start payload");
  if (payload.intent !== "start") {
    throw new CliError("checkpoint_payload_operation_mismatch", "Initial onboarding payload intent must be start.");
  }
  validatePlanShape(payload.plan, "Onboarding start payload plan");
  return payload;
}

function validateReviewPayload(value, state, options) {
  const payload = plainObject(value);
  if (!payload || !new Set(["approve", "replace"]).has(payload.decision)) {
    throw new CliError("checkpoint_payload_operation_mismatch", "Planned onboarding accepts only an explicit approve or replace review payload.");
  }
  const keys = payload.decision === "approve"
    ? ["decision", "plan_sha256"]
    : ["decision", "plan_sha256", "replacement_plan"];
  requireExactKeys(payload, keys, "Onboarding review payload");
  if (!SHA256_PATTERN.test(payload.plan_sha256) || payload.plan_sha256 !== state.plan_sha256) {
    throw new CliError("plan_sha256_mismatch", "Review payload must name the exact current plan_sha256.", {
      nextAction: "Read the current planned checkpoint and review its exact plan and hash again.",
      details: { current_plan_sha256: state.plan_sha256 },
    });
  }
  if (payload.decision === "approve") {
    if (
      !options.approvePlanSha256
      || options.approvePlanSha256 !== payload.plan_sha256
      || options.approvePlanSha256 !== state.plan_sha256
    ) {
      throw new CliError(
        "plan_approval_confirmation_required",
        "Approval requires --approve-plan with the exact current plan_sha256 in addition to the bounded review payload.",
        { nextAction: "Show the full current plan and hash to the human, then rerun only after their explicit approval." },
      );
    }
  } else {
    if (options.approvePlanSha256) {
      throw new CliError("ambiguous_onboarding_action", "--approve-plan cannot accompany a replace decision.");
    }
    validatePlanShape(payload.replacement_plan, "Onboarding replacement plan");
  }
  return payload;
}

function validateProofPayload(value) {
  const payload = requireExactKeys(
    value,
    ["implementation_source_snapshot"],
    "Onboarding proof payload",
  );
  validateSourceSnapshot(
    payload.implementation_source_snapshot,
    "Onboarding proof implementation_source_snapshot",
  );
  return payload;
}

function pathIsWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function readCheckpointFile(context, path, maxBytes) {
  if (!isAbsolute(path)) {
    throw new CliError("checkpoint_file_must_be_absolute", "--checkpoint-file must name an absolute path outside the repository.");
  }
  let realRoot;
  let realPath;
  try {
    [realRoot, realPath] = await Promise.all([
      context.fs.realpath(context.cwd),
      context.fs.realpath(path),
    ]);
  } catch (error) {
    throw new CliError("checkpoint_file_unreadable", "The checkpoint file or repository root could not be resolved.", {
      details: { cause: error?.code ?? "unknown" },
    });
  }
  if (pathIsWithin(realRoot, realPath)) {
    throw new CliError(
      "checkpoint_file_inside_repository",
      "Checkpoint payloads must remain outside the repository.",
      { nextAction: "Move the payload under ~/.agentry/ or another outside-repository path and retry." },
    );
  }
  let stats;
  try {
    stats = await context.fs.stat(realPath);
  } catch (error) {
    throw new CliError("checkpoint_file_unreadable", "The checkpoint file could not be read.", {
      details: { cause: error?.code ?? "unknown" },
    });
  }
  if (!stats.isFile() || stats.size > maxBytes) {
    throw new CliError("checkpoint_input_too_large", `Checkpoint input must be a regular file no larger than ${maxBytes} bytes.`);
  }
  let raw;
  try {
    raw = await context.fs.readFile(realPath);
  } catch (error) {
    throw new CliError("checkpoint_file_unreadable", "The checkpoint file could not be read.", {
      details: { cause: error?.code ?? "unknown" },
    });
  }
  if (raw.byteLength > maxBytes) {
    throw new CliError("checkpoint_input_too_large", `Checkpoint input exceeds ${maxBytes} bytes.`);
  }
  return { raw: raw.toString("utf8"), source: "outside_repository_file" };
}

async function readCheckpointStdin(context, maxBytes) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of context.input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        throw new CliError("checkpoint_input_too_large", `Checkpoint stdin exceeds ${maxBytes} bytes.`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("checkpoint_stdin_unreadable", "Checkpoint JSON could not be read from stdin.");
  }
  return { raw: Buffer.concat(chunks).toString("utf8"), source: "stdin" };
}

async function readCheckpointPayload(context, options, maxBytes) {
  const input = options.checkpointFile
    ? await readCheckpointFile(context, options.checkpointFile, maxBytes)
    : options.checkpointStdin
      ? await readCheckpointStdin(context, maxBytes)
      : null;
  if (!input) return null;
  if (!input.raw.trim()) {
    throw new CliError("checkpoint_input_empty", "Checkpoint input must contain one JSON object.");
  }
  let value;
  try {
    value = JSON.parse(input.raw);
  } catch {
    throw new CliError("checkpoint_input_invalid_json", "Checkpoint input is not valid JSON.");
  }
  if (!plainObject(value)) {
    throw new CliError("invalid_checkpoint_payload", "Checkpoint input must contain exactly one JSON object.");
  }
  return { value, source: input.source };
}

function requireMutationEtag(response) {
  const etag = stringValue(response.headers?.get?.("etag"));
  if (!etag) {
    throw invalidOnboardingState("mutation response omitted its ETag header.");
  }
  return etag;
}

function normalizeProofMarkers(body) {
  const markers = plainObject(body?.one_time_markers);
  const runtime = plainObject(markers?.runtime);
  const ci = plainObject(markers?.ci);
  if (
    !runtime
    || !ci
    || runtime.property_name !== "agentry_onboarding_proof"
    || runtime.environment_variable !== "AGENTRY_ONBOARDING_PROOF"
    || runtime.browser_session_storage_key !== "agentry_onboarding_proof"
    || ci.header_name !== "X-Agentry-Onboarding-Proof"
    || ci.environment_variable !== "AGENTRY_ONBOARDING_PROOF"
    || !stringValue(runtime.value)
    || !stringValue(ci.value)
    || runtime.value === ci.value
  ) {
    throw invalidOnboardingState("proof response omitted its distinct canonical one-time markers.");
  }
  return { runtime, ci };
}

async function actuateOnboarding(context, options, projectId, state) {
  const hasInput = Boolean(options.checkpointFile || options.checkpointStdin);
  const hasAction = hasInput || Boolean(options.approvePlanSha256) || options.verify;
  if (!hasAction) return null;

  if (state === null) {
    if (!hasInput || options.approvePlanSha256 || options.verify) {
      throw new CliError("checkpoint_payload_operation_mismatch", "Initial onboarding requires one start payload and no approval or verify option.");
    }
    const input = await readCheckpointPayload(context, options, ONBOARDING_PLAN_INPUT_MAX_BYTES);
    const payload = validateStartPayload(input.value);
    const path = `/v1/projects/${encodeURIComponent(projectId)}/onboarding`;
    const response = await apiRequest(context, "POST", path, { body: payload });
    const responseEtag = requireMutationEtag(response);
    const nextState = normalizeOnboardingState(response.body, projectId, responseEtag);
    if (nextState.status !== "planned") {
      throw invalidOnboardingState("start did not return planned state.");
    }
    return {
      state: nextState,
      actuation: {
        operation: { method: "POST", path },
        request_etag: null,
        response_etag: nextState.etag,
        input_source: input.source,
      },
    };
  }

  if (state.status === "planned") {
    if (!hasInput || options.verify) {
      throw new CliError("checkpoint_payload_operation_mismatch", "Planned onboarding requires one approve or replace review payload.");
    }
    const input = await readCheckpointPayload(context, options, ONBOARDING_PLAN_INPUT_MAX_BYTES);
    const payload = validateReviewPayload(input.value, state, options);
    const path = state.next_action.operation.path;
    const response = await apiRequest(context, "POST", path, {
      body: payload,
      requestHeaders: { "if-match": state.etag },
    });
    const responseEtag = requireMutationEtag(response);
    const nextState = normalizeOnboardingState(response.body, projectId, responseEtag);
    const expectedStatus = payload.decision === "approve" ? "approved" : "planned";
    if (nextState.status !== expectedStatus) {
      throw invalidOnboardingState(`review ${payload.decision} did not return ${expectedStatus} state.`);
    }
    return {
      state: nextState,
      actuation: {
        operation: { method: "POST", path },
        request_etag: state.etag,
        response_etag: nextState.etag,
        input_source: input.source,
        review_decision: payload.decision,
      },
    };
  }

  if (state.status === "approved") {
    if (!hasInput || options.approvePlanSha256 || options.verify) {
      throw new CliError("checkpoint_payload_operation_mismatch", "Approved onboarding requires one implementation source-snapshot proof payload.");
    }
    const input = await readCheckpointPayload(context, options, ONBOARDING_PROOF_INPUT_MAX_BYTES);
    const payload = validateProofPayload(input.value);
    const path = state.next_action.operation.path;
    const response = await apiRequest(context, "POST", path, {
      body: payload,
      requestHeaders: { "if-match": state.etag },
    });
    const responseEtag = requireMutationEtag(response);
    const nextState = normalizeOnboardingState(response.body?.state, projectId, responseEtag);
    if (nextState.status !== "proving") {
      throw invalidOnboardingState("proof start did not return proving state.");
    }
    return {
      state: nextState,
      actuation: {
        operation: { method: "POST", path },
        request_etag: state.etag,
        response_etag: nextState.etag,
        input_source: input.source,
        one_time_markers: normalizeProofMarkers(response.body),
      },
    };
  }

  if (state.status === "proving") {
    if (hasInput || options.approvePlanSha256 || !options.verify) {
      throw new CliError(
        "verify_confirmation_required",
        "Proving state is bodyless and requires an explicit --verify with no checkpoint payload.",
        { nextAction: "Deploy and exercise only the approved real paths, then rerun with --verify." },
      );
    }
    const path = state.next_action.operation.path;
    const response = await apiRequest(context, "POST", path, {
      requestHeaders: { "if-match": state.etag },
    });
    const responseEtag = requireMutationEtag(response);
    if (typeof response.body?.ok !== "boolean" || !plainObject(response.body?.remaining)) {
      throw invalidOnboardingState("verify response omitted ok or structured remaining evidence.");
    }
    const nextState = normalizeOnboardingState(response.body?.state, projectId, responseEtag);
    if (
      (response.body.ok && nextState.status !== "verified")
      || (!response.body.ok && nextState.status !== "proving")
    ) {
      throw invalidOnboardingState("verify result does not match the returned onboarding status.");
    }
    return {
      state: nextState,
      actuation: {
        operation: { method: "POST", path },
        request_etag: state.etag,
        response_etag: nextState.etag,
        input_source: "explicit_bodyless_verify",
        verified: response.body.ok,
        remaining: response.body.remaining,
      },
    };
  }

  throw new CliError("onboarding_already_complete", "Onboarding is already source_verified; no checkpoint action applies.");
}

function onboardingStateEnvelope(context, options, project, connection, state, actuation = null) {
  const result = {
    project: { id: project.id, name: project.name },
    posthog_connection: publicConnection(connection),
    onboarding: state,
    actuation,
  };
  if (
    state.status === "verified"
    && state.installation_complete
    && state.evidence_status.source === "source_verified"
    && state.next_action === null
  ) {
    return envelope("onboard", "completed", {
      checkpoint: checkpoint(
        "onboarding_source_verified",
        "Onboarding is complete: the approved current source and deployed evidence are source_verified.",
        { kind: "complete", projectId: project.id },
      ),
      result,
    });
  }
  const next = state.next_action;
  if (!next?.instruction) {
    throw new CliError("onboarding_next_action_missing", "Onboarding is incomplete but has no next action.", {
      nextAction: "Read the live onboarding state and filtered OpenAPI contract before retrying.",
    });
  }
  return envelope("onboard", "action_required", {
    checkpoint: checkpoint(next.id, next.instruction, {
      requiresHuman: next.requires_human,
      kind: next.id === "exercise_and_verify"
        ? "external_action"
        : next.requires_human
          ? "human_checkpoint"
          : "agent_task",
      projectId: project.id,
      url: next.guide_anchor,
      resume: commandResume("onboard", options),
    }),
    result,
  });
}

async function onboardCommand(context, options) {
  const command = "onboard";
  const unauthenticated = await requireAuthentication(context, options, command, { interactiveLogin: true });
  if (unauthenticated) {
    // loginCommand labels its own envelope. Reframe it so an agent can rerun
    // the original orchestration command after the same checkpoint.
    return unauthenticated.command === "login"
      ? { ...unauthenticated, command, checkpoint: unauthenticated.checkpoint
          ? { ...unauthenticated.checkpoint, resume: commandResume(command, options) }
          : null }
      : unauthenticated;
  }
  const resolved = await resolveProject(context, options, command);
  if (resolved.response) return resolved.response;
  const project = resolved.project;
  const continuationOptions = {
    ...options,
    projectId: project.id,
    createProjectName: null,
  };
  const ensured = await ensurePosthogConnection(
    context,
    continuationOptions,
    project.id,
    command,
  );
  if (ensured.response) return ensured.response;

  const state = await readOnboardingState(context, project.id);
  const applied = await actuateOnboarding(
    context,
    continuationOptions,
    project.id,
    state,
  );
  if (applied) {
    return onboardingStateEnvelope(
      context,
      clearOnboardingActionOptions(continuationOptions),
      project,
      ensured.connection,
      applied.state,
      applied.actuation,
    );
  }
  if (!state) {
    return envelope(command, "action_required", {
      checkpoint: checkpoint(
        "prepare_source_backed_plan",
        "Inspect the shipped repository and existing PostHog telemetry, prepare the exact source-backed plan, then start the server-owned onboarding state.",
        {
          requiresHuman: false,
          projectId: project.id,
          url: `${context.apiUrl}/v1/openapi.json?flow=onboarding`,
          resume: commandResume(command, continuationOptions),
        },
      ),
      result: {
        project: { id: project.id, name: project.name },
        posthog_connection: publicConnection(ensured.connection),
        onboarding: null,
      },
    });
  }
  return onboardingStateEnvelope(
    context,
    continuationOptions,
    project,
    ensured.connection,
    state,
  );
}

function helpEnvelope() {
  return envelope("help", "completed", {
    result: {
      usage: "agentry <login|status|connect posthog|onboard> [options]",
      commands: [
        { command: "login", description: "Sign in with PostHog and authorize one Cloud project." },
        { command: "status", description: "Show accessible projects and PostHog connection state." },
        { command: "connect posthog", description: "Authorize and select an existing PostHog Cloud project." },
        { command: "onboard", description: "Advance to the next safe onboarding checkpoint." },
      ],
      options: [
        "--json",
        "--non-interactive",
        "--project <agentry-project-id>",
        "--posthog-project <posthog-project-id>",
        "--region <us|eu>",
        "--api-url <url>",
        "--create-project <name>",
        "--checkpoint-file <absolute-outside-repo-path>",
        "--checkpoint-stdin",
        "--approve-plan <sha256>",
        "--verify",
      ],
    },
  });
}

export async function executeCli(argv, dependencies = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    return errorEnvelope("unknown", error);
  }
  const { command, options } = parsed;
  if (command === "help") return helpEnvelope();
  if (command === "version") {
    return envelope("version", "completed", { result: { version: CLI_VERSION } });
  }
  try {
    const context = await loadExecutionContext(options, dependencies);
    if (typeof context.fetch !== "function") {
      throw new CliError("fetch_unavailable", "This Node.js runtime does not provide fetch.");
    }
    if (command === "login") return await loginCommand(context, options);
    if (command === "status") return await statusCommand(context, options);
    if (command === "connect posthog") return await connectPosthogCommand(context, options);
    if (command === "onboard") return await onboardCommand(context, options);
    return helpEnvelope();
  } catch (error) {
    return errorEnvelope(command, error);
  }
}

function renderHuman(response) {
  if (response.status === "failed") {
    const lines = [`Error (${response.error.code}): ${response.error.message}`];
    if (response.error.next_action) lines.push(`Next: ${response.error.next_action}`);
    return `${lines.join("\n")}\n`;
  }
  if (response.command === "help") {
    const lines = [response.result.usage, "", "Commands:"];
    for (const command of response.result.commands) lines.push(`  ${command.command.padEnd(17)} ${command.description}`);
    lines.push("", "Options:", ...response.result.options.map((option) => `  ${option}`));
    return `${lines.join("\n")}\n`;
  }
  if (response.command === "version") return `${response.result.version}\n`;
  if (response.command === "status" && response.result?.projects) {
    const lines = ["Agentry status"];
    for (const project of response.result.projects) {
      lines.push(
        `  ${project.name} (${project.id}): PostHog ${project.posthog_connection.status}; ` +
        `onboarding ${project.onboarding?.status ?? "not started"}`,
      );
    }
    if (response.checkpoint) lines.push("", `Next: ${response.checkpoint.instruction}`);
    return `${lines.join("\n")}\n`;
  }
  if (response.status === "completed") {
    if (response.command === "login") return "Signed in with PostHog.\n";
    if (response.command === "connect posthog") return `PostHog connected to ${response.result.project.name}.\n`;
    if (response.command === "onboard") return `Agentry onboarding is verified for ${response.result.project.name}.\n`;
  }
  if (response.checkpoint) {
    const lines = [`Next: ${response.checkpoint.instruction}`];
    if (response.checkpoint.url) lines.push(response.checkpoint.url);
    if (response.checkpoint.resume) {
      lines.push(`Resume: ${[response.checkpoint.resume.command, ...response.checkpoint.resume.arguments].join(" ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
  return `${JSON.stringify(response.result, null, 2)}\n`;
}

export async function runCli(argv, dependencies = {}) {
  let jsonRequested = argv.includes("--json");
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const report = dependencies.report ?? ((message) => {
    const stream = jsonRequested ? stderr : stdout;
    stream.write(`${redactString(message)}\n`);
  });
  const response = await executeCli(argv, { ...dependencies, report, output: dependencies.output ?? stderr });
  jsonRequested = jsonRequested || response.command === "unknown";
  const rendered = jsonRequested ? `${JSON.stringify(response)}\n` : renderHuman(response);
  (jsonRequested ? stdout : response.status === "failed" ? stderr : stdout).write(rendered);
  return response.status === "failed" ? 1 : 0;
}
