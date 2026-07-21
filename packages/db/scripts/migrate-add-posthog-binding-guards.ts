// Persist the distinct PostHog project-resource identity and make the local
// project binding immutable. Deletion is permitted only while the owning
// project has a durable project/account deletion fence; finalizers explicitly
// remove the binding before removing that fence and cascading the project.

import { createClient, type Client } from "@libsql/client";

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

function explicitLegacyBindingBackfill(): { orgId: string; host: string } | null {
  const orgId = process.env.AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID?.trim() ?? "";
  const rawHost = process.env.AGENTRY_POSTHOG_BINDING_BACKFILL_HOST?.trim() ?? "";
  if (!orgId && !rawHost) return null;
  if (!orgId || !rawHost) {
    throw new Error(
      "legacy PostHog binding reconciliation requires both " +
      "AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID and AGENTRY_POSTHOG_BINDING_BACKFILL_HOST",
    );
  }
  if (orgId.length > 200 || /[\u0000-\u001f\u007f]/.test(orgId)) {
    throw new Error("AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID is invalid");
  }
  let url: URL;
  try {
    url = new URL(rawHost);
  } catch {
    throw new Error("AGENTRY_POSTHOG_BINDING_BACKFILL_HOST must be an absolute URL");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
    .has(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "AGENTRY_POSTHOG_BINDING_BACKFILL_HOST must use HTTPS (or loopback HTTP) " +
      "and contain no credentials, query, or fragment",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return { orgId, host: `${url.origin}${path}` };
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

  const columns = await tableColumns(client, "project_posthog_bindings");
  if (columns.size === 0) {
    throw new Error("project_posthog_bindings is missing; run the core schema migration first");
  }
  if (!columns.has("posthog_project_resource_id")) {
    await client.execute(
      "ALTER TABLE project_posthog_bindings ADD COLUMN posthog_project_resource_id integer",
    );
  }
  const identityColumns = await tableColumns(client, "project_posthog_bindings");
  if (!identityColumns.has("posthog_org_id")) {
    await client.execute(
      "ALTER TABLE project_posthog_bindings ADD COLUMN posthog_org_id text",
    );
  }

  // Clean break: the legacy encrypted read-token columns only ever stored an
  // encrypted literal and had no reader. Rebuild to the canonical identity
  // shape instead of perpetuating fake secret state.
  await client.batch([
    "DROP TABLE IF EXISTS project_posthog_bindings_rebuild",
    `CREATE TABLE project_posthog_bindings_rebuild (
      project_id text PRIMARY KEY NOT NULL
        REFERENCES projects(id) ON DELETE CASCADE,
      posthog_project_id integer NOT NULL,
      posthog_project_resource_id integer,
      posthog_org_id text,
      posthog_project_api_key text NOT NULL,
      posthog_host text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `INSERT INTO project_posthog_bindings_rebuild (
      project_id, posthog_project_id, posthog_project_resource_id, posthog_org_id,
      posthog_project_api_key, posthog_host, created_at
    ) SELECT
      project_id, posthog_project_id, posthog_project_resource_id, posthog_org_id,
      posthog_project_api_key, posthog_host, created_at
    FROM project_posthog_bindings`,
    "DROP TABLE project_posthog_bindings",
    "ALTER TABLE project_posthog_bindings_rebuild RENAME TO project_posthog_bindings",
    `CREATE UNIQUE INDEX project_posthog_bindings_ph_id_idx
      ON project_posthog_bindings (posthog_project_id)`,
  ], "write");

  // Legacy rows intentionally remain unattested (NULL) unless an operator
  // supplies both the exact historical host and organization/account. This
  // is a deliberate reconciliation step: request-time code must never infer
  // an account from the deployment that happens to be current today. Rerun
  // this migration with the pair below to reconcile rows for one exact host.
  const backfill = explicitLegacyBindingBackfill();
  if (backfill) {
    await client.execute({
      sql: `UPDATE project_posthog_bindings
        SET posthog_org_id = ?
        WHERE posthog_org_id IS NULL
          AND rtrim(posthog_host, '/') = ?`,
      args: [backfill.orgId, backfill.host],
    });
  }

  await client.batch([
    `CREATE TABLE IF NOT EXISTS posthog_provision_targets (
      command_id text PRIMARY KEY NOT NULL
        REFERENCES mutation_commands(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      target_fingerprint text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS posthog_provision_targets_project_idx
      ON posthog_provision_targets (project_id)`,
    "DROP TRIGGER IF EXISTS posthog_provision_targets_immutable_update_guard",
    `CREATE TRIGGER posthog_provision_targets_immutable_update_guard
      BEFORE UPDATE ON posthog_provision_targets
      BEGIN
        SELECT RAISE(ABORT, 'posthog_provision_targets rows are immutable');
      END`,
    "DROP TRIGGER IF EXISTS posthog_provision_targets_insert_guard",
    `CREATE TRIGGER posthog_provision_targets_insert_guard
      BEFORE INSERT ON posthog_provision_targets
      WHEN length(NEW.target_fingerprint) <> 64
        OR NEW.target_fingerprint GLOB '*[^a-f0-9]*'
      BEGIN
        SELECT RAISE(ABORT, 'invalid posthog provider target fingerprint');
      END`,
    "DROP TRIGGER IF EXISTS project_posthog_bindings_immutable_update_guard",
    `CREATE TRIGGER project_posthog_bindings_immutable_update_guard
      BEFORE UPDATE ON project_posthog_bindings
      BEGIN
        SELECT RAISE(ABORT, 'project_posthog_bindings rows are immutable');
      END`,
    "DROP TRIGGER IF EXISTS project_posthog_bindings_fenced_delete_guard",
    `CREATE TRIGGER project_posthog_bindings_fenced_delete_guard
      BEFORE DELETE ON project_posthog_bindings
      WHEN NOT EXISTS (
        SELECT 1 FROM project_deletion_fences
        WHERE project_id = OLD.project_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'project_posthog_bindings deletion requires project fence');
      END`,
  ], "write");

  client.close();
}

await main();
