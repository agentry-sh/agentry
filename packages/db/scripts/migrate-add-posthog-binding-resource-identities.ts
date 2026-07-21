// Backfill legacy PostHog environment/team -> project-resource identity from a
// reviewed, nonsecret fixture. This migration never calls PostHog and never
// guesses an identity from the deployment's current credentials.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";

const FIXTURE_FILE_ENV = "AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_FILE";
const FIXTURE_SHA_ENV = "AGENTRY_POSTHOG_BINDING_IDENTITY_BACKFILL_SHA256";
const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;

const IMMUTABLE_TRIGGER_SQL = `CREATE TRIGGER project_posthog_bindings_immutable_update_guard
  BEFORE UPDATE ON project_posthog_bindings
  BEGIN
    SELECT RAISE(ABORT, 'project_posthog_bindings rows are immutable');
  END`;

const IDENTITY_INSERT_TRIGGER_SQL = `CREATE TRIGGER project_posthog_bindings_identity_insert_guard
  BEFORE INSERT ON project_posthog_bindings
  WHEN NEW.posthog_project_id < 1
    OR NEW.posthog_project_resource_id IS NULL
    OR NEW.posthog_project_resource_id < 1
    OR NEW.posthog_org_id IS NULL
    OR trim(NEW.posthog_org_id) = ''
  BEGIN
    SELECT RAISE(ABORT, 'project_posthog_bindings requires exact provider identity');
  END`;

interface FixtureBinding {
  agentryProjectId: string;
  posthogHost: string;
  posthogOrgId: string;
  posthogEnvironmentId: number;
  posthogProjectResourceId: number;
  posthogProjectApiKeySha256: string;
}

interface BackfillFixture {
  schemaVersion: 1;
  reviewRef: string;
  fixtureSha256: string;
  bindings: FixtureBinding[];
}

interface StoredBinding {
  projectId: string;
  posthogEnvironmentId: number;
  posthogProjectResourceId: number | null;
  posthogOrgId: string | null;
  posthogProjectApiKey: string;
  posthogHost: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHost(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 500) {
    throw new Error(`${label} must be an absolute URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
    .has(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `${label} must use HTTPS (or loopback HTTP) and contain no credentials, query, or fragment`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function requiredString(value: unknown, label: string, maxLength = 500): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
  return record;
}

function readFixture(): BackfillFixture | null {
  const file = process.env[FIXTURE_FILE_ENV]?.trim() ?? "";
  const expectedSha = process.env[FIXTURE_SHA_ENV]?.trim() ?? "";
  if (!file && !expectedSha) return null;
  if (!file || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error(
      `legacy PostHog identity backfill requires both ${FIXTURE_FILE_ENV} and a lowercase 64-character ${FIXTURE_SHA_ENV}`,
    );
  }
  const stat = statSync(file);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_FIXTURE_BYTES) {
    throw new Error(
      `legacy PostHog identity fixture must be a 2-${MAX_FIXTURE_BYTES} byte regular file`,
    );
  }
  const raw = readFileSync(file);
  const actualSha = sha256(raw);
  if (actualSha !== expectedSha) {
    throw new Error(
      `legacy PostHog identity fixture SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("legacy PostHog identity fixture must be valid JSON");
  }
  const root = exactObject(
    decoded,
    ["schema_version", "review_ref", "bindings"],
    "legacy PostHog identity fixture",
  );
  if (root.schema_version !== 1) {
    throw new Error("legacy PostHog identity fixture schema_version must be 1");
  }
  const reviewRef = requiredString(root.review_ref, "legacy PostHog identity fixture review_ref");
  if (!Array.isArray(root.bindings)) {
    throw new Error("legacy PostHog identity fixture bindings must be an array");
  }
  const bindings = root.bindings.map((value, index): FixtureBinding => {
    const label = `legacy PostHog identity fixture bindings[${index}]`;
    const row = exactObject(value, [
      "agentry_project_id",
      "posthog_host",
      "posthog_org_id",
      "posthog_environment_id",
      "posthog_project_resource_id",
      "posthog_project_api_key_sha256",
    ], label);
    const apiKeySha = requiredString(
      row.posthog_project_api_key_sha256,
      `${label}.posthog_project_api_key_sha256`,
      64,
    );
    if (!/^[a-f0-9]{64}$/.test(apiKeySha)) {
      throw new Error(`${label}.posthog_project_api_key_sha256 must be a lowercase SHA-256`);
    }
    return {
      agentryProjectId: requiredString(row.agentry_project_id, `${label}.agentry_project_id`, 200),
      posthogHost: normalizeHost(row.posthog_host, `${label}.posthog_host`),
      posthogOrgId: requiredString(row.posthog_org_id, `${label}.posthog_org_id`, 200),
      posthogEnvironmentId: positiveSafeInteger(
        row.posthog_environment_id,
        `${label}.posthog_environment_id`,
      ),
      posthogProjectResourceId: positiveSafeInteger(
        row.posthog_project_resource_id,
        `${label}.posthog_project_resource_id`,
      ),
      posthogProjectApiKeySha256: apiKeySha,
    };
  });
  for (const [field, values] of [
    ["agentry_project_id", bindings.map((row) => row.agentryProjectId)],
    ["posthog_environment_id", bindings.map((row) => String(row.posthogEnvironmentId))],
    [
      "posthog_host/posthog_project_resource_id",
      bindings.map((row) =>
        `${row.posthogHost}\u0000${row.posthogProjectResourceId}`
      ),
    ],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new Error(`legacy PostHog identity fixture has duplicate ${field}`);
    }
  }
  return { schemaVersion: 1, reviewRef, fixtureSha256: actualSha, bindings };
}

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function storedBindings(client: Client): Promise<StoredBinding[]> {
  const result = await client.execute(
    `SELECT project_id, posthog_project_id, posthog_project_resource_id,
            posthog_org_id, posthog_project_api_key, posthog_host
       FROM project_posthog_bindings
      ORDER BY project_id`,
  );
  return result.rows.map((row) => ({
    projectId: String(row.project_id),
    posthogEnvironmentId: Number(row.posthog_project_id),
    posthogProjectResourceId:
      row.posthog_project_resource_id === null
        ? null
        : Number(row.posthog_project_resource_id),
    posthogOrgId: row.posthog_org_id === null ? null : String(row.posthog_org_id),
    posthogProjectApiKey: String(row.posthog_project_api_key),
    posthogHost: String(row.posthog_host),
  }));
}

function identityIncomplete(row: StoredBinding): boolean {
  return !Number.isSafeInteger(row.posthogEnvironmentId) ||
    row.posthogEnvironmentId < 1 ||
    !Number.isSafeInteger(row.posthogProjectResourceId) ||
    (row.posthogProjectResourceId ?? 0) < 1 ||
    row.posthogOrgId === null ||
    row.posthogOrgId.trim() === "";
}

function validateFixtureAgainstDatabase(
  fixture: BackfillFixture,
  rows: StoredBinding[],
): Map<string, FixtureBinding> {
  if (fixture.bindings.length !== rows.length) {
    throw new Error(
      `legacy PostHog identity fixture covers ${fixture.bindings.length} binding(s), but the database has ${rows.length}; provide one reviewed full snapshot`,
    );
  }
  const byProject = new Map(fixture.bindings.map((row) => [row.agentryProjectId, row]));
  for (const stored of rows) {
    const expected = byProject.get(stored.projectId);
    if (!expected) {
      throw new Error(`legacy PostHog identity fixture is missing project ${stored.projectId}`);
    }
    if (normalizeHost(stored.posthogHost, `stored PostHog host for ${stored.projectId}`) !== expected.posthogHost) {
      throw new Error(`legacy PostHog identity host mismatch for project ${stored.projectId}`);
    }
    if (stored.posthogEnvironmentId !== expected.posthogEnvironmentId) {
      throw new Error(`legacy PostHog environment/team id mismatch for project ${stored.projectId}`);
    }
    if (sha256(stored.posthogProjectApiKey) !== expected.posthogProjectApiKeySha256) {
      throw new Error(`legacy PostHog project API key hash mismatch for project ${stored.projectId}`);
    }
    if (
      stored.posthogOrgId !== null &&
      stored.posthogOrgId.trim() !== "" &&
      stored.posthogOrgId !== expected.posthogOrgId
    ) {
      throw new Error(`legacy PostHog organization id mismatch for project ${stored.projectId}`);
    }
    if (
      stored.posthogProjectResourceId !== null &&
      stored.posthogProjectResourceId > 0 &&
      stored.posthogProjectResourceId !== expected.posthogProjectResourceId
    ) {
      throw new Error(`legacy PostHog project resource id mismatch for project ${stored.projectId}`);
    }
  }
  return byProject;
}

async function main(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    const columns = await tableColumns(client, "project_posthog_bindings");
    for (const column of [
      "project_id",
      "posthog_project_id",
      "posthog_project_resource_id",
      "posthog_org_id",
      "posthog_project_api_key",
      "posthog_host",
    ]) {
      if (!columns.has(column)) {
        throw new Error(
          `project_posthog_bindings.${column} is missing; run earlier core migrations first`,
        );
      }
    }

    const rows = await storedBindings(client);
    const incomplete = rows.filter(identityIncomplete);
    const fixture = readFixture();
    if (incomplete.length > 0 && !fixture) {
      throw new Error(
        `${incomplete.length} legacy PostHog binding(s) lack exact environment/team -> project-resource identity; ` +
        `provide the reviewed ${FIXTURE_FILE_ENV} and ${FIXTURE_SHA_ENV}`,
      );
    }
    const fixtureByProject = fixture
      ? validateFixtureAgainstDatabase(fixture, rows)
      : new Map<string, FixtureBinding>();

    const statements: Array<string | { sql: string; args: unknown[] }> = [
      "DROP TRIGGER IF EXISTS project_posthog_bindings_immutable_update_guard",
      "DROP TRIGGER IF EXISTS project_posthog_bindings_identity_insert_guard",
      "DROP INDEX IF EXISTS project_posthog_bindings_ph_resource_idx",
    ];
    for (const stored of incomplete) {
      const expected = fixtureByProject.get(stored.projectId);
      if (!expected) {
        throw new Error(`legacy PostHog identity fixture is missing project ${stored.projectId}`);
      }
      statements.push({
        sql: `UPDATE project_posthog_bindings
                 SET posthog_project_resource_id = ?, posthog_org_id = ?
               WHERE project_id = ?
                 AND posthog_project_id = ?
                 AND posthog_project_api_key = ?
                 AND posthog_host = ?
                 AND (posthog_org_id IS NULL OR trim(posthog_org_id) = '' OR posthog_org_id = ?)
                 AND (posthog_project_resource_id IS NULL OR posthog_project_resource_id < 1 OR posthog_project_resource_id = ?)`,
        args: [
          expected.posthogProjectResourceId,
          expected.posthogOrgId,
          stored.projectId,
          stored.posthogEnvironmentId,
          stored.posthogProjectApiKey,
          stored.posthogHost,
          expected.posthogOrgId,
          expected.posthogProjectResourceId,
        ],
      });
    }
    statements.push(
      `CREATE UNIQUE INDEX project_posthog_bindings_ph_resource_idx
        ON project_posthog_bindings (
          posthog_host, posthog_project_resource_id
        )`,
      IMMUTABLE_TRIGGER_SQL,
      IDENTITY_INSERT_TRIGGER_SQL,
    );
    await client.batch(statements, "write");

    const verified = await storedBindings(client);
    const unresolved = verified.filter(identityIncomplete);
    if (unresolved.length > 0) {
      throw new Error(
        `legacy PostHog identity backfill left ${unresolved.length} unresolved binding(s)`,
      );
    }
    if (fixture) validateFixtureAgainstDatabase(fixture, verified);
    console.log(JSON.stringify({
      migration: "posthog_binding_resource_identity",
      review_ref: fixture?.reviewRef ?? null,
      fixture_sha256: fixture?.fixtureSha256 ?? null,
      updated_rows: incomplete.length,
      verified_rows: verified.length,
    }));
  } finally {
    client.close();
  }
}

await main();
