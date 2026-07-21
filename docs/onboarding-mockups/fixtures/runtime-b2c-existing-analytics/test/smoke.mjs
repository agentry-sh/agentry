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
      ...(token ? { "x-session-token": token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const contentType = response.headers.get("content-type") || "";
  const value = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { status: response.status, value };
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
  const home = await request(baseUrl, "/");
  assert.equal(home.status, 200);
  assert.match(String(home.value), /NoteSpark/);

  const signup = await request(baseUrl, "/auth/signup", {
    method: "POST",
    body: {
      email: "smoke@example.com",
      source: "newsletter",
      utm_source: "newsletter_test",
    },
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.value.user_id, "user_1");
  assert.equal(signup.value.session_token, "session_user_1");
  const token = signup.value.session_token;

  const created = await request(baseUrl, "/api/notes", {
    method: "POST",
    token,
    body: { title: "First note", body: "Smoke test" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.value.note.id, "note_1");

  const shared = await request(baseUrl, "/api/notes/note_1/share", {
    method: "POST",
    token,
    body: { channel: "email", destination: "friend@example.com" },
  });
  assert.equal(shared.status, 200);
  assert.equal(shared.value.share.channel, "email");

  const smsShared = await request(baseUrl, "/api/notes/note_1/share", {
    method: "POST",
    token,
    body: { channel: "sms", destination: "+15551234567" },
  });
  assert.equal(smsShared.status, 200);
  assert.equal(smsShared.value.delivery.provider, "notespark-sms");

  const handledFailure = await request(baseUrl, "/api/notes/note_1/share", {
    method: "POST",
    token,
    body: { channel: "sms", destination: "+15550000000" },
  });
  assert.equal(handledFailure.status, 502);
  assert.equal(handledFailure.value.error, "sms_delivery_failed");
  assert.equal(handledFailure.value.error_code, "sms_provider_timeout");

  const checkout = await request(baseUrl, "/api/billing/checkout", {
    method: "POST",
    token,
    body: { plan: "plus" },
  });
  assert.equal(checkout.status, 200);
  assert.equal(checkout.value.checkout.id, "checkout_user_1_plus");

  const analytics = await request(baseUrl, "/debug/analytics");
  assert.equal(analytics.status, 200);
  assert.deepEqual(
    analytics.value.events.map((event) => event.event),
    [
      "page_view",
      "signup_completed",
      "note_created",
      "note_shared",
      "note_shared",
      "sms_failed",
      "checkout_started",
    ],
  );

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
  const repeatedDeploy = spawnSync("npm", ["run", "deploy"], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(repeatedDeploy.status, 0, `${repeatedDeploy.stdout}\n${repeatedDeploy.stderr}`);
  const repeatedReceipt = JSON.parse(readFileSync(path.join(root, "out/local-deploy/deployment.json"), "utf8"));
  assert.deepEqual(repeatedReceipt, receipt);
  console.log("NoteSpark smoke: pass");
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
