import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { AgentryDb } from "../src/db.js";
import {
  EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT,
  externalMutationManifest,
} from "../src/external-mutation-boundary.js";
import {
  AUTOMATION_DELETION_MANIFEST_SAMPLE_LIMIT,
  automationDeletionManifest,
} from "../src/automation-deletion-boundary.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

describe("deletion manifest work and memory bounds", () => {
  let env: TestEnv | undefined;

  afterEach(() => {
    if (env) disposeTestEnv(env);
    env = undefined;
  });

  it("computes exact external-operation counts without materializing a large audit history", async () => {
    env = await makeTestEnv({ fileDb: true });
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const projectIds = await seedOwnerProjects(db, "manifest_external_project_", 60);

    // Five equally sized outcome classes and thirty action names exercise both
    // exact aggregate counts and the separately bounded action/sample views.
    await db.run(sql`
      WITH RECURSIVE sequence(n) AS (
        SELECT 0
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 999
      )
      INSERT INTO audit_log (
        id,
        user_id,
        project_id,
        operation_id,
        request_hash,
        phase,
        action,
        resource_type,
        resource_id,
        metadata_json,
        occurred_at_ms
      )
      SELECT
        printf('manifest-intent-%04d', n),
        'manifest_owner',
        printf('manifest_external_project_%02d', n % 60),
        printf('manifest-operation-%04d', n),
        printf('request-%04d', n),
        'intent',
        printf('provider.action.%02d', n % 30),
        'provider_resource',
        printf('resource-%04d', n),
        CASE WHEN n % 5 = 3
          THEN '{"$agentry_external_mutation":{"retained_resource_on_success":false}}'
          ELSE '{"$agentry_external_mutation":{"retained_resource_on_success":true}}'
        END,
        (unixepoch() * 1000) + n
      FROM sequence
    `);
    await db.run(sql`
      WITH RECURSIVE sequence(n) AS (
        SELECT 0
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 999
      )
      INSERT INTO audit_log (
        id,
        user_id,
        project_id,
        operation_id,
        request_hash,
        phase,
        action,
        resource_type,
        resource_id,
        metadata_json,
        occurred_at_ms
      )
      SELECT
        printf('manifest-terminal-%04d', n),
        'manifest_owner',
        printf('manifest_external_project_%02d', n % 60),
        printf('manifest-operation-%04d', n),
        printf('request-%04d', n),
        CASE n % 5
          WHEN 1 THEN 'succeeded'
          WHEN 2 THEN 'indeterminate'
          WHEN 3 THEN 'succeeded'
          ELSE 'failed'
        END,
        printf('provider.action.%02d', n % 30),
        'provider_resource',
        printf('provider-id-%04d', n),
        '{}',
        (unixepoch() * 1000) + 10000 + n
      FROM sequence
      WHERE n % 5 <> 0
    `);
    // Retired provider-write actions are ordinary historical audit rows unless
    // their durable metadata explicitly marks an external mutation saga.
    await db.run(sql`
      INSERT INTO audit_log (
        id,
        user_id,
        project_id,
        operation_id,
        request_hash,
        phase,
        action,
        resource_type,
        resource_id,
        metadata_json,
        occurred_at_ms
      ) VALUES (
        'retired-provider-intent',
        'manifest_owner',
        'manifest_external_project_00',
        'retired-provider-operation',
        'retired-provider-request',
        'intent',
        'feature_flag.created',
        'feature_flag',
        'retired-provider-resource',
        '{}',
        unixepoch() * 1000
      )
    `);

    const observed = observeOnlyBoundedRunResults(db);
    const manifest = await externalMutationManifest(
      observed.db,
      projectIds,
    );

    expect(manifest.total_operations).toBe(1_000);
    expect(manifest.counts).toEqual({
      active: 200,
      retained_external_state: 200,
      external_state_unknown: 200,
      completed_without_retained_resource: 200,
      failed_without_provider_effect: 200,
    });
    expect(manifest.operations).toHaveLength(EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT);
    expect(manifest.operations[0]?.operation_id).toBe("manifest-operation-0999");
    expect(manifest.operations_truncated).toBe(true);
    expect(manifest.counts_by_action).toHaveLength(EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT);
    expect(manifest.counts_by_action_truncated).toBe(true);
    expect(observed.stats.calls).toBe(7);
    expect(observed.stats.maxRowsReturned).toBeLessThanOrEqual(
      EXTERNAL_MUTATION_MANIFEST_SAMPLE_LIMIT + 1,
    );
  });

  it("computes exact automation inventory counts with constant query/result bounds", async () => {
    env = await makeTestEnv({ fileDb: true });
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const projectIds = await seedOwnerProjects(db, "manifest_automation_project_", 60);

    await db.run(sql`
      WITH RECURSIVE sequence(n) AS (
        SELECT 0
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 999
      )
      INSERT INTO automation_runs (
        id,
        project_id,
        automation_id,
        contract_revision,
        contract_etag,
        policy_snapshot_json,
        trigger_receipt_id,
        trigger_kind,
        trigger_snapshot_json,
        idempotency_key_hash,
        request_hash,
        status,
        pr_url,
        pr_proof_hash,
        deploy_sha,
        deadline_at,
        created_at,
        updated_at
      )
      SELECT
        printf('manifest-run-%04d', n),
        printf('manifest_automation_project_%02d', n % 60),
        'weekly_report',
        1,
        'manifest-etag',
        '{}',
        printf('manifest-receipt-%04d', n),
        'schedule',
        '{}',
        printf('manifest-idempotency-%04d', n),
        printf('manifest-request-%04d', n),
        'queued',
        CASE WHEN n % 2 = 0
          THEN printf('https://github.com/example/repo/pull/%d?token=must-not-survive', n)
          ELSE NULL
        END,
        CASE WHEN n % 4 = 0 THEN printf('proof-%04d', n) ELSE NULL END,
        CASE WHEN n % 5 = 0 THEN printf('deploy-sha-%04d', n) ELSE NULL END,
        2000000000,
        1700000000 + n,
        1700000000 + n
      FROM sequence
    `);
    await db.run(sql`
      WITH RECURSIVE sequence(n) AS (
        SELECT 0
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 999
      )
      INSERT INTO project_credentials (
        id,
        project_id,
        kind,
        name,
        prefix,
        token_hash,
        automation_id,
        created_at,
        expires_at
      )
      SELECT
        printf('manifest-credential-%04d', n),
        printf('manifest_automation_project_%02d', n % 60),
        'automation_runner',
        printf('runner-%04d', n),
        'agentry_runner_manifest',
        printf('manifest-token-hash-%04d', n),
        'weekly_report',
        1700000000 + n,
        unixepoch() + 3600
      FROM sequence
      WHERE n < 300
    `);
    await db.run(sql`
      WITH RECURSIVE sequence(n) AS (
        SELECT 0
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 59
      )
      INSERT INTO project_credentials (
        id,
        project_id,
        kind,
        name,
        prefix,
        token_hash,
        automation_id,
        created_at,
        expires_at
      )
      SELECT
        printf('manifest-ci-%02d', n),
        printf('manifest_automation_project_%02d', n),
        'ci_deploy',
        printf('ci-%02d', n),
        'agentry_ci_manifest',
        printf('manifest-ci-token-hash-%02d', n),
        NULL,
        1700000000 + n,
        unixepoch() + 3600
      FROM sequence
    `);
    await db.run(sql`
      WITH RECURSIVE sequence(n) AS (
        SELECT 0
        UNION ALL
        SELECT n + 1 FROM sequence WHERE n < 999
      )
      INSERT INTO deploys (
        id,
        project_id,
        sha,
        trust_level,
        credential_kind,
        credential_id,
        received_at
      )
      SELECT
        printf('manifest-deploy-%04d', n),
        printf('manifest_automation_project_%02d', n % 60),
        printf('recorded-sha-%04d', n),
        'trusted_ci',
        'ci_deploy',
        printf('manifest-ci-%02d', n % 60),
        1800000000 + n
      FROM sequence
      WHERE n % 10 = 0
    `);

    const observed = observeOnlyBoundedRunResults(db);
    const manifest = await automationDeletionManifest(
      observed.db,
      projectIds,
    );

    expect(manifest.counts).toEqual({
      enabled_contracts: 0,
      enabled_schedules: 0,
      active_runner_credentials: 300,
      ready_or_claimed_receipts: 0,
      nonterminal_runs: 1_000,
      active_claims: 0,
      pending_approvals: 0,
      issued_or_consumed_draft_pr_grants: 0,
      known_pr_identifiers: 500,
      known_pr_proof_identifiers: 250,
      known_deploy_identifiers: 300,
      known_external_effects: 600,
      possible_or_unknown_external_effects: 700,
      workflow_v3_project_controls: 0,
      workflow_v3_workflows: 0,
      workflow_v3_revisions: 0,
      workflow_v3_execution_authorities: 0,
      workflow_v3_trigger_receipts: 0,
      workflow_v3_runs: 0,
      workflow_v3_system_node_claims: 0,
      workflow_v3_run_leases: 0,
      workflow_v3_budget_charges: 0,
      workflow_v3_run_states: 0,
      workflow_v3_commands: 0,
      workflow_v3_run_events: 0,
      workflow_v3_suspensions: 0,
      workflow_v3_effects: 0,
      workflow_v3_effect_events: 0,
      workflow_v3_enabled_workflows: 0,
      workflow_v3_ready_trigger_receipts: 0,
      workflow_v3_nonterminal_runs: 0,
      workflow_v3_active_leases: 0,
      workflow_v3_active_system_node_claims: 0,
      workflow_v3_pending_suspensions: 0,
      workflow_v3_external_reserved_effects: 0,
      workflow_v3_external_indeterminate_effects: 0,
      workflow_v3_external_manual_follow_up_effects: 0,
      workflow_v3_external_succeeded_effects: 0,
    });
    expect(manifest.samples).toHaveLength(AUTOMATION_DELETION_MANIFEST_SAMPLE_LIMIT);
    expect(manifest.samples_truncated).toBe(true);
    expect(JSON.stringify(manifest.samples)).not.toContain("must-not-survive");
    expect(observed.stats.calls).toBe(5);
    expect(observed.stats.maxRowsReturned).toBeLessThanOrEqual(
      AUTOMATION_DELETION_MANIFEST_SAMPLE_LIMIT + 1,
    );
  });
});

async function seedOwnerProjects(
  db: ReturnType<typeof getDbForUrl>,
  projectPrefix: string,
  count: number,
): Promise<string[]> {
  await db.run(sql`
    INSERT INTO users (id, email)
    VALUES ('manifest_owner', 'manifest-owner@example.com')
  `);
  await db.run(sql`
    WITH RECURSIVE sequence(n) AS (
      SELECT 0
      UNION ALL
      SELECT n + 1 FROM sequence WHERE n < ${count - 1}
    )
    INSERT INTO projects (id, user_id, name)
    SELECT
      ${projectPrefix} || printf('%02d', n),
      'manifest_owner',
      'Manifest bounds ' || n
    FROM sequence
  `);
  return Array.from({ length: count }, (_, index) =>
    `${projectPrefix}${String(index).padStart(2, "0")}`
  );
}

function observeOnlyBoundedRunResults(db: ReturnType<typeof getDbForUrl>) {
  const stats = { calls: 0, maxRowsReturned: 0 };
  const boundedDb = {
    run: async (query: Parameters<typeof db.run>[0]) => {
      stats.calls += 1;
      const result = await db.run(query);
      stats.maxRowsReturned = Math.max(stats.maxRowsReturned, result.rows.length);
      return result;
    },
  } as unknown as AgentryDb;
  return { db: boundedDb, stats };
}
