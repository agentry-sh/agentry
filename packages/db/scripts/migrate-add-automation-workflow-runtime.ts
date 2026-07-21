// Immutable workflow revisions plus the event-sourced workflow-v3 runtime.

import { createClient, type Client } from "@libsql/client";
import { AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS } from "./schema-extensions/20260713_01_automation_workflow_runtime.mjs";

async function replaceTrigger(client: Client, name: string, sql: string) {
  await client.execute(`DROP TRIGGER IF EXISTS ${name}`);
  await client.execute(sql);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });
  try {
    await client.batch([...AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS], "write");

    await replaceTrigger(client, "automation_workflow_revisions_no_update", `
      CREATE TRIGGER automation_workflow_revisions_no_update
      BEFORE UPDATE ON automation_workflow_revisions
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow revisions are immutable');
      END
    `);
    await replaceTrigger(client, "automation_workflow_commands_no_update", `
      CREATE TRIGGER automation_workflow_commands_no_update
      BEFORE UPDATE ON automation_workflow_commands
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow command receipts are immutable');
      END
    `);
    await replaceTrigger(client, "automation_workflow_commands_binding_insert", `
      CREATE TRIGGER automation_workflow_commands_binding_insert
      BEFORE INSERT ON automation_workflow_commands
      WHEN NOT EXISTS (
        SELECT 1 FROM automation_workflow_run_states run_state
         WHERE run_state.run_id = NEW.run_id
           AND run_state.project_id IS NEW.project_id
           AND run_state.automation_id IS NEW.automation_id
           AND run_state.state_version IS NEW.committed_revision
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
                        THEN 1 ELSE 0 END) = 0
      )
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow command binding or event range is invalid');
      END
    `);
    await replaceTrigger(client, "automation_workflow_run_events_no_update", `
      CREATE TRIGGER automation_workflow_run_events_no_update
      BEFORE UPDATE ON automation_workflow_run_events
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow run events are immutable');
      END
    `);
    await replaceTrigger(client, "automation_workflows_revision_binding_insert", `
      CREATE TRIGGER automation_workflows_revision_binding_insert
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
      END
    `);
    await replaceTrigger(client, "automation_workflows_revision_binding_update", `
      CREATE TRIGGER automation_workflows_revision_binding_update
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
      END
    `);
    await replaceTrigger(client, "automation_workflow_run_states_binding_insert", `
      CREATE TRIGGER automation_workflow_run_states_binding_insert
      BEFORE INSERT ON automation_workflow_run_states
      WHEN NOT EXISTS (
        SELECT 1
          FROM automation_runs run
          JOIN automation_workflow_revisions revision_row
            ON revision_row.id = NEW.workflow_revision_id
          JOIN automation_workflows workflow_head
            ON workflow_head.project_id = revision_row.project_id
           AND workflow_head.automation_id = revision_row.automation_id
         WHERE run.id = NEW.run_id
           AND run.project_id IS NEW.project_id
           AND run.automation_id IS NEW.automation_id
           AND run.contract_revision IS revision_row.revision
           AND revision_row.project_id IS NEW.project_id
           AND revision_row.automation_id IS NEW.automation_id
           AND revision_row.workflow_hash IS NEW.workflow_hash
           AND revision_row.compile_hash IS NEW.compile_hash
           AND workflow_head.enabled = 1
           AND workflow_head.active_revision_id IS revision_row.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow run state binding is invalid');
      END
    `);
    await replaceTrigger(client, "automation_workflow_run_states_identity_update", `
      CREATE TRIGGER automation_workflow_run_states_identity_update
      BEFORE UPDATE ON automation_workflow_run_states
      WHEN NEW.run_id IS NOT OLD.run_id
        OR NEW.project_id IS NOT OLD.project_id
        OR NEW.automation_id IS NOT OLD.automation_id
        OR NEW.workflow_revision_id IS NOT OLD.workflow_revision_id
        OR NEW.workflow_hash IS NOT OLD.workflow_hash
        OR NEW.compile_hash IS NOT OLD.compile_hash
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.state_version <= OLD.state_version
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow run state identity is immutable and version must advance');
      END
    `);
    await replaceTrigger(client, "automation_workflow_run_events_binding_insert", `
      CREATE TRIGGER automation_workflow_run_events_binding_insert
      BEFORE INSERT ON automation_workflow_run_events
      WHEN NOT EXISTS (
        SELECT 1 FROM automation_workflow_run_states run_state
         WHERE run_state.run_id = NEW.run_id
           AND run_state.project_id IS NEW.project_id
           AND run_state.automation_id IS NEW.automation_id
           AND run_state.workflow_hash IS NEW.workflow_hash
           AND run_state.compile_hash IS NEW.compile_hash
           AND NEW.sequence <= run_state.state_version
      )
      OR (NEW.sequence > 1 AND NOT EXISTS (
        SELECT 1 FROM automation_workflow_run_events prior
         WHERE prior.run_id = NEW.run_id
           AND prior.sequence = NEW.sequence - 1
           AND prior.id IS NEW.prior_event_hash
      ))
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow event binding is invalid');
      END
    `);
    await replaceTrigger(client, "automation_workflow_suspensions_binding_insert", `
      CREATE TRIGGER automation_workflow_suspensions_binding_insert
      BEFORE INSERT ON automation_workflow_suspensions
      WHEN NOT EXISTS (
        SELECT 1 FROM automation_workflow_run_states run_state
         WHERE run_state.run_id = NEW.run_id
           AND run_state.project_id IS NEW.project_id
           AND run_state.automation_id IS NEW.automation_id
           AND NEW.deadline_at <= run_state.elapsed_deadline_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow suspension binding is invalid');
      END
    `);
    await replaceTrigger(client, "automation_workflow_suspensions_identity_update", `
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
        OR OLD.status IS NOT 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow suspension identity is immutable and terminal rows cannot change');
      END
    `);
    await replaceTrigger(client, "automation_workflow_effects_binding_insert", `
      CREATE TRIGGER automation_workflow_effects_binding_insert
      BEFORE INSERT ON automation_workflow_effects
      WHEN NOT EXISTS (
        SELECT 1 FROM automation_workflow_run_states run_state
         WHERE run_state.run_id = NEW.run_id
           AND run_state.project_id IS NEW.project_id
           AND run_state.automation_id IS NEW.automation_id
      )
      OR (
        NEW.approval_suspension_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM automation_workflow_suspensions approval
           WHERE approval.id = NEW.approval_suspension_id
             AND approval.run_id IS NEW.run_id
             AND approval.kind = 'approval'
             AND approval.status = 'approved'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow effect binding is invalid');
      END
    `);
    await replaceTrigger(client, "automation_workflow_effects_identity_update", `
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
        OR NEW.input_hash IS NOT OLD.input_hash
        OR NEW.intent_hash IS NOT OLD.intent_hash
        OR NEW.provider_target IS NOT OLD.provider_target
        OR NEW.created_at IS NOT OLD.created_at
        OR NEW.version IS NOT OLD.version + 1
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow effect identity is immutable and version must advance');
      END
    `);
    await replaceTrigger(client, "automation_workflow_effects_transition_update", `
      CREATE TRIGGER automation_workflow_effects_transition_update
      BEFORE UPDATE ON automation_workflow_effects
      WHEN NOT (
        (OLD.status = 'reserved'
          AND NEW.status IN ('indeterminate', 'succeeded', 'failed', 'cancelled')
          AND NEW.reconciliation_count = OLD.reconciliation_count)
        OR (OLD.status = 'indeterminate'
          AND NEW.status IN ('indeterminate', 'succeeded', 'failed')
          AND NEW.reconciliation_count = OLD.reconciliation_count + 1)
      )
      BEGIN
        SELECT RAISE(ABORT, 'automation workflow effect transition is invalid');
      END
    `);
    await replaceTrigger(client, "automation_workflow_effects_terminal_update_guard", `
      CREATE TRIGGER automation_workflow_effects_terminal_update_guard
      BEFORE UPDATE ON automation_workflow_effects
      WHEN OLD.status IN ('succeeded', 'failed', 'cancelled')
      BEGIN
        SELECT RAISE(ABORT, 'terminal automation workflow effects cannot change');
      END
    `);

    for (const table of [
      "automation_workflows",
      "automation_workflow_revisions",
      "automation_workflow_run_states",
      "automation_workflow_commands",
      "automation_workflow_run_events",
      "automation_workflow_suspensions",
      "automation_workflow_effects",
    ]) {
      await replaceTrigger(client, `${table}_fenced_delete_guard`, `
        CREATE TRIGGER ${table}_fenced_delete_guard
        BEFORE DELETE ON ${table}
        WHEN NOT EXISTS (
          SELECT 1 FROM project_deletion_fences fence
           WHERE fence.project_id = OLD.project_id
        )
        BEGIN
          SELECT RAISE(ABORT, '${table} deletion requires project fence');
        END
      `);
    }

    console.log(JSON.stringify({
      migration: "automation_workflow_runtime",
      schema_version: "3",
      tables: [
        "automation_workflows",
        "automation_workflow_revisions",
        "automation_workflow_run_states",
        "automation_workflow_commands",
        "automation_workflow_run_events",
        "automation_workflow_suspensions",
        "automation_workflow_effects",
      ],
      security_triggers: 22,
    }));
  } finally {
    client.close();
  }
}

await main();
