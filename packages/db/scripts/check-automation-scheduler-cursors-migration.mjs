import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const migration = join(here, "migrate-add-automation-scheduler-cursors.ts");
const directory = mkdtempSync(join(tmpdir(), "agentry-scheduler-cursor-migration-"));
const url = `file:${join(directory, "legacy.sqlite")}`;

function runMigration() {
  execFileSync(process.execPath, nodeScriptArgs(migration), {
    env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: "" },
    stdio: "pipe",
  });
}

async function mustReject(label, operation) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${label} was accepted`);
}

try {
  const legacy = createClient({ url });
  await legacy.execute("CREATE TABLE projects (id text PRIMARY KEY)");
  legacy.close();

  runMigration();
  runMigration();

  const check = createClient({ url });
  const columns = await check.execute("PRAGMA table_info(automation_scheduler_cursors)");
  assert.deepEqual(
    columns.rows.map((row) => String(row.name)),
    ["sweep_name", "cursor_project_id", "revision", "updated_at"],
  );
  assert.equal(Number(columns.rows.find((row) => row.name === "sweep_name")?.pk), 1);
  assert.equal(Number(columns.rows.find((row) => row.name === "revision")?.notnull), 1);

  await check.execute(`INSERT INTO automation_scheduler_cursors (
    sweep_name, cursor_project_id, revision, updated_at
  ) VALUES ('trigger_contracts', NULL, 0, 10)`);
  const advanced = await check.execute({
    sql: `UPDATE automation_scheduler_cursors
             SET cursor_project_id = ?, revision = revision + 1, updated_at = ?
           WHERE sweep_name = ? AND revision = ? AND cursor_project_id IS NULL
           RETURNING revision`,
    args: ["project-0200", 11, "trigger_contracts", 0],
  });
  assert.equal(advanced.rows.length, 1);
  assert.equal(Number(advanced.rows[0]?.revision), 1);

  const stale = await check.execute({
    sql: `UPDATE automation_scheduler_cursors
             SET cursor_project_id = ?, revision = revision + 1, updated_at = ?
           WHERE sweep_name = ? AND revision = ? AND cursor_project_id IS NULL
           RETURNING revision`,
    args: ["project-stale", 12, "trigger_contracts", 0],
  });
  assert.equal(stale.rows.length, 0, "a stale invocation rewound the durable continuation");
  const stored = await check.execute(
    "SELECT cursor_project_id, revision FROM automation_scheduler_cursors WHERE sweep_name = 'trigger_contracts'",
  );
  assert.equal(String(stored.rows[0]?.cursor_project_id), "project-0200");
  assert.equal(Number(stored.rows[0]?.revision), 1);

  await mustReject("negative scheduler cursor revision", () => check.execute(
    "UPDATE automation_scheduler_cursors SET revision = -1 WHERE sweep_name = 'trigger_contracts'",
  ));
  await mustReject("duplicate scheduler sweep cursor", () => check.execute(
    "INSERT INTO automation_scheduler_cursors (sweep_name) VALUES ('trigger_contracts')",
  ));
  check.close();
  console.log("automation scheduler cursor migration self-test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
