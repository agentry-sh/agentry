import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { createProjectDurably } from "./durable-project-create.mjs";

test("recovers one committed project through a proxy-dropped first response", async () => {
  const key = "proxy-lost-project-create-key";
  const committed = new Map();
  const receivedKeys = [];
  let dropped = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const requestKey = String(request.headers["idempotency-key"] ?? "");
    receivedKeys.push(requestKey);
    if (!committed.has(requestKey)) {
      committed.set(requestKey, {
        command_id: "mutcmd_proxy_recovery",
        id: "project-proxy-recovery",
        next_action: "Connect the existing customer PostHog project through read-only OAuth.",
        idempotent_replay: false,
      });
    }
    if (!dropped) {
      dropped = true;
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...committed.get(requestKey), idempotent_replay: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  let clock = 0;

  try {
    const result = await createProjectDurably({
      idempotencyKey: key,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      attempt: async ({ idempotencyKey }) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ name: "proxy recovery" }),
          redirect: "error",
          signal: AbortSignal.timeout(1_000),
        });
        return { status: response.status, headers: response.headers, json: await response.json() };
      },
    });
    assert.equal(result.project_create_complete, true);
    assert.deepEqual(result.project_create_identity, {
      commandId: "mutcmd_proxy_recovery",
      projectId: "project-proxy-recovery",
    });
    assert.equal(result.json.public_api_key, undefined);
    assert.match(result.json.next_action, /PostHog.*OAuth/);
    assert.equal(committed.size, 1);
    assert.deepEqual(receivedKeys, [key, key]);
    assert.deepEqual(
      result.project_create_attempts.map((entry) => entry.outcome),
      ["response_lost", "identity_recovered"],
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
