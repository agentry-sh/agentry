#!/usr/bin/env node

import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const PROJECT_ENV = "AGENTRY_BOOTSTRAP_PROJECT_ID";
const REVIEW_ENV = "AGENTRY_LEGACY_BASELINE_REVIEW_REF";
const OWNER_KEY_ENV = "AGENTRY_PRIVATE_API_KEY";
const OWNER_KEY_PATTERN = /^agentry_sk_[A-Za-z0-9_-]{32}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function tableExists(client, name) {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [name],
  });
  return result.rows.length === 1;
}

export async function verifyCiAttributionBootstrapEligibility({
  databaseUrl = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
  projectId = process.env[PROJECT_ENV],
  reviewRef = process.env[REVIEW_ENV],
  ownerApiKey = process.env[OWNER_KEY_ENV],
  createDatabaseClient = createClient,
} = {}) {
  const normalizedProjectId = typeof projectId === "string" ? projectId.trim() : "";
  const normalizedReviewRef = typeof reviewRef === "string" ? reviewRef.trim() : "";
  const normalizedOwnerApiKey = typeof ownerApiKey === "string" ? ownerApiKey.trim() : "";
  if (!databaseUrl) throw new Error("TURSO_DATABASE_URL not set");
  if (!normalizedProjectId) throw new Error(`${PROJECT_ENV} not set`);
  if (!normalizedReviewRef) throw new Error(`${REVIEW_ENV} not set`);
  if (!OWNER_KEY_PATTERN.test(normalizedOwnerApiKey)) {
    throw new Error(`${OWNER_KEY_ENV} is not a valid private owner key`);
  }
  const ownerKeyHash = sha256(normalizedOwnerApiKey);

  const client = createDatabaseClient({ url: databaseUrl, authToken });
  try {
    const schema = await client.execute(
      `SELECT type, name
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
          AND type IN ('table', 'view', 'trigger', 'index')
        ORDER BY type, name`,
    );
    if (schema.rows.length === 0) {
      throw new Error("CI attribution bootstrap requires a nonempty reviewed legacy database");
    }

    const coreMetadata = schema.rows.filter((row) => String(row.name).startsWith("_agentry_core_"));
    let adoptionState = "untracked_legacy";
    if (coreMetadata.length > 0) {
      if (!await tableExists(client, "_agentry_core_baseline")) {
        throw new Error(
          "CI attribution bootstrap found partial core metadata without a baseline receipt",
        );
      }
      const baseline = await client.execute(
        "SELECT kind, review_ref FROM _agentry_core_baseline WHERE singleton = 1",
      );
      if (
        baseline.rows.length !== 1
        || String(baseline.rows[0].kind) !== "legacy_reviewed"
        || String(baseline.rows[0].review_ref ?? "") !== normalizedReviewRef
      ) {
        throw new Error(
          "CI attribution bootstrap retry requires the same legacy-reviewed baseline and exact review reference",
        );
      }
      adoptionState = "reviewed_legacy_retry";
    }
    if (!await tableExists(client, "projects")) {
      throw new Error("CI attribution bootstrap requires the legacy projects table");
    }
    const project = await client.execute({
      sql: "SELECT id FROM projects WHERE id = ? LIMIT 2",
      args: [normalizedProjectId],
    });
    if (project.rows.length !== 1 || String(project.rows[0].id) !== normalizedProjectId) {
      throw new Error("CI attribution bootstrap project does not exist exactly once in the target database");
    }
    if (!await tableExists(client, "api_keys")) {
      throw new Error("CI attribution bootstrap requires the legacy private api_keys table");
    }
    let ownerKeyBinding;
    try {
      ownerKeyBinding = await client.execute({
        sql: `SELECT COUNT(*) AS count
                FROM projects AS project
                JOIN api_keys AS owner_key
                  ON owner_key.user_id = project.user_id
               WHERE project.id = ?
                 AND owner_key.key_hash = ?
                 AND owner_key.kind = 'private'
                 AND owner_key.revoked_at IS NULL`,
        args: [normalizedProjectId, ownerKeyHash],
      });
    } catch {
      throw new Error(
        "CI attribution bootstrap could not verify the active private project-owner key binding",
      );
    }
    const ownerKeyBindingCount = Number(ownerKeyBinding.rows[0]?.count ?? Number.NaN);
    if (!Number.isSafeInteger(ownerKeyBindingCount) || ownerKeyBindingCount !== 1) {
      throw new Error(
        "CI attribution bootstrap requires exactly one active private owner key bound to the exact project owner",
      );
    }

    const hasCredentialTable = await tableExists(client, "project_credentials");
    if (hasCredentialTable) {
      const credentials = await client.execute("SELECT COUNT(*) AS count FROM project_credentials");
      const credentialCount = Number(credentials.rows[0]?.count ?? Number.NaN);
      if (!Number.isSafeInteger(credentialCount) || credentialCount !== 0) {
        throw new Error(
          "CI attribution bootstrap requires the legacy database to contain zero project credential rows",
        );
      }
    }

    return Object.freeze({
      ok: true,
      eligibility: "untracked_legacy_first_ci_credential",
      adoption_state: adoptionState,
      project_id: normalizedProjectId,
      owner_key_binding: "active_private_project_owner",
      project_credentials: hasCredentialTable ? "empty" : "missing",
    });
  } finally {
    client.close();
  }
}

async function main() {
  console.log(JSON.stringify(await verifyCiAttributionBootstrapEligibility()));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(
      "CI attribution bootstrap eligibility failed:",
      error instanceof Error ? error.message : "unexpected failure",
    );
    process.exitCode = 1;
  });
}

export {
  OWNER_KEY_ENV,
  PROJECT_ENV as BOOTSTRAP_PROJECT_ENV,
  REVIEW_ENV as LEGACY_REVIEW_ENV,
};
