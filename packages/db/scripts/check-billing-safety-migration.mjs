import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-add-billing-safety.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-billing-migration-"));

function runMigration(url, expectFailure = false) {
  try {
    execFileSync(process.execPath, nodeScriptArgs(migration), {
      env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
      stdio: "pipe",
    });
    if (expectFailure) throw new Error("migration unexpectedly accepted schema drift");
  } catch (error) {
    if (!expectFailure) throw error;
  }
}

async function seedPrerequisites(client) {
  await client.batch([
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE users (id text PRIMARY KEY, plan text NOT NULL DEFAULT 'free')`,
    `CREATE TABLE mutation_commands (
      id text PRIMARY KEY,
      actor_user_id text NOT NULL,
      project_id text,
      action text NOT NULL,
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      response_json text NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'succeeded',
      version integer NOT NULL DEFAULT 0,
      lease_token text,
      lease_expires_at integer,
      attempt_count integer NOT NULL DEFAULT 0,
      target_count integer NOT NULL DEFAULT 0,
      processed_count integer NOT NULL DEFAULT 0,
      error_json text,
      updated_at integer NOT NULL DEFAULT (unixepoch()),
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `INSERT INTO users (id) VALUES ('usr_1')`,
    `INSERT INTO mutation_commands (
      id, actor_user_id, action, idempotency_key_hash, request_hash,
      resource_type, resource_id, status, target_count
    ) VALUES (
      'mutcmd_1', 'usr_1', 'billing.checkout',
      'idem', 'request', 'billing_session', 'usr_1', 'intent', 1
    )`,
  ], "write");
}

async function expectReject(promise, label) {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${label} was not rejected`);
}

try {
  const dbPath = join(directory, "billing.sqlite");
  const url = `file:${dbPath}`;
  const client = createClient({ url });
  await seedPrerequisites(client);
  client.close();

  runMigration(url);
  runMigration(url);

  const check = createClient({ url });
  const expectedTables = [
    "account_deletion_fences",
    "billing_mutation_targets",
    "billing_mutation_secrets",
    "billing_webhook_events",
    "billing_subscription_cursors",
  ];
  for (const table of expectedTables) {
    const row = await check.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      args: [table],
    });
    if (row.rows.length !== 1) throw new Error(`missing ${table}`);
  }
  await check.execute(`INSERT INTO billing_mutation_targets (
    command_id, user_id, operation, target_hash, target_json,
    stripe_customer_idempotency_key, stripe_session_idempotency_key
  ) VALUES (
    'mutcmd_1', 'usr_1', 'checkout',
    '${"a".repeat(64)}', '{"plan":"pro"}',
    'agentry_customer_12345678', 'agentry_checkout_12345678'
  )`);
  await expectReject(
    check.execute(`UPDATE billing_mutation_targets SET target_json='{}' WHERE command_id='mutcmd_1'`),
    "immutable billing target update",
  );
  await expectReject(
    check.execute(`INSERT INTO billing_mutation_targets (
      command_id, user_id, operation, target_hash, target_json,
      stripe_session_idempotency_key
    ) VALUES ('bad', 'usr_1', 'checkout', '${"b".repeat(64)}', '{}', 'short')`),
    "invalid billing target",
  );
  await check.execute(`INSERT INTO billing_webhook_events (
    event_id, payload_hash, event_type, provider_created, status
  ) VALUES ('evt_1', '${"c".repeat(64)}', 'customer.subscription.updated', 100, 'applied')`);
  await expectReject(
    check.execute(`UPDATE billing_webhook_events SET status='stale' WHERE event_id='evt_1'`),
    "immutable webhook receipt update",
  );
  await check.execute(`INSERT INTO billing_subscription_cursors (
    subscription_id, user_id, last_event_created, last_event_id
  ) VALUES ('sub_1', 'usr_1', 100, 'evt_b')`);
  await expectReject(
    check.execute(`UPDATE billing_subscription_cursors
      SET last_event_created=99, last_event_id='evt_z' WHERE subscription_id='sub_1'`),
    "backward billing cursor",
  );
  await expectReject(
    check.execute(`UPDATE billing_subscription_cursors
      SET last_event_created=100, last_event_id='evt_c' WHERE subscription_id='sub_1'`),
    "same-second opaque billing cursor order",
  );
  check.close();

  const driftUrl = `file:${join(directory, "drift.sqlite")}`;
  const drift = createClient({ url: driftUrl });
  await seedPrerequisites(drift);
  await drift.execute(`CREATE TABLE account_deletion_fences (
    user_id text PRIMARY KEY, command_id text NOT NULL, created_at integer NOT NULL,
    unexpected text
  )`);
  drift.close();
  runMigration(driftUrl, true);

  console.log("billing safety migration self-test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
