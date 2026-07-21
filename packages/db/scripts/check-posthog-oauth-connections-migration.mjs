import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-add-posthog-oauth-connections.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-posthog-oauth-migration-"));
const url = `file:${join(directory, "oauth.sqlite")}`;
const now = Math.floor(Date.now() / 1000);
const hash = (character) => character.repeat(64);
const scopes = JSON.stringify([
  "openid", "email", "project:read", "query:read",
  "event_definition:read", "property_definition:read", "error_tracking:read",
  "session_recording:read", "feature_flag:read", "survey:read", "experiment:read",
]);
const loopback = `http://127.0.0.1:43123/agentry/posthog/callback/${"a".repeat(22)}`;

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

async function mustReject(label, operation) {
  await assert.rejects(operation, undefined, `${label} was accepted`);
}

try {
  const bootstrap = createClient({ url });
  await bootstrap.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE users (id text PRIMARY KEY)",
    "CREATE TABLE projects (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE)",
    "INSERT INTO users (id) VALUES ('user-1')",
    "INSERT INTO projects (id, user_id) VALUES ('project-1', 'user-1')",
  ], "write");
  bootstrap.close();

  runMigration();
  runMigration();

  const db = createClient({ url });
  await db.execute("PRAGMA foreign_keys = ON");
  const connectionColumns = (await db.execute("PRAGMA table_info(posthog_connections)"))
    .rows.map((row) => String(row.name));
  for (const name of [
    "access_token_ciphertext", "refresh_token_ciphertext", "oauth_client_id",
    "refresh_lease_token", "refresh_lease_expires_at",
  ]) assert.ok(connectionColumns.includes(name), `missing connection column ${name}`);
  for (const name of ["access_token", "refresh_token", "access_token_hash", "refresh_token_hash"])
    assert.equal(connectionColumns.includes(name), false, `retained raw/hash column ${name}`);

  const attemptColumns = (await db.execute("PRAGMA table_info(posthog_oauth_attempts)"))
    .rows.map((row) => String(row.name));
  for (const name of [
    "mode", "state_hash", "poll_token_hash", "handoff_redirect_uri",
    "handoff_challenge", "handoff_code_hash", "oidc_nonce_hash",
    "oidc_nonce_ciphertext", "oidc_nonce_iv",
  ]) assert.ok(attemptColumns.includes(name), `missing attempt column ${name}`);
  for (const name of ["state", "pkce_verifier", "oidc_nonce"])
    assert.equal(attemptColumns.includes(name), false, `retained raw attempt column ${name}`);

  const bootstrapInsert = {
    sql: `INSERT INTO posthog_oauth_attempts (
      id, mode, poll_token_hash, handoff_redirect_uri, handoff_challenge,
      state_hash, oauth_client_id, pkce_verifier_ciphertext, pkce_verifier_iv,
      oidc_nonce_hash, oidc_nonce_ciphertext, oidc_nonce_iv, redirect_uri,
      requested_scopes_json, posthog_region_hint, status, expires_at, created_at, updated_at
    ) VALUES (?, 'bootstrap', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'us', 'pending', ?, ?, ?)`,
    args: [
      "bootstrap-1", hash("b"), loopback, "c".repeat(43), hash("a"),
      "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      "encrypted-pkce", "pkce-iv", hash("d"), "encrypted-nonce", "nonce-iv",
      "https://api.agentry.sh/v1/integrations/posthog/oauth/callback",
      scopes, now + 600, now, now,
    ],
  };
  await db.execute(bootstrapInsert);

  await mustReject("bootstrap without a localhost return binding", () => db.execute({
    ...bootstrapInsert,
    args: [
      "bootstrap-unbound", null, null, null, hash("e"),
      "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      "encrypted-pkce", "pkce-iv", hash("f"), "encrypted-nonce", "nonce-iv",
      "https://api.agentry.sh/v1/integrations/posthog/oauth/callback",
      scopes, now + 600, now, now,
    ],
  }));
  await mustReject("non-loopback native callback", () => db.execute({
    ...bootstrapInsert,
    args: [
      "bootstrap-open-redirect", hash("1"),
      `https://attacker.example/agentry/posthog/callback/${"a".repeat(22)}`,
      "c".repeat(43), hash("2"),
      "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      "encrypted-pkce", "pkce-iv", hash("3"), "encrypted-nonce", "nonce-iv",
      "https://api.agentry.sh/v1/integrations/posthog/oauth/callback",
      scopes, now + 600, now, now,
    ],
  }));

  await db.execute({
    sql: `UPDATE posthog_oauth_attempts SET status='exchanging', exchange_started_at=?,
      version=version+1, updated_at=? WHERE id='bootstrap-1'`,
    args: [now + 1, now + 1],
  });
  await db.execute({
    sql: `UPDATE posthog_oauth_attempts SET status='authorized', user_id='user-1',
      pkce_verifier_ciphertext=NULL, pkce_verifier_iv=NULL,
      oidc_nonce_ciphertext=NULL, oidc_nonce_iv=NULL,
      handoff_code_hash=?, handoff_expires_at=?,
      pending_access_token_ciphertext='enc-access', pending_access_token_iv='access-iv',
      pending_refresh_token_ciphertext='enc-refresh', pending_refresh_token_iv='refresh-iv',
      pending_access_token_expires_at=?, granted_scopes_json=?,
      posthog_host='https://us.posthog.com', posthog_environment_id=42,
      capability_snapshot_json='{}', authorized_at=?, expires_at=?,
      version=version+1, updated_at=? WHERE id='bootstrap-1'`,
    args: [hash("4"), now + 300, now + 3600, scopes, now + 2, now + 300, now + 2],
  });
  await mustReject("consumption retaining the browser ticket", () => db.execute({
    sql: "UPDATE posthog_oauth_attempts SET poll_consumed_at=? WHERE id='bootstrap-1'",
    args: [now + 3],
  }));
  await db.execute({
    sql: `UPDATE posthog_oauth_attempts SET poll_consumed_at=?, handoff_code_hash=NULL,
      handoff_expires_at=NULL, expires_at=?, version=version+1, updated_at=?
      WHERE id='bootstrap-1'`,
    args: [now + 3, now + 1800, now + 3],
  });

  await db.execute({
    sql: `INSERT INTO posthog_connections (
      id, project_id, authorized_by_user_id, oauth_client_id, status,
      access_token_ciphertext, access_token_iv, refresh_token_ciphertext, refresh_token_iv,
      access_token_expires_at, granted_scopes_json, posthog_host, posthog_region,
      posthog_environment_id, capability_snapshot_json, authorized_at, created_at, updated_at
    ) VALUES ('connection-1','project-1','user-1',?,'active',
      'enc-access','access-iv','enc-refresh','refresh-iv',?,?,
      'https://us.posthog.com','us',42,'{}',?,?,?)`,
    args: [
      "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      now + 3600, scopes, now + 3, now + 3, now + 3,
    ],
  });
  await db.execute({
    sql: `UPDATE posthog_connections SET refresh_lease_token=?, refresh_lease_expires_at=?,
      version=version+1, updated_at=? WHERE id='connection-1'`,
    args: ["l".repeat(32), now + 30, now + 4],
  });
  await mustReject("partial refresh lease", () => db.execute(
    "UPDATE posthog_connections SET refresh_lease_expires_at=NULL WHERE id='connection-1'",
  ));
  await db.execute({
    sql: `UPDATE posthog_connections SET refresh_lease_token=NULL, refresh_lease_expires_at=NULL,
      version=version+1, updated_at=? WHERE id='connection-1'`,
    args: [now + 5],
  });
  await mustReject("detach retaining OAuth credentials", () => db.execute({
    sql: "UPDATE posthog_connections SET status='detached', detached_at=? WHERE id='connection-1'",
    args: [now + 6],
  }));
  await db.execute({
    sql: `UPDATE posthog_connections SET status='detached', access_token_ciphertext=NULL,
      access_token_iv=NULL, refresh_token_ciphertext=NULL, refresh_token_iv=NULL,
      access_token_expires_at=NULL, granted_scopes_json='[]', posthog_organization_id=NULL,
      posthog_environment_id=NULL, detached_at=?, version=version+1, updated_at=?
      WHERE id='connection-1'`,
    args: [now + 6, now + 6],
  });

  const foreignKeys = await db.execute("PRAGMA foreign_key_check");
  assert.equal(foreignKeys.rows.length, 0);
  db.close();
  console.log("PostHog OAuth connection migration self-test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
