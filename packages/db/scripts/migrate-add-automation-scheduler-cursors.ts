// Durable continuation for bounded platform-owned automation sweeps.
//
// Product releases execute this additive, idempotent migration only through
// the ordered core migration manifest. The cursor intentionally has no project
// foreign key: deleting the project at a page boundary must not erase progress.

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    await client.execute(`CREATE TABLE IF NOT EXISTS automation_scheduler_cursors (
      sweep_name text PRIMARY KEY,
      cursor_project_id text,
      revision integer NOT NULL DEFAULT 0,
      updated_at integer NOT NULL DEFAULT (unixepoch()),
      CONSTRAINT automation_scheduler_cursors_revision_check CHECK (revision >= 0)
    )`);
    console.log(JSON.stringify({
      migration: "automation_scheduler_cursors",
      table: "automation_scheduler_cursors",
      continuation: "revision_guarded_project_keyset",
    }));
  } finally {
    client.close();
  }
}

await main();
