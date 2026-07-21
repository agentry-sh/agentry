import assert from "node:assert/strict";
import test from "node:test";
import { executeWithCleanup } from "./execute-with-cleanup.mjs";

test("attempts cleanup after an injected mid-suite failure and preserves both outcomes", async () => {
  const calls = [];
  const primary = new Error("injected mid-suite failure");
  const cleanupFailure = new Error("cleanup evidence failure");
  const outcome = await executeWithCleanup(
    async () => {
      calls.push("work");
      throw primary;
    },
    async (observedPrimary) => {
      calls.push("cleanup");
      assert.equal(observedPrimary, primary);
      throw cleanupFailure;
    },
  );

  assert.deepEqual(calls, ["work", "cleanup"]);
  assert.equal(outcome.error, primary);
  assert.equal(outcome.cleanupError, cleanupFailure);
});

test("returns work value after successful cleanup", async () => {
  const outcome = await executeWithCleanup(async () => 42, async () => undefined);
  assert.equal(outcome.value, 42);
  assert.equal(outcome.error, null);
  assert.equal(outcome.cleanupError, null);
});
