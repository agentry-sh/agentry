import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import {
  AutomationContractSchema,
  canonicalJsonStringify,
  sha256Hex,
  uuidv7,
} from "@agentrysh/shared";
import {
  apiKeys,
  auditLog,
  automationContracts,
  mutationCommands,
  projectCredentials,
  projectDeletionFences,
  projectMemberships,
  projects,
  webhookDeliveries,
  webhooks,
} from "@agentry/db/schema";
import { automationContractEtag } from "../src/automation-contracts.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");
const { prepareWebhookOutbox } = await import("../src/webhooks.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let idSequence = 0;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true, fileDb: true });
  app = createApp();
  idSequence = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  disposeTestEnv(env);
});

async function call(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, {
    ...init,
    headers,
    body,
  }), env);
}

async function signup(email = `mutation-${++idSequence}@example.com`) {
  const response = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(response.status).toBe(200);
  return await response.json() as { api_key: string; user_id: string };
}

async function createProject(apiKey: string, name = "mutation-test", key = `project-${++idSequence}-stable`) {
  const response = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": key,
    },
    json: { name },
  });
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return await response.json() as {
    command_id: string;
    id: string;
    idempotent_replay: boolean;
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(await check()).toBe(true);
}

describe("durable mutation idempotency and secret recovery", () => {
  it("requires a stable 8-500 character Idempotency-Key before mutating", async () => {
    const owner = await signup("required-idempotency@example.com");
    const missing = await call("/v1/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.api_key}` },
      json: { name: "must-not-exist" },
    });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({
      error: { details: { header: "Idempotency-Key", action: "project.create" } },
    });

    for (const key of ["short", "x".repeat(501)]) {
      const invalid = await call("/v1/projects", {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.api_key}`,
          "idempotency-key": key,
        },
        json: { name: "must-not-exist" },
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "invalid_payload" } });
    }

    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(projects)).toHaveLength(0);
    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(mutationCommands)).toHaveLength(0);
  });

  it("replays project creation without minting application telemetry credentials", async () => {
    const owner = await signup("project-retry@example.com");
    const headers = {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": "project-create-lost-response-0001",
    };
    const body = {
      name: "retry-safe-project",
      repo_url: "https://example.com/repo",
    };

    const first = await call("/v1/projects", {
      method: "POST",
      headers,
      json: body,
    });
    expect(first.status).toBe(200);
    const created = await first.json() as {
      command_id: string;
      id: string;
      idempotent_replay: boolean;
      next_action: string;
    };
    expect(created.idempotent_replay).toBe(false);
    expect(created.command_id).toMatch(/^mutcmd_/);
    expect(created).not.toHaveProperty("public_api_key");
    expect(created).not.toHaveProperty("server_api_key");
    expect(created.next_action).toContain("PostHog OAuth");

    const replay = await call("/v1/projects", {
      method: "POST",
      headers,
      json: body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      command_id: created.command_id,
      id: created.id,
      idempotent_replay: true,
    });

    const changed = await call("/v1/projects", {
      method: "POST",
      headers,
      json: { name: "changed-project" },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      error: { code: "idempotency_key_reused" },
    });

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    expect(await db.select().from(projects)).toHaveLength(1);
    const commands = await db.select().from(mutationCommands);
    expect(commands.filter((row) => row.action === "project.create")).toHaveLength(1);
    const audits = await db.select().from(auditLog);
    expect(
      audits.filter(
        (row) => row.action === "project.created" && row.phase === "succeeded",
      ),
    ).toHaveLength(1);
  });

  it("rolls back the project cascade when terminal deletion audit evidence conflicts", async () => {
    const owner = await signup("project-delete-terminal-audit-conflict@example.com");
    const project = await createProject(
      owner.api_key,
      "project-delete-terminal-audit-conflict",
      "project-delete-terminal-audit-conflict-create-0001",
    );
    const idempotencyKey = "project-delete-terminal-audit-conflict-delete-0001";
    const operationId = `auditop_${await sha256Hex(canonicalJsonStringify({
      user_id: owner.user_id,
      project_id: project.id,
      action: "project.deleted",
      resource_type: "project",
      method: "DELETE",
      path: `/v1/projects/${project.id}`,
      request_identity: `idempotency:${idempotencyKey}`,
    }))}`;
    const terminalAuditId = `audit_${await sha256Hex(`${operationId}:succeeded`)}`;
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(auditLog).values({
      id: terminalAuditId,
      userId: owner.user_id,
      projectId: null,
      operationId,
      requestHash: "corrupt-conflicting-request-hash",
      phase: "succeeded",
      action: "project.deleted",
      resourceType: "project",
      resourceId: project.id,
      summary: "conflicting terminal evidence",
      metadataJson: "{}",
    });

    let deletion: Response | null = null;
    let deletionJson: Record<string, any> = {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      deletion = await call(`/v1/projects/${project.id}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${owner.api_key}`,
          "idempotency-key": idempotencyKey,
        },
      });
      deletionJson = await deletion.json() as Record<string, unknown>;
      if (deletion.status === 409) break;
      await db.update(projectDeletionFences).set({
        createdAt: sql<number>`unixepoch() - 60`,
      }).where(eq(projectDeletionFences.projectId, project.id));
    }

    expect(deletion?.status).toBe(409);
    expect(deletionJson).toMatchObject({
      error: {
        code: "project_deletion_terminal_audit_conflict",
        details: {
          project_id: project.id,
          command_id: expect.stringMatching(/^mutcmd_/),
          expected_audit_id: terminalAuditId,
          conflicting_audit_id: terminalAuditId,
          retryable: false,
          operator_remediation_required: true,
          project_preserved: true,
        },
      },
    });
    expect(deletionJson.error?.next_action).toMatch(/Stop retrying.*operator/i);
    expect(await db.select().from(projects).where(eq(projects.id, project.id)))
      .toHaveLength(1);
    const [command] = await db.select().from(mutationCommands).where(and(
      eq(mutationCommands.action, "project.delete"),
      eq(mutationCommands.resourceId, project.id),
    ));
    expect(command?.status).not.toBe("succeeded");
    const [conflict] = await db.select().from(auditLog)
      .where(eq(auditLog.id, terminalAuditId));
    expect(conflict?.requestHash).toBe("corrupt-conflicting-request-hash");

    const repeated = await call(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "idempotency-key": idempotencyKey,
      },
    });
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      error: {
        code: "project_deletion_terminal_audit_conflict",
        details: { retryable: false, operator_remediation_required: true },
      },
    });
  });

  it("lets an invited co-owner delete within the Agentry project boundary", async () => {
    const creator = await signup("project-delete-creator@example.com");
    const coOwner = await signup("project-delete-co-owner@example.com");
    const project = await createProject(
      creator.api_key,
      "delete-by-co-owner",
      "delete-by-co-owner-create-0001",
    );
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(projectMemberships).values({
      id: uuidv7(),
      projectId: project.id,
      userId: coOwner.user_id,
      role: "owner",
      invitedBy: creator.user_id,
      createdAt: sql<number>`unixepoch()`,
    });

    const deleted = await call(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${coOwner.api_key}`,
        "idempotency-key": "delete-by-co-owner-0001",
      },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ deleted: true, id: project.id });
    expect(await db.select().from(projects).where(eq(projects.id, project.id))).toHaveLength(0);
  });

  it("stages owner-key replacement, never remints on retry, and revokes only after handoff", async () => {
    const owner = await signup("owner-rotate@example.com");
    const headers = {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": "owner-key-rotate-lost-response-0001",
    };
    const first = await call("/v1/auth/keys/rotate", { method: "POST", headers });
    expect(first.status).toBe(200);
    const replacement = await first.json() as {
      api_key: string;
      key_id: string;
      previous_key_id: string;
      previous_key_active: boolean;
    };
    expect(replacement.previous_key_active).toBe(true);
    expect((await call("/v1/projects", {
      headers: { authorization: `Bearer ${owner.api_key}` },
    })).status).toBe(200);

    const replay = await call("/v1/auth/keys/rotate", { method: "POST", headers });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: {
        code: "owner_key_secret_not_recoverable",
        details: {
          replacement_key_id: replacement.key_id,
          previous_key_active: true,
          idempotent_replay: true,
        },
      },
    });
    const keys = await call("/v1/auth/keys", {
      headers: { authorization: `Bearer ${replacement.api_key}` },
    });
    expect((await keys.json() as { keys: unknown[] }).keys).toHaveLength(2);

    const revoked = await call(`/v1/auth/keys/${replacement.previous_key_id}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${replacement.api_key}`,
        "idempotency-key": "owner-key-revoke-old-0001",
      },
      json: { reason: "Replacement verified." },
    });
    expect(revoked.status).toBe(200);
    expect((await call("/v1/projects", {
      headers: { authorization: `Bearer ${owner.api_key}` },
    })).status).toBe(401);
    expect((await call("/v1/projects", {
      headers: { authorization: `Bearer ${replacement.api_key}` },
    })).status).toBe(200);
  });

  it("binds an already-revoked owner-key no-op to its exact command evidence", async () => {
    const owner = await signup("owner-revoke-noop@example.com");
    const firstRotation = await call("/v1/auth/keys/rotate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "idempotency-key": "owner-key-noop-first-rotation-0001",
      },
    });
    expect(firstRotation.status).toBe(200);
    const first = await firstRotation.json() as {
      api_key: string;
      previous_key_id: string;
    };
    expect((await call(`/v1/auth/keys/${first.previous_key_id}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.api_key}`,
        "idempotency-key": "owner-key-noop-initial-revoke-0001",
      },
      json: { reason: "First replacement verified." },
    })).status).toBe(200);

    const secondRotation = await call("/v1/auth/keys/rotate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${first.api_key}`,
        "idempotency-key": "owner-key-noop-second-rotation-0001",
      },
    });
    expect(secondRotation.status).toBe(200);
    const second = await secondRotation.json() as {
      api_key: string;
      previous_key_id: string;
    };
    const sharedHeaders = {
      authorization: `Bearer ${second.api_key}`,
      "idempotency-key": "owner-key-already-revoked-noop-0001",
    };
    const reason = "Confirm stale key cleanup.";
    const noOp = await call(`/v1/auth/keys/${first.previous_key_id}/revoke`, {
      method: "POST",
      headers: sharedHeaders,
      json: { reason },
    });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({
      key_id: first.previous_key_id,
      already_revoked: true,
      idempotent_replay: false,
    });
    const replay = await call(`/v1/auth/keys/${first.previous_key_id}/revoke`, {
      method: "POST",
      headers: sharedHeaders,
      json: { reason },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotent_replay: true });

    const changedTarget = await call(`/v1/auth/keys/${second.previous_key_id}/revoke`, {
      method: "POST",
      headers: sharedHeaders,
      json: { reason },
    });
    expect(changedTarget.status).toBe(409);
    expect(await changedTarget.json()).toMatchObject({
      error: { code: "idempotency_key_reused" },
    });
    expect((await call("/v1/projects", {
      headers: { authorization: `Bearer ${first.api_key}` },
    })).status).toBe(200);
  });

  it("does not mint a second runner credential when the raw response is lost", async () => {
    const owner = await signup("runner-credential@example.com");
    const project = await createProject(owner.api_key, "runner-credential", "runner-project-create-0001");
    const contract = AutomationContractSchema.parse({
      schema_version: "2",
      revision: 1,
      enabled: false,
      summary: "Retry-safe runner credential test.",
      automations: [{
        id: "fix_errors",
        name: "Fix errors",
        enabled: false,
        runner: {
          provider: "codex",
          repository: "https://github.com/example/app",
          default_branch: "main",
          mode: "draft_only",
        },
        trigger: {
          kind: "unhandled_cases",
          max_cases_per_sweep: 1,
          cooldown_seconds: 60,
          required_trust: "customer_posthog",
        },
        allowed_actions: ["escalate"],
        scope: { allowed_paths: [], test_commands: [] },
        approvals: { required_for: [], expires_after_seconds: 3600 },
        escalation: { destination: "owner", instructions: "Escalate." },
      }],
    });
    await getDbForUrl(env.TURSO_DATABASE_URL).insert(automationContracts).values({
      projectId: project.id,
      schemaVersion: "2",
      revision: 1,
      enabled: 0,
      etag: await automationContractEtag(contract),
      documentJson: JSON.stringify(contract),
      createdBy: owner.user_id,
      updatedBy: owner.user_id,
    });
    const headers = {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": "runner-credential-create-0001",
    };
    const body = {
      kind: "automation_runner",
      name: "fix-errors runner",
      automation_id: "fix_errors",
    };
    const first = await call(`/v1/projects/${project.id}/credentials`, {
      method: "POST",
      headers,
      json: body,
    });
    expect(first.status).toBe(200);
    const created = await first.json() as { id: string; credential: string };
    expect(created.credential).toMatch(/^agentry_runner_/);

    const replay = await call(`/v1/projects/${project.id}/credentials`, {
      method: "POST",
      headers,
      json: body,
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      error: {
        code: "credential_secret_not_recoverable",
        details: { credential_id: created.id, active: true },
      },
    });
    const rows = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select().from(projectCredentials).where(eq(projectCredentials.projectId, project.id));
    expect(rows).toHaveLength(1);

    const changed = await call(`/v1/projects/${project.id}/credentials`, {
      method: "POST",
      headers,
      json: { ...body, name: "changed runner" },
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
  });

  it("makes simultaneous deletion fences beat owner contract and credential creation writes", async () => {
    const owner = await signup("automation-fence-owner-race@example.com");
    const contract = AutomationContractSchema.parse({
      schema_version: "2",
      revision: 1,
      enabled: false,
      summary: "Fence atomic owner admission writes.",
      automations: [{
        id: "fenced_runner",
        name: "Fenced runner",
        enabled: false,
        runner: {
          provider: "codex",
          repository: "https://github.com/example/app",
          default_branch: "main",
          mode: "draft_only",
        },
        trigger: {
          kind: "unhandled_cases",
          max_cases_per_sweep: 1,
          cooldown_seconds: 60,
          required_trust: "customer_posthog",
        },
        allowed_actions: ["escalate"],
        scope: { allowed_paths: [], test_commands: [] },
        approvals: { required_for: [], expires_after_seconds: 3_600 },
        escalation: { destination: "owner", instructions: "Stop and escalate." },
      }],
    });

    const contractProject = await createProject(
      owner.api_key,
      "fenced-contract-create",
      "fenced-contract-project-create-0001",
    );
    await getDbForUrl(env.TURSO_DATABASE_URL).run(sql`PRAGMA journal_mode=WAL`);
    await getDbForUrl(env.TURSO_DATABASE_URL).run(sql`PRAGMA busy_timeout=2000`);
    const startFenceWinner = async (projectId: string, commandId: string) => {
      const script = `
        import { createClient } from "@libsql/client";
        const client = createClient({ url: process.argv[1] });
        await client.execute("PRAGMA journal_mode=WAL");
        await client.execute("PRAGMA busy_timeout=2000");
        await client.execute("BEGIN IMMEDIATE");
        await client.execute({
          sql: "INSERT INTO project_deletion_fences (project_id, command_id, reason, actor, created_at) VALUES (?, ?, 'project_delete', ?, unixepoch())",
          args: [process.argv[2], process.argv[3], process.argv[4]],
        });
        process.stdout.write("LOCKED\\n");
        setTimeout(async () => {
          await client.execute("COMMIT");
          client.close();
          process.exit(0);
        }, 100);
      `;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, env.TURSO_DATABASE_URL, projectId, commandId, `user:${owner.user_id}`],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const exitPromise = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0
          ? resolve()
          : reject(new Error(`fence child exited ${code}: ${stderr}`)));
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
        child.once("error", reject);
        void exitPromise.catch(reject);
      });
      return {
        wait: () => exitPromise,
      };
    };
    const contractFence = await startFenceWinner(contractProject.id, "contract-fence-winner");
    const contractAttempt = call(`/v1/projects/${contractProject.id}/automation-contract`, {
      method: "PUT",
      headers: { authorization: `Bearer ${owner.api_key}` },
      json: contract,
    });
    const contractResponse = await contractAttempt;
    await contractFence.wait();
    expect(contractResponse.status).toBe(409);
    expect(await contractResponse.json()).toMatchObject({
      error: { code: "project_deletion_in_progress" },
    });
    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(automationContracts)
      .where(eq(automationContracts.projectId, contractProject.id))).toHaveLength(0);

    const credentialProject = await createProject(
      owner.api_key,
      "fenced-credential-create",
      "fenced-credential-project-create-0001",
    );
    await getDbForUrl(env.TURSO_DATABASE_URL).insert(automationContracts).values({
      projectId: credentialProject.id,
      schemaVersion: "2",
      revision: 1,
      enabled: 0,
      etag: await automationContractEtag(contract),
      documentJson: JSON.stringify(contract),
      createdBy: owner.user_id,
      updatedBy: owner.user_id,
    });
    const credentialFence = await startFenceWinner(credentialProject.id, "credential-fence-winner");
    const credentialAttempt = call(`/v1/projects/${credentialProject.id}/credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "idempotency-key": "fenced-runner-credential-create-0001",
      },
      json: {
        kind: "automation_runner",
        name: "must not mint",
        automation_id: "fenced_runner",
      },
    });
    const credentialResponse = await credentialAttempt;
    await credentialFence.wait();
    expect(credentialResponse.status).toBe(409);
    expect(await credentialResponse.json()).toMatchObject({
      error: { code: "project_deletion_in_progress" },
    });
    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(projectCredentials)
      .where(eq(projectCredentials.projectId, credentialProject.id))).toHaveLength(0);
    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(mutationCommands)
      .where(and(
        eq(mutationCommands.projectId, credentialProject.id),
        eq(mutationCommands.action, "project_credential.create"),
      ))).toHaveLength(0);
  });

  it("recovers webhook creation and keeps one stable test delivery per command", async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const owner = await signup("webhook-retry@example.com");
    const project = await createProject(owner.api_key, "webhook-retry", "webhook-project-create-0001");
    const createHeaders = {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": "webhook-create-lost-response-0001",
    };
    const body = { url: "https://hooks.example.com/events", events: ["case.created"] };
    const first = await call(`/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: createHeaders,
      json: body,
    });
    expect(first.status).toBe(200);
    const created = await first.json() as { id: string; signing_secret: string };
    const replay = await call(`/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: createHeaders,
      json: body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: created.id,
      signing_secret: created.signing_secret,
      idempotent_replay: true,
    });
    expect(await getDbForUrl(env.TURSO_DATABASE_URL).select().from(webhooks)).toHaveLength(1);

    const changed = await call(`/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: createHeaders,
      json: { ...body, events: ["case.resolved"] },
    });
    expect(changed.status).toBe(409);

    const testHeaders = {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": "webhook-test-delivery-0001",
    };
    const tested = await call(`/v1/projects/${project.id}/webhooks/${created.id}/test`, {
      method: "POST",
      headers: testHeaders,
    });
    expect(tested.status).toBe(200);
    const testBody = await tested.json() as { delivery_ids: string[]; source_event_id: string };
    await waitFor(() => outbound.length === 1);
    const testReplay = await call(`/v1/projects/${project.id}/webhooks/${created.id}/test`, {
      method: "POST",
      headers: testHeaders,
    });
    expect(testReplay.status).toBe(200);
    expect(await testReplay.json()).toMatchObject({
      delivery_ids: testBody.delivery_ids,
      source_event_id: testBody.source_event_id,
      idempotent_replay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outbound).toHaveLength(1);

    const secondCreate = await call(`/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "idempotency-key": "webhook-create-second-target-0001",
      },
      json: { url: "https://second-hooks.example.com/events", events: ["case.created"] },
    });
    expect(secondCreate.status).toBe(200);
    const secondHook = await secondCreate.json() as { id: string };
    const changedTestTarget = await call(
      `/v1/projects/${project.id}/webhooks/${secondHook.id}/test`,
      { method: "POST", headers: testHeaders },
    );
    expect(changedTestTarget.status).toBe(409);
    expect(await changedTestTarget.json()).toMatchObject({
      error: { code: "idempotency_key_reused" },
    });
    expect(outbound).toHaveLength(1);
    const deliveries = await getDbForUrl(env.TURSO_DATABASE_URL)
      .select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sourceEventId).toBe(testBody.source_event_id);

    const disabled = await call(`/v1/projects/${project.id}/webhooks/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner.api_key}` },
    });
    expect(disabled.status).toBe(200);
    const replayAfterDisable = await call(`/v1/projects/${project.id}/webhooks/${created.id}/test`, {
      method: "POST",
      headers: testHeaders,
    });
    expect(replayAfterDisable.status).toBe(200);
    expect(await replayAfterDisable.json()).toMatchObject({
      delivery_ids: testBody.delivery_ids,
      source_event_id: testBody.source_event_id,
      idempotent_replay: true,
    });
    expect(outbound).toHaveLength(1);
  });

  it("uses the database clock for webhook leases despite Worker clock skew", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    const owner = await signup("webhook-clock-skew@example.com");
    const project = await createProject(owner.api_key, "webhook-clock-skew", "webhook-clock-project-0001");
    const createdResponse = await call(`/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "idempotency-key": "webhook-clock-create-0001",
      },
      json: { url: "https://clock.example.com/events", events: ["case.created"] },
    });
    expect(createdResponse.status).toBe(200);
    const hook = await createdResponse.json() as { id: string };
    const realNowMs = Date.now();
    const realNow = Math.floor(realNowMs / 1_000);

    const behind = vi.spyOn(Date, "now").mockReturnValue(realNowMs - 86_400_000);
    let completed: Response;
    try {
      completed = await call(`/v1/projects/${project.id}/webhooks/${hook.id}/test`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.api_key}`,
          "idempotency-key": "webhook-clock-behind-0001",
        },
      });
    } finally {
      behind.mockRestore();
    }
    expect(completed!.status).toBe(200);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const completedCommands = (await db.select().from(mutationCommands)).filter(
      (row) => row.action === "webhook.test" && row.resourceId !== null,
    );
    const completedCommand = completedCommands.find((row) => row.status === "succeeded");
    expect(completedCommand).toMatchObject({
      status: "succeeded",
      leaseToken: null,
      leaseExpiresAt: null,
      attemptCount: 1,
    });
    expect(completedCommand!.createdAt).toBeGreaterThanOrEqual(realNow);
    expect(completedCommand!.updatedAt).toBeGreaterThanOrEqual(realNow);

    const activeKey = "webhook-clock-active-0001";
    const scope = {
      schema_version: "1",
      actor_user_id: owner.user_id,
      project_id: project.id,
      action: "webhook.test",
      idempotency_key: activeKey,
    };
    const idempotencyKeyHash = await sha256Hex(canonicalJsonStringify(scope));
    const requestHash = await sha256Hex(canonicalJsonStringify({
      ...scope,
      request: { webhook_id: hook.id, event: "case.created" },
    }));
    const sourceEventId = `webhook-test:${requestHash}`;
    const activeId = `mutcmd_${idempotencyKeyHash}`;
    await db.insert(mutationCommands).values({
      id: activeId,
      actorUserId: owner.user_id,
      projectId: project.id,
      action: "webhook.test",
      idempotencyKeyHash,
      requestHash,
      resourceType: "webhook_delivery",
      resourceId: sourceEventId,
      responseJson: "{}",
      status: "intent",
      updatedAt: realNow,
      createdAt: realNow,
    });
    await db.update(mutationCommands).set({
      status: "in_progress",
      version: 1,
      leaseToken: "active-webhook-database-lease",
      leaseExpiresAt: sql<number>`unixepoch() + 600`,
      attemptCount: 1,
      updatedAt: sql<number>`unixepoch()`,
    }).where(and(
      eq(mutationCommands.id, activeId),
      eq(mutationCommands.status, "intent"),
      eq(mutationCommands.version, 0),
    ));

    const ahead = vi.spyOn(Date, "now").mockReturnValue(realNowMs + 86_400_000);
    let busy: Response;
    try {
      busy = await call(`/v1/projects/${project.id}/webhooks/${hook.id}/test`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.api_key}`,
          "idempotency-key": activeKey,
        },
      });
    } finally {
      ahead.mockRestore();
    }
    expect(busy!.status).toBe(409);
    expect(await busy!.json()).toMatchObject({ error: { code: "mutation_in_progress" } });
    const [unchanged] = await db.select().from(mutationCommands)
      .where(eq(mutationCommands.id, activeId));
    expect(unchanged).toMatchObject({
      version: 1,
      leaseToken: "active-webhook-database-lease",
      attemptCount: 1,
    });
  });

  it("never replays a signing secret whose ciphertext belongs to another webhook", async () => {
    const owner = await signup("webhook-secret-integrity@example.com");
    const project = await createProject(
      owner.api_key,
      "webhook-secret-integrity",
      "webhook-secret-integrity-project-0001",
    );
    const createHook = async (suffix: string) => {
      const request = {
        url: `https://${suffix}.hooks.example.com/events`,
        events: ["case.created"],
      };
      const idempotencyKey = `webhook-secret-integrity-${suffix}-0001`;
      const response = await call(`/v1/projects/${project.id}/webhooks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.api_key}`,
          "idempotency-key": idempotencyKey,
        },
        json: request,
      });
      expect(response.status).toBe(200);
      return {
        request,
        idempotencyKey,
        body: await response.json() as { id: string; signing_secret: string },
      };
    };
    const first = await createHook("first-integrity");
    const second = await createHook("second-integrity");
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const secondRow = (
      await db.select().from(webhooks).where(eq(webhooks.id, second.body.id)).limit(1)
    )[0];
    expect(secondRow?.signingSecretEnc).toBeTruthy();
    expect(secondRow?.signingSecretIv).toBeTruthy();
    await db
      .update(webhooks)
      .set({
        signingSecretEnc: secondRow!.signingSecretEnc,
        signingSecretIv: secondRow!.signingSecretIv,
      })
      .where(eq(webhooks.id, first.body.id));

    const replay = await call(`/v1/projects/${project.id}/webhooks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.api_key}`,
        "idempotency-key": first.idempotencyKey,
      },
      json: first.request,
    });
    expect(replay.status).toBe(500);
    const errorBody = await replay.json();
    expect(errorBody).toMatchObject({
      error: {
        code: "persistence_failed",
        details: {
          webhook_id: first.body.id,
          integrity_check: "signing_secret_binding",
        },
      },
    });
    const serializedError = JSON.stringify(errorBody);
    expect(serializedError).not.toContain(first.body.signing_secret);
    expect(serializedError).not.toContain(second.body.signing_secret);
  });

  it("binds a crash-left webhook recipient reservation to one exact test command", async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      outbound.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const owner = await signup("webhook-reservation-race@example.com");
    const project = await createProject(
      owner.api_key,
      "webhook-reservation-race",
      "webhook-reservation-project-0001",
    );
    const createHook = async (suffix: string) => {
      const response = await call(`/v1/projects/${project.id}/webhooks`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.api_key}`,
          "idempotency-key": `webhook-reservation-create-${suffix}-0001`,
        },
        json: {
          url: `https://${suffix}.hooks.example.com/events`,
          events: ["case.created"],
        },
      });
      expect(response.status).toBe(200);
      return await response.json() as { id: string };
    };
    const hookA = await createHook("first");
    const hookB = await createHook("second");
    const idempotencyKey = "webhook-test-reservation-race-0001";
    const scope = {
      schema_version: "1",
      actor_user_id: owner.user_id,
      project_id: project.id,
      action: "webhook.test",
      idempotency_key: idempotencyKey,
    };
    const idempotencyKeyHash = await sha256Hex(canonicalJsonStringify(scope));
    const requestHash = await sha256Hex(canonicalJsonStringify({
      ...scope,
      request: { webhook_id: hookA.id, event: "case.created" },
    }));
    const sourceEventId = `webhook-test:${requestHash}`;
    const now = Math.floor(Date.now() / 1_000);
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(mutationCommands).values({
      id: `mutcmd_${idempotencyKeyHash}`,
      actorUserId: owner.user_id,
      projectId: project.id,
      action: "webhook.test",
      idempotencyKeyHash,
      requestHash,
      resourceType: "webhook_delivery",
      resourceId: sourceEventId,
      responseJson: "{}",
      status: "intent",
      updatedAt: now,
      createdAt: now,
    });
    const reserved = await prepareWebhookOutbox(
      env,
      project.id,
      "case.created",
      {
        synthetic: true,
        message: "This is a synthetic test event from POST /webhooks/:id/test.",
      },
      { sourceEventId, webhookId: hookA.id },
    );
    expect(reserved.recipientWebhookIds).toEqual([hookA.id]);
    expect(await db.select().from(webhookDeliveries)).toHaveLength(0);

    const headers = {
      authorization: `Bearer ${owner.api_key}`,
      "idempotency-key": idempotencyKey,
    };
    const changedTarget = await call(
      `/v1/projects/${project.id}/webhooks/${hookB.id}/test`,
      { method: "POST", headers },
    );
    expect(changedTarget.status).toBe(409);
    expect(await changedTarget.json()).toMatchObject({
      error: { code: "idempotency_key_reused" },
    });
    expect(await db.select().from(webhookDeliveries)).toHaveLength(0);

    const recovered = await call(
      `/v1/projects/${project.id}/webhooks/${hookA.id}/test`,
      { method: "POST", headers },
    );
    expect(recovered.status).toBe(200);
    await waitFor(() => outbound.length === 1);
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      webhookId: hookA.id,
      sourceEventId,
    });
    expect(deliveries[0]?.webhookId).not.toBe(hookB.id);
  });
});
