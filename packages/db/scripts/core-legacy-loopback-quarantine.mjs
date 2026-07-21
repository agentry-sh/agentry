import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const LEGACY_LOOPBACK_QUARANTINE_FILE_ENV =
  "AGENTRY_LEGACY_LOOPBACK_QUARANTINE_FILE";
export const LEGACY_LOOPBACK_QUARANTINE_SHA_ENV =
  "AGENTRY_LEGACY_LOOPBACK_QUARANTINE_SHA256";

const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
const QUARANTINE_TABLE = "_agentry_core_legacy_posthog_binding_quarantine";
const RECEIPT_TABLE = "_agentry_core_legacy_posthog_binding_quarantine_receipt";
const EXPECTED_SOURCE_COLUMNS = Object.freeze([
  "project_id",
  "posthog_project_id",
  "posthog_project_api_key",
  "read_token_enc",
  "read_token_iv",
  "posthog_host",
  "created_at",
]);
const QUARANTINE_COLUMNS = Object.freeze([
  ...EXPECTED_SOURCE_COLUMNS,
  "raw_row_sha256",
  "fixture_sha256",
  "review_ref",
  "backup_ref",
  "quarantined_at",
]);
const RECEIPT_COLUMNS = Object.freeze([
  "singleton",
  "fixture_sha256",
  "review_ref",
  "backup_ref",
  "source_row_count",
  "completed_at",
]);

const CREATE_QUARANTINE_TABLE_SQL = `CREATE TABLE ${QUARANTINE_TABLE} (
  project_id text PRIMARY KEY NOT NULL,
  posthog_project_id integer NOT NULL,
  posthog_project_api_key text NOT NULL,
  read_token_enc text,
  read_token_iv text,
  posthog_host text NOT NULL,
  created_at integer NOT NULL,
  raw_row_sha256 text NOT NULL UNIQUE CHECK (
    length(raw_row_sha256) = 64 AND raw_row_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  fixture_sha256 text NOT NULL CHECK (
    length(fixture_sha256) = 64 AND fixture_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  review_ref text NOT NULL,
  backup_ref text NOT NULL,
  quarantined_at integer NOT NULL DEFAULT (unixepoch())
)`;

const CREATE_RECEIPT_TABLE_SQL = `CREATE TABLE ${RECEIPT_TABLE} (
  singleton integer PRIMARY KEY NOT NULL CHECK (singleton = 1),
  fixture_sha256 text NOT NULL CHECK (
    length(fixture_sha256) = 64 AND fixture_sha256 NOT GLOB '*[^a-f0-9]*'
  ),
  review_ref text NOT NULL,
  backup_ref text NOT NULL,
  source_row_count integer NOT NULL CHECK (source_row_count > 0),
  completed_at integer NOT NULL DEFAULT (unixepoch())
)`;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return value;
}

function boundedReference(value, label) {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{7,299}$/.test(value)
  ) {
    throw new Error(`${label} must be an 8-300 character nonsecret review or backup reference`);
  }
  return value;
}

function requiredString(value, label, max = 500) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function nullableSha(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be null or a lowercase SHA-256`);
  }
  return value;
}

function requiredSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function normalizedRawRow(row) {
  return {
    project_id: String(row.project_id),
    posthog_project_id: Number(row.posthog_project_id),
    posthog_project_api_key: String(row.posthog_project_api_key),
    read_token_enc: row.read_token_enc === null ? null : String(row.read_token_enc),
    read_token_iv: row.read_token_iv === null ? null : String(row.read_token_iv),
    posthog_host: String(row.posthog_host),
    created_at: Number(row.created_at),
  };
}

export function legacyLoopbackRawRowSha256(row) {
  return sha256(JSON.stringify(normalizedRawRow(row)));
}

export function isExactLoopbackPostHogHost(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(url.protocol)
    && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
  );
}

export function legacyLoopbackFixtureBinding(row) {
  const normalized = normalizedRawRow(row);
  if (!isExactLoopbackPostHogHost(normalized.posthog_host)) {
    throw new Error("legacy loopback quarantine fixture row must use an exact loopback PostHog host");
  }
  positiveSafeInteger(normalized.posthog_project_id, "legacy loopback PostHog environment id");
  nonnegativeSafeInteger(normalized.created_at, "legacy loopback binding created_at");
  return {
    project_id: normalized.project_id,
    posthog_environment_id: normalized.posthog_project_id,
    posthog_host: normalized.posthog_host,
    created_at: normalized.created_at,
    posthog_project_api_key_sha256: sha256(normalized.posthog_project_api_key),
    read_token_enc_sha256:
      normalized.read_token_enc === null ? null : sha256(normalized.read_token_enc),
    read_token_iv_sha256:
      normalized.read_token_iv === null ? null : sha256(normalized.read_token_iv),
    raw_row_sha256: legacyLoopbackRawRowSha256(normalized),
  };
}

function parseFixtureBinding(value, index) {
  const label = `legacy loopback quarantine fixture bindings[${index}]`;
  const row = exactObject(value, [
    "project_id",
    "posthog_environment_id",
    "posthog_host",
    "created_at",
    "posthog_project_api_key_sha256",
    "read_token_enc_sha256",
    "read_token_iv_sha256",
    "raw_row_sha256",
  ], label);
  const host = requiredString(row.posthog_host, `${label}.posthog_host`);
  if (!isExactLoopbackPostHogHost(host)) {
    throw new Error(`${label}.posthog_host must be an exact loopback HTTP(S) URL`);
  }
  return {
    projectId: requiredString(row.project_id, `${label}.project_id`, 200),
    posthogEnvironmentId: positiveSafeInteger(
      row.posthog_environment_id,
      `${label}.posthog_environment_id`,
    ),
    posthogHost: host,
    createdAt: nonnegativeSafeInteger(row.created_at, `${label}.created_at`),
    posthogProjectApiKeySha256: requiredSha(
      row.posthog_project_api_key_sha256,
      `${label}.posthog_project_api_key_sha256`,
    ),
    readTokenEncSha256: nullableSha(
      row.read_token_enc_sha256,
      `${label}.read_token_enc_sha256`,
    ),
    readTokenIvSha256: nullableSha(
      row.read_token_iv_sha256,
      `${label}.read_token_iv_sha256`,
    ),
    rawRowSha256: requiredSha(row.raw_row_sha256, `${label}.raw_row_sha256`),
  };
}

async function readFixture(env) {
  const file = env[LEGACY_LOOPBACK_QUARANTINE_FILE_ENV]?.trim() ?? "";
  const expectedSha = env[LEGACY_LOOPBACK_QUARANTINE_SHA_ENV]?.trim() ?? "";
  if (!file && !expectedSha) return null;
  if (!file || !isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error(
      `legacy loopback quarantine requires an absolute ${LEGACY_LOOPBACK_QUARANTINE_FILE_ENV} `
      + `and a lowercase 64-character ${LEGACY_LOOPBACK_QUARANTINE_SHA_ENV}`,
    );
  }
  const details = await stat(file);
  if (!details.isFile() || details.size < 2 || details.size > MAX_FIXTURE_BYTES) {
    throw new Error(
      `legacy loopback quarantine fixture must be a 2-${MAX_FIXTURE_BYTES} byte regular file`,
    );
  }
  const raw = await readFile(file);
  const actualSha = sha256(raw);
  if (actualSha !== expectedSha) {
    throw new Error(
      `legacy loopback quarantine fixture SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }
  let decoded;
  try {
    decoded = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("legacy loopback quarantine fixture must be valid JSON");
  }
  const root = exactObject(
    decoded,
    ["schema_version", "review_ref", "backup_ref", "bindings"],
    "legacy loopback quarantine fixture",
  );
  if (root.schema_version !== 1) {
    throw new Error("legacy loopback quarantine fixture schema_version must be 1");
  }
  if (!Array.isArray(root.bindings) || root.bindings.length < 1) {
    throw new Error("legacy loopback quarantine fixture bindings must be a nonempty array");
  }
  const bindings = root.bindings.map(parseFixtureBinding);
  const projectIds = bindings.map((row) => row.projectId);
  if (new Set(projectIds).size !== projectIds.length) {
    throw new Error("legacy loopback quarantine fixture has duplicate project_id");
  }
  return {
    fixtureSha256: actualSha,
    reviewRef: boundedReference(root.review_ref, "legacy loopback quarantine fixture review_ref"),
    backupRef: boundedReference(root.backup_ref, "legacy loopback quarantine fixture backup_ref"),
    bindings,
  };
}

async function tableExists(client, name) {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [name],
  });
  return result.rows.length === 1;
}

async function exactColumnNames(client, table) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((row) => String(row.name));
}

function normalizedSql(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function exactTableSql(client, table) {
  const result = await client.execute({
    sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [table],
  });
  return result.rows.length === 1 ? normalizedSql(result.rows[0].sql) : null;
}

async function sourceLoopbackRows(client) {
  if (!await tableExists(client, "project_posthog_bindings")) return [];
  const columns = await exactColumnNames(client, "project_posthog_bindings");
  if (!columns.includes("project_id") || !columns.includes("posthog_host")) {
    throw new Error("legacy PostHog binding table lacks project_id/posthog_host");
  }
  const hosts = await client.execute(
    "SELECT project_id, posthog_host FROM project_posthog_bindings ORDER BY project_id",
  );
  const loopbackProjectIds = hosts.rows
    .filter((row) => isExactLoopbackPostHogHost(String(row.posthog_host)))
    .map((row) => String(row.project_id));
  if (loopbackProjectIds.length === 0) return [];
  if (JSON.stringify(columns) !== JSON.stringify(EXPECTED_SOURCE_COLUMNS)) {
    throw new Error(
      "legacy loopback quarantine refuses a PostHog binding shape it cannot preserve exactly",
    );
  }
  const rows = await client.execute(
    `SELECT ${EXPECTED_SOURCE_COLUMNS.join(", ")}
       FROM project_posthog_bindings
      ORDER BY project_id`,
  );
  return rows.rows
    .map(normalizedRawRow)
    .filter((row) => isExactLoopbackPostHogHost(row.posthog_host));
}

function assertFixtureMatchesRows(fixture, rows) {
  if (fixture.bindings.length !== rows.length) {
    throw new Error(
      `legacy loopback quarantine fixture covers ${fixture.bindings.length} binding(s), `
      + `but the database has ${rows.length}; provide one full reviewed snapshot`,
    );
  }
  const byProject = new Map(fixture.bindings.map((row) => [row.projectId, row]));
  for (const raw of rows) {
    const expected = byProject.get(raw.project_id);
    if (!expected) {
      throw new Error(`legacy loopback quarantine fixture is missing project ${raw.project_id}`);
    }
    const actual = legacyLoopbackFixtureBinding(raw);
    const comparable = {
      projectId: actual.project_id,
      posthogEnvironmentId: actual.posthog_environment_id,
      posthogHost: actual.posthog_host,
      createdAt: actual.created_at,
      posthogProjectApiKeySha256: actual.posthog_project_api_key_sha256,
      readTokenEncSha256: actual.read_token_enc_sha256,
      readTokenIvSha256: actual.read_token_iv_sha256,
      rawRowSha256: actual.raw_row_sha256,
    };
    if (JSON.stringify(comparable) !== JSON.stringify(expected)) {
      throw new Error(`legacy loopback quarantine fixture mismatch for project ${raw.project_id}`);
    }
  }
}

async function existingQuarantineState(client) {
  const [quarantineExists, receiptExists] = await Promise.all([
    tableExists(client, QUARANTINE_TABLE),
    tableExists(client, RECEIPT_TABLE),
  ]);
  if (quarantineExists !== receiptExists) {
    throw new Error("legacy loopback quarantine metadata is partial");
  }
  return quarantineExists;
}

export async function verifyLegacyLoopbackQuarantine(client, { baselineKind, fixture = null } = {}) {
  const exists = await existingQuarantineState(client);
  if (!exists) return null;
  if (baselineKind !== "legacy_reviewed") {
    throw new Error("legacy loopback quarantine exists outside a legacy_reviewed baseline");
  }
  const [quarantineColumns, receiptColumns, quarantineSql, receiptSql] = await Promise.all([
    exactColumnNames(client, QUARANTINE_TABLE),
    exactColumnNames(client, RECEIPT_TABLE),
    exactTableSql(client, QUARANTINE_TABLE),
    exactTableSql(client, RECEIPT_TABLE),
  ]);
  if (JSON.stringify(quarantineColumns) !== JSON.stringify(QUARANTINE_COLUMNS)) {
    throw new Error("legacy loopback quarantine table shape drifted");
  }
  if (JSON.stringify(receiptColumns) !== JSON.stringify(RECEIPT_COLUMNS)) {
    throw new Error("legacy loopback quarantine receipt shape drifted");
  }
  if (quarantineSql !== normalizedSql(CREATE_QUARANTINE_TABLE_SQL)) {
    throw new Error("legacy loopback quarantine table constraints drifted");
  }
  if (receiptSql !== normalizedSql(CREATE_RECEIPT_TABLE_SQL)) {
    throw new Error("legacy loopback quarantine receipt constraints drifted");
  }
  const [receipts, quarantined, remaining] = await Promise.all([
    client.execute(
      `SELECT fixture_sha256, review_ref, backup_ref, source_row_count, completed_at
         FROM ${RECEIPT_TABLE}
        ORDER BY singleton`,
    ),
    client.execute(
      `SELECT ${QUARANTINE_COLUMNS.join(", ")}
         FROM ${QUARANTINE_TABLE}
        ORDER BY project_id`,
    ),
    sourceLoopbackRows(client),
  ]);
  if (receipts.rows.length !== 1) {
    throw new Error("legacy loopback quarantine receipt must contain exactly one row");
  }
  if (remaining.length !== 0) {
    throw new Error("legacy loopback quarantine receipt exists while source loopback rows remain");
  }
  const receipt = receipts.rows[0];
  const count = Number(receipt.source_row_count);
  if (
    !Number.isSafeInteger(count)
    || count < 1
    || quarantined.rows.length !== count
    || !Number.isSafeInteger(Number(receipt.completed_at))
    || Number(receipt.completed_at) < 1
  ) {
    throw new Error("legacy loopback quarantine receipt row count drifted");
  }
  const fixtureSha256 = requiredSha(
    String(receipt.fixture_sha256),
    "legacy loopback quarantine receipt fixture_sha256",
  );
  const reviewRef = boundedReference(
    String(receipt.review_ref),
    "legacy loopback quarantine receipt review_ref",
  );
  const backupRef = boundedReference(
    String(receipt.backup_ref),
    "legacy loopback quarantine receipt backup_ref",
  );
  for (const row of quarantined.rows) {
    const raw = normalizedRawRow(row);
    if (!isExactLoopbackPostHogHost(raw.posthog_host)) {
      throw new Error(`quarantined PostHog binding ${raw.project_id} is not loopback`);
    }
    if (
      String(row.fixture_sha256) !== fixtureSha256
      || String(row.review_ref) !== reviewRef
      || String(row.backup_ref) !== backupRef
      || String(row.raw_row_sha256) !== legacyLoopbackRawRowSha256(raw)
      || !Number.isSafeInteger(Number(row.quarantined_at))
      || Number(row.quarantined_at) < 1
    ) {
      throw new Error(`legacy loopback quarantine evidence drifted for project ${raw.project_id}`);
    }
  }
  if (fixture) {
    if (
      fixture.fixtureSha256 !== fixtureSha256
      || fixture.reviewRef !== reviewRef
      || fixture.backupRef !== backupRef
    ) {
      throw new Error("legacy loopback quarantine fixture does not match the durable receipt");
    }
    assertFixtureMatchesRows(fixture, quarantined.rows.map(normalizedRawRow));
  }
  return Object.freeze({
    fixtureSha256,
    reviewRef,
    backupRef,
    rowCount: count,
  });
}

function exactRowPredicate() {
  return `project_id = ?
    AND posthog_project_id = ?
    AND posthog_project_api_key = ?
    AND read_token_enc IS ?
    AND read_token_iv IS ?
    AND posthog_host = ?
    AND created_at = ?`;
}

function rawRowArgs(row) {
  return [
    row.project_id,
    row.posthog_project_id,
    row.posthog_project_api_key,
    row.read_token_enc,
    row.read_token_iv,
    row.posthog_host,
    row.created_at,
  ];
}

export async function reconcileLegacyLoopbackBindings({
  client,
  baselineKind,
  baselineReviewRef,
  appliedCount,
  env = process.env,
}) {
  const fixture = await readFixture(env);
  const existing = await verifyLegacyLoopbackQuarantine(client, { baselineKind, fixture });
  const rows = await sourceLoopbackRows(client);
  if (existing) {
    if (rows.length !== 0) {
      throw new Error("legacy loopback quarantine is complete but source loopback rows reappeared");
    }
    return { ...existing, idempotentReplay: true };
  }
  if (baselineKind !== "legacy_reviewed") {
    if (fixture) {
      throw new Error("legacy loopback quarantine is allowed only for a legacy_reviewed baseline");
    }
    return null;
  }
  if (rows.length === 0) {
    if (fixture) {
      throw new Error("legacy loopback quarantine fixture was supplied but no loopback rows exist");
    }
    return null;
  }
  if (appliedCount !== 0) {
    throw new Error(
      "legacy loopback bindings can be quarantined only before the first core migration receipt",
    );
  }
  if (!fixture) {
    throw new Error(
      `${rows.length} legacy loopback PostHog binding(s) require a reviewed full `
      + `${LEGACY_LOOPBACK_QUARANTINE_FILE_ENV} and ${LEGACY_LOOPBACK_QUARANTINE_SHA_ENV}`,
    );
  }
  if (fixture.reviewRef !== baselineReviewRef) {
    throw new Error(
      "legacy loopback quarantine fixture review_ref does not match the legacy baseline review_ref",
    );
  }
  assertFixtureMatchesRows(fixture, rows);
  const sourceCountResult = await client.execute(
    "SELECT COUNT(*) AS count FROM project_posthog_bindings",
  );
  const sourceCount = Number(sourceCountResult.rows[0]?.count ?? -1);
  if (!Number.isSafeInteger(sourceCount) || sourceCount < rows.length) {
    throw new Error("legacy PostHog binding count is invalid for quarantine");
  }

  const statements = [CREATE_QUARANTINE_TABLE_SQL, CREATE_RECEIPT_TABLE_SQL];
  for (const row of rows) {
    const rawHash = legacyLoopbackRawRowSha256(row);
    statements.push({
      sql: `INSERT INTO ${QUARANTINE_TABLE} (
              ${QUARANTINE_COLUMNS.join(", ")}
            )
            SELECT ${EXPECTED_SOURCE_COLUMNS.join(", ")}, ?, ?, ?, ?, unixepoch()
              FROM project_posthog_bindings
             WHERE ${exactRowPredicate()}`,
      args: [
        rawHash,
        fixture.fixtureSha256,
        fixture.reviewRef,
        fixture.backupRef,
        ...rawRowArgs(row),
      ],
    });
    statements.push({
      sql: `DELETE FROM project_posthog_bindings
             WHERE ${exactRowPredicate()}
               AND EXISTS (
                 SELECT 1 FROM ${QUARANTINE_TABLE}
                  WHERE project_id = ? AND raw_row_sha256 = ?
               )`,
      args: [...rawRowArgs(row), row.project_id, rawHash],
    });
  }
  statements.push({
    sql: `INSERT INTO ${RECEIPT_TABLE} (
            singleton, fixture_sha256, review_ref, backup_ref, source_row_count
          ) VALUES (
            CASE WHEN
              (SELECT COUNT(*) FROM project_posthog_bindings) = ?
              AND (SELECT COUNT(*) FROM ${QUARANTINE_TABLE}
                    WHERE fixture_sha256 = ?) = ?
            THEN 1 ELSE 0 END,
            ?, ?, ?, ?
          )`,
    args: [
      sourceCount - rows.length,
      fixture.fixtureSha256,
      rows.length,
      fixture.fixtureSha256,
      fixture.reviewRef,
      fixture.backupRef,
      rows.length,
    ],
  });
  await client.batch(statements, "write");
  const receipt = await verifyLegacyLoopbackQuarantine(client, { baselineKind, fixture });
  if (!receipt) throw new Error("legacy loopback quarantine did not write its durable receipt");
  console.log(JSON.stringify({
    migration_adoption_step: "legacy_posthog_loopback_quarantine",
    fixture_sha256: receipt.fixtureSha256,
    review_ref: receipt.reviewRef,
    backup_ref: receipt.backupRef,
    quarantined_rows: receipt.rowCount,
  }));
  return { ...receipt, idempotentReplay: false };
}
