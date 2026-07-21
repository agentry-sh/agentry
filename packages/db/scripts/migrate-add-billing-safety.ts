// Forward-only, idempotent billing safety migration.
// Requires the canonical mutation_commands migration to have run first.

import { createClient, type Client } from "@libsql/client";

const TABLES: Record<string, { columns: string[]; create: string }> = {
  account_deletion_fences: {
    columns: ["user_id", "command_id", "created_at"],
    create: `CREATE TABLE account_deletion_fences (
      user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      command_id text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
  },
  billing_mutation_targets: {
    columns: [
      "command_id", "user_id", "operation", "target_hash", "target_json",
      "stripe_customer_idempotency_key", "stripe_session_idempotency_key", "created_at",
    ],
    create: `CREATE TABLE billing_mutation_targets (
      command_id text PRIMARY KEY REFERENCES mutation_commands(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation text NOT NULL CHECK (operation IN ('checkout','portal')),
      target_hash text NOT NULL,
      target_json text NOT NULL,
      stripe_customer_idempotency_key text,
      stripe_session_idempotency_key text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
  },
  billing_mutation_secrets: {
    columns: ["command_id", "response_enc", "response_iv", "created_at"],
    create: `CREATE TABLE billing_mutation_secrets (
      command_id text PRIMARY KEY REFERENCES mutation_commands(id) ON DELETE CASCADE,
      response_enc text NOT NULL,
      response_iv text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
  },
  billing_webhook_events: {
    columns: [
      "event_id", "payload_hash", "event_type", "provider_created", "object_id",
      "subscription_id", "user_id", "status", "billing_status", "stripe_customer_id",
      "stripe_subscription_id", "stripe_price_id", "billing_current_period_end",
      "billing_cancel_at_period_end", "result_json", "processed_at",
    ],
    create: `CREATE TABLE billing_webhook_events (
      event_id text PRIMARY KEY,
      payload_hash text NOT NULL,
      event_type text NOT NULL,
      provider_created integer NOT NULL,
      object_id text,
      subscription_id text,
      user_id text,
      status text NOT NULL CHECK (status IN (
        'applied','stale','ambiguous_order','account_deletion_fenced','unmatched','unhandled'
      )),
      billing_status text,
      stripe_customer_id text,
      stripe_subscription_id text,
      stripe_price_id text,
      billing_current_period_end integer,
      billing_cancel_at_period_end integer,
      result_json text NOT NULL DEFAULT '{}',
      processed_at integer NOT NULL DEFAULT (unixepoch())
    )`,
  },
  billing_subscription_cursors: {
    columns: ["subscription_id", "user_id", "last_event_created", "last_event_id", "updated_at"],
    create: `CREATE TABLE billing_subscription_cursors (
      subscription_id text PRIMARY KEY,
      user_id text,
      last_event_created integer NOT NULL,
      last_event_id text NOT NULL,
      updated_at integer NOT NULL DEFAULT (unixepoch())
    )`,
  },
};

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS billing_mutation_targets_user_time_idx
    ON billing_mutation_targets (user_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS billing_mutation_targets_customer_key_idx
    ON billing_mutation_targets (stripe_customer_idempotency_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS billing_mutation_targets_session_key_idx
    ON billing_mutation_targets (stripe_session_idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS billing_webhook_events_user_time_idx
    ON billing_webhook_events (user_id, provider_created)`,
  `CREATE INDEX IF NOT EXISTS billing_webhook_events_subscription_time_idx
    ON billing_webhook_events (subscription_id, provider_created)`,
  `CREATE INDEX IF NOT EXISTS billing_subscription_cursors_user_idx
    ON billing_subscription_cursors (user_id, updated_at)`,
];

const TRIGGERS = [
  ["account_deletion_fences_immutable_update_guard", `
    CREATE TRIGGER account_deletion_fences_immutable_update_guard
    BEFORE UPDATE ON account_deletion_fences
    BEGIN
      SELECT RAISE(ABORT, 'account deletion fence is immutable');
    END`],
  ["billing_mutation_targets_immutable_update_guard", `
    CREATE TRIGGER billing_mutation_targets_immutable_update_guard
    BEFORE UPDATE ON billing_mutation_targets
    BEGIN
      SELECT RAISE(ABORT, 'billing mutation target is immutable');
    END`],
  ["billing_mutation_targets_insert_guard", `
    CREATE TRIGGER billing_mutation_targets_insert_guard
    BEFORE INSERT ON billing_mutation_targets
    BEGIN
      SELECT RAISE(ABORT, 'invalid billing mutation target')
       WHERE NEW.operation NOT IN ('checkout','portal')
          OR length(NEW.target_hash) <> 64
          OR length(NEW.target_json) = 0
          OR length(NEW.target_json) > 8192
          OR length(NEW.stripe_session_idempotency_key) < 8
          OR length(NEW.stripe_session_idempotency_key) > 255
          OR (NEW.operation = 'checkout' AND (
            NEW.stripe_customer_idempotency_key IS NULL
            OR length(NEW.stripe_customer_idempotency_key) < 8
            OR length(NEW.stripe_customer_idempotency_key) > 255
          ))
          OR (NEW.operation = 'portal' AND NEW.stripe_customer_idempotency_key IS NOT NULL);
    END`],
  ["billing_mutation_secrets_immutable_update_guard", `
    CREATE TRIGGER billing_mutation_secrets_immutable_update_guard
    BEFORE UPDATE ON billing_mutation_secrets
    BEGIN
      SELECT RAISE(ABORT, 'billing encrypted response is immutable');
    END`],
  ["billing_mutation_secrets_insert_guard", `
    CREATE TRIGGER billing_mutation_secrets_insert_guard
    BEFORE INSERT ON billing_mutation_secrets
    BEGIN
      SELECT RAISE(ABORT, 'invalid encrypted billing response')
       WHERE length(NEW.response_enc) = 0 OR length(NEW.response_enc) > 16384
          OR length(NEW.response_iv) = 0 OR length(NEW.response_iv) > 256;
    END`],
  ["billing_webhook_events_immutable_update_guard", `
    CREATE TRIGGER billing_webhook_events_immutable_update_guard
    BEFORE UPDATE ON billing_webhook_events
    BEGIN
      SELECT RAISE(ABORT, 'billing webhook receipt is immutable');
    END`],
  ["billing_webhook_events_insert_guard", `
    CREATE TRIGGER billing_webhook_events_insert_guard
    BEFORE INSERT ON billing_webhook_events
    BEGIN
      SELECT RAISE(ABORT, 'invalid billing webhook receipt')
       WHERE length(NEW.event_id) = 0 OR length(NEW.event_id) > 255
          OR length(NEW.payload_hash) <> 64
          OR length(NEW.event_type) = 0 OR length(NEW.event_type) > 255
          OR typeof(NEW.provider_created) <> 'integer' OR NEW.provider_created < 0
          OR NEW.status NOT IN ('applied','stale','ambiguous_order','account_deletion_fenced','unmatched','unhandled')
          OR length(NEW.result_json) > 8192;
    END`],
  ["billing_subscription_cursors_update_guard", `
    CREATE TRIGGER billing_subscription_cursors_update_guard
    BEFORE UPDATE ON billing_subscription_cursors
    BEGIN
      SELECT RAISE(ABORT, 'billing subscription cursor identity is immutable')
       WHERE NEW.subscription_id IS NOT OLD.subscription_id;
      SELECT RAISE(ABORT, 'billing subscription cursor cannot move backward')
       WHERE NEW.last_event_created < OLD.last_event_created
          OR (
            NEW.last_event_created = OLD.last_event_created
            AND NEW.last_event_id IS NOT OLD.last_event_id
          );
    END`],
] as const;

async function tableExists(client: Client, table: string): Promise<boolean> {
  const row = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
    args: [table],
  });
  return row.rows.length === 1;
}

async function assertCanonicalColumns(client: Client, table: string, expected: string[]): Promise<void> {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const actual = info.rows.map((row) => String(row.name));
  const missing = expected.filter((column) => !actual.includes(column));
  const unexpected = actual.filter((column) => !expected.includes(column));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Refusing billing migration with ${table} schema drift; ` +
        `missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`,
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    if (!await tableExists(client, "users") || !await tableExists(client, "mutation_commands")) {
      throw new Error("billing safety migration requires canonical users and mutation_commands tables");
    }
    for (const [table, definition] of Object.entries(TABLES)) {
      if (!await tableExists(client, table)) await client.execute(definition.create);
      await assertCanonicalColumns(client, table, definition.columns);
    }
    for (const statement of INDEXES) await client.execute(statement);
    for (const [name, statement] of TRIGGERS) {
      await client.execute(`DROP TRIGGER IF EXISTS ${name}`);
      await client.execute(statement);
    }
    console.log("billing safety migration complete");
  } finally {
    client.close();
  }
}

await main();
