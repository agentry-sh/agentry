import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createClient } from "@libsql/client";

import { CORE_MIGRATIONS } from "./core-migration-manifest.mjs";
import { CORE_DB_PACKAGE_ROOT } from "./core-schema-baseline.mjs";

const databaseUrl = process.env.AGENTRY_CANONICAL_SOURCE_DATABASE_URL;
if (!databaseUrl || !databaseUrl.startsWith("file:")) {
  throw new Error("AGENTRY_CANONICAL_SOURCE_DATABASE_URL must be a local file: database URL");
}

const client = createClient({ url: databaseUrl });
try {
  const ledger = await client.execute(
    "SELECT COUNT(*) AS count FROM _agentry_core_migrations",
  );
  if (Number(ledger.rows[0]?.count ?? 0) !== CORE_MIGRATIONS.length) {
    throw new Error("canonical source database does not have the complete core migration ledger");
  }
  const forbidden = await client.execute(
    `SELECT type, name FROM sqlite_master
      WHERE name IN (
        'agent_runs', 'events', 'project_secrets', 'project_posthog_bindings',
        'posthog_error_capture_commands', 'posthog_provision_targets',
        'usage_counters', 'usage_snapshots', 'suppression_entries',
        'sourcemap_cleanup_outcomes', 'sourcemaps', 'sourcemap_objects',
        'sourcemap_release_states', 'sourcemap_commands',
        'projects_dsn_hash_idx'
      )`,
  );
  if (forbidden.rows.length > 0) {
    throw new Error(
      `canonical source database still contains ${forbidden.rows.length} retired object(s)`,
    );
  }

  const schema = await client.execute(
    `SELECT type, name, sql
       FROM sqlite_master
      WHERE sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_agentry_core_%'
        AND type IN ('table', 'index')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rootpage, name`,
  );
  const baselineSource = [
    "-- Canonical read-only PostHog control-plane bootstrap.",
    "-- Generated from a fully migrated local release database; runtime security",
    "-- triggers are emitted separately in core-bootstrap-triggers.mjs.",
    "",
    ...schema.rows.map((row) => `${String(row.sql).trim()};--> statement-breakpoint`),
    "",
  ].join("\n");
  await writeFile(
    join(CORE_DB_PACKAGE_ROOT, "drizzle/0000_core_baseline.sql"),
    baselineSource,
    "utf8",
  );

  const triggers = await client.execute(
    `SELECT name, sql
       FROM sqlite_master
      WHERE type = 'trigger' AND sql IS NOT NULL
      ORDER BY name`,
  );
  const triggerSource = [
    "// Canonical runtime security triggers for the read-only PostHog control plane.",
    "// Generated from a fully migrated local release database.",
    "",
    "export const CORE_BOOTSTRAP_TRIGGER_STATEMENTS = Object.freeze([",
    ...triggers.rows.map((row) => `  ${JSON.stringify(String(row.sql).trim())},`),
    "]);",
    "",
  ].join("\n");
  await writeFile(
    join(CORE_DB_PACKAGE_ROOT, "scripts/core-bootstrap-triggers.mjs"),
    triggerSource,
    "utf8",
  );

  console.log(JSON.stringify({
    tables_and_indexes: schema.rows.length,
    security_triggers: triggers.rows.length,
  }));
} finally {
  client.close();
}
