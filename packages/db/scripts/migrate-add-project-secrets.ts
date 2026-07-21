// Additive, idempotent migration: project_secrets.
//
// Stores recoverable project runtime secrets encrypted with AGENTRY_TOKEN_ENC_KEY.
// Existing hash-only DSNs remain valid, but raw DSN recovery is unavailable until
// an owner verifies the current DSN or explicitly rotates it.
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-project-secrets.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id text NOT NULL,
      kind text NOT NULL,
      secret_enc text NOT NULL,
      secret_iv text NOT NULL,
      created_at integer DEFAULT (unixepoch()) NOT NULL,
      updated_at integer DEFAULT (unixepoch()) NOT NULL,
      PRIMARY KEY (project_id, kind),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE cascade
    )
  `);
  console.log("ensured project_secrets table.");

  await client.execute(
    "CREATE INDEX IF NOT EXISTS project_secrets_project_idx ON project_secrets (project_id)",
  );
  console.log("ensured project_secrets_project_idx.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
