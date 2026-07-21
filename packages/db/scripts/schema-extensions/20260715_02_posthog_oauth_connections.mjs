// Canonical projection for customer-owned PostHog Cloud OAuth connections.

export const POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE posthog_connections (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    authorized_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    detached_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
    oauth_client_id text NOT NULL,
    status text NOT NULL,
    access_token_ciphertext text,
    access_token_iv text,
    refresh_token_ciphertext text,
    refresh_token_iv text,
    access_token_expires_at integer,
    granted_scopes_json text NOT NULL DEFAULT '[]',
    posthog_host text NOT NULL,
    posthog_region text NOT NULL,
    posthog_organization_id text,
    posthog_environment_id integer,
    capability_snapshot_json text NOT NULL DEFAULT '{}',
    capabilities_observed_at integer,
    external_ownership text NOT NULL DEFAULT 'customer_owned',
    external_deletion_policy text NOT NULL DEFAULT 'detach_only',
    authorized_at integer NOT NULL,
    token_refreshed_at integer,
    refresh_lease_token text,
    refresh_lease_expires_at integer,
    last_verified_at integer,
    last_used_at integer,
    case_projection_offset integer NOT NULL DEFAULT 0,
    case_projection_last_attempt_at integer,
    case_projection_last_completed_at integer,
    reauth_required_at integer,
    detached_at integer,
    version integer NOT NULL DEFAULT 1,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT posthog_connections_lifecycle_check CHECK (
      (status = 'active'
        AND access_token_ciphertext IS NOT NULL
        AND access_token_iv IS NOT NULL
        AND refresh_token_ciphertext IS NOT NULL
        AND refresh_token_iv IS NOT NULL
        AND access_token_expires_at IS NOT NULL
        AND access_token_expires_at > 0
        AND reauth_required_at IS NULL
        AND detached_at IS NULL)
      OR
      (status = 'reauth_required'
        AND access_token_ciphertext IS NULL
        AND access_token_iv IS NULL
        AND refresh_token_ciphertext IS NULL
        AND refresh_token_iv IS NULL
        AND access_token_expires_at IS NULL
        AND reauth_required_at IS NOT NULL
        AND detached_at IS NULL)
      OR
      (status = 'detached'
        AND access_token_ciphertext IS NULL
        AND access_token_iv IS NULL
        AND refresh_token_ciphertext IS NULL
        AND refresh_token_iv IS NULL
        AND access_token_expires_at IS NULL
        AND detached_at IS NOT NULL)
    ),
    CONSTRAINT posthog_connections_refresh_lease_check CHECK (
      (refresh_lease_token IS NULL AND refresh_lease_expires_at IS NULL)
      OR
      (status = 'active'
        AND refresh_lease_token IS NOT NULL
        AND length(refresh_lease_token) BETWEEN 16 AND 128
        AND refresh_lease_expires_at IS NOT NULL
        AND refresh_lease_expires_at > 0)
    ),
    CONSTRAINT posthog_connections_identity_check CHECK (
      ((posthog_region = 'us' AND posthog_host = 'https://us.posthog.com')
        OR (posthog_region = 'eu' AND posthog_host = 'https://eu.posthog.com'))
      AND (
        (status = 'detached'
          AND posthog_organization_id IS NULL
          AND posthog_environment_id IS NULL)
        OR
        (status IN ('active', 'reauth_required')
          AND posthog_environment_id IS NOT NULL
          AND posthog_environment_id > 0)
      )
    ),
    CONSTRAINT posthog_connections_json_check CHECK (
      json_valid(granted_scopes_json)
      AND json_type(granted_scopes_json) = 'array'
      AND length(granted_scopes_json) <= 16384
      AND json_valid(capability_snapshot_json)
      AND json_type(capability_snapshot_json) = 'object'
      AND length(capability_snapshot_json) <= 65536
    ),
    CONSTRAINT posthog_connections_external_ownership_check CHECK (
      external_ownership = 'customer_owned'
      AND external_deletion_policy = 'detach_only'
    ),
    CONSTRAINT posthog_connections_timestamp_check CHECK (
      length(oauth_client_id) BETWEEN 8 AND 2048
      AND (oauth_client_id LIKE 'https://%'
        OR oauth_client_id LIKE 'http://localhost%'
        OR oauth_client_id LIKE 'http://127.0.0.1%'
        OR oauth_client_id LIKE 'http://[::1]%')
      AND authorized_at > 0
      AND version >= 1
      AND created_at > 0
      AND updated_at >= created_at
    ),
    CONSTRAINT posthog_connections_case_projection_cursor_check CHECK (
      case_projection_offset >= 0
      AND (case_projection_last_attempt_at IS NULL
        OR case_projection_last_attempt_at > 0)
      AND (case_projection_last_completed_at IS NULL
        OR (case_projection_last_attempt_at IS NOT NULL
          AND case_projection_last_completed_at > 0
          AND case_projection_last_completed_at <= case_projection_last_attempt_at))
    )
  )`,
  `CREATE UNIQUE INDEX posthog_connections_project_idx
    ON posthog_connections (project_id)`,
  `CREATE UNIQUE INDEX posthog_connections_id_project_idx
    ON posthog_connections (id, project_id)`,
  `CREATE INDEX posthog_connections_refresh_due_idx
    ON posthog_connections (status, access_token_expires_at)`,
  `CREATE INDEX posthog_connections_provider_identity_idx
    ON posthog_connections (posthog_host, posthog_environment_id, status)`,
  `CREATE INDEX posthog_connections_case_projection_due_idx
    ON posthog_connections (status, case_projection_last_attempt_at, id)`,
  `CREATE TABLE posthog_oauth_attempts (
    id text PRIMARY KEY,
    mode text NOT NULL,
    project_id text REFERENCES projects(id) ON DELETE CASCADE,
    user_id text REFERENCES users(id) ON DELETE CASCADE,
    poll_token_hash text,
    handoff_redirect_uri text,
    handoff_challenge text,
    handoff_code_hash text,
    handoff_expires_at integer,
    handoff_failure_count integer NOT NULL DEFAULT 0,
    state_hash text NOT NULL,
    oauth_client_id text NOT NULL,
    pkce_verifier_ciphertext text,
    pkce_verifier_iv text,
    oidc_nonce_hash text NOT NULL,
    oidc_nonce_ciphertext text,
    oidc_nonce_iv text,
    redirect_uri text NOT NULL,
    requested_scopes_json text NOT NULL DEFAULT '[]',
    posthog_region_hint text,
    posthog_environment_id_hint integer,
    client_name text,
    distribution_surface text,
    status text NOT NULL DEFAULT 'pending',
    connection_id text,
    pending_access_token_ciphertext text,
    pending_access_token_iv text,
    pending_refresh_token_ciphertext text,
    pending_refresh_token_iv text,
    pending_access_token_expires_at integer,
    granted_scopes_json text NOT NULL DEFAULT '[]',
    posthog_host text,
    posthog_organization_id text,
    posthog_environment_id integer,
    capability_snapshot_json text NOT NULL DEFAULT '{}',
    capabilities_observed_at integer,
    error_code text,
    error_metadata_json text NOT NULL DEFAULT '{}',
    expires_at integer NOT NULL,
    exchange_started_at integer,
    authorized_at integer,
    last_polled_at integer,
    poll_consumed_at integer,
    claimed_at integer,
    failed_at integer,
    expired_at integer,
    version integer NOT NULL DEFAULT 1,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT posthog_oauth_attempts_state_hash_check CHECK (
      length(state_hash) = 64
      AND state_hash NOT GLOB '*[^a-f0-9]*'
    ),
    CONSTRAINT posthog_oauth_attempts_secret_hash_check CHECK (
      length(oidc_nonce_hash) = 64
      AND oidc_nonce_hash NOT GLOB '*[^a-f0-9]*'
      AND (poll_token_hash IS NULL OR (
        length(poll_token_hash) = 64
        AND poll_token_hash NOT GLOB '*[^a-f0-9]*'))
      AND (handoff_code_hash IS NULL OR (
        length(handoff_code_hash) = 64
        AND handoff_code_hash NOT GLOB '*[^a-f0-9]*'))
    ),
    CONSTRAINT posthog_oauth_attempts_authority_mode_check CHECK (
      (mode = 'bootstrap'
        AND poll_token_hash IS NOT NULL
        AND handoff_redirect_uri IS NOT NULL
        AND handoff_challenge IS NOT NULL)
      OR
      (mode = 'connect' AND poll_token_hash IS NULL
        AND handoff_redirect_uri IS NULL
        AND handoff_challenge IS NULL
        AND project_id IS NOT NULL AND user_id IS NOT NULL)
    ),
    CONSTRAINT posthog_oauth_attempts_secret_lifecycle_check CHECK (
      (status IN ('pending', 'exchanging')
        AND pkce_verifier_ciphertext IS NOT NULL
        AND pkce_verifier_iv IS NOT NULL
        AND oidc_nonce_ciphertext IS NOT NULL
        AND oidc_nonce_iv IS NOT NULL)
      OR
      (status IN ('authorized', 'claimed', 'failed', 'expired')
        AND pkce_verifier_ciphertext IS NULL
        AND pkce_verifier_iv IS NULL
        AND oidc_nonce_ciphertext IS NULL
        AND oidc_nonce_iv IS NULL)
    ),
    CONSTRAINT posthog_oauth_attempts_pending_grant_check CHECK (
      (status = 'authorized'
        AND mode = 'bootstrap'
        AND project_id IS NULL
        AND user_id IS NOT NULL
        AND connection_id IS NULL
        AND pending_access_token_ciphertext IS NOT NULL
        AND pending_access_token_iv IS NOT NULL
        AND pending_refresh_token_ciphertext IS NOT NULL
        AND pending_refresh_token_iv IS NOT NULL
        AND pending_access_token_expires_at IS NOT NULL
        AND pending_access_token_expires_at > 0
        AND posthog_host IS NOT NULL
        AND posthog_environment_id IS NOT NULL
        AND posthog_environment_id > 0)
      OR
      (status <> 'authorized'
        AND pending_access_token_ciphertext IS NULL
        AND pending_access_token_iv IS NULL
        AND pending_refresh_token_ciphertext IS NULL
        AND pending_refresh_token_iv IS NULL
        AND pending_access_token_expires_at IS NULL)
    ),
    CONSTRAINT posthog_oauth_attempts_handoff_lifecycle_check CHECK (
      (mode = 'bootstrap' AND status = 'authorized'
        AND (
          (poll_consumed_at IS NULL
            AND handoff_code_hash IS NOT NULL
            AND handoff_expires_at IS NOT NULL
            AND handoff_expires_at > 0
            AND handoff_expires_at = expires_at
            AND handoff_expires_at <= authorized_at + 300
            AND handoff_failure_count BETWEEN 0 AND 5)
          OR
          (poll_consumed_at IS NOT NULL
            AND handoff_code_hash IS NULL
            AND handoff_expires_at IS NULL
            AND handoff_failure_count = 0)
        ))
      OR
      (NOT (mode = 'bootstrap' AND status = 'authorized')
        AND handoff_code_hash IS NULL
        AND handoff_expires_at IS NULL
        AND handoff_failure_count = 0)
    ),
    CONSTRAINT posthog_oauth_attempts_lifecycle_check CHECK (
      (status = 'pending'
        AND exchange_started_at IS NULL
        AND connection_id IS NULL
        AND authorized_at IS NULL
        AND failed_at IS NULL
        AND expired_at IS NULL
        AND error_code IS NULL)
      OR
      (status = 'exchanging'
        AND exchange_started_at IS NOT NULL
        AND connection_id IS NULL
        AND authorized_at IS NULL
        AND failed_at IS NULL
        AND expired_at IS NULL
        AND error_code IS NULL)
      OR
      (status = 'authorized'
        AND exchange_started_at IS NOT NULL
        AND connection_id IS NULL
        AND authorized_at IS NOT NULL
        AND claimed_at IS NULL
        AND failed_at IS NULL
        AND expired_at IS NULL
        AND error_code IS NULL)
      OR
      (status = 'claimed'
        AND exchange_started_at IS NOT NULL
        AND project_id IS NOT NULL
        AND user_id IS NOT NULL
        AND connection_id IS NOT NULL
        AND authorized_at IS NOT NULL
        AND claimed_at IS NOT NULL
        AND failed_at IS NULL
        AND expired_at IS NULL
        AND error_code IS NULL)
      OR
      (status = 'failed'
        AND exchange_started_at IS NOT NULL
        AND connection_id IS NULL
        AND authorized_at IS NULL
        AND failed_at IS NOT NULL
        AND expired_at IS NULL
        AND error_code IS NOT NULL)
      OR
      (status = 'expired'
        AND connection_id IS NULL
        AND authorized_at IS NULL
        AND failed_at IS NULL
        AND expired_at IS NOT NULL
        AND error_code IS NULL)
    ),
    CONSTRAINT posthog_oauth_attempts_json_check CHECK (
      json_valid(requested_scopes_json)
      AND json_type(requested_scopes_json) = 'array'
      AND length(requested_scopes_json) <= 16384
      AND json_valid(granted_scopes_json)
      AND json_type(granted_scopes_json) = 'array'
      AND length(granted_scopes_json) <= 16384
      AND json_valid(capability_snapshot_json)
      AND json_type(capability_snapshot_json) = 'object'
      AND length(capability_snapshot_json) <= 65536
      AND json_valid(error_metadata_json)
      AND json_type(error_metadata_json) = 'object'
      AND length(error_metadata_json) <= 16384
    ),
    CONSTRAINT posthog_oauth_attempts_bounds_check CHECK (
      length(oauth_client_id) BETWEEN 8 AND 2048
      AND (oauth_client_id LIKE 'https://%'
        OR oauth_client_id LIKE 'http://localhost%'
        OR oauth_client_id LIKE 'http://127.0.0.1%'
        OR oauth_client_id LIKE 'http://[::1]%')
      AND length(redirect_uri) BETWEEN 1 AND 2048
      AND (handoff_redirect_uri IS NULL OR (
        length(handoff_redirect_uri) BETWEEN 64 AND 256
        AND handoff_redirect_uri LIKE 'http://127.0.0.1:%/agentry/posthog/callback/%'))
      AND (handoff_challenge IS NULL OR (
        length(handoff_challenge) = 43
        AND handoff_challenge NOT GLOB '*[^A-Za-z0-9_-]*'))
      AND (posthog_environment_id_hint IS NULL OR posthog_environment_id_hint > 0)
      AND (posthog_environment_id IS NULL OR posthog_environment_id > 0)
      AND (client_name IS NULL OR length(client_name) BETWEEN 1 AND 64)
      AND (distribution_surface IS NULL
        OR length(distribution_surface) BETWEEN 1 AND 64)
      AND (last_polled_at IS NULL OR last_polled_at > 0)
      AND (poll_consumed_at IS NULL OR poll_consumed_at > 0)
      AND (handoff_expires_at IS NULL OR handoff_expires_at > 0)
      AND handoff_failure_count BETWEEN 0 AND 5
      AND expires_at > created_at
      AND version >= 1
      AND created_at > 0
      AND updated_at >= created_at
    ),
    CONSTRAINT posthog_oauth_attempts_connection_project_fk
      FOREIGN KEY (connection_id, project_id)
      REFERENCES posthog_connections(id, project_id)
      ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX posthog_oauth_attempts_state_hash_idx
    ON posthog_oauth_attempts (state_hash)`,
  `CREATE UNIQUE INDEX posthog_oauth_attempts_poll_token_hash_idx
    ON posthog_oauth_attempts (poll_token_hash)`,
  `CREATE INDEX posthog_oauth_attempts_project_time_idx
    ON posthog_oauth_attempts (project_id, created_at)`,
  `CREATE INDEX posthog_oauth_attempts_user_time_idx
    ON posthog_oauth_attempts (user_id, created_at)`,
  `CREATE INDEX posthog_oauth_attempts_expiry_idx
    ON posthog_oauth_attempts (status, expires_at)`,
  `CREATE INDEX posthog_oauth_attempts_connection_idx
    ON posthog_oauth_attempts (connection_id)`,
]);

export const POSTHOG_OAUTH_CONNECTION_SCHEMA_EXTENSION = Object.freeze({
  id: "20260715_02_posthog_oauth_connections",
  schemaProjection: "scripts/schema-extensions/20260715_02_posthog_oauth_connections.mjs",
  statements: POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS,
  tables: Object.freeze(["posthog_connections", "posthog_oauth_attempts"]),
});
