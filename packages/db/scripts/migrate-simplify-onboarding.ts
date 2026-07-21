// Replace the discarded draft onboarding state/evidence schema with the lean
// plan -> approval -> proof -> verified model. Incomplete draft onboarding is
// intentionally reset; customer telemetry rows are retained without old proof
// stamps and can be verified again through a new short-lived session.

import { createClient, type Client } from "@libsql/client";

async function columns(client: Client, table: string): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    args: [table],
  });
  return result.rows.length === 1;
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });
  try {
    const proofColumns = await columns(client, "onboarding_proof_sessions");
    const proofIsLean = proofColumns.has("approved_state_etag") &&
      !proofColumns.has("implementation_artifact_etag");

    if (!proofIsLean && proofColumns.size > 0) {
      for (const table of ["events", "deploys"]) {
        const tableColumns = await columns(client, table);
        if (tableColumns.has("onboarding_proof_session_id")) {
          await client.execute(
            `UPDATE ${table} SET onboarding_proof_session_id=NULL, onboarding_proof_credential_id=NULL WHERE onboarding_proof_session_id IS NOT NULL`,
          );
        }
      }
      await client.batch([
        "DROP TRIGGER IF EXISTS onboarding_proof_session_secrets_immutable_update_guard",
        "DROP TRIGGER IF EXISTS onboarding_proof_session_secrets_insert_guard",
        "DROP TRIGGER IF EXISTS onboarding_proof_sessions_identity_update_guard",
        "DROP TRIGGER IF EXISTS onboarding_proof_sessions_lifecycle_update_guard",
        "DROP TABLE IF EXISTS onboarding_proof_session_secrets",
        "DROP TABLE onboarding_proof_sessions",
      ], "write");
    }

    await client.batch([
      "DROP TRIGGER IF EXISTS onboarding_v2_project_heads_insert_guard",
      "DROP TRIGGER IF EXISTS onboarding_v2_project_heads_update_guard",
      "DROP TRIGGER IF EXISTS onboarding_v2_state_history_immutable_update_guard",
      "DROP TABLE IF EXISTS onboarding_v2_project_heads",
      "DROP TABLE IF EXISTS onboarding_v2_state_history",
      `CREATE TABLE IF NOT EXISTS onboarding_proof_sessions (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        onboarding_id text NOT NULL,
        approved_state_etag text NOT NULL,
        runtime_public_key_hash text NOT NULL,
        runtime_server_credential_id text REFERENCES project_credentials(id) ON DELETE RESTRICT,
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
          OR (status IN ('completed', 'revoked') AND terminal_at IS NOT NULL AND terminal_at >= started_at AND terminal_at < expires_at AND terminal_reason IS NOT NULL AND length(trim(terminal_reason)) > 0)
          OR (status = 'expired' AND terminal_at IS NOT NULL AND terminal_at >= expires_at AND terminal_reason IS NOT NULL AND length(trim(terminal_reason)) > 0)
        )
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS onboarding_proof_sessions_runtime_marker_idx ON onboarding_proof_sessions (runtime_marker_hash)",
      "CREATE UNIQUE INDEX IF NOT EXISTS onboarding_proof_sessions_ci_marker_idx ON onboarding_proof_sessions (ci_marker_hash)",
      "CREATE INDEX IF NOT EXISTS onboarding_proof_sessions_server_credential_idx ON onboarding_proof_sessions (runtime_server_credential_id)",
      "CREATE INDEX IF NOT EXISTS onboarding_proof_sessions_ci_credential_idx ON onboarding_proof_sessions (ci_credential_id)",
      "CREATE INDEX IF NOT EXISTS onboarding_proof_sessions_project_status_idx ON onboarding_proof_sessions (project_id, status, expires_at)",
      "CREATE INDEX IF NOT EXISTS onboarding_proof_sessions_onboarding_idx ON onboarding_proof_sessions (project_id, onboarding_id, started_at)",
      `CREATE TABLE IF NOT EXISTS onboarding_states (
        project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        onboarding_id text NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        status text NOT NULL,
        etag text NOT NULL,
        plan_sha256 text NOT NULL,
        plan_json text NOT NULL,
        implementation_source_snapshot_json text,
        proof_session_json text,
        receipt_json text,
        created_by text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT onboarding_states_revision_check CHECK (revision > 0),
        CONSTRAINT onboarding_states_timestamps_check CHECK (created_at >= 0 AND updated_at >= created_at),
        CONSTRAINT onboarding_states_json_check CHECK (
          json_valid(plan_json) AND json_type(plan_json) = 'object'
          AND (implementation_source_snapshot_json IS NULL OR (json_valid(implementation_source_snapshot_json) AND json_type(implementation_source_snapshot_json) = 'object'))
          AND (proof_session_json IS NULL OR (json_valid(proof_session_json) AND json_type(proof_session_json) = 'object'))
          AND (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object'))
        ),
        CONSTRAINT onboarding_states_status_documents_check CHECK (
          (status IN ('planned', 'approved') AND implementation_source_snapshot_json IS NULL AND proof_session_json IS NULL AND receipt_json IS NULL)
          OR (status = 'proving' AND implementation_source_snapshot_json IS NOT NULL AND proof_session_json IS NOT NULL AND receipt_json IS NULL)
          OR (status = 'verified' AND implementation_source_snapshot_json IS NOT NULL AND proof_session_json IS NOT NULL AND receipt_json IS NOT NULL)
        )
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS onboarding_states_onboarding_idx ON onboarding_states (onboarding_id)",
      "CREATE UNIQUE INDEX IF NOT EXISTS onboarding_states_etag_idx ON onboarding_states (etag)",
      "CREATE INDEX IF NOT EXISTS onboarding_states_status_idx ON onboarding_states (status, updated_at)",
    ], "write");

    console.log(JSON.stringify({
      migration: "lean_onboarding",
      reset_incomplete_draft_state: true,
      states: ["planned", "approved", "proving", "verified"],
    }));
  } finally {
    client.close();
  }
}

await main();
