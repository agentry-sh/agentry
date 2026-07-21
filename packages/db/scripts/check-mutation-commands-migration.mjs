import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-add-mutation-commands.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-mutation-command-migration-"));

function runMigration(databaseUrl) {
  return execFileSync(process.execPath, nodeScriptArgs(migration), {
    cwd: join(here, ".."),
    env: { ...process.env, TURSO_DATABASE_URL: databaseUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function insertCommand(client, {
  id,
  status = "intent",
  version = 0,
  leaseToken = null,
  leaseExpiresAt = null,
  attemptCount = 0,
  targetCount = 0,
  processedCount = 0,
  responseJson = "{}",
  updatedAt,
  createdAt,
}) {
  await client.execute({
    sql: `INSERT INTO mutation_commands (
      id, actor_user_id, project_id, action, idempotency_key_hash,
      request_hash, resource_type, resource_id, response_json, status,
      version, lease_token, lease_expires_at, attempt_count, target_count,
      processed_count, error_json, updated_at, created_at
    ) VALUES (?, 'user-1', 'project-1', 'project.delete', ?,
      ?, 'project', 'project-1', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    args: [
      id,
      `key-${id}`,
      `request-${id}`,
      responseJson,
      status,
      version,
      leaseToken,
      leaseExpiresAt,
      attemptCount,
      targetCount,
      processedCount,
      updatedAt,
      createdAt,
    ],
  });
}

async function rejectsUpdate(client, sql, args, pattern) {
  await assert.rejects(client.execute({ sql, args }), pattern);
}

try {
  // A fresh install must have the real unixepoch expression default and stay
  // stable across repeated migration runs.
  const freshUrl = `file:${join(directory, "fresh.db")}`;
  const freshClient = createClient({ url: freshUrl });
  runMigration(freshUrl);
  runMigration(freshUrl);
  const freshInfo = await freshClient.execute("PRAGMA table_info(mutation_commands)");
  const freshUpdatedAt = freshInfo.rows.find((row) => row.name === "updated_at");
  assert.match(String(freshUpdatedAt?.dflt_value), /unixepoch\(\)/i);
  const beforeInsert = Math.floor(Date.now() / 1_000);
  await freshClient.execute(`INSERT INTO mutation_commands (
    id, actor_user_id, action, idempotency_key_hash, request_hash,
    resource_type, response_json, created_at
  ) VALUES (
    'fresh-default', 'user-1', 'project.create', 'fresh-key',
    'fresh-request', 'project', '{}', 100
  )`);
  const freshDefault = await freshClient.execute(
    "SELECT updated_at FROM mutation_commands WHERE id = 'fresh-default'",
  );
  assert(Number(freshDefault.rows[0]?.updated_at) >= beforeInsert);
  freshClient.close();

  // Simulate the original one-shot receipt table plus the historical
  // updated_at DEFAULT 0 column. The migration must add workflow fields,
  // preserve the receipt, backfill its timestamp, and repair the default.
  const legacyUrl = `file:${join(directory, "legacy.db")}`;
  const client = createClient({ url: legacyUrl });
  await client.batch([
    "CREATE TABLE legacy_state (id text PRIMARY KEY NOT NULL)",
    "INSERT INTO legacy_state (id) VALUES ('preserved')",
    `CREATE TABLE mutation_commands (
      id text PRIMARY KEY NOT NULL,
      actor_user_id text NOT NULL,
      project_id text,
      action text NOT NULL,
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      response_json text NOT NULL DEFAULT '{}',
      updated_at integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `INSERT INTO mutation_commands (
      id, actor_user_id, project_id, action, idempotency_key_hash,
      request_hash, resource_type, resource_id, response_json,
      updated_at, created_at
    ) VALUES (
      'mutcmd_existing', 'user-1', 'project-1', 'webhook.create',
      'scoped-hash-1', 'request-hash-1', 'webhook', 'webhook-1',
      '{"id":"webhook-1"}', 0, 100
    )`,
  ], "write");

  runMigration(legacyUrl);
  runMigration(legacyUrl);

  const preserved = await client.execute(
    "SELECT response_json, status, updated_at, created_at FROM mutation_commands WHERE id = 'mutcmd_existing'",
  );
  assert.equal(preserved.rows.length, 1);
  assert.equal(preserved.rows[0]?.response_json, '{"id":"webhook-1"}');
  assert.equal(preserved.rows[0]?.status, "succeeded");
  assert.equal(Number(preserved.rows[0]?.updated_at), 100);
  assert.equal(Number(preserved.rows[0]?.created_at), 100);
  assert.equal((await client.execute("SELECT id FROM legacy_state")).rows.length, 1);

  const repairedInfo = await client.execute("PRAGMA table_info(mutation_commands)");
  assert.match(
    String(repairedInfo.rows.find((row) => row.name === "updated_at")?.dflt_value),
    /unixepoch\(\)/i,
  );

  const now = Math.floor(Date.now() / 1_000);
  await insertCommand(client, {
    id: "workflow",
    targetCount: 3,
    updatedAt: now - 100,
    createdAt: now - 100,
  });

  // Exact authority/evidence/resource identity is frozen even when the rest of
  // the attempted write is a valid intent -> in_progress lease transition.
  const immutableUpdates = [
    ["id", "rewritten-id"],
    ["actor_user_id", "user-2"],
    ["project_id", null],
    ["action", "account.self_delete"],
    ["idempotency_key_hash", "different-key"],
    ["request_hash", "different-request"],
    ["resource_type", "account"],
    ["resource_id", "project-2"],
    ["created_at", now - 101],
  ];
  for (const [column, value] of immutableUpdates) {
    await rejectsUpdate(client, `UPDATE mutation_commands SET
        ${column} = ?, status = 'in_progress', version = 1,
        lease_token = 'immutable-test', lease_expires_at = ?,
        attempt_count = 1, updated_at = ?
      WHERE id = 'workflow'`, [value, now + 600, now - 99], /immutable/i);
  }

  // The complete supported recovery path. Progress may rewrite its bounded
  // response only while releasing a lease; every re-acquisition preserves it.
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'in_progress', version = 1, lease_token = 'lease-1',
      lease_expires_at = ?, attempt_count = 1, updated_at = ?
      WHERE id = 'workflow'`,
    args: [now + 600, now - 99],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'in_progress', version = 2, lease_token = NULL,
      lease_expires_at = NULL, target_count = 4, processed_count = 1,
      response_json = '{"phase":"page-1"}', updated_at = ?
      WHERE id = 'workflow'`,
    args: [now - 98],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'in_progress', version = 3, lease_token = 'lease-2',
      lease_expires_at = ?, attempt_count = 2, updated_at = ?
      WHERE id = 'workflow'`,
    args: [now + 600, now - 97],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'failed', version = 4, lease_token = NULL,
      lease_expires_at = NULL, response_json = '{"phase":"failed"}',
      error_json = '{"code":"provider_rejected"}', updated_at = ?
      WHERE id = 'workflow'`,
    args: [now - 96],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'in_progress', version = 5, lease_token = 'lease-3',
      lease_expires_at = ?, attempt_count = 3, updated_at = ?
      WHERE id = 'workflow'`,
    args: [now + 600, now - 95],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'indeterminate', version = 6, lease_token = NULL,
      lease_expires_at = NULL, response_json = '{"phase":"unknown"}',
      error_json = '{"code":"provider_unknown"}', updated_at = ?
      WHERE id = 'workflow'`,
    args: [now - 94],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'in_progress', version = 7, lease_token = 'lease-4',
      lease_expires_at = ?, attempt_count = 4, updated_at = ?
      WHERE id = 'workflow'`,
    args: [now + 600, now - 93],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET
      status = 'succeeded', version = 8, lease_token = NULL,
      lease_expires_at = NULL, processed_count = 4,
      response_json = '{"phase":"complete"}', error_json = NULL,
      updated_at = ? WHERE id = 'workflow'`,
    args: [now - 92],
  });
  const complete = (await client.execute(
    "SELECT status, version, attempt_count, target_count, processed_count FROM mutation_commands WHERE id = 'workflow'",
  )).rows[0];
  assert.deepEqual(
    {
      status: complete?.status,
      version: Number(complete?.version),
      attemptCount: Number(complete?.attempt_count),
      targetCount: Number(complete?.target_count),
      processedCount: Number(complete?.processed_count),
    },
    { status: "succeeded", version: 8, attemptCount: 4, targetCount: 4, processedCount: 4 },
  );
  await rejectsUpdate(client, `UPDATE mutation_commands
    SET response_json = '{}', version = 9, updated_at = ? WHERE id = 'workflow'`,
  [now - 91], /terminal/i);

  // An expired in-progress lease can be recovered; an active one cannot be
  // stolen or silently extended with the same attempt.
  await insertCommand(client, {
    id: "expired-lease",
    responseJson: '{"phase":"saved"}',
    updatedAt: now - 10,
    createdAt: now - 20,
  });
  const shortLeaseExpiry = Math.floor(Date.now() / 1_000) + 1;
  await client.execute({
    sql: `UPDATE mutation_commands SET status = 'in_progress', version = 1,
      lease_token = 'expired-token', lease_expires_at = ?, attempt_count = 1,
      updated_at = ? WHERE id = 'expired-lease'`,
    args: [shortLeaseExpiry, now - 9],
  });
  while (Math.floor(Date.now() / 1_000) < shortLeaseExpiry) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await client.execute({
    sql: `UPDATE mutation_commands SET version = 2, lease_token = 'replacement-token',
      lease_expires_at = ?, attempt_count = 2, updated_at = ?
      WHERE id = 'expired-lease'`,
    args: [Math.floor(Date.now() / 1_000) + 600, Math.floor(Date.now() / 1_000)],
  });

  await insertCommand(client, {
    id: "active-lease",
    updatedAt: now - 10,
    createdAt: now - 20,
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET status = 'in_progress', version = 1,
      lease_token = 'active-token', lease_expires_at = ?, attempt_count = 1,
      updated_at = ? WHERE id = 'active-lease'`,
    args: [now + 600, now - 9],
  });
  await rejectsUpdate(client, `UPDATE mutation_commands SET
    version = 2, lease_token = 'stolen-token', lease_expires_at = ?,
    attempt_count = 2, updated_at = ? WHERE id = 'active-lease'`,
  [now + 700, now], /active.*lease/i);
  await rejectsUpdate(client, `UPDATE mutation_commands SET
    version = 2, lease_expires_at = ?, updated_at = ? WHERE id = 'active-lease'`,
  [now + 700, now], /acquire or release/i);

  // Recovery cannot change the durable response under cover of a new lease.
  await insertCommand(client, {
    id: "failed-response",
    responseJson: '{"provider_id":"original"}',
    updatedAt: now - 10,
    createdAt: now - 20,
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET status = 'in_progress', version = 1,
      lease_token = 'failed-response-lease', lease_expires_at = ?,
      attempt_count = 1, updated_at = ? WHERE id = 'failed-response'`,
    args: [now + 600, now - 9],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET status = 'failed', version = 2,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = 'failed-response'`,
    args: [now - 8],
  });
  await rejectsUpdate(client, `UPDATE mutation_commands SET
    status = 'in_progress', version = 3, lease_token = 'retry-token',
    lease_expires_at = ?, attempt_count = 2,
    response_json = '{"provider_id":"rewritten"}', updated_at = ?
    WHERE id = 'failed-response'`, [now + 600, now], /cannot rewrite/i);

  // Status edges outside the explicit matrix fail closed.
  await insertCommand(client, {
    id: "invalid-intent-terminal",
    updatedAt: now - 10,
    createdAt: now - 20,
  });
  await rejectsUpdate(client, `UPDATE mutation_commands SET
    status = 'failed', version = 1, updated_at = ?
    WHERE id = 'invalid-intent-terminal'`, [now], /status transition/i);
  await insertCommand(client, {
    id: "invalid-failed-success",
    updatedAt: now - 10,
    createdAt: now - 20,
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET status = 'in_progress', version = 1,
      lease_token = 'invalid-failed-lease', lease_expires_at = ?,
      attempt_count = 1, updated_at = ? WHERE id = 'invalid-failed-success'`,
    args: [now + 600, now - 9],
  });
  await client.execute({
    sql: `UPDATE mutation_commands SET status = 'failed', version = 2,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = 'invalid-failed-success'`,
    args: [now - 8],
  });
  await rejectsUpdate(client, `UPDATE mutation_commands SET
    status = 'succeeded', version = 3, updated_at = ?
    WHERE id = 'invalid-failed-success'`, [now], /status transition/i);

  // CAS and progress counters must advance exactly and never regress.
  for (const [id, setClause, args, pattern] of [
    ["bad-version", "version = 2, lease_token = 'v', lease_expires_at = ?, attempt_count = 1", [now + 600], /version/i],
    ["bad-attempt", "version = 1, lease_token = 'a', lease_expires_at = ?, attempt_count = 0", [now + 600], /attempt/i],
    ["bad-target", "version = 1, lease_token = 't', lease_expires_at = ?, attempt_count = 1, target_count = 1", [now + 600], /counters/i],
    ["bad-processed", "version = 1, lease_token = 'p', lease_expires_at = ?, attempt_count = 1, processed_count = 4", [now + 600], /counters/i],
    ["bad-lease-pair", "version = 1, lease_token = 'pair', lease_expires_at = NULL, attempt_count = 1", [], /set or cleared together/i],
  ]) {
    await insertCommand(client, {
      id,
      targetCount: id === "bad-target" ? 2 : 3,
      processedCount: id === "bad-processed" ? 1 : 0,
      updatedAt: now - 10,
      createdAt: now - 20,
    });
    await rejectsUpdate(client, `UPDATE mutation_commands SET
      status = 'in_progress', ${setClause}, updated_at = ? WHERE id = ?`,
    [...args, now, id], pattern);
  }

  await assert.rejects(
    client.execute(`INSERT INTO mutation_commands (
      id, actor_user_id, action, idempotency_key_hash, request_hash,
      resource_type, response_json
    ) VALUES (
      'mutcmd_duplicate', 'user-1', 'webhook.create', 'scoped-hash-1',
      'request-hash-1', 'webhook', '{}'
    )`),
    /UNIQUE/,
  );
  await assert.rejects(
    client.execute(`INSERT INTO mutation_commands (
      id, actor_user_id, action, idempotency_key_hash, request_hash,
      resource_type, response_json
    ) VALUES (
      'mutcmd_null', NULL, 'project.create', 'scoped-hash-null',
      'request-hash-null', 'project', '{}'
    )`),
    /NOT NULL/,
  );
  await assert.rejects(
    client.execute(`INSERT INTO mutation_commands (
      id, actor_user_id, action, idempotency_key_hash, request_hash,
      resource_type, response_json, lease_token
    ) VALUES (
      'mutcmd_bad_lease', 'user-1', 'project.delete', 'bad-lease-key',
      'bad-lease-request', 'project', '{}', 'unpaired-token'
    )`),
    /initial mutation command cannot hold a lease|CHECK constraint/i,
  );
  for (const [id, columns, values, pattern] of [
    ["mutcmd_bad_status", "status", "'unknown'", /initial.*status/i],
    ["mutcmd_initial_in_progress", "status", "'in_progress'", /initial.*status/i],
    ["mutcmd_initial_failed", "status", "'failed'", /initial.*status/i],
    ["mutcmd_initial_indeterminate", "status", "'indeterminate'", /initial.*status/i],
    ["mutcmd_bad_version", "version", "1", /version.*attempt/i],
    ["mutcmd_bad_version_type", "version", "'not-an-integer'", /version.*attempt/i],
    ["mutcmd_bad_attempt", "attempt_count", "1", /version.*attempt/i],
    ["mutcmd_bad_target", "target_count", "-1", /initial.*counters/i],
    ["mutcmd_bad_counter_type", "target_count", "'not-an-integer'", /initial.*counters/i],
    ["mutcmd_bad_processed", "target_count, processed_count", "1, 2", /initial.*counters/i],
    ["mutcmd_bad_timestamp", "updated_at, created_at", "99, 100", /timestamps/i],
    ["mutcmd_bad_timestamp_type", "updated_at, created_at", "'later', 'earlier'", /timestamps/i],
    [
      "mutcmd_terminal_lease",
      "status, lease_token, lease_expires_at",
      "'succeeded', 'terminal-token', 9999999999",
      /initial mutation command cannot hold a lease/i,
    ],
  ]) {
    await assert.rejects(
      client.execute(`INSERT INTO mutation_commands (
        id, actor_user_id, action, idempotency_key_hash, request_hash,
        resource_type, response_json, ${columns}
      ) VALUES (
        '${id}', 'user-1', 'project.delete', '${id}-key', '${id}-request',
        'project', '{}', ${values}
      )`),
      pattern,
    );
  }

  const indexes = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mutation_commands'",
  );
  const indexNames = new Set(indexes.rows.map((row) => String(row.name)));
  assert(indexNames.has("mutation_commands_idempotency_idx"));
  assert(indexNames.has("mutation_commands_actor_time_idx"));
  assert(indexNames.has("mutation_commands_project_time_idx"));

  const triggers = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mutation_commands'",
  );
  assert.deepEqual(
    new Set(triggers.rows.map((row) => String(row.name))),
    new Set([
      "mutation_commands_immutable_update_guard",
      "mutation_commands_insert_guard",
      "mutation_commands_progress_update_guard",
    ]),
  );

  client.close();
  console.log(
    "mutation command migration is twice-idempotent, timestamp-canonical, authority-frozen, and transition-guarded",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
