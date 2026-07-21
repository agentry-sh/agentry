import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-add-install-plan-revisions.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-install-plan-migration-"));
const url = `file:${join(directory, "legacy.sqlite")}`;

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

try {
  const legacy = createClient({ url });
  await legacy.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE users (id text PRIMARY KEY)",
    "CREATE TABLE projects (id text PRIMARY KEY, user_id text REFERENCES users(id))",
    `CREATE TABLE project_signal_maps (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      contract_version text NOT NULL, framework text NOT NULL, surface text NOT NULL,
      approved_plan_hash text NOT NULL, approved_at integer NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL
    )`,
    `CREATE TABLE project_artifacts (
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      artifact_type text NOT NULL, artifact_json text NOT NULL DEFAULT '{}',
      artifact_version text, approved_plan_hash text,
      created_at integer NOT NULL, updated_at integer NOT NULL,
      PRIMARY KEY (project_id, artifact_type)
    )`,
    "INSERT INTO users (id) VALUES ('owner')",
    "INSERT INTO projects (id, user_id) VALUES ('project', 'owner')",
    "INSERT INTO project_signal_maps VALUES ('project', 'legacy', 'node', 'server', 'legacy-hash', 1, 1, 1)",
    "INSERT INTO project_artifacts VALUES ('project', 'implementation_report', '{}', 'legacy', 'legacy-hash', 1, 1)",
  ], "write");
  legacy.close();

  runMigration();
  runMigration();

  const check = createClient({ url });
  for (const [table, expectedColumns] of [
    ["project_signal_maps", ["plan_id", "plan_revision", "signal_map_etag", "repo_snapshot_json", "approval_kind", "approved_by"]],
    ["project_artifacts", ["plan_id", "source_etag", "artifact_etag"]],
  ]) {
    const columns = await check.execute(`PRAGMA table_info(${table})`);
    const names = new Set(columns.rows.map((row) => String(row.name)));
    for (const column of expectedColumns) {
      if (!names.has(column)) throw new Error(`missing ${table}.${column}`);
    }
  }
  for (const table of ["project_install_plans", "project_install_plan_approvals"]) {
    const found = await check.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      args: [table],
    });
    if (found.rows.length !== 1) throw new Error(`missing ${table}`);
  }
  const retainedMaps = await check.execute("SELECT project_id FROM project_signal_maps");
  const retainedArtifacts = await check.execute("SELECT project_id FROM project_artifacts");
  if (retainedMaps.rows.length !== 1 || retainedArtifacts.rows.length !== 1) {
    throw new Error("legacy install artifacts were not retained");
  }
  await check.execute(`INSERT INTO project_install_plans (
    id, project_id, revision, contract_json, contract_sha256,
    repo_snapshot_json, source_request_sha256, created_by, created_at
  ) VALUES ('plan-1', 'project', 1, '{}', '${"a".repeat(64)}', '{}', '${"b".repeat(64)}', 'owner', 2)`);
  let duplicateRejected = false;
  try {
    await check.execute(`INSERT INTO project_install_plans (
      id, project_id, revision, contract_json, contract_sha256,
      repo_snapshot_json, source_request_sha256, created_by, created_at
    ) VALUES ('plan-2', 'project', 1, '{}', '${"c".repeat(64)}', '{}', '${"d".repeat(64)}', 'owner', 2)`);
  } catch {
    duplicateRejected = true;
  }
  if (!duplicateRejected) throw new Error("duplicate project plan revision was accepted");
  check.close();
  console.log("install-plan revision migration self-test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
