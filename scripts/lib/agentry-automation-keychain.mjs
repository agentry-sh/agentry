import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";

export const AUTOMATION_KEYCHAIN_ITEMS = Object.freeze({
  runner: Object.freeze({
    service: "agentry.automation.agentry_production_error_repair.runner",
    account: "019e43d2-6e5a-7c39-b916-9f71ea581143",
    env: "AGENTRY_RUNNER_API_KEY",
    prefix: "agentry_runner_",
  }),
  github: Object.freeze({
    service: "agentry.automation.agentry_production_error_repair.github",
    account: "019e43d2-6e5a-7c39-b916-9f71ea581143",
    env: "AGENTRY_AUTOMATION_GITHUB_TOKEN",
    prefix: null,
  }),
});

export class KeychainLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = "KeychainLoadError";
  }
}

export function readKeychainSecret(item, options = {}) {
  const spawnSync = options.spawnSync ?? nodeSpawnSync;
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", item.service, "-a", item.account, "-w"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: options.home ?? process.env.HOME,
        PATH: "/usr/bin:/bin",
      },
    },
  );
  if (result.status !== 0) {
    throw new KeychainLoadError(`Keychain item ${item.service}/${item.account} is missing or unavailable`);
  }
  const secret = typeof result.stdout === "string" ? result.stdout.replace(/[\r\n]+$/u, "") : "";
  if (
    secret.length < 20 ||
    secret.length > 1_000 ||
    /[\r\n\u0000]/u.test(secret) ||
    (item.prefix && !secret.startsWith(item.prefix))
  ) {
    throw new KeychainLoadError(`Keychain item ${item.service}/${item.account} has the wrong credential shape`);
  }
  return secret;
}

export function keychainSchedulerEnvironment(parentEnv, secrets) {
  const env = { ...parentEnv };
  for (const name of [
    "AGENTRY_PRIVATE_API_KEY",
    "AGENTRY_CI_API_KEY",
    "AGENTRY_SERVER_API_KEY",
    "AGENTRY_PUBLIC_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    delete env[name];
  }
  env.AGENTRY_RUNNER_API_KEY = secrets.runner;
  env.AGENTRY_AUTOMATION_GITHUB_TOKEN = secrets.github;
  return env;
}

export async function spawnKeychainScheduler(entrypoint, argv, env, options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const child = spawn(process.execPath, [entrypoint, ...argv], {
    cwd: options.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}
