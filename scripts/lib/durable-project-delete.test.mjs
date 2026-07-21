import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteProjectDurably,
  retryAfterSecondsFor,
} from "./durable-project-delete.mjs";

test("retries 202 with one key and preserves the command identity", async () => {
  let clock = 1_000;
  const calls = [];
  const waits = [];
  const responses = [
    { status: 202, headers: { "retry-after": "9" }, json: { command_id: "mutcmd_one", retry_after_seconds: 2 } },
    { status: 200, headers: {}, json: { command_id: "mutcmd_one", deleted: true } },
  ];
  const result = await deleteProjectDurably({
    idempotencyKey: "stable-delete-key",
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    attempt: async (input) => {
      calls.push(input);
      return responses.shift();
    },
  });
  assert.equal(result.deletion_complete, true);
  assert.deepEqual(waits, [2_000]);
  assert.deepEqual(calls.map((row) => row.idempotencyKey), ["stable-delete-key", "stable-delete-key"]);
  assert.deepEqual(result.deletion_attempts.map((row) => row.status), [202, 200]);
});

test("retries a lost response with the same key", async () => {
  let clock = 0;
  let calls = 0;
  const result = await deleteProjectDurably({
    idempotencyKey: "lost-response-key",
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    attempt: async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset after commit");
      return { status: 200, headers: {}, json: { command_id: "mutcmd_lost", deleted: true } };
    },
  });
  assert.equal(result.deletion_complete, true);
  assert.equal(calls, 2);
  assert.match(result.deletion_attempts[0].network_error, /connection reset/);
});

test("does not mistake in-progress or arbitrary 2xx responses for deletion", async () => {
  let clock = 0;
  const pending = await deleteProjectDurably({
    idempotencyKey: "pending-delete-key",
    maxWaitMs: 500,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    attempt: async () => ({
      status: 202,
      headers: { "retry-after": "10" },
      json: { command_id: "mutcmd_pending", deleted: false },
    }),
  });
  assert.equal(pending.deletion_complete, false);
  assert.equal(pending.deletion_retry_budget_exhausted, true);

  const accepted = await deleteProjectDurably({
    idempotencyKey: "accepted-delete-key",
    attempt: async () => ({ status: 200, headers: {}, json: { deleted: false } }),
  });
  assert.equal(accepted.deletion_complete, false);
});

test("rejects a changed command id and reads standard headers", async () => {
  let calls = 0;
  await assert.rejects(
    deleteProjectDurably({
      idempotencyKey: "changed-command-key",
      sleep: async () => {},
      attempt: async () => {
        calls += 1;
        return calls === 1
          ? { status: 202, headers: { "retry-after": "1" }, json: { command_id: "mutcmd_a" } }
          : { status: 200, headers: {}, json: { command_id: "mutcmd_b", deleted: true } };
      },
    }),
    /changed command_id/,
  );
  assert.equal(retryAfterSecondsFor({ headers: new Headers({ "Retry-After": "3" }), json: {} }), 3);
});
