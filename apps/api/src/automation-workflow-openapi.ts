/** Canonical OpenAPI fragments for the fail-closed workflow-v3 production slice. */

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
): OpenApiObject {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties,
  };
}

const array = (items: unknown, bounds: OpenApiObject = {}) => ({
  type: "array",
  items,
  ...bounds,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const literal = (value: string | number | boolean) => ({
  type: typeof value,
  const: value,
});
const enumString = (values: readonly string[]) => ({
  type: "string",
  enum: [...values],
});
const nullable = (schema: unknown) => ({ oneOf: [schema, nullSchema] });

function jsonResponse(
  schema: unknown,
  description = "OK",
  example: unknown = {},
) {
  return {
    description,
    content: {
      "application/json": {
        schema,
        examples: { default: { value: example } },
      },
    },
  };
}

const errorResponse = (description: string) =>
  jsonResponse(ref("ErrorEnvelope"), description, {
    error: {
      code: "invalid_payload",
      message: "The workflow request is invalid.",
      next_action: "Read the exact operation schema, correct the request, and retry.",
    },
  });

function operation(input: {
  operationId: string;
  summary: string;
  description: string;
  parameters?: unknown[];
  request?: unknown;
  requestExample?: unknown;
  responses: Record<string, unknown>;
  authority: string;
  security?: Array<Record<string, string[]>>;
  state?: "catalog" | "compile" | "control" | "runtime" | "recovery";
  extensions?: Record<string, unknown>;
}) {
  return {
    operationId: input.operationId,
    summary: input.summary,
    description: input.description,
    tags: ["Automation"],
    security: input.security ?? [{ ApiKeyAuth: [] }],
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.request === undefined
      ? {}
      : {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: input.request,
                examples: {
                  default: { value: input.requestExample ?? {} },
                },
              },
            },
          },
        }),
    responses: input.responses,
    "x-agentry-authority": input.authority,
    "x-agentry-workflow-v3-state": input.state ?? "runtime",
    "x-agentry-production-boundary":
      "schedule.cron + ordered-funnel-period-compare + funnel-review + private-report only; every other graph fails readiness closed",
    ...(input.extensions ?? {}),
  };
}

const privateOnly: Array<Record<string, string[]>> = [{ ApiKeyAuth: [] }];
const runnerOnly: Array<Record<string, string[]>> = [{ AutomationRunnerAuth: [] }];
const privateOrRunner: Array<Record<string, string[]>> = [
  { ApiKeyAuth: [] },
  { AutomationRunnerAuth: [] },
];
const privateOrCi: Array<Record<string, string[]>> = [
  { ApiKeyAuth: [] },
  { CiDeployAuth: [] },
];
const privateRunnerOrCi: Array<Record<string, string[]>> = [
  { ApiKeyAuth: [] },
  { AutomationRunnerAuth: [] },
  { CiDeployAuth: [] },
];
const idempotencyKeyParameter = { $ref: "#/components/parameters/idempotencyKey" };

const workflowId = {
  type: "string",
  pattern: "^[a-z][a-z0-9_-]{0,99}$",
};
const nodeId = workflowId;
const semver = {
  type: "string",
  pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$",
};
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
const timestamp = { type: "integer", minimum: 0 };
const etag = {
  type: "string",
  pattern: '^"[A-Za-z0-9._:-]+"$',
  description: "One exact quoted strong workflow-head ETag.",
};
const assurance = enumString(["reported", "recorded", "observed", "verified"]);
const principal = enumString([
  "agentry_system",
  "automation_runner",
  "human_project_owner",
  "customer_posthog",
  "trusted_ci",
]);

const componentRef = object(
  { id: { type: "string", pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$", maxLength: 200 }, version: semver },
  ["id", "version"],
);
const outputRef = object({ node_id: nodeId }, ["node_id"]);
const valueRef = object(
  {
    node_id: nodeId,
    path: array({ type: "string", minLength: 1, maxLength: 100 }, { maxItems: 20, default: [] }),
  },
  ["node_id"],
);
const inputs = {
  type: "object",
  minProperties: 1,
  maxProperties: 20,
  propertyNames: { pattern: "^[a-z][a-z0-9_]{0,99}$" },
  additionalProperties: ref("AutomationWorkflowV3OutputRef"),
};
const config = {
  type: "object",
  maxProperties: 100,
  additionalProperties: ref("AutomationWorkflowV3JsonValue"),
  description:
    "Bounded JSON config. The API additionally enforces aggregate depth, value-count, container-size, key-length, and total-string limits.",
};
const nodeBase = {
  id: nodeId,
  label: { type: "string", minLength: 1, maxLength: 200 },
};
const componentNodeBase = {
  ...nodeBase,
  component: ref("AutomationWorkflowV3ComponentRef"),
  config,
};
const linearNodeBase = {
  ...componentNodeBase,
  inputs,
  next: nodeId,
  on_error: nodeId,
};

const triggerNode = object(
  {
    ...componentNodeBase,
    kind: literal("trigger"),
    next: nodeId,
    on_error: nodeId,
  },
  ["id", "kind", "component", "config", "next", "on_error"],
);
const queryNode = object(
  { ...linearNodeBase, kind: literal("query") },
  ["id", "kind", "component", "config", "inputs", "next", "on_error"],
);
const agentTaskNode = object(
  { ...linearNodeBase, kind: literal("agent_task") },
  ["id", "kind", "component", "config", "inputs", "next", "on_error"],
);
const effectNode = object(
  {
    ...linearNodeBase,
    kind: literal("effect"),
    approval_node_id: nodeId,
  },
  ["id", "kind", "component", "config", "inputs", "next", "on_error"],
);
const waitNode = object(
  {
    ...componentNodeBase,
    kind: literal("wait"),
    inputs,
    on_ready: nodeId,
    on_timeout: nodeId,
    on_error: nodeId,
  },
  ["id", "kind", "component", "config", "inputs", "on_ready", "on_timeout", "on_error"],
);
const verifyNode = object(
  {
    ...componentNodeBase,
    kind: literal("verify"),
    inputs,
    on_pass: nodeId,
    on_fail: nodeId,
    on_timeout: nodeId,
    on_error: nodeId,
  },
  ["id", "kind", "component", "config", "inputs", "on_pass", "on_fail", "on_timeout", "on_error"],
);
const conditionNode = object(
  {
    ...nodeBase,
    kind: literal("condition"),
    predicate: object(
      {
        value: ref("AutomationWorkflowV3ValueRef"),
        operator: enumString(["eq", "not_eq", "gt", "gte", "lt", "lte", "contains"]),
        expected: {
          oneOf: [string, number, boolean, nullSchema],
        },
      },
      ["value", "operator", "expected"],
    ),
    on_true: nodeId,
    on_false: nodeId,
    on_error: nodeId,
  },
  ["id", "kind", "predicate", "on_true", "on_false", "on_error"],
);
const approvalNode = object(
  {
    ...nodeBase,
    kind: literal("approval"),
    subject: ref("AutomationWorkflowV3OutputRef"),
    expires_after_seconds: { type: "integer", minimum: 300, maximum: 2_592_000 },
    on_approved: nodeId,
    on_rejected: nodeId,
    on_expired: nodeId,
  },
  ["id", "kind", "subject", "expires_after_seconds", "on_approved", "on_rejected", "on_expired"],
);
const terminalNode = object(
  {
    ...nodeBase,
    kind: literal("terminal"),
    terminal: {
      oneOf: [
        object(
          { outcome: literal("complete"), result: ref("AutomationWorkflowV3OutputRef") },
          ["outcome", "result"],
        ),
        object(
          {
            outcome: literal("escalate"),
            destination: { type: "string", minLength: 1, maxLength: 500 },
            instructions: { type: "string", minLength: 1, maxLength: 2_000 },
          },
          ["outcome", "destination", "instructions"],
        ),
      ],
      discriminator: { propertyName: "outcome" },
    },
  },
  ["id", "kind", "terminal"],
);

const runner = {
  ...object({
    provider: enumString(["codex", "claude_code", "github_actions", "custom"]),
    repository_provider: enumString(["github", "gitlab", "bitbucket", "custom"]),
    repository: {
      type: "string",
      format: "uri",
      pattern: "^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)[^/?#]+/[^?#]+$",
      maxLength: 500,
      description:
        "Optional absolute HTTPS repository URL without credentials, query, fragment, or empty path. If present, repository_provider and default_branch are required. Built-in repository providers also require their canonical public host; use custom for an intentional enterprise host.",
    },
    default_branch: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^(?!-)(?!HEAD$)(?!/)(?!.*\\.\\.)(?!.*//)(?!.*@\\{)(?!.*[\\u0000-\\u0020\\u007f~^:?*\\[\\\\])(?!.*(?:^|/)\\.)(?!.*\\.lock(?:/|$))(?!.*[/.]$).+$",
      description: "Conservative Git branch ref. Required exactly when repository is present.",
    },
    environment: { type: "string", minLength: 1, maxLength: 100 },
  }, ["provider"]),
  dependentRequired: {
    repository: ["repository_provider", "default_branch"],
    repository_provider: ["repository", "default_branch"],
    default_branch: ["repository", "repository_provider"],
  },
};

const limits = object(
  {
    max_runs_per_day: { type: "integer", minimum: 1, maximum: 1_000 },
    max_attempts_per_trigger: { type: "integer", minimum: 1, maximum: 20 },
    max_turns_per_run: { type: "integer", minimum: 1, maximum: 500 },
    max_active_runtime_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
    max_elapsed_seconds: {
      type: "integer",
      minimum: 60,
      maximum: 10_000_000,
      description: "Must be at least max_active_runtime_seconds.",
    },
    max_cost_usd_per_run: { type: "number", exclusiveMinimum: 0, maximum: 10_000 },
    retry_backoff_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
    max_external_effects_per_run: { type: "integer", minimum: 0, maximum: 100 },
    max_external_effects_per_day: { type: "integer", minimum: 0, maximum: 1_000 },
    max_files_changed_per_run: { type: "integer", minimum: 0, maximum: 100 },
    max_changed_lines_per_run: { type: "integer", minimum: 0, maximum: 10_000 },
  },
  [
    "max_runs_per_day",
    "max_attempts_per_trigger",
    "max_turns_per_run",
    "max_active_runtime_seconds",
    "max_elapsed_seconds",
    "retry_backoff_seconds",
    "max_external_effects_per_run",
    "max_external_effects_per_day",
    "max_files_changed_per_run",
    "max_changed_lines_per_run",
  ],
);

const workflowDefinition = object(
  {
    schema_version: literal("3"),
    id: workflowId,
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", minLength: 1, maxLength: 2_000 },
    runner: ref("AutomationWorkflowV3Runner"),
    limits: ref("AutomationWorkflowV3Limits"),
    entry: nodeId,
    nodes: array(ref("AutomationWorkflowV3Node"), { minItems: 2, maxItems: 100 }),
  },
  ["schema_version", "id", "name", "runner", "limits", "entry", "nodes"],
);

const dataContract = object(
  {
    ref: { type: "string", minLength: 3, maxLength: 300 },
    id: { type: "string", minLength: 1, maxLength: 200 },
    version: { type: "integer", minimum: 1 },
    title: string,
    description: string,
    instruction_authority: literal("none"),
    minimum_assurance: assurance,
    validator_semantics_version: literal(1),
    validator_semantics: array(string),
    json_schema: { type: "object", additionalProperties: true },
    json_schema_hash: sha256,
    schema_hash: sha256,
    contract_hash: sha256,
  },
  [
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
  ],
);

const componentInputPort = object(
  {
    contract: string,
    required: boolean,
    description: string,
    schema_hash: sha256,
    minimum_assurance: assurance,
  },
  ["contract", "required", "description", "schema_hash", "minimum_assurance"],
);
const componentAuthorityProperties = {
  telemetry_instruction_authority: literal("none"),
  owner_goal_grants_authority: literal(false),
  effect_authority: enumString(["none", "workflow_policy", "one_time_grant"]),
  approval_floor: enumString(["none", "per_run"]),
  approval_subject_port: nullable(string),
};
const componentAuthority = object(
  componentAuthorityProperties,
  Object.keys(componentAuthorityProperties),
);
const workspacePolicy = object(
  {
    path_semantics: literal("repository_relative_glob"),
    allowed_paths_config_field: literal("allowed_paths"),
    forbidden_paths: array(string),
    deny_precedence: literal(true),
    forbidden_change_types: array(string),
    required_test_commands_config_field: literal("test_commands"),
    max_files_changed_config_field: literal("max_files_changed"),
    max_changed_lines_config_field: literal("max_changed_lines"),
  },
  [
    "path_semantics",
    "allowed_paths_config_field",
    "forbidden_paths",
    "deny_precedence",
    "forbidden_change_types",
    "required_test_commands_config_field",
    "max_files_changed_config_field",
    "max_changed_lines_config_field",
  ],
);
const mutationProtocol = object(
  {
    intent_identity: literal("compile_hash+component_hash+run_id+node_id+canonical_input_hash+provider_target"),
    reservation: literal("durable_unique_intent_before_provider_call"),
    authorization_cardinality: literal("one_authorized_intent_per_run_node"),
    provider_retry_safety: literal("adapter_specific_idempotency_or_reconciliation_required"),
    uncertain_outcome: literal("indeterminate_until_reconciled"),
    retry_policy: literal("reconcile_existing_intent_before_any_repeat"),
    replay_policy: literal("return_persisted_receipt_without_repeating_provider_effect"),
  },
  [
    "intent_identity",
    "reservation",
    "authorization_cardinality",
    "provider_retry_safety",
    "uncertain_outcome",
    "retry_policy",
    "replay_policy",
  ],
);
const sideEffectProperties = {
  kind: enumString(["none", "customer_runner_workspace", "agentry_record", "external_provider"]),
  description: string,
  forbidden: array(string),
  enforcement: literal("runtime_required"),
  workspace_policy: nullable(workspacePolicy),
  mutation_protocol: nullable(mutationProtocol),
};
const componentSideEffect = object(
  sideEffectProperties,
  Object.keys(sideEffectProperties),
);

const configField = object(
  {
    type: enumString(["string", "integer", "number", "boolean", "string_array"]),
    required: boolean,
    minimum: number,
    maximum: number,
    min_items: integer,
    max_items: integer,
    item_format: string,
    item_min_length: integer,
    item_max_length: integer,
    const: { oneOf: [string, number, boolean] },
    format: string,
    description: string,
  },
  ["type", "required", "description"],
);
const configRule = {
  oneOf: [
    object(
      { kind: literal("distinct_items"), field: string },
      ["kind", "field"],
    ),
    object(
      { kind: literal("field_gte"), field: string, other_field: string },
      ["kind", "field", "other_field"],
    ),
  ],
  discriminator: { propertyName: "kind" },
};
const component = object(
  {
    id: string,
    version: semver,
    kind: enumString(["trigger", "query", "agent_task", "effect", "wait", "verify"]),
    title: string,
    description: string,
    input_ports: { type: "object", additionalProperties: componentInputPort },
    output_contract: string,
    output_value_paths: array(object(
      {
        path: array(string, { maxItems: 20 }),
        type: enumString(["string", "number", "boolean", "null"]),
      },
      ["path", "type"],
    )),
    output_available_on: array(enumString(["next", "on_ready", "on_pass", "on_fail"])),
    config_contract: object(
      {
        additional_properties: literal(false),
        fields: { type: "object", additionalProperties: configField },
        rules: array(configRule),
      },
      ["additional_properties", "fields", "rules"],
    ),
    principal_roles: object(
      {
        executor: principal,
        callers: array(principal),
        approver: nullable(principal),
        evidence_sources: array(principal),
      },
      ["executor", "callers", "approver", "evidence_sources"],
    ),
    requirement_templates: array(object(
      {
        id: string,
        kind: enumString(["project_readiness", "credential", "caller_assertion", "approval", "proof", "runtime"]),
        description: string,
      },
      ["id", "kind", "description"],
    )),
    authority: componentAuthority,
    side_effect: componentSideEffect,
    lineage: object(
      {
        scope: literal("same_workflow_run"),
        output_bound_to_inputs: literal(true),
        runtime_preconditions: array(string),
      },
      ["scope", "output_bound_to_inputs", "runtime_preconditions"],
    ),
    timing: object(
      {
        mode: enumString(["active", "durable_wait"]),
        max_wait_seconds_config_field: nullable(string),
      },
      ["mode", "max_wait_seconds_config_field"],
    ),
    output_contract_schema_hash: sha256,
    output_minimum_assurance: assurance,
    component_hash: sha256,
  },
  [
    "id",
    "version",
    "kind",
    "title",
    "description",
    "input_ports",
    "output_contract",
    "output_value_paths",
    "output_available_on",
    "config_contract",
    "principal_roles",
    "requirement_templates",
    "authority",
    "side_effect",
    "lineage",
    "timing",
    "output_contract_schema_hash",
    "output_minimum_assurance",
    "component_hash",
  ],
);

const requirement = object(
  {
    id: string,
    kind: enumString(["project_readiness", "credential", "caller_assertion", "approval", "proof", "runtime"]),
    requirement: string,
    next_action: string,
    required_by_node_ids: array(string),
  },
  ["id", "kind", "requirement", "next_action", "required_by_node_ids"],
);
const compileIssue = object(
  {
    code: string,
    path: array({ oneOf: [string, integer] }),
    message: string,
    next_action: string,
  },
  ["code", "path", "message", "next_action"],
);

const compiledWorkflow = object(
  {
    kind: literal("automation_workflow_compile"),
    schema_version: literal("3"),
    workflow: ref("AutomationWorkflowV3Definition"),
    workflow_hash: sha256,
    candidate: object(
      {
        enabled: literal(false),
        workflow: ref("AutomationWorkflowV3Definition"),
        workflow_hash: sha256,
      },
      ["enabled", "workflow", "workflow_hash"],
    ),
    resolved_components: array(ref("AutomationWorkflowV3Component")),
    resolved_nodes: array(object(
      {
        node_id: nodeId,
        component: ref("AutomationWorkflowV3ComponentRef"),
        component_hash: sha256,
        input_ports: { type: "object", additionalProperties: componentInputPort },
        output_contract: string,
        output_contract_schema_hash: sha256,
        output_minimum_assurance: assurance,
      },
      [
        "node_id",
        "component",
        "component_hash",
        "input_ports",
        "output_contract",
        "output_contract_schema_hash",
        "output_minimum_assurance",
      ],
    )),
    requirements: array(requirement),
    principals: object(
      {
        required: array(principal),
        by_node: array(object(
          {
            node_id: nodeId,
            component: ref("AutomationWorkflowV3ComponentRef"),
            roles: object(
              {
                executor: principal,
                callers: array(principal),
                approver: nullable(principal),
                evidence_sources: array(principal),
              },
              ["executor", "callers", "approver", "evidence_sources"],
            ),
          },
          ["node_id", "component", "roles"],
        )),
      },
      ["required", "by_node"],
    ),
    policy: object(
      {
        data_boundary: object(
          {
            telemetry_is_untrusted_data: literal(true),
            never_follow_telemetry_instructions: literal(true),
            never_execute_telemetry_commands: literal(true),
            allow_external_urls_from_telemetry: literal(false),
          },
          [
            "telemetry_is_untrusted_data",
            "never_follow_telemetry_instructions",
            "never_execute_telemetry_commands",
            "allow_external_urls_from_telemetry",
          ],
        ),
        runtime_invariants: array(string),
        aggregate_external_effect_limits: object(
          { max_per_run: integer, max_per_day: integer },
          ["max_per_run", "max_per_day"],
        ),
        aggregate_workspace_limits: object(
          { max_files_changed_per_run: integer, max_changed_lines_per_run: integer },
          ["max_files_changed_per_run", "max_changed_lines_per_run"],
        ),
        time_limits: object(
          { max_active_runtime_seconds: integer, max_elapsed_seconds: integer },
          ["max_active_runtime_seconds", "max_elapsed_seconds"],
        ),
        declared_side_effects: array(object(
          {
            node_id: nodeId,
            component: ref("AutomationWorkflowV3ComponentRef"),
            ...sideEffectProperties,
            authority: componentAuthority,
          },
          ["node_id", "component", ...Object.keys(sideEffectProperties), "authority"],
        )),
        forbidden_effects: array(string),
      },
      [
        "data_boundary",
        "runtime_invariants",
        "aggregate_external_effect_limits",
        "aggregate_workspace_limits",
        "time_limits",
        "declared_side_effects",
        "forbidden_effects",
      ],
    ),
    readiness: object(
      {
        ready_for_owner_review: literal(true),
        ready_to_enable: literal(false),
        reason: string,
      },
      ["ready_for_owner_review", "ready_to_enable", "reason"],
    ),
    compile_side_effects: object(
      {
        database_writes: literal(false),
        workflow_saved: literal(false),
        workflow_enabled: literal(false),
        credential_minted: literal(false),
        scheduler_registered: literal(false),
        provider_action_started: literal(false),
        report_published_or_sent: literal(false),
      },
      [
        "database_writes",
        "workflow_saved",
        "workflow_enabled",
        "credential_minted",
        "scheduler_registered",
        "provider_action_started",
        "report_published_or_sent",
      ],
    ),
    next_action: string,
    compile_hash: sha256,
  },
  [
    "kind",
    "schema_version",
    "workflow",
    "workflow_hash",
    "candidate",
    "resolved_components",
    "resolved_nodes",
    "requirements",
    "principals",
    "policy",
    "readiness",
    "compile_side_effects",
    "next_action",
    "compile_hash",
  ],
);

const storedWorkflowProperties = {
  kind: literal("automation_workflow"),
  schema_version: literal("3"),
  project_id: string,
  automation_id: workflowId,
  revision_id: { type: "string", pattern: "^awfr_[a-f0-9]{64}$" },
  revision: { type: "integer", minimum: 1 },
  etag,
  enabled: boolean,
  active_revision_id: nullable({ type: "string", pattern: "^awfr_[a-f0-9]{64}$" }),
  active_execution_authority_id: nullable(sha256),
  paused_at: nullable(timestamp),
  pause_reason: nullable({ type: "string", minLength: 1, maxLength: 1_000 }),
  workflow_hash: sha256,
  compile_hash: sha256,
  component_hashes: { type: "object", additionalProperties: sha256 },
  workflow: ref("AutomationWorkflowV3Definition"),
  compiled: ref("AutomationWorkflowV3Compiled"),
  created_at: timestamp,
  updated_at: timestamp,
  next_action: string,
};
const storedWorkflowRequired = Object.keys(storedWorkflowProperties);
const storedWorkflow = object(storedWorkflowProperties, storedWorkflowRequired);
const savedWorkflow = object(
  { ...storedWorkflowProperties, created: boolean },
  [...storedWorkflowRequired, "created"],
);

const workflowProjectControl = object(
  {
    kind: literal("automation_workflow_project_control"),
    schema_version: literal("1"),
    project_id: string,
    revision: { type: "integer", minimum: 1 },
    etag,
    paused: boolean,
    paused_at: nullable(timestamp),
    pause_reason: nullable({ type: "string", minLength: 1, maxLength: 1_000 }),
    updated_at: timestamp,
    next_action: string,
  },
  [
    "kind",
    "schema_version",
    "project_id",
    "revision",
    "etag",
    "paused",
    "paused_at",
    "pause_reason",
    "updated_at",
    "next_action",
  ],
);

const readinessBlocker = object(
  {
    check_id: string,
    code: string,
    message: string,
    next_action: string,
  },
  ["check_id", "code", "message", "next_action"],
);
const readinessCheck = object(
  {
    id: string,
    kind: enumString(["project_readiness", "credential", "caller_assertion", "approval", "proof", "runtime", "unknown"]),
    required_by_node_ids: array(nodeId),
    requirement: string,
    status: enumString(["ready", "blocked"]),
    evidence_ids: array(string),
    blocker: nullable(object(
      { code: string, message: string, next_action: string },
      ["code", "message", "next_action"],
    )),
  },
  [
    "id",
    "kind",
    "required_by_node_ids",
    "requirement",
    "status",
    "evidence_ids",
    "blocker",
  ],
);
const workflowReadiness = object(
  {
    kind: literal("automation_workflow_readiness"),
    schema_version: literal("3"),
    project_id: string,
    automation_id: workflowId,
    revision_id: string,
    revision: { type: "integer", minimum: 1 },
    etag,
    workflow_hash: sha256,
    compile_hash: sha256,
    status: enumString(["ready", "blocked"]),
    readiness_hash: sha256,
    owner_confirmed_caller_assertion_ids: array(string),
    checks: array(readinessCheck),
    blockers: array(readinessBlocker),
    next_action: string,
  },
  [
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
  ],
);

const triggerReceipt = object(
  {
    kind: literal("automation_workflow_trigger_receipt"),
    schema_version: literal("1"),
    receipt_id: string,
    project_id: string,
    automation_id: workflowId,
    workflow_revision_id: string,
    workflow_hash: sha256,
    compile_hash: sha256,
    execution_authority_id: sha256,
    trigger_node_id: nodeId,
    component: object(
      {
        id: enumString(["trigger.cases.unhandled", "trigger.schedule.cron"]),
        version: semver,
        component_hash: sha256,
        output_contract: enumString(["case_trigger_receipt@1", "schedule_trigger_receipt@1"]),
        output_schema_hash: sha256,
      },
      ["id", "version", "component_hash", "output_contract", "output_schema_hash"],
    ),
    trigger_kind: enumString(["case", "schedule"]),
    trigger_key: string,
    attempt: { type: "integer", minimum: 1 },
    trigger_output: {
      type: "object",
      additionalProperties: ref("AutomationWorkflowV3JsonValue"),
      description:
        "Server-authored typed output. A runner may read it but can never supply or modify it when starting a run.",
    },
    trigger_output_hash: sha256,
    source_trust: enumString(["customer_posthog", "agentry_system"]),
    status: enumString(["ready", "consumed", "expired", "cancelled"]),
    consumed_run_id: nullable(string),
    issued_at: timestamp,
    available_at: timestamp,
    expires_at: timestamp,
    consumed_at: nullable(timestamp),
    cancelled_at: nullable(timestamp),
    cancel_reason: nullable(string),
    updated_at: timestamp,
    next_action: string,
  },
  [
    "kind",
    "schema_version",
    "receipt_id",
    "project_id",
    "automation_id",
    "workflow_revision_id",
    "workflow_hash",
    "compile_hash",
    "execution_authority_id",
    "trigger_node_id",
    "component",
    "trigger_kind",
    "trigger_key",
    "attempt",
    "trigger_output",
    "trigger_output_hash",
    "source_trust",
    "status",
    "consumed_run_id",
    "issued_at",
    "available_at",
    "expires_at",
    "consumed_at",
    "cancelled_at",
    "cancel_reason",
    "updated_at",
    "next_action",
  ],
);
const triggerIssuance = object(
  {
    kind: literal("automation_workflow_trigger_issuance"),
    schema_version: literal("1"),
    project_id: string,
    automation_id: workflowId,
    workflow_revision_id: string,
    trigger_kind: enumString(["case", "schedule"]),
    receipts: array(triggerReceipt),
    issued_count: { type: "integer", minimum: 0 },
    replayed_count: { type: "integer", minimum: 0 },
    skipped: array(object(
      {
        code: string,
        reason: string,
        details: {
          type: "object",
          additionalProperties: ref("AutomationWorkflowV3JsonValue"),
        },
      },
      ["code", "reason"],
    )),
    next_action: string,
  },
  [
    "kind",
    "schema_version",
    "project_id",
    "automation_id",
    "workflow_revision_id",
    "trigger_kind",
    "receipts",
    "issued_count",
    "replayed_count",
    "skipped",
    "next_action",
  ],
);

const runAuthority = object(
  {
    open: boolean,
    reason: enumString([
      "open",
      "project_deletion_fenced",
      "project_control_missing",
      "project_paused",
      "workflow_missing",
      "workflow_disabled",
      "workflow_paused",
      "active_revision_mismatch",
      "execution_authority_missing",
      "execution_authority_mismatch",
      "runner_credential_inactive",
    ]),
    project_revision: nullable(integer),
    project_paused_at: nullable(timestamp),
    project_pause_reason: nullable(string),
    workflow_etag: nullable(etag),
    workflow_enabled: nullable(boolean),
    workflow_paused_at: nullable(timestamp),
    workflow_pause_reason: nullable(string),
    active_revision_id: nullable(string),
    active_execution_authority_id: nullable(sha256),
    runner_credential_id: nullable(string),
    runner_credential_active: nullable(boolean),
    deletion_fence: nullable(object(
      {
        command_id: string,
        reason: enumString(["project_delete", "account_delete"]),
        fenced_at: timestamp,
      },
      ["command_id", "reason", "fenced_at"],
    )),
  },
  [
    "open",
    "reason",
    "project_revision",
    "project_paused_at",
    "project_pause_reason",
    "workflow_etag",
    "workflow_enabled",
    "workflow_paused_at",
    "workflow_pause_reason",
    "active_revision_id",
    "active_execution_authority_id",
    "runner_credential_id",
    "runner_credential_active",
    "deletion_fence",
  ],
);

const workflowRunOutput = object(
  {
    node_id: nodeId,
    contract: string,
    schema_hash: sha256,
    assurance,
    payload: ref("AutomationWorkflowV3JsonValue"),
    payload_hash: sha256,
    recorded_at: timestamp,
  },
  ["node_id", "contract", "schema_hash", "assurance", "payload", "payload_hash", "recorded_at"],
);
const runtimeAction = {
  oneOf: [
    object(
      {
        kind: literal("execute_component"),
        node_id: nodeId,
        attempt: { type: "integer", minimum: 1 },
        component: componentRef,
        component_hash: sha256,
        config,
        inputs: { type: "object", additionalProperties: workflowRunOutput },
        input_hash: sha256,
        output_contract: string,
        output_schema_hash: sha256,
        output_minimum_assurance: assurance,
      },
      [
        "kind",
        "node_id",
        "attempt",
        "component",
        "component_hash",
        "config",
        "inputs",
        "input_hash",
        "output_contract",
        "output_schema_hash",
        "output_minimum_assurance",
      ],
    ),
    object(
      {
        kind: literal("await_approval"),
        node_id: nodeId,
        effect_node_id: nodeId,
        subject_hash: sha256,
        binding_hash: sha256,
        expires_at: timestamp,
      },
      ["kind", "node_id", "effect_node_id", "subject_hash", "binding_hash", "expires_at"],
    ),
    object(
      {
        kind: literal("execute_effect"),
        node_id: nodeId,
        component: componentRef,
        component_hash: sha256,
        intent_hash: sha256,
        provider_target: string,
        input_hash: sha256,
        inputs: { type: "object", additionalProperties: workflowRunOutput },
      },
      ["kind", "node_id", "component", "component_hash", "intent_hash", "provider_target", "input_hash", "inputs"],
    ),
    object(
      {
        kind: literal("reconcile_effect"),
        node_id: nodeId,
        intent_hash: sha256,
        provider_target: string,
        reconciliation_count: { type: "integer", minimum: 0 },
        next_reconcile_at: timestamp,
      },
      ["kind", "node_id", "intent_hash", "provider_target", "reconciliation_count", "next_reconcile_at"],
    ),
    object(
      {
        kind: literal("suspended"),
        suspension: enumString(["wait", "verify"]),
        node_id: nodeId,
        next_check_at: timestamp,
        deadline_at: timestamp,
      },
      ["kind", "suspension", "node_id", "next_check_at", "deadline_at"],
    ),
  ],
  discriminator: { propertyName: "kind" },
};
const publicLease = object(
  {
    run_id: string,
    lease_epoch: { type: "integer", minimum: 1 },
    lease_version: { type: "integer", minimum: 1 },
    holder_principal: enumString(["agentry_system", "automation_runner", "trusted_ci"]),
    holder_credential_id: nullable(string),
    status: enumString(["active", "expired", "released"]),
    acquired_at: timestamp,
    renewed_at: timestamp,
    expires_at: timestamp,
    released_at: nullable(timestamp),
    release_reason: nullable(string),
  },
  [
    "run_id",
    "lease_epoch",
    "lease_version",
    "holder_principal",
    "holder_credential_id",
    "status",
    "acquired_at",
    "renewed_at",
    "expires_at",
    "released_at",
    "release_reason",
  ],
);
const recoverableAction = object(
  {
    runtime: runtimeAction,
    required_principal: principal,
    method: literal("POST"),
    path: string,
    expected_revision: { type: "integer", minimum: 1 },
    lease_required: boolean,
    lease: nullable(object(
      {
        current: nullable(publicLease),
        acquire: object({ method: literal("POST"), path: string }, ["method", "path"]),
        renew: object({ method: literal("POST"), path: string }, ["method", "path"]),
        release: object({ method: literal("DELETE"), path: string }, ["method", "path"]),
      },
      ["current", "acquire", "renew", "release"],
    )),
    timing: object(
      {
        ready_at: timestamp,
        next_check_at: nullable(timestamp),
        expires_at: nullable(timestamp),
        deadline_at: timestamp,
      },
      ["ready_at", "next_check_at", "expires_at", "deadline_at"],
    ),
    effect_id: nullable(string),
    effect_status: nullable(enumString(["reserved", "indeterminate", "succeeded", "manual_follow_up"])),
    suspension_id: nullable(string),
    suspension_kind: nullable(enumString(["approval", "wait", "verify"])),
    suspension_status: nullable(enumString([
      "pending",
      "approved",
      "rejected",
      "expired",
      "ready",
      "passed",
      "not_passed",
      "timed_out",
      "error",
      "cancelled",
    ])),
  },
  [
    "runtime",
    "required_principal",
    "method",
    "path",
    "expected_revision",
    "lease_required",
    "lease",
    "timing",
    "effect_id",
    "effect_status",
    "suspension_id",
    "suspension_kind",
    "suspension_status",
  ],
);
const workflowExecutionControl = object(
  {
    execution_authorized: boolean,
    next_action_suppressed: boolean,
    project_control: object({ method: literal("GET"), path: string }, ["method", "path"]),
    workflow_control: object({ method: literal("GET"), path: string }, ["method", "path"]),
    recovery: nullable(object(
      {
        mode: enumString(["continue_project_deletion", "restore_authority_or_cancel"]),
        instruction: string,
        deletion_command_id: nullable(string),
        cancel_run: object(
          { allowed: boolean, method: literal("POST"), path: string },
          ["allowed", "method", "path"],
        ),
        settle_already_started_effect: object(
          { allowed: boolean, method: literal("POST"), path: string },
          ["allowed", "method", "path"],
        ),
        reconcile_already_started_effect: object(
          { allowed: boolean, instruction: string },
          ["allowed", "instruction"],
        ),
      },
      [
        "mode",
        "instruction",
        "deletion_command_id",
        "cancel_run",
        "settle_already_started_effect",
        "reconcile_already_started_effect",
      ],
    )),
  },
  ["execution_authorized", "next_action_suppressed", "project_control", "workflow_control", "recovery"],
);
const workflowRun = object(
  {
    kind: literal("automation_workflow_run"),
    schema_version: literal("1"),
    project_id: string,
    automation_id: workflowId,
    run_id: string,
    workflow_revision_id: string,
    workflow_hash: sha256,
    compile_hash: sha256,
    execution_authority_id: sha256,
    execution_descriptor_hash: sha256,
    trigger_receipt_id: string,
    trigger_kind: enumString(["case", "schedule"]),
    trigger_key: string,
    attempt: { type: "integer", minimum: 1 },
    runner_credential_id: string,
    authority: runAuthority,
    execution_control: workflowExecutionControl,
    state: {
      type: "object",
      description:
        "Replay-verified runtime state. The exact runtime fields are immutable schema version 1; use state.revision, status, terminal, outputs, budgets, and hashes only as declared.",
      additionalProperties: true,
    },
    next_action: nullable(recoverableAction),
  },
  [
    "kind",
    "schema_version",
    "project_id",
    "automation_id",
    "run_id",
    "workflow_revision_id",
    "workflow_hash",
    "compile_hash",
    "execution_authority_id",
    "execution_descriptor_hash",
    "trigger_receipt_id",
    "trigger_kind",
    "trigger_key",
    "attempt",
    "runner_credential_id",
    "authority",
    "execution_control",
    "state",
    "next_action",
  ],
);

const adapterUsage = object(
  {
    sequence: { type: "integer", minimum: 1 },
    turns_used: { type: "integer", minimum: 0 },
    cost_micros: { type: "integer", minimum: 0 },
    touched_files: array({ type: "string", minLength: 1, maxLength: 1_000 }, { maxItems: 1_000 }),
    changed_line_churn: { type: "integer", minimum: 0 },
  },
  ["sequence", "turns_used", "cost_micros", "touched_files", "changed_line_churn"],
);
const workflowCommand = {
  oneOf: [
    object(
      {
        kind: literal("component_succeeded"),
        command_id: string,
        expected_revision: { type: "integer", minimum: 1 },
        node_id: nodeId,
        output: ref("AutomationWorkflowV3JsonValue"),
        usage: adapterUsage,
        lease: object(
          {
            lease_epoch: { type: "integer", minimum: 1 },
            lease_token: { type: "string", pattern: "^[A-Za-z0-9._~-]{32,500}$" },
          },
          ["lease_epoch", "lease_token"],
        ),
      },
      ["kind", "command_id", "expected_revision", "node_id", "output", "lease"],
    ),
    object(
      {
        kind: literal("component_domain_failed"),
        command_id: string,
        expected_revision: { type: "integer", minimum: 1 },
        node_id: nodeId,
        error: object(
          {
            code: { type: "string", minLength: 1, maxLength: 200 },
            message: { type: "string", minLength: 1, maxLength: 4_000 },
          },
          ["code", "message"],
        ),
        usage: adapterUsage,
        lease: object(
          {
            lease_epoch: { type: "integer", minimum: 1 },
            lease_token: { type: "string", pattern: "^[A-Za-z0-9._~-]{32,500}$" },
          },
          ["lease_epoch", "lease_token"],
        ),
      },
      ["kind", "command_id", "expected_revision", "node_id", "error", "lease"],
    ),
    object(
      {
        kind: literal("approval_decided"),
        command_id: string,
        expected_revision: { type: "integer", minimum: 1 },
        node_id: nodeId,
        decision: enumString(["approved", "rejected"]),
        reason: { type: "string", minLength: 1, maxLength: 1_000 },
      },
      ["kind", "command_id", "expected_revision", "node_id", "decision", "reason"],
    ),
    object(
      {
        kind: literal("effect_call_started"),
        command_id: string,
        expected_revision: { type: "integer", minimum: 1 },
        node_id: nodeId,
        intent_hash: sha256,
        lease: object(
          {
            lease_epoch: { type: "integer", minimum: 1 },
            lease_token: { type: "string", pattern: "^[A-Za-z0-9._~-]{32,500}$" },
          },
          ["lease_epoch", "lease_token"],
        ),
      },
      ["kind", "command_id", "expected_revision", "node_id", "intent_hash", "lease"],
    ),
    object(
      {
        kind: literal("effect_receipt_recorded"),
        command_id: string,
        expected_revision: { type: "integer", minimum: 1 },
        node_id: nodeId,
        intent_hash: sha256,
        output: ref("AutomationWorkflowV3JsonValue"),
      },
      ["kind", "command_id", "expected_revision", "node_id", "intent_hash", "output"],
    ),
  ],
  discriminator: { propertyName: "kind" },
};
const commandReceipt = object(
  {
    kind: literal("automation_workflow_command_receipt"),
    schema_version: literal("1"),
    run_id: string,
    command_id: string,
    request_hash: sha256,
    expected_revision: { type: "integer", minimum: 0 },
    committed_revision: { type: "integer", minimum: 1 },
    state_hash: sha256,
    state: { type: "object", additionalProperties: true },
    next_action: nullable(runtimeAction),
    idempotent_replay: boolean,
    effect_call: nullable(object(
      {
        intent_hash: sha256,
        provider_operation_key: string,
        call_authorized: boolean,
        reconcile_only: boolean,
        lease_epoch: { type: "integer", minimum: 1 },
      },
      ["intent_hash", "provider_operation_key", "call_authorized", "reconcile_only", "lease_epoch"],
    )),
  },
  [
    "kind",
    "schema_version",
    "run_id",
    "command_id",
    "request_hash",
    "expected_revision",
    "committed_revision",
    "state_hash",
    "state",
    "next_action",
    "idempotent_replay",
    "effect_call",
  ],
);
const leaseReceipt = object(
  {
    run_id: string,
    lease_epoch: { type: "integer", minimum: 1 },
    holder_principal: literal("automation_runner"),
    holder_credential_id: string,
    expires_at: timestamp,
    replayed: boolean,
  },
  ["run_id", "lease_epoch", "holder_principal", "holder_credential_id", "expires_at", "replayed"],
);
const leaseReleaseReceipt = object(
  {
    kind: literal("automation_workflow_lease_release_receipt"),
    schema_version: literal("1"),
    run_id: string,
    lease_epoch: { type: "integer", minimum: 1 },
    lease_version: { type: "integer", minimum: 1 },
    holder_principal: enumString(["agentry_system", "automation_runner", "trusted_ci"]),
    holder_credential_id: nullable(string),
    acquired_at: timestamp,
    renewed_at: timestamp,
    expires_at: timestamp,
    released_at: timestamp,
    release_reason: string,
    receipt_hash: sha256,
    idempotent_replay: boolean,
  },
  [
    "kind",
    "schema_version",
    "run_id",
    "lease_epoch",
    "lease_version",
    "holder_principal",
    "holder_credential_id",
    "acquired_at",
    "renewed_at",
    "expires_at",
    "released_at",
    "release_reason",
    "receipt_hash",
    "idempotent_replay",
  ],
);

const providerEvidence = object(
  {
    effect_event_id: string,
    effect_event_sequence: { type: "integer", minimum: 1 },
    event: string,
    observed_at: timestamp,
    actor_principal: principal,
    evidence_hash: sha256,
    provider: literal("github"),
    provider_operation_key: string,
    provider_target: string,
    intent_marker: sha256,
    expected_head_sha: { type: "string", pattern: "^[a-fA-F0-9]{7,64}$" },
    lookup_started_at: timestamp,
    lookup_completed_at: timestamp,
    lookup_result: enumString(["found", "not_found", "unknown"]),
    matched_provider_ref: nullable(string),
  },
  [
    "effect_event_id",
    "effect_event_sequence",
    "event",
    "observed_at",
    "actor_principal",
    "evidence_hash",
    "provider",
    "provider_operation_key",
    "provider_target",
    "intent_marker",
    "expected_head_sha",
    "lookup_started_at",
    "lookup_completed_at",
    "lookup_result",
    "matched_provider_ref",
  ],
);
const workflowEffect = object(
  {
    kind: literal("automation_workflow_effect"),
    schema_version: literal("1"),
    project_id: string,
    automation_id: workflowId,
    run_id: string,
    effect_id: string,
    node_id: nodeId,
    component: object(
      { id: string, version: semver, component_hash: sha256 },
      ["id", "version", "component_hash"],
    ),
    status: enumString(["reserved", "indeterminate", "succeeded", "manual_follow_up"]),
    version: { type: "integer", minimum: 1 },
    input_hash: sha256,
    intent_hash: sha256,
    approval: object(
      {
        suspension_id: string,
        binding_hash: sha256,
        status: enumString(["pending", "approved", "rejected", "expired", "cancelled"]),
        expires_at: timestamp,
        resolved_at: nullable(timestamp),
      },
      ["suspension_id", "binding_hash", "status", "expires_at", "resolved_at"],
    ),
    provider: object(
      {
        target: string,
        operation_key: string,
        call_attempt: { type: "integer", minimum: 0 },
        maximum_call_attempts: { type: "integer", minimum: 1 },
        call_started_at: nullable(timestamp),
        provider_ref: nullable(string),
        receipt_hash: nullable(sha256),
        completed_at: nullable(timestamp),
      },
      ["target", "operation_key", "call_attempt", "maximum_call_attempts", "call_started_at", "provider_ref", "receipt_hash", "completed_at"],
    ),
    reconciliation: object(
      {
        count: { type: "integer", minimum: 0 },
        maximum: { type: "integer", minimum: 1 },
        remaining: { type: "integer", minimum: 0 },
        next_reconcile_at: nullable(timestamp),
        due: boolean,
        operation: nullable(object(
          {
            method: literal("POST"),
            path: string,
            required_principal: literal("trusted_ci"),
            idempotency_key_required: literal(true),
          },
          ["method", "path", "required_principal", "idempotency_key_required"],
        )),
        last_provider_evidence: nullable(providerEvidence),
      },
      ["count", "maximum", "remaining", "next_reconcile_at", "due", "operation", "last_provider_evidence"],
    ),
    ledger: {
      type: "object",
      description: "Bounded hash-linked effect ledger tail and count.",
      additionalProperties: true,
    },
    provider_call_authorized: literal(false),
    created_at: timestamp,
    updated_at: timestamp,
  },
  [
    "kind",
    "schema_version",
    "project_id",
    "automation_id",
    "run_id",
    "effect_id",
    "node_id",
    "component",
    "status",
    "version",
    "input_hash",
    "intent_hash",
    "approval",
    "provider",
    "reconciliation",
    "ledger",
    "provider_call_authorized",
    "created_at",
    "updated_at",
  ],
);
const githubLookupEvidenceRequest = object(
  {
    provider: literal("github"),
    provider_operation_key: string,
    provider_target: string,
    intent_marker: sha256,
    expected_head_sha: { type: "string", pattern: "^[a-fA-F0-9]{7,64}$" },
    lookup_started_at: timestamp,
    lookup_completed_at: timestamp,
    lookup_result: enumString(["found", "not_found", "unknown"]),
    matched_provider_ref: nullable(string),
  },
  [
    "provider",
    "provider_operation_key",
    "provider_target",
    "intent_marker",
    "expected_head_sha",
    "lookup_started_at",
    "lookup_completed_at",
    "lookup_result",
    "matched_provider_ref",
  ],
);
const reconciliationReceipt = object(
  {
    kind: literal("automation_workflow_effect_reconciliation_receipt"),
    schema_version: literal("1"),
    project_id: string,
    automation_id: workflowId,
    run_id: string,
    effect_id: string,
    node_id: nodeId,
    intent_hash: sha256,
    request_hash: sha256,
    requested_outcome: enumString(["found", "definitively_absent", "unknown"]),
    effective_outcome: enumString(["found", "definitively_absent", "unknown"]),
    effect_status: enumString(["indeterminate", "succeeded", "manual_follow_up"]),
    reconciliation_count: { type: "integer", minimum: 0 },
    next_reconcile_at: nullable(timestamp),
    provider_ref: nullable(string),
    receipt_hash: nullable(sha256),
    provider_call_authorized: literal(false),
    effect_event_id: string,
    effect_event_sequence: { type: "integer", minimum: 1 },
    idempotent_replay: boolean,
  },
  [
    "kind",
    "schema_version",
    "project_id",
    "automation_id",
    "run_id",
    "effect_id",
    "node_id",
    "intent_hash",
    "request_hash",
    "requested_outcome",
    "effective_outcome",
    "effect_status",
    "reconciliation_count",
    "next_reconcile_at",
    "provider_ref",
    "receipt_hash",
    "provider_call_authorized",
    "effect_event_id",
    "effect_event_sequence",
    "idempotent_replay",
  ],
);
const recoveryRead = object(
  {
    method: literal("GET"),
    path: string,
    instruction: string,
  },
  ["method", "path", "instruction"],
);
const commandReceiptWithRecovery = object(
  {
    ...(commandReceipt.properties as Record<string, unknown>),
    recovery: recoveryRead,
  },
  [...(commandReceipt.required as string[]), "recovery"],
);
const leaseReceiptWithRecovery = object(
  {
    ...(leaseReceipt.properties as Record<string, unknown>),
    recovery: recoveryRead,
  },
  [...(leaseReceipt.required as string[]), "recovery"],
);
const leaseReleaseReceiptWithRecovery = object(
  {
    ...(leaseReleaseReceipt.properties as Record<string, unknown>),
    recovery: recoveryRead,
  },
  [...(leaseReleaseReceipt.required as string[]), "recovery"],
);
const runStatus = enumString([
  "running",
  "awaiting_component",
  "awaiting_approval",
  "effect_reserved",
  "effect_indeterminate",
  "waiting",
  "verifying",
  "completed",
  "escalated",
  "cancelled",
  "quarantined",
]);
const runList = object(
  {
    kind: literal("automation_workflow_run_list"),
    schema_version: literal("1"),
    project_id: string,
    automation_id: workflowId,
    runs: array(object(
      {
        run_id: string,
        workflow_revision_id: string,
        trigger_receipt_id: string,
        trigger_kind: enumString(["case", "schedule"]),
        attempt: { type: "integer", minimum: 1 },
        status: runStatus,
        state_revision: { type: "integer", minimum: 1 },
        created_at: timestamp,
        updated_at: timestamp,
        read: object({ method: literal("GET"), path: string }, ["method", "path"]),
      },
      [
        "run_id",
        "workflow_revision_id",
        "trigger_receipt_id",
        "trigger_kind",
        "attempt",
        "status",
        "state_revision",
        "created_at",
        "updated_at",
        "read",
      ],
    ), { maxItems: 100 }),
    pagination: ref("AutomationKeysetPagination"),
    next_action: string,
  },
  ["kind", "schema_version", "project_id", "automation_id", "runs", "pagination", "next_action"],
);
const systemAdvance = object(
  {
    kind: literal("automation_workflow_system_advance"),
    schema_version: literal("1"),
    steps_committed: { type: "integer", minimum: 0, maximum: 32 },
    stopped_reason: enumString(["customer_runner", "owner", "suspended", "terminal"]),
    run: ref("AutomationWorkflowV3Run"),
  },
  ["kind", "schema_version", "steps_committed", "stopped_reason", "run"],
);

export const AUTOMATION_WORKFLOW_OPENAPI_SCHEMAS: Record<string, OpenApiObject> = {
  AutomationWorkflowV3JsonValue: {
    oneOf: [
      string,
      number,
      boolean,
      nullSchema,
      array(ref("AutomationWorkflowV3JsonValue"), { maxItems: 100 }),
      {
        type: "object",
        maxProperties: 100,
        additionalProperties: ref("AutomationWorkflowV3JsonValue"),
      },
    ],
  },
  AutomationWorkflowV3ComponentRef: componentRef,
  AutomationWorkflowV3OutputRef: outputRef,
  AutomationWorkflowV3ValueRef: valueRef,
  AutomationWorkflowV3TriggerNode: triggerNode,
  AutomationWorkflowV3QueryNode: queryNode,
  AutomationWorkflowV3ConditionNode: conditionNode,
  AutomationWorkflowV3AgentTaskNode: agentTaskNode,
  AutomationWorkflowV3ApprovalNode: approvalNode,
  AutomationWorkflowV3EffectNode: effectNode,
  AutomationWorkflowV3WaitNode: waitNode,
  AutomationWorkflowV3VerifyNode: verifyNode,
  AutomationWorkflowV3TerminalNode: terminalNode,
  AutomationWorkflowV3Node: {
    oneOf: [
      ref("AutomationWorkflowV3TriggerNode"),
      ref("AutomationWorkflowV3QueryNode"),
      ref("AutomationWorkflowV3ConditionNode"),
      ref("AutomationWorkflowV3AgentTaskNode"),
      ref("AutomationWorkflowV3ApprovalNode"),
      ref("AutomationWorkflowV3EffectNode"),
      ref("AutomationWorkflowV3WaitNode"),
      ref("AutomationWorkflowV3VerifyNode"),
      ref("AutomationWorkflowV3TerminalNode"),
    ],
    discriminator: { propertyName: "kind" },
  },
  AutomationWorkflowV3Runner: runner,
  AutomationWorkflowV3Limits: limits,
  AutomationWorkflowV3Definition: workflowDefinition,
  AutomationWorkflowV3DataContract: dataContract,
  AutomationWorkflowV3DataContractCatalog: object(
    {
      kind: literal("automation_workflow_data_contract_catalog"),
      version_policy: literal("immutable_integer"),
      count: { type: "integer", minimum: 0 },
      contracts: array(ref("AutomationWorkflowV3DataContract")),
      next_action: string,
    },
    ["kind", "version_policy", "count", "contracts", "next_action"],
  ),
  AutomationWorkflowV3Component: component,
  AutomationWorkflowV3ComponentCatalog: object(
    {
      kind: literal("automation_workflow_component_catalog"),
      version_policy: literal("immutable_semver"),
      count: { type: "integer", minimum: 0 },
      components: array(ref("AutomationWorkflowV3Component")),
      next_action: string,
    },
    ["kind", "version_policy", "count", "components", "next_action"],
  ),
  AutomationWorkflowV3CompileIssue: compileIssue,
  AutomationWorkflowV3Compiled: compiledWorkflow,
  AutomationWorkflowV3CompileResponse: {
    oneOf: [
      object(
        {
          success: literal(true),
          data: ref("AutomationWorkflowV3Compiled"),
          next_action: string,
        },
        ["success", "data", "next_action"],
      ),
      object(
        {
          success: literal(false),
          issues: array(ref("AutomationWorkflowV3CompileIssue"), { minItems: 1 }),
          next_action: string,
        },
        ["success", "issues", "next_action"],
      ),
    ],
  },
  AutomationWorkflowV3Stored: storedWorkflow,
  AutomationWorkflowV3SaveResponse: savedWorkflow,
  AutomationWorkflowV3ProjectControl: workflowProjectControl,
  AutomationWorkflowV3ReadinessBlocker: readinessBlocker,
  AutomationWorkflowV3ReadinessCheck: readinessCheck,
  AutomationWorkflowV3Readiness: workflowReadiness,
  AutomationWorkflowV3TriggerReceipt: triggerReceipt,
  AutomationWorkflowV3TriggerIssuance: triggerIssuance,
  AutomationWorkflowV3RunOutput: workflowRunOutput,
  AutomationWorkflowV3RuntimeAction: runtimeAction,
  AutomationWorkflowV3RecoverableAction: recoverableAction,
  AutomationWorkflowV3ExecutionControl: workflowExecutionControl,
  AutomationWorkflowV3PublicLease: publicLease,
  AutomationWorkflowV3Run: workflowRun,
  AutomationWorkflowV3AdapterUsage: adapterUsage,
  AutomationWorkflowV3Command: workflowCommand,
  AutomationWorkflowV3CommandReceipt: commandReceipt,
  AutomationWorkflowV3LeaseReceipt: leaseReceipt,
  AutomationWorkflowV3LeaseReleaseReceipt: leaseReleaseReceipt,
  AutomationWorkflowV3ProviderEvidence: providerEvidence,
  AutomationWorkflowV3Effect: workflowEffect,
  AutomationWorkflowV3GithubLookupEvidenceRequest: githubLookupEvidenceRequest,
  AutomationWorkflowV3ReconciliationReceipt: reconciliationReceipt,
  AutomationWorkflowV3RecoveryRead: recoveryRead,
  AutomationWorkflowV3CommandReceiptWithRecovery: commandReceiptWithRecovery,
  AutomationWorkflowV3LeaseReceiptWithRecovery: leaseReceiptWithRecovery,
  AutomationWorkflowV3LeaseReleaseReceiptWithRecovery: leaseReleaseReceiptWithRecovery,
  AutomationWorkflowV3RunList: runList,
  AutomationWorkflowV3SystemAdvance: systemAdvance,
};

const projectId = { $ref: "#/components/parameters/projectId" };
const workflowAutomationId = {
  name: "automation_id",
  in: "path",
  required: true,
  description: "Exact workflow id; it must match the request body's id on PUT.",
  schema: workflowId,
};
const workflowIfMatch = {
  name: "If-Match",
  in: "header",
  required: false,
  description:
    "Omit only when creating a workflow id for the first time. Every replacement requires the exact strong ETag from the latest GET or PUT; reload after 412 or 428.",
  schema: etag,
};
const workflowIfMatchRequired = {
  name: "If-Match",
  in: "header",
  required: true,
  description:
    "Exact quoted strong ETag from the reviewed workflow/readiness or project-control response. On 412, reload and review; never substitute a newer value without reconsidering the mutation.",
  schema: etag,
};
const workflowReceiptId = {
  name: "receipt_id",
  in: "path",
  required: true,
  description: "Exact server-issued workflow trigger receipt id.",
  schema: string,
};
const workflowRunId = {
  name: "run_id",
  in: "path",
  required: true,
  description: "Exact immutable workflow run id.",
  schema: string,
};
const workflowEffectId = {
  name: "effect_id",
  in: "path",
  required: true,
  description: "Exact durable effect projection id returned by the run action.",
  schema: string,
};
const workflowEtagHeaders = {
  ETag: {
    required: true,
    description: "Exact current workflow-head ETag for a later conditional replacement.",
    schema: etag,
  },
};

const weeklyExample = {
  schema_version: "3",
  id: "weekly_funnel_review",
  name: "Weekly activation funnel review",
  runner: { provider: "codex", environment: "production" },
  limits: {
    max_runs_per_day: 2,
    max_attempts_per_trigger: 1,
    max_turns_per_run: 24,
    max_active_runtime_seconds: 1800,
    max_elapsed_seconds: 1800,
    max_cost_usd_per_run: 5,
    retry_backoff_seconds: 900,
    max_external_effects_per_run: 0,
    max_external_effects_per_day: 0,
    max_files_changed_per_run: 0,
    max_changed_lines_per_run: 0,
  },
  entry: "scheduled",
  nodes: [
    {
      id: "scheduled",
      kind: "trigger",
      component: { id: "trigger.schedule.cron", version: "1.0.0" },
      config: { cron: "0 9 * * 1", timezone: "Europe/Helsinki", start_window_seconds: 900 },
      next: "funnel_source",
      on_error: "escalate",
    },
    {
      id: "funnel_source",
      kind: "query",
      component: { id: "query.analytics.ordered-funnel-period-compare", version: "1.0.0" },
      config: {
        events: ["account_created", "project_created", "first_value_reached"],
        period_days: 7,
        minimum_sample_size: 25,
      },
      inputs: { schedule: { node_id: "scheduled" } },
      next: "review_funnel",
      on_error: "escalate",
    },
    {
      id: "review_funnel",
      kind: "agent_task",
      component: { id: "agent.funnel-review", version: "1.0.0" },
      config: {},
      inputs: { source: { node_id: "funnel_source" } },
      next: "record_private_report",
      on_error: "escalate",
    },
    {
      id: "record_private_report",
      kind: "effect",
      component: { id: "effect.report.private", version: "1.0.0" },
      config: {},
      inputs: {
        source: { node_id: "funnel_source" },
        report: { node_id: "review_funnel" },
      },
      next: "complete",
      on_error: "escalate",
    },
    {
      id: "complete",
      kind: "terminal",
      terminal: { outcome: "complete", result: { node_id: "record_private_report" } },
    },
    {
      id: "escalate",
      kind: "terminal",
      terminal: {
        outcome: "escalate",
        destination: "project owner",
        instructions: "Report the missing evidence and stop.",
      },
    },
  ],
};

export const AUTOMATION_WORKFLOW_OPENAPI_PATHS: Record<string, OpenApiObject> = {
  "/v1/automation-workflow-components": {
    get: operation({
      operationId: "list_automation_workflow_components",
      summary: "List immutable workflow-v3 components",
      description:
        "Authenticated read-only catalog of the executable component versions, typed ports, principals, side effects, lineage rules, and runtime requirements accepted by the deterministic compiler.",
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3ComponentCatalog")),
        default: errorResponse("Error"),
      },
      authority: "workflow_component_catalog_read",
    }),
  },
  "/v1/automation-workflow-contracts": {
    get: operation({
      operationId: "list_automation_workflow_contracts",
      summary: "List immutable workflow-v3 data contracts",
      description:
        "Authenticated read-only catalog of typed payload contracts, executable validator-semantics hashes, assurance floors, and zero instruction authority. Use exact refs and schema hashes when connecting component ports.",
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3DataContractCatalog")),
        default: errorResponse("Error"),
      },
      authority: "workflow_data_contract_catalog_read",
    }),
  },
  "/v1/projects/{project_id}/automation-workflow-control": {
    get: operation({
      operationId: "get_automation_workflow_project_control",
      summary: "Read the workflow-v3 project kill switch",
      description:
        "Project members read the exact desired state, revision, pause reason, and strong ETag. Missing control fails execution closed. This is the first recovery read when every workflow is unexpectedly blocked.",
      parameters: [projectId],
      responses: {
        "200": {
          ...jsonResponse(ref("AutomationWorkflowV3ProjectControl")),
          headers: workflowEtagHeaders,
        },
        "404": errorResponse("Workflow project control not initialized"),
        default: errorResponse("Error"),
      },
      authority: "workflow_project_control_read",
      state: "control",
      security: privateOnly,
    }),
  },
  "/v1/projects/{project_id}/automation-workflow-control/pause": {
    post: operation({
      operationId: "pause_automation_workflow_project",
      summary: "Emergency-pause all workflow-v3 authority in a project",
      description:
        "Owner-only desired-state kill switch. It deliberately needs no If-Match so an emergency stop can win. It blocks new receipts, starts, leases, advancement, runner work, and provider call-start, but preserves cancellation and exact settlement/reconciliation for provider calls whose call-start already committed. Repeating the same reason returns the existing pause state.",
      parameters: [projectId],
      request: object(
        { reason: { type: "string", minLength: 1, maxLength: 1_000 } },
        ["reason"],
      ),
      requestExample: { reason: "incident INC-123: stop new workflow authority" },
      responses: {
        "200": {
          ...jsonResponse(object(
            {
              kind: literal("automation_workflow_project_pause_receipt"),
              schema_version: literal("1"),
              project_id: string,
              paused: literal(true),
              paused_at: timestamp,
              pause_reason: string,
              revision: integer,
              etag,
              next_action: string,
            },
            ["kind", "schema_version", "project_id", "paused", "paused_at", "pause_reason", "revision", "etag", "next_action"],
          )),
          headers: workflowEtagHeaders,
        },
        "409": errorResponse("Control is missing or pause lost bounded contention"),
        default: errorResponse("Error"),
      },
      authority: "owner_workflow_project_kill_switch",
      state: "control",
      security: privateOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Read desired state after response loss; a pause never reverses an already-started provider effect.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflow-control/resume": {
    post: operation({
      operationId: "resume_automation_workflow_project",
      summary: "Conditionally reopen project workflow-v3 authority",
      description:
        "Owner-only exact-replay mutation. Requires the current project-control ETag and a stable Idempotency-Key. Reopening the project does not enable individually paused workflows; each must pass current readiness and be enabled explicitly.",
      parameters: [projectId, workflowIfMatchRequired, idempotencyKeyParameter],
      request: object({}, []),
      requestExample: {},
      responses: {
        "200": jsonResponse(object(
          {
            kind: literal("automation_workflow_project_resume_receipt"),
            schema_version: literal("1"),
            control: ref("AutomationWorkflowV3ProjectControl"),
            next_action: string,
            idempotent_replay: boolean,
          },
          ["kind", "schema_version", "control", "next_action", "idempotent_replay"],
        )),
        "412": errorResponse("Project workflow control changed before resume"),
        "428": errorResponse("If-Match is required"),
        default: errorResponse("Error"),
      },
      authority: "owner_workflow_project_resume",
      state: "control",
      security: privateOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Replay the byte-equivalent request with the same Idempotency-Key; the durable receipt is readable even after the ETag advances.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/compile": {
    post: operation({
      operationId: "compile_automation_workflow",
      summary: "Compile one disabled workflow-v3 candidate",
      description:
        "Project members may perform deterministic, side-effect-free validation and compilation. The compile artifact itself always has ready_to_enable=false because live enablement evidence is evaluated only after a disabled revision is saved. Compilation does not write the database, save or enable a workflow, mint a credential, schedule work, start an agent, call a provider, publish, or send.",
      parameters: [projectId],
      request: ref("AutomationWorkflowV3Definition"),
      requestExample: weeklyExample,
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3CompileResponse")),
        "413": errorResponse("The bounded workflow request is too large"),
        default: errorResponse("Error"),
      },
      authority: "workflow_compile_only",
      state: "compile",
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}": {
    get: operation({
      operationId: "get_automation_workflow",
      summary: "Read the current workflow-v3 revision and live head",
      description:
        "Project members read the exact immutable current revision, frozen compilation, hashes, enabled/paused head state, active revision binding, next action, and strong ETag. This read grants no execution authority.",
      parameters: [projectId, workflowAutomationId],
      responses: {
        "200": {
          ...jsonResponse(ref("AutomationWorkflowV3Stored")),
          headers: workflowEtagHeaders,
        },
        "404": errorResponse("Workflow not found"),
        default: errorResponse("Error"),
      },
      authority: "workflow_revision_and_head_read",
      state: "control",
    }),
    put: operation({
      operationId: "save_disabled_automation_workflow",
      summary: "Save one immutable disabled workflow-v3 revision",
      description:
        "Owner-only. automation_id belongs to one project-wide namespace shared with automation v2; a v2/v3 collision returns 409. The body id must exactly match automation_id. The server compiles again, stores an immutable revision, advances the head atomically, and always clears active_revision_id and enabled=false. Omit If-Match only for the first save; every replacement requires the exact current ETag. Saving never enables, creates a run/receipt, invokes a scheduler/tool/provider, publishes, or sends.",
      parameters: [projectId, workflowAutomationId, workflowIfMatch],
      request: ref("AutomationWorkflowV3Definition"),
      requestExample: weeklyExample,
      responses: {
        "200": {
          ...jsonResponse(ref("AutomationWorkflowV3SaveResponse")),
          headers: workflowEtagHeaders,
        },
        "409": errorResponse("The automation_id is already held by automation v2"),
        "412": errorResponse("The workflow head does not exist or its ETag changed"),
        "413": errorResponse("The workflow or frozen compilation is too large"),
        "422": errorResponse("The workflow is structurally valid JSON but cannot compile"),
        "428": errorResponse("If-Match is required for replacement"),
        default: errorResponse("Error"),
      },
      authority: "workflow_save_disabled_only",
      state: "control",
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/readiness": {
    get: operation({
      operationId: "get_automation_workflow_readiness",
      summary: "Evaluate exact workflow-v3 enablement readiness",
      description:
        "Project members evaluate the current immutable revision against live project control, exactly one active bound runner credential, verified onboarding/signal evidence, exact query blueprint, installed adapters/handlers, and explicit owner caller assertions. Pass confirm once per exact required caller_assertion id. Unknown assertions fail rather than granting free-form authority. Only the scheduled-funnel component set can currently become ready.",
      parameters: [
        projectId,
        workflowAutomationId,
        {
          name: "confirm",
          in: "query",
          required: false,
          style: "form",
          explode: true,
          description:
            "Repeatable exact caller_assertion id. The scheduled-funnel slice requires scheduler_execution_configured. Use exactly the ids returned by this revision's checks.",
          schema: { type: "array", items: string, maxItems: 100 },
        },
      ],
      responses: {
        "200": {
          ...jsonResponse(ref("AutomationWorkflowV3Readiness")),
          headers: workflowEtagHeaders,
        },
        "404": errorResponse("Workflow not found"),
        "412": errorResponse("The exact expected revision changed"),
        "422": errorResponse("A caller assertion is unknown for this revision"),
        default: errorResponse("Error"),
      },
      authority: "workflow_readiness_evidence_read",
      state: "control",
      security: privateOnly,
      extensions: {
        "x-agentry-readiness-fails-closed": true,
        "x-agentry-owner-confirmation-policy":
          "Confirm only exact caller_assertion check ids; confirmations are hashed into revision-bound readiness evidence.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/enable": {
    post: operation({
      operationId: "enable_automation_workflow",
      summary: "Enable one exact ready workflow-v3 revision",
      description:
        "Owner-only exact-replay mutation. The current workflow ETag, revision_id, readiness_hash, and sorted caller-assertion ids must match one ready evaluation in the same transaction. Enablement binds exactly one active workflow runner credential and never registers or launches a scheduler/tool/provider.",
      parameters: [projectId, workflowAutomationId, workflowIfMatchRequired, idempotencyKeyParameter],
      request: object(
        {
          revision_id: string,
          readiness_hash: sha256,
          owner_confirmed_caller_assertion_ids: array(string, { maxItems: 100, uniqueItems: true }),
        },
        ["revision_id", "readiness_hash", "owner_confirmed_caller_assertion_ids"],
      ),
      requestExample: {
        revision_id: "awfr_<sha256>",
        readiness_hash: "<sha256>",
        owner_confirmed_caller_assertion_ids: ["scheduler_execution_configured"],
      },
      responses: {
        "200": {
          ...jsonResponse(object(
            {
              kind: literal("automation_workflow_enable_receipt"),
              schema_version: literal("1"),
              workflow: ref("AutomationWorkflowV3Stored"),
              runner_credential_id: string,
              execution_authority_id: sha256,
              execution_descriptor_hash: sha256,
              readiness: object(
                {
                  revision_id: string,
                  readiness_hash: sha256,
                  owner_confirmed_caller_assertion_ids: array(string),
                },
                ["revision_id", "readiness_hash", "owner_confirmed_caller_assertion_ids"],
              ),
              next_action: string,
              idempotent_replay: boolean,
            },
            [
              "kind",
              "schema_version",
              "workflow",
              "runner_credential_id",
              "execution_authority_id",
              "execution_descriptor_hash",
              "readiness",
              "next_action",
              "idempotent_replay",
            ],
          )),
          headers: workflowEtagHeaders,
        },
        "409": errorResponse("Readiness is blocked or project control is paused"),
        "412": errorResponse("ETag, revision, or readiness hash changed"),
        "422": errorResponse("Enablement evidence is malformed or assertion is unknown"),
        "428": errorResponse("If-Match is required"),
        default: errorResponse("Error"),
      },
      authority: "owner_enable_exact_workflow_revision",
      state: "control",
      security: privateOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "After response loss, replay the byte-equivalent request with the same Idempotency-Key; load the durable command before re-evaluating the now-old ETag.",
        "x-agentry-execution-authority-binding":
          "execution_authority_id and execution_descriptor_hash bind the immutable reviewed enablement descriptor, runner, readiness evidence, revision, adapters, and system claims used by every executable run.",
        "x-agentry-error-recovery": {
          automation_workflow_execution_descriptor_not_ready:
            "Keep disabled, re-read current readiness, resolve blockers, and enable only a newly reviewed exact descriptor.",
        },
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/pause": {
    post: operation({
      operationId: "pause_automation_workflow",
      summary: "Emergency-pause one workflow-v3 automation",
      description:
        "Owner-only desired-state kill switch with no If-Match. It disables the head and clears active_revision_id immediately. Existing runs cannot acquire new authority, but an already-started provider effect remains settlement/reconciliation-only. To reopen, read current readiness and explicitly enable an exact revision again.",
      parameters: [projectId, workflowAutomationId],
      request: object(
        { reason: { type: "string", minLength: 1, maxLength: 1_000 } },
        ["reason"],
      ),
      requestExample: { reason: "incident INC-123: stop this workflow" },
      responses: {
        "200": {
          ...jsonResponse(object(
            {
              kind: literal("automation_workflow_pause_receipt"),
              schema_version: literal("1"),
              project_id: string,
              automation_id: workflowId,
              enabled: literal(false),
              paused_at: timestamp,
              pause_reason: string,
              etag,
              next_action: string,
            },
            ["kind", "schema_version", "project_id", "automation_id", "enabled", "paused_at", "pause_reason", "etag", "next_action"],
          )),
          headers: workflowEtagHeaders,
        },
        "404": errorResponse("Workflow not found"),
        "409": errorResponse("Pause lost bounded contention"),
        default: errorResponse("Error"),
      },
      authority: "owner_workflow_kill_switch",
      state: "control",
      security: privateOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Read the workflow head after response loss. Repeating the same reason returns the existing paused state.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/issue": {
    post: operation({
      operationId: "issue_automation_workflow_trigger_receipts",
      summary: "Issue due server-authored workflow-v3 trigger receipts",
      description:
        "Exact-bound runner or project owner requests one bounded eligibility sweep with strict empty JSON body {}. The server derives workflow revision, cron/case occurrence, attempt, trust, typed trigger_output, availability, expiry, actor, and timestamps. Repeated due issuance returns the same durable receipt. The minute sweep calls the same authority service but never starts a customer tool or provider effect.",
      parameters: [projectId, workflowAutomationId],
      request: object({}, []),
      requestExample: {},
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3TriggerIssuance")),
        "409": errorResponse("Workflow is disabled/paused or trigger authority changed"),
        default: errorResponse("Error"),
      },
      authority: "server_derived_workflow_trigger_issue",
      state: "runtime",
      security: privateOrRunner,
      extensions: {
        "x-agentry-trigger-authority":
          "Caller selects only the exact workflow; no caller-authored trigger facts, trust, times, actor, or payload are accepted.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts": {
    get: operation({
      operationId: "list_automation_workflow_trigger_receipts",
      summary: "List bounded workflow-v3 trigger receipt history",
      description:
        "Project members or the exact-bound runner list newest-first durable receipts. Use status=ready for work and status=consumed to recover a lost start through consumed_run_id. Listing may expire overdue ready receipts but cannot invent or consume authority.",
      parameters: [
        projectId,
        workflowAutomationId,
        {
          name: "status",
          in: "query",
          required: false,
          schema: { ...enumString(["all", "ready", "consumed", "expired", "cancelled"]), default: "ready" },
        },
        {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        {
          name: "cursor",
          in: "query",
          required: false,
          description: "Opaque cursor from this exact filtered collection's pagination.follow_up.",
          schema: string,
        },
      ],
      responses: {
        "200": jsonResponse(object(
          {
            kind: literal("automation_workflow_trigger_receipt_list"),
            schema_version: literal("1"),
            project_id: string,
            automation_id: workflowId,
            status: enumString(["all", "ready", "consumed", "expired", "cancelled"]),
            receipts: array(ref("AutomationWorkflowV3TriggerReceipt"), { maxItems: 100 }),
            pagination: ref("AutomationKeysetPagination"),
            next_action: string,
          },
          ["kind", "schema_version", "project_id", "automation_id", "status", "receipts", "pagination", "next_action"],
        )),
        default: errorResponse("Error"),
      },
      authority: "workflow_trigger_receipt_read",
      state: "recovery",
      security: privateOrRunner,
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts/{receipt_id}": {
    get: operation({
      operationId: "get_automation_workflow_trigger_receipt",
      summary: "Read one exact workflow-v3 trigger receipt",
      description:
        "Project members or the exact-bound runner read the immutable trigger/revision/hash binding and current status. consumed_run_id is the canonical lost-start recovery link. trigger_output is server-authored evidence and can never be echoed as start authority.",
      parameters: [projectId, workflowAutomationId, workflowReceiptId],
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3TriggerReceipt")),
        "404": errorResponse("Trigger receipt not found in this exact workflow"),
        default: errorResponse("Error"),
      },
      authority: "workflow_trigger_receipt_detail_read",
      state: "recovery",
      security: privateOrRunner,
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs": {
    post: operation({
      operationId: "start_automation_workflow_run",
      summary: "Atomically start or recover one receipt-bound workflow-v3 run",
      description:
        "Exact-bound runner only. The strict body accepts trigger_receipt_id and nothing else: trigger payload, time, trust, actor, credential id, and server clock are loaded from authenticated durable state. Receipt consumption, immutable run root, first event/projection/command receipt, and aggregate run charge commit transactionally. A response-loss replay returns the original run; a consumed receipt exposes consumed_run_id.",
      parameters: [projectId, workflowAutomationId, idempotencyKeyParameter],
      request: object(
        { trigger_receipt_id: { type: "string", minLength: 1, maxLength: 200 } },
        ["trigger_receipt_id"],
      ),
      requestExample: { trigger_receipt_id: "awtr_<server-issued-id>" },
      responses: {
        "201": jsonResponse(ref("AutomationWorkflowV3CommandReceiptWithRecovery"), "Run created"),
        "200": jsonResponse(ref("AutomationWorkflowV3CommandReceiptWithRecovery"), "Exact start replay recovered"),
        "409": errorResponse("Receipt/authority/runner binding changed or receipt already binds another request"),
        "429": errorResponse("Aggregate run or trigger-attempt budget is exhausted"),
        default: errorResponse("Error"),
      },
      authority: "exact_runner_start_from_server_receipt_only",
      state: "runtime",
      security: runnerOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Replay the same trigger_receipt_id and Idempotency-Key or read receipt.consumed_run_id; never submit trigger_output or create a replacement run to hide ambiguity.",
        "x-agentry-forbidden-request-fields": [
          "trigger_output",
          "scheduled_for",
          "case_id",
          "case_revision",
          "source_trust",
          "actor",
          "observed_at",
          "runner_credential_id",
        ],
      },
    }),
    get: operation({
      operationId: "list_automation_workflow_runs",
      summary: "List bounded workflow-v3 run summaries",
      description:
        "Project members or the exact-bound runner list newest-first summaries and stable detail paths. A summary is not executable authority; GET the selected run and follow only its strict next_action.",
      parameters: [
        projectId,
        workflowAutomationId,
        { name: "status", in: "query", required: false, schema: runStatus },
        { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
        { name: "cursor", in: "query", required: false, description: "Opaque cursor from this exact filter's pagination.follow_up.", schema: string },
      ],
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3RunList")),
        default: errorResponse("Error"),
      },
      authority: "workflow_run_summary_read",
      state: "recovery",
      security: privateOrRunner,
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}": {
    get: operation({
      operationId: "get_automation_workflow_run",
      summary: "Read one strict replay-verified workflow-v3 run",
      description:
        "Project members or the exact-bound runner read the immutable root, replay-verified state, live deletion/project/workflow/execution-authority/runner-credential gates, and execution_control. A recoverable next_action is returned only while execution_control.execution_authorized=true; otherwise it is suppressed and execution_control.recovery names the only allowed recovery. An open action names its executor principal, exact path, expected revision, lease requirement/current lease, timing, and effect/suspension id. next_action=null may therefore mean terminal or suppressed authority: inspect state.terminal and execution_control rather than treating HTTP 200 as success.",
      parameters: [projectId, workflowAutomationId, workflowRunId],
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3Run")),
        "404": errorResponse("Run not found in this exact project/workflow"),
        default: errorResponse("Error"),
      },
      authority: "workflow_recoverable_next_action_read",
      state: "recovery",
      security: privateOrRunner,
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease": {
    post: operation({
      operationId: "acquire_automation_workflow_run_lease",
      summary: "Acquire or recover one fenced workflow-v3 runner lease",
      description:
        "Exact-bound runner only. Supply a locally generated opaque token and 30-3600 second duration. Exact replay with the same active token returns the same epoch. After expiry/release, a takeover creates a larger epoch that permanently fences older workers. Never submit stale work under a new epoch.",
      parameters: [projectId, workflowAutomationId, workflowRunId],
      request: object(
        {
          lease_token: { type: "string", pattern: "^[A-Za-z0-9._~-]{32,500}$" },
          lease_seconds: { type: "integer", minimum: 30, maximum: 3_600 },
        },
        ["lease_token", "lease_seconds"],
      ),
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3LeaseReceiptWithRecovery")),
        "409": errorResponse("Another live epoch owns the run, authority is closed, or run is terminal"),
        default: errorResponse("Error"),
      },
      authority: "exact_runner_fenced_lease_acquire",
      state: "runtime",
      security: runnerOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Retain the supplied token locally and replay it after response loss. A different token cannot recover the first worker's authority or results.",
      },
    }),
    delete: operation({
      operationId: "release_automation_workflow_run_lease",
      summary: "Durably release one exact workflow-v3 lease epoch",
      description:
        "Exact-bound runner only. The current epoch, original opaque token, and bounded reason close the lease. Exact replay returns the immutable release receipt. A stale epoch reads the current run and discards old worker output.",
      parameters: [projectId, workflowAutomationId, workflowRunId],
      request: object(
        {
          lease_epoch: { type: "integer", minimum: 1 },
          lease_token: { type: "string", pattern: "^[A-Za-z0-9._~-]{32,500}$" },
          reason: { type: "string", minLength: 1, maxLength: 1_000 },
        },
        ["lease_epoch", "lease_token", "reason"],
      ),
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3LeaseReleaseReceiptWithRecovery")),
        "409": errorResponse("Lease epoch is stale or prior release used a different reason"),
        default: errorResponse("Error"),
      },
      authority: "exact_runner_fenced_lease_release",
      state: "recovery",
      security: runnerOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Replay the exact epoch/token/reason. Never rewrite release history or treat a stale worker result as current.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/lease/renew": {
    post: operation({
      operationId: "renew_automation_workflow_run_lease",
      summary: "Renew one exact unexpired workflow-v3 lease epoch",
      description:
        "Exact-bound runner only. The original token and current epoch must still own an unexpired lease; lease_seconds must move expires_at forward. A stale/expired/released epoch returns conflict and its worker must stop.",
      parameters: [projectId, workflowAutomationId, workflowRunId],
      request: object(
        {
          lease_token: { type: "string", pattern: "^[A-Za-z0-9._~-]{32,500}$" },
          lease_seconds: { type: "integer", minimum: 30, maximum: 3_600 },
          lease_epoch: { type: "integer", minimum: 1 },
        },
        ["lease_token", "lease_seconds", "lease_epoch"],
      ),
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3LeaseReceiptWithRecovery")),
        "409": errorResponse("Lease is stale, expired, released, not extended, or authority is closed"),
        default: errorResponse("Error"),
      },
      authority: "exact_runner_fenced_lease_renew",
      state: "runtime",
      security: runnerOnly,
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/commands": {
    post: operation({
      operationId: "apply_automation_workflow_command",
      summary: "Commit one exact public workflow-v3 command",
      description:
        "Strict five-kind command boundary. Exact runner may submit component_succeeded, component_domain_failed, effect_call_started, or effect_receipt_recorded; component work and call-start embed the current lease epoch/token. Only a project owner may submit approval_decided. start, tick, wait/verify resolution, quarantine, cancellation, and reconciliation are rejected here and use dedicated server/control services. command_id plus actor and canonical payload is exact-replay identity; changing payload under one id conflicts.",
      parameters: [projectId, workflowAutomationId, workflowRunId],
      request: ref("AutomationWorkflowV3Command"),
      requestExample: {
        kind: "component_succeeded",
        command_id: "review-funnel-result-<stable-id>",
        expected_revision: 2,
        node_id: "review_funnel",
        output: { report_hash: "<typed-output-from-contract>" },
        usage: {
          sequence: 1,
          turns_used: 4,
          cost_micros: 120000,
          touched_files: [],
          changed_line_churn: 0,
        },
        lease: { lease_epoch: 1, lease_token: "<32-plus-character-locally-generated-token>" },
      },
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3CommandReceiptWithRecovery")),
        "403": errorResponse("The authenticated principal cannot submit this command kind"),
        "409": errorResponse("Revision/lease/authority/run/effect state conflicts"),
        "422": errorResponse("Strict command or typed adapter output is invalid"),
        "429": errorResponse("Turns/cost/workspace/effect aggregate budget is exhausted"),
        default: errorResponse("Error"),
      },
      authority: "principal_and_revision_fenced_workflow_command",
      state: "runtime",
      security: privateOrRunner,
      extensions: {
        "x-agentry-command-principals": {
          automation_runner: [
            "component_succeeded",
            "component_domain_failed",
            "effect_call_started",
            "effect_receipt_recorded",
          ],
          human_project_owner: ["approval_decided"],
        },
        "x-agentry-effect-call-start-rule":
          "Call the provider only from a fresh effect_call receipt with call_authorized=true. Exact replay returns call_authorized=false,reconcile_only=true and never permits a call.",
        "x-agentry-provider-receipt-time":
          "For effect_receipt_recorded, output.recorded_at is server-owned. Omit it or send stable 0 when the typed contract permits; the transaction replaces it with the database second and request identity normalizes it so an exact retry remains stable across seconds.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/cancel": {
    post: operation({
      operationId: "cancel_automation_workflow_run",
      summary: "Cancel one workflow-v3 run's local authority",
      description:
        "Owner-only exact-replay command. expected_revision prevents cancelling a different projection than the one reviewed. Cancellation closes downstream Agentry authority and releases local coordination, but cannot undo an external provider call; read the effect and reconcile already-started uncertainty separately.",
      parameters: [projectId, workflowAutomationId, workflowRunId, idempotencyKeyParameter],
      request: object(
        {
          expected_revision: { type: "integer", minimum: 0 },
          reason: { type: "string", minLength: 1, maxLength: 1_000 },
        },
        ["expected_revision", "reason"],
      ),
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3CommandReceiptWithRecovery")),
        "409": errorResponse("Run revision changed or run is already terminal"),
        default: errorResponse("Error"),
      },
      authority: "owner_cancel_workflow_run",
      state: "control",
      security: privateOnly,
      extensions: {
        "x-agentry-recovery-rule":
          "Replay the same key/expected_revision/reason, then GET recovery.path. Inspect external effect state separately.",
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/advance": {
    post: operation({
      operationId: "advance_automation_workflow_system_nodes",
      summary: "Boundedly advance only reviewed Agentry-owned workflow-v3 nodes",
      description:
        "Project owner or exact-bound runner asks Agentry to execute up to max_steps due system-owned nodes using deterministic command ids. It never impersonates the customer runner or owner and never executes an unsupported external effect. It yields at runner work, owner approval, future suspension, reconciliation, or terminal. Re-read returned run.next_action after response loss.",
      parameters: [projectId, workflowAutomationId, workflowRunId],
      request: object(
        { max_steps: { type: "integer", minimum: 1, maximum: 32, default: 8 } },
        [],
      ),
      requestExample: {},
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3SystemAdvance")),
        "409": errorResponse("Authority closed, bounded step limit reached, or installed system adapter unavailable"),
        default: errorResponse("Error"),
      },
      authority: "agentry_system_component_advance_only",
      state: "runtime",
      security: privateOrRunner,
      extensions: {
        "x-agentry-system-does-not": [
          "invoke_codex_or_claude",
          "execute_customer_runner_action",
          "decide_owner_approval",
          "start_external_provider_effect",
        ],
        "x-agentry-system-claim":
          "Agentry internally acquires one hash-only 300-second fenced claim before analytics or other system-node I/O. The HTTP caller never supplies or receives its token.",
        "x-agentry-error-recovery": {
          automation_workflow_execution_authority_missing:
            "Nonretryable for this run: perform no analytics/provider work; pause, save/review, and enable a replacement revision. Never advance the legacy run.",
          automation_workflow_execution_descriptor_drift:
            "Nonretryable: perform no analytics read; pause and inspect, then save/review/enable a replacement exact revision.",
          automation_workflow_system_node_claim_active:
            "Wait until details.retry_at, GET the run, and replay the same /advance path. Never fan out another system-node worker.",
          automation_workflow_system_node_claim_contention:
            "Wait until details.retry_at, GET the run, and replay /advance. Never fan out.",
          automation_workflow_system_node_claim_stale:
            "Re-read run.next_action; do not continue from the stale claim context.",
          automation_workflow_system_node_claim_fence_lost:
            "Discard the result and re-read the run; never commit output from the fenced worker.",
        },
      },
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}": {
    get: operation({
      operationId: "get_automation_workflow_effect",
      summary: "Read one durable workflow-v3 effect and recovery state",
      description:
        "Project member, exact-bound runner, or project CI credential reads the immutable intent, approval binding, provider operation key/call state, bounded reconciliation count/timing, last provider evidence, and hash-linked ledger tail. This read always returns provider_call_authorized=false and never permits another provider call.",
      parameters: [projectId, workflowAutomationId, workflowRunId, workflowEffectId],
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3Effect")),
        "404": errorResponse("Effect not found in this exact run"),
        default: errorResponse("Error"),
      },
      authority: "effect_recovery_read_only",
      state: "recovery",
      security: privateRunnerOrCi,
    }),
  },
  "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}/effects/{effect_id}/reconcile": {
    post: operation({
      operationId: "reconcile_automation_workflow_effect",
      summary: "Settle one indeterminate workflow-v3 effect from exact CI evidence",
      description:
        "Trusted CI only. After next_reconcile_at, perform one exact GitHub lookup for the frozen provider operation/target/intent/head. found requires the exact typed provider receipt output; definitively_absent and unknown forbid output. Exact replay uses the same Idempotency-Key and evidence and is bound to the trusted_ci principal type rather than one credential id, so a replacement active project CI credential can recover a lost response while a revoked bearer remains rejected. Reconciliation advances live run/effect ledgers atomically, or only the detached effect ledger after the run is terminal, and always returns provider_call_authorized=false.",
      parameters: [projectId, workflowAutomationId, workflowRunId, workflowEffectId, idempotencyKeyParameter],
      request: {
        oneOf: [
          object(
            {
              outcome: literal("found"),
              evidence: ref("AutomationWorkflowV3GithubLookupEvidenceRequest"),
              output: ref("AutomationWorkflowV3JsonValue"),
            },
            ["outcome", "evidence", "output"],
          ),
          object(
            {
              outcome: enumString(["definitively_absent", "unknown"]),
              evidence: ref("AutomationWorkflowV3GithubLookupEvidenceRequest"),
            },
            ["outcome", "evidence"],
          ),
        ],
        discriminator: { propertyName: "outcome" },
      },
      responses: {
        "200": jsonResponse(ref("AutomationWorkflowV3ReconciliationReceipt")),
        "403": errorResponse("Exact active project CI credential is required"),
        "409": errorResponse("Effect is not indeterminate, not due, or another reconciler advanced first"),
        "422": errorResponse("Lookup evidence or found provider receipt does not match the frozen intent"),
        default: errorResponse("Error"),
      },
      authority: "trusted_ci_evidence_bound_effect_reconciliation",
      state: "recovery",
      security: [{ CiDeployAuth: [] }],
      extensions: {
        "x-agentry-provider-call-authorized": false,
        "x-agentry-recovery-rule":
          "Never repeat the provider mutation. Replay exact reconciliation evidence/key or read the effect and continue only if another bounded lookup is due.",
        "x-agentry-ci-replay-identity":
          "Replay identity binds trusted_ci, not a specific rotated CI credential. The caller must still present an active project CI credential; a revoked bearer is rejected.",
        "x-agentry-provider-receipt-time":
          "For outcome=found, output.recorded_at is server-owned. Omit it or send stable 0 when the typed contract permits; the transaction replaces it with the database second without changing exact replay identity.",
      },
    }),
  },
};
