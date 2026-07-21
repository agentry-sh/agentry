#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  AUTOMATION_KEYCHAIN_ITEMS,
  keychainSchedulerEnvironment,
  readKeychainSecret,
  spawnKeychainScheduler,
} from "./lib/agentry-automation-keychain.mjs";

const allowed = new Set(["--once", "--preflight", "--help", "-h"]);
const argv = process.argv.slice(2);
if (argv.length > 1 || (argv.length === 1 && !allowed.has(argv[0]))) {
  process.stderr.write("usage: node scripts/run-agentry-codex-automation-keychain.mjs [--once|--preflight|--help]\n");
  process.exit(1);
}
try {
  const secrets = {
    runner: readKeychainSecret(AUTOMATION_KEYCHAIN_ITEMS.runner),
    github: readKeychainSecret(AUTOMATION_KEYCHAIN_ITEMS.github),
  };
  const env = keychainSchedulerEnvironment(process.env, secrets);
  const entrypoint = fileURLToPath(new URL("./run-agentry-codex-automation.mjs", import.meta.url));
  const result = await spawnKeychainScheduler(entrypoint, argv, env, {
    cwd: process.cwd(),
  });
  if (result.signal) {
    process.stderr.write(`automation runner stopped by signal ${result.signal}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.code ?? 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ ok: false, code: "keychain_load_failed", message })}\n`);
  process.exitCode = 1;
}
