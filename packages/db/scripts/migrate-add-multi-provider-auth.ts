// Additive migration for multi-provider auth + team memberships.
// Idempotent — safe to re-run.
//
//   env $(grep -v '^#' apps/api/.dev.vars | xargs) node \
//     packages/db/scripts/migrate-add-multi-provider-auth.ts
//
// What it does:
//   1. Creates: identities, project_memberships, project_invites, device_codes
//   2. Makes users.github_id nullable (SQLite has no ALTER COLUMN — done via
//      table rebuild only if the current column is still NOT NULL).
//   3. Backfills identities from existing users.github_id (one per legacy user)
//   4. Backfills project_memberships from existing projects.userId (owner role)
//
// Safe to run before any code that depends on the new tables ships.

import { createClient, type Client } from "@libsql/client";

async function tableExists(client: Client, name: string): Promise<boolean> {
  const r = await client.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    args: [name],
  });
  return r.rows.length > 0;
}

async function isGithubIdNotNull(client: Client): Promise<boolean> {
  const info = await client.execute("PRAGMA table_info(users)");
  for (const row of info.rows) {
    // pragma_info columns: cid, name, type, notnull, dflt_value, pk
    if ((row as unknown as { name: string }).name === "github_id") {
      const notnull = (row as unknown as { notnull: number }).notnull;
      return notnull === 1;
    }
  }
  return false;
}

async function makeGithubIdNullable(client: Client) {
  // SQLite needs a table rebuild for NOT NULL → NULL. Done inside a transaction.
  console.log("rebuilding users table to make github_id nullable…");
  await client.batch(
    [
      "PRAGMA foreign_keys=OFF",
      `CREATE TABLE users_new (
        id text PRIMARY KEY NOT NULL,
        github_id integer,
        github_username text,
        email text,
        avatar_url text,
        plan text DEFAULT 'free' NOT NULL,
        created_at integer DEFAULT (unixepoch()) NOT NULL
      )`,
      `INSERT INTO users_new (id, github_id, github_username, email, avatar_url, plan, created_at)
         SELECT id, github_id, github_username, email, avatar_url, plan, created_at FROM users`,
      "DROP TABLE users",
      "ALTER TABLE users_new RENAME TO users",
      "CREATE UNIQUE INDEX users_github_id_idx ON users (github_id)",
      "CREATE INDEX users_email_idx ON users (email)",
      "PRAGMA foreign_keys=ON",
    ],
    "write",
  );
  console.log("users.github_id is now nullable.");
}

async function createIdentities(client: Client) {
  if (await tableExists(client, "identities")) {
    console.log("identities already exists — skipping create.");
    return;
  }
  await client.execute(`
    CREATE TABLE identities (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider text NOT NULL,
      provider_user_id text NOT NULL,
      email text,
      created_at integer DEFAULT (unixepoch()) NOT NULL
    )
  `);
  await client.execute(
    "CREATE UNIQUE INDEX identities_provider_idx ON identities (provider, provider_user_id)",
  );
  await client.execute("CREATE INDEX identities_user_idx ON identities (user_id)");
  console.log("created identities table + indexes.");
}

async function createProjectMemberships(client: Client) {
  if (await tableExists(client, "project_memberships")) {
    console.log("project_memberships already exists — skipping create.");
    return;
  }
  await client.execute(`
    CREATE TABLE project_memberships (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text DEFAULT 'member' NOT NULL,
      invited_by text REFERENCES users(id) ON DELETE SET NULL,
      created_at integer DEFAULT (unixepoch()) NOT NULL
    )
  `);
  await client.execute(
    "CREATE UNIQUE INDEX project_memberships_unique ON project_memberships (project_id, user_id)",
  );
  await client.execute(
    "CREATE INDEX project_memberships_user_idx ON project_memberships (user_id)",
  );
  await client.execute(
    "CREATE INDEX project_memberships_proj_idx ON project_memberships (project_id)",
  );
  console.log("created project_memberships table + indexes.");
}

async function createProjectInvites(client: Client) {
  if (await tableExists(client, "project_invites")) {
    console.log("project_invites already exists — skipping create.");
    return;
  }
  await client.execute(`
    CREATE TABLE project_invites (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      invited_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email text,
      role text DEFAULT 'member' NOT NULL,
      token_hash text NOT NULL,
      created_at integer DEFAULT (unixepoch()) NOT NULL,
      expires_at integer NOT NULL,
      consumed_at integer,
      consumed_by text REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  await client.execute(
    "CREATE UNIQUE INDEX project_invites_token_idx ON project_invites (token_hash)",
  );
  await client.execute(
    "CREATE INDEX project_invites_proj_idx ON project_invites (project_id)",
  );
  console.log("created project_invites table + indexes.");
}

async function createDeviceCodes(client: Client) {
  if (await tableExists(client, "device_codes")) {
    console.log("device_codes already exists — skipping create.");
    return;
  }
  await client.execute(`
    CREATE TABLE device_codes (
      id text PRIMARY KEY NOT NULL,
      device_code_hash text NOT NULL,
      user_code_hash text NOT NULL,
      status text DEFAULT 'pending' NOT NULL,
      user_id text REFERENCES users(id) ON DELETE CASCADE,
      client_name text,
      created_at integer DEFAULT (unixepoch()) NOT NULL,
      expires_at integer NOT NULL,
      last_polled_at integer
    )
  `);
  await client.execute(
    "CREATE UNIQUE INDEX device_codes_device_idx ON device_codes (device_code_hash)",
  );
  await client.execute(
    "CREATE UNIQUE INDEX device_codes_user_idx ON device_codes (user_code_hash)",
  );
  await client.execute(
    "CREATE INDEX device_codes_expires_idx ON device_codes (expires_at)",
  );
  console.log("created device_codes table + indexes.");
}

// uuidv7 in plain SQL — for backfill rows. Time-based, sufficiently unique
// for migration use. (Runtime code uses @agentrysh/shared's uuidv7.)
function uuidv7(): string {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  const hex = tsHex + "7" + randHex.slice(0, 3) + "8" + randHex.slice(3);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function backfillIdentities(client: Client) {
  // Insert one identity row per existing user that has a github_id, only if no
  // identity already exists for that user. Provider = "github" (the legacy
  // direct-GitHub flow — distinct from "workos" identities minted post-cutover).
  const users = await client.execute(`
    SELECT u.id, u.github_id, u.email
    FROM users u
    WHERE u.github_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM identities i
        WHERE i.user_id = u.id AND i.provider = 'github'
      )
  `);

  if (users.rows.length === 0) {
    console.log("identities: nothing to backfill.");
    return;
  }

  console.log(`backfilling ${users.rows.length} identity rows from users.github_id…`);
  const now = Math.floor(Date.now() / 1000);
  const stmts = users.rows.map((row) => {
    const r = row as unknown as { id: string; github_id: number; email: string | null };
    return {
      sql: `INSERT INTO identities (id, user_id, provider, provider_user_id, email, created_at)
            VALUES (?, ?, 'github', ?, ?, ?)`,
      args: [uuidv7(), r.id, String(r.github_id), r.email, now],
    };
  });
  await client.batch(stmts, "write");
  console.log(`backfilled ${stmts.length} identity rows.`);
}

async function backfillMemberships(client: Client) {
  // Insert one owner membership per existing project, only if no membership
  // already exists for that (project, user) pair.
  const projects = await client.execute(`
    SELECT p.id AS project_id, p.user_id, p.created_at
    FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM project_memberships m
      WHERE m.project_id = p.id AND m.user_id = p.user_id
    )
  `);

  if (projects.rows.length === 0) {
    console.log("project_memberships: nothing to backfill.");
    return;
  }

  console.log(`backfilling ${projects.rows.length} owner memberships from projects…`);
  const stmts = projects.rows.map((row) => {
    const r = row as unknown as { project_id: string; user_id: string; created_at: number };
    return {
      sql: `INSERT INTO project_memberships (id, project_id, user_id, role, invited_by, created_at)
            VALUES (?, ?, ?, 'owner', NULL, ?)`,
      args: [uuidv7(), r.project_id, r.user_id, r.created_at],
    };
  });
  await client.batch(stmts, "write");
  console.log(`backfilled ${stmts.length} owner memberships.`);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });

  // Order matters: create new tables first (they're additive), then backfill
  // (depends on those tables existing), then rebuild users last (so backfills
  // can still read github_id under its current schema).
  await createIdentities(client);
  await createProjectMemberships(client);
  await createProjectInvites(client);
  await createDeviceCodes(client);

  await backfillIdentities(client);
  await backfillMemberships(client);

  if (await isGithubIdNotNull(client)) {
    await makeGithubIdNullable(client);
  } else {
    console.log("users.github_id is already nullable — skipping rebuild.");
  }

  console.log("migration complete.");
}

main().catch((err) => {
  console.error("migration failed:", err);
  process.exit(1);
});
