// Additive, idempotent migration for the automation v2 foundations:
// versioned contracts, durable runs/evidence, case leases, approvals, and the
// webhook delivery outbox.
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node \
//     packages/db/scripts/migrate-add-automation-foundations.ts

import { createClient } from "@libsql/client";

async function tableColumns(client: ReturnType<typeof createClient>, table: string) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function tableExists(client: ReturnType<typeof createClient>, table: string) {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length === 1;
}

async function replaceTrigger(
  client: ReturnType<typeof createClient>,
  name: string,
  definition: string,
) {
  await client.batch([
    `DROP TRIGGER IF EXISTS ${name}`,
    definition,
  ], "write");
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });

  const caseColumns = await tableColumns(client, "cases");
  if (!caseColumns.has("revision")) {
    await client.execute("ALTER TABLE cases ADD COLUMN revision integer NOT NULL DEFAULT 1");
    console.log("added cases.revision.");
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS case_mutation_commands (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      actor_user_id text NOT NULL,
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      expected_revision integer NOT NULL,
      committed_revision integer NOT NULL,
      response_json text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )
  `);
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS case_mutation_commands_project_key_idx ON case_mutation_commands (project_id, idempotency_key_hash)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS case_mutation_commands_case_time_idx ON case_mutation_commands (case_id, created_at)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS automation_contracts (
      project_id text PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    )
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_contracts_enabled_idx ON automation_contracts (enabled, updated_at)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      contract_revision integer NOT NULL,
      contract_etag text NOT NULL,
      policy_snapshot_json text NOT NULL,
      case_id text REFERENCES cases(id) ON DELETE SET NULL,
      case_revision integer,
      trigger_kind text NOT NULL,
      trigger_ref text,
      trigger_snapshot_json text NOT NULL DEFAULT '{}',
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      attempt integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'queued',
      runner_provider text,
      runner_id text,
      model text,
      branch text,
      commit_sha text,
      pr_url text,
      deploy_sha text,
      summary_md text,
      evidence_json text NOT NULL DEFAULT '{}',
      verification_json text,
      error_code text,
      error_message text,
      started_at integer,
      finished_at integer,
      created_at integer NOT NULL DEFAULT (unixepoch()),
      updated_at integer NOT NULL DEFAULT (unixepoch())
    )
  `);
  const runColumns = await tableColumns(client, "automation_runs");
  if (!runColumns.has("request_hash")) {
    await client.execute("ALTER TABLE automation_runs ADD COLUMN request_hash text");
    runColumns.add("request_hash");
    console.log("added automation_runs.request_hash.");
  }
  // Freeze and repair the full connected authority chain only after legacy
  // claim and approval columns have also been inspected below.
  await replaceTrigger(client, "automation_runs_request_hash_insert_guard", `
    CREATE TRIGGER automation_runs_request_hash_insert_guard
    BEFORE INSERT ON automation_runs
    WHEN NEW.request_hash IS NULL OR trim(NEW.request_hash) = ''
    BEGIN
      SELECT RAISE(ABORT, 'automation run request_hash is required');
    END
  `);
  await replaceTrigger(client, "automation_runs_request_hash_update_guard", `
    CREATE TRIGGER automation_runs_request_hash_update_guard
    BEFORE UPDATE OF request_hash ON automation_runs
    WHEN NEW.request_hash IS NULL OR trim(NEW.request_hash) = ''
    BEGIN
      SELECT RAISE(ABORT, 'automation run request_hash is required');
    END
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_runs_project_status_idx ON automation_runs (project_id, status, created_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_runs_case_idx ON automation_runs (case_id, case_revision, created_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_runs_automation_idx ON automation_runs (project_id, automation_id, created_at)",
  );
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_idempotency_idx ON automation_runs (project_id, idempotency_key_hash)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS automation_run_events (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      event text NOT NULL,
      from_status text,
      to_status text,
      actor text,
      data_json text NOT NULL DEFAULT '{}',
      at integer NOT NULL DEFAULT (unixepoch())
    )
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_run_events_run_time_idx ON automation_run_events (run_id, at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_run_events_project_time_idx ON automation_run_events (project_id, at)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS case_claims (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      case_revision integer NOT NULL,
      attempt integer NOT NULL,
      run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      lease_token_hash text NOT NULL,
      lease_token_enc text NOT NULL,
      lease_token_iv text NOT NULL,
      claimed_by text NOT NULL,
      acquired_at integer NOT NULL DEFAULT (unixepoch()),
      expires_at integer NOT NULL,
      released_at integer,
      release_reason text
    )
  `);
  const claimColumns = await tableColumns(client, "case_claims");
  for (const [name, definition] of [
    ["idempotency_key_hash", "text"],
    ["request_hash", "text"],
    ["lease_token_enc", "text"],
    ["lease_token_iv", "text"],
  ] as const) {
    if (!claimColumns.has(name)) {
      await client.execute(`ALTER TABLE case_claims ADD COLUMN ${name} ${definition}`);
      claimColumns.add(name);
      console.log(`added case_claims.${name}.`);
    }
  }
  await replaceTrigger(client, "case_claims_authority_fields_insert_guard", `
    CREATE TRIGGER case_claims_authority_fields_insert_guard
    BEFORE INSERT ON case_claims
    WHEN NEW.idempotency_key_hash IS NULL OR trim(NEW.idempotency_key_hash) = ''
      OR NEW.request_hash IS NULL OR trim(NEW.request_hash) = ''
      OR NEW.lease_token_enc IS NULL OR trim(NEW.lease_token_enc) = ''
      OR NEW.lease_token_iv IS NULL OR trim(NEW.lease_token_iv) = ''
    BEGIN
      SELECT RAISE(ABORT, 'case claim authority fields are required');
    END
  `);
  await replaceTrigger(client, "case_claims_authority_fields_update_guard", `
    CREATE TRIGGER case_claims_authority_fields_update_guard
    BEFORE UPDATE OF idempotency_key_hash, request_hash, lease_token_enc, lease_token_iv ON case_claims
    WHEN NEW.idempotency_key_hash IS NULL OR trim(NEW.idempotency_key_hash) = ''
      OR NEW.request_hash IS NULL OR trim(NEW.request_hash) = ''
      OR NEW.lease_token_enc IS NULL OR trim(NEW.lease_token_enc) = ''
      OR NEW.lease_token_iv IS NULL OR trim(NEW.lease_token_iv) = ''
    BEGIN
      SELECT RAISE(ABORT, 'case claim authority fields are required');
    END
  `);
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS case_claims_attempt_idx ON case_claims (case_id, case_revision, attempt)",
  );
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS case_claims_idempotency_idx ON case_claims (project_id, idempotency_key_hash)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS case_claims_active_idx ON case_claims (project_id, expires_at, released_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS case_claims_run_idx ON case_claims (run_id)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS automation_approvals (
      id text PRIMARY KEY NOT NULL,
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
    )
  `);
  const approvalColumns = await tableColumns(client, "automation_approvals");
  if (!approvalColumns.has("request_reason")) {
    await client.execute("ALTER TABLE automation_approvals ADD COLUMN request_reason text");
    approvalColumns.add("request_reason");
    if (approvalColumns.has("reason")) {
      await client.execute("UPDATE automation_approvals SET request_reason = reason WHERE request_reason IS NULL");
    }
    console.log("added automation_approvals.request_reason.");
  }
  if (!approvalColumns.has("decision_reason")) {
    await client.execute("ALTER TABLE automation_approvals ADD COLUMN decision_reason text");
    approvalColumns.add("decision_reason");
    console.log("added automation_approvals.decision_reason.");
  }
  if (!approvalColumns.has("subject_hash")) {
    await client.execute("ALTER TABLE automation_approvals ADD COLUMN subject_hash text");
    approvalColumns.add("subject_hash");
    console.log("added automation_approvals.subject_hash.");
  }
  if (!approvalColumns.has("subject_json")) {
    await client.execute("ALTER TABLE automation_approvals ADD COLUMN subject_json text");
    approvalColumns.add("subject_json");
    console.log("added automation_approvals.subject_json.");
  }
  await replaceTrigger(client, "automation_approvals_authority_fields_insert_guard", `
    CREATE TRIGGER automation_approvals_authority_fields_insert_guard
    BEFORE INSERT ON automation_approvals
    WHEN NEW.request_reason IS NULL OR trim(NEW.request_reason) = ''
      OR NEW.subject_hash IS NULL OR trim(NEW.subject_hash) = ''
      OR NEW.subject_json IS NULL OR trim(NEW.subject_json) = '' OR NOT json_valid(NEW.subject_json)
    BEGIN
      SELECT RAISE(ABORT, 'automation approval authority fields are required');
    END
  `);
  await replaceTrigger(client, "automation_approvals_authority_fields_update_guard", `
    CREATE TRIGGER automation_approvals_authority_fields_update_guard
    BEFORE UPDATE OF request_reason, subject_hash, subject_json ON automation_approvals
    WHEN NEW.request_reason IS NULL OR trim(NEW.request_reason) = ''
      OR NEW.subject_hash IS NULL OR trim(NEW.subject_hash) = ''
      OR NEW.subject_json IS NULL OR trim(NEW.subject_json) = '' OR NOT json_valid(NEW.subject_json)
    BEGIN
      SELECT RAISE(ABORT, 'automation approval authority fields are required');
    END
  `);
  // Freeze every unsafe authority node before filling any placeholder. A
  // defect in a run, claim, or approval invalidates the connected nonterminal
  // run chain: run cancellation, claim release, approval cancellation, and
  // issued-grant cancellation commit together. The staging table makes a
  // crash before this batch recoverable on the next migration run.
  const runTerminalAssignments = ["status = 'cancelled'"];
  if (runColumns.has("finished_at")) {
    runTerminalAssignments.push("finished_at = COALESCE(finished_at, unixepoch())");
  }
  if (runColumns.has("error_code")) {
    runTerminalAssignments.push(`error_code = COALESCE(NULLIF(error_code, ''),
      CASE WHEN request_hash IS NULL OR trim(request_hash) = ''
        THEN 'legacy_unbound_request' ELSE 'legacy_unbound_authority' END)`);
  }
  if (runColumns.has("error_message")) {
    runTerminalAssignments.push(`error_message = COALESCE(NULLIF(error_message, ''),
      'Legacy automation authority was incomplete and the connected run was cancelled during migration.')`);
  }
  if (runColumns.has("updated_at")) runTerminalAssignments.push("updated_at = unixepoch()");

  const repairStatements = [
    `CREATE TABLE IF NOT EXISTS _agentry_migration_unsafe_runs (
      run_id text PRIMARY KEY NOT NULL
    )`,
    `INSERT OR IGNORE INTO _agentry_migration_unsafe_runs (run_id)
      SELECT id FROM automation_runs
       WHERE request_hash IS NULL OR trim(request_hash) = ''
          OR request_hash = 'legacy-unbound'
          OR request_hash LIKE 'legacy-unbound:automation-run:%'
          OR error_code IN ('legacy_unbound_request', 'legacy_unbound_authority')`,
    `INSERT OR IGNORE INTO _agentry_migration_unsafe_runs (run_id)
      SELECT DISTINCT run_id FROM case_claims
       WHERE run_id IS NOT NULL
         AND (
           idempotency_key_hash IS NULL OR trim(idempotency_key_hash) = ''
           OR request_hash IS NULL OR trim(request_hash) = ''
           OR lease_token_enc IS NULL OR trim(lease_token_enc) = ''
           OR lease_token_iv IS NULL OR trim(lease_token_iv) = ''
           OR idempotency_key_hash LIKE 'legacy-unbound:case-claim:%'
           OR request_hash = 'legacy-unbound'
           OR request_hash LIKE 'legacy-unbound:case-claim:%'
           OR lease_token_enc LIKE 'legacy-unbound:case-claim:%'
           OR lease_token_iv LIKE 'legacy-unbound:case-claim:%'
           OR release_reason = 'legacy_unbound_authority'
         )`,
    `INSERT OR IGNORE INTO _agentry_migration_unsafe_runs (run_id)
      SELECT DISTINCT run_id FROM automation_approvals
       WHERE request_reason IS NULL OR trim(request_reason) = ''
          OR subject_hash IS NULL OR trim(subject_hash) = ''
          OR subject_json IS NULL OR trim(subject_json) = ''
          OR request_reason LIKE 'Legacy unbound approval %'
          OR subject_hash LIKE 'legacy-unbound:automation-approval:%'
          OR CASE WHEN json_valid(subject_json)
            THEN COALESCE(json_extract(subject_json, '$.legacy_unbound'), 0)
            ELSE 1 END = 1`,
    `UPDATE automation_runs
        SET ${runTerminalAssignments.join(", ")}
      WHERE id IN (SELECT run_id FROM _agentry_migration_unsafe_runs)
        AND status IN ('queued', 'claimed', 'running', 'draft_pr_opened', 'awaiting_approval', 'verifying')`,
    `UPDATE case_claims
        SET released_at = COALESCE(released_at, unixepoch()),
            release_reason = COALESCE(NULLIF(release_reason, ''), 'legacy_unbound_authority')
      WHERE idempotency_key_hash IS NULL OR trim(idempotency_key_hash) = ''
         OR request_hash IS NULL OR trim(request_hash) = ''
         OR lease_token_enc IS NULL OR trim(lease_token_enc) = ''
         OR lease_token_iv IS NULL OR trim(lease_token_iv) = ''
         OR idempotency_key_hash LIKE 'legacy-unbound:case-claim:%'
         OR request_hash = 'legacy-unbound'
         OR request_hash LIKE 'legacy-unbound:case-claim:%'
         OR lease_token_enc LIKE 'legacy-unbound:case-claim:%'
         OR lease_token_iv LIKE 'legacy-unbound:case-claim:%'
         OR release_reason = 'legacy_unbound_authority'
         OR run_id IN (SELECT run_id FROM _agentry_migration_unsafe_runs)`,
    `UPDATE automation_approvals
        SET status = CASE WHEN status IN ('pending', 'approved') THEN 'cancelled' ELSE status END,
            decision_reason = CASE
              WHEN status IN ('pending', 'approved')
              THEN COALESCE(NULLIF(decision_reason, ''), 'legacy approval was not bound to an immutable action subject')
              ELSE decision_reason
            END,
            decided_at = CASE
              WHEN status IN ('pending', 'approved') THEN COALESCE(decided_at, unixepoch())
              ELSE decided_at
            END
      WHERE request_reason IS NULL OR trim(request_reason) = ''
         OR subject_hash IS NULL OR trim(subject_hash) = ''
         OR subject_json IS NULL OR trim(subject_json) = ''
         OR request_reason LIKE 'Legacy unbound approval %'
         OR subject_hash LIKE 'legacy-unbound:automation-approval:%'
         OR CASE WHEN json_valid(subject_json)
           THEN COALESCE(json_extract(subject_json, '$.legacy_unbound'), 0)
           ELSE 1 END = 1
         OR run_id IN (SELECT run_id FROM _agentry_migration_unsafe_runs)`,
    `UPDATE automation_runs
        SET request_hash = 'legacy-unbound:automation-run:' || id
      WHERE request_hash IS NULL OR trim(request_hash) = ''`,
    `UPDATE case_claims
        SET idempotency_key_hash = CASE
              WHEN idempotency_key_hash IS NULL OR trim(idempotency_key_hash) = ''
              THEN 'legacy-unbound:case-claim:idempotency:' || id ELSE idempotency_key_hash END,
            request_hash = CASE
              WHEN request_hash IS NULL OR trim(request_hash) = ''
              THEN 'legacy-unbound:case-claim:request:' || id ELSE request_hash END,
            lease_token_enc = CASE
              WHEN lease_token_enc IS NULL OR trim(lease_token_enc) = ''
              THEN 'legacy-unbound:case-claim:lease-enc:' || id ELSE lease_token_enc END,
            lease_token_iv = CASE
              WHEN lease_token_iv IS NULL OR trim(lease_token_iv) = ''
              THEN 'legacy-unbound:case-claim:lease-iv:' || id ELSE lease_token_iv END`,
    `UPDATE automation_approvals
        SET request_reason = CASE
              WHEN request_reason IS NULL OR trim(request_reason) = ''
              THEN 'Legacy unbound approval ' || id ELSE request_reason END,
            subject_hash = CASE
              WHEN subject_hash IS NULL OR trim(subject_hash) = ''
              THEN 'legacy-unbound:automation-approval:subject:' || id ELSE subject_hash END,
            subject_json = CASE
              WHEN subject_json IS NULL OR trim(subject_json) = '' OR NOT json_valid(subject_json)
              THEN json_object('legacy_unbound', 1, 'approval_id', id) ELSE subject_json END`,
  ];
  if (await tableExists(client, "automation_action_grants")) {
    const grantColumns = await tableColumns(client, "automation_action_grants");
    if (grantColumns.has("run_id") && grantColumns.has("status")) {
      repairStatements.push(`UPDATE automation_action_grants
        SET status = 'cancelled'
        WHERE status = 'issued'
          AND run_id IN (SELECT run_id FROM _agentry_migration_unsafe_runs)`);
    }
  }
  if (await tableExists(client, "automation_trigger_receipts")) {
    const receiptColumns = await tableColumns(client, "automation_trigger_receipts");
    if (receiptColumns.has("claim_id") && receiptColumns.has("status")) {
      const receiptAssignments = ["status = 'cancelled'"];
      if (receiptColumns.has("cancelled_at")) {
        receiptAssignments.push("cancelled_at = COALESCE(cancelled_at, unixepoch())");
      }
      if (receiptColumns.has("cancel_reason")) {
        receiptAssignments.push("cancel_reason = COALESCE(NULLIF(cancel_reason, ''), 'legacy_unbound_authority')");
      }
      repairStatements.push(`UPDATE automation_trigger_receipts
        SET ${receiptAssignments.join(", ")}
        WHERE status = 'claimed'
          AND claim_id IN (
            SELECT id FROM case_claims
             WHERE released_at IS NOT NULL
          )`);
    }
  }
  repairStatements.push("DROP TABLE _agentry_migration_unsafe_runs");
  await client.batch(repairStatements, "write");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_approvals_pending_idx ON automation_approvals (project_id, status, expires_at)",
  );
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS automation_approvals_run_action_idx ON automation_approvals (run_id, action)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_approvals_run_idx ON automation_approvals (run_id)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS webhook_recipient_sets (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_event_id text NOT NULL,
      source_event_hash text NOT NULL,
      event text NOT NULL,
      webhook_ids_json text NOT NULL DEFAULT '[]',
      created_at integer NOT NULL DEFAULT (unixepoch())
    )
  `);
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS webhook_recipient_sets_source_event_idx ON webhook_recipient_sets (project_id, source_event_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS webhook_recipient_sets_project_time_idx ON webhook_recipient_sets (project_id, created_at)",
  );

  await client.execute(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id text PRIMARY KEY NOT NULL,
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
    )
  `);
  const deliveryColumns = await tableColumns(client, "webhook_deliveries");
  if (!deliveryColumns.has("source_event_id")) {
    await client.execute("ALTER TABLE webhook_deliveries ADD COLUMN source_event_id text");
    console.log("added webhook_deliveries.source_event_id.");
  }
  if (!deliveryColumns.has("source_event_hash")) {
    await client.execute("ALTER TABLE webhook_deliveries ADD COLUMN source_event_hash text");
    console.log("added webhook_deliveries.source_event_hash.");
  }
  // Existing deliveries remain replayable but can never collide with a new
  // domain event. Fresh databases get physical NOT NULL columns above;
  // triggers enforce the same invariant on SQLite tables upgraded in place.
  await client.execute(
    "UPDATE webhook_deliveries SET source_event_id = 'legacy:' || id WHERE source_event_id IS NULL OR source_event_id = ''",
  );
  await client.execute(
    "UPDATE webhook_deliveries SET source_event_hash = 'legacy:' || id WHERE source_event_hash IS NULL OR source_event_hash = ''",
  );
  await replaceTrigger(client, "webhook_deliveries_source_event_insert_guard", `
    CREATE TRIGGER webhook_deliveries_source_event_insert_guard
    BEFORE INSERT ON webhook_deliveries
    WHEN NEW.source_event_id IS NULL OR NEW.source_event_id = '' OR NEW.source_event_hash IS NULL OR NEW.source_event_hash = ''
    BEGIN
      SELECT RAISE(ABORT, 'webhook delivery source event identity is required');
    END
  `);
  await replaceTrigger(client, "webhook_deliveries_source_event_update_guard", `
    CREATE TRIGGER webhook_deliveries_source_event_update_guard
    BEFORE UPDATE OF source_event_id, source_event_hash ON webhook_deliveries
    WHEN NEW.source_event_id IS NULL OR NEW.source_event_id = '' OR NEW.source_event_hash IS NULL OR NEW.source_event_hash = ''
    BEGIN
      SELECT RAISE(ABORT, 'webhook delivery source event identity is required');
    END
  `);
  await client.execute(
    "CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (status, next_attempt_at)",
  );
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_source_event_idx ON webhook_deliveries (webhook_id, source_event_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_time_idx ON webhook_deliveries (webhook_id, created_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS webhook_deliveries_project_time_idx ON webhook_deliveries (project_id, created_at)",
  );
  // A subscription can be disabled after an outbox row was prepared but
  // before the caller's atomic batch inserts it. Preserve the recipient
  // tombstone, but make it non-deliverable in the same insert transaction.
  await replaceTrigger(client, "webhook_deliveries_active_subscription_guard", `
    CREATE TRIGGER webhook_deliveries_active_subscription_guard
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
    END
  `);

  // `automation_runs` supersedes the legacy write path, but migrations are not
  // data-retention policy. Keep `agent_runs` as read-only archival history;
  // removing it requires a separate, explicitly authorized retention change.
  if (await tableExists(client, "agent_runs")) {
    const legacyRunColumns = await tableColumns(client, "agent_runs");
    if (legacyRunColumns.has("case_id") && legacyRunColumns.has("started_at")) {
      await client.execute(
        "CREATE INDEX IF NOT EXISTS agent_runs_case_idx ON agent_runs (case_id, started_at)",
      );
    }
  }

  console.log("automation v2 foundation tables and indexes are ready.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
