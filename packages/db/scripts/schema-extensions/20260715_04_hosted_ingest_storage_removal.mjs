// Hard-cut the retired Agentry-hosted telemetry ingress secret surface.
// Projects now identify only the Agentry control-plane boundary; customer
// applications send runtime telemetry directly to their own PostHog project.

export const HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_STATEMENTS = Object.freeze([
  "DROP TABLE IF EXISTS sourcemap_cleanup_outcomes",
  "DROP TABLE IF EXISTS sourcemaps",
  "DROP TABLE IF EXISTS sourcemap_objects",
  "DROP TABLE IF EXISTS sourcemap_release_states",
  "DROP TABLE IF EXISTS sourcemap_commands",
  "DROP TABLE IF EXISTS suppression_entries",
  "DROP TABLE IF EXISTS events",
  "DROP TABLE IF EXISTS posthog_error_capture_commands",
  "DROP TABLE posthog_provision_targets",
  "DROP TABLE project_posthog_bindings",
  "DROP TABLE project_secrets",
  "DROP TABLE usage_snapshots",
  "DROP TABLE usage_counters",
  "DROP INDEX projects_dsn_hash_idx",
  "ALTER TABLE projects DROP COLUMN dsn_prefix",
  "ALTER TABLE projects DROP COLUMN dsn_hash",
]);

export const HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_EXTENSION = Object.freeze({
  id: "20260715_04_hosted_ingest_storage_removal",
  schemaProjection:
    "scripts/schema-extensions/20260715_04_hosted_ingest_storage_removal.mjs",
  statements: HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_STATEMENTS,
  tables: Object.freeze(["projects"]),
});
