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

type JsonRecord = Record<string, unknown>;
type JsonSchema = JsonRecord & {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: unknown;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  maxItems?: number;
  dependentRequired?: Record<string, string[]>;
};
type OpenApiOperation = JsonRecord & {
  operationId?: string;
  parameters?: JsonRecord[];
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: JsonSchema }> }
  >;
  security?: Array<Record<string, string[]>>;
};
type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<string, JsonRecord>;
  };
};

const AUTOMATION_OPERATIONS = [
  [
    "get",
    "/v1/automation-workflow-components",
    "list_automation_workflow_components",
  ],
  [
    "get",
    "/v1/automation-workflow-contracts",
    "list_automation_workflow_contracts",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/compile",
    "compile_automation_workflow",
  ],
  [
    "put",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}",
    "save_disabled_automation_workflow",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}",
    "get_automation_workflow",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflow-control",
    "get_automation_workflow_project_control",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflow-control/pause",
    "pause_automation_workflow_project",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflow-control/resume",
    "resume_automation_workflow_project",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/readiness",
    "get_automation_workflow_readiness",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/enable",
    "enable_automation_workflow",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/pause",
    "pause_automation_workflow",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/issue",
    "issue_automation_workflow_trigger_receipts",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts",
    "list_automation_workflow_trigger_receipts",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/{receipt_id}",
    "get_automation_workflow_trigger_receipt",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs",
    "start_automation_workflow_run",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs",
    "list_automation_workflow_runs",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}",
    "get_automation_workflow_run",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease",
    "acquire_automation_workflow_run_lease",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease/renew",
    "renew_automation_workflow_run_lease",
  ],
  [
    "delete",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease",
    "release_automation_workflow_run_lease",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/commands",
    "apply_automation_workflow_command",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/cancel",
    "cancel_automation_workflow_run",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/advance",
    "advance_automation_workflow_system_nodes",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}",
    "get_automation_workflow_effect",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}/reconcile",
    "reconcile_automation_workflow_effect",
  ],
  ["get", "/v1/automation-playbooks", "list_automation_playbooks"],
  ["get", "/v1/automation-playbooks/{id}", "get_automation_playbook"],
  [
    "post",
    "/v1/projects/{project_id}/automation-playbooks/{id}/render",
    "render_automation_playbook",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-control",
    "get_automation_control",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-contract",
    "get_automation_contract",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-contract/validate",
    "validate_automation_contract",
  ],
  [
    "put",
    "/v1/projects/{project_id}/automation-contract",
    "put_automation_contract",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-contract/enable",
    "enable_automation_contract",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-contract/pause",
    "pause_automation_contract",
  ],
  [
    "patch",
    "/v1/projects/{project_id}/automation-contract/automations/{automation_id}",
    "set_automation_enabled",
  ],
  [
    "get",
    "/v1/projects/{project_id}/credentials",
    "list_project_credentials",
  ],
  [
    "post",
    "/v1/projects/{project_id}/credentials",
    "create_project_credential",
  ],
  [
    "post",
    "/v1/project-credentials/{credential_id}/revoke",
    "revoke_project_credential",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-triggers/issue",
    "issue_automation_triggers",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-trigger-receipts",
    "list_automation_trigger_receipts",
  ],
  [
    "get",
    "/v1/automation-trigger-receipts/{receipt_id}",
    "get_automation_trigger_receipt",
  ],
  ["post", "/v1/cases/{case_id}/claims", "claim_case"],
  ["get", "/v1/cases/{case_id}/claims/active", "get_active_case_claim"],
  [
    "post",
    "/v1/cases/{case_id}/claims/{claim_id}/renew",
    "renew_case_claim",
  ],
  [
    "post",
    "/v1/cases/{case_id}/claims/{claim_id}/release",
    "release_case_claim",
  ],
  [
    "post",
    "/v1/projects/{project_id}/automation-runs",
    "start_automation_run",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-runs",
    "list_automation_runs",
  ],
  ["get", "/v1/automation-runs/{run_id}", "get_automation_run"],
  ["post", "/v1/automation-runs/{run_id}/cancel", "cancel_automation_run"],
  [
    "post",
    "/v1/automation-runs/{run_id}/approvals",
    "request_automation_approval",
  ],
  [
    "get",
    "/v1/projects/{project_id}/automation-approvals",
    "list_automation_approvals",
  ],
  [
    "post",
    "/v1/automation-approvals/{approval_id}/decide",
    "decide_automation_approval",
  ],
  [
    "post",
    "/v1/automation-runs/{run_id}/actions/draft-pr/authorize",
    "authorize_draft_pr",
  ],
  [
    "post",
    "/v1/automation-runs/{run_id}/actions/draft-pr/consume",
    "consume_draft_pr_grant",
  ],
  [
    "post",
    "/v1/automation-runs/{run_id}/usage",
    "report_automation_usage",
  ],
  [
    "post",
    "/v1/automation-runs/{run_id}/report-source",
    "get_automation_report_source",
  ],
  [
    "post",
    "/v1/automation-runs/{run_id}/actions/record-report",
    "record_automation_report",
  ],
  ["patch", "/v1/automation-runs/{run_id}", "update_automation_run"],
  [
    "post",
    "/v1/automation-runs/{run_id}/pr-proof",
    "record_automation_pr_proof",
  ],
  ["post", "/v1/deploys/", "record_deploy"],
  ["post", "/v1/automation-runs/{run_id}/verify", "verify_automation_run"],
  ["delete", "/v1/projects/{project_id}", "delete_project"],
  ["post", "/v1/auth/self_delete", "self_delete_account"],
] as const;

const AUTOMATION_FLOW_DEPENDENCIES = [
  ["get", "/v1/projects/{project_id}/signal-map"],
  ["get", "/v1/projects/{project_id}/onboarding"],
  ["get", "/v1/cases/{case_id}"],
] as const;

const app = createApp();
let env: TestEnv;

beforeAll(async () => {
  env = await makeTestEnv();
});

async function call(path: string): Promise<Response> {
  return app.fetch(new Request(`http://test${path}`), env);
}

async function openApi(): Promise<OpenApiDocument> {
  const response = await call("/v1/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as OpenApiDocument;
}

function dereferenceFilteredValue(
  root: JsonRecord,
  value: unknown,
  seen = new Set<string>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => dereferenceFilteredValue(root, item, seen));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as JsonRecord;
  const ref = typeof record.$ref === "string" ? record.$ref : null;
  if (ref?.startsWith("#/")) {
    let resolved: unknown = root;
    for (const rawPart of ref.slice(2).split("/")) {
      const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
        resolved = undefined;
        break;
      }
      resolved = (resolved as JsonRecord)[part];
    }
    if (resolved !== undefined && !seen.has(ref)) {
      const nextSeen = new Set(seen);
      nextSeen.add(ref);
      const dereferenced = dereferenceFilteredValue(root, resolved, nextSeen);
      const siblings = Object.fromEntries(
        Object.entries(record)
          .filter(([key]) => key !== "$ref")
          .map(([key, item]) => [
            key,
            dereferenceFilteredValue(root, item, seen),
          ]),
      );
      return dereferenced && typeof dereferenced === "object" && !Array.isArray(dereferenced)
        ? { ...(dereferenced as JsonRecord), ...siblings }
        : dereferenced;
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      dereferenceFilteredValue(root, item, seen),
    ]),
  );
}

async function filteredOperation(
  method: string,
  path: string,
): Promise<OpenApiOperation> {
  const response = await call(
    `/v1/openapi.json?path=${encodeURIComponent(path)}&method=${method}`,
  );
  expect(
    response.status,
    `${method.toUpperCase()} ${path} must support filtered schema lookup`,
  ).toBe(200);
  const body = (await response.json()) as JsonRecord & {
    operation?: OpenApiOperation;
  };
  expect(body.operation).toBeDefined();
  return (dereferenceFilteredValue(body, body.operation) ?? {}) as OpenApiOperation;
}

function requestSchema(operation: OpenApiOperation): JsonSchema {
  const schema =
    operation.requestBody?.content?.["application/json"]?.schema;
  expect(schema, "operation must document its JSON request schema").toBeDefined();
  return schema ?? {};
}

function responseSchema(
  operation: OpenApiOperation,
  status: string,
): JsonSchema {
  const schema =
    operation.responses?.[status]?.content?.["application/json"]?.schema;
  expect(
    schema,
    `operation must document its ${status} JSON response schema`,
  ).toBeDefined();
  return schema ?? {};
}

function property(schema: JsonSchema, name: string): JsonSchema {
  const value = schema.properties?.[name];
  expect(value, `schema must expose property ${name}`).toBeDefined();
  return value ?? {};
}

function arrayItems(schema: JsonSchema): JsonSchema {
  expect(schema.type).toBe("array");
  expect(schema.items, "array schema must document its item shape").toBeDefined();
  return schema.items ?? {};
}

function expectProperties(schema: JsonSchema, names: string[]): void {
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...names].sort());
}

function expectRequired(schema: JsonSchema, names: string[]): void {
  expect([...(schema.required ?? [])].sort()).toEqual([...names].sort());
}

function expectClosedObject(schema: JsonSchema, names: string[]): void {
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expectProperties(schema, names);
}

function expectLiteral(schema: JsonSchema, expected: unknown): void {
  const values = schema.const !== undefined ? [schema.const] : schema.enum;
  expect(values).toEqual([expected]);
}

function unionBranches(schema: JsonSchema): JsonSchema[] {
  const branches = schema.oneOf ?? schema.anyOf;
  expect(branches, "schema must use an explicit oneOf/anyOf union").toBeDefined();
  return branches ?? [];
}

function branchForLiteral(
  schema: JsonSchema,
  propertyName: string,
  literal: string,
): JsonSchema {
  const branch = unionBranches(schema).find((candidate) => {
    const discriminator = candidate.properties?.[propertyName];
    return discriminator?.const === literal ||
      (Array.isArray(discriminator?.enum) &&
        discriminator.enum.length === 1 &&
        discriminator.enum[0] === literal);
  });
  expect(
    branch,
    `union must contain ${propertyName}=${literal}`,
  ).toBeDefined();
  return branch ?? {};
}

function parameter(
  operation: OpenApiOperation,
  location: string,
  name: string,
): JsonRecord | undefined {
  return operation.parameters?.find(
    (candidate) =>
      candidate.in === location &&
      String(candidate.name).toLowerCase() === name.toLowerCase(),
  );
}

function expectRequiredHeader(
  operation: OpenApiOperation,
  name: string,
): void {
  const header = parameter(operation, "header", name);
  expect(header, `operation must document ${name} header`).toBeDefined();
  expect(header?.required, `${name} must be required`).toBe(true);
}

function expectRunBinding(
  paramsSchema: JsonSchema,
  name: string,
  field: string,
): void {
  const binding = property(paramsSchema, name);
  expectClosedObject(binding, ["source", "field"]);
  expectRequired(binding, ["source", "field"]);
  expectLiteral(property(binding, "source"), "run");
  expectLiteral(property(binding, "field"), field);
}

function expectVerificationSample(sample: JsonSchema): void {
  expectClosedObject(sample, [
    "state",
    "blueprint_id",
    "event_name",
    "sample_count",
    "min_sample_size",
    "rows",
    "window",
    "input_readiness",
    "data_boundary",
  ]);
  expectLiteral(property(sample, "blueprint_id"), "automation_deploy_traffic_sample");
  expect(property(sample, "sample_count").type).toBe("integer");
  expect(property(sample, "min_sample_size").type).toBe("integer");
  const window = property(sample, "window");
  expectClosedObject(window, ["start_at", "end_at", "bounds"]);
  expectLiteral(property(window, "bounds"), "[start,end)");
}

function expectVerificationOutcome(outcome: JsonSchema): void {
  const notExecuted = branchForLiteral(outcome, "state", "not_executed");
  expectClosedObject(notExecuted, [
    "state",
    "blueprint_id",
    "reason",
    "rows",
    "window",
    "data_boundary",
  ]);
  expectLiteral(
    property(notExecuted, "blueprint_id"),
    "automation_case_recurrence_after_deploy",
  );
  expectLiteral(property(notExecuted, "reason"), "sample_gate_not_met");

  const evaluated = branchForLiteral(outcome, "state", "evaluated");
  expectClosedObject(evaluated, [
    "state",
    "blueprint_id",
    "recurrence_count",
    "predicate",
    "passed",
    "rows",
    "window",
    "data_boundary",
  ]);
  expectLiteral(
    property(evaluated, "blueprint_id"),
    "automation_case_recurrence_after_deploy",
  );
  const predicate = property(evaluated, "predicate");
  expectClosedObject(predicate, ["column", "reducer", "operator", "value"]);
  expectLiteral(property(predicate, "column"), "recurrence_count");
  expectLiteral(property(predicate, "reducer"), "first");
  expectLiteral(property(predicate, "operator"), "eq");
  expectLiteral(property(predicate, "value"), 0);
}

describe("automation v2 OpenAPI contract", () => {
  it("publishes closed run, trigger, evidence, control, and pagination schemas", async () => {
    const listRuns = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-runs",
    );
    expect(parameter(listRuns, "query", "cursor")?.schema).toMatchObject({
      type: "string",
      maxLength: 1_000,
    });
    const runList = responseSchema(listRuns, "200");
    expectClosedObject(runList, ["runs", "pagination", "next_action"]);
    const run = arrayItems(property(runList, "runs"));
    for (const field of [
      "data_boundary",
      "runner",
      "control",
      "trigger_receipt",
      "runner_output",
    ]) {
      expect(property(run, field).additionalProperties).toBe(false);
    }
    expectClosedObject(property(run, "runner"), [
      "provider",
      "id",
      "credential_id",
      "model",
    ]);
    expectClosedObject(property(run, "trigger_receipt"), [
      "id",
      "source",
      "eligibility_authority",
      "instruction_authority",
      "trigger_ref",
      "observation",
      "inspection",
    ]);
    expectClosedObject(property(run, "runner_output"), [
      "source",
      "instruction_authority",
      "evidence",
      "inspection",
    ]);

    const detail = await filteredOperation("get", "/v1/automation-runs/{run_id}");
    const detailSchema = responseSchema(detail, "200");
    expectClosedObject(arrayItems(property(detailSchema, "events")), [
      "id",
      "event",
      "from_status",
      "to_status",
      "actor",
      "data",
      "at",
    ]);

    const listReceipts = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-trigger-receipts",
    );
    expect(parameter(listReceipts, "query", "cursor")).toBeDefined();
    const receiptList = responseSchema(listReceipts, "200");
    expectClosedObject(receiptList, [
      "data_boundary",
      "filters",
      "receipts",
      "pagination",
      "next_action",
    ]);
    const receipt = arrayItems(property(receiptList, "receipts"));
    for (const field of ["trigger", "proof", "binding", "validity", "authority"]) {
      expect(property(receipt, field).additionalProperties).toBe(false);
    }

    const listApprovals = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-approvals",
    );
    expect(parameter(listApprovals, "query", "cursor")).toBeDefined();
    expectClosedObject(responseSchema(listApprovals, "200"), [
      "approvals",
      "pagination",
      "next_action",
    ]);

    const control = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-control",
    );
    const controlSchema = responseSchema(control, "200");
    const attention = arrayItems(property(controlSchema, "attention"));
    expect(attention.required).toEqual(expect.arrayContaining([
      "message",
      "next_action",
      "operator_remediation_required",
      "operation",
    ]));
    expect(property(attention, "operation").additionalProperties).toBe(false);
    const controls = property(controlSchema, "controls");
    expect(controls.properties).not.toHaveProperty("manage_credentials");
    expectLiteral(property(property(controls, "list_credentials"), "method"), "GET");
    const createCredential = property(controls, "create_credential");
    expectLiteral(property(createCredential, "method"), "POST");
    expect(property(createCredential, "required_headers")).toMatchObject({
      minItems: 1,
      maxItems: 1,
    });
  });

  it("documents the bounded secret-free automation deletion manifest", async () => {
    for (const [method, path] of [
      ["delete", "/v1/projects/{project_id}"],
      ["post", "/v1/auth/self_delete"],
    ] as const) {
      const operation = await filteredOperation(method, path);
      const response = responseSchema(operation, "200");
      const cleanup = property(response, "cleanup");
      const manifest = property(cleanup, "automation_deletion_manifest");
      expect(manifest.required).toEqual(expect.arrayContaining([
        "as_of",
        "project_ids",
        "sample_limit",
        "counts",
        "samples",
        "samples_truncated",
        "external_follow_up",
      ]));
      expect(property(manifest, "sample_limit").const).toBe(20);
      expect(property(manifest, "samples").maxItems).toBe(20);
      const counts = property(manifest, "counts");
      expect(counts.required).toEqual(expect.arrayContaining([
        "enabled_schedules",
        "active_runner_credentials",
        "nonterminal_runs",
        "active_claims",
        "pending_approvals",
        "issued_or_consumed_draft_pr_grants",
        "known_external_effects",
        "possible_or_unknown_external_effects",
        "workflow_v3_project_controls",
        "workflow_v3_workflows",
        "workflow_v3_revisions",
        "workflow_v3_execution_authorities",
        "workflow_v3_trigger_receipts",
        "workflow_v3_runs",
        "workflow_v3_system_node_claims",
        "workflow_v3_run_leases",
        "workflow_v3_budget_charges",
        "workflow_v3_run_states",
        "workflow_v3_commands",
        "workflow_v3_run_events",
        "workflow_v3_suspensions",
        "workflow_v3_effects",
        "workflow_v3_effect_events",
        "workflow_v3_enabled_workflows",
        "workflow_v3_ready_trigger_receipts",
        "workflow_v3_nonterminal_runs",
        "workflow_v3_active_leases",
        "workflow_v3_active_system_node_claims",
        "workflow_v3_pending_suspensions",
        "workflow_v3_external_reserved_effects",
        "workflow_v3_external_indeterminate_effects",
        "workflow_v3_external_manual_follow_up_effects",
        "workflow_v3_external_succeeded_effects",
      ]));
      const sample = arrayItems(property(manifest, "samples"));
      expect(property(sample, "kind").enum).toEqual(expect.arrayContaining([
        "workflow_v3_enabled_workflow",
        "workflow_v3_trigger_receipt",
        "workflow_v3_nonterminal_run",
        "workflow_v3_active_lease",
        "workflow_v3_active_system_node_claim",
        "workflow_v3_pending_suspension",
        "workflow_v3_effect",
      ]));
      expect(property(sample, "provider_ref")).toBeDefined();
      expect(property(sample, "provider_ref").maxLength).toBe(500);
      const followUp = property(manifest, "external_follow_up");
      expect(property(followUp, "provider_state_reversible_by_agentry").const).toBe(false);
      expect(property(followUp, "actions").type).toBe("array");
    }
  });

  it("publishes exact mutation recovery and one-time secret semantics", async () => {
    const operations = [
      ["post", "/v1/projects", "create_project"],
      ["post", "/v1/auth/keys/rotate", "rotate_owner_key"],
      ["post", "/v1/auth/keys/{key_id}/revoke", "revoke_owner_key"],
      ["post", "/v1/projects/{project_id}/credentials", "create_project_credential"],
      ["post", "/v1/projects/{project_id}/webhooks", "create_webhook"],
      ["post", "/v1/projects/{project_id}/webhooks/{id}/test", "test_webhook"],
    ] as const;

    for (const [method, path, operationId] of operations) {
      const operation = await filteredOperation(method, path);
      expect(operation.operationId).toBe(operationId);
      expectRequiredHeader(operation, "Idempotency-Key");
      const idempotency = parameter(operation, "header", "Idempotency-Key");
      expect(idempotency?.schema).toMatchObject({ minLength: 8, maxLength: 500 });
      expect(operation.responses?.["409"]).toBeDefined();
    }

    for (const path of [
      "/v1/auth/keys/rotate",
      "/v1/projects/{project_id}/webhooks/{id}/test",
    ]) {
      const operation = await filteredOperation("post", path);
      expect(operation.requestBody).toBeUndefined();
      expect(operation["x-agentry-request-body"]).toBe("none");
    }

    const projectCreate = await filteredOperation("post", "/v1/projects");
    expect(projectCreate.description).toContain("commit atomically");
    expect(projectCreate.description).toContain("same Agentry project");
    expect(projectCreate.description).toContain("never provision or mutate PostHog");

    const ownerRotate = await filteredOperation("post", "/v1/auth/keys/rotate");
    expect(ownerRotate.description).toContain("current key remains active");
    expect(ownerRotate.description).toContain("hash-only");

    const credential = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/credentials",
    );
    expect(credential.description).toContain("hash-only");
    expect(credential.description).toContain("never mints another active secret");

    const webhookCreate = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/webhooks",
    );
    expect(webhookCreate.description).toContain("same encrypted signing secret");
    expect(responseSchema(webhookCreate, "200").required).toEqual(
      expect.arrayContaining(["signing_secret", "idempotent_replay"]),
    );

    const keyList = await filteredOperation("get", "/v1/auth/keys");
    const keyMetadata = arrayItems(property(responseSchema(keyList, "200"), "keys"));
    expectClosedObject(keyMetadata, [
      "id",
      "prefix",
      "name",
      "created_at",
      "last_used_at",
      "revoked_at",
      "active",
      "current",
    ]);
    expect(keyMetadata.properties).not.toHaveProperty("api_key");
  });

  it("documents every automation operation with a stable unique operationId", async () => {
    const schema = await openApi();
    const operationIds: string[] = [];

    expect(schema.paths).not.toHaveProperty(
      "/v1/automation-runs/{run_id}/actions/suppress-issue",
    );
    expect(JSON.stringify(schema)).not.toContain('"suppress_issue"');

    for (const [method, path, operationId] of AUTOMATION_OPERATIONS) {
      const operation = schema.paths[path]?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${path} is missing from OpenAPI`,
      ).toBeDefined();
      expect(operation?.operationId).toBe(operationId);
      operationIds.push(operation?.operationId ?? "");
    }

    expect(new Set(operationIds).size).toBe(AUTOMATION_OPERATIONS.length);

    const allDocumentedOperationIds = Object.values(schema.paths).flatMap(
      (methods) => Object.values(methods)
        .map((operation) => operation.operationId)
        .filter((operationId): operationId is string =>
          typeof operationId === "string"
        ),
    );
    expect(new Set(allDocumentedOperationIds).size).toBe(
      allDocumentedOperationIds.length,
    );

    const documentedByRoute = new Map(
      AUTOMATION_OPERATIONS.map(([method, path, operationId]) => [
        `${method} ${path}`,
        operationId,
      ]),
    );
    for (const playbookId of ["error-to-draft-pr", "weekly-funnel-review"]) {
      const response = await call(`/v1/automation-playbooks/${playbookId}?version=2.0.0`);
      expect(response.status).toBe(200);
      const playbook = (await response.json()) as {
        related_operations?: Array<{
          operation_id?: string;
          method?: string;
          path?: string;
        }>;
      };
      for (const related of playbook.related_operations ?? []) {
        const path = String(related.path).replace(
          /:([A-Za-z_][A-Za-z0-9_]*)/g,
          "{$1}",
        );
        const route = `${String(related.method).toLowerCase()} ${path}`;
        expect(
          documentedByRoute.get(route),
          `${playbookId} related operation ${route} must resolve in OpenAPI`,
        ).toBe(related.operation_id);
      }
    }
  });

  it("publishes workflow v3 as a typed fail-closed production branch", async () => {
    const componentCatalog = await filteredOperation(
      "get",
      "/v1/automation-workflow-components",
    );
    expect(componentCatalog.security).toEqual([{ ApiKeyAuth: [] }]);
    const componentCatalogSchema = responseSchema(componentCatalog, "200");
    expectClosedObject(componentCatalogSchema, [
      "kind",
      "version_policy",
      "count",
      "components",
      "next_action",
    ]);
    expectLiteral(
      property(componentCatalogSchema, "kind"),
      "automation_workflow_component_catalog",
    );

    const contractCatalog = await filteredOperation(
      "get",
      "/v1/automation-workflow-contracts",
    );
    const contract = arrayItems(
      property(responseSchema(contractCatalog, "200"), "contracts"),
    );
    expectClosedObject(contract, [
      "ref",
      "id",
      "version",
      "title",
      "description",
      "instruction_authority",
      "minimum_assurance",
      "validator_semantics_version",
      "validator_semantics",
      "json_schema",
      "json_schema_hash",
      "schema_hash",
      "contract_hash",
    ]);
    expectLiteral(property(contract, "instruction_authority"), "none");
    expectLiteral(property(contract, "validator_semantics_version"), 1);

    const compile = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/compile",
    );
    expect(compile["x-agentry-authority"]).toBe("workflow_compile_only");
    expect(compile.description).toContain("side-effect-free");
    expect(compile.description).toContain("ready_to_enable=false");
    const definition = requestSchema(compile);
    expectClosedObject(definition, [
      "schema_version",
      "id",
      "name",
      "description",
      "runner",
      "limits",
      "entry",
      "nodes",
    ]);
    const valueRef = property(
      branchForLiteral(
        arrayItems(property(definition, "nodes")),
        "kind",
        "condition",
      ),
      "predicate",
    );
    const predicateValue = property(valueRef, "value");
    expect(predicateValue.required).toEqual(["node_id"]);

    const compileBranches = unionBranches(responseSchema(compile, "200"));
    const compileSuccess = compileBranches.find(
      (branch) => property(branch, "success").const === true,
    );
    expect(compileSuccess).toBeDefined();
    const compiled = property(compileSuccess ?? {}, "data");
    expectLiteral(property(property(compiled, "readiness"), "ready_to_enable"), false);
    const compileSideEffects = property(compiled, "compile_side_effects");
    for (const sideEffect of Object.values(compileSideEffects.properties ?? {})) {
      expectLiteral(sideEffect, false);
    }

    const save = await filteredOperation(
      "put",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}",
    );
    expect(save["x-agentry-authority"]).toBe("workflow_save_disabled_only");
    const ifMatch = parameter(save, "header", "If-Match");
    expect(ifMatch?.required).toBe(false);
    expect(ifMatch?.description).toContain("first time");
    expect(ifMatch?.schema).toMatchObject({
      pattern: '^"[A-Za-z0-9._:-]+"$',
    });
    expect(save.description).toContain("one project-wide namespace");
    expect(save.responses?.["409"]).toBeDefined();
    expect(save.responses?.["412"]).toBeDefined();
    expect(save.responses?.["422"]).toBeDefined();
    expect(save.responses?.["428"]).toBeDefined();
    const saved = responseSchema(save, "200");
    expect(property(saved, "enabled").type).toBe("boolean");
    expect(unionBranches(property(saved, "active_revision_id"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "string" }),
        expect.objectContaining({ type: "null" }),
      ]),
    );
    expect(property(saved, "paused_at")).toBeDefined();
    expect(property(saved, "pause_reason")).toBeDefined();
    expect(property(saved, "active_execution_authority_id")).toBeDefined();
    expect(property(saved, "created").type).toBe("boolean");
    expect(save.description).toContain("Saving never enables");

    const current = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}",
    );
    expect(property(responseSchema(current, "200"), "enabled").type).toBe(
      "boolean",
    );

    const readiness = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/readiness",
    );
    expect(readiness.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(readiness["x-agentry-readiness-fails-closed"]).toBe(true);
    expect(String(readiness.description)).toContain("scheduled-funnel component set");
    const readinessSchema = responseSchema(readiness, "200");
    expectClosedObject(readinessSchema, [
      "kind",
      "schema_version",
      "project_id",
      "automation_id",
      "revision_id",
      "revision",
      "etag",
      "workflow_hash",
      "compile_hash",
      "status",
      "readiness_hash",
      "owner_confirmed_caller_assertion_ids",
      "checks",
      "blockers",
      "next_action",
    ]);

    const enable = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/enable",
    );
    expect(enable.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(parameter(enable, "header", "If-Match")?.required).toBe(true);
    expect(parameter(enable, "header", "Idempotency-Key")?.required).toBe(true);
    expectClosedObject(requestSchema(enable), [
      "revision_id",
      "readiness_hash",
      "owner_confirmed_caller_assertion_ids",
    ]);
    const enableReceipt = responseSchema(enable, "200");
    expect(enableReceipt.required).toEqual(expect.arrayContaining([
      "execution_authority_id",
      "execution_descriptor_hash",
    ]));
    expect(property(enableReceipt, "execution_authority_id").pattern).toBe(
      "^[a-f0-9]{64}$",
    );
    expect(String(enable["x-agentry-execution-authority-binding"])).toContain(
      "immutable reviewed enablement descriptor",
    );

    const issue = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/issue",
    );
    expect(issue.security).toEqual([
      { ApiKeyAuth: [] },
      { AutomationRunnerAuth: [] },
    ]);
    expectClosedObject(requestSchema(issue), []);
    expect(String(issue["x-agentry-trigger-authority"])).toContain(
      "no caller-authored trigger facts",
    );
    const issuedReceipt = arrayItems(
      property(responseSchema(issue, "200"), "receipts"),
    );
    expect(issuedReceipt.required).toContain("execution_authority_id");
    expect(property(issuedReceipt, "execution_authority_id").pattern).toBe(
      "^[a-f0-9]{64}$",
    );

    const start = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs",
    );
    expect(start.security).toEqual([{ AutomationRunnerAuth: [] }]);
    expectClosedObject(requestSchema(start), ["trigger_receipt_id"]);
    expect(JSON.stringify(requestSchema(start))).not.toContain("trigger_output");
    expect(String(start.description)).toContain("commit transactionally");

    const run = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}",
    );
    const runSchema = responseSchema(run, "200");
    expect(runSchema.required).toEqual(expect.arrayContaining([
      "execution_authority_id",
      "execution_descriptor_hash",
      "authority",
      "execution_control",
      "next_action",
    ]));
    expect(property(runSchema, "execution_authority_id").pattern).toBe(
      "^[a-f0-9]{64}$",
    );

    const advance = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/advance",
    );
    expect(String(advance["x-agentry-system-claim"])).toContain("300-second");
    expect(JSON.stringify(advance["x-agentry-error-recovery"])).toContain(
      "automation_workflow_system_node_claim_fence_lost",
    );

    const commands = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/commands",
    );
    expect(commands.security).toEqual([
      { ApiKeyAuth: [] },
      { AutomationRunnerAuth: [] },
    ]);
    const commandJson = JSON.stringify(requestSchema(commands));
    for (const kind of [
      "component_succeeded",
      "component_domain_failed",
      "approval_decided",
      "effect_call_started",
      "effect_receipt_recorded",
    ]) {
      expect(commandJson).toContain(kind);
    }
    for (const forbidden of [
      '"tick"',
      '"effect_reconciled"',
      '"wait_resolved"',
      '"verification_resolved"',
      '"quarantine"',
      '"start"',
    ]) {
      expect(commandJson).not.toContain(forbidden);
    }
    expect(String(commands["x-agentry-effect-call-start-rule"])).toContain(
      "reconcile_only=true",
    );

    const effect = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}",
    );
    expect(effect.security).toEqual([
      { ApiKeyAuth: [] },
      { AutomationRunnerAuth: [] },
      { CiDeployAuth: [] },
    ]);
    expectLiteral(property(responseSchema(effect, "200"), "provider_call_authorized"), false);

    const reconcile = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}/reconcile",
    );
    expect(reconcile.security).toEqual([{ CiDeployAuth: [] }]);
    expect(parameter(reconcile, "header", "Idempotency-Key")?.required).toBe(true);
    expect(reconcile["x-agentry-provider-call-authorized"]).toBe(false);
    expectLiteral(
      property(responseSchema(reconcile, "200"), "provider_call_authorized"),
      false,
    );
  });

  it("returns a complete dependency-ordered automation flow", async () => {
    const response = await call("/v1/openapi.json?flow=automation");
    expect(response.status).toBe(200);
    const flow = (await response.json()) as {
      flow?: string;
      count?: number;
      definition?: {
        operations?: Array<{ method?: string; path?: string }>;
        states?: string[];
        invariants?: string[];
        branches?: {
          workflow_v3_scheduled_funnel_production?: string[];
          workflow_v3_recovery?: string[];
        };
      };
      paths?: Record<string, Record<string, OpenApiOperation>>;
      missing_operations?: unknown[];
    };
    expect(flow.flow).toBe("automation");
    expect(flow.missing_operations).toEqual([]);
    expect(flow.definition?.states).toEqual(
      expect.arrayContaining([
        "workflow_components_discovered",
        "workflow_candidate_compiled",
        "workflow_revision_saved_disabled",
        "workflow_readiness_reviewed",
        "workflow_exact_revision_enabled",
        "workflow_trigger_receipt_issued",
        "workflow_action_loaded",
        "workflow_lease_acquired_when_required",
        "workflow_effect_reconciled_when_required",
        "workflow_terminal_or_escalated",
        "template_selected",
        "disabled_candidate_rendered",
        "owner_enabled",
        "trigger_receipt_issued",
        "run_started",
        "human_review",
        "verified_or_reported",
        "stopped",
        "deletion_fenced",
        "external_follow_up_required",
      ]),
    );
    expect(flow.definition?.branches?.workflow_v3_scheduled_funnel_production).toEqual(
      expect.arrayContaining([
        expect.stringContaining("compile without writes or external actions"),
        expect.stringContaining("read readiness with confirm=scheduler_execution_configured"),
        expect.stringContaining("consume only server-issued trigger receipt ids"),
        expect.stringContaining("recoverable next_action"),
      ]),
    );
    expect(flow.definition?.branches?.workflow_v3_recovery).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reconciliation-only"),
        expect.stringContaining("stale revision or lease epoch"),
      ]),
    );
    expect(flow.definition?.invariants).toEqual(
      expect.arrayContaining([
        expect.stringContaining("trigger.schedule.cron@1.0.0"),
        expect.stringContaining("supply only trigger_receipt_id"),
        expect.stringContaining("replayed call-start is reconciliation-only"),
        expect.stringContaining("minute sweep issues receipts"),
      ]),
    );

    const definitionKeys = (flow.definition?.operations ?? []).map(
      ({ method, path }) => `${String(method).toLowerCase()} ${path}`,
    );
    const filteredKeys = new Set(
      Object.entries(flow.paths ?? {}).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method.toLowerCase()} ${path}`)
      ),
    );
    for (const [method, path] of AUTOMATION_OPERATIONS) {
      const key = `${method} ${path}`;
      expect(definitionKeys, `${key} is missing from the flow definition`).toContain(key);
      expect(filteredKeys, `${key} is missing from the filtered flow schema`).toContain(key);
    }
    for (const [method, path] of AUTOMATION_FLOW_DEPENDENCIES) {
      const key = `${method} ${path}`;
      expect(definitionKeys, `${key} dependency is missing from the flow definition`).toContain(key);
      expect(filteredKeys, `${key} dependency is missing from the filtered flow schema`).toContain(key);
    }
    expect(flow.count).toBeGreaterThanOrEqual(
      AUTOMATION_OPERATIONS.length + AUTOMATION_FLOW_DEPENDENCIES.length,
    );

    const indexOf = (key: string) => {
      const index = definitionKeys.indexOf(key);
      expect(index, `${key} is missing from dependency order`).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(indexOf("get /v1/automation-workflow-components")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-workflows/compile"),
    );
    expect(indexOf("post /v1/projects/{project_id}/automation-workflows/compile")).toBeLessThan(
      indexOf("put /v1/projects/{project_id}/automation-workflows/{automation_id}"),
    );
    expect(indexOf("post /v1/projects/{project_id}/credentials")).toBeLessThan(
      indexOf("get /v1/projects/{project_id}/automation-workflows/{automation_id}/readiness"),
    );
    expect(indexOf("get /v1/projects/{project_id}/automation-workflows/{automation_id}/readiness")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-workflows/{automation_id}/enable"),
    );
    expect(indexOf("post /v1/projects/{project_id}/automation-workflows/{automation_id}/enable")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/issue"),
    );
    expect(indexOf("get /v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/{receipt_id}")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-workflows/{automation_id}/runs"),
    );
    expect(indexOf("post /v1/projects/{project_id}/automation-workflows/{automation_id}/runs")).toBeLessThan(
      indexOf("get /v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}"),
    );
    expect(indexOf("get /v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/commands"),
    );
    expect(indexOf("get /v1/automation-playbooks")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-playbooks/{id}/render"),
    );
    expect(indexOf("post /v1/projects/{project_id}/automation-playbooks/{id}/render")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-contract/validate"),
    );
    expect(indexOf("post /v1/projects/{project_id}/automation-contract/validate")).toBeLessThan(
      indexOf("put /v1/projects/{project_id}/automation-contract"),
    );
    expect(indexOf("put /v1/projects/{project_id}/automation-contract")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/credentials"),
    );
    expect(indexOf("post /v1/projects/{project_id}/credentials")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-contract/enable"),
    );
    expect(indexOf("post /v1/projects/{project_id}/automation-contract/enable")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-triggers/issue"),
    );
    expect(definitionKeys).not.toContain("get /v1/projects/{project_id}/cases");
    expect(filteredKeys).not.toContain("get /v1/projects/{project_id}/cases");
    expect(indexOf("get /v1/automation-trigger-receipts/{receipt_id}")).toBeLessThan(
      indexOf("post /v1/cases/{case_id}/claims"),
    );
    expect(indexOf("post /v1/cases/{case_id}/claims")).toBeLessThan(
      indexOf("get /v1/cases/{case_id}"),
    );
    expect(indexOf("get /v1/cases/{case_id}")).toBeLessThan(
      indexOf("post /v1/projects/{project_id}/automation-runs"),
    );
    expect(indexOf("post /v1/automation-runs/{run_id}/actions/draft-pr/consume")).toBeLessThan(
      indexOf("post /v1/automation-runs/{run_id}/pr-proof"),
    );
    expect(indexOf("post /v1/automation-runs/{run_id}/pr-proof")).toBeLessThan(
      indexOf("post /v1/deploys/"),
    );
    expect(indexOf("post /v1/deploys/")).toBeLessThan(
      indexOf("post /v1/automation-runs/{run_id}/verify"),
    );
    expect(indexOf("post /v1/automation-runs/{run_id}/report-source")).toBeLessThan(
      indexOf("post /v1/automation-runs/{run_id}/actions/record-report"),
    );
    expect(flow.definition?.invariants?.join(" ")).toContain("zero traffic");
    expect(flow.definition?.invariants?.join(" ")).toContain("draft");
    expect(flow.definition?.invariants?.join(" ")).toContain("telemetry");
  });

  it("keeps case inventory human-only and runner evidence claim-bound", async () => {
    const schema = await openApi();

    const list = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/cases",
    );
    expect(list.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(String(list.description)).toContain("cannot enumerate");
    expect(parameter(list, "query", "status")?.schema).toMatchObject({
      type: "string",
      enum: ["active", "resolved", "suppressed", "all"],
    });
    const listResponse = responseSchema(list, "200");
    expect(listResponse.required).toContain("projection_refresh");
    expect(property(listResponse, "projection_refresh").required).toEqual(
      expect.arrayContaining([
        "provider_status_filter",
        "requested_case_status",
        "complete",
        "truncated",
        "next_offset",
      ]),
    );

    const detail = await filteredOperation("get", "/v1/cases/{case_id}");
    expect(detail.security).toEqual([
      { ApiKeyAuth: [] },
      { AutomationRunnerAuth: [] },
    ]);
    expect(String(detail.description)).toContain("unexpired, unreleased claim");
    expect(String(detail.description)).toContain("omit affected-user data");

    const users = await filteredOperation("get", "/v1/cases/{case_id}/users");
    expect(users.security).toEqual([{ ApiKeyAuth: [] }]);
    const projectUsers = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/users",
    );
    expect(projectUsers.security).toEqual([{ ApiKeyAuth: [] }]);
    const detailSchema = schema.components?.schemas?.CaseDetail;
    expect(detailSchema?.properties?.provider_issue_id).toBeDefined();
    expect(detailSchema?.required ?? []).toContain("provider_issue_id");
    expect(detailSchema?.properties?.affected_users).toBeDefined();
    expect(detailSchema?.required ?? []).not.toContain("affected_users");
    expect(
      String(schema.components?.securitySchemes?.AutomationRunnerAuth?.description),
    ).toContain("active claim");

    const update = await filteredOperation("patch", "/v1/cases/{case_id}");
    expectRequiredHeader(update, "If-Match");
    expect(parameter(update, "header", "If-Match")?.schema).toMatchObject({
      type: "string",
      pattern: '^"[1-9][0-9]*"$',
    });
    expect(String(update.description)).toContain("agent_summary and pr_url");
    expect(String(update.description)).toContain("PostHog owns issue lifecycle");

    const alerts = await filteredOperation(
      "get",
      "/v1/projects/{project_id}/alerts",
    );
    expect(alerts.security).toEqual([{ ApiKeyAuth: [] }]);
    expect(String(alerts.description)).toContain("server-issued alert trigger receipts");
  });

  it("documents the canonical dual verification policy and server-owned result", async () => {
    const validate = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-contract/validate",
    );
    const contract = requestSchema(validate);
    const serializedContract = JSON.stringify(contract);
    expect(serializedContract).not.toContain('"open_pr"');
    expect(serializedContract).not.toContain('"record_run_only"');
    expect(serializedContract).not.toContain('"success_criteria"');
    const definition = arrayItems(property(contract, "automations"));
    const verification = property(definition, "verification");
    expectClosedObject(verification, [
      "outcome",
      "sample",
      "observation_window_seconds",
      "max_wait_seconds",
    ]);
    expectRequired(verification, ["outcome", "sample"]);

    const outcome = property(verification, "outcome");
    expectClosedObject(outcome, ["blueprint_id", "params", "predicate"]);
    expectLiteral(
      property(outcome, "blueprint_id"),
      "automation_case_recurrence_after_deploy",
    );
    const outcomeParams = property(outcome, "params");
    expectClosedObject(outcomeParams, [
      "run_id",
      "case_id",
      "case_revision",
      "deploy_sha",
      "deployed_at",
      "checked_at",
    ]);
    expectRunBinding(outcomeParams, "run_id", "run_id");
    expectRunBinding(outcomeParams, "case_id", "case_id");
    expectRunBinding(outcomeParams, "case_revision", "case_revision");
    expectRunBinding(outcomeParams, "deploy_sha", "deploy_sha");
    expectRunBinding(outcomeParams, "deployed_at", "deploy_received_at");
    expectRunBinding(outcomeParams, "checked_at", "verification_checked_at");
    const outcomePredicate = property(outcome, "predicate");
    expectClosedObject(outcomePredicate, ["column", "reducer", "operator", "value"]);
    expectLiteral(property(outcomePredicate, "column"), "recurrence_count");
    expectLiteral(property(outcomePredicate, "operator"), "eq");
    expectLiteral(property(outcomePredicate, "value"), 0);

    const sample = property(verification, "sample");
    expectClosedObject(sample, [
      "blueprint_id",
      "params",
      "sample_size",
      "min_sample_size",
    ]);
    expectLiteral(
      property(sample, "blueprint_id"),
      "automation_deploy_traffic_sample",
    );
    const sampleParams = property(sample, "params");
    expectClosedObject(sampleParams, [
      "deploy_sha",
      "deployed_at",
      "checked_at",
      "event_name",
    ]);
    expectRunBinding(sampleParams, "deploy_sha", "deploy_sha");
    expectRunBinding(sampleParams, "deployed_at", "deploy_received_at");
    expectRunBinding(sampleParams, "checked_at", "verification_checked_at");
    expect(property(sampleParams, "event_name").type).toBe("string");
    const sampleSize = property(sample, "sample_size");
    expectLiteral(property(sampleSize, "kind"), "column_sum");
    expectLiteral(property(sampleSize, "column"), "sample_count");

    const verify = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/verify",
    );
    expect(verify.requestBody).toBeUndefined();

    const pendingBranches = unionBranches(responseSchema(verify, "202"));
    const observationPending = pendingBranches.find((branch) =>
      branch.properties?.verification_ready_at !== undefined
    );
    expect(observationPending).toBeDefined();
    expectClosedObject(observationPending ?? {}, [
      "run_id",
      "status",
      "verification_ready_at",
      "retry_after_seconds",
      "next_action",
    ]);
    const samplePendingEnvelope = pendingBranches.find((branch) =>
      branch.properties?.verification !== undefined
    );
    expect(samplePendingEnvelope).toBeDefined();
    const pending = property(samplePendingEnvelope ?? {}, "verification");
    expectClosedObject(pending, [
      "state",
      "checked_at",
      "trusted_deploy",
      "sample",
      "outcome",
      "retry_after_seconds",
      "deadline_at",
    ]);
    expectLiteral(property(pending, "state"), "pending_sample");
    expectVerificationSample(property(pending, "sample"));
    expectVerificationOutcome(property(pending, "outcome"));

    const complete = property(responseSchema(verify, "200"), "verification");
    expectClosedObject(complete, [
      "state",
      "checked_at",
      "trusted_deploy",
      "sample",
      "outcome",
      "passed",
    ]);
    expectLiteral(property(complete, "state"), "complete");
    expectVerificationSample(property(complete, "sample"));
    expectVerificationOutcome(property(complete, "outcome"));
    const trustedDeploy = property(complete, "trusted_deploy");
    expectClosedObject(trustedDeploy, [
      "id",
      "sha",
      "source_commit_sha",
      "received_at",
      "credential_id",
      "credential_kind",
      "trust_level",
    ]);
    expectLiteral(property(trustedDeploy, "credential_kind"), "ci_deploy");
    expectLiteral(property(trustedDeploy, "trust_level"), "trusted_ci");
  });

  it("locks scheduled reports to one source and a typed human-review report", async () => {
    const validate = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-contract/validate",
    );
    const definition = arrayItems(
      property(requestSchema(validate), "automations"),
    );
    const reportPlan = property(definition, "report_plan");
    expectClosedObject(reportPlan, [
      "schema_version",
      "blueprint_id",
      "params",
      "period",
      "output_schema_version",
    ]);
    expectRequired(reportPlan, ["blueprint_id", "period"]);
    expectLiteral(property(reportPlan, "schema_version"), "1");
    expectLiteral(property(reportPlan, "output_schema_version"), "1");
    expectProperties(property(reportPlan, "period"), [
      "lookback_seconds",
      "offset_seconds",
    ]);
    expect(reportPlan.properties?.hogql).toBeUndefined();
    expect(reportPlan.properties?.query).toBeUndefined();

    const sourceOperation = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/report-source",
    );
    expect(sourceOperation.security).toEqual([{ AutomationRunnerAuth: [] }]);
    expectRequiredHeader(sourceOperation, "Idempotency-Key");
    const sourceRequest = requestSchema(sourceOperation);
    expectClosedObject(sourceRequest, ["blueprint_id"]);
    expectRequired(sourceRequest, ["blueprint_id"]);
    for (const forbidden of ["params", "hogql", "query", "period_start", "period_end"]) {
      expect(sourceRequest.properties?.[forbidden]).toBeUndefined();
    }
    const sourceResponse = responseSchema(sourceOperation, "200");
    expectRequired(sourceResponse, [
      "data_boundary",
      "id",
      "project_id",
      "automation_id",
      "run_id",
      "blueprint_id",
      "plan_hash",
      "source_hash",
      "source",
      "readiness",
      "idempotent_replay",
      "created_at",
      "next_action",
    ]);
    const source = property(sourceResponse, "source");
    expectClosedObject(source, [
      "schema_version",
      "source",
      "consistency",
      "blueprint_id",
      "plan_hash",
      "input_readiness",
      "scheduled_for",
      "period_start",
      "period_end",
      "columns",
      "rows",
      "row_count",
      "queried_at",
      "query_duration_ms",
    ]);
    const readiness = property(sourceResponse, "readiness");
    expectClosedObject(readiness, ["status", "contract", "checks", "next_action"]);
    expect(property(readiness, "status").enum).toEqual(["ready", "blocked"]);

    const recordOperation = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/actions/record-report",
    );
    expect(recordOperation.security).toEqual([{ AutomationRunnerAuth: [] }]);
    expectRequiredHeader(recordOperation, "Idempotency-Key");
    const recordRequest = requestSchema(recordOperation);
    expectClosedObject(recordRequest, ["summary_md", "evidence"]);
    expectRequired(recordRequest, ["summary_md", "evidence"]);
    const evidence = property(recordRequest, "evidence");
    const report = property(evidence, "report");
    expectClosedObject(report, [
      "kind",
      "period_start",
      "period_end",
      "source_hash",
      "findings",
      "limitations",
    ]);
    expectRequired(report, [
      "kind",
      "period_start",
      "period_end",
      "source_hash",
      "findings",
    ]);
    const findings = property(report, "findings");
    const findingSchema = findings.items ?? {};
    const metric = branchForLiteral(findingSchema, "kind", "metric");
    expectClosedObject(metric, [
      "kind",
      "metric",
      "unit",
      "prior_value",
      "current_value",
      "change",
      "source_columns",
    ]);
    const hypothesis = branchForLiteral(findingSchema, "kind", "hypothesis");
    expectClosedObject(hypothesis, [
      "kind",
      "rank",
      "title",
      "rationale",
      "expected_impact",
      "confidence",
      "evidence_columns",
      "suggested_human_next_step",
    ]);
    const readinessGap = branchForLiteral(
      findingSchema,
      "kind",
      "readiness_gap",
    );
    expectClosedObject(readinessGap, [
      "kind",
      "code",
      "message",
      "required_signal",
    ]);
  });

  it("documents immutable playbook discovery/rendering and exact concurrency headers", async () => {
    const list = await filteredOperation("get", "/v1/automation-playbooks");
    const listResponse = responseSchema(list, "200");
    expectProperties(listResponse, [
      "kind",
      "count",
      "version_policy",
      "list_policy",
      "playbooks",
      "next_action",
    ]);
    expectLiteral(property(listResponse, "kind"), "automation_playbook_catalog");
    expectLiteral(property(listResponse, "version_policy"), "immutable_semver");

    const detail = await filteredOperation("get", "/v1/automation-playbooks/{id}");
    const version = parameter(detail, "query", "version");
    expect(version).toBeDefined();
    const detailResponse = responseSchema(detail, "200");
    for (const name of [
      "id",
      "version",
      "template_hash",
      "render_request_schema",
      "run_output_schema",
      "locked_invariants",
      "related_operations",
      "endpoints",
    ]) {
      expect(detailResponse.properties?.[name], `playbook detail needs ${name}`).toBeDefined();
    }

    const render = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-playbooks/{id}/render",
    );
    expect(render.security).toEqual([{ ApiKeyAuth: [] }]);
    const renderBranches = unionBranches(requestSchema(render));
    expect(renderBranches).toHaveLength(2);
    for (const branch of renderBranches) {
      expectClosedObject(branch, ["version", "bindings", "readiness_assertions"]);
      expectRequired(branch, ["version", "bindings", "readiness_assertions"]);
      expectLiteral(property(branch, "version"), "2.0.0");
    }
    const bindingPropertySets = renderBranches.map((branch) =>
      new Set(Object.keys(property(branch, "bindings").properties ?? {}))
    );
    expect(bindingPropertySets.some((keys) => keys.has("traffic_sample_event"))).toBe(true);
    expect(bindingPropertySets.some((keys) => keys.has("funnel"))).toBe(true);
    for (const branch of renderBranches) {
      expect(property(branch, "bindings").required).toContain("execution");
      expect(unionBranches(property(property(branch, "bindings"), "execution"))).toHaveLength(4);
    }
    const errorBranch = renderBranches.find((branch) => property(branch, "bindings").properties?.traffic_sample_event)!;
    const weeklyBranch = renderBranches.find((branch) => property(branch, "bindings").properties?.funnel)!;
    const errorBindings = property(errorBranch, "bindings");
    const weeklyBindings = property(weeklyBranch, "bindings");
    expect(property(errorBindings, "traffic_sample_event").pattern).toBe("^[^\\s\\u0000-\\u001F\\u007F]+$");
    expect((property(property(errorBindings, "runner"), "repository") as any).pattern).toBe("^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)");
    expect((property(property(errorBindings, "budgets"), "max_prs_per_day") as any).minimum).toBe(1);
    expect((property(errorBindings, "verification") as any)["x-agentry-runtime-constraints"]).toEqual([
      "max_wait_seconds >= observation_window_seconds",
    ]);
    expectProperties(property(weeklyBindings, "budgets"), [
      "max_runs_per_day",
      "max_turns_per_run",
      "max_runtime_seconds",
      "max_cost_usd_per_run",
    ]);
    expect(property(weeklyBindings, "budgets").properties?.max_prs_per_day).toBeUndefined();
    expect(property(weeklyBindings, "budgets").properties?.max_attempts_per_case_revision).toBeUndefined();
    const weeklyFunnel = property(weeklyBindings, "funnel");
    expect((property(weeklyFunnel, "events").items as any).pattern).toBe("^[^\\s\\u0000-\\u001F\\u007F]+$");
    expect(property(weeklyFunnel, "events")).toMatchObject({ minItems: 2, maxItems: 20 });
    expect((weeklyFunnel as any)["x-agentry-runtime-constraints"]).toEqual([
      "events must contain 2–20 pairwise-distinct names in funnel order",
    ]);
    const weeklySchedule = property(weeklyBindings, "schedule");
    expect((property(weeklySchedule, "cron") as any)["x-agentry-runtime-validator"]).toBe("isValidCronExpression");
    expect((property(weeklySchedule, "timezone") as any)["x-agentry-runtime-validator"]).toBe("isValidTimeZone");

    const renderResponse = responseSchema(render, "200");
    expectProperties(renderResponse, [
      "kind",
      "template_ref",
      "automation_definition",
      "contract_candidate",
      "scheduler_neutral_prompt",
      "scheduler_handoffs",
      "related_operations",
      "render_hash",
      "readiness",
      "side_effects",
      "next_action",
    ]);
    expectLiteral(property(renderResponse, "kind"), "automation_playbook_render");
    const templateRef = property(renderResponse, "template_ref");
    expectClosedObject(templateRef, ["id", "version", "bindings_sha256"]);
    expectLiteral(property(templateRef, "version"), "2.0.0");
    expect(property(templateRef, "bindings_sha256").pattern).toBe("^[a-f0-9]{64}$");
    expectLiteral(
      property(property(renderResponse, "contract_candidate"), "enabled"),
      false,
    );
    const handoffs = property(renderResponse, "scheduler_handoffs");
    expect(handoffs.type).toBe("array");
    expect(handoffs.minItems).toBe(2);
    expect(handoffs.maxItems).toBe(2);
    const handoffBranches = unionBranches(arrayItems(handoffs));
    expect(handoffBranches).toHaveLength(5);
    const handoffProperties = [
      "provider",
      "display_name",
      "runner_provider",
      "selected_by_runner_binding",
      "state",
      "contract_enabled",
      "automation_enabled",
      "scheduler_registered",
      "api",
      "schedule_semantics",
      "prompt_source",
      "operations",
      "provider_setup",
      "credential_placement",
      "polling_and_output",
      "first_run_proof",
      "stop_and_escalation",
    ];
    const executableBranches = handoffBranches.filter((branch) =>
      property(branch, "provider").const !== "chatgpt_scheduled_task_preview"
    );
    expect(executableBranches).toHaveLength(4);
    for (const branch of executableBranches) {
      expectClosedObject(branch, handoffProperties);
      expectRequired(branch, handoffProperties);
      expectLiteral(property(branch, "state"), "proposal_only");
      expectLiteral(property(branch, "contract_enabled"), false);
      expectLiteral(property(branch, "automation_enabled"), false);
      expectLiteral(property(branch, "scheduler_registered"), false);
      expectLiteral(property(branch, "prompt_source"), "scheduler_neutral_prompt");
      expectLiteral(property(branch, "selected_by_runner_binding"), true);

      const schedule = property(branch, "schedule_semantics");
      expectClosedObject(schedule, [
        "mode",
        "recurrence_source",
        "cron",
        "timezone",
        "start_window_seconds",
        "receipt_authority",
        "scheduled_for_policy",
        "duplicate_policy",
      ]);
      expectRequired(schedule, [
        "mode",
        "recurrence_source",
        "cron",
        "timezone",
        "start_window_seconds",
        "receipt_authority",
        "scheduled_for_policy",
        "duplicate_policy",
      ]);

      const operations = property(branch, "operations");
      const operationArrays = unionBranches(operations);
      expect(operationArrays.map((candidate) => [candidate.minItems, candidate.maxItems])).toEqual([
        [18, 18],
        [24, 24],
      ]);
      const operation = arrayItems(operationArrays[0]!);
      expectClosedObject(operation, [
        "phase",
        "operation_id",
        "method",
        "href_template",
        "required_principal",
        "required_headers",
        "purpose",
      ]);
      expectRequired(operation, [
        "phase",
        "operation_id",
        "method",
        "href_template",
        "required_principal",
        "required_headers",
        "purpose",
      ]);

      const credential = property(branch, "credential_placement");
      expectClosedObject(credential, [
        "kind",
        "automation_id",
        "env_var",
        "destination",
        "secret_included",
        "one_automation_only",
        "owner_private_key_allowed",
        "forbidden_destinations",
      ]);
      expectLiteral(property(credential, "kind"), "automation_runner");
      expectLiteral(property(credential, "env_var"), "AGENTRY_RUNNER_API_KEY");
      expectLiteral(property(credential, "secret_included"), false);
      expectLiteral(property(credential, "one_automation_only"), true);
      expectLiteral(property(credential, "owner_private_key_allowed"), false);

      const firstRun = property(branch, "first_run_proof");
      expectClosedObject(firstRun, ["required", "mode", "template", "steps", "success_evidence"]);
      expectLiteral(property(firstRun, "required"), true);
      expectLiteral(property(firstRun, "mode"), "manual_before_unattended_recurrence");
      expect(unionBranches(property(firstRun, "steps")).map((candidate) => [candidate.minItems, candidate.maxItems])).toEqual([
        [7, 7],
        [12, 12],
      ]);

      const stop = property(branch, "stop_and_escalation");
      expectClosedObject(stop, [
        "external_scheduler_stop_required",
        "agentry_operation_ids",
        "escalation_destination",
        "stop_conditions",
        "provider_stop_action",
      ]);
      expectLiteral(property(stop, "external_scheduler_stop_required"), true);
    }
    const codexHandoff = branchForLiteral(arrayItems(handoffs), "provider", "codex_cli_scheduler");
    expectLiteral(property(codexHandoff, "runner_provider"), "codex");
    const codexSetup = property(codexHandoff, "provider_setup");
    expectClosedObject(codexSetup, [
      "management_surface",
      "docs_url",
      "registration_mode",
      "manual_registration_required",
      "recurrence_instruction",
      "workspace_mode",
      "invocation",
    ]);
    expectLiteral(property(codexSetup, "management_surface"), "customer_owned_scheduler");
    expectLiteral(property(codexSetup, "registration_mode"), "cron_ci_or_job_runner");
    expectLiteral(property(codexSetup, "manual_registration_required"), true);
    const claudeHandoff = branchForLiteral(arrayItems(handoffs), "provider", "claude_code_scheduler");
    expectLiteral(property(claudeHandoff, "runner_provider"), "claude_code");
    const claudeSetup = property(claudeHandoff, "provider_setup");
    expectClosedObject(claudeSetup, [
      "management_surface",
      "docs_url",
      "registration_mode",
      "manual_registration_required",
      "recurrence_instruction",
      "workspace_mode",
      "invocation",
    ]);
    expectLiteral(property(claudeSetup, "management_surface"), "customer_owned_scheduler");
    expectClosedObject(property(claudeSetup, "invocation"), [
      "executable",
      "argv",
      "prompt_transport",
      "direct_argv_required",
      "shell_interpolation_forbidden",
      "output_format",
    ]);
    const githubHandoff = branchForLiteral(arrayItems(handoffs), "provider", "github_actions_workflow");
    expectLiteral(property(githubHandoff, "runner_provider"), "github_actions");
    const customHandoff = branchForLiteral(arrayItems(handoffs), "provider", "custom_scheduler");
    expectLiteral(property(customHandoff, "runner_provider"), "custom");
    const scheduledPreview = branchForLiteral(arrayItems(handoffs), "provider", "chatgpt_scheduled_task_preview");
    expectClosedObject(scheduledPreview, [
      "provider",
      "display_name",
      "runner_provider",
      "selected_by_runner_binding",
      "state",
      "direct_authenticated_agentry_execution",
      "scheduler_registered",
      "provider_setup",
      "credential_placement",
      "prompt_preview_source",
      "blocked_reason",
      "recommended_executable_handoff",
    ]);
    expectLiteral(property(scheduledPreview, "state"), "blocked_advisory");
    expectLiteral(property(scheduledPreview, "direct_authenticated_agentry_execution"), "blocked");
    const scheduledSetup = property(scheduledPreview, "provider_setup");
    expectLiteral(property(scheduledSetup, "management_surface"), "Scheduled");
    expectLiteral(property(scheduledSetup, "official_name"), "ChatGPT Scheduled tasks");
    const scheduledCredential = property(scheduledPreview, "credential_placement");
    expect(property(scheduledCredential, "env_var").type).toBe("null");
    expect(property(scheduledCredential, "destination").type).toBe("null");
    const sideEffects = property(renderResponse, "side_effects");
    for (const sideEffect of Object.values(sideEffects.properties ?? {})) {
      expectLiteral(sideEffect, false);
    }

    const putContract = await filteredOperation(
      "put",
      "/v1/projects/{project_id}/automation-contract",
    );
    const putIfMatch = parameter(putContract, "header", "If-Match");
    expect(putIfMatch, "PUT must document conditional replacement with If-Match").toBeDefined();
    expect(putIfMatch?.required).toBe(false);
    const enable = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-contract/enable",
    );
    expectRequiredHeader(enable, "If-Match");
    const toggle = await filteredOperation(
      "patch",
      "/v1/projects/{project_id}/automation-contract/automations/{automation_id}",
    );
    expectRequiredHeader(toggle, "If-Match");
    const pause = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-contract/pause",
    );
    expect(parameter(pause, "header", "If-Match")).toBeUndefined();

    const claim = await filteredOperation("post", "/v1/cases/{case_id}/claims");
    expectRequiredHeader(claim, "Idempotency-Key");
    const start = await filteredOperation(
      "post",
      "/v1/projects/{project_id}/automation-runs",
    );
    expectRequiredHeader(start, "Idempotency-Key");
    expect(parameter(start, "header", "x-agentry-lease-token")).toBeDefined();
    const cancel = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/cancel",
    );
    expectRequiredHeader(cancel, "Idempotency-Key");
    const renew = await filteredOperation(
      "post",
      "/v1/cases/{case_id}/claims/{claim_id}/renew",
    );
    expectRequiredHeader(renew, "x-agentry-lease-token");
    const release = await filteredOperation(
      "post",
      "/v1/cases/{case_id}/claims/{claim_id}/release",
    );
    expectRequiredHeader(release, "x-agentry-lease-token");
    const consume = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/actions/draft-pr/consume",
    );
    expectRequiredHeader(consume, "x-agentry-action-token");
    expectRequiredHeader(consume, "x-agentry-lease-token");
    const authorize = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/actions/draft-pr/authorize",
    );
    expectRequiredHeader(authorize, "Idempotency-Key");
    expectRequiredHeader(authorize, "x-agentry-lease-token");
    const approval = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/approvals",
    );
    expectRequiredHeader(approval, "x-agentry-lease-token");
    const update = await filteredOperation(
      "patch",
      "/v1/automation-runs/{run_id}",
    );
    expect(parameter(update, "header", "x-agentry-lease-token")).toBeDefined();
    const usage = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/usage",
    );
    expect(parameter(usage, "header", "x-agentry-lease-token")).toBeDefined();

    const proof = await filteredOperation(
      "post",
      "/v1/automation-runs/{run_id}/pr-proof",
    );
    expect(proof.security).toEqual([{ CiDeployAuth: [] }]);

    const deploy = await filteredOperation("post", "/v1/deploys/");
    expect(deploy.security).toEqual([{ CiDeployAuth: [] }]);
    expectRequiredHeader(deploy, "Idempotency-Key");
    const deployRequest = requestSchema(deploy);
    expect(deployRequest.dependentRequired).toEqual({
      automation_run_id: ["source_commit_sha"],
      source_commit_sha: ["automation_run_id"],
    });
  });
});
