import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cases as caseTable } from "@agentry/db/schema";
import { uuidv7 } from "@agentrysh/shared";
import { renderSkillMarkdown } from "../src/adapters.js";
import {
  PUBLIC_AGENT_REFERENCE_URL,
  PUBLIC_INSTALL_DOC_URL,
  PUBLIC_PRIVACY_URL,
  PUBLIC_REPOSITORY_URL,
  PUBLIC_SKILL_URL,
} from "../src/public-links.js";
import {
  CUSTOMER_ANALYTICS_EXCLUDED_BOOLEAN_PROPERTIES,
  CUSTOMER_ANALYTICS_EXCLUDED_SOURCE_VALUES,
  CUSTOMER_ANALYTICS_HOGQL_FILTER,
} from "../src/customer-data.js";
import {
  getDbForUrl,
  getRawDbClientForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";
import {
  seedApprovedOnboardingPlan,
  seedVerifiedOnboardingReadiness,
} from "./onboarding-readiness-fixture.js";

// Mock the db module so every getDb() call inside the app returns the
// in-memory drizzle instance keyed by the env's URL. The factory is hoisted,
// so we must import getDbForUrl from within it.
vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

// Import after the mock so the app picks up the stubbed getDb.
const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  const method = init?.method ?? "GET";
  if (
    !headers.has("idempotency-key") &&
    ((method === "POST" && (
      path === "/v1/feedback" ||
      /^\/v1\/projects\/[^/]+\/(?:invites|alerts|public-queries)$/.test(path)
    )) || (method === "DELETE" && /^\/v1\/projects\/[^/]+\/public-queries\/[^/]+$/.test(path)))
  ) {
    headers.set("idempotency-key", `api-test-${crypto.randomUUID()}`);
  }
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`http://test${path}`, {
      method,
      headers,
      body,
    }),
    env,
  );
}

const OPENAPI_HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const OPENAPI_HTTP_METHOD_SET = new Set<string>(OPENAPI_HTTP_METHODS);
const OPENAPI_MUTATING_METHOD_SET = new Set<string>(["post", "put", "patch"]);

type OpenApiOperation = {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  tags?: unknown;
  security?: unknown;
  parameters?: unknown;
  requestBody?: {
    content?: Record<string, { schema?: unknown; examples?: unknown }>;
  };
  responses?: Record<string, unknown>;
  "x-agentry-request-body"?: unknown;
  "x-agentry-flow"?: unknown;
};
type OpenApiPathItem = Partial<
  Record<(typeof OPENAPI_HTTP_METHODS)[number], OpenApiOperation>
> & {
  parameters?: unknown;
};
type OpenApiDocument = {
  openapi: string;
  paths: Record<string, OpenApiPathItem>;
  components?: {
    parameters?: Record<string, unknown>;
    schemas?: Record<string, unknown>;
  };
  "x-agentry-flows"?: Record<string, unknown>;
};

function jsonRequestSchema(operation: OpenApiOperation | undefined):
  | {
      $ref?: unknown;
      oneOf?: unknown[];
      properties?: Record<string, unknown>;
      required?: string[];
    }
  | undefined {
  return operation?.requestBody?.content?.["application/json"]?.schema as
    | {
        $ref?: unknown;
        oneOf?: unknown[];
        properties?: Record<string, unknown>;
        required?: string[];
      }
    | undefined;
}

function jsonResponseSchema(
  operation: OpenApiOperation | undefined,
  status = "200",
):
  | {
      $ref?: unknown;
      properties?: Record<string, unknown>;
      required?: string[];
    }
  | undefined {
  const response = operation?.responses?.[status] as
    | { content?: Record<string, { schema?: unknown }> }
    | undefined;
  return response?.content?.["application/json"]?.schema as
    | {
        $ref?: unknown;
        properties?: Record<string, unknown>;
        required?: string[];
      }
    | undefined;
}

function normalizeDocumentedPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{}").replace(/\{[^}/]+\}/g, "{}");
}

function openApiRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizeDocumentedPath(path)}`;
}

function openApiOperations(schema: OpenApiDocument): Array<{
  path: string;
  method: string;
  pathItem: OpenApiPathItem;
  operation: OpenApiOperation;
}> {
  const entries: Array<{
    path: string;
    method: string;
    pathItem: OpenApiPathItem;
    operation: OpenApiOperation;
  }> = [];
  for (const [path, pathItem] of Object.entries(schema.paths)) {
    for (const method of OPENAPI_HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation) entries.push({ path, method, pathItem, operation });
    }
  }
  return entries;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
}

function resolveOpenApiParameter(
  schema: OpenApiDocument,
  parameter: Record<string, unknown>,
): Record<string, unknown> {
  const ref = parameter.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/components/parameters/")) {
    return parameter;
  }
  const name = ref.split("/").pop();
  const resolved = name ? schema.components?.parameters?.[name] : undefined;
  return resolved && typeof resolved === "object" && !Array.isArray(resolved)
    ? (resolved as Record<string, unknown>)
    : parameter;
}

async function signup(
  email: string,
): Promise<{ apiKey: string; userId: string }> {
  const res = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as {
    api_key: string;
    user_id: string;
  };
  expect(data).not.toHaveProperty("public_api_key");
  return { apiKey: data.api_key, userId: data.user_id };
}

function retiredPublicKey(): string {
  return `agp_retired-test-fixture-${uuidv7()}`;
}

async function createProject(
  apiKey: string,
  name: string,
): Promise<{ id: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: { name },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { id: string };
  return data;
}

function signalMapProvenance(
  approvedPlanHash = "test-approved-plan-hash",
  signal = "signup_completed",
) {
  return {
    discovery_map: {
      product_summary: "Test product.",
      product_category: "test",
      metric_lens: "activation and reliability",
      primary_outcome: "User completes the approved flow.",
      key_entities: ["user"],
      key_user_journeys: [
        "User starts",
        "User reaches value",
        "User completes",
      ],
    },
    planned_wiring_map: [
      {
        signal,
        kind:
          signal === "deploy.recorded"
            ? "deploy"
            : signal.includes("error") || signal.includes("failure")
              ? "error"
              : "event",
        target_files: ["src/example.ts"],
        target_surface: "src/example.ts",
        trigger: "approved test trigger",
        key_properties: [],
        notes: [],
      },
    ],
    approved_plan_hash: approvedPlanHash,
  };
}

describe("discovery", () => {
  it("GET / returns metadata json", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      name: string;
      repository: string;
      docs: string;
      install_docs: string;
      reference_docs: string;
      api_schema: string;
      onboarding: string;
      onboarding_flow: string;
      posthog_flow: string;
      onboarding_source_snapshot_helper: string;
      automation_docs: string;
      automation_flow: string;
      automation_playbooks: string;
      capabilities: string;
      setup_manifest: string;
      quick_start: Array<{ when: string; action: string; urls: string[] }>;
      mental_model: {
        write: Array<{ concept: string; endpoint: string; use_when: string }>;
        read: Array<{ concept: string; endpoint: string; use_when: string }>;
        helpers: string;
      };
      proof_contract: {
        install: string;
        answering: string;
      };
      signal_map: string;
      skill: string;
      next_action: string;
    };
    expect(json.name).toBe("Agentry");
    expect(json.repository).toBe(PUBLIC_REPOSITORY_URL);
    expect(json.docs).toBe(PUBLIC_AGENT_REFERENCE_URL);
    expect(json.install_docs).toBe(PUBLIC_INSTALL_DOC_URL);
    expect(json.reference_docs).toBe(PUBLIC_AGENT_REFERENCE_URL);
    expect(json.api_schema).toBe("/v1/openapi.json");
    expect(json.onboarding).toBe("/v1/projects/:project_id/onboarding");
    expect(json.onboarding_flow).toBe(
      "/v1/openapi.json?flow=onboarding",
    );
    expect(json.posthog_flow).toBe("/v1/openapi.json?flow=posthog");
    expect(json.onboarding_source_snapshot_helper).toBe(
      "/v1/onboarding/source-snapshot.mjs",
    );
    expect(json.automation_docs).toBe("/v1/docs/automation");
    expect(json.automation_flow).toBe(
      "/v1/openapi.json?flow=automation",
    );
    expect(json.automation_playbooks).toBe("/v1/automation-playbooks");
    expect(json.capabilities).toBe("/v1/capabilities");
    expect(json.setup_manifest).toBe("/v1/setup/manifest");
    expect(json.quick_start.map((step) => step.when)).toEqual([
      "installing",
      "day_to_day_use",
      "agentic_automation",
      "exact_payload_shape",
    ]);
    expect(json.quick_start[0]?.urls).toContain(PUBLIC_INSTALL_DOC_URL);
    expect(json.quick_start[0]?.urls).toContain(
      "/v1/openapi.json?flow=onboarding",
    );
    expect(json.quick_start[0]?.action).toContain(
      "important business question",
    );
    expect(json.quick_start[0]?.action).toContain("funnel/business logic flow");
    expect(json.quick_start[1]?.urls).toContain(
      "/v1/projects/:project_id/analytics/query",
    );
    expect(json.quick_start[1]?.urls).toContain(PUBLIC_AGENT_REFERENCE_URL);
    expect(json.quick_start[1]?.urls).toContain(
      "/v1/openapi.json?flow=posthog",
    );
    expect(json.quick_start[1]?.urls).toContain(
      "/v1/projects/:project_id/signal-map",
    );
    expect(json.quick_start[1]?.urls).toContain(
      "/v1/projects/:project_id/onboarding",
    );
    expect(json.quick_start[1]?.urls).not.toContain(
      "/v1/projects/:project_id/answer-contracts",
    );
    expect(json.quick_start[1]?.urls).toContain(
      "/v1/projects/:project_id/event-names",
    );
    expect(json.quick_start[1]?.urls).toContain(
      "/v1/projects/:project_id/event-property-keys",
    );
    expect(json.quick_start[1]?.action).toContain("saved signal map");
    expect(json.quick_start[1]?.action).toContain(
      "source_verified receipt",
    );
    expect(json.quick_start[1]?.action).toContain("customer PostHog");
    expect(json.quick_start[2]?.urls).toContain("/v1/docs/automation");
    expect(json.quick_start[2]?.urls).toContain(
      "/v1/openapi.json?flow=automation",
    );
    expect(json.quick_start[2]?.urls).toContain("/v1/automation-playbooks");
    expect(json.quick_start[2]?.action).toContain("disabled playbook candidate");
    expect(json.quick_start[3]?.urls).toContain(
      "/v1/openapi.json?flow=onboarding",
    );
    expect(json.next_action).toContain("Choose one quick_start entry");
    expect(json.next_action).toContain("Installing starts at install_docs");
    expect(json.next_action).toContain(
      "automation starts at /v1/docs/automation",
    );
    expect(json.next_action.length).toBeLessThan(450);
    expect(json.next_action).not.toContain("mkdir -p ~/.claude/skills/agentry");
    expect(json.skill).toBe(PUBLIC_SKILL_URL);
    const deployWrite = json.mental_model.write.find(
      (entry) => entry.concept === "deploys",
    );
    expect(deployWrite?.endpoint).toBe("POST /v1/deploys/");
    expect(deployWrite?.use_when).toContain("CI/provider post-deploy");
    expect(deployWrite?.use_when).toContain("successful deploy");
    const analyticsRead = json.mental_model.read.find(
      (entry) => entry.concept === "analytics",
    );
    expect(analyticsRead?.endpoint).toBe(
      "POST /v1/projects/:project_id/analytics/query",
    );
    expect(analyticsRead?.use_when).toContain("signal map");
    expect(analyticsRead?.use_when).toContain("source_verified");
    expect(analyticsRead?.use_when).toContain("custom HogQL");
    const resourceRead = json.mental_model.read.find(
      (entry) => entry.concept === "posthog_resources",
    );
    expect(resourceRead?.use_when).toContain("current provider");
    expect(resourceRead?.use_when).toContain("flow=posthog");
    expect(json.mental_model.helpers).toContain("signal map");
    expect(json.mental_model.helpers).toContain("source-verification receipt");
    expect(json.proof_contract.install).toContain("state.next_action");
    expect(json.proof_contract.install).toContain("one real proof session");
    expect(json.proof_contract.install).toContain("installation_complete=true");
    expect(json.proof_contract.answering).toContain("source_verified");
    expect(json.proof_contract.answering).toContain("customer PostHog");
    expect(json.proof_contract.answering).toContain("missing event/property");
    expect(json.signal_map).toBe("/v1/projects/:project_id/signal-map");
    expect(json.api_schema).toBe("/v1/openapi.json");
    expect(json.skill).toBe(PUBLIC_SKILL_URL);
  });

  it("GET /v1/openapi.json exposes endpoint request and response schemas", async () => {
    const res = await call("/v1/openapi.json");
    expect(res.status).toBe(200);
    const schema = (await res.json()) as OpenApiDocument & {
      components: {
        schemas: Record<string, unknown>;
        securitySchemes: Record<string, unknown>;
      };
    };
    expect(schema.openapi).toBe("3.1.0");
    expect(schema.paths["/v1/deploys/"]?.post).toBeTruthy();
    expect(schema.paths["/v1/analytics/"]).toBeUndefined();
    expect(schema.paths["/v1/logs/"]).toBeUndefined();
    expect(schema.paths["/v1/projects/{project_id}/analytics/query"]?.post).toBeTruthy();
    expect(schema.paths["/v1/onboarding/source-snapshot.mjs"]?.get).toBeTruthy();
    expect(schema.paths["/v1/install/sdk/{language}"]?.get).toBeUndefined();
    expect(schema.paths["/v1/logs"]?.post).toBeUndefined();
    expect(schema.paths["/v1/analytics"]?.post).toBeUndefined();
    expect(schema.paths["/v1/deploys"]?.post).toBeUndefined();
    expect(schema.paths["/v1/store/{project_id}"]?.post).toBeUndefined();
    const setupManifestOperation = schema.paths["/v1/setup/manifest"]?.get as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: {
                    properties?: Record<
                      string,
                      { description?: string } | unknown
                    >;
                    required?: string[];
                  };
                }
              >;
            }
          >;
        }
      | undefined;
    const setupManifestSchema =
      setupManifestOperation?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(setupManifestSchema?.properties?.credential_boundaries).toBeTruthy();
    expect(setupManifestSchema?.properties?.posthog_telemetry_boundary).toBeTruthy();
    expect(setupManifestSchema?.required).toEqual(
      expect.arrayContaining([
        "credential_boundaries",
        "posthog_telemetry_boundary",
      ]),
    );
    expect(setupManifestSchema?.properties?.local_state).toBeTruthy();
    expect(setupManifestSchema?.properties?.content).toBeUndefined();
    expect(
      schema.paths["/api/projects/{project_id}/error_tracking/symbol_sets/bulk_start_upload/"],
    ).toBeUndefined();
    expect(schema.paths["/v1/sourcemaps/{project_id}/blob/"]).toBeUndefined();
    expect(schema.paths["/v1/projects/{project_id}/posthog/provision"]).toBeUndefined();
    expect(schema.paths["/v1/projects/{project_id}/posthog/provisioning"]).toBeUndefined();
    expect(schema.paths["/v1/integrations/posthog/oauth/client"]?.get).toBeTruthy();
    expect(schema.paths["/v1/integrations/posthog/oauth/callback"]?.get).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/posthog-connection"]?.get).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/posthog-connection"]?.post).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/posthog-connection"]?.delete).toBeTruthy();
    expect(schema.paths["/v1/auth/_test/login"]?.post).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/analytics/query"]?.post
        ?.description,
    ).toContain("at least 45 seconds");
    const loginResponseSchema = schema.components.schemas.PosthogAuthSuccessResponse as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(loginResponseSchema?.properties?.api_key).toBeTruthy();
    expect(loginResponseSchema?.properties?.public_api_key).toBeUndefined();
    const projectDetailSchema = schema.components.schemas.ProjectDetail as
      | {
          properties?: Record<
            string,
            {
              type?: string;
              properties?: Record<string, unknown>;
              required?: string[];
            }
          >;
          required?: string[];
        }
      | undefined;
    expect(projectDetailSchema?.properties?.dsn).toBeUndefined();
    expect(projectDetailSchema?.properties?.public_key).toBeUndefined();
    expect(projectDetailSchema?.required).toContain("next_action");
    const analyticsQueryOperation = schema.paths[
      "/v1/projects/{project_id}/analytics/query"
    ]?.post as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: {
                    properties?: Record<string, unknown>;
                    required?: string[];
                  };
                  examples?: Record<
                    string,
                    { value?: Record<string, unknown> }
                  >;
                }
              >;
            }
          >;
        }
      | undefined;
    const analyticsQueryMedia =
      analyticsQueryOperation?.responses?.["200"]?.content?.[
        "application/json"
      ];
    const analyticsQueryResponse = analyticsQueryMedia?.schema;
    const analyticsQueryExample = analyticsQueryMedia?.examples?.default?.value;
    const analyticsRowsSchema = analyticsQueryResponse?.properties?.rows as
      | { description?: string }
      | undefined;
    expect(analyticsQueryResponse?.properties?.rows).toBeTruthy();
    expect(analyticsRowsSchema?.description).toContain("response.rows");
    expect(analyticsRowsSchema?.description).toContain(
      "response.results is intentionally absent",
    );
    expect(analyticsQueryResponse?.properties?.results).toBeUndefined();
    expect(analyticsQueryResponse?.properties?.row_count).toBeTruthy();
    expect(analyticsQueryResponse?.properties?.freshness).toBeTruthy();
    expect(analyticsQueryExample?.rows).toEqual([
      { event: "signup_completed", users: 42 },
    ]);
    expect(analyticsQueryExample?.results).toBeUndefined();
    expect(analyticsQueryExample?.next_action).toContain("response.rows");
    expect(analyticsQueryExample?.next_action).toContain(
      "response.results is intentionally absent",
    );
    expect(analyticsQueryExample?.freshness).toEqual(
      expect.objectContaining({
        source: "posthog_hogql",
        consistency: "eventual",
        cache_bust: true,
        retry_after_ms: 30000,
      }),
    );
    const publicQueryOperation = schema.paths["/v1/public/q/{publication_id}"]
      ?.get as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: {
                    properties?: Record<string, unknown>;
                    required?: string[];
                  };
                  examples?: Record<
                    string,
                    { value?: Record<string, unknown> }
                  >;
                }
              >;
            }
          >;
        }
      | undefined;
    const publicQueryMedia =
      publicQueryOperation?.responses?.["200"]?.content?.["application/json"];
    const publicQueryExample = publicQueryMedia?.examples?.default?.value;
    expect(publicQueryMedia?.schema?.properties?.rows).toBeTruthy();
    expect(publicQueryMedia?.schema?.properties?.results).toBeUndefined();
    expect(publicQueryMedia?.schema?.properties?.freshness).toBeTruthy();
    expect(publicQueryExample?.rows).toEqual([{ day: "2026-06-14", dau: 42 }]);
    expect(publicQueryExample?.results).toBeUndefined();
    expect(publicQueryExample?.freshness).toEqual(
      expect.objectContaining({
        source: "posthog_hogql",
        consistency: "eventual",
        cache_bust: true,
        retry_after_ms: 30000,
      }),
    );
    expect(
      schema.paths["/v1/projects/{project_id}/event-names"]?.get,
    ).toBeTruthy();
    const eventNamesOperation = schema.paths[
      "/v1/projects/{project_id}/event-names"
    ]?.get as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: { properties?: Record<string, unknown> };
                }
              >;
            }
          >;
        }
      | undefined;
    const eventNamesSchema =
      eventNamesOperation?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(eventNamesSchema?.properties?.server_emitted).toBeTruthy();
    expect(eventNamesSchema?.properties?.analytics_events).toBeTruthy();
    expect(eventNamesSchema?.properties?.analytics_read).toBeTruthy();
    expect(eventNamesSchema?.properties?.wildcards).toBeTruthy();
    expect(eventNamesSchema?.properties?.events).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/event-property-keys"]?.get,
    ).toBeTruthy();
    const propertyKeysOperation = schema.paths[
      "/v1/projects/{project_id}/event-property-keys"
    ]?.get as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: { properties?: Record<string, unknown> };
                }
              >;
            }
          >;
        }
      | undefined;
    const propertyKeysSchema =
      propertyKeysOperation?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(propertyKeysSchema?.properties?.keys).toBeTruthy();
    expect(propertyKeysSchema?.properties?.analytics_read).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/setup"]?.get).toBeTruthy();
    const projectSetupOperation = schema.paths[
      "/v1/projects/{project_id}/setup"
    ]?.get as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: {
                    properties?: Record<string, unknown>;
                    required?: string[];
                  };
                }
              >;
            }
          >;
        }
      | undefined;
    const projectSetupSchema =
      projectSetupOperation?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(projectSetupSchema?.properties?.env_matrix).toBeTruthy();
    expect(projectSetupSchema?.properties?.posthog_connection).toBeTruthy();
    expect(projectSetupSchema?.required).toEqual(
      expect.arrayContaining([
        "posthog_connection",
        "env_matrix",
      ]),
    );
    expect(projectSetupSchema?.properties?.project_binding).toBeUndefined();
    expect(projectSetupSchema?.properties?.content).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/answer-contracts"]?.get,
    ).toBeUndefined();
    expect(schema.paths["/v1/query-blueprints"]?.get).toBeTruthy();
    expect(
      schema.paths["/v1/query-blueprints/{blueprint_id}"]?.get,
    ).toBeTruthy();
    expect(
      schema.paths[
        "/v1/projects/{project_id}/query-blueprints/{blueprint_id}/run"
      ]?.post,
    ).toBeTruthy();
    const blueprintRunOperation = schema.paths[
      "/v1/projects/{project_id}/query-blueprints/{blueprint_id}/run"
    ]?.post as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                {
                  schema?: { properties?: Record<string, unknown> };
                  examples?: Record<
                    string,
                    { value?: Record<string, unknown> }
                  >;
                }
              >;
            }
          >;
        }
      | undefined;
    const blueprintRunMedia =
      blueprintRunOperation?.responses?.["200"]?.content?.["application/json"];
    expect(blueprintRunMedia?.schema?.properties?.row_count).toBeTruthy();
    expect(blueprintRunMedia?.schema?.properties?.freshness).toBeTruthy();
    expect(blueprintRunMedia?.examples?.default?.value?.row_count).toBe(1);
    expect(blueprintRunMedia?.examples?.default?.value?.freshness).toEqual(
      expect.objectContaining({
        source: "posthog_hogql",
        retry_after_ms: 30000,
      }),
    );
    expect(
      schema.paths["/v1/projects/{project_id}/recipes/required-events"],
    ).toBeUndefined();
    expect(schema.paths["/v1/recipes/required-events"]).toBeUndefined();
    for (const resourcePath of [
      "/v1/projects/{project_id}/session-recordings",
      "/v1/projects/{project_id}/session-recordings/{recording_id}",
      "/v1/projects/{project_id}/feature-flags",
      "/v1/projects/{project_id}/feature-flags/{flag_id}",
      "/v1/projects/{project_id}/surveys",
      "/v1/projects/{project_id}/surveys/{survey_id}",
      "/v1/projects/{project_id}/surveys/{survey_id}/responses",
      "/v1/projects/{project_id}/surveys/{survey_id}/stats",
      "/v1/projects/{project_id}/experiments",
      "/v1/projects/{project_id}/experiments/{experiment_id}",
    ]) {
      expect(schema.paths[resourcePath]?.get, resourcePath).toBeTruthy();
    }
    expect(
      schema.paths["/v1/projects/{project_id}/experiments/{experiment_id}/results"],
    ).toBeUndefined();
    expect(schema.paths["/v1/install/plan"]).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/signal-map"]?.put,
    ).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/implementation-report"],
    ).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/install/verify"],
    ).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/onboarding"]?.get,
    ).toBeTruthy();
    expect(
      schema.paths["/v1/projects/{project_id}/onboarding"]?.post,
    ).toBeTruthy();
    expect(
      schema.paths[
        "/v1/projects/{project_id}/onboarding/verify"
      ]?.post,
    ).toBeTruthy();
    expect(schema.paths["/v1/onboarding/source-snapshot.mjs"]?.get).toBeTruthy();
    expect(schema.paths["/v1/me"]?.get).toBeTruthy();
    expect(schema.paths["/v1/recipes"]).toBeUndefined();
    expect(schema.paths["/v1/recipes/{id}"]).toBeUndefined();
    expect(schema.paths["/admin/users/{user_id}/plan"]?.patch).toBeTruthy();
    const createProjectMedia =
      schema.paths["/v1/projects"]?.post?.requestBody?.content?.[
        "application/json"
      ];
    expect(createProjectMedia?.examples).toBeTruthy();
    const createProjectOperation = schema.paths["/v1/projects"]?.post as
      | {
          responses?: Record<
            string,
            {
              content?: Record<
                string,
                { examples?: Record<string, { value?: unknown }> }
              >;
            }
          >;
        }
      | undefined;
    const defaultErrorExample = JSON.stringify(
      createProjectOperation?.responses?.default?.content?.["application/json"]
        ?.examples?.default?.value,
    );
    expect(defaultErrorExample).not.toContain("HogQL");
    expect(defaultErrorExample).not.toContain("analytics/query");
    expect(schema.paths["/v1/projects/{project_id}/public-key"]).toBeUndefined();
    expect(schema.paths["/v1/projects/{project_id}/dsn"]).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/public-key/verify"],
    ).toBeUndefined();
    expect(
      schema.paths["/v1/projects/{project_id}/public-key/rotate"],
    ).toBeUndefined();
    const projectDeleteDescription =
      schema.paths["/v1/projects/{project_id}"]?.delete?.description;
    expect(projectDeleteDescription).toContain("Durable owner-only deletion");
    expect(projectDeleteDescription).toContain("stable Idempotency-Key");
    expect(projectDeleteDescription).toContain("bounded 202 progress");
    expect(schema["x-agentry-flows"]?.onboarding).toBeTruthy();
    expect(schema["x-agentry-flows"]?.install).toBeUndefined();
    expect(schema["x-agentry-flows"]?.webhooks).toBeTruthy();
    expect(schema.components.schemas.AnalyticsIngestRequest).toBeUndefined();
    expect(schema.components.schemas.LogIngestRequest).toBeUndefined();
    expect(schema.components.schemas.DeployIngestRequest).toBeTruthy();
    for (const retiredRequestComponent of [
      "InstallPlanRequest",
      "SaveSignalMapRequest",
      "ImplementationReportRequest",
      "VerifyInstallRequest",
    ]) {
      expect(schema.components.schemas[retiredRequestComponent]).toBeUndefined();
    }
    expect(schema.components.schemas.InstallPlanResponse).toBeUndefined();
    expect(schema.components.schemas.ImplementationReport).toBeUndefined();
    const onboardingMedia = schema.paths["/v1/projects/{project_id}/onboarding"]
      ?.post?.requestBody?.content?.["application/json"] as
      | { schema?: { $ref?: string }; examples?: unknown }
      | undefined;
    expect(onboardingMedia?.schema?.$ref).toBe(
      "#/components/schemas/OnboardingV3StartRequest",
    );
    expect(onboardingMedia?.examples).toBeUndefined();
    expect(schema.paths["/v1/deploys/"]?.post?.description).toContain(
      "Do not call this from app startup",
    );
    expect(schema.paths["/v1/deploys/"]?.post?.description).toContain(
      "instrumentation/register/bootstrap hooks",
    );
    expect(schema.components.securitySchemes.ApiKeyAuth).toBeTruthy();
    expect(schema.components.securitySchemes.PublicIngestAuth).toBeUndefined();
    expect(schema.components.securitySchemes.ServerIngestAuth).toBeUndefined();
    expect(schema.components.securitySchemes.DsnAuth).toBeUndefined();
    expect(
      schema.paths["/api/projects/{project_id}/error_tracking/symbol_sets/bulk_start_upload/"],
    ).toBeUndefined();

    expect(schema.paths["/v1/schema"]?.get).toBeUndefined();
  });

  it("GET /v1/openapi.json supports filtered schema lookups", async () => {
    const flowRes = await call("/v1/openapi.json?flow=onboarding");
    expect(flowRes.status).toBe(200);
    const flow = (await flowRes.json()) as {
      flow: string;
      definition: {
        id?: string;
        operation_count?: number;
        support_operation_count?: number;
        statuses?: string[];
        operations?: Array<{ method: string; path: string }>;
      };
      count: number;
      paths: OpenApiDocument["paths"];
      missing_operations: unknown[];
    };
    expect(flow.flow).toBe("onboarding");
    expect(flow.definition.id).toBe("onboarding_v3");
    expect(flow.definition.operation_count).toBe(5);
    expect(flow.definition.support_operation_count).toBe(1);
    expect(flow.definition.statuses).toEqual([
      "planned",
      "approved",
      "proving",
      "verified",
    ]);
    expect(flow.count).toBe(6);
    expect(flow.missing_operations).toEqual([]);
    expect(flow.paths["/v1/projects/{project_id}/onboarding"]?.get).toBeTruthy();
    expect(flow.paths["/v1/projects/{project_id}/onboarding"]?.post).toBeTruthy();
    expect(
      flow.paths[
        "/v1/projects/{project_id}/onboarding/review"
      ]?.post,
    ).toBeTruthy();
    expect(
      flow.paths[
        "/v1/projects/{project_id}/onboarding/proof"
      ]?.post,
    ).toBeTruthy();
    expect(
      flow.paths[
        "/v1/projects/{project_id}/onboarding/verify"
      ]?.post,
    ).toBeTruthy();
    expect(flow.paths["/v1/onboarding/source-snapshot.mjs"]?.get).toBeTruthy();
    expect(flow.paths["/v1/install/plan"]).toBeUndefined();

    const tagRes = await call(
      "/v1/openapi.json?tag=Onboarding&include_components=false",
    );
    expect(tagRes.status).toBe(200);
    const tag = (await tagRes.json()) as {
      tag: string;
      count: number;
      paths: OpenApiDocument["paths"];
      components?: unknown;
    };
    expect(tag.tag).toBe("Onboarding");
    expect(tag.count).toBe(5);
    expect(
      tag.paths[
        "/v1/projects/{project_id}/onboarding/verify"
      ]?.post,
    ).toBeTruthy();
    expect(tag.components).toBeUndefined();
    const tagStartRequestSchema = jsonRequestSchema(
      tag.paths["/v1/projects/{project_id}/onboarding"]?.post,
    );
    expect(tagStartRequestSchema?.$ref).toBeUndefined();
    expect(tagStartRequestSchema?.properties).toEqual(
      expect.objectContaining({ intent: expect.any(Object), plan: expect.any(Object) }),
    );

    const operationPath = encodeURIComponent(
      "/v1/projects/{project_id}/onboarding",
    );
    const opRes = await call(
      `/v1/openapi.json?path=${operationPath}&method=post`,
    );
    expect(opRes.status).toBe(200);
    const op = (await opRes.json()) as {
      path: string;
      method: string;
      operation: OpenApiOperation;
      paths?: OpenApiDocument["paths"];
      components?: unknown;
    };
    expect(op.path).toBe("/v1/projects/{project_id}/onboarding");
    expect(op.method).toBe("post");
    expect(op.operation.requestBody).toBeTruthy();
    expect(
      op.paths?.["/v1/projects/{project_id}/onboarding"]?.post?.requestBody,
    ).toBeTruthy();
    const opStartRequestSchema = jsonRequestSchema(op.operation);
    expect(opStartRequestSchema?.$ref).toBe(
      "#/components/schemas/OnboardingV3StartRequest",
    );
    expect(op.components).toBeTruthy();
    const onboardingSchemas = (
      op.components as {
        schemas: Record<string, {
          oneOf?: unknown[];
          properties?: Record<string, unknown>;
        }>;
      }
    ).schemas;
    expect(
      onboardingSchemas.OnboardingV3StartRequest?.properties,
    ).toEqual(expect.objectContaining({ intent: expect.any(Object), plan: expect.any(Object) }));
    expect(onboardingSchemas.OnboardingV3State).toBeTruthy();
    expect(onboardingSchemas.OnboardingV3LocalPointer).toBeUndefined();

    const installPlanPath = encodeURIComponent("/v1/install/plan");
    const installPlanOpRes = await call(
      `/v1/openapi.json?path=${installPlanPath}&method=post`,
    );
    expect(installPlanOpRes.status).toBe(404);

    const pathOnlyRes = await call(`/v1/openapi.json?path=${operationPath}`);
    expect(pathOnlyRes.status).toBe(200);
    const pathOnly = (await pathOnlyRes.json()) as {
      path: string;
      method?: string;
      operation?: OpenApiOperation;
      operations?: OpenApiDocument["paths"][string];
      available_methods?: string[];
    };
    expect(pathOnly.path).toBe("/v1/projects/{project_id}/onboarding");
    expect(pathOnly.method).toBeUndefined();
    expect(pathOnly.operation).toBeUndefined();
    expect(pathOnly.operations?.get).toBeTruthy();
    expect(pathOnly.operations?.post).toBeTruthy();
    expect(pathOnly.available_methods).toEqual(["get", "post"]);

    const alertEvaluatePath = encodeURIComponent(
      "/v1/projects/{project_id}/alerts/{id}/evaluate",
    );
    const alertEvaluateRes = await call(
      `/v1/openapi.json?path=${alertEvaluatePath}&method=post`,
    );
    expect(alertEvaluateRes.status).toBe(200);
    const alertEvaluateOp = (await alertEvaluateRes.json()) as {
      operation: OpenApiOperation;
    };
    const alertEvaluateResponse = jsonResponseSchema(alertEvaluateOp.operation);
    expect(alertEvaluateResponse?.properties?.transition_event).toBeTruthy();
    expect(alertEvaluateResponse?.properties?.rows_count).toBeTruthy();
    expect(alertEvaluateResponse?.properties?.fired).toBeUndefined();

    const connectionPath = encodeURIComponent(
      "/v1/projects/{project_id}/posthog-connection",
    );
    const connectionRes = await call(
      `/v1/openapi.json?path=${connectionPath}&method=get`,
    );
    expect(connectionRes.status).toBe(200);
    const connectionOp = (await connectionRes.json()) as {
      operation: OpenApiOperation;
    };
    const connectionResponse = jsonResponseSchema(connectionOp.operation);
    expect(connectionResponse?.properties?.connection).toBeTruthy();

    const flagPath = encodeURIComponent(
      "/v1/projects/{project_id}/feature-flags",
    );
    const flagRes = await call(
      `/v1/openapi.json?path=${flagPath}&method=get`,
    );
    expect(flagRes.status).toBe(200);
    const flagOp = (await flagRes.json()) as {
      operation: OpenApiOperation;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(flagOp.operation.operationId).toBe("list_posthog_feature_flags");
    expect(jsonResponseSchema(flagOp.operation)?.$ref).toBe(
      "#/components/schemas/PosthogFeatureFlagListResponse",
    );
    expect(flagOp.components?.schemas?.PosthogResourceFreshness).toBeTruthy();
    expect(flagOp.components?.schemas?.PosthogResourceDataBoundary).toBeTruthy();
    expect(flagOp.components?.schemas?.PosthogResourcePage).toBeTruthy();
    expect(flagOp.components?.schemas?.PosthogFeatureFlag).toBeTruthy();

    for (const retiredPath of [
      "/v1/projects/{project_id}/session-replays",
      "/v1/projects/{project_id}/cohorts/{cohort_id}",
      "/v1/projects/{project_id}/ab-tests",
    ]) {
      const retiredResponse = await call(
        `/v1/openapi.json?path=${encodeURIComponent(retiredPath)}&method=get`,
      );
      expect(retiredResponse.status, retiredPath).toBe(404);
    }

    const colonPath = encodeURIComponent(
      "/v1/projects/:project_id/onboarding/verify",
    );
    const colonPathRes = await call(
      `/v1/openapi.json?path=${colonPath}&method=post`,
    );
    expect(colonPathRes.status).toBe(200);
    const colonPathOp = (await colonPathRes.json()) as {
      path: string;
      method: string;
    };
    expect(colonPathOp.path).toBe(
      "/v1/projects/{project_id}/onboarding/verify",
    );
    expect(colonPathOp.method).toBe("post");

    const concretePath = encodeURIComponent(
      "/v1/projects/project_id/signal-map",
    );
    const concretePathRes = await call(
      `/v1/openapi.json?path=${concretePath}&method=get`,
    );
    expect(concretePathRes.status).toBe(200);
    const concretePathOp = (await concretePathRes.json()) as {
      path: string;
      method: string;
    };
    expect(concretePathOp.path).toBe("/v1/projects/{project_id}/signal-map");
    expect(concretePathOp.method).toBe("get");

    const signalMapPath = encodeURIComponent(
      "/v1/projects/{project_id}/signal-map",
    );
    const signalMapOpRes = await call(
      `/v1/openapi.json?path=${signalMapPath}&method=get`,
    );
    expect(signalMapOpRes.status).toBe(200);
    const signalMapOp = (await signalMapOpRes.json()) as {
      components?: unknown;
    };
    const signalMapSchemas = (
      signalMapOp.components as {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      }
    ).schemas;
    const returnedSignalMapProperties =
      signalMapSchemas.SignalMap?.properties ?? {};
    expect(Object.keys(returnedSignalMapProperties)).toEqual([
      "project_id",
      "contract_version",
      "mode",
      "plan_sha256",
      "business_question",
      "plan_markdown",
      "source_snapshot",
      "historical_evidence",
      "evidence_status",
      "milestones",
      "failures",
      "deploy",
      "receipt",
    ]);
    expect(returnedSignalMapProperties.approved_events).toBeUndefined();
    expect(returnedSignalMapProperties.approved_event_properties).toBeUndefined();
    expect(returnedSignalMapProperties.funnel_transitions).toBeUndefined();
    expect(returnedSignalMapProperties.failure_targets).toBeUndefined();
    expect(returnedSignalMapProperties.deploy_target).toBeUndefined();
    expect(returnedSignalMapProperties.required_events).toBeUndefined();
    expect(
      returnedSignalMapProperties.required_event_properties,
    ).toBeUndefined();

    expect(signalMapSchemas.VerifyInstallResponse).toBeUndefined();
    expect(signalMapSchemas.AnswerContractsResponse).toBeUndefined();
    expect(returnedSignalMapProperties.implementation_report_template).toBeUndefined();
    expect(returnedSignalMapProperties.verify_request_template).toBeUndefined();
    expect(returnedSignalMapProperties.answer_contracts).toBeUndefined();
    expect(returnedSignalMapProperties.questions_to_answer).toBeUndefined();
    expect(returnedSignalMapProperties.post_setup_blueprint).toBeUndefined();
    expect(returnedSignalMapProperties.question_handoff).toBeUndefined();
    expect(returnedSignalMapProperties.happy_path_funnel).toBeUndefined();
    expect(returnedSignalMapProperties.failure_surface_map).toBeUndefined();
    expect(returnedSignalMapProperties.planned_wiring_map).toBeUndefined();

    const multiMethodRes = await call(`/v1/openapi.json?path=${signalMapPath}`);
    expect(multiMethodRes.status).toBe(200);
    const multiMethod = (await multiMethodRes.json()) as {
      operation?: OpenApiOperation;
      operations?: OpenApiDocument["paths"][string];
      available_methods?: string[];
    };
    expect(multiMethod.operation).toBeTruthy();
    expect(multiMethod.operations?.get).toBeTruthy();
    expect(multiMethod.operations?.put).toBeUndefined();
    expect(multiMethod.available_methods).toEqual(["get"]);

    const nextStepsPath = encodeURIComponent(
      "/v1/projects/{project_id}/next-steps",
    );
    const nextStepsSchemaRes = await call(
      `/v1/openapi.json?path=${nextStepsPath}&method=get`,
    );
    expect(nextStepsSchemaRes.status).toBe(200);
    const nextStepsSchemaJson = (await nextStepsSchemaRes.json()) as {
      operation?: OpenApiOperation;
    };
    const nextSteps200 = nextStepsSchemaJson.operation?.responses?.["200"] as
      | { content?: Record<string, { schema?: unknown }> }
      | undefined;
    const nextStepsResponseSchema = nextSteps200?.content?.["application/json"]
      ?.schema as { properties?: Record<string, unknown> } | undefined;
    const suggestionsSchema = nextStepsResponseSchema?.properties
      ?.suggestions as
      | { items?: { properties?: Record<string, unknown> } }
      | undefined;
    expect(suggestionsSchema?.items?.properties?.prompt_template).toBeTruthy();
    expect(suggestionsSchema?.items?.properties?.uses).toBeTruthy();
    expect(suggestionsSchema?.items?.properties?.requires).toBeTruthy();

    const analyticsQueryPath = encodeURIComponent(
      "/v1/projects/{project_id}/analytics/query",
    );
    const analyticsQuerySchemaRes = await call(
      `/v1/openapi.json?path=${analyticsQueryPath}&method=post`,
    );
    expect(analyticsQuerySchemaRes.status).toBe(200);
    const analyticsQuerySchemaJson = (await analyticsQuerySchemaRes.json()) as {
      operation?: OpenApiOperation;
    };
    expect(analyticsQuerySchemaJson.operation?.description).toContain(
      "owner or member agent",
    );
    expect(analyticsQuerySchemaJson.operation?.description).toContain(
      "read-only PostHog Cloud OAuth",
    );
    expect(analyticsQuerySchemaJson.operation?.description).toContain(
      "CI and runner credentials cannot call",
    );
    const analyticsQueryRequestJson =
      analyticsQuerySchemaJson.operation?.requestBody?.content?.[
        "application/json"
      ];
    const analyticsQueryRequestSchema = analyticsQueryRequestJson?.schema as
      | {
          properties?: Record<string, { type?: unknown; description?: unknown }>;
          required?: string[];
        }
      | undefined;
    const hogqlExample =
      (
        analyticsQueryRequestJson?.examples as
          | Record<string, { value?: { query?: string; include_synthetic?: boolean } }>
          | undefined
      )?.default?.value?.query ?? "";
    expect(analyticsQueryRequestSchema?.required).toContain("query");
    expect(analyticsQueryRequestSchema?.properties?.include_synthetic).toEqual(
      expect.objectContaining({ type: "boolean" }),
    );
    expect(
      analyticsQueryRequestSchema?.properties?.include_synthetic?.description,
    ).toContain("explicit onboarding proof");
    expect(
      analyticsQueryRequestSchema?.properties?.include_synthetic?.description,
    ).not.toContain("ingest");
    expect(hogqlExample).toContain("FROM events WHERE event IN");
    expect(hogqlExample).not.toContain(CUSTOMER_ANALYTICS_HOGQL_FILTER);
    const analyticsQuery200 = analyticsQuerySchemaJson.operation?.responses?.[
      "200"
    ] as { content?: Record<string, { schema?: unknown }> } | undefined;
    const analyticsQueryResponseSchema = analyticsQuery200?.content?.[
      "application/json"
    ]?.schema as { properties?: Record<string, unknown> } | undefined;
    const analyticsQueryFilterSchema = analyticsQueryResponseSchema?.properties
      ?.customer_data_filter as
      | { properties?: Record<string, { type?: unknown }>; required?: string[] }
      | undefined;
    expect(analyticsQueryFilterSchema?.required).toEqual(
      expect.arrayContaining(["applied", "include_synthetic", "mode", "hogql_where"]),
    );
    expect(analyticsQueryFilterSchema?.properties?.applied).toEqual(
      expect.objectContaining({ type: "boolean" }),
    );
    expect(analyticsQueryFilterSchema?.properties?.include_synthetic).toEqual(
      expect.objectContaining({ type: "boolean" }),
    );
    expect(CUSTOMER_ANALYTICS_HOGQL_FILTER).toContain(
      "agentry_rehearsal_event",
    );
    expect(CUSTOMER_ANALYTICS_HOGQL_FILTER).toContain("event_source");
    expect(CUSTOMER_ANALYTICS_HOGQL_FILTER).toContain(
      "agentry_onboarding_proof",
    );
    expect(CUSTOMER_ANALYTICS_EXCLUDED_BOOLEAN_PROPERTIES).toContain(
      "agentry_test_event",
    );
    expect(CUSTOMER_ANALYTICS_EXCLUDED_SOURCE_VALUES).toContain(
      "direct_rehearsal_ingest",
    );

    const dailyUseFlowRes = await call("/v1/openapi.json?flow=daily-use");
    expect(dailyUseFlowRes.status).toBe(200);
    const dailyUseFlow = (await dailyUseFlowRes.json()) as {
      paths?: Record<string, unknown>;
    };
    expect(
      dailyUseFlow.paths?.["/v1/projects/{project_id}/signal-map"],
    ).toBeTruthy();
    expect(
      dailyUseFlow.paths?.["/v1/projects/{project_id}/answer-contracts"],
    ).toBeUndefined();
    expect(
      dailyUseFlow.paths?.["/v1/projects/{project_id}/analytics/query"],
    ).toBeTruthy();
    expect(
      dailyUseFlow.paths?.["/v1/projects/{project_id}/session-recordings"],
    ).toBeTruthy();
    expect(
      dailyUseFlow.paths?.["/v1/projects/{project_id}/surveys/{survey_id}/stats"],
    ).toBeTruthy();

    const resourceFlowRes = await call(
      "/v1/openapi.json?flow=posthog",
    );
    expect(resourceFlowRes.status).toBe(200);
    const resourceFlow = (await resourceFlowRes.json()) as {
      count?: number;
      paths?: Record<string, OpenApiPathItem>;
      missing_operations?: unknown[];
      components?: { schemas?: Record<string, unknown> };
    };
    expect(resourceFlow.count).toBe(10);
    expect(resourceFlow.missing_operations).toEqual([]);
    expect(
      resourceFlow.paths?.[
        "/v1/projects/{project_id}/experiments/{experiment_id}"
      ]?.get?.operationId,
    ).toBe("get_posthog_experiment");
    expect(resourceFlow.components?.schemas?.PosthogResourceDataBoundary).toBeTruthy();
    expect(
      (await call("/v1/openapi.json?flow=posthog-resources")).status,
    ).toBe(404);

    const testLoginPath = encodeURIComponent("/v1/auth/_test/login");
    const testLoginRes = await call(
      `/v1/openapi.json?path=${testLoginPath}&method=post`,
    );
    expect(testLoginRes.status).toBe(404);

    const indexRes = await call("/v1/openapi.json?index=true");
    expect(indexRes.status).toBe(200);
    const index = (await indexRes.json()) as {
      available_filters: unknown;
      available_operations: Array<{ path: string; method: string }>;
      core_agent_operations: Array<{ path: string; method: string }>;
      daily_use_operations: Array<{ path: string; method: string }>;
      posthog_resource_operations: Array<{ path: string; method: string }>;
      agent_facing_operations: Array<{ path: string; method: string }>;
      advanced_agent_operations?: Array<{ path: string; method: string }>;
      advanced_agent_operations_count?: number;
      advanced_index_url?: string;
      operator_internal_operations: Array<{ path: string; method: string }>;
      openapi?: string;
      next_action?: string;
    };
    expect(index.openapi).toBeUndefined();
    expect(index.available_filters).toBeTruthy();
    expect(index.advanced_index_url).toBe(
      "/v1/openapi.json?index=true&include_advanced=true",
    );
    expect(index.available_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/onboarding",
        method: "post",
      }),
    );
    expect(index.core_agent_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/onboarding",
        method: "post",
      }),
    );
    expect(index.core_agent_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/onboarding/source-snapshot.mjs",
        method: "get",
      }),
    );
    expect(index.core_agent_operations).not.toContainEqual(
      expect.objectContaining({ path: "/v1/install/plan", method: "post" }),
    );
    expect(index.core_agent_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/install/verify",
        method: "post",
      }),
    );
    expect(index.core_agent_operations).not.toContainEqual(
      expect.objectContaining({ path: "/v1/logs/", method: "post" }),
    );
    expect(index.core_agent_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/install/sdk/{language}",
        method: "get",
      }),
    );
    expect(index.core_agent_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/analytics/query",
        method: "post",
      }),
    );
    expect(index.daily_use_operations).toContainEqual(
      expect.objectContaining({ path: "/v1/query-blueprints", method: "get" }),
    );
    expect(index.daily_use_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/signal-map",
        method: "get",
      }),
    );
    expect(index.daily_use_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/analytics/query",
        method: "post",
      }),
    );
    expect(index.posthog_resource_operations).toHaveLength(10);
    expect(index.posthog_resource_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/feature-flags",
        method: "get",
      }),
    );
    expect(index.daily_use_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/surveys/{survey_id}/responses",
        method: "get",
      }),
    );
    expect(index.available_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/experiments",
        method: "get",
      }),
    );
    expect(index.available_operations).not.toContainEqual(
      expect.objectContaining({ path: "/v1/auth/_test/login", method: "post" }),
    );
    expect(index.available_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/feature-flags",
        method: "post",
      }),
    );
    expect(index.advanced_agent_operations).toBeUndefined();
    expect(index.advanced_agent_operations_count).toBeGreaterThan(0);
    expect(index.next_action).toContain("include_advanced=true");
    expect(index.agent_facing_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/onboarding",
        method: "post",
      }),
    );
    expect(index.agent_facing_operations).toContainEqual(
      expect.objectContaining({
        path: "/v1/auth/posthog",
        method: "post",
      }),
    );
    expect(index.agent_facing_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/feature-flags",
        method: "post",
      }),
    );
    expect(index.operator_internal_operations).not.toContainEqual(
      expect.objectContaining({ path: "/v1/auth/_test/login", method: "post" }),
    );

    const advancedIndexRes = await call(
      "/v1/openapi.json?index=true&include_advanced=true",
    );
    expect(advancedIndexRes.status).toBe(200);
    const advancedIndex = (await advancedIndexRes.json()) as {
      available_operations: Array<{ path: string; method: string }>;
      agent_facing_operations: Array<{ path: string; method: string }>;
      advanced_agent_operations?: Array<{ path: string; method: string }>;
      operator_internal_operations: Array<{ path: string; method: string }>;
      next_action?: string;
    };
    expect(advancedIndex.advanced_agent_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/feature-flags",
        method: "post",
      }),
    );
    expect(advancedIndex.agent_facing_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/feature-flags",
        method: "post",
      }),
    );
    expect(advancedIndex.available_operations).not.toContainEqual(
      expect.objectContaining({
        path: "/v1/projects/{project_id}/feature-flags",
        method: "post",
      }),
    );
    expect(advancedIndex.agent_facing_operations).toContainEqual(
      expect.objectContaining({ path: "/v1/auth/posthog", method: "post" }),
    );
    expect(advancedIndex.operator_internal_operations).not.toContainEqual(
      expect.objectContaining({ path: "/v1/auth/_test/login", method: "post" }),
    );
    expect(advancedIndex.next_action).toContain(
      "advanced_agent_operations only for explicit management asks",
    );
  });

  it("GET /v1/me confirms API-key auth state for HTTP agents", async () => {
    const { apiKey } = await signup("me-route@example.com");
    const res = await call("/v1/me", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      user: { email: string };
      api_key: { id: string; prefix: string; kind: string };
      projects_url: string;
      schema_url: string;
      next_action: string;
    };
    expect(json.user.email).toBe("me-route@example.com");
    expect(json.api_key.id).toBeTruthy();
    expect(json.api_key.prefix).toBeTruthy();
    expect(json.api_key.kind).toBe("private");
    expect(json.projects_url).toBe("/v1/projects");
    expect(json.schema_url).toBe("/v1/openapi.json");
    expect(json.next_action).toContain(
      "For a first installation, POST /v1/projects",
    );
    expect(json.next_action).not.toContain("reuse");
  });

  it("keeps the OpenAPI route inventory in sync with registered Hono routes", async () => {
    const res = await call("/v1/openapi.json");
    expect(res.status).toBe(200);
    const schema = (await res.json()) as OpenApiDocument;
    const runtimeRoutes = new Set(
      (
        (app as unknown as { routes?: Array<{ method: string; path: string }> })
          .routes ?? []
      )
        .filter((route) =>
          OPENAPI_HTTP_METHOD_SET.has(route.method.toLowerCase()),
        )
        .map((route) =>
          openApiRouteKey(route.method.toLowerCase(), route.path),
        ),
    );
    const schemaRoutes = new Set(
      openApiOperations(schema).map(({ method, path }) =>
        openApiRouteKey(method, path),
      ),
    );

    const localOnlyRuntimeRoutes = new Set([
      openApiRouteKey("post", "/v1/auth/_test/login"),
    ]);
    const missingFromSchema = [...runtimeRoutes]
      .filter(
        (route) =>
          !localOnlyRuntimeRoutes.has(route) &&
          !schemaRoutes.has(route),
      )
      .sort();
    const staleSchemaRoutes = [...schemaRoutes]
      .filter((route) => !runtimeRoutes.has(route))
      .sort();
    expect(
      missingFromSchema,
      "registered routes missing from /v1/openapi.json",
    ).toEqual([]);
    expect(
      staleSchemaRoutes,
      "OpenAPI routes without registered handlers",
    ).toEqual([]);
  });

  it("exposes a capability manifest for agent feature discovery", async () => {
    const res = await call("/v1/capabilities");
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      surfaces?: {
        answer_contracts?: never;
        query_blueprints?: {
          count?: number;
          catalog_url?: string;
          run_url?: string;
        };
        posthog_resources?: { flow_schema_url?: string };
      };
      capabilities?: Array<{ id: string; endpoints?: string[] }>;
      auth_types?: {
        public_ingest?: never;
        server_ingest?: never;
        ci_deploy?: string;
      };
      next_action?: string;
    };
    expect(manifest.surfaces?.answer_contracts).toBeUndefined();
    expect(manifest.surfaces?.query_blueprints?.count).toBeGreaterThan(0);
    expect(manifest.surfaces?.query_blueprints?.catalog_url).toBe(
      "/v1/query-blueprints",
    );
    expect(manifest.surfaces?.posthog_resources?.flow_schema_url).toBe(
      "/v1/openapi.json?flow=posthog",
    );
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "onboarding_v3",
          endpoints: expect.arrayContaining([
            "/v1/setup/manifest",
            "/v1/projects/{project_id}/onboarding",
            "/v1/onboarding/source-snapshot.mjs",
          ]),
        }),
        expect.objectContaining({
          id: "query_blueprints",
          endpoints: expect.arrayContaining(["/v1/query-blueprints"]),
        }),
        expect.objectContaining({
          id: "posthog_resources",
          endpoints: expect.arrayContaining([
            "/v1/projects/{project_id}/session-recordings",
            "/v1/projects/{project_id}/feature-flags",
            "/v1/projects/{project_id}/surveys/{survey_id}/responses",
            "/v1/projects/{project_id}/experiments",
          ]),
        }),
      ]),
    );
    expect(manifest.auth_types?.public_ingest).toBeUndefined();
    expect(manifest.auth_types?.server_ingest).toBeUndefined();
    expect(manifest.auth_types?.ci_deploy).toContain(
      "PostHog source-map credentials remain customer-owned",
    );
    expect(manifest.next_action).toContain("source_verified receipt");
    expect(manifest.next_action).toContain("customer PostHog event/property reads");
    expect(manifest.next_action).toContain("query blueprints");
  });

  it("exposes only OAuth, CI, runner, and owner setup boundaries", async () => {
    const res = await call("/v1/setup/manifest");
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      principle?: string;
      credential_boundaries?: Array<{
        name: string;
        token_prefix?: string;
        boundary?: string;
        allowed_operations?: string[];
        forbidden_contexts?: string[];
        browser_safe?: boolean;
      }>;
      support_env?: Array<{ name: string; required?: boolean; default?: string }>;
      posthog_telemetry_boundary?: {
        analytics_and_errors?: string;
        source_maps?: string;
        agentry_access?: string;
      };
      framework_env_matrix?: never;
      host_env_matrix?: never;
      env_preflight_checks?: never;
      local_state?: {
        source_snapshot_helper?: string;
        repo_artifact_required?: boolean;
        snapshot_rule?: string;
        local_only?: string;
      };
      public_queries?: { default_agent_behavior?: string };
      project_setup_endpoint?: string;
      next_action?: string;
    };

    expect(manifest.principle).toContain("analytics, exceptions, and source maps");
    expect(manifest.principle).toContain("directly to PostHog");
    expect(manifest.project_setup_endpoint).toBe(
      "/v1/projects/{project_id}/setup",
    );
    expect(manifest.credential_boundaries?.map((item) => item.name)).toEqual([
      "AGENTRY_CI_API_KEY",
      "AGENTRY_RUNNER_API_KEY",
      "AGENTRY_PRIVATE_API_KEY",
    ]);

    const byName = (name: string) =>
      manifest.credential_boundaries?.find((item) => item.name === name);
    expect(byName("AGENTRY_CI_API_KEY")).toEqual(
      expect.objectContaining({
        token_prefix: "agentry_ci_",
        boundary: "trusted_ci",
        browser_safe: false,
        allowed_operations: [
          "POST /v1/deploys/",
          "POST /v1/automation-runs/:run_id/pr-proof",
        ],
      }),
    );
    expect(byName("AGENTRY_RUNNER_API_KEY")).toEqual(
      expect.objectContaining({
        token_prefix: "agentry_runner_",
        boundary: "exact_automation_runner",
        forbidden_contexts: expect.arrayContaining([
          "owner decisions",
          "another automation_id",
        ]),
      }),
    );
    expect(byName("AGENTRY_PRIVATE_API_KEY")).toEqual(
      expect.objectContaining({
        token_prefix: "agentry_sk_",
        boundary: "human_owner_or_member",
      }),
    );
    expect(byName("AGENTRY_PUBLIC_API_KEY")).toBeUndefined();
    expect(byName("AGENTRY_SERVER_API_KEY")).toBeUndefined();

    expect(manifest.posthog_telemetry_boundary).toEqual(
      expect.objectContaining({
        analytics_and_errors: expect.stringContaining("official PostHog SDKs"),
        source_maps: expect.stringContaining("official PostHog CLI"),
        agentry_access: expect.stringContaining("read-only PostHog OAuth"),
      }),
    );
    expect(manifest.framework_env_matrix).toBeUndefined();
    expect(manifest.host_env_matrix).toBeUndefined();
    expect(manifest.env_preflight_checks).toBeUndefined();
    expect(manifest.support_env).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "AGENTRY_URL",
          required: false,
          default: "https://api.agentry.sh",
        }),
      ]),
    );
    expect(manifest.local_state).toEqual(
      expect.objectContaining({
        source_snapshot_helper: "/v1/onboarding/source-snapshot.mjs",
        repo_artifact_required: false,
        snapshot_rule: expect.stringContaining(
          "do not create an Agentry state file",
        ),
        local_only: expect.stringContaining("credentials"),
      }),
    );
    expect(manifest.public_queries?.default_agent_behavior).toContain(
      "only for explicit browser",
    );
    expect(manifest.next_action).toContain("read-only OAuth");
    expect(manifest.next_action).toContain("detect the existing telemetry SDK");
  });
  it("exposes a customer-PostHog project setup matrix", async () => {
    const { apiKey } = await signup("setup-matrix@example.com");
    const proj = await createProject(apiKey, "setup-matrix-demo");
    const endpoint = "/v1/projects/" + proj.id + "/setup";
    const res = await call(endpoint, {
      headers: { authorization: "Bearer " + apiKey },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      schema_version?: number;
      project_id: string;
      principle?: string;
      posthog_connection?: {
        endpoint?: string;
        ownership?: string;
        access?: string;
        regions?: string[];
        next_action?: string;
      };
      env_matrix?: Array<{
        env_var: string;
        token_kind: string;
        token_prefix?: string;
        commit_to_git: boolean;
        browser_safe: boolean;
        allowed_contexts?: string[];
        host_or_ci_placement?: string;
        notes?: string;
      }>;
      project_binding?: never;
      framework_env_matrix?: never;
      host_env_matrix?: never;
      env_preflight_checks?: never;
      public_queries?: { default_agent_behavior?: string };
      next_action?: string;
    };

    expect(json.schema_version).toBe(3);
    expect(json.project_id).toBe(proj.id);
    expect(json.principle).toContain("customer-owned PostHog Cloud project");
    expect(json.principle).toContain("encrypted read-only OAuth grant");
    expect(json.posthog_connection).toEqual(
      expect.objectContaining({
        endpoint: "/v1/projects/" + proj.id + "/posthog-connection",
        ownership: "customer_owned",
        access: "oauth_read_only",
        regions: ["us", "eu"],
      }),
    );
    expect(json.posthog_connection?.next_action).toContain("authorize PostHog");

    const names = json.env_matrix?.map((item) => item.env_var);
    expect(names).toEqual([
      "AGENTRY_CI_API_KEY",
      "AGENTRY_RUNNER_API_KEY",
      "AGENTRY_PRIVATE_API_KEY",
      "AGENTRY_URL",
      "AGENTRY_DEPLOY_SHA",
      "AGENTRY_ENVIRONMENT",
    ]);
    expect(names).not.toContain("AGENTRY_PUBLIC_API_KEY");
    expect(names).not.toContain("AGENTRY_SERVER_API_KEY");

    const ci = json.env_matrix?.find(
      (item) => item.env_var === "AGENTRY_CI_API_KEY",
    );
    expect(ci).toEqual(
      expect.objectContaining({
        token_kind: "ci_deploy_key",
        token_prefix: "agentry_ci_",
        browser_safe: false,
        allowed_contexts: ["ci_deploy"],
      }),
    );
    expect(ci?.notes).toContain("deploy attribution and automation PR proof");
    expect(ci?.notes).toContain("cannot read PostHog");

    const runner = json.env_matrix?.find(
      (item) => item.env_var === "AGENTRY_RUNNER_API_KEY",
    );
    expect(runner).toEqual(
      expect.objectContaining({
        token_kind: "automation_runner_key",
        token_prefix: "agentry_runner_",
        browser_safe: false,
      }),
    );
    expect(runner?.host_or_ci_placement).toContain("one automation_id");

    const owner = json.env_matrix?.find(
      (item) => item.env_var === "AGENTRY_PRIVATE_API_KEY",
    );
    expect(owner).toEqual(
      expect.objectContaining({
        token_kind: "owner_api_key",
        token_prefix: "agentry_sk_",
        browser_safe: false,
        allowed_contexts: ["agent_local", "human_management"],
      }),
    );
    expect(owner?.notes).toContain("Never expose this in browser bundles");
    expect(json.project_binding).toBeUndefined();
    expect(json.framework_env_matrix).toBeUndefined();
    expect(json.host_env_matrix).toBeUndefined();
    expect(json.env_preflight_checks).toBeUndefined();
    expect(json.public_queries?.default_agent_behavior).toContain(
      "full public URL",
    );
    expect(json.next_action).toContain("Connect PostHog");
    expect(json.next_action).toContain("only the CI and runner credentials");
  });
  it("every operational query blueprint in the catalog has a run handler", async () => {
    const { listQueryBlueprintTemplates } = await import("../src/query-blueprint-catalog.js");
    const { apiKey } = await signup("bp-handlers@example.com");
    const proj = await createProject(apiKey, "bp-handlers");
    const operational = listQueryBlueprintTemplates().filter(
      (b) => b.backend === "operational",
    );
    expect(operational.length).toBeGreaterThan(0);
    for (const blueprint of operational) {
      // Only pass params that have defaults or are optional; required params
      // get a placeholder so the handler is exercised, not the validation.
      const params: Record<string, unknown> = {};
      for (const p of blueprint.params) {
        if (p.required && p.default === undefined) {
          params[p.name] = p.type === "number" ? 1 : "placeholder";
        }
      }
      const res = await call(
        `/v1/projects/${proj.id}/query-blueprints/${blueprint.id}/run`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}` },
          json: { params },
        },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      expect(
        body.error?.code,
        `blueprint ${blueprint.id} must have a handler`,
      ).not.toBe("catalog_inconsistent");
    }
  });

  it("exposes query blueprints without reviving the old recipe API surface", async () => {
    const listRes = await call("/v1/query-blueprints");
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      kind: string;
      count: number;
      categories: string[];
      blueprints?: Array<{
        id: string;
        kind: string;
        backend: string;
        publishable: boolean;
        endpoints?: { run?: string; publish?: string };
        render_hint?: unknown;
      }>;
      next_action?: string;
    };
    expect(list.kind).toBe("query_blueprints");
    expect(list.count).toBeGreaterThan(0);
    expect(list.categories).toContain("events");
    expect(
      new Set(list.blueprints?.map((blueprint) => blueprint.id)).size,
    ).toBe(list.blueprints?.length);
    expect(
      list.blueprints?.every(
        (blueprint) => blueprint.kind === "query_blueprint",
      ),
    ).toBe(true);
    expect(JSON.stringify(list.blueprints)).not.toContain("runnable");
    expect(
      list.blueprints?.some((blueprint) => blueprint.backend === "analytics"),
    ).toBe(true);
    expect(
      list.blueprints?.some((blueprint) => blueprint.backend === "operational"),
    ).toBe(true);
    expect(
      list.blueprints?.some(
        (blueprint) => blueprint.id === "funnel_3_step_by_property",
      ),
    ).toBe(true);
    const analyticsBlueprint = list.blueprints?.find(
      (blueprint) => blueprint.id === "active_users_daily",
    );
    const casesBlueprint = list.blueprints?.find(
      (blueprint) => blueprint.id === "active_cases_top",
    );
    const deployBlueprint = list.blueprints?.find(
      (blueprint) => blueprint.id === "deploy_frequency_30d",
    );
    expect(analyticsBlueprint?.publishable).toBe(true);
    expect(analyticsBlueprint?.endpoints?.publish).toBe(
      "/v1/projects/:project_id/public-queries",
    );
    expect(casesBlueprint?.publishable).toBe(false);
    expect(casesBlueprint?.endpoints?.publish).toBeUndefined();
    expect(deployBlueprint?.publishable).toBe(false);
    expect(deployBlueprint?.endpoints?.publish).toBeUndefined();
    expect(list.next_action).toContain("saved signal map");
    expect(list.next_action).toContain("current verified onboarding receipt");
    expect(list.next_action).toContain("generic defaults");
    expect(list.next_action).toContain("HogQL");

    const filteredRes = await call("/v1/query-blueprints?category=events");
    expect(filteredRes.status).toBe(200);
    const filtered = (await filteredRes.json()) as {
      blueprints?: Array<{ category: string }>;
    };
    expect(filtered.blueprints?.length).toBeGreaterThan(0);
    expect(
      filtered.blueprints?.every(
        (blueprint) => blueprint.category === "events",
      ),
    ).toBe(true);

    const detailRes = await call("/v1/query-blueprints/active_users_daily");
    expect(detailRes.status).toBe(200);
    await expect(detailRes.json()).resolves.toMatchObject({
      id: "active_users_daily",
      kind: "query_blueprint",
      backend: "analytics",
      publishable: true,
      endpoints: {
        run: "/v1/projects/:project_id/query-blueprints/active_users_daily/run",
        publish: "/v1/projects/:project_id/public-queries",
      },
    });

    const casesDetailRes = await call("/v1/query-blueprints/active_cases_top");
    expect(casesDetailRes.status).toBe(200);
    const casesDetail = (await casesDetailRes.json()) as {
      publishable: boolean;
      endpoints: { run?: string; publish?: string };
      next_action?: string;
    };
    expect(casesDetail.publishable).toBe(false);
    expect(casesDetail.endpoints.publish).toBeUndefined();
    expect(casesDetail.next_action).toContain("not browser-publishable");

    const segmentedFunnelRes = await call(
      "/v1/query-blueprints/funnel_3_step_by_property",
    );
    expect(segmentedFunnelRes.status).toBe(200);
    const segmentedFunnel = (await segmentedFunnelRes.json()) as {
      id: string;
      query: string;
      params: Array<{ name: string; default?: unknown }>;
      expected_columns: string[];
      render_hint?: { notes?: string[] };
      example_params?: Record<string, unknown>;
      recommended_segment_properties?: string[];
      required_event_properties?: Record<string, string[]>;
      parameterized_required_event_properties?: Array<{
        event_param: string;
        property_param: string;
        check_endpoint: string;
      }>;
      next_action?: string;
    };
    expect(segmentedFunnel.id).toBe("funnel_3_step_by_property");
    expect(segmentedFunnel.params.map((param) => param.name)).toContain(
      "segment_property",
    );
    expect(
      segmentedFunnel.params.find((param) => param.name === "segment_property")
        ?.default,
    ).toBeUndefined();
    expect(segmentedFunnel.example_params?.segment_property).toBe("$device_type");
    expect(segmentedFunnel.recommended_segment_properties).toEqual(
      expect.arrayContaining(["$device_type", "$os", "$browser", "$is_mobile", "$platform"]),
    );
    expect(segmentedFunnel.recommended_segment_properties).not.toContain("$user_agent");

    const retentionBlueprintRes = await call("/v1/query-blueprints/weekly_retention");
    expect(retentionBlueprintRes.status).toBe(200);
    const retentionBlueprint = (await retentionBlueprintRes.json()) as {
      params: Array<{ name: string; default?: unknown }>;
      example_params?: Record<string, unknown>;
    };
    expect(
      retentionBlueprint.params.find((param) => param.name === "activity_event")
        ?.default,
    ).toBeUndefined();
    expect(retentionBlueprint.example_params?.activity_event).not.toBe("page_view");

    expect(segmentedFunnel.required_event_properties?.page_view).toBeUndefined();
    expect(segmentedFunnel.parameterized_required_event_properties).toEqual([
      expect.objectContaining({
        event_param: "step1",
        property_param: "segment_property",
        check_endpoint: "/v1/projects/:project_id/event-property-keys?events={{step1}}",
      }),
    ]);
    expect(segmentedFunnel.next_action).toContain(
      "parameterized_required_event_properties",
    );
    expect(segmentedFunnel.query).toContain("argMin(");
    expect(segmentedFunnel.query).not.toMatch(/\bany\s*\(/i);
    expect(segmentedFunnel.expected_columns).toEqual(
      expect.arrayContaining([
        "segment",
        "step1_count",
        "step2_count",
        "step3_count",
      ]),
    );
    expect(segmentedFunnel.render_hint?.notes?.join(" ")).toContain(
      "telemetry gap",
    );

    const removedRes = await call("/v1/recipes/catalog");
    expect(removedRes.status).toBe(404);
  });

  it("keeps the generated repository workflow manifest in sync with markdown", () => {
    const script = fileURLToPath(
      new URL("../../../scripts/gen-workflow-manifest.mjs", import.meta.url),
    );
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    expect(() =>
      execFileSync(process.execPath, [script, "--check"], {
        cwd: repoRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("keeps workflow/example markdown references aligned with executable query templates", () => {
    const script = fileURLToPath(
      new URL("../../../scripts/lint-workflow-references.mjs", import.meta.url),
    );
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    expect(() =>
      execFileSync(process.execPath, [script], {
        cwd: repoRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("requires OpenAPI operations to expose usable schema metadata", async () => {
    const res = await call("/v1/openapi.json");
    expect(res.status).toBe(200);
    const schema = (await res.json()) as OpenApiDocument;
    const failures: string[] = [];

    for (const { path, method, pathItem, operation } of openApiOperations(
      schema,
    )) {
      const route = `${method.toUpperCase()} ${path}`;
      if (
        typeof operation.summary !== "string" &&
        typeof operation.operationId !== "string"
      ) {
        failures.push(`${route}: missing summary or operationId`);
      }
      if (!Array.isArray(operation.tags) || operation.tags.length === 0) {
        failures.push(`${route}: missing tags`);
      }
      if (
        !operation.responses ||
        Object.keys(operation.responses).length === 0
      ) {
        failures.push(`${route}: missing responses`);
      }
      if (
        OPENAPI_MUTATING_METHOD_SET.has(method) &&
        operation.requestBody === undefined &&
        operation["x-agentry-request-body"] !== "none"
      ) {
        failures.push(
          `${route}: missing requestBody schema or x-agentry-request-body=none`,
        );
      }
      const isLeanOnboarding = operation["x-agentry-flow"] === "onboarding_v3";
      const requestJson = operation.requestBody?.content?.["application/json"];
      if (
        !isLeanOnboarding &&
        operation.requestBody &&
        requestJson?.examples === undefined
      ) {
        failures.push(`${route}: missing requestBody example`);
      }
      const successResponses = Object.entries(operation.responses ?? {}).filter(
        ([status]) => /^2\d\d$/.test(status),
      );
      for (const [status, response] of successResponses) {
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response)
        )
          continue;
        const content = (response as { content?: unknown }).content;
        if (!content || typeof content !== "object" || Array.isArray(content))
          continue;
        const json = (content as Record<string, { examples?: unknown }>)[
          "application/json"
        ];
        if (!isLeanOnboarding && json && json.examples === undefined) {
          failures.push(`${route}: missing ${status} response example`);
        }
      }

      const placeholders = [...path.matchAll(/\{([^}/]+)\}/g)].flatMap(
        (match) => (match[1] ? [match[1]] : []),
      );
      if (placeholders.length === 0) continue;
      const documentedPathParams = new Set(
        [...asRecords(pathItem.parameters), ...asRecords(operation.parameters)]
          .map((parameter) => resolveOpenApiParameter(schema, parameter))
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name)
          .filter((name): name is string => typeof name === "string"),
      );
      for (const placeholder of placeholders) {
        if (!documentedPathParams.has(placeholder)) {
          failures.push(
            `${route}: missing path parameter schema for {${placeholder}}`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("returns schema-aware invalid_payload details that agents can use to retry", async () => {
    const { apiKey } = await signup("schema-aware-invalid@example.com");
    const res = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "schema-aware-invalid-project",
      },
      json: {},
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: {
        code: string;
        next_action: string;
        request_id: string;
        retryable: boolean;
        details: {
          schema_path: string;
          schema_method: string;
          schema_ref?: string;
          request_body_schema?: unknown;
          request_example?: unknown;
          missing_fields: string[];
        };
      };
    };
    expect(json.error.code).toBe("invalid_payload");
    expect(res.headers.get("x-agentry-request-id")).toBeTruthy();
    expect(json.error.request_id).toBeTruthy();
    expect(json.error.retryable).toBe(false);
    expect(json.error.next_action).toContain("/v1/openapi.json");
    expect(json.error.details).toMatchObject({
      schema_path: "/v1/projects",
      schema_method: "post",
      schema_ref: "#/components/schemas/CreateProjectRequest",
    });
    expect(json.error.details.missing_fields).toContain("name");
    expect(json.error.details.request_example).toBeTruthy();

    const corrected = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "schema-aware-corrected-project",
      },
      json: { name: "schema-aware-corrected" },
    });
    expect(corrected.status).toBe(200);
  });

  it("documents agent-discovered feedback kind and fingerprint in the OpenAPI schema", async () => {
    const res = await call(
      "/v1/openapi.json?path=%2Fv1%2Ffeedback&method=post",
    );
    expect(res.status).toBe(200);
    const schema = (await res.json()) as {
      operation?: {
        requestBody?: {
          content?: {
            "application/json"?: {
              schema?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      };
    };
    const props =
      schema.operation?.requestBody?.content?.["application/json"]?.schema
        ?.properties ?? {};
    expect((props.kind as { enum?: string[] }).enum).toContain(
      "agent_discovered_bug",
    );
    expect(props.fingerprint).toBeTruthy();
  });

  it("keeps authored install, reference, and skill Markdown out of the API", async () => {
    for (const path of [
      "/install.md",
      "/agentry.md",
      "/skill/agentry/SKILL.md",
      "/agentry-install-guide.md",
      "/agentry-install.md",
    ]) {
      expect((await call(path, { redirect: "manual" })).status).toBe(404);
    }
  });

  it("keeps the packaged Claude plugin skill synced with the rendered skill", () => {
    const pluginSkillPath = fileURLToPath(
      new URL(
        "../../../plugins/agentry/skills/agentry/SKILL.md",
        import.meta.url,
      ),
    );
    expect(readFileSync(pluginSkillPath, "utf8")).toBe(renderSkillMarkdown());
  });

  it("keeps repo AGENTS.md on the customer-owned PostHog boundary", () => {
    const agentsPath = fileURLToPath(
      new URL("../../../AGENTS.md", import.meta.url),
    );
    const txt = readFileSync(agentsPath, "utf8");
    expect(txt).toContain("Agentry does not host PostHog");
    expect(txt).toContain("Agentry issues no browser or server telemetry key");
    expect(txt).not.toContain("AGENTRY_SERVER_API_KEY");
    expect(txt).toContain(
      "CI/provider post-deploy automation uses `AGENTRY_CI_API_KEY`",
    );
    expect(txt).toMatch(
      /Never give a runner the owner\s+credential or the PostHog OAuth token/,
    );
    expect(txt).toContain("Source maps go directly through the");
    expect(txt).toContain("material durable milestones");
    expect(txt).toContain("Onboarding completes only at");
    expect(txt).toContain(
      "Direct provider-state questions use the matching bounded PostHog resource",
    );
    expect(txt).toMatch(
      /Claims about runtime flag application,[\s\S]+begin with the[\s\S]+approved source map/,
    );
    expect(txt).toContain("non-browser direct HTTP calls");
    expect(txt).toContain("Browser fetch");
  });

  it("GET /adapters lists cross-platform install adapters over one canonical source", async () => {
    const res = await call("/adapters");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      canonical: { openapi: string; skill: string };
      install_policy: {
        detect_all_harnesses: boolean;
        default_repo_pointer: string;
      };
      adapters: Record<string, Record<string, string>>;
      next_action: string;
    };
    expect(json.canonical.openapi).toBe("/v1/openapi.json");
    expect(json.install_policy.detect_all_harnesses).toBe(true);
    expect(json.install_policy.default_repo_pointer).toBe("AGENTS.md");
    expect(json.next_action).toContain("Detect all");
    expect(json.next_action).toContain("every applicable adapter");
    expect(json.adapters.cursor!.url).toBe("/adapters/cursor.mdc");
    expect(json.adapters.windsurf!.url).toBe("/adapters/windsurfrules");
    expect(json.adapters.agents_md!.url).toBe("/adapters/AGENTS.md");
    expect(json.adapters.codex!.skill_url).toBe(
      PUBLIC_SKILL_URL,
    );
    expect(json.adapters.codex!.install).toContain("CODEX_HOME");
    expect(json.adapters.chatgpt!.action_schema).toContain("/v1/openapi.json");
    expect(json.adapters.claude_code!.plugin_manifest).toBe(
      "/adapters/claude-plugin.json",
    );
    expect(json.adapters.claude_code!.install_project).toContain(
      ".claude/skills/agentry",
    );
    expect(json.adapters.claude_code!.install_user).toContain(
      "~/.claude/skills/agentry",
    );
  });

  it("GET /adapters/* serve thin pointers that point at the API, not duplicates", async () => {
    const mdc = await (await call("/adapters/cursor.mdc")).text();
    expect(mdc).toContain("description:"); // .mdc frontmatter
    expect(mdc).toContain("/v1/openapi.json");
    expect(mdc).toContain("AGENTRY_PRIVATE_API_KEY");
    expect(mdc).not.toContain("AGENTRY_PUBLIC_API_KEY");
    expect(mdc).not.toContain("AGENTRY_SERVER_API_KEY");
    expect(mdc).toContain("PostHog OAuth");
    expect(mdc).toContain("AGENTRY_CI_API_KEY");
    expect(mdc).toContain("AGENTRY_RUNNER_API_KEY");
    expect(mdc).toContain("/adapters");
    expect(mdc).not.toContain("POST https://api.agentry.sh/v1/auth/device");
    expect(mdc).not.toContain("45 seconds");
    expect(mdc).not.toContain("/v1/feedback");

    const agents = await (await call("/adapters/AGENTS.md")).text();
    expect(agents).toContain("## Agentry");
    expect(agents).toContain("/v1/openapi.json");
    expect(agents).not.toContain("AGENTRY_PUBLIC_API_KEY");
    expect(agents).not.toContain("AGENTRY_SERVER_API_KEY");
    expect(agents).toContain("PostHog OAuth");
    expect(agents).toContain("AGENTRY_CI_API_KEY");
    expect(agents).toContain("AGENTRY_RUNNER_API_KEY");
    expect(agents).toContain("Do not emit deploys from browser");
    expect(agents).toContain("/v1/docs/automation");
    expect(agents).not.toContain("POST https://api.agentry.sh/v1/auth/device");
    expect(agents).not.toContain("Prefer recipes");
    expect(agents).not.toContain("Recipes, event names");
    expect(agents).not.toContain("agent_discovered_bug");

    const windsurf = await (await call("/adapters/windsurfrules")).text();
    expect(windsurf).toContain("Agentry");
    expect(windsurf).toContain(PUBLIC_INSTALL_DOC_URL);
    expect(windsurf).toContain("/adapters");
    expect(windsurf).not.toContain("PostHog/HogQL");

    const plugin = (await (
      await call("/adapters/claude-plugin.json")
    ).json()) as {
      name: string;
      skills: string[];
    };
    expect(plugin.name).toBe("agentry");
    expect(plugin.skills).toContain("./skills/agentry");
  });

  it("does not serve removed llms.txt alias", async () => {
    const res = await call("/llms.txt");
    expect(res.status).toBe(404);
  });

  it("GET /v1/docs/query and /v1/docs/automation serve the agent-readable reference docs", async () => {
    const query = await call("/v1/docs/query");
    expect(query.status).toBe(200);
    expect(query.headers.get("content-type") ?? "").toContain("text/markdown");
    const queryText = await query.text();
    expect(queryText).toContain("agent query reference");
    expect(queryText).toContain("HogQL primer");
    expect(queryText).toContain("ALWAYS validate the rows");
    expect(queryText).toContain("freshness.retry_after_ms");
    expect(queryText).toContain("source_verified");
    expect(queryText).toContain("customer's official PostHog SDK setup");
    expect(queryText).not.toContain("posthog_compatible_safe_v1");
    expect(queryText).not.toContain("central transport");
    expect(queryText).not.toContain("ingest plumbing");
    expect(queryText).toContain("Custom HogQL is exposed for analytics events");
    expect(queryText).toContain("ad-hoc SQL over Agentry's operational");
    expect(queryText).not.toMatch(/toMonday\s*\(\s*toDate\s*\(\s*min\s*\(\s*timestamp\s*\)/i);
    expect(queryText).not.toContain(
      "To run an\nad-hoc SQL is not currently exposed",
    );

    const automation = await call("/v1/docs/automation");
    expect(automation.status).toBe(200);
    expect(automation.headers.get("content-type") ?? "").toContain(
      "text/markdown",
    );
    const automationText = await automation.text();
    expect(automationText).toContain("Agentry automation: v3 workflow engine and v2 automations");
    expect(automationText).toContain("/v1/openapi.json?flow=automation");
    expect(automationText).toContain("trigger.schedule.cron@1.0.0");
    expect(automationText).toContain("reconcile_only: true");
    expect(automationText).toContain("error-to-draft-pr@2.0.0");
    expect(automationText).toContain("weekly-funnel-review@2.0.0");
    expect(automationText).toContain("Zero traffic never proves success");
  });

  it("GET /v1/openapi.json exposes the endpoint schema and /v1/schema is not an alias", async () => {
    const res = await call("/v1/openapi.json");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(json.openapi).toBe("3.1.0");
    expect(json.paths["/v1/install/plan"]).toBeUndefined();
    expect(json.paths["/v1/projects/{project_id}/install/verify"]).toBeUndefined();
    expect(json.paths["/v1/projects/{project_id}/onboarding"]).toBeTruthy();
    expect(json.paths["/v1/onboarding/source-snapshot.mjs"]).toBeTruthy();

    const alias = await call("/v1/schema");
    expect(alias.status).toBe(404);
  });

  it("GET /v1/privacy/disclosure can emit a client-only analytics clause", async () => {
    const res = await call(
      "/v1/privacy/disclosure?variant=client&errors=false&analytics=true",
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      canonical_url: string;
      variant: string;
      includes: { errors: boolean; analytics: boolean };
      paste_ready_markdown: string;
      data_residency: {
        telemetry_backend: string;
        analytics_backend: string;
        error_backend: string;
        sourcemap_storage: string;
        agentry_control_plane: string;
      };
      learn_more: string;
    };
    expect(json.canonical_url).toBe(PUBLIC_PRIVACY_URL);
    expect(json.learn_more).toBe(PUBLIC_REPOSITORY_URL);
    expect(json.variant).toBe("client");
    expect(json.includes).toEqual({ errors: false, analytics: true });
    expect(json.data_residency.telemetry_backend).toContain(
      "Customer-owned PostHog Cloud project",
    );
    expect(json.data_residency.sourcemap_storage).toContain(
      "customer's official PostHog CLI",
    );
    expect(json.data_residency.agentry_control_plane).toContain(
      "bounded/redacted evidence",
    );
    expect(json.paste_ready_markdown).toContain("Product analytics");
    expect(json.paste_ready_markdown).not.toContain("Error monitoring");
    expect(json.paste_ready_markdown).toContain(
      "sends product analytics directly to our PostHog Cloud project",
    );
    expect(json.paste_ready_markdown).toContain(
      "does not proxy telemetry, store raw events, or operate a shadow analytics warehouse",
    );
    expect(json.paste_ready_markdown).toContain(PUBLIC_REPOSITORY_URL);
    expect(json.paste_ready_markdown).not.toContain("properties such as the page URL, referrer, language, and user-agent");
  });

  it("does not serve removed /v1/install/guide alias", async () => {
    const res = await call("/v1/install/guide?framework=next");
    expect(res.status).toBe(404);
  });

  it("returns 404 for every retired onboarding route and keeps lean onboarding canonical", async () => {
    for (const [method, path] of [
      ["GET", "/v1/install/contract"],
      ["POST", "/v1/install/plan"],
      ["GET", "/v1/install/repo-fingerprint/node"],
      ["GET", "/v1/install/sdk/node"],
      ["GET", "/v1/install/sdk/browser"],
      ["GET", "/v1/install/sdk/python"],
    ] as const) {
      expect((await call(path, { method })).status, `${method} ${path}`).toBe(404);
    }

    const { apiKey } = await signup("retired-onboarding-routes@example.com");
    const project = await createProject(apiKey, "retired-onboarding-routes");
    const headers = { authorization: `Bearer ${apiKey}` };
    for (const [method, path] of [
      ["PUT", `/v1/projects/${project.id}/signal-map`],
      ["GET", `/v1/projects/${project.id}/install-plans`],
      ["GET", `/v1/projects/${project.id}/install-plans/retired-plan`],
      ["GET", `/v1/projects/${project.id}/implementation-report`],
      ["PUT", `/v1/projects/${project.id}/implementation-report`],
      ["POST", `/v1/projects/${project.id}/install/verify`],
      ["GET", `/v1/projects/${project.id}/verify-report`],
      ["GET", `/v1/projects/${project.id}/answer-contracts`],
    ] as const) {
      expect(
        (await call(path, { method, headers })).status,
        `${method} ${path}`,
      ).toBe(404);
    }

    const schema = (await (await call("/v1/openapi.json")).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(schema.paths["/v1/projects/{project_id}/onboarding"]?.get).toBeTruthy();
    expect(schema.paths["/v1/onboarding/source-snapshot.mjs"]?.get).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/signal-map"]?.get).toBeTruthy();
    for (const path of [
      "/v1/install/contract",
      "/v1/install/plan",
      "/v1/install/repo-fingerprint/node",
      "/v1/install/sdk/node",
      "/v1/install/sdk/browser",
      "/v1/install/sdk/{language}",
      "/v1/projects/{project_id}/install-plans",
      "/v1/projects/{project_id}/install-plans/{plan_id}",
      "/v1/projects/{project_id}/implementation-report",
      "/v1/projects/{project_id}/install/verify",
      "/v1/projects/{project_id}/verify-report",
      "/v1/projects/{project_id}/answer-contracts",
    ]) {
      expect(schema.paths[path], path).toBeUndefined();
    }
    expect(schema.paths["/v1/projects/{project_id}/signal-map"]?.put).toBeUndefined();
  });

  it("unknown route returns 404 with code=not_found", async () => {
    const res = await call("/v1/does-not-exist");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("not_found");
  });
});

describe("auth", () => {
  it("test-login mints a key and creates a user", async () => {
    const { apiKey, userId } = await signup("alice@example.com");
    expect(apiKey).toMatch(/^agentry_sk_/);
    expect(userId).toMatch(/-/);
  });

  it("test-login twice for same email returns NEW key but SAME user", async () => {
    const a = await signup("bob@example.com");
    const b = await signup("bob@example.com");
    expect(a.userId).toBe(b.userId);
    expect(a.apiKey).not.toBe(b.apiKey);

    // Old key should still work (not revoked).
    const r1 = await call("/v1/projects", {
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(r1.status).toBe(200);
  });

  it("test-login with malformed JSON returns 400 invalid_payload", async () => {
    const res = await call("/v1/auth/_test/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_payload");
  });

  it("test-login is gated by ENABLE_TEST_LOGIN env var", async () => {
    env = await makeTestEnv({ enableTestLogin: false });
    const res = await call("/v1/auth/_test/login", {
      method: "POST",
      json: { email: "x@example.com" },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("not_found");
  });

  it("hard-removes the legacy device flow", async () => {
    expect((await call("/v1/auth/device", { method: "POST", json: {} })).status).toBe(404);
    expect((await call("/v1/auth/device/poll", { method: "POST", json: {} })).status).toBe(404);
  });

  it("PostHog redemption without its bound secrets returns 400 invalid_payload", async () => {
    const res = await call("/v1/auth/posthog/poll", {
      method: "POST",
      json: {},
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_payload");
  });

  it("stages a replacement owner key until explicit revocation", async () => {
    const { apiKey } = await signup("carol@example.com");
    const res = await call("/v1/auth/keys/rotate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "carol-owner-key-rotate",
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { api_key: string; previous_key_id: string };
    expect(data.api_key).not.toBe(apiKey);

    // Staged overlap keeps the only previously known key usable until handoff.
    const oldRes = await call("/v1/projects", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(oldRes.status).toBe(200);

    const newRes = await call("/v1/projects", {
      headers: { authorization: `Bearer ${data.api_key}` },
    });
    expect(newRes.status).toBe(200);

    const revoke = await call(`/v1/auth/keys/${data.previous_key_id}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${data.api_key}`,
        "idempotency-key": "carol-owner-key-revoke-old",
      },
      json: { reason: "Replacement verified." },
    });
    expect(revoke.status).toBe(200);
    expect((await call("/v1/projects", {
      headers: { authorization: `Bearer ${apiKey}` },
    })).status).toBe(401);
  });

  it("missing auth header returns 401 unauthorized", async () => {
    const res = await call("/v1/projects");
    expect(res.status).toBe(401);
    const json = (await res.json()) as {
      error: { code: string; next_action?: string };
    };
    expect(json.error.code).toBe("unauthorized");
    expect(json.error.next_action).toContain("AGENTRY_PRIVATE_API_KEY");
    expect(json.error.next_action).toContain("agentry login");
    expect(json.error.next_action).not.toContain("/v1/auth/device");
    expect(json.error.next_action).not.toContain("/v1/auth/signup");
  });

  it("invalid api key returns 401 invalid_api_key", async () => {
    const res = await call("/v1/projects", {
      headers: { authorization: "Bearer agentry_sk_nonsense" },
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as {
      error: { code: string; next_action?: string };
    };
    expect(json.error.code).toBe("invalid_api_key");
    expect(json.error.next_action).toContain("AGENTRY_PRIVATE_API_KEY");
    expect(json.error.next_action).toContain("full agentry_sk_ key");
    expect(json.error.next_action).toContain("agentry login");
    expect(json.error.next_action).not.toContain("/v1/auth/device");
    expect(json.error.next_action).not.toContain("/v1/auth/signup");
  });

  it("rejects agp_ keys on private routes with the same invalid_api_key shape", async () => {
    const publicApiKey = retiredPublicKey();
    const res = await call("/v1/projects", {
      headers: { authorization: `Bearer ${publicApiKey}` },
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as {
      error: { code: string; next_action?: string };
    };
    expect(json.error.code).toBe("invalid_api_key");
    expect(json.error.next_action).toContain("full agentry_sk_ key");
    expect(json.error.next_action).not.toContain("/v1/auth/signup");
  });
});

describe("projects", () => {
  it("rolls project creation back when the owner membership cannot commit", async () => {
    const { apiKey } = await signup("atomic-project-create@example.com");
    const raw = getRawDbClientForUrl(env.TURSO_DATABASE_URL);
    await raw.execute(`
      CREATE TRIGGER reject_project_owner_membership
      BEFORE INSERT ON project_memberships
      BEGIN
        SELECT RAISE(ABORT, 'forced owner membership failure');
      END
    `);
    const failed = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "atomic-project-create-retry",
      },
      json: { name: "must-rollback" },
    });
    expect(failed.status).toBe(500);
    const orphan = await raw.execute({
      sql: "SELECT id FROM projects WHERE name = ?",
      args: ["must-rollback"],
    });
    expect(orphan.rows).toHaveLength(0);

    await raw.execute("DROP TRIGGER reject_project_owner_membership");
    const retry = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "atomic-project-create-retry",
      },
      json: { name: "must-rollback" },
    });
    expect(retry.status).toBe(200);
  });

  it("creates a control-plane project without minting an application telemetry key", async () => {
    const { apiKey } = await signup("dan@example.com");
    const create = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "idempotency-key": "control-plane-project-create",
      },
      json: { name: "musicvideogen" },
    });
    expect(create.status).toBe(200);
    const proj = (await create.json()) as {
      id: string;
      next_action: string;
      deploys_note: string;
    };
    expect(proj.id).toMatch(/-/);
    expect(proj).not.toHaveProperty("public_api_key");
    expect(proj).not.toHaveProperty("server_api_key");
    expect(proj.next_action).toContain("PostHog OAuth");
    expect(proj.next_action).toContain("customer-owned PostHog Cloud project");
    expect(proj.deploys_note).toContain("AGENTRY_CI_API_KEY");

    const detail = await call(`/v1/projects/${proj.id}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(detail.status).toBe(200);
    const detailJson = (await detail.json()) as { next_action: string };
    expect(detailJson).not.toHaveProperty("public_api_key");
    expect(detailJson.next_action).toContain("PostHog OAuth connection");
    expect(detailJson.next_action).toContain("never provision, mutate, or delete");
  });

  it("lists projects without public keys", async () => {
    const { apiKey } = await signup("erin@example.com");
    await createProject(apiKey, "p1");
    await createProject(apiKey, "p2");
    const res = await call("/v1/projects", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const data = (await res.json()) as {
      projects: Array<{ name: string; public_api_key?: string; public_key?: string; dsn?: string }>;
    };
    expect(data.projects).toHaveLength(2);
    for (const p of data.projects) {
      expect(p.public_api_key).toBeUndefined();
      expect(p.public_key).toBeUndefined();
      expect(p.dsn).toBeUndefined();
    }
  });

  it("lets owners delete disposable Agentry projects without touching customer PostHog data", async () => {
    // Durable deletion uses an interactive transaction; libSQL in-memory
    // connections do not share transaction state.
    env = await makeTestEnv({ fileDb: true });
    app = createApp();
    const owner = await signup("delete-owner@example.com");
    const other = await signup("delete-other@example.com");
    const proj = await createProject(owner.apiKey, "delete-me");

    const forbidden = await call(`/v1/projects/${proj.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${other.apiKey}` },
    });
    expect(forbidden.status).toBe(403);

    const detailBeforeDelete = await call(`/v1/projects/${proj.id}`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(detailBeforeDelete.status).toBe(200);
    expect(detailBeforeDelete.headers.get("cache-control")).toContain(
      "no-store",
    );
    expect(detailBeforeDelete.headers.get("vary")).toContain("Authorization");

    const deleted = await call(`/v1/projects/${proj.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${owner.apiKey}`,
        "idempotency-key": "delete-project-stable-0001",
      },
    });
    expect(deleted.status).toBe(200);
    const deletedJson = (await deleted.json()) as {
      id: string;
      deleted: boolean;
      cleanup: Record<string, unknown>;
      next_action: string;
    };
    expect(deletedJson.id).toBe(proj.id);
    expect(deletedJson.deleted).toBe(true);
    expect(deletedJson.cleanup.customer_posthog_data_affected).toBe(false);
    expect(deletedJson.next_action).toContain("Customer-owned PostHog data is untouched");

    const audit = await call("/v1/audit/recent?action_prefix=project.deleted", {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(audit.status).toBe(200);
    const auditJson = await audit.json() as {
      actions: Array<{ phase: string; project_id: string | null; resource_id: string }>;
    };
    expect(auditJson.actions).toEqual([
      expect.objectContaining({
        phase: "succeeded",
        project_id: null,
        resource_id: proj.id,
      }),
    ]);
    const auditAttempts = await call(
      "/v1/audit/recent?action_prefix=project.deleted&include_attempts=true",
      { headers: { authorization: `Bearer ${owner.apiKey}` } },
    );
    const attemptJson = await auditAttempts.json() as {
      actions: Array<{ phase: string; project_id: string | null; resource_id: string }>;
    };
    expect(attemptJson.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "intent", project_id: proj.id, resource_id: proj.id }),
      expect.objectContaining({ phase: "succeeded", project_id: null, resource_id: proj.id }),
    ]));

    const list = await call("/v1/projects", {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    const listJson = (await list.json()) as { projects: Array<{ id: string }> };
    expect(
      listJson.projects.find((project) => project.id === proj.id),
    ).toBeUndefined();

    const detail = await call(`/v1/projects/${proj.id}`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(detail.status).toBe(404);
  });

  it("rejects access to another user's project (tenancy)", async () => {
    const a = await signup("a@example.com");
    const b = await signup("b@example.com");
    const projA = await createProject(a.apiKey, "secret");
    const res = await call(`/v1/projects/${projA.id}`, {
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("forbidden");
  });

  it("returns 404 for unknown project id", async () => {
    const { apiKey } = await signup("frank@example.com");
    const res = await call(
      "/v1/projects/00000000-0000-0000-0000-000000000000",
      {
        headers: { authorization: `Bearer ${apiKey}` },
      },
    );
    expect(res.status).toBe(404);
  });

  it("keeps the approved signal map as the authenticated daily read", async () => {
    const owner = await signup("signal-map-daily-owner@example.com");
    const intruder = await signup("signal-map-daily-intruder@example.com");
    const project = await createProject(owner.apiKey, "signal-map-daily-read");
    expect((await call(`/v1/projects/${project.id}/signal-map`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    })).status).toBe(404);
    const plan = await seedApprovedOnboardingPlan({
      db: getDbForUrl(env.TURSO_DATABASE_URL),
      project_id: project.id,
      approved_events: ["signup_completed", "workspace_activated"],
      approved_plan_hash: "a".repeat(64),
    });

    const response = await call(`/v1/projects/${project.id}/signal-map`, {
      headers: { authorization: `Bearer ${owner.apiKey}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project_id: project.id,
      contract_version: "3",
      mode: "onboarding_v3",
      business_question: plan.business_question,
      milestones: plan.milestones,
      failures: plan.failures,
      deploy: plan.deploy,
      receipt: null,
    });
    expect(response.headers.get("etag")).toMatch(/^"[a-f0-9]{64}"$/);
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect((await call(`/v1/projects/${project.id}/signal-map`, {
      headers: { authorization: `Bearer ${intruder.apiKey}` },
    })).status).toBe(403);

    const verifiedProject = await createProject(
      owner.apiKey,
      "signal-map-verified-receipt",
    );
    await seedVerifiedOnboardingReadiness({
      db: getDbForUrl(env.TURSO_DATABASE_URL),
      project_id: verifiedProject.id,
      approved_events: ["attempt_started", "value_received"],
      approved_plan_hash: "b".repeat(64),
    });
    const verifiedOnboarding = await call(
      `/v1/projects/${verifiedProject.id}/onboarding`,
      { headers: { authorization: `Bearer ${owner.apiKey}` } },
    );
    const verifiedMap = await call(
      `/v1/projects/${verifiedProject.id}/signal-map`,
      { headers: { authorization: `Bearer ${owner.apiKey}` } },
    );
    const verifiedStateJson = (await verifiedOnboarding.json()) as {
      receipt: unknown;
    };
    const verifiedMapJson = (await verifiedMap.json()) as Record<string, unknown>;
    expect(verifiedMapJson.receipt).toEqual(verifiedStateJson.receipt);
    expect(verifiedMapJson.receipt).not.toBeNull();
    expect(verifiedMapJson.proof_session).toBeUndefined();
    expect(verifiedMapJson.one_time_markers).toBeUndefined();
    expect(verifiedMapJson.credentials).toBeUndefined();
  });

});
