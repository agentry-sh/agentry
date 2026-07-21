// Additive, idempotent migration: feedback.fingerprint + dedupe index.
//
// Lets agent feedback over-fire safely by storing a stable per-issue key. The
// API dedupes unresolved rows by user_id + fingerprint.
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-feedback-fingerprint.ts

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });

  const columns = await client.execute("PRAGMA table_info(feedback)");
  const hasFingerprint = columns.rows.some((row) => row.name === "fingerprint");
  if (!hasFingerprint) {
    await client.execute("ALTER TABLE feedback ADD COLUMN fingerprint text");
    console.log("added feedback.fingerprint column.");
  } else {
    console.log("feedback.fingerprint already exists — skipping column.");
  }

  const indexes = await client.execute("PRAGMA index_list(feedback)");
  const hasIndex = indexes.rows.some((row) => row.name === "feedback_user_fingerprint_idx");
  if (!hasIndex) {
    await client.execute(
      "CREATE INDEX feedback_user_fingerprint_idx ON feedback (user_id, fingerprint, resolved, created_at)",
    );
    console.log("created feedback_user_fingerprint_idx.");
  } else {
    console.log("feedback_user_fingerprint_idx already exists — skipping index.");
  }
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
