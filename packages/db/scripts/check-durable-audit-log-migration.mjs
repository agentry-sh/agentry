import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-durable-audit-log.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-audit-migration-"));
const databaseUrl = `file:${join(directory, "legacy.db")}`;

try {
  const client = createClient({ url: databaseUrl });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.batch([
    "CREATE TABLE users (id text PRIMARY KEY NOT NULL)",
    "CREATE TABLE projects (id text PRIMARY KEY NOT NULL)",
    `CREATE TABLE audit_log (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id text REFERENCES projects(id) ON DELETE SET NULL,
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      summary text,
      metadata_json text,
      ip text,
      ua text,
      at integer NOT NULL DEFAULT (unixepoch())
    )`,
    "INSERT INTO users (id) VALUES ('user-1')",
    "INSERT INTO projects (id) VALUES ('project-1')",
    `INSERT INTO audit_log (
      id, user_id, project_id, action, resource_type, resource_id, summary,
      metadata_json, at
    ) VALUES (
      'audit-intent', 'user-1', 'project-1', 'feature_flag.created',
      'feature_flag', 'checkout', 'Create checkout flag',
      '{"$agentry_audit":{"operation_id":"op-1","request_hash":"hash-1","phase":"intent"}}',
      100
    )`,
    `INSERT INTO audit_log (
      id, user_id, project_id, action, resource_type, resource_id, summary,
      metadata_json, at
    ) VALUES (
      'audit-legacy', 'user-1', 'project-1', 'publication.minted',
      'publication', 'publication-1', 'Legacy completed row', '{}', 101
    )`,
  ], "write");

  const runMigration = () => execFileSync(process.execPath, nodeScriptArgs(migration), {
    cwd: join(here, ".."),
    env: { ...process.env, TURSO_DATABASE_URL: databaseUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  runMigration();
  runMigration();

  const columns = await client.execute("PRAGMA table_info(audit_log)");
  const names = new Set(columns.rows.map((row) => String(row.name)));
  for (const column of ["operation_id", "request_hash", "phase", "occurred_at_ms"]) {
    assert(names.has(column), `missing ${column}`);
  }
  const foreignKeys = await client.execute("PRAGMA foreign_key_list(audit_log)");
  assert.equal(foreignKeys.rows.length, 0, "destructive audit foreign keys remain");

  const migrated = await client.execute(
    "SELECT id, project_id, operation_id, request_hash, phase, occurred_at_ms FROM audit_log ORDER BY id",
  );
  const intent = migrated.rows.find((row) => row.id === "audit-intent");
  const legacy = migrated.rows.find((row) => row.id === "audit-legacy");
  assert.equal(intent?.operation_id, "op-1");
  assert.equal(intent?.phase, "intent");
  assert.equal(Number(intent?.occurred_at_ms), 100_000);
  assert.equal(legacy?.operation_id, "legacy:audit-legacy");
  assert.equal(legacy?.request_hash, "legacy:audit-legacy");
  assert.equal(legacy?.phase, "succeeded");

  await client.execute("DELETE FROM projects WHERE id = 'project-1'");
  await client.execute("DELETE FROM users WHERE id = 'user-1'");
  const tombstones = await client.execute(
    "SELECT user_id, project_id FROM audit_log ORDER BY id",
  );
  assert.equal(tombstones.rows.length, 2);
  assert(tombstones.rows.every((row) => row.user_id === "user-1"));
  assert(tombstones.rows.every((row) => row.project_id === "project-1"));

  await assert.rejects(
    client.execute("UPDATE audit_log SET summary = 'rewritten' WHERE id = 'audit-intent'"),
    /append-only/,
  );
  await client.execute(`INSERT INTO audit_log (
    id, user_id, project_id, operation_id, request_hash, phase, action,
    resource_type, at, occurred_at_ms
  ) VALUES (
    'audit-recent', 'user-recent', 'project-recent', 'op-recent',
    'hash-recent', 'succeeded', 'retention.recent', 'audit', unixepoch(),
    unixepoch() * 1000
  )`);
  await assert.rejects(
    client.execute("DELETE FROM audit_log WHERE id = 'audit-recent'"),
    /90 days/,
  );
  await client.execute(`INSERT INTO audit_log (
    id, user_id, project_id, operation_id, request_hash, phase, action,
    resource_type, at, occurred_at_ms
  ) VALUES (
    'audit-expired', 'user-old', 'project-old', 'op-old', 'hash-old',
    'succeeded', 'retention.expired', 'audit', unixepoch() - 7776001,
    (unixepoch() - 7776001) * 1000
  )`);
  await client.execute("DELETE FROM audit_log WHERE id = 'audit-expired'");

  const operationIndex = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'audit_operation_phase_idx'",
  );
  assert.equal(operationIndex.rows.length, 1);
  client.close();
  console.log("durable audit migration is idempotent, tombstone-safe, append-only, and retention-bounded");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
