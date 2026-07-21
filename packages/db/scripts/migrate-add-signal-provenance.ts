// Additive migration for scoped project credentials and signal provenance.
// Run after the automation-foundations migration.

import { createClient } from "@libsql/client";

async function tableColumns(client: ReturnType<typeof createClient>, table: string) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function addColumnIfMissing(
  client: ReturnType<typeof createClient>,
  table: string,
  column: string,
  definition: string,
) {
  const columns = await tableColumns(client, table);
  if (columns.has(column)) return;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`added ${table}.${column}.`);
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken });

  await client.execute(`
    CREATE TABLE IF NOT EXISTS project_credentials (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind text NOT NULL,
      name text NOT NULL,
      prefix text NOT NULL,
      token_hash text NOT NULL,
      automation_id text,
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      created_at integer NOT NULL DEFAULT (unixepoch()),
      expires_at integer NOT NULL,
      last_used_at integer,
      revoked_at integer,
      revoke_reason text
    )
  `);
  const credentialIdentityColumns = ["id", "project_id", "kind"] as const;
  const credentialsBefore = await tableColumns(client, "project_credentials");
  const missingIdentity = credentialIdentityColumns.filter((column) => !credentialsBefore.has(column));
  if (missingIdentity.length > 0) {
    throw new Error(
      `project_credentials is missing authority identity columns (${missingIdentity.join(", ")}); ` +
      "migration stopped before inventing credential identities",
    );
  }
  const credentialAuthorityUnprovable =
    !credentialsBefore.has("token_hash") || !credentialsBefore.has("expires_at");
  for (const [column, definition] of [
    ["name", "text NOT NULL DEFAULT ''"],
    ["prefix", "text NOT NULL DEFAULT ''"],
    ["token_hash", "text NOT NULL DEFAULT ''"],
    ["automation_id", "text"],
    ["created_by", "text REFERENCES users(id) ON DELETE SET NULL"],
    ["created_at", "integer NOT NULL DEFAULT 0"],
    ["expires_at", "integer NOT NULL DEFAULT 0"],
    ["last_used_at", "integer"],
    ["revoked_at", "integer"],
    ["revoke_reason", "text"],
  ] as const) {
    await addColumnIfMissing(client, "project_credentials", column, definition);
  }

  // A table that previously lacked its token hash or expiry cannot prove that
  // its rows were usable credentials. Preserve ids as provenance
  // tombstones, but deterministically disable every row and replace any
  // untrustworthy token material before installing the unique auth index.
  if (credentialAuthorityUnprovable) {
    await client.execute(`
      UPDATE project_credentials
         SET name = CASE WHEN name IS NULL OR trim(name) = '' THEN 'legacy disabled credential' ELSE name END,
             prefix = 'legacy_disabled_' || id,
             token_hash = 'legacy-disabled:' || id,
             created_at = COALESCE(created_at, 0),
             expires_at = 0,
             revoked_at = COALESCE(revoked_at, 0),
             revoke_reason = COALESCE(revoke_reason, 'legacy_partial_credential_schema')
    `);
  } else {
    await client.execute(`
      UPDATE project_credentials
         SET name = CASE WHEN name IS NULL OR trim(name) = '' THEN 'legacy disabled credential' ELSE name END,
             prefix = CASE WHEN prefix IS NULL OR trim(prefix) = '' THEN 'legacy_disabled_' || id ELSE prefix END,
             token_hash = CASE WHEN token_hash IS NULL OR trim(token_hash) = '' THEN 'legacy-disabled:' || id ELSE token_hash END,
             created_at = COALESCE(created_at, 0),
             expires_at = COALESCE(expires_at, 0),
             revoked_at = CASE
               WHEN token_hash IS NULL OR trim(token_hash) = '' THEN COALESCE(revoked_at, 0)
               ELSE revoked_at
             END,
             revoke_reason = CASE
               WHEN token_hash IS NULL OR trim(token_hash) = '' THEN COALESCE(revoke_reason, 'legacy_invalid_credential_record')
               ELSE revoke_reason
             END
       WHERE name IS NULL OR trim(name) = ''
          OR prefix IS NULL OR trim(prefix) = ''
          OR token_hash IS NULL OR trim(token_hash) = ''
          OR created_at IS NULL OR expires_at IS NULL
    `);
  }
  // Runner authority is narrower than the other credential kinds. A legacy
  // runner without one exact automation binding is unusable, while a server or
  // CI credential must never acquire an automation binding by accident.
  await client.execute(`
    UPDATE project_credentials
       SET prefix = CASE WHEN prefix IS NULL OR trim(prefix) = '' THEN 'legacy_disabled_' || id ELSE prefix END,
           token_hash = CASE
             WHEN kind = 'automation_runner' AND (automation_id IS NULL OR trim(automation_id) = '')
               THEN 'legacy-disabled:' || id
             ELSE token_hash
           END,
           expires_at = CASE
             WHEN kind = 'automation_runner' AND (automation_id IS NULL OR trim(automation_id) = '')
               THEN 0
             ELSE expires_at
           END,
           revoked_at = CASE
             WHEN kind = 'automation_runner' AND (automation_id IS NULL OR trim(automation_id) = '')
               THEN COALESCE(revoked_at, 0)
             ELSE revoked_at
           END,
           revoke_reason = CASE
             WHEN kind = 'automation_runner' AND (automation_id IS NULL OR trim(automation_id) = '')
               THEN COALESCE(revoke_reason, 'legacy_runner_missing_automation_binding')
             ELSE revoke_reason
           END,
           automation_id = CASE WHEN kind = 'automation_runner' THEN automation_id ELSE NULL END
  `);
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS project_credentials_token_hash_idx ON project_credentials (token_hash)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS project_credentials_project_active_idx ON project_credentials (project_id, revoked_at, expires_at)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS project_credentials_automation_idx ON project_credentials (project_id, automation_id, revoked_at)",
  );
  await client.batch([
    "DROP TRIGGER IF EXISTS project_credentials_required_fields_insert_guard",
    "DROP TRIGGER IF EXISTS project_credentials_required_fields_update_guard",
    `CREATE TRIGGER project_credentials_required_fields_insert_guard
     BEFORE INSERT ON project_credentials
     WHEN NEW.id IS NULL OR trim(NEW.id) = ''
       OR NEW.project_id IS NULL OR trim(NEW.project_id) = ''
       OR NEW.kind NOT IN ('server_ingest', 'ci_deploy', 'automation_runner')
       OR NEW.name IS NULL OR trim(NEW.name) = ''
       OR NEW.prefix IS NULL OR trim(NEW.prefix) = ''
       OR NEW.token_hash IS NULL OR trim(NEW.token_hash) = ''
       OR (NEW.kind = 'automation_runner' AND (NEW.automation_id IS NULL OR trim(NEW.automation_id) = ''))
       OR (NEW.kind <> 'automation_runner' AND NEW.automation_id IS NOT NULL)
       OR NEW.created_at IS NULL OR NEW.expires_at IS NULL
     BEGIN
       SELECT RAISE(ABORT, 'project credential requires complete scoped authority fields');
     END`,
    `CREATE TRIGGER project_credentials_required_fields_update_guard
     BEFORE UPDATE OF id, project_id, kind, name, prefix, token_hash, automation_id, created_at, expires_at
     ON project_credentials
     WHEN NEW.id IS NULL OR trim(NEW.id) = ''
       OR NEW.project_id IS NULL OR trim(NEW.project_id) = ''
       OR NEW.kind NOT IN ('server_ingest', 'ci_deploy', 'automation_runner')
       OR NEW.name IS NULL OR trim(NEW.name) = ''
       OR NEW.prefix IS NULL OR trim(NEW.prefix) = ''
       OR NEW.token_hash IS NULL OR trim(NEW.token_hash) = ''
       OR (NEW.kind = 'automation_runner' AND (NEW.automation_id IS NULL OR trim(NEW.automation_id) = ''))
       OR (NEW.kind <> 'automation_runner' AND NEW.automation_id IS NOT NULL)
       OR NEW.created_at IS NULL OR NEW.expires_at IS NULL
     BEGIN
       SELECT RAISE(ABORT, 'project credential requires complete scoped authority fields');
     END`,
  ], "write");

  await addColumnIfMissing(
    client,
    "events",
    "trust_level",
    "text NOT NULL DEFAULT 'untrusted_browser'",
  );
  await addColumnIfMissing(
    client,
    "events",
    "credential_kind",
    "text NOT NULL DEFAULT 'browser_public'",
  );
  await addColumnIfMissing(client, "events", "credential_id", "text REFERENCES project_credentials(id) ON DELETE SET NULL");

  await addColumnIfMissing(
    client,
    "cases",
    "last_trust_level",
    "text NOT NULL DEFAULT 'untrusted_browser'",
  );
  await addColumnIfMissing(
    client,
    "cases",
    "last_credential_kind",
    "text NOT NULL DEFAULT 'browser_public'",
  );
  await addColumnIfMissing(client, "cases", "last_credential_id", "text REFERENCES project_credentials(id) ON DELETE SET NULL");

  // Previous provenance migrations could leave trusted labels behind without
  // an exact scoped credential. Labels alone are never authority. Preserve a
  // trusted historical observation only when its credential tombstone belongs
  // to the same project, has the right kind, and came from a complete (not
  // legacy-disabled) credential record; otherwise downgrade it explicitly.
  await client.execute(`
    UPDATE events
       SET trust_level = 'untrusted_browser',
           credential_kind = 'browser_public',
           credential_id = NULL
     WHERE NOT (
       (trust_level IS 'untrusted_browser'
        AND credential_kind IS 'browser_public'
        AND credential_id IS NULL)
       OR
       (trust_level IS 'trusted_server'
        AND credential_kind IS 'server_ingest'
        AND credential_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM project_credentials credential
           WHERE credential.id = events.credential_id
             AND credential.project_id = events.project_id
             AND credential.kind = 'server_ingest'
             AND credential.token_hash NOT LIKE 'legacy-disabled:%'
        ))
     )
  `);
  await client.execute(`
    UPDATE cases
       SET last_trust_level = 'untrusted_browser',
           last_credential_kind = 'browser_public',
           last_credential_id = NULL
     WHERE NOT (
       (last_trust_level IS 'untrusted_browser'
        AND last_credential_kind IS 'browser_public'
        AND last_credential_id IS NULL)
       OR
       (last_trust_level IS 'trusted_server'
        AND last_credential_kind IS 'server_ingest'
        AND last_credential_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM project_credentials credential
           WHERE credential.id = cases.last_credential_id
             AND credential.project_id = cases.project_id
             AND credential.kind = 'server_ingest'
             AND credential.token_hash NOT LIKE 'legacy-disabled:%'
        ))
     )
  `);

  await addColumnIfMissing(client, "automation_runs", "runner_credential_id", "text REFERENCES project_credentials(id) ON DELETE SET NULL");
  await addColumnIfMissing(client, "case_claims", "credential_id", "text REFERENCES project_credentials(id) ON DELETE SET NULL");

  await addColumnIfMissing(
    client,
    "deploys",
    "trust_level",
    "text NOT NULL DEFAULT 'legacy_unverified'",
  );
  await addColumnIfMissing(
    client,
    "deploys",
    "credential_kind",
    "text NOT NULL DEFAULT 'legacy_deploy'",
  );
  await addColumnIfMissing(client, "deploys", "credential_id", "text REFERENCES project_credentials(id) ON DELETE RESTRICT");

  // Rows that predate scoped CI credentials cannot be upgraded into trusted
  // evidence merely because a migration added provenance columns. This also
  // repairs databases that already ran the earlier false-trust backfill.
  await client.execute(`
    UPDATE deploys
       SET trust_level = 'legacy_unverified',
           credential_kind = 'legacy_deploy',
           credential_id = NULL
     WHERE credential_id IS NULL
        OR trust_level IS NOT 'trusted_ci'
        OR credential_kind IS NOT 'ci_deploy'
        OR NOT EXISTS (
          SELECT 1
            FROM project_credentials credential
           WHERE credential.id = deploys.credential_id
             AND credential.project_id = deploys.project_id
             AND credential.kind = 'ci_deploy'
             AND credential.token_hash NOT LIKE 'legacy-disabled:%'
        )
  `);
  // Do not symmetrically "repair" credential-bearing rows into trusted state:
  // a migration cannot prove when or how an arbitrary legacy credential_id
  // was attached. Canonical ingest already writes trusted_ci explicitly after
  // authenticating an active CI credential; everything else stays as found.
  await client.batch([
    "DROP TRIGGER IF EXISTS deploys_provenance_insert_guard",
    "DROP TRIGGER IF EXISTS deploys_provenance_update_guard",
    `CREATE TRIGGER deploys_provenance_insert_guard
    BEFORE INSERT ON deploys
    WHEN (
      NEW.credential_id IS NULL
      AND (NEW.trust_level IS NOT 'legacy_unverified' OR NEW.credential_kind IS NOT 'legacy_deploy')
    ) OR (
      NEW.credential_id IS NOT NULL
      AND (
        NEW.trust_level IS NOT 'trusted_ci'
        OR NEW.credential_kind IS NOT 'ci_deploy'
        OR NOT EXISTS (
          SELECT 1
            FROM project_credentials credential
           WHERE credential.id = NEW.credential_id
             AND credential.project_id = NEW.project_id
             AND credential.kind = 'ci_deploy'
             AND credential.revoked_at IS NULL
             AND credential.expires_at > unixepoch()
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'deploy provenance must match an exact scoped CI credential or remain legacy_unverified');
    END
  `,
    `CREATE TRIGGER deploys_provenance_update_guard
    BEFORE UPDATE OF project_id, trust_level, credential_kind, credential_id ON deploys
    WHEN NOT (
      OLD.credential_id IS NOT NULL
      AND NEW.credential_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM projects project WHERE project.id = NEW.project_id)
    ) AND NOT (
      NEW.project_id IS OLD.project_id
      AND (
        (
          NEW.trust_level IS OLD.trust_level
          AND NEW.credential_kind IS OLD.credential_kind
          AND NEW.credential_id IS OLD.credential_id
        ) OR (
          NEW.trust_level IS 'legacy_unverified'
          AND NEW.credential_kind IS 'legacy_deploy'
          AND NEW.credential_id IS NULL
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'deploy provenance must match an exact scoped CI credential or remain legacy_unverified');
    END
  `,
  ], "write");

  console.log("project credential and signal provenance schema is ready.");
}

main().catch((error) => {
  console.error("migration failed:", error);
  process.exit(1);
});
