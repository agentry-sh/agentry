import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-add-sourcemap-commands.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-sourcemap-command-migration-"));
const databaseUrl = `file:${join(directory, "legacy.db")}`;

let client;

async function scalar(sql, args = []) {
  const result = await client.execute({ sql, args });
  return Number(result.rows[0]?.value ?? 0);
}

async function inventoryCounts() {
  return {
    projects: await scalar("SELECT COUNT(*) AS value FROM projects"),
    currentIndexes: await scalar("SELECT COUNT(*) AS value FROM sourcemaps"),
    releaseStates: await scalar("SELECT COUNT(*) AS value FROM sourcemap_release_states"),
    commands: await scalar("SELECT COUNT(*) AS value FROM sourcemap_commands"),
    objects: await scalar("SELECT COUNT(*) AS value FROM sourcemap_objects"),
    outcomes: await scalar("SELECT COUNT(*) AS value FROM sourcemap_cleanup_outcomes"),
  };
}

try {
  client = createClient({ url: databaseUrl });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.batch([
    "CREATE TABLE projects (id text PRIMARY KEY NOT NULL)",
    `CREATE TABLE sourcemaps (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release_id text NOT NULL,
      source_url text NOT NULL,
      r2_key text NOT NULL,
      size_bytes integer NOT NULL,
      uploaded_at integer NOT NULL
    )`,
    `CREATE UNIQUE INDEX sourcemaps_lookup_idx
      ON sourcemaps (project_id, release_id, source_url)`,
    "INSERT INTO projects (id) VALUES ('project-delete'), ('project-survivor')",
    `INSERT INTO sourcemaps
      (id, project_id, release_id, source_url, r2_key, size_bytes, uploaded_at)
     VALUES
      ('legacy-a', 'project-delete', 'release-1', '/assets/a.js',
       'sourcemaps/project-delete/release-1/legacy-a.map', 101, 1001),
      ('legacy-b', 'project-delete', 'release-1', '/assets/b.js',
       'sourcemaps/project-delete/release-1/legacy-b.map', 202, 1002),
      ('legacy-c', 'project-survivor', 'release-2', '/assets/c.js',
       'sourcemaps/project-survivor/release-2/legacy-c.map', 303, 1003)`,
  ], "write");

  const legacyRows = (await client.execute(`
    SELECT id, project_id, release_id, source_url, r2_key, size_bytes, uploaded_at
    FROM sourcemaps
    ORDER BY id
  `)).rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    releaseId: String(row.release_id),
    sourceUrl: String(row.source_url),
    r2Key: String(row.r2_key),
    sizeBytes: Number(row.size_bytes),
    uploadedAt: Number(row.uploaded_at),
  }));

  const runMigration = () => execFileSync(process.execPath, nodeScriptArgs(migration), {
    cwd: join(here, ".."),
    env: { ...process.env, TURSO_DATABASE_URL: databaseUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  runMigration();

  // The migration must preserve every legacy pointer in canonical inventory
  // before a later immutable upload can replace the current sourcemaps row.
  for (const legacy of legacyRows) {
    const result = await client.execute({
      sql: `SELECT
          sm.inventory_object_id,
          obj.id AS object_id,
          obj.project_id,
          obj.release_id,
          obj.source_url,
          obj.r2_key,
          obj.size_bytes,
          obj.state,
          obj.created_at,
          obj.updated_at
        FROM sourcemaps AS sm
        JOIN sourcemap_objects AS obj ON obj.id = sm.inventory_object_id
        WHERE sm.id = ?`,
      args: [legacy.id],
    });
    assert.equal(result.rows.length, 1, `missing inventory for ${legacy.id}`);
    const row = result.rows[0];
    assert.equal(row.inventory_object_id, row.object_id);
    assert.equal(row.project_id, legacy.projectId);
    assert.equal(row.release_id, legacy.releaseId);
    assert.equal(row.source_url, legacy.sourceUrl);
    assert.equal(row.r2_key, legacy.r2Key);
    assert.equal(Number(row.size_bytes), legacy.sizeBytes);
    assert.equal(row.state, "indexed");
    assert.equal(Number(row.created_at), legacy.uploadedAt);
    assert.equal(Number(row.updated_at), legacy.uploadedAt);
  }
  assert.equal(await scalar("SELECT COUNT(*) AS value FROM sourcemap_objects"), legacyRows.length);

  // A malformed half-lease must never become an immortal busy row. Fresh
  // writes are rejected by migration-installed guards; valid pairs can still
  // be acquired and cleared normally.
  await assert.rejects(
    client.execute(`UPDATE sourcemap_objects
      SET lease_token = 'orphan-token', lease_expires_at = NULL
      WHERE id = (SELECT id FROM sourcemap_objects ORDER BY id LIMIT 1)`),
    /lease token\/expiry must be paired|CHECK constraint failed/i,
  );
  await client.execute(`UPDATE sourcemap_objects
    SET lease_token = 'valid-token', lease_expires_at = 9999999999
    WHERE id = (SELECT id FROM sourcemap_objects ORDER BY id LIMIT 1)`);
  await client.execute(`UPDATE sourcemap_objects
    SET lease_token = NULL, lease_expires_at = NULL
    WHERE id = (SELECT id FROM sourcemap_objects ORDER BY id LIMIT 1)`);

  const afterFirstRun = await inventoryCounts();
  runMigration();
  assert.deepEqual(await inventoryCounts(), afterFirstRun, "second migration run duplicated state");

  // Simulate an immutable replacement: the current index advances to a new
  // command-specific object while the legacy R2 pointer remains inventoried.
  await client.batch([
    `INSERT INTO sourcemap_commands (
      id, project_id, operation, actor, credential_id, idempotency_key_hash,
      request_hash, release_id, source_url, body_hash, size_bytes, r2_key,
      sourcemap_id, status, response_json, outcome_json, terminal_code,
      terminal_at, created_at, updated_at
    ) VALUES (
      'replace-command', 'project-delete', 'upload', 'ci:credential-1',
      'credential-1', 'replacement-idempotency', 'replacement-request',
      'release-1', '/assets/a.js', 'replacement-body', 111,
      'sourcemaps/project-delete/release-1/replace-command.map',
      'legacy-a', 'succeeded', '{}', '{}', 'succeeded', 2001, 2000, 2001
    )`,
    `INSERT INTO sourcemap_objects (
      id, project_id, release_id, source_url, r2_key, size_bytes, body_hash,
      credential_id, upload_command_id, generation, state, version,
      created_at, updated_at
    ) VALUES (
      'replacement-object', 'project-delete', 'release-1', '/assets/a.js',
      'sourcemaps/project-delete/release-1/replace-command.map', 111,
      'replacement-body', 'credential-1', 'replace-command', 0, 'indexed',
      1, 2000, 2001
    )`,
    `UPDATE sourcemaps
      SET r2_key = 'sourcemaps/project-delete/release-1/replace-command.map',
          size_bytes = 111,
          body_hash = 'replacement-body',
          credential_id = 'credential-1',
          upload_command_id = 'replace-command',
          inventory_object_id = 'replacement-object',
          uploaded_at = 2001
      WHERE id = 'legacy-a'`,
  ], "write");

  await assert.rejects(
    client.execute(`UPDATE sourcemap_commands
      SET lease_token = 'orphan-command-token', lease_expires_at = NULL
      WHERE id = 'replace-command'`),
    /lease token\/expiry must be paired|CHECK constraint failed/i,
  );

  const oldObject = await client.execute(`
    SELECT state, r2_key
    FROM sourcemap_objects
    WHERE r2_key = 'sourcemaps/project-delete/release-1/legacy-a.map'
  `);
  assert.equal(oldObject.rows.length, 1);
  assert.equal(oldObject.rows[0]?.state, "indexed");

  const replacementIndex = await client.execute(`
    SELECT r2_key, inventory_object_id, upload_command_id
    FROM sourcemaps
    WHERE id = 'legacy-a'
  `);
  assert.equal(replacementIndex.rows[0]?.inventory_object_id, "replacement-object");
  assert.equal(replacementIndex.rows[0]?.upload_command_id, "replace-command");

  // Reconcile cleanup of only the superseded object. Its durable tombstone
  // must not remove or rewrite the current replacement pointer.
  await client.execute(`
    UPDATE sourcemap_objects
    SET state = 'deleted', version = version + 1, deleted_at = 2100, updated_at = 2100
    WHERE r2_key = 'sourcemaps/project-delete/release-1/legacy-a.map'
  `);
  assert.equal((await client.execute(`
    SELECT inventory_object_id FROM sourcemaps WHERE id = 'legacy-a'
  `)).rows[0]?.inventory_object_id, "replacement-object");
  assert.equal((await client.execute(`
    SELECT state FROM sourcemap_objects
    WHERE r2_key = 'sourcemaps/project-delete/release-1/legacy-a.map'
  `)).rows[0]?.state, "deleted");

  // Purging a reconciled old tombstone is insufficient while any project
  // object is still active: the inventory FK must fence project deletion.
  await client.execute(`
    DELETE FROM sourcemap_objects
    WHERE project_id = 'project-delete' AND state = 'deleted'
  `);
  await assert.rejects(
    client.execute("DELETE FROM projects WHERE id = 'project-delete'"),
    /FOREIGN KEY constraint failed/i,
  );

  // Even after all R2 objects are durably terminal, tombstones deliberately
  // continue to block project deletion until the final inventory purge.
  await client.batch([
    `DELETE FROM sourcemaps WHERE project_id = 'project-delete'`,
    `UPDATE sourcemap_objects
      SET state = 'deleted', version = version + 1, deleted_at = 2200, updated_at = 2200
      WHERE project_id = 'project-delete'`,
  ], "write");
  assert.equal(await scalar(`
    SELECT COUNT(*) AS value FROM sourcemap_objects
    WHERE project_id = 'project-delete' AND state <> 'deleted'
  `), 0);
  await assert.rejects(
    client.execute("DELETE FROM projects WHERE id = 'project-delete'"),
    /FOREIGN KEY constraint failed/i,
  );

  await client.execute(`
    DELETE FROM sourcemap_objects
    WHERE project_id = 'project-delete' AND state = 'deleted'
  `);
  await client.execute("DELETE FROM projects WHERE id = 'project-delete'");
  assert.equal(await scalar(`
    SELECT COUNT(*) AS value FROM projects WHERE id = 'project-delete'
  `), 0);

  // A later production rerun must neither resurrect the deleted project nor
  // duplicate the surviving project's legacy inventory.
  const beforeFinalRun = await inventoryCounts();
  runMigration();
  assert.deepEqual(await inventoryCounts(), beforeFinalRun, "later migration rerun changed stable state");
  assert.equal(beforeFinalRun.projects, 1);
  assert.equal(beforeFinalRun.currentIndexes, 1);
  assert.equal(beforeFinalRun.releaseStates, 1);
  assert.equal(beforeFinalRun.objects, 1);
  assert.equal((await client.execute(`
    SELECT obj.r2_key, obj.state
    FROM sourcemaps AS sm
    JOIN sourcemap_objects AS obj ON obj.id = sm.inventory_object_id
    WHERE sm.id = 'legacy-c'
  `)).rows[0]?.state, "indexed");

  console.log(
    "sourcemap command migration is additive, twice-idempotent, legacy-complete, replacement-safe, cleanup-safe, and deletion-fenced",
  );
} finally {
  client?.close();
  rmSync(directory, { recursive: true, force: true });
}
