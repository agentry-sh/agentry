#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const AUTOMATION_ID = "agentry_production_error_repair";
export const PLAYBOOK = "error-to-draft-pr@2.0.0";
export const USER_AGENT = `agentry-self-repair-pr-proof/1.0 (${AUTOMATION_ID}; ${PLAYBOOK})`;
export const RUN_ID_MARKER = "agentry-automation-run-id";
export const MAX_CHANGED_FILES = 5;
export const MAX_CHANGED_LINES = 240;

export const REQUIRED_TESTS = Object.freeze([
  Object.freeze({
    command: "npm -w @agentry/db run typecheck",
    status: "passed",
  }),
  Object.freeze({ command: "npm -w @agentrysh/shared test", status: "passed" }),
  Object.freeze({
    command: "npm -w @agentry/api run typecheck",
    status: "passed",
  }),
  Object.freeze({
    command: "npm -w @agentry/api run test:unit",
    status: "passed",
  }),
]);

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GIT_SHA = /^[0-9a-f]{40,64}$/i;
const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);
const SUPPORTED_FILE_STATUSES = new Set([
  "added",
  "modified",
  "removed",
  "renamed",
]);

const PATH_RULES = Object.freeze([
  Object.freeze({ prefix: "apps/api/test/", type: "tests" }),
  Object.freeze({ prefix: "packages/shared/test/", type: "tests" }),
  Object.freeze({ prefix: "apps/api/src/", type: "application_code" }),
  Object.freeze({ prefix: "packages/shared/src/", type: "application_code" }),
  Object.freeze({ prefix: "packages/db/src/", type: "application_code" }),
]);

export class ProofError extends Error {
  constructor(code, message, recovery) {
    super(message);
    this.name = "ProofError";
    this.code = code;
    this.recovery = recovery;
  }
}

function fail(code, message, recovery) {
  throw new ProofError(code, message, recovery);
}

/**
 * Parse the one authority-binding marker accepted from a PR body.
 *
 * The marker must be its own exact line:
 *   <!-- agentry-automation-run-id: 01900000-0000-7000-8000-000000000000 -->
 *
 * Text without the marker is an ordinary PR and returns null. Any mention of
 * the marker token that is malformed, inline, or duplicated fails closed.
 */
export function parseRunIdMarker(body) {
  if (body === null || body === undefined || body === "") return null;
  if (typeof body !== "string") {
    fail(
      "invalid_pr_body",
      "GitHub returned a non-string pull-request body.",
      "Reload the pull request from GitHub and rerun the workflow.",
    );
  }

  const tokenPattern = new RegExp(RUN_ID_MARKER, "gi");
  const tokenCount = [...body.matchAll(tokenPattern)].length;
  if (tokenCount === 0) return null;

  const exactMarker = new RegExp(
    `^<!-- ${RUN_ID_MARKER}: ([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}) -->$`,
  );
  const matches = body
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .map((line) => exactMarker.exec(line))
    .filter(Boolean);

  if (tokenCount !== 1 || matches.length !== 1) {
    fail(
      "invalid_run_id_marker",
      `The PR body must contain exactly one standalone <!-- ${RUN_ID_MARKER}: <uuid-v7> --> line.`,
      "Replace every malformed or duplicate marker with the exact marker emitted by the Agentry runner, then rerun this workflow.",
    );
  }

  const runId = matches[0][1].toLowerCase();
  if (!UUID_V7.test(runId)) {
    fail(
      "invalid_run_id_marker",
      "The Agentry automation run id is not a canonical UUIDv7.",
      "Copy run_id from the durable Agentry run; never invent or shorten it.",
    );
  }
  return runId;
}

function validatedPath(value, label = "filename") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 500 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    CONTROL_CHARACTER.test(value) ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(
      "invalid_changed_file",
      `GitHub returned an unsafe ${label}.`,
      "Inspect the provider diff and replace the PR if its path cannot be represented safely.",
    );
  }
  return value;
}

function classifyPath(path) {
  const match = PATH_RULES.find((rule) => path.startsWith(rule.prefix));
  if (!match) {
    fail(
      "changed_file_out_of_scope",
      `The draft PR changes out-of-scope path ${JSON.stringify(path)}.`,
      "Close or revise the draft PR so it changes only the automation contract's five allowed source/test path families, then obtain a new exact approval.",
    );
  }
  return match.type;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      "invalid_provider_diff",
      `GitHub returned an invalid ${label}.`,
      "Wait for GitHub's pull-request diff to settle and rerun the workflow.",
    );
  }
  return value;
}

function changedFileStatus(value) {
  if (typeof value !== "string" || !SUPPORTED_FILE_STATUSES.has(value)) {
    fail(
      "unsupported_provider_file_status",
      "GitHub returned a changed-file status that cannot be bound to an exact regular blob.",
      "Recreate the bounded repair as ordinary added, modified, removed, or renamed regular files, then request a new exact approval.",
    );
  }
  return value;
}

function validateTextPatch(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(
      "non_text_provider_diff",
      `GitHub did not return a complete textual patch for ${JSON.stringify(path)}.`,
      "Remove binary, oversized single-line, or otherwise non-text content from the repair; create a new bounded draft PR and obtain a new exact approval.",
    );
  }
}

/** Derive the exact, bounded grant subject facts from GitHub's PR-files API. */
export function summarizeChangedFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    fail(
      "empty_provider_diff",
      "GitHub returned no changed files for the draft PR.",
      "Do not attest an empty repair; inspect the PR and rerun after the provider diff is available.",
    );
  }
  if (files.length > MAX_CHANGED_FILES) {
    fail(
      "provider_diff_too_large",
      `The draft PR changes ${files.length} files; the approved limit is ${MAX_CHANGED_FILES}.`,
      "Split or narrow the repair, then request a new exact approval for the smaller diff.",
    );
  }

  const paths = [];
  const changeTypes = new Set();
  let added = 0;
  let deleted = 0;

  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      fail(
        "invalid_provider_diff",
        "GitHub returned a malformed changed-file record.",
        "Wait for GitHub's pull-request diff to settle and rerun the workflow.",
      );
    }
    const path = validatedPath(file.filename);
    const type = classifyPath(path);
    const status = changedFileStatus(file.status);
    validateTextPatch(file.patch, path);

    if (status === "renamed") {
      const previousPath = validatedPath(
        file.previous_filename,
        "previous_filename",
      );
      const previousType = classifyPath(previousPath);
      if (previousType !== type) {
        fail(
          "renamed_file_crosses_scope",
          `The rename from ${JSON.stringify(previousPath)} to ${JSON.stringify(path)} crosses deterministic change-type boundaries.`,
          "Use a new bounded PR whose renames stay inside one approved path family, then request a new exact approval.",
        );
      }
    }

    paths.push(path);
    changeTypes.add(type);
    added += nonnegativeInteger(file.additions, `${path} additions`);
    deleted += nonnegativeInteger(file.deletions, `${path} deletions`);
  }

  const uniquePaths = new Set(paths);
  if (uniquePaths.size !== paths.length) {
    fail(
      "duplicate_changed_file",
      "GitHub returned duplicate changed-file paths.",
      "Wait for the provider diff to settle and rerun; do not submit ambiguous proof.",
    );
  }
  if (added + deleted > MAX_CHANGED_LINES) {
    fail(
      "provider_diff_too_large",
      `The draft PR changes ${added + deleted} lines; the approved limit is ${MAX_CHANGED_LINES}.`,
      "Split or narrow the repair, then request a new exact approval for the smaller diff.",
    );
  }

  return {
    changed_files: [...uniquePaths].sort(),
    changed_lines: { added, deleted },
    change_types: [...changeTypes].sort(),
  };
}

function regularBlobRequirements(files) {
  const headPaths = new Set();
  const basePaths = new Set();

  for (const file of files) {
    const path = validatedPath(file.filename);
    switch (changedFileStatus(file.status)) {
      case "added":
        headPaths.add(path);
        break;
      case "modified":
        headPaths.add(path);
        basePaths.add(path);
        break;
      case "removed":
        basePaths.add(path);
        break;
      case "renamed":
        headPaths.add(path);
        basePaths.add(
          validatedPath(file.previous_filename, "previous_filename"),
        );
        break;
      default:
        throw new Error("unreachable changed-file status");
    }
  }

  return {
    headPaths: [...headPaths].sort(),
    basePaths: [...basePaths].sort(),
  };
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(
      "invalid_github_event",
      `${label} must be a positive integer.`,
      "Rerun this workflow from a pull_request_target event for the intended draft PR.",
    );
  }
  return value;
}

function validateSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    fail(
      "invalid_provider_identity",
      `${label} is not a full Git object id.`,
      "Reload provider facts from GitHub and rerun this workflow.",
    );
  }
  return value.toLowerCase();
}

function validateBranch(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 300 ||
    CONTROL_CHARACTER.test(value)
  ) {
    fail(
      "invalid_provider_identity",
      `${label} is invalid.`,
      "Inspect the GitHub PR branch identity and replace the PR if necessary.",
    );
  }
  return value;
}

function httpsUrl(value, label, expectedOrigin, maxLength = 2_000) {
  if (typeof value !== "string" || value.length > maxLength) {
    fail(
      "invalid_provider_identity",
      `${label} is missing or exceeds ${maxLength} characters.`,
      "Reload bounded provider facts from GitHub and rerun this workflow.",
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(
      "invalid_provider_identity",
      `${label} is not a valid URL.`,
      "Reload provider facts from GitHub and rerun this workflow.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (expectedOrigin && parsed.origin !== expectedOrigin)
  ) {
    fail(
      "invalid_provider_identity",
      `${label} is outside the trusted HTTPS GitHub origin.`,
      "Use the provider URL returned by this repository's GitHub API; never submit a caller-authored URL.",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

function safeErrorBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error =
    value.error &&
    typeof value.error === "object" &&
    !Array.isArray(value.error)
      ? value.error
      : value;
  return {
    ...(typeof error.code === "string"
      ? { code: error.code.slice(0, 200) }
      : {}),
    ...(typeof error.message === "string"
      ? { message: error.message.slice(0, 1_000) }
      : {}),
    ...(typeof error.next_action === "string"
      ? { next_action: error.next_action.slice(0, 1_000) }
      : {}),
  };
}

async function responseJson(response, label) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    fail(
      "unexpected_provider_response",
      `${label} returned HTTP ${response.status} without JSON.`,
      "Check provider availability and permissions, then rerun the workflow.",
    );
  }
  try {
    return await response.json();
  } catch {
    fail(
      "unexpected_provider_response",
      `${label} returned invalid JSON.`,
      "Check provider availability and rerun the workflow.",
    );
  }
}

async function githubJson(path, { fetchImpl, githubApiUrl, githubToken }) {
  const response = await fetchImpl(`${githubApiUrl}${path}`, {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
  });
  const json = await responseJson(response, "GitHub API");
  if (!response.ok) {
    const safe = safeErrorBody(json);
    fail(
      "github_api_failed",
      `GitHub API returned HTTP ${response.status}${safe?.message ? `: ${safe.message}` : ""}.`,
      "Verify pull-request read permission and GitHub availability, then rerun the failed workflow.",
    );
  }
  return json;
}

async function verifyRegularBlobsAtRevision({
  fetchImpl,
  githubApiUrl,
  githubToken,
  encodedRepository,
  revision,
  revisionLabel,
  paths,
}) {
  if (paths.length === 0) return;

  const tree = await githubJson(
    `/repos/${encodedRepository}/git/trees/${encodeURIComponent(revision)}?recursive=1`,
    { fetchImpl, githubApiUrl, githubToken },
  );
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    fail(
      "invalid_provider_tree",
      `GitHub returned a malformed ${revisionLabel} tree.`,
      "Reload the exact PR head/base tree from GitHub and rerun this workflow.",
    );
  }
  if (
    validateSha(tree.sha, `${revisionLabel} tree revision`) !== revision
  ) {
    fail(
      "provider_tree_revision_mismatch",
      `GitHub returned a tree that is not bound to the tested ${revisionLabel} revision.`,
      "Rerun from a fresh pull-request event; never attest objects from a different Git revision.",
    );
  }
  if (tree.truncated !== false) {
    fail(
      tree.truncated === true
        ? "provider_tree_truncated"
        : "invalid_provider_tree",
      `GitHub did not return a complete ${revisionLabel} tree.`,
      "Do not attest partial object facts. Rerun after provider data is available; if the repository exceeds GitHub's recursive-tree limit, replace this integration with exact path-by-path tree traversal before enabling the automation.",
    );
  }
  if (!Array.isArray(tree.tree)) {
    fail(
      "invalid_provider_tree",
      `GitHub returned a malformed ${revisionLabel} tree entry list.`,
      "Reload the exact PR head/base tree from GitHub and rerun this workflow.",
    );
  }

  const requiredPaths = new Set(paths);
  const entriesByPath = new Map();
  for (const entry of tree.tree) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof entry.path === "string" &&
      requiredPaths.has(entry.path)
    ) {
      if (entriesByPath.has(entry.path)) {
        fail(
          "invalid_provider_tree",
          `GitHub returned duplicate ${revisionLabel} tree entries for ${JSON.stringify(entry.path)}.`,
          "Reload provider facts and rerun; never attest an ambiguous Git object.",
        );
      }
      entriesByPath.set(entry.path, entry);
    }
  }

  for (const path of paths) {
    const entry = entriesByPath.get(path);
    if (!entry) {
      fail(
        "provider_tree_file_missing",
        `The ${revisionLabel} tree does not contain changed file ${JSON.stringify(path)}.`,
        "Wait for GitHub's PR files and tree views to agree, then rerun this workflow from a fresh event.",
      );
    }
    if (entry.type !== "blob" || !REGULAR_BLOB_MODES.has(entry.mode)) {
      fail(
        "non_regular_changed_file",
        `Changed path ${JSON.stringify(path)} is not a regular file in the ${revisionLabel} tree.`,
        "Remove symlinks, submodules, directories, and other non-regular objects from the repair; create a new bounded draft PR and obtain a new exact approval.",
      );
    }
  }
}

/**
 * Read all provider facts from GitHub, binding them to the exact event head/base
 * that the unprivileged job tested.
 */
export async function collectGithubProof({
  fetchImpl = fetch,
  githubApiUrl,
  githubServerUrl,
  githubToken,
  repository,
  prNumber,
  expectedHeadSha,
  expectedBaseSha,
  ciUrl,
}) {
  if (!REPOSITORY_SLUG.test(repository)) {
    fail(
      "invalid_github_event",
      "GITHUB_REPOSITORY is not an owner/repository slug.",
      "Run this only inside the intended GitHub repository.",
    );
  }
  positiveInteger(prNumber, "pull request number");
  const apiUrl = httpsUrl(githubApiUrl, "GITHUB_API_URL");
  const serverUrl = httpsUrl(githubServerUrl, "GITHUB_SERVER_URL");
  if (typeof githubToken !== "string" || githubToken.length < 1) {
    fail(
      "missing_github_token",
      "The trusted proof job has no GitHub API token.",
      "Grant the proof job read-only contents and pull-request permissions, then rerun it.",
    );
  }

  const encodedRepository = repository
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const pr = await githubJson(`/repos/${encodedRepository}/pulls/${prNumber}`, {
    fetchImpl,
    githubApiUrl: apiUrl,
    githubToken,
  });
  if (!pr || typeof pr !== "object" || Array.isArray(pr)) {
    fail(
      "invalid_provider_response",
      "GitHub returned a malformed pull request.",
      "Reload the PR from GitHub and rerun the workflow.",
    );
  }

  if (pr.number !== prNumber || pr.state !== "open" || pr.draft !== true) {
    fail(
      "pr_not_open_draft",
      "Provider proof is allowed only for the exact open draft PR from this event.",
      "Keep the automation PR open and draft; create a new approved run if it was closed or made ready for review.",
    );
  }

  const baseRepository = pr.base?.repo?.full_name;
  const headRepository = pr.head?.repo?.full_name;
  if (
    typeof baseRepository !== "string" ||
    baseRepository.toLowerCase() !== repository.toLowerCase() ||
    typeof headRepository !== "string" ||
    headRepository.toLowerCase() !== repository.toLowerCase()
  ) {
    fail(
      "pr_repository_mismatch",
      "The PR is not a same-repository branch targeting this trusted base repository.",
      "Do not expose proof authority to a fork; have the approved runner create its bounded branch in the configured repository.",
    );
  }

  const headSha = validateSha(pr.head?.sha, "PR head SHA");
  const baseSha = validateSha(pr.base?.sha, "PR base SHA");
  if (headSha !== validateSha(expectedHeadSha, "tested event head SHA")) {
    fail(
      "tested_head_changed",
      "The GitHub PR head changed after the unprivileged test job was scheduled.",
      "Use the newer synchronize workflow run; never attest a head that this run did not test.",
    );
  }
  if (baseSha !== validateSha(expectedBaseSha, "tested event base SHA")) {
    fail(
      "tested_base_changed",
      "The GitHub PR base changed after the unprivileged test job was scheduled.",
      "Trigger a fresh PR event by editing the surrounding PR description while preserving the exact marker, so tests and proof bind the current base.",
    );
  }

  const runId = parseRunIdMarker(pr.body);
  if (runId === null) {
    return { status: "skipped", reason: "no_agentry_run_id_marker" };
  }

  const files = [];
  for (let page = 1; ; page += 1) {
    const pageRows = await githubJson(
      `/repos/${encodedRepository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      { fetchImpl, githubApiUrl: apiUrl, githubToken },
    );
    if (!Array.isArray(pageRows)) {
      fail(
        "invalid_provider_response",
        "GitHub returned a malformed PR-files page.",
        "Wait for the provider diff to settle and rerun the workflow.",
      );
    }
    files.push(...pageRows);
    if (files.length > MAX_CHANGED_FILES || pageRows.length < 100) break;
  }

  const diff = summarizeChangedFiles(files);
  if (
    pr.changed_files !== files.length ||
    pr.additions !== diff.changed_lines.added ||
    pr.deletions !== diff.changed_lines.deleted
  ) {
    fail(
      "provider_diff_changed",
      "GitHub's PR summary and files API disagree about the current diff.",
      "Wait for provider facts to settle, then rerun; never submit a mixed-revision proof.",
    );
  }

  const { headPaths, basePaths } = regularBlobRequirements(files);
  await Promise.all([
    verifyRegularBlobsAtRevision({
      fetchImpl,
      githubApiUrl: apiUrl,
      githubToken,
      encodedRepository,
      revision: headSha,
      revisionLabel: "tested head",
      paths: headPaths,
    }),
    verifyRegularBlobsAtRevision({
      fetchImpl,
      githubApiUrl: apiUrl,
      githubToken,
      encodedRepository,
      revision: baseSha,
      revisionLabel: "tested base",
      paths: basePaths,
    }),
  ]);

  const repositoryUrl = httpsUrl(
    pr.base?.repo?.html_url,
    "repository URL",
    new URL(serverUrl).origin,
    500,
  );
  const prUrl = httpsUrl(pr.html_url, "PR URL", new URL(serverUrl).origin, 500);
  const normalizedCiUrl = ciUrl
    ? httpsUrl(ciUrl, "CI URL", new URL(serverUrl).origin, 500)
    : undefined;

  return {
    status: "ready",
    run_id: runId,
    payload: {
      vcs_provider: "github",
      repository: repositoryUrl,
      pr_url: prUrl,
      pr_number: prNumber,
      draft: true,
      head_sha: headSha,
      head_branch: validateBranch(pr.head?.ref, "PR head branch"),
      base_branch: validateBranch(pr.base?.ref, "PR base branch"),
      change_types: diff.change_types,
      changed_files: diff.changed_files,
      changed_lines: diff.changed_lines,
      tests: REQUIRED_TESTS.map((test) => ({ ...test })),
      ...(normalizedCiUrl ? { ci_url: normalizedCiUrl } : {}),
    },
  };
}

export async function postAgentryProof({
  fetchImpl = fetch,
  apiBaseUrl,
  ciApiKey,
  runId,
  payload,
}) {
  if (!UUID_V7.test(runId)) {
    fail(
      "invalid_run_id",
      "Refusing to construct a proof URL from a non-UUIDv7 run id.",
      "Use the strict provider-read PR body marker emitted for the durable Agentry run.",
    );
  }
  if (
    typeof ciApiKey !== "string" ||
    !ciApiKey.startsWith("agentry_ci_") ||
    ciApiKey.length < 24
  ) {
    fail(
      "missing_ci_credential",
      "AGENTRY_AUTOMATION_CI_API_KEY is missing or is not an Agentry CI credential.",
      "Install the project's automation_proofs:write CI credential as the protected GitHub Actions secret, then rerun only the trusted proof job.",
    );
  }
  const apiBase = httpsUrl(apiBaseUrl, "Agentry API base URL");
  const response = await fetchImpl(
    `${apiBase}/v1/automation-runs/${encodeURIComponent(runId)}/pr-proof`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ciApiKey}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
      redirect: "error",
    },
  );
  const json = await responseJson(response, "Agentry API");
  if (!response.ok) {
    const safe = safeErrorBody(json);
    fail(
      "agentry_pr_proof_failed",
      `Agentry rejected PR proof with HTTP ${response.status}${safe?.code ? ` (${safe.code})` : ""}${safe?.message ? `: ${safe.message}` : ""}.`,
      safe?.next_action ??
        "Read the durable run and current automation control state, reconcile the exact PR/grant facts, then rerun this trusted job. Never open or attest a replacement PR under the old grant.",
    );
  }
  return json;
}

function requiredEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(
      "missing_workflow_context",
      `${name} is required in the trusted proof job.`,
      "Rerun the repository workflow from a supported pull_request_target event.",
    );
  }
  return value;
}

function githubAnnotation(kind, title, message) {
  const escaped = String(message)
    .replace(/%/gu, "%25")
    .replace(/\r/gu, "%0D")
    .replace(/\n/gu, "%0A");
  process.stderr.write(`::${kind} title=${title}::${escaped}\n`);
}

export async function main({ env = process.env, fetchImpl = fetch } = {}) {
  if (requiredEnv(env, "GITHUB_EVENT_NAME") !== "pull_request_target") {
    fail(
      "unsupported_workflow_event",
      "PR proof runs only from pull_request_target so the proof script is trusted base-branch code.",
      "Use the repository's Agentry self-repair PR proof workflow; do not run proof from PR-controlled workflow code.",
    );
  }
  if (requiredEnv(env, "AGENTRY_TEST_JOB_RESULT") !== "success") {
    fail(
      "required_tests_not_passed",
      "The exact unprivileged test job did not finish successfully.",
      "Fix the draft PR and let all four exact tests pass before rerunning proof.",
    );
  }
  if (requiredEnv(env, "AGENTRY_AUTOMATION_ID") !== AUTOMATION_ID) {
    fail(
      "automation_id_mismatch",
      "The workflow automation id does not match this trusted integration.",
      `Set AGENTRY_AUTOMATION_ID to ${AUTOMATION_ID} in trusted base-branch workflow code.`,
    );
  }
  if (requiredEnv(env, "AGENTRY_PLAYBOOK") !== PLAYBOOK) {
    fail(
      "playbook_mismatch",
      "The workflow playbook binding does not match this trusted integration.",
      `Set AGENTRY_PLAYBOOK to ${PLAYBOOK} in trusted base-branch workflow code.`,
    );
  }

  let event;
  try {
    event = JSON.parse(
      await readFile(requiredEnv(env, "GITHUB_EVENT_PATH"), "utf8"),
    );
  } catch (error) {
    fail(
      "invalid_github_event",
      `Could not read the GitHub event: ${error instanceof Error ? error.message : "invalid JSON"}.`,
      "Rerun the workflow from the intended pull request.",
    );
  }
  const prNumber = positiveInteger(
    event?.pull_request?.number,
    "event pull request number",
  );
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const githubServerUrl = requiredEnv(env, "GITHUB_SERVER_URL");
  const runId = requiredEnv(env, "GITHUB_RUN_ID");
  if (!/^\d+$/u.test(runId)) {
    fail(
      "invalid_github_event",
      "GITHUB_RUN_ID is invalid.",
      "Rerun the workflow from GitHub Actions.",
    );
  }
  const ciUrl = `${githubServerUrl.replace(/\/$/u, "")}/${repository}/actions/runs/${runId}`;

  const proof = await collectGithubProof({
    fetchImpl,
    githubApiUrl: requiredEnv(env, "GITHUB_API_URL"),
    githubServerUrl,
    githubToken: requiredEnv(env, "GITHUB_TOKEN"),
    repository,
    prNumber,
    expectedHeadSha: requiredEnv(env, "EXPECTED_HEAD_SHA"),
    expectedBaseSha: requiredEnv(env, "EXPECTED_BASE_SHA"),
    ciUrl,
  });

  if (proof.status === "skipped") {
    process.stdout.write(
      "No strict Agentry automation run marker is present; no proof was posted.\n",
    );
    return proof;
  }

  const result = await postAgentryProof({
    fetchImpl,
    apiBaseUrl: requiredEnv(env, "AGENTRY_API_BASE_URL"),
    ciApiKey: requiredEnv(env, "AGENTRY_AUTOMATION_CI_API_KEY"),
    runId: proof.run_id,
    payload: proof.payload,
  });
  process.stdout.write(
    JSON.stringify({
      run_id: proof.run_id,
      proof_hash:
        typeof result?.proof_hash === "string" ? result.proof_hash : null,
      recorded_at: result?.recorded_at ?? null,
      idempotent_replay: result?.idempotent_replay === true,
    }) + "\n",
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    if (error instanceof ProofError) {
      githubAnnotation(
        "error",
        "Agentry PR proof blocked",
        `${error.code}: ${error.message} Recovery: ${error.recovery}`,
      );
    } else {
      githubAnnotation(
        "error",
        "Agentry PR proof failed",
        "unexpected_error: Trusted proof failed before completion. Inspect the job and rerun; no merge or deploy was attempted.",
      );
    }
    process.exitCode = 1;
  });
}
