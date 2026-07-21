// Rebuild audit_log as a durable append-only tombstone ledger.
//
// The legacy table cascaded actor deletion and rewrote project_id to NULL when
// a project was deleted. That made history mutable and allowed the very action
// being audited to erase its project identity. This migration preserves every
// row, detaches destructive foreign keys, materializes operation/phase fields,
// adds millisecond ordering, and installs append/retention guards.

import { createClient, type Client } from "@libsql/client";

async function tableExists(client: Client, table: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length > 0;
}

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function createIndexesAndGuards(client: Client): Promise<void> {
  await client.batch([
    "CREATE UNIQUE INDEX IF NOT EXISTS audit_operation_phase_idx ON audit_log (operation_id, phase)",
    "CREATE INDEX IF NOT EXISTS audit_user_time_idx ON audit_log (user_id, occurred_at_ms)",
    "CREATE INDEX IF NOT EXISTS audit_proj_time_idx ON audit_log (project_id, occurred_at_ms)",
    "CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (user_id, action, at)",
    `CREATE TRIGGER IF NOT EXISTS audit_log_no_update
       BEFORE UPDATE ON audit_log
       BEGIN
         SELECT RAISE(ABORT, 'audit_log rows are append-only');
       END`,
    `CREATE TRIGGER IF NOT EXISTS audit_log_retention_delete_only
       BEFORE DELETE ON audit_log
       WHEN OLD.at >= unixepoch() - 7776000
       BEGIN
         SELECT RAISE(ABORT, 'audit_log rows may only be deleted after 90 days');
       END`,
  ], "write");
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  if (!(await tableExists(client, "audit_log"))) {
    await client.execute(`CREATE TABLE audit_log (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      project_id text,
      operation_id text NOT NULL,
      request_hash text NOT NULL,
      phase text NOT NULL CHECK (phase IN ('intent','succeeded','failed','indeterminate')),
      action text NOT NULL,
      resource_type text NOT NULL,
      resource_id text,
      summary text,
      metadata_json text,
      ip text,
      ua text,
      at integer NOT NULL DEFAULT (unixepoch()),
      occurred_at_ms integer NOT NULL DEFAULT (unixepoch() * 1000)
    )`);
    await createIndexesAndGuards(client);
    console.log("created durable audit_log.");
    client.close();
    return;
  }

  const columns = await tableColumns(client, "audit_log");
  const foreignKeys = await client.execute("PRAGMA foreign_key_list(audit_log)");
  const canonicalColumns = [
    "operation_id",
    "request_hash",
    "phase",
    "occurred_at_ms",
  ];
  const needsRebuild = foreignKeys.rows.length > 0 ||
    canonicalColumns.some((column) => !columns.has(column));

  if (needsRebuild) {
    const operationExpression = columns.has("operation_id")
      ? "NULLIF(operation_id, '')"
      : "NULLIF(json_extract(metadata_json, '$.\"$agentry_audit\".operation_id'), '')";
    const requestHashExpression = columns.has("request_hash")
      ? "NULLIF(request_hash, '')"
      : "NULLIF(json_extract(metadata_json, '$.\"$agentry_audit\".request_hash'), '')";
    const phaseExpression = columns.has("phase")
      ? "phase"
      : "json_extract(metadata_json, '$.\"$agentry_audit\".phase')";
    const occurredAtMsExpression = columns.has("occurred_at_ms")
      ? "occurred_at_ms"
      : "at * 1000";

    await client.batch([
      "DROP TABLE IF EXISTS audit_log_durable_new",
      `CREATE TABLE audit_log_durable_new (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        project_id text,
        operation_id text NOT NULL,
        request_hash text NOT NULL,
        phase text NOT NULL CHECK (phase IN ('intent','succeeded','failed','indeterminate')),
        action text NOT NULL,
        resource_type text NOT NULL,
        resource_id text,
        summary text,
        metadata_json text,
        ip text,
        ua text,
        at integer NOT NULL,
        occurred_at_ms integer NOT NULL
      )`,
      `INSERT INTO audit_log_durable_new (
        id, user_id, project_id, operation_id, request_hash, phase, action,
        resource_type, resource_id, summary, metadata_json, ip, ua, at,
        occurred_at_ms
      )
      WITH normalized AS (
        SELECT
          id,
          user_id,
          project_id,
          COALESCE(${operationExpression}, 'legacy:' || id) AS base_operation_id,
          COALESCE(${requestHashExpression}, 'legacy:' || id) AS normalized_request_hash,
          CASE
            WHEN ${phaseExpression} IN ('intent','succeeded','failed','indeterminate')
              THEN ${phaseExpression}
            ELSE 'succeeded'
          END AS normalized_phase,
          action,
          resource_type,
          resource_id,
          summary,
          metadata_json,
          ip,
          ua,
          at,
          COALESCE(${occurredAtMsExpression}, at * 1000) AS normalized_occurred_at_ms,
          COUNT(*) OVER (
            PARTITION BY COALESCE(${operationExpression}, 'legacy:' || id),
              CASE
                WHEN ${phaseExpression} IN ('intent','succeeded','failed','indeterminate')
                  THEN ${phaseExpression}
                ELSE 'succeeded'
              END
          ) AS duplicate_count
        FROM audit_log
      )
      SELECT
        id,
        user_id,
        project_id,
        CASE
          WHEN duplicate_count > 1 THEN base_operation_id || ':legacy-duplicate:' || id
          ELSE base_operation_id
        END,
        normalized_request_hash,
        normalized_phase,
        action,
        resource_type,
        resource_id,
        summary,
        metadata_json,
        ip,
        ua,
        at,
        normalized_occurred_at_ms
      FROM normalized`,
      "DROP TABLE audit_log",
      "ALTER TABLE audit_log_durable_new RENAME TO audit_log",
    ], "write");
    console.log("rebuilt audit_log as a durable tombstone ledger.");
  }

  await createIndexesAndGuards(client);
  client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
