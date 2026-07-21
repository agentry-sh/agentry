import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENTRY_SELF_REPAIR_POLICY,
  DraftSubjectError,
  canonicalizeAgentryDraftSubject,
} from "./agentry-draft-subject.mjs";

const base = () => ({
  branch: "codex/agentry-repair-019f5c38",
  commit_sha: "ABCDEF0123456789abcdef0123456789abcdef01",
  changed_files: [
    "packages/shared/src/automation.test.ts",
    "apps/api/test/automation-v2.test.ts",
    "apps/api/src/routes/automation-runs.ts",
  ],
  changed_lines: { added: 100, deleted: 20 },
  tests: AGENTRY_SELF_REPAIR_POLICY.test_commands.map((command) => ({
    command,
    status: "passed",
  })),
});

test("canonicalizes the exact approval and proof subject fields", () => {
  const subject = canonicalizeAgentryDraftSubject(base());
  assert.deepEqual(Object.keys(subject), [
    "kind",
    "branch",
    "commit_sha",
    "change_types",
    "changed_files",
    "changed_lines",
    "tests",
  ]);
  assert.deepEqual(subject.change_types, ["application_code", "tests"]);
  assert.deepEqual(subject.changed_files, [...base().changed_files].sort());
  assert.equal(subject.commit_sha, base().commit_sha.toLowerCase());
  assert.deepEqual(subject.tests, AGENTRY_SELF_REPAIR_POLICY.test_commands.map((command) => ({
    command,
    status: "passed",
  })));
});

test("classifies allowed test roots as tests and src roots as application_code", () => {
  const input = base();
  input.changed_files = [
    "apps/api/test/example.test.ts",
    "packages/shared/test/example.test.ts",
    "packages/db/src/example.ts",
  ];
  assert.deepEqual(
    canonicalizeAgentryDraftSubject(input).change_types,
    ["application_code", "tests"],
  );
});

test("rejects out-of-scope files, duplicate paths, and frozen budget overflow", () => {
  for (const changedFiles of [
    [".github/workflows/release.yml"],
    ["apps/api/src/a.ts", "apps/api/src/a.ts"],
    Array.from({ length: 6 }, (_, index) => `apps/api/src/file-${index}.ts`),
  ]) {
    const input = base();
    input.changed_files = changedFiles;
    assert.throws(() => canonicalizeAgentryDraftSubject(input), DraftSubjectError);
  }
  const lines = base();
  lines.changed_lines = { added: 240, deleted: 1 };
  assert.throws(() => canonicalizeAgentryDraftSubject(lines), /240-line limit/);
});

test("requires the four exact npm results in their frozen order with no extra evidence", () => {
  const reordered = base();
  reordered.tests.reverse();
  assert.throws(() => canonicalizeAgentryDraftSubject(reordered), /tests\[0\]\.command/);

  const extra = base();
  extra.tests[0] = { ...extra.tests[0], exit_code: 0 };
  assert.throws(() => canonicalizeAgentryDraftSubject(extra), /unsupported fields: exit_code/);

  const failed = base();
  failed.tests[3].status = "failed";
  assert.throws(() => canonicalizeAgentryDraftSubject(failed), /must be passed/);
});

test("requires the full GitHub commit object id", () => {
  const abbreviated = base();
  abbreviated.commit_sha = abbreviated.commit_sha.slice(0, 7);
  assert.throws(() => canonicalizeAgentryDraftSubject(abbreviated), /full 40-character/);
});
