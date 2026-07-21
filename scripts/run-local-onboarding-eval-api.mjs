#!/usr/bin/env node

import { createServer } from "node:http";

const host = process.env.AGENTRY_EVAL_API_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.AGENTRY_EVAL_API_PORT);
const maxRequestBytes = 2 * 1024 * 1024;

if (process.env.AGENTRY_EVAL_LOCAL_ONLY !== "1") {
  throw new Error("Local onboarding eval API requires AGENTRY_EVAL_LOCAL_ONLY=1");
}
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error("Local onboarding eval API must bind to loopback");
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("AGENTRY_EVAL_API_PORT must be a valid TCP port");
}
if (!String(process.env.TURSO_DATABASE_URL ?? "").startsWith("file:")) {
  throw new Error("Local onboarding eval API requires a throwaway file: database");
}

const ENV_KEYS = [
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "ENABLE_TEST_LOGIN",
  "AGENTRY_TOKEN_ENC_KEY",
  "POSTHOG_OAUTH_CLIENT_ID",
  "POSTHOG_OAUTH_REDIRECT_URI",
  "ADMIN_TOKEN",
  "MAX_BODY_BYTES",
  "INSTALL_PLAN_RATE_LIMIT_PER_MINUTE",
  "AGENTRY_URL",
  "AGENTRY_DEPLOY_SHA",
  "AGENTRY_ENVIRONMENT",
];

const env = Object.fromEntries(
  ENV_KEYS.flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
);
const worker = (await import("../apps/api/src/index.ts")).default;
const pending = new Set();

function executionContext() {
  return {
    waitUntil(promise) {
      const tracked = Promise.resolve(promise)
        .catch((error) => {
          process.stderr.write(`[waitUntil] ${error instanceof Error ? error.message : String(error)}\n`);
        })
        .finally(() => pending.delete(tracked));
      pending.add(tracked);
    },
    passThroughOnException() {},
  };
}

async function boundedBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.byteLength;
    if (size > maxRequestBytes) throw new Error("local eval request body exceeded 2 MiB");
    chunks.push(chunk);
  }
  return size === 0 ? undefined : Buffer.concat(chunks, size);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, raw] of Object.entries(incoming.headers)) {
      if (Array.isArray(raw)) raw.forEach((value) => headers.append(name, value));
      else if (raw !== undefined) headers.set(name, raw);
    }
    const body = await boundedBody(incoming);
    const request = new Request(
      `http://${host}:${port}${incoming.url || "/"}`,
      {
        method: incoming.method || "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      },
    );
    const response = await worker.fetch(request, env, executionContext());
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (!response.body || incoming.method === "HEAD") {
      outgoing.end();
      return;
    }
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    process.stderr.write(`[request] ${incoming.method || "GET"} ${incoming.url || "/"}: ${error instanceof Error ? error.message : String(error)}\n`);
    if (!outgoing.headersSent) {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", "application/json");
    }
    outgoing.end(JSON.stringify({ error: { code: "local_eval_server_error", message: "Local eval server request failed." } }));
  }
});

server.listen(port, host, () => {
  process.stdout.write(`local onboarding eval API listening on http://${host}:${port}\n`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  const timer = setTimeout(() => server.closeAllConnections?.(), 1_000);
  timer.unref();
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
