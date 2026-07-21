// Hard-cut onboarding proof to direct customer PostHog runtime telemetry.
// Existing proof sessions are intentionally discarded: raw one-time markers
// were never persisted, so an old session cannot be resumed safely.

export const ONBOARDING_POSTHOG_PROOF_SCHEMA_STATEMENTS = Object.freeze([
  `UPDATE deploys
      SET onboarding_proof_session_id = NULL,
          onboarding_proof_credential_id = NULL
    WHERE onboarding_proof_session_id IS NOT NULL
       OR onboarding_proof_credential_id IS NOT NULL`,
  `CREATE TABLE onboarding_proof_sessions_next (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    onboarding_id text NOT NULL,
    approved_state_etag text NOT NULL,
    ci_credential_id text NOT NULL REFERENCES project_credentials(id) ON DELETE RESTRICT,
    runtime_marker_hash text NOT NULL,
    ci_marker_hash text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    started_at integer NOT NULL DEFAULT (unixepoch()),
    expires_at integer NOT NULL,
    terminal_at integer,
    terminal_reason text,
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT onboarding_proof_sessions_lifetime_check CHECK (
      started_at >= 0 AND expires_at > started_at AND updated_at >= started_at
    ),
    CONSTRAINT onboarding_proof_sessions_distinct_markers_check CHECK (
      runtime_marker_hash <> ci_marker_hash
    ),
    CONSTRAINT onboarding_proof_sessions_lifecycle_check CHECK (
      (status = 'active' AND terminal_at IS NULL AND terminal_reason IS NULL)
      OR
      (status IN ('completed', 'revoked')
        AND terminal_at IS NOT NULL
        AND terminal_at >= started_at
        AND terminal_at < expires_at
        AND terminal_reason IS NOT NULL
        AND length(trim(terminal_reason)) > 0)
      OR
      (status = 'expired'
        AND terminal_at IS NOT NULL
        AND terminal_at >= expires_at
        AND terminal_reason IS NOT NULL
        AND length(trim(terminal_reason)) > 0)
    )
  )`,
  `DROP TABLE onboarding_proof_sessions`,
  `ALTER TABLE onboarding_proof_sessions_next RENAME TO onboarding_proof_sessions`,
  `CREATE UNIQUE INDEX onboarding_proof_sessions_runtime_marker_idx
    ON onboarding_proof_sessions (runtime_marker_hash)`,
  `CREATE UNIQUE INDEX onboarding_proof_sessions_ci_marker_idx
    ON onboarding_proof_sessions (ci_marker_hash)`,
  `CREATE INDEX onboarding_proof_sessions_ci_credential_idx
    ON onboarding_proof_sessions (ci_credential_id)`,
  `CREATE INDEX onboarding_proof_sessions_project_status_idx
    ON onboarding_proof_sessions (project_id, status, expires_at)`,
  `CREATE INDEX onboarding_proof_sessions_onboarding_idx
    ON onboarding_proof_sessions (project_id, onboarding_id, started_at)`,
]);

export const ONBOARDING_POSTHOG_PROOF_SCHEMA_EXTENSION = Object.freeze({
  id: "20260715_03_onboarding_posthog_proof",
  schemaProjection:
    "scripts/schema-extensions/20260715_03_onboarding_posthog_proof.mjs",
  statements: ONBOARDING_POSTHOG_PROOF_SCHEMA_STATEMENTS,
  tables: Object.freeze(["onboarding_proof_sessions"]),
});
