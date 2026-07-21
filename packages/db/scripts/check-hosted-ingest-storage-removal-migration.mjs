import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-remove-hosted-ingest-storage.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-hosted-ingest-removal-"));
const url = `file:${join(directory, "hard-cut.sqlite")}`;

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

try {
  const bootstrap = createClient({ url });
  await bootstrap.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE users (id text PRIMARY KEY)",
    `CREATE TABLE projects (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      dsn_prefix text NOT NULL,
      dsn_hash text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    "CREATE INDEX projects_user_idx ON projects (user_id)",
    "CREATE UNIQUE INDEX projects_dsn_hash_idx ON projects (dsn_hash)",
    `CREATE TABLE project_secrets (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind text NOT NULL,
      secret_enc text NOT NULL,
      secret_iv text NOT NULL,
      PRIMARY KEY (project_id, kind)
    )`,
    `CREATE TABLE events (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE suppression_entries (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE sourcemap_commands (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE sourcemap_release_states (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE sourcemap_objects (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE sourcemaps (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE sourcemap_cleanup_outcomes (
      id text PRIMARY KEY,
      command_id text NOT NULL REFERENCES sourcemap_commands(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE usage_counters (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      period text NOT NULL,
      signal_type text NOT NULL,
      count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, period, signal_type)
    )`,
    `CREATE TABLE usage_snapshots (
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day text NOT NULL,
      period text NOT NULL,
      total_events integer NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )`,
    `CREATE TABLE project_posthog_bindings (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      posthog_project_id integer NOT NULL,
      posthog_project_api_key text NOT NULL,
      posthog_host text NOT NULL
    )`,
    `CREATE TRIGGER project_posthog_bindings_fenced_delete_guard
      BEFORE DELETE ON project_posthog_bindings
      BEGIN SELECT RAISE(ABORT, 'retired binding delete blocked'); END`,
    `CREATE TABLE posthog_error_capture_commands (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      payload_json text NOT NULL
    )`,
    `CREATE TABLE posthog_provision_targets (
      command_id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE _agentry_core_legacy_posthog_binding_quarantine (
      project_id text PRIMARY KEY,
      posthog_project_api_key text NOT NULL
    )`,
    `CREATE TABLE _agentry_core_legacy_posthog_binding_quarantine_receipt (
      singleton integer PRIMARY KEY,
      source_row_count integer NOT NULL
    )`,
    `CREATE TABLE project_children (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    )`,
    "INSERT INTO users (id) VALUES ('user-1')",
    `INSERT INTO projects (id, user_id, name, dsn_prefix, dsn_hash)
      VALUES ('project-1', 'user-1', 'Existing project', 'agentry_pk_old', 'old-hash')`,
    `INSERT INTO project_secrets (project_id, kind, secret_enc, secret_iv)
      VALUES ('project-1', 'dsn', 'retired-secret', 'retired-iv')`,
    `INSERT INTO events (id, project_id) VALUES ('event-1', 'project-1')`,
    `INSERT INTO suppression_entries (id, project_id) VALUES ('suppression-1', 'project-1')`,
    `INSERT INTO sourcemap_commands (id, project_id) VALUES ('sm-command-1', 'project-1')`,
    `INSERT INTO sourcemap_release_states (id, project_id) VALUES ('sm-release-1', 'project-1')`,
    `INSERT INTO sourcemap_objects (id, project_id) VALUES ('sm-object-1', 'project-1')`,
    `INSERT INTO sourcemaps (id, project_id) VALUES ('sm-1', 'project-1')`,
    `INSERT INTO sourcemap_cleanup_outcomes (id, command_id, project_id)
      VALUES ('sm-cleanup-1', 'sm-command-1', 'project-1')`,
    `INSERT INTO usage_counters (project_id, period, signal_type, count)
      VALUES ('project-1', '2026-07', 'deploys', 1)`,
    `INSERT INTO usage_snapshots (user_id, day, period, total_events)
      VALUES ('user-1', '2026-07-15', '2026-07', 1)`,
    `INSERT INTO project_posthog_bindings (
      project_id, posthog_project_id, posthog_project_api_key, posthog_host
    ) VALUES ('project-1', 42, 'phc-retired', 'https://legacy-posthog.example')`,
    `INSERT INTO posthog_error_capture_commands (id, project_id, payload_json)
      VALUES ('capture-1', 'project-1', '{"exception":"retired"}')`,
    `INSERT INTO posthog_provision_targets (command_id, project_id)
      VALUES ('provision-1', 'project-1')`,
    `INSERT INTO _agentry_core_legacy_posthog_binding_quarantine (
      project_id, posthog_project_api_key
    ) VALUES ('project-1', 'phc-quarantined')`,
    `INSERT INTO _agentry_core_legacy_posthog_binding_quarantine_receipt (
      singleton, source_row_count
    ) VALUES (1, 1)`,
    "INSERT INTO project_children (id, project_id) VALUES ('child-1', 'project-1')",
  ], "write");
  bootstrap.close();

  runMigration();
  runMigration();

  const db = createClient({ url });
  await db.execute("PRAGMA foreign_keys = ON");
  const projectColumns = await db.execute("PRAGMA table_info(projects)");
  const names = projectColumns.rows.map((row) => String(row.name));
  assert.equal(names.includes("dsn_prefix"), false);
  assert.equal(names.includes("dsn_hash"), false);

  const retiredTables = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
      'events',
      'project_secrets',
      'project_posthog_bindings',
      'posthog_error_capture_commands',
      'posthog_provision_targets',
      'usage_counters',
      'usage_snapshots',
      'suppression_entries',
      'sourcemap_cleanup_outcomes',
      'sourcemaps',
      'sourcemap_objects',
      'sourcemap_release_states',
      'sourcemap_commands',
      '_agentry_core_legacy_posthog_binding_quarantine',
      '_agentry_core_legacy_posthog_binding_quarantine_receipt'
    )`,
  );
  assert.equal(retiredTables.rows.length, 0);
  const retiredIndex = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_dsn_hash_idx'",
  );
  assert.equal(retiredIndex.rows.length, 0);

  const project = await db.execute(
    "SELECT id, user_id, name FROM projects WHERE id = 'project-1'",
  );
  assert.deepEqual(project.rows[0], {
    id: "project-1",
    user_id: "user-1",
    name: "Existing project",
  });
  const child = await db.execute(
    "SELECT project_id FROM project_children WHERE id = 'child-1'",
  );
  assert.equal(child.rows[0]?.project_id, "project-1");
  const foreignKeys = await db.execute("PRAGMA foreign_key_check");
  assert.equal(foreignKeys.rows.length, 0);
  db.close();
  console.log("hosted ingest storage removal migration checks passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
