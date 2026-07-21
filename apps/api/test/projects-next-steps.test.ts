import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cases,
  mutationCommands,
  posthogConnections,
  projectArtifacts,
  projectSignalMaps,
} from "@agentry/db/schema";
import { uuidv7 } from "@agentrysh/shared";
import { INSTALL_COMPLETE_USER_HANDOFF } from "../src/install-handoff.js";
import { createTestProjectCredential, getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";
import { seedVerifiedOnboardingReadiness } from "./onboarding-readiness-fixture.js";

const posthogState = vi.hoisted(() => ({
  configured: false,
}));

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>("../src/posthog.js");
  return {
    ...actual,
    isPosthogConfigured: () => posthogState.configured,
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = createApp();
  posthogState.configured = false;
});

afterEach(() => {
  vi.clearAllMocks();
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

async function signup(email: string): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { api_key: string; user_id: string };
  return { apiKey: data.api_key, userId: data.user_id };
}

async function createProject(
  apiKey: string,
  body: { name: string; repo_url?: string; default_branch?: string; local_path?: string },
): Promise<{
  id: string;
  [key: string]: unknown;
}> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: body,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    id: string;
    [key: string]: unknown;
  };
}

async function saveGreenVerifyReport(
  projectId: string,
): Promise<void> {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  await seedVerifiedOnboardingReadiness({
    db,
    project_id: projectId,
    approved_events: ["signup_started", "signup_completed"],
    approved_plan_hash: "plan_hash_123",
  });
}

async function saveLegacyGreenVerifyReport(projectId: string): Promise<void> {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const artifact = {
      artifact: "verify_report",
      approved_plan_hash: "legacy_plan_hash",
      ok: true,
      minimum_install_complete: true,
      summary: "legacy install verified",
      passed: ["errors", "analytics", "deploys"],
      failed: [],
      repo_audit: {
        status: "fresh",
        reason: "repo audit matched the approved signal map",
        repo_root: "/tmp/project",
      },
      gate_failures: [],
      readiness_gaps: [],
      planned_event_check: {
        requested: true,
        required_event_count: 1,
        seen_required_event_count: 1,
        missing_events: [],
        missing_event_properties: [],
      },
      answer_contract_check: {
        requested: true,
        applicable_count: 1,
        answerable_count: 1,
        pending_real_data_count: 0,
        blocked_count: 0,
        answerable_contract_ids: ["signup-funnel"],
        blocked_contract_ids: [],
        pending_real_data_contract_ids: [],
        missing_events: [],
        missing_event_properties: [],
      },
      error_surface_check: {
        requested: true,
        applicable_count: 1,
        wired_count: 1,
        missing_ids: [],
      },
      real_events: {
        total: 1,
        real: 1,
        samples: ["signup_completed"],
      },
      live_signal_proof: greenLiveSignalProof(1),
      suggested_next_step_titles: [],
      generated_at: Math.floor(Date.now() / 1000),
    };
  const now = Math.floor(Date.now() / 1000);
  await db.insert(projectArtifacts).values({
    projectId,
    artifactType: "verify_report",
    artifactJson: JSON.stringify(artifact),
    artifactEtag: '"legacy-verify-report"',
    approvedPlanHash: "legacy_plan_hash",
    createdAt: now,
    updatedAt: now,
  });
}

async function saveSignalMap(projectId: string, signalTypes: string[]): Promise<void> {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const now = Math.floor(Date.now() / 1000);
  await db.insert(projectSignalMaps).values({
    projectId,
    contractVersion: "install-contract/v1",
    framework: "next",
    surface: "server",
    signalTypesJson: JSON.stringify(signalTypes),
    shapesJson: JSON.stringify(["b2b-saas"]),
    hasRevenue: 1,
    isB2b: 1,
    isTwoSided: 0,
    mode: "verify",
    approvedEventsJson: signalTypes.includes("analytics") ? JSON.stringify(["signup_completed"]) : "[]",
    approvedEventPropertiesJson: "{}",
    providerSatisfiedEventsJson: "[]",
    discoveryMapJson: "{}",
    eventBucketsJson: "[]",
    happyPathFunnelJson: "[]",
    failureSurfaceMapJson: "[]",
    plannedWiringMapJson: "[]",
    questionsToAnswerJson: "[]",
    postSetupBlueprintJson: "{}",
    recipeDecisionsJson: "[]",
    approvalNotesJson: "[]",
    approvedPlanHash: "plan_hash_123",
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

function greenLiveSignalProof(realEvents: number) {
  return {
    complete: true,
    proof_window_started_at: Math.floor(Date.now() / 1000),
    errors: {
      required: true,
      complete: true,
      non_synthetic_event_count: 1,
      event_ids: ["case-1"],
    },
    analytics: {
      required: true,
      complete: true,
      approved_event_count: 1,
      observed_event_count: realEvents,
      required_event_property_count: 0,
      observed_event_property_count: 0,
      missing_events: [],
      missing_event_properties: [],
    },
    deploys: {
      required: true,
      complete: true,
      trusted_ci_deploy_count: 1,
      deploy_ids: ["deploy-1"],
      shas: ["deploy-1"],
    },
    error_surfaces: {
      required: true,
      complete: true,
      applicable_count: 1,
      wired_count: 1,
      missing_ids: [],
    },
    state_transitions: {
      required: false,
      complete: true,
      checked_events: [],
      weak_events: [],
    },
  };
}

describe("project lifecycle hard cut", () => {
  it("creates projects without provisioning or promising an Agentry-owned PostHog project", async () => {
    const owner = await signup("project-coverage@example.com");

    const malformed = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `malformed-project-${crypto.randomUUID()}`,
      },
      body: "{broken",
    });
    expect(malformed.status).toBe(400);

    const invalid = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.apiKey}`,
        "idempotency-key": `invalid-project-${crypto.randomUUID()}`,
      },
      json: {},
    });
    expect(invalid.status).toBe(400);

    posthogState.configured = true;
    const project = await createProject(owner.apiKey, {
      name: "configured-project",
      repo_url: "https://github.com/acme/configured-project",
      default_branch: "develop",
      local_path: "/srv/configured-project",
    });
    expect(project).not.toHaveProperty("analytics");
    expect(project).not.toHaveProperty("logs_url");
    expect(project).not.toHaveProperty("analytics_url");
    expect(String(project.next_action)).toContain("PostHog OAuth");
    expect(String(project.next_action)).toContain("never provisions or deletes");

    await Promise.resolve();
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const commands = await db.select().from(mutationCommands);
    expect(commands).toEqual([
      expect.objectContaining({ action: "project.create" }),
    ]);

    const list = await call("/v1/projects", {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(list.status).toBe(200);
    const listJson = (await list.json()) as {
      projects: Array<{
        id: string;
        repo_url: string | null;
        default_branch: string;
        local_path: string | null;
      }>;
    };
    expect(listJson.projects).toEqual([
      expect.objectContaining({
        id: project.id,
        repo_url: "https://github.com/acme/configured-project",
        default_branch: "develop",
        local_path: "/srv/configured-project",
      }),
    ]);

    const detail = await call(`/v1/projects/${project.id}`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(detail.status).toBe(200);
    const detailJson = (await detail.json()) as Record<string, unknown>;
    expect(detailJson).not.toHaveProperty("analytics");
    expect(String(detailJson.next_action)).toContain("never provision");
  });

  it("deletes only Agentry-owned project metadata and detaches the customer PostHog connection", async () => {
    const owner = await signup("local-project-delete@example.com");
    const project = await createProject(owner.apiKey, { name: "local-delete" });
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const now = Math.floor(Date.now() / 1000);
    await db.insert(posthogConnections).values({
      id: `phconn-${project.id}`,
      projectId: project.id,
      authorizedByUserId: owner.userId,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: now + 3600,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org_customer",
      posthogEnvironmentId: 4242,
      authorizedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const deleted = await call(`/v1/projects/${project.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${owner.apiKey}`,
        "idempotency-key": "local-only-project-delete",
      },
    });
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as Record<string, unknown> & {
      cleanup: Record<string, unknown>;
    };
    expect(body.cleanup.customer_posthog_data_affected).toBe(false);
    expect(body.cleanup).not.toHaveProperty("posthog_operation");
    expect(body.cleanup).not.toHaveProperty("posthog_external_follow_up");
    expect(body.cleanup).not.toHaveProperty("external_provider_follow_up");
    expect(String(body.next_action)).toContain("Customer-owned PostHog data is untouched");
    expect(await db.select().from(posthogConnections)).toHaveLength(0);
  });
});

describe("next steps and source verification", () => {
  it("surfaces next-step suggestions from project state", async () => {
    const owner = await signup("next-steps@example.com");

    const sparseProject = await createProject(owner.apiKey, { name: "sparse-project" });
    const sparse = await call(`/v1/projects/${sparseProject.id}/next-steps`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(sparse.status).toBe(200);
    const sparseJson = (await sparse.json()) as {
      count: number;
      project_state: {
        signal_types: string[];
        analytics_scope: boolean;
        errors_scope: boolean;
        deploys_scope: boolean;
        analytics_configured: boolean;
        has_events: boolean;
	        has_cases: boolean;
	        has_deploys: boolean;
	        install_verified: boolean;
	        minimum_install_complete: boolean;
	        readiness_complete: boolean;
	        answer_ready: boolean;
	        readiness_gaps_count: number;
	        pending_real_data_count: number;
	      };
      suggestions: Array<{ id: string; prompt_template: string; uses: string[] }>;
      next_action: string;
    };
    expect(sparseJson.project_state).toEqual({
      signal_types: [],
      analytics_scope: false,
      errors_scope: false,
      deploys_scope: false,
      analytics_configured: false,
      has_events: false,
	      has_cases: false,
	      has_deploys: false,
	      install_verified: false,
	      minimum_install_complete: false,
	      readiness_complete: false,
	      answer_ready: false,
	      readiness_gaps_count: 0,
	      pending_real_data_count: 0,
	    });
    expect(sparseJson.count).toBe(0);
    expect(sparseJson.suggestions).toEqual([]);
    expect(sparseJson.next_action).toContain("one next_action");
    expect(sparseJson.next_action).toContain("status=verified");

    posthogState.configured = true;
    const richProject = await createProject(owner.apiKey, { name: "rich-project" });
    const richCi = await createTestProjectCredential(env, richProject.id, "ci_deploy");

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const projectedAt = Math.floor(Date.now() / 1000);
    await db.insert(cases).values({
      id: uuidv7(),
      projectId: richProject.id,
      providerIssueId: "posthog-issue-next-steps",
      providerSnapshotHash: "a".repeat(64),
      providerProjectedAt: projectedAt,
      providerEventClassification: "customer_exception",
      fingerprint: "posthog-issue-next-steps",
      errorType: "TypeError",
      message: "Projected PostHog error",
      status: "active",
      eventCount: 1,
      firstSeenAt: projectedAt,
      lastSeenAt: projectedAt,
    });

    const deploy = await call(`/v1/deploys/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${richCi.credential}`,
        "idempotency-key": "next-steps-rich-deploy-0001",
      },
      json: { sha: "deploy-1", branch: "main" },
    });
    expect(deploy.status).toBe(200);
    await saveGreenVerifyReport(richProject.id);

    const rich = await call(`/v1/projects/${richProject.id}/next-steps`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(rich.status).toBe(200);
    const richJson = (await rich.json()) as {
      count: number;
      project_state: {
        signal_types: string[];
        analytics_scope: boolean;
        errors_scope: boolean;
        deploys_scope: boolean;
        analytics_configured: boolean;
        has_events: boolean;
	        has_cases: boolean;
	        has_deploys: boolean;
	        install_verified: boolean;
	        minimum_install_complete: boolean;
	        readiness_complete: boolean;
	        answer_ready: boolean;
	        readiness_gaps_count: number;
	        pending_real_data_count: number;
	      };
      suggestions: Array<{ id: string; title: string; prompt_template: string; uses: string[] }>;
      next_action: string;
    };
    expect(richJson.project_state).toEqual({
      signal_types: ["errors", "analytics", "deploys"],
      analytics_scope: true,
      errors_scope: true,
      deploys_scope: true,
      analytics_configured: true,
      has_events: true,
	      has_cases: true,
	      has_deploys: true,
	      install_verified: true,
	      minimum_install_complete: true,
	      readiness_complete: true,
	      answer_ready: true,
	      readiness_gaps_count: 0,
	      pending_real_data_count: 0,
	    });
    expect(richJson.count).toBe(12);
    expect(richJson.suggestions.map((entry) => entry.id)).toEqual([
      "go_live_deployment_checklist",
      "answer_product_question",
      "review_primary_funnel_readiness",
      "review_current_error_cases",
      "deploy_health_check",
      "investigate_top_error",
      "review_signup_funnel",
      "compare_versions",
      "weekly_review",
      "build_custom_interface",
      "ask_custom_question",
      "auto_fix_on_error",
    ]);
    const productQuestion = richJson.suggestions.find((entry) => entry.id === "answer_product_question");
    expect(productQuestion?.title).toBe("Answer a product question from verified analytics signals");
    expect(productQuestion?.prompt_template).toContain("Answer the highest-impact Agentry analytics question");
    expect(productQuestion?.prompt_template).toContain("Return one concise answer with evidence first");
    expect(productQuestion?.prompt_template).toContain("Do not build a dashboard or persistent route unless the user asks");
    expect(productQuestion?.prompt_template).toContain("keep owner reads server-only");
    expect(productQuestion?.prompt_template).toContain("business question, funnel, events/properties");
    expect(productQuestion?.prompt_template).toContain("Do not add AGENTRY_PRIVATE_API_KEY");
    expect(productQuestion?.prompt_template).toContain("at least 45 seconds");
    expect(productQuestion?.uses).not.toContain("POST /v1/projects/:project_id/public-queries");
    const internalFunnel = richJson.suggestions.find((entry) => entry.id === "review_primary_funnel_readiness");
    expect(internalFunnel?.title).toBe("Review the primary funnel and readiness gaps");
    expect(internalFunnel?.prompt_template).toContain("Review the approved primary funnel");
    expect(internalFunnel?.prompt_template).toContain("Return a written readiness handoff only");
    expect(internalFunnel?.prompt_template).toContain("Do not create a route, dashboard, public query, or custom interface");
    expect(internalFunnel?.prompt_template).toContain("current verified onboarding receipt");
    expect(internalFunnel?.prompt_template).toContain("status=verified");
    expect(internalFunnel?.prompt_template).toContain("fresh onboarding proof");
    expect(internalFunnel?.prompt_template).toContain("Ready, Needs more data, or Needs instrumentation");
    expect(internalFunnel?.prompt_template).not.toContain("small fixed query batch");
    expect(internalFunnel?.prompt_template).not.toContain("Flatten analytics queries");
    expect(internalFunnel?.prompt_template).not.toContain("never from the browser");
    expect(internalFunnel?.uses).not.toContain("GET /v1/query-blueprints");
    expect(internalFunnel?.uses).not.toContain("POST /v1/projects/:project_id/analytics/query");
    expect(internalFunnel?.uses).not.toContain("POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run with params from signal-map milestones");
    expect(internalFunnel?.uses).not.toContain("(local protected internal/admin route)");
    const funnel = richJson.suggestions.find((entry) => entry.id === "review_signup_funnel");
    expect(funnel?.title).toBe("Review the primary funnel for drop-offs");
    expect(funnel?.uses).toContain("GET /v1/projects/:project_id/signal-map");
    expect(funnel?.uses).toContain("POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run with params from signal-map milestones");
    expect(funnel?.uses).toContain("GET /v1/projects/:project_id/event-names");
    const weekly = richJson.suggestions.find((entry) => entry.id === "weekly_review");
    expect(weekly?.prompt_template).toContain("Generate this week's review from the saved signal map");
    expect(weekly?.prompt_template).toContain("only when errors are in scope");
    const customInterface = richJson.suggestions.find((entry) => entry.id === "build_custom_interface");
    expect(customInterface?.title).toBe("Create a custom report or internal interface");
    expect(customInterface?.prompt_template).toContain("report, brief, automation plan, or internal interface");
    const customQuestion = richJson.suggestions.find((entry) => entry.id === "ask_custom_question");
	    expect(customQuestion?.prompt_template).toContain("prove the needed events/properties first");
    expect(customQuestion?.uses).not.toContain("POST /v1/projects/:project_id/public-queries");
    const autoFix = richJson.suggestions.find((entry) => entry.id === "auto_fix_on_error");
    expect(autoFix?.uses).toContain("GET /v1/automation-playbooks/error-to-draft-pr?version=2.0.0");
    expect(autoFix?.uses).not.toContain("GET /v1/automation-playbooks/error-to-draft-pr?version=1.0.0");
    expect(richJson.next_action).toContain("product question, report, interface, or automation");
    expect(richJson.next_action).toContain("Answer from the saved signal map and live reads before building UI");
    expect(richJson.next_action).toContain(INSTALL_COMPLETE_USER_HANDOFF);
    expect(richJson.next_action).not.toContain("every required real Agentry target");
  });

		  it("does not treat a legacy green verify report as verified onboarding", async () => {
		    const owner = await signup("next-steps-legacy-readiness@example.com");
		    posthogState.configured = true;
		    const project = await createProject(owner.apiKey, {
		      name: "legacy-readiness-project",
		    });
		    await saveSignalMap(project.id, ["errors", "analytics", "deploys"]);
		    await saveLegacyGreenVerifyReport(project.id);

		    const res = await call(`/v1/projects/${project.id}/next-steps`, {
		      headers: { authorization: `Bearer ${owner.apiKey}` },
		    });
		    expect(res.status).toBe(200);
		    const json = (await res.json()) as {
		      project_state: {
		        install_verified: boolean;
		        answer_ready: boolean;
		        readiness_complete: boolean;
		      };
		      suggestions: Array<{ id: string }>;
		      next_action: string;
		    };

		    expect(json.project_state).toMatchObject({
		      install_verified: false,
		      answer_ready: false,
		      readiness_complete: false,
		    });
		    expect(json.suggestions).toEqual([]);
		    expect(json.next_action).toContain("legacy verify reports");
		  });

});
