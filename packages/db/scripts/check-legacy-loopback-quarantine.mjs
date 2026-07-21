import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

import {
  LEGACY_LOOPBACK_QUARANTINE_FILE_ENV,
  LEGACY_LOOPBACK_QUARANTINE_SHA_ENV,
  isExactLoopbackPostHogHost,
  legacyLoopbackFixtureBinding,
  reconcileLegacyLoopbackBindings,
} from "./core-legacy-loopback-quarantine.mjs";
import {
  runCoreMigrations,
  verifyCoreMigrations,
} from "./core-migration-lifecycle.mjs";
import { baselineStatements } from "./core-schema-baseline.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const directory = mkdtempSync(join(tmpdir(), "agentry-loopback-quarantine-"));
const reviewRef = "backup:test-loopback-quarantine-20260713";
const backupRef = `sha256:${"a".repeat(64)}`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixtureEnvironment(name, rows, transform = (fixture) => fixture) {
  const path = join(directory, `${name}.json`);
  const fixture = transform({
    schema_version: 1,
    review_ref: reviewRef,
    backup_ref: backupRef,
    bindings: rows.map(legacyLoopbackFixtureBinding),
  });
  const raw = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(path, raw, { mode: 0o600 });
  return {
    [LEGACY_LOOPBACK_QUARANTINE_FILE_ENV]: path,
    [LEGACY_LOOPBACK_QUARANTINE_SHA_ENV]: sha256(raw),
  };
}

async function seedLegacyDatabase(name, rows) {
  const databaseUrl = `file:${join(directory, `${name}.db`)}`;
  const baseline = baselineStatements(readFileSync(
    join(here, "fixtures/20260713_pre_read_only_core_baseline.sql"),
    "utf8",
  ));
  const client = createClient({ url: databaseUrl });
  try {
    await client.batch(baseline, "write");
    await client.batch([
      "DROP TRIGGER IF EXISTS project_posthog_bindings_immutable_update_guard",
      "DROP TRIGGER IF EXISTS project_posthog_bindings_fenced_delete_guard",
      "DROP TRIGGER IF EXISTS project_posthog_bindings_identity_insert_guard",
      "DROP INDEX IF EXISTS project_posthog_bindings_ph_resource_idx",
      "DROP INDEX IF EXISTS project_posthog_bindings_ph_id_idx",
      "DROP TABLE project_posthog_bindings",
      `CREATE TABLE project_posthog_bindings (
        project_id text PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        posthog_project_id integer NOT NULL,
        posthog_project_api_key text NOT NULL,
        read_token_enc text,
        read_token_iv text,
        posthog_host text NOT NULL,
        created_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX project_posthog_bindings_ph_id_idx
        ON project_posthog_bindings (posthog_project_id)`,
    ], "write");
    for (const row of rows) {
      await client.batch([
        {
          sql: "INSERT INTO users (id) VALUES (?)",
          args: [`user-${row.project_id}`],
        },
        {
          sql: `INSERT INTO projects (id, user_id, name, dsn_prefix, dsn_hash)
                VALUES (?, ?, ?, ?, ?)`,
          args: [
            row.project_id,
            `user-${row.project_id}`,
            `Project ${row.project_id}`,
            `agentry_pk_${row.project_id}`,
            `hash-${row.project_id}`,
          ],
        },
        {
          sql: `INSERT INTO project_posthog_bindings (
                  project_id, posthog_project_id, posthog_project_api_key,
                  read_token_enc, read_token_iv, posthog_host, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            row.project_id,
            row.posthog_project_id,
            row.posthog_project_api_key,
            row.read_token_enc,
            row.read_token_iv,
            row.posthog_host,
            row.created_at,
          ],
        },
      ], "write");
    }
  } finally {
    client.close();
  }
  return databaseUrl;
}

async function inspect(databaseUrl) {
  const client = createClient({ url: databaseUrl });
  try {
    const [bindings, quarantine, receipt, projects, ledger] = await Promise.all([
      client.execute(
        "SELECT project_id, posthog_host FROM project_posthog_bindings ORDER BY project_id",
      ).catch(() => ({ rows: [] })),
      client.execute(
        `SELECT project_id, posthog_project_api_key, read_token_enc, read_token_iv,
                posthog_host, raw_row_sha256, fixture_sha256, review_ref, backup_ref
           FROM _agentry_core_legacy_posthog_binding_quarantine
          ORDER BY project_id`,
      ).catch(() => ({ rows: [] })),
      client.execute(
        `SELECT fixture_sha256, review_ref, backup_ref, source_row_count
           FROM _agentry_core_legacy_posthog_binding_quarantine_receipt`,
      ).catch(() => ({ rows: [] })),
      client.execute("SELECT id FROM projects ORDER BY id"),
      client.execute(
        "SELECT sequence, migration_id FROM _agentry_core_migrations ORDER BY sequence",
      ).catch(() => ({ rows: [] })),
    ]);
    return {
      bindings: bindings.rows,
      quarantine: quarantine.rows,
      receipt: receipt.rows,
      projects: projects.rows,
      ledger: ledger.rows,
    };
  } finally {
    client.close();
  }
}

const loopbackA = {
  project_id: "loopback-a",
  posthog_project_id: 41,
  posthog_project_api_key: "phc_loopback_a",
  read_token_enc: "encrypted-loopback-a",
  read_token_iv: "iv-loopback-a",
  posthog_host: "http://127.0.0.1:49159",
  created_at: 1_720_000_001,
};
const loopbackB = {
  project_id: "loopback-b",
  posthog_project_id: 42,
  posthog_project_api_key: "phc_loopback_b",
  read_token_enc: null,
  read_token_iv: null,
  posthog_host: "http://localhost:8910",
  created_at: 1_720_000_002,
};
const remote = {
  project_id: "remote-a",
  posthog_project_id: 43,
  posthog_project_api_key: "phc_remote_a",
  read_token_enc: "encrypted-remote-a",
  read_token_iv: "iv-remote-a",
  posthog_host: "https://posthog.agentry.sh",
  created_at: 1_720_000_003,
};

try {
  for (const host of [
    "HTTP://LOCALHOST:80/path",
    "http://127.0.0.1.",
    "http://2130706433",
    "http://0x7f000001",
    "http://[0:0:0:0:0:0:0:1]",
    "http://%6cocalhost",
    "http://localhost\\path",
  ]) {
    assert.equal(isExactLoopbackPostHogHost(host), true, `missed loopback host ${host}`);
  }
  for (const host of [
    "https://posthog.agentry.sh",
    "http://127.0.0.10",
    "http://localhost.evil.example",
    "http://user:pass@localhost",
    "http://localhost/?token=unsafe",
  ]) {
    assert.equal(isExactLoopbackPostHogHost(host), false, `accepted non-exact loopback host ${host}`);
  }

  const noop = join(directory, "noop.mjs");
  const noopSecond = join(directory, "noop-second.mjs");
  writeFileSync(noop, "// adoption receipt fixture\n");
  writeFileSync(noopSecond, "// later migration fixture\n");
  const manifest = [{ id: "test_0001_quarantine", script: noop }];

  // The move is exact and narrow: only fixture-matched loopback bindings leave
  // the live table, while their raw values and the owning projects survive.
  const successUrl = await seedLegacyDatabase("success", [loopbackA, remote]);
  const successEnv = fixtureEnvironment("success", [loopbackA]);
  const success = await runCoreMigrations({
    databaseUrl: successUrl,
    manifest,
    root: packageRoot,
    reviewedLegacyBaseline: true,
    reviewRef,
    childEnv: successEnv,
  });
  assert.deepEqual(success, { baselineKind: "legacy_reviewed", appliedCount: 1 });
  const afterSuccess = await inspect(successUrl);
  assert.deepEqual(
    afterSuccess.bindings.map((row) => String(row.project_id)),
    [remote.project_id],
  );
  assert.deepEqual(
    afterSuccess.projects.map((row) => String(row.id)),
    [loopbackA.project_id, remote.project_id],
    "quarantine deleted an owning project",
  );
  assert.equal(afterSuccess.quarantine.length, 1);
  assert.equal(String(afterSuccess.quarantine[0].posthog_project_api_key), loopbackA.posthog_project_api_key);
  assert.equal(String(afterSuccess.quarantine[0].read_token_enc), loopbackA.read_token_enc);
  assert.equal(String(afterSuccess.quarantine[0].read_token_iv), loopbackA.read_token_iv);
  assert.equal(String(afterSuccess.quarantine[0].review_ref), reviewRef);
  assert.equal(String(afterSuccess.quarantine[0].backup_ref), backupRef);
  assert.equal(afterSuccess.receipt.length, 1);
  assert.equal(Number(afterSuccess.receipt[0].source_row_count), 1);
  await verifyCoreMigrations({ databaseUrl: successUrl, manifest, root: packageRoot });

  // Lost migration-receipt recovery reattests the durable quarantine receipt
  // and never inserts or deletes the raw row twice.
  const lostReceiptClient = createClient({ url: successUrl });
  try {
    await lostReceiptClient.execute("DELETE FROM _agentry_core_migrations WHERE sequence = 1");
  } finally {
    lostReceiptClient.close();
  }
  await runCoreMigrations({
    databaseUrl: successUrl,
    manifest,
    root: packageRoot,
    childEnv: successEnv,
  });
  const afterRetry = await inspect(successUrl);
  assert.equal(afterRetry.quarantine.length, 1);
  assert.equal(afterRetry.receipt.length, 1);
  assert.equal(afterRetry.ledger.length, 1);

  // A client can lose the response after the atomic quarantine batch commits.
  // The next call recovers from the durable receipt without moving data twice.
  const lostBatchUrl = await seedLegacyDatabase("lost-batch-response", [loopbackA, remote]);
  const lostBatchEnv = fixtureEnvironment("lost-batch-response", [loopbackA]);
  const lostBatchClient = createClient({ url: lostBatchUrl });
  let droppedCommittedResponse = false;
  const responseDroppingClient = {
    execute: (...args) => lostBatchClient.execute(...args),
    batch: async (...args) => {
      const result = await lostBatchClient.batch(...args);
      if (!droppedCommittedResponse) {
        droppedCommittedResponse = true;
        throw new Error("simulated committed quarantine response loss");
      }
      return result;
    },
  };
  await assert.rejects(
    reconcileLegacyLoopbackBindings({
      client: responseDroppingClient,
      baselineKind: "legacy_reviewed",
      baselineReviewRef: reviewRef,
      appliedCount: 0,
      env: lostBatchEnv,
    }),
    /simulated committed quarantine response loss/,
  );
  const recovered = await reconcileLegacyLoopbackBindings({
    client: lostBatchClient,
    baselineKind: "legacy_reviewed",
    baselineReviewRef: reviewRef,
    appliedCount: 0,
    env: lostBatchEnv,
  });
  assert.equal(recovered?.idempotentReplay, true);
  lostBatchClient.close();
  const afterLostBatch = await inspect(lostBatchUrl);
  assert.equal(afterLostBatch.bindings.length, 1);
  assert.equal(afterLostBatch.quarantine.length, 1);
  assert.equal(afterLostBatch.receipt.length, 1);

  // Missing, hash-mismatched, and incomplete evidence all stop before the
  // first migration receipt and preserve every source binding.
  const missingUrl = await seedLegacyDatabase("missing", [loopbackA]);
  await assert.rejects(
    runCoreMigrations({
      databaseUrl: missingUrl,
      manifest,
      root: packageRoot,
      reviewedLegacyBaseline: true,
      reviewRef,
      childEnv: {},
    }),
    /require a reviewed full AGENTRY_LEGACY_LOOPBACK_QUARANTINE_FILE/,
  );
  assert.equal((await inspect(missingUrl)).bindings.length, 1);
  assert.equal((await inspect(missingUrl)).ledger.length, 0);

  const wrongShaUrl = await seedLegacyDatabase("wrong-sha", [loopbackA]);
  const wrongShaEnv = {
    ...fixtureEnvironment("wrong-sha", [loopbackA]),
    [LEGACY_LOOPBACK_QUARANTINE_SHA_ENV]: "0".repeat(64),
  };
  await assert.rejects(
    runCoreMigrations({
      databaseUrl: wrongShaUrl,
      manifest,
      root: packageRoot,
      reviewedLegacyBaseline: true,
      reviewRef,
      childEnv: wrongShaEnv,
    }),
    /fixture SHA-256 mismatch/,
  );
  assert.equal((await inspect(wrongShaUrl)).bindings.length, 1);
  assert.equal((await inspect(wrongShaUrl)).ledger.length, 0);

  const incompleteUrl = await seedLegacyDatabase("incomplete", [loopbackA, loopbackB, remote]);
  await assert.rejects(
    runCoreMigrations({
      databaseUrl: incompleteUrl,
      manifest,
      root: packageRoot,
      reviewedLegacyBaseline: true,
      reviewRef,
      childEnv: fixtureEnvironment("incomplete", [loopbackA]),
    }),
    /provide one full reviewed snapshot/,
  );
  const afterIncomplete = await inspect(incompleteUrl);
  assert.equal(afterIncomplete.bindings.length, 3);
  assert.equal(afterIncomplete.quarantine.length, 0);
  assert.equal(afterIncomplete.ledger.length, 0);

  // A binding introduced after any migration receipt is too late for this
  // one-time adoption path, even with an otherwise exact fixture.
  const lateUrl = await seedLegacyDatabase("late", [remote]);
  await runCoreMigrations({
    databaseUrl: lateUrl,
    manifest,
    root: packageRoot,
    reviewedLegacyBaseline: true,
    reviewRef,
    childEnv: {},
  });
  const lateClient = createClient({ url: lateUrl });
  try {
    await lateClient.batch([
      {
        sql: "INSERT INTO users (id) VALUES (?)",
        args: [`user-${loopbackA.project_id}`],
      },
      {
        sql: `INSERT INTO projects (id, user_id, name, dsn_prefix, dsn_hash)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          loopbackA.project_id,
          `user-${loopbackA.project_id}`,
          "Late loopback",
          `agentry_pk_${loopbackA.project_id}`,
          `hash-${loopbackA.project_id}`,
        ],
      },
      {
        sql: `INSERT INTO project_posthog_bindings (
                project_id, posthog_project_id, posthog_project_api_key,
                read_token_enc, read_token_iv, posthog_host, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          loopbackA.project_id,
          loopbackA.posthog_project_id,
          loopbackA.posthog_project_api_key,
          loopbackA.read_token_enc,
          loopbackA.read_token_iv,
          loopbackA.posthog_host,
          loopbackA.created_at,
        ],
      },
    ], "write");
  } finally {
    lateClient.close();
  }
  await assert.rejects(
    runCoreMigrations({
      databaseUrl: lateUrl,
      manifest: [...manifest, { id: "test_0002_late", script: noopSecond }],
      root: packageRoot,
      childEnv: fixtureEnvironment("late", [loopbackA]),
    }),
    /only before the first core migration receipt/,
  );
  const afterLate = await inspect(lateUrl);
  assert.equal(afterLate.bindings.length, 2);
  assert.equal(afterLate.quarantine.length, 0);
  assert.equal(afterLate.ledger.length, 1);

  // The real manifest converges after quarantine and whole-schema verification
  // tolerates only the two internal tables and their implicit autoindexes.
  const fullUrl = await seedLegacyDatabase("full-manifest", [loopbackA, remote]);
  const fullQuarantineEnv = fixtureEnvironment("full-manifest-quarantine", [loopbackA]);
  const identityPath = join(directory, "full-manifest-identities.json");
  const identityRaw = `${JSON.stringify({
    schema_version: 1,
    review_ref: "provider-export:test-loopback-quarantine-20260713",
    bindings: [{
      agentry_project_id: remote.project_id,
      posthog_host: remote.posthog_host,
      posthog_org_id: "production-org",
      posthog_environment_id: remote.posthog_project_id,
      posthog_project_resource_id: 143,
      posthog_project_api_key_sha256: sha256(remote.posthog_project_api_key),
    }],
  }, null, 2)}\n`;
  writeFileSync(identityPath, identityRaw, { mode: 0o600 });
  await runCoreMigrations({
    databaseUrl: fullUrl,
    reviewedLegacyBaseline: true,
    reviewRef,
    childEnv: {
      ...fullQuarantineEnv,
      AGENTRY_POSTHOG_BINDING_BACKFILL_HOST: remote.posthog_host,
      AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID: "production-org",
      AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE: identityPath,
      AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256: sha256(identityRaw),
    },
  });
  const fullVerification = await verifyCoreMigrations({ databaseUrl: fullUrl });
  assert.equal(fullVerification.baselineKind, "legacy_reviewed");
  assert.ok(fullVerification.runtimeInvariants?.fingerprint);
  const afterFull = await inspect(fullUrl);
  assert.equal(afterFull.bindings.length, 0);
  assert.equal(afterFull.quarantine.length, 0);
  assert.equal(afterFull.projects.length, 2);

  console.log("legacy loopback quarantine lifecycle checks passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
