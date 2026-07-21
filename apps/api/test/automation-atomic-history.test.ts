import { createClient as createLibsql, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@agentry/db/schema";
import {
  automationRunEvents,
  automationRuns,
} from "@agentry/db/schema";
import {
  appendAutomationRunEvent,
  atomicAutomationHistory,
  mutateAutomationRunWithEvent,
} from "../src/automation-atomic-history.js";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

describe("atomic automation run history", () => {
  let client: Client;
  let db: TestDb;
  let directory: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentry-atomic-history-"));
    client = createLibsql({ url: `file:${join(directory, "history.sqlite")}` });
    db = drizzle(client, { schema });
    await createSchema(client);
  });

  afterEach(() => {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("commits a run transition and its event together", async () => {
    const { runId } = await seedRun(db, "atomic-success");
    const now = 1_800_000_000;

    const result = await mutateAutomationRunWithEvent(db, {
      runId,
      expectedStatus: "queued",
      nextStatus: "running",
      patch: { startedAt: now },
      event: {
        id: "event-success",
        name: "run.started",
        actor: "runner:test",
        data: { trigger_receipt_id: "receipt-atomic-success" },
      },
      at: now,
    });

    expect(result.applied).toBe(true);
    const run = await readRun(db, runId);
    const events = await readEvents(db, runId);
    expect(run.status).toBe("running");
    expect(run.startedAt).toBe(now);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "event-success",
      event: "run.started",
      fromStatus: "queued",
      toStatus: "running",
      actor: "runner:test",
    });
    expect(JSON.parse(events[0]!.dataJson)).toEqual({
      trigger_receipt_id: "receipt-atomic-success",
    });
  });

  it("rolls the state mutation back when the event insert fails", async () => {
    const { projectId, runId } = await seedRun(db, "atomic-event-failure");
    await db.insert(automationRunEvents).values({
      id: "duplicate-event-id",
      projectId,
      runId,
      event: "run.seeded",
      fromStatus: "queued",
      toStatus: "queued",
      actor: "test",
      dataJson: "{}",
      at: 1_799_999_999,
    });

    await expect(mutateAutomationRunWithEvent(db, {
      runId,
      expectedStatus: "queued",
      nextStatus: "running",
      patch: { startedAt: 1_800_000_000 },
      event: {
        id: "duplicate-event-id",
        name: "run.started",
        actor: "runner:test",
      },
      at: 1_800_000_000,
    })).rejects.toThrow();

    const run = await readRun(db, runId);
    const events = await readEvents(db, runId);
    expect(run.status).toBe("queued");
    expect(run.startedAt).toBeNull();
    expect(events.map((event) => event.event)).toEqual(["run.seeded"]);
  });

  it("does not append an event when the compare-and-set mutation loses", async () => {
    const { runId } = await seedRun(db, "atomic-cas-loss", "running");

    const result = await mutateAutomationRunWithEvent(db, {
      runId,
      expectedStatus: "queued",
      nextStatus: "running",
      patch: { startedAt: 1_800_000_000 },
      event: {
        id: "event-must-not-exist",
        name: "run.started",
        actor: "runner:test",
      },
      at: 1_800_000_000,
    });

    expect(result).toEqual({ applied: false, run: null, eventId: null });
    expect(await readEvents(db, runId)).toEqual([]);
  });

  it("rolls every compound local row and event back when a later invariant fails", async () => {
    const { projectId, runId } = await seedRun(db, "compound-rollback");
    await expect(atomicAutomationHistory(db, async (tx) => {
      await tx.update(automationRuns).set({ status: "running" }).where(eq(automationRuns.id, runId));
      await appendAutomationRunEvent(tx, {
        id: "compound-event-must-rollback",
        projectId,
        runId,
        name: "run.running",
        fromStatus: "queued",
        toStatus: "running",
        actor: "runner:test",
        at: 1_800_000_000,
      });
      throw new Error("later related-row compare-and-set failed");
    })).rejects.toThrow("later related-row compare-and-set failed");

    expect((await readRun(db, runId)).status).toBe("queued");
    expect(await readEvents(db, runId)).toEqual([]);
  });

  it("makes a completed transition retry an event-free idempotent no-op", async () => {
    const { runId } = await seedRun(db, "atomic-retry");
    const input = {
      runId,
      expectedStatus: "queued" as const,
      nextStatus: "running" as const,
      patch: { startedAt: 1_800_000_000 },
      event: {
        id: "event-one-time",
        name: "run.started",
        actor: "runner:test",
      },
      at: 1_800_000_000,
    };

    expect((await mutateAutomationRunWithEvent(db, input)).applied).toBe(true);
    expect(await mutateAutomationRunWithEvent(db, input)).toEqual({
      applied: false,
      run: null,
      eventId: null,
    });
    expect(await readEvents(db, runId)).toHaveLength(1);
  });

  it("requires and honors a one-time guard for same-status evidence writes", async () => {
    const { runId } = await seedRun(db, "atomic-proof", "draft_pr_opened");
    const input = {
      runId,
      expectedStatus: "draft_pr_opened" as const,
      nextStatus: "draft_pr_opened" as const,
      patch: { prProofHash: "proof-hash" },
      guard: isNull(automationRuns.prProofHash),
      event: {
        id: "event-proof",
        name: "pr.proof_recorded",
        actor: "credential:ci_test",
        data: { proof_hash: "proof-hash" },
      },
      at: 1_800_000_000,
    };

    expect((await mutateAutomationRunWithEvent(db, input)).applied).toBe(true);
    expect((await mutateAutomationRunWithEvent(db, input)).applied).toBe(false);
    expect((await readRun(db, runId)).prProofHash).toBe("proof-hash");
    expect(await readEvents(db, runId)).toHaveLength(1);
  });
});

async function seedRun(
  db: TestDb,
  suffix: string,
  status: typeof automationRuns.$inferInsert.status = "queued",
) {
  const userId = `user-${suffix}`;
  const projectId = `project-${suffix}`;
  const runId = `run-${suffix}`;
  await db.run(sql`INSERT INTO users (id, email) VALUES (${userId}, ${`${suffix}@example.com`})`);
  await db.run(sql`INSERT INTO projects (id, user_id, name)
    VALUES (${projectId}, ${userId}, ${`Project ${suffix}`})`);
  await db.insert(automationRuns).values({
    id: runId,
    projectId,
    automationId: "atomic_history_test",
    contractRevision: 1,
    contractEtag: "etag-test",
    policySnapshotJson: "{}",
    triggerReceiptId: `receipt-${suffix}`,
    triggerKind: "manual",
    idempotencyKeyHash: `idempotency-${suffix}`,
    requestHash: `request-${suffix}`,
    status,
    deadlineAt: 1_900_000_000,
  });
  return { db, projectId, runId };
}

async function readRun(
  db: TestDb,
  runId: string,
) {
  return (await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1))[0]!;
}

async function readEvents(
  db: TestDb,
  runId: string,
) {
  return db
    .select()
    .from(automationRunEvents)
    .where(eq(automationRunEvents.runId, runId));
}

async function createSchema(client: Client): Promise<void> {
  await client.batch([
    `CREATE TABLE users (
      id text PRIMARY KEY,
      email text
    )`,
    `CREATE TABLE projects (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL
    )`,
    `CREATE TABLE project_deletion_fences (
      project_id text PRIMARY KEY REFERENCES projects(id),
      command_id text NOT NULL,
      reason text NOT NULL,
      actor text NOT NULL,
      created_at integer NOT NULL DEFAULT (unixepoch())
    )`,
    `CREATE TABLE automation_runs (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      automation_id text NOT NULL,
      contract_revision integer NOT NULL,
      contract_etag text NOT NULL,
      policy_snapshot_json text NOT NULL,
      case_id text,
      case_revision integer,
      trigger_receipt_id text NOT NULL UNIQUE,
      trigger_kind text NOT NULL,
      trigger_ref text,
      trigger_snapshot_json text NOT NULL DEFAULT '{}',
      idempotency_key_hash text NOT NULL,
      request_hash text NOT NULL,
      attempt integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'queued',
      runner_provider text,
      runner_id text,
      runner_credential_id text,
      model text,
      branch text,
      commit_sha text,
      pr_url text,
      deploy_sha text,
      summary_md text,
      evidence_json text NOT NULL DEFAULT '{}',
      verification_json text,
      verification_started_at integer,
      pr_proof_json text,
      pr_proof_hash text,
      pr_proof_credential_id text,
      pr_proof_at integer,
      turns_used integer NOT NULL DEFAULT 0,
      cost_micros integer NOT NULL DEFAULT 0,
      usage_sequence integer NOT NULL DEFAULT 0,
      deadline_at integer NOT NULL,
      last_heartbeat_at integer,
      retry_eligible_at integer,
      error_code text,
      error_message text,
      started_at integer,
      finished_at integer,
      created_at integer NOT NULL DEFAULT (unixepoch()),
      updated_at integer NOT NULL DEFAULT (unixepoch()),
      UNIQUE (project_id, idempotency_key_hash)
    )`,
    `CREATE TABLE automation_run_events (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      event text NOT NULL,
      from_status text,
      to_status text,
      actor text,
      data_json text NOT NULL DEFAULT '{}',
      at integer NOT NULL DEFAULT (unixepoch())
    )`,
  ], "write");
}
