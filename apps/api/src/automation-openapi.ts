import {
  AUTOMATION_WORKFLOW_OPENAPI_PATHS,
  AUTOMATION_WORKFLOW_OPENAPI_SCHEMAS,
} from "./automation-workflow-openapi.js";

/**
 * Canonical OpenAPI fragments for automation v2 and the fail-closed
 * workflow-v3 production slice.
 *
 * Keep these fragments beside the executable automation implementation rather
 * than burying them in the general discovery route. Request objects mirror the
 * strict Zod contracts in @agentrysh/shared; response objects document the
 * bounded control/evidence envelopes returned by the API.
 */

type OpenApiObject = Record<string, unknown>;

const string = { type: "string" } as const;
const integer = { type: "integer" } as const;
const number = { type: "number" } as const;
const boolean = { type: "boolean" } as const;
const nullSchema = { type: "null" } as const;

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
  additionalProperties: boolean | OpenApiObject = false,
) {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties,
  };
}

const array = (items: unknown) => ({ type: "array", items });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: unknown) => ({ oneOf: [schema, nullSchema] });
const literal = (value: string | number | boolean) => ({
  type: typeof value === "string" ? "string" : typeof value,
  const: value,
});
const enumString = (values: readonly string[]) => ({
  type: "string",
  enum: [...values],
});

function exampleForSchema(schema: unknown, depth = 0): unknown {
  if (depth > 10 || !schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const value = schema as Record<string, unknown>;
  if (value.const !== undefined) return value.const;
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0];
  if (Array.isArray(value.oneOf) && value.oneOf.length > 0) {
    return exampleForSchema(value.oneOf[0], depth + 1);
  }
  if (Array.isArray(value.anyOf) && value.anyOf.length > 0) {
    return exampleForSchema(value.anyOf[0], depth + 1);
  }
  if (value.type === "string") return "string";
  if (value.type === "integer" || value.type === "number") return 1;
  if (value.type === "boolean") return true;
  if (value.type === "null") return null;
  if (value.type === "array") return [exampleForSchema(value.items, depth + 1)];
  if (value.type === "object") {
    const properties = value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
      ? value.properties as Record<string, unknown>
      : {};
    return Object.fromEntries(
      Object.entries(properties).map(([key, property]) => [
        key,
        exampleForSchema(property, depth + 1),
      ]),
    );
  }
  return {};
}

function jsonResponse(schema: unknown, description = "OK") {
  return {
    description,
    content: {
      "application/json": {
        schema,
        examples: { default: { value: exampleForSchema(schema) } },
      },
    },
  };
}

const defaultError = {
  default: jsonResponse(ref("ErrorEnvelope"), "Error"),
};

function operation(input: {
  operationId: string;
  summary: string;
  description: string;
  security?: Array<Record<string, string[]>>;
  parameters?: unknown[];
  request?: unknown;
  responses?: Record<string, unknown>;
  tags?: string[];
  extensions?: Record<string, unknown>;
}) {
  return {
    operationId: input.operationId,
    summary: input.summary,
    description: input.description,
    tags: input.tags ?? ["Automation"],
    ...(input.security === undefined ? {} : { security: input.security }),
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.request === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: input.request,
                examples: { default: { value: exampleForSchema(input.request) } },
              },
            },
          },
        }),
    responses: input.responses ?? {
      "200": jsonResponse(boundedEvidence),
      ...defaultError,
    },
    ...input.extensions,
  };
}

const owner: Array<Record<string, string[]>> = [{ ApiKeyAuth: [] }];
const ownerOrRunner: Array<Record<string, string[]>> = [
  { ApiKeyAuth: [] },
  { AutomationRunnerAuth: [] },
];
const runnerOnly: Array<Record<string, string[]>> = [{ AutomationRunnerAuth: [] }];
const ciOnly: Array<Record<string, string[]>> = [{ CiDeployAuth: [] }];

const projectId = { $ref: "#/components/parameters/projectId" };
const caseId = { $ref: "#/components/parameters/caseId" };
const runId = { $ref: "#/components/parameters/runId" };
const automationIdPath = { $ref: "#/components/parameters/automationId" };
const claimId = { $ref: "#/components/parameters/claimId" };
const receiptId = { $ref: "#/components/parameters/receiptId" };
const approvalId = { $ref: "#/components/parameters/approvalId" };
const credentialId = { $ref: "#/components/parameters/credentialId" };
const playbookId = { $ref: "#/components/parameters/playbookId" };
const deliveryId = { $ref: "#/components/parameters/deliveryId" };
const idempotencyKey = { $ref: "#/components/parameters/idempotencyKey" };
const ifMatchOptional = { $ref: "#/components/parameters/ifMatchOptional" };
const ifMatchRequired = { $ref: "#/components/parameters/ifMatchRequired" };
const leaseTokenOptional = { $ref: "#/components/parameters/leaseTokenOptional" };
const leaseTokenRequired = { $ref: "#/components/parameters/leaseTokenRequired" };
const actionTokenRequired = { $ref: "#/components/parameters/actionTokenRequired" };

export const AUTOMATION_OPENAPI_SECURITY_SCHEMES = {
  AutomationRunnerAuth: {
    type: "http",
    scheme: "bearer",
    description:
      "Exact-automation runner credential, agentry_runner_<projectId>.<token>. It is bound to one automation_id and fixed receipt/run/lease/command scopes; detailed v2 case/source evidence additionally requires the exact credential's active claim. It is never an owner, CI, merge, deploy, generic analytics, trigger-fact, or server-clock credential.",
  },
  CiDeployAuth: {
    type: "http",
    scheme: "bearer",
    description:
      "Trusted CI credential, agentry_ci_<projectId>.<token>, for Agentry deploy evidence, provider-observed automation PR proof, and exact evidence-bound reconciliation of an already-started workflow effect. PostHog source-map credentials remain customer-owned and go directly to PostHog.",
  },
} as const;

const header = (
  name: string,
  required: boolean,
  description: string,
  schema: OpenApiObject = string,
) => ({ name, in: "header", required, description, schema });

export const AUTOMATION_OPENAPI_PARAMETERS = {
  runId: { name: "run_id", in: "path", required: true, schema: string },
  automationId: { name: "automation_id", in: "path", required: true, schema: string },
  claimId: { name: "claim_id", in: "path", required: true, schema: string },
  receiptId: { name: "receipt_id", in: "path", required: true, schema: string },
  approvalId: { name: "approval_id", in: "path", required: true, schema: string },
  credentialId: { name: "credential_id", in: "path", required: true, schema: string },
  playbookId: { name: "id", in: "path", required: true, schema: string },
  deliveryId: { name: "delivery_id", in: "path", required: true, schema: string },
  idempotencyKey: header(
    "Idempotency-Key",
    true,
    "Stable 8-500 character command key. Preserve it only when replaying the exact same request; use a new key for a distinct command.",
    { type: "string", minLength: 8, maxLength: 500 },
  ),
  ifMatchOptional: header(
    "If-Match",
    false,
    "Required when replacing an existing contract; omit only for the first save. Use the exact ETag returned by the latest contract read.",
  ),
  ifMatchRequired: header(
    "If-Match",
    true,
    "Exact current automation-contract ETag. Re-read after any 412/428 conflict.",
  ),
  leaseTokenOptional: header(
    "X-Agentry-Lease-Token",
    false,
    "Required for a case-linked run. Omit only for schedule/alert runs that have no case claim.",
  ),
  leaseTokenRequired: header(
    "X-Agentry-Lease-Token",
    true,
    "One-time case lease token returned to the exact claimant. Keep it only in runner memory.",
  ),
  actionTokenRequired: header(
    "X-Agentry-Action-Token",
    true,
    "One-time draft-PR action token returned by the matching authorization grant.",
  ),
} as const;

const automationIdentifier = {
  type: "string",
  pattern: "^[a-z][a-z0-9_-]{0,99}$",
} as const;
const templateIdentifier = {
  type: "string",
  pattern: "^[a-z][a-z0-9-]{0,99}$",
} as const;
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const commitSha = { type: "string", pattern: "^[a-fA-F0-9]{7,64}$" } as const;
const HTTPS_WITHOUT_CREDENTIALS_PATTERN = "^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)" as const;
const EVENT_NAME_PATTERN = "^[^\\s\\u0000-\\u001F\\u007F]+$" as const;
const httpsUrl = {
  type: "string",
  format: "uri",
  pattern: HTTPS_WITHOUT_CREDENTIALS_PATTERN,
  maxLength: 500,
  description: "Absolute HTTPS URL without embedded username or password credentials.",
} as const;
const timestamp = { type: "integer", minimum: 0 } as const;
const scalar = { oneOf: [string, number, boolean, nullSchema] } as const;

const boundedEvidenceValue = {
  oneOf: [
    string,
    number,
    boolean,
    nullSchema,
    { type: "array", items: ref("BoundedEvidenceValue"), maxItems: 100 },
    {
      type: "object",
      maxProperties: 100,
      additionalProperties: ref("BoundedEvidenceValue"),
    },
  ],
} as const;
const boundedEvidenceObject = {
  type: "object",
  maxProperties: 100,
  additionalProperties: ref("BoundedEvidenceValue"),
} as const;
const boundedEvidence = ref("BoundedEvidenceObject");

const telemetryInspection = object(
  {
    heuristic_only: literal(true),
    indicators: {
      ...array(enumString([
        "instruction_like_text",
        "shell_like_text",
        "external_url",
        "potential_secret",
        "control_characters",
        "content_truncated",
      ])),
      maxItems: 6,
      uniqueItems: true,
    },
    external_url_hosts: { ...array({ type: "string", maxLength: 253 }), maxItems: 20 },
    redacted_paths: { ...array({ type: "string", maxLength: 500 }), maxItems: 100 },
    truncated_paths: { ...array({ type: "string", maxLength: 500 }), maxItems: 100 },
  },
  ["heuristic_only", "indicators", "external_url_hosts", "redacted_paths", "truncated_paths"],
);

const telemetryDataBoundary = object(
  {
    schema_version: literal("1"),
    classification: enumString([
      "untrusted_observation",
      "untrusted_observation_and_runner_evidence",
      "runner_and_owner_annotation",
      "server_control_with_authority_free_observation",
      "server_owned_bounded_aggregate",
      "external_response",
    ]),
    content_role: literal("evidence_only"),
    instruction_authority: literal("none"),
    trusted_provenance_does_not_mean_trusted_content: literal(true),
    external_url_policy: literal("do_not_fetch"),
    command_policy: literal("do_not_execute"),
    authority_source: literal("enabled_automation_contract_and_server_policy_only"),
    applies_to: {
      oneOf: [
        { type: "string", minLength: 1, maxLength: 500 },
        { ...array({ type: "string", minLength: 1, maxLength: 500 }), maxItems: 20 },
      ],
    },
    inspection: telemetryInspection,
    control_fields: { ...array({ type: "string", minLength: 1, maxLength: 500 }), maxItems: 20 },
    identifier_columns_included: boolean,
    secret_values_included: boolean,
  },
  [
    "schema_version",
    "classification",
    "content_role",
    "instruction_authority",
    "trusted_provenance_does_not_mean_trusted_content",
    "external_url_policy",
    "command_policy",
    "authority_source",
  ],
);

const queryBlueprintInputReadiness = object(
  {
    source: literal("verified_onboarding_plan"),
    approved_plan_hash: sha256,
    verified_onboarding_etag: {
      type: "string",
      pattern: '^"[A-Za-z0-9._:-]+"$',
    },
    selected_event_params: { ...array({ type: "string", minLength: 1, maxLength: 200 }), maxItems: 20 },
    selected_events: { ...array({ type: "string", minLength: 1, maxLength: 200 }), maxItems: 20 },
    event_order: enumString(["ordered_funnel", "not_applicable"]),
    onboarding_verified: literal(true),
    selected_events_observed_by_onboarding_proof: literal(true),
    synthetic_rows: literal("server_excluded"),
    trusted_deploy: literal("exact_ci_deploy_verified"),
  },
  [
    "source",
    "approved_plan_hash",
    "verified_onboarding_etag",
    "selected_event_params",
    "selected_events",
    "event_order",
    "onboarding_verified",
    "selected_events_observed_by_onboarding_proof",
    "synthetic_rows",
  ],
);

const keysetPagination = object(
  {
    kind: literal("descending_keyset"),
    sort: literal("timestamp_desc_id_desc"),
    limit: { type: "integer", minimum: 1, maximum: 200 },
    has_more: boolean,
    next_cursor: nullable({ type: "string", minLength: 1, maxLength: 1_000 }),
    follow_up: nullable(object(
      {
        operation_id: enumString([
          "list_automation_runs",
          "list_automation_approvals",
          "list_automation_trigger_receipts",
        ]),
        method: literal("GET"),
        href: { type: "string", minLength: 1, maxLength: 2_000 },
        required_principal: enumString(["human_owner_or_member", "human_or_exact_bound_runner"]),
      },
      ["operation_id", "method", "href", "required_principal"],
    )),
  },
  ["kind", "sort", "limit", "has_more", "next_cursor", "follow_up"],
);

function runBinding(field: string) {
  return object(
    { source: literal("run"), field: literal(field) },
    ["source", "field"],
  );
}

const verificationWindow = object(
  {
    start_at: timestamp,
    end_at: timestamp,
    bounds: literal("[start,end)"),
  },
  ["start_at", "end_at", "bounds"],
);

const verificationPredicate = object(
  {
    column: literal("recurrence_count"),
    reducer: literal("first"),
    operator: literal("eq"),
    value: literal(0),
  },
  ["column", "reducer", "operator", "value"],
);

const verificationOutcomePolicy = object(
  {
    blueprint_id: literal("automation_case_recurrence_after_deploy"),
    params: object(
      {
        run_id: runBinding("run_id"),
        case_id: runBinding("case_id"),
        case_revision: runBinding("case_revision"),
        deploy_sha: runBinding("deploy_sha"),
        deployed_at: runBinding("deploy_received_at"),
        checked_at: runBinding("verification_checked_at"),
      },
      ["run_id", "case_id", "case_revision", "deploy_sha", "deployed_at", "checked_at"],
    ),
    predicate: verificationPredicate,
  },
  ["blueprint_id", "params", "predicate"],
);

const verificationSamplePolicy = object(
  {
    blueprint_id: literal("automation_deploy_traffic_sample"),
    params: object(
      {
        deploy_sha: runBinding("deploy_sha"),
        deployed_at: runBinding("deploy_received_at"),
        checked_at: runBinding("verification_checked_at"),
        event_name: { type: "string", minLength: 1, maxLength: 200 },
      },
      ["deploy_sha", "deployed_at", "checked_at", "event_name"],
    ),
    sample_size: object(
      { kind: literal("column_sum"), column: literal("sample_count") },
      ["kind", "column"],
    ),
    min_sample_size: { type: "integer", minimum: 1, maximum: 10_000_000 },
  },
  ["blueprint_id", "params", "sample_size", "min_sample_size"],
);

const automationVerificationPolicy = object(
  {
    outcome: verificationOutcomePolicy,
    sample: verificationSamplePolicy,
    observation_window_seconds: { type: "integer", minimum: 60, maximum: 2_592_000, default: 3_600 },
    max_wait_seconds: { type: "integer", minimum: 60, maximum: 2_592_000, default: 86_400 },
  },
  ["outcome", "sample"],
);

const scheduleParamBinding = object(
  {
    source: literal("schedule"),
    field: enumString([
      "scheduled_for",
      "period_start",
      "period_end",
      "previous_period_start",
      "previous_period_end",
    ]),
  },
  ["source", "field"],
);

const automationReportPlan = object(
  {
    schema_version: { ...literal("1"), default: "1" },
    blueprint_id: { type: "string", minLength: 1, maxLength: 200 },
    params: {
      type: "object",
      maxProperties: 50,
      additionalProperties: { oneOf: [string, number, scheduleParamBinding] },
      default: {},
    },
    period: object(
      {
        lookback_seconds: { type: "integer", minimum: 60, maximum: 31_622_400 },
        offset_seconds: { type: "integer", minimum: 0, maximum: 31_622_400, default: 0 },
      },
      ["lookback_seconds"],
    ),
    output_schema_version: { ...literal("1"), default: "1" },
  },
  ["blueprint_id", "period"],
);

const automationRunner = object(
  {
    provider: enumString(["codex", "claude_code", "github_actions", "custom"]),
    repository: httpsUrl,
    default_branch: { type: "string", minLength: 1, maxLength: 200 },
    environment: { type: "string", minLength: 1, maxLength: 100 },
    mode: { ...literal("draft_only"), default: "draft_only" },
  },
  ["provider"],
);

const automationTrigger = {
  oneOf: [
    object(
      {
        kind: literal("alert"),
        alert_id: { type: "string", minLength: 1, maxLength: 200 },
        cooldown_seconds: { type: "integer", minimum: 60, maximum: 604_800, default: 3_600 },
        min_consecutive_breaches: { type: "integer", minimum: 1, maximum: 100, default: 1 },
        required_trust: { ...literal("server_evaluated"), default: "server_evaluated" },
      },
      ["kind", "alert_id"],
    ),
    object(
      {
        kind: literal("unhandled_cases"),
        max_cases_per_sweep: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        cooldown_seconds: { type: "integer", minimum: 60, maximum: 604_800, default: 3_600 },
        required_trust: { ...enumString(["any", "customer_posthog"]), default: "customer_posthog" },
      },
      ["kind"],
    ),
    object(
      {
        kind: literal("schedule"),
        cron: { type: "string", minLength: 5, maxLength: 200 },
        timezone: { type: "string", minLength: 1, maxLength: 100, default: "UTC" },
        report_kind: enumString(["funnel_review", "reliability_review", "custom"]),
        start_window_seconds: { type: "integer", minimum: 60, maximum: 86_400, default: 900 },
      },
      ["kind", "cron", "report_kind"],
    ),
  ],
  discriminator: { propertyName: "kind" },
} as const;

const automationScope = object(
  {
    allowed_paths: array({ type: "string", minLength: 1, maxLength: 500 }),
    forbidden_paths: array({ type: "string", minLength: 1, maxLength: 500 }),
    forbidden_change_types: array(enumString([
      "dependencies",
      "database_migrations",
      "infrastructure",
      "authentication",
      "billing",
      "permissions",
    ])),
    max_files_changed: { type: "integer", minimum: 0, maximum: 100 },
    max_changed_lines: { type: "integer", minimum: 0, maximum: 10_000 },
    test_commands: array({ type: "string", minLength: 1, maxLength: 500 }),
  },
  [],
);

const automationBudgets = object(
  {
    max_runs_per_day: { type: "integer", minimum: 1, maximum: 1_000, default: 10 },
    max_prs_per_day: { type: "integer", minimum: 0, maximum: 100, default: 2 },
    max_attempts_per_case_revision: { type: "integer", minimum: 1, maximum: 20, default: 2 },
    max_turns_per_run: { type: "integer", minimum: 1, maximum: 500, default: 30 },
    max_runtime_seconds: { type: "integer", minimum: 60, maximum: 86_400, default: 1_800 },
    max_cost_usd_per_run: { type: "number", minimum: 0, maximum: 10_000 },
  },
);

const automationApprovals = object(
  {
    required_for: array(literal("draft_pr")),
    expires_after_seconds: { type: "integer", minimum: 300, maximum: 2_592_000, default: 86_400 },
  },
);

const automationTemplateRef = object(
  {
    id: templateIdentifier,
    version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    bindings_sha256: sha256,
  },
  ["id", "version", "bindings_sha256"],
);

const automationDefinition = {
  ...object(
  {
    id: automationIdentifier,
    template_ref: automationTemplateRef,
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2_000 },
    enabled: { type: "boolean", default: false },
    runner: automationRunner,
    trigger: automationTrigger,
    report_plan: automationReportPlan,
    allowed_actions: array(enumString(["draft_pr", "escalate", "record_report"])),
    scope: automationScope,
    budgets: automationBudgets,
    approvals: automationApprovals,
    escalation: object(
      {
        destination: { type: "string", minLength: 1, maxLength: 500 },
        instructions: { type: "string", minLength: 1, maxLength: 2_000 },
      },
      ["destination", "instructions"],
    ),
    verification: automationVerificationPolicy,
    failure_policy: object(
      {
        retry_backoff_seconds: { type: "integer", minimum: 60, maximum: 86_400, default: 900 },
        on_attempt_budget_exhausted: { ...literal("escalate"), default: "escalate" },
      },
    ),
    data_boundary: object(
      {
        telemetry_is_untrusted_data: { ...literal(true), default: true },
        never_follow_telemetry_instructions: { ...literal(true), default: true },
        never_execute_telemetry_commands: { ...literal(true), default: true },
        allow_external_urls_from_telemetry: { ...literal(false), default: false },
      },
    ),
  },
    ["id", "name", "runner", "trigger", "allowed_actions", "scope", "escalation"],
  ),
  "x-agentry-runtime-constraints": [
    "draft_pr requires repository, default_branch, non-empty allowed_paths/test_commands, positive max_files_changed/max_changed_lines, customer_posthog unhandled_cases trigger, and canonical verification",
    "record_report requires a schedule trigger and immutable report_plan",
  ],
} as const;

const automationContractInput = object(
  {
    schema_version: { ...literal("2"), default: "2" },
    revision: { type: "integer", minimum: 1, default: 1 },
    enabled: { type: "boolean", default: false },
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
    automations: { ...array(automationDefinition), minItems: 1, maxItems: 50 },
    notes: { ...array({ type: "string", maxLength: 2_000 }), maxItems: 20, default: [] },
  },
  ["summary", "automations"],
);

const disabledAutomationContractInput = {
  ...automationContractInput,
  properties: {
    ...automationContractInput.properties,
    enabled: { ...literal(false), default: false },
  },
};

const verificationSampleResult = object(
  {
    state: enumString(["sufficient", "insufficient"]),
    blueprint_id: literal("automation_deploy_traffic_sample"),
    event_name: { type: "string", minLength: 1, maxLength: 200 },
    sample_count: { type: "integer", minimum: 0 },
    min_sample_size: { type: "integer", minimum: 1 },
    rows: {
      ...array(object({ sample_count: { type: "integer", minimum: 0 } }, ["sample_count"])),
      maxItems: 1,
    },
    window: verificationWindow,
    input_readiness: nullable(queryBlueprintInputReadiness),
    data_boundary: telemetryDataBoundary,
  },
  [
    "state",
    "blueprint_id",
    "event_name",
    "sample_count",
    "min_sample_size",
    "rows",
    "window",
    "input_readiness",
    "data_boundary",
  ],
);

const verificationOutcomeResult = {
  oneOf: [
    object(
      {
        state: literal("not_executed"),
        blueprint_id: literal("automation_case_recurrence_after_deploy"),
        reason: literal("sample_gate_not_met"),
        rows: {
          ...array(object({ recurrence_count: { type: "integer", minimum: 0 } }, ["recurrence_count"])),
          maxItems: 0,
        },
        window: verificationWindow,
        data_boundary: telemetryDataBoundary,
      },
      ["state", "blueprint_id", "reason", "rows", "window", "data_boundary"],
    ),
    object(
      {
        state: literal("evaluated"),
        blueprint_id: literal("automation_case_recurrence_after_deploy"),
        recurrence_count: { type: "integer", minimum: 0 },
        predicate: verificationPredicate,
        passed: boolean,
        rows: {
          ...array(object({ recurrence_count: { type: "integer", minimum: 0 } }, ["recurrence_count"])),
          maxItems: 1,
        },
        window: verificationWindow,
        data_boundary: telemetryDataBoundary,
      },
      [
        "state",
        "blueprint_id",
        "recurrence_count",
        "predicate",
        "passed",
        "rows",
        "window",
        "data_boundary",
      ],
    ),
  ],
  discriminator: { propertyName: "state" },
} as const;

const trustedDeployResult = object(
  {
    id: { type: "string", minLength: 1, maxLength: 200 },
    sha: { type: "string", minLength: 1, maxLength: 200 },
    source_commit_sha: nullable({ type: "string", minLength: 1, maxLength: 200 }),
    received_at: timestamp,
    credential_id: nullable({ type: "string", minLength: 1, maxLength: 200 }),
    credential_kind: literal("ci_deploy"),
    trust_level: literal("trusted_ci"),
  },
  [
    "id",
    "sha",
    "source_commit_sha",
    "received_at",
    "credential_id",
    "credential_kind",
    "trust_level",
  ],
);

const pendingVerificationResult = object(
  {
    state: literal("pending_sample"),
    checked_at: timestamp,
    trusted_deploy: trustedDeployResult,
    sample: verificationSampleResult,
    outcome: verificationOutcomeResult,
    retry_after_seconds: { type: "integer", minimum: 0 },
    deadline_at: timestamp,
  },
  [
    "state",
    "checked_at",
    "trusted_deploy",
    "sample",
    "outcome",
    "retry_after_seconds",
    "deadline_at",
  ],
);

const completeVerificationResult = object(
  {
    state: literal("complete"),
    checked_at: timestamp,
    trusted_deploy: trustedDeployResult,
    sample: verificationSampleResult,
    outcome: verificationOutcomeResult,
    passed: boolean,
  },
  ["state", "checked_at", "trusted_deploy", "sample", "outcome", "passed"],
);

const automationTestEvidence = object(
  {
    command: { type: "string", minLength: 1, maxLength: 500 },
    status: enumString(["passed", "failed", "skipped"]),
    exit_code: { type: "integer", minimum: -1, maximum: 255 },
    duration_ms: { type: "integer", minimum: 0, maximum: 86_400_000 },
    output_excerpt: { type: "string", maxLength: 4_000 },
  },
  ["command", "status"],
);

const changedLines = object(
  {
    added: { type: "integer", minimum: 0, maximum: 100_000 },
    deleted: { type: "integer", minimum: 0, maximum: 100_000 },
  },
  ["added", "deleted"],
);

const metricFinding = object(
  {
    kind: literal("metric"),
    metric: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,199}$" },
    unit: enumString(["count", "percent", "ratio", "seconds", "currency"]),
    prior_value: nullable(number),
    current_value: nullable(number),
    change: nullable(number),
    source_columns: { ...array({ type: "string", minLength: 1, maxLength: 200 }), minItems: 1, maxItems: 20 },
  },
  ["kind", "metric", "unit", "prior_value", "current_value", "change", "source_columns"],
);

const hypothesisFinding = object(
  {
    kind: literal("hypothesis"),
    rank: { type: "integer", minimum: 1, maximum: 100 },
    title: { type: "string", minLength: 1, maxLength: 300 },
    rationale: { type: "string", minLength: 1, maxLength: 2_000 },
    expected_impact: enumString(["low", "medium", "high", "unknown"]),
    confidence: enumString(["low", "medium", "high"]),
    evidence_columns: { ...array({ type: "string", minLength: 1, maxLength: 200 }), minItems: 1, maxItems: 20 },
    suggested_human_next_step: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  [
    "kind",
    "rank",
    "title",
    "rationale",
    "expected_impact",
    "confidence",
    "evidence_columns",
    "suggested_human_next_step",
  ],
);

const readinessGapFinding = object(
  {
    kind: literal("readiness_gap"),
    code: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,199}$" },
    message: { type: "string", minLength: 1, maxLength: 2_000 },
    required_signal: { type: "string", minLength: 1, maxLength: 200 },
  },
  ["kind", "code", "message"],
);

const reportEvidence = object(
  {
    kind: enumString(["funnel_review", "reliability_review", "custom"]),
    period_start: timestamp,
    period_end: timestamp,
    source_hash: sha256,
    findings: {
      ...array({
        oneOf: [metricFinding, hypothesisFinding, readinessGapFinding],
        discriminator: { propertyName: "kind" },
      }),
      maxItems: 100,
    },
    limitations: {
      ...array({ type: "string", minLength: 1, maxLength: 1_000 }),
      maxItems: 20,
      default: [],
    },
  },
  ["kind", "period_start", "period_end", "source_hash", "findings"],
);

const automationRunEvidence = object(
  {
    change_types: array(enumString([
      "application_code",
      "tests",
      "documentation",
      "dependencies",
      "database_migrations",
      "infrastructure",
      "authentication",
      "billing",
      "permissions",
    ])),
    changed_files: array({ type: "string", minLength: 1, maxLength: 500 }),
    changed_lines: changedLines,
    tests: array(automationTestEvidence),
    ci: object(
      {
        status: enumString(["pending", "passed", "failed", "cancelled"]),
        url: httpsUrl,
      },
      ["status"],
    ),
    artifacts: array(object(
      {
        kind: enumString(["log", "diff", "report", "screenshot", "other"]),
        url: httpsUrl,
        label: { type: "string", maxLength: 300 },
      },
      ["kind", "url"],
    )),
    report: reportEvidence,
  },
);

const draftPrSubject = object(
  {
    kind: literal("draft_pr"),
    branch: { type: "string", minLength: 1, maxLength: 300 },
    commit_sha: commitSha,
    change_types: automationRunEvidence.properties.change_types,
    changed_files: automationRunEvidence.properties.changed_files,
    changed_lines: changedLines,
    tests: automationRunEvidence.properties.tests,
  },
  ["kind", "branch", "commit_sha", "change_types", "changed_files", "changed_lines", "tests"],
);

const approvalEvidence = object(
  {
    request_reason: nullable({ type: "string", maxLength: 2_000 }),
    decision_reason: nullable({ type: "string", maxLength: 2_000 }),
    subject: boundedEvidence,
  },
  ["request_reason", "decision_reason", "subject"],
);

const automationApproval = object(
  {
    data_boundary: telemetryDataBoundary,
    id: string,
    project_id: string,
    automation_id: string,
    run_id: string,
    action: literal("draft_pr"),
    status: enumString(["pending", "approved", "rejected", "expired", "cancelled"]),
    requested_by: string,
    decided_by: nullable(string),
    subject_hash: sha256,
    evidence: approvalEvidence,
    run_url: { type: "string", pattern: "^/v1/automation-runs/" },
    requested_at: timestamp,
    decided_at: nullable(timestamp),
    expires_at: timestamp,
  },
  [
    "data_boundary",
    "id",
    "project_id",
    "automation_id",
    "run_id",
    "action",
    "status",
    "requested_by",
    "decided_by",
    "subject_hash",
    "evidence",
    "run_url",
    "requested_at",
    "decided_at",
    "expires_at",
  ],
);

const automationRunRunner = object(
  {
    provider: nullable(enumString(["codex", "claude_code", "github_actions", "custom"])),
    id: nullable({ type: "string", minLength: 1, maxLength: 300 }),
    credential_id: nullable({ type: "string", minLength: 1, maxLength: 300 }),
    model: nullable({ type: "string", minLength: 1, maxLength: 200 }),
  },
  ["provider", "id", "credential_id", "model"],
);

const automationRunLifecycle = object(
  {
    deadline_at: timestamp,
    last_heartbeat_at: nullable(timestamp),
    retry_eligible_at: nullable(timestamp),
    turns_used: { type: "integer", minimum: 0 },
    cost_usd: { type: "number", minimum: 0 },
    usage_sequence: { type: "integer", minimum: 0 },
  },
  ["deadline_at", "last_heartbeat_at", "retry_eligible_at", "turns_used", "cost_usd", "usage_sequence"],
);

const automationRunPrProof = object(
  {
    source: literal("trusted_ci"),
    credential_id: nullable(string),
    proof_hash: nullable(sha256),
    recorded_at: nullable(timestamp),
    evidence: boundedEvidence,
  },
  ["source", "credential_id", "proof_hash", "recorded_at", "evidence"],
);

const automationRunControl = object(
  {
    source: literal("agentry_system"),
    contract_revision: { type: "integer", minimum: 1 },
    contract_etag: { type: "string", minLength: 1, maxLength: 300 },
    policy_snapshot: automationDefinition,
    policy_authority: literal("structured_fields_only"),
    note: { type: "string", minLength: 1, maxLength: 1_000 },
    lifecycle: automationRunLifecycle,
    pr_proof: nullable(automationRunPrProof),
    verification: nullable(boundedEvidence),
  },
  [
    "source",
    "contract_revision",
    "contract_etag",
    "policy_snapshot",
    "policy_authority",
    "note",
    "lifecycle",
    "pr_proof",
    "verification",
  ],
);

const automationRunTriggerReceipt = object(
  {
    id: string,
    source: literal("agentry_system"),
    eligibility_authority: literal("trigger_only"),
    instruction_authority: literal("none"),
    trigger_ref: { type: "string", minLength: 1, maxLength: 500 },
    observation: boundedEvidence,
    inspection: telemetryInspection,
  },
  ["id", "source", "eligibility_authority", "instruction_authority", "trigger_ref", "observation", "inspection"],
);

const automationRunRunnerOutput = object(
  {
    source: literal("runner_attested_unverified"),
    instruction_authority: literal("none"),
    evidence: boundedEvidence,
    inspection: telemetryInspection,
  },
  ["source", "instruction_authority", "evidence", "inspection"],
);

const automationRun = object(
  {
    data_boundary: telemetryDataBoundary,
    id: string,
    project_id: string,
    automation_id: string,
    case_id: nullable(string),
    case_revision: nullable(integer),
    trigger_kind: enumString(["alert", "unhandled_cases", "schedule"]),
    trigger_receipt_id: string,
    request_hash: sha256,
    attempt: { type: "integer", minimum: 1 },
    status: enumString([
      "queued",
      "claimed",
      "running",
      "draft_pr_opened",
      "awaiting_approval",
      "verifying",
      "succeeded",
      "failed",
      "escalated",
      "cancelled",
    ]),
    runner: automationRunRunner,
    control: automationRunControl,
    trigger_receipt: automationRunTriggerReceipt,
    runner_output: automationRunRunnerOutput,
    started_at: nullable(timestamp),
    finished_at: nullable(timestamp),
    created_at: timestamp,
    updated_at: timestamp,
    idempotent_replay: boolean,
    next_action: string,
  },
  [
    "data_boundary",
    "id",
    "project_id",
    "automation_id",
    "case_id",
    "case_revision",
    "trigger_kind",
    "trigger_receipt_id",
    "request_hash",
    "attempt",
    "status",
    "runner",
    "control",
    "trigger_receipt",
    "runner_output",
    "started_at",
    "finished_at",
    "created_at",
    "updated_at",
  ],
);

const automationTriggerReceiptTrigger = object(
  {
    kind: enumString(["alert", "unhandled_cases", "schedule"]),
    key: { type: "string", minLength: 1, maxLength: 500 },
    case_id: nullable(string),
    case_revision: nullable({ type: "integer", minimum: 1 }),
    attempt: nullable({ type: "integer", minimum: 1 }),
    alert_id: nullable(string),
    scheduled_for: nullable(timestamp),
    required_trust: enumString(["any", "customer_posthog", "server_evaluated", "agentry_system"]),
    source_trust: enumString(["customer_posthog", "trusted_ci", "agentry_system"]),
  },
  [
    "kind",
    "key",
    "case_id",
    "case_revision",
    "attempt",
    "alert_id",
    "scheduled_for",
    "required_trust",
    "source_trust",
  ],
);

const automationTriggerReceiptProof = object(
  {
    snapshot_hash: sha256,
    trigger_snapshot: boundedEvidence,
  },
  ["snapshot_hash", "trigger_snapshot"],
);

const automationTriggerReceiptBinding = object(
  { claim_id: nullable(string), run_id: nullable(string) },
  ["claim_id", "run_id"],
);

const automationTriggerReceiptValidity = object(
  {
    issued_at: timestamp,
    not_before_at: timestamp,
    expires_at: timestamp,
    claimed_at: nullable(timestamp),
    consumed_at: nullable(timestamp),
    cancelled_at: nullable(timestamp),
    cancel_reason: nullable({ type: "string", maxLength: 2_000 }),
  },
  ["issued_at", "not_before_at", "expires_at", "claimed_at", "consumed_at", "cancelled_at", "cancel_reason"],
);

const automationTriggerReceiptAuthority = object(
  {
    grants: {
      ...array(literal("claim_or_start_exact_occurrence_once")),
      minItems: 1,
      maxItems: 1,
    },
    does_not_grant: {
      ...array(enumString(["code_change", "draft_pr", "merge", "deploy", "case_status_change"])),
      minItems: 5,
      maxItems: 5,
    },
    note: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  ["grants", "does_not_grant", "note"],
);

const triggerReceipt = object(
  {
    id: string,
    project_id: string,
    automation_id: string,
    contract_revision: integer,
    contract_etag: string,
    status: enumString(["ready", "claimed", "consumed", "expired", "cancelled"]),
    trigger: automationTriggerReceiptTrigger,
    proof: automationTriggerReceiptProof,
    binding: automationTriggerReceiptBinding,
    validity: automationTriggerReceiptValidity,
    authority: automationTriggerReceiptAuthority,
  },
  ["id", "project_id", "automation_id", "contract_revision", "contract_etag", "status", "trigger", "proof", "binding", "validity", "authority"],
);

const automationTriggerSkip = object(
  {
    code: { type: "string", pattern: "^[a-z][a-z0-9_]{0,199}$" },
    reason: { type: "string", minLength: 1, maxLength: 2_000 },
    details: boundedEvidence,
  },
  ["code", "reason"],
);

const automationRunEvent = object(
  {
    id: string,
    event: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,199}$" },
    from_status: nullable(automationRun.properties.status),
    to_status: nullable(automationRun.properties.status),
    actor: nullable({ type: "string", maxLength: 500 }),
    data: boundedEvidence,
    at: timestamp,
  },
  ["id", "event", "from_status", "to_status", "actor", "data", "at"],
);

const caseClaim = object(
  {
    id: string,
    project_id: string,
    case_id: string,
    case_revision: { type: "integer", minimum: 1 },
    automation_id: string,
    trigger_receipt_id: string,
    contract_revision: integer,
    contract_etag: string,
    attempt: { type: "integer", minimum: 1 },
    claimed_by: string,
    credential_id: nullable(string),
    acquired_at: timestamp,
    expires_at: timestamp,
    run_id: nullable(string),
    released_at: nullable(timestamp),
    release_reason: nullable(string),
    lease_token: string,
    idempotent_replay: boolean,
    next_action: string,
  },
  ["id", "project_id", "case_id", "case_revision", "automation_id", "trigger_receipt_id", "attempt", "claimed_by", "acquired_at", "expires_at"],
  true,
);

const reportSourcePayload = object(
  {
    schema_version: string,
    source: string,
    consistency: string,
    blueprint_id: string,
    plan_hash: sha256,
    input_readiness: nullable(queryBlueprintInputReadiness),
    scheduled_for: timestamp,
    period_start: timestamp,
    period_end: timestamp,
    columns: array(string),
    rows: { ...array({ type: "object", additionalProperties: scalar }), maxItems: 100 },
    row_count: { type: "integer", minimum: 0, maximum: 100 },
    queried_at: timestamp,
    query_duration_ms: { type: "integer", minimum: 0 },
  },
  [
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
  ],
);

const reportSourceReadiness = object(
  {
    status: enumString(["ready", "blocked"]),
    contract: object(
      {
        kind: literal("all_rows_boolean"),
        column: { type: "string", minLength: 1, maxLength: 200 },
        expected_rows: { type: "integer", minimum: 0, maximum: 100 },
        row_identity: object(
          {
            column: { type: "string", minLength: 1, maxLength: 200 },
            values: { ...array({ type: "string", maxLength: 1_000 }), maxItems: 100 },
          },
          ["column", "values"],
        ),
      },
      ["kind", "column", "expected_rows", "row_identity"],
    ),
    checks: object(
      {
        exact_row_count: boolean,
        exact_row_identity_order: boolean,
        all_sample_gates_passed: boolean,
      },
      ["exact_row_count", "exact_row_identity_order", "all_sample_gates_passed"],
    ),
    next_action: string,
  },
  ["status", "contract", "checks", "next_action"],
);

const automationReportSource = object(
  {
    data_boundary: telemetryDataBoundary,
    id: string,
    project_id: string,
    automation_id: string,
    run_id: string,
    blueprint_id: string,
    plan_hash: sha256,
    source_hash: sha256,
    source: reportSourcePayload,
    readiness: reportSourceReadiness,
    idempotent_replay: boolean,
    created_at: timestamp,
    next_action: string,
  },
  [
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
  ],
  true,
);

const errorPlaybookBudgets = object(
  {
    max_runs_per_day: { type: "integer", minimum: 1, maximum: 1_000 },
    max_prs_per_day: { type: "integer", minimum: 1, maximum: 100 },
    max_attempts_per_case_revision: { type: "integer", minimum: 1, maximum: 20 },
    max_turns_per_run: { type: "integer", minimum: 1, maximum: 500 },
    max_runtime_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
    max_cost_usd_per_run: { type: "number", exclusiveMinimum: 0, maximum: 10_000 },
  },
  [
    "max_runs_per_day",
    "max_prs_per_day",
    "max_attempts_per_case_revision",
    "max_turns_per_run",
    "max_runtime_seconds",
    "max_cost_usd_per_run",
  ],
);

const weeklyPlaybookBudgets = {
  ...object(
    {
      max_runs_per_day: { type: "integer", minimum: 1, maximum: 1_000 },
      max_turns_per_run: { type: "integer", minimum: 1, maximum: 500 },
      max_runtime_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
      max_cost_usd_per_run: { type: "number", exclusiveMinimum: 0, maximum: 10_000 },
    },
    ["max_runs_per_day", "max_turns_per_run", "max_runtime_seconds", "max_cost_usd_per_run"],
  ),
  description: "Weekly report caller budgets only. Rendering locks max_prs_per_day=0 and max_attempts_per_case_revision=1; callers cannot choose either field.",
} as const;

const playbookEscalation = object(
  {
    destination: { type: "string", minLength: 1, maxLength: 500 },
    instructions: { type: "string", minLength: 1, maxLength: 2_000 },
  },
  ["destination", "instructions"],
);

const playbookRunner = object(
  {
    provider: enumString(["codex", "claude_code", "github_actions", "custom"]),
    repository: httpsUrl,
    default_branch: { type: "string", minLength: 1, maxLength: 200 },
    environment: { type: "string", minLength: 1, maxLength: 100 },
  },
  ["provider", "repository", "default_branch"],
);

const reportPlaybookRunner = object(
  {
    provider: enumString(["codex", "claude_code", "github_actions", "custom"]),
    environment: { type: "string", minLength: 1, maxLength: 100 },
  },
  ["provider"],
);

const directRunnerInvocation = object(
  {
    executable: { type: "string", minLength: 1, maxLength: 500 },
    argv: {
      ...array({ type: "string", maxLength: 500, pattern: "^[^\\u0000-\\u001F\\u007F]*$" }),
      maxItems: 50,
    },
  },
  ["executable", "argv"],
);

const playbookRunnerExecution = {
  oneOf: [
    object({ provider: literal("codex") }, ["provider"]),
    object({ provider: literal("claude_code") }, ["provider"]),
    object(
      {
        provider: literal("github_actions"),
        github_actions: object(
          {
            workflow_file: { type: "string", minLength: 1, maxLength: 500 },
            job_id: { type: "string", minLength: 1, maxLength: 200 },
            environment_name: { type: "string", minLength: 1, maxLength: 200 },
            invocation: directRunnerInvocation,
          },
          ["workflow_file", "job_id", "environment_name", "invocation"],
        ),
      },
      ["provider", "github_actions"],
    ),
    object(
      {
        provider: literal("custom"),
        custom: object(
          {
            management_surface: { type: "string", minLength: 1, maxLength: 500 },
            credential_destination: { type: "string", minLength: 1, maxLength: 1_000 },
            invocation: directRunnerInvocation,
          },
          ["management_surface", "credential_destination", "invocation"],
        ),
      },
      ["provider", "custom"],
    ),
  ],
  discriminator: { propertyName: "provider" },
  "x-agentry-runtime-constraints": ["execution.provider must exactly match runner.provider"],
} as const;

const errorPlaybookRenderRequest = object(
  {
    version: literal("2.0.0"),
    bindings: object(
      {
        automation_id: automationIdentifier,
        name: { type: "string", minLength: 1, maxLength: 200 },
        runner: playbookRunner,
        execution: playbookRunnerExecution,
        trigger: object(
          {
            max_cases_per_sweep: { type: "integer", minimum: 1, maximum: 100 },
            cooldown_seconds: { type: "integer", minimum: 60, maximum: 604_800 },
          },
          ["max_cases_per_sweep", "cooldown_seconds"],
        ),
        scope: object(
          {
            allowed_paths: { ...array({ type: "string", minLength: 1, maxLength: 500 }), minItems: 1, maxItems: 100 },
            test_commands: { ...array({ type: "string", minLength: 1, maxLength: 500 }), minItems: 1, maxItems: 30 },
            max_files_changed: { type: "integer", minimum: 1, maximum: 100 },
            max_changed_lines: { type: "integer", minimum: 1, maximum: 10_000 },
          },
          ["allowed_paths", "test_commands", "max_files_changed", "max_changed_lines"],
        ),
        budgets: errorPlaybookBudgets,
        approval_expires_after_seconds: { type: "integer", minimum: 300, maximum: 2_592_000 },
        traffic_sample_event: { type: "string", minLength: 1, maxLength: 200, pattern: EVENT_NAME_PATTERN },
        verification: {
          ...object(
          {
            observation_window_seconds: { type: "integer", minimum: 60, maximum: 2_592_000 },
            max_wait_seconds: { type: "integer", minimum: 60, maximum: 2_592_000 },
            min_sample_size: { type: "integer", minimum: 1, maximum: 10_000_000 },
          },
          ["observation_window_seconds", "max_wait_seconds", "min_sample_size"],
          ),
          "x-agentry-runtime-constraints": ["max_wait_seconds >= observation_window_seconds"],
        },
        escalation: playbookEscalation,
      },
      [
        "automation_id",
        "name",
        "runner",
        "execution",
        "trigger",
        "scope",
        "budgets",
        "approval_expires_after_seconds",
        "traffic_sample_event",
        "verification",
        "escalation",
      ],
    ),
    readiness_assertions: object(
      {
        repository_draft_pr_access_confirmed: boolean,
        ci_proof_callback_configured: boolean,
        deploy_ingest_configured: boolean,
      },
      [
        "repository_draft_pr_access_confirmed",
        "ci_proof_callback_configured",
        "deploy_ingest_configured",
      ],
    ),
  },
  ["version", "bindings", "readiness_assertions"],
);

const weeklyPlaybookRenderRequest = object(
  {
    version: literal("2.0.0"),
    bindings: object(
      {
        automation_id: automationIdentifier,
        name: { type: "string", minLength: 1, maxLength: 200 },
        runner: reportPlaybookRunner,
        execution: playbookRunnerExecution,
        schedule: object(
          {
            cron: {
              type: "string",
              minLength: 5,
              maxLength: 200,
              description: "Validated by the canonical conservative five-field isValidCronExpression parser.",
              "x-agentry-runtime-validator": "isValidCronExpression",
            },
            timezone: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              description: "Validated as an IANA time zone by isValidTimeZone/Intl.DateTimeFormat.",
              "x-agentry-runtime-validator": "isValidTimeZone",
            },
            start_window_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
          },
          ["cron", "timezone", "start_window_seconds"],
        ),
        funnel: {
          ...object(
          {
            events: {
              ...array({ type: "string", minLength: 1, maxLength: 200, pattern: EVENT_NAME_PATTERN }),
              minItems: 2,
              maxItems: 20,
            },
            period_days: { type: "integer", minimum: 1, maximum: 90 },
            minimum_sample_size: { type: "integer", minimum: 1, maximum: 100_000 },
          },
          ["events", "period_days", "minimum_sample_size"],
          ),
          "x-agentry-runtime-constraints": ["events must contain 2–20 pairwise-distinct names in funnel order"],
        },
        budgets: weeklyPlaybookBudgets,
        escalation: playbookEscalation,
      },
      ["automation_id", "name", "runner", "execution", "schedule", "funnel", "budgets", "escalation"],
    ),
    readiness_assertions: object(
      { scheduler_execution_configured: boolean },
      ["scheduler_execution_configured"],
    ),
  },
  ["version", "bindings", "readiness_assertions"],
);

const relatedOperation = object(
  {
    operation_id: string,
    method: enumString(["GET", "POST", "PUT", "PATCH"]),
    path: string,
  },
  ["operation_id", "method", "path"],
);

const schedulerHandoffOperationIds = [
  "put_automation_contract",
  "create_project_credential",
  "enable_automation_contract",
  "issue_automation_triggers",
  "list_automation_trigger_receipts",
  "get_automation_trigger_receipt",
  "claim_case",
  "start_automation_run",
  "report_automation_usage",
  "update_automation_run",
  "request_automation_approval",
  "decide_automation_approval",
  "authorize_draft_pr",
  "consume_draft_pr_grant",
  "record_automation_pr_proof",
  "record_deploy",
  "verify_automation_run",
  "get_automation_report_source",
  "record_automation_report",
  "list_automation_runs",
  "get_automation_run",
  "get_automation_control",
  "pause_automation_contract",
  "set_automation_enabled",
  "cancel_automation_run",
  "revoke_project_credential",
] as const;

const schedulerHandoffOperation = object(
  {
    phase: enumString(["setup", "execute", "observe", "stop"]),
    operation_id: enumString(schedulerHandoffOperationIds),
    method: enumString(["GET", "POST", "PUT", "PATCH"]),
    href_template: { type: "string", minLength: 1, maxLength: 1_000 },
    required_principal: enumString([
      "automation_runner",
      "human_project_member",
      "human_project_owner",
      "trusted_ci",
    ]),
    required_headers: {
      ...array(enumString([
        "Idempotency-Key",
        "If-Match",
        "X-Agentry-Lease-Token",
        "X-Agentry-Action-Token",
      ])),
      maxItems: 2,
      uniqueItems: true,
    },
    purpose: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  [
    "phase",
    "operation_id",
    "method",
    "href_template",
    "required_principal",
    "required_headers",
    "purpose",
  ],
);

const schedulerScheduleSemantics = object(
  {
    mode: enumString([
      "wake_and_consume_due_schedule_receipt",
      "poll_and_consume_server_issued_receipts",
    ]),
    recurrence_source: enumString([
      "contract_schedule",
      "operator_selected_poll_cadence",
    ]),
    cron: nullable({ type: "string", minLength: 5, maxLength: 200 }),
    timezone: nullable({ type: "string", minLength: 1, maxLength: 100 }),
    start_window_seconds: nullable({ type: "integer", minimum: 60, maximum: 86_400 }),
    receipt_authority: { type: "string", minLength: 1, maxLength: 1_000 },
    scheduled_for_policy: { type: "string", minLength: 1, maxLength: 1_000 },
    duplicate_policy: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  [
    "mode",
    "recurrence_source",
    "cron",
    "timezone",
    "start_window_seconds",
    "receipt_authority",
    "scheduled_for_policy",
    "duplicate_policy",
  ],
);

const schedulerCredentialPlacement = object(
  {
    kind: literal("automation_runner"),
    automation_id: automationIdentifier,
    env_var: literal("AGENTRY_RUNNER_API_KEY"),
    destination: { type: "string", minLength: 1, maxLength: 1_000 },
    secret_included: literal(false),
    one_automation_only: literal(true),
    owner_private_key_allowed: literal(false),
    forbidden_destinations: {
      ...array({ type: "string", minLength: 1, maxLength: 200 }),
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
    },
  },
  [
    "kind",
    "automation_id",
    "env_var",
    "destination",
    "secret_included",
    "one_automation_only",
    "owner_private_key_allowed",
    "forbidden_destinations",
  ],
);

const schedulerProofStep = object(
  {
    order: { type: "integer", minimum: 1, maximum: 12 },
    actor: enumString(["human_owner", "scheduler_runner", "trusted_ci"]),
    action: { type: "string", minLength: 1, maxLength: 2_000 },
    operation_ids: {
      ...array(enumString(schedulerHandoffOperationIds)),
      maxItems: 5,
      uniqueItems: true,
    },
    required_evidence: {
      ...array({ type: "string", minLength: 1, maxLength: 1_000 }),
      minItems: 1,
      maxItems: 5,
    },
  },
  ["order", "actor", "action", "operation_ids", "required_evidence"],
);

const schedulerFirstRunProof = object(
  {
    required: literal(true),
    mode: literal("manual_before_unattended_recurrence"),
    template: enumString(["error-to-draft-pr", "weekly-funnel-review"]),
    steps: {
      oneOf: [
        { ...array(schedulerProofStep), minItems: 7, maxItems: 7 },
        { ...array(schedulerProofStep), minItems: 12, maxItems: 12 },
      ],
    },
    success_evidence: {
      oneOf: [
        { ...array({ type: "string", minLength: 1, maxLength: 1_000 }), minItems: 4, maxItems: 4 },
        { ...array({ type: "string", minLength: 1, maxLength: 1_000 }), minItems: 6, maxItems: 6 },
      ],
    },
  },
  ["required", "mode", "template", "steps", "success_evidence"],
);

const schedulerPollingOutput = object(
  {
    receipt_list_operation_id: literal("list_automation_trigger_receipts"),
    run_list_operation_id: literal("list_automation_runs"),
    run_detail_operation_id: literal("get_automation_run"),
    pagination_policy: { type: "string", minLength: 1, maxLength: 1_000 },
    terminal_statuses: {
      ...array(enumString(["succeeded", "failed", "escalated", "cancelled"])),
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
    },
    output_visibility: {
      ...array({ type: "string", minLength: 1, maxLength: 500 }),
      minItems: 4,
      maxItems: 4,
    },
  },
  [
    "receipt_list_operation_id",
    "run_list_operation_id",
    "run_detail_operation_id",
    "pagination_policy",
    "terminal_statuses",
    "output_visibility",
  ],
);

const schedulerStopAndEscalation = object(
  {
    external_scheduler_stop_required: literal(true),
    agentry_operation_ids: {
      ...array(enumString([
        "pause_automation_contract",
        "set_automation_enabled",
        "cancel_automation_run",
        "revoke_project_credential",
      ])),
      minItems: 4,
      maxItems: 4,
      uniqueItems: true,
    },
    escalation_destination: { type: "string", minLength: 1, maxLength: 500 },
    stop_conditions: {
      ...array({ type: "string", minLength: 1, maxLength: 1_000 }),
      minItems: 5,
      maxItems: 5,
    },
    provider_stop_action: { type: "string", minLength: 1, maxLength: 1_000 },
  },
  [
    "external_scheduler_stop_required",
    "agentry_operation_ids",
    "escalation_destination",
    "stop_conditions",
    "provider_stop_action",
  ],
);

const schedulerHandoffCommonProperties = {
  selected_by_runner_binding: literal(true),
  state: literal("proposal_only"),
  contract_enabled: literal(false),
  automation_enabled: literal(false),
  scheduler_registered: literal(false),
  api: object(
    {
      default_base_url: literal("https://api.agentry.sh"),
      override_env: literal("AGENTRY_URL"),
      user_agent_required_for_direct_http: literal(true),
    },
    ["default_base_url", "override_env", "user_agent_required_for_direct_http"],
  ),
  schedule_semantics: schedulerScheduleSemantics,
  prompt_source: literal("scheduler_neutral_prompt"),
  operations: {
    oneOf: [
      { ...array(schedulerHandoffOperation), minItems: 18, maxItems: 18 },
      { ...array(schedulerHandoffOperation), minItems: 24, maxItems: 24 },
    ],
    "x-agentry-template-item-counts": {
      "weekly-funnel-review": 18,
      "error-to-draft-pr": 24,
    },
  },
  credential_placement: schedulerCredentialPlacement,
  polling_and_output: schedulerPollingOutput,
  first_run_proof: schedulerFirstRunProof,
  stop_and_escalation: schedulerStopAndEscalation,
};

const schedulerHandoffCommonRequired = [
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

const schedulerDirectInvocation = object(
  {
    executable: { type: "string", minLength: 1, maxLength: 500 },
    argv: {
      ...array({ type: "string", maxLength: 500 }),
      maxItems: 50,
    },
    prompt_transport: literal("stdin_from_scheduler_neutral_prompt"),
    direct_argv_required: literal(true),
    shell_interpolation_forbidden: literal(true),
    output_format: literal("json"),
  },
  ["executable", "argv", "prompt_transport", "direct_argv_required", "shell_interpolation_forbidden"],
);

const codexCliSchedulerHandoff = object(
  {
    provider: literal("codex_cli_scheduler"),
    display_name: literal("Codex CLI via customer scheduler"),
    runner_provider: literal("codex"),
    ...schedulerHandoffCommonProperties,
    provider_setup: object(
      {
        management_surface: literal("customer_owned_scheduler"),
        docs_url: literal("https://developers.openai.com/codex/noninteractive"),
        registration_mode: literal("cron_ci_or_job_runner"),
        manual_registration_required: literal(true),
        recurrence_instruction: { type: "string", minLength: 1, maxLength: 1_000 },
        workspace_mode: enumString([
          "isolated_checkout_or_worktree_required",
          "no_repository_checkout_required",
        ]),
        invocation: schedulerDirectInvocation,
      },
      [
        "management_surface",
        "docs_url",
        "registration_mode",
        "manual_registration_required",
        "recurrence_instruction",
        "workspace_mode",
        "invocation",
      ],
    ),
  },
  schedulerHandoffCommonRequired,
);

const claudeCodeSchedulerHandoff = object(
  {
    provider: literal("claude_code_scheduler"),
    display_name: literal("Claude Code via customer scheduler"),
    runner_provider: literal("claude_code"),
    ...schedulerHandoffCommonProperties,
    provider_setup: object(
      {
        management_surface: literal("customer_owned_scheduler"),
        docs_url: literal("https://code.claude.com/docs/en/cli-reference"),
        registration_mode: literal("cron_ci_or_job_runner"),
        manual_registration_required: literal(true),
        recurrence_instruction: { type: "string", minLength: 1, maxLength: 1_000 },
        workspace_mode: enumString([
          "isolated_checkout_or_worktree_required",
          "no_repository_checkout_required",
        ]),
        invocation: schedulerDirectInvocation,
      },
      [
        "management_surface",
        "docs_url",
        "registration_mode",
        "manual_registration_required",
        "recurrence_instruction",
        "workspace_mode",
        "invocation",
      ],
    ),
  },
  schedulerHandoffCommonRequired,
);

const githubActionsSchedulerHandoff = object(
  {
    provider: literal("github_actions_workflow"),
    display_name: literal("GitHub Actions workflow"),
    runner_provider: literal("github_actions"),
    ...schedulerHandoffCommonProperties,
    provider_setup: object(
      {
        management_surface: literal("GitHub Actions"),
        docs_url: literal("https://docs.github.com/actions/using-workflows/events-that-trigger-workflows#schedule"),
        registration_mode: literal("existing_customer_workflow"),
        manual_registration_required: literal(true),
        recurrence_instruction: { type: "string", minLength: 1, maxLength: 1_000 },
        workspace_mode: enumString(["isolated_checkout_required", "no_repository_checkout_required"]),
        workflow_file: { type: "string", minLength: 1, maxLength: 500 },
        job_id: { type: "string", minLength: 1, maxLength: 200 },
        environment_name: { type: "string", minLength: 1, maxLength: 200 },
        invocation: schedulerDirectInvocation,
      },
      [
        "management_surface",
        "docs_url",
        "registration_mode",
        "manual_registration_required",
        "recurrence_instruction",
        "workspace_mode",
        "workflow_file",
        "job_id",
        "environment_name",
        "invocation",
      ],
    ),
  },
  schedulerHandoffCommonRequired,
);

const customSchedulerHandoff = object(
  {
    provider: literal("custom_scheduler"),
    display_name: literal("Custom executable runner"),
    runner_provider: literal("custom"),
    ...schedulerHandoffCommonProperties,
    provider_setup: object(
      {
        management_surface: { type: "string", minLength: 1, maxLength: 500 },
        docs_url: literal("https://api.agentry.sh/v1/docs/automation"),
        registration_mode: literal("customer_defined_direct_argv_runner"),
        manual_registration_required: literal(true),
        recurrence_instruction: { type: "string", minLength: 1, maxLength: 1_000 },
        workspace_mode: enumString(["isolated_checkout_or_worktree_required", "no_repository_checkout_required"]),
        invocation: schedulerDirectInvocation,
      },
      [
        "management_surface",
        "docs_url",
        "registration_mode",
        "manual_registration_required",
        "recurrence_instruction",
        "workspace_mode",
        "invocation",
      ],
    ),
  },
  schedulerHandoffCommonRequired,
);

const chatgptScheduledTaskPreview = object(
  {
    provider: literal("chatgpt_scheduled_task_preview"),
    display_name: literal("ChatGPT Scheduled tasks (advisory preview)"),
    runner_provider: literal("codex"),
    selected_by_runner_binding: literal(false),
    state: literal("blocked_advisory"),
    direct_authenticated_agentry_execution: literal("blocked"),
    scheduler_registered: literal(false),
    provider_setup: object(
      {
        management_surface: literal("Scheduled"),
        docs_url: literal("https://developers.openai.com/codex/app/automations"),
        official_name: literal("ChatGPT Scheduled tasks"),
        local_host_must_be_online_for_local_projects: literal(true),
      },
      ["management_surface", "docs_url", "official_name", "local_host_must_be_online_for_local_projects"],
    ),
    credential_placement: object(
      {
        supported: literal(false),
        env_var: nullSchema,
        destination: nullSchema,
        secret_included: literal(false),
      },
      ["supported", "env_var", "destination", "secret_included"],
    ),
    prompt_preview_source: literal("scheduler_neutral_prompt"),
    blocked_reason: { type: "string", minLength: 1, maxLength: 1_000 },
    recommended_executable_handoff: literal("codex_cli_scheduler"),
  },
  [
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
  ],
);

const schedulerHandoffs = {
  ...array({
    oneOf: [
      codexCliSchedulerHandoff,
      claudeCodeSchedulerHandoff,
      githubActionsSchedulerHandoff,
      customSchedulerHandoff,
      chatgptScheduledTaskPreview,
    ],
  }),
  minItems: 2,
  maxItems: 2,
  description: "Exactly one selected executable customer-owned handoff matching runner.provider plus one blocked advisory preview for ChatGPT Scheduled tasks in Scheduled. No provider task is registered by rendering.",
};

const automationPlaybookTemplate = object(
  {
    kind: literal("automation_playbook"),
    id: enumString(["error-to-draft-pr", "weekly-funnel-review"]),
    version: literal("2.0.0"),
    latest: boolean,
    title: string,
    description: string,
    trigger_kind: enumString(["unhandled_cases", "schedule"]),
    output_kind: enumString(["draft_pr", "funnel_review"]),
    locked_invariants: boundedEvidence,
    render_request_schema: boundedEvidence,
    run_output_schema: boundedEvidence,
    related_operations: array(relatedOperation),
    latest_version: literal("2.0.0"),
    available_versions: array(literal("2.0.0")),
    endpoints: object(
      { detail: string, render: string },
      ["detail", "render"],
    ),
    template_hash: sha256,
    next_action: string,
  },
  [
    "kind",
    "id",
    "version",
    "latest",
    "title",
    "description",
    "trigger_kind",
    "output_kind",
    "locked_invariants",
    "render_request_schema",
    "run_output_schema",
    "related_operations",
    "latest_version",
    "available_versions",
    "endpoints",
    "template_hash",
  ],
  true,
);

const normalizedDisabledContract = object(
  {
    schema_version: literal("2"),
    revision: { type: "integer", minimum: 1 },
    enabled: literal(false),
    summary: string,
    automations: array(ref("AutomationDefinition")),
    notes: array(string),
  },
  ["schema_version", "revision", "enabled", "summary", "automations", "notes"],
);

const renderedTemplateRef = object(
  {
    id: templateIdentifier,
    version: literal("2.0.0"),
    bindings_sha256: sha256,
  },
  ["id", "version", "bindings_sha256"],
);

const automationPlaybookRenderResponse = object(
  {
    kind: literal("automation_playbook_render"),
    template_ref: renderedTemplateRef,
    automation_definition: ref("AutomationDefinition"),
    contract_candidate: normalizedDisabledContract,
    scheduler_neutral_prompt: string,
    scheduler_handoffs: schedulerHandoffs,
    related_operations: array(relatedOperation),
    render_hash: sha256,
    readiness: object(
      {
        ready_for_owner_review: boolean,
        ready_to_enable: boolean,
        source_boundary: string,
        gates: array(boundedEvidence),
        blocking_gates: array(boundedEvidence),
        unresolved_inputs: array(boundedEvidence),
      },
      ["ready_for_owner_review", "ready_to_enable", "source_boundary", "gates", "blocking_gates", "unresolved_inputs"],
      true,
    ),
    side_effects: object(
      {
        database_writes: literal(false),
        contract_saved: literal(false),
        automation_enabled: literal(false),
        credential_minted: literal(false),
        provider_action_started: literal(false),
        scheduler_registered: literal(false),
        report_published_or_sent: literal(false),
      },
      [
        "database_writes",
        "contract_saved",
        "automation_enabled",
        "credential_minted",
        "provider_action_started",
        "scheduler_registered",
        "report_published_or_sent",
      ],
    ),
    next_action: string,
  },
  [
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
  ],
);

const projectCredential = object(
  {
    id: string,
    project_id: string,
    kind: enumString(["ci_deploy", "automation_runner"]),
    name: string,
    prefix: string,
    scopes: array(enumString([
      "deploys:write",
      "automation_proofs:write",
      "cases:read",
      "triggers:read",
      "triggers:issue",
      "claims:write",
      "runs:read",
      "runs:write",
      "approvals:request",
    ])),
    automation_id: nullable(string),
    created_by: string,
    created_at: timestamp,
    expires_at: timestamp,
    last_used_at: nullable(timestamp),
    revoked_at: nullable(timestamp),
    revoke_reason: nullable(string),
    active: boolean,
  },
  ["id", "project_id", "kind", "name", "prefix", "scopes", "created_at", "expires_at", "active"],
  true,
);

const automationControlOperation = object(
  {
    operation_id: enumString([
      "get_automation_contract",
      "list_automation_runs",
      "list_automation_approvals",
      "validate_automation_contract",
      "put_automation_contract",
      "enable_automation_contract",
      "pause_automation_contract",
      "set_automation_enabled",
      "decide_automation_approval",
      "cancel_automation_run",
      "list_project_credentials",
      "create_project_credential",
      "verify_automation_run",
      "record_automation_pr_proof",
      "record_deploy",
    ]),
    method: enumString(["GET", "POST", "PUT", "PATCH"]),
    href: { type: "string", minLength: 1, maxLength: 2_000 },
    href_template: { type: "string", minLength: 1, maxLength: 2_000 },
    allowed: boolean,
    required_principal: enumString(["human_owner_or_member", "human_owner", "ci_deploy"]),
    required_headers: { ...array(enumString(["Idempotency-Key", "If-Match"])), maxItems: 2 },
    required_fields: { ...array({ type: "string", minLength: 1, maxLength: 100 }), maxItems: 20 },
    conditional_fields: object(
      {
        automation_runner: {
          ...array(literal("automation_id")),
          minItems: 1,
          maxItems: 1,
        },
      },
    ),
    etag: nullable(string),
  },
  [
    "operation_id",
    "method",
    "allowed",
    "required_principal",
    "required_headers",
    "required_fields",
  ],
);

const listCredentialsControlOperation = {
  ...automationControlOperation,
  properties: {
    ...automationControlOperation.properties,
    operation_id: literal("list_project_credentials"),
    method: literal("GET"),
    required_principal: literal("human_owner"),
    required_headers: { type: "array", items: string, maxItems: 0 },
    required_fields: { type: "array", items: string, maxItems: 0 },
  },
};

const createCredentialControlOperation = {
  ...automationControlOperation,
  properties: {
    ...automationControlOperation.properties,
    operation_id: literal("create_project_credential"),
    method: literal("POST"),
    required_principal: literal("human_owner"),
    required_headers: {
      type: "array",
      items: literal("Idempotency-Key"),
      minItems: 1,
      maxItems: 1,
    },
    required_fields: {
      type: "array",
      prefixItems: [literal("kind"), literal("name")],
      items: false,
      minItems: 2,
      maxItems: 2,
    },
  },
};

const automationAttentionKind = enumString([
  "contract_inconsistent",
  "contract_not_configured",
  "contract_disabled",
  "contract_paused",
  "runner_credential_missing",
  "runner_credential_inactive",
  "new_run_budget_unavailable",
  "live_pr_budget_inconsistent",
  "live_pr_budget_mixed_policy",
  "approval_expired",
  "approval_pending",
  "global_kill_switch_active_run",
  "automation_kill_switch_active_run",
  "runner_credential_binding_invalid",
  "case_revision_or_state_changed",
  "case_claim_not_active",
  "draft_pr_grant_expired",
  "draft_pr_grant_ready",
  "run_deadline_exceeded",
  "approval_record_missing",
  "provider_wait_deadline_exceeded",
  "draft_pr_awaiting_ci_proof",
  "proven_pr_awaiting_deploy",
  "deploy_binding_state_inconsistent",
  "verification_clock_inconsistent",
  "verification_overdue",
  "verification_ready",
  "verification_observation_pending",
  "run_escalated",
  "run_failed",
  "scheduled_report_ready",
]);

const automationAttention = object(
  {
    id: { type: "string", minLength: 1, maxLength: 700 },
    kind: automationAttentionKind,
    severity: enumString(["critical", "warning", "info"]),
    href: { type: "string", minLength: 1, maxLength: 2_000 },
    automation_id: automationIdentifier,
    run_id: string,
    approval_id: string,
    action: literal("draft_pr"),
    grant_id: string,
    case_id: string,
    case_revision: { type: "integer", minimum: 1 },
    expires_at: timestamp,
    deadline_at: timestamp,
    proof_recorded_at: timestamp,
    verification_ready_at: timestamp,
    verification_max_wait_at: timestamp,
    review_state: literal("unacknowledged_no_durable_ledger"),
    finished_at: timestamp,
    secondary_reasons: { ...array(automationAttentionKind), maxItems: 30, uniqueItems: true },
    message: { type: "string", minLength: 1, maxLength: 2_000 },
    next_action: { type: "string", minLength: 1, maxLength: 2_000 },
    operator_remediation_required: boolean,
    operation: automationControlOperation,
  },
  [
    "id",
    "kind",
    "severity",
    "href",
    "message",
    "next_action",
    "operator_remediation_required",
    "operation",
  ],
);

const automationControlBudgetState = object(
  {
    kind: enumString(["run", "draft_pr"]),
    policy_source: enumString([
      "current_contract_for_new_runs",
      "current_contract_for_future_run_snapshots",
      "immutable_run_snapshot",
    ]),
    limit: { type: "integer", minimum: 0, maximum: 1_000 },
    used: { type: "integer", minimum: 0 },
    remaining: { type: "integer", minimum: 0 },
    available: boolean,
    policy_blocked: boolean,
    available_at: nullable(timestamp),
    inconsistent: literal(true),
  },
  ["kind", "policy_source", "limit", "used", "remaining", "available", "policy_blocked", "available_at"],
);

const automationControlLivePrCapacity = object(
  {
    status: enumString(["inconsistent", "no_pr_capable_live_runs", "single_policy", "mixed_policy"]),
    can_assume_available: boolean,
    live_run_count: { type: "integer", minimum: 0, maximum: 500 },
    invalid_snapshot_count: { type: "integer", minimum: 0, maximum: 500 },
    policy_source: literal("immutable_run_snapshots"),
    query_truncated: boolean,
    capacities: { ...array(automationControlBudgetState), maxItems: 500 },
  },
  [
    "status",
    "can_assume_available",
    "live_run_count",
    "invalid_snapshot_count",
    "policy_source",
    "query_truncated",
    "capacities",
  ],
);

const runCountsByStatus = object(
  Object.fromEntries([
    "queued",
    "claimed",
    "running",
    "awaiting_approval",
    "draft_pr_opened",
    "verifying",
    "succeeded",
    "failed",
    "escalated",
    "cancelled",
  ].map((status) => [status, { type: "integer", minimum: 0 }])),
  [
    "queued",
    "claimed",
    "running",
    "awaiting_approval",
    "draft_pr_opened",
    "verifying",
    "succeeded",
    "failed",
    "escalated",
    "cancelled",
  ],
);

const automationControlAutomation = object(
  {
    id: automationIdentifier,
    name: { type: "string", minLength: 1, maxLength: 200 },
    template_ref: nullable(automationTemplateRef),
    template_ref_authority: literal("descriptive_provenance"),
    configured_enabled: boolean,
    effective_enabled: boolean,
    trigger: automationTrigger,
    activity: object(
      {
        runs_by_status: runCountsByStatus,
        active_runs: { type: "integer", minimum: 0 },
        ready_trigger_receipts: { type: "integer", minimum: 0 },
        claimed_trigger_receipts: { type: "integer", minimum: 0 },
        active_case_claims: { type: "integer", minimum: 0 },
        pending_approvals: { type: "integer", minimum: 0 },
        blocked_pending_approvals: { type: "integer", minimum: 0 },
        expired_pending_approvals: { type: "integer", minimum: 0 },
      },
      [
        "runs_by_status",
        "active_runs",
        "ready_trigger_receipts",
        "claimed_trigger_receipts",
        "active_case_claims",
        "pending_approvals",
        "blocked_pending_approvals",
        "expired_pending_approvals",
      ],
    ),
    rolling_24h_budgets: object(
      {
        window_start: timestamp,
        window_end: timestamp,
        new_run_current_policy: automationControlBudgetState,
        draft_pr_current_policy_for_future_runs: automationControlBudgetState,
        draft_pr_live_run_policies: automationControlLivePrCapacity,
        per_run_limits: object(
          {
            max_attempts_per_case_revision: { type: "integer", minimum: 1, maximum: 20 },
            max_turns: { type: "integer", minimum: 1, maximum: 500 },
            max_runtime_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
            max_cost_usd: nullable({ type: "number", minimum: 0, maximum: 10_000 }),
          },
          ["max_attempts_per_case_revision", "max_turns", "max_runtime_seconds", "max_cost_usd"],
        ),
      },
      [
        "window_start",
        "window_end",
        "new_run_current_policy",
        "draft_pr_current_policy_for_future_runs",
        "draft_pr_live_run_policies",
        "per_run_limits",
      ],
    ),
    runner_credentials: object(
      {
        status: enumString(["missing", "inactive", "expiring", "healthy"]),
        total: { type: "integer", minimum: 0 },
        active: { type: "integer", minimum: 0 },
        expiring: { type: "integer", minimum: 0 },
        expired: { type: "integer", minimum: 0 },
        revoked: { type: "integer", minimum: 0 },
        next_expiry_at: nullable(timestamp),
        last_used_at: nullable(timestamp),
      },
      ["status", "total", "active", "expiring", "expired", "revoked", "next_expiry_at", "last_used_at"],
    ),
    latest_run: nullable(object(
      {
        id: string,
        status: automationRun.properties.status,
        trigger_kind: automationRun.properties.trigger_kind,
        created_at: timestamp,
        started_at: nullable(timestamp),
        updated_at: timestamp,
        finished_at: nullable(timestamp),
        deadline_at: timestamp,
        turns_used: { type: "integer", minimum: 0 },
        cost_usd: { type: "number", minimum: 0 },
        usage_source: literal("runner_attested_unverified"),
        href: { type: "string", pattern: "^/v1/automation-runs/" },
      },
      [
        "id",
        "status",
        "trigger_kind",
        "created_at",
        "started_at",
        "updated_at",
        "finished_at",
        "deadline_at",
        "turns_used",
        "cost_usd",
        "usage_source",
        "href",
      ],
    )),
    links: object(
      {
        runs: { type: "string", minLength: 1, maxLength: 2_000 },
        toggle: { type: "string", minLength: 1, maxLength: 2_000 },
      },
      ["runs", "toggle"],
    ),
  },
  [
    "id",
    "name",
    "template_ref",
    "template_ref_authority",
    "configured_enabled",
    "effective_enabled",
    "trigger",
    "activity",
    "rolling_24h_budgets",
    "runner_credentials",
    "latest_run",
    "links",
  ],
);

const automationControlContinuationOperation = object(
  {
    operation_id: enumString(["list_automation_runs", "list_automation_approvals"]),
    method: literal("GET"),
    href: { type: "string", minLength: 1, maxLength: 2_000 },
    cursor_response_path: literal("pagination.next_cursor"),
    follow_up_response_path: literal("pagination.follow_up"),
    note: { type: "string", maxLength: 2_000 },
  },
  ["operation_id", "method", "href", "cursor_response_path", "follow_up_response_path"],
);

const automationControlTruncation = object(
  {
    attention: object(
      {
        candidate_count: { type: "integer", minimum: 0 },
        candidate_count_exact: boolean,
        returned: { type: "integer", minimum: 0, maximum: 100 },
        truncated: boolean,
        source_query_truncated: boolean,
        query_priority_applied_before_limit: literal(true),
        continuation: nullable(object(
          {
            mode: literal("restart_each_source_with_keyset_pagination"),
            complete_when: { type: "string", minLength: 1, maxLength: 500 },
            operations: {
              ...array(automationControlContinuationOperation),
              minItems: 2,
              maxItems: 2,
            },
          },
          ["mode", "complete_when", "operations"],
        )),
      },
      [
        "candidate_count",
        "candidate_count_exact",
        "returned",
        "truncated",
        "source_query_truncated",
        "query_priority_applied_before_limit",
        "continuation",
      ],
    ),
    live_run_policy_rows: object(
      {
        returned: { type: "integer", minimum: 0, maximum: 500 },
        truncated: boolean,
        continuation: nullable(automationControlContinuationOperation),
      },
      ["returned", "truncated", "continuation"],
    ),
  },
  ["attention", "live_run_policy_rows"],
);

const automationControlResponse = object(
  {
    kind: literal("automation_control"),
    project_id: string,
    as_of: timestamp,
    consistency: object(
      {
        model: literal("eventual_read"),
        clock_math_uses_single_as_of: literal(true),
        cross_table_transaction: literal(false),
      },
      ["model", "clock_math_uses_single_as_of", "cross_table_transaction"],
    ),
    control_boundary: object(
      {
        source: literal("agentry_control_plane"),
        telemetry_evidence_included: literal(false),
        raw_runner_output_included: literal(false),
        runner_attested_control_metadata: {
          ...array(enumString(["latest_run.turns_used", "latest_run.cost_usd"])),
          minItems: 2,
          maxItems: 2,
        },
        bounded_human_authored_descriptions: {
          ...array(enumString(["contract.summary", "automations[].name"])),
          minItems: 2,
          maxItems: 2,
        },
        secret_columns_included: literal(false),
        free_text_authority: literal("none"),
      },
      [
        "source",
        "telemetry_evidence_included",
        "raw_runner_output_included",
        "runner_attested_control_metadata",
        "bounded_human_authored_descriptions",
        "secret_columns_included",
        "free_text_authority",
      ],
    ),
    viewer: object(
      {
        user_id: string,
        role: enumString(["owner", "member"]),
        capabilities: object(
          {
            read_control: literal(true),
            update_contract: boolean,
            enable_contract: boolean,
            pause_contract: boolean,
            toggle_automation: boolean,
            manage_credentials: boolean,
            decide_approvals: boolean,
            cancel_runs: boolean,
          },
          [
            "read_control",
            "update_contract",
            "enable_contract",
            "pause_contract",
            "toggle_automation",
            "manage_credentials",
            "decide_approvals",
            "cancel_runs",
          ],
        ),
      },
      ["user_id", "role", "capabilities"],
    ),
    contract: object(
      {
        configured: boolean,
        valid: nullable(boolean),
        state: enumString(["not_configured", "inconsistent", "enabled", "paused", "disabled"]),
        schema_version: nullable(literal("2")),
        revision: nullable({ type: "integer", minimum: 1 }),
        etag: nullable(string),
        stored_enabled: boolean,
        document_enabled: boolean,
        effective_enabled: boolean,
        paused_at: nullable(timestamp),
        summary: nullable({ type: "string", maxLength: 2_000 }),
        summary_authority: literal("description_only"),
        created_at: nullable(timestamp),
        updated_at: nullable(timestamp),
      },
      [
        "configured",
        "valid",
        "state",
        "schema_version",
        "revision",
        "etag",
        "stored_enabled",
        "document_enabled",
        "effective_enabled",
        "paused_at",
        "summary",
        "summary_authority",
        "created_at",
        "updated_at",
      ],
    ),
    summary: object(
      {
        configured_automations: { type: "integer", minimum: 0, maximum: 50 },
        effective_enabled_automations: { type: "integer", minimum: 0, maximum: 50 },
        active_runs: { type: "integer", minimum: 0 },
        pending_approval_records: { type: "integer", minimum: 0 },
        actionable_pending_approvals: { type: "integer", minimum: 0 },
        ready_trigger_receipts: { type: "integer", minimum: 0 },
        active_case_claims: { type: "integer", minimum: 0 },
        attention_items: { type: "integer", minimum: 0, maximum: 100 },
      },
      [
        "configured_automations",
        "effective_enabled_automations",
        "active_runs",
        "pending_approval_records",
        "actionable_pending_approvals",
        "ready_trigger_receipts",
        "active_case_claims",
        "attention_items",
      ],
    ),
    attention: { ...array(automationAttention), maxItems: 100 },
    attention_review: object(
      {
        durable_acknowledgement_supported: literal(false),
        item_ids_stable: literal(true),
        note: { type: "string", minLength: 1, maxLength: 500 },
      },
      ["durable_acknowledgement_supported", "item_ids_stable", "note"],
    ),
    automations: { ...array(automationControlAutomation), maxItems: 50 },
    controls: object(
      {
        read_contract: automationControlOperation,
        list_runs: automationControlOperation,
        list_approvals: automationControlOperation,
        validate_contract: automationControlOperation,
        save_contract: automationControlOperation,
        enable_contract: automationControlOperation,
        pause_contract: automationControlOperation,
        toggle_automation: automationControlOperation,
        decide_approval: automationControlOperation,
        cancel_run: automationControlOperation,
        list_credentials: listCredentialsControlOperation,
        create_credential: createCredentialControlOperation,
      },
      [
        "read_contract",
        "list_runs",
        "list_approvals",
        "validate_contract",
        "save_contract",
        "enable_contract",
        "pause_contract",
        "toggle_automation",
        "decide_approval",
        "cancel_run",
        "list_credentials",
        "create_credential",
      ],
    ),
    bounds: object(
      {
        max_automations: literal(50),
        max_latest_runs_per_automation: literal(1),
        max_attention_items: literal(100),
        max_live_policy_rows: literal(500),
      },
      ["max_automations", "max_latest_runs_per_automation", "max_attention_items", "max_live_policy_rows"],
    ),
    truncation: automationControlTruncation,
    next_action: string,
  },
  [
    "kind",
    "project_id",
    "as_of",
    "consistency",
    "control_boundary",
    "viewer",
    "contract",
    "summary",
    "attention",
    "attention_review",
    "automations",
    "controls",
    "bounds",
    "truncation",
    "next_action",
  ],
);

const webhookDelivery = object(
  {
    id: string,
    webhook_id: nullable(string),
    source_event_id: string,
    source_event_hash: sha256,
    event: string,
    status: enumString(["pending", "delivering", "retrying", "succeeded", "failed", "dead_letter", "cancelled"]),
    attempt_count: integer,
    max_attempts: integer,
    next_attempt_at: nullable(timestamp),
    last_attempt_at: nullable(timestamp),
    delivered_at: nullable(timestamp),
    last_status_code: nullable(integer),
    last_error: nullable(string),
    last_error_inspection: telemetryInspection,
    created_at: timestamp,
    updated_at: timestamp,
  },
  [
    "id",
    "webhook_id",
    "source_event_id",
    "source_event_hash",
    "event",
    "status",
    "attempt_count",
    "max_attempts",
    "created_at",
    "updated_at",
  ],
  true,
);

const AUTOMATION_OPENAPI_BASE_SCHEMAS = {
  ...AUTOMATION_WORKFLOW_OPENAPI_SCHEMAS,
  BoundedEvidenceValue: boundedEvidenceValue,
  BoundedEvidenceObject: boundedEvidenceObject,
  TelemetryInspection: telemetryInspection,
  AutomationTelemetryDataBoundary: telemetryDataBoundary,
  AutomationKeysetPagination: keysetPagination,
  AutomationTemplateRef: automationTemplateRef,
  AutomationRunner: automationRunner,
  AutomationTrigger: automationTrigger,
  AutomationReportPlan: automationReportPlan,
  AutomationScope: automationScope,
  AutomationBudgets: automationBudgets,
  AutomationApprovalsPolicy: automationApprovals,
  AutomationVerificationPolicy: automationVerificationPolicy,
  AutomationDefinition: automationDefinition,
  AutomationContractInput: automationContractInput,
  // Breaking canonical replacement for the stale v1 component name.
  AutomationContract: automationContractInput,
  AutomationVerificationPendingResult: pendingVerificationResult,
  AutomationVerificationCompleteResult: completeVerificationResult,
  AutomationVerificationResult: {
    oneOf: [pendingVerificationResult, completeVerificationResult],
    discriminator: { propertyName: "state" },
  },
  AutomationRunEvidence: automationRunEvidence,
  AutomationRun: automationRun,
  AutomationApproval: automationApproval,
  AutomationTriggerReceipt: triggerReceipt,
  AutomationCaseClaim: caseClaim,
  AutomationReportSource: automationReportSource,
  AutomationPlaybookTemplate: automationPlaybookTemplate,
  ErrorAutomationPlaybookRenderRequest: errorPlaybookRenderRequest,
  WeeklyAutomationPlaybookRenderRequest: weeklyPlaybookRenderRequest,
  AutomationPlaybookRenderResponse: automationPlaybookRenderResponse,
  ProjectCredential: projectCredential,
  AutomationControlResponse: automationControlResponse,
  WebhookDelivery: webhookDelivery,
} as const;

const etagHeaders = {
  ETag: {
    description: "Current canonical automation-contract ETag.",
    schema: string,
  },
};

const contractValidationResponse = object(
  {
    valid: boolean,
    issues: array(object(
      { code: string, path: string, message: string },
      ["code", "path", "message"],
    )),
    warnings: array(string),
    contract: nullable(automationContractInput),
    next_action: string,
  },
  ["valid", "issues", "warnings", "contract", "next_action"],
  true,
);

const contractArtifactResponse = object(
  {
    artifact: literal("automation_contract"),
    project_id: string,
    ...automationContractInput.properties,
    etag: string,
    paused_at: nullable(timestamp),
    pause_reason: nullable(string),
    created_at: timestamp,
    updated_at: timestamp,
    validation: contractValidationResponse,
    next_action: string,
  },
  ["artifact", "project_id", "schema_version", "revision", "enabled", "summary", "automations", "notes", "etag", "next_action"],
  true,
);

const contractStateResponse = object(
  {
    project_id: string,
    automation_id: string,
    enabled: boolean,
    paused_at: timestamp,
    pause_reason: string,
    revision: integer,
    etag: string,
    next_action: string,
  },
  ["project_id", "enabled", "revision", "etag", "next_action"],
  true,
);

const playbookCatalogResponse = object(
  {
    kind: literal("automation_playbook_catalog"),
    count: integer,
    version_policy: literal("immutable_semver"),
    list_policy: literal("latest_version_per_template"),
    playbooks: array(automationPlaybookTemplate),
    next_action: string,
  },
  ["kind", "count", "version_policy", "list_policy", "playbooks", "next_action"],
);

const createCredentialRequest = {
  ...object(
    {
      kind: enumString(["ci_deploy", "automation_runner"]),
      name: { type: "string", minLength: 1, maxLength: 200 },
      automation_id: automationIdentifier,
      expires_in_seconds: { type: "integer", minimum: 300, maximum: 31_536_000 },
    },
    ["kind", "name"],
  ),
  allOf: [
    {
      if: {
        properties: { kind: literal("automation_runner") },
        required: ["kind"],
      },
      then: { required: ["automation_id"] },
      else: { not: { required: ["automation_id"] } },
    },
  ],
};

const createCredentialResponse = object(
  {
    ...projectCredential.properties,
    credential: string,
    env_var: enumString(["AGENTRY_CI_API_KEY", "AGENTRY_RUNNER_API_KEY"]),
    runner_id: nullable(string),
    idempotent_replay: boolean,
    next_action: string,
  },
  [...(projectCredential.required ?? []), "credential", "env_var", "idempotent_replay", "next_action"],
  true,
);

const claimCaseRequest = object(
  {
    automation_id: automationIdentifier,
    trigger_receipt_id: { type: "string", minLength: 1, maxLength: 200 },
    claimed_by: { type: "string", minLength: 1, maxLength: 300 },
    lease_seconds: { type: "integer", minimum: 60, maximum: 3_600, default: 900 },
  },
  ["automation_id", "trigger_receipt_id", "claimed_by"],
);

const startRunRequest = {
  ...object(
    {
      automation_id: automationIdentifier,
      trigger_receipt_id: { type: "string", minLength: 1, maxLength: 200 },
      case_id: { type: "string", minLength: 1, maxLength: 200 },
      claim_id: { type: "string", minLength: 1, maxLength: 200 },
      runner: object(
        {
          provider: enumString(["codex", "claude_code", "github_actions", "custom"]),
          id: { type: "string", minLength: 1, maxLength: 300 },
          model: { type: "string", minLength: 1, maxLength: 200 },
        },
        ["provider", "id"],
      ),
    },
    ["automation_id", "trigger_receipt_id", "runner"],
  ),
  dependentRequired: {
    case_id: ["claim_id"],
    claim_id: ["case_id"],
  },
};

const updateRunRequest = object(
  {
    status: enumString(["running", "failed", "escalated", "cancelled"]),
    summary_md: { type: "string", maxLength: 20_000 },
    evidence: automationRunEvidence,
    error: object(
      {
        code: { type: "string", minLength: 1, maxLength: 200 },
        message: { type: "string", minLength: 1, maxLength: 4_000 },
      },
      ["code", "message"],
    ),
  },
  ["status"],
);

const requestApproval = object(
  {
    action: literal("draft_pr"),
    reason: { type: "string", minLength: 1, maxLength: 2_000 },
    subject: draftPrSubject,
  },
  ["action", "reason", "subject"],
);

const recordPrProofRequest = object(
  {
    vcs_provider: enumString(["github", "gitlab", "bitbucket"]),
    repository: httpsUrl,
    pr_url: httpsUrl,
    pr_number: { type: "integer", minimum: 1 },
    draft: literal(true),
    head_sha: commitSha,
    head_branch: { type: "string", minLength: 1, maxLength: 300 },
    base_branch: { type: "string", minLength: 1, maxLength: 300 },
    change_types: automationRunEvidence.properties.change_types,
    changed_files: automationRunEvidence.properties.changed_files,
    changed_lines: changedLines,
    tests: automationRunEvidence.properties.tests,
    ci_url: httpsUrl,
  },
  [
    "vcs_provider",
    "repository",
    "pr_url",
    "pr_number",
    "draft",
    "head_sha",
    "head_branch",
    "base_branch",
    "change_types",
    "changed_files",
    "changed_lines",
    "tests",
  ],
);

const recordReportEvidence = {
  ...automationRunEvidence,
  required: ["report"],
};

const recordReportRequest = object(
  {
    summary_md: { type: "string", minLength: 1, maxLength: 20_000 },
    evidence: recordReportEvidence,
  },
  ["summary_md", "evidence"],
);

const verificationPendingEnvelope = object(
  {
    run_id: string,
    status: literal("verifying"),
    verification: pendingVerificationResult,
    idempotent_replay: boolean,
    next_action: string,
  },
  ["run_id", "status", "verification"],
  true,
);

const verificationObservationPendingEnvelope = object(
  {
    run_id: string,
    status: literal("verifying"),
    verification_ready_at: timestamp,
    retry_after_seconds: { type: "integer", minimum: 1 },
    next_action: string,
  },
  ["run_id", "status", "verification_ready_at", "retry_after_seconds", "next_action"],
);

const verificationCompleteEnvelope = object(
  {
    run_id: string,
    status: enumString(["succeeded", "failed", "escalated"]),
    verification: completeVerificationResult,
    idempotent_replay: boolean,
    next_action: string,
  },
  ["run_id", "status", "verification"],
  true,
);

export const AUTOMATION_OPENAPI_SCHEMAS = {
  ...AUTOMATION_OPENAPI_BASE_SCHEMAS,
  DisabledAutomationContractInput: disabledAutomationContractInput,
  AutomationContractValidationResponse: contractValidationResponse,
  AutomationContractArtifactResponse: contractArtifactResponse,
} as const;

export const AUTOMATION_OPENAPI_PATHS = {
  ...AUTOMATION_WORKFLOW_OPENAPI_PATHS,
  "/v1/automation-playbooks": {
    get: operation({
      operationId: "list_automation_playbooks",
      summary: "List immutable automation playbooks",
      description: "Public, read-only catalog. Choose an exact immutable version before collecting bindings.",
      security: [],
      responses: { "200": jsonResponse(playbookCatalogResponse), ...defaultError },
      extensions: { "x-agentry-authority": "read_only" },
    }),
  },
  "/v1/automation-playbooks/{id}": {
    get: operation({
      operationId: "get_automation_playbook",
      summary: "Get one immutable automation playbook",
      description: "Returns the exact render schema, locked invariants, output contract, and related HTTP operations for one version.",
      security: [],
      parameters: [
        playbookId,
        { name: "version", in: "query", required: false, schema: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" } },
      ],
      responses: { "200": jsonResponse(automationPlaybookTemplate), ...defaultError },
      extensions: { "x-agentry-authority": "read_only" },
    }),
  },
  "/v1/projects/{project_id}/automation-playbooks/{id}/render": {
    post: operation({
      operationId: "render_automation_playbook",
      summary: "Render a disabled automation candidate",
      description: "Human project members only. Rendering is deterministic and side-effect free; it never saves, enables, mints, schedules, queries, publishes, or messages.",
      security: owner,
      parameters: [projectId, playbookId],
      request: {
        oneOf: [
          ref("ErrorAutomationPlaybookRenderRequest"),
          ref("WeeklyAutomationPlaybookRenderRequest"),
        ],
      },
      responses: { "200": jsonResponse(ref("AutomationPlaybookRenderResponse")), ...defaultError },
      extensions: { "x-agentry-authority": "render_disabled_candidate" },
    }),
  },
  "/v1/projects/{project_id}/automation-control": {
    get: operation({
      operationId: "get_automation_control",
      summary: "Read the bounded human automation control plane",
      description: "Returns contract state, budgets, credentials, approvals, attention items, safe controls, bounds, and truncation metadata at one server timestamp.",
      security: owner,
      parameters: [projectId],
      responses: { "200": jsonResponse(automationControlResponse), ...defaultError },
      extensions: { "x-agentry-authority": "human_control_read" },
    }),
  },
  "/v1/projects/{project_id}/automation-contract": {
    get: operation({
      operationId: "get_automation_contract",
      summary: "Get the canonical automation v2 contract",
      description: "Read the normalized structured authority boundary and its ETag before any policy mutation.",
      security: owner,
      parameters: [projectId],
      responses: {
        "200": { ...jsonResponse(ref("AutomationContractArtifactResponse")), headers: etagHeaders },
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "policy_read" },
    }),
    put: operation({
      operationId: "put_automation_contract",
      summary: "Save an automation v2 contract disabled",
      description: "Owner-only. Saving can never enable unattended execution. If-Match is optional only for the first save and required for replacement.",
      security: owner,
      parameters: [projectId, ifMatchOptional],
      request: ref("DisabledAutomationContractInput"),
      responses: {
        "200": { ...jsonResponse(ref("AutomationContractArtifactResponse")), headers: etagHeaders },
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "policy_write_disabled" },
    }),
  },
  "/v1/projects/{project_id}/automation-contract/validate": {
    post: operation({
      operationId: "validate_automation_contract",
      summary: "Validate an automation v2 contract",
      description: "Read-only validation against the strict v2 policy and current project readiness. It does not save or enable anything.",
      security: owner,
      parameters: [projectId],
      request: ref("AutomationContractInput"),
      responses: { "200": jsonResponse(ref("AutomationContractValidationResponse")), ...defaultError },
      extensions: { "x-agentry-authority": "validation_only" },
    }),
  },
  "/v1/projects/{project_id}/automation-contract/enable": {
    post: operation({
      operationId: "enable_automation_contract",
      summary: "Explicitly enable the automation contract",
      description: "Owner-only enable gate. Requires the exact current ETag and re-validates execution readiness.",
      security: owner,
      parameters: [projectId, ifMatchRequired],
      responses: {
        "200": { ...jsonResponse(contractStateResponse), headers: etagHeaders },
        ...defaultError,
      },
      extensions: {
        "x-agentry-authority": "owner_enable",
        "x-agentry-request-body": "none",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-contract/pause": {
    post: operation({
      operationId: "pause_automation_contract",
      summary: "Activate the global automation kill switch",
      description: "Owner-only emergency pause. It deliberately needs no If-Match so the kill switch can win during concurrent edits.",
      security: owner,
      parameters: [projectId],
      request: object(
        { reason: { type: "string", minLength: 1, maxLength: 2_000 } },
        ["reason"],
      ),
      responses: {
        "200": { ...jsonResponse(contractStateResponse), headers: etagHeaders },
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "emergency_kill_switch" },
    }),
  },
  "/v1/projects/{project_id}/automation-contract/automations/{automation_id}": {
    patch: operation({
      operationId: "set_automation_enabled",
      summary: "Set one automation's enabled state",
      description: "Owner-only per-automation switch guarded by the exact current contract ETag.",
      security: owner,
      parameters: [projectId, automationIdPath, ifMatchRequired],
      request: object(
        {
          enabled: boolean,
          reason: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        ["enabled", "reason"],
      ),
      responses: {
        "200": { ...jsonResponse(contractStateResponse), headers: etagHeaders },
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "owner_automation_switch" },
    }),
  },
  "/v1/projects/{project_id}/credentials": {
    get: operation({
      operationId: "list_project_credentials",
      summary: "List project-scoped credential metadata",
      description: "Owner-only metadata read. Raw credential values are never recoverable.",
      security: owner,
      parameters: [projectId],
      responses: {
        "200": jsonResponse(object(
          { credentials: array(projectCredential), next_action: string },
          ["credentials", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "credential_metadata_read" },
    }),
    post: operation({
      operationId: "create_project_credential",
      summary: "Create one least-authority project credential",
      description: "Owner-only and requires a stable Idempotency-Key. The raw value remains hash-only and is returned exactly once; an exact lost-response retry names the already-created credential and never mints another active secret. automation_runner requires an exact saved automation_id.",
      security: owner,
      parameters: [projectId, idempotencyKey],
      request: createCredentialRequest,
      responses: {
        "200": jsonResponse(createCredentialResponse),
        "409": jsonResponse(
          ref("ErrorEnvelope"),
          "Exact retry identifies the already-created hash-only credential instead of returning or minting a secret",
        ),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "credential_mint" },
    }),
  },
  "/v1/project-credentials/{credential_id}/revoke": {
    post: operation({
      operationId: "revoke_project_credential",
      summary: "Revoke one project credential",
      description: "Owner-only revocation bound to one stable Idempotency-Key and exact normalized reason. The credential CAS, durable command receipt, and immutable audit event commit atomically. Remove the value from its host after revocation.",
      security: owner,
      parameters: [credentialId, idempotencyKey],
      request: object(
        { reason: { type: "string", minLength: 1, maxLength: 2_000 } },
        ["reason"],
      ),
      responses: {
        "200": jsonResponse(object(
          { ...projectCredential.properties, idempotent_replay: boolean, next_action: string },
          [...(projectCredential.required ?? []), "idempotent_replay", "next_action"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "credential_revoke" },
    }),
  },
  "/v1/projects/{project_id}/automation-triggers/issue": {
    post: operation({
      operationId: "issue_automation_triggers",
      summary: "Ask the server to issue eligible trigger receipts",
      description: "The server evaluates current policy and eligibility. The caller cannot invent trigger evidence or authority.",
      security: ownerOrRunner,
      parameters: [projectId],
      request: object(
        { automation_id: automationIdentifier },
        ["automation_id"],
      ),
      responses: {
        "200": jsonResponse(object(
          {
            data_boundary: telemetryDataBoundary,
            automation_id: string,
            trigger_kind: enumString(["alert", "unhandled_cases", "schedule"]),
            issued_count: integer,
            replayed_count: integer,
            cooldown_until: nullable(timestamp),
            skipped: { ...array(automationTriggerSkip), maxItems: 100 },
            receipts: array(triggerReceipt),
            next_action: string,
          },
          [
            "data_boundary",
            "automation_id",
            "trigger_kind",
            "issued_count",
            "replayed_count",
            "cooldown_until",
            "skipped",
            "receipts",
            "next_action",
          ],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "request_server_eligibility_evaluation" },
    }),
  },
  "/v1/projects/{project_id}/automation-trigger-receipts": {
    get: operation({
      operationId: "list_automation_trigger_receipts",
      summary: "List server-issued trigger receipts",
      description: "Runner reads are automatically constrained to the credential's one automation_id.",
      security: ownerOrRunner,
      parameters: [
        projectId,
        { name: "automation_id", in: "query", required: false, schema: automationIdentifier },
        { name: "status", in: "query", required: false, schema: enumString(["all", "ready", "claimed", "consumed", "expired", "cancelled"]) },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
        { name: "cursor", in: "query", required: false, description: "Opaque next_cursor from the preceding response with identical filters.", schema: { type: "string", minLength: 1, maxLength: 1_000 } },
      ],
      responses: {
        "200": jsonResponse(object(
          {
            data_boundary: telemetryDataBoundary,
            filters: object(
              {
                automation_id: nullable(automationIdentifier),
                status: enumString(["all", "ready", "claimed", "consumed", "expired", "cancelled"]),
                limit: { type: "integer", minimum: 1, maximum: 100 },
              },
              ["automation_id", "status", "limit"],
            ),
            receipts: array(triggerReceipt),
            pagination: keysetPagination,
            next_action: string,
          },
          ["data_boundary", "filters", "receipts", "pagination", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "trigger_receipt_read" },
    }),
  },
  "/v1/automation-trigger-receipts/{receipt_id}": {
    get: operation({
      operationId: "get_automation_trigger_receipt",
      summary: "Get one server-issued trigger receipt",
      description: "Read the exact contract, occurrence, trust, validity, and single-use binding before claiming or starting.",
      security: ownerOrRunner,
      parameters: [receiptId],
      responses: {
        "200": jsonResponse(object(
          { data_boundary: telemetryDataBoundary, receipt: triggerReceipt, next_action: string },
          ["data_boundary", "receipt", "next_action"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "trigger_receipt_read" },
    }),
  },
  "/v1/cases/{case_id}/claims": {
    post: operation({
      operationId: "claim_case",
      summary: "Atomically claim one exact case revision",
      description: "Consumes the exact unhandled-case receipt into one bounded lease. The lease token is returned only to the exact claimant and exact idempotent replay.",
      security: ownerOrRunner,
      parameters: [caseId, idempotencyKey],
      request: claimCaseRequest,
      responses: { "200": jsonResponse(caseClaim), ...defaultError },
      extensions: { "x-agentry-authority": "case_lease_acquire" },
    }),
  },
  "/v1/cases/{case_id}/claims/active": {
    get: operation({
      operationId: "get_active_case_claim",
      summary: "Read active ownership for the current case revision",
      description: "Returns ownership metadata only; it never exposes another claimant's lease token.",
      security: ownerOrRunner,
      parameters: [caseId],
      responses: {
        "200": jsonResponse(object(
          {
            case_id: string,
            case_revision: integer,
            claim: nullable(caseClaim),
            next_action: string,
          },
          ["case_id", "case_revision", "claim", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "case_lease_read" },
    }),
  },
  "/v1/cases/{case_id}/claims/{claim_id}/renew": {
    post: operation({
      operationId: "renew_case_claim",
      summary: "Renew an active case lease",
      description: "The server re-checks the case revision, contract, automation switch, credential binding, and token before extending the lease.",
      security: ownerOrRunner,
      parameters: [caseId, claimId, leaseTokenRequired],
      request: object(
        { lease_seconds: { type: "integer", minimum: 60, maximum: 3_600, default: 900 } },
      ),
      responses: {
        "200": jsonResponse(object(
          {
            claim_id: string,
            case_id: string,
            case_revision: integer,
            trigger_receipt_id: string,
            expires_at: timestamp,
            next_action: string,
          },
          ["claim_id", "case_id", "case_revision", "trigger_receipt_id", "expires_at", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "case_lease_renew" },
    }),
  },
  "/v1/cases/{case_id}/claims/{claim_id}/release": {
    post: operation({
      operationId: "release_case_claim",
      summary: "Release a case lease",
      description: "Releases the exact lease and preserves durable run history and budget charges.",
      security: ownerOrRunner,
      parameters: [caseId, claimId, leaseTokenRequired],
      request: object(
        { reason: enumString(["completed", "failed", "escalated", "cancelled", "superseded"]) },
        ["reason"],
      ),
      responses: {
        "200": jsonResponse(object(
          {
            claim_id: string,
            released_at: timestamp,
            release_reason: string,
            idempotent_replay: boolean,
            next_action: string,
          },
          ["claim_id", "released_at", "release_reason", "next_action"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "case_lease_release" },
    }),
  },
  "/v1/projects/{project_id}/automation-runs": {
    post: operation({
      operationId: "start_automation_run",
      summary: "Start one durable run from one trigger receipt",
      description: "Atomically consumes the one-time receipt, binds the current policy snapshot and runner credential, and reserves the run budget. Case-linked runs also require their lease token.",
      security: ownerOrRunner,
      parameters: [projectId, idempotencyKey, leaseTokenOptional],
      request: startRunRequest,
      responses: { "200": jsonResponse(ref("AutomationRun")), ...defaultError },
      extensions: { "x-agentry-authority": "start_bound_run" },
    }),
    get: operation({
      operationId: "list_automation_runs",
      summary: "List durable automation runs",
      description: "Runner reads are constrained to its exact automation. Inspect failed, escalated, and awaiting-review runs first.",
      security: ownerOrRunner,
      parameters: [
        projectId,
        { name: "status", in: "query", required: false, schema: enumString([
          "queued",
          "claimed",
          "running",
          "draft_pr_opened",
          "awaiting_approval",
          "verifying",
          "succeeded",
          "failed",
          "escalated",
          "cancelled",
        ]) },
        { name: "automation_id", in: "query", required: false, schema: automationIdentifier },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        { name: "cursor", in: "query", required: false, description: "Opaque next_cursor from the preceding response with identical filters.", schema: { type: "string", minLength: 1, maxLength: 1_000 } },
      ],
      responses: {
        "200": jsonResponse(object(
          { runs: array(ref("AutomationRun")), pagination: keysetPagination, next_action: string },
          ["runs", "pagination", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "run_read" },
    }),
  },
  "/v1/automation-runs/{run_id}": {
    get: operation({
      operationId: "get_automation_run",
      summary: "Get a run with immutable history and evidence",
      description: "Returns the policy snapshot, trigger observation boundary, runner evidence, ordered history, approvals, and at most one immutable report source.",
      security: ownerOrRunner,
      parameters: [runId],
      responses: {
        "200": jsonResponse(object(
          {
            ...automationRun.properties,
            events: array(automationRunEvent),
            approvals: array(automationApproval),
            report_source: nullable(automationReportSource),
            next_action: string,
          },
          [...(automationRun.required ?? []), "events", "approvals", "report_source", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "run_read" },
    }),
    patch: operation({
      operationId: "update_automation_run",
      summary: "Apply one allowed run state transition",
      description: "The server validates the immutable policy, evidence, budget, current switch, and case lease. The caller cannot mark deploy verification successful through this endpoint.",
      security: ownerOrRunner,
      parameters: [runId, leaseTokenOptional],
      request: updateRunRequest,
      responses: { "200": jsonResponse(ref("AutomationRun")), ...defaultError },
      extensions: { "x-agentry-authority": "bounded_run_transition" },
    }),
  },
  "/v1/automation-runs/{run_id}/cancel": {
    post: operation({
      operationId: "cancel_automation_run",
      summary: "Cancel local runner authority",
      description: "Owner-only atomic cancellation of the run, claim, pending approvals, and issued grants. External provider effects are not cancelled and may require explicit follow-up.",
      security: owner,
      parameters: [runId, idempotencyKey],
      request: object(
        { reason: { type: "string", minLength: 1, maxLength: 2_000 } },
        ["reason"],
      ),
      responses: {
        "200": jsonResponse(object(
          {
            run_id: string,
            status: literal("cancelled"),
            reason: string,
            cancelled_by: string,
            cancelled_at: timestamp,
            idempotent_replay: boolean,
            external_follow_up: object(
              {
                required: literal(true),
                provider_state: literal("unknown"),
                external_effect_cancelled_by_agentry: literal(false),
                evidence: object(
                  {
                    pr_url: nullable(httpsUrl),
                    pr_proof_recorded: boolean,
                    deploy_sha: nullable(commitSha),
                    action_grant_statuses: {
                      ...array(enumString(["issued", "consumed"])),
                      maxItems: 2,
                      uniqueItems: true,
                    },
                  },
                  ["pr_url", "pr_proof_recorded", "deploy_sha", "action_grant_statuses"],
                ),
                next_action: string,
              },
              ["required", "provider_state", "external_effect_cancelled_by_agentry", "evidence", "next_action"],
            ),
            next_action: string,
          },
          ["run_id", "status", "reason", "cancelled_by", "cancelled_at", "idempotent_replay", "next_action"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "owner_cancel_local_authority" },
    }),
  },
  "/v1/automation-runs/{run_id}/usage": {
    post: operation({
      operationId: "report_automation_usage",
      summary: "Report monotonic bounded run usage",
      description: "Reports a monotonic sequence, turns, and optional cost; crossing the immutable budget escalates and closes the run.",
      security: ownerOrRunner,
      parameters: [runId, leaseTokenOptional],
      request: object(
        {
          sequence: { type: "integer", minimum: 1 },
          turns_used: { type: "integer", minimum: 0, maximum: 1_000_000 },
          cost_usd: { type: "number", minimum: 0, maximum: 1_000_000 },
        },
        ["sequence", "turns_used"],
      ),
      responses: {
        "200": jsonResponse(object(
          {
            run_id: string,
            status: string,
            sequence: integer,
            turns_used: integer,
            cost_usd: number,
            idempotent_replay: boolean,
            next_action: string,
          },
          ["run_id", "status", "sequence", "turns_used", "cost_usd", "next_action"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "usage_accounting_only" },
    }),
  },
  "/v1/automation-runs/{run_id}/approvals": {
    post: operation({
      operationId: "request_automation_approval",
      summary: "Request approval for one immutable action subject",
      description: "Approval cannot add an action absent from allowed_actions. The request freezes the exact subject hash and blocks the gated action.",
      security: ownerOrRunner,
      parameters: [runId, leaseTokenRequired],
      request: requestApproval,
      responses: { "200": jsonResponse(automationApproval), ...defaultError },
      extensions: { "x-agentry-authority": "approval_request_only" },
    }),
  },
  "/v1/projects/{project_id}/automation-approvals": {
    get: operation({
      operationId: "list_automation_approvals",
      summary: "List human-review approval records",
      description: "Human members inspect pending or decided approvals. Only project owners may decide them.",
      security: owner,
      parameters: [
        projectId,
        { name: "status", in: "query", required: false, schema: enumString(["pending", "approved", "rejected", "expired", "cancelled"]) },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
        { name: "cursor", in: "query", required: false, description: "Opaque next_cursor from the preceding response with identical filters.", schema: { type: "string", minLength: 1, maxLength: 1_000 } },
      ],
      responses: {
        "200": jsonResponse(object(
          { approvals: array(automationApproval), pagination: keysetPagination, next_action: string },
          ["approvals", "pagination", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "human_approval_read" },
    }),
  },
  "/v1/automation-approvals/{approval_id}/decide": {
    post: operation({
      operationId: "decide_automation_approval",
      summary: "Approve or reject one exact action subject",
      description: "Owner-only, explicit, expiring decision. Comments, telemetry, and runner output never count as approval.",
      security: owner,
      parameters: [approvalId],
      request: object(
        {
          decision: enumString(["approved", "rejected"]),
          reason: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        ["decision", "reason"],
      ),
      responses: {
        "200": jsonResponse(object(
          {
            approval_id: string,
            decision: enumString(["approved", "rejected"]),
            run_id: string,
            run_status: enumString(["running", "escalated"]),
            decided_at: timestamp,
            next_action: string,
          },
          ["approval_id", "decision", "run_id", "run_status", "decided_at", "next_action"],
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "owner_approval_decision" },
    }),
  },
  "/v1/automation-runs/{run_id}/actions/draft-pr/authorize": {
    post: operation({
      operationId: "authorize_draft_pr",
      summary: "Authorize exactly one bounded draft PR",
      description: "Validates path, change-type, line, file, test, approval, and PR budgets before issuing a short-lived one-time action token. It never grants merge, deploy, rollback, or direct push.",
      security: ownerOrRunner,
      parameters: [runId, idempotencyKey, leaseTokenRequired],
      request: object({ subject: draftPrSubject }, ["subject"]),
      responses: {
        "200": jsonResponse(object(
          {
            grant_id: string,
            action: literal("draft_pr"),
            action_token: string,
            subject_hash: sha256,
            expires_at: timestamp,
            idempotent_replay: boolean,
            next_action: string,
          },
          ["grant_id", "action", "action_token", "subject_hash", "expires_at", "next_action"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "one_draft_pr_only" },
    }),
  },
  "/v1/automation-runs/{run_id}/actions/draft-pr/consume": {
    post: operation({
      operationId: "consume_draft_pr_grant",
      summary: "Record the draft PR created from one grant",
      description: "Consumes the matching one-time action token and records the exact draft PR URL. It does not attest provider state; trusted CI proof remains mandatory.",
      security: ownerOrRunner,
      parameters: [runId, actionTokenRequired, leaseTokenRequired],
      request: object(
        {
          grant_id: { type: "string", minLength: 1, maxLength: 200 },
          pr_url: httpsUrl,
        },
        ["grant_id", "pr_url"],
      ),
      responses: { "200": jsonResponse(automationRun), ...defaultError },
      extensions: { "x-agentry-authority": "consume_one_draft_pr_grant" },
    }),
  },
  "/v1/automation-runs/{run_id}/pr-proof": {
    post: operation({
      operationId: "record_automation_pr_proof",
      summary: "Record immutable provider-observed draft PR proof",
      description: "Trusted CI only. The proof must match the exact repository, branch, commit, diff, tests, and consumed pre-action grant.",
      security: ciOnly,
      parameters: [runId],
      request: recordPrProofRequest,
      responses: {
        "200": jsonResponse(object(
          {
            run_id: string,
            proof_hash: sha256,
            recorded_at: timestamp,
            idempotent_replay: boolean,
            next_action: string,
          },
          ["run_id", "proof_hash", "recorded_at", "idempotent_replay"],
          true,
        )),
        ...defaultError,
      },
      extensions: { "x-agentry-authority": "trusted_ci_attestation" },
    }),
  },
  "/v1/automation-runs/{run_id}/verify": {
    post: operation({
      operationId: "verify_automation_run",
      summary: "Execute server-owned post-deploy verification",
      description: "The caller supplies no result. The server binds the exact trusted CI deploy, first proves approved real traffic, then evaluates exact case recurrence. Zero traffic is pending until timeout and then failure, never success.",
      security: ownerOrRunner,
      parameters: [runId],
      responses: {
        "200": jsonResponse(verificationCompleteEnvelope, "Verification complete"),
        "202": jsonResponse(
          {
            oneOf: [verificationObservationPendingEnvelope, verificationPendingEnvelope],
          },
          "Observation window or traffic sample pending",
        ),
        ...defaultError,
      },
      extensions: {
        "x-agentry-authority": "server_owned_verification",
        "x-agentry-request-body": "none",
      },
    }),
  },
  "/v1/automation-runs/{run_id}/report-source": {
    post: operation({
      operationId: "get_automation_report_source",
      summary: "Materialize the one immutable scheduled-report source",
      description: "Exact bound runner only. Executes only the saved strict aggregate blueprint with server-bound schedule inputs; arbitrary params and HogQL are forbidden.",
      security: runnerOnly,
      parameters: [runId, idempotencyKey],
      request: object(
        { blueprint_id: { type: "string", minLength: 1, maxLength: 200 } },
        ["blueprint_id"],
      ),
      responses: { "200": jsonResponse(automationReportSource), ...defaultError },
      extensions: { "x-agentry-authority": "one_saved_aggregate_source" },
    }),
  },
  "/v1/automation-runs/{run_id}/actions/record-report": {
    post: operation({
      operationId: "record_automation_report",
      summary: "Record a source-bound typed human-review report",
      description: "Exact bound runner only. The report must match the one immutable source hash and period; findings are metrics, hypotheses, or readiness gaps only. It never publishes or sends output.",
      security: runnerOnly,
      parameters: [runId, idempotencyKey],
      request: recordReportRequest,
      responses: { "200": jsonResponse(automationRun), ...defaultError },
      extensions: { "x-agentry-authority": "record_private_typed_report" },
    }),
  },
  "/v1/projects/{project_id}/webhook-deliveries": {
    get: operation({
      operationId: "list_webhook_deliveries",
      summary: "List durable webhook deliveries",
      description: "Inspect pending, retrying, failed, and dead-letter outbound deliveries without re-running source events.",
      security: owner,
      parameters: [
        projectId,
        { name: "status", in: "query", required: false, schema: enumString(["pending", "delivering", "retrying", "succeeded", "failed", "dead_letter", "cancelled"]) },
        { name: "webhook_id", in: "query", required: false, schema: string },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      ],
      responses: {
        "200": jsonResponse(object(
          {
            data_boundary: telemetryDataBoundary,
            deliveries: array(webhookDelivery),
            next_action: string,
          },
          ["data_boundary", "deliveries", "next_action"],
          true,
        )),
        ...defaultError,
      },
      tags: ["Webhooks"],
      extensions: { "x-agentry-authority": "delivery_read" },
    }),
  },
  "/v1/projects/{project_id}/webhook-deliveries/{delivery_id}/replay": {
    post: operation({
      operationId: "replay_webhook_delivery",
      summary: "Replay one failed webhook delivery",
      description: "Owner-only replay after fixing the receiver. The delivery id is preserved for receiver idempotency; succeeded deliveries cannot be replayed.",
      security: owner,
      parameters: [projectId, deliveryId],
      responses: {
        "200": jsonResponse(object(
          {
            delivery_id: string,
            replayed: literal(true),
            result: enumString(["delivered", "retrying", "dead_letter", "skipped"]),
            next_action: string,
          },
          ["delivery_id", "replayed", "result", "next_action"],
        )),
        ...defaultError,
      },
      tags: ["Webhooks"],
      extensions: {
        "x-agentry-authority": "owner_delivery_replay",
        "x-agentry-request-body": "none",
      },
    }),
  },
} as const;

/**
 * Dependency order is deliberately explicit. A scheduler can select the
 * branch it needs, while a fresh agent can see every prerequisite and stop
 * control without reverse-engineering route names from prose.
 */
export const AUTOMATION_OPENAPI_FLOW = {
  purpose:
    "Compose, compile, review, enable, execute, recover, and stop the fail-closed workflow-v3 scheduled-funnel production slice; separately render and execute bounded automation-v2 templates. Neither branch grants merge, deploy, generic-query, publication, scheduler-secret substitution, or telemetry-instruction authority.",
  states: [
    "workflow_components_discovered",
    "workflow_candidate_compiled",
    "workflow_revision_saved_disabled",
    "workflow_current_revision_read",
    "workflow_runner_credential_scoped",
    "workflow_readiness_reviewed",
    "workflow_exact_revision_enabled",
    "workflow_trigger_receipt_issued",
    "workflow_trigger_receipt_consumed",
    "workflow_run_started",
    "workflow_action_loaded",
    "workflow_lease_acquired_when_required",
    "workflow_command_committed",
    "workflow_effect_reconciled_when_required",
    "workflow_terminal_or_escalated",
    "workflow_paused_or_recovered",
    "readiness_loaded",
    "template_selected",
    "disabled_candidate_rendered",
    "contract_validated",
    "contract_saved_disabled",
    "credentials_scoped",
    "owner_enabled",
    "trigger_receipt_issued",
    "case_claimed_or_schedule_bound",
    "run_started",
    "running",
    "human_review",
    "provider_proof_pending",
    "verified_or_reported",
    "stopped",
    "deletion_fenced",
    "external_follow_up_required",
  ],
  operations: [
    { method: "get", path: "/v1/automation-workflow-components" },
    { method: "get", path: "/v1/automation-workflow-contracts" },
    { method: "get", path: "/v1/projects/{project_id}/signal-map" },
    { method: "get", path: "/v1/projects/{project_id}/onboarding" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/compile" },
    { method: "put", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}" },
    { method: "get", path: "/v1/automation-playbooks" },
    { method: "get", path: "/v1/automation-playbooks/{id}" },
    { method: "post", path: "/v1/projects/{project_id}/automation-playbooks/{id}/render" },
    { method: "post", path: "/v1/projects/{project_id}/automation-contract/validate" },
    { method: "put", path: "/v1/projects/{project_id}/automation-contract" },
    { method: "get", path: "/v1/projects/{project_id}/automation-contract" },
    { method: "post", path: "/v1/projects/{project_id}/credentials" },
    { method: "get", path: "/v1/projects/{project_id}/credentials" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflow-control" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/readiness" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/enable" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/issue" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/{receipt_id}" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease/renew" },
    { method: "delete", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/commands" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/advance" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/cancel" },
    { method: "get", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}/reconcile" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflows/{automation_id}/pause" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflow-control/pause" },
    { method: "post", path: "/v1/projects/{project_id}/automation-workflow-control/resume" },
    { method: "get", path: "/v1/projects/{project_id}/automation-control" },
    { method: "post", path: "/v1/projects/{project_id}/automation-contract/enable" },
    { method: "post", path: "/v1/projects/{project_id}/automation-triggers/issue" },
    { method: "get", path: "/v1/projects/{project_id}/automation-trigger-receipts" },
    { method: "get", path: "/v1/automation-trigger-receipts/{receipt_id}" },
    { method: "get", path: "/v1/cases/{case_id}/claims/active" },
    { method: "post", path: "/v1/cases/{case_id}/claims" },
    { method: "get", path: "/v1/cases/{case_id}" },
    { method: "post", path: "/v1/cases/{case_id}/claims/{claim_id}/renew" },
    { method: "post", path: "/v1/projects/{project_id}/automation-runs" },
    { method: "get", path: "/v1/projects/{project_id}/automation-runs" },
    { method: "get", path: "/v1/automation-runs/{run_id}" },
    { method: "patch", path: "/v1/automation-runs/{run_id}" },
    { method: "post", path: "/v1/automation-runs/{run_id}/usage" },
    { method: "post", path: "/v1/automation-runs/{run_id}/approvals" },
    { method: "get", path: "/v1/projects/{project_id}/automation-approvals" },
    { method: "post", path: "/v1/automation-approvals/{approval_id}/decide" },
    { method: "post", path: "/v1/automation-runs/{run_id}/actions/draft-pr/authorize" },
    { method: "post", path: "/v1/automation-runs/{run_id}/actions/draft-pr/consume" },
    { method: "post", path: "/v1/automation-runs/{run_id}/pr-proof" },
    { method: "post", path: "/v1/deploys/" },
    { method: "post", path: "/v1/automation-runs/{run_id}/verify" },
    { method: "post", path: "/v1/automation-runs/{run_id}/report-source" },
    { method: "post", path: "/v1/automation-runs/{run_id}/actions/record-report" },
    { method: "post", path: "/v1/cases/{case_id}/claims/{claim_id}/release" },
    { method: "patch", path: "/v1/projects/{project_id}/automation-contract/automations/{automation_id}" },
    { method: "post", path: "/v1/projects/{project_id}/automation-contract/pause" },
    { method: "post", path: "/v1/automation-runs/{run_id}/cancel" },
    { method: "post", path: "/v1/project-credentials/{credential_id}/revoke" },
    { method: "delete", path: "/v1/projects/{project_id}" },
    { method: "post", path: "/v1/auth/self_delete" },
  ],
  branches: {
    workflow_v3_scheduled_funnel_production: [
      "read the immutable component and payload-contract catalogs",
      "assemble the exact supported schedule cron -> ordered funnel query -> funnel review agent task -> private report graph with complete/escalate terminals",
      "compile without writes or external actions; compile artifacts themselves remain ready_to_enable=false until saved live evidence is evaluated",
      "let an owner save one immutable disabled revision, omitting If-Match only for the first save",
      "create exactly one active runner credential bound to this automation_id and keep its raw value only in the customer scheduler",
      "read readiness with confirm=scheduler_execution_configured and resolve every blocker; unsupported components fail closed",
      "enable only the reviewed revision_id + workflow ETag + readiness_hash + exact assertion ids with one stable Idempotency-Key, then retain the returned execution_authority_id and execution_descriptor_hash",
      "consume only server-issued trigger receipt ids; never submit trigger payloads, times, trust, actor, or server clock",
      "start/recover one receipt-bound run; require its immutable execution-authority binding, then inspect live authority and execution_control before every action",
      "follow each authorized recoverable next_action's principal, exact path, expected revision, lease fence, timing, effect id, and suspension id",
      "let Agentry use an internal 300-second generation-fenced claim for system query/private-report work and return only the funnel-review component to the exact runner",
      "when next_action is null, distinguish state.terminal from live authority suppression and follow only execution_control.recovery; the private report is never published or sent",
    ],
    workflow_v3_recovery: [
      "replay exact start/command/control operations with their original identity and recover the durable receipt rather than create replacement authority",
      "on stale revision or lease epoch, re-read and discard old worker output",
      "on an active or contended system-node claim wait until details.retry_at, GET the run, and replay /advance; on stale re-read; on fence-lost discard the result",
      "missing or drifted immutable execution authority is nonretryable for the legacy run: perform no analytics/provider work and save/review/enable a replacement",
      "after effect call-start, call a provider only from a fresh call_authorized=true receipt; a replay is reconciliation-only (reconcile_only=true) and never authorizes a call",
      "use trusted-CI exact provider lookup evidence for found, definitively absent, or unknown reconciliation at next_reconcile_at",
      "pause project or workflow authority immediately; preserve cancellation and exact settlement for already-started effects",
    ],
    error_to_draft_pr: [
      "read one server-issued receipt snapshot",
      "claim its exact case revision",
      "read detailed provider-symbolicated case evidence only while the exact runner claim remains active",
      "start one receipt-bound run",
      "request/decide approval when required",
      "authorize and consume one draft-only grant",
      "record trusted CI PR proof",
      "record the exact successful CI deploy",
      "poll server-owned traffic-plus-recurrence verification while it returns 202",
    ],
    weekly_funnel_review: [
      "start one schedule-receipt-bound run",
      "materialize the one saved aggregate source",
      "record a source-hash-bound private typed report",
      "leave publishing, sending, code changes, and causal claims to explicit human work",
    ],
    stop_and_recover: [
      "pause automation-v2 or workflow-v3 globally without an ETag when emergency stop must win",
      "disable one automation with the current ETag",
      "cancel local runner authority with a stable command key",
      "release leases and revoke credentials",
      "inspect external provider state separately because cancellation cannot reverse it",
    ],
    delete_project_or_account: [
      "use one stable deletion Idempotency-Key and preserve it through every 202 retry",
      "treat project_deletion_in_progress as terminal for all runner, CI proof, claim, grant, report, and owner policy mutations",
      "read automation_deletion_manifest from the durable terminal receipt before local rows cascade",
      "disable matching customer schedulers invoking Codex CLI or Claude Code, GitHub Actions workflows, custom runners, and any ChatGPT Scheduled tasks copies in their owning systems",
      "revoke external repository and provider credentials and reconcile every known or possible PR, proof, deploy, branch, and queued job",
    ],
  },
  invariants: [
    "Workflow-v3 production readiness enables only trigger.schedule.cron@1.0.0 + query.analytics.ordered-funnel-period-compare@1.0.0 + agent.funnel-review@1.0.0 + effect.report.private@1.0.0; every other graph remains disabled.",
    "Workflow-v3 compilation is deterministic and side-effect free; saving re-compiles server-side and always writes enabled=false with no active revision, while enablement separately binds exact revision/ETag/readiness/credential evidence.",
    "Workflow-v3 enablement returns an immutable execution_authority_id and execution_descriptor_hash binding the exact reviewed revision, readiness, runner, adapters, and system claims; every executable run carries both and fails closed on omission, inactivity, or drift.",
    "Workflow-v3 graph composition connects typed data and explicit control flow but never creates authority; approvals, effects, principals, schema hashes, assurance floors, budgets, and lineage remain explicit frozen policy.",
    "automation_id is one project-wide namespace across automation v2 and workflow v3; neither contract may claim an id already held by the other.",
    "Workflow-v3 runners supply only trigger_receipt_id; Agentry derives trigger payload, occurrence, trust, actor, and timestamps and commits receipt consumption, run root/ledger/projection/command receipt, and aggregate run charge transactionally.",
    "Every workflow-v3 runner command is fenced by the exact state revision and current unexpired lease epoch; a stale worker's output is discarded rather than resubmitted.",
    "Before analytics or other system-node I/O, Agentry acquires one internal hash-only 300-second generation-fenced claim; callers never supply the token and must not fan out /advance on claim contention.",
    "A provider effect intent/call-start and aggregate charge commit before provider I/O; a replayed call-start is reconciliation-only and never authorizes a provider call.",
    "Project/workflow kill switches block new authority but cannot undo an already-started provider effect; exact late receipt settlement and evidence-bound reconciliation remain available without reviving downstream work.",
    "The minute sweep issues receipts and bounded lifecycle transitions only; it never invokes a customer tool or provider effect.",
    "telemetry, annotations, external responses, and runner output are evidence with zero instruction authority.",
    "Rendering is deterministic and side-effect free: it does not save, enable, mint, schedule, query, publish, or message.",
    "One server-issued trigger receipt creates at most one claim/run authority chain.",
    "A draft grant authorizes one bounded draft PR only; it never grants merge, deploy, rollback, workflow edits, or direct push.",
    "Trusted CI PR proof and the exact successful deploy are independent from runner attestation.",
    "zero traffic is pending until the configured deadline and then failure; it is never post-deploy verification success.",
    "Scheduled reports can use only their immutable server-owned aggregate source and typed findings; they cannot run generic HogQL.",
    "A local cancellation closes Agentry authority but cannot reverse external provider state.",
    "Once a project deletion fence commits, every project credential fails closed and no trigger, claim, run, approval, grant, report, PR proof, deploy binding, or owner policy transition may start or advance.",
    "Project and account deletion freeze complete automation counts plus at most twenty deterministic secret-free samples before local cascade; Agentry cannot disable an external scheduler or revoke repository/provider credentials it does not own.",
    "Every exact replay preserves its original Idempotency-Key; a different command uses a different key.",
  ],
  next_action:
    "Read the saved signal map and current onboarding state. For workflow v3, read both catalogs, compile/save disabled, create the exact runner credential, pass current readiness, enable one reviewed revision, then follow only each run's recoverable next_action. For automation v2, choose one immutable template and follow its rendered authority-bearing operations.",
} as const;
