import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";

const dir = mkdtempSync(join(tmpdir(), "agentry-webhook-migration-"));
const file = join(dir, "migration.db");
const url = `file:${file}`;
const client = createClient({ url });

try {
  await client.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE users (id text PRIMARY KEY)",
    "CREATE TABLE projects (id text PRIMARY KEY, user_id text REFERENCES users(id))",
    `CREATE TABLE cases (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id),
      fingerprint text NOT NULL
    )`,
    `CREATE TABLE webhooks (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      active integer NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE webhook_deliveries (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      webhook_id text REFERENCES webhooks(id) ON DELETE SET NULL,
      event text NOT NULL,
      payload_json text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempt_count integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 8,
      next_attempt_at integer NOT NULL DEFAULT (unixepoch()),
      locked_at integer,
      locked_by text,
      last_attempt_at integer,
      delivered_at integer,
      last_status_code integer,
      last_error text,
      created_at integer NOT NULL DEFAULT (unixepoch()),
      updated_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    "INSERT INTO users (id) VALUES ('user_1')",
    "INSERT INTO projects (id, user_id) VALUES ('project_1', 'user_1')",
    "INSERT INTO webhooks (id, project_id) VALUES ('webhook_1', 'project_1')",
    `INSERT INTO webhook_deliveries (
      id, project_id, webhook_id, event, payload_json
    ) VALUES ('delivery_legacy', 'project_1', 'webhook_1', 'case.created', '{}')`,
  ], "write");

  runMigration();
  runMigration();

  const columns = await client.execute("PRAGMA table_info(webhook_deliveries)");
  const columnNames = new Set(columns.rows.map((row) => String(row.name)));
  assert(columnNames.has("source_event_id"));
  assert(columnNames.has("source_event_hash"));

  const commandColumns = await client.execute("PRAGMA table_info(case_mutation_commands)");
  const commandColumnNames = new Set(commandColumns.rows.map((row) => String(row.name)));
  assert(commandColumnNames.has("idempotency_key_hash"));
  assert(commandColumnNames.has("request_hash"));
  assert(commandColumnNames.has("committed_revision"));
  assert(commandColumnNames.has("response_json"));

  await client.execute(
    "INSERT INTO cases (id, project_id, fingerprint) VALUES ('case_1', 'project_1', 'fingerprint_1')",
  );
  await client.execute(`INSERT INTO case_mutation_commands (
    id, project_id, case_id, actor_user_id, idempotency_key_hash,
    request_hash, expected_revision, committed_revision, response_json
  ) VALUES (
    'casecmd_1', 'project_1', 'case_1', 'user_1', 'key_hash_1',
    'request_hash_1', 1, 2, '{}'
  )`);
  await assert.rejects(
    client.execute(`INSERT INTO case_mutation_commands (
      id, project_id, case_id, actor_user_id, idempotency_key_hash,
      request_hash, expected_revision, committed_revision, response_json
    ) VALUES (
      'casecmd_2', 'project_1', 'case_1', 'user_1', 'key_hash_1',
      'request_hash_2', 2, 3, '{}'
    )`),
    /UNIQUE constraint failed/i,
  );

  const recipientSetTable = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_recipient_sets'",
  );
  assert.equal(recipientSetTable.rows[0]?.name, "webhook_recipient_sets");

  const legacy = await client.execute(
    "SELECT source_event_id, source_event_hash FROM webhook_deliveries WHERE id = 'delivery_legacy'",
  );
  assert.equal(legacy.rows[0]?.source_event_id, "legacy:delivery_legacy");
  assert.equal(legacy.rows[0]?.source_event_hash, "legacy:delivery_legacy");

  await client.execute({
    sql: `INSERT INTO webhook_deliveries (
      id, project_id, webhook_id, source_event_id, source_event_hash,
      event, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "delivery_new",
      "project_1",
      "webhook_1",
      "case:event_1:created",
      "hash_1",
      "case.created",
      "{}",
    ],
  });

  await client.execute({
    sql: `INSERT INTO webhook_recipient_sets (
      id, project_id, source_event_id, source_event_hash, event, webhook_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      "recipient_set_1",
      "project_1",
      "case:event_1:created",
      "hash_1",
      "case.created",
      '["webhook_1"]',
    ],
  });
  await assert.rejects(
    client.execute({
      sql: `INSERT INTO webhook_recipient_sets (
        id, project_id, source_event_id, source_event_hash, event, webhook_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        "recipient_set_duplicate",
        "project_1",
        "case:event_1:created",
        "hash_1",
        "case.created",
        "[]",
      ],
    }),
    /UNIQUE constraint failed/i,
  );

  await client.execute("UPDATE webhooks SET active = 0 WHERE id = 'webhook_1'");
  await client.execute({
    sql: `INSERT INTO webhook_deliveries (
      id, project_id, webhook_id, source_event_id, source_event_hash,
      event, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "delivery_after_disable",
      "project_1",
      "webhook_1",
      "case:event_2:created",
      "hash_2",
      "case.created",
      "{}",
    ],
  });
  const disabledDelivery = await client.execute(
    "SELECT status, last_error FROM webhook_deliveries WHERE id = 'delivery_after_disable'",
  );
  assert.equal(disabledDelivery.rows[0]?.status, "cancelled");
  assert.equal(disabledDelivery.rows[0]?.last_error, "webhook_inactive_at_enqueue");

  await assert.rejects(
    client.execute({
      sql: `INSERT INTO webhook_deliveries (
        id, project_id, webhook_id, source_event_id, source_event_hash,
        event, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        "delivery_duplicate",
        "project_1",
        "webhook_1",
        "case:event_1:created",
        "hash_1",
        "case.created",
        "{}",
      ],
    }),
    /UNIQUE constraint failed/i,
  );

  await assert.rejects(
    client.execute(`INSERT INTO webhook_deliveries (
      id, project_id, webhook_id, event, payload_json
    ) VALUES ('delivery_missing_source', 'project_1', 'webhook_1', 'case.created', '{}')`),
    /source event identity is required/i,
  );

  console.log("webhook outbox source-event migration is additive, idempotent, and enforced");
} finally {
  client.close();
  rmSync(dir, { recursive: true, force: true });
}

function runMigration() {
  const result = spawnSync(
    process.execPath,
    ["scripts/migrate-add-automation-foundations.ts"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        TURSO_DATABASE_URL: url,
        TURSO_AUTH_TOKEN: "",
      },
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `migration failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}
