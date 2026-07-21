import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";

import { bootstrapEmptyCoreDatabase } from "./bootstrap-empty-core-db.mjs";
import {
  LEGACY_LOOPBACK_QUARANTINE_FILE_ENV,
  LEGACY_LOOPBACK_QUARANTINE_SHA_ENV,
} from "./core-legacy-loopback-quarantine.mjs";
import {
  MAINTENANCE_API_URL_ENV,
  MAINTENANCE_ID_ENV,
  runCoreMigrations,
  verifyCoreMigrations,
} from "./core-migration-lifecycle.mjs";
import { CORE_MIGRATIONS } from "./core-migration-manifest.mjs";
import { baselineStatements, loadCoreBaseline } from "./core-schema-baseline.mjs";
import { CORE_SECURITY_TRIGGER_SHA256 } from "./core-runtime-invariants.mjs";
import { nodeScriptArgs, TYPESCRIPT_STRIP_FLAG } from "./node-script-args.mjs";
import { verifyCiAttributionBootstrapEligibility } from "./verify-ci-attribution-bootstrap-eligibility.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const bootstrapScript = join(here, "bootstrap-empty-core-db.mjs");
const coordinatorScript = join(here, "core-migration-lifecycle.mjs");
const bootstrapEligibilityScript = join(here, "verify-ci-attribution-bootstrap-eligibility.mjs");
const directory = mkdtempSync(join(tmpdir(), "agentry-core-db-lifecycle-"));
const legacyOwnerKey = `agentry_sk_${"b".repeat(32)}`;
const otherOwnerKey = `agentry_sk_${"c".repeat(32)}`;

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.AGENTRY_POSTHOG_BINDING_BACKFILL_HOST;
  delete env.AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID;
  delete env.AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE;
  delete env.AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256;
  delete env.AGENTRY_PRIVATE_API_KEY;
  delete env[LEGACY_LOOPBACK_QUARANTINE_FILE_ENV];
  delete env[LEGACY_LOOPBACK_QUARANTINE_SHA_ENV];
  delete env[MAINTENANCE_API_URL_ENV];
  delete env[MAINTENANCE_ID_ENV];
  return { ...env, ...overrides };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCli(script, databaseUrl, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, nodeScriptArgs(script, args), {
    cwd: packageRoot,
    env: cleanEnv({ TURSO_DATABASE_URL: databaseUrl, TURSO_AUTH_TOKEN: "", ...extraEnv }),
    encoding: "utf8",
  });
}

async function ledgerRows(databaseUrl) {
  const client = createClient({ url: databaseUrl });
  try {
    const result = await client.execute(
      `SELECT sequence, migration_id, script_path, script_checksum, manifest_checksum
         FROM _agentry_core_migrations ORDER BY sequence`,
    );
    return result.rows.map((row) => ({
      sequence: Number(row.sequence),
      migrationId: String(row.migration_id),
      scriptPath: String(row.script_path),
      scriptChecksum: String(row.script_checksum),
      manifestChecksum: String(row.manifest_checksum),
    }));
  } finally {
    client.close();
  }
}

try {
  assert.deepEqual(
    nodeScriptArgs("migration.ts", ["--fixture"]),
    [TYPESCRIPT_STRIP_FLAG, "migration.ts", "--fixture"],
    "Node 22.12 migration execution omitted the explicit type-stripping flag",
  );
  assert.deepEqual(
    nodeScriptArgs("coordinator.mjs", ["--verify-only"]),
    ["coordinator.mjs", "--verify-only"],
    "plain JavaScript execution unexpectedly received the TypeScript flag",
  );
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(packageJson.scripts).filter((name) => name.startsWith("db:migrate:")),
    ["db:migrate:core"],
    "the package must expose one canonical product migration command",
  );
  assert.equal(packageJson.scripts["db:deploy"], "npm run db:migrate:core");
  assert.equal(
    Object.values(packageJson.scripts).some((command) => /drizzle-kit\s+push/.test(command)),
    false,
    "package scripts exposed a general schema push",
  );
  const drizzleConfig = readFileSync(join(packageRoot, "drizzle.config.ts"), "utf8");
  assert.doesNotMatch(
    drizzleConfig,
    /dbCredentials|TURSO_DATABASE_URL|TURSO_AUTH_TOKEN/,
    "schema-generation config must not carry live database credentials",
  );
  const journal = JSON.parse(readFileSync(join(packageRoot, "drizzle/meta/_journal.json"), "utf8"));
  assert.ok(Array.isArray(journal.entries) && journal.entries.length > 0, "Drizzle journal is empty");
  assert.equal(journal.entries[0]?.tag, "0000_core_baseline", "Drizzle baseline journal entry drifted");
  const baseline = await loadCoreBaseline();
  assert.ok(baseline.statements.length > 0, "generated core baseline is empty");
  const legacyBaseline = baselineStatements(readFileSync(
    join(packageRoot, "scripts/fixtures/20260713_pre_read_only_core_baseline.sql"),
    "utf8",
  ));
  const productMigrationFiles = readdirSync(join(packageRoot, "scripts"))
    .filter((name) => /^migrate-.*\.(?:ts|mjs|js)$/.test(name))
    .sort();
  const manifestedFiles = [...new Set(CORE_MIGRATIONS.map((entry) => entry.script.replace("scripts/", "")))]
    .sort();
  assert.deepEqual(
    manifestedFiles,
    productMigrationFiles,
    "every product migration script must appear in the core manifest",
  );

  // Remote migrations fail before a database client can exist unless the
  // configured API is already serving the exact bounded maintenance proof.
  // These injected probes never open a remote database connection.
  const remoteDatabaseUrl = "libsql://core-db.example.invalid";
  const maintenanceApiUrl = "https://api.example.test/maintenance-proof";
  const maintenanceId = "core-migration-20260711";
  const proofManifest = [{
    id: "test_0000_maintenance_proof",
    script: join(directory, "maintenance-proof-never-read.mjs"),
  }];
  let remoteClientCreations = 0;
  const refusingRemoteClient = () => {
    remoteClientCreations += 1;
    throw new Error("test remote database client created");
  };
  const remoteAttempt = (overrides = {}) => runCoreMigrations({
    databaseUrl: remoteDatabaseUrl,
    manifest: proofManifest,
    root: packageRoot,
    createDatabaseClient: refusingRemoteClient,
    ...overrides,
  });

  await assert.rejects(
    remoteAttempt(),
    new RegExp(`${MAINTENANCE_ID_ENV} not set`),
  );
  await assert.rejects(
    remoteAttempt({ maintenanceId }),
    new RegExp(`${MAINTENANCE_API_URL_ENV} not set`),
  );
  await assert.rejects(
    remoteAttempt({
      maintenanceApiUrl,
      maintenanceId: "agentry_sk_not-a-maintenance-id",
    }),
    /must be an 8-128 character nonsecret maintenance identifier/,
  );
  assert.equal(remoteClientCreations, 0, "missing maintenance config created a remote client");

  await assert.rejects(
    remoteAttempt({
      maintenanceApiUrl,
      maintenanceId,
      maintenanceFetch: async () => ({
        status: 503,
        redirected: false,
        headers: new Headers({ "x-agentry-maintenance-id": "different-maintenance-id" }),
      }),
    }),
    /did not contain the exact x-agentry-maintenance-id/,
  );
  await assert.rejects(
    remoteAttempt({
      maintenanceApiUrl,
      maintenanceId,
      maintenanceFetch: async () => ({
        status: 302,
        redirected: false,
        headers: new Headers({ Location: "https://api.example.test/elsewhere" }),
      }),
    }),
    /expected HTTP 503, received 302/,
  );
  assert.equal(remoteClientCreations, 0, "wrong or redirected maintenance proof created a remote client");

  await assert.rejects(
    remoteAttempt({
      maintenanceApiUrl,
      maintenanceId,
      maintenanceFetch: async () => {
        throw new Error("simulated unreachable API");
      },
    }),
    /maintenance proof API is unreachable/,
  );
  await assert.rejects(
    remoteAttempt({
      maintenanceApiUrl,
      maintenanceId,
      maintenanceTimeoutMs: 5,
      maintenanceFetch: (_url, { signal }) => new Promise((resolvePromise, rejectPromise) => {
        signal.addEventListener("abort", () => rejectPromise(new Error("aborted")), { once: true });
      }),
    }),
    /maintenance proof timed out after 5ms/,
  );
  assert.equal(remoteClientCreations, 0, "unreachable maintenance proof created a remote client");

  let acceptedProbe;
  await assert.rejects(
    remoteAttempt({
      maintenanceApiUrl,
      maintenanceId,
      maintenanceFetch: async (url, init) => {
        acceptedProbe = { url, init };
        return {
          status: 503,
          redirected: false,
          headers: new Headers({ "x-agentry-maintenance-id": maintenanceId }),
        };
      },
    }),
    /test remote database client created/,
  );
  assert.equal(remoteClientCreations, 1, "exact maintenance proof did not admit the remote client");
  assert.equal(acceptedProbe?.url, maintenanceApiUrl, "maintenance probe changed the configured URL");
  assert.equal(acceptedProbe?.init.method, "GET");
  assert.equal(acceptedProbe?.init.redirect, "manual", "maintenance probe followed redirects");
  assert.equal(acceptedProbe?.init.cache, "no-store");
  assert.equal(acceptedProbe?.init.headers["Cache-Control"], "no-store");
  assert.equal(
    acceptedProbe?.init.headers["User-Agent"],
    "agentry-core-migration-maintenance-proof/1",
  );

  let verifyClientCreations = 0;
  await assert.rejects(
    verifyCoreMigrations({
      databaseUrl: remoteDatabaseUrl,
      manifest: proofManifest,
      root: packageRoot,
      createDatabaseClient: () => {
        verifyClientCreations += 1;
        throw new Error("test verify-only database client created");
      },
    }),
    /test verify-only database client created/,
  );
  assert.equal(
    verifyClientCreations,
    1,
    "read-only verification incorrectly required a maintenance proof",
  );

  // Empty bootstrap is create-only and one-shot. A second invocation must not
  // reinterpret a populated database as compatible.
  const emptyUrl = `file:${join(directory, "empty.db")}`;
  const firstBootstrap = runCli(bootstrapScript, emptyUrl);
  assert.equal(firstBootstrap.status, 0, firstBootstrap.stderr || firstBootstrap.stdout);
  const freshBootstrapProbe = createClient({ url: emptyUrl });
  try {
    const retired = await freshBootstrapProbe.execute(
      `SELECT type, name FROM sqlite_master WHERE name IN (
        'agent_runs', 'events', 'project_secrets', 'project_posthog_bindings',
        'posthog_error_capture_commands', 'posthog_provision_targets',
        'usage_counters', 'usage_snapshots', 'suppression_entries',
        'sourcemap_cleanup_outcomes', 'sourcemaps', 'sourcemap_objects',
        'sourcemap_release_states', 'sourcemap_commands', 'projects_dsn_hash_idx'
      )`,
    );
    assert.equal(retired.rows.length, 0, "fresh bootstrap created retired hosted-ingest storage");
    const ledger = await freshBootstrapProbe.execute(
      "SELECT COUNT(*) AS count FROM _agentry_core_migrations",
    );
    assert.equal(Number(ledger.rows[0]?.count ?? -1), 0, "bootstrap pre-recorded migration history");
  } finally {
    freshBootstrapProbe.close();
  }
  const secondBootstrap = runCli(bootstrapScript, emptyUrl);
  assert.notEqual(secondBootstrap.status, 0, "bootstrap accepted a nonempty database");
  assert.match(secondBootstrap.stderr, /refused a nonempty database/);
  await assert.rejects(
    verifyCiAttributionBootstrapEligibility({
      databaseUrl: emptyUrl,
      projectId: "not-relevant",
      reviewRef: "backup:must-not-adopt-empty-20260712",
      ownerApiKey: legacyOwnerKey,
    }),
    /same legacy-reviewed baseline and exact review reference/,
  );

  const emptyCoreFirst = runCli(coordinatorScript, emptyUrl);
  assert.equal(emptyCoreFirst.status, 0, emptyCoreFirst.stderr || emptyCoreFirst.stdout);
  assert.match(emptyCoreFirst.stdout, /folded into canonical empty bootstrap/);
  assert.doesNotMatch(emptyCoreFirst.stdout, /ensured project_secrets|sourcemap leases/);
  const emptyCoreSecond = runCli(coordinatorScript, emptyUrl);
  assert.equal(emptyCoreSecond.status, 0, emptyCoreSecond.stderr || emptyCoreSecond.stdout);
  assert.equal((await ledgerRows(emptyUrl)).length, CORE_MIGRATIONS.length);
  const emptyVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
  assert.equal(emptyVerify.status, 0, emptyVerify.stderr || emptyVerify.stdout);
  const triggerProbe = createClient({ url: emptyUrl });
  try {
    const triggers = await triggerProbe.execute(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    );
    const names = new Set(triggers.rows.map((row) => String(row.name)));
    assert.deepEqual(
      [...names].sort(),
      Object.keys(CORE_SECURITY_TRIGGER_SHA256).sort(),
      "every canonical runtime trigger must be covered by the immutable verifier",
    );
    for (const required of [
      "audit_log_no_update",
      "automation_runs_request_hash_insert_guard",
      "billing_mutation_targets_immutable_update_guard",
      "mutation_commands_insert_guard",
      "webhook_deliveries_source_event_insert_guard",
    ]) {
      assert.ok(names.has(required), `empty bootstrap plus core migrations omitted trigger ${required}`);
    }

    for (const triggerName of [
      "audit_log_no_update",
    ]) {
      const definition = await triggerProbe.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        args: [triggerName],
      });
      const triggerSql = String(definition.rows[0]?.sql ?? "");
      assert.ok(triggerSql.startsWith("CREATE TRIGGER"), `missing canonical SQL for ${triggerName}`);
      await triggerProbe.execute(`DROP TRIGGER ${triggerName}`);
      const missingTriggerVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
      assert.notEqual(missingTriggerVerify.status, 0, `verify accepted missing trigger ${triggerName}`);
      assert.match(missingTriggerVerify.stderr, new RegExp(`trigger invariant drift at ${triggerName}`));
      await triggerProbe.execute(triggerSql);
    }

    const retiredIngestArtifacts = await triggerProbe.execute(
      `SELECT type, name FROM sqlite_master
        WHERE name IN (
          'events',
          'project_secrets',
          'projects_dsn_hash_idx',
          'project_posthog_bindings',
          'posthog_error_capture_commands',
          'posthog_provision_targets',
          'usage_counters',
          'usage_snapshots',
          'suppression_entries',
          'sourcemap_cleanup_outcomes',
          'sourcemaps',
          'sourcemap_objects',
          'sourcemap_release_states',
          'sourcemap_commands',
          '_agentry_core_legacy_posthog_binding_quarantine',
          '_agentry_core_legacy_posthog_binding_quarantine_receipt'
        )`,
    );
    assert.equal(retiredIngestArtifacts.rows.length, 0);
    const projectColumns = await triggerProbe.execute("PRAGMA table_info(projects)");
    assert.equal(
      projectColumns.rows.some((row) => ["dsn_prefix", "dsn_hash"].includes(String(row.name))),
      false,
    );

    await triggerProbe.execute(
      "CREATE TABLE project_secrets (project_id text PRIMARY KEY, secret_enc text NOT NULL)",
    );
    const retiredStorageVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
    assert.notEqual(retiredStorageVerify.status, 0, "verify accepted retired hosted-ingest storage");
    assert.match(retiredStorageVerify.stderr, /left retired Agentry-hosted ingest storage/);
    await triggerProbe.execute("DROP TABLE project_secrets");

    await triggerProbe.execute(`
      CREATE TRIGGER injected_runtime_breakage
      BEFORE INSERT ON projects
      BEGIN
        SELECT RAISE(ABORT, 'blocked by injected trigger');
      END
    `);
    const unexpectedTriggerVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
    assert.notEqual(unexpectedTriggerVerify.status, 0, "verify accepted an unexpected runtime trigger");
    assert.match(
      unexpectedTriggerVerify.stderr,
      /security trigger invariant found unexpected trigger injected_runtime_breakage/,
    );
    await triggerProbe.execute("DROP TRIGGER injected_runtime_breakage");

    await triggerProbe.execute("CREATE UNIQUE INDEX injected_runtime_uniqueness ON projects (name)");
    const unexpectedIndexVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
    assert.notEqual(unexpectedIndexVerify.status, 0, "verify accepted an unexpected runtime index");
    assert.match(
      unexpectedIndexVerify.stderr,
      /schema invariant found unexpected index injected_runtime_uniqueness/,
    );
    await triggerProbe.execute("DROP INDEX injected_runtime_uniqueness");

    const commandDefinition = await triggerProbe.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'automation_workflow_commands'",
    );
    const commandSql = String(commandDefinition.rows[0]?.sql ?? "");
    const weakenedCommandSql = commandSql.replace(
      /\s+AND first_sequence = expected_revision \+ 1/,
      "",
    );
    assert.notEqual(weakenedCommandSql, commandSql, "command sequence CHECK fixture did not match");
    const schemaVersion = await triggerProbe.execute("PRAGMA schema_version");
    const priorSchemaVersion = Number(schemaVersion.rows[0]?.schema_version ?? 0);
    await triggerProbe.execute("PRAGMA writable_schema = ON");
    await triggerProbe.execute({
      sql: "UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'automation_workflow_commands'",
      args: [weakenedCommandSql],
    });
    await triggerProbe.execute("PRAGMA writable_schema = OFF");
    await triggerProbe.execute(`PRAGMA schema_version = ${priorSchemaVersion + 1}`);
    const weakenedCheckVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
    assert.notEqual(weakenedCheckVerify.status, 0, "verify accepted a weakened workflow command CHECK");
    assert.match(
      weakenedCheckVerify.stderr,
      /schema invariant table-definition drift at automation_workflow_commands/,
    );
    await triggerProbe.execute("PRAGMA writable_schema = ON");
    await triggerProbe.execute({
      sql: "UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'automation_workflow_commands'",
      args: [commandSql],
    });
    await triggerProbe.execute("PRAGMA writable_schema = OFF");
    await triggerProbe.execute(`PRAGMA schema_version = ${priorSchemaVersion + 2}`);

    await triggerProbe.execute(
      "ALTER TABLE projects ADD COLUMN injected_runtime_column text NOT NULL DEFAULT 'blocked'",
    );
    const unexpectedColumnVerify = runCli(coordinatorScript, emptyUrl, ["--verify-only"]);
    assert.notEqual(unexpectedColumnVerify.status, 0, "verify accepted an unexpected runtime column");
    assert.match(unexpectedColumnVerify.stderr, /schema invariant column count drift at projects/);
  } finally {
    triggerProbe.close();
  }

  // The PostHog resource-identity receipt is written only after the exact
  // two-column authority index and both canonical guards pass its own
  // post-check. Final whole-schema verification is deliberately not the first
  // place these security definitions are attested.
  const attestationNoop = join(directory, "posthog-attestation-noop.mjs");
  writeFileSync(attestationNoop, "// post-check fixture\n");
  const attestationCases = [
    {
      name: "immutable-trigger",
      statements: [
        "DROP TRIGGER project_posthog_bindings_immutable_update_guard",
        `CREATE TRIGGER project_posthog_bindings_immutable_update_guard
          BEFORE UPDATE ON project_posthog_bindings BEGIN SELECT 1; END`,
      ],
      error: /project_posthog_bindings_immutable_update_guard/,
    },
    {
      name: "identity-insert-trigger",
      statements: [
        "DROP TRIGGER project_posthog_bindings_identity_insert_guard",
        `CREATE TRIGGER project_posthog_bindings_identity_insert_guard
          BEFORE INSERT ON project_posthog_bindings BEGIN SELECT 1; END`,
      ],
      error: /project_posthog_bindings_identity_insert_guard/,
    },
    {
      name: "resource-index-scope",
      statements: [
        "DROP INDEX project_posthog_bindings_ph_resource_idx",
        `CREATE UNIQUE INDEX project_posthog_bindings_ph_resource_idx
          ON project_posthog_bindings (
            posthog_host, posthog_org_id, posthog_project_resource_id
          )`,
      ],
      error: /malformed PostHog project-resource identity index/,
    },
  ];
  for (const testCase of attestationCases) {
    const attestationUrl = `file:${join(directory, `attestation-${testCase.name}.db`)}`;
    await bootstrapEmptyCoreDatabase({ databaseUrl: attestationUrl });
    const legacyBindingFixture = createClient({ url: attestationUrl });
    try {
      await legacyBindingFixture.execute(`CREATE TABLE project_posthog_bindings (
        project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        posthog_project_id integer NOT NULL,
        posthog_project_api_key text NOT NULL,
        posthog_host text NOT NULL,
        posthog_org_id text,
        posthog_project_resource_id integer
      )`);
    } finally {
      legacyBindingFixture.close();
    }
    const installIdentityGuards = runCli(
      join(here, "migrate-add-posthog-binding-resource-identities.ts"),
      attestationUrl,
    );
    assert.equal(
      installIdentityGuards.status,
      0,
      installIdentityGuards.stderr || installIdentityGuards.stdout,
    );
    const attestationClient = createClient({ url: attestationUrl });
    try {
      await attestationClient.batch(testCase.statements, "write");
    } finally {
      attestationClient.close();
    }
    await assert.rejects(
      runCoreMigrations({
        databaseUrl: attestationUrl,
        manifest: [{
          id: `test_0010_${testCase.name.replaceAll("-", "_")}`,
          script: attestationNoop,
          postCheck: "posthog_binding_identity_attested",
        }],
        root: packageRoot,
        childEnv: cleanEnv(),
      }),
      testCase.error,
    );
    assert.equal(
      (await ledgerRows(attestationUrl)).length,
      0,
      `${testCase.name} drift was recorded before exact post-check attestation`,
    );
  }

  // A nonempty database without Agentry's own release ledger is legacy. It
  // must fail read-only until the operator supplies both explicit review
  // switches; after acceptance, the full ordered migration is rerunnable.
  const legacyUrl = `file:${join(directory, "legacy.db")}`;
  const legacyClient = createClient({ url: legacyUrl });
  try {
    await legacyClient.batch(legacyBaseline, "write");
    await legacyClient.batch([
      "INSERT INTO users (id) VALUES ('legacy-user')",
      "INSERT INTO users (id) VALUES ('other-user')",
      `INSERT INTO projects (id, user_id, name, dsn_prefix, dsn_hash)
       VALUES ('legacy-project', 'legacy-user', 'Legacy', 'agentry_pk_legacy', 'legacy-hash')`,
      `INSERT INTO api_keys (id, user_id, kind, prefix, key_hash)
       VALUES ('legacy-owner-key', 'legacy-user', 'private', 'agentry_sk_bbbbbbbb', '${sha256(legacyOwnerKey)}')`,
      `INSERT INTO api_keys (id, user_id, kind, prefix, key_hash)
       VALUES ('other-owner-key', 'other-user', 'private', 'agentry_sk_cccccccc', '${sha256(otherOwnerKey)}')`,
      `INSERT INTO project_posthog_bindings (
         project_id, posthog_project_id, posthog_project_api_key, posthog_host
       ) VALUES ('legacy-project', 42, 'phc_legacy', 'https://us.posthog.com')`,
    ], "write");
  } finally {
    legacyClient.close();
  }
  const eligibility = await verifyCiAttributionBootstrapEligibility({
    databaseUrl: legacyUrl,
    projectId: "legacy-project",
    reviewRef: "backup:test-core-20260710",
    ownerApiKey: legacyOwnerKey,
  });
  assert.deepEqual(eligibility, {
    ok: true,
    eligibility: "untracked_legacy_first_ci_credential",
    adoption_state: "untracked_legacy",
    project_id: "legacy-project",
    owner_key_binding: "active_private_project_owner",
    project_credentials: "empty",
  });
  const eligibilityCli = runCli(bootstrapEligibilityScript, legacyUrl, [], {
    AGENTRY_BOOTSTRAP_PROJECT_ID: "legacy-project",
    AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:test-core-20260710",
    AGENTRY_PRIVATE_API_KEY: legacyOwnerKey,
  });
  assert.equal(eligibilityCli.status, 0, eligibilityCli.stderr || eligibilityCli.stdout);
  assert.deepEqual(JSON.parse(eligibilityCli.stdout), eligibility);
  assert.doesNotMatch(eligibilityCli.stdout, new RegExp(legacyOwnerKey));
  assert.doesNotMatch(eligibilityCli.stdout, new RegExp(sha256(legacyOwnerKey)));
  const wrongOwnerCli = runCli(bootstrapEligibilityScript, legacyUrl, [], {
    AGENTRY_BOOTSTRAP_PROJECT_ID: "legacy-project",
    AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:test-core-20260710",
    AGENTRY_PRIVATE_API_KEY: otherOwnerKey,
  });
  assert.notEqual(wrongOwnerCli.status, 0, "unrelated active owner key passed eligibility");
  assert.doesNotMatch(wrongOwnerCli.stderr, new RegExp(otherOwnerKey));
  assert.doesNotMatch(wrongOwnerCli.stderr, new RegExp(sha256(otherOwnerKey)));
  await assert.rejects(
    verifyCiAttributionBootstrapEligibility({
      databaseUrl: legacyUrl,
      projectId: "wrong-project",
      reviewRef: "backup:test-core-20260710",
      ownerApiKey: legacyOwnerKey,
    }),
    /project does not exist exactly once/,
  );
  const credentialProbe = createClient({ url: legacyUrl });
  try {
    await assert.rejects(
      verifyCiAttributionBootstrapEligibility({
        databaseUrl: legacyUrl,
        projectId: "legacy-project",
        reviewRef: "backup:test-core-20260710",
        ownerApiKey: otherOwnerKey,
      }),
      /exactly one active private owner key bound to the exact project owner/,
    );
    await credentialProbe.execute(
      "UPDATE api_keys SET revoked_at = 1 WHERE id = 'legacy-owner-key'",
    );
    await assert.rejects(
      verifyCiAttributionBootstrapEligibility({
        databaseUrl: legacyUrl,
        projectId: "legacy-project",
        reviewRef: "backup:test-core-20260710",
        ownerApiKey: legacyOwnerKey,
      }),
      /exactly one active private owner key bound to the exact project owner/,
    );
    await credentialProbe.execute(
      "UPDATE api_keys SET revoked_at = NULL, kind = 'public' WHERE id = 'legacy-owner-key'",
    );
    await assert.rejects(
      verifyCiAttributionBootstrapEligibility({
        databaseUrl: legacyUrl,
        projectId: "legacy-project",
        reviewRef: "backup:test-core-20260710",
        ownerApiKey: legacyOwnerKey,
      }),
      /exactly one active private owner key bound to the exact project owner/,
    );
    await credentialProbe.execute(
      "UPDATE api_keys SET kind = 'private' WHERE id = 'legacy-owner-key'",
    );
    await credentialProbe.execute(`
      INSERT INTO project_credentials (
        id, project_id, kind, name, prefix, token_hash, expires_at
      ) VALUES (
        'legacy-ci', 'legacy-project', 'ci_deploy', 'legacy',
        'agentry_ci_legacy', 'legacy-token-hash', 2000000000
      )
    `);
    await assert.rejects(
      verifyCiAttributionBootstrapEligibility({
        databaseUrl: legacyUrl,
        projectId: "legacy-project",
        reviewRef: "backup:test-core-20260710",
        ownerApiKey: legacyOwnerKey,
      }),
      /zero project credential rows/,
    );
    await credentialProbe.execute("DELETE FROM project_credentials WHERE id = 'legacy-ci'");
  } finally {
    credentialProbe.close();
  }
  const refusedLegacy = runCli(coordinatorScript, legacyUrl);
  assert.notEqual(refusedLegacy.status, 0, "unreviewed legacy database was accepted");
  assert.match(refusedLegacy.stderr, /untracked nonempty database refused/);
  const legacyProbe = createClient({ url: legacyUrl });
  try {
    const metadata = await legacyProbe.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_agentry_core_baseline'",
    );
    assert.equal(metadata.rows.length, 0, "refused legacy preflight mutated the database");
  } finally {
    legacyProbe.close();
  }

  const reviewEnv = { AGENTRY_LEGACY_BASELINE_REVIEW_REF: "backup:test-core-20260710" };
  const unattestedLegacy = runCli(
    coordinatorScript,
    legacyUrl,
    ["--reviewed-legacy-baseline"],
    reviewEnv,
  );
  assert.notEqual(unattestedLegacy.status, 0, "unattested legacy PostHog binding passed");
  assert.match(unattestedLegacy.stderr, /without organization attestation/);
  assert.deepEqual(
    await verifyCiAttributionBootstrapEligibility({
      databaseUrl: legacyUrl,
      projectId: "legacy-project",
      reviewRef: "backup:test-core-20260710",
      ownerApiKey: legacyOwnerKey,
    }),
    {
      ok: true,
      eligibility: "untracked_legacy_first_ci_credential",
      adoption_state: "reviewed_legacy_retry",
      project_id: "legacy-project",
      owner_key_binding: "active_private_project_owner",
      project_credentials: "empty",
    },
  );
  await assert.rejects(
    verifyCiAttributionBootstrapEligibility({
      databaseUrl: legacyUrl,
      projectId: "legacy-project",
      reviewRef: "backup:different-review-20260712",
      ownerApiKey: legacyOwnerKey,
    }),
    /same legacy-reviewed baseline and exact review reference/,
  );
  const posthogIndex = CORE_MIGRATIONS.findIndex((entry) => entry.postCheck === "posthog_org_attested");
  assert.equal((await ledgerRows(legacyUrl)).length, posthogIndex);

  const identityBlocked = runCli(coordinatorScript, legacyUrl, [], {
    AGENTRY_POSTHOG_BINDING_BACKFILL_HOST: "https://us.posthog.com",
    AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID: "legacy-org",
  });
  assert.notEqual(identityBlocked.status, 0, "legacy NULL PostHog project-resource id passed");
  assert.match(
    identityBlocked.stderr,
    /AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE/,
  );
  const identityIndex = CORE_MIGRATIONS.findIndex(
    (entry) => entry.postCheck === "posthog_binding_identity_attested",
  );
  assert.ok(identityIndex > posthogIndex, "PostHog resource identity repair is not append-only");
  assert.equal((await ledgerRows(legacyUrl)).length, identityIndex);

  const identityFixture = join(directory, "legacy-posthog-identities.json");
  const identityFixtureRaw = `${JSON.stringify({
    schema_version: 1,
    review_ref: "provider-export:test-core-20260710",
    bindings: [{
      agentry_project_id: "legacy-project",
      posthog_host: "https://us.posthog.com",
      posthog_org_id: "legacy-org",
      posthog_environment_id: 42,
      posthog_project_resource_id: 142,
      posthog_project_api_key_sha256: sha256("phc_legacy"),
    }],
  }, null, 2)}\n`;
  writeFileSync(identityFixture, identityFixtureRaw);
  const legacyFirst = runCli(coordinatorScript, legacyUrl, [], {
    AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE: identityFixture,
    AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256: sha256(identityFixtureRaw),
  });
  assert.equal(legacyFirst.status, 0, legacyFirst.stderr || legacyFirst.stdout);
  const firstLedger = await ledgerRows(legacyUrl);
  assert.equal(firstLedger.length, CORE_MIGRATIONS.length);
  const legacySecond = runCli(coordinatorScript, legacyUrl);
  assert.equal(legacySecond.status, 0, legacySecond.stderr || legacySecond.stdout);
  assert.deepEqual(await ledgerRows(legacyUrl), firstLedger, "idempotent rerun changed migration history");
  const legacyVerify = runCli(coordinatorScript, legacyUrl, ["--verify-only"]);
  assert.equal(legacyVerify.status, 0, legacyVerify.stderr || legacyVerify.stdout);

  // A child failure must stop the manifest, leave no applied receipt, and
  // release the coordinator lease so a corrected release can be retried.
  const failureUrl = `file:${join(directory, "failure.db")}`;
  await bootstrapEmptyCoreDatabase({ databaseUrl: failureUrl });
  const failingScript = join(directory, "fail.mjs");
  const forbiddenScript = join(directory, "must-not-run.mjs");
  const sentinel = join(directory, "must-not-exist");
  writeFileSync(failingScript, "process.exit(23);\n");
  writeFileSync(
    forbiddenScript,
    "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TEST_SENTINEL_PATH, 'ran');\n",
  );
  await assert.rejects(
    runCoreMigrations({
      databaseUrl: failureUrl,
      manifest: [
        { id: "test_0001_failure", script: failingScript },
        { id: "test_0002_forbidden", script: forbiddenScript },
      ],
      root: packageRoot,
      childEnv: cleanEnv({ TEST_SENTINEL_PATH: sentinel }),
    }),
    /test_0001_failure failed.*exit 23/,
  );
  assert.equal(existsSync(sentinel), false, "coordinator continued after a failed child migration");
  const failureClient = createClient({ url: failureUrl });
  try {
    const ledger = await failureClient.execute("SELECT COUNT(*) AS count FROM _agentry_core_migrations");
    const locks = await failureClient.execute("SELECT COUNT(*) AS count FROM _agentry_core_migration_lock");
    assert.equal(Number(ledger.rows[0].count), 0, "failed migration was recorded as applied");
    assert.equal(Number(locks.rows[0].count), 0, "failed coordinator retained its live lease");

    // A live lease blocks a second coordinator without running its child.
    await failureClient.execute(
      `INSERT INTO _agentry_core_migration_lock (
         singleton, owner_token, lease_expires_at, updated_at
       ) VALUES (1, 'other-release', unixepoch() + 600, unixepoch())`,
    );
  } finally {
    failureClient.close();
  }
  await assert.rejects(
    runCoreMigrations({
      databaseUrl: failureUrl,
      manifest: [{ id: "test_0003_blocked", script: forbiddenScript }],
      root: packageRoot,
      childEnv: cleanEnv({ TEST_SENTINEL_PATH: sentinel }),
    }),
    /another core migration coordinator holds the database lease/,
  );
  assert.equal(existsSync(sentinel), false, "blocked coordinator ran a child migration");
  const expireClient = createClient({ url: failureUrl });
  try {
    await expireClient.execute(
      "UPDATE _agentry_core_migration_lock SET lease_expires_at = unixepoch() - 1 WHERE singleton = 1",
    );
  } finally {
    expireClient.close();
  }
  await runCoreMigrations({
    databaseUrl: failureUrl,
    manifest: [{ id: "test_0003_blocked", script: forbiddenScript }],
    root: packageRoot,
    childEnv: cleanEnv({ TEST_SENTINEL_PATH: sentinel }),
  });
  assert.equal(existsSync(sentinel), true, "expired migration lease was not recoverable");

  console.log(
    "core DB lifecycle self-test passed: empty bootstrap refusal, reviewed legacy rerun, failure propagation, and leased re-entry",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
