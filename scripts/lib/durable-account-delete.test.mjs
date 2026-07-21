import test from "node:test";
import assert from "node:assert/strict";
import { deleteAccountDurably } from "./durable-account-delete.mjs";

test("resumes account deletion with one key through terminal tombstone recovery", async () => {
  let clock = 0;
  const keys = [];
  const responses = [
    {
      status: 202,
      headers: { "retry-after": "2" },
      json: { command_id: "mutcmd_account", retry_after_seconds: 1 },
    },
    {
      status: 200,
      headers: {},
      json: {
        status: "deleted",
        command_id: "mutcmd_account",
        receipt_recovery: { authority: "terminal_manifest_only" },
      },
    },
  ];
  const result = await deleteAccountDurably({
    idempotencyKey: "stable-account-delete-key",
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    attempt: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      return responses.shift();
    },
  });
  assert.equal(result.account_deletion_complete, true);
  assert.deepEqual(keys, ["stable-account-delete-key", "stable-account-delete-key"]);
  assert.deepEqual(result.deletion_attempts.map((row) => row.status), [202, 200]);
});

test("does not accept an arbitrary 200 account response", async () => {
  const result = await deleteAccountDurably({
    idempotencyKey: "stable-account-delete-key",
    attempt: async () => ({ status: 200, headers: {}, json: { status: "pending" } }),
  });
  assert.equal(result.account_deletion_complete, false);
});
