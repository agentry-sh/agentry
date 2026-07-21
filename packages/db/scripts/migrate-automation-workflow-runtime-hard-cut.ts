// Forward-only hard cut from the immutable 20260713 workflow runtime.
//
// There are no customer workflow executions to preserve during this beta
// migration. The preceding read-only hard cut pauses every workflow and
// revokes every automation runner, so the safest exact-schema convergence is
// to rebuild the replaceable workflow runtime while the API is fenced for
// maintenance.

import { createClient, type Client } from "@libsql/client";

import {
  AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS,
  AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS,
} from "./schema-extensions/20260721_01_automation_workflow_runtime_hard_cut.mjs";

const WORKFLOW_TABLES_CHILD_FIRST = Object.freeze([
  "automation_workflow_budget_charges",
  "automation_workflow_effect_events",
  "automation_workflow_effects",
  "automation_workflow_suspensions",
  "automation_workflow_commands",
  "automation_workflow_run_events",
  "automation_workflow_run_states",
  "automation_workflow_run_leases",
  "automation_workflow_system_node_claims",
  "automation_workflow_runs",
  "automation_workflow_trigger_receipts",
  "automation_workflows",
  "automation_workflow_execution_authorities",
  "automation_workflow_revisions",
  "automation_workflow_project_controls",
]);

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function dropWorkflowTriggers(client: Client) {
  const result = await client.execute(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'trigger'
       AND (
         name LIKE 'automation_workflow_%'
         OR sql LIKE '%automation_workflow_%'
       )
     ORDER BY name
  `);
  for (const row of result.rows) {
    await client.execute(`DROP TRIGGER IF EXISTS ${quoteIdentifier(String(row.name))}`);
  }
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    await client.execute("PRAGMA foreign_keys = OFF");
    await dropWorkflowTriggers(client);
    for (const table of WORKFLOW_TABLES_CHILD_FIRST) {
      await client.execute(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    }
    await client.batch([...AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_STATEMENTS], "write");
    await client.batch([...AUTOMATION_WORKFLOW_RUNTIME_SECURITY_STATEMENTS], "write");
    await client.execute("PRAGMA foreign_keys = ON");

    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length > 0) {
      throw new Error(
        `workflow runtime hard cut left ${foreignKeys.rows.length} foreign-key violation(s)`,
      );
    }

    console.log(JSON.stringify({
      migration: "automation_workflow_runtime_hard_cut",
      rebuilt_tables: WORKFLOW_TABLES_CHILD_FIRST.length,
      authority: "paused_and_revoked_by_read_only_hard_cut",
    }));
  } finally {
    client.close();
  }
}

await main();
