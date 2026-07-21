const TEST_COMMANDS = Object.freeze([
  "npm -w @agentry/db run typecheck",
  "npm -w @agentrysh/shared test",
  "npm -w @agentry/api run typecheck",
  "npm -w @agentry/api run test:unit",
]);

const ALLOWED_SOURCE_PREFIXES = Object.freeze([
  "apps/api/src/",
  "packages/shared/src/",
  "packages/db/src/",
]);

const ALLOWED_TEST_PREFIXES = Object.freeze([
  "apps/api/test/",
  "packages/shared/test/",
]);

export const AGENTRY_SELF_REPAIR_POLICY = Object.freeze({
  project_id: "019e43d2-6e5a-7c39-b916-9f71ea581143",
  automation_id: "agentry_production_error_repair",
  runner_id: "agentry-self-repair-runner-01",
  repository: "https://github.com/agentry-sh/agentry",
  default_branch: "main",
  allowed_paths: Object.freeze([
    "apps/api/src/**",
    "apps/api/test/**",
    "packages/shared/src/**",
    "packages/shared/test/**",
    "packages/db/src/**",
  ]),
  test_commands: TEST_COMMANDS,
  max_files_changed: 5,
  max_changed_lines: 240,
});

export class DraftSubjectError extends Error {
  constructor(message) {
    super(message);
    this.name = "DraftSubjectError";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new DraftSubjectError(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new DraftSubjectError(`${label} contains unsupported fields: ${extras.sort().join(", ")}`);
  }
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new DraftSubjectError(`${label} must be a non-empty string no longer than ${maximum} characters`);
  }
  return value;
}

function normalizedFile(value) {
  const file = boundedString(value, "changed_files[]", 500);
  if (
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").includes("..") ||
    file.split("/").includes("")
  ) {
    throw new DraftSubjectError(`changed file is not a normalized repository-relative path: ${file}`);
  }
  return file;
}

export function changeTypeForPath(file) {
  if (ALLOWED_TEST_PREFIXES.some((prefix) => file.startsWith(prefix))) return "tests";
  if (ALLOWED_SOURCE_PREFIXES.some((prefix) => file.startsWith(prefix))) return "application_code";
  throw new DraftSubjectError(`changed file is outside the frozen automation scope: ${file}`);
}

function canonicalTests(value) {
  if (!Array.isArray(value) || value.length !== TEST_COMMANDS.length) {
    throw new DraftSubjectError(`tests must contain exactly ${TEST_COMMANDS.length} ordered results`);
  }
  return value.map((test, index) => {
    exactKeys(test, ["command", "status"], `tests[${index}]`);
    const expected = TEST_COMMANDS[index];
    if (test.command !== expected) {
      throw new DraftSubjectError(`tests[${index}].command must be exactly: ${expected}`);
    }
    if (test.status !== "passed") {
      throw new DraftSubjectError(`tests[${index}].status must be passed before approval can be requested`);
    }
    return { command: expected, status: "passed" };
  });
}

/**
 * Produce the one canonical client-side draft-PR subject used for both the
 * approval request and the later grant authorization. The API independently
 * canonicalizes and hashes this subject; this helper prevents accidental drift
 * in paths, tests, counts, or optional evidence fields before either request.
 */
export function canonicalizeAgentryDraftSubject(input) {
  exactKeys(
    input,
    ["branch", "commit_sha", "changed_files", "changed_lines", "tests"],
    "draft subject input",
  );

  const branch = boundedString(input.branch, "branch", 300);
  if (branch === AGENTRY_SELF_REPAIR_POLICY.default_branch || branch.startsWith("-") || /[\u0000-\u001f\u007f]/u.test(branch)) {
    throw new DraftSubjectError("branch must be a safe non-default repair branch");
  }
  const commitSha = boundedString(input.commit_sha, "commit_sha", 40);
  if (!/^[a-f0-9]{40}$/iu.test(commitSha)) {
    throw new DraftSubjectError("commit_sha must be a full 40-character hexadecimal Git commit id");
  }

  if (!Array.isArray(input.changed_files) || input.changed_files.length < 1) {
    throw new DraftSubjectError("changed_files must contain at least one file");
  }
  const changedFiles = [...new Set(input.changed_files.map(normalizedFile))].sort();
  if (changedFiles.length !== input.changed_files.length) {
    throw new DraftSubjectError("changed_files must not contain duplicates");
  }
  if (changedFiles.length > AGENTRY_SELF_REPAIR_POLICY.max_files_changed) {
    throw new DraftSubjectError(`changed_files exceeds the frozen ${AGENTRY_SELF_REPAIR_POLICY.max_files_changed}-file limit`);
  }
  const changeTypes = [...new Set(changedFiles.map(changeTypeForPath))].sort();

  exactKeys(input.changed_lines, ["added", "deleted"], "changed_lines");
  const added = input.changed_lines.added;
  const deleted = input.changed_lines.deleted;
  if (!Number.isInteger(added) || added < 0 || !Number.isInteger(deleted) || deleted < 0) {
    throw new DraftSubjectError("changed_lines.added and changed_lines.deleted must be non-negative integers");
  }
  if (added + deleted > AGENTRY_SELF_REPAIR_POLICY.max_changed_lines) {
    throw new DraftSubjectError(`changed_lines exceeds the frozen ${AGENTRY_SELF_REPAIR_POLICY.max_changed_lines}-line limit`);
  }

  return {
    kind: "draft_pr",
    branch,
    commit_sha: commitSha.toLowerCase(),
    change_types: changeTypes,
    changed_files: changedFiles,
    changed_lines: { added, deleted },
    tests: canonicalTests(input.tests),
  };
}
