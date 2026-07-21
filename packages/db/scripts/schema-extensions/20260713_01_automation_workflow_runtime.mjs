// Canonical create-only schema projection for the append-only workflow-v3
// runtime migration. This file is immutable once its manifest entry ships.

export const AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS automation_workflows (
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
  `CREATE INDEX IF NOT EXISTS automation_workflows_enabled_idx
    ON automation_workflows (enabled, updated_at)`,
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
  `CREATE TABLE IF NOT EXISTS automation_workflow_run_states (
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
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_states_project_status_idx
    ON automation_workflow_run_states (project_id, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_states_due_idx
    ON automation_workflow_run_states (status, ready_at, elapsed_deadline_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_commands (
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
  `CREATE INDEX IF NOT EXISTS automation_workflow_commands_project_time_idx
    ON automation_workflow_commands (project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_run_events (
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
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_run_events_run_sequence_idx
    ON automation_workflow_run_events (run_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_events_command_idx
    ON automation_workflow_run_events (run_id, command_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_run_events_project_time_idx
    ON automation_workflow_run_events (project_id, at)`,
  `CREATE TABLE IF NOT EXISTS automation_workflow_suspensions (
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
  `CREATE TABLE IF NOT EXISTS automation_workflow_effects (
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
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effects_run_node_idx
    ON automation_workflow_effects (run_id, node_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS automation_workflow_effects_intent_idx
    ON automation_workflow_effects (intent_hash)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_effects_reconcile_idx
    ON automation_workflow_effects (status, reconcile_after_at, updated_at)`,
  `CREATE INDEX IF NOT EXISTS automation_workflow_effects_project_status_idx
    ON automation_workflow_effects (project_id, status, updated_at)`,
]);

export const AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_EXTENSION = Object.freeze({
  id: "20260713_01_automation_workflow_runtime",
  schemaProjection: "scripts/schema-extensions/20260713_01_automation_workflow_runtime.mjs",
  tables: Object.freeze([
    "automation_workflows",
    "automation_workflow_revisions",
    "automation_workflow_run_states",
    "automation_workflow_commands",
    "automation_workflow_run_events",
    "automation_workflow_suspensions",
    "automation_workflow_effects",
  ]),
  statements: AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS,
});
