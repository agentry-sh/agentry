// Test bootstrap — builds an in-memory libSQL DB by default (or a temporary
// file DB for interactive-transaction coverage) and stubs the API's getDb().

import { createClient as createLibsql, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentry/db/schema";
import { mintProjectCredential, uuidv7, type ProjectCredentialKind } from "@agentrysh/shared";
// The create-only projection is intentionally consumed by runtime tests so a
// hand-copied test schema cannot drift from the release migration.
import {
  AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS,
  AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS,
} from "../../../packages/db/scripts/schema-extensions/20260721_01_automation_workflow_runtime_hard_cut.mjs";
import { POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS } from "../../../packages/db/scripts/schema-extensions/20260715_01_posthog_error_tracking.mjs";
import { POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS } from "../../../packages/db/scripts/schema-extensions/20260715_02_posthog_oauth_connections.mjs";
import { READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS } from "../../../packages/db/scripts/schema-extensions/20260720_01_read_only_schema_hard_cut.mjs";

export interface TestEnv {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  POSTHOG_OAUTH_CLIENT_ID?: string;
  POSTHOG_OAUTH_REDIRECT_URI?: string;
  ENABLE_TEST_LOGIN: string;
  ADMIN_TOKEN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_NERVE?: string;
  BILLING_SUCCESS_URL?: string;
  BILLING_CANCEL_URL?: string;
  BILLING_PORTAL_RETURN_URL?: string;
  // Optional — webhook signing-secret encryption uses AES-256-GCM with this key.
  // Required for webhook CRUD tests but unused for plain ingest.
  AGENTRY_TOKEN_ENC_KEY?: string;
  INSTALL_PLAN_RATE_LIMIT_PER_MINUTE?: string;
  MAX_BODY_BYTES?: string;
}

// 32-byte all-zeros key, base64url-encoded (no pad). Deterministic for tests.
// AES-256-GCM requires a 32-byte key; the value doesn't have to be secret in tests.
export const TEST_ENC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// Cache so getDb() returns the same connection within one test.
const dbByUrl = new Map<
  string,
  { client: Client; drizzle: ReturnType<typeof drizzle<typeof schema>>; directory?: string }
>();

export async function makeTestEnv(opts?: {
  enableTestLogin?: boolean;
  withEncKey?: boolean;
  /** Use a file DB when the code under test opens an interactive transaction. */
  fileDb?: boolean;
}): Promise<TestEnv> {
  const directory = opts?.fileDb
    ? mkdtempSync(join(tmpdir(), "agentry-api-test-"))
    : undefined;
  const url = directory
    ? `file:${join(directory, "test.sqlite")}`
    : `:memory:#${Math.random().toString(36).slice(2)}`;
  const client = createLibsql({ url: directory ? url : ":memory:" });
  const d = drizzle(client, { schema });

  // Apply schema. Mirrors packages/db/src/schema.ts.
  const bootstrapStatements = [
      `CREATE TABLE users (
        id text PRIMARY KEY,
        github_id integer,
        github_username text,
        email text,
        avatar_url text,
        plan text NOT NULL DEFAULT 'free',
        stripe_customer_id text,
        stripe_subscription_id text,
        stripe_price_id text,
        billing_status text NOT NULL DEFAULT 'none',
        billing_current_period_end integer,
        billing_cancel_at_period_end integer NOT NULL DEFAULT 0,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX users_github_id_idx ON users (github_id)`,
      `CREATE INDEX users_email_idx ON users (email)`,
      `CREATE TABLE identities (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        issuer text NOT NULL,
        subject text NOT NULL,
        email text,
        email_verified integer,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT identities_oidc_identity_check CHECK (
          length(issuer) BETWEEN 8 AND 2048
          AND issuer LIKE 'https://%'
          AND length(subject) BETWEEN 1 AND 512
          AND (email_verified IS NULL OR email_verified IN (0, 1))
          AND updated_at >= created_at
        )
      )`,
      `CREATE UNIQUE INDEX identities_oidc_subject_idx ON identities (issuer, subject)`,
      `CREATE INDEX identities_user_idx ON identities (user_id)`,
      `CREATE TABLE api_keys (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind text NOT NULL DEFAULT 'private',
        prefix text NOT NULL,
        key_hash text NOT NULL,
        name text,
        last_used_at integer,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        revoked_at integer
      )`,
      `CREATE UNIQUE INDEX api_keys_hash_idx ON api_keys (key_hash)`,
      `CREATE INDEX api_keys_user_idx ON api_keys (user_id)`,
      `CREATE INDEX api_keys_user_kind_idx ON api_keys (user_id, kind)`,
      `CREATE TABLE public_query_publications (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id text NOT NULL,
        recipe_id text NOT NULL,
        params_json text NOT NULL DEFAULT '{}',
        description text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        last_used_at integer,
        revoked_at integer
      )`,
      `CREATE INDEX pubq_user_idx ON public_query_publications (user_id)`,
      `CREATE INDEX pubq_project_idx ON public_query_publications (project_id)`,
      `CREATE TABLE projects (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        repo_url text,
        default_branch text NOT NULL DEFAULT 'main',
        local_path text,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX projects_user_idx ON projects (user_id)`,
      `CREATE TABLE project_credentials (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL,
        name text NOT NULL,
        prefix text NOT NULL,
        token_hash text NOT NULL,
        automation_id text,
        created_by text REFERENCES users(id) ON DELETE SET NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        expires_at integer NOT NULL,
        last_used_at integer,
        revoked_at integer,
        revoke_reason text
      )`,
      `CREATE UNIQUE INDEX project_credentials_token_hash_idx ON project_credentials (token_hash)`,
      `CREATE INDEX project_credentials_project_active_idx ON project_credentials (project_id, revoked_at, expires_at)`,
      `CREATE INDEX project_credentials_automation_idx ON project_credentials (project_id, automation_id, revoked_at)`,
      `CREATE TABLE mutation_commands (
        id text PRIMARY KEY,
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
      )`,
      `CREATE UNIQUE INDEX mutation_commands_idempotency_idx ON mutation_commands (idempotency_key_hash)`,
      `CREATE INDEX mutation_commands_actor_time_idx ON mutation_commands (actor_user_id, created_at)`,
      `CREATE INDEX mutation_commands_project_time_idx ON mutation_commands (project_id, created_at)`,
      `CREATE TRIGGER mutation_commands_immutable_update_guard
        BEFORE UPDATE ON mutation_commands
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
        END`,
      `CREATE TRIGGER mutation_commands_progress_update_guard
        BEFORE UPDATE ON mutation_commands
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
        END`,
      `CREATE TRIGGER mutation_commands_insert_guard
        BEFORE INSERT ON mutation_commands
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
        END`,
      `CREATE TABLE account_deletion_fences (
        user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        command_id text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE TABLE billing_mutation_targets (
        command_id text PRIMARY KEY REFERENCES mutation_commands(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        operation text NOT NULL,
        target_hash text NOT NULL,
        target_json text NOT NULL,
        stripe_customer_idempotency_key text,
        stripe_session_idempotency_key text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX billing_mutation_targets_user_time_idx ON billing_mutation_targets (user_id, created_at)`,
      `CREATE UNIQUE INDEX billing_mutation_targets_customer_key_idx ON billing_mutation_targets (stripe_customer_idempotency_key)`,
      `CREATE UNIQUE INDEX billing_mutation_targets_session_key_idx ON billing_mutation_targets (stripe_session_idempotency_key)`,
      `CREATE TABLE billing_mutation_secrets (
        command_id text PRIMARY KEY REFERENCES mutation_commands(id) ON DELETE CASCADE,
        response_enc text NOT NULL,
        response_iv text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE TABLE billing_webhook_events (
        event_id text PRIMARY KEY,
        payload_hash text NOT NULL,
        event_type text NOT NULL,
        provider_created integer NOT NULL,
        object_id text,
        subscription_id text,
        user_id text,
        status text NOT NULL,
        billing_status text,
        stripe_customer_id text,
        stripe_subscription_id text,
        stripe_price_id text,
        billing_current_period_end integer,
        billing_cancel_at_period_end integer,
        result_json text NOT NULL DEFAULT '{}',
        processed_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX billing_webhook_events_user_time_idx ON billing_webhook_events (user_id, provider_created)`,
      `CREATE INDEX billing_webhook_events_subscription_time_idx ON billing_webhook_events (subscription_id, provider_created)`,
      `CREATE TABLE billing_subscription_cursors (
        subscription_id text PRIMARY KEY,
        user_id text,
        last_event_created integer NOT NULL,
        last_event_id text NOT NULL,
        updated_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX billing_subscription_cursors_user_idx ON billing_subscription_cursors (user_id, updated_at)`,
      `CREATE TABLE project_install_plans (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision integer NOT NULL,
        contract_json text NOT NULL,
        contract_sha256 text NOT NULL,
        repo_snapshot_json text NOT NULL,
        source_request_sha256 text NOT NULL,
        base_signal_map_etag text,
        created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX project_install_plans_project_revision_idx ON project_install_plans (project_id, revision)`,
      `CREATE INDEX project_install_plans_project_created_idx ON project_install_plans (project_id, created_at)`,
      `CREATE INDEX project_install_plans_project_contract_idx ON project_install_plans (project_id, contract_sha256)`,
      `CREATE TABLE project_install_plan_approvals (
        plan_id text PRIMARY KEY REFERENCES project_install_plans(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        attestation_kind text NOT NULL,
        attestation_source text NOT NULL,
        statement text NOT NULL,
        notes_json text NOT NULL DEFAULT '[]',
        attested_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        attested_at integer NOT NULL DEFAULT (unixepoch()),
        signal_map_etag text NOT NULL
      )`,
      `CREATE INDEX project_install_plan_approvals_project_time_idx ON project_install_plan_approvals (project_id, attested_at)`,
      `CREATE INDEX project_install_plan_approvals_approver_time_idx ON project_install_plan_approvals (attested_by, attested_at)`,
      `CREATE TABLE project_signal_maps (
        project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        plan_id text REFERENCES project_install_plans(id) ON DELETE RESTRICT,
        plan_revision integer,
        signal_map_etag text,
        repo_snapshot_json text,
        approval_kind text,
        approved_by text REFERENCES users(id) ON DELETE RESTRICT,
        contract_version text NOT NULL,
        framework text NOT NULL,
        surface text NOT NULL,
        signal_types_json text NOT NULL DEFAULT '[]',
        shapes_json text NOT NULL DEFAULT '[]',
        has_revenue integer NOT NULL DEFAULT 0,
        is_b2b integer NOT NULL DEFAULT 0,
        is_two_sided integer NOT NULL DEFAULT 0,
        mode text,
        approved_events_json text NOT NULL DEFAULT '[]',
        approved_event_properties_json text NOT NULL DEFAULT '{}',
        provider_satisfied_events_json text NOT NULL DEFAULT '[]',
        discovery_map_json text NOT NULL DEFAULT '{}',
        event_buckets_json text NOT NULL DEFAULT '[]',
        happy_path_funnel_json text NOT NULL DEFAULT '[]',
        failure_surface_map_json text NOT NULL DEFAULT '[]',
        planned_wiring_map_json text NOT NULL DEFAULT '[]',
        questions_to_answer_json text NOT NULL DEFAULT '[]',
        post_setup_blueprint_json text NOT NULL DEFAULT '{}',
        recipe_decisions_json text NOT NULL DEFAULT '[]',
        approval_notes_json text NOT NULL DEFAULT '[]',
        approved_plan_hash text NOT NULL,
        approved_at integer NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX project_signal_maps_approved_at_idx ON project_signal_maps (approved_at)`,
      `CREATE INDEX project_signal_maps_updated_at_idx ON project_signal_maps (updated_at)`,
      `CREATE TABLE project_artifacts (
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        artifact_type text NOT NULL,
        plan_id text REFERENCES project_install_plans(id) ON DELETE CASCADE,
        source_etag text,
        artifact_etag text,
        artifact_json text NOT NULL DEFAULT '{}',
        artifact_version text,
        approved_plan_hash text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (project_id, artifact_type)
      )`,
      `CREATE INDEX project_artifacts_updated_at_idx ON project_artifacts (updated_at)`,
      `CREATE TABLE onboarding_proof_sessions (
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
          (status IN ('completed', 'revoked') AND terminal_at IS NOT NULL AND terminal_at >= started_at AND terminal_at < expires_at AND terminal_reason IS NOT NULL AND length(trim(terminal_reason)) > 0)
          OR
          (status = 'expired' AND terminal_at IS NOT NULL AND terminal_at >= expires_at AND terminal_reason IS NOT NULL AND length(trim(terminal_reason)) > 0)
        )
      )`,
      `CREATE UNIQUE INDEX onboarding_proof_sessions_runtime_marker_idx ON onboarding_proof_sessions (runtime_marker_hash)`,
      `CREATE UNIQUE INDEX onboarding_proof_sessions_ci_marker_idx ON onboarding_proof_sessions (ci_marker_hash)`,
      `CREATE INDEX onboarding_proof_sessions_ci_credential_idx ON onboarding_proof_sessions (ci_credential_id)`,
      `CREATE INDEX onboarding_proof_sessions_project_status_idx ON onboarding_proof_sessions (project_id, status, expires_at)`,
      `CREATE INDEX onboarding_proof_sessions_onboarding_idx ON onboarding_proof_sessions (project_id, onboarding_id, started_at)`,
      `CREATE TABLE onboarding_states (
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
        CONSTRAINT onboarding_states_timestamps_check CHECK (
          created_at >= 0 AND updated_at >= created_at
        ),
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
      `CREATE UNIQUE INDEX onboarding_states_onboarding_idx ON onboarding_states (onboarding_id)`,
      `CREATE UNIQUE INDEX onboarding_states_etag_idx ON onboarding_states (etag)`,
      `CREATE INDEX onboarding_states_status_idx ON onboarding_states (status, updated_at)`,
      `CREATE TABLE project_memberships (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member',
        invited_by text REFERENCES users(id) ON DELETE SET NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX project_memberships_unique ON project_memberships (project_id, user_id)`,
      `CREATE INDEX project_memberships_user_idx ON project_memberships (user_id)`,
      `CREATE INDEX project_memberships_proj_idx ON project_memberships (project_id)`,
      `CREATE TABLE project_invites (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        invited_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email text,
        role text NOT NULL DEFAULT 'member',
        token_hash text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        expires_at integer NOT NULL,
        consumed_at integer,
        consumed_by text REFERENCES users(id) ON DELETE SET NULL
      )`,
      `CREATE UNIQUE INDEX project_invites_token_idx ON project_invites (token_hash)`,
      `CREATE INDEX project_invites_proj_idx ON project_invites (project_id)`,
      `CREATE TABLE cases (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider_issue_id text NOT NULL,
        provider_snapshot_hash text NOT NULL,
        provider_projected_at integer NOT NULL,
        last_provider_event_id text,
        provider_event_classification text NOT NULL DEFAULT 'unclassified',
        fingerprint text NOT NULL,
        error_type text NOT NULL,
        message text NOT NULL,
        status text NOT NULL DEFAULT 'active',
        event_count integer NOT NULL DEFAULT 0,
        first_seen_at integer NOT NULL DEFAULT (unixepoch()),
        last_seen_at integer NOT NULL DEFAULT (unixepoch()),
        last_deploy_sha text,
        last_environment text,
        agent_summary text,
        pr_url text,
        last_trust_level text NOT NULL DEFAULT 'customer_posthog',
        last_credential_kind text NOT NULL DEFAULT 'posthog_oauth',
        revision integer NOT NULL DEFAULT 1,
        CONSTRAINT cases_provider_projection_check CHECK (
          status IN ('active', 'resolved', 'suppressed')
          AND length(provider_snapshot_hash) = 64
          AND provider_snapshot_hash NOT GLOB '*[^a-f0-9]*'
          AND provider_projected_at > 0
          AND event_count >= 0
          AND first_seen_at >= 0
          AND last_seen_at >= first_seen_at
          AND provider_event_classification IN (
            'unclassified', 'customer_exception', 'onboarding_proof_exception'
          )
          AND last_trust_level = 'customer_posthog'
          AND last_credential_kind = 'posthog_oauth'
          AND revision >= 1
        )
      )`,
      `CREATE UNIQUE INDEX cases_provider_issue_idx ON cases (project_id, provider_issue_id)`,
      `CREATE UNIQUE INDEX cases_proj_fp_idx ON cases (project_id, fingerprint)`,
      `CREATE INDEX cases_proj_status_idx
        ON cases (project_id, provider_event_classification, status, last_seen_at)`,
      `CREATE TABLE case_mutation_commands (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        actor_user_id text NOT NULL,
        idempotency_key_hash text NOT NULL,
        request_hash text NOT NULL,
        expected_revision integer NOT NULL,
        committed_revision integer NOT NULL,
        response_json text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX case_mutation_commands_project_key_idx ON case_mutation_commands (project_id, idempotency_key_hash)`,
      `CREATE INDEX case_mutation_commands_case_time_idx ON case_mutation_commands (case_id, created_at)`,
      `CREATE TABLE automation_contracts (
        project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        schema_version text NOT NULL,
        revision integer NOT NULL DEFAULT 1,
        enabled integer NOT NULL DEFAULT 0,
        etag text NOT NULL,
        document_json text NOT NULL,
        created_by text REFERENCES users(id) ON DELETE SET NULL,
        updated_by text REFERENCES users(id) ON DELETE SET NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        paused_at integer,
        pause_reason text
      )`,
      `CREATE INDEX automation_contracts_enabled_idx ON automation_contracts (enabled, updated_at)`,
      `CREATE TABLE automation_workflows (
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        current_revision_id text NOT NULL,
        current_revision integer NOT NULL,
        active_revision_id text,
        etag text NOT NULL,
        enabled integer NOT NULL DEFAULT 0,
        created_by text REFERENCES users(id) ON DELETE SET NULL,
        updated_by text REFERENCES users(id) ON DELETE SET NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        paused_at integer,
        pause_reason text,
        CONSTRAINT automation_workflows_pk PRIMARY KEY (project_id, automation_id),
        CONSTRAINT automation_workflows_revision_check CHECK (current_revision >= 1),
        CONSTRAINT automation_workflows_enabled_check CHECK (enabled IN (0, 1)),
        CONSTRAINT automation_workflows_active_check CHECK (
          (enabled = 0 AND active_revision_id IS NULL)
          OR (enabled = 1 AND active_revision_id IS current_revision_id)
        )
      )`,
      `CREATE INDEX automation_workflows_enabled_idx ON automation_workflows (enabled, updated_at)`,
      `CREATE TABLE automation_workflow_revisions (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        revision integer NOT NULL,
        schema_version text NOT NULL,
        workflow_json text NOT NULL,
        workflow_hash text NOT NULL,
        compiled_json text NOT NULL,
        compile_hash text NOT NULL,
        component_hashes_json text NOT NULL,
        created_by text REFERENCES users(id) ON DELETE SET NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT automation_workflow_revisions_revision_check CHECK (revision >= 1),
        CONSTRAINT automation_workflow_revisions_schema_check CHECK (schema_version = '3'),
        CONSTRAINT automation_workflow_revisions_json_check CHECK (
          json_valid(workflow_json) AND json_type(workflow_json) = 'object'
          AND json_valid(compiled_json) AND json_type(compiled_json) = 'object'
          AND json_valid(component_hashes_json) AND json_type(component_hashes_json) = 'object'
          AND length(workflow_json) <= 1048576
          AND length(compiled_json) <= 4194304
          AND length(component_hashes_json) <= 262144
        ),
        CONSTRAINT automation_workflow_revisions_hash_check CHECK (
          length(workflow_hash) = 64 AND workflow_hash NOT GLOB '*[^a-f0-9]*'
          AND length(compile_hash) = 64 AND compile_hash NOT GLOB '*[^a-f0-9]*'
        )
      )`,
      `CREATE UNIQUE INDEX automation_workflow_revisions_project_revision_idx
        ON automation_workflow_revisions (project_id, automation_id, revision)`,
      `CREATE INDEX automation_workflow_revisions_project_created_idx
        ON automation_workflow_revisions (project_id, automation_id, created_at)`,
      `CREATE TRIGGER automation_workflow_revisions_no_update
       BEFORE UPDATE ON automation_workflow_revisions
       BEGIN
         SELECT RAISE(ABORT, 'automation workflow revisions are immutable');
       END`,
      `CREATE TRIGGER automation_workflows_revision_binding_insert
       BEFORE INSERT ON automation_workflows
       WHEN NOT EXISTS (
         SELECT 1 FROM automation_workflow_revisions revision_row
          WHERE revision_row.id = NEW.current_revision_id
            AND revision_row.project_id IS NEW.project_id
            AND revision_row.automation_id IS NEW.automation_id
            AND revision_row.revision IS NEW.current_revision
       )
       BEGIN
         SELECT RAISE(ABORT, 'automation workflow head must bind its exact immutable revision');
       END`,
      `CREATE TRIGGER automation_workflows_revision_binding_update
       BEFORE UPDATE ON automation_workflows
       WHEN NEW.project_id IS NOT OLD.project_id
         OR NEW.automation_id IS NOT OLD.automation_id
         OR NOT EXISTS (
           SELECT 1 FROM automation_workflow_revisions revision_row
            WHERE revision_row.id = NEW.current_revision_id
              AND revision_row.project_id IS NEW.project_id
              AND revision_row.automation_id IS NEW.automation_id
              AND revision_row.revision IS NEW.current_revision
         )
       BEGIN
         SELECT RAISE(ABORT, 'automation workflow head identity or revision binding is invalid');
       END`,
      `CREATE TABLE automation_scheduler_cursors (
        sweep_name text PRIMARY KEY,
        cursor_project_id text,
        revision integer NOT NULL DEFAULT 0,
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT automation_scheduler_cursors_revision_check CHECK (revision >= 0)
      )`,
      `CREATE TABLE automation_runs (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        contract_revision integer NOT NULL,
        contract_etag text NOT NULL,
        policy_snapshot_json text NOT NULL,
        case_id text REFERENCES cases(id) ON DELETE SET NULL,
        case_revision integer,
        trigger_receipt_id text NOT NULL,
        trigger_kind text NOT NULL,
        trigger_ref text,
        trigger_snapshot_json text NOT NULL DEFAULT '{}',
        idempotency_key_hash text NOT NULL,
        request_hash text NOT NULL,
        attempt integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'queued',
        runner_provider text,
        runner_id text,
        runner_credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL,
        model text,
        branch text,
        commit_sha text,
        pr_url text,
        deploy_sha text,
        summary_md text,
        evidence_json text NOT NULL DEFAULT '{}',
        verification_json text,
        verification_started_at integer,
        pr_proof_json text,
        pr_proof_hash text,
        pr_proof_credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL,
        pr_proof_at integer,
        turns_used integer NOT NULL DEFAULT 0,
        cost_micros integer NOT NULL DEFAULT 0,
        usage_sequence integer NOT NULL DEFAULT 0,
        deadline_at integer NOT NULL,
        last_heartbeat_at integer,
        retry_eligible_at integer,
        error_code text,
        error_message text,
        started_at integer,
        finished_at integer,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX automation_runs_project_status_idx ON automation_runs (project_id, status, created_at)`,
      `CREATE INDEX automation_runs_case_idx ON automation_runs (case_id, case_revision, created_at)`,
      `CREATE INDEX automation_runs_automation_idx ON automation_runs (project_id, automation_id, created_at)`,
      `CREATE UNIQUE INDEX automation_runs_idempotency_idx ON automation_runs (project_id, idempotency_key_hash)`,
      `CREATE UNIQUE INDEX automation_runs_trigger_receipt_idx ON automation_runs (trigger_receipt_id)`,
      `CREATE INDEX automation_runs_deadline_idx ON automation_runs (status, deadline_at)`,
      `CREATE TABLE automation_workflow_run_states (
        run_id text PRIMARY KEY REFERENCES automation_runs(id) ON DELETE CASCADE,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        workflow_revision_id text NOT NULL REFERENCES automation_workflow_revisions(id) ON DELETE RESTRICT,
        workflow_hash text NOT NULL,
        compile_hash text NOT NULL,
        state_version integer NOT NULL,
        status text NOT NULL,
        current_node_id text,
        state_json text NOT NULL,
        state_hash text NOT NULL,
        ready_at integer,
        active_runtime_seconds integer NOT NULL DEFAULT 0,
        elapsed_deadline_at integer NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT automation_workflow_run_states_version_check CHECK (state_version >= 1),
        CONSTRAINT automation_workflow_run_states_status_check CHECK (status IN (
          'running', 'awaiting_component', 'awaiting_approval', 'effect_reserved',
          'effect_indeterminate', 'waiting', 'verifying', 'completed', 'escalated',
          'cancelled', 'quarantined'
        )),
        CONSTRAINT automation_workflow_run_states_json_check CHECK (
          json_valid(state_json) AND json_type(state_json) = 'object' AND length(state_json) <= 4194304
        ),
        CONSTRAINT automation_workflow_run_states_hash_check CHECK (
          length(workflow_hash) = 64 AND workflow_hash NOT GLOB '*[^a-f0-9]*'
          AND length(compile_hash) = 64 AND compile_hash NOT GLOB '*[^a-f0-9]*'
          AND length(state_hash) = 64 AND state_hash NOT GLOB '*[^a-f0-9]*'
        ),
        CONSTRAINT automation_workflow_run_states_time_check CHECK (
          active_runtime_seconds >= 0 AND elapsed_deadline_at >= created_at AND updated_at >= created_at
        )
      )`,
      `CREATE INDEX automation_workflow_run_states_project_status_idx
        ON automation_workflow_run_states (project_id, status, updated_at)`,
      `CREATE INDEX automation_workflow_run_states_due_idx
        ON automation_workflow_run_states (status, ready_at, elapsed_deadline_at)`,
      `CREATE TABLE automation_workflow_commands (
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        command_id text NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        request_hash text NOT NULL,
        expected_revision integer NOT NULL,
        committed_revision integer NOT NULL,
        first_sequence integer NOT NULL,
        last_sequence integer NOT NULL,
        actor_principal text NOT NULL,
        actor_credential_id text,
        response_json text NOT NULL,
        response_hash text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT automation_workflow_commands_pk PRIMARY KEY (run_id, command_id),
        CONSTRAINT automation_workflow_commands_revision_check CHECK (
          expected_revision >= 0 AND committed_revision = last_sequence
          AND first_sequence = expected_revision + 1 AND last_sequence >= first_sequence
        ),
        CONSTRAINT automation_workflow_commands_json_check CHECK (
          json_valid(response_json) AND json_type(response_json) = 'object' AND length(response_json) <= 4194304
        ),
        CONSTRAINT automation_workflow_commands_hash_check CHECK (
          length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'
          AND length(response_hash) = 64 AND response_hash NOT GLOB '*[^a-f0-9]*'
        )
      )`,
      `CREATE INDEX automation_workflow_commands_project_time_idx
        ON automation_workflow_commands (project_id, created_at)`,
      `CREATE TABLE automation_workflow_run_events (
        id text PRIMARY KEY,
        prior_event_hash text,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        sequence integer NOT NULL,
        command_id text NOT NULL,
        request_hash text NOT NULL,
        event_version text NOT NULL,
        event text NOT NULL,
        workflow_hash text NOT NULL,
        compile_hash text NOT NULL,
        node_id text,
        component_hash text,
        payload_schema_ref text,
        payload_json text NOT NULL,
        payload_hash text NOT NULL,
        actor_principal text NOT NULL,
        actor_credential_id text,
        at integer NOT NULL DEFAULT (unixepoch()),
        CONSTRAINT automation_workflow_run_events_sequence_check CHECK (sequence >= 1),
        CONSTRAINT automation_workflow_run_events_version_check CHECK (event_version = '1'),
        CONSTRAINT automation_workflow_run_events_json_check CHECK (
          json_valid(payload_json) AND json_type(payload_json) = 'object' AND length(payload_json) <= 4194304
        ),
        CONSTRAINT automation_workflow_run_events_hash_check CHECK (
          length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'
          AND ((sequence = 1 AND prior_event_hash IS NULL)
            OR (sequence > 1 AND length(prior_event_hash) = 64 AND prior_event_hash NOT GLOB '*[^a-f0-9]*'))
          AND length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'
          AND length(workflow_hash) = 64 AND workflow_hash NOT GLOB '*[^a-f0-9]*'
          AND length(compile_hash) = 64 AND compile_hash NOT GLOB '*[^a-f0-9]*'
          AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'
        )
      )`,
      `CREATE UNIQUE INDEX automation_workflow_run_events_run_sequence_idx
        ON automation_workflow_run_events (run_id, sequence)`,
      `CREATE INDEX automation_workflow_run_events_command_idx
        ON automation_workflow_run_events (run_id, command_id, sequence)`,
      `CREATE INDEX automation_workflow_run_events_project_time_idx
        ON automation_workflow_run_events (project_id, at)`,
      `CREATE TABLE automation_workflow_suspensions (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        version integer NOT NULL DEFAULT 1,
        binding_hash text,
        subject_json text,
        subject_hash text,
        next_check_at integer,
        deadline_at integer NOT NULL,
        result_json text,
        result_hash text,
        decision_by text REFERENCES users(id) ON DELETE SET NULL,
        decision_reason text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        resolved_at integer,
        CONSTRAINT automation_workflow_suspensions_version_check CHECK (version >= 1),
        CONSTRAINT automation_workflow_suspensions_kind_check CHECK (kind IN ('approval', 'wait', 'verify')),
        CONSTRAINT automation_workflow_suspensions_status_check CHECK (status IN (
          'pending', 'approved', 'rejected', 'expired', 'ready', 'passed', 'not_passed',
          'timed_out', 'error', 'cancelled'
        )),
        CONSTRAINT automation_workflow_suspensions_kind_status_check CHECK (
          (kind = 'approval' AND status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled'))
          OR (kind = 'wait' AND status IN ('pending', 'ready', 'timed_out', 'error', 'cancelled'))
          OR (kind = 'verify' AND status IN ('pending', 'passed', 'not_passed', 'timed_out', 'error', 'cancelled'))
        ),
        CONSTRAINT automation_workflow_suspensions_time_check CHECK (
          deadline_at >= created_at AND updated_at >= created_at
          AND (next_check_at IS NULL OR next_check_at <= deadline_at)
          AND ((status = 'pending' AND resolved_at IS NULL) OR (status <> 'pending' AND resolved_at IS NOT NULL))
        ),
        CONSTRAINT automation_workflow_suspensions_subject_check CHECK (
          (subject_json IS NULL) = (subject_hash IS NULL)
          AND (subject_json IS NULL OR (json_valid(subject_json) AND json_type(subject_json) = 'object' AND length(subject_json) <= 262144))
          AND ((kind = 'approval' AND binding_hash IS NOT NULL AND subject_json IS NOT NULL AND next_check_at IS NULL)
            OR (kind IN ('wait', 'verify') AND binding_hash IS NULL AND subject_json IS NULL))
        ),
        CONSTRAINT automation_workflow_suspensions_result_check CHECK (
          (result_json IS NULL) = (result_hash IS NULL)
          AND (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object' AND length(result_json) <= 1048576))
          AND (kind <> 'approval' OR result_json IS NULL)
        ),
        CONSTRAINT automation_workflow_suspensions_hash_check CHECK (
          (binding_hash IS NULL OR (length(binding_hash) = 64 AND binding_hash NOT GLOB '*[^a-f0-9]*'))
          AND (subject_hash IS NULL OR (length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^a-f0-9]*'))
          AND (result_hash IS NULL OR (length(result_hash) = 64 AND result_hash NOT GLOB '*[^a-f0-9]*'))
        )
      )`,
      `CREATE UNIQUE INDEX automation_workflow_suspensions_run_node_idx
        ON automation_workflow_suspensions (run_id, node_id)`,
      `CREATE INDEX automation_workflow_suspensions_due_idx
        ON automation_workflow_suspensions (status, next_check_at, deadline_at)`,
      `CREATE INDEX automation_workflow_suspensions_project_status_idx
        ON automation_workflow_suspensions (project_id, status, updated_at)`,
      `CREATE TABLE automation_workflow_effects (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        node_id text NOT NULL,
        component_id text NOT NULL,
        component_version text NOT NULL,
        component_hash text NOT NULL,
        approval_suspension_id text REFERENCES automation_workflow_suspensions(id) ON DELETE RESTRICT,
        input_hash text NOT NULL,
        intent_hash text NOT NULL,
        provider_target text NOT NULL,
        status text NOT NULL,
        version integer NOT NULL DEFAULT 1,
        reconciliation_count integer NOT NULL DEFAULT 0,
        reconcile_after_at integer,
        provider_ref text,
        receipt_json text,
        receipt_hash text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        call_started_at integer,
        completed_at integer,
        CONSTRAINT automation_workflow_effects_version_check CHECK (version >= 1 AND reconciliation_count >= 0),
        CONSTRAINT automation_workflow_effects_status_check CHECK (status IN (
          'reserved', 'indeterminate', 'succeeded', 'failed', 'cancelled'
        )),
        CONSTRAINT automation_workflow_effects_time_check CHECK (
          updated_at >= created_at
          AND (call_started_at IS NULL OR call_started_at >= created_at)
          AND (completed_at IS NULL OR completed_at >= created_at)
          AND ((status = 'reserved' AND call_started_at IS NULL AND completed_at IS NULL
              AND reconcile_after_at IS NULL AND receipt_json IS NULL)
            OR (status = 'indeterminate' AND call_started_at IS NOT NULL AND completed_at IS NULL
              AND reconcile_after_at IS NOT NULL AND reconcile_after_at >= updated_at AND receipt_json IS NULL)
            OR (status = 'succeeded' AND call_started_at IS NOT NULL AND completed_at IS NOT NULL
              AND reconcile_after_at IS NULL AND receipt_json IS NOT NULL)
            OR (status = 'failed' AND completed_at IS NOT NULL AND reconcile_after_at IS NULL)
            OR (status = 'cancelled' AND call_started_at IS NULL AND completed_at IS NOT NULL
              AND reconcile_after_at IS NULL))
        ),
        CONSTRAINT automation_workflow_effects_receipt_check CHECK (
          (receipt_json IS NULL) = (receipt_hash IS NULL)
          AND (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND length(receipt_json) <= 1048576))
        ),
        CONSTRAINT automation_workflow_effects_hash_check CHECK (
          length(component_hash) = 64 AND component_hash NOT GLOB '*[^a-f0-9]*'
          AND length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'
          AND length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^a-f0-9]*'
          AND (receipt_hash IS NULL OR (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^a-f0-9]*'))
        )
      )`,
      `CREATE UNIQUE INDEX automation_workflow_effects_run_node_idx
        ON automation_workflow_effects (run_id, node_id)`,
      `CREATE UNIQUE INDEX automation_workflow_effects_intent_idx
        ON automation_workflow_effects (intent_hash)`,
      `CREATE INDEX automation_workflow_effects_reconcile_idx
        ON automation_workflow_effects (status, reconcile_after_at, updated_at)`,
      `CREATE INDEX automation_workflow_effects_project_status_idx
        ON automation_workflow_effects (project_id, status, updated_at)`,
      `CREATE TABLE automation_run_report_sources (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        runner_credential_id text NOT NULL,
        idempotency_key_hash text NOT NULL,
        request_hash text NOT NULL,
        plan_hash text NOT NULL,
        blueprint_id text NOT NULL,
        output_schema_version text NOT NULL,
        period_start integer NOT NULL,
        period_end integer NOT NULL,
        row_count integer NOT NULL,
        source_json text NOT NULL,
        source_hash text NOT NULL,
        readiness_json text NOT NULL,
        queried_at integer NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX automation_run_report_sources_run_idx ON automation_run_report_sources (run_id)`,
      `CREATE UNIQUE INDEX automation_run_report_sources_idempotency_idx ON automation_run_report_sources (project_id, idempotency_key_hash)`,
      `CREATE INDEX automation_run_report_sources_project_time_idx ON automation_run_report_sources (project_id, created_at)`,
      `CREATE TABLE automation_run_events (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        event text NOT NULL,
        from_status text,
        to_status text,
        actor text,
        data_json text NOT NULL DEFAULT '{}',
        at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX automation_run_events_run_time_idx ON automation_run_events (run_id, at)`,
      `CREATE INDEX automation_run_events_project_time_idx ON automation_run_events (project_id, at)`,
      `CREATE TABLE case_claims (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        case_revision integer NOT NULL,
        attempt integer NOT NULL,
        run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
        trigger_receipt_id text NOT NULL,
        idempotency_key_hash text NOT NULL,
        request_hash text NOT NULL,
        lease_token_hash text NOT NULL,
        lease_token_enc text NOT NULL,
        lease_token_iv text NOT NULL,
        claimed_by text NOT NULL,
        credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL,
        acquired_at integer NOT NULL DEFAULT (unixepoch()),
        expires_at integer NOT NULL,
        released_at integer,
        release_reason text
      )`,
      `CREATE UNIQUE INDEX case_claims_attempt_idx ON case_claims (case_id, case_revision, attempt)`,
      `CREATE UNIQUE INDEX case_claims_idempotency_idx ON case_claims (project_id, idempotency_key_hash)`,
      `CREATE INDEX case_claims_active_idx ON case_claims (project_id, expires_at, released_at)`,
      `CREATE INDEX case_claims_run_idx ON case_claims (run_id)`,
      `CREATE UNIQUE INDEX case_claims_trigger_receipt_idx ON case_claims (trigger_receipt_id)`,
      `CREATE TABLE automation_approvals (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        action text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        requested_by text,
        decided_by text REFERENCES users(id) ON DELETE SET NULL,
        request_reason text NOT NULL,
        decision_reason text,
        subject_hash text NOT NULL,
        subject_json text NOT NULL,
        requested_at integer NOT NULL DEFAULT (unixepoch()),
        decided_at integer,
        expires_at integer NOT NULL
      )`,
      `CREATE INDEX automation_approvals_pending_idx ON automation_approvals (project_id, status, expires_at)`,
      `CREATE UNIQUE INDEX automation_approvals_run_action_idx ON automation_approvals (run_id, action)`,
      `CREATE INDEX automation_approvals_run_idx ON automation_approvals (run_id)`,
      `CREATE TABLE automation_trigger_states (
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        contract_revision integer NOT NULL,
        contract_etag text NOT NULL,
        trigger_hash text NOT NULL,
        trigger_kind text NOT NULL,
        trigger_ref text NOT NULL,
        last_source_evaluated_at integer,
        last_outcome text,
        consecutive_breaches integer NOT NULL DEFAULT 0,
        cooldown_until integer,
        last_receipt_at integer,
        last_schedule_slot integer,
        updated_at integer NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (project_id, automation_id)
      )`,
      `CREATE INDEX automation_trigger_states_due_idx ON automation_trigger_states (trigger_kind, cooldown_until, updated_at)`,
      `CREATE TABLE automation_trigger_receipts (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        contract_revision integer NOT NULL,
        contract_etag text NOT NULL,
        trigger_kind text NOT NULL,
        trigger_key text NOT NULL,
        case_id text REFERENCES cases(id) ON DELETE CASCADE,
        case_revision integer,
        attempt integer,
        alert_id text,
        scheduled_for integer,
        required_trust text NOT NULL,
        source_trust text NOT NULL,
        snapshot_json text NOT NULL,
        snapshot_hash text NOT NULL,
        status text NOT NULL DEFAULT 'ready',
        claim_id text,
        run_id text,
        issued_at integer NOT NULL DEFAULT (unixepoch()),
        not_before_at integer NOT NULL,
        expires_at integer NOT NULL,
        claimed_at integer,
        consumed_at integer,
        cancelled_at integer,
        cancel_reason text
      )`,
      `CREATE UNIQUE INDEX automation_trigger_receipts_key_idx ON automation_trigger_receipts (project_id, automation_id, trigger_key)`,
      `CREATE INDEX automation_trigger_receipts_ready_idx ON automation_trigger_receipts (project_id, automation_id, status, expires_at)`,
      `CREATE INDEX automation_trigger_receipts_case_idx ON automation_trigger_receipts (case_id, case_revision, attempt)`,
      `CREATE INDEX automation_trigger_receipts_run_idx ON automation_trigger_receipts (run_id)`,
      `CREATE TABLE automation_budget_charges (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL,
        kind text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX automation_budget_charges_run_kind_idx ON automation_budget_charges (run_id, kind)`,
      `CREATE INDEX automation_budget_charges_window_idx ON automation_budget_charges (project_id, automation_id, kind, created_at)`,
      `CREATE TABLE automation_action_grants (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        action text NOT NULL,
        subject_hash text NOT NULL,
        subject_json text NOT NULL,
        token_hash text NOT NULL,
        token_enc text NOT NULL,
        token_iv text NOT NULL,
        idempotency_key_hash text NOT NULL,
        request_hash text NOT NULL,
        credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL,
        status text NOT NULL DEFAULT 'issued',
        issued_at integer NOT NULL DEFAULT (unixepoch()),
        expires_at integer NOT NULL,
        consumed_at integer
      )`,
      `CREATE UNIQUE INDEX automation_action_grants_run_action_idx ON automation_action_grants (run_id, action)`,
      `CREATE UNIQUE INDEX automation_action_grants_idempotency_idx ON automation_action_grants (project_id, idempotency_key_hash)`,
      `CREATE INDEX automation_action_grants_status_idx ON automation_action_grants (project_id, status, expires_at)`,
      `CREATE TABLE deploys (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sha text NOT NULL,
        branch text,
        environment text,
        message text,
        url text,
        actor text,
        automation_run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
        source_commit_sha text,
        extra_json text,
        trust_level text NOT NULL,
        credential_kind text NOT NULL,
        credential_id text NOT NULL REFERENCES project_credentials(id) ON DELETE RESTRICT,
        onboarding_proof_session_id text REFERENCES onboarding_proof_sessions(id) ON DELETE SET NULL,
        onboarding_proof_credential_id text,
        received_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX deploys_proj_time_idx ON deploys (project_id, received_at)`,
      `CREATE INDEX deploys_automation_run_idx ON deploys (automation_run_id, received_at)`,
      `CREATE INDEX deploys_onboarding_proof_idx ON deploys (project_id, onboarding_proof_session_id, credential_id, received_at)`,
      `CREATE TABLE webhooks (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        url text NOT NULL,
        description text,
        events text NOT NULL,
        signing_secret_prefix text NOT NULL,
        signing_secret_hash text NOT NULL,
        signing_secret_enc text,
        signing_secret_iv text,
        active integer NOT NULL DEFAULT 1,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        last_fired_at integer,
        last_status integer,
        last_error text
      )`,
      `CREATE INDEX webhooks_proj_idx ON webhooks (project_id, active)`,
      `CREATE TABLE webhook_recipient_sets (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_event_id text NOT NULL,
        source_event_hash text NOT NULL,
        event text NOT NULL,
        webhook_ids_json text NOT NULL DEFAULT '[]',
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX webhook_recipient_sets_source_event_idx ON webhook_recipient_sets (project_id, source_event_id)`,
      `CREATE INDEX webhook_recipient_sets_project_time_idx ON webhook_recipient_sets (project_id, created_at)`,
      `CREATE TABLE webhook_deliveries (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        webhook_id text REFERENCES webhooks(id) ON DELETE SET NULL,
        source_event_id text NOT NULL,
        source_event_hash text NOT NULL,
        event text NOT NULL,
        payload_json text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 8,
        next_attempt_at integer NOT NULL DEFAULT (unixepoch()),
        locked_at integer,
        locked_by text,
        last_attempt_at integer,
        delivered_at integer,
        last_status_code integer,
        last_error text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at)`,
      `CREATE UNIQUE INDEX webhook_deliveries_source_event_idx ON webhook_deliveries (webhook_id, source_event_id)`,
      `CREATE INDEX webhook_deliveries_webhook_time_idx ON webhook_deliveries (webhook_id, created_at)`,
      `CREATE INDEX webhook_deliveries_project_time_idx ON webhook_deliveries (project_id, created_at)`,
      `CREATE TRIGGER webhook_deliveries_active_subscription_guard
       AFTER INSERT ON webhook_deliveries
       WHEN NEW.webhook_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM webhooks
         WHERE id = NEW.webhook_id
           AND project_id = NEW.project_id
           AND active = 1
       )
       BEGIN
         UPDATE webhook_deliveries
         SET status = 'cancelled',
             locked_at = NULL,
             locked_by = NULL,
             last_error = 'webhook_inactive_at_enqueue',
             updated_at = unixepoch()
         WHERE id = NEW.id;
       END`,
      `CREATE TABLE alerts (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name text NOT NULL,
        description text,
        recipe_id text NOT NULL,
        params_json text NOT NULL DEFAULT '{}',
        threshold_column text NOT NULL,
        threshold_op text NOT NULL,
        threshold_value text NOT NULL,
        webhook_id text,
        active integer NOT NULL DEFAULT 1,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        last_evaluated_at integer,
        last_triggered_at integer,
        last_value text,
        last_state text
      )`,
      `CREATE INDEX alerts_proj_idx ON alerts (project_id, active)`,
      `CREATE TABLE project_deletion_fences (
        project_id text PRIMARY KEY REFERENCES projects(id),
        command_id text NOT NULL,
        reason text NOT NULL,
        actor text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE TABLE feedback (
        id text PRIMARY KEY,
        user_id text REFERENCES users(id) ON DELETE SET NULL,
        project_id text REFERENCES projects(id) ON DELETE SET NULL,
        kind text NOT NULL DEFAULT 'other',
        message text NOT NULL,
        agent_note text,
        tool_name text,
        attempt_count integer,
        fingerprint text,
        claude_session_id text,
        created_at integer NOT NULL DEFAULT (unixepoch()),
        resolved integer NOT NULL DEFAULT 0,
        resolution text
      )`,
      `CREATE INDEX feedback_user_idx ON feedback (user_id, created_at)`,
      `CREATE INDEX feedback_kind_idx ON feedback (kind, resolved, created_at)`,
      `CREATE INDEX feedback_user_fingerprint_idx ON feedback (user_id, fingerprint, resolved, created_at)`,
      `CREATE TABLE audit_log (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        project_id text,
        operation_id text NOT NULL,
        request_hash text NOT NULL,
        phase text NOT NULL,
        action text NOT NULL,
        resource_type text NOT NULL,
        resource_id text,
        summary text,
        metadata_json text,
        ip text,
        ua text,
        at integer NOT NULL DEFAULT (unixepoch()),
        occurred_at_ms integer NOT NULL DEFAULT (unixepoch() * 1000)
      )`,
      `CREATE UNIQUE INDEX audit_operation_phase_idx ON audit_log (operation_id, phase)`,
      `CREATE INDEX audit_user_time_idx ON audit_log (user_id, occurred_at_ms)`,
      `CREATE INDEX audit_proj_time_idx ON audit_log (project_id, occurred_at_ms)`,
      `CREATE INDEX audit_action_idx ON audit_log (user_id, action, at)`,
      `CREATE TRIGGER audit_log_no_update
       BEFORE UPDATE ON audit_log
       BEGIN
         SELECT RAISE(ABORT, 'audit_log rows are append-only');
       END`,
      `CREATE TRIGGER audit_log_retention_delete_only
       BEFORE DELETE ON audit_log
       WHEN OLD.at >= unixepoch() - 7776000
       BEGIN
         SELECT RAISE(ABORT, 'audit_log rows may only be deleted after 90 days');
       END`,
  ];
  await client.batch([
    ...bootstrapStatements.filter((statement) => !/\bautomation_workflow/u.test(statement)),
    ...AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS,
    ...AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS,
    ...POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS.filter((statement) => statement.startsWith("DROP TABLE")),
    ...POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS,
    ...READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS,
  ], "write");

  dbByUrl.set(url, { client, drizzle: d, directory });

  return {
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: "",
    ENABLE_TEST_LOGIN: opts?.enableTestLogin === false ? "false" : "true",
    ...(opts?.withEncKey === false ? {} : { AGENTRY_TOKEN_ENC_KEY: TEST_ENC_KEY }),
  };
}

// Module-mock helper: replace getDb so it returns the seeded Drizzle DB for the URL.
export function getDbForUrl(url: string) {
  const entry = dbByUrl.get(url);
  if (!entry) throw new Error(`No test DB seeded for url ${url}`);
  return entry.drizzle;
}

export function disposeTestEnv(env: Pick<TestEnv, "TURSO_DATABASE_URL">): void {
  const entry = dbByUrl.get(env.TURSO_DATABASE_URL);
  if (!entry) return;
  dbByUrl.delete(env.TURSO_DATABASE_URL);
  entry.client.close();
  if (entry.directory) rmSync(entry.directory, { recursive: true, force: true });
}

export async function createTestProjectCredential(
  env: TestEnv,
  projectId: string,
  kind: ProjectCredentialKind,
  automationId: string | null = null,
) {
  const minted = await mintProjectCredential(projectId, kind);
  const now = Math.floor(Date.now() / 1000);
  const id = uuidv7();
  await getDbForUrl(env.TURSO_DATABASE_URL).insert(schema.projectCredentials).values({
    id,
    projectId,
    kind,
    name: `test ${kind}`,
    prefix: minted.prefix,
    tokenHash: minted.hash,
    automationId,
    createdBy: null,
    createdAt: now,
    expiresAt: now + 86_400,
    lastUsedAt: null,
    revokedAt: null,
    revokeReason: null,
  });
  return { id, credential: minted.raw };
}

export function getRawDbClientForUrl(url: string) {
  const entry = dbByUrl.get(url);
  if (!entry) throw new Error(`No test DB seeded for url ${url}`);
  return entry.client;
}
