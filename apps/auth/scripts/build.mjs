#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(root, "public"), dist, { recursive: true });

const functionBuild = mkdtempSync(join(tmpdir(), "agentry-auth-functions-"));
try {
  const result = spawnSync("wrangler", [
    "pages",
    "functions",
    "build",
    join(root, "functions"),
    "--outdir",
    functionBuild,
    "--project-directory",
    root,
    "--build-output-directory",
    dist,
  ], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Pages Functions compilation exited with status ${result.status ?? "unknown"}`);
  }
} finally {
  rmSync(functionBuild, { recursive: true, force: true });
}

console.log("auth build: copied static assets and compiled transactional functions");
