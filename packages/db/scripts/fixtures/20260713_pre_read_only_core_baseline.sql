CREATE TABLE `account_deletion_fences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `alerts_proj_idx` ON `alerts` (`project_id`,`active`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_keys_user_kind_idx` ON `api_keys` (`user_id`,`kind`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_operation_phase_idx` ON `audit_log` (`operation_id`,`phase`);--> statement-breakpoint
CREATE INDEX `audit_user_time_idx` ON `audit_log` (`user_id`,`occurred_at_ms`);--> statement-breakpoint
CREATE INDEX `audit_proj_time_idx` ON `audit_log` (`project_id`,`occurred_at_ms`);--> statement-breakpoint
CREATE INDEX `audit_action_idx` ON `audit_log` (`user_id`,`action`,`at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_action_grants_run_action_idx` ON `automation_action_grants` (`run_id`,`action`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_action_grants_idempotency_idx` ON `automation_action_grants` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `automation_action_grants_status_idx` ON `automation_action_grants` (`project_id`,`status`,`expires_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_approvals_run_action_idx` ON `automation_approvals` (`run_id`,`action`);--> statement-breakpoint
CREATE INDEX `automation_approvals_pending_idx` ON `automation_approvals` (`project_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `automation_approvals_run_idx` ON `automation_approvals` (`run_id`);--> statement-breakpoint
CREATE TABLE `automation_budget_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_budget_charges_run_kind_idx` ON `automation_budget_charges` (`run_id`,`kind`);--> statement-breakpoint
CREATE INDEX `automation_budget_charges_window_idx` ON `automation_budget_charges` (`project_id`,`automation_id`,`kind`,`created_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `automation_contracts_enabled_idx` ON `automation_contracts` (`enabled`,`updated_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `automation_run_events_run_time_idx` ON `automation_run_events` (`run_id`,`at`);--> statement-breakpoint
CREATE INDEX `automation_run_events_project_time_idx` ON `automation_run_events` (`project_id`,`at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_run_report_sources_run_idx` ON `automation_run_report_sources` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_run_report_sources_idempotency_idx` ON `automation_run_report_sources` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `automation_run_report_sources_project_time_idx` ON `automation_run_report_sources` (`project_id`,`created_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `automation_runs_project_status_idx` ON `automation_runs` (`project_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_case_idx` ON `automation_runs` (`case_id`,`case_revision`,`created_at`);--> statement-breakpoint
CREATE INDEX `automation_runs_automation_idx` ON `automation_runs` (`project_id`,`automation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_idempotency_idx` ON `automation_runs` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_trigger_receipt_idx` ON `automation_runs` (`trigger_receipt_id`);--> statement-breakpoint
CREATE INDEX `automation_runs_deadline_idx` ON `automation_runs` (`status`,`deadline_at`);--> statement-breakpoint
CREATE TABLE `automation_scheduler_cursors` (
	`sweep_name` text PRIMARY KEY NOT NULL,
	`cursor_project_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "automation_scheduler_cursors_revision_check" CHECK("automation_scheduler_cursors"."revision" >= 0)
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_trigger_receipts_key_idx` ON `automation_trigger_receipts` (`project_id`,`automation_id`,`trigger_key`);--> statement-breakpoint
CREATE INDEX `automation_trigger_receipts_ready_idx` ON `automation_trigger_receipts` (`project_id`,`automation_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `automation_trigger_receipts_case_idx` ON `automation_trigger_receipts` (`case_id`,`case_revision`,`attempt`);--> statement-breakpoint
CREATE INDEX `automation_trigger_receipts_run_idx` ON `automation_trigger_receipts` (`run_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `automation_trigger_states_due_idx` ON `automation_trigger_states` (`trigger_kind`,`cooldown_until`,`updated_at`);--> statement-breakpoint
CREATE TABLE `billing_mutation_secrets` (
	`command_id` text PRIMARY KEY NOT NULL,
	`response_enc` text NOT NULL,
	`response_iv` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `mutation_commands`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `billing_mutation_targets_user_time_idx` ON `billing_mutation_targets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_mutation_targets_customer_key_idx` ON `billing_mutation_targets` (`stripe_customer_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_mutation_targets_session_key_idx` ON `billing_mutation_targets` (`stripe_session_idempotency_key`);--> statement-breakpoint
CREATE TABLE `billing_subscription_cursors` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`last_event_created` integer NOT NULL,
	`last_event_id` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_subscription_cursors_user_idx` ON `billing_subscription_cursors` (`user_id`,`updated_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `billing_webhook_events_user_time_idx` ON `billing_webhook_events` (`user_id`,`provider_created`);--> statement-breakpoint
CREATE INDEX `billing_webhook_events_subscription_time_idx` ON `billing_webhook_events` (`subscription_id`,`provider_created`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_claims_attempt_idx` ON `case_claims` (`case_id`,`case_revision`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_claims_idempotency_idx` ON `case_claims` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `case_claims_active_idx` ON `case_claims` (`project_id`,`expires_at`,`released_at`);--> statement-breakpoint
CREATE INDEX `case_claims_run_idx` ON `case_claims` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `case_claims_trigger_receipt_idx` ON `case_claims` (`trigger_receipt_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_mutation_commands_project_key_idx` ON `case_mutation_commands` (`project_id`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `case_mutation_commands_case_time_idx` ON `case_mutation_commands` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_deploy_sha` text,
	`agent_summary` text,
	`pr_url` text,
	`last_trust_level` text DEFAULT 'untrusted_browser' NOT NULL,
	`last_credential_kind` text DEFAULT 'browser_public' NOT NULL,
	`last_credential_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cases_proj_fp_idx` ON `cases` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `cases_proj_status_idx` ON `cases` (`project_id`,`status`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `deploys` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`sha` text NOT NULL,
	`branch` text,
	`environment` text,
	`message` text,
	`url` text,
	`actor` text,
	`automation_run_id` text,
	`source_commit_sha` text,
	`extra_json` text,
	`trust_level` text DEFAULT 'legacy_unverified' NOT NULL,
	`credential_kind` text DEFAULT 'legacy_deploy' NOT NULL,
	`credential_id` text,
	`onboarding_proof_session_id` text,
	`onboarding_proof_credential_id` text,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`automation_run_id`) REFERENCES `automation_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`onboarding_proof_session_id`) REFERENCES `onboarding_proof_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deploys_proj_time_idx` ON `deploys` (`project_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `deploys_automation_run_idx` ON `deploys` (`automation_run_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `deploys_onboarding_proof_idx` ON `deploys` (`project_id`,`onboarding_proof_session_id`,`credential_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`client_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_polled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_idx` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_idx` ON `device_codes` (`user_code_hash`);--> statement-breakpoint
CREATE INDEX `device_codes_expires_idx` ON `device_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`stack` text NOT NULL,
	`deploy_sha` text,
	`environment` text,
	`user_id` text,
	`user_email` text,
	`breadcrumbs_json` text,
	`request_json` text,
	`tags_json` text,
	`extra_json` text,
	`trust_level` text DEFAULT 'untrusted_browser' NOT NULL,
	`credential_kind` text DEFAULT 'browser_public' NOT NULL,
	`credential_id` text,
	`onboarding_proof_session_id` text,
	`onboarding_proof_credential_id` text,
	`received_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`onboarding_proof_session_id`) REFERENCES `onboarding_proof_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_proj_fp_idx` ON `events` (`project_id`,`fingerprint`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_proj_user_idx` ON `events` (`project_id`,`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_proj_received_idx` ON `events` (`project_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_onboarding_proof_idx` ON `events` (`project_id`,`onboarding_proof_session_id`,`credential_kind`,`credential_id`,`received_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `feedback_user_idx` ON `feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_kind_idx` ON `feedback` (`kind`,`resolved`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_user_fingerprint_idx` ON `feedback` (`user_id`,`fingerprint`,`resolved`,`created_at`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`email` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_idx` ON `identities` (`provider`,`provider_user_id`);--> statement-breakpoint
CREATE INDEX `identities_user_idx` ON `identities` (`user_id`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`summary_md` text,
	`pr_url` text,
	`action` text,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_case_idx` ON `agent_runs` (`case_id`,`started_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_commands_idempotency_idx` ON `mutation_commands` (`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `mutation_commands_actor_time_idx` ON `mutation_commands` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `mutation_commands_project_time_idx` ON `mutation_commands` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `onboarding_proof_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`onboarding_id` text NOT NULL,
	`approved_state_etag` text NOT NULL,
	`runtime_public_key_hash` text NOT NULL,
	`runtime_server_credential_id` text,
	`ci_credential_id` text NOT NULL,
	`runtime_marker_hash` text NOT NULL,
	`ci_marker_hash` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`terminal_at` integer,
	`terminal_reason` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runtime_server_credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ci_credential_id`) REFERENCES `project_credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "onboarding_proof_sessions_lifetime_check" CHECK("onboarding_proof_sessions"."started_at" >= 0 AND "onboarding_proof_sessions"."expires_at" > "onboarding_proof_sessions"."started_at" AND "onboarding_proof_sessions"."updated_at" >= "onboarding_proof_sessions"."started_at"),
	CONSTRAINT "onboarding_proof_sessions_distinct_markers_check" CHECK("onboarding_proof_sessions"."runtime_marker_hash" <> "onboarding_proof_sessions"."ci_marker_hash"),
	CONSTRAINT "onboarding_proof_sessions_lifecycle_check" CHECK((
      ("onboarding_proof_sessions"."status" = 'active' AND "onboarding_proof_sessions"."terminal_at" IS NULL AND "onboarding_proof_sessions"."terminal_reason" IS NULL)
      OR
      ("onboarding_proof_sessions"."status" IN ('completed', 'revoked') AND "onboarding_proof_sessions"."terminal_at" IS NOT NULL AND "onboarding_proof_sessions"."terminal_at" >= "onboarding_proof_sessions"."started_at" AND "onboarding_proof_sessions"."terminal_at" < "onboarding_proof_sessions"."expires_at" AND "onboarding_proof_sessions"."terminal_reason" IS NOT NULL AND length(trim("onboarding_proof_sessions"."terminal_reason")) > 0)
      OR
      ("onboarding_proof_sessions"."status" = 'expired' AND "onboarding_proof_sessions"."terminal_at" IS NOT NULL AND "onboarding_proof_sessions"."terminal_at" >= "onboarding_proof_sessions"."expires_at" AND "onboarding_proof_sessions"."terminal_reason" IS NOT NULL AND length(trim("onboarding_proof_sessions"."terminal_reason")) > 0)
    ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_proof_sessions_runtime_marker_idx` ON `onboarding_proof_sessions` (`runtime_marker_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_proof_sessions_ci_marker_idx` ON `onboarding_proof_sessions` (`ci_marker_hash`);--> statement-breakpoint
CREATE INDEX `onboarding_proof_sessions_server_credential_idx` ON `onboarding_proof_sessions` (`runtime_server_credential_id`);--> statement-breakpoint
CREATE INDEX `onboarding_proof_sessions_ci_credential_idx` ON `onboarding_proof_sessions` (`ci_credential_id`);--> statement-breakpoint
CREATE INDEX `onboarding_proof_sessions_project_status_idx` ON `onboarding_proof_sessions` (`project_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `onboarding_proof_sessions_onboarding_idx` ON `onboarding_proof_sessions` (`project_id`,`onboarding_id`,`started_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_states_onboarding_idx` ON `onboarding_states` (`onboarding_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_states_etag_idx` ON `onboarding_states` (`etag`);--> statement-breakpoint
CREATE INDEX `onboarding_states_status_idx` ON `onboarding_states` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `posthog_provision_targets` (
	`command_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`target_fingerprint` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `mutation_commands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posthog_provision_targets_project_idx` ON `posthog_provision_targets` (`project_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `project_artifacts_updated_at_idx` ON `project_artifacts` (`updated_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_credentials_token_hash_idx` ON `project_credentials` (`token_hash`);--> statement-breakpoint
CREATE INDEX `project_credentials_project_active_idx` ON `project_credentials` (`project_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE INDEX `project_credentials_automation_idx` ON `project_credentials` (`project_id`,`automation_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `project_deletion_fences` (
	`project_id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `project_install_plan_approvals_project_time_idx` ON `project_install_plan_approvals` (`project_id`,`attested_at`);--> statement-breakpoint
CREATE INDEX `project_install_plan_approvals_approver_time_idx` ON `project_install_plan_approvals` (`attested_by`,`attested_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_install_plans_project_revision_idx` ON `project_install_plans` (`project_id`,`revision`);--> statement-breakpoint
CREATE INDEX `project_install_plans_project_created_idx` ON `project_install_plans` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `project_install_plans_project_contract_idx` ON `project_install_plans` (`project_id`,`contract_sha256`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_invites_token_idx` ON `project_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `project_invites_proj_idx` ON `project_invites` (`project_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_memberships_unique` ON `project_memberships` (`project_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `project_memberships_user_idx` ON `project_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `project_memberships_proj_idx` ON `project_memberships` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_posthog_bindings` (
	`project_id` text PRIMARY KEY NOT NULL,
	`posthog_project_id` integer NOT NULL,
	`posthog_project_resource_id` integer,
	`posthog_org_id` text,
	`posthog_project_api_key` text NOT NULL,
	`posthog_host` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_posthog_bindings_ph_id_idx` ON `project_posthog_bindings` (`posthog_project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_posthog_bindings_ph_resource_idx` ON `project_posthog_bindings` (`posthog_host`,`posthog_project_resource_id`);--> statement-breakpoint
CREATE TABLE `project_secrets` (
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`secret_enc` text NOT NULL,
	`secret_iv` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`project_id`, `kind`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_secrets_project_idx` ON `project_secrets` (`project_id`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `project_signal_maps_approved_at_idx` ON `project_signal_maps` (`approved_at`);--> statement-breakpoint
CREATE INDEX `project_signal_maps_updated_at_idx` ON `project_signal_maps` (`updated_at`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`repo_url` text,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`local_path` text,
	`dsn_prefix` text NOT NULL,
	`dsn_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_user_idx` ON `projects` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_dsn_hash_idx` ON `projects` (`dsn_hash`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `pubq_user_idx` ON `public_query_publications` (`user_id`);--> statement-breakpoint
CREATE INDEX `pubq_project_idx` ON `public_query_publications` (`project_id`);--> statement-breakpoint
CREATE TABLE `sourcemap_cleanup_outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sourcemap_id` text NOT NULL,
	`release_id` text NOT NULL,
	`source_url` text NOT NULL,
	`r2_key` text NOT NULL,
	`body_hash` text,
	`upload_command_id` text,
	`object_id` text,
	`r2_status` text DEFAULT 'pending' NOT NULL,
	`db_status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `sourcemap_commands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sourcemap_cleanup_command_blob_idx` ON `sourcemap_cleanup_outcomes` (`command_id`,`r2_key`);--> statement-breakpoint
CREATE INDEX `sourcemap_cleanup_command_idx` ON `sourcemap_cleanup_outcomes` (`command_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `sourcemap_cleanup_project_release_idx` ON `sourcemap_cleanup_outcomes` (`project_id`,`release_id`);--> statement-breakpoint
CREATE TABLE `sourcemap_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`actor` text NOT NULL,
	`credential_id` text,
	`idempotency_key_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`release_id` text NOT NULL,
	`source_url` text,
	`body_hash` text,
	`size_bytes` integer,
	`r2_key` text,
	`sourcemap_id` text,
	`status` text DEFAULT 'intent' NOT NULL,
	`response_json` text,
	`outcome_json` text DEFAULT '{}' NOT NULL,
	`error_json` text,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`terminal_code` text,
	`terminal_at` integer,
	`snapshot_generation` integer,
	`snapshot_at` integer,
	`target_count` integer DEFAULT 0 NOT NULL,
	`processed_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sourcemap_commands_lease_pair_check" CHECK((("sourcemap_commands"."lease_token" IS NULL AND "sourcemap_commands"."lease_expires_at" IS NULL) OR ("sourcemap_commands"."lease_token" IS NOT NULL AND "sourcemap_commands"."lease_expires_at" IS NOT NULL AND "sourcemap_commands"."lease_expires_at" > 0)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sourcemap_commands_project_key_idx` ON `sourcemap_commands` (`project_id`,`operation`,`idempotency_key_hash`);--> statement-breakpoint
CREATE INDEX `sourcemap_commands_project_time_idx` ON `sourcemap_commands` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sourcemap_commands_lease_idx` ON `sourcemap_commands` (`lease_expires_at`,`terminal_at`);--> statement-breakpoint
CREATE TABLE `sourcemap_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`release_id` text NOT NULL,
	`source_url` text NOT NULL,
	`r2_key` text NOT NULL,
	`size_bytes` integer,
	`body_hash` text,
	`credential_id` text,
	`upload_command_id` text,
	`generation` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer,
	`cleanup_command_id` text,
	`delete_attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sourcemap_objects_lease_pair_check" CHECK((("sourcemap_objects"."lease_token" IS NULL AND "sourcemap_objects"."lease_expires_at" IS NULL) OR ("sourcemap_objects"."lease_token" IS NOT NULL AND "sourcemap_objects"."lease_expires_at" IS NOT NULL AND "sourcemap_objects"."lease_expires_at" > 0)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sourcemap_objects_r2_key_idx` ON `sourcemap_objects` (`r2_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `sourcemap_objects_upload_command_idx` ON `sourcemap_objects` (`upload_command_id`);--> statement-breakpoint
CREATE INDEX `sourcemap_objects_release_state_idx` ON `sourcemap_objects` (`project_id`,`release_id`,`generation`,`state`);--> statement-breakpoint
CREATE INDEX `sourcemap_objects_project_state_idx` ON `sourcemap_objects` (`project_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `sourcemap_release_states` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`release_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sourcemap_release_states_release_idx` ON `sourcemap_release_states` (`project_id`,`release_id`);--> statement-breakpoint
CREATE TABLE `sourcemaps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`release_id` text NOT NULL,
	`source_url` text NOT NULL,
	`r2_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`body_hash` text,
	`credential_id` text,
	`upload_command_id` text,
	`inventory_object_id` text,
	`uploaded_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sourcemaps_proj_release_idx` ON `sourcemaps` (`project_id`,`release_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sourcemaps_lookup_idx` ON `sourcemaps` (`project_id`,`release_id`,`source_url`);--> statement-breakpoint
CREATE TABLE `suppression_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint_pattern` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`hint_text` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suppression_proj_idx` ON `suppression_entries` (`project_id`);--> statement-breakpoint
CREATE TABLE `usage_counters` (
	`project_id` text NOT NULL,
	`period` text NOT NULL,
	`signal_type` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_counters_pk` ON `usage_counters` (`project_id`,`period`,`signal_type`);--> statement-breakpoint
CREATE INDEX `usage_counters_period_project_idx` ON `usage_counters` (`period`,`project_id`);--> statement-breakpoint
CREATE TABLE `usage_snapshots` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`period` text NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`analytics` integer DEFAULT 0 NOT NULL,
	`deploys` integer DEFAULT 0 NOT NULL,
	`total_events` integer DEFAULT 0 NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_snapshots_pk` ON `usage_snapshots` (`user_id`,`day`);--> statement-breakpoint
CREATE INDEX `usage_snapshots_day_idx` ON `usage_snapshots` (`day`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_idx` ON `users` (`github_id`);--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_source_event_idx` ON `webhook_deliveries` (`webhook_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_time_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_project_time_idx` ON `webhook_deliveries` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_recipient_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_event_id` text NOT NULL,
	`source_event_hash` text NOT NULL,
	`event` text NOT NULL,
	`webhook_ids_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_recipient_sets_source_event_idx` ON `webhook_recipient_sets` (`project_id`,`source_event_id`);--> statement-breakpoint
CREATE INDEX `webhook_recipient_sets_project_time_idx` ON `webhook_recipient_sets` (`project_id`,`created_at`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE INDEX `webhooks_proj_idx` ON `webhooks` (`project_id`,`active`);
