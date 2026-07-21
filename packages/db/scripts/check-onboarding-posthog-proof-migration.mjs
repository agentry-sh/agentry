import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-onboarding-posthog-proof.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-onboarding-posthog-proof-"));
const url = `file:${join(directory, "proof.sqlite")}`;
const now = Math.floor(Date.now() / 1_000);

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

try {
  const bootstrap = createClient({ url });
  await bootstrap.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE projects (id text PRIMARY KEY)",
    `CREATE TABLE project_credentials (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind text NOT NULL
    )`,
    `CREATE TABLE onboarding_proof_sessions (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      onboarding_id text NOT NULL,
      approved_state_etag text NOT NULL,
      runtime_public_key_hash text NOT NULL,
      runtime_server_credential_id text REFERENCES project_credentials(id) ON DELETE RESTRICT,
      ci_credential_id text NOT NULL REFERENCES project_credentials(id) ON DELETE RESTRICT,
      runtime_marker_hash text NOT NULL,
      ci_marker_hash text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      started_at integer NOT NULL,
      expires_at integer NOT NULL,
      terminal_at integer,
      terminal_reason text,
      updated_at integer NOT NULL
    )`,
    `CREATE TABLE deploys (
      id text PRIMARY KEY,
      onboarding_proof_session_id text REFERENCES onboarding_proof_sessions(id) ON DELETE SET NULL,
      onboarding_proof_credential_id text
    )`,
    "INSERT INTO projects (id) VALUES ('project-1')",
    "INSERT INTO project_credentials (id, project_id, kind) VALUES ('server-1', 'project-1', 'server_ingest')",
    "INSERT INTO project_credentials (id, project_id, kind) VALUES ('ci-1', 'project-1', 'ci_deploy')",
    `INSERT INTO onboarding_proof_sessions (
      id, project_id, onboarding_id, approved_state_etag,
      runtime_public_key_hash, runtime_server_credential_id, ci_credential_id,
      runtime_marker_hash, ci_marker_hash, started_at, expires_at, updated_at
    ) VALUES (
      'proof-1', 'project-1', 'onboarding-1', '${`"${"a".repeat(64)}"`}',
      '${"b".repeat(64)}', 'server-1', 'ci-1',
      '${"c".repeat(64)}', '${"d".repeat(64)}', ${now}, ${now + 900}, ${now}
    )`,
    "INSERT INTO deploys (id, onboarding_proof_session_id, onboarding_proof_credential_id) VALUES ('deploy-1', 'proof-1', 'ci-1')",
  ], "write");
  bootstrap.close();

  runMigration();
  runMigration();

  const db = createClient({ url });
  await db.execute("PRAGMA foreign_keys = ON");
  const columns = await db.execute("PRAGMA table_info(onboarding_proof_sessions)");
  const names = columns.rows.map((row) => String(row.name));
  assert.equal(names.includes("runtime_public_key_hash"), false);
  assert.equal(names.includes("runtime_server_credential_id"), false);
  assert.ok(names.includes("runtime_marker_hash"));
  assert.ok(names.includes("ci_credential_id"));

  const sessions = await db.execute("SELECT * FROM onboarding_proof_sessions");
  assert.equal(sessions.rows.length, 0, "non-resumable legacy proof session survived");
  const deploy = await db.execute("SELECT * FROM deploys WHERE id = 'deploy-1'");
  assert.equal(deploy.rows[0]?.onboarding_proof_session_id, null);
  assert.equal(deploy.rows[0]?.onboarding_proof_credential_id, null);

  await db.execute({
    sql: `INSERT INTO onboarding_proof_sessions (
      id, project_id, onboarding_id, approved_state_etag, ci_credential_id,
      runtime_marker_hash, ci_marker_hash, started_at, expires_at, updated_at
    ) VALUES (?, 'project-1', 'onboarding-2', ?, 'ci-1', ?, ?, ?, ?, ?)`,
    args: [
      "proof-2",
      `"${"e".repeat(64)}"`,
      "f".repeat(64),
      "1".repeat(64),
      now,
      now + 900,
      now,
    ],
  });
  const inserted = await db.execute(
    "SELECT ci_credential_id, runtime_marker_hash FROM onboarding_proof_sessions WHERE id = 'proof-2'",
  );
  assert.equal(inserted.rows[0]?.ci_credential_id, "ci-1");
  assert.equal(inserted.rows[0]?.runtime_marker_hash, "f".repeat(64));
  await db.execute(
    "INSERT INTO deploys (id, onboarding_proof_session_id, onboarding_proof_credential_id) " +
      "VALUES ('deploy-2', 'proof-2', 'ci-1')",
  );
  const deployForeignKeys = await db.execute("PRAGMA foreign_key_list(deploys)");
  assert.ok(deployForeignKeys.rows.some((row) =>
    row.table === "onboarding_proof_sessions" &&
    row.from === "onboarding_proof_session_id"
  ));
  db.close();
  console.log("onboarding PostHog proof migration checks passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
