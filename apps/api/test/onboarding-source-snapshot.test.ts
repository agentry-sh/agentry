import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_SOURCE_SNAPSHOT_FILENAME,
  ONBOARDING_SOURCE_SNAPSHOT_NODE,
  ONBOARDING_SOURCE_SNAPSHOT_PATH,
} from "../src/onboarding-source-snapshot.js";

const temporaryDirectories: string[] = [];
const algorithm = "agentry-source-tree-sha256-v1";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function fixture(): { root: string; script: string } {
  const directory = mkdtempSync(join(tmpdir(), "agentry-source-snapshot-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), "hello\n");
  writeFileSync(join(root, "src", "run.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(join(root, "src", "run.sh"), 0o755);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "snapshot-test@agentry.test");
  git(root, "config", "user.name", "Agentry Snapshot Test");
  git(root, "add", "--all");
  git(root, "update-index", "--chmod=+x", "src/run.sh");
  git(root, "commit", "--quiet", "-m", "fixture");
  const script = join(directory, ONBOARDING_SOURCE_SNAPSHOT_FILENAME);
  writeFileSync(script, ONBOARDING_SOURCE_SNAPSHOT_NODE);
  chmodSync(script, 0o755);
  return { root, script };
}

function run(root: string, script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AGENTRY_PRIVATE_API_KEY: "must-not-be-read" },
  });
}

function expectedFingerprint() {
  const entries = [
    { mode: "100644", path: Buffer.from("README.md"), content: Buffer.from("hello\n") },
    { mode: "100755", path: Buffer.from("src/run.sh"), content: Buffer.from("#!/bin/sh\necho ok\n") },
  ];
  const hash = createHash("sha256").update(`${algorithm}\0`, "ascii");
  for (const entry of entries) {
    hash.update(`${entry.mode}\0${entry.path.length}\0`, "ascii");
    hash.update(entry.path);
    hash.update(`\0${entry.content.length}\0`, "ascii");
    hash.update(entry.content);
    hash.update("\0", "ascii");
  }
  return hash.digest("hex");
}

describe("standalone onboarding source snapshot", () => {
  it("has one small dependency-free served-script surface", () => {
    expect(ONBOARDING_SOURCE_SNAPSHOT_FILENAME).toBe("agentry-source-snapshot.mjs");
    expect(ONBOARDING_SOURCE_SNAPSHOT_PATH).toBe("/v1/onboarding/source-snapshot.mjs");
    expect(ONBOARDING_SOURCE_SNAPSHOT_NODE.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(Buffer.byteLength(ONBOARDING_SOURCE_SNAPSHOT_NODE)).toBeLessThan(12 * 1024);
    expect(ONBOARDING_SOURCE_SNAPSHOT_NODE).not.toMatch(/fetch\(|node:http|node:https|process\.env|onboarding\.json|api[_-]?key/i);
  });

  it("returns only the deterministic committed mode/path/content fingerprint", () => {
    const { root, script } = fixture();
    const result = run(root, script);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      git_head_sha: git(root, "rev-parse", "HEAD"),
      source_fingerprint_sha256: expectedFingerprint(),
      source_fingerprint_algorithm: algorithm,
    });
  });

  it("ignores dirty and untracked working files for planning but requires clean tracked source for final", () => {
    const { root, script } = fixture();
    const original = JSON.parse(run(root, script).stdout);
    writeFileSync(join(root, "README.md"), "local tracked change\n");
    writeFileSync(join(root, ".env"), "SECRET=do-not-read\n");

    const planning = run(root, script);
    expect(planning.status).toBe(0);
    expect(JSON.parse(planning.stdout)).toEqual(original);
    expect(planning.stdout).not.toContain("SECRET");

    const final = run(root, script, "--final");
    expect(final.status).toBe(1);
    expect(final.stdout).toBe("");
    expect(final.stderr).toBe("tracked_source_not_clean\n");
  });

  it("allows untracked files at final and changes only after tracked source is committed", () => {
    const { root, script } = fixture();
    const before = JSON.parse(run(root, script, "--final").stdout);
    writeFileSync(join(root, ".env"), "SECRET=still-not-read\n");
    const withUntracked = run(root, script, "--final");
    expect(withUntracked.status).toBe(0);
    expect(JSON.parse(withUntracked.stdout)).toEqual(before);

    writeFileSync(join(root, "README.md"), "committed change\n");
    git(root, "add", "README.md");
    git(root, "commit", "--quiet", "-m", "change source");
    const after = JSON.parse(run(root, script, "--final").stdout);
    expect(after.git_head_sha).not.toBe(before.git_head_sha);
    expect(after.source_fingerprint_sha256).not.toBe(before.source_fingerprint_sha256);
  });

  it("fails closed outside Git and on unknown arguments without leaking command output", () => {
    const { script } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "agentry-source-snapshot-no-git-"));
    temporaryDirectories.push(directory);
    const outside = run(directory, script);
    expect(outside.status).toBe(1);
    expect(outside.stdout).toBe("");
    expect(outside.stderr).toBe("not_a_git_repository\n");

    const unknown = run(directory, script, "--submit");
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toBe("usage: agentry-source-snapshot.mjs [--final]\n");
  });
});
