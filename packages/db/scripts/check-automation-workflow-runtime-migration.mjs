import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";
import {
  AUTOMATION_WORKFLOW_RUNTIME_HARD_CUT_SCHEMA_EXTENSION,
  AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS,
} from "./schema-extensions/20260721_01_automation_workflow_runtime_hard_cut.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-automation-workflow-runtime-hard-cut.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-workflow-runtime-migration-"));
const url = `file:${join(directory, "fixture.sqlite")}`;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

async function mustReject(label, operation) {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(`${label} was accepted`);
}

try {
  const fixture = createClient({ url });
  const seedNow = Math.floor(Date.now() / 1_000);
  await fixture.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE users (id text PRIMARY KEY)",
    "CREATE TABLE projects (id text PRIMARY KEY)",
    `CREATE TABLE project_credentials (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind text NOT NULL,
      name text NOT NULL,
      prefix text NOT NULL,
      token_hash text NOT NULL,
      automation_id text,
      created_by text,
      created_at integer NOT NULL,
      expires_at integer NOT NULL,
      last_used_at integer,
      revoked_at integer,
      revoke_reason text
    )`,
    `CREATE TABLE cases (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status text NOT NULL,
      revision integer NOT NULL,
      last_trust_level text NOT NULL,
      last_credential_kind text NOT NULL,
      last_credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE posthog_connections (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status text NOT NULL
    )`,
    `CREATE TABLE project_deletion_fences (
      project_id text PRIMARY KEY REFERENCES projects(id),
      command_id text NOT NULL,
      reason text NOT NULL,
      actor text NOT NULL,
      created_at integer NOT NULL
    )`,
    "INSERT INTO users (id) VALUES ('owner-1')",
    "INSERT INTO projects (id) VALUES ('project-1')",
    {
      sql: `INSERT INTO project_credentials (
        id, project_id, kind, name, prefix, token_hash, automation_id,
        created_by, created_at, expires_at
      ) VALUES (?, 'project-1', 'automation_runner', 'runner', 'agentry_runner_', ?,
        'workflow-1', 'owner-1', ?, ?)`,
      args: ["credential-1", digest("credential"), seedNow, seedNow + 20_000],
    },
    {
      sql: `INSERT INTO project_credentials (
        id, project_id, kind, name, prefix, token_hash, automation_id,
        created_by, created_at, expires_at
      ) VALUES (?, 'project-1', 'automation_runner', 'different runner', 'agentry_runner_', ?,
        'workflow-other', 'owner-1', ?, ?)`,
      args: ["credential-2", digest("different-credential"), seedNow, seedNow + 20_000],
    },
    {
      sql: `INSERT INTO project_credentials (
        id, project_id, kind, name, prefix, token_hash, automation_id,
        created_by, created_at, expires_at
      ) VALUES (?, 'project-1', 'automation_runner', 'expired runner', 'agentry_runner_', ?,
        'workflow-1', 'owner-1', ?, ?)`,
      args: ["credential-expired", digest("expired-credential"), seedNow - 100, seedNow - 1],
    },
    {
      sql: `INSERT INTO project_credentials (
        id, project_id, kind, name, prefix, token_hash, automation_id,
        created_by, created_at, expires_at
      ) VALUES (?, 'project-1', 'automation_runner', 'disabled legacy runner', 'agentry_runner_', ?,
        'workflow-1', 'owner-1', ?, ?)`,
      args: ["credential-legacy-disabled", `legacy-disabled:${digest("legacy-credential")}`, seedNow, seedNow + 20_000],
    },
  ], "write");
  fixture.close();

  runMigration();
  runMigration();

  const db = createClient({ url });
  const tables = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_workflow%' ORDER BY name",
  );
  assert.deepEqual(
    tables.rows.map((row) => String(row.name)),
    [...AUTOMATION_WORKFLOW_RUNTIME_HARD_CUT_SCHEMA_EXTENSION.tables].sort(),
  );
  const triggers = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'automation_workflow%' ORDER BY name",
  );
  assert.equal(
    triggers.rows.length,
    AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS.filter((statement) =>
      statement.includes("CREATE TRIGGER")
    ).length,
  );

  const clock = await db.execute("SELECT unixepoch() AS now");
  const now = Number(clock.rows[0].now);
  const limits = {
    max_runs_per_day: 2,
    max_attempts_per_trigger: 2,
    max_turns_per_run: 20,
    max_active_runtime_seconds: 600,
    max_elapsed_seconds: 3_600,
    retry_backoff_seconds: 60,
    max_external_effects_per_run: 2,
    max_external_effects_per_day: 2,
    max_files_changed_per_run: 10,
    max_changed_lines_per_run: 1_000,
  };
  const limitsJson = JSON.stringify(limits);
  const triggerNodeId = "schedule_trigger";
  const triggerComponentHash = digest("trigger.schedule.cron@1.0.0");
  const triggerOutputSchemaHash = digest("schedule_trigger_receipt@1");
  const workflowJson = JSON.stringify({
    schema_version: "3",
    entry: triggerNodeId,
    nodes: [{
      id: triggerNodeId,
      kind: "trigger",
      component: { id: "trigger.schedule.cron", version: "1.0.0" },
      config: { cron: "* * * * *", timezone: "UTC", start_window_seconds: 3600 },
    }],
    limits,
  });
  const compiledJson = JSON.stringify({
    resolved_nodes: [{
      node_id: triggerNodeId,
      component: { id: "trigger.schedule.cron", version: "1.0.0" },
      component_hash: triggerComponentHash,
      output_contract: "schedule_trigger_receipt@1",
      output_contract_schema_hash: triggerOutputSchemaHash,
    }],
  });
  const workflowHash = digest("workflow");
  const compileHash = digest("compile");
  const executionAuthorityId = digest("execution-authority");
  const executionDescriptorJson = JSON.stringify({
    schema_version: "1",
    kind: "ordered_funnel_period_compare",
    execution_semantics_version: 1,
  });
  const executionDescriptorHash = digest(executionDescriptorJson);

  await db.execute({
    sql: `INSERT INTO automation_workflow_project_controls (
      project_id, revision, etag, created_by, updated_by, created_at, updated_at
    ) VALUES ('project-1', 1, 'control-1', 'owner-1', 'owner-1', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_revisions (
      id, project_id, automation_id, revision, schema_version, workflow_json,
      workflow_hash, compiled_json, compile_hash, component_hashes_json, created_by, created_at
    ) VALUES ('revision-1', 'project-1', 'workflow-1', 1, '3', ?, ?, ?, ?, '{}', 'owner-1', ?)`,
    args: [workflowJson, workflowHash, compiledJson, compileHash, now],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflows (
      project_id, automation_id, current_revision_id, current_revision, etag,
      created_by, updated_by, created_at, updated_at
    ) VALUES ('project-1', 'workflow-1', 'revision-1', 1, 'workflow-1',
      'owner-1', 'owner-1', ?, ?)`,
    args: [now, now],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_execution_authorities (
      id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
      readiness_hash, owner_confirmed_caller_assertion_ids_json, descriptor_kind,
      descriptor_json, descriptor_hash, runner_credential_id, enabled_by, enabled_at
    ) VALUES (?, 'project-1', 'workflow-1', 'revision-1', ?, ?, ?, '[]',
      'ordered_funnel_period_compare', ?, ?, 'credential-1', 'owner-1', ?)`,
    args: [
      executionAuthorityId,
      workflowHash,
      compileHash,
      digest("readiness"),
      executionDescriptorJson,
      executionDescriptorHash,
      now,
    ],
  });

  const insertRun = async (
    runId,
    receipt,
    triggerKey,
    runnerCredentialId = "credential-1",
    createdAt = now,
  ) => {
    const occurrenceOffset = Number.parseInt(triggerKey.match(/(\d+)$/)?.[1] ?? "0", 10) % 1_000;
    const scheduledFor = now - occurrenceOffset;
    const exactTriggerKey = `schedule:${scheduledFor}`;
    const triggerPayloadJson = JSON.stringify({
      receipt_id: receipt,
      scheduled_for: scheduledFor,
      window_start: scheduledFor,
      window_end: scheduledFor + 3_600,
      instruction_authority: "none",
    });
    const triggerPayloadHash = digest(triggerPayloadJson);
    await db.execute({
      sql: `INSERT INTO automation_workflow_trigger_receipts (
        id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
        execution_authority_id,
        trigger_node_id, component_id, component_version, component_hash,
        output_contract, output_schema_hash, trigger_kind, trigger_key, attempt,
        payload_json, payload_hash, source_trust, status, issued_at, available_at,
        expires_at, updated_at
      ) VALUES (?, 'project-1', 'workflow-1', 'revision-1', ?, ?, ?, ?,
        'trigger.schedule.cron', '1.0.0', ?, 'schedule_trigger_receipt@1', ?,
        'schedule', ?, 1, ?, ?, 'agentry_system', 'ready', ?, ?, ?, ?)`,
      args: [
        receipt,
        workflowHash,
        compileHash,
        executionAuthorityId,
        triggerNodeId,
        triggerComponentHash,
        triggerOutputSchemaHash,
        exactTriggerKey,
        triggerPayloadJson,
        triggerPayloadHash,
        now,
        scheduledFor,
        scheduledFor + 3_600,
        now,
      ],
    });
    const insertedRun = await db.execute({
      sql: `INSERT INTO automation_workflow_runs (
      id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
      execution_authority_id, execution_descriptor_hash,
      trigger_receipt_id, trigger_kind, trigger_key, trigger_payload_json, trigger_payload_hash,
      attempt, idempotency_key_hash, request_hash, limits_json, limits_hash,
      runner_credential_id, created_at, updated_at
    ) VALUES (?, 'project-1', 'workflow-1', 'revision-1', ?, ?, ?, ?, ?, 'schedule', ?, ?, ?,
      1, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        runId,
        workflowHash,
        compileHash,
        executionAuthorityId,
        executionDescriptorHash,
        receipt,
        exactTriggerKey,
        triggerPayloadJson,
        triggerPayloadHash,
        digest(`${runId}:idempotency`),
        digest(`${runId}:request`),
        limitsJson,
        digest(limitsJson),
        runnerCredentialId,
        createdAt,
        createdAt,
      ],
    });
    await db.execute({
      sql: `UPDATE automation_workflow_trigger_receipts
        SET status = 'consumed', consumed_run_id = ?, consumed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ready'`,
      args: [runId, createdAt, createdAt, receipt],
    });
    return insertedRun;
  };

  await mustReject("run root behind a disabled workflow head", () =>
    insertRun("run-disabled", "receipt-disabled", "disabled"));
  await db.execute({
    sql: `UPDATE automation_workflows
      SET enabled = 1, active_revision_id = current_revision_id,
        active_execution_authority_id = ?, updated_at = ?
      WHERE project_id = 'project-1' AND automation_id = 'workflow-1'`,
    args: [executionAuthorityId, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 2, etag = 'control-2', paused_at = ?, pause_reason = 'operator stop', updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now, now],
  });
  await mustReject("run root behind the project kill switch", () =>
    insertRun("run-paused", "receipt-paused", "paused"));
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 3, etag = 'control-3', paused_at = NULL, pause_reason = NULL, updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now],
  });
  await mustReject("run root bound to an expired runner credential", () =>
    insertRun("run-expired-runner", "receipt-expired-runner", "expired-runner", "credential-expired"));
  await mustReject("run root bound to a legacy-disabled runner credential", () =>
    insertRun("run-disabled-runner", "receipt-disabled-runner", "disabled-runner", "credential-legacy-disabled"));
  await mustReject("backdated run root", () =>
    insertRun("run-backdated", "receipt-backdated", "backdated", "credential-1", now - 10));
  await insertRun("run-1", "receipt-1", "trigger-1");
  await mustReject("immutable workflow run root update", () => db.execute(
    "UPDATE automation_workflow_runs SET trigger_key = 'changed' WHERE id = 'run-1'",
  ));

  await db.execute({
    sql: `INSERT INTO automation_workflow_budget_charges (
      id, project_id, automation_id, run_id, kind, subject_key, created_at
    ) VALUES (?, 'project-1', 'workflow-1', 'run-1', 'run', 'run', ?)`,
    args: [digest("run-charge-1"), now],
  });
  await insertRun("run-2", "receipt-2", "trigger-2");
  await db.execute({
    sql: `INSERT INTO automation_workflow_budget_charges (
      id, project_id, automation_id, run_id, kind, subject_key, created_at
    ) VALUES (?, 'project-1', 'workflow-1', 'run-2', 'run', 'run', ?)`,
    args: [digest("run-charge-2"), now],
  });
  await insertRun("run-3", "receipt-3", "trigger-3");
  await mustReject("rolling run budget over-allocation", () => db.execute({
    sql: `INSERT INTO automation_workflow_budget_charges (
      id, project_id, automation_id, run_id, kind, subject_key, created_at
    ) VALUES (?, 'project-1', 'workflow-1', 'run-3', 'run', 'run', ?)`,
    args: [digest("run-charge-3"), now],
  }));
  const unchargedRunStartedPayload = JSON.stringify({
    started_at: now,
    elapsed_deadline_at: now + limits.max_elapsed_seconds,
  });
  await mustReject("run.started without its run budget charge", () => db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, NULL, 'project-1', 'workflow-1', 'run-3', 1, 'uncharged-run-start', ?, '1',
      'run.started', ?, ?, 'trigger', ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      digest("uncharged-run-start"),
      digest("uncharged-run-request"),
      workflowHash,
      compileHash,
      unchargedRunStartedPayload,
      digest(unchargedRunStartedPayload),
      now,
    ],
  }));

  const systemRunStart = digest("system-run-start");
  const systemRunRequest = digest("system-run-request");
  const systemRunState = digest("system-run-state");
  const systemRunStartedPayload = JSON.stringify({
    started_at: now,
    elapsed_deadline_at: now + limits.max_elapsed_seconds,
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, NULL, 'project-1', 'workflow-1', 'run-2', 1, 'system-run-start', ?, '1',
      'run.started', ?, ?, 'trigger', ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      systemRunStart,
      systemRunRequest,
      workflowHash,
      compileHash,
      systemRunStartedPayload,
      digest(systemRunStartedPayload),
      now,
    ],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-2', 'system-run-start', 'project-1', 'workflow-1', ?, 0, 1, 1, 1,
      NULL, 'agentry_system', NULL, '{}', ?, ?, ?)`,
    args: [systemRunRequest, digest("system-run-start-response"), systemRunState, now],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_states (
      run_id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
      state_version, status, current_node_id, state_json, state_hash, elapsed_deadline_at,
      created_at, updated_at
    ) VALUES ('run-2', 'project-1', 'workflow-1', 'revision-1', ?, ?, 1, 'running',
      'query', '{}', ?, ?, ?, ?)`,
    args: [workflowHash, compileHash, systemRunState, now + limits.max_elapsed_seconds, now, now],
  });
  const systemClaimId = digest("system-node-claim");
  const systemClaimInputHash = digest("system-node-input");
  const systemClaimToken1 = digest("system-node-token-1");
  const systemClaimToken2 = digest("system-node-token-2");
  const insertSystemClaim = () => db.execute({
    sql: `INSERT INTO automation_workflow_system_node_claims (
      id, project_id, automation_id, run_id, run_revision, node_id, input_hash,
      claim_epoch, claim_token_hash, status, claimed_at, expires_at, updated_at
    ) VALUES (?, 'project-1', 'workflow-1', 'run-2', 1, 'query', ?,
      1, ?, 'active', ?, ?, ?)`,
    args: [systemClaimId, systemClaimInputHash, systemClaimToken1, now, now + 300, now],
  });
  await insertSystemClaim();
  await mustReject("duplicate system-node input claim", insertSystemClaim);
  await mustReject("stale system-node claim token transition", () => db.execute({
    sql: `UPDATE automation_workflow_system_node_claims
      SET claim_token_hash = ?, status = 'released', released_at = ?, updated_at = ?
      WHERE id = ?`,
    args: [digest("stale-system-node-token"), now, now, systemClaimId],
  }));
  await db.execute({
    sql: `UPDATE automation_workflow_system_node_claims
      SET status = 'released', released_at = ?, updated_at = ?
      WHERE id = ?`,
    args: [now, now, systemClaimId],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_system_node_claims
      SET claim_epoch = 2, claim_token_hash = ?, status = 'active', claimed_at = ?,
        expires_at = ?, released_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ?`,
    args: [systemClaimToken2, now, now + 300, now, systemClaimId],
  });
  await mustReject("system-node claim identity mutation", () => db.execute({
    sql: `UPDATE automation_workflow_system_node_claims SET node_id = 'other' WHERE id = ?`,
    args: [systemClaimId],
  }));
  const pausedSystemEvent = digest("paused-system-event");
  const pausedSystemRequest = digest("paused-system-request");
  const pausedSystemState = digest("paused-system-state");
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-2', 2, 'paused-system-command', ?, '1',
      'node.completed', ?, ?, 'query', '{}', ?, 'agentry_system', NULL, ?)`,
    args: [pausedSystemEvent, systemRunStart, pausedSystemRequest, workflowHash, compileHash, digest("paused-system-payload"), now],
  });
  const insertPausedSystemReceipt = () => db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-2', 'paused-system-command', 'project-1', 'workflow-1', ?, 1, 2, 2, 2,
      NULL, 'agentry_system', NULL, '{}', ?, ?, ?)`,
    args: [pausedSystemRequest, digest("paused-system-response"), pausedSystemState, now],
  });

  const event1 = digest("run-event-1");
  const initialSuspensionEvent = digest("run-event-initial-suspension");
  const request1 = digest("command-request-1");
  const state1 = digest("state-1");
  const startedPayloadJson = JSON.stringify({
    started_at: now,
    elapsed_deadline_at: now + limits.max_elapsed_seconds,
  });
  const insertCommand1 = (createdAt = now) => db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'command-1', 'project-1', 'workflow-1', ?, 0, 2, 1, 2,
      NULL, 'agentry_system', NULL, '{}', ?, ?, ?)`,
    args: [request1, digest("response-1"), state1, createdAt],
  });
  await mustReject("command receipt before its event range", insertCommand1);
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, NULL, 'project-1', 'workflow-1', 'run-1', 1, 'command-1', ?, '1',
      'run.started', ?, ?, 'trigger', ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      event1,
      request1,
      workflowHash,
      compileHash,
      startedPayloadJson,
      digest(startedPayloadJson),
      now,
    ],
  });
  await mustReject("backdated workflow event", () => db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 2, 'backdated-event', ?, '1',
      'node.completed', ?, ?, 'query', '{}', ?, 'agentry_system', NULL, ?)`,
    args: [
      digest("backdated-workflow-event"),
      event1,
      digest("backdated-workflow-request"),
      workflowHash,
      compileHash,
      digest("backdated-workflow-payload"),
      now - 10,
    ],
  }));
  const initialSuspensionPayloadJson = JSON.stringify({
    input_hash: digest("initial-wait-input"),
    started_at: now,
    deadline_at: now + 600,
    next_check_at: now,
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 2, 'command-1', ?, '1',
      'wait.registered', ?, ?, 'initial-wait', ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      initialSuspensionEvent,
      event1,
      request1,
      workflowHash,
      compileHash,
      initialSuspensionPayloadJson,
      digest(initialSuspensionPayloadJson),
      now,
    ],
  });
  await mustReject("backdated command receipt", () => insertCommand1(now - 10));
  await mustReject("initial suspension beyond its immutable registration event", () => db.execute({
    sql: `INSERT INTO automation_workflow_suspensions (
      id, project_id, automation_id, run_id, node_id, kind, status, version,
      binding_hash, subject_json, subject_hash, next_check_at, deadline_at, created_at, updated_at
    ) VALUES ('invalid-initial-suspension', 'project-1', 'workflow-1', 'run-1', 'initial-wait',
      'wait', 'pending', 1, NULL, NULL, NULL, ?, ?, ?, ?)`,
    args: [
      now,
      now + limits.max_elapsed_seconds,
      now,
      now,
    ],
  }));
  await db.execute({
    sql: `INSERT INTO automation_workflow_suspensions (
      id, project_id, automation_id, run_id, node_id, kind, status, version,
      binding_hash, subject_json, subject_hash, next_check_at, deadline_at, created_at, updated_at
    ) VALUES ('initial-suspension', 'project-1', 'workflow-1', 'run-1', 'initial-wait',
      'wait', 'pending', 1, NULL, NULL, NULL, ?, ?, ?, ?)`,
    args: [now, now + 600, now, now],
  });
  await mustReject("suspension without an immutable registration event", () => db.execute({
    sql: `INSERT INTO automation_workflow_suspensions (
      id, project_id, automation_id, run_id, node_id, kind, status, version,
      binding_hash, subject_json, subject_hash, next_check_at, deadline_at, created_at, updated_at
    ) VALUES ('invalid-initial-suspension', 'project-1', 'workflow-1', 'run-1', 'invalid-wait',
      'wait', 'pending', 1, NULL, NULL, NULL, ?, ?, ?, ?)`,
    args: [
      now,
      now + 600,
      now,
      now,
    ],
  }));
  const insertState1 = () => db.execute({
    sql: `INSERT INTO automation_workflow_run_states (
      run_id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
      state_version, status, current_node_id, state_json, state_hash, active_runtime_seconds,
      usage_sequence, turns_used, cost_micros, files_changed, changed_line_churn,
      elapsed_deadline_at, created_at, updated_at
    ) VALUES ('run-1', 'project-1', 'workflow-1', 'revision-1', ?, ?, 2, 'running',
      'trigger', '{}', ?, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
    args: [workflowHash, compileHash, state1, now + 3_600, now, now],
  });
  await mustReject("projection before its command receipt", insertState1);
  await insertCommand1();
  await insertState1();

  const lease1 = digest("lease-1");
  await mustReject("lease using a runner other than the immutable run credential", () => db.execute({
    sql: `INSERT INTO automation_workflow_run_leases (
      run_id, project_id, automation_id, lease_epoch, version, holder_principal,
      holder_credential_id, token_hash, acquired_at, renewed_at, expires_at
    ) VALUES ('run-1', 'project-1', 'workflow-1', 1, 1, 'automation_runner',
      'credential-2', ?, ?, ?, ?)`,
    args: [digest("wrong-runner-lease"), now, now, now + 300],
  }));
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_leases (
      run_id, project_id, automation_id, lease_epoch, version, holder_principal,
      holder_credential_id, token_hash, acquired_at, renewed_at, expires_at
    ) VALUES ('run-1', 'project-1', 'workflow-1', 1, 1, 'automation_runner',
      'credential-1', ?, ?, ?, ?)`,
    args: [lease1, now, now, now + 300],
  });
  await mustReject("takeover of an active lease", () => db.execute({
    sql: `INSERT INTO automation_workflow_run_leases (
      run_id, project_id, automation_id, lease_epoch, version, holder_principal,
      holder_credential_id, token_hash, acquired_at, renewed_at, expires_at
    ) VALUES ('run-1', 'project-1', 'workflow-1', 2, 1, 'automation_runner',
      'credential-1', ?, ?, ?, ?)`,
    args: [digest("busy-lease"), now, now, now + 300],
  }));
  await db.execute({
    sql: `UPDATE automation_workflow_run_leases
      SET version = 2, renewed_at = ?, expires_at = ?
      WHERE run_id = 'run-1' AND lease_epoch = 1`,
    args: [now, now + 400],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_run_leases
      SET version = 3, renewed_at = ?, released_at = ?, release_reason = 'handoff'
      WHERE run_id = 'run-1' AND lease_epoch = 1`,
    args: [now, now],
  });
  const lease2 = digest("lease-2");
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_leases (
      run_id, project_id, automation_id, lease_epoch, version, holder_principal,
      holder_credential_id, token_hash, acquired_at, renewed_at, expires_at
    ) VALUES ('run-1', 'project-1', 'workflow-1', 2, 1, 'automation_runner',
      'credential-1', ?, ?, ?, ?)`,
    args: [lease2, now, now, now + 600],
  });

  const event2 = digest("run-event-2");
  const request2 = digest("command-request-2");
  const state2 = digest("state-2");
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 3, 'command-2', ?, '1',
      'node.completed', ?, ?, 'query', '{}', ?, 'automation_runner', 'credential-1', ?)`,
    args: [event2, initialSuspensionEvent, request2, workflowHash, compileHash, digest("payload-2"), now],
  });
  const insertCommand2 = (epoch) => db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'command-2', 'project-1', 'workflow-1', ?, 2, 3, 3, 3,
      ?, 'automation_runner', 'credential-1', '{}', ?, ?, ?)`,
    args: [request2, epoch, digest("response-2"), state2, now],
  });
  await mustReject("stale lease epoch command", () => insertCommand2(1));
  await mustReject("projection update without a receipt", () => db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 3, state_hash = ?, updated_at = ? WHERE run_id = 'run-1'`,
    args: [state2, now],
  }));
  await insertCommand2(2);
  await db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 3, state_hash = ?, usage_sequence = 1, turns_used = 3,
          cost_micros = 2500, files_changed = 1, changed_line_churn = 8,
          active_runtime_seconds = 5, updated_at = ?
      WHERE run_id = 'run-1'`,
    args: [state2, now],
  });
  await mustReject("cumulative usage rollback", () => db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 4, state_hash = ?, usage_sequence = 2, turns_used = 2, updated_at = ?
      WHERE run_id = 'run-1'`,
    args: [digest("unreceipted-state"), now],
  }));

  const event3 = digest("run-event-3");
  const request3 = digest("command-request-3");
  const state3 = digest("state-3");
  const approvalHash = digest("approval-binding");
  const approvalSubjectHash = digest("approval-subject");
  const approvalPayloadJson = JSON.stringify({
    effect_node_id: "effect-node",
    subject_node_id: "query",
    subject_port: "proposal",
    subject_hash: approvalSubjectHash,
    binding_hash: approvalHash,
    provider_target: "github:example/app",
    expires_at: now + 1_000,
  });
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 4, etag = 'control-4', paused_at = ?, pause_reason = 'kill switch', updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now, now],
  });
  await mustReject("system command receipt while project kill switch is active", insertPausedSystemReceipt);
  const insertEvent3 = () => db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 4, 'command-3', ?, '1',
      'approval.requested', ?, ?, 'approval-node', ?, ?, 'automation_runner', 'credential-1', ?)`,
    args: [
      event3,
      event2,
      request3,
      workflowHash,
      compileHash,
      approvalPayloadJson,
      digest(approvalPayloadJson),
      now,
    ],
  });
  await mustReject("new workflow event while project kill switch is active", insertEvent3);
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 5, etag = 'control-5', paused_at = NULL, pause_reason = NULL, updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now],
  });
  await insertEvent3();
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 6, etag = 'control-6', paused_at = ?, pause_reason = 'receipt kill switch', updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now, now],
  });
  const insertCommand3 = () => db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'command-3', 'project-1', 'workflow-1', ?, 3, 4, 4, 4,
      2, 'automation_runner', 'credential-1', '{}', ?, ?, ?)`,
    args: [request3, digest("response-3"), state3, now],
  });
  await mustReject("runner command while project kill switch is active", insertCommand3);
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 7, etag = 'control-7', paused_at = NULL, pause_reason = NULL, updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now],
  });
  await db.execute({
    sql: `UPDATE project_credentials
      SET revoked_at = ?, revoke_reason = 'runtime fence test'
      WHERE id = 'credential-1'`,
    args: [now],
  });
  await mustReject("runner command with a revoked frozen credential", insertCommand3);
  await db.execute({
    sql: `UPDATE project_credentials
      SET revoked_at = NULL, revoke_reason = NULL, expires_at = ?
      WHERE id = 'credential-1'`,
    args: [now - 1],
  });
  await mustReject("runner command with an expired frozen credential", insertCommand3);
  await db.execute({
    sql: `UPDATE project_credentials
      SET expires_at = ?, token_hash = ?
      WHERE id = 'credential-1'`,
    args: [seedNow + 20_000, `legacy-disabled:${digest("credential")}`],
  });
  await mustReject("runner command with a legacy-disabled frozen credential", insertCommand3);
  await db.execute({
    sql: `UPDATE project_credentials SET token_hash = ? WHERE id = 'credential-1'`,
    args: [digest("credential")],
  });
  await insertCommand3();
  await db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 4, state_hash = ?, updated_at = ? WHERE run_id = 'run-1'`,
    args: [state3, now],
  });

  await db.execute({
    sql: `INSERT INTO automation_workflow_suspensions (
      id, project_id, automation_id, run_id, node_id, kind, status, version,
      binding_hash, subject_json, subject_hash, deadline_at, created_at, updated_at
    ) VALUES ('approval-1', 'project-1', 'workflow-1', 'run-1', 'approval-node',
      'approval', 'pending', 1, ?, '{}', ?, ?, ?, ?)`,
    args: [approvalHash, approvalSubjectHash, now + 1_000, now, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_suspensions
      SET status = 'approved', version = 2, decision_by = 'owner-1',
          decision_reason = 'approved exact intent', resolved_at = ?, updated_at = ?
      WHERE id = 'approval-1'`,
    args: [now, now],
  });

  const effectId = "effect-1";
  const intentHash = digest("effect-intent");
  const effectComponentHash = digest("component");
  const effectInputHash = digest("effect-input");
  const effectIntentWorkflowEvent = digest("run-event-effect-intent");
  const effectIntentRequest = digest("effect-intent-request");
  const effectIntentState = digest("state-effect-intent");
  const effectIntentWorkflowPayload = JSON.stringify({
    input_hash: effectInputHash,
    intent_hash: intentHash,
    provider_target: "github:example/app",
  });
  const effectIntentWorkflowPayloadHash = digest(effectIntentWorkflowPayload);
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id, component_hash,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 5, 'reserve-effect', ?, '1',
      'effect.intent_reserved', ?, ?, 'effect-node', ?, ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      effectIntentWorkflowEvent,
      event3,
      effectIntentRequest,
      workflowHash,
      compileHash,
      effectComponentHash,
      effectIntentWorkflowPayload,
      effectIntentWorkflowPayloadHash,
      now,
    ],
  });
  const frozenAdapterPolicy = {
    protocol_version: "1",
    semantic_validator_version: 1,
    reconciliation_policy: {
      protocol_version: "1",
      strategy: "provider_lookup_before_retry",
      provider: "github",
      stable_operation_key: "intent_hash",
      native_provider_idempotency: false,
      provider_intent_marker_required: true,
      absence_consistency_window_seconds: 60,
      backoff_source: "frozen_workflow_limit",
      max_automatic_reconciliations: 2,
      max_provider_call_attempts: 2,
      outcomes: ["found", "definitively_absent", "unknown"],
      absence_before_consistency_window: "unknown",
      retry_after_definitive_absence: "manual_follow_up_no_provider_retry",
      ambiguous_outcome: "indeterminate",
      exhausted_outcome: "manual_follow_up",
      absence_evidence_required: true,
    },
  };
  const effectIntentLedgerPayload = {
    intent_hash: intentHash,
    workflow_event_id: effectIntentWorkflowEvent,
    workflow_event_payload_hash: effectIntentWorkflowPayloadHash,
    workflow_command_id: "reserve-effect",
    workflow_request_hash: effectIntentRequest,
    evidence: JSON.parse(effectIntentWorkflowPayload),
    frozen_adapter_policy: frozenAdapterPolicy,
    frozen_adapter_policy_hash: digest(JSON.stringify(frozenAdapterPolicy)),
  };
  const effectEvent1 = digest("effect-event-1");
  const insertEffectIntentReserved = (payload = effectIntentLedgerPayload, id = effectEvent1) => db.execute({
    sql: `INSERT INTO automation_workflow_effect_events (
      id, idempotency_key_hash, prior_event_hash, effect_id, project_id, automation_id,
      run_id, sequence, event, effect_attempt, reconciliation_count, lease_epoch,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, NULL, ?, 'project-1', 'workflow-1', 'run-1', 1,
      'effect.intent_reserved', 0, 0, NULL, ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      id,
      digest(`${id}:idempotency`),
      effectId,
      JSON.stringify(payload),
      digest(JSON.stringify(payload)),
      now,
    ],
  });
  await mustReject("effect root with a mismatched workflow crosslink", () => insertEffectIntentReserved({
    ...effectIntentLedgerPayload,
    workflow_event_id: digest("mismatched-effect-root-workflow-event"),
  }, digest("mismatched-effect-root")));
  await insertEffectIntentReserved();
  await db.execute({
    sql: `INSERT INTO automation_workflow_effects (
      id, project_id, automation_id, run_id, node_id, component_id, component_version,
      component_hash, approval_suspension_id, approval_binding_hash, input_hash, intent_hash,
      provider_target, provider_operation_key, created_event_id, last_event_id, status,
      version, call_attempt, max_call_attempts, max_reconciliations, reconciliation_count,
      created_at, updated_at
    ) VALUES (?, 'project-1', 'workflow-1', 'run-1', 'effect-node', 'effect.github', '1.0.0',
      ?, 'approval-1', ?, ?, ?, 'github:example/app', ?, ?, ?, 'reserved',
      1, 0, 2, 2, 0, ?, ?)`,
    args: [
      effectId,
      effectComponentHash,
      approvalHash,
      effectInputHash,
      intentHash,
      intentHash,
      effectEvent1,
      effectEvent1,
      now,
      now,
    ],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'reserve-effect', 'project-1', 'workflow-1', ?, 4, 5, 5, 5,
      NULL, 'agentry_system', NULL, '{}', ?, ?, ?)`,
    args: [effectIntentRequest, digest("effect-intent-response"), effectIntentState, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 5, state_hash = ?, current_node_id = 'effect-node', updated_at = ?
      WHERE run_id = 'run-1'`,
    args: [effectIntentState, now],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_budget_charges (
      id, project_id, automation_id, run_id, kind, subject_key, node_id, effect_attempt, created_at
    ) VALUES (?, 'project-1', 'workflow-1', 'run-1', 'external_effect_call',
      'effect-node:1', 'effect-node', 1, ?)`,
    args: [digest("effect-charge-1"), now],
  });
  const effectCallWorkflowEvent = digest("run-event-effect-call-started");
  const effectCallRequest = digest("effect-call-request");
  const effectCallState = digest("state-effect-call-started");
  const effectCallWorkflowPayload = JSON.stringify({
    intent_hash: intentHash,
    next_reconcile_at: now,
  });
  const effectCallWorkflowPayloadHash = digest(effectCallWorkflowPayload);
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id, component_hash,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 6, 'start-effect-call', ?, '1',
      'effect.call_started', ?, ?, 'effect-node', ?, ?, ?, 'automation_runner', 'credential-1', ?)`,
    args: [
      effectCallWorkflowEvent,
      effectIntentWorkflowEvent,
      effectCallRequest,
      workflowHash,
      compileHash,
      effectComponentHash,
      effectCallWorkflowPayload,
      effectCallWorkflowPayloadHash,
      now,
    ],
  });
  const effectCallLedgerPayload = {
    intent_hash: intentHash,
    workflow_event_id: effectCallWorkflowEvent,
    workflow_event_payload_hash: effectCallWorkflowPayloadHash,
    workflow_command_id: "start-effect-call",
    workflow_request_hash: effectCallRequest,
    evidence: JSON.parse(effectCallWorkflowPayload),
  };
  const effectEvent2 = digest("effect-event-2");
  const insertEffectCallStarted = (payload = effectCallLedgerPayload, id = effectEvent2) => db.execute({
    sql: `INSERT INTO automation_workflow_effect_events (
      id, idempotency_key_hash, prior_event_hash, effect_id, project_id, automation_id,
      run_id, sequence, event, effect_attempt, reconciliation_count, lease_epoch,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, ?, ?, 'project-1', 'workflow-1', 'run-1', 2,
      'effect.call_started', 1, 0, 2, ?, ?, 'automation_runner', 'credential-1', ?)`,
    args: [
      effectEvent2,
      digest("effect-idempotency-2"),
      effectEvent1,
      effectId,
      JSON.stringify(payload),
      digest(JSON.stringify(payload)),
      now,
    ],
  });
  await db.execute({
    sql: `UPDATE project_credentials
      SET revoked_at = ?, revoke_reason = 'effect fence test'
      WHERE id = 'credential-1'`,
    args: [now],
  });
  await mustReject("effect call start with a revoked frozen credential", insertEffectCallStarted);
  await db.execute(
    "UPDATE project_credentials SET revoked_at = NULL, revoke_reason = NULL WHERE id = 'credential-1'",
  );
  await mustReject("effect call with a mismatched workflow crosslink", () => insertEffectCallStarted({
    ...effectCallLedgerPayload,
    workflow_command_id: "mismatched-effect-call-command",
  }, digest("mismatched-effect-call")));
  await insertEffectCallStarted();
  await db.execute({
    sql: `UPDATE automation_workflow_effects
      SET last_event_id = ?, status = 'indeterminate', version = 2, call_attempt = 1,
          reconcile_after_at = ?, call_started_at = ?, updated_at = ?
      WHERE id = ?`,
    args: [effectEvent2, now, now, now, effectId],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'start-effect-call', 'project-1', 'workflow-1', ?, 5, 6, 6, 6,
      2, 'automation_runner', 'credential-1', '{}', ?, ?, ?)`,
    args: [effectCallRequest, digest("effect-call-response"), effectCallState, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 6, state_hash = ?, updated_at = ? WHERE run_id = 'run-1'`,
    args: [effectCallState, now],
  });
  await mustReject("indeterminate effect returning to reserved", () => db.execute({
    sql: `UPDATE automation_workflow_effects
      SET status = 'reserved', version = 3, last_event_id = ? WHERE id = ?`,
    args: [effectEvent2, effectId],
  }));
  const effectEvent3 = digest("effect-event-3");
  const reconciliationKey = digest("reconciliation-key");
  const reconciliationWorkflowEvent = digest("run-event-reconciliation");
  const reconciliationRequest = digest("reconciliation-request");
  const reconciliationWorkflowPayload = JSON.stringify({
    intent_hash: intentHash,
    reconciliation_count: 1,
    next_reconcile_at: now + 120,
  });
  const reconciliationWorkflowPayloadHash = digest(reconciliationWorkflowPayload);
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 7, 'reconcile-effect', ?, '1',
      'effect.reconciled_absent', ?, ?, 'effect-node', ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      reconciliationWorkflowEvent,
      effectCallWorkflowEvent,
      reconciliationRequest,
      workflowHash,
      compileHash,
      reconciliationWorkflowPayload,
      reconciliationWorkflowPayloadHash,
      now,
    ],
  });
  const reconciliationEffectPayload = JSON.stringify({
    intent_hash: intentHash,
    request_hash: reconciliationRequest,
    reconciliation_count: 1,
    next_reconcile_at: now + 120,
    workflow_event_id: reconciliationWorkflowEvent,
    workflow_event_payload_hash: reconciliationWorkflowPayloadHash,
    workflow_command_id: "reconcile-effect",
    workflow_request_hash: reconciliationRequest,
    evidence: JSON.parse(reconciliationWorkflowPayload),
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_effect_events (
      id, idempotency_key_hash, prior_event_hash, effect_id, project_id, automation_id,
      run_id, sequence, event, effect_attempt, reconciliation_count, lease_epoch,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, ?, ?, 'project-1', 'workflow-1', 'run-1', 3,
      'effect.reconciled_absent', 1, 1, NULL, ?, ?, 'agentry_system', NULL, ?)`,
    args: [
      effectEvent3,
      reconciliationKey,
      effectEvent2,
      effectId,
      reconciliationEffectPayload,
      digest(reconciliationEffectPayload),
      now,
    ],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_effects
      SET last_event_id = ?, version = 3, reconciliation_count = 1,
          reconcile_after_at = ?, updated_at = ? WHERE id = ?`,
    args: [effectEvent3, now + 120, now, effectId],
  });
  const reconciledState = digest("state-reconciled");
  await db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'reconcile-effect', 'project-1', 'workflow-1', ?, 6, 7, 7, 7,
      NULL, 'agentry_system', NULL, '{}', ?, ?, ?)`,
    args: [reconciliationRequest, digest("reconciliation-response"), reconciledState, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 7, state_hash = ?, updated_at = ? WHERE run_id = 'run-1'`,
    args: [reconciledState, now],
  });
  await mustReject("duplicate effect reconciliation idempotency key", () => db.execute({
    sql: `INSERT INTO automation_workflow_effect_events (
      id, idempotency_key_hash, prior_event_hash, effect_id, project_id, automation_id,
      run_id, sequence, event, effect_attempt, reconciliation_count, lease_epoch,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, ?, ?, 'project-1', 'workflow-1', 'run-1', 4,
      'effect.reconciliation_unknown', 1, 2, NULL, '{}', ?, 'agentry_system', NULL, ?)`,
    args: [digest("effect-duplicate"), reconciliationKey, effectEvent3, effectId, digest("duplicate"), now],
  }));

  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 8, etag = 'control-8', paused_at = ?, pause_reason = 'receipt-only', updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now, now],
  });
  await db.execute({
    sql: `UPDATE project_credentials
      SET revoked_at = ?, revoke_reason = 'revoked after provider call start'
      WHERE id = 'credential-1'`,
    args: [now],
  });
  const effectEvent4 = digest("effect-event-4");
  const event4 = digest("run-event-4");
  const quarantineEvent = digest("run-event-kill-switch-quarantine");
  const request4 = digest("command-request-4");
  const state4 = digest("state-4");
  const completionWorkflowPayload = JSON.stringify({
    intent_hash: intentHash,
    output: {},
    output_hash: digest("{}"),
  });
  const completionWorkflowPayloadHash = digest(completionWorkflowPayload);
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 8, 'command-4', ?, '1',
      'effect.completed', ?, ?, 'effect-node', ?, ?, 'automation_runner', 'credential-1', ?)`,
    args: [
      event4,
      reconciliationWorkflowEvent,
      request4,
      workflowHash,
      compileHash,
      completionWorkflowPayload,
      completionWorkflowPayloadHash,
      now,
    ],
  });
  const quarantinePayload = JSON.stringify({ reason: "kill_switch_active" });
  await db.execute({
    sql: `INSERT INTO automation_workflow_run_events (
      id, prior_event_hash, project_id, automation_id, run_id, sequence, command_id,
      request_hash, event_version, event, workflow_hash, compile_hash, node_id,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, 'project-1', 'workflow-1', 'run-1', 9, 'command-4', ?, '1',
      'run.quarantined', ?, ?, 'effect-node', ?, ?, 'automation_runner', 'credential-1', ?)`,
    args: [
      quarantineEvent,
      event4,
      request4,
      workflowHash,
      compileHash,
      quarantinePayload,
      digest(quarantinePayload),
      now,
    ],
  });
  const completionEffectPayload = JSON.stringify({
    intent_hash: intentHash,
    workflow_event_id: event4,
    workflow_event_payload_hash: completionWorkflowPayloadHash,
    workflow_command_id: "command-4",
    workflow_request_hash: request4,
    evidence: JSON.parse(completionWorkflowPayload),
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_effect_events (
      id, idempotency_key_hash, prior_event_hash, effect_id, project_id, automation_id,
      run_id, sequence, event, effect_attempt, reconciliation_count, lease_epoch,
      payload_json, payload_hash, actor_principal, actor_credential_id, at
    ) VALUES (?, ?, ?, ?, 'project-1', 'workflow-1', 'run-1', 4,
      'effect.completed', 1, 1, 2, ?, ?, 'automation_runner', 'credential-1', ?)`,
    args: [
      effectEvent4,
      digest("effect-idempotency-4"),
      effectEvent3,
      effectId,
      completionEffectPayload,
      digest(completionEffectPayload),
      now,
    ],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_effects
      SET last_event_id = ?, status = 'succeeded', version = 4,
          reconcile_after_at = NULL, receipt_json = '{}', receipt_hash = ?,
          completed_at = ?, updated_at = ? WHERE id = ?`,
    args: [effectEvent4, digest("{}"), now, now, effectId],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_commands (
      run_id, command_id, project_id, automation_id, request_hash, expected_revision,
      committed_revision, first_sequence, last_sequence, lease_epoch, actor_principal,
      actor_credential_id, response_json, response_hash, committed_state_hash, created_at
    ) VALUES ('run-1', 'command-4', 'project-1', 'workflow-1', ?, 7, 9, 8, 9,
      2, 'automation_runner', 'credential-1', '{}', ?, ?, ?)`,
    args: [request4, digest("response-4"), state4, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_run_states
      SET state_version = 9, state_hash = ?, status = 'quarantined', updated_at = ?
      WHERE run_id = 'run-1'`,
    args: [state4, now],
  });

  await db.execute(
    "UPDATE project_credentials SET revoked_at = NULL, revoke_reason = NULL WHERE id = 'credential-1'",
  );
  const workflowHash2 = digest("workflow-2");
  const compileHash2 = digest("compile-2");
  const executionAuthorityId2 = digest("execution-authority-2");
  await db.execute({
    sql: `INSERT INTO automation_workflow_revisions (
      id, project_id, automation_id, revision, schema_version, workflow_json,
      workflow_hash, compiled_json, compile_hash, component_hashes_json, created_by, created_at
    ) VALUES ('revision-2', 'project-1', 'workflow-1', 2, '3', ?, ?, ?, ?, '{}', 'owner-1', ?)`,
    args: [workflowJson, workflowHash2, compiledJson, compileHash2, now],
  });
  await db.execute({
    sql: `UPDATE automation_workflows
      SET current_revision_id = 'revision-2', current_revision = 2,
          enabled = 0, active_revision_id = NULL, active_execution_authority_id = NULL,
          etag = 'workflow-2-disabled', updated_at = ?
      WHERE project_id = 'project-1' AND automation_id = 'workflow-1'`,
    args: [now],
  });
  await db.execute({
    sql: `UPDATE automation_workflow_project_controls
      SET revision = 9, etag = 'control-9', paused_at = NULL, pause_reason = NULL, updated_at = ?
      WHERE project_id = 'project-1'`,
    args: [now],
  });
  await db.execute({
    sql: `INSERT INTO automation_workflow_execution_authorities (
      id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
      readiness_hash, owner_confirmed_caller_assertion_ids_json, descriptor_kind,
      descriptor_json, descriptor_hash, runner_credential_id, enabled_by, enabled_at
    ) VALUES (?, 'project-1', 'workflow-1', 'revision-2', ?, ?, ?, '[]',
      'ordered_funnel_period_compare', ?, ?, 'credential-1', 'owner-1', ?)`,
    args: [
      executionAuthorityId2,
      workflowHash2,
      compileHash2,
      digest("readiness-2"),
      executionDescriptorJson,
      executionDescriptorHash,
      now,
    ],
  });
  await db.execute({
    sql: `UPDATE automation_workflows
      SET enabled = 1, active_revision_id = 'revision-2',
        active_execution_authority_id = ?, etag = 'workflow-2', updated_at = ?
      WHERE project_id = 'project-1' AND automation_id = 'workflow-1'`,
    args: [executionAuthorityId2, now],
  });
  const insertRevisionTwoRun = async (runId, receiptId) => {
    const scheduledFor = now;
    const triggerKey = `schedule:${scheduledFor}`;
    const triggerPayloadJson = JSON.stringify({
      receipt_id: receiptId,
      scheduled_for: scheduledFor,
      window_start: scheduledFor,
      window_end: scheduledFor + 3_600,
      instruction_authority: "none",
    });
    const triggerPayloadHash = digest(triggerPayloadJson);
    await db.execute({
      sql: `INSERT INTO automation_workflow_trigger_receipts (
        id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
        execution_authority_id,
        trigger_node_id, component_id, component_version, component_hash,
        output_contract, output_schema_hash, trigger_kind, trigger_key, attempt,
        payload_json, payload_hash, source_trust, status, issued_at, available_at,
        expires_at, updated_at
      ) VALUES (?, 'project-1', 'workflow-1', 'revision-2', ?, ?, ?, ?,
        'trigger.schedule.cron', '1.0.0', ?, 'schedule_trigger_receipt@1', ?,
        'schedule', ?, 1, ?, ?, 'agentry_system', 'ready', ?, ?, ?, ?)`,
      args: [
        receiptId,
        workflowHash2,
        compileHash2,
        executionAuthorityId2,
        triggerNodeId,
        triggerComponentHash,
        triggerOutputSchemaHash,
        triggerKey,
        triggerPayloadJson,
        triggerPayloadHash,
        now,
        scheduledFor,
        scheduledFor + 3_600,
        now,
      ],
    });
    const insertedRun = await db.execute({
      sql: `INSERT INTO automation_workflow_runs (
      id, project_id, automation_id, workflow_revision_id, workflow_hash, compile_hash,
      execution_authority_id, execution_descriptor_hash,
      trigger_receipt_id, trigger_kind, trigger_key, trigger_payload_json, trigger_payload_hash,
      attempt, idempotency_key_hash, request_hash, limits_json, limits_hash,
      runner_credential_id, created_at, updated_at
    ) VALUES (?, 'project-1', 'workflow-1', 'revision-2', ?, ?, ?, ?, ?, 'schedule', ?, ?, ?,
      1, ?, ?, ?, ?, 'credential-1', ?, ?)`,
      args: [
        runId,
        workflowHash2,
        compileHash2,
        executionAuthorityId2,
        executionDescriptorHash,
        receiptId,
        triggerKey,
        triggerPayloadJson,
        triggerPayloadHash,
        digest(`${runId}:idempotency`),
        digest(`${runId}:request`),
        limitsJson,
        digest(limitsJson),
        now,
        now,
      ],
    });
    await db.execute({
      sql: `UPDATE automation_workflow_trigger_receipts
        SET status = 'consumed', consumed_run_id = ?, consumed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'ready'`,
      args: [runId, now, now, receiptId],
    });
    return insertedRun;
  };
  await insertRevisionTwoRun("run-revision-2", "receipt-revision-2");
  await mustReject("duplicate trigger attempt within one immutable revision", () =>
    insertRevisionTwoRun("run-revision-2-duplicate", "receipt-revision-2-duplicate"));

  await mustReject("effect event update", () => db.execute(
    "UPDATE automation_workflow_effect_events SET payload_json = '{}' WHERE id = 'missing' OR effect_id = 'effect-1'",
  ));
  await mustReject("budget charge update", () => db.execute(
    "UPDATE automation_workflow_budget_charges SET subject_key = 'changed' WHERE run_id = 'run-1'",
  ));
  await mustReject("unfenced workflow graph delete", () => db.execute(
    "DELETE FROM automation_workflow_effects WHERE id = 'effect-1'",
  ));

  await db.execute({
    sql: `INSERT INTO project_deletion_fences (project_id, command_id, reason, actor, created_at)
      VALUES ('project-1', 'delete-project-1', 'project_delete', 'owner-1', ?)`,
    args: [now],
  });
  await db.batch([
    "DELETE FROM automation_workflow_effects WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_effect_events WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_suspensions WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_commands WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_run_events WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_run_states WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_run_leases WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_system_node_claims WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_budget_charges WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_runs WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_trigger_receipts WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflows WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_execution_authorities WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_revisions WHERE project_id = 'project-1'",
    "DELETE FROM automation_workflow_project_controls WHERE project_id = 'project-1'",
  ], "write");
  const foreignKeys = await db.execute("PRAGMA foreign_key_check");
  assert.equal(foreignKeys.rows.length, 0);
  for (const table of AUTOMATION_WORKFLOW_RUNTIME_HARD_CUT_SCHEMA_EXTENSION.tables) {
    const remaining = await db.execute(`SELECT COUNT(*) AS count FROM ${table}`);
    assert.equal(Number(remaining.rows[0].count), 0, `${table} was not deleted`);
  }
  db.close();
  console.log("automation workflow runtime migration self-test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
