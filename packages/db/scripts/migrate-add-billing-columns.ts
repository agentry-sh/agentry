// Additive, idempotent migration:
//   users.stripe_customer_id
//   users.stripe_subscription_id
//   users.stripe_price_id
//   users.billing_status
//   users.billing_current_period_end
//   users.billing_cancel_at_period_end
//
// Run with:
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node packages/db/scripts/migrate-add-billing-columns.ts

import { createClient } from "@libsql/client";

const COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "stripe_customer_id", ddl: "ALTER TABLE users ADD COLUMN stripe_customer_id text" },
  { name: "stripe_subscription_id", ddl: "ALTER TABLE users ADD COLUMN stripe_subscription_id text" },
  { name: "stripe_price_id", ddl: "ALTER TABLE users ADD COLUMN stripe_price_id text" },
  { name: "billing_status", ddl: "ALTER TABLE users ADD COLUMN billing_status text NOT NULL DEFAULT 'none'" },
  { name: "billing_current_period_end", ddl: "ALTER TABLE users ADD COLUMN billing_current_period_end integer" },
  { name: "billing_cancel_at_period_end", ddl: "ALTER TABLE users ADD COLUMN billing_cancel_at_period_end integer NOT NULL DEFAULT 0" },
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  const info = await client.execute("PRAGMA table_info(users)");
  const existing = new Set(info.rows.map((r) => (r as { name: string }).name));

  for (const column of COLUMNS) {
    if (existing.has(column.name)) {
      console.log(`users.${column.name} already exists - skipping.`);
      continue;
    }
    await client.execute(column.ddl);
    console.log(`added users.${column.name}.`);
  }

  const finalInfo = await client.execute("PRAGMA table_info(users)");
  console.log(
    "users columns:",
    finalInfo.rows.map((r) => (r as { name: string }).name).join(", "),
  );
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
