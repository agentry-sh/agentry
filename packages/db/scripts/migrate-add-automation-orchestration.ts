// Additive, idempotent migration for server-owned automation orchestration:
// trigger receipts/state, atomic budget reservations, pre-action grants,
// lifecycle/proof/usage fields, and trusted deploy-to-run binding.
//
// The canonical release entrypoint is `npm -w @agentry/db run
// db:migrate:core`; its manifest guarantees foundation -> provenance ->
// orchestration -> connected-foundation convergence.

import { createClient, type Client } from "@libsql/client";

async function tableExists(client: Client, table: string) {
  const result = await client.execute({
    sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length > 0;
}

async function tableColumns(client: Client, table: string) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function replaceTrigger(client: Client, name: string, definition: string) {
  await client.batch([
    `DROP TRIGGER IF EXISTS ${name}`,
    definition,
  ], "write");
}

async function replaceIndex(client: Client, name: string, definition: string) {
  await client.batch([
    `DROP INDEX IF EXISTS ${name}`,
    definition,
  ], "write");
}

type PartialOwnedTable = {
  table: string;
  archive: string;
  columns: Set<string>;
};

async function ensureCanonicalOwnedTable(
  client: Client,
  table: string,
  canonicalColumns: readonly string[],
  createSql: string,
): Promise<PartialOwnedTable | null> {
  const archive = `_agentry_legacy_${table}`;
  const archiveExists = await tableExists(client, archive);
  if (!(await tableExists(client, table))) {
    await client.execute(createSql);
    if (!archiveExists) return null;
    return { table, archive, columns: await tableColumns(client, archive) };
  }

  const columns = await tableColumns(client, table);
  if (canonicalColumns.every((column) => columns.has(column))) {
    if (!archiveExists) return null;
    return { table, archive, columns: await tableColumns(client, archive) };
  }
  if (archiveExists) {
    throw new Error(
      `${table} is partial while ${archive} already exists; stop and reconcile the prior interrupted orchestration migration`,
    );
  }

  const objects = await client.execute({
    sql: `SELECT type, name FROM sqlite_master
           WHERE tbl_name = ?
             AND type IN ('index', 'trigger')
             AND name NOT LIKE 'sqlite_autoindex_%'`,
    args: [table],
  });
  const statements: string[] = [];
  for (const object of objects.rows) {
    const type = String(object.type).toUpperCase();
    const name = String(object.name).replaceAll('"', '""');
    statements.push(`DROP ${type} IF EXISTS "${name}"`);
  }
  statements.push(`ALTER TABLE ${table} RENAME TO ${archive}`);
  statements.push(createSql);
  await client.batch(statements, "write");
  console.log(`rebuilt partial ${table}; legacy rows are staged in ${archive}.`);
  return { table, archive, columns };
}

function textValue(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function integerValue(row: Record<string, unknown>, column: string): number | null {
  const value = row[column];
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}

function rowRecord(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

async function addColumnIfMissing(
  client: Client,
  table: string,
  column: string,
  definition: string,
) {
  const columns = await tableColumns(client, table);
  if (columns.has(column)) return;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`added ${table}.${column}.`);
}

async function assertNoNulls(client: Client, table: string, column: string) {
  const result = await client.execute(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IS NULL OR ${column} = ''`,
  );
  if (Number(result.rows[0]?.count ?? 0) > 0) {
    throw new Error(`${table}.${column} still contains unbound rows; migration stopped`);
  }
}

async function assertUnique(client: Client, table: string, column: string) {
  const result = await client.execute(
    `SELECT ${column}, COUNT(*) AS count
       FROM ${table}
      WHERE ${column} IS NOT NULL
      GROUP BY ${column}
     HAVING COUNT(*) > 1
      LIMIT 1`,
  );
  if (result.rows.length > 0) {
    throw new Error(
      `${table}.${column} contains duplicate value ${String(result.rows[0]?.[column])}; migration stopped`,
    );
  }
}

const ORCHESTRATION_TABLES = {
  automation_trigger_states: {
    columns: [
      "project_id", "automation_id", "contract_revision", "contract_etag", "trigger_hash",
      "trigger_kind", "trigger_ref", "last_source_evaluated_at", "last_outcome",
      "consecutive_breaches", "cooldown_until", "last_receipt_at", "last_schedule_slot",
      "updated_at",
    ],
    create: `CREATE TABLE automation_trigger_states (
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
  },
  automation_trigger_receipts: {
    columns: [
      "id", "project_id", "automation_id", "contract_revision", "contract_etag",
      "trigger_kind", "trigger_key", "case_id", "case_revision", "attempt", "alert_id",
      "scheduled_for", "required_trust", "source_trust", "snapshot_json", "snapshot_hash",
      "status", "claim_id", "run_id", "issued_at", "not_before_at", "expires_at",
      "claimed_at", "consumed_at", "cancelled_at", "cancel_reason",
    ],
    create: `CREATE TABLE automation_trigger_receipts (
      id text PRIMARY KEY NOT NULL,
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
  },
  automation_budget_charges: {
    columns: ["id", "project_id", "automation_id", "run_id", "kind", "created_at"],
    create: `CREATE TABLE automation_budget_charges (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      run_id text NOT NULL,
      kind text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
  },
  automation_action_grants: {
    columns: [
      "id", "project_id", "automation_id", "run_id", "action", "subject_hash",
      "subject_json", "token_hash", "token_enc", "token_iv", "idempotency_key_hash",
      "request_hash", "credential_id", "status", "issued_at", "expires_at", "consumed_at",
    ],
    create: `CREATE TABLE automation_action_grants (
      id text PRIMARY KEY NOT NULL,
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
  },
  automation_run_report_sources: {
    columns: [
      "id", "project_id", "automation_id", "run_id", "runner_credential_id",
      "idempotency_key_hash", "request_hash", "plan_hash", "blueprint_id",
      "output_schema_version", "period_start", "period_end", "row_count", "source_json",
      "source_hash", "readiness_json", "queried_at", "created_at",
    ],
    create: `CREATE TABLE automation_run_report_sources (
      id text PRIMARY KEY NOT NULL,
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
  },
} as const;

async function convergePartialOwnedRows(
  client: Client,
  partials: PartialOwnedTable[],
  legacySnapshot: string,
  now: number,
) {
  if (partials.length === 0) return;

  await client.execute(`CREATE TABLE IF NOT EXISTS _agentry_migration_unsafe_orchestration_runs (
    run_id text PRIMARY KEY NOT NULL
  )`);
  const runRows = await client.execute(`SELECT id, project_id, automation_id, contract_revision,
    contract_etag, case_id, case_revision, attempt, created_at, updated_at, finished_at
    FROM automation_runs`);
  const runs = new Map(runRows.rows.map((row) => [String(row.id), rowRecord(row)]));
  const claimRows = await client.execute(`SELECT id, project_id, automation_id, case_id,
    case_revision, attempt, run_id, acquired_at, expires_at, released_at, release_reason
    FROM case_claims`);
  const claims = new Map(claimRows.rows.map((row) => [String(row.id), rowRecord(row)]));
  const contractRows = await client.execute(
    "SELECT project_id, revision, etag FROM automation_contracts",
  );
  const contracts = new Map(contractRows.rows.map((row) => [String(row.project_id), rowRecord(row)]));
  const projectRows = await client.execute("SELECT id FROM projects");
  const projectIds = new Set(projectRows.rows.map((row) => String(row.id)));
  const credentialRows = await client.execute("SELECT id FROM project_credentials");
  const credentialIds = new Set(credentialRows.rows.map((row) => String(row.id)));

  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  const dropArchives: string[] = [];
  const seenBudgetCharges = new Set<string>();

  for (const partial of partials) {
    const legacyRows = await client.execute(`SELECT rowid AS __rowid, * FROM ${partial.archive}`);
    if (partial.table === "automation_trigger_states") {
      // Trigger state is a rebuildable cache, not historical authority. An
      // incomplete row cannot safely preserve cooldown or eligibility.
      if (legacyRows.rows.length > 0) {
        console.log(`reset ${legacyRows.rows.length} incomplete automation trigger state row(s).`);
      }
      dropArchives.push(partial.archive);
      continue;
    }

    if (partial.table === "automation_trigger_receipts") {
      for (const raw of legacyRows.rows) {
        const row = rowRecord(raw);
        const id = textValue(row, "id");
        if (!id) throw new Error("partial automation_trigger_receipts row has no id; migration stopped");
        const runId = textValue(row, "run_id");
        const claimId = textValue(row, "claim_id");
        const run = runId ? runs.get(runId) : undefined;
        const claim = claimId ? claims.get(claimId) : undefined;
        const claimRunId = claim ? textValue(claim, "run_id") : null;
        const connectedRunId = runId ?? claimRunId;
        const connectedRun = connectedRunId ? runs.get(connectedRunId) : undefined;
        const projectId =
          (connectedRun && textValue(connectedRun, "project_id")) ??
          (claim && textValue(claim, "project_id")) ??
          textValue(row, "project_id");
        const automationId =
          (connectedRun && textValue(connectedRun, "automation_id")) ??
          (claim && textValue(claim, "automation_id")) ??
          textValue(row, "automation_id");
        if (!projectId || !projectIds.has(projectId) || !automationId) {
          throw new Error(
            `partial automation trigger receipt ${id} has no exact project/automation identity; migration stopped`,
          );
        }
        if (connectedRunId) {
          statements.push({
            sql: "INSERT OR IGNORE INTO _agentry_migration_unsafe_orchestration_runs (run_id) VALUES (?)",
            args: [connectedRunId],
          });
        }
        const contract = contracts.get(projectId);
        const contractRevision =
          (connectedRun && integerValue(connectedRun, "contract_revision")) ??
          integerValue(row, "contract_revision") ??
          (contract && integerValue(contract, "revision")) ??
          0;
        const contractEtag =
          (connectedRun && textValue(connectedRun, "contract_etag")) ??
          textValue(row, "contract_etag") ??
          (contract && textValue(contract, "etag")) ??
          "legacy-unbound";
        const caseId =
          (claim && textValue(claim, "case_id")) ??
          (connectedRun && textValue(connectedRun, "case_id")) ??
          textValue(row, "case_id");
        const caseRevision =
          (claim && integerValue(claim, "case_revision")) ??
          (connectedRun && integerValue(connectedRun, "case_revision")) ??
          integerValue(row, "case_revision");
        const attempt =
          (claim && integerValue(claim, "attempt")) ??
          (connectedRun && integerValue(connectedRun, "attempt")) ??
          integerValue(row, "attempt");
        const issuedAt =
          integerValue(row, "issued_at") ??
          (claim && integerValue(claim, "acquired_at")) ??
          (connectedRun && integerValue(connectedRun, "created_at")) ??
          now;
        const expiresAt =
          integerValue(row, "expires_at") ??
          (claim && integerValue(claim, "expires_at")) ??
          (connectedRun && (
            integerValue(connectedRun, "finished_at") ?? integerValue(connectedRun, "updated_at")
          )) ??
          issuedAt;
        statements.push({
          sql: `INSERT OR REPLACE INTO automation_trigger_receipts (
            id, project_id, automation_id, contract_revision, contract_etag,
            trigger_kind, trigger_key, case_id, case_revision, attempt, alert_id,
            scheduled_for, required_trust, source_trust, snapshot_json, snapshot_hash,
            status, claim_id, run_id, issued_at, not_before_at, expires_at,
            claimed_at, consumed_at, cancelled_at, cancel_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            projectId,
            automationId,
            contractRevision,
            contractEtag,
            ["alert", "unhandled_cases", "schedule"].includes(textValue(row, "trigger_kind") ?? "")
              ? textValue(row, "trigger_kind")!
              : "unhandled_cases",
            `legacy-partial-receipt:${id}`,
            caseId,
            caseRevision,
            attempt,
            textValue(row, "alert_id"),
            integerValue(row, "scheduled_for"),
            "legacy_unbound",
            "legacy_unbound",
            legacySnapshot,
            `legacy-unbound:partial-receipt:${id}`,
            "cancelled",
            claimId,
            connectedRunId,
            issuedAt,
            integerValue(row, "not_before_at") ?? issuedAt,
            expiresAt,
            integerValue(row, "claimed_at"),
            integerValue(row, "consumed_at"),
            integerValue(row, "cancelled_at") ?? now,
            textValue(row, "cancel_reason") ?? "legacy_unbound_orchestration_receipt",
          ],
        });
      }
      dropArchives.push(partial.archive);
      continue;
    }

    if (partial.table === "automation_action_grants") {
      for (const raw of legacyRows.rows) {
        const row = rowRecord(raw);
        const id = textValue(row, "id");
        const runId = textValue(row, "run_id");
        const run = runId ? runs.get(runId) : undefined;
        if (!id || !runId || !run) {
          throw new Error("partial automation action grant lacks an exact retained run; migration stopped");
        }
        const projectId = textValue(run, "project_id")!;
        const automationId = textValue(run, "automation_id")!;
        const marker = `legacy-unbound:action-grant:${id}`;
        statements.push({
          sql: `INSERT OR REPLACE INTO automation_action_grants (
            id, project_id, automation_id, run_id, action, subject_hash, subject_json,
            token_hash, token_enc, token_iv, idempotency_key_hash, request_hash,
            credential_id, status, issued_at, expires_at, consumed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            projectId,
            automationId,
            runId,
            textValue(row, "action") ?? "draft_pr",
            marker,
            JSON.stringify({ legacy_unbound: true, grant_id: id }),
            marker,
            marker,
            marker,
            marker,
            marker,
            credentialIds.has(textValue(row, "credential_id") ?? "")
              ? textValue(row, "credential_id")
              : null,
            textValue(row, "status") === "consumed" ? "consumed" : "cancelled",
            integerValue(row, "issued_at") ?? now,
            integerValue(row, "expires_at") ?? now,
            integerValue(row, "consumed_at"),
          ],
        });
      }
      dropArchives.push(partial.archive);
      continue;
    }

    if (partial.table === "automation_budget_charges") {
      for (const raw of legacyRows.rows) {
        const row = rowRecord(raw);
        const baseId = textValue(row, "id");
        const runId = textValue(row, "run_id");
        const run = runId ? runs.get(runId) : undefined;
        if (!baseId || !runId || !run) {
          throw new Error("partial automation budget charge lacks an exact retained run; migration stopped");
        }
        const existingKind = textValue(row, "kind");
        const kinds = existingKind === "run" || existingKind === "draft_pr"
          ? [existingKind]
          : ["run", "draft_pr"];
        for (const kind of kinds) {
          const logicalKey = `${runId}\u0000${kind}`;
          if (seenBudgetCharges.has(logicalKey)) continue;
          seenBudgetCharges.add(logicalKey);
          statements.push({
            sql: `INSERT OR IGNORE INTO automation_budget_charges
              (id, project_id, automation_id, run_id, kind, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
              kinds.length === 1 ? baseId : `${baseId}:legacy:${kind}`,
              textValue(run, "project_id")!,
              textValue(run, "automation_id")!,
              runId,
              kind,
              integerValue(row, "created_at") ?? now,
            ],
          });
        }
      }
      dropArchives.push(partial.archive);
      continue;
    }

    if (partial.table === "automation_run_report_sources") {
      // Incomplete source evidence can never be promoted into a live trusted
      // report source. Preserve the renamed table as an archive and close any
      // connected nonterminal run below.
      for (const raw of legacyRows.rows) {
        const runId = textValue(rowRecord(raw), "run_id");
        if (runId && runs.has(runId)) {
          statements.push({
            sql: "INSERT OR IGNORE INTO _agentry_migration_unsafe_orchestration_runs (run_id) VALUES (?)",
            args: [runId],
          });
        }
      }
      console.log(`retained ${partial.archive} as non-authoritative report-source history.`);
    }
  }

  if (statements.length > 0) await client.batch(statements, "write");
  for (const archive of dropArchives) await client.execute(`DROP TABLE ${archive}`);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });

  const prerequisites = [
    "projects",
    "cases",
    "project_credentials",
    "automation_contracts",
    "automation_runs",
    "case_claims",
    "automation_approvals",
    "deploys",
  ];
  for (const table of prerequisites) {
    if (!(await tableExists(client, table))) {
      throw new Error(
        `required table ${table} is missing; run the ordered db:migrate:core coordinator`,
      );
    }
  }

  const legacySnapshot = JSON.stringify({
    boundary: {
      content_trust: "untrusted_observation",
      instruction_authority: "none",
    },
    migration: "legacy_unbound",
  });
  const nowResult = await client.execute("SELECT unixepoch() AS now");
  const migrationNow = Number(nowResult.rows[0]?.now ?? Math.floor(Date.now() / 1_000));
  const partialOwnedTables: PartialOwnedTable[] = [];
  for (const [table, spec] of Object.entries(ORCHESTRATION_TABLES)) {
    const partial = await ensureCanonicalOwnedTable(
      client,
      table,
      spec.columns,
      spec.create,
    );
    if (partial) partialOwnedTables.push(partial);
  }
  await convergePartialOwnedRows(client, partialOwnedTables, legacySnapshot, migrationNow);

  // SQLite cannot add a required column to a populated table without a
  // constant default. The two identity columns are added nullable, backfilled
  // to unique fail-closed legacy receipts, and guarded by triggers below. New
  // databases get physical NOT NULL constraints from the canonical schema.
  const initialRunColumns = await tableColumns(client, "automation_runs");
  const initialClaimColumns = await tableColumns(client, "case_claims");
  const liveRunOrchestrationColumnsPreexisted = [
    "trigger_receipt_id",
    "deadline_at",
    "turns_used",
    "cost_micros",
    "usage_sequence",
  ].every((column) => initialRunColumns.has(column));
  const liveClaimReceiptColumnPreexisted = initialClaimColumns.has("trigger_receipt_id");
  for (const [column, definition] of [
    ["trigger_receipt_id", "text"],
    ["verification_started_at", "integer"],
    ["pr_proof_json", "text"],
    ["pr_proof_hash", "text"],
    [
      "pr_proof_credential_id",
      "text REFERENCES project_credentials(id) ON DELETE SET NULL",
    ],
    ["pr_proof_at", "integer"],
    ["turns_used", "integer NOT NULL DEFAULT 0"],
    ["cost_micros", "integer NOT NULL DEFAULT 0"],
    ["usage_sequence", "integer NOT NULL DEFAULT 0"],
    ["deadline_at", "integer"],
    ["last_heartbeat_at", "integer"],
    ["retry_eligible_at", "integer"],
  ] as const) {
    await addColumnIfMissing(client, "automation_runs", column, definition);
  }
  await addColumnIfMissing(client, "case_claims", "trigger_receipt_id", "text");
  await addColumnIfMissing(
    client,
    "deploys",
    "automation_run_id",
    "text REFERENCES automation_runs(id) ON DELETE SET NULL",
  );
  await addColumnIfMissing(client, "deploys", "source_commit_sha", "text");

  // Snapshot demonstrably exact authority before changing any identity. A
  // missing field, terminal receipt, cross-boundary reference, legacy marker,
  // or label-only trusted-server signal invalidates live authority. Invalid
  // chains are closed together and rebound to isolated archival receipts; a
  // cancelled/expired receipt is never promoted back to consumed/claimed.
  const repairStatements: Array<{ sql: string; args: Array<string | number> }> = [
    {
      sql: `CREATE TABLE IF NOT EXISTS _agentry_migration_unsafe_orchestration_runs (
        run_id text PRIMARY KEY NOT NULL
      )`,
      args: [],
    },
    { sql: "DROP TABLE IF EXISTS _agentry_migration_valid_run_bindings", args: [] },
    { sql: "DROP TABLE IF EXISTS _agentry_migration_valid_claim_bindings", args: [] },
    {
      sql: `CREATE TABLE _agentry_migration_valid_run_bindings (
        run_id text PRIMARY KEY NOT NULL
      )`,
      args: [],
    },
    {
      sql: `CREATE TABLE _agentry_migration_valid_claim_bindings (
        claim_id text PRIMARY KEY NOT NULL
      )`,
      args: [],
    },
    {
      sql: `INSERT OR IGNORE INTO _agentry_migration_valid_run_bindings (run_id)
        SELECT run.id
          FROM automation_runs run
          JOIN automation_trigger_receipts receipt ON receipt.id = run.trigger_receipt_id
         WHERE ${liveRunOrchestrationColumnsPreexisted ? 1 : 0} = 1
           AND run.trigger_receipt_id IS NOT NULL AND trim(run.trigger_receipt_id) <> ''
           AND run.deadline_at IS NOT NULL
           AND run.turns_used IS NOT NULL
           AND run.cost_micros IS NOT NULL
           AND run.usage_sequence IS NOT NULL
           AND receipt.project_id IS run.project_id
           AND receipt.automation_id IS run.automation_id
           AND receipt.contract_revision IS run.contract_revision
           AND receipt.contract_etag IS run.contract_etag
           AND receipt.run_id IS run.id
           AND receipt.status IS 'consumed'
           AND receipt.required_trust IS NOT NULL
           AND receipt.required_trust NOT LIKE 'legacy%'
           AND receipt.source_trust IS NOT NULL
           AND receipt.source_trust NOT LIKE 'legacy%'
           AND receipt.snapshot_hash IS NOT NULL AND trim(receipt.snapshot_hash) <> ''
           AND json_valid(receipt.snapshot_json)
           AND (
             (run.case_id IS NULL AND receipt.case_id IS NULL)
             OR (
               receipt.case_id IS run.case_id
               AND receipt.case_revision IS run.case_revision
               AND receipt.attempt IS run.attempt
             )
           )
           AND (
             receipt.required_trust IS NOT 'trusted_server'
             OR EXISTS (
               SELECT 1
                 FROM cases trusted_case
                 JOIN project_credentials trusted_credential
                   ON trusted_credential.id = trusted_case.last_credential_id
                  AND trusted_credential.project_id = trusted_case.project_id
                  AND trusted_credential.kind = 'server_ingest'
                  AND trusted_credential.token_hash NOT LIKE 'legacy-disabled:%'
                WHERE trusted_case.id = run.case_id
                  AND trusted_case.project_id = run.project_id
                  AND trusted_case.revision IS run.case_revision
                  AND trusted_case.last_trust_level = 'trusted_server'
                  AND trusted_case.last_credential_kind = 'server_ingest'
                  AND trusted_case.last_credential_id IS NOT NULL
             )
           )`,
      args: [],
    },
    {
      sql: `INSERT OR IGNORE INTO _agentry_migration_valid_claim_bindings (claim_id)
        SELECT claim.id
          FROM case_claims claim
          JOIN automation_trigger_receipts receipt ON receipt.id = claim.trigger_receipt_id
         WHERE ${liveClaimReceiptColumnPreexisted ? 1 : 0} = 1
           AND claim.trigger_receipt_id IS NOT NULL AND trim(claim.trigger_receipt_id) <> ''
           AND (claim.released_at IS NOT NULL OR claim.expires_at > unixepoch())
           AND receipt.project_id IS claim.project_id
           AND receipt.automation_id IS claim.automation_id
           AND receipt.case_id IS claim.case_id
           AND receipt.case_revision IS claim.case_revision
           AND receipt.attempt IS claim.attempt
           AND receipt.claim_id IS claim.id
           AND receipt.required_trust IS NOT NULL
           AND receipt.required_trust NOT LIKE 'legacy%'
           AND receipt.source_trust IS NOT NULL
           AND receipt.source_trust NOT LIKE 'legacy%'
           AND receipt.snapshot_hash IS NOT NULL AND trim(receipt.snapshot_hash) <> ''
           AND json_valid(receipt.snapshot_json)
           AND (
             (
               claim.run_id IS NULL
               AND receipt.run_id IS NULL
               AND receipt.status IS 'claimed'
               AND receipt.expires_at > unixepoch()
             )
             OR (
               claim.run_id IS NOT NULL
               AND receipt.run_id IS claim.run_id
               AND receipt.status IS 'consumed'
               AND EXISTS (
                 SELECT 1 FROM _agentry_migration_valid_run_bindings valid_run
                  WHERE valid_run.run_id = claim.run_id
               )
             )
           )
           AND (
             receipt.required_trust IS NOT 'trusted_server'
             OR EXISTS (
               SELECT 1
                 FROM cases trusted_case
                 JOIN project_credentials trusted_credential
                   ON trusted_credential.id = trusted_case.last_credential_id
                  AND trusted_credential.project_id = trusted_case.project_id
                  AND trusted_credential.kind = 'server_ingest'
                  AND trusted_credential.token_hash NOT LIKE 'legacy-disabled:%'
                WHERE trusted_case.id = claim.case_id
                  AND trusted_case.project_id = claim.project_id
                  AND trusted_case.revision IS claim.case_revision
                  AND trusted_case.last_trust_level = 'trusted_server'
                  AND trusted_case.last_credential_kind = 'server_ingest'
                  AND trusted_case.last_credential_id IS NOT NULL
             )
           )`,
      args: [],
    },
    {
      sql: `INSERT OR IGNORE INTO _agentry_migration_unsafe_orchestration_runs (run_id)
        SELECT id FROM automation_runs
         WHERE status IN ('queued', 'claimed', 'running', 'draft_pr_opened', 'awaiting_approval', 'verifying')
           AND id NOT IN (SELECT run_id FROM _agentry_migration_valid_run_bindings)`,
      args: [],
    },
    {
      sql: `INSERT OR IGNORE INTO _agentry_migration_unsafe_orchestration_runs (run_id)
        SELECT DISTINCT claim.run_id
          FROM case_claims claim
         WHERE claim.run_id IS NOT NULL
           AND (
             claim.id NOT IN (SELECT claim_id FROM _agentry_migration_valid_claim_bindings)
             OR NOT EXISTS (
               SELECT 1 FROM automation_runs run
                WHERE run.id = claim.run_id
                  AND run.project_id IS claim.project_id
                  AND run.automation_id IS claim.automation_id
                  AND run.case_id IS claim.case_id
                  AND run.case_revision IS claim.case_revision
             )
           )`,
      args: [],
    },
    {
      sql: `INSERT OR IGNORE INTO _agentry_migration_unsafe_orchestration_runs (run_id)
        SELECT DISTINCT approval.run_id
          FROM automation_approvals approval
          JOIN automation_runs run ON run.id = approval.run_id
         WHERE approval.project_id IS NOT run.project_id
            OR approval.automation_id IS NOT run.automation_id`,
      args: [],
    },
    {
      sql: `INSERT OR IGNORE INTO _agentry_migration_unsafe_orchestration_runs (run_id)
        SELECT DISTINCT grant_row.run_id
          FROM automation_action_grants grant_row
          JOIN automation_runs run ON run.id = grant_row.run_id
         WHERE grant_row.project_id IS NOT run.project_id
            OR grant_row.automation_id IS NOT run.automation_id`,
      args: [],
    },
    {
      sql: `UPDATE automation_runs
               SET deadline_at = COALESCE(deadline_at, finished_at, updated_at, started_at, created_at, unixepoch()),
                   turns_used = COALESCE(turns_used, 0),
                   cost_micros = COALESCE(cost_micros, 0),
                   usage_sequence = COALESCE(usage_sequence, 0)
             WHERE deadline_at IS NULL
                OR turns_used IS NULL
                OR cost_micros IS NULL
                OR usage_sequence IS NULL`,
      args: [],
    },
    {
      sql: `UPDATE automation_trigger_receipts
               SET status = 'cancelled',
                   cancelled_at = COALESCE(cancelled_at, unixepoch()),
                   cancel_reason = COALESCE(NULLIF(cancel_reason, ''), 'legacy_unbound_orchestration_authority')
             WHERE id IN (
               SELECT run.trigger_receipt_id
                 FROM automation_runs run
                 JOIN _agentry_migration_unsafe_orchestration_runs unsafe ON unsafe.run_id = run.id
                WHERE run.trigger_receipt_id IS NOT NULL
             )
                OR id IN (
                  SELECT claim.trigger_receipt_id
                    FROM case_claims claim
                   WHERE claim.id NOT IN (SELECT claim_id FROM _agentry_migration_valid_claim_bindings)
                     AND claim.trigger_receipt_id IS NOT NULL
                     AND NOT EXISTS (
                       SELECT 1 FROM _agentry_migration_valid_run_bindings valid_run
                       JOIN automation_runs run ON run.id = valid_run.run_id
                        WHERE run.trigger_receipt_id = claim.trigger_receipt_id
                     )
                )`,
      args: [],
    },
    {
      sql: `UPDATE automation_runs
               SET status = 'cancelled',
                   error_code = COALESCE(NULLIF(error_code, ''), 'legacy_unbound_trigger'),
                   error_message = COALESCE(NULLIF(error_message, ''),
                     'Run lacked an exact immutable server-issued trigger chain and was cancelled by migration.'),
                   finished_at = COALESCE(finished_at, unixepoch()),
                   updated_at = unixepoch()
             WHERE id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)
               AND status IN ('queued', 'claimed', 'running', 'draft_pr_opened', 'awaiting_approval', 'verifying')`,
      args: [],
    },
    {
      sql: `UPDATE case_claims
               SET released_at = COALESCE(released_at, unixepoch()),
                   release_reason = COALESCE(NULLIF(release_reason, ''), 'legacy_unbound_trigger')
             WHERE id NOT IN (SELECT claim_id FROM _agentry_migration_valid_claim_bindings)
                OR run_id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)`,
      args: [],
    },
    {
      sql: `UPDATE automation_approvals
               SET status = CASE WHEN status IN ('pending', 'approved') THEN 'cancelled' ELSE status END,
                   decision_reason = CASE WHEN status IN ('pending', 'approved')
                     THEN COALESCE(NULLIF(decision_reason, ''), 'connected trigger authority was invalidated by migration')
                     ELSE decision_reason END,
                   decided_at = CASE WHEN status IN ('pending', 'approved')
                     THEN COALESCE(decided_at, unixepoch()) ELSE decided_at END
             WHERE run_id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)
                OR NOT EXISTS (
                  SELECT 1 FROM automation_runs run
                   WHERE run.id = automation_approvals.run_id
                     AND run.project_id IS automation_approvals.project_id
                     AND run.automation_id IS automation_approvals.automation_id
                )`,
      args: [],
    },
    {
      sql: `UPDATE automation_action_grants
               SET status = 'cancelled'
             WHERE status = 'issued'
               AND (
                 run_id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)
                 OR subject_hash LIKE 'legacy-unbound:%'
                 OR token_hash LIKE 'legacy-unbound:%'
                 OR request_hash LIKE 'legacy-unbound:%'
                 OR NOT EXISTS (
                   SELECT 1 FROM automation_runs run
                    WHERE run.id = automation_action_grants.run_id
                      AND run.project_id IS automation_action_grants.project_id
                      AND run.automation_id IS automation_action_grants.automation_id
                 )
               )`,
      args: [],
    },
    {
      sql: `UPDATE automation_runs
               SET trigger_receipt_id = 'legacy-run:' || id
             WHERE id NOT IN (SELECT run_id FROM _agentry_migration_valid_run_bindings)
                OR id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)`,
      args: [],
    },
    {
      sql: `UPDATE case_claims
               SET trigger_receipt_id = 'legacy-claim:' || id
             WHERE id NOT IN (SELECT claim_id FROM _agentry_migration_valid_claim_bindings)
                OR run_id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)`,
      args: [],
    },
    {
      sql: `UPDATE automation_runs
               SET deadline_at = COALESCE(deadline_at, finished_at, updated_at, started_at, created_at, unixepoch()),
                   turns_used = COALESCE(turns_used, 0),
                   cost_micros = COALESCE(cost_micros, 0),
                   usage_sequence = COALESCE(usage_sequence, 0)
             WHERE deadline_at IS NULL
                OR turns_used IS NULL
                OR cost_micros IS NULL
                OR usage_sequence IS NULL`,
      args: [],
    },
    {
      sql: `INSERT OR REPLACE INTO automation_trigger_receipts (
              id, project_id, automation_id, contract_revision, contract_etag,
              trigger_kind, trigger_key, case_id, case_revision, attempt,
              required_trust, source_trust, snapshot_json, snapshot_hash,
              status, claim_id, run_id, issued_at, not_before_at, expires_at,
              claimed_at, consumed_at, cancelled_at, cancel_reason
            )
            SELECT 'legacy-run:' || run.id,
                   run.project_id,
                   run.automation_id,
                   run.contract_revision,
                   run.contract_etag,
                   CASE WHEN run.trigger_kind IN ('alert', 'unhandled_cases', 'schedule')
                     THEN run.trigger_kind ELSE 'unhandled_cases' END,
                   'legacy-rebound-run:' || run.id,
                   run.case_id,
                   run.case_revision,
                   run.attempt,
                   'legacy_unbound',
                   'legacy_unbound',
                   ?,
                   'legacy-unbound:run:' || run.id,
                   'consumed',
                   NULL,
                   run.id,
                   COALESCE(run.created_at, unixepoch()),
                   COALESCE(run.created_at, unixepoch()),
                   COALESCE(run.finished_at, run.updated_at, run.created_at, unixepoch()),
                   NULL,
                   COALESCE(run.started_at, run.created_at, unixepoch()),
                   NULL,
                   NULL
              FROM automation_runs run
             WHERE run.id NOT IN (SELECT run_id FROM _agentry_migration_valid_run_bindings)
                OR run.id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)`,
      args: [legacySnapshot],
    },
    {
      sql: `INSERT OR REPLACE INTO automation_trigger_receipts (
              id, project_id, automation_id, contract_revision, contract_etag,
              trigger_kind, trigger_key, case_id, case_revision, attempt,
              required_trust, source_trust, snapshot_json, snapshot_hash,
              status, claim_id, run_id, issued_at, not_before_at, expires_at,
              claimed_at, consumed_at, cancelled_at, cancel_reason
            )
            SELECT 'legacy-claim:' || claim.id,
                   claim.project_id,
                   claim.automation_id,
                   COALESCE(run.contract_revision, contract.revision, 0),
                   COALESCE(run.contract_etag, contract.etag, 'legacy-unbound'),
                   'unhandled_cases',
                   'legacy-rebound-claim:' || claim.id,
                   claim.case_id,
                   claim.case_revision,
                   claim.attempt,
                   'legacy_unbound',
                   'legacy_unbound',
                   ?,
                   'legacy-unbound:claim:' || claim.id,
                   'cancelled',
                   claim.id,
                   claim.run_id,
                   claim.acquired_at,
                   claim.acquired_at,
                   claim.expires_at,
                   claim.acquired_at,
                   CASE WHEN claim.run_id IS NULL THEN NULL ELSE claim.acquired_at END,
                   COALESCE(claim.released_at, unixepoch()),
                   COALESCE(NULLIF(claim.release_reason, ''), 'legacy_unbound_trigger')
              FROM case_claims claim
              LEFT JOIN automation_runs run ON run.id = claim.run_id
              LEFT JOIN automation_contracts contract ON contract.project_id = claim.project_id
             WHERE claim.id NOT IN (SELECT claim_id FROM _agentry_migration_valid_claim_bindings)
                OR claim.run_id IN (SELECT run_id FROM _agentry_migration_unsafe_orchestration_runs)`,
      args: [legacySnapshot],
    },
  ];
  await client.batch(repairStatements, "write");

  await assertNoNulls(client, "automation_runs", "trigger_receipt_id");
  await assertNoNulls(client, "automation_runs", "deadline_at");
  await assertNoNulls(client, "case_claims", "trigger_receipt_id");
  await assertUnique(client, "automation_runs", "trigger_receipt_id");
  await assertUnique(client, "case_claims", "trigger_receipt_id");

  const invalidRunBinding = await client.execute(`
    SELECT r.id
      FROM automation_runs r
      LEFT JOIN automation_trigger_receipts receipt ON receipt.id = r.trigger_receipt_id
     WHERE receipt.id IS NULL
        OR receipt.project_id IS NOT r.project_id
        OR receipt.automation_id IS NOT r.automation_id
        OR receipt.contract_revision IS NOT r.contract_revision
        OR receipt.contract_etag IS NOT r.contract_etag
        OR receipt.run_id IS NOT r.id
        OR receipt.status IS NOT 'consumed'
        OR NOT (
          (r.case_id IS NULL AND receipt.case_id IS NULL)
          OR (
            receipt.case_id IS r.case_id
            AND receipt.case_revision IS r.case_revision
            AND receipt.attempt IS r.attempt
          )
        )
     LIMIT 1
  `);
  if (invalidRunBinding.rows.length > 0) {
    throw new Error(
      `automation run ${String(invalidRunBinding.rows[0]?.id)} has an invalid trigger receipt binding; migration stopped`,
    );
  }
  const invalidActiveClaimBinding = await client.execute(`
    SELECT claim.id
      FROM case_claims claim
      LEFT JOIN automation_trigger_receipts receipt ON receipt.id = claim.trigger_receipt_id
     WHERE claim.released_at IS NULL
       AND (
         receipt.id IS NULL
         OR receipt.project_id IS NOT claim.project_id
         OR receipt.automation_id IS NOT claim.automation_id
         OR receipt.case_id IS NOT claim.case_id
         OR receipt.case_revision IS NOT claim.case_revision
         OR receipt.attempt IS NOT claim.attempt
         OR receipt.claim_id IS NOT claim.id
         OR NOT (
           (
             claim.run_id IS NULL
             AND receipt.run_id IS NULL
             AND receipt.status IS 'claimed'
             AND receipt.expires_at > unixepoch()
           )
           OR (
             claim.run_id IS NOT NULL
             AND receipt.run_id IS claim.run_id
             AND receipt.status IS 'consumed'
           )
         )
       )
     LIMIT 1
  `);
  if (invalidActiveClaimBinding.rows.length > 0) {
    throw new Error(
      `case claim ${String(invalidActiveClaimBinding.rows[0]?.id)} retained invalid trigger authority; migration stopped`,
    );
  }
  await client.batch([
    "DROP TABLE _agentry_migration_valid_run_bindings",
    "DROP TABLE _agentry_migration_valid_claim_bindings",
    "DROP TABLE _agentry_migration_unsafe_orchestration_runs",
  ], "write");

  // A deploy may be a trusted CI observation without being an automation
  // binding. Binding authority additionally requires the exact same-project
  // run, provider-proven source commit, run deploy SHA, and non-legacy CI
  // credential identities. Invalid historical bindings are cleared rather
  // than reinterpreted; the deploy remains visible as generic CI evidence.
  await client.execute(`
    UPDATE deploys
       SET automation_run_id = NULL,
           source_commit_sha = NULL
     WHERE (automation_run_id IS NULL) IS NOT (source_commit_sha IS NULL)
        OR (
          automation_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM automation_runs run
             WHERE run.id = deploys.automation_run_id
               AND run.project_id IS deploys.project_id
               AND run.commit_sha IS deploys.source_commit_sha
               AND run.deploy_sha IS deploys.sha
               AND run.pr_proof_hash IS NOT NULL
               AND trim(run.pr_proof_hash) <> ''
               AND run.pr_proof_credential_id IS NOT NULL
               AND deploys.trust_level IS 'trusted_ci'
               AND deploys.credential_kind IS 'ci_deploy'
               AND deploys.credential_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM project_credentials deploy_credential
                  WHERE deploy_credential.id = deploys.credential_id
                    AND deploy_credential.project_id = deploys.project_id
                    AND deploy_credential.kind = 'ci_deploy'
                    AND deploy_credential.token_hash NOT LIKE 'legacy-disabled:%'
               )
               AND EXISTS (
                 SELECT 1 FROM project_credentials proof_credential
                  WHERE proof_credential.id = run.pr_proof_credential_id
                    AND proof_credential.project_id = run.project_id
                    AND proof_credential.kind = 'ci_deploy'
                    AND proof_credential.token_hash NOT LIKE 'legacy-disabled:%'
               )
          )
        )
  `);
  await replaceTrigger(client, "deploys_automation_binding_insert_guard", `
    CREATE TRIGGER deploys_automation_binding_insert_guard
    BEFORE INSERT ON deploys
    WHEN (NEW.automation_run_id IS NULL) IS NOT (NEW.source_commit_sha IS NULL)
      OR (
        NEW.automation_run_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM automation_runs run
           WHERE run.id = NEW.automation_run_id
             AND run.project_id IS NEW.project_id
             AND run.commit_sha IS NEW.source_commit_sha
             AND run.deploy_sha IS NEW.sha
             AND run.pr_proof_hash IS NOT NULL
             AND trim(run.pr_proof_hash) <> ''
             AND run.pr_proof_credential_id IS NOT NULL
             AND NEW.trust_level IS 'trusted_ci'
             AND NEW.credential_kind IS 'ci_deploy'
             AND NEW.credential_id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM project_credentials deploy_credential
                WHERE deploy_credential.id = NEW.credential_id
                  AND deploy_credential.project_id = NEW.project_id
                  AND deploy_credential.kind = 'ci_deploy'
                  AND deploy_credential.token_hash NOT LIKE 'legacy-disabled:%'
             )
             AND EXISTS (
               SELECT 1 FROM project_credentials proof_credential
                WHERE proof_credential.id = run.pr_proof_credential_id
                  AND proof_credential.project_id = run.project_id
                  AND proof_credential.kind = 'ci_deploy'
                  AND proof_credential.token_hash NOT LIKE 'legacy-disabled:%'
             )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'deploy automation binding must match exact trusted CI run proof');
    END
  `);
  await replaceTrigger(client, "deploys_automation_binding_update_guard", `
    CREATE TRIGGER deploys_automation_binding_update_guard
    BEFORE UPDATE OF automation_run_id, source_commit_sha ON deploys
    WHEN NOT (
      NEW.automation_run_id IS OLD.automation_run_id
      AND NEW.source_commit_sha IS OLD.source_commit_sha
    ) AND NOT (
      NEW.automation_run_id IS NULL
      AND NEW.source_commit_sha IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'deploy automation binding is immutable');
    END
  `);
  await replaceTrigger(client, "automation_runs_deploy_binding_update_guard", `
    CREATE TRIGGER automation_runs_deploy_binding_update_guard
    BEFORE UPDATE OF project_id, commit_sha, deploy_sha, pr_proof_hash, pr_proof_credential_id ON automation_runs
    WHEN EXISTS (
      SELECT 1 FROM deploys deploy
       WHERE deploy.automation_run_id = OLD.id
    ) AND (
      NEW.project_id IS NOT OLD.project_id
      OR NEW.commit_sha IS NOT OLD.commit_sha
      OR NEW.deploy_sha IS NOT OLD.deploy_sha
      OR NEW.pr_proof_hash IS NOT OLD.pr_proof_hash
      OR NEW.pr_proof_credential_id IS NOT OLD.pr_proof_credential_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'automation run deploy proof is immutable after binding');
    END
  `);
  await replaceTrigger(client, "automation_runs_deploy_binding_delete_cleanup", `
    CREATE TRIGGER automation_runs_deploy_binding_delete_cleanup
    BEFORE DELETE ON automation_runs
    BEGIN
      UPDATE deploys
         SET automation_run_id = NULL,
             source_commit_sha = NULL
       WHERE automation_run_id = OLD.id;
    END
  `);

  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_trigger_states_due_idx ON automation_trigger_states (trigger_kind, cooldown_until, updated_at)",
  );
  await replaceIndex(
    client,
    "automation_trigger_receipts_key_idx",
    "CREATE UNIQUE INDEX automation_trigger_receipts_key_idx ON automation_trigger_receipts (project_id, automation_id, trigger_key)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_trigger_receipts_ready_idx ON automation_trigger_receipts (project_id, automation_id, status, expires_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_trigger_receipts_case_idx ON automation_trigger_receipts (case_id, case_revision, attempt)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_trigger_receipts_run_idx ON automation_trigger_receipts (run_id)",
  );
  await replaceIndex(
    client,
    "automation_budget_charges_run_kind_idx",
    "CREATE UNIQUE INDEX automation_budget_charges_run_kind_idx ON automation_budget_charges (run_id, kind)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_budget_charges_window_idx ON automation_budget_charges (project_id, automation_id, kind, created_at)",
  );
  await replaceIndex(
    client,
    "automation_action_grants_run_action_idx",
    "CREATE UNIQUE INDEX automation_action_grants_run_action_idx ON automation_action_grants (run_id, action)",
  );
  await replaceIndex(
    client,
    "automation_action_grants_idempotency_idx",
    "CREATE UNIQUE INDEX automation_action_grants_idempotency_idx ON automation_action_grants (project_id, idempotency_key_hash)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_action_grants_status_idx ON automation_action_grants (project_id, status, expires_at)",
  );
  await replaceIndex(
    client,
    "automation_run_report_sources_run_idx",
    "CREATE UNIQUE INDEX automation_run_report_sources_run_idx ON automation_run_report_sources (run_id)",
  );
  await replaceIndex(
    client,
    "automation_run_report_sources_idempotency_idx",
    "CREATE UNIQUE INDEX automation_run_report_sources_idempotency_idx ON automation_run_report_sources (project_id, idempotency_key_hash)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_run_report_sources_project_time_idx ON automation_run_report_sources (project_id, created_at)",
  );
  await replaceIndex(
    client,
    "automation_runs_trigger_receipt_idx",
    "CREATE UNIQUE INDEX automation_runs_trigger_receipt_idx ON automation_runs (trigger_receipt_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS automation_runs_deadline_idx ON automation_runs (status, deadline_at)",
  );
  await replaceIndex(
    client,
    "case_claims_trigger_receipt_idx",
    "CREATE UNIQUE INDEX case_claims_trigger_receipt_idx ON case_claims (trigger_receipt_id)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS deploys_automation_run_idx ON deploys (automation_run_id, received_at)",
  );

  // Physical NOT NULL cannot be added in-place on populated SQLite tables;
  // these guards make the migrated table behavior match the canonical schema.
  await replaceTrigger(client, "automation_runs_orchestration_fields_insert", `
    CREATE TRIGGER automation_runs_orchestration_fields_insert
    BEFORE INSERT ON automation_runs
    WHEN NEW.trigger_receipt_id IS NULL OR trim(NEW.trigger_receipt_id) = '' OR NEW.deadline_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'automation_runs requires trigger_receipt_id and deadline_at');
    END
  `);
  await replaceTrigger(client, "automation_runs_orchestration_fields_update", `
    CREATE TRIGGER automation_runs_orchestration_fields_update
    BEFORE UPDATE OF trigger_receipt_id, deadline_at ON automation_runs
    WHEN NEW.trigger_receipt_id IS NULL OR trim(NEW.trigger_receipt_id) = '' OR NEW.deadline_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'automation_runs requires trigger_receipt_id and deadline_at');
    END
  `);
  await replaceTrigger(client, "case_claims_trigger_receipt_insert", `
    CREATE TRIGGER case_claims_trigger_receipt_insert
    BEFORE INSERT ON case_claims
    WHEN NEW.trigger_receipt_id IS NULL OR trim(NEW.trigger_receipt_id) = ''
    BEGIN
      SELECT RAISE(ABORT, 'case_claims requires trigger_receipt_id');
    END
  `);
  await replaceTrigger(client, "case_claims_trigger_receipt_update", `
    CREATE TRIGGER case_claims_trigger_receipt_update
    BEFORE UPDATE OF trigger_receipt_id ON case_claims
    WHEN NEW.trigger_receipt_id IS NULL OR trim(NEW.trigger_receipt_id) = ''
    BEGIN
      SELECT RAISE(ABORT, 'case_claims requires trigger_receipt_id');
    END
  `);

  console.log("automation orchestration schema and legacy fail-closed backfill are ready.");
}

main().catch((error) => {
  console.error("migration failed:", error);
  process.exit(1);
});
