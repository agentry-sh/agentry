// Add retry-safe sourcemap commands, the shared project-deletion barrier,
// release fencing, and durable R2 object inventory. The migration is
// additive/idempotent and backfills every legacy current index row before a
// replacement can hide its R2 pointer.

import { createClient, type Client } from "@libsql/client";

async function tableExists(client: Client, table: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length === 1;
}

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  if (!await tableExists(client, table)) return new Set();
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function addColumnIfMissing(
  client: Client,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await tableColumns(client, table);
  if (columns.size > 0 && !columns.has(column)) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  await client.batch([
    `CREATE TABLE IF NOT EXISTS sourcemap_release_states (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      release_id text NOT NULL,
      generation integer NOT NULL DEFAULT 0,
      version integer NOT NULL DEFAULT 0,
      updated_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sourcemap_release_states_release_idx
      ON sourcemap_release_states (project_id, release_id)`,
    `CREATE TABLE IF NOT EXISTS project_deletion_fences (
      project_id text PRIMARY KEY NOT NULL REFERENCES projects(id),
      command_id text NOT NULL,
      reason text NOT NULL CHECK (reason IN ('project_delete','account_delete')),
      actor text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE TABLE IF NOT EXISTS sourcemap_commands (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      operation text NOT NULL CHECK (operation IN ('upload','delete_release')),
      actor text NOT NULL,
      credential_id text,
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      release_id text NOT NULL,
      source_url text,
      body_hash text,
      size_bytes integer,
      r2_key text,
      sourcemap_id text,
      status text NOT NULL DEFAULT 'intent'
        CHECK (status IN ('intent','succeeded','failed','indeterminate')),
      response_json text,
      outcome_json text NOT NULL DEFAULT '{}',
      error_json text,
      version integer NOT NULL DEFAULT 0,
      lease_token text,
      lease_expires_at integer CHECK (
        (lease_token IS NULL AND lease_expires_at IS NULL) OR
        (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > 0)
      ),
      attempt_count integer NOT NULL DEFAULT 0,
      terminal_code text,
      terminal_at integer,
      snapshot_generation integer,
      snapshot_at integer,
      target_count integer NOT NULL DEFAULT 0,
      processed_count integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL DEFAULT (unixepoch()),
      updated_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `DROP INDEX IF EXISTS sourcemap_commands_project_key_idx`,
    `CREATE UNIQUE INDEX sourcemap_commands_project_key_idx
      ON sourcemap_commands (project_id, operation, idempotency_key_hash)`,
    `CREATE INDEX IF NOT EXISTS sourcemap_commands_project_time_idx
      ON sourcemap_commands (project_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS sourcemap_commands_lease_idx
      ON sourcemap_commands (lease_expires_at, terminal_at)`,
    `CREATE TABLE IF NOT EXISTS sourcemap_objects (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id),
      release_id text NOT NULL,
      source_url text NOT NULL,
      r2_key text NOT NULL,
      size_bytes integer,
      body_hash text,
      credential_id text,
      upload_command_id text,
      generation integer NOT NULL DEFAULT 0,
      state text NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved','present','indexed','cleanup_pending','deleted')),
      version integer NOT NULL DEFAULT 0,
      lease_token text,
      lease_expires_at integer CHECK (
        (lease_token IS NULL AND lease_expires_at IS NULL) OR
        (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > 0)
      ),
      cleanup_command_id text,
      delete_attempt_count integer NOT NULL DEFAULT 0,
      last_error text,
      created_at integer NOT NULL DEFAULT (unixepoch()),
      updated_at integer NOT NULL DEFAULT (unixepoch()),
      deleted_at integer
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sourcemap_objects_r2_key_idx
      ON sourcemap_objects (r2_key)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sourcemap_objects_upload_command_idx
      ON sourcemap_objects (upload_command_id)`,
    `CREATE INDEX IF NOT EXISTS sourcemap_objects_release_state_idx
      ON sourcemap_objects (project_id, release_id, generation, state)`,
    `CREATE INDEX IF NOT EXISTS sourcemap_objects_project_state_idx
      ON sourcemap_objects (project_id, state, created_at)`,
    `CREATE TABLE IF NOT EXISTS sourcemap_cleanup_outcomes (
      id text PRIMARY KEY NOT NULL,
      command_id text NOT NULL REFERENCES sourcemap_commands(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sourcemap_id text NOT NULL,
      release_id text NOT NULL,
      source_url text NOT NULL,
      r2_key text NOT NULL,
      body_hash text,
      upload_command_id text,
      object_id text,
      r2_status text NOT NULL DEFAULT 'pending'
        CHECK (r2_status IN ('pending','deleted','already_missing','failed','indeterminate')),
      db_status text NOT NULL DEFAULT 'pending'
        CHECK (db_status IN ('pending','deleted','already_missing','not_found_or_replaced')),
      last_error text,
      version integer NOT NULL DEFAULT 0,
      updated_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `DROP INDEX IF EXISTS sourcemap_cleanup_command_resource_idx`,
    `CREATE UNIQUE INDEX IF NOT EXISTS sourcemap_cleanup_command_blob_idx
      ON sourcemap_cleanup_outcomes (command_id, r2_key)`,
    `CREATE INDEX IF NOT EXISTS sourcemap_cleanup_command_idx
      ON sourcemap_cleanup_outcomes (command_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS sourcemap_cleanup_project_release_idx
      ON sourcemap_cleanup_outcomes (project_id, release_id)`,
  ], "write");

  await addColumnIfMissing(client, "sourcemap_commands", "size_bytes", "integer");
  await addColumnIfMissing(client, "sourcemap_commands", "version", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "sourcemap_commands", "lease_token", "text");
  await addColumnIfMissing(client, "sourcemap_commands", "lease_expires_at", "integer");
  await addColumnIfMissing(client, "sourcemap_commands", "attempt_count", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "sourcemap_commands", "terminal_code", "text");
  await addColumnIfMissing(client, "sourcemap_commands", "terminal_at", "integer");
  await addColumnIfMissing(client, "sourcemap_commands", "snapshot_generation", "integer");
  await addColumnIfMissing(client, "sourcemap_commands", "snapshot_at", "integer");
  await addColumnIfMissing(client, "sourcemap_commands", "target_count", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "sourcemap_commands", "processed_count", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "sourcemaps", "body_hash", "text");
  await addColumnIfMissing(client, "sourcemaps", "credential_id", "text");
  await addColumnIfMissing(client, "sourcemaps", "upload_command_id", "text");
  await addColumnIfMissing(client, "sourcemaps", "inventory_object_id", "text");
  await addColumnIfMissing(client, "sourcemap_objects", "lease_token", "text");
  await addColumnIfMissing(client, "sourcemap_objects", "lease_expires_at", "integer");
  await addColumnIfMissing(client, "sourcemap_cleanup_outcomes", "object_id", "text");
  await addColumnIfMissing(client, "sourcemap_cleanup_outcomes", "version", "integer NOT NULL DEFAULT 0");

  // Project/account deletion uses the generic mutation receipt as its durable
  // progress command. Existing one-shot mutations remain succeeded by default.
  await addColumnIfMissing(client, "mutation_commands", "status", "text NOT NULL DEFAULT 'succeeded'");
  await addColumnIfMissing(client, "mutation_commands", "version", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "mutation_commands", "lease_token", "text");
  await addColumnIfMissing(client, "mutation_commands", "lease_expires_at", "integer");
  await addColumnIfMissing(client, "mutation_commands", "attempt_count", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "mutation_commands", "target_count", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "mutation_commands", "processed_count", "integer NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "mutation_commands", "error_json", "text");
  await addColumnIfMissing(client, "mutation_commands", "updated_at", "integer NOT NULL DEFAULT 0");

  // Old partial writes may have left one half of a lease pair NULL (or an
  // invalid non-positive expiry). Normalize them to unleased before installing
  // guards; otherwise those rows would be treated as active forever and could
  // permanently stall bounded cleanup.
  for (const table of ["sourcemap_commands", "sourcemap_objects", "mutation_commands"]) {
    if (!await tableExists(client, table)) continue;
    const columns = await tableColumns(client, table);
    if (!columns.has("lease_token") || !columns.has("lease_expires_at")) continue;
    await client.execute(`UPDATE ${table}
      SET lease_token = NULL, lease_expires_at = NULL
      WHERE (lease_token IS NULL AND lease_expires_at IS NOT NULL)
         OR (lease_token IS NOT NULL AND lease_expires_at IS NULL)
         OR (lease_expires_at IS NOT NULL AND lease_expires_at <= 0)`);
    await client.batch([
      `CREATE TRIGGER IF NOT EXISTS ${table}_lease_pair_insert
       BEFORE INSERT ON ${table}
       WHEN NOT (
         (NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL) OR
         (NEW.lease_token IS NOT NULL AND NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at > 0)
       )
       BEGIN
         SELECT RAISE(ABORT, '${table} lease token/expiry must be paired');
       END`,
      `CREATE TRIGGER IF NOT EXISTS ${table}_lease_pair_update
       BEFORE UPDATE OF lease_token, lease_expires_at ON ${table}
       WHEN NOT (
         (NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL) OR
         (NEW.lease_token IS NOT NULL AND NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at > 0)
       )
       BEGIN
         SELECT RAISE(ABORT, '${table} lease token/expiry must be paired');
       END`,
    ], "write");
  }

  await client.batch([
    `UPDATE sourcemap_commands
      SET terminal_code = 'succeeded', terminal_at = COALESCE(terminal_at, updated_at)
      WHERE status = 'succeeded' AND terminal_at IS NULL`,
    `INSERT OR IGNORE INTO sourcemap_release_states
      (id, project_id, release_id, generation, version, updated_at)
      SELECT 'sourcemaprelease_' || hex(project_id) || '_' || hex(release_id),
             project_id, release_id, 0, 0, unixepoch()
      FROM sourcemaps
      GROUP BY project_id, release_id`,
    `INSERT OR IGNORE INTO sourcemap_release_states
      (id, project_id, release_id, generation, version, updated_at)
      SELECT 'sourcemaprelease_' || hex(project_id) || '_' || hex(release_id),
             project_id, release_id, 0, 0, unixepoch()
      FROM sourcemap_commands
      WHERE operation = 'upload'
      GROUP BY project_id, release_id`,
    `INSERT OR IGNORE INTO sourcemap_objects
      (id, project_id, release_id, source_url, r2_key, size_bytes, body_hash,
       credential_id, upload_command_id, generation, state, version,
       created_at, updated_at)
      SELECT 'sourcemapobject_legacy_' || hex(id), project_id, release_id,
             source_url, r2_key, size_bytes, body_hash, credential_id,
             upload_command_id, 0, 'indexed', 0, uploaded_at, uploaded_at
      FROM sourcemaps`,
    `INSERT OR IGNORE INTO sourcemap_objects
      (id, project_id, release_id, source_url, r2_key, size_bytes, body_hash,
       credential_id, upload_command_id, generation, state, version,
       created_at, updated_at)
      SELECT 'sourcemapobject_command_' || hex(id), project_id, release_id,
             source_url, r2_key, size_bytes, body_hash, credential_id, id, 0,
             CASE WHEN status = 'succeeded' THEN 'present' ELSE 'reserved' END,
             0, created_at, updated_at
      FROM sourcemap_commands
      WHERE operation = 'upload' AND source_url IS NOT NULL AND r2_key IS NOT NULL`,
    `UPDATE sourcemaps
      SET inventory_object_id = (
        SELECT id FROM sourcemap_objects WHERE sourcemap_objects.r2_key = sourcemaps.r2_key
      )
      WHERE inventory_object_id IS NULL`,
    `UPDATE sourcemap_cleanup_outcomes
      SET object_id = (
        SELECT id FROM sourcemap_objects
        WHERE sourcemap_objects.r2_key = sourcemap_cleanup_outcomes.r2_key
      )
      WHERE object_id IS NULL`,
  ], "write");

  client.close();
  console.log("sourcemap leases, release fences, and durable object inventory are ready");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
