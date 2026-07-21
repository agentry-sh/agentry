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

const here = dirname(fileURLToPath(import.meta.url));
const foundationMigration = join(here, "migrate-add-automation-foundations.ts");
const provenanceMigration = join(here, "migrate-add-signal-provenance.ts");
const migration = join(here, "migrate-add-automation-orchestration.ts");
const tempDirectory = mkdtempSync(join(tmpdir(), "agentry-orchestration-migration-"));
const databasePath = join(tempDirectory, "legacy.db");
const databaseUrl = `file:${databasePath}`;

try {
  const client = createClient({ url: databaseUrl });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.batch(
    [
      "CREATE TABLE users (id text PRIMARY KEY NOT NULL)",
      "CREATE TABLE projects (id text PRIMARY KEY NOT NULL)",
      `CREATE TABLE project_credentials (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL,
        token_hash text NOT NULL
      )`,
      `CREATE TABLE cases (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        revision integer NOT NULL DEFAULT 1,
        last_trust_level text NOT NULL DEFAULT 'untrusted_browser',
        last_credential_kind text NOT NULL DEFAULT 'browser_public',
        last_credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL
      )`,
      `CREATE TABLE automation_contracts (
        project_id text PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        schema_version text NOT NULL DEFAULT '2',
        revision integer NOT NULL,
        enabled integer NOT NULL DEFAULT 1,
        etag text NOT NULL,
        document_json text NOT NULL DEFAULT '{}',
        created_by text,
        updated_by text,
        created_at integer NOT NULL DEFAULT 0,
        updated_at integer NOT NULL DEFAULT 0,
        paused_at integer,
        pause_reason text
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
        request_hash text NOT NULL,
        attempt integer NOT NULL DEFAULT 1,
        status text NOT NULL DEFAULT 'queued',
        runner_provider text,
        runner_id text,
        runner_credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL,
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
        created_at integer NOT NULL DEFAULT (unixepoch()),
        updated_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE TABLE case_claims (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        case_revision integer NOT NULL,
        attempt integer NOT NULL,
        run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
        idempotency_key_hash text NOT NULL,
        request_hash text NOT NULL,
        lease_token_hash text NOT NULL,
        lease_token_enc text NOT NULL,
        lease_token_iv text NOT NULL,
        claimed_by text NOT NULL,
        credential_id text REFERENCES project_credentials(id) ON DELETE SET NULL,
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
        decided_by text,
        request_reason text NOT NULL,
        decision_reason text,
        subject_hash text NOT NULL,
        subject_json text NOT NULL,
        requested_at integer NOT NULL,
        decided_at integer,
        expires_at integer NOT NULL
      )`,
      `CREATE TABLE deploys (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sha text NOT NULL,
        trust_level text NOT NULL DEFAULT 'legacy_unverified',
        credential_kind text NOT NULL DEFAULT 'legacy_deploy',
        credential_id text REFERENCES project_credentials(id) ON DELETE RESTRICT,
        received_at integer NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE TABLE events (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE webhooks (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        active integer NOT NULL DEFAULT 1
      )`,
      `CREATE TABLE agent_runs (
        id text PRIMARY KEY NOT NULL,
        case_id text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
        started_at integer NOT NULL,
        status text NOT NULL,
        summary_md text
      )`,
      `CREATE TABLE automation_trigger_receipts (
        id text PRIMARY KEY NOT NULL,
        claim_id text,
        run_id text,
        status text NOT NULL,
        cancelled_at integer,
        cancel_reason text
      )`,
      `CREATE TABLE automation_action_grants (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        automation_id text NOT NULL,
        run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
        action text NOT NULL,
        status text NOT NULL
      )`,
      `CREATE TRIGGER automation_runs_orchestration_fields_insert
        BEFORE INSERT ON automation_runs
        BEGIN SELECT 1; END`,
      "INSERT INTO users (id) VALUES ('user-1')",
      "INSERT INTO projects (id) VALUES ('project-1')",
      "INSERT INTO cases (id, project_id) VALUES ('case-1', 'project-1')",
      "INSERT INTO automation_contracts (project_id, revision, etag) VALUES ('project-1', 4, 'etag-4')",
      `INSERT INTO automation_runs (
        id, project_id, automation_id, contract_revision, contract_etag,
        policy_snapshot_json, case_id, case_revision, trigger_kind,
        idempotency_key_hash, request_hash, status, started_at, created_at, updated_at
      ) VALUES (
        'run-active', 'project-1', 'fix-errors', 4, 'etag-4', '{}',
        'case-1', 7, 'unhandled_cases', 'idem-active', 'request-active',
        'running', 100, 90, 110
      )`,
      `INSERT INTO automation_runs (
        id, project_id, automation_id, contract_revision, contract_etag,
        policy_snapshot_json, case_id, case_revision, trigger_kind,
        idempotency_key_hash, request_hash, status, started_at, finished_at,
        created_at, updated_at
      ) VALUES (
        'run-done', 'project-1', 'fix-errors', 4, 'etag-4', '{}',
        'case-1', 6, 'manual', 'idem-done', 'request-done',
        'succeeded', 50, 60, 40, 60
      )`,
      `INSERT INTO case_claims (
        id, project_id, case_id, automation_id, case_revision, attempt, run_id,
        idempotency_key_hash, request_hash, lease_token_hash, lease_token_enc,
        lease_token_iv, claimed_by, acquired_at, expires_at
      ) VALUES (
        'claim-active', 'project-1', 'case-1', 'fix-errors', 7, 1, 'run-active',
        'claim-idem-active', 'claim-request-active', 'hash', 'enc', 'iv',
        'runner', 90, 500
      )`,
      `INSERT INTO case_claims (
        id, project_id, case_id, automation_id, case_revision, attempt,
        idempotency_key_hash, request_hash, lease_token_hash, lease_token_enc,
        lease_token_iv, claimed_by, acquired_at, expires_at
      ) VALUES (
        'claim-orphan', 'project-1', 'case-1', 'fix-errors', 8, 1,
        'claim-idem-orphan', 'claim-request-orphan', 'hash', 'enc', 'iv',
        'runner', 120, 600
      )`,
      `INSERT INTO automation_trigger_receipts
        (id, run_id, status, cancelled_at, cancel_reason)
       VALUES ('partial-cancelled-run-receipt', 'run-active', 'cancelled', 80, 'owner_cancelled')`,
      `INSERT INTO automation_trigger_receipts
        (id, claim_id, status, cancelled_at, cancel_reason)
       VALUES ('partial-cancelled-claim-receipt', 'claim-orphan', 'cancelled', 80, 'owner_cancelled')`,
      `INSERT INTO automation_action_grants
        (id, project_id, automation_id, run_id, action, status)
       VALUES ('partial-issued-grant', 'project-1', 'fix-errors', 'run-active', 'draft_pr', 'issued')`,
      `INSERT INTO automation_approvals (
        id, project_id, automation_id, run_id, action, status, request_reason,
        subject_hash, subject_json, requested_at, expires_at
      ) VALUES (
        'approval-active-run', 'project-1', 'fix-errors', 'run-active', 'draft_pr',
        'approved', 'reviewed', 'subject-hash', '{}', 80, 9999999999
      )`,
    ],
    "write",
  );

  const runOneMigration = (path) =>
    execFileSync(process.execPath, nodeScriptArgs(path), {
      cwd: join(here, ".."),
      env: { ...process.env, TURSO_DATABASE_URL: databaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const runMigration = () => {
    runOneMigration(foundationMigration);
    runOneMigration(provenanceMigration);
    runOneMigration(migration);
    // Re-run the foundation repair after orchestration-owned grants/receipts
    // exist so one canonical entrypoint converges interrupted older sequences.
    runOneMigration(foundationMigration);
  };

  runMigration();
  runMigration();

  // Seed already-canonical controls and adversarial near-misses, then rerun.
  // Exact consumed/claimed chains must survive byte-for-byte; cancelled/ready
  // or label-only chains must never be promoted into live authority.
  await client.batch([
    "INSERT INTO projects (id) VALUES ('project-other')",
    `INSERT INTO project_credentials (
      id, project_id, kind, name, prefix, token_hash, created_at, expires_at
    ) VALUES
      ('server-exact', 'project-1', 'server_ingest', 'Server exact', 'agentry_server_exact',
       'server-exact-hash', 1, 9999999999),
      ('ci-exact', 'project-1', 'ci_deploy', 'CI exact', 'agentry_ci_exact',
       'ci-exact-hash', 1, 9999999999),
      ('ci-proof', 'project-1', 'ci_deploy', 'CI proof', 'agentry_ci_proof',
       'ci-proof-hash', 1, 9999999999)`,
    `INSERT INTO cases (
      id, project_id, revision, last_trust_level, last_credential_kind, last_credential_id
    ) VALUES
      ('case-exact', 'project-1', 5, 'trusted_server', 'server_ingest', 'server-exact'),
      ('case-label-only', 'project-1', 6, 'trusted_server', 'server_ingest', NULL),
      ('case-ready-claim', 'project-1', 7, 'untrusted_browser', 'browser_public', NULL)`,
    `INSERT INTO automation_trigger_receipts (
      id, project_id, automation_id, contract_revision, contract_etag, trigger_kind,
      trigger_key, case_id, case_revision, attempt, required_trust, source_trust,
      snapshot_json, snapshot_hash, status, claim_id, run_id, issued_at,
      not_before_at, expires_at, claimed_at, consumed_at
    ) VALUES
      ('receipt-exact', 'project-1', 'fix-errors', 4, 'etag-4', 'unhandled_cases',
       'exact-key', 'case-exact', 5, 1, 'trusted_server', 'trusted_server',
       '{}', 'exact-snapshot-hash', 'consumed', 'claim-exact', 'run-exact', 200, 200,
       9999999999, 200, 201),
      ('receipt-cancelled', 'project-1', 'fix-errors', 4, 'etag-4', 'unhandled_cases',
       'cancelled-key', 'case-exact', 5, 2, 'trusted_server', 'trusted_server',
       '{}', 'cancelled-snapshot-hash', 'cancelled', NULL, NULL, 200, 200,
       201, NULL, NULL),
      ('receipt-ready-claim', 'project-1', 'fix-errors', 4, 'etag-4', 'unhandled_cases',
       'ready-claim-key', 'case-ready-claim', 7, 1, 'any', 'untrusted_browser',
       '{}', 'ready-claim-snapshot-hash', 'ready', NULL, NULL, 200, 200,
       9999999999, NULL, NULL),
      ('receipt-label-only', 'project-1', 'fix-errors', 4, 'etag-4', 'unhandled_cases',
       'label-only-key', 'case-label-only', 6, 1, 'trusted_server', 'trusted_server',
       '{}', 'label-only-snapshot-hash', 'consumed', NULL, 'run-label-only', 200, 200,
       9999999999, NULL, 201),
      ('receipt-deploy-exact', 'project-1', 'deploy-fix', 4, 'etag-4', 'schedule',
       'deploy-exact-key', NULL, NULL, 1, 'server_schedule', 'server_schedule',
       '{}', 'deploy-exact-snapshot-hash', 'consumed', NULL, 'run-deploy-exact', 200, 200,
       9999999999, NULL, 201)`,
    `INSERT INTO automation_runs (
      id, project_id, automation_id, contract_revision, contract_etag,
      policy_snapshot_json, case_id, case_revision, trigger_kind,
      idempotency_key_hash, request_hash, attempt, status, trigger_receipt_id,
      deadline_at, turns_used, cost_micros, usage_sequence, started_at, created_at, updated_at
    ) VALUES
      ('run-exact', 'project-1', 'fix-errors', 4, 'etag-4', '{}', 'case-exact', 5,
       'unhandled_cases', 'idem-exact', 'request-exact', 1, 'running', 'receipt-exact',
       9999999999, 2, 10, 1, 201, 200, 201),
      ('run-cancelled-receipt', 'project-1', 'fix-errors', 4, 'etag-4', '{}', 'case-exact', 5,
       'unhandled_cases', 'idem-cancelled', 'request-cancelled', 2, 'running', 'receipt-cancelled',
       9999999999, 1, 5, 1, 201, 200, 201),
      ('run-label-only', 'project-1', 'fix-errors', 4, 'etag-4', '{}', 'case-label-only', 6,
       'unhandled_cases', 'idem-label-only', 'request-label-only', 1, 'running', 'receipt-label-only',
       9999999999, 1, 5, 1, 201, 200, 201)`,
    `INSERT INTO automation_runs (
      id, project_id, automation_id, contract_revision, contract_etag,
      policy_snapshot_json, trigger_kind, idempotency_key_hash, request_hash, attempt,
      status, trigger_receipt_id, deadline_at, turns_used, cost_micros, usage_sequence,
      commit_sha, deploy_sha, pr_proof_hash, pr_proof_credential_id,
      started_at, created_at, updated_at
    ) VALUES (
      'run-deploy-exact', 'project-1', 'deploy-fix', 4, 'etag-4', '{}', 'schedule',
      'idem-deploy-exact', 'request-deploy-exact', 1, 'verifying', 'receipt-deploy-exact',
      9999999999, 1, 5, 1, 'commit-exact', 'deploy-exact', 'proof-hash', 'ci-proof',
      201, 200, 201
    )`,
    `INSERT INTO case_claims (
      id, project_id, case_id, automation_id, case_revision, attempt, run_id,
      idempotency_key_hash, request_hash, lease_token_hash, lease_token_enc,
      lease_token_iv, claimed_by, acquired_at, expires_at, trigger_receipt_id
    ) VALUES
      ('claim-exact', 'project-1', 'case-exact', 'fix-errors', 5, 1, 'run-exact',
       'claim-idem-exact', 'claim-request-exact', 'hash', 'enc', 'iv', 'runner',
       200, 9999999999, 'receipt-exact'),
      ('claim-ready', 'project-1', 'case-ready-claim', 'fix-errors', 7, 1, NULL,
       'claim-idem-ready', 'claim-request-ready', 'hash', 'enc', 'iv', 'runner',
       200, 9999999999, 'receipt-ready-claim')`,
    `INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id,
      automation_run_id, source_commit_sha, received_at
    ) VALUES (
      'deploy-bound-exact', 'project-1', 'deploy-exact', 'trusted_ci', 'ci_deploy',
      'ci-exact', 'run-deploy-exact', 'commit-exact', 202
    )`,
  ], "write");
  // Simulate an invalid binding written under a prior weaker trigger.
  await client.execute("DROP TRIGGER deploys_automation_binding_insert_guard");
  await client.execute(`INSERT INTO deploys (
    id, project_id, sha, trust_level, credential_kind, credential_id,
    automation_run_id, source_commit_sha, received_at
  ) VALUES (
    'deploy-bound-invalid', 'project-1', 'deploy-exact', 'trusted_ci', 'ci_deploy',
    'ci-exact', 'run-deploy-exact', 'wrong-commit', 203
  )`);
  runMigration();

  const runs = await client.execute(
    "SELECT id, status, trigger_receipt_id, deadline_at, error_code FROM automation_runs ORDER BY id",
  );
  const active = runs.rows.find((row) => row.id === "run-active");
  const done = runs.rows.find((row) => row.id === "run-done");
  invariant(active?.status === "cancelled", "legacy in-flight run was not cancelled");
  invariant(active?.error_code === "legacy_unbound_trigger", "legacy run lacks fail-closed reason");
  invariant(active?.trigger_receipt_id === "legacy-run:run-active", "legacy run receipt was not bound");
  invariant(Number(active?.deadline_at) === 110, "legacy run deadline was not deterministically backfilled");
  invariant(done?.status === "succeeded", "historical terminal run status changed");

  const claims = await client.execute(
    `SELECT id, trigger_receipt_id, released_at, release_reason FROM case_claims
      WHERE id IN ('claim-active', 'claim-orphan') ORDER BY id`,
  );
  invariant(claims.rows.every((row) => row.released_at !== null), "legacy claims were not released");
  invariant(
    claims.rows.every((row) => row.release_reason === "legacy_unbound_trigger"),
    "legacy claim release reason is missing",
  );

  const receiptCount = await client.execute(
    `SELECT COUNT(*) AS count FROM automation_trigger_receipts
      WHERE id IN (
        'legacy-run:run-active', 'legacy-run:run-done',
        'legacy-claim:claim-active', 'legacy-claim:claim-orphan',
        'partial-cancelled-run-receipt', 'partial-cancelled-claim-receipt'
      )`,
  );
  invariant(Number(receiptCount.rows[0]?.count) === 6, "legacy receipt backfill is not idempotent");
  const invalidReceipt = await client.execute(`
    SELECT r.id
      FROM automation_runs r
      JOIN automation_trigger_receipts receipt ON receipt.id = r.trigger_receipt_id
     WHERE receipt.run_id IS NOT r.id OR receipt.status IS NOT 'consumed'
  `);
  invariant(invalidReceipt.rows.length === 0, "run receipt binding is incomplete");
  const partialReceipts = await client.execute(`
    SELECT id, status, required_trust, source_trust, cancel_reason
      FROM automation_trigger_receipts
     WHERE id LIKE 'partial-%'
     ORDER BY id
  `);
  invariant(partialReceipts.rows.length === 2, "partial receipt history was lost");
  invariant(
    partialReceipts.rows.every((row) =>
      row.status === "cancelled" &&
      row.required_trust === "legacy_unbound" &&
      row.source_trust === "legacy_unbound"
    ),
    "partial receipt authority was manufactured during rebuild",
  );
  const partialGrant = (await client.execute(`
    SELECT status, subject_hash, token_hash
      FROM automation_action_grants WHERE id = 'partial-issued-grant'
  `)).rows[0];
  invariant(partialGrant?.status === "cancelled", "partial issued grant survived migration");
  invariant(
    String(partialGrant?.subject_hash).startsWith("legacy-unbound:") &&
      String(partialGrant?.token_hash).startsWith("legacy-unbound:"),
    "partial grant was not retained as a fail-closed tombstone",
  );
  const approval = (await client.execute(`
    SELECT status, decided_at FROM automation_approvals WHERE id = 'approval-active-run'
  `)).rows[0];
  invariant(approval?.status === "cancelled", "approval survived connected run cancellation");
  invariant(approval?.decided_at !== null, "approval cancellation was not timestamped");

  const exactRun = (await client.execute(`
    SELECT status, trigger_receipt_id, deadline_at, turns_used, cost_micros, usage_sequence
      FROM automation_runs WHERE id = 'run-exact'
  `)).rows[0];
  invariant(exactRun?.status === "running", "exact consumed run chain was cancelled");
  invariant(exactRun?.trigger_receipt_id === "receipt-exact", "exact run receipt identity changed");
  invariant(Number(exactRun?.deadline_at) === 9999999999, "exact run deadline changed");
  invariant(Number(exactRun?.turns_used) === 2, "exact run usage changed");
  const exactClaim = (await client.execute(`
    SELECT trigger_receipt_id, released_at FROM case_claims WHERE id = 'claim-exact'
  `)).rows[0];
  invariant(exactClaim?.trigger_receipt_id === "receipt-exact", "exact claim receipt changed");
  invariant(exactClaim?.released_at === null, "exact consumed claim chain was released");

  const invalidRuns = await client.execute(`
    SELECT id, status, trigger_receipt_id
      FROM automation_runs
     WHERE id IN ('run-cancelled-receipt', 'run-label-only')
     ORDER BY id
  `);
  invariant(invalidRuns.rows.every((row) => row.status === "cancelled"), "invalid run chain remained active");
  invariant(invalidRuns.rows.every((row) =>
    row.trigger_receipt_id === `legacy-run:${String(row.id)}`
  ), "invalid run was not isolated from its old receipt");
  const invalidOriginalReceipts = await client.execute(`
    SELECT id, status FROM automation_trigger_receipts
     WHERE id IN ('receipt-cancelled', 'receipt-label-only', 'receipt-ready-claim')
     ORDER BY id
  `);
  invariant(
    invalidOriginalReceipts.rows.every((row) => row.status === "cancelled"),
    "terminal or label-only receipt was resurrected",
  );
  const readyClaim = (await client.execute(`
    SELECT trigger_receipt_id, released_at, release_reason
      FROM case_claims WHERE id = 'claim-ready'
  `)).rows[0];
  invariant(readyClaim?.released_at !== null, "ready receipt manufactured an active claim");
  invariant(readyClaim?.trigger_receipt_id === "legacy-claim:claim-ready", "invalid claim was not isolated");

  const deployBindings = await client.execute(`
    SELECT id, automation_run_id, source_commit_sha FROM deploys
     WHERE id IN ('deploy-bound-exact', 'deploy-bound-invalid') ORDER BY id
  `);
  const exactDeploy = deployBindings.rows.find((row) => row.id === "deploy-bound-exact");
  const invalidDeploy = deployBindings.rows.find((row) => row.id === "deploy-bound-invalid");
  invariant(
    exactDeploy?.automation_run_id === "run-deploy-exact" &&
      exactDeploy?.source_commit_sha === "commit-exact",
    "exact deploy binding was cleared",
  );
  invariant(
    invalidDeploy?.automation_run_id === null && invalidDeploy?.source_commit_sha === null,
    "invalid deploy binding survived repair",
  );
  let bindingMutationGuarded = false;
  try {
    await client.execute(
      "UPDATE deploys SET source_commit_sha = 'changed' WHERE id = 'deploy-bound-exact'",
    );
  } catch (error) {
    bindingMutationGuarded = String(error).includes("deploy automation binding is immutable");
  }
  invariant(bindingMutationGuarded, "deploy binding remained mutable after migration");
  let runProofMutationGuarded = false;
  try {
    await client.execute(
      "UPDATE automation_runs SET commit_sha = 'changed' WHERE id = 'run-deploy-exact'",
    );
  } catch (error) {
    runProofMutationGuarded = String(error).includes("deploy proof is immutable");
  }
  invariant(runProofMutationGuarded, "bound run proof remained mutable after migration");
  let invalidBindingInsertGuarded = false;
  try {
    await client.execute(`INSERT INTO deploys (
      id, project_id, sha, trust_level, credential_kind, credential_id,
      automation_run_id, source_commit_sha, received_at
    ) VALUES (
      'deploy-invalid-after-migration', 'project-1', 'deploy-exact', 'trusted_ci',
      'ci_deploy', 'ci-exact', 'run-deploy-exact', 'wrong-commit', 204
    )`);
  } catch (error) {
    invalidBindingInsertGuarded = String(error).includes("must match exact trusted CI run proof");
  }
  invariant(invalidBindingInsertGuarded, "deploy binding insert guard accepted false authority");

  const deployColumns = await client.execute("PRAGMA table_info(deploys)");
  const deployColumnNames = new Set(deployColumns.rows.map((row) => String(row.name)));
  invariant(deployColumnNames.has("automation_run_id"), "deploy automation_run_id is missing");
  invariant(deployColumnNames.has("source_commit_sha"), "deploy source_commit_sha is missing");

  const expectedTables = [
    "automation_trigger_states",
    "automation_trigger_receipts",
    "automation_budget_charges",
    "automation_action_grants",
    "automation_run_report_sources",
  ];
  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'",
  );
  const tableNames = new Set(tables.rows.map((row) => String(row.name)));
  invariant(expectedTables.every((table) => tableNames.has(table)), "orchestration tables are incomplete");

  const receiptColumns = await client.execute("PRAGMA table_info(automation_trigger_receipts)");
  const receiptColumnNames = new Set(receiptColumns.rows.map((row) => String(row.name)));
  invariant(
    [
      "project_id", "automation_id", "contract_revision", "contract_etag", "trigger_key",
      "required_trust", "source_trust", "snapshot_json", "snapshot_hash", "not_before_at",
      "expires_at",
    ].every((column) => receiptColumnNames.has(column)),
    "partial trigger receipt table did not converge to the canonical shape",
  );
  const grantColumns = await client.execute("PRAGMA table_info(automation_action_grants)");
  const grantColumnNames = new Set(grantColumns.rows.map((row) => String(row.name)));
  invariant(
    [
      "subject_hash", "subject_json", "token_hash", "token_enc", "token_iv",
      "idempotency_key_hash", "request_hash", "expires_at",
    ].every((column) => grantColumnNames.has(column)),
    "partial action grant table did not converge to the canonical shape",
  );
  const grantForeignKeys = await client.execute("PRAGMA foreign_key_list(automation_action_grants)");
  invariant(
    grantForeignKeys.rows.some((row) => row.table === "automation_runs" && row.from === "run_id"),
    "rebuilt action grants lost the run foreign key",
  );

  const reportSourceIndexes = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'automation_run_report_sources'",
  );
  const reportSourceIndexNames = new Set(
    reportSourceIndexes.rows.map((row) => String(row.name)),
  );
  invariant(
    reportSourceIndexNames.has("automation_run_report_sources_run_idx") &&
      reportSourceIndexNames.has("automation_run_report_sources_idempotency_idx"),
    "automation report source uniqueness indexes are incomplete",
  );

  let nullGuarded = false;
  try {
    await client.execute(
      "UPDATE automation_runs SET trigger_receipt_id = NULL WHERE id = 'run-done'",
    );
  } catch (error) {
    nullGuarded = String(error).includes("requires trigger_receipt_id and deadline_at");
  }
  invariant(nullGuarded, "migrated automation_runs does not enforce required orchestration fields");
  let whitespaceGuarded = false;
  try {
    await client.execute(
      "UPDATE automation_runs SET trigger_receipt_id = '   ' WHERE id = 'run-done'",
    );
  } catch (error) {
    whitespaceGuarded = String(error).includes("requires trigger_receipt_id and deadline_at");
  }
  invariant(whitespaceGuarded, "replacement run guard accepted whitespace receipt identity");

  await client.execute("DELETE FROM projects WHERE id = 'project-1'");
  const cascadeCounts = await client.execute(`
    SELECT
      (SELECT count(*) FROM automation_runs WHERE project_id = 'project-1') AS runs,
      (SELECT count(*) FROM deploys WHERE project_id = 'project-1') AS deploys,
      (SELECT count(*) FROM automation_trigger_receipts WHERE project_id = 'project-1') AS receipts
  `);
  invariant(
    Number(cascadeCounts.rows[0]?.runs) === 0 &&
      Number(cascadeCounts.rows[0]?.deploys) === 0 &&
      Number(cascadeCounts.rows[0]?.receipts) === 0,
    "deploy binding guards blocked project cascade cleanup",
  );

  console.log("automation orchestration migration self-test passed");
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
