import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const directory = await mkdtemp(join(tmpdir(), "agentry-posthog-guards-"));
const databasePath = join(directory, "test.db");
const url = `file:${databasePath}`;
const migration = fileURLToPath(new URL("./migrate-add-posthog-binding-guards.ts", import.meta.url));

try {
  const client = createClient({ url });
  await client.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE projects (id text PRIMARY KEY)",
    "CREATE TABLE mutation_commands (id text PRIMARY KEY)",
    `CREATE TABLE project_deletion_fences (
      project_id text PRIMARY KEY REFERENCES projects(id),
      command_id text NOT NULL,
      reason text NOT NULL,
      actor text NOT NULL
    )`,
    `CREATE TABLE project_posthog_bindings (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      posthog_project_id integer NOT NULL,
      posthog_project_api_key text NOT NULL,
      read_token_enc text NOT NULL,
      read_token_iv text NOT NULL,
      posthog_host text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    "INSERT INTO projects (id) VALUES ('project-legacy')",
    `INSERT INTO project_posthog_bindings (
      project_id, posthog_project_id, posthog_project_api_key,
      read_token_enc, read_token_iv, posthog_host
    ) VALUES (
      'project-legacy', 41, 'phc_public_legacy',
      'unused', 'unused', 'https://posthog.example/'
    )`,
  ], "write");
  client.close();

  for (let run = 0; run < 2; run += 1) {
    execFileSync(process.execPath, nodeScriptArgs(migration), {
      env: {
        ...process.env,
        TURSO_DATABASE_URL: url,
        AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID: "org-test",
        AGENTRY_POSTHOG_BINDING_BACKFILL_HOST: "https://posthog.example/",
      },
      stdio: "pipe",
    });
  }

  const verified = createClient({ url });
  const columns = await verified.execute("PRAGMA table_info(project_posthog_bindings)");
  if (!columns.rows.some((row) => row.name === "posthog_project_resource_id")) {
    throw new Error("posthog_project_resource_id migration missing");
  }
  if (!columns.rows.some((row) => row.name === "posthog_org_id")) {
    throw new Error("posthog_org_id migration missing");
  }
  if (columns.rows.some((row) => ["read_token_enc", "read_token_iv"].includes(String(row.name)))) {
    throw new Error("stale PostHog read-token columns remain");
  }
  const legacy = await verified.execute(
    "SELECT posthog_org_id FROM project_posthog_bindings WHERE project_id = 'project-legacy'",
  );
  if (legacy.rows[0]?.posthog_org_id !== "org-test") {
    throw new Error("explicit legacy PostHog organization backfill failed");
  }
  await verified.batch([
    { sql: "INSERT INTO projects (id) VALUES (?)", args: ["project-1"] },
    { sql: "INSERT INTO mutation_commands (id) VALUES (?)", args: ["command-1"] },
    {
      sql: `INSERT INTO project_posthog_bindings (
        project_id, posthog_project_id, posthog_project_resource_id, posthog_org_id,
        posthog_project_api_key, posthog_host
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["project-1", 42, 142, "org-test", "phc_public_test", "https://posthog.example"],
    },
    {
      sql: `INSERT INTO posthog_provision_targets (
        command_id, project_id, target_fingerprint
      ) VALUES (?, ?, ?)`,
      args: ["command-1", "project-1", "a".repeat(64)],
    },
  ], "write");

  await assertRejects(
    () => verified.execute("UPDATE project_posthog_bindings SET posthog_project_id = 43 WHERE project_id = 'project-1'"),
    "binding update",
  );
  await assertRejects(
    () => verified.execute("DELETE FROM project_posthog_bindings WHERE project_id = 'project-1'"),
    "unfenced binding delete",
  );
  await assertRejects(
    () => verified.execute("UPDATE posthog_provision_targets SET target_fingerprint = 'bbbb' WHERE command_id = 'command-1'"),
    "target update",
  );

  await verified.execute({
    sql: "INSERT INTO project_deletion_fences (project_id, command_id, reason, actor) VALUES (?, ?, ?, ?)",
    args: ["project-1", "delete-1", "project_delete", "test"],
  });
  await verified.execute("DELETE FROM project_posthog_bindings WHERE project_id = 'project-1'");
  const remaining = await verified.execute("SELECT count(*) AS n FROM project_posthog_bindings");
  if (Number(remaining.rows[0]?.n ?? -1) !== 1) throw new Error("fenced binding delete failed");
  verified.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

async function assertRejects(action, label) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

console.log("posthog binding/target guard migration: ok");
