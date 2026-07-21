import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";

import { CORE_BOOTSTRAP_TRIGGER_STATEMENTS } from "./core-bootstrap-triggers.mjs";
import { CORE_METADATA_SQL } from "./core-migration-metadata.mjs";
import { loadCoreBaseline } from "./core-schema-baseline.mjs";

async function schemaObjects(client) {
  const result = await client.execute(
    `SELECT type, name
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND type IN ('table', 'view', 'trigger', 'index')
      ORDER BY type, name`,
  );
  return result.rows.map((row) => ({ type: String(row.type), name: String(row.name) }));
}

export async function bootstrapEmptyCoreDatabase({
  databaseUrl = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
} = {}) {
  if (!databaseUrl) throw new Error("TURSO_DATABASE_URL not set");
  const baseline = await loadCoreBaseline();
  const client = createClient({ url: databaseUrl, authToken });
  try {
    const existing = await schemaObjects(client);
    if (existing.length > 0) {
      const sample = existing.slice(0, 5).map((entry) => `${entry.type}:${entry.name}`).join(", ");
      throw new Error(
        `empty bootstrap refused a nonempty database (${sample}); ` +
        "existing databases require the reviewed legacy migration flow",
      );
    }

    await client.batch([
      ...baseline.statements,
      ...CORE_METADATA_SQL,
      ...CORE_BOOTSTRAP_TRIGGER_STATEMENTS,
      {
        sql: `INSERT INTO _agentry_core_baseline (
                singleton, kind, baseline_sql_checksum, review_ref
              ) VALUES (1, 'empty_bootstrap', ?, NULL)`,
        args: [baseline.checksum],
      },
    ], "write");

    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length > 0) {
      throw new Error(`empty bootstrap created ${foreignKeys.rows.length} foreign-key violations`);
    }
    const marker = await client.execute(
      "SELECT baseline_sql_checksum FROM _agentry_core_baseline WHERE singleton = 1 AND kind = 'empty_bootstrap'",
    );
    if (marker.rows.length !== 1 || String(marker.rows[0].baseline_sql_checksum) !== baseline.checksum) {
      throw new Error("empty bootstrap marker verification failed");
    }
    const triggerCount = await client.execute(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'",
    );
    if (Number(triggerCount.rows[0]?.count ?? 0) !== CORE_BOOTSTRAP_TRIGGER_STATEMENTS.length) {
      throw new Error("empty bootstrap runtime trigger verification failed");
    }
    console.log(
      `empty core database bootstrapped from ${baseline.path}; run db:migrate:core before starting the API`,
    );
    return { checksum: baseline.checksum };
  } finally {
    client.close();
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error(`unknown argument: ${process.argv[2]}`);
  await bootstrapEmptyCoreDatabase();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error("empty core database bootstrap failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { schemaObjects };
