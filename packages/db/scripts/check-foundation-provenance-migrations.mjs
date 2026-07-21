import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@libsql/client";
import { nodeScriptArgs } from "./node-script-args.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectSqlFailure(client, statement, message) {
  let failed = false;
  try {
    await client.execute(statement);
  } catch {
    failed = true;
  }
  invariant(failed, message);
}

const here = dirname(fileURLToPath(import.meta.url));
const foundationMigration = join(here, "migrate-add-automation-foundations.ts");
const provenanceMigration = join(here, "migrate-add-signal-provenance.ts");
const tempDirectory = mkdtempSync(join(tmpdir(), "agentry-foundation-provenance-"));
const databasePath = join(tempDirectory, "legacy.db");
const databaseUrl = `file:${databasePath}`;

try {
  const client = createClient({ url: databaseUrl });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.batch([
    "CREATE TABLE users (id text PRIMARY KEY NOT NULL)",
    "CREATE TABLE projects (id text PRIMARY KEY NOT NULL, user_id text REFERENCES users(id))",
    `CREATE TABLE project_credentials (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind text NOT NULL,
      name text NOT NULL,
      prefix text NOT NULL,
      token_hash text NOT NULL,
      automation_id text,
      created_by text REFERENCES users(id) ON DELETE SET NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL,
      last_used_at integer,
      revoked_at integer,
      revoke_reason text
    )`,
    `CREATE TABLE cases (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      last_trust_level text,
      last_credential_kind text,
      last_credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE events (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      trust_level text,
      credential_kind text,
      credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE webhooks (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      active integer NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE agent_runs (
      id text PRIMARY KEY NOT NULL,
      case_id text REFERENCES cases(id),
      status text NOT NULL,
      summary_md text
    )`,
    `CREATE TABLE automation_runs (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      contract_revision integer NOT NULL,
      contract_etag text NOT NULL,
      policy_snapshot_json text NOT NULL,
      case_id text REFERENCES cases(id) ON DELETE SET NULL,
      case_revision integer,
      trigger_kind text NOT NULL,
      trigger_ref text,
      trigger_snapshot_json text NOT NULL DEFAULT '{}',
      idempotency_key_hash text NOT NULL,
      request_hash text,
      attempt integer NOT NULL DEFAULT 1,
      status text NOT NULL,
      runner_provider text,
      runner_id text,
      model text,
      branch text,
      commit_sha text,
      pr_url text,
      deploy_sha text,
      summary_md text,
      evidence_json text NOT NULL DEFAULT '{}',
      verification_json text,
      error_code text,
      error_message text,
      started_at integer,
      finished_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`,
    `CREATE TABLE case_claims (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      case_revision integer NOT NULL,
      attempt integer NOT NULL,
      run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
      idempotency_key_hash text,
      request_hash text,
      lease_token_hash text NOT NULL,
      lease_token_enc text,
      lease_token_iv text,
      claimed_by text NOT NULL,
      acquired_at integer NOT NULL,
      expires_at integer NOT NULL,
      released_at integer,
      release_reason text
    )`,
    `CREATE TABLE automation_approvals (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      action text NOT NULL,
      status text NOT NULL,
      requested_by text,
      decided_by text REFERENCES users(id) ON DELETE SET NULL,
      request_reason text,
      decision_reason text,
      subject_hash text,
      subject_json text,
      requested_at integer NOT NULL,
      decided_at integer,
      expires_at integer NOT NULL
    )`,
    `CREATE TABLE automation_action_grants (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      action text NOT NULL,
      status text NOT NULL
    )`,
    `CREATE TABLE automation_trigger_receipts (
      id text PRIMARY KEY NOT NULL,
      claim_id text REFERENCES case_claims(id) ON DELETE SET NULL,
      run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
      status text NOT NULL,
      cancelled_at integer,
      cancel_reason text
    )`,
    `CREATE TABLE deploys (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sha text NOT NULL,
      trust_level text,
      credential_kind text,
      credential_id text REFERENCES project_credentials(id) ON DELETE RESTRICT,
      received_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    "INSERT INTO users (id) VALUES ('user-1')",
    "INSERT INTO projects (id, user_id) VALUES ('project-1', 'user-1')",
    "INSERT INTO projects (id, user_id) VALUES ('project-other', 'user-1')",
    `INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, created_by, created_at, expires_at
    ) VALUES
      ('credential-server', 'project-1', 'server_ingest', 'Server', 'agentry_server_test', 'server-hash', 'user-1', 1, 9999999999),
      ('credential-other-server', 'project-other', 'server_ingest', 'Other Server', 'agentry_server_other', 'other-server-hash', 'user-1', 1, 9999999999),
      ('credential-other-ci', 'project-other', 'ci_deploy', 'Other CI', 'agentry_ci_other', 'other-ci-hash', 'user-1', 1, 9999999999),
      ('credential-valid-ci', 'project-1', 'ci_deploy', 'Valid CI', 'agentry_ci_valid', 'valid-ci-hash', 'user-1', 1, 9999999999)
    `,
    "INSERT INTO cases (id, project_id) VALUES ('case-1', 'project-1')",
    `INSERT INTO cases (
      id, project_id, last_trust_level, last_credential_kind, last_credential_id
    ) VALUES
      ('case-trusted-null', 'project-1', 'trusted_server', 'server_ingest', NULL),
      ('case-wrong-kind', 'project-1', 'trusted_server', 'server_ingest', 'credential-valid-ci'),
      ('case-wrong-project', 'project-1', 'trusted_server', 'server_ingest', 'credential-other-server'),
      ('case-valid-server', 'project-1', 'trusted_server', 'server_ingest', 'credential-server')`,
    `INSERT INTO events (
      id, project_id, trust_level, credential_kind, credential_id
    ) VALUES
      ('event-trusted-null', 'project-1', 'trusted_server', 'server_ingest', NULL),
      ('event-wrong-kind', 'project-1', 'trusted_server', 'server_ingest', 'credential-valid-ci'),
      ('event-wrong-project', 'project-1', 'trusted_server', 'server_ingest', 'credential-other-server'),
      ('event-valid-server', 'project-1', 'trusted_server', 'server_ingest', 'credential-server')`,
    "INSERT INTO agent_runs (id, case_id, status, summary_md) VALUES ('legacy-agent-run', 'case-1', 'failed', 'retain me')",
    `INSERT INTO automation_runs (
      id, project_id, automation_id, contract_revision, contract_etag,
      policy_snapshot_json, case_id, case_revision, trigger_kind,
      idempotency_key_hash, request_hash, status, created_at, updated_at
    ) VALUES (
      'legacy-run', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
      'case-1', 1, 'manual', 'legacy-run-idempotency', NULL,
      'running', 10, 10
    )`,
    `INSERT INTO automation_runs (
      id, project_id, automation_id, contract_revision, contract_etag,
      policy_snapshot_json, case_id, case_revision, trigger_kind,
      idempotency_key_hash, request_hash, status, created_at, updated_at
    ) VALUES
      ('invalid-run-complete-chain', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
       'case-1', 2, 'manual', 'idem-invalid-run', NULL, 'running', 11, 11),
      ('valid-run-invalid-claim', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
       'case-1', 3, 'manual', 'idem-invalid-claim', 'request-valid-claim-run', 'running', 12, 12),
      ('valid-run-invalid-approval', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
       'case-1', 4, 'manual', 'idem-invalid-approval', 'request-valid-approval-run', 'awaiting_approval', 13, 13),
      ('premigrated-run-marker', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
       'case-1', 5, 'manual', 'idem-premigrated-run',
       'legacy-unbound:automation-run:premigrated-run-marker', 'running', 14, 14),
      ('premigrated-node-markers', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
       'case-1', 6, 'manual', 'idem-premigrated-nodes', 'request-premigrated-nodes', 'running', 15, 15),
      ('malformed-approval-json-run', 'project-1', 'fix-errors', 1, 'etag-1', '{}',
       'case-1', 7, 'manual', 'idem-malformed-approval', 'request-malformed-approval', 'awaiting_approval', 16, 16)
    `,
    `INSERT INTO case_claims (
      id, project_id, case_id, automation_id, case_revision, attempt, run_id,
      idempotency_key_hash, request_hash, lease_token_hash, lease_token_enc,
      lease_token_iv, claimed_by, acquired_at, expires_at
    ) VALUES (
      'legacy-claim', 'project-1', 'case-1', 'fix-errors', 1, 1, 'legacy-run',
      NULL, NULL, 'old-hash', NULL, NULL, 'old-runner', 10, 9999999999
    )`,
    `INSERT INTO case_claims (
      id, project_id, case_id, automation_id, case_revision, attempt, run_id,
      idempotency_key_hash, request_hash, lease_token_hash, lease_token_enc,
      lease_token_iv, claimed_by, acquired_at, expires_at
    ) VALUES
      ('complete-claim-invalid-run', 'project-1', 'case-1', 'fix-errors', 2, 1,
       'invalid-run-complete-chain', 'claim-idem-a', 'claim-request-a', 'hash-a',
       'enc-a', 'iv-a', 'runner-a', 11, 9999999999),
      ('invalid-claim-valid-run', 'project-1', 'case-1', 'fix-errors', 3, 1,
       'valid-run-invalid-claim', 'claim-idem-b', 'claim-request-b', 'hash-b',
       NULL, 'iv-b', 'runner-b', 12, 9999999999),
      ('complete-claim-invalid-approval', 'project-1', 'case-1', 'fix-errors', 4, 1,
       'valid-run-invalid-approval', 'claim-idem-c', 'claim-request-c', 'hash-c',
       'enc-c', 'iv-c', 'runner-c', 13, 9999999999),
      ('complete-claim-premigrated-run', 'project-1', 'case-1', 'fix-errors', 5, 1,
       'premigrated-run-marker', 'claim-idem-d', 'claim-request-d', 'hash-d',
       'enc-d', 'iv-d', 'runner-d', 14, 9999999999),
      ('premigrated-claim-markers', 'project-1', 'case-1', 'fix-errors', 6, 1,
       'premigrated-node-markers', 'legacy-unbound:case-claim:idempotency:premigrated-claim-markers',
       'legacy-unbound:case-claim:request:premigrated-claim-markers', 'hash-e',
       'legacy-unbound:case-claim:lease-enc:premigrated-claim-markers',
       'legacy-unbound:case-claim:lease-iv:premigrated-claim-markers', 'runner-e', 15, 9999999999),
      ('complete-claim-malformed-approval', 'project-1', 'case-1', 'fix-errors', 7, 1,
       'malformed-approval-json-run', 'claim-idem-f', 'claim-request-f', 'hash-f',
       'enc-f', 'iv-f', 'runner-f', 16, 9999999999),
      ('orphan-unsafe-claim', 'project-1', 'case-1', 'fix-errors', 8, 1,
       NULL, NULL, NULL, 'hash-g', NULL, NULL, 'runner-g', 17, 9999999999)
    `,
    `INSERT INTO automation_approvals (
      id, project_id, automation_id, run_id, action, status, requested_by,
      request_reason, subject_hash, subject_json, requested_at, expires_at
    ) VALUES (
      'legacy-approval', 'project-1', 'fix-errors', 'legacy-run', 'publish',
      'pending', 'old-runner', NULL, NULL, NULL, 10, 9999999999
    )`,
    `INSERT INTO automation_approvals (
      id, project_id, automation_id, run_id, action, status, requested_by,
      request_reason, subject_hash, subject_json, requested_at, expires_at
    ) VALUES
      ('complete-approval-invalid-run', 'project-1', 'fix-errors', 'invalid-run-complete-chain',
       'draft_pr', 'pending', 'runner-a', 'review a', 'subject-a', '{}', 11, 9999999999),
      ('complete-approval-invalid-claim', 'project-1', 'fix-errors', 'valid-run-invalid-claim',
       'draft_pr', 'pending', 'runner-b', 'review b', 'subject-b', '{}', 12, 9999999999),
      ('invalid-approval-valid-run', 'project-1', 'fix-errors', 'valid-run-invalid-approval',
       'draft_pr', 'pending', 'runner-c', 'review c', NULL, '{}', 13, 9999999999),
      ('complete-approval-premigrated-run', 'project-1', 'fix-errors', 'premigrated-run-marker',
       'draft_pr', 'pending', 'runner-d', 'review d', 'subject-d', '{}', 14, 9999999999),
      ('premigrated-approval-markers', 'project-1', 'fix-errors', 'premigrated-node-markers',
       'draft_pr', 'cancelled', 'runner-e', 'Legacy unbound approval premigrated-approval-markers',
       'legacy-unbound:automation-approval:subject:premigrated-approval-markers',
       '{"legacy_unbound":1,"approval_id":"premigrated-approval-markers"}', 15, 9999999999),
      ('malformed-json-approval', 'project-1', 'fix-errors', 'malformed-approval-json-run',
       'draft_pr', 'pending', 'runner-f', 'review f', 'subject-f', 'not-json', 16, 9999999999)
    `,
    `INSERT INTO automation_action_grants (
      id, project_id, automation_id, run_id, action, status
    ) VALUES
      ('grant-a', 'project-1', 'fix-errors', 'invalid-run-complete-chain', 'draft_pr', 'issued'),
      ('grant-b', 'project-1', 'fix-errors', 'valid-run-invalid-claim', 'draft_pr', 'issued'),
      ('grant-c', 'project-1', 'fix-errors', 'valid-run-invalid-approval', 'draft_pr', 'issued'),
      ('grant-d', 'project-1', 'fix-errors', 'premigrated-run-marker', 'draft_pr', 'issued'),
      ('grant-e', 'project-1', 'fix-errors', 'premigrated-node-markers', 'draft_pr', 'issued'),
      ('grant-f', 'project-1', 'fix-errors', 'malformed-approval-json-run', 'draft_pr', 'issued')
    `,
    "UPDATE case_claims SET released_at = 15, release_reason = 'legacy_unbound_authority' WHERE id = 'premigrated-claim-markers'",
    "UPDATE automation_approvals SET decided_at = 15, decision_reason = 'legacy approval was not bound to an immutable action subject' WHERE id = 'premigrated-approval-markers'",
    `INSERT INTO automation_trigger_receipts (
      id, claim_id, run_id, status
    ) VALUES ('receipt-orphan-unsafe-claim', 'orphan-unsafe-claim', NULL, 'claimed')`,
    "INSERT INTO deploys (id, project_id, sha) VALUES ('legacy-deploy', 'project-1', 'legacy-sha')",
    `INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES
      ('wrong-kind-deploy', 'project-1', 'wrong-kind-sha', 'trusted_ci', 'ci_deploy', 'credential-server'),
      ('wrong-project-deploy', 'project-1', 'wrong-project-sha', 'trusted_ci', 'ci_deploy', 'credential-other-ci'),
      ('valid-preexisting-deploy', 'project-1', 'valid-preexisting-sha', 'trusted_ci', 'ci_deploy', 'credential-valid-ci')
    `,
  ], "write");
  await client.execute("PRAGMA foreign_keys = OFF");
  await client.execute(`
    INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES (
      'dangling-credential-deploy', 'project-1', 'dangling-sha',
      'trusted_ci', 'ci_deploy', 'credential-does-not-exist'
    )
  `);
  await client.execute(`
    INSERT INTO events (
      id, project_id, trust_level, credential_kind, credential_id
    ) VALUES (
      'event-dangling', 'project-1', 'trusted_server', 'server_ingest',
      'credential-does-not-exist'
    )
  `);
  await client.execute(`
    INSERT INTO cases (
      id, project_id, last_trust_level, last_credential_kind, last_credential_id
    ) VALUES (
      'case-dangling', 'project-1', 'trusted_server', 'server_ingest',
      'credential-does-not-exist'
    )
  `);
  await client.execute("PRAGMA foreign_keys = ON");

  const runMigration = (path, targetUrl = databaseUrl) => execFileSync(process.execPath, nodeScriptArgs(path), {
    cwd: join(here, ".."),
    env: { ...process.env, TURSO_DATABASE_URL: targetUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  runMigration(foundationMigration);
  const firstRepairTimes = {
    runs: new Map((await client.execute(`
      SELECT id, finished_at FROM automation_runs
       WHERE id IN ('invalid-run-complete-chain', 'valid-run-invalid-claim', 'valid-run-invalid-approval')
    `)).rows.map((row) => [String(row.id), row.finished_at])),
    claims: new Map((await client.execute(`
      SELECT id, released_at FROM case_claims
       WHERE id IN ('complete-claim-invalid-run', 'invalid-claim-valid-run', 'complete-claim-invalid-approval')
    `)).rows.map((row) => [String(row.id), row.released_at])),
    approvals: new Map((await client.execute(`
      SELECT id, decided_at FROM automation_approvals
       WHERE id IN ('complete-approval-invalid-run', 'complete-approval-invalid-claim', 'invalid-approval-valid-run')
    `)).rows.map((row) => [String(row.id), row.decided_at])),
  };
  runMigration(foundationMigration);

  const archived = await client.execute("SELECT status, summary_md FROM agent_runs WHERE id = 'legacy-agent-run'");
  invariant(archived.rows.length === 1, "foundation migration deleted legacy agent_runs history");
  invariant(archived.rows[0]?.summary_md === "retain me", "legacy agent_runs content changed");

  const run = (await client.execute(
    "SELECT status, request_hash, error_code FROM automation_runs WHERE id = 'legacy-run'",
  )).rows[0];
  invariant(run?.status === "cancelled", "unbound active automation run was not terminalized");
  invariant(run?.request_hash === "legacy-unbound:automation-run:legacy-run", "run request marker is not deterministic");
  invariant(run?.error_code === "legacy_unbound_request", "run terminal reason is missing");

  const claim = (await client.execute(
    `SELECT idempotency_key_hash, request_hash, lease_token_enc, lease_token_iv,
            released_at, release_reason
       FROM case_claims WHERE id = 'legacy-claim'`,
  )).rows[0];
  invariant(claim?.released_at !== null, "unbound legacy claim remains active");
  invariant(claim?.release_reason === "legacy_unbound_authority", "claim release reason is missing");
  invariant(
    [claim?.idempotency_key_hash, claim?.request_hash, claim?.lease_token_enc, claim?.lease_token_iv]
      .every((value) => typeof value === "string" && value.includes("legacy-claim")),
    "claim archival fields were not deterministically backfilled",
  );

  const approval = (await client.execute(
    "SELECT status, request_reason, subject_hash, subject_json, decided_at FROM automation_approvals WHERE id = 'legacy-approval'",
  )).rows[0];
  invariant(approval?.status === "cancelled", "unbound legacy approval remains pending");
  invariant(approval?.decided_at !== null, "legacy approval cancellation is not timestamped");
  invariant(String(approval?.request_reason).includes("legacy-approval"), "approval reason marker is missing");
  invariant(String(approval?.subject_hash).includes("legacy-approval"), "approval subject marker is missing");

  const connectedRuns = await client.execute(`
    SELECT id, status, request_hash, error_code, finished_at
      FROM automation_runs
     WHERE id IN ('invalid-run-complete-chain', 'valid-run-invalid-claim', 'valid-run-invalid-approval')
     ORDER BY id
  `);
  invariant(connectedRuns.rows.length === 3, "connected unsafe run fixtures are missing");
  invariant(connectedRuns.rows.every((row) => row.status === "cancelled"), "an unsafe connected run remains active");
  invariant(connectedRuns.rows.every((row) =>
    row.error_code === "legacy_unbound_request" || row.error_code === "legacy_unbound_authority"
  ), "connected run cancellation reason is missing");
  invariant(connectedRuns.rows.every((row) =>
    row.finished_at === firstRepairTimes.runs.get(String(row.id))
  ), "foundation rerun changed connected run completion time");
  invariant(
    connectedRuns.rows.find((row) => row.id === "invalid-run-complete-chain")?.request_hash ===
      "legacy-unbound:automation-run:invalid-run-complete-chain",
    "invalid run request hash was not archived",
  );
  invariant(
    connectedRuns.rows.find((row) => row.id === "valid-run-invalid-claim")?.request_hash ===
      "request-valid-claim-run",
    "valid run request hash was overwritten",
  );

  const connectedClaims = await client.execute(`
    SELECT id, released_at, release_reason, lease_token_enc
      FROM case_claims
     WHERE id IN ('complete-claim-invalid-run', 'invalid-claim-valid-run', 'complete-claim-invalid-approval')
     ORDER BY id
  `);
  invariant(connectedClaims.rows.length === 3, "connected claim fixtures are missing");
  invariant(connectedClaims.rows.every((row) => row.released_at !== null), "a connected claim remains active");
  invariant(connectedClaims.rows.every((row) => row.release_reason === "legacy_unbound_authority"), "claim repair reason is missing");
  invariant(connectedClaims.rows.every((row) =>
    row.released_at === firstRepairTimes.claims.get(String(row.id))
  ), "foundation rerun changed claim release time");
  invariant(
    connectedClaims.rows.find((row) => row.id === "invalid-claim-valid-run")?.lease_token_enc ===
      "legacy-unbound:case-claim:lease-enc:invalid-claim-valid-run",
    "invalid claim encrypted lease marker is missing",
  );
  invariant(
    connectedClaims.rows.find((row) => row.id === "complete-claim-invalid-run")?.lease_token_enc === "enc-a",
    "complete claim evidence was overwritten",
  );

  const connectedApprovals = await client.execute(`
    SELECT id, status, request_reason, subject_hash, decided_at
      FROM automation_approvals
     WHERE id IN ('complete-approval-invalid-run', 'complete-approval-invalid-claim', 'invalid-approval-valid-run')
     ORDER BY id
  `);
  invariant(connectedApprovals.rows.length === 3, "connected approval fixtures are missing");
  invariant(connectedApprovals.rows.every((row) => row.status === "cancelled"), "a connected approval remains authoritative");
  invariant(connectedApprovals.rows.every((row) =>
    row.decided_at === firstRepairTimes.approvals.get(String(row.id))
  ), "foundation rerun changed approval decision time");
  invariant(
    connectedApprovals.rows.find((row) => row.id === "invalid-approval-valid-run")?.subject_hash ===
      "legacy-unbound:automation-approval:subject:invalid-approval-valid-run",
    "invalid approval subject marker is missing",
  );
  invariant(
    connectedApprovals.rows.find((row) => row.id === "complete-approval-invalid-claim")?.subject_hash === "subject-b",
    "complete approval evidence was overwritten",
  );

  const grants = await client.execute(
    "SELECT id, status FROM automation_action_grants WHERE id IN ('grant-a', 'grant-b', 'grant-c')",
  );
  invariant(grants.rows.length === 3, "connected action-grant fixtures are missing");
  invariant(grants.rows.every((row) => row.status === "cancelled"), "issued grant survived connected authority repair");

  const priorMigrationRuns = await client.execute(`
    SELECT id, status, request_hash
      FROM automation_runs
     WHERE id IN ('premigrated-run-marker', 'premigrated-node-markers', 'malformed-approval-json-run')
     ORDER BY id
  `);
  invariant(priorMigrationRuns.rows.length === 3, "prior-migration run fixtures are missing");
  invariant(priorMigrationRuns.rows.every((row) => row.status === "cancelled"), "prior migration markers did not close an active run");
  invariant(
    priorMigrationRuns.rows.find((row) => row.id === "premigrated-node-markers")?.request_hash ===
      "request-premigrated-nodes",
    "marker convergence overwrote valid run evidence",
  );
  const priorMigrationClaims = await client.execute(`
    SELECT id, released_at, release_reason, lease_token_enc
      FROM case_claims
     WHERE id IN ('complete-claim-premigrated-run', 'premigrated-claim-markers', 'complete-claim-malformed-approval')
     ORDER BY id
  `);
  invariant(priorMigrationClaims.rows.every((row) => row.released_at !== null), "prior marker chain retained an active claim");
  invariant(
    priorMigrationClaims.rows.find((row) => row.id === "premigrated-claim-markers")?.released_at === 15,
    "prior migration claim release timestamp changed",
  );
  invariant(
    priorMigrationClaims.rows.find((row) => row.id === "complete-claim-premigrated-run")?.lease_token_enc === "enc-d",
    "complete claim in a prior-marker chain was overwritten",
  );
  const priorMigrationApprovals = await client.execute(`
    SELECT id, status, subject_hash, subject_json, decided_at
      FROM automation_approvals
     WHERE id IN ('complete-approval-premigrated-run', 'premigrated-approval-markers', 'malformed-json-approval')
     ORDER BY id
  `);
  invariant(priorMigrationApprovals.rows.every((row) => row.status === "cancelled"), "prior marker chain retained approval authority");
  invariant(
    priorMigrationApprovals.rows.find((row) => row.id === "premigrated-approval-markers")?.decided_at === 15,
    "prior migration approval decision timestamp changed",
  );
  const repairedMalformed = priorMigrationApprovals.rows.find((row) => row.id === "malformed-json-approval");
  invariant(
    typeof repairedMalformed?.subject_json === "string" &&
      JSON.parse(repairedMalformed.subject_json).legacy_unbound === 1,
    "malformed legacy approval JSON was not safely replaced",
  );
  const priorMigrationGrants = await client.execute(
    "SELECT id, status FROM automation_action_grants WHERE id IN ('grant-d', 'grant-e', 'grant-f')",
  );
  invariant(priorMigrationGrants.rows.every((row) => row.status === "cancelled"), "prior marker chain retained an issued grant");
  const orphanClaim = (await client.execute(`
    SELECT released_at, release_reason FROM case_claims WHERE id = 'orphan-unsafe-claim'
  `)).rows[0];
  invariant(orphanClaim?.released_at !== null, "unsafe orphan claim remains active");
  invariant(orphanClaim?.release_reason === "legacy_unbound_authority", "unsafe orphan claim lacks repair reason");
  const orphanReceipt = (await client.execute(`
    SELECT status, cancelled_at, cancel_reason
      FROM automation_trigger_receipts WHERE id = 'receipt-orphan-unsafe-claim'
  `)).rows[0];
  invariant(orphanReceipt?.status === "cancelled", "claimed trigger receipt survived orphan claim repair");
  invariant(orphanReceipt?.cancelled_at !== null, "trigger receipt cancellation is not timestamped");
  invariant(orphanReceipt?.cancel_reason === "legacy_unbound_authority", "trigger receipt repair reason is missing");

  const expectedTriggers = [
    "automation_runs_request_hash_insert_guard",
    "automation_runs_request_hash_update_guard",
    "case_claims_authority_fields_insert_guard",
    "case_claims_authority_fields_update_guard",
    "automation_approvals_authority_fields_insert_guard",
    "automation_approvals_authority_fields_update_guard",
  ];
  const triggerRows = await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'");
  const triggerNames = new Set(triggerRows.rows.map((row) => String(row.name)));
  invariant(expectedTriggers.every((name) => triggerNames.has(name)), "foundation authority guards are incomplete");

  await expectSqlFailure(
    client,
    "UPDATE automation_runs SET request_hash = '' WHERE id = 'legacy-run'",
    "automation run update accepted an empty request hash",
  );
  for (const column of ["idempotency_key_hash", "request_hash", "lease_token_enc", "lease_token_iv"]) {
    await expectSqlFailure(
      client,
      `UPDATE case_claims SET ${column} = NULL WHERE id = 'legacy-claim'`,
      `case claim update accepted null ${column}`,
    );
  }
  for (const column of ["request_reason", "subject_hash", "subject_json"]) {
    await expectSqlFailure(
      client,
      `UPDATE automation_approvals SET ${column} = '' WHERE id = 'legacy-approval'`,
      `approval update accepted empty ${column}`,
    );
  }
  await expectSqlFailure(
    client,
    `INSERT INTO automation_runs (
      id, project_id, automation_id, contract_revision, contract_etag,
      policy_snapshot_json, trigger_kind, idempotency_key_hash, request_hash,
      status, created_at, updated_at
    ) VALUES ('bad-run', 'project-1', 'fix-errors', 1, 'etag-1', '{}', 'manual', 'bad-idem', '', 'queued', 20, 20)`,
    "automation run insert accepted an empty request hash",
  );
  await expectSqlFailure(
    client,
    `INSERT INTO case_claims (
      id, project_id, case_id, automation_id, case_revision, attempt,
      idempotency_key_hash, request_hash, lease_token_hash, lease_token_enc,
      lease_token_iv, claimed_by, acquired_at, expires_at
    ) VALUES ('bad-claim', 'project-1', 'case-1', 'fix-errors', 2, 1,
      'bad-claim-idem', 'bad-request', 'hash', '', 'iv', 'runner', 20, 30)`,
    "case claim insert accepted an empty encrypted lease field",
  );
  await expectSqlFailure(
    client,
    `INSERT INTO automation_approvals (
      id, project_id, automation_id, run_id, action, status, request_reason,
      subject_hash, subject_json, requested_at, expires_at
    ) VALUES ('bad-approval', 'project-1', 'fix-errors', 'legacy-run', 'publish',
      'pending', 'reason', '', '{}', 20, 30)`,
    "approval insert accepted an empty subject hash",
  );

  runMigration(provenanceMigration);
  const repairedInvalidEvents = await client.execute(`
    SELECT id, trust_level, credential_kind, credential_id
      FROM events
     WHERE id IN ('event-trusted-null', 'event-wrong-kind', 'event-wrong-project', 'event-dangling')
  `);
  invariant(repairedInvalidEvents.rows.length === 4, "invalid event provenance fixtures are missing");
  invariant(repairedInvalidEvents.rows.every((row) =>
    row.trust_level === "untrusted_browser" &&
    row.credential_kind === "browser_public" &&
    row.credential_id === null
  ), "invalid event credential references retained trusted-server labels");
  const repairedInvalidCases = await client.execute(`
    SELECT id, last_trust_level, last_credential_kind, last_credential_id
      FROM cases
     WHERE id IN ('case-trusted-null', 'case-wrong-kind', 'case-wrong-project', 'case-dangling')
  `);
  invariant(repairedInvalidCases.rows.length === 4, "invalid case provenance fixtures are missing");
  invariant(repairedInvalidCases.rows.every((row) =>
    row.last_trust_level === "untrusted_browser" &&
    row.last_credential_kind === "browser_public" &&
    row.last_credential_id === null
  ), "invalid case credential references retained trusted-server labels");
  const validServerEvent = (await client.execute(`
    SELECT trust_level, credential_kind, credential_id
      FROM events WHERE id = 'event-valid-server'
  `)).rows[0];
  invariant(
    validServerEvent?.trust_level === "trusted_server" &&
    validServerEvent?.credential_kind === "server_ingest" &&
    validServerEvent?.credential_id === "credential-server",
    "valid server event provenance was downgraded",
  );
  const validServerCase = (await client.execute(`
    SELECT last_trust_level, last_credential_kind, last_credential_id
      FROM cases WHERE id = 'case-valid-server'
  `)).rows[0];
  invariant(
    validServerCase?.last_trust_level === "trusted_server" &&
    validServerCase?.last_credential_kind === "server_ingest" &&
    validServerCase?.last_credential_id === "credential-server",
    "valid server case provenance was downgraded",
  );
  const legacyDeploy = (await client.execute(
    "SELECT trust_level, credential_kind, credential_id FROM deploys WHERE id = 'legacy-deploy'",
  )).rows[0];
  invariant(legacyDeploy?.trust_level === "legacy_unverified", "legacy deploy was falsely trusted");
  invariant(legacyDeploy?.credential_kind === "legacy_deploy", "legacy deploy kind is falsely CI-bound");
  invariant(legacyDeploy?.credential_id === null, "legacy deploy unexpectedly gained a credential");
  const repairedInvalidDeploys = await client.execute(`
    SELECT id, trust_level, credential_kind, credential_id
      FROM deploys
     WHERE id IN ('wrong-kind-deploy', 'wrong-project-deploy', 'dangling-credential-deploy')
  `);
  invariant(repairedInvalidDeploys.rows.length === 3, "invalid legacy deploy fixtures are missing");
  invariant(repairedInvalidDeploys.rows.every((row) =>
    row.trust_level === "legacy_unverified" &&
    row.credential_kind === "legacy_deploy" &&
    row.credential_id === null
  ), "invalid credential references retained manufactured trusted CI provenance");
  const validPreexisting = (await client.execute(`
    SELECT trust_level, credential_kind, credential_id
      FROM deploys WHERE id = 'valid-preexisting-deploy'
  `)).rows[0];
  invariant(validPreexisting?.trust_level === "trusted_ci", "valid preexisting CI deploy was downgraded");
  invariant(validPreexisting?.credential_id === "credential-valid-ci", "valid preexisting CI credential was cleared");

  await client.execute(`
    INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, created_by, created_at, expires_at
    ) VALUES (
      'credential-ci', 'project-1', 'ci_deploy', 'CI', 'agentry_ci_test',
      'ci-token-hash', 'user-1', 20, 9999999999
    )
  `);
  await client.execute(`
    INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES (
      'trusted-deploy', 'project-1', 'trusted-sha', 'trusted_ci', 'ci_deploy', 'credential-ci'
    )
  `);
  await expectSqlFailure(
    client,
    `INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES ('false-trust', 'project-1', 'bad-sha', 'trusted_ci', 'ci_deploy', NULL)`,
    "deploy insert manufactured trusted CI provenance without a credential",
  );
  await expectSqlFailure(
    client,
    `INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES ('null-provenance', 'project-1', 'null-sha', NULL, NULL, NULL)`,
    "nullable legacy deploy table accepted SQL-NULL provenance",
  );
  await expectSqlFailure(
    client,
    "UPDATE deploys SET trust_level = 'trusted_ci', credential_kind = 'ci_deploy' WHERE id = 'legacy-deploy'",
    "deploy update manufactured trusted CI provenance without a credential",
  );
  await expectSqlFailure(
    client,
    `UPDATE deploys
        SET trust_level = 'trusted_ci',
            credential_kind = 'ci_deploy',
            credential_id = 'credential-ci'
      WHERE id = 'legacy-deploy'`,
    "deploy update manufactured trusted CI provenance from an active credential",
  );
  await expectSqlFailure(
    client,
    `UPDATE deploys
        SET credential_id = 'credential-valid-ci'
      WHERE id = 'trusted-deploy'`,
    "deploy update rebound immutable CI provenance to another credential",
  );
  await client.execute(
    "UPDATE project_credentials SET revoked_at = 30 WHERE id = 'credential-ci'",
  );
  await expectSqlFailure(
    client,
    `UPDATE deploys
        SET trust_level = 'trusted_ci',
            credential_kind = 'ci_deploy',
            credential_id = 'credential-ci'
      WHERE id = 'legacy-deploy'`,
    "deploy update manufactured trusted CI provenance from a revoked credential",
  );
  await client.execute(`
    UPDATE deploys
       SET trust_level = trust_level,
           credential_kind = credential_kind,
           credential_id = credential_id
     WHERE id = 'trusted-deploy'
  `);
  await expectSqlFailure(
    client,
    "DELETE FROM project_credentials WHERE id = 'credential-ci'",
    "physical credential deletion stripped provenance from retained trusted deploy history",
  );

  runMigration(provenanceMigration);
  const finalDeploys = await client.execute(
    "SELECT id, trust_level, credential_kind, credential_id FROM deploys ORDER BY id",
  );
  const finalLegacy = finalDeploys.rows.find((row) => row.id === "legacy-deploy");
  const finalTrusted = finalDeploys.rows.find((row) => row.id === "trusted-deploy");
  invariant(finalLegacy?.trust_level === "legacy_unverified", "second migration falsely trusted legacy deploy");
  invariant(finalTrusted?.trust_level === "trusted_ci", "credential-bound CI deploy lost trust");
  invariant(finalTrusted?.credential_kind === "ci_deploy", "credential-bound CI kind changed");
  invariant(finalTrusted?.credential_id === "credential-ci", "credential-bound CI provenance was lost");

  await client.execute("INSERT INTO projects (id, user_id) VALUES ('project-cascade', 'user-1')");
  await client.execute(`
    INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, created_by, created_at, expires_at
    ) VALUES (
      'credential-cascade', 'project-cascade', 'ci_deploy', 'Cascade CI',
      'agentry_ci_cascade', 'ci-cascade-hash', 'user-1', 20, 9999999999
    )
  `);
  await client.execute(`
    INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES (
      'deploy-cascade', 'project-cascade', 'cascade-sha',
      'trusted_ci', 'ci_deploy', 'credential-cascade'
    )
  `);
  await client.execute("DELETE FROM projects WHERE id = 'project-cascade'");
  const cascadeRows = await client.execute(
    "SELECT COUNT(*) AS count FROM deploys WHERE project_id = 'project-cascade'",
  );
  invariant(Number(cascadeRows.rows[0]?.count) === 0, "provenance guards blocked project cascade cleanup");

  client.close();

  const partialDatabaseUrl = `file:${join(tempDirectory, "partial-credentials.db")}`;
  const partialClient = createClient({ url: partialDatabaseUrl });
  await partialClient.execute("PRAGMA foreign_keys = ON");
  await partialClient.batch([
    "CREATE TABLE users (id text PRIMARY KEY NOT NULL)",
    "CREATE TABLE projects (id text PRIMARY KEY NOT NULL, user_id text REFERENCES users(id))",
    `CREATE TABLE project_credentials (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind text NOT NULL
    )`,
    "CREATE TABLE events (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE)",
    "CREATE TABLE cases (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE)",
    "CREATE TABLE automation_runs (id text PRIMARY KEY NOT NULL)",
    "CREATE TABLE case_claims (id text PRIMARY KEY NOT NULL)",
    `CREATE TABLE deploys (
      id text PRIMARY KEY NOT NULL,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sha text NOT NULL,
      trust_level text,
      credential_kind text,
      credential_id text REFERENCES project_credentials(id) ON DELETE RESTRICT
    )`,
    "INSERT INTO users (id) VALUES ('partial-user')",
    "INSERT INTO projects (id, user_id) VALUES ('partial-project', 'partial-user')",
    `INSERT INTO project_credentials (id, project_id, kind) VALUES
      ('partial-server', 'partial-project', 'server_ingest'),
      ('partial-ci', 'partial-project', 'ci_deploy')`,
    `INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id
    ) VALUES (
      'partial-deploy', 'partial-project', 'partial-sha',
      'trusted_ci', 'ci_deploy', 'partial-ci'
    )`,
  ], "write");

  runMigration(provenanceMigration, partialDatabaseUrl);
  const disabledCredentials = await partialClient.execute(`
    SELECT id, token_hash, expires_at, revoked_at, revoke_reason
      FROM project_credentials
     ORDER BY id
  `);
  invariant(disabledCredentials.rows.length === 2, "partial credential rows were lost");
  invariant(disabledCredentials.rows.every((row) =>
    row.token_hash === `legacy-disabled:${String(row.id)}` &&
    Number(row.expires_at) === 0 &&
    row.revoked_at !== null &&
    row.revoke_reason === "legacy_partial_credential_schema"
  ), "partial credential rows were not converted to disabled provenance tombstones");
  const partialDeploy = (await partialClient.execute(`
    SELECT trust_level, credential_kind, credential_id
      FROM deploys WHERE id = 'partial-deploy'
  `)).rows[0];
  invariant(
    partialDeploy?.trust_level === "legacy_unverified" &&
    partialDeploy?.credential_kind === "legacy_deploy" &&
    partialDeploy?.credential_id === null,
    "a partial-schema credential retained manufactured trusted deploy authority",
  );
  await expectSqlFailure(
    partialClient,
    `INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, created_at, expires_at
    ) VALUES (
      'incomplete-new', 'partial-project', 'ci_deploy', '', '', '', 0, 0
    )`,
    "credential guard accepted incomplete new authority fields",
  );
  await partialClient.execute(`
    INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, created_at, expires_at
    ) VALUES (
      'complete-new', 'partial-project', 'ci_deploy', 'CI',
      'agentry_ci_complete', 'complete-token-hash', 10, 9999999999
    )
  `);
  runMigration(provenanceMigration, partialDatabaseUrl);
  const rerunDisabled = (await partialClient.execute(`
    SELECT token_hash, revoke_reason FROM project_credentials WHERE id = 'partial-ci'
  `)).rows[0];
  invariant(
    rerunDisabled?.token_hash === "legacy-disabled:partial-ci" &&
    rerunDisabled?.revoke_reason === "legacy_partial_credential_schema",
    "provenance rerun changed a disabled credential tombstone",
  );
  const rerunComplete = (await partialClient.execute(`
    SELECT token_hash, revoked_at FROM project_credentials WHERE id = 'complete-new'
  `)).rows[0];
  invariant(
    rerunComplete?.token_hash === "complete-token-hash" && rerunComplete?.revoked_at === null,
    "provenance rerun disabled a complete credential",
  );
  partialClient.close();
  console.log("automation foundation and signal provenance migration self-test passed");
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
