// Forward hard cut from the immutable 20260713 workflow-v3 schema to the
// canonical durable runtime authority. The migration deliberately rebuilds
// replaceable pre-beta workflow state before applying these exact statements.

export const AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS automation_workflow_project_controls (
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
  )`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_revisions (
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
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_revisions_project_revision_idx
    ON automation_workflow_revisions (project_id, automation_id, revision)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_revisions_project_created_idx
    ON automation_workflow_revisions (project_id, automation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflows (
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
  )`,
  `CREATE INDEX IF NOT EXISTS automation_workflows_enabled_idx
    ON automation_workflows (enabled, updated_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_execution_authorities (
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
  )`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_execution_authorities_revision_idx
    ON automation_workflow_execution_authorities (
      project_id, automation_id, workflow_revision_id, enabled_at
    )`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_trigger_receipts (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_trigger_receipts_occurrence_attempt_idx
    ON automation_workflow_trigger_receipts (
      project_id, automation_id, workflow_revision_id, trigger_key, attempt
    )`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_trigger_receipts_ready_idx
    ON automation_workflow_trigger_receipts (
      project_id, automation_id, status, available_at, expires_at
    )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_trigger_receipts_consumed_run_idx
    ON automation_workflow_trigger_receipts (consumed_run_id)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_runs (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_runs_project_idempotency_idx
    ON automation_workflow_runs (project_id, idempotency_key_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_runs_trigger_receipt_idx
    ON automation_workflow_runs (trigger_receipt_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_runs_trigger_attempt_idx
    ON automation_workflow_runs (project_id, automation_id, workflow_revision_id, trigger_key, attempt)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_runs_project_created_idx
    ON automation_workflow_runs (project_id, automation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_system_node_claims (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_system_node_claims_input_idx
    ON automation_workflow_system_node_claims (run_id, run_revision, node_id, input_hash)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_system_node_claims_expiry_idx
    ON automation_workflow_system_node_claims (status, expires_at, updated_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_run_leases (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_run_leases_token_idx
    ON automation_workflow_run_leases (token_hash)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_leases_active_idx
    ON automation_workflow_run_leases (expires_at, released_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_leases_project_idx
    ON automation_workflow_run_leases (project_id, automation_id, expires_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_run_states (
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
  )`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_states_project_status_idx
    ON automation_workflow_run_states (project_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_states_due_idx
    ON automation_workflow_run_states (status, ready_at, elapsed_deadline_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_run_events (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_run_events_run_sequence_idx
    ON automation_workflow_run_events (run_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_events_command_idx
    ON automation_workflow_run_events (run_id, command_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_events_project_time_idx
    ON automation_workflow_run_events (project_id, at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_commands (
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
  )`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_commands_project_time_idx
    ON automation_workflow_commands (project_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_commands_committed_revision_idx
    ON automation_workflow_commands (run_id, committed_revision)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_suspensions (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_suspensions_run_node_idx
    ON automation_workflow_suspensions (run_id, node_id)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_suspensions_due_idx
    ON automation_workflow_suspensions (status, next_check_at, deadline_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_suspensions_project_status_idx
    ON automation_workflow_suspensions (project_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_effect_events (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effect_events_effect_sequence_idx
    ON automation_workflow_effect_events (effect_id, sequence)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effect_events_idempotency_idx
    ON automation_workflow_effect_events (effect_id, idempotency_key_hash)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_effect_events_run_time_idx
    ON automation_workflow_effect_events (run_id, at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_effect_events_project_time_idx
    ON automation_workflow_effect_events (project_id, at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_effects (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effects_run_node_idx
    ON automation_workflow_effects (run_id, node_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effects_intent_idx
    ON automation_workflow_effects (intent_hash)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effects_operation_key_idx
    ON automation_workflow_effects (provider_operation_key)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_effects_reconcile_idx
    ON automation_workflow_effects (status, reconcile_after_at, updated_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_effects_project_status_idx
    ON automation_workflow_effects (project_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_budget_charges (
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
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_budget_charges_subject_idx
    ON automation_workflow_budget_charges (run_id, kind, subject_key)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_budget_charges_window_idx
    ON automation_workflow_budget_charges (project_id, automation_id, kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_budget_charges_run_idx
    ON automation_workflow_budget_charges (run_id, kind, created_at)`,
]);

function replaceTrigger(name, sql) {
  return [`DROP TRIGGER IF EXISTS ${name}`, sql];
}

function fencedDelete(table) {
  return replaceTrigger(`${table}_fenced_delete_guard`, `
    CREATE TRIGGER ${table}_fenced_delete_guard
    BEFORE DELETE ON ${table}
    WHEN NOT EXISTS (
      SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'workflow-v3 rows may be deleted only behind a project deletion fence');
    END
  `);
}

export const AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS = Object.freeze([
  ...replaceTrigger("automation_workflow_project_controls_insert_guard", `
    CREATE TRIGGER automation_workflow_project_controls_insert_guard
    BEFORE INSERT ON automation_workflow_project_controls
    WHEN NEW.revision IS NOT 1
      OR NEW.updated_at IS NOT NEW.created_at
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow project control initial authority is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_project_controls_update_guard", `
    CREATE TRIGGER automation_workflow_project_controls_update_guard
    BEFORE UPDATE ON automation_workflow_project_controls
    WHEN NEW.project_id IS NOT OLD.project_id
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.revision IS NOT OLD.revision + 1
      OR NEW.updated_at < OLD.updated_at
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow project control update must be a monotonic CAS');
    END
  `),
  ...replaceTrigger("automation_workflow_project_controls_cancel_ready_receipts_after_pause", `
    CREATE TRIGGER automation_workflow_project_controls_cancel_ready_receipts_after_pause
    AFTER UPDATE ON automation_workflow_project_controls
    WHEN NEW.paused_at IS NOT NULL
    BEGIN
      UPDATE automation_workflow_trigger_receipts
         SET status = 'cancelled',
             cancelled_at = unixepoch(),
             cancel_reason = 'project_paused',
             updated_at = unixepoch()
       WHERE project_id = NEW.project_id
         AND status = 'ready';
    END
  `),
  ...replaceTrigger("automation_workflow_revisions_binding_insert", `
    CREATE TRIGGER automation_workflow_revisions_binding_insert
    BEFORE INSERT ON automation_workflow_revisions
    WHEN NOT EXISTS (
      SELECT 1 FROM automation_workflow_project_controls control
       WHERE control.project_id = NEW.project_id
    )
      OR NEW.revision IS NOT COALESCE((
        SELECT MAX(prior.revision) + 1
          FROM automation_workflow_revisions prior
         WHERE prior.project_id = NEW.project_id
           AND prior.automation_id = NEW.automation_id
      ), 1)
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow revision admission or sequence is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_revisions_no_update", `
    CREATE TRIGGER automation_workflow_revisions_no_update
    BEFORE UPDATE ON automation_workflow_revisions
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow revisions are immutable');
    END
  `),
  ...replaceTrigger("automation_workflow_execution_authorities_binding_insert", `
    CREATE TRIGGER automation_workflow_execution_authorities_binding_insert
    BEFORE INSERT ON automation_workflow_execution_authorities
    WHEN NEW.enabled_at < unixepoch() - 1
      OR NEW.enabled_at > unixepoch() + 1
      OR EXISTS (
        SELECT 1 FROM json_each(NEW.owner_confirmed_caller_assertion_ids_json) item
         WHERE item.type <> 'text'
      )
      OR EXISTS (
        SELECT 1
          FROM json_each(NEW.owner_confirmed_caller_assertion_ids_json) left_item
          JOIN json_each(NEW.owner_confirmed_caller_assertion_ids_json) right_item
            ON CAST(right_item.key AS integer) > CAST(left_item.key AS integer)
         WHERE right_item.value <= left_item.value
      )
      OR 1 IS NOT (
        SELECT COUNT(*) FROM project_credentials active_runner
         WHERE active_runner.project_id IS NEW.project_id
           AND active_runner.kind = 'automation_runner'
           AND active_runner.automation_id IS NEW.automation_id
           AND active_runner.created_at <= NEW.enabled_at
           AND active_runner.revoked_at IS NULL
           AND active_runner.expires_at > NEW.enabled_at
           AND active_runner.expires_at > unixepoch()
           AND active_runner.token_hash NOT LIKE 'legacy-disabled:%'
      )
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_revisions revision_row
          JOIN automation_workflows workflow_head
            ON workflow_head.project_id = revision_row.project_id
           AND workflow_head.automation_id = revision_row.automation_id
          JOIN automation_workflow_project_controls control
            ON control.project_id = revision_row.project_id
          JOIN project_credentials runner
            ON runner.id = NEW.runner_credential_id
           AND runner.project_id = revision_row.project_id
           AND runner.automation_id = revision_row.automation_id
         WHERE revision_row.id = NEW.workflow_revision_id
           AND revision_row.project_id IS NEW.project_id
           AND revision_row.automation_id IS NEW.automation_id
           AND revision_row.workflow_hash IS NEW.workflow_hash
           AND revision_row.compile_hash IS NEW.compile_hash
           AND workflow_head.current_revision_id IS revision_row.id
           AND workflow_head.current_revision IS revision_row.revision
           AND workflow_head.paused_at IS NULL
           AND control.paused_at IS NULL
           AND runner.kind = 'automation_runner'
           AND runner.created_at <= NEW.enabled_at
           AND runner.revoked_at IS NULL
           AND runner.expires_at > NEW.enabled_at
           AND runner.expires_at > unixepoch()
           AND runner.token_hash NOT LIKE 'legacy-disabled:%'
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow execution authority must bind exact readiness, revision, and runner evidence');
    END
  `),
  ...replaceTrigger("automation_workflow_execution_authorities_no_update", `
    CREATE TRIGGER automation_workflow_execution_authorities_no_update
    BEFORE UPDATE ON automation_workflow_execution_authorities
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow execution authorities are immutable');
    END
  `),
  ...replaceTrigger("automation_workflows_revision_binding_insert", `
    CREATE TRIGGER automation_workflows_revision_binding_insert
    BEFORE INSERT ON automation_workflows
    WHEN NEW.active_execution_authority_id IS NOT NULL
      OR NOT EXISTS (
      SELECT 1 FROM automation_workflow_revisions revision_row
       WHERE revision_row.id = NEW.current_revision_id
         AND revision_row.project_id IS NEW.project_id
         AND revision_row.automation_id IS NEW.automation_id
         AND revision_row.revision IS NEW.current_revision
    )
      OR NOT EXISTS (
        SELECT 1 FROM automation_workflow_project_controls control
         WHERE control.project_id = NEW.project_id
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow head must bind its exact immutable revision');
    END
  `),
  ...replaceTrigger("automation_workflows_revision_binding_update", `
    CREATE TRIGGER automation_workflows_revision_binding_update
    BEFORE UPDATE ON automation_workflows
    WHEN NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.updated_at < OLD.updated_at
      OR NOT EXISTS (
        SELECT 1 FROM automation_workflow_revisions revision_row
         WHERE revision_row.id = NEW.current_revision_id
           AND revision_row.project_id IS NEW.project_id
           AND revision_row.automation_id IS NEW.automation_id
           AND revision_row.revision IS NEW.current_revision
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
      OR (NEW.enabled = 0 AND NEW.active_execution_authority_id IS NOT NULL)
      OR (NEW.enabled = 1 AND NOT EXISTS (
        SELECT 1
          FROM automation_workflow_execution_authorities authority
          JOIN project_credentials runner
            ON runner.id = authority.runner_credential_id
           AND runner.project_id = authority.project_id
           AND runner.automation_id = authority.automation_id
         WHERE authority.id = NEW.active_execution_authority_id
           AND authority.project_id IS NEW.project_id
           AND authority.automation_id IS NEW.automation_id
           AND authority.workflow_revision_id IS NEW.active_revision_id
           AND authority.workflow_revision_id IS NEW.current_revision_id
           AND runner.kind = 'automation_runner'
           AND runner.revoked_at IS NULL
           AND runner.expires_at > unixepoch()
           AND runner.token_hash NOT LIKE 'legacy-disabled:%'
      ))
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow head identity or revision binding is invalid');
    END
  `),
  ...replaceTrigger("automation_workflows_cancel_ready_receipts_after_authority_change", `
    CREATE TRIGGER automation_workflows_cancel_ready_receipts_after_authority_change
    AFTER UPDATE ON automation_workflows
    WHEN NEW.enabled = 0
      OR NEW.paused_at IS NOT NULL
      OR NEW.active_revision_id IS NOT OLD.active_revision_id
      OR NEW.active_execution_authority_id IS NOT OLD.active_execution_authority_id
    BEGIN
      UPDATE automation_workflow_trigger_receipts
         SET status = 'cancelled',
             cancelled_at = unixepoch(),
             cancel_reason = 'workflow_authority_changed',
             updated_at = unixepoch()
       WHERE project_id = NEW.project_id
         AND automation_id = NEW.automation_id
         AND status = 'ready';
    END
  `),
  ...replaceTrigger("automation_workflow_trigger_receipts_binding_insert", `
    CREATE TRIGGER automation_workflow_trigger_receipts_binding_insert
    BEFORE INSERT ON automation_workflow_trigger_receipts
    WHEN NEW.status IS NOT 'ready'
      OR NEW.consumed_run_id IS NOT NULL
      OR NEW.consumed_at IS NOT NULL
      OR NEW.cancelled_at IS NOT NULL
      OR NEW.cancel_reason IS NOT NULL
      OR NEW.updated_at IS NOT NEW.issued_at
      OR NEW.issued_at < unixepoch() - 1
      OR NEW.issued_at > unixepoch() + 1
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_revisions revision_row
          JOIN automation_workflows workflow_head
            ON workflow_head.project_id = revision_row.project_id
           AND workflow_head.automation_id = revision_row.automation_id
          JOIN automation_workflow_project_controls control
            ON control.project_id = revision_row.project_id
          JOIN automation_workflow_execution_authorities authority
            ON authority.id = NEW.execution_authority_id
           AND authority.project_id = revision_row.project_id
           AND authority.automation_id = revision_row.automation_id
           AND authority.workflow_revision_id = revision_row.id
          JOIN project_credentials authority_runner
            ON authority_runner.id = authority.runner_credential_id
           AND authority_runner.project_id = authority.project_id
           AND authority_runner.automation_id = authority.automation_id
          JOIN json_each(revision_row.compiled_json, '$.resolved_nodes') resolved_node
         WHERE revision_row.id = NEW.workflow_revision_id
           AND revision_row.project_id IS NEW.project_id
           AND revision_row.automation_id IS NEW.automation_id
           AND revision_row.workflow_hash IS NEW.workflow_hash
           AND revision_row.compile_hash IS NEW.compile_hash
           AND workflow_head.enabled = 1
           AND workflow_head.paused_at IS NULL
           AND workflow_head.active_revision_id IS revision_row.id
           AND workflow_head.active_execution_authority_id IS authority.id
           AND authority.workflow_hash IS revision_row.workflow_hash
           AND authority.compile_hash IS revision_row.compile_hash
           AND authority_runner.kind = 'automation_runner'
           AND authority_runner.revoked_at IS NULL
           AND authority_runner.expires_at > NEW.issued_at
           AND authority_runner.expires_at > unixepoch()
           AND authority_runner.token_hash NOT LIKE 'legacy-disabled:%'
           AND control.paused_at IS NULL
           AND json_extract(revision_row.workflow_json, '$.entry') IS NEW.trigger_node_id
           AND json_extract(resolved_node.value, '$.node_id') IS NEW.trigger_node_id
           AND json_extract(resolved_node.value, '$.component.id') IS NEW.component_id
           AND json_extract(resolved_node.value, '$.component.version') IS NEW.component_version
           AND json_extract(resolved_node.value, '$.component_hash') IS NEW.component_hash
           AND json_extract(resolved_node.value, '$.output_contract') IS NEW.output_contract
           AND json_extract(resolved_node.value, '$.output_contract_schema_hash') IS NEW.output_schema_hash
      )
      OR json_extract(NEW.payload_json, '$.receipt_id') IS NOT NEW.id
      OR json_extract(NEW.payload_json, '$.instruction_authority') IS NOT 'none'
      OR NOT (
        (
          NEW.trigger_kind = 'case'
          AND NEW.component_id = 'trigger.cases.unhandled'
          AND NEW.output_contract = 'case_trigger_receipt@1'
          AND NEW.source_trust = 'customer_posthog'
          AND NEW.available_at IS NEW.issued_at
          AND json_type(NEW.payload_json, '$.case_id') = 'text'
          AND json_type(NEW.payload_json, '$.case_revision') = 'integer'
          AND json_extract(NEW.payload_json, '$.case_revision') >= 1
          AND length(json_extract(NEW.payload_json, '$.snapshot_hash')) = 64
          AND json_extract(NEW.payload_json, '$.snapshot_hash') NOT GLOB '*[^a-f0-9]*'
          AND json_extract(NEW.payload_json, '$.source_trust') = 'customer_posthog'
          AND json_extract(NEW.payload_json, '$.issued_at') IS NEW.issued_at
          AND json_extract(NEW.payload_json, '$.expires_at') IS NEW.expires_at
          AND NEW.trigger_key IS 'case:' || json_extract(NEW.payload_json, '$.case_id')
            || ':' || json_extract(NEW.payload_json, '$.case_revision')
          AND EXISTS (
            SELECT 1
              FROM cases case_row
              JOIN posthog_connections source_connection
                ON source_connection.project_id = case_row.project_id
               AND source_connection.status = 'active'
             WHERE case_row.id IS json_extract(NEW.payload_json, '$.case_id')
               AND case_row.project_id IS NEW.project_id
               AND case_row.revision IS json_extract(NEW.payload_json, '$.case_revision')
               AND case_row.status = 'active'
               AND case_row.last_trust_level = 'customer_posthog'
               AND case_row.last_credential_kind = 'posthog_oauth'
          )
        )
        OR (
          NEW.trigger_kind = 'schedule'
          AND NEW.component_id = 'trigger.schedule.cron'
          AND NEW.output_contract = 'schedule_trigger_receipt@1'
          AND NEW.source_trust = 'agentry_system'
          AND json_type(NEW.payload_json, '$.scheduled_for') = 'integer'
          AND json_extract(NEW.payload_json, '$.window_start') IS NEW.available_at
          AND json_extract(NEW.payload_json, '$.window_end') IS NEW.expires_at
          AND json_extract(NEW.payload_json, '$.scheduled_for') >= NEW.available_at
          AND json_extract(NEW.payload_json, '$.scheduled_for') < NEW.expires_at
          AND NEW.trigger_key IS 'schedule:' || json_extract(NEW.payload_json, '$.scheduled_for')
        )
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow trigger receipt authority or frozen component binding is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_trigger_receipts_update_guard", `
    CREATE TRIGGER automation_workflow_trigger_receipts_update_guard
    BEFORE UPDATE ON automation_workflow_trigger_receipts
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.workflow_revision_id IS NOT OLD.workflow_revision_id
      OR NEW.workflow_hash IS NOT OLD.workflow_hash
      OR NEW.compile_hash IS NOT OLD.compile_hash
      OR NEW.execution_authority_id IS NOT OLD.execution_authority_id
      OR NEW.trigger_node_id IS NOT OLD.trigger_node_id
      OR NEW.component_id IS NOT OLD.component_id
      OR NEW.component_version IS NOT OLD.component_version
      OR NEW.component_hash IS NOT OLD.component_hash
      OR NEW.output_contract IS NOT OLD.output_contract
      OR NEW.output_schema_hash IS NOT OLD.output_schema_hash
      OR NEW.trigger_kind IS NOT OLD.trigger_kind
      OR NEW.trigger_key IS NOT OLD.trigger_key
      OR NEW.attempt IS NOT OLD.attempt
      OR NEW.payload_json IS NOT OLD.payload_json
      OR NEW.payload_hash IS NOT OLD.payload_hash
      OR NEW.source_trust IS NOT OLD.source_trust
      OR NEW.issued_at IS NOT OLD.issued_at
      OR NEW.available_at IS NOT OLD.available_at
      OR NEW.expires_at IS NOT OLD.expires_at
      OR OLD.status IS NOT 'ready'
      OR NEW.updated_at < unixepoch() - 1
      OR NEW.updated_at > unixepoch() + 1
      OR NOT (
        (
          NEW.status = 'expired'
          AND NEW.updated_at >= OLD.expires_at
          AND NEW.consumed_run_id IS NULL AND NEW.consumed_at IS NULL
          AND NEW.cancelled_at IS NULL AND NEW.cancel_reason IS NULL
        )
        OR (
          NEW.status = 'cancelled'
          AND NEW.cancelled_at IS NEW.updated_at
          AND NEW.consumed_run_id IS NULL AND NEW.consumed_at IS NULL
          AND typeof(NEW.cancel_reason) = 'text'
          AND length(trim(NEW.cancel_reason)) BETWEEN 1 AND 1000
        )
        OR (
          NEW.status = 'consumed'
          AND NEW.consumed_at IS NEW.updated_at
          AND NEW.consumed_at >= OLD.available_at
          AND NEW.consumed_at < OLD.expires_at
          AND NEW.cancelled_at IS NULL AND NEW.cancel_reason IS NULL
          AND EXISTS (
            SELECT 1 FROM automation_workflow_runs run
             WHERE run.id = NEW.consumed_run_id
               AND run.project_id IS OLD.project_id
               AND run.automation_id IS OLD.automation_id
               AND run.workflow_revision_id IS OLD.workflow_revision_id
               AND run.workflow_hash IS OLD.workflow_hash
               AND run.compile_hash IS OLD.compile_hash
               AND run.execution_authority_id IS OLD.execution_authority_id
               AND run.trigger_receipt_id IS OLD.id
               AND run.trigger_kind IS OLD.trigger_kind
               AND run.trigger_key IS OLD.trigger_key
               AND run.trigger_payload_json IS OLD.payload_json
               AND run.trigger_payload_hash IS OLD.payload_hash
               AND run.attempt IS OLD.attempt
               AND run.created_at IS NEW.consumed_at
          )
        )
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow trigger receipt transition or run binding is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_runs_binding_insert", `
    CREATE TRIGGER automation_workflow_runs_binding_insert
    BEFORE INSERT ON automation_workflow_runs
    WHEN NEW.created_at < unixepoch() - 1
      OR NEW.created_at > unixepoch() + 1
      OR NOT EXISTS (
      SELECT 1
        FROM automation_workflow_revisions revision_row
        JOIN automation_workflows workflow_head
          ON workflow_head.project_id = revision_row.project_id
         AND workflow_head.automation_id = revision_row.automation_id
        JOIN automation_workflow_project_controls control
          ON control.project_id = revision_row.project_id
        JOIN automation_workflow_execution_authorities authority
          ON authority.id = NEW.execution_authority_id
         AND authority.project_id = revision_row.project_id
         AND authority.automation_id = revision_row.automation_id
         AND authority.workflow_revision_id = revision_row.id
       WHERE revision_row.id = NEW.workflow_revision_id
         AND revision_row.project_id IS NEW.project_id
         AND revision_row.automation_id IS NEW.automation_id
         AND revision_row.workflow_hash IS NEW.workflow_hash
         AND revision_row.compile_hash IS NEW.compile_hash
         AND json(json_extract(revision_row.workflow_json, '$.limits')) IS json(NEW.limits_json)
         AND workflow_head.enabled = 1
         AND workflow_head.paused_at IS NULL
         AND workflow_head.active_revision_id IS revision_row.id
         AND workflow_head.active_execution_authority_id IS authority.id
         AND authority.workflow_hash IS revision_row.workflow_hash
         AND authority.compile_hash IS revision_row.compile_hash
         AND authority.descriptor_hash IS NEW.execution_descriptor_hash
         AND authority.runner_credential_id IS NEW.runner_credential_id
         AND control.paused_at IS NULL
    )
      OR json_type(NEW.limits_json, '$.max_runs_per_day') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_runs_per_day') < 1
      OR json_type(NEW.limits_json, '$.max_attempts_per_trigger') IS NOT 'integer'
      OR NEW.attempt > json_extract(NEW.limits_json, '$.max_attempts_per_trigger')
      OR json_extract(NEW.limits_json, '$.max_attempts_per_trigger') < 1
      OR json_type(NEW.limits_json, '$.max_turns_per_run') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_turns_per_run') < 1
      OR json_type(NEW.limits_json, '$.max_active_runtime_seconds') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_active_runtime_seconds') < 1
      OR json_type(NEW.limits_json, '$.max_elapsed_seconds') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_elapsed_seconds') < json_extract(NEW.limits_json, '$.max_active_runtime_seconds')
      OR json_type(NEW.limits_json, '$.retry_backoff_seconds') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.retry_backoff_seconds') < 1
      OR json_type(NEW.limits_json, '$.max_external_effects_per_run') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_external_effects_per_run') < 0
      OR json_type(NEW.limits_json, '$.max_external_effects_per_day') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_external_effects_per_day') < 0
      OR json_type(NEW.limits_json, '$.max_files_changed_per_run') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_files_changed_per_run') < 0
      OR json_type(NEW.limits_json, '$.max_changed_lines_per_run') IS NOT 'integer'
      OR json_extract(NEW.limits_json, '$.max_changed_lines_per_run') < 0
      OR NOT EXISTS (
        SELECT 1 FROM automation_workflow_trigger_receipts trigger_receipt
         WHERE trigger_receipt.id = NEW.trigger_receipt_id
           AND trigger_receipt.project_id IS NEW.project_id
           AND trigger_receipt.automation_id IS NEW.automation_id
           AND trigger_receipt.workflow_revision_id IS NEW.workflow_revision_id
           AND trigger_receipt.workflow_hash IS NEW.workflow_hash
           AND trigger_receipt.compile_hash IS NEW.compile_hash
           AND trigger_receipt.execution_authority_id IS NEW.execution_authority_id
           AND trigger_receipt.trigger_kind IS NEW.trigger_kind
           AND trigger_receipt.trigger_key IS NEW.trigger_key
           AND trigger_receipt.attempt IS NEW.attempt
           AND trigger_receipt.payload_json IS NEW.trigger_payload_json
           AND trigger_receipt.payload_hash IS NEW.trigger_payload_hash
           AND trigger_receipt.status = 'ready'
           AND trigger_receipt.available_at <= NEW.created_at
           AND trigger_receipt.expires_at > NEW.created_at
      )
      OR NOT EXISTS (
        SELECT 1 FROM project_credentials credential
         WHERE credential.id = NEW.runner_credential_id
           AND credential.project_id IS NEW.project_id
           AND credential.kind = 'automation_runner'
           AND credential.automation_id IS NEW.automation_id
           AND credential.created_at <= NEW.created_at
           AND credential.revoked_at IS NULL
           AND credential.expires_at > NEW.created_at
           AND credential.expires_at > unixepoch()
           AND credential.token_hash NOT LIKE 'legacy-disabled:%'
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow run root authority or aggregate limits are invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_runs_no_update", `
    CREATE TRIGGER automation_workflow_runs_no_update
    BEFORE UPDATE ON automation_workflow_runs
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow run roots are immutable');
    END
  `),
  ...replaceTrigger("automation_workflow_system_node_claims_binding_insert", `
    CREATE TRIGGER automation_workflow_system_node_claims_binding_insert
    BEFORE INSERT ON automation_workflow_system_node_claims
    WHEN NEW.status <> 'active'
      OR NEW.claim_epoch <> 1
      OR NEW.claimed_at IS NOT NEW.updated_at
      OR NEW.released_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.claimed_at < unixepoch() - 1
      OR NEW.claimed_at > unixepoch() + 1
      OR NEW.expires_at < NEW.claimed_at + 30
      OR NEW.expires_at > NEW.claimed_at + 300
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_runs run
          JOIN automation_workflow_run_states run_state ON run_state.run_id = run.id
          JOIN automation_workflows workflow_head
            ON workflow_head.project_id = run.project_id
           AND workflow_head.automation_id = run.automation_id
          JOIN automation_workflow_project_controls control ON control.project_id = run.project_id
          JOIN automation_workflow_execution_authorities authority
            ON authority.id = run.execution_authority_id
           AND authority.project_id = run.project_id
           AND authority.automation_id = run.automation_id
           AND authority.workflow_revision_id = run.workflow_revision_id
          JOIN project_credentials runner
            ON runner.id = authority.runner_credential_id
           AND runner.project_id = authority.project_id
           AND runner.automation_id = authority.automation_id
         WHERE run.id = NEW.run_id
           AND run.project_id IS NEW.project_id
           AND run.automation_id IS NEW.automation_id
           AND run_state.state_version IS NEW.run_revision
           AND run_state.status NOT IN ('completed', 'escalated', 'cancelled', 'quarantined')
           AND authority.descriptor_hash IS run.execution_descriptor_hash
           AND runner.kind = 'automation_runner'
           AND runner.revoked_at IS NULL
           AND runner.expires_at > NEW.claimed_at
           AND runner.expires_at > unixepoch()
           AND runner.token_hash NOT LIKE 'legacy-disabled:%'
           AND workflow_head.enabled = 1
           AND workflow_head.paused_at IS NULL
           AND workflow_head.active_revision_id IS run.workflow_revision_id
           AND workflow_head.active_execution_authority_id IS authority.id
           AND control.paused_at IS NULL
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow system-node claim authority or fence is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_system_node_claims_update_guard", `
    CREATE TRIGGER automation_workflow_system_node_claims_update_guard
    BEFORE UPDATE ON automation_workflow_system_node_claims
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.run_revision IS NOT OLD.run_revision
      OR NEW.node_id IS NOT OLD.node_id
      OR NEW.input_hash IS NOT OLD.input_hash
      OR NEW.updated_at < unixepoch() - 1
      OR NEW.updated_at > unixepoch() + 1
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
      OR NOT (
        (
          NEW.status = 'active'
          AND NEW.claim_epoch = OLD.claim_epoch + 1
          AND NEW.claim_token_hash IS NOT OLD.claim_token_hash
          AND NEW.claimed_at IS NEW.updated_at
          AND NEW.expires_at >= NEW.claimed_at + 30
          AND NEW.expires_at <= NEW.claimed_at + 300
          AND NEW.released_at IS NULL
          AND NEW.completed_at IS NULL
          AND (OLD.status = 'released'
            OR (OLD.status = 'active' AND OLD.expires_at <= NEW.claimed_at))
          AND EXISTS (
            SELECT 1
              FROM automation_workflow_runs run
              JOIN automation_workflow_run_states run_state ON run_state.run_id = run.id
              JOIN automation_workflows workflow_head
                ON workflow_head.project_id = run.project_id
               AND workflow_head.automation_id = run.automation_id
              JOIN automation_workflow_project_controls control ON control.project_id = run.project_id
              JOIN automation_workflow_execution_authorities authority
                ON authority.id = run.execution_authority_id
               AND authority.project_id = run.project_id
               AND authority.automation_id = run.automation_id
              JOIN project_credentials runner
                ON runner.id = authority.runner_credential_id
               AND runner.project_id = authority.project_id
               AND runner.automation_id = authority.automation_id
             WHERE run.id = OLD.run_id
               AND run_state.state_version IS OLD.run_revision
               AND run_state.status NOT IN ('completed', 'escalated', 'cancelled', 'quarantined')
               AND run.execution_authority_id IS NOT NULL
               AND authority.descriptor_hash IS run.execution_descriptor_hash
               AND runner.kind = 'automation_runner'
               AND runner.revoked_at IS NULL
               AND runner.expires_at > NEW.claimed_at
               AND runner.expires_at > unixepoch()
               AND runner.token_hash NOT LIKE 'legacy-disabled:%'
               AND workflow_head.enabled = 1
               AND workflow_head.paused_at IS NULL
               AND workflow_head.active_revision_id IS run.workflow_revision_id
               AND workflow_head.active_execution_authority_id IS run.execution_authority_id
               AND control.paused_at IS NULL
          )
        )
        OR (
          OLD.status = 'active'
          AND NEW.status = 'released'
          AND NEW.claim_epoch IS OLD.claim_epoch
          AND NEW.claim_token_hash IS OLD.claim_token_hash
          AND NEW.claimed_at IS OLD.claimed_at
          AND NEW.expires_at IS OLD.expires_at
          AND NEW.released_at IS NEW.updated_at
          AND NEW.completed_at IS NULL
        )
        OR (
          OLD.status = 'active'
          AND NEW.status = 'completed'
          AND NEW.claim_epoch IS OLD.claim_epoch
          AND NEW.claim_token_hash IS OLD.claim_token_hash
          AND NEW.claimed_at IS OLD.claimed_at
          AND NEW.expires_at IS OLD.expires_at
          AND NEW.released_at IS NULL
          AND NEW.completed_at IS NEW.updated_at
          AND EXISTS (
            SELECT 1 FROM automation_workflow_run_states run_state
             WHERE run_state.run_id = OLD.run_id
               AND run_state.state_version > OLD.run_revision
          )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow system-node claim transition or stale fence is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_run_leases_binding_insert", `
    CREATE TRIGGER automation_workflow_run_leases_binding_insert
    BEFORE INSERT ON automation_workflow_run_leases
    WHEN NOT EXISTS (
      SELECT 1
        FROM automation_workflow_runs run
        JOIN automation_workflow_run_states run_state ON run_state.run_id = run.id
        JOIN automation_workflows workflow_head
          ON workflow_head.project_id = run.project_id
         AND workflow_head.automation_id = run.automation_id
        JOIN automation_workflow_project_controls control ON control.project_id = run.project_id
       WHERE run.id = NEW.run_id
         AND run.project_id IS NEW.project_id
         AND run.automation_id IS NEW.automation_id
         AND NEW.acquired_at >= run.created_at
         AND NEW.holder_principal = 'automation_runner'
         AND NEW.holder_credential_id IS run.runner_credential_id
         AND run_state.status NOT IN ('completed', 'escalated', 'cancelled', 'quarantined')
         AND run.execution_authority_id IS NOT NULL
         AND workflow_head.enabled = 1
         AND workflow_head.paused_at IS NULL
         AND workflow_head.active_revision_id IS run.workflow_revision_id
         AND workflow_head.active_execution_authority_id IS run.execution_authority_id
         AND control.paused_at IS NULL
    )
      OR NEW.lease_epoch IS NOT COALESCE((
        SELECT MAX(prior.lease_epoch) + 1
          FROM automation_workflow_run_leases prior
         WHERE prior.run_id = NEW.run_id
      ), 1)
      OR NEW.version IS NOT 1
      OR NEW.acquired_at IS NOT NEW.renewed_at
      OR NEW.acquired_at < unixepoch() - 1
      OR NEW.acquired_at > unixepoch() + 1
      OR EXISTS (
        SELECT 1 FROM automation_workflow_run_leases prior
         WHERE prior.run_id = NEW.run_id
           AND prior.lease_epoch = NEW.lease_epoch - 1
           AND prior.released_at IS NULL
           AND prior.expires_at > NEW.acquired_at
      )
      OR NOT EXISTS (
          SELECT 1 FROM project_credentials credential
           WHERE credential.id = NEW.holder_credential_id
             AND credential.project_id IS NEW.project_id
             AND credential.kind = 'automation_runner'
             AND credential.automation_id IS NEW.automation_id
             AND credential.created_at <= NEW.acquired_at
             AND credential.revoked_at IS NULL
             AND credential.expires_at > NEW.expires_at
             AND credential.expires_at > unixepoch()
             AND credential.token_hash NOT LIKE 'legacy-disabled:%'
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'workflow run lease acquisition authority is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_run_leases_update_guard", `
    CREATE TRIGGER automation_workflow_run_leases_update_guard
    BEFORE UPDATE ON automation_workflow_run_leases
    WHEN NEW.run_id IS NOT OLD.run_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.lease_epoch IS NOT OLD.lease_epoch
      OR NEW.holder_principal IS NOT OLD.holder_principal
      OR NEW.holder_credential_id IS NOT OLD.holder_credential_id
      OR NEW.token_hash IS NOT OLD.token_hash
      OR NEW.acquired_at IS NOT OLD.acquired_at
      OR NEW.version IS NOT OLD.version + 1
      OR OLD.released_at IS NOT NULL
      OR NEW.lease_epoch IS NOT (
        SELECT MAX(current.lease_epoch)
          FROM automation_workflow_run_leases current
         WHERE current.run_id = OLD.run_id
      )
      OR (
        NEW.released_at IS NULL
        AND (
          NEW.release_reason IS NOT NULL
          OR NEW.renewed_at < OLD.renewed_at
          OR NEW.renewed_at < unixepoch() - 1
          OR NEW.renewed_at > unixepoch() + 1
          OR NEW.expires_at <= OLD.expires_at
          OR OLD.expires_at <= unixepoch()
          OR NOT EXISTS (
            SELECT 1
              FROM automation_workflow_runs run
              JOIN automation_workflows workflow_head
                ON workflow_head.project_id = run.project_id
               AND workflow_head.automation_id = run.automation_id
              JOIN automation_workflow_project_controls control ON control.project_id = run.project_id
             WHERE run.id = OLD.run_id
               AND OLD.holder_principal = 'automation_runner'
               AND OLD.holder_credential_id IS run.runner_credential_id
               AND run.execution_authority_id IS NOT NULL
               AND workflow_head.enabled = 1
               AND workflow_head.paused_at IS NULL
               AND workflow_head.active_revision_id IS run.workflow_revision_id
               AND workflow_head.active_execution_authority_id IS run.execution_authority_id
               AND control.paused_at IS NULL
          )
          OR NOT EXISTS (
            SELECT 1 FROM project_credentials credential
             WHERE credential.id = OLD.holder_credential_id
               AND credential.project_id IS OLD.project_id
               AND credential.kind = 'automation_runner'
               AND credential.automation_id IS OLD.automation_id
               AND credential.revoked_at IS NULL
               AND credential.expires_at > NEW.expires_at
               AND credential.token_hash NOT LIKE 'legacy-disabled:%'
          )
          OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
        )
      )
      OR (
        NEW.released_at IS NOT NULL
        AND (
          NEW.release_reason IS NULL
          OR NEW.expires_at IS NOT OLD.expires_at
          OR NEW.renewed_at < OLD.renewed_at
          OR NEW.released_at < OLD.renewed_at
          OR NEW.released_at < unixepoch() - 1
          OR NEW.released_at > unixepoch() + 1
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'workflow run lease renewal or release CAS is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_run_events_no_update", `
    CREATE TRIGGER automation_workflow_run_events_no_update
    BEFORE UPDATE ON automation_workflow_run_events
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow run events are immutable');
    END
  `),
  ...replaceTrigger("automation_workflow_run_events_binding_insert", `
    CREATE TRIGGER automation_workflow_run_events_binding_insert
    BEFORE INSERT ON automation_workflow_run_events
    WHEN NEW.at < unixepoch() - 1
      OR NEW.at > unixepoch() + 1
      OR NOT EXISTS (
      SELECT 1 FROM automation_workflow_runs run
       WHERE run.id = NEW.run_id
         AND run.project_id IS NEW.project_id
         AND run.automation_id IS NEW.automation_id
         AND run.workflow_hash IS NEW.workflow_hash
         AND run.compile_hash IS NEW.compile_hash
    )
      OR NEW.sequence IS NOT COALESCE((
        SELECT MAX(prior.sequence) + 1
          FROM automation_workflow_run_events prior
         WHERE prior.run_id = NEW.run_id
      ), 1)
      OR (NEW.sequence > 1 AND NOT EXISTS (
        SELECT 1 FROM automation_workflow_run_events prior
         WHERE prior.run_id = NEW.run_id
           AND prior.sequence = NEW.sequence - 1
           AND prior.id IS NEW.prior_event_hash
           AND prior.at <= NEW.at
      ))
      OR (NEW.sequence = 1 AND (
        NEW.event IS NOT 'run.started'
        OR NEW.actor_principal IS NOT 'agentry_system'
        OR NEW.actor_credential_id IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
            FROM automation_workflow_runs run
            JOIN automation_workflow_budget_charges charge
              ON charge.run_id = run.id
             AND charge.project_id = run.project_id
             AND charge.automation_id = run.automation_id
             AND charge.kind = 'run'
             AND charge.subject_key = 'run'
             AND charge.node_id IS NULL
             AND charge.effect_attempt IS NULL
             AND charge.created_at IS NEW.at
           WHERE run.id = NEW.run_id
             AND run.created_at IS NEW.at
             AND json_extract(NEW.payload_json, '$.started_at') IS run.created_at
             AND json_extract(NEW.payload_json, '$.elapsed_deadline_at')
                   IS run.created_at + json_extract(run.limits_json, '$.max_elapsed_seconds')
        )
      ))
      OR (NEW.sequence > 1 AND NEW.event = 'run.started')
      OR NEW.actor_principal NOT IN (
        'agentry_system', 'automation_runner', 'human_project_owner', 'customer_posthog', 'trusted_ci'
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow event root binding or hash chain is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_run_events_live_authority_insert", `
    CREATE TRIGGER automation_workflow_run_events_live_authority_insert
    BEFORE INSERT ON automation_workflow_run_events
    WHEN NOT EXISTS (
      SELECT 1
        FROM automation_workflow_runs run
        JOIN automation_workflows workflow_head
          ON workflow_head.project_id = run.project_id
         AND workflow_head.automation_id = run.automation_id
        JOIN automation_workflow_project_controls control
          ON control.project_id = run.project_id
       WHERE run.id = NEW.run_id
         AND run.execution_authority_id IS NOT NULL
         AND workflow_head.enabled = 1
         AND workflow_head.paused_at IS NULL
         AND workflow_head.active_revision_id IS run.workflow_revision_id
         AND workflow_head.active_execution_authority_id IS run.execution_authority_id
         AND control.paused_at IS NULL
    )
      AND NOT (
        (NEW.event = 'run.cancelled'
          AND NEW.actor_principal = 'human_project_owner'
          AND NEW.actor_credential_id IS NOT NULL)
        OR (NEW.event = 'run.quarantined'
          AND NEW.actor_principal = 'agentry_system'
          AND NEW.actor_credential_id IS NULL)
        OR (NEW.event IN (
              'effect.completed', 'effect.reconciled_absent',
              'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
            )
          AND EXISTS (
            SELECT 1
              FROM automation_workflow_effects effect
              JOIN automation_workflow_effect_events call_start
                ON call_start.effect_id = effect.id
               AND call_start.event = 'effect.call_started'
               AND call_start.effect_attempt = effect.call_attempt
             WHERE effect.run_id = NEW.run_id
               AND effect.node_id IS NEW.node_id
               AND effect.status = 'indeterminate'
               AND json_extract(NEW.payload_json, '$.intent_hash') IS effect.intent_hash
               AND (
                 (NEW.event = 'effect.completed'
                   AND NEW.actor_principal = 'automation_runner'
                   AND NEW.actor_credential_id IS call_start.actor_credential_id)
                 OR (NEW.actor_principal = 'agentry_system'
                   AND NEW.actor_credential_id IS NULL)
                 OR (NEW.actor_principal = 'trusted_ci'
                   AND EXISTS (
                     SELECT 1 FROM project_credentials credential
                      WHERE credential.id = NEW.actor_credential_id
                        AND credential.project_id IS NEW.project_id
                        AND credential.kind = 'ci_deploy'
                        AND credential.revoked_at IS NULL
                        AND credential.expires_at > unixepoch()
                        AND credential.token_hash NOT LIKE 'legacy-disabled:%'
                   ))
               )
          ))
        OR (NEW.event = 'run.quarantined'
          AND EXISTS (
            SELECT 1 FROM automation_workflow_run_events effect_event
             WHERE effect_event.run_id = NEW.run_id
               AND effect_event.command_id = NEW.command_id
               AND effect_event.request_hash = NEW.request_hash
               AND effect_event.actor_principal = NEW.actor_principal
               AND effect_event.actor_credential_id IS NEW.actor_credential_id
               AND effect_event.event IN (
                 'effect.completed', 'effect.reconciled_absent',
                 'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
               )
          ))
      )
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow event is blocked by live authority');
    END
  `),
  ...replaceTrigger("automation_workflow_commands_no_update", `
    CREATE TRIGGER automation_workflow_commands_no_update
    BEFORE UPDATE ON automation_workflow_commands
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow command receipts are immutable');
    END
  `),
  ...replaceTrigger("automation_workflow_commands_binding_insert", `
    CREATE TRIGGER automation_workflow_commands_binding_insert
    BEFORE INSERT ON automation_workflow_commands
    WHEN NEW.created_at < unixepoch() - 1
      OR NEW.created_at > unixepoch() + 1
      OR NOT EXISTS (
      SELECT 1 FROM automation_workflow_runs run
       WHERE run.id = NEW.run_id
         AND run.project_id IS NEW.project_id
         AND run.automation_id IS NEW.automation_id
    )
      OR NEW.expected_revision IS NOT COALESCE((
        SELECT MAX(prior.sequence)
          FROM automation_workflow_run_events prior
         WHERE prior.run_id = NEW.run_id
           AND prior.sequence < NEW.first_sequence
      ), 0)
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_run_events event_row
         WHERE event_row.run_id = NEW.run_id
           AND event_row.command_id = NEW.command_id
         GROUP BY event_row.run_id, event_row.command_id
        HAVING COUNT(*) = NEW.last_sequence - NEW.first_sequence + 1
           AND MIN(event_row.sequence) = NEW.first_sequence
           AND MAX(event_row.sequence) = NEW.last_sequence
           AND SUM(CASE WHEN event_row.project_id IS NOT NEW.project_id
                          OR event_row.automation_id IS NOT NEW.automation_id
                          OR event_row.request_hash IS NOT NEW.request_hash
                          OR event_row.actor_principal IS NOT NEW.actor_principal
                          OR event_row.actor_credential_id IS NOT NEW.actor_credential_id
                          OR event_row.at IS NOT NEW.created_at
                        THEN 1 ELSE 0 END) = 0
      )
      OR (NEW.actor_principal = 'automation_runner' AND (
        NEW.lease_epoch IS NULL OR NEW.actor_credential_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM automation_workflow_runs run
           WHERE run.id = NEW.run_id
             AND run.runner_credential_id IS NEW.actor_credential_id
        )
      ))
      OR (NEW.lease_epoch IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM automation_workflow_run_leases acquired_lease
           WHERE acquired_lease.run_id = NEW.run_id
             AND acquired_lease.lease_epoch = NEW.lease_epoch
             AND acquired_lease.project_id IS NEW.project_id
             AND acquired_lease.automation_id IS NEW.automation_id
             AND NEW.created_at >= acquired_lease.acquired_at
        ))
      OR (NEW.lease_epoch IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM automation_workflow_run_leases lease
            JOIN automation_workflow_runs run ON run.id = lease.run_id
            JOIN automation_workflows workflow_head
              ON workflow_head.project_id = run.project_id
             AND workflow_head.automation_id = run.automation_id
            JOIN automation_workflow_project_controls control ON control.project_id = run.project_id
            JOIN project_credentials credential ON credential.id = lease.holder_credential_id
           WHERE lease.run_id = NEW.run_id
             AND lease.lease_epoch = NEW.lease_epoch
             AND lease.project_id IS NEW.project_id
             AND lease.automation_id IS NEW.automation_id
             AND lease.holder_principal IS NEW.actor_principal
             AND lease.holder_credential_id IS NEW.actor_credential_id
             AND lease.holder_credential_id IS run.runner_credential_id
             AND lease.released_at IS NULL
             AND lease.expires_at > unixepoch()
             AND credential.project_id IS run.project_id
             AND credential.kind = 'automation_runner'
             AND credential.automation_id IS run.automation_id
             AND credential.revoked_at IS NULL
             AND credential.expires_at > unixepoch()
             AND credential.token_hash NOT LIKE 'legacy-disabled:%'
             AND lease.lease_epoch = (
               SELECT MAX(latest.lease_epoch)
                 FROM automation_workflow_run_leases latest
                WHERE latest.run_id = NEW.run_id
             )
             AND run.execution_authority_id IS NOT NULL
             AND workflow_head.enabled = 1
             AND workflow_head.paused_at IS NULL
             AND workflow_head.active_revision_id IS run.workflow_revision_id
             AND workflow_head.active_execution_authority_id IS run.execution_authority_id
             AND control.paused_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM automation_workflow_run_events workflow_event
            JOIN automation_workflow_effects effect
              ON effect.run_id = workflow_event.run_id
             AND effect.node_id = workflow_event.node_id
            JOIN automation_workflow_runs run ON run.id = effect.run_id
            JOIN automation_workflow_effect_events completed
              ON completed.id = effect.last_event_id
             AND completed.event = 'effect.completed'
            JOIN automation_workflow_effect_events call_start
              ON call_start.effect_id = effect.id
             AND call_start.event = 'effect.call_started'
             AND call_start.effect_attempt = completed.effect_attempt
           WHERE workflow_event.run_id = NEW.run_id
             AND workflow_event.command_id = NEW.command_id
             AND workflow_event.event = 'effect.completed'
             AND effect.status = 'succeeded'
             AND run.runner_credential_id IS NEW.actor_credential_id
             AND completed.actor_principal = 'automation_runner'
             AND completed.actor_credential_id IS NEW.actor_credential_id
             AND completed.lease_epoch IS NEW.lease_epoch
             AND call_start.actor_principal = 'automation_runner'
             AND call_start.actor_credential_id IS NEW.actor_credential_id
             AND call_start.lease_epoch IS NEW.lease_epoch
             AND json_extract(completed.payload_json, '$.intent_hash')
                   IS json_extract(call_start.payload_json, '$.intent_hash')
        ))
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow command event range, root, or lease fence is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_commands_live_authority_insert", `
    CREATE TRIGGER automation_workflow_commands_live_authority_insert
    BEFORE INSERT ON automation_workflow_commands
    WHEN NOT EXISTS (
      SELECT 1
        FROM automation_workflow_runs run
        JOIN automation_workflows workflow_head
          ON workflow_head.project_id = run.project_id
         AND workflow_head.automation_id = run.automation_id
        JOIN automation_workflow_project_controls control
          ON control.project_id = run.project_id
       WHERE run.id = NEW.run_id
         AND run.execution_authority_id IS NOT NULL
         AND workflow_head.enabled = 1
         AND workflow_head.paused_at IS NULL
         AND workflow_head.active_revision_id IS run.workflow_revision_id
         AND workflow_head.active_execution_authority_id IS run.execution_authority_id
         AND control.paused_at IS NULL
    )
      AND NOT (
        (NEW.actor_principal = 'human_project_owner'
          AND NEW.actor_credential_id IS NOT NULL
          AND NEW.last_sequence = NEW.first_sequence
          AND EXISTS (
            SELECT 1 FROM automation_workflow_run_events terminal_event
             WHERE terminal_event.run_id = NEW.run_id
               AND terminal_event.command_id = NEW.command_id
               AND terminal_event.sequence = NEW.first_sequence
               AND terminal_event.event = 'run.cancelled'
          ))
        OR (NEW.actor_principal = 'agentry_system'
          AND NEW.actor_credential_id IS NULL
          AND NEW.last_sequence = NEW.first_sequence
          AND EXISTS (
            SELECT 1 FROM automation_workflow_run_events terminal_event
             WHERE terminal_event.run_id = NEW.run_id
               AND terminal_event.command_id = NEW.command_id
               AND terminal_event.sequence = NEW.first_sequence
               AND terminal_event.event = 'run.quarantined'
          ))
        OR (NEW.last_sequence = NEW.first_sequence + 1
          AND EXISTS (
            SELECT 1
              FROM automation_workflow_run_events effect_event
              JOIN automation_workflow_effects effect
                ON effect.run_id = effect_event.run_id
               AND effect.node_id = effect_event.node_id
              JOIN automation_workflow_effect_events ledger_event
                ON ledger_event.id = effect.last_event_id
               AND ledger_event.event = effect_event.event
             WHERE effect_event.run_id = NEW.run_id
               AND effect_event.command_id = NEW.command_id
               AND effect_event.event IN (
                 'effect.completed', 'effect.reconciled_absent',
                 'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
               )
               AND json_extract(ledger_event.payload_json, '$.workflow_event_id') IS effect_event.id
               AND json_extract(ledger_event.payload_json, '$.workflow_event_payload_hash') IS effect_event.payload_hash
               AND json_extract(ledger_event.payload_json, '$.workflow_command_id') IS NEW.command_id
               AND json_extract(ledger_event.payload_json, '$.workflow_request_hash') IS NEW.request_hash
          )
          AND EXISTS (
            SELECT 1 FROM automation_workflow_run_events terminal_event
             WHERE terminal_event.run_id = NEW.run_id
               AND terminal_event.command_id = NEW.command_id
               AND terminal_event.event = 'run.quarantined'
          ))
      )
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow command is blocked by live authority');
    END
  `),
  ...replaceTrigger("automation_workflow_run_states_binding_insert", `
    CREATE TRIGGER automation_workflow_run_states_binding_insert
    BEFORE INSERT ON automation_workflow_run_states
    WHEN NOT EXISTS (
      SELECT 1
        FROM automation_workflow_runs run
        JOIN automation_workflow_commands receipt ON receipt.run_id = run.id
       WHERE run.id = NEW.run_id
         AND run.project_id IS NEW.project_id
         AND run.automation_id IS NEW.automation_id
         AND run.workflow_revision_id IS NEW.workflow_revision_id
         AND run.workflow_hash IS NEW.workflow_hash
         AND run.compile_hash IS NEW.compile_hash
         AND receipt.expected_revision = 0
         AND receipt.committed_revision IS NEW.state_version
         AND receipt.committed_state_hash IS NEW.state_hash
    )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow initial projection lacks its committed receipt');
    END
  `),
  ...replaceTrigger("automation_workflow_run_states_identity_update", `
    CREATE TRIGGER automation_workflow_run_states_identity_update
    BEFORE UPDATE ON automation_workflow_run_states
    WHEN NEW.run_id IS NOT OLD.run_id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.workflow_revision_id IS NOT OLD.workflow_revision_id
      OR NEW.workflow_hash IS NOT OLD.workflow_hash
      OR NEW.compile_hash IS NOT OLD.compile_hash
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.elapsed_deadline_at IS NOT OLD.elapsed_deadline_at
      OR NEW.updated_at < OLD.updated_at
      OR NEW.active_runtime_seconds < OLD.active_runtime_seconds
      OR NEW.state_version <= OLD.state_version
      OR NOT EXISTS (
        SELECT 1 FROM automation_workflow_commands receipt
         WHERE receipt.run_id = OLD.run_id
           AND receipt.expected_revision IS OLD.state_version
           AND receipt.committed_revision IS NEW.state_version
           AND receipt.committed_state_hash IS NEW.state_hash
      )
      OR NEW.usage_sequence < OLD.usage_sequence
      OR NEW.usage_sequence > OLD.usage_sequence + 1
      OR (NEW.usage_sequence = OLD.usage_sequence AND (
        NEW.turns_used IS NOT OLD.turns_used
        OR NEW.cost_micros IS NOT OLD.cost_micros
        OR NEW.files_changed IS NOT OLD.files_changed
        OR NEW.changed_line_churn IS NOT OLD.changed_line_churn
      ))
      OR (NEW.usage_sequence = OLD.usage_sequence + 1 AND (
        NEW.turns_used < OLD.turns_used
        OR NEW.cost_micros < OLD.cost_micros
        OR NEW.files_changed < OLD.files_changed
        OR NEW.changed_line_churn < OLD.changed_line_churn
      ))
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow projection CAS, receipt, or cumulative usage is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_suspensions_binding_insert", `
    CREATE TRIGGER automation_workflow_suspensions_binding_insert
    BEFORE INSERT ON automation_workflow_suspensions
    WHEN NOT EXISTS (
      SELECT 1
        FROM automation_workflow_runs run
        JOIN automation_workflow_run_events started_event
          ON started_event.run_id = run.id
         AND started_event.sequence = 1
         AND started_event.event = 'run.started'
        JOIN automation_workflow_run_events suspension_event
          ON suspension_event.run_id = run.id
         AND suspension_event.node_id IS NEW.node_id
         AND suspension_event.at IS NEW.created_at
         AND suspension_event.event = CASE NEW.kind
           WHEN 'approval' THEN 'approval.requested'
           WHEN 'wait' THEN 'wait.registered'
           WHEN 'verify' THEN 'verification.started'
         END
       WHERE run.id = NEW.run_id
         AND run.project_id IS NEW.project_id
         AND run.automation_id IS NEW.automation_id
         AND started_event.project_id IS run.project_id
         AND started_event.automation_id IS run.automation_id
         AND started_event.workflow_hash IS run.workflow_hash
         AND started_event.compile_hash IS run.compile_hash
         AND started_event.at IS run.created_at
         AND json_extract(started_event.payload_json, '$.started_at') IS run.created_at
         AND json_extract(started_event.payload_json, '$.elapsed_deadline_at')
               IS run.created_at + json_extract(run.limits_json, '$.max_elapsed_seconds')
         AND suspension_event.project_id IS run.project_id
         AND suspension_event.automation_id IS run.automation_id
         AND suspension_event.workflow_hash IS run.workflow_hash
         AND suspension_event.compile_hash IS run.compile_hash
         AND NEW.status = 'pending'
         AND NEW.version = 1
         AND NEW.updated_at IS NEW.created_at
         AND NEW.created_at >= started_event.at
         AND NEW.deadline_at <= json_extract(started_event.payload_json, '$.elapsed_deadline_at')
         AND (
           (NEW.kind = 'approval'
             AND json_extract(suspension_event.payload_json, '$.binding_hash') IS NEW.binding_hash
             AND json_extract(suspension_event.payload_json, '$.subject_hash') IS NEW.subject_hash
             AND json_extract(suspension_event.payload_json, '$.expires_at') IS NEW.deadline_at)
           OR (NEW.kind IN ('wait', 'verify')
             AND json_extract(suspension_event.payload_json, '$.started_at') IS NEW.created_at
             AND json_extract(suspension_event.payload_json, '$.next_check_at') IS NEW.next_check_at
             AND json_extract(suspension_event.payload_json, '$.deadline_at') IS NEW.deadline_at)
         )
    )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow suspension binding is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_suspensions_identity_update", `
    CREATE TRIGGER automation_workflow_suspensions_identity_update
    BEFORE UPDATE ON automation_workflow_suspensions
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.node_id IS NOT OLD.node_id
      OR NEW.kind IS NOT OLD.kind
      OR NEW.binding_hash IS NOT OLD.binding_hash
      OR NEW.subject_json IS NOT OLD.subject_json
      OR NEW.subject_hash IS NOT OLD.subject_hash
      OR NEW.deadline_at IS NOT OLD.deadline_at
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.version IS NOT OLD.version + 1
      OR NEW.updated_at < OLD.updated_at
      OR OLD.status IS NOT 'pending'
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow suspension identity is immutable and terminal rows cannot change');
    END
  `),
  ...replaceTrigger("automation_workflow_effect_events_no_update", `
    CREATE TRIGGER automation_workflow_effect_events_no_update
    BEFORE UPDATE ON automation_workflow_effect_events
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow effect events are immutable');
    END
  `),
  ...replaceTrigger("automation_workflow_effect_events_binding_insert", `
    CREATE TRIGGER automation_workflow_effect_events_binding_insert
    BEFORE INSERT ON automation_workflow_effect_events
    WHEN NEW.at < unixepoch() - 1
      OR NEW.at > unixepoch() + 1
      OR NOT EXISTS (
      SELECT 1 FROM automation_workflow_runs run
       WHERE run.id = NEW.run_id
         AND run.project_id IS NEW.project_id
         AND run.automation_id IS NEW.automation_id
    )
      OR NEW.sequence IS NOT COALESCE((
        SELECT MAX(prior.sequence) + 1
          FROM automation_workflow_effect_events prior
         WHERE prior.effect_id = NEW.effect_id
      ), 1)
      OR (NEW.sequence > 1 AND NOT EXISTS (
        SELECT 1 FROM automation_workflow_effect_events prior
         WHERE prior.effect_id = NEW.effect_id
           AND prior.sequence = NEW.sequence - 1
           AND prior.id IS NEW.prior_event_hash
           AND prior.at <= NEW.at
      ))
      OR NOT (
        (NEW.sequence = 1
          AND NEW.event = 'effect.intent_reserved'
          AND NEW.effect_attempt = 0
          AND NEW.reconciliation_count = 0
          AND NEW.lease_epoch IS NULL)
        OR
        (NEW.sequence > 1
          AND EXISTS (
            SELECT 1 FROM automation_workflow_effects effect
             WHERE effect.id = NEW.effect_id
               AND effect.project_id IS NEW.project_id
               AND effect.automation_id IS NEW.automation_id
               AND effect.run_id IS NEW.run_id
               AND effect.last_event_id IS NEW.prior_event_hash
          )
          AND (
            (NEW.event = 'effect.call_started'
              AND NEW.effect_attempt = (
                SELECT effect.call_attempt + 1 FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.reconciliation_count = (
                SELECT effect.reconciliation_count FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.lease_epoch IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM automation_workflow_effects effect
                  JOIN automation_workflow_run_leases lease
                    ON lease.run_id = effect.run_id
                   AND lease.lease_epoch = NEW.lease_epoch
                  JOIN automation_workflow_runs run ON run.id = effect.run_id
                  JOIN automation_workflows workflow_head
                    ON workflow_head.project_id = run.project_id
                   AND workflow_head.automation_id = run.automation_id
                  JOIN automation_workflow_project_controls control
                    ON control.project_id = run.project_id
                  JOIN project_credentials credential
                    ON credential.id = lease.holder_credential_id
                 WHERE effect.id = NEW.effect_id
                   AND effect.status IN ('reserved', 'indeterminate')
                   AND effect.call_attempt < effect.max_call_attempts
                   AND (effect.status = 'reserved' OR EXISTS (
                     SELECT 1 FROM automation_workflow_effect_events prior_kind
                      WHERE prior_kind.id = effect.last_event_id
                        AND prior_kind.event = 'effect.reconciled_absent'
                   ))
                   AND lease.holder_principal = 'automation_runner'
                   AND lease.holder_principal IS NEW.actor_principal
                   AND lease.holder_credential_id IS NEW.actor_credential_id
                   AND lease.holder_credential_id IS run.runner_credential_id
                   AND lease.released_at IS NULL
                   AND lease.expires_at > unixepoch()
                   AND credential.project_id IS run.project_id
                   AND credential.kind = 'automation_runner'
                   AND credential.automation_id IS run.automation_id
                   AND credential.revoked_at IS NULL
                   AND credential.expires_at > unixepoch()
                   AND credential.token_hash NOT LIKE 'legacy-disabled:%'
                   AND lease.lease_epoch = (
                     SELECT MAX(latest.lease_epoch)
                       FROM automation_workflow_run_leases latest
                      WHERE latest.run_id = effect.run_id
                   )
                   AND run.execution_authority_id IS NOT NULL
                   AND workflow_head.enabled = 1
                   AND workflow_head.paused_at IS NULL
                   AND workflow_head.active_revision_id IS run.workflow_revision_id
                   AND workflow_head.active_execution_authority_id IS run.execution_authority_id
                   AND control.paused_at IS NULL
              )
              AND EXISTS (
                SELECT 1
                  FROM automation_workflow_effects effect
                  JOIN automation_workflow_budget_charges charge
                    ON charge.run_id = effect.run_id
                   AND charge.kind = 'external_effect_call'
                   AND charge.node_id = effect.node_id
                   AND charge.effect_attempt = NEW.effect_attempt
                 WHERE effect.id = NEW.effect_id
              ))
            OR (NEW.event = 'effect.completed'
              AND NEW.effect_attempt = (
                SELECT effect.call_attempt FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.reconciliation_count = (
                SELECT effect.reconciliation_count FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND EXISTS (
                SELECT 1 FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id AND effect.status = 'indeterminate'
              )
              AND (
                (NEW.actor_principal IN ('agentry_system', 'trusted_ci') AND NEW.lease_epoch IS NULL)
                OR (NEW.actor_principal = 'automation_runner' AND NEW.lease_epoch IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM automation_workflow_effect_events call_start
                     WHERE call_start.effect_id = NEW.effect_id
                       AND call_start.event = 'effect.call_started'
                       AND call_start.effect_attempt = NEW.effect_attempt
                       AND call_start.lease_epoch IS NEW.lease_epoch
                       AND call_start.actor_principal = 'automation_runner'
                       AND call_start.actor_credential_id IS NEW.actor_credential_id
                  ))
              ))
            OR (NEW.event IN ('effect.reconciled_absent', 'effect.reconciliation_unknown')
              AND NEW.effect_attempt = (
                SELECT effect.call_attempt FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.reconciliation_count = (
                SELECT effect.reconciliation_count + 1 FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.reconciliation_count < (
                SELECT effect.max_reconciliations FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.lease_epoch IS NULL
              AND NEW.actor_principal IN ('agentry_system', 'trusted_ci')
              AND EXISTS (
                SELECT 1 FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id AND effect.status = 'indeterminate'
              ))
            OR (NEW.event = 'effect.reconciliation_exhausted'
              AND NEW.effect_attempt = (
                SELECT effect.call_attempt FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.reconciliation_count = (
                SELECT effect.reconciliation_count + 1 FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.reconciliation_count = (
                SELECT effect.max_reconciliations FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id
              )
              AND NEW.lease_epoch IS NULL
              AND NEW.actor_principal IN ('agentry_system', 'trusted_ci')
              AND EXISTS (
                SELECT 1 FROM automation_workflow_effects effect
                 WHERE effect.id = NEW.effect_id AND effect.status = 'indeterminate'
              ))
          ))
      )
      OR (
        NEW.event IN (
          'effect.intent_reserved', 'effect.call_started', 'effect.completed', 'effect.reconciled_absent',
          'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
        )
        AND NOT (
          NEW.event IN (
            'effect.completed', 'effect.reconciled_absent',
            'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
          )
          AND NEW.actor_principal IN ('agentry_system', 'trusted_ci')
          AND EXISTS (
            SELECT 1 FROM automation_workflow_run_states terminal_state
             WHERE terminal_state.run_id = NEW.run_id
               AND terminal_state.status IN ('completed', 'escalated', 'cancelled', 'quarantined')
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM automation_workflow_run_events workflow_event
            LEFT JOIN automation_workflow_effects effect ON effect.id = NEW.effect_id
           WHERE workflow_event.id IS json_extract(NEW.payload_json, '$.workflow_event_id')
             AND workflow_event.project_id IS NEW.project_id
             AND workflow_event.automation_id IS NEW.automation_id
             AND workflow_event.run_id IS NEW.run_id
             AND (
               (NEW.sequence = 1 AND NEW.event = 'effect.intent_reserved')
               OR (effect.run_id IS NEW.run_id AND workflow_event.node_id IS effect.node_id)
             )
             AND workflow_event.event IS NEW.event
             AND workflow_event.payload_hash IS json_extract(NEW.payload_json, '$.workflow_event_payload_hash')
             AND workflow_event.command_id IS json_extract(NEW.payload_json, '$.workflow_command_id')
             AND workflow_event.request_hash IS json_extract(NEW.payload_json, '$.workflow_request_hash')
             AND (
               NEW.event NOT IN (
                 'effect.completed', 'effect.reconciled_absent',
                 'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
               )
               OR NEW.actor_principal NOT IN ('agentry_system', 'trusted_ci')
               OR workflow_event.request_hash IS json_extract(NEW.payload_json, '$.request_hash')
             )
             AND json_extract(NEW.payload_json, '$.intent_hash')
                   IS json_extract(workflow_event.payload_json, '$.intent_hash')
             AND (effect.id IS NULL OR json_extract(NEW.payload_json, '$.intent_hash') IS effect.intent_hash)
             AND (
               NEW.event NOT IN ('effect.intent_reserved', 'effect.call_started')
               AND NOT (NEW.event = 'effect.completed' AND NEW.actor_principal = 'automation_runner')
               OR json(json_extract(NEW.payload_json, '$.evidence')) IS json(workflow_event.payload_json)
             )
             AND workflow_event.actor_principal IS NEW.actor_principal
             AND workflow_event.actor_credential_id IS NEW.actor_credential_id
             AND workflow_event.at IS NEW.at
        )
      )
      OR (
        NEW.actor_principal IN ('agentry_system', 'trusted_ci')
        AND NEW.event IN (
          'effect.completed', 'effect.reconciled_absent',
          'effect.reconciliation_unknown', 'effect.reconciliation_exhausted'
        )
        AND (
          ABS(NEW.at - unixepoch()) > 1
          OR NOT EXISTS (
            SELECT 1 FROM automation_workflow_effects effect
             WHERE effect.id = NEW.effect_id
               AND effect.status = 'indeterminate'
               AND effect.reconcile_after_at IS NOT NULL
               AND effect.reconcile_after_at <= NEW.at
          )
        )
      )
      OR (NEW.actor_principal = 'trusted_ci' AND NOT EXISTS (
        SELECT 1 FROM project_credentials credential
         WHERE credential.id = NEW.actor_credential_id
           AND credential.project_id IS NEW.project_id
           AND credential.kind = 'ci_deploy'
           AND credential.revoked_at IS NULL
           AND credential.expires_at > NEW.at
           AND credential.expires_at > unixepoch()
           AND credential.token_hash NOT LIKE 'legacy-disabled:%'
      ))
      OR (NEW.actor_principal = 'agentry_system' AND NEW.actor_credential_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow effect event chain, lease, or transition evidence is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_effects_binding_insert", `
    CREATE TRIGGER automation_workflow_effects_binding_insert
    BEFORE INSERT ON automation_workflow_effects
    WHEN NEW.status IS NOT 'reserved'
      OR NEW.version IS NOT 1
      OR NEW.call_attempt IS NOT 0
      OR NEW.reconciliation_count IS NOT 0
      OR NEW.created_event_id IS NOT NEW.last_event_id
      OR NEW.provider_operation_key IS NOT NEW.intent_hash
      OR NEW.max_reconciliations > 10
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_effect_events created_event
          JOIN automation_workflow_runs run ON run.id = created_event.run_id
          JOIN automation_workflow_run_events workflow_event
            ON workflow_event.id IS json_extract(created_event.payload_json, '$.workflow_event_id')
         WHERE created_event.id = NEW.created_event_id
           AND created_event.effect_id IS NEW.id
           AND created_event.sequence = 1
           AND created_event.event = 'effect.intent_reserved'
           AND created_event.project_id IS NEW.project_id
           AND created_event.automation_id IS NEW.automation_id
           AND created_event.run_id IS NEW.run_id
           AND run.project_id IS NEW.project_id
           AND run.automation_id IS NEW.automation_id
           AND workflow_event.project_id IS NEW.project_id
           AND workflow_event.automation_id IS NEW.automation_id
           AND workflow_event.run_id IS NEW.run_id
           AND workflow_event.node_id IS NEW.node_id
           AND workflow_event.event = 'effect.intent_reserved'
           AND workflow_event.component_hash IS NEW.component_hash
           AND workflow_event.payload_hash IS json_extract(created_event.payload_json, '$.workflow_event_payload_hash')
           AND workflow_event.command_id IS json_extract(created_event.payload_json, '$.workflow_command_id')
           AND workflow_event.request_hash IS json_extract(created_event.payload_json, '$.workflow_request_hash')
           AND workflow_event.actor_principal IS created_event.actor_principal
           AND workflow_event.actor_credential_id IS created_event.actor_credential_id
           AND workflow_event.at IS created_event.at
           AND json_extract(created_event.payload_json, '$.intent_hash') IS NEW.intent_hash
           AND json_extract(workflow_event.payload_json, '$.intent_hash') IS NEW.intent_hash
           AND json_extract(workflow_event.payload_json, '$.input_hash') IS NEW.input_hash
           AND json_extract(workflow_event.payload_json, '$.provider_target') IS NEW.provider_target
           AND json(json_extract(created_event.payload_json, '$.evidence')) IS json(workflow_event.payload_json)
           AND json_extract(
                 created_event.payload_json,
                 '$.frozen_adapter_policy.reconciliation_policy.max_provider_call_attempts'
               ) IS NEW.max_call_attempts
           AND json_extract(
                 created_event.payload_json,
                 '$.frozen_adapter_policy.reconciliation_policy.max_automatic_reconciliations'
               ) IS NEW.max_reconciliations
           AND NEW.created_at IS created_event.at
           AND NEW.updated_at IS created_event.at
           AND NEW.max_call_attempts <= json_extract(run.limits_json, '$.max_external_effects_per_run')
      )
      OR (NEW.approval_suspension_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM automation_workflow_suspensions approval
         WHERE approval.id = NEW.approval_suspension_id
           AND approval.project_id IS NEW.project_id
           AND approval.automation_id IS NEW.automation_id
           AND approval.run_id IS NEW.run_id
           AND approval.kind = 'approval'
           AND approval.status = 'approved'
           AND approval.binding_hash IS NEW.approval_binding_hash
      ))
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow effect reservation projection is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_effects_identity_update", `
    CREATE TRIGGER automation_workflow_effects_identity_update
    BEFORE UPDATE ON automation_workflow_effects
    WHEN NEW.id IS NOT OLD.id
      OR NEW.project_id IS NOT OLD.project_id
      OR NEW.automation_id IS NOT OLD.automation_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.node_id IS NOT OLD.node_id
      OR NEW.component_id IS NOT OLD.component_id
      OR NEW.component_version IS NOT OLD.component_version
      OR NEW.component_hash IS NOT OLD.component_hash
      OR NEW.approval_suspension_id IS NOT OLD.approval_suspension_id
      OR NEW.approval_binding_hash IS NOT OLD.approval_binding_hash
      OR NEW.input_hash IS NOT OLD.input_hash
      OR NEW.intent_hash IS NOT OLD.intent_hash
      OR NEW.provider_target IS NOT OLD.provider_target
      OR NEW.provider_operation_key IS NOT OLD.provider_operation_key
      OR NEW.created_event_id IS NOT OLD.created_event_id
      OR NEW.max_call_attempts IS NOT OLD.max_call_attempts
      OR NEW.max_reconciliations IS NOT OLD.max_reconciliations
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.version IS NOT OLD.version + 1
      OR NEW.updated_at < OLD.updated_at
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_effect_events next_event
          JOIN automation_workflow_effect_events prior_event
            ON prior_event.id = OLD.last_event_id
         WHERE next_event.id = NEW.last_event_id
           AND next_event.effect_id IS OLD.id
           AND next_event.sequence = prior_event.sequence + 1
           AND next_event.prior_event_hash IS OLD.last_event_id
           AND NEW.updated_at IS next_event.at
      )
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = OLD.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow effect projection identity or event CAS is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_effects_transition_update", `
    CREATE TRIGGER automation_workflow_effects_transition_update
    BEFORE UPDATE ON automation_workflow_effects
    WHEN NOT (
      (OLD.status = 'reserved'
        AND NEW.status = 'indeterminate'
        AND NEW.call_attempt = OLD.call_attempt + 1
        AND NEW.reconciliation_count = OLD.reconciliation_count
        AND NEW.call_started_at IS NOT NULL
        AND NEW.completed_at IS NULL
        AND NEW.reconcile_after_at IS NOT NULL
        AND NEW.receipt_json IS NULL
        AND EXISTS (
          SELECT 1 FROM automation_workflow_effect_events event_row
           WHERE event_row.id = NEW.last_event_id
             AND event_row.event = 'effect.call_started'
             AND event_row.effect_attempt IS NEW.call_attempt
             AND event_row.reconciliation_count IS NEW.reconciliation_count
             AND NEW.call_started_at IS event_row.at
             AND NEW.reconcile_after_at IS json_extract(event_row.payload_json, '$.evidence.next_reconcile_at')
        ))
      OR (OLD.status = 'indeterminate'
        AND NEW.status = 'indeterminate'
        AND NEW.call_attempt = OLD.call_attempt + 1
        AND NEW.reconciliation_count = OLD.reconciliation_count
        AND NEW.completed_at IS NULL
        AND NEW.reconcile_after_at IS NOT NULL
        AND NEW.receipt_json IS NULL
        AND EXISTS (
          SELECT 1
            FROM automation_workflow_effect_events event_row
            JOIN automation_workflow_effect_events prior_event
              ON prior_event.id = OLD.last_event_id
           WHERE event_row.id = NEW.last_event_id
             AND event_row.event = 'effect.call_started'
             AND prior_event.event = 'effect.reconciled_absent'
             AND event_row.effect_attempt IS NEW.call_attempt
             AND NEW.call_started_at IS event_row.at
             AND NEW.reconcile_after_at IS json_extract(event_row.payload_json, '$.evidence.next_reconcile_at')
        ))
      OR (OLD.status = 'indeterminate'
        AND NEW.status = 'indeterminate'
        AND NEW.call_attempt = OLD.call_attempt
        AND NEW.reconciliation_count = OLD.reconciliation_count + 1
        AND NEW.call_started_at IS OLD.call_started_at
        AND NEW.completed_at IS NULL
        AND NEW.reconcile_after_at IS NOT NULL
        AND NEW.receipt_json IS NULL
        AND EXISTS (
          SELECT 1 FROM automation_workflow_effect_events event_row
           WHERE event_row.id = NEW.last_event_id
             AND event_row.event IN ('effect.reconciled_absent', 'effect.reconciliation_unknown')
             AND event_row.effect_attempt IS NEW.call_attempt
             AND event_row.reconciliation_count IS NEW.reconciliation_count
             AND NEW.reconcile_after_at IS COALESCE(
               json_extract(event_row.payload_json, '$.next_reconcile_at'),
               json_extract(event_row.payload_json, '$.evidence.next_reconcile_at')
             )
        ))
      OR (OLD.status = 'indeterminate'
        AND NEW.status = 'succeeded'
        AND NEW.call_attempt = OLD.call_attempt
        AND NEW.reconciliation_count = OLD.reconciliation_count
        AND NEW.reconcile_after_at IS NULL
        AND NEW.completed_at IS NOT NULL
        AND NEW.receipt_json IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM automation_workflow_effect_events event_row
           WHERE event_row.id = NEW.last_event_id
             AND event_row.event = 'effect.completed'
             AND event_row.effect_attempt IS NEW.call_attempt
             AND event_row.reconciliation_count IS NEW.reconciliation_count
             AND NEW.completed_at IS event_row.at
             AND NEW.receipt_hash IS COALESCE(
               json_extract(event_row.payload_json, '$.output_hash'),
               json_extract(event_row.payload_json, '$.evidence.output_hash')
             )
             AND json(NEW.receipt_json) IS json(COALESCE(
               json_extract(event_row.payload_json, '$.output'),
               json_extract(event_row.payload_json, '$.evidence.output')
             ))
        ))
      OR (OLD.status = 'indeterminate'
        AND NEW.status = 'manual_follow_up'
        AND NEW.call_attempt = OLD.call_attempt
        AND NEW.reconciliation_count = OLD.reconciliation_count + 1
        AND NEW.reconciliation_count = NEW.max_reconciliations
        AND NEW.call_started_at IS OLD.call_started_at
        AND NEW.completed_at IS NULL
        AND NEW.reconcile_after_at IS NULL
        AND NEW.receipt_json IS NULL
        AND EXISTS (
          SELECT 1 FROM automation_workflow_effect_events event_row
           WHERE event_row.id = NEW.last_event_id
             AND event_row.event = 'effect.reconciliation_exhausted'
             AND event_row.effect_attempt IS NEW.call_attempt
             AND event_row.reconciliation_count IS NEW.reconciliation_count
        ))
    )
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow effect transition is invalid');
    END
  `),
  ...replaceTrigger("automation_workflow_budget_charges_no_update", `
    CREATE TRIGGER automation_workflow_budget_charges_no_update
    BEFORE UPDATE ON automation_workflow_budget_charges
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow budget charges are immutable');
    END
  `),
  ...replaceTrigger("automation_workflow_budget_charges_binding_insert", `
    CREATE TRIGGER automation_workflow_budget_charges_binding_insert
    BEFORE INSERT ON automation_workflow_budget_charges
    WHEN NEW.created_at < unixepoch() - 1
      OR NEW.created_at > unixepoch() + 1
      OR NOT EXISTS (
        SELECT 1
          FROM automation_workflow_runs run
          JOIN automation_workflows workflow_head
            ON workflow_head.project_id = run.project_id
           AND workflow_head.automation_id = run.automation_id
          JOIN automation_workflow_project_controls control ON control.project_id = run.project_id
         WHERE run.id = NEW.run_id
           AND run.project_id IS NEW.project_id
           AND run.automation_id IS NEW.automation_id
           AND NEW.created_at >= run.created_at
           AND run.execution_authority_id IS NOT NULL
           AND workflow_head.enabled = 1
           AND workflow_head.paused_at IS NULL
           AND workflow_head.active_revision_id IS run.workflow_revision_id
           AND workflow_head.active_execution_authority_id IS run.execution_authority_id
           AND control.paused_at IS NULL
      )
      OR (NEW.kind = 'run' AND (
        EXISTS (
          SELECT 1 FROM automation_workflow_budget_charges prior
           WHERE prior.run_id = NEW.run_id AND prior.kind = 'run'
        )
        OR (SELECT COUNT(*) FROM automation_workflow_budget_charges prior
             WHERE prior.project_id = NEW.project_id
               AND prior.automation_id = NEW.automation_id
               AND prior.kind = 'run'
               AND prior.created_at >= NEW.created_at - 86400)
           >= (SELECT json_extract(run.limits_json, '$.max_runs_per_day')
                 FROM automation_workflow_runs run WHERE run.id = NEW.run_id)
      ))
      OR (NEW.kind = 'external_effect_call' AND (
        NEW.subject_key IS NOT NEW.node_id || ':' || NEW.effect_attempt
        OR NOT EXISTS (
          SELECT 1 FROM automation_workflow_effects effect
           WHERE effect.run_id = NEW.run_id
             AND effect.project_id IS NEW.project_id
             AND effect.automation_id IS NEW.automation_id
             AND effect.node_id IS NEW.node_id
             AND effect.status IN ('reserved', 'indeterminate')
             AND NEW.effect_attempt = effect.call_attempt + 1
             AND NEW.effect_attempt <= effect.max_call_attempts
        )
        OR (SELECT COUNT(*) FROM automation_workflow_budget_charges prior
             WHERE prior.run_id = NEW.run_id
               AND prior.kind = 'external_effect_call')
           >= (SELECT json_extract(run.limits_json, '$.max_external_effects_per_run')
                 FROM automation_workflow_runs run WHERE run.id = NEW.run_id)
        OR (SELECT COUNT(*) FROM automation_workflow_budget_charges prior
             WHERE prior.project_id = NEW.project_id
               AND prior.automation_id = NEW.automation_id
               AND prior.kind = 'external_effect_call'
               AND prior.created_at >= NEW.created_at - 86400)
           >= (SELECT json_extract(run.limits_json, '$.max_external_effects_per_day')
                 FROM automation_workflow_runs run WHERE run.id = NEW.run_id)
      ))
      OR EXISTS (SELECT 1 FROM project_deletion_fences fence WHERE fence.project_id = NEW.project_id)
    BEGIN
      SELECT RAISE(ABORT, 'automation workflow aggregate budget charge is invalid or exhausted');
    END
  `),
  ...fencedDelete("automation_workflow_project_controls"),
  ...fencedDelete("automation_workflow_revisions"),
  ...fencedDelete("automation_workflow_execution_authorities"),
  ...fencedDelete("automation_workflows"),
  ...fencedDelete("automation_workflow_trigger_receipts"),
  ...fencedDelete("automation_workflow_runs"),
  ...fencedDelete("automation_workflow_system_node_claims"),
  ...fencedDelete("automation_workflow_run_leases"),
  ...fencedDelete("automation_workflow_run_states"),
  ...fencedDelete("automation_workflow_run_events"),
  ...fencedDelete("automation_workflow_commands"),
  ...fencedDelete("automation_workflow_suspensions"),
  ...fencedDelete("automation_workflow_effect_events"),
  ...fencedDelete("automation_workflow_effects"),
  ...fencedDelete("automation_workflow_budget_charges"),
]);

export const AUTOMATION_WORKFLOW_RUNTIME_HARD_CUT_SCHEMA_EXTENSION = Object.freeze({
  id: "20260721_01_automation_workflow_runtime_hard_cut",
  schemaProjection: "scripts/schema-extensions/20260721_01_automation_workflow_runtime_hard_cut.mjs",
  tables: Object.freeze([
    "automation_workflow_project_controls",
    "automation_workflow_revisions",
    "automation_workflow_execution_authorities",
    "automation_workflows",
    "automation_workflow_trigger_receipts",
    "automation_workflow_runs",
    "automation_workflow_system_node_claims",
    "automation_workflow_run_leases",
    "automation_workflow_run_states",
    "automation_workflow_run_events",
    "automation_workflow_commands",
    "automation_workflow_suspensions",
    "automation_workflow_effect_events",
    "automation_workflow_effects",
    "automation_workflow_budget_charges",
  ]),
  statements: AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS,
});
