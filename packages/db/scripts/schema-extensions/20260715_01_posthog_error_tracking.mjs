// Canonical projection for the PostHog-backed error-tracking authority.

export const POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS = Object.freeze([
  `ALTER TABLE cases ADD COLUMN provider_issue_id text`,
  `ALTER TABLE cases ADD COLUMN provider_snapshot_hash text`,
  `ALTER TABLE cases ADD COLUMN provider_projected_at integer`,
  `ALTER TABLE cases ADD COLUMN last_provider_event_id text`,
  `ALTER TABLE cases ADD COLUMN last_environment text`,
  `CREATE UNIQUE INDEX cases_provider_issue_idx
    ON cases (project_id, provider_issue_id)`,
  `DROP TABLE IF EXISTS sourcemap_cleanup_outcomes`,
  `DROP TABLE IF EXISTS sourcemaps`,
  `DROP TABLE IF EXISTS sourcemap_objects`,
  `DROP TABLE IF EXISTS sourcemap_commands`,
  `DROP TABLE IF EXISTS sourcemap_release_states`,
  `DROP TABLE IF EXISTS suppression_entries`,
  `DROP TABLE IF EXISTS events`,
]);

export const POSTHOG_ERROR_TRACKING_SCHEMA_EXTENSION = Object.freeze({
  id: "20260715_01_posthog_error_tracking",
  schemaProjection: "scripts/schema-extensions/20260715_01_posthog_error_tracking.mjs",
  statements: POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS,
  tables: Object.freeze([]),
});
