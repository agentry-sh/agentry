import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generated = [path.join(root, "dist"), path.join(root, "out")];

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function request(baseUrl, pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { "x-api-key": token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs()}`);
    try {
      const health = await request(baseUrl, "/health");
      if (health.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`server did not become ready\n${logs()}`);
}

for (const directory of generated) rmSync(directory, { recursive: true, force: true });
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(process.execPath, ["src/server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  await waitForHealth(baseUrl, child, () => output);
  const signup = await request(baseUrl, "/auth/signup", {
    method: "POST",
    body: { email: "smoke@example.com", company: "Smoke Co" },
  });
  assert.equal(signup.status, 201);
  assert.ok(signup.json.api_key);
  assert.ok(signup.json.workspace_id);
  const token = signup.json.api_key;

  assert.equal((await request(baseUrl, "/api/dashboard", { token })).status, 200);
  assert.equal((await request(baseUrl, "/api/integrations/slack/connect", {
    method: "POST", token, body: { code: "ok_smoke" },
  })).status, 200);
  assert.equal((await request(baseUrl, "/api/automations", {
    method: "POST", token, body: { name: "Smoke digest", trigger: "new_signup" },
  })).status, 201);
  assert.equal((await request(baseUrl, "/api/billing/checkout", {
    method: "POST", token, body: { plan: "pro" },
  })).status, 200);
  assert.equal((await request(baseUrl, "/api/stripe/webhook", {
    method: "POST",
    body: {
      type: "customer.subscription.created",
      workspace_id: signup.json.workspace_id,
      plan: "pro",
    },
  })).status, 200);
  assert.equal((await request(baseUrl, "/api/stripe/webhook", {
    method: "POST",
    body: {
      type: "invoice.payment_failed",
      workspace_id: signup.json.workspace_id,
      plan: "pro",
      decline_code: "generic_decline",
    },
  })).status, 200);

  const handledFailure = await request(baseUrl, "/api/integrations/slack/connect", {
    method: "POST", token, body: { code: "fail" },
  });
  assert.equal(handledFailure.status, 502);
  assert.equal(handledFailure.json.error, "slack_connect_failed");

  const webhookFailure = await request(baseUrl, "/api/stripe/webhook", {
    method: "POST",
    body: { type: "customer.subscription.created" },
  });
  assert.equal(webhookFailure.status, 400);
  assert.equal(webhookFailure.json.error, "webhook_failed");

  const deploy = spawnSync("npm", ["run", "deploy"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(deploy.status, 0, `${deploy.stdout}\n${deploy.stderr}`);
  const receipt = JSON.parse(readFileSync(path.join(root, "out/local-deploy/deployment.json"), "utf8"));
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.completion_command, "npm run deploy");
  assert.match(receipt.release_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.deploy_sha, /^[a-f0-9]{7,64}$/);
  console.log("LaunchFlow smoke: pass");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_000).unref();
  });
  for (const directory of generated) rmSync(directory, { recursive: true, force: true });
}
