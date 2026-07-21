// Immutable project-bound install-plan revisions and derived-artifact provenance.

import { createClient, type Client } from "@libsql/client";

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function addColumnIfMissing(
  client: Client,
  table: string,
  column: string,
  definition: string,
) {
  if ((await tableColumns(client, table)).has(column)) return;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });
  try {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS project_install_plans (
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
      `CREATE UNIQUE INDEX IF NOT EXISTS project_install_plans_project_revision_idx
        ON project_install_plans (project_id, revision)`,
      `CREATE INDEX IF NOT EXISTS project_install_plans_project_created_idx
        ON project_install_plans (project_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS project_install_plans_project_contract_idx
        ON project_install_plans (project_id, contract_sha256)`,
      `CREATE TABLE IF NOT EXISTS project_install_plan_approvals (
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
      `CREATE INDEX IF NOT EXISTS project_install_plan_approvals_project_time_idx
        ON project_install_plan_approvals (project_id, attested_at)`,
      `CREATE INDEX IF NOT EXISTS project_install_plan_approvals_approver_time_idx
        ON project_install_plan_approvals (attested_by, attested_at)`,
    ], "write");

    for (const [column, definition] of [
      ["plan_id", "text REFERENCES project_install_plans(id) ON DELETE RESTRICT"],
      ["plan_revision", "integer"],
      ["signal_map_etag", "text"],
      ["repo_snapshot_json", "text"],
      ["approval_kind", "text"],
      ["approved_by", "text REFERENCES users(id) ON DELETE RESTRICT"],
    ] as const) {
      await addColumnIfMissing(client, "project_signal_maps", column, definition);
    }
    for (const [column, definition] of [
      ["plan_id", "text REFERENCES project_install_plans(id) ON DELETE CASCADE"],
      ["source_etag", "text"],
      ["artifact_etag", "text"],
    ] as const) {
      await addColumnIfMissing(client, "project_artifacts", column, definition);
    }

    console.log(JSON.stringify({
      migration: "install_plan_revisions",
      tables: ["project_install_plans", "project_install_plan_approvals"],
      signal_map_provenance_columns: 6,
      artifact_provenance_columns: 3,
    }));
  } finally {
    client.close();
  }
}

await main();
