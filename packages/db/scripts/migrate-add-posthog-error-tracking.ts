import { createClient } from "@libsql/client";
import { POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS } from "./schema-extensions/20260715_01_posthog_error_tracking.mjs";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    const columns = await client.execute("PRAGMA table_info(cases)");
    const existing = new Set(columns.rows.map((row) => String(row.name)));
    const additiveColumns = POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS.slice(0, 5);
    const columnNames = [
      "provider_issue_id",
      "provider_snapshot_hash",
      "provider_projected_at",
      "last_provider_event_id",
      "last_environment",
    ];
    for (let index = 0; index < additiveColumns.length; index += 1) {
      if (!existing.has(columnNames[index]!)) {
        await client.execute(additiveColumns[index]!);
      }
    }
    for (const statement of POSTHOG_ERROR_TRACKING_SCHEMA_STATEMENTS.slice(5)) {
      await client.execute(statement.replace(/^CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ")
        .replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS "));
    }
    console.log(JSON.stringify({
      migration: "posthog_error_tracking",
      provider: "posthog",
      local_authority: "bounded_read_projection_only",
    }));
  } finally {
    client.close();
  }
}

await main();
