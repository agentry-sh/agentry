import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { AutomationContractSchema } from "@agentrysh/shared";
import {
  automationContracts,
  auditLog,
  cases,
  deploys,
  mutationCommands,
  posthogConnections,
  projectCredentials,
} from "@agentry/db/schema";
import { disposeTestEnv, getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

const synchronizePosthogIssueMock = vi.hoisted(() => vi.fn());
const synchronizePosthogCasesForProjectMock = vi.hoisted(() => vi.fn());
const getPosthogIssueEventsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) => getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog-error-tracking.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog-error-tracking.js")>(
    "../src/posthog-error-tracking.js",
  );
  return {
    ...actual,
    synchronizePosthogIssue: (...args: unknown[]) => synchronizePosthogIssueMock(...args),
    synchronizePosthogCasesForProject: (...args: unknown[]) =>
      synchronizePosthogCasesForProjectMock(...args),
    getPosthogIssueEvents: (...args: unknown[]) => getPosthogIssueEventsMock(...args),
  };
});

const { createApp } = await import("../src/index.js");
const { automationContractEtag } = await import("../src/automation-contracts.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ withEncKey: true, fileDb: true });
  app = createApp();
  getPosthogIssueEventsMock.mockReset();
  getPosthogIssueEventsMock.mockResolvedValue({
    results: [], hasMore: false, limit: 5, offset: 0, nextOffset: null,
  });
  synchronizePosthogCasesForProjectMock.mockReset();
  synchronizePosthogCasesForProjectMock.mockImplementation(
    async (_env: unknown, _projectId: string, options: { limit?: number; offset?: number }) => ({
      page: {
        results: [],
        hasMore: false,
        limit: options.limit ?? 100,
        offset: options.offset ?? 0,
        nextOffset: null,
      },
      projected: 0,
      changed: 0,
    }),
  );
  synchronizePosthogIssueMock.mockReset();
  synchronizePosthogIssueMock.mockImplementation(async (_env: unknown, _projectId: string, caseId: string) => {
    const row = (
      await getDbForUrl(env.TURSO_DATABASE_URL).select().from(cases).where(eq(cases.id, caseId)).limit(1)
    )[0];
    if (!row) throw new Error(`missing projected case ${caseId}`);
    return {
      row,
      issue: { id: caseId, status: row.status, aggregations: { occurrences: row.eventCount, users: 0 } },
      latestEvent: null,
      changed: false,
      created: false,
    };
  });
});

afterEach(() => disposeTestEnv(env));

async function call(path: string, init?: RequestInit & { json?: unknown }): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  }), env);
}

async function setupProject() {
  const login = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email: `credential-${Math.random()}@example.com` },
  });
  const auth = (await login.json()) as { api_key: string; user_id: string };
  const create = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.api_key}`,
      "idempotency-key": `credential-project-${crypto.randomUUID()}`,
    },
    json: {
      name: "credential-provenance",
      repo_url: "https://github.com/example/app",
      default_branch: "main",
    },
  });
  const project = (await create.json()) as { id: string };
  return { ...auth, project };
}

async function createCredential(
  apiKey: string,
  projectId: string,
  body: { kind: "ci_deploy" | "automation_runner"; name: string; automation_id?: string },
) {
  const response = await call(`/v1/projects/${projectId}/credentials`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `credential-create-${crypto.randomUUID()}`,
    },
    json: body,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    id: string;
    credential: string;
    runner_id: string | null;
    scopes: string[];
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("project-scoped credentials and provenance", () => {
  it("refreshes all provider lifecycle states before filtering and discloses truncation", async () => {
    const state = await setupProject();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const caseId = `posthog-list-${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1_000);
    await db.insert(cases).values({
      id: caseId,
      projectId: state.project.id,
      providerIssueId: caseId,
      providerSnapshotHash: "1".repeat(64),
      providerProjectedAt: now,
      providerEventClassification: "customer_exception",
      fingerprint: caseId,
      errorType: "LifecycleError",
      message: "provider lifecycle changed",
      status: "active",
      eventCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
      revision: 1,
    });

    let projectedLifecycle = false;
    synchronizePosthogCasesForProjectMock.mockImplementation(
      async (_env: unknown, projectId: string, options: {
        status?: string;
        limit?: number;
        offset?: number;
      }) => {
        expect(projectId).toBe(state.project.id);
        expect(options.status).toBe("all");
        if (!projectedLifecycle) {
          projectedLifecycle = true;
          await db.update(cases).set({
            providerSnapshotHash: "2".repeat(64),
            providerProjectedAt: now + 1,
            status: "resolved",
            revision: 2,
          }).where(eq(cases.id, caseId));
        }
        return {
          page: {
            results: [],
            hasMore: false,
            limit: options.limit ?? 100,
            offset: options.offset ?? 0,
            nextOffset: null,
          },
          projected: 1,
          changed: projectedLifecycle ? 1 : 0,
        };
      },
    );

    const activeResponse = await call(`/v1/projects/${state.project.id}/cases`, {
      headers: bearer(state.api_key),
    });
    expect(activeResponse.status).toBe(200);
    const activeBody = await activeResponse.json() as {
      cases: Array<{ id: string }>;
      projection_refresh: Record<string, unknown>;
    };
    expect(activeBody.cases).toEqual([]);
    expect(activeBody.projection_refresh).toMatchObject({
      provider_status_filter: "all",
      requested_case_status: "active",
      complete: true,
      truncated: false,
      next_offset: null,
    });

    const resolvedResponse = await call(
      `/v1/projects/${state.project.id}/cases?status=resolved`,
      { headers: bearer(state.api_key) },
    );
    expect(resolvedResponse.status).toBe(200);
    expect(await resolvedResponse.json()).toMatchObject({
      cases: [{ id: caseId, status: "resolved", revision: 2 }],
      projection_refresh: {
        provider_status_filter: "all",
        requested_case_status: "resolved",
        complete: true,
        truncated: false,
      },
    });

    synchronizePosthogCasesForProjectMock.mockClear();
    synchronizePosthogCasesForProjectMock.mockImplementation(
      async (_env: unknown, _projectId: string, options: {
        status?: string;
        limit?: number;
        offset?: number;
      }) => {
        expect(options.status).toBe("all");
        const offset = options.offset ?? 0;
        return {
          page: {
            results: [{ id: `provider-page-${offset}` }],
            hasMore: true,
            limit: options.limit ?? 100,
            offset,
            nextOffset: offset + 1,
          },
          projected: 1,
          changed: 0,
        };
      },
    );
    const truncatedResponse = await call(
      `/v1/projects/${state.project.id}/cases?status=all`,
      { headers: bearer(state.api_key) },
    );
    expect(truncatedResponse.status).toBe(200);
    expect(synchronizePosthogCasesForProjectMock).toHaveBeenCalledTimes(5);
    expect(synchronizePosthogCasesForProjectMock.mock.calls.map((call) =>
      (call[2] as { offset: number }).offset)).toEqual([0, 1, 2, 3, 4]);
    expect(await truncatedResponse.json()).toMatchObject({
      cases: [{ id: caseId, status: "resolved" }],
      projection_refresh: {
        provider_status_filter: "all",
        requested_case_status: "all",
        pages: 5,
        projected: 5,
        complete: false,
        truncated: true,
        next_offset: 5,
      },
    });
  });

  it("keeps CI authority scoped to trusted deploy evidence", async () => {
    const state = await setupProject();
    expect(state.project).not.toHaveProperty("public_api_key");
    const ci = await createCredential(state.api_key, state.project.id, {
      kind: "ci_deploy",
      name: "production deploy workflow",
    });
    expect(ci.scopes).toEqual(["deploys:write", "automation_proofs:write"]);

    const list = await call(`/v1/projects/${state.project.id}/credentials`, {
      headers: bearer(state.api_key),
    });
    const listed = (await list.json()) as { credentials: Array<Record<string, unknown>> };
    expect(listed.credentials).toHaveLength(1);
    expect(listed.credentials.every((credential) => !("credential" in credential))).toBe(true);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const deploy = await call("/v1/deploys/", {
      method: "POST",
      headers: {
        ...bearer(ci.credential),
        "idempotency-key": "credential-provenance-deploy-0001",
      },
      json: { sha: "0123456789abcdef", branch: "main", environment: "production" },
    });
    expect(deploy.status).toBe(200);
    expect(await deploy.json()).toMatchObject({
      provenance: { trust_level: "trusted_ci", credential_kind: "ci_deploy", credential_id: ci.id },
    });
    expect((await db.select().from(deploys).where(eq(deploys.projectId, state.project.id)))[0])
      .toMatchObject({ trustLevel: "trusted_ci", credentialKind: "ci_deploy", credentialId: ci.id });

    const revoke = await call(`/v1/project-credentials/${ci.id}/revoke`, {
      method: "POST",
      headers: {
        ...bearer(state.api_key),
        "idempotency-key": "ci-credential-revoke-0001",
      },
      json: { reason: "Rotating the deploy workflow credential." },
    });
    expect(revoke.status).toBe(200);
    const revokedUse = await call("/v1/deploys/", {
      method: "POST",
      headers: bearer(ci.credential),
      json: { sha: "fedcba9876543210" },
    });
    expect(revokedUse.status).toBe(401);
    expect(((await revokedUse.json()) as { error: { code: string } }).error.code)
      .toBe("invalid_project_credential");
  });

  it("binds credential revocation to one durable command, reason, and audit event", async () => {
    const state = await setupProject();
    const credential = await createCredential(state.api_key, state.project.id, {
      kind: "ci_deploy",
      name: "deploy credential revocation receipt test",
    });
    const headers = {
      ...bearer(state.api_key),
      "idempotency-key": "credential-revoke-receipt-0001",
    };
    const body = { reason: "Rotate the deploy workflow credential." };
    const first = await call(`/v1/project-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers,
      json: body,
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      id: string;
      revoked_at: number;
      revoke_reason: string;
      idempotent_replay: boolean;
    };
    expect(firstBody).toMatchObject({
      id: credential.id,
      revoke_reason: body.reason,
      idempotent_replay: false,
    });

    const replay = await call(`/v1/project-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers,
      json: body,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      id: credential.id,
      revoked_at: firstBody.revoked_at,
      revoke_reason: body.reason,
      idempotent_replay: true,
    });

    const changedEvidence = await call(`/v1/project-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers,
      json: { reason: "A different reason must not become a replay." },
    });
    expect(changedEvidence.status).toBe(409);
    expect(await changedEvidence.json()).toMatchObject({
      error: { code: "idempotency_key_reused" },
    });
    const differentCommand = await call(`/v1/project-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers: {
        ...bearer(state.api_key),
        "idempotency-key": "credential-revoke-receipt-0002",
      },
      json: body,
    });
    expect(differentCommand.status).toBe(409);
    expect(await differentCommand.json()).toMatchObject({
      error: { code: "credential_already_revoked" },
    });

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const receipts = await db.select().from(mutationCommands)
      .where(eq(mutationCommands.resourceId, credential.id));
    const audits = await db.select().from(auditLog)
      .where(eq(auditLog.resourceId, credential.id));
    expect(receipts.filter((row) => row.action === "project_credential.revoke"))
      .toHaveLength(1);
    expect(audits.filter((row) => row.action === "project_credential.revoked"))
      .toHaveLength(1);
  });

  it("rolls credential revocation and its receipt back when audit persistence fails", async () => {
    const state = await setupProject();
    const credential = await createCredential(state.api_key, state.project.id, {
      kind: "ci_deploy",
      name: "atomic revocation test",
    });
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.run(sql`
      CREATE TRIGGER fail_project_credential_revoke_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action = 'project_credential.revoked'
      BEGIN
        SELECT RAISE(ABORT, 'forced credential revocation audit failure');
      END
    `);
    const headers = {
      ...bearer(state.api_key),
      "idempotency-key": "credential-revoke-audit-atomic-0001",
    };
    const body = { reason: "Audit must commit with revocation." };
    const failed = await call(`/v1/project-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers,
      json: body,
    });
    expect(failed.status).toBe(500);
    const beforeRetry = (
      await db.select().from(projectCredentials)
        .where(eq(projectCredentials.id, credential.id)).limit(1)
    )[0]!;
    expect(beforeRetry.revokedAt).toBeNull();
    expect((await db.select().from(mutationCommands)
      .where(eq(mutationCommands.resourceId, credential.id)))
      .filter((row) => row.action === "project_credential.revoke"))
      .toHaveLength(0);

    await db.run(sql`DROP TRIGGER fail_project_credential_revoke_audit`);
    const retry = await call(`/v1/project-credentials/${credential.id}/revoke`, {
      method: "POST",
      headers,
      json: body,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ idempotent_replay: false });
  });

  it("lets only one concurrent revocation reason become durable", async () => {
    const state = await setupProject();
    const credential = await createCredential(state.api_key, state.project.id, {
      kind: "ci_deploy",
      name: "concurrent deploy credential revocation test",
    });
    const revoke = (suffix: string, reason: string) => call(
      `/v1/project-credentials/${credential.id}/revoke`,
      {
        method: "POST",
        headers: {
          ...bearer(state.api_key),
          "idempotency-key": `credential-revoke-concurrent-${suffix}-0001`,
        },
        json: { reason },
      },
    );
    const responses = await Promise.all([
      revoke("first", "First concurrent owner reason."),
      revoke("second", "Second concurrent owner reason."),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json() as {
      revoke_reason: string;
    };
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const stored = (
      await db.select().from(projectCredentials)
        .where(eq(projectCredentials.id, credential.id)).limit(1)
    )[0]!;
    expect(stored.revokeReason).toBe(winner.revoke_reason);
    const receipts = (await db.select().from(mutationCommands)
      .where(eq(mutationCommands.resourceId, credential.id)))
      .filter((row) => row.action === "project_credential.revoke");
    const audits = (await db.select().from(auditLog)
      .where(eq(auditLog.resourceId, credential.id)))
      .filter((row) => row.action === "project_credential.revoked");
    expect(receipts).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it("binds runner authority to one automation and keeps PostHog issue mutation outside read-only OAuth", async () => {
    const state = await setupProject();
    const contract = AutomationContractSchema.parse({
      schema_version: "2",
      revision: 1,
      enabled: true,
      summary: "Runner provenance and bounded case review.",
      automations: [{
        id: "classify_noise",
        name: "Review a noisy case",
        enabled: true,
        runner: {
          provider: "codex",
          repository: "https://github.com/example/app",
          default_branch: "main",
          mode: "draft_only",
        },
        trigger: {
          kind: "unhandled_cases",
          max_cases_per_sweep: 10,
          cooldown_seconds: 300,
          required_trust: "customer_posthog",
        },
        allowed_actions: ["escalate"],
        scope: { allowed_paths: [], test_commands: [] },
        approvals: {},
        escalation: { destination: "project owner", instructions: "Escalate uncertainty." },
      }],
    });
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(automationContracts).values({
      projectId: state.project.id,
      schemaVersion: "2",
      revision: 1,
      enabled: 1,
      etag: await automationContractEtag(contract),
      documentJson: JSON.stringify(contract),
      createdBy: state.user_id,
      updatedBy: state.user_id,
    });
    const runner = await createCredential(state.api_key, state.project.id, {
      kind: "automation_runner",
      name: "weekly noise classifier",
      automation_id: "classify_noise",
    });
    expect(runner.runner_id).toBe(`credential:${runner.id}`);

    const caseId = `posthog-noise-${crypto.randomUUID()}`;
    const now = Math.floor(Date.now() / 1_000);
    await db.insert(cases).values({
      id: caseId,
      projectId: state.project.id,
      providerIssueId: caseId,
      providerSnapshotHash: "a".repeat(64),
      providerProjectedAt: now,
      providerEventClassification: "customer_exception",
      fingerprint: caseId,
      errorType: "NoiseError",
      message: "known browser extension noise",
      status: "active",
      eventCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
      revision: 1,
    });
    const unclaimedDetail = await call(`/v1/cases/${caseId}`, {
      headers: bearer(runner.credential),
    });
    expect(unclaimedDetail.status).toBe(403);
    expect(((await unclaimedDetail.json()) as { error: { details: { required_authority: string } } })
      .error.details.required_authority).toBe("unexpired_unreleased_exact_runner_claim");
    const runnerCaseList = await call(
      `/v1/projects/${state.project.id}/cases?unhandled=true`,
      { headers: bearer(runner.credential) },
    );
    expect(runnerCaseList.status).toBe(401);
    const runnerAffectedUsers = await call(`/v1/cases/${caseId}/users`, {
      headers: bearer(runner.credential),
    });
    expect(runnerAffectedUsers.status).toBe(401);
    const runnerRawUsers = await call(`/v1/projects/${state.project.id}/users`, {
      headers: bearer(runner.credential),
    });
    expect(runnerRawUsers.status).toBe(401);
    const forbiddenCaseMutation = await call(`/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: bearer(runner.credential),
      json: { status: "suppressed", agent_summary: "Bypass approval." },
    });
    expect(forbiddenCaseMutation.status).toBe(403);
    expect(((await forbiddenCaseMutation.json()) as { error: { code: string } }).error.code)
      .toBe("credential_scope_denied");

    const untrustedIssue = await call(`/v1/projects/${state.project.id}/automation-triggers/issue`, {
      method: "POST",
      headers: bearer(runner.credential),
      json: { automation_id: "classify_noise" },
    });
    expect(untrustedIssue.status).toBe(200);
    expect(await untrustedIssue.json()).toMatchObject({
      issued_count: 0,
      receipts: [],
      skipped: [{ code: "no_eligible_cases" }],
    });

    const activeConnection = {
      id: `phconn-${state.project.id}`,
      projectId: state.project.id,
      authorizedByUserId: state.user_id,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active" as const,
      accessTokenCiphertext: "encrypted-access",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: now + 86_400,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us" as const,
      posthogOrganizationId: "org-credential-provenance",
      posthogEnvironmentId: 42,
      authorizedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(posthogConnections).values(activeConnection);
    await db.update(cases).set({
      providerSnapshotHash: "b".repeat(64),
      eventCount: 2,
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
      revision: 2,
    }).where(eq(cases.id, caseId));

    const issue = await call(`/v1/projects/${state.project.id}/automation-triggers/issue`, {
      method: "POST",
      headers: bearer(runner.credential),
      json: { automation_id: "classify_noise" },
    });
    expect(issue.status).toBe(200);
    const issueBody = (await issue.json()) as { receipts: Array<{ id: string }> };
    expect(issueBody.receipts).toHaveLength(1);
    const triggerReceiptId = issueBody.receipts[0]!.id;

    await db.delete(posthogConnections)
      .where(eq(posthogConnections.projectId, state.project.id));
    const mislabeledClaim = await call(`/v1/cases/${caseId}/claims`, {
      method: "POST",
      headers: { ...bearer(runner.credential), "idempotency-key": "runner-claim-provenance-reject" },
      json: {
        automation_id: "classify_noise",
        trigger_receipt_id: triggerReceiptId,
        claimed_by: runner.runner_id,
      },
    });
    expect(mislabeledClaim.status).toBe(409);
    expect((await mislabeledClaim.json() as { error: { code: string } }).error.code)
      .toBe("case_signal_trust_insufficient");
    await db.insert(posthogConnections).values(activeConnection);

    const claimResponse = await call(`/v1/cases/${caseId}/claims`, {
      method: "POST",
      headers: { ...bearer(runner.credential), "idempotency-key": "runner-claim-0002" },
      json: {
        automation_id: "classify_noise",
        trigger_receipt_id: triggerReceiptId,
        claimed_by: runner.runner_id,
      },
    });
    expect(claimResponse.status).toBe(200);
    const claim = (await claimResponse.json()) as { id: string; lease_token: string; case_revision: number; trigger_receipt_id: string };
    expect(claim.case_revision).toBe(2);
    const runnerHeaders = {
      ...bearer(runner.credential),
      "x-agentry-lease-token": claim.lease_token,
    };
    const claimedDetail = await call(`/v1/cases/${caseId}`, {
      headers: bearer(runner.credential),
    });
    expect(claimedDetail.status).toBe(200);
    expect(await claimedDetail.json()).not.toHaveProperty("affected_users");
    const ownerDetail = await call(`/v1/cases/${caseId}`, {
      headers: bearer(state.api_key),
    });
    expect(ownerDetail.status).toBe(200);
    expect(await ownerDetail.json()).toHaveProperty("affected_users");

    const otherCaseId = `posthog-other-${crypto.randomUUID()}`;
    await db.insert(cases).values({
      id: otherCaseId,
      projectId: state.project.id,
      providerIssueId: otherCaseId,
      providerSnapshotHash: "c".repeat(64),
      providerProjectedAt: now,
      providerEventClassification: "customer_exception",
      fingerprint: otherCaseId,
      errorType: "DifferentError",
      message: "another trusted production failure",
      status: "active",
      eventCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
    });
    expect((await call(`/v1/cases/${otherCaseId}`, {
      headers: bearer(runner.credential),
    })).status).toBe(403);

    const secondRunner = await createCredential(state.api_key, state.project.id, {
      kind: "automation_runner",
      name: "replacement noise classifier",
      automation_id: "classify_noise",
    });
    expect((await call(`/v1/cases/${caseId}`, {
      headers: bearer(secondRunner.credential),
    })).status).toBe(403);

    const start = await call(`/v1/projects/${state.project.id}/automation-runs`, {
      method: "POST",
      headers: { ...runnerHeaders, "idempotency-key": "runner-start-0001" },
      json: {
        automation_id: "classify_noise",
        trigger_receipt_id: claim.trigger_receipt_id,
        case_id: caseId,
        claim_id: claim.id,
        runner: { provider: "codex", id: runner.runner_id, model: "gpt-5" },
      },
    });
    const startBody = await start.json() as Record<string, unknown>;
    expect(start.status, JSON.stringify(startBody)).toBe(200);
    const run = startBody as unknown as { id: string; runner: { credential_id: string } };
    expect(run.runner.credential_id).toBe(runner.id);
    await call(`/v1/automation-runs/${run.id}`, {
      method: "PATCH",
      headers: runnerHeaders,
      json: { status: "running" },
    });

    const caseAfter = await call(`/v1/cases/${caseId}`, { headers: bearer(state.api_key) });
    expect(await caseAfter.json()).toMatchObject({ status: "active" });

    synchronizePosthogIssueMock.mockImplementationOnce(async () => {
      const updated = (
        await db.update(cases).set({
          providerSnapshotHash: "d".repeat(64),
          providerProjectedAt: now + 1,
          status: "resolved",
          revision: 3,
        }).where(eq(cases.id, caseId)).returning()
      )[0]!;
      return {
        row: updated,
        issue: {
          id: caseId,
          status: "resolved",
          aggregations: { occurrences: updated.eventCount, users: 0 },
        },
        latestEvent: null,
        changed: true,
        created: false,
      };
    });
    const staleClaimRead = await call(`/v1/cases/${caseId}`, {
      headers: bearer(runner.credential),
    });
    expect(staleClaimRead.status).toBe(403);
    expect(await staleClaimRead.json()).toMatchObject({
      error: {
        code: "credential_scope_denied",
        details: {
          case_revision: 3,
          current_status: "resolved",
          reissue_allowed: false,
          required_authority: "unexpired_unreleased_exact_runner_claim",
        },
      },
    });

    await call(`/v1/project-credentials/${runner.id}/revoke`, {
      method: "POST",
      headers: {
        ...bearer(state.api_key),
        "idempotency-key": "runner-credential-revoke-0001",
      },
      json: { reason: "Schedule retired." },
    });
    const revokedRead = await call(`/v1/automation-runs/${run.id}`, {
      headers: bearer(runner.credential),
    });
    expect(revokedRead.status).toBe(401);
    const row = (
      await db.select().from(projectCredentials).where(eq(projectCredentials.id, runner.id)).limit(1)
    )[0]!;
    expect(row.revokedAt).not.toBeNull();
  });
});
