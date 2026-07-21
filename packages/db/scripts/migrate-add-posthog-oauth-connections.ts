import { createClient } from "@libsql/client";
import { POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS } from "./schema-extensions/20260715_02_posthog_oauth_connections.mjs";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    const attemptColumns = await client.execute("PRAGMA table_info(posthog_oauth_attempts)");
    const connectionColumns = await client.execute("PRAGMA table_info(posthog_connections)");
    const canonicalAttempt = attemptColumns.rows.length === 0 || (
      attemptColumns.rows.some((row) => String(row.name) === "mode") &&
      [
        "handoff_redirect_uri",
        "handoff_challenge",
        "handoff_code_hash",
        "handoff_expires_at",
        "handoff_failure_count",
      ].every(
        (name) => attemptColumns.rows.some((row) => String(row.name) === name),
      )
    );
    const canonicalConnection = connectionColumns.rows.length === 0 ||
      connectionColumns.rows.some((row) => String(row.name) === "refresh_lease_token");
    if (!canonicalAttempt || !canonicalConnection) {
      // There are no customer grants to preserve. Pending legacy callbacks
      // cannot prove PostHog OIDC identity or nonce binding, so the safe hard
      // cut is to discard them and require a fresh one-browser authorization.
      if (attemptColumns.rows.length > 0) {
        await client.execute("DROP TABLE posthog_oauth_attempts");
      }
      if (!canonicalConnection && connectionColumns.rows.length > 0) {
        await client.execute("DROP TABLE posthog_connections");
      }
    }
    for (const statement of POSTHOG_OAUTH_CONNECTION_SCHEMA_STATEMENTS) {
      await client.execute(
        statement
          .replace(/^CREATE UNIQUE INDEX /, "CREATE UNIQUE INDEX IF NOT EXISTS ")
          .replace(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS ")
          .replace(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS "),
      );
    }
    console.log(JSON.stringify({
      migration: "posthog_oauth_connections",
      provider: "posthog_cloud",
      external_ownership: "customer_owned",
      external_deletion_policy: "detach_only",
    }));
  } finally {
    client.close();
  }
}

await main();
