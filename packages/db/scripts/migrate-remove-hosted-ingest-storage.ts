import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    const [tables, indexes, columns] = await Promise.all([
      client.execute(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'events',
            'posthog_error_capture_commands',
            'posthog_provision_targets',
            'project_posthog_bindings',
            'project_secrets',
            'usage_counters',
            'usage_snapshots',
            'suppression_entries',
            'sourcemap_cleanup_outcomes',
            'sourcemaps',
            'sourcemap_objects',
            'sourcemap_release_states',
            'sourcemap_commands',
            '_agentry_core_legacy_posthog_binding_quarantine',
            '_agentry_core_legacy_posthog_binding_quarantine_receipt'
          )`,
      ),
      client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_dsn_hash_idx'",
      ),
      client.execute("PRAGMA table_info(projects)"),
    ]);
    const projectColumns = new Set(columns.rows.map((row) => String(row.name)));

    const existingTables = new Set(tables.rows.map((row) => String(row.name)));
    for (const table of [
      "sourcemap_cleanup_outcomes",
      "sourcemaps",
      "sourcemap_objects",
      "sourcemap_release_states",
      "sourcemap_commands",
      "suppression_entries",
      "events",
      "posthog_error_capture_commands",
      "posthog_provision_targets",
      "project_posthog_bindings",
      "project_secrets",
      "usage_counters",
      "usage_snapshots",
      "_agentry_core_legacy_posthog_binding_quarantine",
      "_agentry_core_legacy_posthog_binding_quarantine_receipt",
    ]) {
      if (existingTables.has(table)) await client.execute(`DROP TABLE ${table}`);
    }
    if (indexes.rows.length > 0) {
      await client.execute("DROP INDEX projects_dsn_hash_idx");
    }
    if (projectColumns.has("dsn_prefix")) {
      await client.execute("ALTER TABLE projects DROP COLUMN dsn_prefix");
    }
    if (projectColumns.has("dsn_hash")) {
      await client.execute("ALTER TABLE projects DROP COLUMN dsn_hash");
    }

    console.log(JSON.stringify({
      migration: "hosted_ingest_storage_removal",
      removed: [
        "project_secrets",
        "project_posthog_bindings",
        "posthog_error_capture_commands",
        "posthog_provision_targets",
        "legacy_posthog_binding_quarantine",
        "events",
        "suppression_entries",
        "sourcemap_storage_and_commands",
        "usage_counters",
        "usage_snapshots",
        "projects.dsn_prefix",
        "projects.dsn_hash",
      ],
      runtime_telemetry: "customer_posthog_direct",
    }));
  } finally {
    client.close();
  }
}

await main();
