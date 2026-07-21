#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function stampFor(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function redactText(value) {
  if (typeof value !== "string") return value;
  // Preserve redaction for logs produced before public-ingest keys were retired.
  return value
    .replace(/agentry_sk_[A-Za-z0-9._-]+/g, "agentry_sk_<redacted>")
    .replace(/agentry_pk_[A-Za-z0-9._-]+/g, "agentry_pk_<redacted>")
    .replace(/agp_[A-Za-z0-9._-]+/g, "agp_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer <redacted>");
}

function writeText(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, redactText(value));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function relativeToRepo(file) {
  return path.relative(REPO_ROOT, file);
}

function runChild(command, args, { logFile }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk) => {
      const text = redactText(chunk.toString());
      output += text;
      process.stdout.write(text);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("exit", (code, signal) => {
      writeText(logFile, output);
      resolve({
        code,
        signal,
        output,
        duration_ms: Date.now() - startedAt,
      });
    });
    child.on("error", (error) => {
      output += redactText(`${error.stack || error.message}\n`);
      writeText(logFile, output);
      resolve({
        code: 1,
        signal: null,
        output,
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}

function writeMarkdown(file, summary) {
  const lines = [
    "# Auth Account Lifecycle Preflight",
    "",
    `Status: ${summary.ok ? "PASS" : "FAIL"}`,
    `Started: ${summary.started_at}`,
    `Ended: ${summary.ended_at}`,
    `Duration: ${formatDuration(summary.duration_ms)}`,
    "",
    "## Coverage",
    "",
    ...summary.covered_requirements.map((item) => `- ${item}`),
    "",
    "## Gates",
    "",
    ...Object.entries(summary.gates).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Artifacts",
    "",
    `- Log: \`${relativeToRepo(summary.log_file)}\``,
    `- Summary JSON: \`${relativeToRepo(summary.summary_json)}\``,
    "",
  ];
  writeText(file, `${lines.join("\n")}\n`);
}

async function main() {
  const startedAt = Date.now();
  const runDir = path.join(REPO_ROOT, "tmp", "agentry-soak", `auth-account-lifecycle-${stampFor(new Date(startedAt))}`);
  const logFile = path.join(runDir, "auth-account-lifecycle.log");
  const child = await runChild("npm", ["-w", "apps/api", "run", "test:auth-account-lifecycle"], { logFile });
  const ok = child.code === 0;
  const coveredRequirements = [
    "fresh account can be authorized through the hosted test device-flow hook",
    "device poll mints only the private agentry_sk_ owner key",
    "private key rotation mints a new agentry_sk_ key",
    "old private key is rejected after rotation",
    "rotated owner key can create a control-plane project without an application telemetry credential",
    "self-delete requires explicit confirmation",
    "self-delete cascades account, project, and API-key state",
    "deleted account key is rejected after cleanup",
  ];
  const summaryJson = path.join(runDir, "summary.json");
  const summaryMd = path.join(runDir, "summary.md");
  const summary = {
    ok,
    run_dir: runDir,
    started_at: new Date(startedAt).toISOString(),
    ended_at: new Date().toISOString(),
    duration_ms: child.duration_ms,
    command: "npm -w apps/api run test:auth-account-lifecycle",
    exit_code: child.code,
    signal: child.signal,
    log_file: logFile,
    summary_md: summaryMd,
    summary_json: summaryJson,
    covered_requirements: coveredRequirements,
    gates: {
      fresh_account_hosted_test_device_flow: ok,
      owner_key_minted: ok,
      private_key_rotated: ok,
      old_private_key_rejected_after_rotation: ok,
      project_created_with_rotated_key: ok,
      self_delete_requires_confirmation: ok,
      self_delete_cascades_state: ok,
      deleted_account_key_rejected: ok,
    },
  };
  writeJson(summaryJson, summary);
  writeMarkdown(summaryMd, summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
