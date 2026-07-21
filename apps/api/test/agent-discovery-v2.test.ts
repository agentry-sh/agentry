import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");
const { mutationRecoveryInventory } = await import("../src/mutation-route-policy.js");
const {
  PUBLIC_AGENT_REFERENCE_URL,
  PUBLIC_INSTALL_DOC_URL,
  PUBLIC_REPOSITORY_URL,
  PUBLIC_SKILL_URL,
} = await import("../src/public-links.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  env = await makeTestEnv();
  app = createApp();
});

async function call(path: string): Promise<Response> {
  return app.fetch(new Request(`http://test${path}`), env);
}

describe("progressive agent discovery", () => {
  it("routes root discovery directly to the automation guide, flow, and catalog", async () => {
    const response = await call("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repository?: string;
      docs?: string;
      install_docs?: string;
      skill?: string;
      automation_docs?: string;
      automation_flow?: string;
      automation_playbooks?: string;
      automation_workflow_components?: string;
      automation_workflow_contracts?: string;
      automation_workflow_control?: string;
      quick_start?: Array<{ when?: string; urls?: string[]; action?: string }>;
      next_action?: string;
    };

    expect(body.repository).toBe(PUBLIC_REPOSITORY_URL);
    expect(body.docs).toBe(PUBLIC_AGENT_REFERENCE_URL);
    expect(body.install_docs).toBe(PUBLIC_INSTALL_DOC_URL);
    expect(body.skill).toBe(PUBLIC_SKILL_URL);
    expect(body.automation_docs).toBe("/v1/docs/automation");
    expect(body.automation_flow).toBe("/v1/openapi.json?flow=automation");
    expect(body.automation_playbooks).toBe("/v1/automation-playbooks");
    expect(body.automation_workflow_components).toBe(
      "/v1/automation-workflow-components",
    );
    expect(body.automation_workflow_contracts).toBe(
      "/v1/automation-workflow-contracts",
    );
    expect(body.automation_workflow_control).toBe(
      "/v1/projects/:project_id/automation-workflow-control",
    );
    expect(body.quick_start).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          when: "agentic_automation",
          urls: expect.arrayContaining([
            "/v1/docs/automation",
            "/v1/openapi.json?flow=automation",
            "/v1/automation-workflow-components",
            "/v1/automation-workflow-contracts",
            "/v1/projects/:project_id/automation-workflow-control",
            "/v1/automation-playbooks",
            "/v1/projects/:project_id/automation-control",
          ]),
        }),
      ]),
    );
    expect(body.next_action).toContain("automation starts at /v1/docs/automation");
  });

  it("advertises current automation principals and invariants in capabilities", async () => {
    const response = await call("/v1/capabilities");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      auth_types?: Record<string, string>;
      surfaces?: {
        automation?: Record<string, unknown>;
      };
      capabilities?: Array<{
        id?: string;
        auth?: string[];
        invariants?: string[];
      }>;
    };

    expect(body.auth_types).toEqual(
      expect.objectContaining({
        ci_deploy: expect.stringContaining("agentry_ci_"),
        automation_runner: expect.stringContaining("agentry_runner_"),
      }),
    );
    expect(body.auth_types).not.toHaveProperty("public_ingest");
    expect(body.auth_types).not.toHaveProperty("server_ingest");
    expect(body.surfaces?.automation).toEqual(
      expect.objectContaining({
        guide_url: "/v1/docs/automation",
        flow_schema_url: "/v1/openapi.json?flow=automation",
        playbook_catalog_url: "/v1/automation-playbooks",
        workflow_component_catalog_url: "/v1/automation-workflow-components",
        workflow_contract_catalog_url: "/v1/automation-workflow-contracts",
        workflow_control_url:
          "/v1/projects/{project_id}/automation-workflow-control",
        versions: {
          automation_contract: "2",
          workflow_definition: "3",
          workflow_runtime: "1",
        },
      }),
    );
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automation_workflow_v3",
          auth: ["api_key", "ci_deploy", "automation_runner"],
          invariants: expect.arrayContaining([
            expect.stringContaining("supplies only trigger_receipt_id"),
            expect.stringContaining("recoverable next_action"),
            expect.stringContaining("reconciliation-only"),
            expect.stringContaining("minute sweep issues receipts"),
          ]),
        }),
        expect.objectContaining({
          id: "automation_v2",
          auth: ["api_key", "ci_deploy", "automation_runner"],
          invariants: expect.arrayContaining([
            expect.stringContaining("zero traffic never proves success"),
            expect.stringContaining("remain private"),
            expect.stringContaining("pre-claim evidence source"),
            expect.stringContaining("exact runner credential"),
          ]),
        }),
      ]),
    );
  });

  it("derives mutation recovery discovery from executable policy and removes the public-query key alias", async () => {
    const expected = mutationRecoveryInventory();
    const response = await call("/v1/capabilities");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      auth_types?: Record<string, string>;
      capabilities?: Array<{
        id?: string;
        source?: string;
        endpoint_count?: number;
        endpoints?: string[];
        operations?: unknown[];
      }>;
    };
    const recovery = body.capabilities?.find((item) => item.id === "mutation_recovery");
    expect(recovery).toMatchObject({
      source: expect.stringContaining("MUTATION_ROUTE_POLICIES"),
      endpoint_count: expected.length,
      endpoints: expected.map((item) => item.operation),
      operations: expected,
    });
    expect(body.auth_types?.public_query_url).toContain("complete URL");
    expect(body.auth_types?.public_query_url).not.toContain("agp_");

    const publicationSchema = await call(
      "/v1/openapi.json?path=%2Fv1%2Fpublic%2Fq%2F%7Bpublication_id%7D&method=get",
    );
    expect(publicationSchema.status).toBe(200);
    const publication = (await publicationSchema.json()) as {
      operation?: { parameters?: Array<{ in?: string; name?: string }> };
    };
    expect(publication.operation?.parameters).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "query", name: "key" }),
    ]));

    const schema = await call("/v1/openapi.json");
    const openapi = (await schema.json()) as {
      "x-agentry-flows"?: { public_queries?: { invariants?: string[] } };
    };
    expect(openapi["x-agentry-flows"]?.public_queries?.invariants).toEqual(
      expect.arrayContaining([
        expect.stringContaining("complete unguessable publication URL is the visitor capability"),
      ]),
    );
  });

  it("makes automation a named OpenAPI flow instead of an inferred route hunt", async () => {
    const response = await call("/v1/openapi.json?index=true");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      available_flows?: string[];
      advanced_capability_groups?: Array<{
        id?: string;
        schema_filters?: string[];
        guide?: string;
        templates?: string;
        workflow_components?: string;
        workflow_contracts?: string;
        workflow_production_boundary?: string;
      }>;
      examples?: string[];
      next_action?: string;
    };

    expect(body.available_flows).toContain("automation");
    expect(body.examples).toContain("/v1/openapi.json?flow=automation");
    expect(body.advanced_capability_groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "automation",
          guide: "/v1/docs/automation",
          templates: "/v1/automation-playbooks",
          workflow_components: "/v1/automation-workflow-components",
          workflow_contracts: "/v1/automation-workflow-contracts",
          workflow_production_boundary: expect.stringContaining(
            "schedule cron + ordered funnel",
          ),
          schema_filters: expect.arrayContaining([
            "/v1/openapi.json?flow=automation",
          ]),
        }),
      ]),
    );
    expect(body.next_action).toContain("self-healing or scheduled agent workflows");
  });

  it("serves a cold-agent automation guide with production and recovery boundaries", async () => {
    const response = await call("/v1/docs/automation");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/markdown");
    const text = await response.text();

    expect(text.split("\n").length).toBeLessThan(260);
    expect(text.length).toBeLessThan(16_000);
    expect(text).toContain("/v1/openapi.json?flow=automation");
    expect(text).toContain("Workflow v3 production boundary");
    expect(text).toContain("trigger.schedule.cron@1.0.0");
    expect(text).toContain("agent.funnel-review@1.0.0");
    expect(text).toContain("Other graphs may compile and save disabled");
    expect(text).toContain("reconcile_only: true");
    expect(text).toContain("consumed_run_id");
    expect(text).toContain("execution_control");
    expect(text).toContain("missing/drifted execution authority");
    expect(text).toContain("active/contended system-node claim");
    expect(text).toContain("minute sweep only");
    expect(text).toContain("error-to-draft-pr@2.0.0");
    expect(text).toContain("weekly-funnel-review@2.0.0");
    expect(text).toContain("Application analytics and exceptions go directly");
    expect(text).toContain("customer's PostHog");
    expect(text).not.toContain("agentry_server_");
    expect(text).toContain("agentry_ci_");
    expect(text).toContain("agentry_runner_");
    expect(text).toContain("external_audit_saga");
    expect(text).toContain("/v1/projects/{project_id}/credentials");
    expect(text).not.toContain("internal key prefix `agp_`");
    expect(text).toContain("Idempotency-Key");
    expect(text).toContain("If-Match");
    expect(text).toContain("strict body is `{}`");
    expect(text).toContain("Zero traffic never proves success");
    expect(text).toContain("does not publish it");
    expect(text).toContain("This grants no merge, deploy,");
    expect(text).toContain("rollback, workflow-edit, or direct-push authority");
    expect(text).toContain("pre-claim source");
    expect(text).toContain("current, unexpired, and");
    expect(text).toContain("unreleased");
    expect(text).not.toContain("/v1/cases/:case_id/runs");
    expect(text).not.toContain("record_run_only");
    expect(text).not.toContain("open_pr");
    expect(text).not.toContain("X-Agentry-Webhook-Id");
    expect(text).not.toContain("caller-supplied passed");
  });

  it("does not duplicate canonical repository Markdown on the API", async () => {
    for (const path of [
      "/agentry.md",
      "/install.md",
      "/skill/agentry/SKILL.md",
    ]) {
      expect((await call(path)).status).toBe(404);
    }
  });
});
