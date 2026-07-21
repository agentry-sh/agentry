import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  automationWorkflowExecutionAuthorities,
  automationWorkflowProjectControls,
  automationWorkflowRevisions,
  automationWorkflowRuns,
  automationWorkflowRunStates,
  automationWorkflowSystemNodeClaims,
  automationWorkflowTriggerReceipts,
  automationWorkflows,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import {
  acquireAutomationWorkflowSystemNodeClaim,
  releaseAutomationWorkflowSystemNodeClaim,
} from "../src/automation-workflow-system-claims.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const PROJECT_ID = "system-claim-project";
const AUTOMATION_ID = "system_claim_workflow";
const REVISION_ID = "system-claim-revision";
const RUN_ID = "system-claim-run";
const AUTHORITY_ID = "a".repeat(64);
const DESCRIPTOR_HASH = "b".repeat(64);
const RUNNER_ID = "system-claim-runner";
const hash = (character: string) => character.repeat(64);

type Db = ReturnType<typeof getDbForUrl>;
let env: TestEnv;
let db: Db;
let now: number;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  const clock = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  now = Number(clock.rows[0]?.now_seconds ?? 0);
  await withWorkflowTriggersDisabled(async () => {
    await db.insert(users).values({ id: "system-claim-owner", email: "system-claim@example.test" });
    await db.insert(projects).values({
      id: PROJECT_ID,
      userId: "system-claim-owner",
      name: "System claim",
    });
    await db.insert(projectCredentials).values({
      id: RUNNER_ID,
      projectId: PROJECT_ID,
      kind: "automation_runner",
      name: "System claim runner",
      prefix: "agentry_runner_system_claim",
      tokenHash: hash("1"),
      automationId: AUTOMATION_ID,
      createdBy: "system-claim-owner",
      createdAt: now,
      expiresAt: now + 3_600,
    });
    await db.insert(automationWorkflowProjectControls).values({
      projectId: PROJECT_ID,
      revision: 1,
      etag: "system-claim-control",
      createdBy: "system-claim-owner",
      updatedBy: "system-claim-owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(automationWorkflowRevisions).values({
      id: REVISION_ID,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      revision: 1,
      schemaVersion: "3",
      workflowJson: "{}",
      workflowHash: hash("2"),
      compiledJson: "{}",
      compileHash: hash("3"),
      componentHashesJson: "{}",
      createdBy: "system-claim-owner",
      createdAt: now,
    });
    await db.insert(automationWorkflows).values({
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      currentRevisionId: REVISION_ID,
      currentRevision: 1,
      activeRevisionId: REVISION_ID,
      activeExecutionAuthorityId: AUTHORITY_ID,
      etag: "system-claim-workflow",
      enabled: 1,
      createdBy: "system-claim-owner",
      updatedBy: "system-claim-owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(automationWorkflowExecutionAuthorities).values({
      id: AUTHORITY_ID,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: REVISION_ID,
      workflowHash: hash("2"),
      compileHash: hash("3"),
      readinessHash: hash("4"),
      ownerConfirmedCallerAssertionIdsJson: "[]",
      descriptorKind: "ordered_funnel_period_compare",
      descriptorJson: JSON.stringify({ schema_version: "1", kind: "ordered_funnel_period_compare" }),
      descriptorHash: DESCRIPTOR_HASH,
      runnerCredentialId: RUNNER_ID,
      enabledBy: "system-claim-owner",
      enabledAt: now,
    });
    await db.insert(automationWorkflowTriggerReceipts).values({
      id: "system-claim-trigger",
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: REVISION_ID,
      workflowHash: hash("2"),
      compileHash: hash("3"),
      executionAuthorityId: AUTHORITY_ID,
      triggerNodeId: "schedule",
      componentId: "trigger.schedule.cron",
      componentVersion: "1.0.0",
      componentHash: hash("5"),
      outputContract: "schedule_trigger_receipt@1",
      outputSchemaHash: hash("6"),
      triggerKind: "schedule",
      triggerKey: `schedule:${now}`,
      attempt: 1,
      payloadJson: "{}",
      payloadHash: hash("7"),
      sourceTrust: "agentry_system",
      status: "consumed",
      consumedRunId: RUN_ID,
      issuedAt: now,
      availableAt: now,
      expiresAt: now + 3_600,
      consumedAt: now,
      updatedAt: now,
    });
    await db.insert(automationWorkflowRuns).values({
      id: RUN_ID,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: REVISION_ID,
      workflowHash: hash("2"),
      compileHash: hash("3"),
      executionAuthorityId: AUTHORITY_ID,
      executionDescriptorHash: DESCRIPTOR_HASH,
      triggerReceiptId: "system-claim-trigger",
      triggerKind: "schedule",
      triggerKey: `schedule:${now}`,
      triggerPayloadJson: "{}",
      triggerPayloadHash: hash("7"),
      attempt: 1,
      idempotencyKeyHash: hash("8"),
      requestHash: hash("9"),
      limitsJson: "{}",
      limitsHash: hash("c"),
      runnerCredentialId: RUNNER_ID,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(automationWorkflowRunStates).values({
      runId: RUN_ID,
      projectId: PROJECT_ID,
      automationId: AUTOMATION_ID,
      workflowRevisionId: REVISION_ID,
      workflowHash: hash("2"),
      compileHash: hash("3"),
      stateVersion: 1,
      status: "running",
      currentNodeId: "query",
      stateJson: "{}",
      stateHash: hash("d"),
      elapsedDeadlineAt: now + 3_600,
      createdAt: now,
      updatedAt: now,
    });
  });
});

afterEach(() => disposeTestEnv(env));

describe("automation workflow system-node claims", () => {
  it("admits one concurrent owner for an exact run revision and input", async () => {
    const request = {
      run_id: RUN_ID,
      run_revision: 1,
      node_id: "query",
      input_hash: hash("e"),
    };
    const outcomes = await Promise.allSettled([
      acquireAutomationWorkflowSystemNodeClaim(db, request),
      acquireAutomationWorkflowSystemNodeClaim(db, request),
    ]);
    const acquired = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireAutomationWorkflowSystemNodeClaim>>> =>
        outcome.status === "fulfilled" && outcome.value.outcome === "acquired",
    );
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({
        code: expect.stringMatching(/automation_workflow_system_node_claim_(active|contention)/),
      }),
    });
  });

  it("recovers an expired claim with a new epoch and rejects the stale fence", async () => {
    const inputHash = hash("f");
    const claimId = await claimIdFor(inputHash);
    await withWorkflowTriggersDisabled(async () => {
      await db.insert(automationWorkflowSystemNodeClaims).values({
        id: claimId,
        projectId: PROJECT_ID,
        automationId: AUTOMATION_ID,
        runId: RUN_ID,
        runRevision: 1,
        nodeId: "query",
        inputHash,
        claimEpoch: 1,
        claimTokenHash: hash("a"),
        status: "active",
        claimedAt: now - 301,
        expiresAt: now - 1,
        updatedAt: now - 301,
      });
    });

    const acquired = await acquireAutomationWorkflowSystemNodeClaim(db, {
      run_id: RUN_ID,
      run_revision: 1,
      node_id: "query",
      input_hash: inputHash,
    });
    expect(acquired).toMatchObject({ outcome: "acquired", claim: { claim_epoch: 2 } });
    if (acquired.outcome !== "acquired") throw new Error("claim was not acquired");

    await expect(releaseAutomationWorkflowSystemNodeClaim(db, {
      ...acquired.claim,
      claim_epoch: 1,
      claim_token: "stale_".padEnd(40, "x"),
    })).rejects.toMatchObject({
      code: "automation_workflow_system_node_claim_fence_lost",
    });
    await expect(releaseAutomationWorkflowSystemNodeClaim(db, acquired.claim)).resolves.toBeUndefined();
  });
});

async function claimIdFor(inputHash: string): Promise<string> {
  const { canonicalJsonStringify, sha256Hex } = await import("@agentrysh/shared");
  return sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-system-node-claim-v1",
    run_id: RUN_ID,
    run_revision: 1,
    node_id: "query",
    input_hash: inputHash,
  }));
}

async function withWorkflowTriggersDisabled<T>(operation: () => Promise<T>): Promise<T> {
  const snapshot = await db.run(sql`
    SELECT name, sql FROM sqlite_master
     WHERE type = 'trigger' AND name LIKE 'automation_workflow_%'
     ORDER BY name
  `);
  const triggers = snapshot.rows.map((row) => ({ name: String(row.name), sql: String(row.sql) }));
  for (const trigger of triggers) {
    await db.run(sql.raw(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`));
  }
  try {
    return await operation();
  } finally {
    for (const trigger of triggers) await db.run(sql.raw(trigger.sql));
  }
}
