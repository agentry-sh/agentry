import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

import { baselineStatements } from "./core-schema-baseline.mjs";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const migration = join(here, "migrate-read-only-schema-hard-cut.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-read-only-schema-hard-cut-"));
const url = `file:${join(directory, "hard-cut.sqlite")}`;
const now = Math.floor(Date.now() / 1_000);

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    cwd: packageRoot,
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

try {
  const bootstrap = createClient({ url });
  const legacyBaseline = baselineStatements(readFileSync(
    join(here, "fixtures/20260713_pre_read_only_core_baseline.sql"),
    "utf8",
  ));
  await bootstrap.batch(legacyBaseline, "write");
  await bootstrap.batch([
    "INSERT INTO users (id) VALUES ('user-1')",
    `INSERT INTO projects (id, user_id, name, dsn_prefix, dsn_hash)
      VALUES ('project-1', 'user-1', 'Legacy', 'agentry_pk_legacy', 'legacy-hash')`,
    `INSERT INTO api_keys (id, user_id, kind, prefix, key_hash)
      VALUES ('private-key', 'user-1', 'private', 'agentry_sk_private', 'private-hash')`,
    `INSERT INTO api_keys (id, user_id, kind, prefix, key_hash)
      VALUES ('public-key', 'user-1', 'public', 'agentry_pk_public', 'public-hash')`,
    `INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, expires_at
    ) VALUES (
      'server-key', 'project-1', 'server_ingest', 'retired',
      'agentry_server_retired', 'server-hash', ${now + 3600}
    )`,
    `INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, expires_at
    ) VALUES (
      'ci-key', 'project-1', 'ci_deploy', 'ci',
      'agentry_ci_valid', 'ci-hash', ${now + 3600}
    )`,
    `INSERT INTO cases (
      id, project_id, fingerprint, error_type, message,
      last_trust_level, last_credential_kind, last_credential_id
    ) VALUES (
      'legacy-case', 'project-1', 'legacy-fingerprint', 'Error', 'legacy',
      'trusted_server', 'server_ingest', 'server-key'
    )`,
    `INSERT INTO agent_runs (id, case_id, status)
      VALUES ('legacy-run', 'legacy-case', 'marked_spurious')`,
    `INSERT INTO deploys (id, project_id, sha, trust_level, credential_kind)
      VALUES ('legacy-deploy', 'project-1', 'legacy-sha',
        'legacy_unverified', 'legacy_deploy')`,
    `INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES (
      'trusted-deploy', 'project-1', 'trusted-sha',
      'trusted_ci', 'ci_deploy', 'ci-key'
    )`,
  ], "write");
  bootstrap.close();

  runMigration();
  runMigration();

  const db = createClient({ url });
  await db.execute("PRAGMA foreign_keys = ON");
  assert.equal((await db.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_codes'",
  )).rows.length, 0);
  const identityColumns = new Set((await db.execute(
    "PRAGMA table_info(identities)",
  )).rows.map((row) => String(row.name)));
  assert.equal(identityColumns.has("issuer"), true);
  assert.equal(identityColumns.has("subject"), true);
  assert.equal(identityColumns.has("provider"), false);
  assert.equal(identityColumns.has("provider_user_id"), false);
  const removedArchive = await db.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
  );
  assert.equal(removedArchive.rows.length, 0);
  assert.equal(Number((await db.execute(
    "SELECT COUNT(*) AS count FROM api_keys WHERE kind <> 'private'",
  )).rows[0]?.count), 0);
  assert.equal(Number((await db.execute(
    "SELECT COUNT(*) AS count FROM project_credentials WHERE kind = 'server_ingest'",
  )).rows[0]?.count), 0);
  assert.equal(Number((await db.execute(
    "SELECT COUNT(*) AS count FROM cases",
  )).rows[0]?.count), 0);
  assert.equal(Number((await db.execute(
    "SELECT COUNT(*) AS count FROM deploys WHERE id = 'legacy-deploy'",
  )).rows[0]?.count), 0);
  assert.equal(Number((await db.execute(
    "SELECT COUNT(*) AS count FROM deploys WHERE id = 'trusted-deploy'",
  )).rows[0]?.count), 1);

  const caseColumns = await db.execute("PRAGMA table_info(cases)");
  const caseShape = new Map(
    caseColumns.rows.map((row) => [String(row.name), Number(row.notnull ?? 0)]),
  );
  assert.equal(caseShape.has("last_credential_id"), false);
  assert.equal(caseShape.get("provider_issue_id"), 1);
  assert.equal(caseShape.get("provider_snapshot_hash"), 1);
  assert.equal(caseShape.get("provider_projected_at"), 1);
  assert.equal(caseShape.get("provider_event_classification"), 1);

  await assert.rejects(db.execute(`INSERT INTO api_keys (
    id, user_id, kind, prefix, key_hash
  ) VALUES ('bad-public', 'user-1', 'public', 'agentry_pk_bad', 'bad-public-hash')`));
  await assert.rejects(db.execute(`INSERT INTO project_credentials (
    id, project_id, kind, name, prefix, token_hash, expires_at
  ) VALUES (
    'bad-server', 'project-1', 'server_ingest', 'bad',
    'agentry_server_bad', 'bad-server-hash', ${now + 3600}
  )`));
  await assert.rejects(db.execute(`INSERT INTO deploys (
    id, project_id, sha, trust_level, credential_kind, credential_id
  ) VALUES (
    'bad-deploy', 'project-1', 'bad-sha',
    'legacy_unverified', 'legacy_deploy', 'ci-key'
  )`));
  await assert.rejects(db.execute(`INSERT INTO cases (
    id, project_id, provider_issue_id, provider_snapshot_hash,
    provider_projected_at, fingerprint, error_type, message, status
  ) VALUES (
    'bad-case', 'project-1', 'bad-case', '${"a".repeat(64)}',
    ${now}, 'bad-case', 'Error', 'bad', 'open'
  )`));
  await db.execute(`INSERT INTO cases (
    id, project_id, provider_issue_id, provider_snapshot_hash,
    provider_projected_at, provider_event_classification,
    fingerprint, error_type, message, status
  ) VALUES (
    'posthog-case', 'project-1', 'posthog-case', '${"b".repeat(64)}',
    ${now}, 'customer_exception', 'posthog-case', 'Error', 'bounded', 'active'
  )`);
  await assert.rejects(db.execute(`INSERT INTO cases (
    id, project_id, provider_issue_id, provider_snapshot_hash,
    provider_projected_at, provider_event_classification,
    fingerprint, error_type, message, status
  ) VALUES (
    'unknown-classification', 'project-1', 'unknown-classification',
    '${"c".repeat(64)}', ${now}, 'provider_unknown',
    'unknown-classification', 'Error', 'bounded', 'active'
  )`));

  const foreignKeys = await db.execute("PRAGMA foreign_key_check");
  assert.equal(foreignKeys.rows.length, 0);
  db.close();
  console.log("read-only schema hard-cut migration checks passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
