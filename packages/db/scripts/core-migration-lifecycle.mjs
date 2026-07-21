import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";

import {
  reconcileLegacyLoopbackBindings,
  verifyLegacyLoopbackQuarantine,
} from "./core-legacy-loopback-quarantine.mjs";
import {
  CORE_EMPTY_BOOTSTRAP_FOLDED_THROUGH,
  CORE_MIGRATIONS,
} from "./core-migration-manifest.mjs";
import { assertCoreSchemaExtensionManifest } from "./core-schema-extensions.mjs";
import { CORE_METADATA_SQL } from "./core-migration-metadata.mjs";
import { CORE_DB_PACKAGE_ROOT, loadCoreBaseline, sha256 } from "./core-schema-baseline.mjs";
import { nodeScriptArgs } from "./node-script-args.mjs";
import { verifyCoreRuntimeInvariants } from "./core-runtime-invariants.mjs";

const packageRoot = CORE_DB_PACKAGE_ROOT;
const LOCK_LEASE_SECONDS = 30 * 60;
const LOCK_HEARTBEAT_MS = 30_000;
const LEGACY_REVIEW_FLAG = "--reviewed-legacy-baseline";
const LEGACY_REVIEW_ENV = "AGENTRY_LEGACY_BASELINE_REVIEW_REF";
const MAINTENANCE_API_URL_ENV = "AGENTRY_MAINTENANCE_API_URL";
const MAINTENANCE_ID_ENV = "AGENTRY_MAINTENANCE_ID";
const MAINTENANCE_PROOF_TIMEOUT_MS = 5_000;
const MAINTENANCE_PROOF_HEADER = "x-agentry-maintenance-id";
// Historical post-check evidence for the retired hosted PostHog binding table.
// These guards existed only between the identity migration and the hard-cut
// storage-removal migration; they are intentionally not runtime invariants.
const HISTORICAL_POSTHOG_BINDING_TRIGGER_SHA256 = Object.freeze({
  project_posthog_bindings_identity_insert_guard:
    "ee97ec78da010e6a98c3794523d26c6b3d6d8a7e0314ac7570aa31e596c6e52f",
  project_posthog_bindings_immutable_update_guard:
    "d9534c1450c13501b7a6d5a16fed36dea887507edf8051406f9d21d67276e04c",
});

assertCoreSchemaExtensionManifest(CORE_MIGRATIONS);

function isFileDatabaseUrl(value) {
  try {
    return new URL(String(value)).protocol === "file:";
  } catch {
    return false;
  }
}

function normalizedMaintenanceId(value) {
  const raw = typeof value === "string" ? value : "";
  const maintenanceId = raw.trim();
  if (!maintenanceId) {
    throw new Error(`${MAINTENANCE_ID_ENV} not set for remote core migration`);
  }
  if (
    raw !== maintenanceId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(maintenanceId) ||
    /^agentry_(?:pk|sk|server|ci|runner)_/i.test(maintenanceId)
  ) {
    throw new Error(
      `${MAINTENANCE_ID_ENV} must be an 8-128 character nonsecret maintenance identifier`,
    );
  }
  return maintenanceId;
}

function normalizedMaintenanceApiUrl(value) {
  const configured = typeof value === "string" ? value : "";
  const raw = configured.trim();
  if (!raw) {
    throw new Error(`${MAINTENANCE_API_URL_ENV} not set for remote core migration`);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${MAINTENANCE_API_URL_ENV} must be an absolute HTTP(S) URL`);
  }
  const loopbackHttp = url.protocol === "http:" && [
    "localhost",
    "127.0.0.1",
    "[::1]",
  ].includes(url.hostname);
  if (
    configured !== raw ||
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      `${MAINTENANCE_API_URL_ENV} must be HTTPS (or loopback HTTP) without credentials or a fragment`,
    );
  }
  return url.href;
}

async function requireRemoteMaintenanceProof({
  apiUrl,
  maintenanceId,
  fetchImpl = globalThis.fetch,
  timeoutMs = MAINTENANCE_PROOF_TIMEOUT_MS,
}) {
  const expectedId = normalizedMaintenanceId(maintenanceId);
  const proofUrl = normalizedMaintenanceApiUrl(apiUrl);
  if (typeof fetchImpl !== "function") {
    throw new Error("remote core migration maintenance proof requires HTTP fetch support");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("remote core migration maintenance proof timeout must be 1-30000ms");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(proofUrl, {
      method: "GET",
      headers: {
        Accept: "text/plain, application/json;q=0.9, */*;q=0.1",
        "Cache-Control": "no-store",
        "User-Agent": "agentry-core-migration-maintenance-proof/1",
      },
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new Error(
        `remote core migration refused: maintenance proof timed out after ${timeoutMs}ms`,
      );
    }
    throw new Error("remote core migration refused: maintenance proof API is unreachable");
  } finally {
    clearTimeout(timeout);
  }

  if (response.redirected) {
    throw new Error("remote core migration refused: maintenance proof response was redirected");
  }
  if (response.status !== 503) {
    throw new Error(
      `remote core migration refused: maintenance proof expected HTTP 503, received ${response.status}`,
    );
  }
  if (response.headers.get(MAINTENANCE_PROOF_HEADER) !== expectedId) {
    throw new Error(
      `remote core migration refused: maintenance proof response did not contain the exact ${MAINTENANCE_PROOF_HEADER}`,
    );
  }
}

function normalizedReviewRef(value) {
  const ref = value?.trim() ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,199}$/.test(ref)) {
    throw new Error(
      `${LEGACY_REVIEW_ENV} must be an 8-200 character nonsecret backup, change, or review reference`,
    );
  }
  return ref;
}

async function tableExists(client, name) {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [name],
  });
  return result.rows.length === 1;
}

async function nonInternalSchemaObjects(client) {
  const result = await client.execute(
    `SELECT type, name
       FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_agentry_core_%'
        AND type IN ('table', 'view', 'trigger', 'index')
      ORDER BY type, name`,
  );
  return result.rows.map((row) => ({ type: String(row.type), name: String(row.name) }));
}

async function initializeLegacyBaseline(client, { reviewedLegacyBaseline, reviewRef }) {
  const schemaObjects = await nonInternalSchemaObjects(client);
  if (schemaObjects.length === 0) {
    throw new Error(
      "core migration refused an empty database; run `npm -w @agentry/db run db:bootstrap:empty` first",
    );
  }

  const hasBaseline = await tableExists(client, "_agentry_core_baseline");
  if (hasBaseline) return;

  if (!reviewedLegacyBaseline) {
    throw new Error(
      "untracked nonempty database refused; complete the backup and schema preflight, then use " +
      `${LEGACY_REVIEW_FLAG} with ${LEGACY_REVIEW_ENV}=<nonsecret-review-reference> exactly once`,
    );
  }

  const acceptedReviewRef = normalizedReviewRef(reviewRef);
  await client.batch([
    ...CORE_METADATA_SQL,
    {
      sql: `INSERT INTO _agentry_core_baseline (
              singleton, kind, baseline_sql_checksum, review_ref
            ) VALUES (1, 'legacy_reviewed', NULL, ?)`,
      args: [acceptedReviewRef],
    },
  ], "write");
}

async function validateBaseline(client, expectedBaselineChecksum) {
  if (!await tableExists(client, "_agentry_core_baseline")) {
    throw new Error("core baseline metadata is missing");
  }
  const result = await client.execute(
    `SELECT kind, baseline_sql_checksum, review_ref
       FROM _agentry_core_baseline
      WHERE singleton = 1`,
  );
  if (result.rows.length !== 1) {
    throw new Error("core baseline metadata must contain exactly one singleton row");
  }
  const row = result.rows[0];
  const kind = String(row.kind);
  if (kind === "empty_bootstrap") {
    if (
      !/^[a-f0-9]{64}$/.test(String(row.baseline_sql_checksum ?? "")) ||
      String(row.baseline_sql_checksum) !== expectedBaselineChecksum ||
      row.review_ref !== null
    ) {
      throw new Error("empty-bootstrap baseline metadata is invalid");
    }
  } else if (kind === "legacy_reviewed") {
    normalizedReviewRef(String(row.review_ref ?? ""));
    if (row.baseline_sql_checksum !== null) {
      throw new Error("legacy baseline must not claim a generated-schema checksum");
    }
  } else {
    throw new Error(`unsupported core baseline kind: ${kind}`);
  }
  return {
    kind,
    reviewRef: kind === "legacy_reviewed" ? String(row.review_ref) : null,
  };
}

async function acquireLock(client, ownerToken) {
  const result = await client.execute({
    sql: `INSERT INTO _agentry_core_migration_lock (
            singleton, owner_token, lease_expires_at, updated_at
          ) VALUES (1, ?, unixepoch() + ?, unixepoch())
          ON CONFLICT(singleton) DO UPDATE SET
            owner_token = excluded.owner_token,
            lease_expires_at = excluded.lease_expires_at,
            updated_at = excluded.updated_at
          WHERE _agentry_core_migration_lock.lease_expires_at <= unixepoch()
          RETURNING owner_token, lease_expires_at`,
    args: [ownerToken, LOCK_LEASE_SECONDS],
  });
  if (result.rows.length !== 1 || String(result.rows[0].owner_token) !== ownerToken) {
    throw new Error("another core migration coordinator holds the database lease; retry after it exits");
  }
}

async function renewLock(client, ownerToken) {
  const result = await client.execute({
    sql: `UPDATE _agentry_core_migration_lock
             SET lease_expires_at = unixepoch() + ?, updated_at = unixepoch()
           WHERE singleton = 1
             AND owner_token = ?
             AND lease_expires_at > unixepoch()
         RETURNING owner_token`,
    args: [LOCK_LEASE_SECONDS, ownerToken],
  });
  if (result.rows.length !== 1) {
    throw new Error("core migration lease was lost");
  }
}

async function releaseLock(client, ownerToken) {
  const result = await client.execute({
    sql: "DELETE FROM _agentry_core_migration_lock WHERE singleton = 1 AND owner_token = ?",
    args: [ownerToken],
  });
  if (result.rowsAffected !== 1) {
    throw new Error("core migration lease could not be released by its exact owner");
  }
}

async function resolvedManifest(manifest, root) {
  const ids = new Set();
  const resolved = [];
  for (const entry of manifest) {
    if (!/^[a-z0-9][a-z0-9_]{7,99}$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error(`invalid or duplicate core migration id: ${entry.id}`);
    }
    ids.add(entry.id);
    const scriptPath = isAbsolute(entry.script) ? entry.script : join(root, entry.script);
    const source = await readFile(scriptPath);
    const schemaProjectionPath = entry.schemaProjection
      ? (isAbsolute(entry.schemaProjection) ? entry.schemaProjection : join(root, entry.schemaProjection))
      : null;
    const schemaProjectionSource = schemaProjectionPath ? await readFile(schemaProjectionPath) : null;
    const manifestIdentity = {
      id: entry.id,
      script: entry.script,
      scriptChecksum: sha256(source),
      postCheck: entry.postCheck ?? null,
      ...(entry.schemaProjection ? {
        schemaProjection: entry.schemaProjection,
        schemaProjectionChecksum: sha256(schemaProjectionSource),
      } : {}),
    };
    resolved.push({
      ...entry,
      scriptPath,
      checksum: sha256(source),
      manifestChecksum: sha256(JSON.stringify(manifestIdentity)),
    });
  }
  return resolved;
}

async function validateAppliedPrefix(client, manifest) {
  const result = await client.execute(
    `SELECT sequence, migration_id, script_path, script_checksum, manifest_checksum
       FROM _agentry_core_migrations
      ORDER BY sequence`,
  );
  if (result.rows.length > manifest.length) {
    throw new Error("database migration history is ahead of this release manifest");
  }
  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const expected = manifest[index];
    const sequence = index + 1;
    if (
      Number(row.sequence) !== sequence ||
      String(row.migration_id) !== expected.id ||
      String(row.script_path) !== expected.script ||
      String(row.script_checksum) !== expected.checksum ||
      String(row.manifest_checksum) !== expected.manifestChecksum
    ) {
      throw new Error(
        `core migration history drift at sequence ${sequence}; shipped entries and scripts are immutable`,
      );
    }
  }
  return result.rows.length;
}

async function runPostCheck(client, migration) {
  if (!migration.postCheck) return;
  if (migration.postCheck === "posthog_org_attested") {
    const bindingTable = await client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_posthog_bindings'",
    );
    if (bindingTable.rows.length === 0) return;
    const result = await client.execute(
      `SELECT COUNT(*) AS count
         FROM project_posthog_bindings
        WHERE posthog_org_id IS NULL OR trim(posthog_org_id) = ''`,
    );
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `${migration.id} left ${count} legacy PostHog binding(s) without organization attestation; ` +
        "rerun the coordinator with the exact paired " +
        "AGENTRY_POSTHOG_BINDING_BACKFILL_HOST and AGENTRY_POSTHOG_BINDING_BACKFILL_ORG_ID",
      );
    }
    return;
  }
  if (migration.postCheck === "posthog_binding_identity_attested") {
    const bindingTable = await client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_posthog_bindings'",
    );
    if (bindingTable.rows.length === 0) return;
    const result = await client.execute(
      `SELECT COUNT(*) AS count
         FROM project_posthog_bindings
        WHERE posthog_project_id < 1
           OR posthog_project_resource_id IS NULL
           OR posthog_project_resource_id < 1
           OR posthog_org_id IS NULL
           OR trim(posthog_org_id) = ''`,
    );
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > 0) {
      throw new Error(
        `${migration.id} left ${count} PostHog binding(s) without exact environment/team -> project-resource identity; ` +
        "rerun the coordinator with the reviewed " +
        "AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE and " +
        "AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256",
      );
    }
    const indexes = await client.execute(
      "PRAGMA index_list(project_posthog_bindings)",
    );
    const resourceIndex = indexes.rows.find(
      (row) => String(row.name) === "project_posthog_bindings_ph_resource_idx",
    );
    if (
      !resourceIndex ||
      Number(resourceIndex.unique ?? 0) !== 1 ||
      Number(resourceIndex.partial ?? 0) !== 0 ||
      String(resourceIndex.origin ?? "") !== "c"
    ) {
      throw new Error(
        `${migration.id} is missing the unique PostHog project-resource identity index`,
      );
    }
    const columns = await client.execute(
      "PRAGMA index_xinfo(project_posthog_bindings_ph_resource_idx)",
    );
    const keyColumns = columns.rows
      .filter((row) => Number(row.key ?? 0) === 1)
      .map((row) => ({
        name: row.name === null ? null : String(row.name),
        desc: Number(row.desc ?? 0),
        coll: String(row.coll ?? ""),
      }));
    if (JSON.stringify(keyColumns) !== JSON.stringify([
      { name: "posthog_host", desc: 0, coll: "BINARY" },
      { name: "posthog_project_resource_id", desc: 0, coll: "BINARY" },
    ])) {
      throw new Error(
        `${migration.id} has a malformed PostHog project-resource identity index`,
      );
    }
    for (const triggerName of [
      "project_posthog_bindings_immutable_update_guard",
      "project_posthog_bindings_identity_insert_guard",
    ]) {
      const trigger = await client.execute({
        sql: "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        args: [triggerName],
      });
      const triggerHash = trigger.rows.length === 1
        ? sha256(String(trigger.rows[0]?.sql ?? "").replace(/\s+/g, " ").trim())
        : null;
      if (triggerHash !== HISTORICAL_POSTHOG_BINDING_TRIGGER_SHA256[triggerName]) {
        throw new Error(
          `${migration.id} has a missing or malformed ${triggerName}`,
        );
      }
    }
    return;
  }
  if (migration.postCheck === "hosted_ingest_storage_removed") {
    const retiredTables = await client.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
        'events',
        'project_secrets',
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
    const retiredIndex = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_dsn_hash_idx'",
    );
    const columns = await client.execute("PRAGMA table_info(projects)");
    const names = new Set(columns.rows.map((row) => String(row.name)));
    if (
      retiredTables.rows.length > 0 ||
      retiredIndex.rows.length > 0 ||
      names.has("dsn_prefix") ||
      names.has("dsn_hash")
    ) {
      throw new Error(
        `${migration.id} left retired Agentry-hosted ingest storage in the core database`,
      );
    }
    return;
  }
  if (migration.postCheck === "read_only_schema_hard_cut") {
    const [archive, apiKeyAliases, credentialAliases, deployAliases, caseColumns, deployColumns,
      connectionColumns, cursorIndex] = await Promise.all([
      client.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_runs'",
      ),
      client.execute("SELECT COUNT(*) AS count FROM api_keys WHERE kind <> 'private'"),
      client.execute(
        "SELECT COUNT(*) AS count FROM project_credentials " +
        "WHERE kind NOT IN ('ci_deploy', 'automation_runner')",
      ),
      client.execute(
        "SELECT COUNT(*) AS count FROM deploys " +
        "WHERE trust_level <> 'trusted_ci' OR credential_kind <> 'ci_deploy' " +
        "OR credential_id IS NULL",
      ),
      client.execute("PRAGMA table_info(cases)"),
      client.execute("PRAGMA table_info(deploys)"),
      client.execute("PRAGMA table_info(posthog_connections)"),
      client.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' " +
        "AND name = 'posthog_connections_case_projection_due_idx'",
      ),
    ]);
    const caseShape = new Map(
      caseColumns.rows.map((row) => [String(row.name), Number(row.notnull ?? 0)]),
    );
    const deployShape = new Map(
      deployColumns.rows.map((row) => [String(row.name), Number(row.notnull ?? 0)]),
    );
    const connectionShape = new Set(connectionColumns.rows.map((row) => String(row.name)));
    const expectedConnectionColumns = [
      "case_projection_offset",
      "case_projection_last_attempt_at",
      "case_projection_last_completed_at",
    ];
    if (
      archive.rows.length > 0 ||
      Number(apiKeyAliases.rows[0]?.count ?? 0) > 0 ||
      Number(credentialAliases.rows[0]?.count ?? 0) > 0 ||
      Number(deployAliases.rows[0]?.count ?? 0) > 0 ||
      caseShape.has("last_credential_id") ||
      caseShape.get("provider_issue_id") !== 1 ||
      caseShape.get("provider_snapshot_hash") !== 1 ||
      caseShape.get("provider_projected_at") !== 1 ||
      caseShape.get("provider_event_classification") !== 1 ||
      deployShape.get("credential_id") !== 1 ||
      expectedConnectionColumns.some((name) => !connectionShape.has(name)) ||
      cursorIndex.rows.length !== 1
    ) {
      throw new Error(
        `${migration.id} left a retired credential, deploy, case, or projection-cursor alias`,
      );
    }
    return;
  }
  throw new Error(`unsupported core migration post-check: ${migration.postCheck}`);
}

function runScript(entry, env, onHeartbeat) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let heartbeatInFlight = false;
    let heartbeatFailure = null;
    const child = spawn(process.execPath, nodeScriptArgs(entry.scriptPath), {
      cwd: packageRoot,
      env,
      stdio: "inherit",
    });
    const interval = setInterval(async () => {
      if (heartbeatInFlight || settled) return;
      heartbeatInFlight = true;
      try {
        await onHeartbeat();
      } catch (error) {
        heartbeatFailure = error;
        child.kill("SIGTERM");
      } finally {
        heartbeatInFlight = false;
      }
    }, LOCK_HEARTBEAT_MS);
    interval.unref();

    child.once("error", (error) => {
      settled = true;
      clearInterval(interval);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      settled = true;
      clearInterval(interval);
      if (heartbeatFailure) {
        rejectPromise(heartbeatFailure);
      } else if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(
            `core migration ${entry.id} failed (${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`})`,
          ),
        );
      }
    });
  });
}

export async function runCoreMigrations({
  databaseUrl = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
  manifest = CORE_MIGRATIONS,
  root = packageRoot,
  reviewedLegacyBaseline = false,
  reviewRef = process.env[LEGACY_REVIEW_ENV],
  childEnv = process.env,
  maintenanceApiUrl = process.env[MAINTENANCE_API_URL_ENV],
  maintenanceId = process.env[MAINTENANCE_ID_ENV],
  maintenanceFetch = globalThis.fetch,
  maintenanceTimeoutMs = MAINTENANCE_PROOF_TIMEOUT_MS,
  createDatabaseClient = createClient,
} = {}) {
  if (!databaseUrl) throw new Error("TURSO_DATABASE_URL not set");
  if (manifest.length === 0) throw new Error("core migration manifest is empty");

  if (!isFileDatabaseUrl(databaseUrl)) {
    await requireRemoteMaintenanceProof({
      apiUrl: maintenanceApiUrl,
      maintenanceId,
      fetchImpl: maintenanceFetch,
      timeoutMs: maintenanceTimeoutMs,
    });
  }

  const client = createDatabaseClient({ url: databaseUrl, authToken });
  const ownerToken = randomUUID();
  let locked = false;
  let outcome;
  let failure;
  try {
    await initializeLegacyBaseline(client, { reviewedLegacyBaseline, reviewRef });
    await client.batch(CORE_METADATA_SQL, "write");
    const baseline = await loadCoreBaseline(root);
    const baselineState = await validateBaseline(client, baseline.checksum);
    const baselineKind = baselineState.kind;
    const migrations = await resolvedManifest(manifest, root);
    const canonicalManifest = manifest === CORE_MIGRATIONS;
    const foldedThroughIndex = canonicalManifest
      ? migrations.findIndex(
        (migration) => migration.id === CORE_EMPTY_BOOTSTRAP_FOLDED_THROUGH,
      )
      : -1;
    if (canonicalManifest && foldedThroughIndex < 0) {
      throw new Error(
        `empty-bootstrap folded migration ${CORE_EMPTY_BOOTSTRAP_FOLDED_THROUGH} is missing`,
      );
    }

    await acquireLock(client, ownerToken);
    locked = true;
    const appliedCount = await validateAppliedPrefix(client, migrations);
    await reconcileLegacyLoopbackBindings({
      client,
      baselineKind,
      baselineReviewRef: baselineState.reviewRef,
      appliedCount,
      env: childEnv,
    });

    for (let index = appliedCount; index < migrations.length; index += 1) {
      const migration = migrations[index];
      const sequence = index + 1;
      await renewLock(client, ownerToken);
      const foldedIntoBaseline =
        baselineKind === "empty_bootstrap" && index <= foldedThroughIndex;
      console.log(
        `[core-db ${sequence}/${migrations.length}] ${migration.id}` +
        `${foldedIntoBaseline ? " (folded into canonical empty bootstrap)" : ""}`,
      );
      if (!foldedIntoBaseline) {
        await runScript(
          migration,
          {
            ...childEnv,
            TURSO_DATABASE_URL: databaseUrl,
            TURSO_AUTH_TOKEN: authToken ?? "",
          },
          () => renewLock(client, ownerToken),
        );
      }
      await renewLock(client, ownerToken);
      await runPostCheck(client, migration);
      await client.execute({
        sql: `INSERT INTO _agentry_core_migrations (
                sequence, migration_id, script_path, script_checksum, manifest_checksum, applied_at
              )
              SELECT ?, ?, ?, ?, ?, unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM _agentry_core_migration_lock
                 WHERE singleton = 1 AND owner_token = ? AND lease_expires_at > unixepoch()
              )`,
        args: [
          sequence,
          migration.id,
          migration.script,
          migration.checksum,
          migration.manifestChecksum,
          ownerToken,
        ],
      });
      const recorded = await client.execute({
        sql: `SELECT 1 FROM _agentry_core_migrations
               WHERE sequence = ? AND migration_id = ?
                 AND script_checksum = ? AND manifest_checksum = ?`,
        args: [sequence, migration.id, migration.checksum, migration.manifestChecksum],
      });
      if (recorded.rows.length !== 1) {
        throw new Error(`core migration ${migration.id} completed but its leased ledger write failed`);
      }
    }

    const finalCount = await validateAppliedPrefix(client, migrations);
    if (finalCount !== migrations.length) {
      throw new Error(`core migration verification expected ${migrations.length} entries, found ${finalCount}`);
    }
    const runtimeInvariants = manifest === CORE_MIGRATIONS
      ? await verifyCoreRuntimeInvariants(client, baseline)
      : null;
    console.log(
      `core database migrations ready (${baselineKind}; ${finalCount}/${migrations.length}` +
      `${runtimeInvariants ? `; schema ${runtimeInvariants.fingerprint}` : ""})`,
    );
    outcome = { baselineKind, appliedCount: finalCount };
  } catch (error) {
    failure = error;
  }

  let releaseFailure;
  if (locked) {
    try {
      await releaseLock(client, ownerToken);
    } catch (error) {
      releaseFailure = error;
    }
  }
  client.close();

  if (failure && releaseFailure) {
    throw new AggregateError(
      [failure, releaseFailure],
      "core migration failed and its lease could not be released",
    );
  }
  if (failure) throw failure;
  if (releaseFailure) throw releaseFailure;
  return outcome;
}

export async function verifyCoreMigrations({
  databaseUrl = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
  manifest = CORE_MIGRATIONS,
  root = packageRoot,
  createDatabaseClient = createClient,
} = {}) {
  if (!databaseUrl) throw new Error("TURSO_DATABASE_URL not set");
  if (manifest.length === 0) throw new Error("core migration manifest is empty");
  const client = createDatabaseClient({ url: databaseUrl, authToken });
  try {
    const schemaObjects = await nonInternalSchemaObjects(client);
    if (schemaObjects.length === 0) throw new Error("core database is empty");
    const baseline = await loadCoreBaseline(root);
    const baselineState = await validateBaseline(client, baseline.checksum);
    const baselineKind = baselineState.kind;
    const migrations = await resolvedManifest(manifest, root);
    const appliedCount = await validateAppliedPrefix(client, migrations);
    if (appliedCount !== migrations.length) {
      throw new Error(`core migration ledger is incomplete (${appliedCount}/${migrations.length})`);
    }
    const lock = await client.execute("SELECT owner_token, lease_expires_at FROM _agentry_core_migration_lock");
    if (lock.rows.length !== 0) {
      throw new Error("core migration lock row remains; rerun the coordinator before release verification");
    }
    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length !== 0) {
      throw new Error(`core database has ${foreignKeys.rows.length} foreign-key violation(s)`);
    }
    await verifyLegacyLoopbackQuarantine(client, { baselineKind });
    for (const migration of migrations) await runPostCheck(client, migration);
    const runtimeInvariants = manifest === CORE_MIGRATIONS
      ? await verifyCoreRuntimeInvariants(client, baseline)
      : null;
    console.log(
      `core database verification passed (${baselineKind}; ${appliedCount}/${migrations.length}` +
      `${runtimeInvariants ? `; schema ${runtimeInvariants.fingerprint}` : ""})`,
    );
    return { baselineKind, appliedCount, runtimeInvariants };
  } finally {
    client.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify-only");
  const unknown = args.filter((arg) => arg !== LEGACY_REVIEW_FLAG && arg !== "--verify-only");
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`);
  if (verifyOnly && args.includes(LEGACY_REVIEW_FLAG)) {
    throw new Error("--verify-only cannot be combined with the legacy baseline acceptance flag");
  }
  if (verifyOnly) await verifyCoreMigrations();
  else await runCoreMigrations({ reviewedLegacyBaseline: args.includes(LEGACY_REVIEW_FLAG) });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error("core database migration failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export {
  LEGACY_REVIEW_ENV,
  LEGACY_REVIEW_FLAG,
  MAINTENANCE_API_URL_ENV,
  MAINTENANCE_ID_ENV,
  nonInternalSchemaObjects,
};
