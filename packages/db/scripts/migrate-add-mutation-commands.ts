// Additive, idempotent migration for generic owner-mutation command receipts.
// Raw secrets never belong in this table; response_json is non-secret and
// resource-specific encrypted stores retain recoverable public/signing keys.

import { createClient, type Client } from "@libsql/client";

const TABLE = "mutation_commands";
const REBUILD_TABLE = "mutation_commands_rebuild";
const IMMUTABLE_TRIGGER = "mutation_commands_immutable_update_guard";
const PROGRESS_TRIGGER = "mutation_commands_progress_update_guard";
const INSERT_TRIGGER = "mutation_commands_insert_guard";
const LEGACY_LEASE_INSERT_TRIGGER = "mutation_commands_lease_pair_insert_guard";

const CANONICAL_COLUMNS = [
  "id",
  "actor_user_id",
  "project_id",
  "action",
  "idempotency_key_hash",
  "request_hash",
  "resource_type",
  "resource_id",
  "response_json",
  "status",
  "version",
  "lease_token",
  "lease_expires_at",
  "attempt_count",
  "target_count",
  "processed_count",
  "error_json",
  "updated_at",
  "created_at",
] as const;

function createTableSql(table: string): string {
  return `CREATE TABLE ${table} (
    id text PRIMARY KEY NOT NULL,
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
    lease_expires_at integer CHECK (
      (lease_token IS NULL AND lease_expires_at IS NULL) OR
      (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > 0)
    ),
    attempt_count integer NOT NULL DEFAULT 0,
    target_count integer NOT NULL DEFAULT 0,
    processed_count integer NOT NULL DEFAULT 0,
    error_json text,
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    created_at integer NOT NULL DEFAULT (unixepoch())
  )`;
}

async function tableInfo(client: Client) {
  return (await client.execute(`PRAGMA table_info(${TABLE})`)).rows;
}

async function addColumnIfMissing(
  client: Client,
  column: string,
  definition: string,
): Promise<void> {
  const result = await tableInfo(client);
  if (!result.some((row) => String(row.name) === column)) {
    await client.execute(`ALTER TABLE ${TABLE} ADD COLUMN ${column} ${definition}`);
  }
}

function isUnixepochDefault(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  let normalized = String(value).toLowerCase().replace(/\s+/g, "");
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized === "unixepoch()";
}

async function canonicalizeUpdatedAtDefault(client: Client): Promise<void> {
  const columns = await tableInfo(client);
  const updatedAt = columns.find((row) => String(row.name) === "updated_at");
  if (updatedAt && isUnixepochDefault(updatedAt.dflt_value)) return;

  const actualNames = new Set(columns.map((row) => String(row.name)));
  const unexpected = [...actualNames].filter(
    (column) => !CANONICAL_COLUMNS.includes(column as (typeof CANONICAL_COLUMNS)[number]),
  );
  const missing = CANONICAL_COLUMNS.filter((column) => !actualNames.has(column));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Refusing to rebuild ${TABLE} with schema drift; ` +
        `unexpected=[${unexpected.join(",")}], missing=[${missing.join(",")}]`,
    );
  }

  const columnList = CANONICAL_COLUMNS.join(", ");
  await client.batch([
    `DROP TABLE IF EXISTS ${REBUILD_TABLE}`,
    createTableSql(REBUILD_TABLE),
    `INSERT INTO ${REBUILD_TABLE} (${columnList}) SELECT ${columnList} FROM ${TABLE}`,
    `DROP TABLE ${TABLE}`,
    `ALTER TABLE ${REBUILD_TABLE} RENAME TO ${TABLE}`,
  ], "write");
}

const immutableTriggerSql = `CREATE TRIGGER ${IMMUTABLE_TRIGGER}
  BEFORE UPDATE ON ${TABLE}
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'mutation command identity, evidence, resource, and created_at are immutable')
    WHERE NEW.id IS NOT OLD.id
       OR NEW.actor_user_id IS NOT OLD.actor_user_id
       OR NEW.project_id IS NOT OLD.project_id
       OR NEW.action IS NOT OLD.action
       OR NEW.idempotency_key_hash IS NOT OLD.idempotency_key_hash
       OR NEW.request_hash IS NOT OLD.request_hash
       OR NEW.resource_type IS NOT OLD.resource_type
       OR NEW.resource_id IS NOT OLD.resource_id
       OR NEW.created_at IS NOT OLD.created_at;
  END`;

const progressTriggerSql = `CREATE TRIGGER ${PROGRESS_TRIGGER}
  BEFORE UPDATE ON ${TABLE}
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'succeeded mutation command is terminal')
    WHERE OLD.status = 'succeeded';

    SELECT RAISE(ABORT, 'invalid mutation command status transition')
    WHERE NOT (
      (OLD.status = 'intent' AND NEW.status = 'in_progress')
      OR (OLD.status = 'in_progress' AND NEW.status IN ('in_progress', 'succeeded', 'failed', 'indeterminate'))
      OR (OLD.status IN ('failed', 'indeterminate') AND NEW.status = 'in_progress')
    );

    SELECT RAISE(ABORT, 'mutation command version must increment exactly once')
    WHERE typeof(NEW.version) <> 'integer'
       OR NEW.version <> OLD.version + 1;

    SELECT RAISE(ABORT, 'mutation command timestamps cannot move backward')
    WHERE typeof(NEW.updated_at) <> 'integer'
       OR typeof(NEW.created_at) <> 'integer'
       OR NEW.updated_at < 0
       OR NEW.created_at < 0
       OR NEW.updated_at < OLD.updated_at
       OR NEW.updated_at < NEW.created_at;

    SELECT RAISE(ABORT, 'mutation command lease token and expiry must be set or cleared together')
    WHERE (NEW.lease_token IS NULL AND NEW.lease_expires_at IS NOT NULL)
       OR (NEW.lease_token IS NOT NULL AND NEW.lease_expires_at IS NULL)
       OR (NEW.lease_token IS NOT NULL AND (typeof(NEW.lease_token) <> 'text' OR length(NEW.lease_token) = 0))
       OR (NEW.lease_expires_at IS NOT NULL AND typeof(NEW.lease_expires_at) <> 'integer')
       OR (NEW.lease_expires_at IS NOT NULL AND NEW.lease_expires_at <= 0);

    SELECT RAISE(ABORT, 'only an in-progress mutation command may hold a lease')
    WHERE NEW.status <> 'in_progress'
      AND (NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL);

    SELECT RAISE(ABORT, 'a new mutation command lease must have a future expiry')
    WHERE NEW.status = 'in_progress'
      AND NEW.lease_token IS NOT NULL
      AND NEW.lease_token IS NOT OLD.lease_token
      AND NEW.lease_expires_at <= unixepoch();

    SELECT RAISE(ABORT, 'an active mutation command lease cannot be replaced')
    WHERE OLD.status = 'in_progress'
      AND NEW.status = 'in_progress'
      AND NEW.lease_token IS NOT NULL
      AND NEW.lease_token IS NOT OLD.lease_token
      AND OLD.lease_token IS NOT NULL
      AND (OLD.lease_expires_at IS NULL OR OLD.lease_expires_at > unixepoch());

    SELECT RAISE(ABORT, 'in-progress mutation command updates must acquire or release a lease')
    WHERE OLD.status = 'in_progress'
      AND NEW.status = 'in_progress'
      AND NOT (
        (OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL)
        OR (
          NEW.lease_token IS NOT NULL
          AND NEW.lease_token IS NOT OLD.lease_token
          AND (OLD.lease_token IS NULL OR OLD.lease_expires_at <= unixepoch())
        )
      );

    SELECT RAISE(ABORT, 'entering in-progress requires a new mutation command lease')
    WHERE OLD.status IN ('intent', 'failed', 'indeterminate')
      AND NEW.status = 'in_progress'
      AND NEW.lease_token IS NULL;

    SELECT RAISE(ABORT, 'mutation command attempt count must match lease acquisition')
    WHERE (
      NEW.status = 'in_progress'
      AND NEW.lease_token IS NOT NULL
      AND NEW.lease_token IS NOT OLD.lease_token
      AND NEW.attempt_count <> OLD.attempt_count + 1
    ) OR (
      NOT (
        NEW.status = 'in_progress'
        AND NEW.lease_token IS NOT NULL
        AND NEW.lease_token IS NOT OLD.lease_token
      )
      AND NEW.attempt_count <> OLD.attempt_count
    );

    SELECT RAISE(ABORT, 'mutation command counters must be monotonic and bounded')
    WHERE typeof(NEW.attempt_count) <> 'integer'
       OR typeof(NEW.target_count) <> 'integer'
       OR typeof(NEW.processed_count) <> 'integer'
       OR NEW.attempt_count < 0
       OR NEW.target_count < OLD.target_count
       OR NEW.processed_count < OLD.processed_count
       OR NEW.target_count < 0
       OR NEW.processed_count < 0
       OR NEW.processed_count > NEW.target_count;

    SELECT RAISE(ABORT, 'acquiring a mutation command lease cannot rewrite its durable response')
    WHERE NEW.status = 'in_progress'
      AND NEW.lease_token IS NOT NULL
      AND NEW.lease_token IS NOT OLD.lease_token
      AND NEW.response_json IS NOT OLD.response_json;
  END`;

const insertTriggerSql = `CREATE TRIGGER ${INSERT_TRIGGER}
  BEFORE INSERT ON ${TABLE}
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'invalid initial mutation command status')
    WHERE NEW.status NOT IN ('intent', 'succeeded');

    SELECT RAISE(ABORT, 'initial mutation command version and attempt count must both be zero')
    WHERE typeof(NEW.version) <> 'integer'
       OR typeof(NEW.attempt_count) <> 'integer'
       OR NEW.version <> 0
       OR NEW.attempt_count <> 0;

    SELECT RAISE(ABORT, 'initial mutation command counters must be nonnegative and bounded')
    WHERE typeof(NEW.target_count) <> 'integer'
       OR typeof(NEW.processed_count) <> 'integer'
       OR NEW.target_count < 0
       OR NEW.processed_count < 0
       OR NEW.processed_count > NEW.target_count;

    SELECT RAISE(ABORT, 'initial mutation command timestamps cannot move backward')
    WHERE typeof(NEW.updated_at) <> 'integer'
       OR typeof(NEW.created_at) <> 'integer'
       OR NEW.updated_at < 0
       OR NEW.created_at < 0
       OR NEW.updated_at < NEW.created_at;

    SELECT RAISE(ABORT, 'an initial mutation command cannot hold a lease')
    WHERE NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL;
  END`;

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  try {
    await client.execute(createTableSql(TABLE).replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"));

    await addColumnIfMissing(client, "status", "text NOT NULL DEFAULT 'succeeded'");
    await addColumnIfMissing(client, "version", "integer NOT NULL DEFAULT 0");
    await addColumnIfMissing(client, "lease_token", "text");
    await addColumnIfMissing(client, "lease_expires_at", "integer");
    await addColumnIfMissing(client, "attempt_count", "integer NOT NULL DEFAULT 0");
    await addColumnIfMissing(client, "target_count", "integer NOT NULL DEFAULT 0");
    await addColumnIfMissing(client, "processed_count", "integer NOT NULL DEFAULT 0");
    await addColumnIfMissing(client, "error_json", "text");
    // A populated SQLite table cannot gain a non-constant expression default.
    // Add the compatibility value, backfill it, then rebuild only this table to
    // the canonical unixepoch() default below.
    await addColumnIfMissing(client, "updated_at", "integer NOT NULL DEFAULT 0");

    await client.batch([
      `DROP TRIGGER IF EXISTS ${IMMUTABLE_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${PROGRESS_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${INSERT_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${LEGACY_LEASE_INSERT_TRIGGER}`,
      `UPDATE ${TABLE}
       SET lease_token = NULL, lease_expires_at = NULL
       WHERE (status <> 'in_progress' AND (lease_token IS NOT NULL OR lease_expires_at IS NOT NULL))
          OR (lease_token IS NULL AND lease_expires_at IS NOT NULL)
          OR (lease_token IS NOT NULL AND lease_expires_at IS NULL)
          OR (lease_expires_at IS NOT NULL AND lease_expires_at <= 0)`,
      `UPDATE ${TABLE} SET updated_at = created_at WHERE updated_at = 0`,
    ], "write");

    await canonicalizeUpdatedAtDefault(client);

    await client.batch([
      `CREATE UNIQUE INDEX IF NOT EXISTS mutation_commands_idempotency_idx
        ON ${TABLE} (idempotency_key_hash)`,
      `CREATE INDEX IF NOT EXISTS mutation_commands_actor_time_idx
        ON ${TABLE} (actor_user_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS mutation_commands_project_time_idx
        ON ${TABLE} (project_id, created_at)`,
      `DROP TRIGGER IF EXISTS ${IMMUTABLE_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${PROGRESS_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${INSERT_TRIGGER}`,
      `DROP TRIGGER IF EXISTS ${LEGACY_LEASE_INSERT_TRIGGER}`,
      immutableTriggerSql,
      progressTriggerSql,
      insertTriggerSql,
    ], "write");

    console.log("mutation command receipts and transition guards are ready.");
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
