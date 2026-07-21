-- Canonical read-only PostHog control-plane bootstrap.
-- Generated from a fully migrated local release database; runtime security
-- triggers are emitted separately in core-bootstrap-triggers.mjs.

CREATE TABLE `account_deletion_fences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`recipe_id` text NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`threshold_column` text NOT NULL,
	`threshold_op` text NOT NULL,
	`threshold_value` text NOT NULL,
	`webhook_id` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_evaluated_at` integer,
	`last_triggered_at` integer,
	`last_value` text,
	`last_state` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'private' NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`name` text,
	`last_used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`phase` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`summary` text,
	`metadata_json` text,
	`ip` text,
	`ua` text,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	`occurred_at_ms` integer DEFAULT (unixepoch() * 1000) NOT NULL
);--> statement-breakpoint
CREATE TABLE `automation_action_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_hash` text NOT NULL,
	`subject_json` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_enc` text NOT NULL,
	`token_iv` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`credential_id` text,
	`status` text DEFAULT 'issued' NOT NULL,
	`issued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `automation_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`decided_by` text,
	`request_reason` text NOT NULL,
	`decision_reason` text,
	`subject_hash` text NOT NULL,
	`subject_json` text NOT NULL,
	`requested_at` integer DEFAULT (unixepoch()) NOT NULL,
	`decided_at` integer,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `automation_budget_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `automation_contracts` (
	`project_id` text PRIMARY KEY NOT NULL,
	`schema_version` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`etag` text NOT NULL,
	`document_json` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`paused_at` integer,
	`pause_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `automation_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`event` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`actor` text,
	`data_json` text DEFAULT '{}' NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `automation_run_report_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`runner_credential_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`plan_hash` text NOT NULL,
	`blueprint_id` text NOT NULL,
	`output_schema_version` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`row_count` integer NOT NULL,
	`source_json` text NOT NULL,
	`source_hash` text NOT NULL,
	`readiness_json` text NOT NULL,
	`queried_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`contract_revision` integer NOT NULL,
	`contract_etag` text NOT NULL,
	`policy_snapshot_json` text NOT NULL,
	`case_id` text,
	`case_revision` integer,
	`trigger_receipt_id` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`trigger_ref` text,
	`trigger_snapshot_json` text DEFAULT '{}' NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`runner_provider` text,
	`runner_id` text,
	`runner_credential_id` text,
	`model` text,
	`branch` text,
	`commit_sha` text,
	`pr_url` text,
	`deploy_sha` text,
	`summary_md` text,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`verification_json` text,
	`verification_started_at` integer,
	`pr_proof_json` text,
	`pr_proof_hash` text,
	`pr_proof_credential_id` text,
	`pr_proof_at` integer,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`usage_sequence` integer DEFAULT 0 NOT NULL,
	`deadline_at` integer NOT NULL,
	`last_heartbeat_at` integer,
	`retry_eligible_at` integer,
	`error_code` text,
	`error_message` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`runner_credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pr_proof_credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `automation_scheduler_cursors` (
	`sweep_name` text PRIMARY KEY NOT NULL,
	`cursor_project_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "automation_scheduler_cursors_revision_check" CHECK("automation_scheduler_cursors"."revision" >= 0)
);--> statement-breakpoint
CREATE TABLE `automation_trigger_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`contract_revision` integer NOT NULL,
	`contract_etag` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`trigger_key` text NOT NULL,
	`case_id` text,
	`case_revision` integer,
	`attempt` integer,
	`alert_id` text,
	`scheduled_for` integer,
	`required_trust` text NOT NULL,
	`source_trust` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`claim_id` text,
	`run_id` text,
	`issued_at` integer DEFAULT (unixepoch()) NOT NULL,
	`not_before_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`consumed_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `automation_trigger_states` (
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`contract_revision` integer NOT NULL,
	`contract_etag` text NOT NULL,
	`trigger_hash` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`trigger_ref` text NOT NULL,
	`last_source_evaluated_at` integer,
	`last_outcome` text,
	`consecutive_breaches` integer DEFAULT 0 NOT NULL,
	`cooldown_until` integer,
	`last_receipt_at` integer,
	`last_schedule_slot` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`project_id`, `automation_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `billing_mutation_secrets` (
	`command_id` text PRIMARY KEY NOT NULL,
	`response_enc` text NOT NULL,
	`response_iv` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `mutation_commands`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `billing_mutation_targets` (
	`command_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`operation` text NOT NULL,
	`target_hash` text NOT NULL,
	`target_json` text NOT NULL,
	`stripe_customer_idempotency_key` text,
	`stripe_session_idempotency_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `mutation_commands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `billing_subscription_cursors` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`last_event_created` integer NOT NULL,
	`last_event_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`event_type` text NOT NULL,
	`provider_created` integer NOT NULL,
	`object_id` text,
	`subscription_id` text,
	`user_id` text,
	`status` text NOT NULL,
	`billing_status` text,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`stripe_price_id` text,
	`billing_current_period_end` integer,
	`billing_cancel_at_period_end` integer,
	`result_json` text DEFAULT '{}' NOT NULL,
	`processed_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE TABLE `case_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`case_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`case_revision` integer NOT NULL,
	`attempt` integer NOT NULL,
	`run_id` text,
	`trigger_receipt_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`lease_token_hash` text NOT NULL,
	`lease_token_enc` text NOT NULL,
	`lease_token_iv` text NOT NULL,
	`claimed_by` text NOT NULL,
	`credential_id` text,
	`acquired_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`released_at` integer,
	`release_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `case_mutation_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`case_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`committed_revision` integer NOT NULL,
	`response_json` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE cases (
          id text PRIMARY KEY NOT NULL,
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
        );--> statement-breakpoint
CREATE TABLE posthog_connections (
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
  );--> statement-breakpoint
CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`project_id` text,
	`kind` text DEFAULT 'other' NOT NULL,
	`message` text NOT NULL,
	`agent_note` text,
	`tool_name` text,
	`attempt_count` integer,
	`fingerprint` text,
	`claude_session_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL,
	`resolution` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`email_verified` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT `identities_oidc_identity_check` CHECK(length(`issuer`) BETWEEN 8 AND 2048
      AND `issuer` LIKE 'https://%'
      AND length(`subject`) BETWEEN 1 AND 512
      AND (`email_verified` IS NULL OR `email_verified` IN (0, 1))
      AND `updated_at` >= `created_at`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE "deploys" (
          id text PRIMARY KEY NOT NULL,
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
        );--> statement-breakpoint
CREATE TABLE `mutation_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`project_id` text,
	`action` text NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text,
	`response_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'succeeded' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`error_json` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "mutation_commands_lease_pair_check" CHECK((("mutation_commands"."lease_token" IS NULL AND "mutation_commands"."lease_expires_at" IS NULL) OR ("mutation_commands"."lease_token" IS NOT NULL AND "mutation_commands"."lease_expires_at" IS NOT NULL AND "mutation_commands"."lease_expires_at" > 0)))
);--> statement-breakpoint
CREATE TABLE `onboarding_states` (
	`project_id` text PRIMARY KEY NOT NULL,
	`onboarding_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`etag` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`plan_json` text NOT NULL,
	`implementation_source_snapshot_json` text,
	`proof_session_json` text,
	`receipt_json` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "onboarding_states_revision_check" CHECK("onboarding_states"."revision" > 0),
	CONSTRAINT "onboarding_states_timestamps_check" CHECK("onboarding_states"."created_at" >= 0 AND "onboarding_states"."updated_at" >= "onboarding_states"."created_at"),
	CONSTRAINT "onboarding_states_json_check" CHECK(json_valid("onboarding_states"."plan_json") AND json_type("onboarding_states"."plan_json") = 'object'
      AND ("onboarding_states"."implementation_source_snapshot_json" IS NULL OR (json_valid("onboarding_states"."implementation_source_snapshot_json") AND json_type("onboarding_states"."implementation_source_snapshot_json") = 'object'))
      AND ("onboarding_states"."proof_session_json" IS NULL OR (json_valid("onboarding_states"."proof_session_json") AND json_type("onboarding_states"."proof_session_json") = 'object'))
      AND ("onboarding_states"."receipt_json" IS NULL OR (json_valid("onboarding_states"."receipt_json") AND json_type("onboarding_states"."receipt_json") = 'object'))),
	CONSTRAINT "onboarding_states_status_documents_check" CHECK((
      ("onboarding_states"."status" IN ('planned', 'approved') AND "onboarding_states"."implementation_source_snapshot_json" IS NULL AND "onboarding_states"."proof_session_json" IS NULL AND "onboarding_states"."receipt_json" IS NULL)
      OR ("onboarding_states"."status" = 'proving' AND "onboarding_states"."implementation_source_snapshot_json" IS NOT NULL AND "onboarding_states"."proof_session_json" IS NOT NULL AND "onboarding_states"."receipt_json" IS NULL)
      OR ("onboarding_states"."status" = 'verified' AND "onboarding_states"."implementation_source_snapshot_json" IS NOT NULL AND "onboarding_states"."proof_session_json" IS NOT NULL AND "onboarding_states"."receipt_json" IS NOT NULL)
    ))
);--> statement-breakpoint
CREATE TABLE `project_artifacts` (
	`project_id` text NOT NULL,
	`artifact_type` text NOT NULL,
	`plan_id` text,
	`source_etag` text,
	`artifact_etag` text,
	`artifact_json` text DEFAULT '{}' NOT NULL,
	`artifact_version` text,
	`approved_plan_hash` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`project_id`, `artifact_type`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `project_install_plans`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `project_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`automation_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoke_reason` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `project_deletion_fences` (
	`project_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE TABLE `project_install_plan_approvals` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`attestation_kind` text NOT NULL,
	`attestation_source` text NOT NULL,
	`statement` text NOT NULL,
	`notes_json` text DEFAULT '[]' NOT NULL,
	`attested_by` text NOT NULL,
	`attested_at` integer DEFAULT (unixepoch()) NOT NULL,
	`signal_map_etag` text NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `project_install_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attested_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE TABLE `project_install_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`revision` integer NOT NULL,
	`contract_json` text NOT NULL,
	`contract_sha256` text NOT NULL,
	`repo_snapshot_json` text NOT NULL,
	`source_request_sha256` text NOT NULL,
	`base_signal_map_etag` text,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE TABLE `project_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`invited_by` text NOT NULL,
	`email` text,
	`role` text DEFAULT 'member' NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`consumed_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consumed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `project_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`invited_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `project_signal_maps` (
	`project_id` text PRIMARY KEY NOT NULL,
	`plan_id` text,
	`plan_revision` integer,
	`signal_map_etag` text,
	`repo_snapshot_json` text,
	`approval_kind` text,
	`approved_by` text,
	`contract_version` text NOT NULL,
	`framework` text NOT NULL,
	`surface` text NOT NULL,
	`signal_types_json` text DEFAULT '[]' NOT NULL,
	`shapes_json` text DEFAULT '[]' NOT NULL,
	`has_revenue` integer DEFAULT 0 NOT NULL,
	`is_b2b` integer DEFAULT 0 NOT NULL,
	`is_two_sided` integer DEFAULT 0 NOT NULL,
	`mode` text,
	`approved_events_json` text DEFAULT '[]' NOT NULL,
	`approved_event_properties_json` text DEFAULT '{}' NOT NULL,
	`provider_satisfied_events_json` text DEFAULT '[]' NOT NULL,
	`discovery_map_json` text DEFAULT '{}' NOT NULL,
	`event_buckets_json` text DEFAULT '[]' NOT NULL,
	`happy_path_funnel_json` text DEFAULT '[]' NOT NULL,
	`failure_surface_map_json` text DEFAULT '[]' NOT NULL,
	`planned_wiring_map_json` text DEFAULT '[]' NOT NULL,
	`questions_to_answer_json` text DEFAULT '[]' NOT NULL,
	`post_setup_blueprint_json` text DEFAULT '{}' NOT NULL,
	`recipe_decisions_json` text DEFAULT '[]' NOT NULL,
	`approval_notes_json` text DEFAULT '[]' NOT NULL,
	`approved_plan_hash` text NOT NULL,
	`approved_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `project_install_plans`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`repo_url` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`local_path` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `public_query_publications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`params_json` text DEFAULT '{}' NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE posthog_oauth_attempts (
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
  );--> statement-breakpoint
CREATE TABLE "onboarding_proof_sessions" (
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
  );--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer,
	`github_username` text,
	`email` text,
	`avatar_url` text,
	`plan` text DEFAULT 'free' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`stripe_price_id` text,
	`billing_status` text DEFAULT 'none' NOT NULL,
	`billing_current_period_end` integer,
	`billing_cancel_at_period_end` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`webhook_id` text,
	`source_event_id` text NOT NULL,
	`source_event_hash` text NOT NULL,
	`event` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`next_attempt_at` integer DEFAULT (unixepoch()) NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`last_attempt_at` integer,
	`delivered_at` integer,
	`last_status_code` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE TABLE `webhook_recipient_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`source_event_hash` text NOT NULL,
	`event` text NOT NULL,
	`webhook_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`description` text,
	`events` text NOT NULL,
	`signing_secret_prefix` text NOT NULL,
	`signing_secret_hash` text NOT NULL,
	`signing_secret_enc` text,
	`signing_secret_iv` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_fired_at` integer,
	`last_status` integer,
	`last_error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE TABLE automation_workflow_project_controls (
    project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    revision integer NOT NULL DEFAULT 1,
    etag text NOT NULL,
    created_by text REFERENCES users(id) ON DELETE SET NULL,
    updated_by text REFERENCES users(id) ON DELETE SET NULL,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    paused_at integer,
    pause_reason text,
    CONSTRAINT automation_workflow_project_controls_revision_check CHECK (revision >= 1),
    CONSTRAINT automation_workflow_project_controls_time_check CHECK (
      updated_at >= created_at
      AND ((paused_at IS NULL AND pause_reason IS NULL)
        OR (paused_at IS NOT NULL AND paused_at >= created_at
          AND typeof(pause_reason) = 'text' AND length(trim(pause_reason)) BETWEEN 1 AND 1000))
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_revisions (
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
  );--> statement-breakpoint
CREATE TABLE automation_workflows (
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    current_revision_id text NOT NULL,
    current_revision integer NOT NULL,
    active_revision_id text,
    active_execution_authority_id text,
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
  );--> statement-breakpoint
CREATE TABLE automation_workflow_execution_authorities (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    workflow_revision_id text NOT NULL REFERENCES automation_workflow_revisions(id) ON DELETE CASCADE,
    workflow_hash text NOT NULL,
    compile_hash text NOT NULL,
    readiness_hash text NOT NULL,
    owner_confirmed_caller_assertion_ids_json text NOT NULL,
    descriptor_kind text NOT NULL,
    descriptor_json text NOT NULL,
    descriptor_hash text NOT NULL,
    runner_credential_id text NOT NULL,
    enabled_by text REFERENCES users(id) ON DELETE SET NULL,
    enabled_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT automation_workflow_execution_authorities_json_check CHECK (
      json_valid(descriptor_json) AND json_type(descriptor_json) = 'object'
      AND length(descriptor_json) <= 262144
      AND json_valid(owner_confirmed_caller_assertion_ids_json)
      AND json_type(owner_confirmed_caller_assertion_ids_json) = 'array'
      AND length(owner_confirmed_caller_assertion_ids_json) <= 262144
      AND descriptor_kind = 'ordered_funnel_period_compare'
      AND json_extract(descriptor_json, '$.schema_version') = '1'
      AND json_extract(descriptor_json, '$.kind') IS descriptor_kind
    ),
    CONSTRAINT automation_workflow_execution_authorities_hash_check CHECK (
      length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'
      AND length(workflow_hash) = 64 AND workflow_hash NOT GLOB '*[^a-f0-9]*'
      AND length(compile_hash) = 64 AND compile_hash NOT GLOB '*[^a-f0-9]*'
      AND length(readiness_hash) = 64 AND readiness_hash NOT GLOB '*[^a-f0-9]*'
      AND length(descriptor_hash) = 64 AND descriptor_hash NOT GLOB '*[^a-f0-9]*'
    ),
    CONSTRAINT automation_workflow_execution_authorities_time_check CHECK (enabled_at >= 0)
  );--> statement-breakpoint
CREATE TABLE automation_workflow_trigger_receipts (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    workflow_revision_id text NOT NULL REFERENCES automation_workflow_revisions(id) ON DELETE RESTRICT,
    workflow_hash text NOT NULL,
    compile_hash text NOT NULL,
    execution_authority_id text REFERENCES automation_workflow_execution_authorities(id) ON DELETE RESTRICT,
    trigger_node_id text NOT NULL,
    component_id text NOT NULL,
    component_version text NOT NULL,
    component_hash text NOT NULL,
    output_contract text NOT NULL,
    output_schema_hash text NOT NULL,
    trigger_kind text NOT NULL,
    trigger_key text NOT NULL,
    attempt integer NOT NULL,
    payload_json text NOT NULL,
    payload_hash text NOT NULL,
    source_trust text NOT NULL,
    status text NOT NULL DEFAULT 'ready',
    consumed_run_id text,
    issued_at integer NOT NULL DEFAULT (unixepoch()),
    available_at integer NOT NULL,
    expires_at integer NOT NULL,
    consumed_at integer,
    cancelled_at integer,
    cancel_reason text,
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT automation_workflow_trigger_receipts_identity_check CHECK (
      trigger_kind IN ('case', 'schedule')
      AND length(trim(trigger_node_id)) BETWEEN 1 AND 100
      AND component_id IN ('trigger.cases.unhandled', 'trigger.schedule.cron')
      AND length(trim(component_version)) BETWEEN 1 AND 50
      AND length(trim(output_contract)) BETWEEN 1 AND 200
      AND length(trim(trigger_key)) BETWEEN 1 AND 500
      AND attempt >= 1
    ),
    CONSTRAINT automation_workflow_trigger_receipts_json_check CHECK (
      json_valid(payload_json) AND json_type(payload_json) = 'object'
      AND length(payload_json) <= 1048576
    ),
    CONSTRAINT automation_workflow_trigger_receipts_hash_check CHECK (
      length(workflow_hash) = 64 AND workflow_hash NOT GLOB '*[^a-f0-9]*'
      AND length(compile_hash) = 64 AND compile_hash NOT GLOB '*[^a-f0-9]*'
      AND length(component_hash) = 64 AND component_hash NOT GLOB '*[^a-f0-9]*'
      AND length(output_schema_hash) = 64 AND output_schema_hash NOT GLOB '*[^a-f0-9]*'
      AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'
    ),
    CONSTRAINT automation_workflow_trigger_receipts_state_check CHECK (
      status IN ('ready', 'consumed', 'expired', 'cancelled')
      AND (
        (status IN ('ready', 'expired')
          AND consumed_run_id IS NULL AND consumed_at IS NULL
          AND cancelled_at IS NULL AND cancel_reason IS NULL)
        OR (status = 'consumed'
          AND typeof(consumed_run_id) = 'text' AND length(trim(consumed_run_id)) BETWEEN 1 AND 200
          AND consumed_at IS NOT NULL
          AND cancelled_at IS NULL AND cancel_reason IS NULL)
        OR (status = 'cancelled'
          AND consumed_run_id IS NULL AND consumed_at IS NULL
          AND cancelled_at IS NOT NULL
          AND typeof(cancel_reason) = 'text' AND length(trim(cancel_reason)) BETWEEN 1 AND 1000)
      )
    ),
    CONSTRAINT automation_workflow_trigger_receipts_time_check CHECK (
      issued_at >= 0 AND available_at >= 0 AND expires_at > available_at
      AND updated_at >= issued_at
      AND (consumed_at IS NULL OR (consumed_at >= available_at AND consumed_at < expires_at))
      AND (cancelled_at IS NULL OR cancelled_at >= issued_at)
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_runs (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    workflow_revision_id text NOT NULL REFERENCES automation_workflow_revisions(id) ON DELETE RESTRICT,
    workflow_hash text NOT NULL,
    compile_hash text NOT NULL,
    execution_authority_id text REFERENCES automation_workflow_execution_authorities(id) ON DELETE RESTRICT,
    execution_descriptor_hash text,
    trigger_receipt_id text NOT NULL REFERENCES automation_workflow_trigger_receipts(id) ON DELETE RESTRICT,
    trigger_kind text NOT NULL,
    trigger_key text NOT NULL,
    trigger_payload_json text NOT NULL,
    trigger_payload_hash text NOT NULL,
    attempt integer NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_hash text NOT NULL,
    limits_json text NOT NULL,
    limits_hash text NOT NULL,
    runner_credential_id text NOT NULL,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT automation_workflow_runs_trigger_check CHECK (
      trigger_kind IN ('case', 'schedule')
      AND length(trim(trigger_receipt_id)) BETWEEN 1 AND 200
      AND length(trim(trigger_key)) BETWEEN 1 AND 500
      AND attempt >= 1
    ),
    CONSTRAINT automation_workflow_runs_json_check CHECK (
      json_valid(trigger_payload_json) AND json_type(trigger_payload_json) = 'object'
      AND length(trigger_payload_json) <= 1048576
      AND json_valid(limits_json) AND json_type(limits_json) = 'object'
      AND length(limits_json) <= 262144
    ),
    CONSTRAINT automation_workflow_runs_hash_check CHECK (
      length(workflow_hash) = 64 AND workflow_hash NOT GLOB '*[^a-f0-9]*'
      AND length(compile_hash) = 64 AND compile_hash NOT GLOB '*[^a-f0-9]*'
      AND length(trigger_payload_hash) = 64 AND trigger_payload_hash NOT GLOB '*[^a-f0-9]*'
      AND length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'
      AND length(request_hash) = 64 AND request_hash NOT GLOB '*[^a-f0-9]*'
      AND length(limits_hash) = 64 AND limits_hash NOT GLOB '*[^a-f0-9]*'
    ),
    CONSTRAINT automation_workflow_runs_execution_authority_check CHECK (
      (execution_authority_id IS NULL AND execution_descriptor_hash IS NULL)
      OR (execution_authority_id IS NOT NULL
        AND length(execution_descriptor_hash) = 64
        AND execution_descriptor_hash NOT GLOB '*[^a-f0-9]*')
    ),
    CONSTRAINT automation_workflow_runs_time_check CHECK (created_at >= 0 AND updated_at = created_at)
  );--> statement-breakpoint
CREATE TABLE automation_workflow_system_node_claims (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
    run_revision integer NOT NULL,
    node_id text NOT NULL,
    input_hash text NOT NULL,
    claim_epoch integer NOT NULL DEFAULT 1,
    claim_token_hash text NOT NULL,
    status text NOT NULL,
    claimed_at integer NOT NULL DEFAULT (unixepoch()),
    expires_at integer NOT NULL,
    released_at integer,
    completed_at integer,
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT automation_workflow_system_node_claims_identity_check CHECK (
      run_revision >= 1
      AND length(trim(node_id)) BETWEEN 1 AND 200
      AND length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'
      AND length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'
      AND claim_epoch >= 1
      AND length(claim_token_hash) = 64 AND claim_token_hash NOT GLOB '*[^a-f0-9]*'
    ),
    CONSTRAINT automation_workflow_system_node_claims_state_check CHECK (
      status IN ('active', 'released', 'completed')
      AND expires_at > claimed_at
      AND updated_at >= claimed_at
      AND ((status = 'active' AND released_at IS NULL AND completed_at IS NULL)
        OR (status = 'released' AND released_at IS updated_at
          AND released_at >= claimed_at AND completed_at IS NULL)
        OR (status = 'completed' AND completed_at IS updated_at
          AND completed_at >= claimed_at AND released_at IS NULL))
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_run_leases (
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    lease_epoch integer NOT NULL,
    version integer NOT NULL DEFAULT 1,
    holder_principal text NOT NULL,
    holder_credential_id text,
    token_hash text NOT NULL,
    acquired_at integer NOT NULL DEFAULT (unixepoch()),
    renewed_at integer NOT NULL DEFAULT (unixepoch()),
    expires_at integer NOT NULL,
    released_at integer,
    release_reason text,
    CONSTRAINT automation_workflow_run_leases_pk PRIMARY KEY (run_id, lease_epoch),
    CONSTRAINT automation_workflow_run_leases_version_check CHECK (lease_epoch >= 1 AND version >= 1),
    CONSTRAINT automation_workflow_run_leases_holder_check CHECK (
      holder_principal IN ('agentry_system', 'automation_runner', 'trusted_ci')
      AND length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'
    ),
    CONSTRAINT automation_workflow_run_leases_time_check CHECK (
      acquired_at >= 0 AND renewed_at >= acquired_at AND expires_at > renewed_at
      AND ((released_at IS NULL AND release_reason IS NULL)
        OR (released_at IS NOT NULL AND released_at >= acquired_at
          AND typeof(release_reason) = 'text' AND length(trim(release_reason)) BETWEEN 1 AND 1000))
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_run_states (
    run_id text PRIMARY KEY REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
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
    usage_sequence integer NOT NULL DEFAULT 0,
    turns_used integer NOT NULL DEFAULT 0,
    cost_micros integer NOT NULL DEFAULT 0,
    files_changed integer NOT NULL DEFAULT 0,
    changed_line_churn integer NOT NULL DEFAULT 0,
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
    ),
    CONSTRAINT automation_workflow_run_states_usage_check CHECK (
      usage_sequence >= 0 AND turns_used >= 0 AND cost_micros >= 0
      AND files_changed >= 0 AND changed_line_churn >= 0
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_run_events (
    id text PRIMARY KEY,
    prior_event_hash text,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
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
  );--> statement-breakpoint
CREATE TABLE automation_workflow_commands (
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
    command_id text NOT NULL,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    request_hash text NOT NULL,
    expected_revision integer NOT NULL,
    committed_revision integer NOT NULL,
    first_sequence integer NOT NULL,
    last_sequence integer NOT NULL,
    lease_epoch integer,
    actor_principal text NOT NULL,
    actor_credential_id text,
    response_json text NOT NULL,
    response_hash text NOT NULL,
    committed_state_hash text NOT NULL,
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
      AND length(committed_state_hash) = 64 AND committed_state_hash NOT GLOB '*[^a-f0-9]*'
      AND (lease_epoch IS NULL OR lease_epoch >= 1)
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_suspensions (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
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
    CONSTRAINT automation_workflow_suspensions_state_check CHECK (
      (status = 'pending' AND decision_by IS NULL AND decision_reason IS NULL AND result_json IS NULL)
      OR (kind = 'approval' AND status IN ('approved', 'rejected')
        AND decision_by IS NOT NULL AND decision_reason IS NOT NULL AND result_json IS NULL)
      OR (kind = 'approval' AND status IN ('expired', 'cancelled') AND result_json IS NULL)
      OR (kind IN ('wait', 'verify') AND status IN ('ready', 'passed', 'not_passed')
        AND decision_by IS NULL AND decision_reason IS NULL AND result_json IS NOT NULL)
      OR (kind IN ('wait', 'verify') AND status IN ('timed_out', 'error', 'cancelled')
        AND decision_by IS NULL AND result_json IS NULL)
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
  );--> statement-breakpoint
CREATE TABLE automation_workflow_effect_events (
    id text PRIMARY KEY,
    idempotency_key_hash text NOT NULL,
    prior_event_hash text,
    effect_id text NOT NULL,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
    sequence integer NOT NULL,
    event text NOT NULL,
    effect_attempt integer NOT NULL,
    reconciliation_count integer NOT NULL,
    lease_epoch integer,
    payload_json text NOT NULL,
    payload_hash text NOT NULL,
    actor_principal text NOT NULL,
    actor_credential_id text,
    at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT automation_workflow_effect_events_sequence_check CHECK (
      sequence >= 1 AND effect_attempt >= 0 AND reconciliation_count >= 0
      AND (lease_epoch IS NULL OR lease_epoch >= 1)
    ),
    CONSTRAINT automation_workflow_effect_events_event_check CHECK (event IN (
      'effect.intent_reserved', 'effect.call_started', 'effect.completed',
      'effect.reconciled_absent', 'effect.reconciliation_unknown',
      'effect.reconciliation_exhausted'
    )),
    CONSTRAINT automation_workflow_effect_events_json_check CHECK (
      json_valid(payload_json) AND json_type(payload_json) = 'object' AND length(payload_json) <= 1048576
    ),
    CONSTRAINT automation_workflow_effect_events_hash_check CHECK (
      length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'
      AND length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'
      AND ((sequence = 1 AND prior_event_hash IS NULL)
        OR (sequence > 1 AND length(prior_event_hash) = 64 AND prior_event_hash NOT GLOB '*[^a-f0-9]*'))
      AND length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_effects (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
    node_id text NOT NULL,
    component_id text NOT NULL,
    component_version text NOT NULL,
    component_hash text NOT NULL,
    approval_suspension_id text REFERENCES automation_workflow_suspensions(id) ON DELETE RESTRICT,
    approval_binding_hash text,
    input_hash text NOT NULL,
    intent_hash text NOT NULL,
    provider_target text NOT NULL,
    provider_operation_key text NOT NULL,
    created_event_id text NOT NULL REFERENCES automation_workflow_effect_events(id) ON DELETE RESTRICT,
    last_event_id text NOT NULL REFERENCES automation_workflow_effect_events(id) ON DELETE RESTRICT,
    status text NOT NULL,
    version integer NOT NULL DEFAULT 1,
    call_attempt integer NOT NULL DEFAULT 0,
    max_call_attempts integer NOT NULL,
    max_reconciliations integer NOT NULL,
    reconciliation_count integer NOT NULL DEFAULT 0,
    reconcile_after_at integer,
    provider_ref text,
    receipt_json text,
    receipt_hash text,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    updated_at integer NOT NULL DEFAULT (unixepoch()),
    call_started_at integer,
    completed_at integer,
    CONSTRAINT automation_workflow_effects_version_check CHECK (
      version >= 1 AND call_attempt >= 0 AND call_attempt <= max_call_attempts
      AND max_call_attempts >= 1 AND max_reconciliations >= 1
      AND reconciliation_count >= 0 AND reconciliation_count <= max_reconciliations
    ),
    CONSTRAINT automation_workflow_effects_status_check CHECK (
      status IN ('reserved', 'indeterminate', 'succeeded', 'manual_follow_up')
    ),
    CONSTRAINT automation_workflow_effects_time_check CHECK (
      updated_at >= created_at
      AND (call_started_at IS NULL OR call_started_at >= created_at)
      AND (completed_at IS NULL OR completed_at >= created_at)
      AND ((status = 'reserved' AND call_attempt = 0 AND reconciliation_count = 0
          AND call_started_at IS NULL AND completed_at IS NULL
          AND reconcile_after_at IS NULL AND receipt_json IS NULL)
        OR (status = 'indeterminate' AND call_attempt >= 1
          AND call_started_at IS NOT NULL AND completed_at IS NULL AND receipt_json IS NULL)
        OR (status = 'manual_follow_up' AND call_attempt >= 1
          AND call_started_at IS NOT NULL AND completed_at IS NULL
          AND reconcile_after_at IS NULL AND receipt_json IS NULL)
        OR (status = 'succeeded' AND call_attempt >= 1
          AND call_started_at IS NOT NULL AND completed_at IS NOT NULL
          AND reconcile_after_at IS NULL AND receipt_json IS NOT NULL))
    ),
    CONSTRAINT automation_workflow_effects_approval_check CHECK (
      (approval_suspension_id IS NULL) = (approval_binding_hash IS NULL)
    ),
    CONSTRAINT automation_workflow_effects_receipt_check CHECK (
      (receipt_json IS NULL) = (receipt_hash IS NULL)
      AND (receipt_json IS NULL OR (json_valid(receipt_json) AND json_type(receipt_json) = 'object' AND length(receipt_json) <= 1048576))
    ),
    CONSTRAINT automation_workflow_effects_hash_check CHECK (
      length(component_hash) = 64 AND component_hash NOT GLOB '*[^a-f0-9]*'
      AND length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'
      AND length(intent_hash) = 64 AND intent_hash NOT GLOB '*[^a-f0-9]*'
      AND (approval_binding_hash IS NULL OR (length(approval_binding_hash) = 64 AND approval_binding_hash NOT GLOB '*[^a-f0-9]*'))
      AND length(trim(provider_operation_key)) BETWEEN 1 AND 500
      AND (receipt_hash IS NULL OR (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^a-f0-9]*'))
    )
  );--> statement-breakpoint
CREATE TABLE automation_workflow_budget_charges (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    automation_id text NOT NULL,
    run_id text NOT NULL REFERENCES automation_workflow_runs(id) ON DELETE CASCADE,
    kind text NOT NULL,
    subject_key text NOT NULL,
    node_id text,
    effect_attempt integer,
    created_at integer NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT automation_workflow_budget_charges_kind_check CHECK (
      (kind = 'run' AND node_id IS NULL AND effect_attempt IS NULL)
      OR (kind = 'external_effect_call' AND typeof(node_id) = 'text'
        AND length(trim(node_id)) BETWEEN 1 AND 100 AND effect_attempt >= 1)
    ),
    CONSTRAINT automation_workflow_budget_charges_time_check CHECK (created_at >= 0)
  );--> statement-breakpoint
CREATE INDEX `alerts_proj_idx` ON `alerts` (`project_id`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_keys_user_kind_idx` ON `api_keys` (`user_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_operation_phase_idx` ON `audit_log` (`operation_id`,`phase`);--> statement-breakpoint
CREATE INDEX `audit_user_time_idx` ON `audit_log` (`user_id`,`occurred_at_ms`);--> statement-breakpoint
CREATE INDEX `audit_proj_time_idx` ON `audit_log` (`project_id`,`occurred_at_ms`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_log` (`user_id`,`action`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX automation_action_grants_run_action_idx ON automation_action_grants (run_id, action);--> statement-breakpoint
CREATE UNIQUE INDEX automation_action_grants_idempotency_idx ON automation_action_grants (project_id, idempotency_key_hash);--> statement-breakpoint
CREATE INDEX `automation_action_grants_status_idx` ON `automation_action_grants` (`project_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_approvals_run_action_idx` ON `automation_approvals` (`run_id`,`action`);--> statement-breakpoint
CREATE INDEX `automation_approvals_pending_idx` ON `automation_approvals` (`project_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `automation_approvals_run_idx` ON `automation_approvals` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX automation_budget_charges_run_kind_idx ON automation_budget_charges (run_id, kind);--> statement-breakpoint
CREATE INDEX `automation_budget_charges_window_idx` ON `automation_budget_charges` (`project_id`,`automation_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_contracts_enabled_idx` ON `automation_contracts` (`enabled`,`updated_at`);--> statement-breakpoint
CREATE INDEX `automation_run_events_run_time_idx` ON `automation_run_events` (`run_id`,`at`);--> statement-breakpoint
CREATE INDEX `automation_run_events_project_time_idx` ON `automation_run_events` (`project_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX automation_run_report_sources_run_idx ON automation_run_report_sources (run_id);--> statement-breakpoint
CREATE UNIQUE INDEX automation_run_report_sources_idempotency_idx ON automation_run_report_sources (project_id, idempotency_key_hash);--> statement-breakpoint
CREATE INDEX `automation_run_report_sources_project_time_idx` ON `automation_run_report_sources` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_project_status_idx` ON `automation_runs` (`project_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_case_idx` ON `automation_runs` (`case_id`,`case_revision`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_automation_idx` ON `automation_runs` (`project_id`,`automation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_idempotency_idx` ON `automation_runs` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX automation_runs_trigger_receipt_idx ON automation_runs (trigger_receipt_id);--> statement-breakpoint
CREATE INDEX `automation_runs_deadline_idx` ON `automation_runs` (`status`,`deadline_at`);--> statement-breakpoint
CREATE UNIQUE INDEX automation_trigger_receipts_key_idx ON automation_trigger_receipts (project_id, automation_id, trigger_key);--> statement-breakpoint
CREATE INDEX `automation_trigger_receipts_ready_idx` ON `automation_trigger_receipts` (`project_id`,`automation_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `automation_trigger_receipts_case_idx` ON `automation_trigger_receipts` (`case_id`,`case_revision`,`attempt`);--> statement-breakpoint
CREATE INDEX `automation_trigger_receipts_run_idx` ON `automation_trigger_receipts` (`run_id`);--> statement-breakpoint
CREATE INDEX `automation_trigger_states_due_idx` ON `automation_trigger_states` (`trigger_kind`,`cooldown_until`,`updated_at`);--> statement-breakpoint
CREATE INDEX `billing_mutation_targets_user_time_idx` ON `billing_mutation_targets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_mutation_targets_customer_key_idx` ON `billing_mutation_targets` (`stripe_customer_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_mutation_targets_session_key_idx` ON `billing_mutation_targets` (`stripe_session_idempotency_key`);--> statement-breakpoint
CREATE INDEX `billing_subscription_cursors_user_idx` ON `billing_subscription_cursors` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `billing_webhook_events_user_time_idx` ON `billing_webhook_events` (`user_id`,`provider_created`);--> statement-breakpoint
CREATE INDEX `billing_webhook_events_subscription_time_idx` ON `billing_webhook_events` (`subscription_id`,`provider_created`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_claims_attempt_idx` ON `case_claims` (`case_id`,`case_revision`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_claims_idempotency_idx` ON `case_claims` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `case_claims_active_idx` ON `case_claims` (`project_id`,`expires_at`,`released_at`);--> statement-breakpoint
CREATE INDEX `case_claims_run_idx` ON `case_claims` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX case_claims_trigger_receipt_idx ON case_claims (trigger_receipt_id);--> statement-breakpoint
CREATE UNIQUE INDEX `case_mutation_commands_project_key_idx` ON `case_mutation_commands` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `case_mutation_commands_case_time_idx` ON `case_mutation_commands` (`case_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX cases_provider_issue_idx ON cases (project_id, provider_issue_id);--> statement-breakpoint
CREATE UNIQUE INDEX cases_proj_fp_idx ON cases (project_id, fingerprint);--> statement-breakpoint
CREATE INDEX deploys_proj_time_idx ON deploys (project_id, received_at);--> statement-breakpoint
CREATE INDEX deploys_automation_run_idx ON deploys (automation_run_id, received_at);--> statement-breakpoint
CREATE INDEX deploys_onboarding_proof_idx
          ON deploys (project_id, onboarding_proof_session_id, credential_id, received_at);--> statement-breakpoint
CREATE UNIQUE INDEX posthog_connections_project_idx
    ON posthog_connections (project_id);--> statement-breakpoint
CREATE UNIQUE INDEX posthog_connections_id_project_idx
    ON posthog_connections (id, project_id);--> statement-breakpoint
CREATE INDEX posthog_connections_refresh_due_idx
    ON posthog_connections (status, access_token_expires_at);--> statement-breakpoint
CREATE INDEX posthog_connections_provider_identity_idx
    ON posthog_connections (posthog_host, posthog_environment_id, status);--> statement-breakpoint
CREATE INDEX `feedback_user_idx` ON `feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_kind_idx` ON `feedback` (`kind`,`resolved`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_user_fingerprint_idx` ON `feedback` (`user_id`,`fingerprint`,`resolved`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `identities_oidc_subject_idx` ON `identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE INDEX cases_proj_status_idx ON cases (project_id, provider_event_classification, status, last_seen_at);--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_commands_idempotency_idx` ON `mutation_commands` (`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `mutation_commands_actor_time_idx` ON `mutation_commands` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mutation_commands_project_time_idx` ON `mutation_commands` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX onboarding_proof_sessions_runtime_marker_idx
    ON onboarding_proof_sessions (runtime_marker_hash);--> statement-breakpoint
CREATE UNIQUE INDEX onboarding_proof_sessions_ci_marker_idx
    ON onboarding_proof_sessions (ci_marker_hash);--> statement-breakpoint
CREATE INDEX onboarding_proof_sessions_ci_credential_idx
    ON onboarding_proof_sessions (ci_credential_id);--> statement-breakpoint
CREATE INDEX onboarding_proof_sessions_project_status_idx
    ON onboarding_proof_sessions (project_id, status, expires_at);--> statement-breakpoint
CREATE INDEX onboarding_proof_sessions_onboarding_idx
    ON onboarding_proof_sessions (project_id, onboarding_id, started_at);--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_states_onboarding_idx` ON `onboarding_states` (`onboarding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_states_etag_idx` ON `onboarding_states` (`etag`);--> statement-breakpoint
CREATE INDEX `onboarding_states_status_idx` ON `onboarding_states` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `project_artifacts_updated_at_idx` ON `project_artifacts` (`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_credentials_token_hash_idx` ON `project_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `project_credentials_project_active_idx` ON `project_credentials` (`project_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `project_credentials_automation_idx` ON `project_credentials` (`project_id`,`automation_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `project_install_plan_approvals_project_time_idx` ON `project_install_plan_approvals` (`project_id`,`attested_at`);--> statement-breakpoint
CREATE INDEX `project_install_plan_approvals_approver_time_idx` ON `project_install_plan_approvals` (`attested_by`,`attested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_install_plans_project_revision_idx` ON `project_install_plans` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `project_install_plans_project_created_idx` ON `project_install_plans` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_install_plans_project_contract_idx` ON `project_install_plans` (`project_id`,`contract_sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_invites_token_idx` ON `project_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `project_invites_proj_idx` ON `project_invites` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_memberships_unique` ON `project_memberships` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `project_memberships_user_idx` ON `project_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `project_memberships_proj_idx` ON `project_memberships` (`project_id`);--> statement-breakpoint
CREATE INDEX `project_signal_maps_approved_at_idx` ON `project_signal_maps` (`approved_at`);--> statement-breakpoint
CREATE INDEX `project_signal_maps_updated_at_idx` ON `project_signal_maps` (`updated_at`);--> statement-breakpoint
CREATE INDEX `projects_user_idx` ON `projects` (`user_id`);--> statement-breakpoint
CREATE INDEX `pubq_user_idx` ON `public_query_publications` (`user_id`);--> statement-breakpoint
CREATE INDEX `pubq_project_idx` ON `public_query_publications` (`project_id`);--> statement-breakpoint
CREATE INDEX posthog_connections_case_projection_due_idx
    ON posthog_connections (status, case_projection_last_attempt_at, id);--> statement-breakpoint
CREATE UNIQUE INDEX posthog_oauth_attempts_state_hash_idx
    ON posthog_oauth_attempts (state_hash);--> statement-breakpoint
CREATE UNIQUE INDEX posthog_oauth_attempts_poll_token_hash_idx
    ON posthog_oauth_attempts (poll_token_hash);--> statement-breakpoint
CREATE INDEX posthog_oauth_attempts_project_time_idx
    ON posthog_oauth_attempts (project_id, created_at);--> statement-breakpoint
CREATE INDEX posthog_oauth_attempts_user_time_idx
    ON posthog_oauth_attempts (user_id, created_at);--> statement-breakpoint
CREATE INDEX posthog_oauth_attempts_expiry_idx
    ON posthog_oauth_attempts (status, expires_at);--> statement-breakpoint
CREATE INDEX posthog_oauth_attempts_connection_idx
    ON posthog_oauth_attempts (connection_id);--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_idx` ON `users` (`github_id`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_source_event_idx` ON `webhook_deliveries` (`webhook_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_time_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_project_time_idx` ON `webhook_deliveries` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_recipient_sets_source_event_idx` ON `webhook_recipient_sets` (`project_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `webhook_recipient_sets_project_time_idx` ON `webhook_recipient_sets` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhooks_proj_idx` ON `webhooks` (`project_id`,`active`);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_revisions_project_revision_idx
    ON automation_workflow_revisions (project_id, automation_id, revision);--> statement-breakpoint
CREATE INDEX automation_workflow_revisions_project_created_idx
    ON automation_workflow_revisions (project_id, automation_id, created_at);--> statement-breakpoint
CREATE INDEX automation_workflows_enabled_idx
    ON automation_workflows (enabled, updated_at);--> statement-breakpoint
CREATE INDEX automation_workflow_execution_authorities_revision_idx
    ON automation_workflow_execution_authorities (
      project_id, automation_id, workflow_revision_id, enabled_at
    );--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_trigger_receipts_occurrence_attempt_idx
    ON automation_workflow_trigger_receipts (
      project_id, automation_id, workflow_revision_id, trigger_key, attempt
    );--> statement-breakpoint
CREATE INDEX automation_workflow_trigger_receipts_ready_idx
    ON automation_workflow_trigger_receipts (
      project_id, automation_id, status, available_at, expires_at
    );--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_trigger_receipts_consumed_run_idx
    ON automation_workflow_trigger_receipts (consumed_run_id);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_runs_project_idempotency_idx
    ON automation_workflow_runs (project_id, idempotency_key_hash);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_runs_trigger_receipt_idx
    ON automation_workflow_runs (trigger_receipt_id);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_runs_trigger_attempt_idx
    ON automation_workflow_runs (project_id, automation_id, workflow_revision_id, trigger_key, attempt);--> statement-breakpoint
CREATE INDEX automation_workflow_runs_project_created_idx
    ON automation_workflow_runs (project_id, automation_id, created_at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_system_node_claims_input_idx
    ON automation_workflow_system_node_claims (run_id, run_revision, node_id, input_hash);--> statement-breakpoint
CREATE INDEX automation_workflow_system_node_claims_expiry_idx
    ON automation_workflow_system_node_claims (status, expires_at, updated_at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_run_leases_token_idx
    ON automation_workflow_run_leases (token_hash);--> statement-breakpoint
CREATE INDEX automation_workflow_run_leases_active_idx
    ON automation_workflow_run_leases (expires_at, released_at);--> statement-breakpoint
CREATE INDEX automation_workflow_run_leases_project_idx
    ON automation_workflow_run_leases (project_id, automation_id, expires_at);--> statement-breakpoint
CREATE INDEX automation_workflow_run_states_project_status_idx
    ON automation_workflow_run_states (project_id, status, updated_at);--> statement-breakpoint
CREATE INDEX automation_workflow_run_states_due_idx
    ON automation_workflow_run_states (status, ready_at, elapsed_deadline_at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_run_events_run_sequence_idx
    ON automation_workflow_run_events (run_id, sequence);--> statement-breakpoint
CREATE INDEX automation_workflow_run_events_command_idx
    ON automation_workflow_run_events (run_id, command_id, sequence);--> statement-breakpoint
CREATE INDEX automation_workflow_run_events_project_time_idx
    ON automation_workflow_run_events (project_id, at);--> statement-breakpoint
CREATE INDEX automation_workflow_commands_project_time_idx
    ON automation_workflow_commands (project_id, created_at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_commands_committed_revision_idx
    ON automation_workflow_commands (run_id, committed_revision);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_suspensions_run_node_idx
    ON automation_workflow_suspensions (run_id, node_id);--> statement-breakpoint
CREATE INDEX automation_workflow_suspensions_due_idx
    ON automation_workflow_suspensions (status, next_check_at, deadline_at);--> statement-breakpoint
CREATE INDEX automation_workflow_suspensions_project_status_idx
    ON automation_workflow_suspensions (project_id, status, updated_at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_effect_events_effect_sequence_idx
    ON automation_workflow_effect_events (effect_id, sequence);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_effect_events_idempotency_idx
    ON automation_workflow_effect_events (effect_id, idempotency_key_hash);--> statement-breakpoint
CREATE INDEX automation_workflow_effect_events_run_time_idx
    ON automation_workflow_effect_events (run_id, at);--> statement-breakpoint
CREATE INDEX automation_workflow_effect_events_project_time_idx
    ON automation_workflow_effect_events (project_id, at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_effects_run_node_idx
    ON automation_workflow_effects (run_id, node_id);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_effects_intent_idx
    ON automation_workflow_effects (intent_hash);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_effects_operation_key_idx
    ON automation_workflow_effects (provider_operation_key);--> statement-breakpoint
CREATE INDEX automation_workflow_effects_reconcile_idx
    ON automation_workflow_effects (status, reconcile_after_at, updated_at);--> statement-breakpoint
CREATE INDEX automation_workflow_effects_project_status_idx
    ON automation_workflow_effects (project_id, status, updated_at);--> statement-breakpoint
CREATE UNIQUE INDEX automation_workflow_budget_charges_subject_idx
    ON automation_workflow_budget_charges (run_id, kind, subject_key);--> statement-breakpoint
CREATE INDEX automation_workflow_budget_charges_window_idx
    ON automation_workflow_budget_charges (project_id, automation_id, kind, created_at);--> statement-breakpoint
CREATE INDEX automation_workflow_budget_charges_run_idx
    ON automation_workflow_budget_charges (run_id, kind, created_at);--> statement-breakpoint
