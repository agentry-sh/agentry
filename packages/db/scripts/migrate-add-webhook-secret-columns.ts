// Additive, idempotent migration: webhook signing-secret storage and event
// retention lookup index.
//
// New webhook rows store the secret hash, encrypted secret, and IV in separate
// columns. Legacy rows without the encrypted columns remain listable, but cannot
// be used for signed delivery until the customer recreates the webhook.
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-webhook-secret-columns.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  const columns = await client.execute("PRAGMA table_info(webhooks)");
  const names = new Set(columns.rows.map((row) => row.name));

  if (!names.has("signing_secret_enc")) {
    await client.execute("ALTER TABLE webhooks ADD COLUMN signing_secret_enc text");
    console.log("added webhooks.signing_secret_enc column.");
  } else {
    console.log("webhooks.signing_secret_enc already exists - skipping column.");
  }

  if (!names.has("signing_secret_iv")) {
    await client.execute("ALTER TABLE webhooks ADD COLUMN signing_secret_iv text");
    console.log("added webhooks.signing_secret_iv column.");
  } else {
    console.log("webhooks.signing_secret_iv already exists - skipping column.");
  }

  await client.execute("CREATE INDEX IF NOT EXISTS events_proj_received_idx ON events (project_id, received_at)");
  console.log("ensured events_proj_received_idx exists.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
