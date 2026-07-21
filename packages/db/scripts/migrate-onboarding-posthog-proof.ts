import { createClient } from "@libsql/client";
import {
  ONBOARDING_POSTHOG_PROOF_SCHEMA_STATEMENTS,
} from "./schema-extensions/20260715_03_onboarding_posthog_proof.mjs";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    const columns = await client.execute(
      "PRAGMA table_info(onboarding_proof_sessions)",
    );
    const names = new Set(columns.rows.map((row) => String(row.name)));
    if (
      names.has("runtime_public_key_hash") ||
      names.has("runtime_server_credential_id")
    ) {
      for (const statement of ONBOARDING_POSTHOG_PROOF_SCHEMA_STATEMENTS) {
        await client.execute(statement);
      }
    }
    console.log(JSON.stringify({
      migration: "onboarding_posthog_proof",
      runtime_telemetry: "customer_posthog_direct",
      ci_deploy_binding: "retained",
    }));
  } finally {
    client.close();
  }
}

await main();
