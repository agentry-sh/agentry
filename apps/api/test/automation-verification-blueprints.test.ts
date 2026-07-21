import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  automationRuns,
  cases,
  deploys,
  posthogConnections,
} from "@agentry/db/schema";
import { CUSTOMER_ANALYTICS_HOGQL_FILTER } from "../src/customer-data.js";
import {
  getQueryBlueprintTemplate,
  interpolateQuery,
  prepareQueryBlueprintExecution,
} from "../src/query-blueprint-catalog.js";
import { __clearRateLimitForTests } from "../src/rate-limit.js";
import { createTestProjectCredential, getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";
import { seedVerifiedOnboardingReadiness } from "./onboarding-readiness-fixture.js";

const runHogQlMock = vi.hoisted(() => vi.fn());
const listPosthogIssuesMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>(
    "../src/posthog.js",
  );
  return {
    ...actual,
    isPosthogConfigured: () => true,
    runHogQl: (...args: unknown[]) => runHogQlMock(...args),
  };
});

vi.mock("../src/posthog-error-tracking.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog-error-tracking.js")>(
    "../src/posthog-error-tracking.js",
  );
  return {
    ...actual,
    listPosthogIssues: (...args: unknown[]) => listPosthogIssuesMock(...args),
  };
});

const { createApp } = await import("../src/index.js");

const OUTCOME_ID = "automation_case_recurrence_after_deploy";
const SAMPLE_ID = "automation_deploy_traffic_sample";
const PROJECT_EVENT = "request_completed";
const PLAN_HASH = "verification-blueprints-plan-v1";
const DEPLOYED_AT = "2026-07-10T09:00:00.000Z";
const CHECKED_AT = "2026-07-10T10:00:00.000Z";
const DEPLOYED_AT_SECONDS = Date.parse(DEPLOYED_AT) / 1_000;
const CHECKED_AT_SECONDS = Date.parse(CHECKED_AT) / 1_000;

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = createApp();
  runHogQlMock.mockReset();
  listPosthogIssuesMock.mockReset();
  __clearRateLimitForTests();
});

afterEach(() => {
  vi.clearAllMocks();
  __clearRateLimitForTests();
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers,
      body,
    }),
    env,
  );
}

async function login(email: string): Promise<{ apiKey: string }> {
  const response = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { api_key: string };
  return { apiKey: body.api_key };
}

async function createProject(apiKey: string): Promise<{ id: string }> {
  const response = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: { name: "automation-verification-blueprints" },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ id: string }>;
}

interface VerificationBinding {
  runId: string;
  caseId: string;
  caseRevision: number;
  deploySha: string;
  sourceCommitSha: string;
  fingerprint: string;
  posthogConnectionId: string;
}

async function seedVerificationBinding(projectId: string): Promise<VerificationBinding> {
  const binding = {
    runId: "run-verification-1",
    caseId: "case-verification-1",
    caseRevision: 2,
    deploySha: "deploy0123456789abcdef",
    sourceCommitSha: "source0123456789abcdef",
    fingerprint: "fp-verification-case",
    posthogConnectionId: `phconn-${projectId}`,
  };
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const ci = await createTestProjectCredential(env, projectId, "ci_deploy");
  await db.insert(posthogConnections).values({
    id: `phconn-${projectId}`,
    projectId,
    oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
    status: "active",
    accessTokenCiphertext: "encrypted-access",
    accessTokenIv: "access-iv",
    refreshTokenCiphertext: "encrypted-refresh",
    refreshTokenIv: "refresh-iv",
    accessTokenExpiresAt: CHECKED_AT_SECONDS + 3_600,
    posthogHost: "https://us.posthog.com",
    posthogRegion: "us",
    posthogOrganizationId: "org-verification",
    posthogEnvironmentId: 42,
    authorizedAt: DEPLOYED_AT_SECONDS,
    createdAt: DEPLOYED_AT_SECONDS,
    updatedAt: DEPLOYED_AT_SECONDS,
  });
  await db.insert(cases).values({
    id: binding.caseId,
    projectId,
    providerIssueId: binding.caseId,
    providerSnapshotHash: "a".repeat(64),
    providerProjectedAt: DEPLOYED_AT_SECONDS + 120,
    providerEventClassification: "customer_exception",
    fingerprint: binding.fingerprint,
    errorType: "TypeError",
    message: "bounded test case",
    status: "active",
    eventCount: 3,
    firstSeenAt: DEPLOYED_AT_SECONDS - 3_600,
    lastSeenAt: DEPLOYED_AT_SECONDS + 120,
    lastDeploySha: binding.deploySha,
    lastTrustLevel: "customer_posthog",
    lastCredentialKind: "posthog_oauth",
    revision: 3,
  });
  await db.insert(automationRuns).values({
    id: binding.runId,
    projectId,
    automationId: "auto-self-heal",
    contractRevision: 1,
    contractEtag: "contract-etag-1",
    policySnapshotJson: "{}",
    caseId: binding.caseId,
    caseRevision: binding.caseRevision,
    triggerReceiptId: "receipt-verification-1",
    triggerKind: "unhandled_cases",
    triggerRef: binding.caseId,
    triggerSnapshotJson: "{}",
    idempotencyKeyHash: "idem-verification-1",
    requestHash: "request-verification-1",
    status: "verifying",
    commitSha: binding.sourceCommitSha,
    prProofHash: "b".repeat(64),
    prProofCredentialId: ci.id,
    deploySha: binding.deploySha,
    verificationStartedAt: DEPLOYED_AT_SECONDS,
    deadlineAt: CHECKED_AT_SECONDS + 3_600,
    createdAt: DEPLOYED_AT_SECONDS - 3_600,
    updatedAt: DEPLOYED_AT_SECONDS,
  });
  await db.insert(deploys).values({
    id: "deploy-verification-1",
    projectId,
    sha: binding.deploySha,
    branch: "main",
    environment: "production",
    automationRunId: binding.runId,
    sourceCommitSha: binding.sourceCommitSha,
    trustLevel: "trusted_ci",
    credentialKind: "ci_deploy",
    credentialId: ci.id,
    receivedAt: DEPLOYED_AT_SECONDS,
  });
  return binding;
}

async function saveAnalyticsReadiness(projectId: string, approvedEvents: string[]) {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  await seedVerifiedOnboardingReadiness({
    db,
    project_id: projectId,
    approved_events: approvedEvents,
    approved_plan_hash: PLAN_HASH,
  });
}

function outcomeParams(binding: VerificationBinding): Record<string, unknown> {
  return {
    run_id: binding.runId,
    case_id: binding.caseId,
    case_revision: binding.caseRevision,
    deploy_sha: binding.deploySha,
    deployed_at: DEPLOYED_AT,
    checked_at: CHECKED_AT,
  };
}

function sampleParams(binding: VerificationBinding): Record<string, unknown> {
  return {
    deploy_sha: binding.deploySha,
    deployed_at: DEPLOYED_AT,
    checked_at: CHECKED_AT,
    event_name: PROJECT_EVENT,
  };
}

async function runBlueprint(
  projectId: string,
  apiKey: string,
  blueprintId: string,
  params: Record<string, unknown>,
) {
  return call(`/v1/projects/${projectId}/query-blueprints/${blueprintId}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    json: { params },
  });
}

describe("canonical post-deploy verification query blueprints", () => {
  it("publishes strict non-report contracts and exact half-open windows", async () => {
    const outcome = getQueryBlueprintTemplate(OUTCOME_ID)!;
    const sample = getQueryBlueprintTemplate(SAMPLE_ID)!;
    expect(outcome).toMatchObject({
      backend: "operational",
      strict_params: true,
      expected_columns: ["recurrence_count"],
      automation_verification: {
        kind: "case_recurrence",
        count_column: "recurrence_count",
        expected_rows: 1,
        exact_window: {
          bounds: "[start,end)",
          maximum_seconds: 2_592_000,
        },
      },
    });
    expect(outcome.automation_readiness).toBeUndefined();
    expect(outcome.params.map((param) => param.name)).toEqual([
      "run_id",
      "case_id",
      "case_revision",
      "deploy_sha",
      "deployed_at",
      "checked_at",
    ]);
    expect(sample).toMatchObject({
      backend: "analytics",
      strict_params: true,
      required_event_params: ["event_name"],
      expected_columns: ["sample_count"],
      automation_verification: {
        kind: "deploy_traffic_sample",
        count_column: "sample_count",
        expected_rows: 1,
      },
    });
    expect(sample.automation_readiness).toBeUndefined();
    expect(sample.params.map((param) => param.name)).toEqual([
      "deploy_sha",
      "deployed_at",
      "checked_at",
      "event_name",
    ]);
    expect(sample.query).toContain(CUSTOMER_ANALYTICS_HOGQL_FILTER);
    expect(sample.query).toContain("timestamp >= deployed_at");
    expect(sample.query).toContain("timestamp < checked_at");
    expect(sample.query).toContain("properties['deploy_sha']");
    expect(sample.query).not.toMatch(/\bnow\s*\(/i);

    const valid = sampleParams({
      runId: "unused",
      caseId: "unused",
      caseRevision: 1,
      deploySha: "deploy-sha",
      sourceCommitSha: "unused",
      fingerprint: "unused",
      posthogConnectionId: "unused",
    });
    expect(() => prepareQueryBlueprintExecution(sample, {
      ...valid,
      unknown: true,
    })).toThrow(/unknown param/);
    expect(() => interpolateQuery(sample.query, {
      ...valid,
      unknown: true,
    }, sample.params)).toThrow(/unknown param/);
    expect(() => prepareQueryBlueprintExecution(sample, {
      ...valid,
      checked_at: DEPLOYED_AT,
    })).toThrow(/strictly after/);
    expect(() => prepareQueryBlueprintExecution(sample, {
      ...valid,
      checked_at: "2026-08-10T09:00:01.000Z",
    })).toThrow(/at most 2592000 seconds/);
    expect(() => prepareQueryBlueprintExecution(sample, {
      ...valid,
      checked_at: "2026-07-10T10:00:00.123Z",
    })).toThrow(/whole second/);
    expect(() => prepareQueryBlueprintExecution(outcome, {
      run_id: "run",
      case_id: "case",
      case_revision: 1.5,
      deploy_sha: "deploy-sha",
      deployed_at: DEPLOYED_AT,
      checked_at: CHECKED_AT,
    })).toThrow(/integer/);
    expect(() => prepareQueryBlueprintExecution(outcome, {
      run_id: "run",
      case_id: "case",
      case_revision: 1,
      deploy_sha: "deploy-sha",
      deployed_at: DEPLOYED_AT,
      checked_at: CHECKED_AT,
      extra: "not allowed",
    })).toThrow(/unknown param/);
  });

  it("counts exact recurrence while excluding synthetic, other-deploy, and end-boundary rows", async () => {
    const owner = await login("verification-outcome-owner@example.com");
    const project = await createProject(owner.apiKey);
    const binding = await seedVerificationBinding(project.id);
    listPosthogIssuesMock.mockResolvedValueOnce({
      results: [{
        id: binding.caseId,
        status: "active",
        aggregations: { occurrences: 2, users: 1 },
      }],
      hasMore: false,
      limit: 100,
      offset: 0,
      nextOffset: null,
    });

    const response = await runBlueprint(
      project.id,
      owner.apiKey,
      OUTCOME_ID,
      outcomeParams(binding),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      rows: Array<Record<string, unknown>>;
      row_count: number;
    };
    expect(body.row_count).toBe(1);
    expect(body.rows).toEqual([{ recurrence_count: 2 }]);
    expect(JSON.stringify(body.rows)).not.toContain(binding.fingerprint);
    expect(JSON.stringify(body.rows)).not.toContain(binding.caseId);
    expect(listPosthogIssuesMock).toHaveBeenCalledWith(
      env,
      project.id,
      expect.objectContaining({
        status: "all",
        release: binding.deploySha,
        dateFrom: DEPLOYED_AT,
        dateTo: CHECKED_AT,
      }),
    );
  });

  it("rejects wrong run, case revision, deploy, and deploy timestamp bindings and prevents source-commit drift", async () => {
    const owner = await login("verification-binding-owner@example.com");
    const project = await createProject(owner.apiKey);
    const binding = await seedVerificationBinding(project.id);
    const variants = [
      { ...outcomeParams(binding), run_id: "wrong-run" },
      { ...outcomeParams(binding), case_id: "wrong-case" },
      { ...outcomeParams(binding), case_revision: binding.caseRevision + 1 },
      { ...outcomeParams(binding), deploy_sha: "wrong-deploy" },
      {
        ...outcomeParams(binding),
        deployed_at: "2026-07-10T09:00:01.000Z",
      },
    ];
    for (const params of variants) {
      const response = await runBlueprint(
        project.id,
        owner.apiKey,
        OUTCOME_ID,
        params,
      );
      expect(response.status).toBe(409);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe("verification_binding_mismatch");
    }
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await expect(
      db.update(deploys)
        .set({ sourceCommitSha: "different-source-commit" })
        .where(eq(deploys.automationRunId, binding.runId)),
    ).rejects.toMatchObject({ cause: { code: "SQLITE_CONSTRAINT_TRIGGER" } });
    const preservedDeploy = (
      await db.select().from(deploys)
        .where(eq(deploys.automationRunId, binding.runId)).limit(1)
    )[0]!;
    expect(preservedDeploy.sourceCommitSha).toBe(binding.sourceCommitSha);
  });

  it("returns truthful zero traffic only for an approved verified event and exact trusted deploy", async () => {
    const owner = await login("verification-sample-owner@example.com");
    const project = await createProject(owner.apiKey);
    const binding = await seedVerificationBinding(project.id);
    await saveAnalyticsReadiness(project.id, [PROJECT_EVENT]);
    runHogQlMock.mockResolvedValueOnce({
      columns: ["sample_count"],
      results: [[0]],
    });

    const response = await runBlueprint(
      project.id,
      owner.apiKey,
      SAMPLE_ID,
      sampleParams(binding),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      rows: Array<{ sample_count: number }>;
      input_readiness: {
        selected_event_params: string[];
        selected_events: string[];
        event_order: string;
        trusted_deploy: string;
      };
      next_action: string;
    };
    expect(body.rows).toEqual([{ sample_count: 0 }]);
    expect(body.input_readiness).toEqual(expect.objectContaining({
      selected_event_params: ["event_name"],
      selected_events: [PROJECT_EVENT],
      event_order: "not_applicable",
      trusted_deploy: "exact_ci_deploy_verified",
    }));
    expect(body.next_action).toContain("Zero approved traffic");
    expect(body.next_action).toContain("Do not treat zero recurrence");
    expect(runHogQlMock).toHaveBeenCalledTimes(1);
    const query = String(runHogQlMock.mock.calls[0]?.[2] ?? "");
    expect(query).toContain(`event = '${PROJECT_EVENT}'`);
    expect(query).toContain(`= '${binding.deploySha}'`);
    expect(query).toContain("timestamp >= deployed_at");
    expect(query).toContain("timestamp < checked_at");
    expect(query).toContain(CUSTOMER_ANALYTICS_HOGQL_FILTER);

    const wrongDeploy = await runBlueprint(
      project.id,
      owner.apiKey,
      SAMPLE_ID,
      { ...sampleParams(binding), deploy_sha: "wrong-deploy" },
    );
    expect(wrongDeploy.status).toBe(412);
    const unapproved = await runBlueprint(
      project.id,
      owner.apiKey,
      SAMPLE_ID,
      { ...sampleParams(binding), event_name: "unapproved_event" },
    );
    expect(unapproved.status).toBe(412);
    expect(runHogQlMock).toHaveBeenCalledTimes(1);
  });

  it("rejects synthetic event names before consulting onboarding readiness", async () => {
    const owner = await login("verification-synthetic-owner@example.com");
    const project = await createProject(owner.apiKey);
    const binding = await seedVerificationBinding(project.id);
    const response = await runBlueprint(
      project.id,
      owner.apiKey,
      SAMPLE_ID,
      {
        ...sampleParams(binding),
        event_name: "install.verify.synthetic",
      },
    );
    expect(response.status).toBe(412);
    expect(runHogQlMock).not.toHaveBeenCalled();
  });
});
