import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

const directory = mkdtempSync(join(tmpdir(), "agentry-posthog-identity-"));
const databasePath = join(directory, "test.db");
const url = `file:${databasePath}`;
const migration = fileURLToPath(
  new URL("./migrate-add-posthog-binding-resource-identities.ts", import.meta.url),
);
const HISTORICAL_POSTHOG_BINDING_TRIGGER_SHA256 = Object.freeze({
  project_posthog_bindings_identity_insert_guard:
    "ee97ec78da010e6a98c3794523d26c6b3d6d8a7e0314ac7570aa31e596c6e52f",
  project_posthog_bindings_immutable_update_guard:
    "d9534c1450c13501b7a6d5a16fed36dea887507edf8051406f9d21d67276e04c",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanEnv(overrides = {}, databaseUrl = url) {
  const env = { ...process.env };
  delete env.AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE;
  delete env.AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256;
  return { ...env, TURSO_DATABASE_URL: databaseUrl, TURSO_AUTH_TOKEN: "", ...overrides };
}

function run(extraEnv = {}, databaseUrl = url) {
  return spawnSync(process.execPath, nodeScriptArgs(migration), {
    env: cleanEnv(extraEnv, databaseUrl),
    encoding: "utf8",
  });
}

function fixture(bindings, name) {
  const file = join(directory, `${name}.json`);
  const raw = `${JSON.stringify({
    schema_version: 1,
    review_ref: `provider-export:${name}`,
    bindings,
  }, null, 2)}\n`;
  writeFileSync(file, raw);
  return {
    AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE: file,
    AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256: sha256(raw),
  };
}

function binding({
  agentryProjectId,
  host,
  orgId,
  environmentId,
  projectResourceId,
  apiKey,
}) {
  return {
    agentry_project_id: agentryProjectId,
    posthog_host: host,
    posthog_org_id: orgId,
    posthog_environment_id: environmentId,
    posthog_project_resource_id: projectResourceId,
    posthog_project_api_key_sha256: sha256(apiKey),
  };
}

const legacy = binding({
  agentryProjectId: "project-legacy",
  host: "https://posthog.example",
  orgId: "org-test",
  environmentId: 41,
  projectResourceId: 141,
  apiKey: "phc_public_legacy",
});
const ready = binding({
  agentryProjectId: "project-ready",
  host: "https://posthog.example",
  orgId: "org-test",
  environmentId: 42,
  projectResourceId: 142,
  apiKey: "phc_public_ready",
});
// The runtime request authority is host + /api/projects/{resourceId}. The same
// number on a different host is legal and must not collide globally.
const otherTarget = binding({
  agentryProjectId: "project-other-target",
  host: "https://eu.posthog.example",
  orgId: "org-eu",
  environmentId: 43,
  projectResourceId: 141,
  apiKey: "phc_public_other",
});

try {
  // If pre-existing complete rows collide under the canonical host+resource
  // authority, index creation fails. The migration's one write transaction
  // must roll back both trigger drops as well as every other DDL/DML statement.
  const collisionUrl = `file:${join(directory, "collision.db")}`;
  const collision = createClient({ url: collisionUrl });
  await collision.batch([
    "CREATE TABLE projects (id text PRIMARY KEY)",
    `CREATE TABLE project_posthog_bindings (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      posthog_project_id integer NOT NULL,
      posthog_project_resource_id integer,
      posthog_org_id text,
      posthog_project_api_key text NOT NULL,
      posthog_host text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE UNIQUE INDEX project_posthog_bindings_ph_id_idx
      ON project_posthog_bindings (posthog_project_id)`,
    "INSERT INTO projects (id) VALUES ('collision-a'), ('collision-b')",
    `INSERT INTO project_posthog_bindings (
      project_id, posthog_project_id, posthog_project_resource_id,
      posthog_org_id, posthog_project_api_key, posthog_host
    ) VALUES
      ('collision-a', 51, 151, 'org-a', 'phc_collision_a', 'https://same.posthog.example'),
      ('collision-b', 52, 151, 'org-b', 'phc_collision_b', 'https://same.posthog.example')`,
    `CREATE TRIGGER project_posthog_bindings_immutable_update_guard
      BEFORE UPDATE ON project_posthog_bindings
      BEGIN
        SELECT RAISE(ABORT, 'project_posthog_bindings rows are immutable');
      END`,
    `CREATE TRIGGER project_posthog_bindings_identity_insert_guard
      BEFORE INSERT ON project_posthog_bindings
      WHEN NEW.posthog_project_id < 1
        OR NEW.posthog_project_resource_id IS NULL
        OR NEW.posthog_project_resource_id < 1
        OR NEW.posthog_org_id IS NULL
        OR trim(NEW.posthog_org_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'project_posthog_bindings requires exact provider identity');
      END`,
  ], "write");
  collision.close();

  const collisionFailure = run({}, collisionUrl);
  assert.notEqual(collisionFailure.status, 0, "same-host resource collision migrated");
  assert.match(
    `${collisionFailure.stderr}\n${collisionFailure.stdout}`,
    /UNIQUE constraint failed|SQLITE_CONSTRAINT/,
  );
  const collisionProbe = createClient({ url: collisionUrl });
  const survivingGuards = await collisionProbe.execute(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'project_posthog_bindings_immutable_update_guard',
          'project_posthog_bindings_identity_insert_guard'
        )
      ORDER BY name`,
  );
  assert.equal(survivingGuards.rows.length, 2, "uniqueness rollback lost a binding guard");
  for (const row of survivingGuards.rows) {
    const name = String(row.name);
    assert.equal(
      sha256(String(row.sql ?? "").replace(/\s+/g, " ").trim()),
      HISTORICAL_POSTHOG_BINDING_TRIGGER_SHA256[name],
      `uniqueness rollback changed ${name}`,
    );
  }
  const rolledBackIndex = await collisionProbe.execute(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'project_posthog_bindings_ph_resource_idx'",
  );
  assert.equal(rolledBackIndex.rows.length, 0, "failed unique index escaped its transaction");
  collisionProbe.close();

  const setup = createClient({ url });
  await setup.batch([
    "PRAGMA foreign_keys = ON",
    "CREATE TABLE projects (id text PRIMARY KEY)",
    `CREATE TABLE project_posthog_bindings (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      posthog_project_id integer NOT NULL,
      posthog_project_resource_id integer,
      posthog_org_id text,
      posthog_project_api_key text NOT NULL,
      posthog_host text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE UNIQUE INDEX project_posthog_bindings_ph_id_idx
      ON project_posthog_bindings (posthog_project_id)`,
    `CREATE TRIGGER project_posthog_bindings_immutable_update_guard
      BEFORE UPDATE ON project_posthog_bindings
      BEGIN
        SELECT RAISE(ABORT, 'project_posthog_bindings rows are immutable');
      END`,
    "INSERT INTO projects (id) VALUES ('project-legacy'), ('project-ready'), ('project-other-target')",
    `INSERT INTO project_posthog_bindings (
      project_id, posthog_project_id, posthog_project_resource_id,
      posthog_org_id, posthog_project_api_key, posthog_host
    ) VALUES
      ('project-legacy', 41, NULL, 'org-test', 'phc_public_legacy', 'https://posthog.example/'),
      ('project-ready', 42, 142, 'org-test', 'phc_public_ready', 'https://posthog.example'),
      ('project-other-target', 43, 141, 'org-eu', 'phc_public_other', 'https://eu.posthog.example')`,
  ], "write");
  setup.close();

  const missing = run();
  assert.notEqual(missing.status, 0, "legacy NULL identity migrated without reviewed fixture");
  assert.match(missing.stderr, /AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE/);

  for (const [name, changed, message] of [
    ["wrong-host", { ...legacy, posthog_host: "https://wrong.posthog.example" }, /host mismatch/],
    ["wrong-org", { ...legacy, posthog_org_id: "wrong-org" }, /organization id mismatch/],
    ["wrong-environment", { ...legacy, posthog_environment_id: 999 }, /environment\/team id mismatch/],
    [
      "wrong-token-hash",
      { ...legacy, posthog_project_api_key_sha256: "f".repeat(64) },
      /project API key hash mismatch/,
    ],
  ]) {
    const result = run(fixture([changed, ready, otherTarget], name));
    assert.notEqual(result.status, 0, `${name} fixture unexpectedly succeeded`);
    assert.match(result.stderr, message);
  }

  const sameHostDifferentOrg = run(fixture([
    legacy,
    ready,
    {
      ...otherTarget,
      posthog_host: legacy.posthog_host,
      posthog_project_resource_id: legacy.posthog_project_resource_id,
    },
  ], "same-host-different-org-resource-collision"));
  assert.notEqual(
    sameHostDifferentOrg.status,
    0,
    "same host/resource id was accepted merely because organization differed",
  );
  assert.match(
    sameHostDifferentOrg.stderr,
    /duplicate posthog_host\/posthog_project_resource_id/,
  );

  const reviewed = fixture([legacy, ready, otherTarget], "reviewed-exact");
  const first = run(reviewed);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.deepEqual(JSON.parse(first.stdout.trim().split("\n").at(-1)), {
    migration: "posthog_binding_resource_identity",
    review_ref: "provider-export:reviewed-exact",
    fixture_sha256: reviewed.AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256,
    updated_rows: 1,
    verified_rows: 3,
  });
  const second = run(reviewed);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(
    JSON.parse(second.stdout.trim().split("\n").at(-1)).updated_rows,
    0,
    "exact rerun did not report a no-op",
  );
  const noFixtureRerun = run();
  assert.equal(noFixtureRerun.status, 0, noFixtureRerun.stderr || noFixtureRerun.stdout);

  const wrongResourceAfterCommit = run(fixture([
    { ...legacy, posthog_project_resource_id: 999 },
    ready,
    otherTarget,
  ], "wrong-resource-after-commit"));
  assert.notEqual(wrongResourceAfterCommit.status, 0, "immutable resource-id mismatch succeeded");
  assert.match(wrongResourceAfterCommit.stderr, /project resource id mismatch/);

  const verified = createClient({ url });
  const rows = await verified.execute(
    `SELECT project_id, posthog_project_resource_id, posthog_org_id
       FROM project_posthog_bindings ORDER BY project_id`,
  );
  assert.deepEqual(rows.rows.map((row) => ({
    projectId: String(row.project_id),
    resourceId: Number(row.posthog_project_resource_id),
    orgId: String(row.posthog_org_id),
  })), [
    { projectId: "project-legacy", resourceId: 141, orgId: "org-test" },
    { projectId: "project-other-target", resourceId: 141, orgId: "org-eu" },
    { projectId: "project-ready", resourceId: 142, orgId: "org-test" },
  ]);
  const index = await verified.execute(
    "PRAGMA index_info(project_posthog_bindings_ph_resource_idx)",
  );
  assert.deepEqual(
    index.rows.map((row) => String(row.name)),
    ["posthog_host", "posthog_project_resource_id"],
  );

  await assert.rejects(
    verified.execute(
      "UPDATE project_posthog_bindings SET posthog_project_resource_id = 999 WHERE project_id = 'project-legacy'",
    ),
    /immutable/,
  );
  await verified.execute("INSERT INTO projects (id) VALUES ('project-incomplete')");
  await assert.rejects(
    verified.execute(
      `INSERT INTO project_posthog_bindings (
        project_id, posthog_project_id, posthog_project_resource_id,
        posthog_org_id, posthog_project_api_key, posthog_host
      ) VALUES ('project-incomplete', 44, NULL, 'org-test', 'phc_incomplete', 'https://posthog.example')`,
    ),
    /requires exact provider identity/,
  );
  verified.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log("posthog binding resource identity migration: ok");
