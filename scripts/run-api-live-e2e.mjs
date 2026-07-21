#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const baseUrl = process.env.AGENTRY_URL ?? "http://127.0.0.1:8787";
const shouldStartLocal = !process.env.AGENTRY_URL;
const verbose = process.env.AGENTRY_LIVE_E2E_VERBOSE === "1";
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/`);
      if (res.ok) return;
    } catch {
      // Still booting.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for API server at ${url}`);
}

function attachLogBuffer(child) {
  const lines = [];
  const push = (chunk) => {
    const text = chunk.toString();
    lines.push(...text.split(/\r?\n/).filter(Boolean));
    while (lines.length > 80) lines.shift();
    if (verbose) process.stdout.write(text);
  };

  child.stdout?.on("data", push);
  child.stderr?.on("data", push);

  return () => lines.join("\n");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    sleep(5_000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

let devServer;
let getBufferedLogs = () => "";

try {
  if (process.env.AGENTRY_SKIP_LIVE_E2E === "1") {
    console.log("skipping live API e2e because AGENTRY_SKIP_LIVE_E2E=1");
    process.exit(0);
  }

  if (shouldStartLocal) {
    devServer = spawn(npmCmd, ["run", "dev", "--workspace", "@agentry/api"], {
      cwd: repoRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    getBufferedLogs = attachLogBuffer(devServer);
    await waitForServer(baseUrl);
  }

  const e2e = spawn(process.execPath, [join(repoRoot, "scripts", "run-api-mini-live-test.mjs")], {
    cwd: repoRoot,
    env: { ...process.env, AGENTRY_URL: baseUrl },
    stdio: "inherit",
  });
  const [code] = await once(e2e, "exit");
  if (code !== 0) {
    throw new Error(`live e2e exited with code ${code}`);
  }
} catch (err) {
  const logs = getBufferedLogs();
  if (logs) {
    console.error("\n--- local api logs ---");
    console.error(logs);
  }
  throw err;
} finally {
  await stopChild(devServer);
}
