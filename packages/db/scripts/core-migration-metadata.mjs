export const CORE_BASELINE_TABLE = "_agentry_core_baseline";
export const CORE_MIGRATIONS_TABLE = "_agentry_core_migrations";
export const CORE_MIGRATION_LOCK_TABLE = "_agentry_core_migration_lock";

export const CORE_METADATA_SQL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${CORE_BASELINE_TABLE} (
    singleton integer PRIMARY KEY NOT NULL CHECK (singleton = 1),
    kind text NOT NULL CHECK (kind IN ('empty_bootstrap', 'legacy_reviewed')),
    baseline_sql_checksum text,
    review_ref text,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    CHECK (
      (kind = 'empty_bootstrap' AND baseline_sql_checksum IS NOT NULL AND review_ref IS NULL)
      OR
      (kind = 'legacy_reviewed' AND baseline_sql_checksum IS NULL AND review_ref IS NOT NULL)
    )
  )`,
  `CREATE TABLE IF NOT EXISTS ${CORE_MIGRATIONS_TABLE} (
    sequence integer PRIMARY KEY NOT NULL,
    migration_id text NOT NULL UNIQUE,
    script_path text NOT NULL,
    script_checksum text NOT NULL,
    manifest_checksum text NOT NULL,
    applied_at integer NOT NULL DEFAULT (unixepoch())
  )`,
  `CREATE TABLE IF NOT EXISTS ${CORE_MIGRATION_LOCK_TABLE} (
    singleton integer PRIMARY KEY NOT NULL CHECK (singleton = 1),
    owner_token text NOT NULL,
    lease_expires_at integer NOT NULL,
    updated_at integer NOT NULL
  )`,
]);
