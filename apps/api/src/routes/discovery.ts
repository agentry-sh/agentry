import { Hono } from "hono";
import { errors } from "@agentrysh/shared";
import { AUTOMATION_DOCS } from "../automation-docs.js";
import {
  adaptersIndex,
  renderAiderConventions,
  renderAgentsSection,
  renderClaudePluginManifest,
  renderClineRules,
  renderContinueRule,
  renderCopilotInstructions,
  renderCursorMdc,
  renderGeminiMd,
  renderRooRules,
  renderVSCodeInstructions,
  renderWindsurfWorkspaceRule,
  renderWindsurfRules,
  renderZedRules,
} from "../adapters.js";
import {
  QUERY_BLUEPRINTS,
  serializeQueryBlueprint,
} from "../query-blueprints.js";
import { CUSTOMER_ANALYTICS_HOGQL_FILTER } from "../customer-data.js";
import type { AppShape } from "../workflow-manifest.generated.js";
import type { AppBindings } from "../env.js";
import {
  AUTOMATION_OPENAPI_FLOW,
  AUTOMATION_OPENAPI_PARAMETERS,
  AUTOMATION_OPENAPI_PATHS,
  AUTOMATION_OPENAPI_SCHEMAS,
  AUTOMATION_OPENAPI_SECURITY_SCHEMES,
} from "../automation-openapi.js";
import {
  ONBOARDING_V3_OPENAPI_COMPONENTS,
  ONBOARDING_V3_OPENAPI_FLOW,
  ONBOARDING_V3_OPENAPI_PATHS,
} from "../onboarding-v3-openapi.js";
import { ONBOARDING_V3_CONTRACT_VERSION } from "../onboarding-v3-contract.js";
import { ONBOARDING_SOURCE_SNAPSHOT_PATH } from "../onboarding-source-snapshot.js";
import {
  mutationRecoveryInventory,
  mutationRoutePolicyExtension,
  mutationRoutePolicyFor,
} from "../mutation-route-policy.js";
import {
  PUBLIC_AGENT_REFERENCE_URL,
  PUBLIC_INSTALL_DOC_URL,
  PUBLIC_PRIVACY_URL,
  PUBLIC_REPOSITORY_URL,
  PUBLIC_SKILL_URL,
} from "../public-links.js";

const router = new Hono<AppBindings>();

const stringSchema = { type: "string" } as const;
const numberSchema = { type: "number" } as const;
const integerSchema = { type: "integer" } as const;
const booleanSchema = { type: "boolean" } as const;
const nullSchema = { type: "null" } as const;
const unknownObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const schemaExamples: Record<string, unknown> = {
  CreateProjectRequest: {
    name: "acme-web",
    repo_url: "https://github.com/acme/acme-web",
    default_branch: "main",
  },
  CreateProjectResponse: {
    command_id: "mutcmd_example",
    id: "018f0000-0000-7000-8000-000000000001",
    name: "acme-web",
    role: "owner",
    deploys_url: "https://api.agentry.sh/v1/deploys/",
    deploys_note:
      "Use deploys_url only from CI/provider post-deploy hooks after a successful deploy; never from app runtime.",
    idempotent_replay: false,
  },
  DeleteProjectResponse: {
    id: "018f0000-0000-7000-8000-000000000001",
    command_id: "mutcmd_example",
    status: "succeeded",
    deleted: true,
    cleanup: {
      webhook_delivery_drain: {
        drained: true,
        known_delivered_after_fence_count: 0,
        unknown_outcome_count: 0,
        external_follow_up: { required: false },
      },
      automation_deletion_manifest: {
        as_of: 1_783_661_600,
        project_ids: ["018f0000-0000-7000-8000-000000000001"],
        sample_limit: 20,
        counts: {
          enabled_contracts: 0,
          enabled_schedules: 0,
          active_runner_credentials: 0,
          ready_or_claimed_receipts: 0,
          nonterminal_runs: 0,
          active_claims: 0,
          pending_approvals: 0,
          issued_or_consumed_draft_pr_grants: 0,
          known_pr_identifiers: 0,
          known_pr_proof_identifiers: 0,
          known_deploy_identifiers: 0,
          known_external_effects: 0,
          possible_or_unknown_external_effects: 0,
          workflow_v3_project_controls: 0,
          workflow_v3_workflows: 0,
          workflow_v3_revisions: 0,
          workflow_v3_execution_authorities: 0,
          workflow_v3_trigger_receipts: 0,
          workflow_v3_runs: 0,
          workflow_v3_system_node_claims: 0,
          workflow_v3_run_leases: 0,
          workflow_v3_budget_charges: 0,
          workflow_v3_run_states: 0,
          workflow_v3_commands: 0,
          workflow_v3_run_events: 0,
          workflow_v3_suspensions: 0,
          workflow_v3_effects: 0,
          workflow_v3_effect_events: 0,
          workflow_v3_enabled_workflows: 0,
          workflow_v3_ready_trigger_receipts: 0,
          workflow_v3_nonterminal_runs: 0,
          workflow_v3_active_leases: 0,
          workflow_v3_active_system_node_claims: 0,
          workflow_v3_pending_suspensions: 0,
          workflow_v3_external_reserved_effects: 0,
          workflow_v3_external_indeterminate_effects: 0,
          workflow_v3_external_manual_follow_up_effects: 0,
          workflow_v3_external_succeeded_effects: 0,
        },
        samples: [],
        samples_truncated: false,
        external_follow_up: {
          required: false,
          provider_state_reversible_by_agentry: false,
          actions: [],
          note: "No automation authority or provider identifier was present.",
        },
      },
      customer_posthog_data_affected: false,
      external_operations: {
        counts: {
          active: 0,
          retained_external_state: 0,
          external_state_unknown: 0,
        },
        operations: [],
        operations_truncated: false,
      },
    },
    idempotent_replay: false,
    next_action:
      "Project deleted. Customer-owned PostHog data was not mutated or deleted.",
  },
  DeployIngestRequest: {
    version: "web@1.2.3",
    environment: "production",
    sha: "abc123def456",
    branch: "main",
    message: "Deploy web@1.2.3",
  },
  SignalMap: {
    project_id: "019exampleproject",
    contract_version: ONBOARDING_V3_CONTRACT_VERSION,
    mode: "onboarding_v3",
    plan_sha256: "5".repeat(64),
    business_question: "Which signup source produces paid workspaces?",
    plan_markdown:
      "A visitor creates a workspace, starts checkout, and becomes an active subscriber.",
    source_snapshot: {
      git_head_sha: "abc123def456",
      source_fingerprint_sha256: "a".repeat(64),
      source_fingerprint_algorithm: "agentry-source-tree-sha256-v1",
    },
    historical_evidence: {
      status: "historically_observed",
      source: "posthog_cloud",
      posthog_project_id: 42,
      observed_at: 1_724_000_000,
      window: { from: 1_721_408_000, to: 1_723_999_999 },
      query_receipt_sha256: "b".repeat(64),
      observations: [{
        kind: "analytics",
        event: "workspace_created",
        observed_properties: ["user_id", "workspace_id", "source"],
        row_count: 42,
      }],
    },
    evidence_status: {
      historical: "historically_observed",
      source: "source_verified",
    },
    milestones: [
      {
        event: "workspace_created",
        meaning: "The user and workspace are durably created.",
        posthog_boundary: "server_posthog",
        properties: ["user_id", "workspace_id", "source"],
        targets: [{
          file: "app/actions/signup.server.ts",
          anchor: "const signup = await createUserAndWorkspace(input);",
        }],
      },
      {
        event: "checkout_started",
        meaning: "The payment provider returns a checkout session.",
        posthog_boundary: "server_posthog",
        properties: ["workspace_id", "checkout_id", "plan"],
        targets: [{
          file: "app/actions/billing.server.ts",
          anchor: "const checkout = await createCheckoutSession({",
        }],
      },
      {
        event: "subscription_activated",
        meaning: "The active subscription is persisted for the workspace.",
        posthog_boundary: "server_posthog",
        properties: ["workspace_id", "plan", "subscription_status"],
        targets: [{
          file: "app/routes/webhooks/stripe.ts",
          anchor: "await updateWorkspaceSubscription({",
        }],
      },
    ],
    failures: [
      {
        marker: "signup.validation_rejected",
        meaning: "Invalid signup input blocks workspace creation without side effects.",
        posthog_boundary: "server_posthog",
        context: ["validation_field", "status_code", "operation"],
        safe_live_proof: true,
        targets: [{
          file: "app/actions/signup.server.ts",
          anchor: "if (!input.companyName) {",
        }],
      },
    ],
    deploy: {
      environment: "production",
      sha_source: "git_head",
      targets: [{
        file: ".github/workflows/deploy.yml",
        anchor: "deploy",
      }],
    },
    receipt: {
      evidence_status: "source_verified",
      source_verified_at: 1_725_000_000,
      analytics: [
        {
          event: "workspace_created",
          posthog_boundary: "server_posthog",
          required_properties: ["user_id", "workspace_id", "source"],
          observed_properties: ["user_id", "workspace_id", "source"],
          row_count: 1,
        },
        {
          event: "checkout_started",
          posthog_boundary: "server_posthog",
          required_properties: ["workspace_id", "checkout_id", "plan"],
          observed_properties: ["workspace_id", "checkout_id", "plan"],
          row_count: 1,
        },
        {
          event: "subscription_activated",
          posthog_boundary: "server_posthog",
          required_properties: ["workspace_id", "plan", "subscription_status"],
          observed_properties: ["workspace_id", "plan", "subscription_status"],
          row_count: 1,
        },
      ],
      error: {
        marker: "signup.validation_rejected",
        posthog_boundary: "server_posthog",
        required_context: ["validation_field", "status_code", "operation"],
        observed_context: ["validation_field", "status_code", "operation"],
        row_count: 1,
      },
      deploy: {
        environment: "production",
        source_snapshot: {
          git_head_sha: "abc123def456",
          source_fingerprint_sha256: "a".repeat(64),
          source_fingerprint_algorithm: "agentry-source-tree-sha256-v1",
        },
        row_count: 1,
      },
    },
  },
};

function refName(schema: unknown): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return null;
  const ref = (schema as { $ref?: unknown }).$ref;
  return typeof ref === "string" ? (ref.split("/").pop() ?? null) : null;
}

function exampleForSchema(schema: unknown, depth = 0): unknown {
  if (depth > 3) return {};
  const name = refName(schema);
  if (name && name in schemaExamples) return schemaExamples[name];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.oneOf) && record.oneOf.length > 0)
    return exampleForSchema(record.oneOf[0], depth + 1);
  if (Array.isArray(record.anyOf) && record.anyOf.length > 0)
    return exampleForSchema(record.anyOf[0], depth + 1);
  if (Array.isArray(record.enum) && record.enum.length > 0)
    return record.enum[0];
  if (record.type === "string") return "string";
  if (record.type === "number") return 1;
  if (record.type === "integer") return 1;
  if (record.type === "boolean") return true;
  if (record.type === "array")
    return [exampleForSchema(record.items, depth + 1)];
  if (record.type === "object") {
    const props =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : {};
    if (Object.keys(props).length === 0) return {};
    return Object.fromEntries(
      Object.entries(props).map(([key, value]) => [
        key,
        exampleForSchema(value, depth + 1),
      ]),
    );
  }
  return {};
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
  additionalProperties: boolean | Record<string, unknown> = false,
) {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties,
  };
}

function arraySchema(items: unknown) {
  return { type: "array", items };
}

function jsonResponse(
  schema: unknown,
  description = "OK",
  example: unknown = exampleForSchema(schema),
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

const errorEnvelopeExample = {
  error: {
    code: "invalid_payload",
    message: "Request body or parameters are invalid.",
    next_action:
      "Read error.details.request_body_schema, fix the request body, then retry once.",
    request_id: "req_example",
    retryable: false,
    details: {
      missing_fields: ["required_field"],
    },
  },
};

function errorResponse(description = "Error") {
  return jsonResponse(
    { $ref: "#/components/schemas/ErrorEnvelope" },
    description,
    errorEnvelopeExample,
  );
}

function buildCapabilitiesManifest() {
  const queryBlueprints = QUERY_BLUEPRINTS.slice(0, 8).map(
    serializeQueryBlueprint,
  );
  const queryBlueprintCategories = [
    ...new Set(QUERY_BLUEPRINTS.map((blueprint) => blueprint.category)),
  ].sort();
  const mutationRecovery = mutationRecoveryInventory();

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    principle:
      "Agentry is the agent-first control plane over a customer-owned PostHog Cloud project: read-only OAuth analytics and typed resource reads, source-backed onboarding, trusted deploy attribution, bounded evidence, and scoped automation coordination. Applications send telemetry and source maps directly to PostHog.",
    discovery: {
      reference: PUBLIC_AGENT_REFERENCE_URL,
      install_bootstrap: PUBLIC_INSTALL_DOC_URL,
      setup_manifest: "/v1/setup/manifest",
      openapi_schema: "/v1/openapi.json",
      filtered_schema_examples: [
        "/v1/openapi.json?index=true",
        "/v1/openapi.json?flow=onboarding",
        "/v1/openapi.json?flow=daily_use",
        "/v1/openapi.json?flow=posthog",
        "/v1/openapi.json?flow=automation",
        "/v1/openapi.json?tag=Feature%20Flags",
        "/v1/openapi.json?tag=Onboarding&include_components=false",
        "/v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fonboarding&method=post",
      ],
    },
    auth_types: {
      none: "Public discovery, query blueprints, the onboarding source-snapshot helper, schema, and privacy disclosure.",
      api_key: "Private agentry_sk_ key for owner/member read and mutation endpoints.",
      ci_deploy:
        "Trusted CI agentry_ci_ credential for Agentry deploy evidence and provider-observed automation PR proof only. PostHog source-map credentials remain customer-owned.",
      automation_runner:
        "Exact-bound agentry_runner_ credential for one saved automation_id and fixed trigger/claim/run/approval-request scopes.",
      public_query_url:
        "Browser-safe unguessable publication URLs returned by POST /v1/projects/:id/public-queries. The complete URL is the visitor capability; there is no second query-string key.",
      admin: "Operator-only plan and feedback administration.",
      stripe_webhook:
        "Stripe-signed webhook delivery for subscription lifecycle events.",
    },
    surfaces: {
      http: {
        schema_url: "/v1/openapi.json",
        schema_index_url: "/v1/openapi.json?index=true",
        setup_manifest_url: "/v1/setup/manifest",
        project_setup_url: "/v1/projects/{project_id}/setup",
        note: "OpenAPI is canonical for required/optional fields, auth, examples, and responses.",
      },
      query_blueprints: {
        catalog_url: "/v1/query-blueprints",
        get_url: "/v1/query-blueprints/{blueprint_id}",
        run_url:
          "/v1/projects/{project_id}/query-blueprints/{blueprint_id}/run",
        count: QUERY_BLUEPRINTS.length,
        categories: queryBlueprintCategories,
        examples: queryBlueprints,
      },
      automation: {
        guide_url: "/v1/docs/automation",
        flow_schema_url: "/v1/openapi.json?flow=automation",
        playbook_catalog_url: "/v1/automation-playbooks",
        control_url: "/v1/projects/{project_id}/automation-control",
        workflow_component_catalog_url: "/v1/automation-workflow-components",
        workflow_contract_catalog_url: "/v1/automation-workflow-contracts",
        workflow_control_url:
          "/v1/projects/{project_id}/automation-workflow-control",
        versions: {
          automation_contract: "2",
          workflow_definition: "3",
          workflow_runtime: "1",
        },
        immutable_templates: [
          "error-to-draft-pr@2.0.0",
          "weekly-funnel-review@2.0.0",
        ],
        workflow_v3_enabled_components: [
          "trigger.schedule.cron@1.0.0",
          "query.analytics.ordered-funnel-period-compare@1.0.0",
          "agent.funnel-review@1.0.0",
          "effect.report.private@1.0.0",
        ],
        note:
          "Use the flow's stable operation IDs and exact principals/headers. Workflow v3 is a fail-closed production slice for scheduled funnel review; unsupported graphs may compile/save disabled but readiness blocks enablement. Automation v2 playbook rendering remains side-effect free.",
      },
      onboarding: {
        bootstrap_url: PUBLIC_INSTALL_DOC_URL,
        flow_schema_url: "/v1/openapi.json?flow=onboarding",
        state_url: "/v1/projects/{project_id}/onboarding",
        source_snapshot_helper_url: ONBOARDING_SOURCE_SNAPSHOT_PATH,
        note:
          "Five project operations move through planned, approved, proving, and verified. Follow state.next_action after every operation. Completion is only status=verified, installation_complete=true, and next_action=null after real proof; caller-authored or synthetic proof never counts.",
      },
      posthog_resources: {
        flow_schema_url: "/v1/openapi.json?flow=posthog",
        resource_families: [
          "session_recordings",
          "feature_flags",
          "surveys",
          "experiments",
        ],
        note:
          "Canonical GET-only projections of live customer PostHog state. Responses are bounded and carry freshness plus data_boundary; replay content and provider mutations remain outside Agentry.",
      },
      docs: {
        query_docs: "/v1/docs/query",
        automation_docs: "/v1/docs/automation",
        privacy_disclosure: "/v1/privacy/disclosure",
      },
    },
    capabilities: [
      {
        id: "mutation_recovery",
        kind: "cross_cutting_contract",
        source: "MUTATION_ROUTE_POLICIES joined to exact filtered OpenAPI operations",
        auth: ["api_key", "ci_deploy", "automation_runner"],
        endpoint_count: mutationRecovery.length,
        endpoints: mutationRecovery.map((item) => item.operation),
        operations: mutationRecovery,
        invariants: [
          "Every generated operation requires one stable 8-500 character Idempotency-Key. Its exact replay or reconciliation behavior comes from retry_kind and the filtered OpenAPI operation, never a prose-only subset.",
          "external_audit_saga identifies one provider intent and requires reconciliation after ambiguity; it does not authorize a blind repeat.",
          "Webhook signing secrets use encrypted exact-replay recovery; owner and project-scoped private credentials remain hash-only.",
          "Owner-key rotation is staged: the previous key remains active until a verified replacement explicitly revokes it.",
          "A lost project-credential response never mints another active credential; the retry names the existing unrecoverable credential for explicit cleanup.",
          "Webhook test delivery identity comes from the stable command, never the transport request id.",
        ],
      },
      {
        id: "onboarding_v3",
        kind: "flow",
        auth: ["none", "api_key", "ci_deploy"],
        endpoints: [
          "/v1/setup/manifest",
          ONBOARDING_SOURCE_SNAPSHOT_PATH,
          "/v1/projects/{project_id}/onboarding",
          "/v1/projects/{project_id}/onboarding/review",
          "/v1/projects/{project_id}/onboarding/proof",
          "/v1/projects/{project_id}/onboarding/verify",
          "/v1/projects/{project_id}/signal-map",
          "/v1/projects/{project_id}/setup",
        ],
        readiness_contract: [
          "Discovery submits one complete source-grounded value-flow plan with no fixed event count or naming convention.",
          "A human approves the exact plan, then live proof checks its events, properties, safe failure, and deploy before status=verified.",
          "Every nonterminal state names one next_action; only verified returns installation_complete=true and next_action=null.",
        ],
      },
      {
        id: "error_monitoring",
        kind: "feature",
        auth: ["api_key"],
        endpoints: [
          "/v1/projects/{project_id}/cases",
          "/v1/cases/{case_id}",
        ],
        combines_with: [
          "deploy_attribution",
          "posthog_source_maps",
          "affected_users",
        ],
        authority:
          "PostHog owns direct exception capture, grouping, issue lifecycle, affected-user impact, and symbolication. Agentry reads bounded issue evidence through the customer's OAuth connection and keeps only its thin agent-control projection.",
      },
      {
        id: "product_analytics",
        kind: "feature",
        auth: ["api_key"],
        endpoints: [
          "/v1/projects/{project_id}/analytics/query",
          "/v1/projects/{project_id}/event-names",
          "/v1/projects/{project_id}/event-property-keys",
        ],
        combines_with: [
          "verified_onboarding",
          "query_blueprints",
          "public_queries",
          "alerts",
        ],
      },
      {
        id: "posthog_resources",
        kind: "read_only_provider_resources",
        auth: ["api_key"],
        discovery: {
          schema: "/v1/openapi.json?flow=posthog",
          tags: ["Session Recordings", "Feature Flags", "Surveys", "Experiments"],
        },
        resources: [
          "session_recordings",
          "feature_flags",
          "surveys",
          "survey_responses",
          "survey_stats",
          "experiments",
        ],
        endpoints: [
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
        ],
        authority:
          "The connected customer PostHog Cloud project remains authoritative. Agentry reads through read-only OAuth, returns a bounded typed projection, and does not retain a provider resource snapshot or raw event stream.",
        invariants: [
          "Session-recording reads expose metadata and player_url only; replay snapshots, DOM content, and video never cross Agentry.",
          "Survey response reads require a caller-supplied window no longer than 90 days and carry explicit redaction metadata.",
          "Experiment reads expose definitions and provider conclusion state, not an experiment-results endpoint or a causal-effect claim.",
          "No endpoint creates, updates, archives, targets, concludes, deletes, or otherwise mutates PostHog resources.",
        ],
      },
      {
        id: "query_blueprints",
        kind: "query_templates",
        auth: ["none", "api_key"],
        endpoints: [
          "/v1/query-blueprints",
          "/v1/query-blueprints/{blueprint_id}",
          "/v1/projects/{project_id}/query-blueprints/{blueprint_id}/run",
        ],
        count: QUERY_BLUEPRINTS.length,
        categories: queryBlueprintCategories,
      },
      {
        id: "automation_workflow_v3",
        kind: "flow",
        auth: ["api_key", "ci_deploy", "automation_runner"],
        discovery: {
          guide: "/v1/docs/automation",
          schema: "/v1/openapi.json?flow=automation",
          components: "/v1/automation-workflow-components",
          contracts: "/v1/automation-workflow-contracts",
        },
        production_boundary: {
          mode: "fail_closed_component_allowlist",
          enabled_components: [
            "trigger.schedule.cron@1.0.0",
            "query.analytics.ordered-funnel-period-compare@1.0.0",
            "agent.funnel-review@1.0.0",
            "effect.report.private@1.0.0",
          ],
          result:
            "One exact schedule-receipt-bound ordered-funnel analysis and private source-hash-bound report.",
          unsupported_policy:
            "Other graphs may compile and save disabled; readiness blocks them until every exact adapter, execution handler, and proof/reconciliation boundary is installed.",
        },
        endpoints: [
          "/v1/automation-workflow-components",
          "/v1/automation-workflow-contracts",
          "/v1/projects/{project_id}/automation-workflows/compile",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}/readiness",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}/enable",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}/pause",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}/trigger-receipts",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs",
          "/v1/projects/{project_id}/automation-workflows/{automation_id}/runs/{run_id}",
          "/v1/projects/{project_id}/automation-workflow-control",
        ],
        invariants: [
          "The runner supplies only trigger_receipt_id; Agentry owns trigger payloads, occurrence times, trust, actors, and clocks.",
          "Every run follows its returned recoverable next_action with exact principal, path, revision, lease fence, timing, effect id, and suspension id.",
          "A replayed effect call-start is reconciliation-only and never authorizes a provider call.",
          "Project/workflow kill switches block new authority but preserve exact settlement and reconciliation for already-started effects.",
          "The minute sweep issues receipts and lifecycle bookkeeping only; it never starts a customer tool or provider effect.",
        ],
      },
      {
        id: "automation_v2",
        kind: "flow",
        auth: ["api_key", "ci_deploy", "automation_runner"],
        discovery: {
          guide: "/v1/docs/automation",
          schema: "/v1/openapi.json?flow=automation",
          templates: "/v1/automation-playbooks",
        },
        endpoints: [
          "/v1/automation-playbooks",
          "/v1/projects/{project_id}/automation-playbooks/{id}/render",
          "/v1/projects/{project_id}/automation-contract",
          "/v1/projects/{project_id}/automation-control",
          "/v1/projects/{project_id}/automation-triggers/issue",
          "/v1/projects/{project_id}/automation-trigger-receipts",
          "/v1/automation-trigger-receipts/{receipt_id}",
          "/v1/cases/{case_id}/claims",
          "/v1/cases/{case_id}",
          "/v1/projects/{project_id}/automation-runs",
          "/v1/automation-runs/{run_id}",
          "/v1/automation-runs/{run_id}/verify",
          "/v1/automation-runs/{run_id}/report-source",
          "/v1/automation-runs/{run_id}/actions/record-report",
          "/v1/automation-runs/{run_id}/cancel",
        ],
        invariants: [
          "Contracts save disabled and owners enable an exact ETag.",
          "A trigger receipt is the runner's pre-claim evidence source. Detailed PostHog-backed case evidence is available only while the exact runner credential holds the current unexpired claim.",
          "Telemetry and runner text have no instruction authority.",
          "Draft PR authority never includes merge, deploy, rollback, or direct push.",
          "Verification is server-owned; zero traffic never proves success.",
          "Scheduled reports use one immutable aggregate source and remain private until a human chooses follow-up.",
        ],
      },
      {
        id: "agent_ops",
        kind: "workflow",
        auth: ["api_key"],
        endpoints: [
          "/v1/projects/{project_id}/next-steps",
          "/v1/projects/{project_id}/health",
          "/v1/audit/recent",
        ],
        combines_with: ["webhooks", "alerts"],
      },
      {
        id: "billing",
        kind: "management",
        auth: ["api_key", "stripe_webhook"],
        endpoints: [
          "/v1/billing/status",
          "/v1/billing/checkout",
          "/v1/billing/portal",
          "/v1/billing/webhook",
        ],
        combines_with: ["automation"],
        agent_behavior:
          "Billing applies only to the hosted Nerve control plane. Customer PostHog events and customer-run inference are never metered. Billing reads are side-effect free; create a Stripe Checkout link only after an owner chooses Nerve and calls POST /v1/billing/checkout with a stable Idempotency-Key.",
      },
    ],
    next_action:
      "Choose the matching flow. For current recording, flag, survey, or experiment state, follow /v1/openapi.json?flow=posthog. For behavioral or effect questions, prove readiness from the signal map, its source_verified receipt, and bounded customer PostHog event/property reads before query blueprints or custom HogQL. For automations, follow /v1/docs/automation and /v1/openapi.json?flow=automation with exact principals and headers.",
  };
}

function buildSetupManifest() {
  return {
    schema_version: 1,
    principle:
      "Customer applications send analytics, exceptions, and source maps directly to PostHog with customer-owned credentials. Agentry credentials are limited to interactive owner operations, trusted deploy evidence, and one exact unattended automation runner.",
    project_setup_endpoint: "/v1/projects/{project_id}/setup",
    credential_boundaries: [
      {
        name: "AGENTRY_CI_API_KEY",
        token_prefix: "agentry_ci_",
        boundary: "trusted_ci",
        required_when:
          "CI records Agentry deploy evidence or provider-observed automation PR proof",
        allowed_operations: [
          "POST /v1/deploys/",
          "POST /v1/automation-runs/:run_id/pr-proof",
        ],
        forbidden_contexts: [
          "browser/client code",
          "app runtime telemetry",
          "automation runner reasoning",
          "owner reads/mutations",
        ],
        browser_safe: false,
        commit_to_git: false,
        source: "POST /v1/projects/:project_id/credentials with kind=ci_deploy",
      },
      {
        name: "AGENTRY_RUNNER_API_KEY",
        token_prefix: "agentry_runner_",
        boundary: "exact_automation_runner",
        required_when:
          "one detected customer-owned scheduler is explicitly approved and enabled for an automation",
        allowed_operations: [
          "only the trigger/claim/run/approval-request scopes returned for one automation_id",
        ],
        forbidden_contexts: [
          "browser/client code",
          "app telemetry",
          "deploy/source-map proof",
          "owner decisions",
          "another automation_id",
        ],
        browser_safe: false,
        commit_to_git: false,
        source:
          "POST /v1/projects/:project_id/credentials with kind=automation_runner and exact automation_id",
      },
      {
        name: "AGENTRY_PRIVATE_API_KEY",
        token_prefix: "agentry_sk_",
        boundary: "human_owner_or_member",
        required_when: "a human or their interactive agent reads/manages Agentry",
        allowed_operations: [
          "project reads and role-authorized human management operations",
        ],
        forbidden_contexts: [
          "browser/client code",
          "ordinary app runtime",
          "routine CI deploy jobs",
          "customer schedulers invoking Codex CLI or Claude Code, GitHub Actions, custom runners, ChatGPT Scheduled tasks, or other unattended runners",
        ],
        browser_safe: false,
        commit_to_git: false,
        source:
          "AGENTRY_PRIVATE_API_KEY or ~/.agentry/credentials.json after `agentry login` completes PostHog authorization",
      },
    ],
    support_env: [
      {
        name: "AGENTRY_URL",
        required: false,
        default: "https://api.agentry.sh",
        used_for: ["self-hosted/local Agentry override"],
      },
      {
        name: "AGENTRY_DEPLOY_SHA",
        required: false,
        used_for: ["deploy attribution when provider SHA vars are unavailable"],
        accepted_aliases: [
          "GITHUB_SHA",
          "COMMIT_REF",
          "VERCEL_GIT_COMMIT_SHA",
          "RENDER_GIT_COMMIT",
          "RAILWAY_GIT_COMMIT_SHA",
          "HEROKU_SLUG_COMMIT",
          "GIT_SHA",
        ],
      },
      {
        name: "AGENTRY_ENVIRONMENT",
        required: false,
        default: "production",
        used_for: ["Agentry deploy evidence environment labels"],
      },
    ],
    posthog_telemetry_boundary: {
      analytics_and_errors: "official PostHog SDKs configured with the customer's PostHog project token",
      source_maps: "official PostHog CLI configured directly against the customer's PostHog Cloud project",
      agentry_access: "read-only PostHog OAuth; its access and refresh tokens remain encrypted in the hosted control plane",
    },
    public_queries: {
      token_prefix: "/v1/public/q/",
      default_agent_behavior:
        "Create a public-query publication only for explicit browser, shareable link, embed, or report follow-up. Default day-to-day reads should use cases, analytics, deploys, query blueprints, and HogQL with the owner API key. Treat the complete unguessable publication URL as the visitor capability; never invent or request a second query-string key.",
    },
    local_state: {
      canonical_server_state: [
        "GET /v1/projects/:project_id/onboarding",
        "GET /v1/projects/:project_id/signal-map",
      ],
      source_snapshot_helper: ONBOARDING_SOURCE_SNAPSHOT_PATH,
      repo_artifact_required: false,
      snapshot_rule:
        "Run the helper before planning and with --final after a clean implementation commit. Submit its small JSON response directly; do not create an Agentry state file in the customer repo.",
      local_only:
        "credentials, one-time proof markers, logs, and temporary helper output",
    },
    next_action:
      "Connect the customer-owned PostHog Cloud project through read-only OAuth, then detect the existing telemetry SDK, PostHog CLI release path, CI deploy boundary, coding-agent harness, scheduler, and secret store before proposing changes.",
  };
}

export function buildOpenApiSchema() {
  const operation = (
    summary: string,
    options: {
      operationId?: string;
      tags?: string[];
      security?: Array<Record<string, string[]>>;
      requestBody?: unknown;
      requestExample?: unknown;
      responses?: Record<string, unknown>;
      parameters?: unknown[];
      description?: string;
      "x-agentry-request-body"?: "none";
    } = {},
  ) => ({
    ...(options.operationId ? { operationId: options.operationId } : {}),
    summary,
    ...(options.description ? { description: options.description } : {}),
    tags: options.tags ?? ["Agentry"],
    ...(options.security ? { security: options.security } : {}),
    ...(options.parameters ? { parameters: options.parameters } : {}),
    ...(options["x-agentry-request-body"]
      ? { "x-agentry-request-body": options["x-agentry-request-body"] }
      : {}),
    ...(options.requestBody
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: options.requestBody,
                examples: {
                  default: {
                    value:
                      options.requestExample ??
                      exampleForSchema(options.requestBody),
                  },
                },
              },
            },
          },
        }
      : {}),
    responses: options.responses ?? {
      "200": jsonResponse(unknownObjectSchema),
      default: errorResponse(),
    },
  });

  const plainText = {
    description: "Plain text response",
    content: { "text/plain": { schema: stringSchema } },
  };
  const markdown = {
    description: "Markdown response",
    content: { "text/markdown": { schema: stringSchema } },
  };
  const anyJson = jsonResponse(unknownObjectSchema);
  const stringArraySchema = arraySchema(stringSchema);
  const nullableStringSchema = { oneOf: [stringSchema, nullSchema] };
  const eventPropertyMapSchema = {
    type: "object",
    additionalProperties: stringArraySchema,
  };
  const setupManifestResponse = objectSchema(
    {
      schema_version: integerSchema,
      principle: stringSchema,
      project_setup_endpoint: stringSchema,
      credential_boundaries: arraySchema(unknownObjectSchema),
      posthog_telemetry_boundary: unknownObjectSchema,
      public_queries: unknownObjectSchema,
      local_state: unknownObjectSchema,
      next_action: stringSchema,
    },
    [
      "schema_version",
      "principle",
      "project_setup_endpoint",
      "credential_boundaries",
      "posthog_telemetry_boundary",
      "local_state",
      "next_action",
    ],
  );
  const setupEnvMatrixItemSchema = objectSchema(
    {
      token_kind: stringSchema,
      env_var: stringSchema,
      required: booleanSchema,
      default: stringSchema,
      secret_level: stringSchema,
      token_prefix: stringSchema,
      allowed_contexts: stringArraySchema,
      commit_to_git: booleanSchema,
      browser_safe: booleanSchema,
      host_or_ci_placement: stringSchema,
      verify_endpoint: stringSchema,
      rotate_endpoint: { oneOf: [stringSchema, nullSchema] },
      notes: stringSchema,
    },
    [
      "token_kind",
      "env_var",
      "required",
      "secret_level",
      "commit_to_git",
      "browser_safe",
    ],
    true,
  );
  const projectSetupResponse = objectSchema(
    {
      schema_version: integerSchema,
      project_id: stringSchema,
      principle: stringSchema,
      posthog_connection: unknownObjectSchema,
      env_matrix: arraySchema(setupEnvMatrixItemSchema),
      public_queries: unknownObjectSchema,
      next_action: stringSchema,
    },
    [
      "schema_version",
      "project_id",
      "principle",
      "posthog_connection",
      "env_matrix",
      "public_queries",
      "next_action",
    ],
  );
  const apiKey = [{ ApiKeyAuth: [] }];
  const admin = [{ AdminTokenAuth: [] }];
  const idParam = (name: string) => ({
    name,
    in: "path",
    required: true,
    schema: stringSchema,
  });
  const queryParam = (
    name: string,
    schema: unknown = stringSchema,
    required = false,
  ) => ({
    name,
    in: "query",
    required,
    schema,
  });
  const posthogResourceIdParam = (name: string) => ({
    name,
    in: "path",
    required: true,
    description:
      "PostHog provider resource identifier. Agentry uses it only for this bounded read.",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
  });
  const posthogPaginationParameters = () => [
    {
      ...queryParam("limit", {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 50,
      }),
      description: "Maximum number of projected provider resources to return.",
    },
    {
      ...queryParam("offset", {
        type: "integer",
        minimum: 0,
        maximum: 1_000_000,
        default: 0,
      }),
      description: "Zero-based provider collection offset.",
    },
  ];
  const okResponse = objectSchema(
    { ok: booleanSchema, id: stringSchema, next_action: stringSchema },
    [],
    true,
  );
  const posthogConnectionViewSchema = objectSchema(
    {
      status: {
        type: "string",
        enum: ["detached", "active", "reauth_required"],
      },
      region: { oneOf: [{ type: "string", enum: ["us", "eu"] }, nullSchema] },
      posthog_host: nullableStringSchema,
      posthog_project_id: { oneOf: [integerSchema, nullSchema] },
      organization_id: nullableStringSchema,
      scopes: stringArraySchema,
      connected_at: { oneOf: [integerSchema, nullSchema] },
      last_verified_at: { oneOf: [integerSchema, nullSchema] },
      capabilities: { oneOf: [unknownObjectSchema, nullSchema] },
      next_action: nullableStringSchema,
    },
    [
      "status",
      "region",
      "posthog_host",
      "posthog_project_id",
      "organization_id",
      "scopes",
      "connected_at",
      "last_verified_at",
      "capabilities",
      "next_action",
    ],
  );
  const posthogConnectionEnvelope = objectSchema(
    { connection: posthogConnectionViewSchema },
    ["connection"],
  );
  const posthogNullableTextSchema = (maxLength: number) => ({
    oneOf: [{ type: "string", maxLength }, nullSchema],
  });
  const posthogNullableNumberSchema = { oneOf: [numberSchema, nullSchema] };
  const posthogNullableBooleanSchema = { oneOf: [booleanSchema, nullSchema] };
  const posthogIdentifierSchema = {
    oneOf: [
      integerSchema,
      { type: "string", minLength: 1, maxLength: 200 },
    ],
  };
  const posthogNullableIdentifierSchema = {
    oneOf: [integerSchema, { type: "string", maxLength: 200 }, nullSchema],
  };
  const posthogResourcePageSchema = objectSchema(
    {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
      has_more: booleanSchema,
      next_offset: {
        oneOf: [
          { type: "integer", minimum: 0, maximum: 1_000_000 },
          nullSchema,
        ],
      },
    },
    ["limit", "offset", "has_more", "next_offset"],
  );
  const posthogResourceFreshnessSchema = objectSchema(
    {
      source: { type: "string", const: "customer_posthog_cloud_api" },
      consistency: { type: "string", const: "provider_read" },
      queried_at: { type: "string", format: "date-time", maxLength: 100 },
      status: { type: "string", const: "complete_for_query_time" },
    },
    ["source", "consistency", "queried_at", "status"],
  );
  const posthogResourceDataBoundarySchema = objectSchema(
    {
      upstream_source: { type: "string", const: "customer_posthog_cloud" },
      raw_event_stream_retained: { type: "boolean", const: false },
      resource_snapshot_retained: { type: "boolean", const: false },
      session_recording_content_returned: { type: "boolean", const: false },
      provider_mutations_authorized: { type: "boolean", const: false },
    },
    [
      "upstream_source",
      "raw_event_stream_retained",
      "resource_snapshot_retained",
      "session_recording_content_returned",
      "provider_mutations_authorized",
    ],
  );
  const posthogBoundedValueSchema = {
    oneOf: [
      nullSchema,
      booleanSchema,
      numberSchema,
      { type: "string", maxLength: 500 },
      {
        type: "array",
        maxItems: 50,
        items: { $ref: "#/components/schemas/PosthogBoundedValue" },
      },
      {
        type: "object",
        maxProperties: 50,
        propertyNames: { type: "string", maxLength: 100 },
        additionalProperties: { $ref: "#/components/schemas/PosthogBoundedValue" },
      },
    ],
    description:
      "Provider aggregate value bounded to four nesting levels, 50 entries per collection, 100-character keys, and 500-character strings.",
  };
  const posthogFlagVariantSchema = objectSchema(
    {
      key: posthogNullableTextSchema(200),
      name: posthogNullableTextSchema(400),
      rollout_percentage: posthogNullableNumberSchema,
    },
    ["key", "name", "rollout_percentage"],
  );
  const posthogSessionRecordingSchema = objectSchema(
    {
      id: { type: "string", minLength: 1, maxLength: 200 },
      distinct_id: {
        ...posthogNullableTextSchema(400),
        description: "Redacted, bounded actor identifier.",
      },
      viewed: posthogNullableBooleanSchema,
      recording_duration_seconds: posthogNullableNumberSchema,
      active_seconds: posthogNullableNumberSchema,
      inactive_seconds: posthogNullableNumberSchema,
      start_time: posthogNullableTextSchema(100),
      end_time: posthogNullableTextSchema(100),
      click_count: posthogNullableNumberSchema,
      keypress_count: posthogNullableNumberSchema,
      mouse_activity_count: posthogNullableNumberSchema,
      console_log_count: posthogNullableNumberSchema,
      console_warn_count: posthogNullableNumberSchema,
      console_error_count: posthogNullableNumberSchema,
      start_url: {
        ...posthogNullableTextSchema(2_000),
        description: "URL without credentials, query, or fragment.",
      },
      retention_period_days: posthogNullableNumberSchema,
      expiry_time: posthogNullableTextSchema(100),
      snapshot_source: posthogNullableTextSchema(100),
      snapshot_library: posthogNullableTextSchema(100),
      ongoing: posthogNullableBooleanSchema,
      activity_score: posthogNullableNumberSchema,
      has_summary: posthogNullableBooleanSchema,
      player_url: { type: "string", format: "uri", maxLength: 3_000 },
    },
    [
      "id",
      "distinct_id",
      "viewed",
      "recording_duration_seconds",
      "active_seconds",
      "inactive_seconds",
      "start_time",
      "end_time",
      "click_count",
      "keypress_count",
      "mouse_activity_count",
      "console_log_count",
      "console_warn_count",
      "console_error_count",
      "start_url",
      "retention_period_days",
      "expiry_time",
      "snapshot_source",
      "snapshot_library",
      "ongoing",
      "activity_score",
      "has_summary",
      "player_url",
    ],
  );
  const posthogFeatureFlagSchema = objectSchema(
    {
      id: posthogIdentifierSchema,
      key: { type: "string", minLength: 1, maxLength: 400 },
      description: posthogNullableTextSchema(2_000),
      active: posthogNullableBooleanSchema,
      archived: posthogNullableBooleanSchema,
      deleted: posthogNullableBooleanSchema,
      status: posthogNullableTextSchema(100),
      created_at: posthogNullableTextSchema(100),
      updated_at: posthogNullableTextSchema(100),
      last_called_at: posthogNullableTextSchema(100),
      evaluation_runtime: posthogNullableTextSchema(100),
      bucketing_identifier: posthogNullableTextSchema(100),
      ensure_experience_continuity: posthogNullableBooleanSchema,
      has_encrypted_payloads: posthogNullableBooleanSchema,
      tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } },
      targeting_groups: {
        type: "array",
        maxItems: 20,
        items: objectSchema(
          {
            rollout_percentage: posthogNullableNumberSchema,
            variant: posthogNullableTextSchema(200),
            conditions: {
              type: "array",
              maxItems: 50,
              items: objectSchema(
                {
                  key: {
                    oneOf: [{ type: "string", maxLength: 400 }, nullSchema],
                  },
                  type: {
                    oneOf: [{ type: "string", maxLength: 100 }, nullSchema],
                  },
                  operator: {
                    oneOf: [{ type: "string", maxLength: 100 }, nullSchema],
                  },
                  value: {
                    oneOf: [
                      { type: "string", maxLength: 500 },
                      numberSchema,
                      booleanSchema,
                      {
                        type: "array",
                        maxItems: 20,
                        items: {
                          oneOf: [
                            { type: "string", maxLength: 200 },
                            numberSchema,
                            booleanSchema,
                          ],
                        },
                      },
                      nullSchema,
                    ],
                  },
                },
                ["key", "type", "operator", "value"],
              ),
            },
          },
          ["rollout_percentage", "variant", "conditions"],
        ),
      },
      variants: {
        type: "array",
        maxItems: 20,
        items: { $ref: "#/components/schemas/PosthogFlagVariant" },
      },
      experiment_ids: { type: "array", maxItems: 100, items: integerSchema },
    },
    [
      "id",
      "key",
      "description",
      "active",
      "archived",
      "deleted",
      "status",
      "created_at",
      "updated_at",
      "last_called_at",
      "evaluation_runtime",
      "bucketing_identifier",
      "ensure_experience_continuity",
      "has_encrypted_payloads",
      "tags",
      "targeting_groups",
      "variants",
      "experiment_ids",
    ],
  );
  const posthogSurveyQuestionSchema = objectSchema(
    {
      id: posthogNullableTextSchema(200),
      type: posthogNullableTextSchema(100),
      question: posthogNullableTextSchema(1_000),
      description: posthogNullableTextSchema(1_000),
      optional: posthogNullableBooleanSchema,
      choices: {
        type: "array",
        maxItems: 100,
        items: { type: "string", maxLength: 500 },
      },
      scale: posthogNullableNumberSchema,
      lower_bound_label: posthogNullableTextSchema(500),
      upper_bound_label: posthogNullableTextSchema(500),
      is_nps_question: posthogNullableBooleanSchema,
    },
    [
      "id",
      "type",
      "question",
      "description",
      "optional",
      "choices",
      "scale",
      "lower_bound_label",
      "upper_bound_label",
      "is_nps_question",
    ],
  );
  const posthogSurveySchema = objectSchema(
    {
      id: { type: "string", minLength: 1, maxLength: 200 },
      name: { type: "string", minLength: 1, maxLength: 400 },
      description: posthogNullableTextSchema(2_000),
      type: posthogNullableTextSchema(100),
      schedule: posthogNullableTextSchema(100),
      archived: posthogNullableBooleanSchema,
      start_date: posthogNullableTextSchema(100),
      end_date: posthogNullableTextSchema(100),
      created_at: posthogNullableTextSchema(100),
      responses_limit: posthogNullableNumberSchema,
      iteration_count: posthogNullableNumberSchema,
      iteration_frequency_days: posthogNullableNumberSchema,
      current_iteration: posthogNullableNumberSchema,
      enable_partial_responses: posthogNullableBooleanSchema,
      base_language: posthogNullableTextSchema(20),
      linked_feature_flag: {
        oneOf: [
          objectSchema(
            { id: posthogNullableIdentifierSchema, key: posthogNullableTextSchema(400) },
            ["id", "key"],
          ),
          nullSchema,
        ],
      },
      questions: {
        type: "array",
        maxItems: 100,
        items: { $ref: "#/components/schemas/PosthogSurveyQuestion" },
      },
    },
    [
      "id",
      "name",
      "description",
      "type",
      "schedule",
      "archived",
      "start_date",
      "end_date",
      "created_at",
      "responses_limit",
      "iteration_count",
      "iteration_frequency_days",
      "current_iteration",
      "enable_partial_responses",
      "base_language",
      "linked_feature_flag",
      "questions",
    ],
  );
  const posthogSurveyAnswerSchema = {
    oneOf: [
      { type: "string", maxLength: 2_000 },
      { type: "array", maxItems: 50, items: { type: "string", maxLength: 500 } },
      numberSchema,
      booleanSchema,
      nullSchema,
    ],
  };
  const posthogSurveyResponseSchema = objectSchema(
    {
      id: { type: "string", minLength: 1, maxLength: 200 },
      distinct_id: posthogNullableTextSchema(400),
      session_id: posthogNullableTextSchema(400),
      submitted_at: posthogNullableTextSchema(100),
      answers: {
        type: "array",
        maxItems: 100,
        items: objectSchema(
          {
            question_id: posthogNullableTextSchema(200),
            question_index: posthogNullableNumberSchema,
            question_text: posthogNullableTextSchema(1_000),
            question_type: posthogNullableTextSchema(100),
            answer: { $ref: "#/components/schemas/PosthogSurveyAnswer" },
          },
          ["question_id", "question_index", "question_text", "question_type", "answer"],
        ),
      },
      context: {
        oneOf: [
          objectSchema(
            {
              device_type: posthogNullableTextSchema(100),
              browser: posthogNullableTextSchema(100),
              os: posthogNullableTextSchema(100),
              country_code: posthogNullableTextSchema(10),
              country_name: posthogNullableTextSchema(100),
              current_url: posthogNullableTextSchema(2_000),
              iteration: posthogNullableTextSchema(100),
            },
            [
              "device_type",
              "browser",
              "os",
              "country_code",
              "country_name",
              "current_url",
              "iteration",
            ],
          ),
          nullSchema,
        ],
      },
    },
    ["id", "distinct_id", "session_id", "submitted_at", "answers", "context"],
  );
  const posthogSurveyStatsSchema = objectSchema(
    {
      survey_id: { type: "string", minLength: 1, maxLength: 200 },
      start_date: posthogNullableTextSchema(100),
      end_date: posthogNullableTextSchema(100),
      event_counts: { $ref: "#/components/schemas/PosthogBoundedValue" },
      rates: { $ref: "#/components/schemas/PosthogBoundedValue" },
      per_question_stats: {
        type: "array",
        maxItems: 100,
        items: { $ref: "#/components/schemas/PosthogBoundedValue" },
      },
    },
    ["survey_id", "start_date", "end_date", "event_counts", "rates", "per_question_stats"],
  );
  const posthogExperimentMetricSchema = objectSchema(
    {
      uuid: posthogNullableTextSchema(200),
      name: posthogNullableTextSchema(400),
      kind: posthogNullableTextSchema(100),
      metric_type: posthogNullableTextSchema(100),
      event_names: {
        type: "array",
        maxItems: 50,
        items: { type: "string", maxLength: 400 },
      },
    },
    ["uuid", "name", "kind", "metric_type", "event_names"],
  );
  const posthogExperimentSchema = objectSchema(
    {
      id: posthogIdentifierSchema,
      name: { type: "string", minLength: 1, maxLength: 400 },
      description: posthogNullableTextSchema(3_000),
      type: posthogNullableTextSchema(100),
      status: posthogNullableTextSchema(100),
      archived: posthogNullableBooleanSchema,
      deleted: posthogNullableBooleanSchema,
      start_date: posthogNullableTextSchema(100),
      end_date: posthogNullableTextSchema(100),
      created_at: posthogNullableTextSchema(100),
      updated_at: posthogNullableTextSchema(100),
      feature_flag: objectSchema(
        {
          id: posthogNullableIdentifierSchema,
          key: posthogNullableTextSchema(400),
          active: posthogNullableBooleanSchema,
          variants: {
            type: "array",
            maxItems: 20,
            items: { $ref: "#/components/schemas/PosthogFlagVariant" },
          },
        },
        ["id", "key", "active", "variants"],
      ),
      conclusion: posthogNullableTextSchema(100),
      conclusion_comment: posthogNullableTextSchema(2_000),
      is_legacy: posthogNullableBooleanSchema,
      excluded_variants: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 200 },
      },
      primary_metrics: {
        type: "array",
        maxItems: 50,
        items: { $ref: "#/components/schemas/PosthogExperimentMetric" },
      },
      secondary_metrics: {
        type: "array",
        maxItems: 50,
        items: { $ref: "#/components/schemas/PosthogExperimentMetric" },
      },
      saved_metric_count: { type: "integer", minimum: 0, maximum: 100 },
    },
    [
      "id",
      "name",
      "description",
      "type",
      "status",
      "archived",
      "deleted",
      "start_date",
      "end_date",
      "created_at",
      "updated_at",
      "feature_flag",
      "conclusion",
      "conclusion_comment",
      "is_legacy",
      "excluded_variants",
      "primary_metrics",
      "secondary_metrics",
      "saved_metric_count",
    ],
  );
  const posthogResourceEnvelopeProperties = {
    freshness: { $ref: "#/components/schemas/PosthogResourceFreshness" },
    data_boundary: { $ref: "#/components/schemas/PosthogResourceDataBoundary" },
    next_action: { type: "string", minLength: 1, maxLength: 3_000 },
  };
  const posthogListResponseSchema = (name: string, itemSchemaRef: string) => objectSchema(
    {
      [name]: { type: "array", maxItems: 100, items: { $ref: itemSchemaRef } },
      page: { $ref: "#/components/schemas/PosthogResourcePage" },
      ...posthogResourceEnvelopeProperties,
    },
    [name, "page", "freshness", "data_boundary", "next_action"],
  );
  const posthogDetailResponseSchema = (name: string, itemSchemaRef: string) => objectSchema(
    {
      [name]: { $ref: itemSchemaRef },
      ...posthogResourceEnvelopeProperties,
    },
    [name, "freshness", "data_boundary", "next_action"],
  );
  const posthogSurveyResponsesResponseSchema = objectSchema(
    {
      responses: {
        type: "array",
        maxItems: 100,
        items: { $ref: "#/components/schemas/PosthogSurveySubmission" },
      },
      page: { $ref: "#/components/schemas/PosthogResourcePage" },
      ...posthogResourceEnvelopeProperties,
      redaction: objectSchema(
        {
          free_text_max_characters: { type: "integer", const: 2_000 },
          email_addresses_redacted: { type: "boolean", const: true },
          secret_like_values_redacted: { type: "boolean", const: true },
        },
        [
          "free_text_max_characters",
          "email_addresses_redacted",
          "secret_like_values_redacted",
        ],
      ),
    },
    ["responses", "page", "freshness", "data_boundary", "redaction", "next_action"],
  );
  const affectedUserSchema = objectSchema({
    user_id: stringSchema,
    error_count: integerSchema,
    last_seen_at: integerSchema,
  });
  const caseUsersResponse = objectSchema(
    {
      data_boundary: unknownObjectSchema,
      case_id: stringSchema,
      affected_user_count: integerSchema,
      sampled_event_count: integerSchema,
      sample_has_more: booleanSchema,
      users: arraySchema(affectedUserSchema),
      next_action: stringSchema,
    },
    [
      "data_boundary",
      "case_id",
      "affected_user_count",
      "sampled_event_count",
      "sample_has_more",
      "users",
      "next_action",
    ],
  );
  const projectUsersResponse = objectSchema(
    {
      data_boundary: unknownObjectSchema,
      project_id: stringSchema,
      window_days: integerSchema,
      returned_users: integerSchema,
      users: arraySchema(affectedUserSchema),
      next_action: stringSchema,
    },
    ["data_boundary", "project_id", "window_days", "returned_users", "users", "next_action"],
  );
  const billingStatusResponse = objectSchema(
    {
      user_id: stringSchema,
      plan: { type: "string", enum: ["free", "nerve"] },
      plan_name: stringSchema,
      price_cents: integerSchema,
      continuous_automation_enabled: booleanSchema,
      evidence_retention_days: integerSchema,
      billing: unknownObjectSchema,
      upgrade: unknownObjectSchema,
      next_action: stringSchema,
    },
    ["user_id", "plan", "billing", "upgrade", "continuous_automation_enabled"],
  );
  const billingCheckoutResponse = objectSchema(
    {
      command_id: stringSchema,
      checkout_url: stringSchema,
      session_id: stringSchema,
      customer_id: stringSchema,
      subscription_id: { oneOf: [stringSchema, nullSchema] },
      plan: { type: "string", enum: ["nerve"] },
      price_id: stringSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["command_id", "checkout_url", "session_id", "customer_id", "plan", "price_id", "idempotent_replay"],
  );
  const billingPortalResponse = objectSchema(
    {
      command_id: stringSchema,
      url: stringSchema,
      session_id: stringSchema,
      customer_id: stringSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["command_id", "url", "session_id", "customer_id", "idempotent_replay"],
  );
  const billingWebhookResponse = objectSchema(
    {
      received: booleanSchema,
      event_id: { oneOf: [stringSchema, nullSchema] },
      event_type: { oneOf: [stringSchema, nullSchema] },
      handled: booleanSchema,
      applied: booleanSchema,
      delivery_status: {
        type: "string",
        enum: ["applied", "stale", "ambiguous_order", "account_deletion_fenced", "unmatched", "unhandled"],
      },
      idempotent_replay: booleanSchema,
      user_id: { oneOf: [stringSchema, nullSchema] },
      plan: { oneOf: [stringSchema, nullSchema] },
      billing_status: { oneOf: [stringSchema, nullSchema] },
      next_action: stringSchema,
    },
    ["received", "handled", "applied", "delivery_status", "idempotent_replay"],
  );
  const customerDataFilterSchema = objectSchema(
    {
      hogql_where: stringSchema,
      next_action: stringSchema,
    },
    ["hogql_where"],
    true,
  );
  const analyticsQueryCustomerDataFilterSchema = objectSchema(
    {
      applied: booleanSchema,
      include_synthetic: booleanSchema,
      mode: {
        type: "string",
        enum: [
          "server_enforced",
          "disabled_by_request",
          "no_events_table_reference",
        ],
      },
      hogql_where: stringSchema,
      next_action: stringSchema,
    },
    ["applied", "include_synthetic", "mode", "hogql_where"],
    true,
  );
  const nextStepSchema = objectSchema(
    {
      id: stringSchema,
      title: stringSchema,
      description: stringSchema,
      prompt_template: stringSchema,
      uses: stringArraySchema,
      estimated_seconds: integerSchema,
      requires: stringArraySchema,
      status: {
        type: "string",
        enum: ["available", "preview", "coming_soon"],
      },
    },
    [
      "id",
      "title",
      "description",
      "prompt_template",
      "uses",
      "estimated_seconds",
      "requires",
    ],
    true,
  );
  const sourceSnapshotSchema = objectSchema(
    {
      git_head_sha: {
        oneOf: [
          { type: "string", pattern: "^[a-f0-9]{7,64}$" },
          nullSchema,
        ],
      },
      source_fingerprint_sha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
      },
      source_fingerprint_algorithm: {
        type: "string",
        enum: ["agentry-source-tree-sha256-v1"],
      },
    },
    [
      "git_head_sha",
      "source_fingerprint_sha256",
      "source_fingerprint_algorithm",
    ],
  );
  const issuedRepoSnapshotSchema = objectSchema(
    {
      ...sourceSnapshotSchema.properties,
      discovery_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    [
      "git_head_sha",
      "source_fingerprint_sha256",
      "source_fingerprint_algorithm",
      "discovery_sha256",
    ],
  );
  const nextStepsResponse = objectSchema(
    {
      project_state: objectSchema(
        {
          signal_types: stringArraySchema,
          analytics_scope: booleanSchema,
          errors_scope: booleanSchema,
          deploys_scope: booleanSchema,
          analytics_configured: booleanSchema,
          has_events: booleanSchema,
          has_cases: booleanSchema,
          has_deploys: booleanSchema,
          install_verified: booleanSchema,
          minimum_install_complete: booleanSchema,
          readiness_complete: booleanSchema,
          answer_ready: booleanSchema,
          readiness_gaps_count: integerSchema,
          pending_real_data_count: integerSchema,
        },
        [],
        true,
      ),
      count: integerSchema,
      suggestions: arraySchema(nextStepSchema),
      next_action: stringSchema,
    },
    ["project_state", "count", "suggestions"],
  );
  const projectHealthResponse = objectSchema(
    {
      project_id: stringSchema,
      status: { type: "string", enum: ["healthy", "degraded", "blocked"] },
      posthog: unknownObjectSchema,
      case_projection: unknownObjectSchema,
      deploy_control: unknownObjectSchema,
      webhooks: arraySchema(unknownObjectSchema),
      next_action: stringSchema,
    },
    [
      "project_id",
      "status",
      "posthog",
      "case_projection",
      "deploy_control",
      "webhooks",
      "next_action",
    ],
  );
  const auditRecentResponse = objectSchema(
    {
      hours: numberSchema,
      since: integerSchema,
      count: integerSchema,
      actions: arraySchema(
        objectSchema(
          {
            id: stringSchema,
            at: integerSchema,
            action: stringSchema,
            resource_type: stringSchema,
            resource_id: { oneOf: [stringSchema, nullSchema] },
            project_id: { oneOf: [stringSchema, nullSchema] },
            summary: { oneOf: [stringSchema, nullSchema] },
            ip: { oneOf: [stringSchema, nullSchema] },
            ua: { oneOf: [stringSchema, nullSchema] },
            metadata: unknownObjectSchema,
          },
          [],
          true,
        ),
      ),
      next_action: stringSchema,
    },
    ["hours", "since", "count", "actions"],
  );
  const feedbackResponse = objectSchema(
    {
      id: stringSchema,
      received_at: integerSchema,
      fingerprint: { oneOf: [stringSchema, nullSchema] },
      deduped: booleanSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["id", "received_at", "idempotent_replay"],
  );
  const feedbackListResponse = objectSchema(
    {
      count: integerSchema,
      feedback: arraySchema(unknownObjectSchema),
      next_action: stringSchema,
    },
    ["count", "feedback"],
  );
  const webhookResponse = objectSchema(
    {
      id: stringSchema,
      url: stringSchema,
      events: arraySchema(stringSchema),
      signing_secret: stringSchema,
      signing_secret_prefix: stringSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["id", "url", "events", "signing_secret", "signing_secret_prefix", "idempotent_replay"],
  );
  const webhooksListResponse = objectSchema(
    {
      webhooks: arraySchema(unknownObjectSchema),
      next_action: stringSchema,
    },
    ["webhooks"],
  );
  const alertResponse = objectSchema(
    {
      id: stringSchema,
      name: stringSchema,
      blueprint_id: stringSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["id", "name", "blueprint_id", "idempotent_replay"],
    true,
  );
  const alertsListResponse = objectSchema(
    {
      alerts: arraySchema(unknownObjectSchema),
      next_action: stringSchema,
    },
    ["alerts"],
  );
  const alertEvaluationResponse = objectSchema(
    {
      alert_id: stringSchema,
      blueprint_id: stringSchema,
      evaluated_at: integerSchema,
      triggered: booleanSchema,
      current_value: {
        oneOf: [numberSchema, stringSchema, nullSchema],
      },
      threshold: unknownObjectSchema,
      transition_event: { oneOf: [stringSchema, nullSchema] },
      rows_count: integerSchema,
      next_action: stringSchema,
    },
    ["alert_id", "blueprint_id", "triggered", "current_value", "rows_count"],
    true,
  );
  const publicationResponse = objectSchema(
    {
      id: stringSchema,
      project_id: stringSchema,
      blueprint_id: stringSchema,
      params: unknownObjectSchema,
      description: { oneOf: [stringSchema, nullSchema] },
      publication_safety: unknownObjectSchema,
      public_url: stringSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["id", "project_id", "blueprint_id", "public_url", "idempotent_replay"],
  );
  const publicationsListResponse = objectSchema(
    {
      project_id: stringSchema,
      count: integerSchema,
      publications: arraySchema(unknownObjectSchema),
      next_action: stringSchema,
    },
    ["project_id", "publications"],
  );
  const publicationRevokeResponse = objectSchema(
    {
      id: stringSchema,
      revoked: booleanSchema,
      revoked_at: integerSchema,
      idempotent_replay: booleanSchema,
      next_action: stringSchema,
    },
    ["id", "revoked", "revoked_at", "idempotent_replay"],
  );
  const queryBlueprintParamSchema = objectSchema(
    {
      name: stringSchema,
      type: { type: "string", enum: ["string", "number"] },
      description: stringSchema,
      default: { oneOf: [stringSchema, numberSchema] },
      required: booleanSchema,
    },
    ["name", "type", "description"],
    true,
  );
  const renderHintSchema = objectSchema(
    {
      type: {
        type: "string",
        enum: ["table", "line", "bar", "funnel", "scalar", "stacked_bar"],
      },
      x: stringSchema,
      y: stringSchema,
      stages: arraySchema(stringSchema),
      title: stringSchema,
      notes: arraySchema(stringSchema),
    },
    ["type", "title"],
    true,
  );
  const parameterizedRequiredEventPropertySchema = objectSchema(
    {
      event_param: stringSchema,
      property_param: stringSchema,
      check_endpoint: stringSchema,
      description: stringSchema,
    },
    ["event_param", "property_param", "check_endpoint", "description"],
    true,
  );
  const queryBlueprintSchema = objectSchema(
    {
      id: stringSchema,
      kind: { type: "string", enum: ["query_blueprint"] },
      title: stringSchema,
      description: stringSchema,
      category: stringSchema,
      backend: { type: "string", enum: ["analytics", "operational"] },
      params: arraySchema(queryBlueprintParamSchema),
      query: stringSchema,
      expected_columns: arraySchema(stringSchema),
      render_hint: renderHintSchema,
      example_user_question: stringSchema,
      example_params: unknownObjectSchema,
      recommended_segment_properties: arraySchema(stringSchema),
      required_event_properties: unknownObjectSchema,
      parameterized_required_event_properties: arraySchema(
        parameterizedRequiredEventPropertySchema,
      ),
      endpoints: unknownObjectSchema,
      publishable: booleanSchema,
      next_action: stringSchema,
    },
    [
      "id",
      "kind",
      "title",
      "description",
      "category",
      "publishable",
    ],
    true,
  );
  const queryBlueprintListResponse = objectSchema(
    {
      count: integerSchema,
      categories: arraySchema(stringSchema),
      kind: { type: "string", enum: ["query_blueprints"] },
      blueprints: arraySchema(queryBlueprintSchema),
      next_action: stringSchema,
    },
    ["count", "categories", "blueprints"],
  );
  const ownerKeyMetadata = objectSchema(
    {
      id: stringSchema,
      prefix: stringSchema,
      name: nullableStringSchema,
      created_at: integerSchema,
      last_used_at: { oneOf: [integerSchema, nullSchema] },
      revoked_at: { oneOf: [integerSchema, nullSchema] },
      active: booleanSchema,
      current: booleanSchema,
    },
    [
      "id",
      "prefix",
      "name",
      "created_at",
      "last_used_at",
      "revoked_at",
      "active",
      "current",
    ],
  );
  const capabilitiesResponse = objectSchema(
    {
      schema_version: integerSchema,
      generated_at: stringSchema,
      principle: stringSchema,
      discovery: unknownObjectSchema,
      auth_types: unknownObjectSchema,
      surfaces: unknownObjectSchema,
      capabilities: arraySchema(unknownObjectSchema),
      next_action: stringSchema,
    },
    ["schema_version", "surfaces", "capabilities"],
  );
  const featurePaths = {
    "/": {
      get: operation("Get service metadata", {
        tags: ["Discovery"],
        responses: {
          "200": jsonResponse(
            objectSchema(
              {
                name: stringSchema,
                repository: stringSchema,
                docs: stringSchema,
                install_docs: stringSchema,
                reference_docs: stringSchema,
                api_schema: stringSchema,
                automation_docs: stringSchema,
                automation_flow: stringSchema,
                posthog_flow: stringSchema,
                automation_playbooks: stringSchema,
                capabilities: stringSchema,
                setup_manifest: stringSchema,
                quick_start: arraySchema(
                  objectSchema(
                    {
                      when: stringSchema,
                      action: stringSchema,
                      urls: arraySchema(stringSchema),
                    },
                    ["when", "action", "urls"],
                  ),
                ),
                mental_model: unknownObjectSchema,
                proof_contract: objectSchema(
                  {
                    install: stringSchema,
                    answering: stringSchema,
                  },
                  ["install", "answering"],
                ),
                signal_map: stringSchema,
                skill: stringSchema,
                response_shapes: unknownObjectSchema,
                next_action: stringSchema,
              },
              ["name", "docs", "api_schema"],
            ),
          ),
        },
      }),
    },
    "/v1/capabilities": {
      get: operation("Get agent capability manifest", {
        tags: ["Discovery"],
        description:
          "Agent-readable manifest of Agentry's composable product features: endpoint groups, the source-verified signal-map readiness contract, query blueprints, auth types, and what to call next.",
        responses: { "200": jsonResponse(capabilitiesResponse) },
      }),
    },
    "/v1/setup/manifest": {
      get: operation("Get env and setup manifest", {
        tags: ["Install"],
        description:
          "Machine-readable setup guidance for agents: direct customer PostHog SDK/CLI telemetry, read-only OAuth, CI deploy evidence, explicitly enabled automation runners, owner access, and canonical local/control-plane state.",
        responses: { "200": jsonResponse(setupManifestResponse) },
      }),
    },
    "/adapters": {
      get: operation("List cross-platform install adapters", {
        tags: ["Discovery"],
        responses: { "200": anyJson },
      }),
    },
    "/adapters/AGENTS.md": {
      get: operation("AGENTS.md install adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/cursor.mdc": {
      get: operation("Cursor rule install adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/copilot-instructions.md": {
      get: operation("GitHub Copilot repository instructions adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/agentry.instructions.md": {
      get: operation("VS Code and Visual Studio targeted instructions adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/windsurf.md": {
      get: operation("Windsurf or Devin Desktop workspace rule adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/windsurfrules": {
      get: operation("Windsurf rules install adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/cline.md": {
      get: operation("Cline workspace rule adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/roo.md": {
      get: operation("Roo Code workspace rule adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/continue.md": {
      get: operation("Continue rule adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/zed.rules": {
      get: operation("Zed project rule adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/GEMINI.md": {
      get: operation("Gemini CLI context adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/aider-conventions.md": {
      get: operation("Aider conventions adapter", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/adapters/claude-plugin.json": {
      get: operation("Claude Code plugin manifest", {
        tags: ["Discovery"],
        responses: { "200": anyJson },
      }),
    },
    "/v1/docs/query": {
      get: operation("Get HogQL/query docs", {
        tags: ["Discovery"],
        responses: { "200": markdown },
      }),
    },
    "/v1/docs/automation": {
      get: operation("Get the concise automation v2 guide", {
        operationId: "get_automation_docs",
        tags: ["Discovery"],
        description:
          "Human-readable safety and workflow companion to the authoritative /v1/openapi.json?flow=automation machine contract.",
        responses: { "200": markdown },
      }),
    },
    "/v1/privacy/disclosure": {
      get: operation("Get privacy disclosure clause", {
        tags: ["Discovery"],
        parameters: [
          queryParam("variant"),
          queryParam("errors", booleanSchema),
          queryParam("analytics", booleanSchema),
        ],
        responses: {
          "200": jsonResponse(
            objectSchema(
              {
                canonical_url: stringSchema,
                variant: { type: "string", enum: ["client", "server"] },
                last_updated: stringSchema,
                data_residency: unknownObjectSchema,
                includes: unknownObjectSchema,
                paste_ready_markdown: stringSchema,
                learn_more: stringSchema,
              },
              [],
              true,
            ),
          ),
        },
      }),
    },
    "/v1/auth/self_delete": {
      post: operation("Delete authenticated user account", {
        operationId: "self_delete_account",
        description:
          "Requires confirm=DELETE_AGENTRY_ACCOUNT and a stable Idempotency-Key. Before admission it rejects active or unresolved Stripe billing; the same transaction installs an account checkout fence. Finalization removes Agentry-owned account/project state and detaches or best-effort revokes local PostHog OAuth connections. It never deletes or mutates customer-owned PostHog data. It returns 202 while bounded local cleanup is active and 409 when billing remediation is required. Its surviving hash-only tombstone lets an exact retry recover only the terminal manifest after account authority is revoked.",
        tags: ["Auth"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/idempotencyKey" }],
        requestBody: objectSchema({
          confirm: {
            type: "string",
            enum: ["DELETE_AGENTRY_ACCOUNT"],
            description:
              "Acknowledges deletion of Agentry-owned account and project state. Customer-owned PostHog data is untouched.",
          },
        }, ["confirm"]),
        responses: {
          "200": jsonResponse(
            objectSchema(
              {
                status: { type: "string", enum: ["deleted"] },
                command_id: stringSchema,
                user_id: stringSchema,
                cascaded: unknownObjectSchema,
                cleanup: objectSchema({
                  automation_deletion_manifest: {
                    $ref: "#/components/schemas/AutomationDeletionManifest",
                  },
                }, ["automation_deletion_manifest"], true),
                idempotent_replay: booleanSchema,
                receipt_recovery: unknownObjectSchema,
                note: stringSchema,
                next_action: stringSchema,
              },
              ["status", "command_id", "user_id", "cascaded", "cleanup"],
            ),
          ),
          "202": {
            ...jsonResponse(
              objectSchema(
                {
                  status: { type: "string", enum: ["in_progress"] },
                  command_id: stringSchema,
                  user_id: stringSchema,
                  cascaded: unknownObjectSchema,
                  cleanup: objectSchema({
                    automation_deletion_manifest: {
                      $ref: "#/components/schemas/AutomationDeletionManifest",
                    },
                  }, ["automation_deletion_manifest"], true),
                  next_action: stringSchema,
                },
                ["status", "command_id", "user_id", "cleanup", "next_action"],
                true,
              ),
              "Bounded Agentry-owned cleanup remains active; retry at retry_after_seconds with the same key and credential. Customer-owned PostHog data remains untouched",
            ),
            headers: {
              "Retry-After": {
                description: "Integer seconds from the authoritative DB clock until this exact deletion command should be retried.",
                schema: { type: "integer", minimum: 1 },
              },
            },
          },
          "409": errorResponse(
            "Deletion was not admitted or cannot finalize because a billing mutation is unresolved or Stripe billing can still charge; follow error.details.billing.next_action, then retry with the same deletion key",
          ),
          "428": errorResponse("Stable Idempotency-Key required after confirmation validates"),
          default: errorResponse(),
        },
      }),
    },
    "/v1/integrations/posthog/oauth/client": {
      get: operation("Read Agentry's PostHog OAuth client metadata", {
        operationId: "get_posthog_oauth_client",
        tags: ["PostHog Connection"],
        description:
          "Public RFC 7591-compatible client metadata for the fixed Agentry PostHog Cloud OAuth integration. It grants no authority and contains no customer secret.",
        responses: {
          "200": jsonResponse(objectSchema(
            {
              client_id: stringSchema,
              client_name: stringSchema,
              client_uri: stringSchema,
              application_type: { type: "string", enum: ["web"] },
              redirect_uris: stringArraySchema,
              token_endpoint_auth_method: { type: "string", enum: ["none"] },
              grant_types: arraySchema({ type: "string", enum: ["authorization_code", "refresh_token"] }),
              response_types: arraySchema({ type: "string", enum: ["code"] }),
              "com.posthog": objectSchema(
                { scopes: stringArraySchema },
                ["scopes"],
              ),
            },
            [
              "client_id",
              "client_name",
              "client_uri",
              "application_type",
              "redirect_uris",
              "token_endpoint_auth_method",
              "grant_types",
              "response_types",
              "com.posthog",
            ],
          )),
          default: errorResponse(),
        },
      }),
    },
    "/v1/integrations/posthog/oauth/callback": {
      get: operation("Complete a PostHog OAuth browser handoff", {
        operationId: "complete_posthog_oauth_callback",
        tags: ["PostHog Connection"],
        description:
          "Public browser callback protected by the one-time OAuth state and PKCE verifier. Returns a no-store HTML handoff page; OAuth tokens are encrypted by the hosted control plane and never returned to the browser, CLI, repository, CI, or runner.",
        parameters: [
          queryParam("state", stringSchema, true),
          queryParam("code"),
          queryParam("error"),
        ],
        responses: {
          "200": { description: "Authorization completed or project selection is required", content: { "text/html": { schema: stringSchema } } },
          "202": { description: "Another callback is completing the same authorization", content: { "text/html": { schema: stringSchema } } },
          "303": { description: "Bootstrap authorization returned once to the initiating CLI's exact 127.0.0.1 callback." },
          "400": { description: "Authorization failed", content: { "text/html": { schema: stringSchema } } },
          "410": { description: "Authorization attempt expired", content: { "text/html": { schema: stringSchema } } },
        },
      }),
    },
    "/v1/projects/{project_id}/posthog-connection": {
      get: operation("Read the customer-owned PostHog Cloud connection", {
        operationId: "get_posthog_connection",
        tags: ["PostHog Connection"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        responses: {
          "200": jsonResponse(posthogConnectionEnvelope),
          default: errorResponse(),
        },
      }),
      post: operation("Connect one PostHog Cloud project", {
        operationId: "connect_posthog_project",
        tags: ["PostHog Connection"],
        security: apiKey,
        description:
          "Owner-only. connect starts a short-lived PKCE browser handoff for the explicit PostHog Cloud region. PostHog's project-scoped consent selects the one environment bound to this connection. The read-only OAuth token remains encrypted in the hosted control plane.",
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        requestBody: objectSchema(
          {
            intent: { type: "string", enum: ["connect"] },
            region: { type: "string", enum: ["us", "eu"] },
            posthog_project_id: {
              type: "integer",
              minimum: 1,
              description:
                "Optional assertion for a caller that already knows the intended PostHog environment id. OAuth consent must still bind exactly this one provider-scoped environment.",
            },
          },
          ["intent", "region"],
        ),
        responses: {
          "200": jsonResponse(objectSchema(
            {
              connection: posthogConnectionViewSchema,
              authorization_url: stringSchema,
              poll_interval_seconds: integerSchema,
              expires_at: integerSchema,
            },
            ["connection"],
          )),
          default: errorResponse(),
        },
      }),
      delete: operation("Detach the PostHog OAuth connection", {
        operationId: "detach_posthog_connection",
        tags: ["PostHog Connection"],
        security: apiKey,
        description:
          "Owner-only detach/revoke. Agentry destroys its local OAuth ciphertext and best-effort revokes provider tokens. It never deletes, mutates, or otherwise affects customer-owned PostHog data.",
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        "x-agentry-request-body": "none",
        responses: {
          "200": jsonResponse(objectSchema(
            {
              connection: posthogConnectionViewSchema,
              revocation_confirmed: { oneOf: [booleanSchema, nullSchema] },
              customer_posthog_data_affected: { type: "boolean", enum: [false] },
              next_action: nullableStringSchema,
            },
            [
              "connection",
              "revocation_confirmed",
              "customer_posthog_data_affected",
              "next_action",
            ],
          )),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/session-recordings": {
      get: operation("List bounded PostHog session-recording metadata", {
        operationId: "list_posthog_session_recordings",
        tags: ["Session Recordings"],
        security: apiKey,
        description:
          "Reads a bounded page of metadata from the connected customer-owned PostHog Cloud project. It never returns replay snapshots, DOM content, or video, and Agentry does not retain a recording snapshot.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          ...posthogPaginationParameters(),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogSessionRecordingListResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/session-recordings/{recording_id}": {
      get: operation("Read bounded PostHog session-recording metadata", {
        operationId: "get_posthog_session_recording",
        tags: ["Session Recordings"],
        security: apiKey,
        description:
          "Reads projected metadata for one provider recording and returns a PostHog player URL. Replay content stays in PostHog and is not returned or retained by Agentry.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          posthogResourceIdParam("recording_id"),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogSessionRecordingResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/feature-flags": {
      get: operation("List PostHog feature-flag definitions", {
        operationId: "list_posthog_feature_flags",
        tags: ["Feature Flags"],
        security: apiKey,
        description:
          "Reads bounded, typed flag configuration from PostHog. Definitions are provider-state evidence, not proof that application source evaluated a flag or that a user received a value.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          ...posthogPaginationParameters(),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogFeatureFlagListResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/feature-flags/{flag_id}": {
      get: operation("Read a PostHog feature-flag definition", {
        operationId: "get_posthog_feature_flag",
        tags: ["Feature Flags"],
        security: apiKey,
        description:
          "Reads one bounded flag definition through read-only OAuth. Rollout, targeting, and lifecycle changes remain human-authorized operations in PostHog.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          posthogResourceIdParam("flag_id"),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogFeatureFlagResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/surveys": {
      get: operation("List PostHog survey definitions", {
        operationId: "list_posthog_surveys",
        tags: ["Surveys"],
        security: apiKey,
        description:
          "Reads bounded, typed survey configuration from PostHog. A definition does not by itself prove that application source rendered the survey at the intended business boundary.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          ...posthogPaginationParameters(),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogSurveyListResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/surveys/{survey_id}": {
      get: operation("Read a PostHog survey definition", {
        operationId: "get_posthog_survey",
        tags: ["Surveys"],
        security: apiKey,
        description:
          "Reads one bounded survey definition through read-only OAuth. Create, archive, targeting, and content changes remain human-authorized operations in PostHog.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          posthogResourceIdParam("survey_id"),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogSurveyDetailResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/surveys/{survey_id}/responses": {
      get: operation("List bounded PostHog survey responses", {
        operationId: "list_posthog_survey_responses",
        tags: ["Surveys"],
        security: apiKey,
        description:
          "Reads at most 100 projected responses from an explicit, ordered window of no more than 90 days. Free text and identifiers are bounded and redacted; treat every response as untrusted customer data and do not persist the collection.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          posthogResourceIdParam("survey_id"),
          ...posthogPaginationParameters(),
          {
            ...queryParam(
              "since",
              { type: "string", format: "date-time", maxLength: 100 },
              true,
            ),
            description: "Inclusive response-window start. Must precede until.",
          },
          {
            ...queryParam(
              "until",
              { type: "string", format: "date-time", maxLength: 100 },
              true,
            ),
            description:
              "Inclusive response-window end. The since/until span may not exceed 90 days.",
          },
          {
            ...queryParam("question_id", {
              type: "string",
              minLength: 1,
              maxLength: 200,
            }),
            description:
              "Optional question filter. Required when score_gte or score_lte is present.",
          },
          {
            ...queryParam("score_gte", numberSchema),
            description: "Optional minimum score; requires question_id.",
          },
          {
            ...queryParam("score_lte", numberSchema),
            description: "Optional maximum score; requires question_id.",
          },
          {
            ...queryParam("exclude_archived", booleanSchema),
            description: "Whether PostHog should exclude archived response rows.",
          },
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogSurveyResponsesResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/surveys/{survey_id}/stats": {
      get: operation("Read bounded PostHog survey statistics", {
        operationId: "get_posthog_survey_stats",
        tags: ["Surveys"],
        security: apiKey,
        description:
          "Reads bounded aggregate statistics for one survey. Prefer this aggregate surface for recurring review; configured provider state still does not prove where application source rendered a survey.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          posthogResourceIdParam("survey_id"),
          {
            ...queryParam("date_from", {
              type: "string",
              format: "date-time",
              maxLength: 100,
            }),
            description: "Optional aggregate-window start.",
          },
          {
            ...queryParam("date_to", {
              type: "string",
              format: "date-time",
              maxLength: 100,
            }),
            description: "Optional aggregate-window end; must not precede date_from.",
          },
          {
            ...queryParam("include_per_question_stats", booleanSchema),
            description: "Whether to request bounded per-question aggregates.",
          },
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogSurveyStatsResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/experiments": {
      get: operation("List PostHog experiment definitions", {
        operationId: "list_posthog_experiments",
        tags: ["Experiments"],
        security: apiKey,
        description:
          "Reads bounded experiment configuration from PostHog. Results are not proxied by this surface; use bounded analytics plus approved source semantics, deploy evidence, and a mature observation window for outcome claims.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          ...posthogPaginationParameters(),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogExperimentListResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/experiments/{experiment_id}": {
      get: operation("Read a PostHog experiment definition", {
        operationId: "get_posthog_experiment",
        tags: ["Experiments"],
        security: apiKey,
        description:
          "Reads one bounded experiment definition and provider conclusion state. It does not expose an experiment-results proxy or authorize experiment mutations.",
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          posthogResourceIdParam("experiment_id"),
        ],
        responses: {
          "200": jsonResponse({
            $ref: "#/components/schemas/PosthogExperimentResponse",
          }),
          default: errorResponse(),
        },
      }),
    },
    "/v1/cases/{case_id}/users": {
      get: operation("List users affected by a case", {
        tags: ["Users"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/caseId" }],
        responses: {
          "200": jsonResponse(caseUsersResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/users": {
      get: operation("List top users by error count", {
        tags: ["Users"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          queryParam("days", integerSchema),
          queryParam("limit", integerSchema),
        ],
        responses: {
          "200": jsonResponse(projectUsersResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/next-steps": {
      get: operation("Get suggested next steps", {
        tags: ["Projects"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        responses: {
          "200": jsonResponse(nextStepsResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/health": {
      get: operation("Get project health", {
        tags: ["Projects"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        responses: {
          "200": jsonResponse(projectHealthResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/billing/status": {
      get: operation("Get Nerve billing status", {
        tags: ["Billing"],
        description:
          "Read-only hosted-control-plane billing snapshot. Customer PostHog events and coding-agent inference are never metered. This operation never creates a Stripe customer, Checkout session, or portal session; call the explicit POST operation with a stable Idempotency-Key when the owner requests a URL.",
        security: apiKey,
        responses: {
          "200": jsonResponse(billingStatusResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/billing/checkout": {
      post: operation("Create Stripe Checkout session", {
        tags: ["Billing"],
        description:
          "Durable account-scoped Stripe saga. Requires a stable Idempotency-Key, serializes all billing session creation for the account, forwards deterministic per-phase Stripe keys, and encrypts the bearer-like checkout_url with AGENTRY_TOKEN_ENC_KEY. Exact retries recover the same URL; changed evidence conflicts.",
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/idempotencyKey" }],
        requestBody: objectSchema(
          {
            plan: { type: "string", enum: ["nerve"] },
            success_url: stringSchema,
            cancel_url: stringSchema,
          },
          ["plan"],
        ),
        responses: {
          "200": jsonResponse(billingCheckoutResponse),
          "202": jsonResponse(
            unknownObjectSchema,
            "The same or another account billing mutation owns the bounded lease; honor Retry-After and preserve this request's Idempotency-Key",
          ),
          "428": errorResponse("Stable Idempotency-Key required"),
          default: errorResponse(),
        },
      }),
    },
    "/v1/billing/portal": {
      post: operation("Create Stripe customer portal session", {
        tags: ["Billing"],
        description:
          "Durable account-scoped Stripe portal saga. Requires a stable Idempotency-Key and encrypts the bearer-like portal URL for exact replay. Portal creation remains available as the non-charging remediation path while account deletion has fenced new checkout/customer creation.",
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/idempotencyKey" }],
        requestBody: objectSchema({ return_url: stringSchema }),
        responses: {
          "200": jsonResponse(billingPortalResponse),
          "202": jsonResponse(
            unknownObjectSchema,
            "The same or another account billing mutation owns the bounded lease; honor Retry-After and preserve this request's Idempotency-Key",
          ),
          "428": errorResponse("Stable Idempotency-Key required"),
          default: errorResponse(),
        },
      }),
    },
    "/v1/billing/webhook": {
      post: operation("Receive Stripe billing webhook", {
        tags: ["Billing"],
        description:
          "Stripe-signed webhook for checkout.session.completed and customer.subscription.* events. The raw body is stream-bounded to 262144 bytes before signature verification. Required Stripe event id/type/created fields are persisted as a payload-hash-bound replay receipt; per-subscription ordering rejects older delivery before state can roll backward. Stripe event ids are opaque, so different events with the same created second are recorded as ambiguous_order and never automatically applied until a newer provider event resolves state. User updates require no account-deletion fence; fenced events remain durable deletion evidence. This endpoint uses Stripe-Signature, not API-key auth.",
        requestBody: unknownObjectSchema,
        responses: {
          "200": jsonResponse(billingWebhookResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/audit/recent": {
      get: operation("Get recent audit log entries", {
        tags: ["Audit"],
        security: apiKey,
        parameters: [queryParam("hours", integerSchema)],
        responses: {
          "200": jsonResponse(auditRecentResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/feedback": {
      get: operation("List feedback", {
        tags: ["Feedback"],
        security: apiKey,
        parameters: [
          queryParam("limit", integerSchema),
          queryParam("resolved", booleanSchema),
          queryParam("kind"),
        ],
        responses: {
          "200": jsonResponse(feedbackListResponse),
          default: errorResponse(),
        },
      }),
      post: operation("Send feedback", {
        tags: ["Feedback"],
        security: apiKey,
        requestBody: objectSchema(
          {
            message: stringSchema,
            kind: {
              type: "string",
              enum: [
                "missing_feature",
                "bug",
                "agent_discovered_bug",
                "ux_friction",
                "answer_contract_proposal",
                "other",
              ],
            },
            project_id: stringSchema,
            agent_note: stringSchema,
            tool_name: stringSchema,
            attempt_count: numberSchema,
            fingerprint: stringSchema,
            claude_session_id: stringSchema,
          },
          ["message"],
        ),
        responses: {
          "200": jsonResponse(feedbackResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/webhooks": {
      get: operation("List webhooks", {
        tags: ["Webhooks"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        responses: {
          "200": jsonResponse(webhooksListResponse),
          default: errorResponse(),
        },
      }),
      post: operation("Register webhook", {
        operationId: "create_webhook",
        description:
          "Owner-only recoverable command. Requires a stable Idempotency-Key; exact replay returns the same encrypted signing secret and never registers a duplicate subscription.",
        tags: ["Webhooks"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          { $ref: "#/components/parameters/idempotencyKey" },
        ],
        requestBody: objectSchema(
          {
            url: stringSchema,
            events: arraySchema(stringSchema),
            description: stringSchema,
          },
          ["url", "events"],
        ),
        responses: {
          "200": jsonResponse(webhookResponse),
          "409": jsonResponse(
            { $ref: "#/components/schemas/ErrorEnvelope" },
            "The key was reused with changed evidence",
          ),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/webhooks/{id}": {
      delete: operation("Delete webhook", {
        tags: ["Webhooks"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          idParam("id"),
        ],
        responses: {
          "200": jsonResponse(okResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/webhooks/{id}/test": {
      post: operation("Send test webhook delivery", {
        operationId: "test_webhook",
        description:
          "Requires a stable Idempotency-Key. The command identity determines one durable source_event_id and delivery set; exact replay returns those ids without redispatching.",
        tags: ["Webhooks"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          idParam("id"),
          { $ref: "#/components/parameters/idempotencyKey" },
        ],
        "x-agentry-request-body": "none",
        responses: {
          "200": jsonResponse(objectSchema({
            ok: booleanSchema,
            delivery_ids: arraySchema(stringSchema),
            source_event_id: stringSchema,
            idempotent_replay: booleanSchema,
            next_action: stringSchema,
          }, ["ok", "delivery_ids", "source_event_id", "idempotent_replay", "next_action"])),
          "409": jsonResponse(
            { $ref: "#/components/schemas/ErrorEnvelope" },
            "The webhook is disabled or the key was reused with changed evidence",
          ),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/alerts": {
      get: operation("List alerts", {
        tags: ["Alerts"],
        description:
          "Human owner/member view of alert definitions and current state. Unattended runners do not poll this route; they consume exact server-issued alert trigger receipts.",
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          queryParam("state", { type: "string", enum: ["triggered", "recovered"] }),
        ],
        responses: {
          "200": jsonResponse(alertsListResponse),
          default: errorResponse(),
        },
      }),
      post: operation("Create alert", {
        tags: ["Alerts"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        requestBody: objectSchema(
          {
            name: stringSchema,
            blueprint_id: stringSchema,
            threshold_column: stringSchema,
            threshold_op: {
              type: "string",
              enum: ["gt", "gte", "lt", "lte", "eq"],
            },
            threshold_value: {
              oneOf: [stringSchema, numberSchema, booleanSchema],
            },
            params: unknownObjectSchema,
            description: stringSchema,
            webhook_id: stringSchema,
          },
          [
            "name",
            "blueprint_id",
            "threshold_column",
            "threshold_op",
            "threshold_value",
          ],
        ),
        responses: {
          "200": jsonResponse(alertResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/alerts/{id}": {
      delete: operation("Delete alert", {
        tags: ["Alerts"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          idParam("id"),
        ],
        responses: {
          "200": jsonResponse(okResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/alerts/{id}/evaluate": {
      post: operation("Evaluate alert", {
        tags: ["Alerts"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          idParam("id"),
        ],
        requestBody: objectSchema({}),
        responses: {
          "200": jsonResponse(alertEvaluationResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/public-queries": {
      get: operation("List public query publications", {
        tags: ["Public Queries"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        responses: {
          "200": jsonResponse(publicationsListResponse),
          default: errorResponse(),
        },
      }),
      post: operation("Publish a query blueprint", {
        tags: ["Public Queries"],
        security: apiKey,
        parameters: [{ $ref: "#/components/parameters/projectId" }],
        requestBody: objectSchema(
          {
            blueprint_id: stringSchema,
            params: unknownObjectSchema,
            description: stringSchema,
          },
          ["blueprint_id"],
        ),
        responses: {
          "200": jsonResponse(publicationResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/projects/{project_id}/public-queries/{publication_id}": {
      delete: operation("Revoke public query publication", {
        tags: ["Public Queries"],
        security: apiKey,
        parameters: [
          { $ref: "#/components/parameters/projectId" },
          idParam("publication_id"),
        ],
        responses: {
          "200": jsonResponse(publicationRevokeResponse),
          default: errorResponse(),
        },
      }),
    },
    "/v1/public/q/{publication_id}": {
      get: operation("Execute public query publication", {
        tags: ["Public Queries"],
        parameters: [
          idParam("publication_id"),
        ],
        responses: {
          "200": jsonResponse(
            objectSchema(
              {
                publication_id: stringSchema,
                blueprint_id: stringSchema,
                title: stringSchema,
                description: { oneOf: [stringSchema, nullSchema] },
                rows: arraySchema(unknownObjectSchema),
                columns: arraySchema(stringSchema),
                types: { oneOf: [arraySchema(stringSchema), nullSchema] },
                row_count: integerSchema,
                freshness: objectSchema({
                  source: stringSchema,
                  consistency: stringSchema,
                  cache_bust: booleanSchema,
                  queried_at: stringSchema,
                  query_duration_ms: integerSchema,
                  retry_after_ms: integerSchema,
                  status: stringSchema,
                  next_action: stringSchema,
                }),
                render_hint: unknownObjectSchema,
                next_action: stringSchema,
              },
              [],
              true,
            ),
            "OK",
            {
              publication_id: "pub_example",
              blueprint_id: "active_users_daily",
              title: "Active users by day",
              description: "Browser-safe daily active users",
              rows: [{ day: "2026-06-14", dau: 42 }],
              columns: ["day", "dau"],
              types: ["Date", "UInt64"],
              row_count: 1,
              freshness: {
                source: "posthog_hogql",
                consistency: "eventual",
                cache_bust: true,
                queried_at: "2026-06-16T10:00:00.000Z",
                query_duration_ms: 832,
                retry_after_ms: 30000,
                status: "complete_for_query_time",
                next_action:
                  "Recently captured customer analytics can take a short time to appear in PostHog; re-fetch the same bounded public query before making customer-facing claims.",
              },
              render_hint: { type: "line", x: "day", y: "dau" },
              next_action:
                "Consume rows as the canonical object-shaped result set. Columns is metadata for display order. Check freshness before treating recent empty or partial rows as final.",
            },
          ),
          "410": errorResponse("Publication revoked"),
          default: errorResponse(),
        },
      }),
    },
    "/admin/retention/sweep": {
      post: operation("Admin force retention sweep", {
        tags: ["Admin"],
        security: admin,
        requestBody: objectSchema({}),
        responses: { "200": anyJson, default: errorResponse() },
      }),
    },
    "/admin/plans": {
      get: operation("Admin list plans", {
        tags: ["Admin"],
        security: admin,
        responses: { "200": anyJson, default: errorResponse() },
      }),
    },
    "/admin/feedback": {
      get: operation("Admin agent feedback queue", {
        tags: ["Admin"],
        security: admin,
        parameters: [
          queryParam("limit", integerSchema),
          queryParam("resolved", booleanSchema),
          queryParam("kind"),
          queryParam("user_id"),
          queryParam("project_id"),
          queryParam("q"),
        ],
        responses: { "200": anyJson, default: errorResponse() },
      }),
    },
    "/admin/users/{user_id}/plan": {
      patch: operation("Admin change user plan", {
        tags: ["Admin"],
        security: admin,
        parameters: [idParam("user_id")],
        requestBody: objectSchema(
          { plan: { type: "string", enum: ["free", "nerve"] } },
          ["plan"],
        ),
        responses: { "200": anyJson, default: errorResponse() },
      }),
    },
  };
  const posthogResourceOperations = [
    { method: "get", path: "/v1/projects/{project_id}/session-recordings" },
    {
      method: "get",
      path: "/v1/projects/{project_id}/session-recordings/{recording_id}",
    },
    { method: "get", path: "/v1/projects/{project_id}/feature-flags" },
    {
      method: "get",
      path: "/v1/projects/{project_id}/feature-flags/{flag_id}",
    },
    { method: "get", path: "/v1/projects/{project_id}/surveys" },
    {
      method: "get",
      path: "/v1/projects/{project_id}/surveys/{survey_id}",
    },
    {
      method: "get",
      path: "/v1/projects/{project_id}/surveys/{survey_id}/responses",
    },
    {
      method: "get",
      path: "/v1/projects/{project_id}/surveys/{survey_id}/stats",
    },
    { method: "get", path: "/v1/projects/{project_id}/experiments" },
    {
      method: "get",
      path: "/v1/projects/{project_id}/experiments/{experiment_id}",
    },
  ];
  const flowDocs = {
    automation: AUTOMATION_OPENAPI_FLOW,
    onboarding: ONBOARDING_V3_OPENAPI_FLOW,
    daily_use: {
      purpose:
        "Answer day-to-day provider-state, product, reliability, and deploy questions with bounded PostHog resource reads and source-backed behavioral evidence.",
      operations: [
        { method: "get", path: "/v1/projects/{project_id}/onboarding" },
        { method: "get", path: "/v1/projects/{project_id}/signal-map" },
        { method: "get", path: "/v1/projects/{project_id}/event-names" },
        {
          method: "get",
          path: "/v1/projects/{project_id}/event-property-keys",
        },
        { method: "get", path: "/v1/query-blueprints" },
        { method: "get", path: "/v1/query-blueprints/{blueprint_id}" },
        {
          method: "post",
          path: "/v1/projects/{project_id}/query-blueprints/{blueprint_id}/run",
        },
        { method: "post", path: "/v1/projects/{project_id}/analytics/query" },
        { method: "get", path: "/v1/projects/{project_id}/cases" },
        { method: "get", path: "/v1/cases/{case_id}" },
        { method: "get", path: "/v1/projects/{project_id}/deploys" },
        { method: "get", path: "/v1/projects/{project_id}/next-steps" },
        ...posthogResourceOperations,
      ],
      states: [
        "question",
        "provider_state_read",
        "contract_loaded",
        "readiness_classified",
        "queried",
        "answered",
        "needs_data_or_instrumentation",
      ],
      transitions: [
        {
          from: "question",
          to: "provider_state_read",
          operation:
            "Choose the matching canonical GET operation from the PostHog resource list, then inspect freshness and data_boundary.",
          when:
            "the question asks about current recording metadata, flag configuration, survey configuration or outcomes, or experiment configuration",
        },
        {
          from: "question",
          to: "contract_loaded",
          operation: "GET /v1/projects/{project_id}/signal-map",
        },
        {
          from: "provider_state_read",
          to: "answered",
          operation:
            "Return the bounded provider projection with its freshness and data boundary.",
          when: "the question is limited to current provider state",
        },
        {
          from: "provider_state_read",
          to: "contract_loaded",
          operation: "GET /v1/projects/{project_id}/signal-map",
          when:
            "the answer would claim application behavior, exposure, rendering, causal effect, or experiment outcome",
        },
        {
          from: "contract_loaded",
          to: "readiness_classified",
          operation:
            "GET /v1/projects/{project_id}/onboarding -> GET /v1/projects/{project_id}/event-names -> GET /v1/projects/{project_id}/event-property-keys",
        },
        {
          from: "readiness_classified",
          to: "queried",
          operation:
            "GET /v1/projects/{project_id}/event-names -> GET /v1/projects/{project_id}/event-property-keys -> POST /v1/projects/{project_id}/query-blueprints/{blueprint_id}/run or POST /v1/projects/{project_id}/analytics/query",
          when:
            "onboarding status is verified and the needed events/properties are observed",
        },
        {
          from: "readiness_classified",
          to: "needs_data_or_instrumentation",
          operation: "GET /v1/projects/{project_id}/onboarding",
          when: "onboarding is not verified or a required event/property is absent",
        },
        {
          from: "queried",
          to: "answered",
          operation:
            "Return rows plus evidence and freshness; build a report/dashboard only when the user asked for one",
        },
      ],
      invariants: [
        "A direct question about current PostHog resource configuration can use the matching bounded provider read without first claiming source semantics.",
        "For application behavior, exposure, rendering, causal effect, or experiment outcome, read the current onboarding state and signal map, require source_verified semantics, and prove the needed live events/properties before analysis.",
        "For event-property-keys, pass ?events=a,b,c from the saved funnel. Do not rely on the no-events form for segmentation proof.",
        "If onboarding is not verified or a required event/property is absent, classify the question as Ready/Needs more data/Needs instrumentation before querying. Observed rows alone are not proof that the product question is answer-ready.",
        "Public-query publications are optional browser/shareable output, not proof that the metric is valid.",
        "Session-recording operations return metadata and a PostHog player URL only; replay snapshots never cross or persist in Agentry.",
        "Every resource operation is read-only. Create, edit, archive, target, conclude, or otherwise mutate provider resources in PostHog with human authorization.",
      ],
    },
    posthog: {
      purpose:
        "Read session-recording metadata, feature-flag definitions, survey definitions/responses/statistics, and experiment definitions directly from the connected customer-owned PostHog Cloud project.",
      operations: posthogResourceOperations,
      states: [
        "question",
        "resource_selected",
        "provider_state_read",
        "evidence_classified",
        "answered_or_needs_proof",
      ],
      transitions: [
        {
          from: "question",
          to: "resource_selected",
          operation:
            "Choose the matching list operation; select a provider id before a detail, response, or stats read.",
        },
        {
          from: "resource_selected",
          to: "provider_state_read",
          operation:
            "Call one canonical GET operation with bounded pagination or the required survey-response time window.",
        },
        {
          from: "provider_state_read",
          to: "evidence_classified",
          operation:
            "Inspect freshness, data_boundary, redaction when present, and next_action.",
        },
        {
          from: "evidence_classified",
          to: "answered_or_needs_proof",
          operation:
            "Answer provider-state questions directly; for runtime or effect claims continue through daily_use source, deploy, traffic, and analytics evidence.",
        },
      ],
      invariants: [
        "The connected PostHog Cloud project remains the authoritative resource data plane; Agentry returns only bounded projections and retains no resource snapshot or raw event stream.",
        "Session-recording content is never returned. Use player_url for a human review in PostHog.",
        "Survey-response reads require an explicit ordered window no longer than 90 days, return at most 100 projected rows, and redact bounded free text and identifiers.",
        "Experiment reads expose configuration and conclusion provider state only. There is no experiment-results proxy; effect claims require bounded analytics plus source, deploy, traffic, and maturity evidence.",
        "OAuth and every public resource operation are read-only. Provider mutations are never authorized by this flow.",
      ],
    },
    webhooks: {
      purpose:
        "Register signed outbound deliveries for case/deploy lifecycle events.",
      states: [
        "none",
        "registered",
        "tested",
        "delivering",
        "unhealthy",
        "deleted",
      ],
      transitions: [
        {
          from: "none",
          to: "registered",
          operation: "POST /v1/projects/{project_id}/webhooks",
        },
        {
          from: "registered",
          to: "tested",
          operation: "POST /v1/projects/{project_id}/webhooks/{id}/test",
        },
        {
          from: "registered",
          to: "delivering",
          operation: "PostHog issue projection or POST /v1/deploys/",
        },
        {
          from: "delivering",
          to: "unhealthy",
          operation: "GET /v1/projects/{project_id}/webhooks",
          when: "last_status is non-2xx or last_error is present",
        },
        {
          from: "registered",
          to: "deleted",
          operation: "DELETE /v1/projects/{project_id}/webhooks/{id}",
        },
      ],
      invariants: [
        "Deliveries include x-agentry-event and x-agentry-signature.",
        "Subscribers only receive events listed in their events array.",
      ],
    },
    alerts: {
      purpose:
        "Let human owners configure query-blueprint-backed alerts while the platform evaluates them and unattended runners consume exact server-issued alert receipts.",
      states: ["none", "created", "evaluated_clear", "triggered", "deleted"],
      transitions: [
        {
          from: "none",
          to: "created",
          operation: "POST /v1/projects/{project_id}/alerts",
        },
        {
          from: "created",
          to: "evaluated_clear",
          operation: "POST /v1/projects/{project_id}/alerts/{id}/evaluate",
          when: "threshold not crossed",
        },
        {
          from: "created",
          to: "triggered",
          operation: "POST /v1/projects/{project_id}/alerts/{id}/evaluate",
          when: "threshold crossed",
        },
        {
          from: "created",
          to: "deleted",
          operation: "DELETE /v1/projects/{project_id}/alerts/{id}",
        },
      ],
      invariants: [
        "blueprint_id must exist in the query blueprint catalog.",
        "threshold_column, threshold_op, and threshold_value define the trigger condition.",
        "Human owner/member routes are never scheduler credentials or runner poll surfaces; automation begins only from an exact server-issued alert receipt.",
      ],
    },
    public_queries: {
      purpose:
        "Publish a bounded query-blueprint result URL without exposing arbitrary HogQL.",
      states: ["private", "published", "served", "revoked"],
      transitions: [
        {
          from: "private",
          to: "published",
          operation: "POST /v1/projects/{project_id}/public-queries",
        },
        {
          from: "published",
          to: "served",
          operation: "GET /v1/public/q/{publication_id}",
        },
        {
          from: "published",
          to: "revoked",
          operation:
            "DELETE /v1/projects/{project_id}/public-queries/{publication_id}",
        },
      ],
      invariants: [
        "Only blueprint_id plus params are public, never arbitrary HogQL.",
        "The complete unguessable publication URL is the visitor capability. It can execute only its explicitly published query-blueprint query; there is no separate key query parameter.",
      ],
    },
  };

  const schema = {
    openapi: "3.1.0",
    info: {
      title: "Agentry API",
      version: ONBOARDING_V3_CONTRACT_VERSION,
      description:
        `Canonical agent-readable schema for Agentry endpoints. Use ${PUBLIC_INSTALL_DOC_URL} to bootstrap onboarding, ?flow=onboarding for its exact state machine, and exact path+method filters for request and response shapes. Customer PostHog events and customer-run inference are not billing meters.`,
    },
    servers: [{ url: "https://api.agentry.sh" }],
    "x-agentry-flows": flowDocs,
    "x-agentry-agent-contract": {
      request_id_header: "x-agentry-request-id",
      response_request_id_header: "x-agentry-request-id",
      idempotency_key_header: "idempotency-key",
      error_retryability_field: "error.retryable",
      error_request_id_field: "error.request_id",
      billing_boundary:
        "Nerve billing covers hosted continuous automation only. Normal reads never create Stripe state and no event-volume quota can block PostHog-backed evidence.",
      retryable_statuses: [429, 500, 502, 503, 504],
      retry_guidance:
        "Agents should retry retryable=true failures with exponential backoff and preserve the original idempotency-key when replaying the same mutation. invalid_payload is not retryable; fetch the filtered schema and fix the body.",
    },
    paths: {
      ...featurePaths,
      "/v1/auth/posthog": {
        post: operation("Start one-click PostHog sign-in and read-only project authorization", {
          tags: ["Auth"],
          description:
            "Creates one short-lived PostHog Cloud OIDC + read-only project consent transaction bound to the initiating CLI's ephemeral 127.0.0.1 callback. The opaque poll token, loopback ticket, and verifier are local secrets; PostHog access and refresh tokens never leave the hosted control plane.",
          requestBody: objectSchema(
            {
              region: { type: "string", enum: ["us", "eu"] },
              client_name: {
                ...stringSchema,
                maxLength: 64,
                description: "Optional agent or client name used for bounded attribution.",
              },
              distribution_surface: {
                ...stringSchema,
                pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
                description: "Optional coarse acquisition source such as codex_skill or cli.",
              },
              handoff_redirect_uri: {
                ...stringSchema,
                maxLength: 256,
                pattern:
                  "^http://127\\.0\\.0\\.1:[0-9]{4,5}/agentry/posthog/callback/[A-Za-z0-9_-]{22}$",
                description:
                  "Ephemeral callback created by the interactive CLI on this computer. Only exact 127.0.0.1 callbacks are accepted.",
              },
              handoff_challenge: {
                ...stringSchema,
                pattern: "^[A-Za-z0-9_-]{43}$",
                description:
                  "SHA-256 base64url challenge binding the callback ticket to the initiating CLI.",
              },
            },
            ["region", "handoff_redirect_uri", "handoff_challenge"],
          ),
          responses: {
            "200": jsonResponse({
              $ref: "#/components/schemas/PosthogAuthStartResponse",
            }),
            default: errorResponse(),
          },
        }),
      },
      "/v1/auth/posthog/poll": {
        post: operation("Redeem a completed PostHog authorization", {
          tags: ["Auth"],
          description:
            "Uses the opaque poll token plus the one-time loopback ticket and verifier. Success mints one private agentry_sk_ owner key and returns one authorization_id for an atomic project claim; it never returns a PostHog token.",
          requestBody: objectSchema({
            poll_token: stringSchema,
            handoff_ticket: stringSchema,
            handoff_verifier: stringSchema,
          }, ["poll_token", "handoff_ticket", "handoff_verifier"]),
          responses: {
            "200": jsonResponse({
              $ref: "#/components/schemas/PosthogAuthPollResponse",
            }),
            "400": jsonResponse({
              $ref: "#/components/schemas/PosthogAuthPollResponse",
            }),
            default: errorResponse(),
          },
        }),
      },
      "/v1/auth/keys": {
        get: operation("List private owner keys", {
          operationId: "list_owner_keys",
          description:
            "Lists hash-only owner-key metadata so a staged replacement can be verified before explicit revocation. Raw owner keys are never recoverable.",
          tags: ["Auth"],
          security: [{ ApiKeyAuth: [] }],
          responses: {
            "200": jsonResponse(objectSchema({
              keys: arraySchema(ownerKeyMetadata),
              next_action: stringSchema,
            }, ["keys", "next_action"])),
            default: errorResponse(),
          },
        }),
      },
      "/v1/auth/keys/rotate": {
        post: operation("Create a staged replacement private API key", {
          operationId: "rotate_owner_key",
          description:
            "Requires a stable Idempotency-Key. The current key remains active until explicit revocation. The replacement raw value is hash-only and returned once; exact retry identifies the prior replacement and confirms whether the old key remains active without minting again.",
          tags: ["Auth"],
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: "#/components/parameters/idempotencyKey" }],
          "x-agentry-request-body": "none",
          responses: {
            "200": jsonResponse(objectSchema({
              api_key: stringSchema,
              key_id: stringSchema,
              prefix: stringSchema,
              user_id: stringSchema,
              previous_key_id: stringSchema,
              previous_key_active: booleanSchema,
              idempotent_replay: booleanSchema,
              next_action: stringSchema,
            }, [
              "api_key",
              "key_id",
              "prefix",
              "user_id",
              "previous_key_id",
              "previous_key_active",
              "idempotent_replay",
              "next_action",
            ])),
            "409": jsonResponse(
              { $ref: "#/components/schemas/ErrorEnvelope" },
              "Exact retry identifies the hash-only replacement instead of returning or minting a secret",
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/auth/keys/{key_id}/revoke": {
        post: operation("Revoke a superseded private API key", {
          operationId: "revoke_owner_key",
          description:
            "Requires a stable Idempotency-Key and must be authenticated by a different verified owner key. The server refuses to revoke the current or only surviving key.",
          tags: ["Auth"],
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { name: "key_id", in: "path", required: true, schema: stringSchema },
            { $ref: "#/components/parameters/idempotencyKey" },
          ],
          requestBody: objectSchema({ reason: stringSchema }, ["reason"]),
          responses: {
            "200": jsonResponse(objectSchema({
              key_id: stringSchema,
              prefix: stringSchema,
              revoked_at: integerSchema,
              idempotent_replay: booleanSchema,
              next_action: stringSchema,
            }, ["key_id", "prefix", "revoked_at", "idempotent_replay", "next_action"])),
            "409": jsonResponse(
              { $ref: "#/components/schemas/ErrorEnvelope" },
              "The target is current, is the only surviving key, or changed before guarded revocation",
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/me": {
        get: operation("Get current authenticated user", {
          tags: ["Auth"],
          security: [{ ApiKeyAuth: [] }],
          responses: {
            "200": jsonResponse(
              objectSchema(
                {
                  user: objectSchema(
                    {
                      id: stringSchema,
                      email: stringSchema,
                    },
                    ["id"],
                  ),
                  api_key: objectSchema(
                    {
                      id: stringSchema,
                      prefix: stringSchema,
                      kind: stringSchema,
                    },
                    ["id", "prefix", "kind"],
                  ),
                  projects_url: stringSchema,
                  schema_url: stringSchema,
                  next_action: stringSchema,
                },
                [
                  "user",
                  "api_key",
                  "projects_url",
                  "schema_url",
                  "next_action",
                ],
              ),
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects": {
        get: operation("List projects", {
          tags: ["Projects"],
          security: [{ ApiKeyAuth: [] }],
          responses: {
            "200": jsonResponse(
              objectSchema({
                projects: arraySchema({
                  $ref: "#/components/schemas/ProjectSummary",
                }),
              }),
            ),
            default: errorResponse(),
          },
        }),
        post: operation("Create project", {
          operationId: "create_project",
          description:
            "Requires a stable 8-500 character Idempotency-Key. Project state, owner membership, command receipt, and local success audit commit atomically. Exact retries return the same Agentry project and never provision or mutate PostHog.",
          tags: ["Projects"],
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: "#/components/parameters/idempotencyKey" }],
          requestBody: { $ref: "#/components/schemas/CreateProjectRequest" },
          responses: {
            "200": jsonResponse({
              $ref: "#/components/schemas/CreateProjectResponse",
            }),
            "409": jsonResponse(
              { $ref: "#/components/schemas/ErrorEnvelope" },
              "The key was reused with changed evidence or its encrypted recovery material was superseded",
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}": {
        get: operation("Get project", {
          tags: ["Projects"],
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: "#/components/parameters/projectId" }],
          responses: {
            "200": jsonResponse({ $ref: "#/components/schemas/ProjectDetail" }),
            default: errorResponse(),
          },
        }),
        delete: operation("Delete project", {
          operationId: "delete_project",
          description:
            "Durable owner-only deletion of Agentry-owned control-plane state. Requires a stable Idempotency-Key, fences new local mutations, and returns bounded 202 progress while cleanup completes. Agentry detaches or best-effort revokes its local PostHog OAuth connection; it never deletes or mutates the customer's PostHog project or telemetry. Exact retries recover the same terminal receipt.",
          tags: ["Projects"],
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { $ref: "#/components/parameters/projectId" },
            { $ref: "#/components/parameters/idempotencyKey" },
          ],
          responses: {
            "200": jsonResponse({
              $ref: "#/components/schemas/DeleteProjectResponse",
            }),
            "202": {
              ...jsonResponse(
                { $ref: "#/components/schemas/DeleteProjectResponse" },
                "Bounded local cleanup or a pre-fence external operation remains; retry the exact DELETE with the same key at retry_after_seconds",
              ),
              headers: {
                "Retry-After": {
                  description: "Integer seconds from the authoritative DB clock until this exact deletion command should be retried.",
                  schema: { type: "integer", minimum: 1 },
                },
              },
            },
            "409": jsonResponse(
              {
                oneOf: [
                  { $ref: "#/components/schemas/ProjectDeletionTerminalAuditConflict" },
                  { $ref: "#/components/schemas/ErrorEnvelope" },
                ],
              },
              "Deletion conflict. project_deletion_terminal_audit_conflict is terminal and non-retryable: the project is preserved, the caller must stop retrying, and an operator must reconcile the exact command and immutable audit ids.",
              {
                error: {
                  code: "project_deletion_terminal_audit_conflict",
                  message: "Project deletion was rolled back because immutable terminal audit evidence conflicts with this exact command.",
                  next_action: "Stop retrying this deletion. An operator must compare the immutable audit row with the project-deletion command and restore canonical terminal evidence without deleting the project manually.",
                  retryable: false,
                  details: {
                    project_id: "018f0000-0000-7000-8000-000000000001",
                    command_id: "mutcmd_example",
                    expected_audit_id: "audit_expected",
                    conflicting_audit_id: "audit_conflicting",
                    retryable: false,
                    operator_remediation_required: true,
                    project_preserved: true,
                  },
                },
              },
            ),
            "428": errorResponse("Stable Idempotency-Key required for an authorized first attempt"),
            default: errorResponse(),
          },
        }),
      },
      "/v1/deploys/": {
        post: operation("Record a trusted CI deploy", {
          operationId: "record_deploy",
          tags: ["Deploys", "Automation"],
          security: [{ CiDeployAuth: [] }],
          description:
            "Record one deploy after a real successful deploy from CI, a provider deploy hook, or a release script using AGENTRY_CI_API_KEY. A deploy bound to an automation run must include both automation_run_id and source_commit_sha and must match the immutable CI PR proof. Do not call this from app startup, instrumentation/register/bootstrap hooks, cron routes, workers, request handlers, browser/client code, or product flows.",
          parameters: [
            {
              $ref: "#/components/parameters/idempotencyKey",
            },
          ],
          requestBody: { $ref: "#/components/schemas/DeployIngestRequest" },
          responses: {
            "200": jsonResponse({
              $ref: "#/components/schemas/DeployAcceptedResponse",
            }),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/cases": {
        get: operation("List project cases", {
          operationId: "list_cases",
          tags: ["Cases"],
          security: [{ ApiKeyAuth: [] }],
          description:
            "Human owner/member case inventory. Automation runners must use server-issued trigger receipts and cannot enumerate project cases.",
          parameters: [
            { $ref: "#/components/parameters/projectId" },
            {
              name: "status",
              in: "query",
              required: false,
              schema: { $ref: "#/components/schemas/CaseListStatus" },
              description:
                "Local case lifecycle filter applied after a bounded status=all refresh from authoritative PostHog Error Tracking. Defaults to active; all returns every projected lifecycle state.",
            },
            queryParam("limit", integerSchema),
            queryParam("cursor", stringSchema),
            queryParam("q", stringSchema),
            queryParam("environment", stringSchema),
            queryParam("deploy_sha", stringSchema),
            {
              name: "since",
              in: "query",
              required: false,
              schema: integerSchema,
              description:
                "Unix seconds. Only cases with last_seen_at >= since.",
            },
            queryParam("until", integerSchema),
            {
              name: "unhandled",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description:
                "true keeps only cases with no recorded automation run since their last event. This remains a human investigation filter; runners consume exact server-issued receipts.",
            },
          ],
          responses: {
            "200": jsonResponse(
              objectSchema({
                data_boundary: unknownObjectSchema,
                cases: arraySchema({
                  $ref: "#/components/schemas/CaseSummary",
                }),
                next_cursor: { oneOf: [stringSchema, nullSchema] },
                has_more: {
                  ...booleanSchema,
                  description:
                    "Whether more rows remain in Agentry's local case projection for this query. This is independent of projection_refresh.truncated.",
                },
                projection_refresh: {
                  $ref: "#/components/schemas/CaseProjectionRefresh",
                },
                control: unknownObjectSchema,
              }, [
                "data_boundary",
                "cases",
                "next_cursor",
                "has_more",
                "projection_refresh",
                "control",
              ]),
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/cases/{case_id}": {
        get: operation("Get case detail", {
          operationId: "get_case",
          tags: ["Cases"],
          security: [{ ApiKeyAuth: [] }, { AutomationRunnerAuth: [] }],
          description:
            "Human project members may read an accessible case. A runner receives detailed evidence only while its exact credential holds an unexpired, unreleased claim for the current case revision and its bound automation. Runner responses omit affected-user data.",
          parameters: [{ $ref: "#/components/parameters/caseId" }],
          responses: {
            "200": jsonResponse({ $ref: "#/components/schemas/CaseDetail" }),
            default: errorResponse(),
          },
        }),
        patch: operation("Update Agentry-owned case annotations", {
          tags: ["Cases"],
          security: [{ ApiKeyAuth: [] }],
          description:
            "Updates only Agentry-owned agent_summary and pr_url fields. PostHog owns issue lifecycle; change status in PostHog and then re-read the case to refresh this projection. If-Match is required and must carry the current quoted integer revision returned as the case ETag.",
          parameters: [
            { $ref: "#/components/parameters/caseId" },
            {
              name: "If-Match",
              in: "header",
              required: true,
              description:
                "Current quoted integer case revision from the latest GET /v1/cases/{case_id} ETag.",
              schema: {
                type: "string",
                pattern: '^"[1-9][0-9]*"$',
              },
            },
          ],
          requestBody: { $ref: "#/components/schemas/UpdateCaseRequest" },
          responses: {
            "200": jsonResponse({ $ref: "#/components/schemas/CaseDetail" }),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/deploys": {
        get: operation("List deploys", {
          operationId: "list_deploys",
          tags: ["Deploys"],
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { $ref: "#/components/parameters/projectId" },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
            {
              name: "since",
              in: "query",
              required: false,
              schema: integerSchema,
            },
          ],
          responses: {
            "200": jsonResponse(
              objectSchema({
                data_boundary: unknownObjectSchema,
                deploys: arraySchema({ $ref: "#/components/schemas/Deploy" }),
                next_action: stringSchema,
              }),
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/analytics/query": {
        post: operation("Run HogQL query", {
          tags: ["Analytics"],
          description:
            "Runs a bounded PostHog/HogQL read for an owner or member agent through the project's encrypted read-only PostHog Cloud OAuth connection. CI and runner credentials cannot call this endpoint. " +
            "Agentry excludes onboarding-proof, rehearsal, and test rows from events table reads by default; pass include_synthetic=true only while debugging the project's explicit onboarding proof. " +
            "Client code that calls it must use a request timeout of at least 45 seconds; real HogQL queries commonly take 10-30 seconds. " +
            "For dashboard code, run a small fixed set of visible-view queries in a bounded parallel batch and flatten related metrics into grouped queries. " +
            "Avoid unbounded fan-out over dynamic users, rows, segments, or filter values. The response always includes canonical object-shaped rows; columns is metadata for display order. " +
            "Do not read response.results; Agentry does not expose PostHog's internal results array on this agent-facing endpoint. " +
            "Check freshness before treating recent empty or partial reads as final; events sent directly from the customer application can take time to become queryable in PostHog Cloud.",
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: "#/components/parameters/projectId" }],
          requestBody: objectSchema(
            {
              query: stringSchema,
              include_synthetic: {
                ...booleanSchema,
                description:
                  "Defaults to false. Set true only while debugging the project's explicit onboarding proof when its marked proof rows must be included.",
              },
            },
            ["query"],
          ),
          requestExample: {
            query:
              "SELECT event, count() AS users FROM events WHERE event IN ('signup_completed', 'subscription_started') AND timestamp >= now() - INTERVAL 30 DAY GROUP BY event ORDER BY users DESC",
            include_synthetic: false,
          },
          responses: {
            "200": jsonResponse(
              objectSchema(
                {
                  rows: {
                    ...arraySchema(unknownObjectSchema),
                    description:
                      "Canonical object-shaped result rows. Read response.rows; response.results is intentionally absent.",
                  },
                  columns: {
                    ...arraySchema(stringSchema),
                    description:
                      "Display-order metadata only. Do not zip this with a PostHog results array.",
                  },
                  types: { oneOf: [arraySchema(stringSchema), nullSchema] },
                  row_count: integerSchema,
                  freshness: objectSchema({
                    source: stringSchema,
                    consistency: stringSchema,
                    cache_bust: booleanSchema,
                    queried_at: stringSchema,
                    query_duration_ms: integerSchema,
                    retry_after_ms: integerSchema,
                    status: stringSchema,
                    next_action: stringSchema,
                  }),
                  customer_data_filter: analyticsQueryCustomerDataFilterSchema,
                  next_action: stringSchema,
                },
                [],
                true,
              ),
              "OK",
              {
                rows: [{ event: "signup_completed", users: 42 }],
                columns: ["event", "users"],
                types: ["String", "UInt64"],
                row_count: 1,
                freshness: {
                  source: "posthog_hogql",
                  consistency: "eventual",
                  cache_bust: true,
                  queried_at: "2026-06-16T10:00:00.000Z",
                  query_duration_ms: 832,
                  retry_after_ms: 30000,
                  status: "complete_for_query_time",
                  next_action:
                    "Recently captured customer analytics can take a short time to appear in PostHog; re-query bounded onboarding-proof reads before making a source-verification claim.",
                },
                customer_data_filter: {
                  applied: true,
                  include_synthetic: false,
                  mode: "server_enforced",
                  hogql_where: CUSTOMER_ANALYTICS_HOGQL_FILTER,
                  next_action:
                    "Customer analytics reads exclude marked onboarding-proof, rehearsal, and test traffic.",
                },
                next_action:
                  "Interpret response.rows as the canonical object-shaped result set. response.results is intentionally absent; fix clients that read results. Columns is metadata for ordering/display only. Check freshness before treating a recent empty or partial result as final.",
              },
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/signal-map": {
        get: operation("Get approved signal map", {
          operationId: "get_signal_map",
          tags: ["Install"],
          description:
            "Canonical project memory for day-to-day questions: approved business/value flow, exact events/properties, impactful error surfaces, deploy target, and a nullable source-verification receipt. Trust current source semantics only when receipt.evidence_status is source_verified; historical PostHog rows alone establish historically_observed. If the receipt is absent or weaker, read onboarding for recovery.",
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: "#/components/parameters/projectId" }],
          responses: {
            "200": jsonResponse({ $ref: "#/components/schemas/SignalMap" }),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/setup": {
        get: operation("Get project setup matrix", {
          tags: ["Install"],
          description:
            "Project-specific machine-readable connection and credential placement matrix. Application analytics, exceptions, and source maps go directly to the customer-owned PostHog Cloud project. Agentry uses read-only OAuth, while Agentry credentials are limited to interactive owner operations, CI deploy evidence, and explicitly enabled automation runners.",
          security: [{ ApiKeyAuth: [] }],
          parameters: [{ $ref: "#/components/parameters/projectId" }],
          responses: {
            "200": jsonResponse(projectSetupResponse),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/event-names": {
        get: operation(
          "List observed customer PostHog and Agentry control events",
          {
            tags: ["Analytics"],
            description:
              "Owner/member discovery helper. analytics_events are bounded reads from the customer-owned PostHog Cloud project through read-only OAuth; server_emitted lists Agentry control-plane webhook events. Compare customer events with the saved signal map and source-verification receipt before running a funnel.",
            security: [{ ApiKeyAuth: [] }],
            parameters: [{ $ref: "#/components/parameters/projectId" }],
            responses: {
              "200": jsonResponse(
                objectSchema(
                  {
                    server_emitted: arraySchema(stringSchema),
                    analytics_events: arraySchema(
                      objectSchema(
                        {
                          event: stringSchema,
                          count: integerSchema,
                          last_seen: integerSchema,
                        },
                        ["event", "count", "last_seen"],
                        true,
                      ),
                    ),
                    analytics_read: objectSchema(
                      {
                        ok: booleanSchema,
                        status: stringSchema,
                        source: stringSchema,
                        row_count: integerSchema,
                        queried_at: stringSchema,
                        next_action: stringSchema,
                      },
                      ["ok", "status", "source", "row_count"],
                      true,
                    ),
                    customer_data_filter: customerDataFilterSchema,
                    wildcards: arraySchema(stringSchema),
                    next_action: stringSchema,
                  },
                  [
                    "server_emitted",
                    "analytics_events",
                    "analytics_read",
                    "wildcards",
                    "next_action",
                  ],
                  true,
                ),
              ),
              default: errorResponse(),
            },
          },
        ),
      },
      "/v1/projects/{project_id}/event-property-keys": {
        get: operation("List observed analytics property keys", {
          tags: ["Analytics"],
          description:
            "Discovery helper for segmentation and drop-off analysis. Pass ?events=event_a,event_b,event_c from the saved funnel; the no-events form is intentionally only broad guidance and should not be used to prove a segment property exists.",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { $ref: "#/components/parameters/projectId" },
            {
              name: "events",
              in: "query",
              required: false,
              schema: stringSchema,
            },
          ],
          responses: {
            "200": jsonResponse(
              objectSchema(
                {
                  keys: {
                    type: "object",
                    additionalProperties: arraySchema(stringSchema),
                  },
                  analytics_read: objectSchema(
                    {
                      ok: booleanSchema,
                      status: stringSchema,
                      source: stringSchema,
                      row_count: integerSchema,
                      requested_event_count: integerSchema,
                      observed_event_count: integerSchema,
                      missing_events: arraySchema(stringSchema),
                      queried_at: stringSchema,
                      next_action: stringSchema,
                    },
                    ["ok", "status", "source", "row_count"],
                    true,
                  ),
                  customer_data_filter: customerDataFilterSchema,
                  next_action: stringSchema,
                },
                ["keys", "analytics_read"],
                true,
              ),
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/query-blueprints": {
        get: operation("List query blueprints", {
          operationId: "list_query_blueprints",
          tags: ["Query Blueprints"],
          parameters: [
            {
              name: "category",
              in: "query",
              required: false,
              schema: stringSchema,
            },
          ],
          responses: {
            "200": jsonResponse(queryBlueprintListResponse),
            default: errorResponse(),
          },
        }),
      },
      "/v1/query-blueprints/{blueprint_id}": {
        get: operation("Get query blueprint details", {
          operationId: "get_query_blueprint",
          tags: ["Query Blueprints"],
          parameters: [
            {
              name: "blueprint_id",
              in: "path",
              required: true,
              schema: stringSchema,
            },
          ],
          responses: {
            "200": jsonResponse(queryBlueprintSchema),
            default: errorResponse(),
          },
        }),
      },
      "/v1/projects/{project_id}/query-blueprints/{blueprint_id}/run": {
        post: operation("Run query blueprint", {
          tags: ["Query Blueprints"],
          description:
            "Run a deterministic query template. For funnels, set params from the saved signal map's milestones in the source-backed journey order; never rely on default signup steps unless those events are approved and observed for this project.",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            { $ref: "#/components/parameters/projectId" },
            {
              name: "blueprint_id",
              in: "path",
              required: true,
              schema: stringSchema,
            },
          ],
          requestBody: objectSchema({ params: unknownObjectSchema }),
          requestExample: {
            params: {
              step1: "page_view",
              step2: "signup_completed",
              step3: "subscription_started",
              days: 30,
              segment_property: "utm_source",
            },
          },
          responses: {
            "200": jsonResponse(
              objectSchema({
                blueprint_id: stringSchema,
                title: stringSchema,
                backend: { type: "string", enum: ["analytics", "operational"] },
                rows: arraySchema(unknownObjectSchema),
                columns: arraySchema(stringSchema),
                row_count: integerSchema,
                freshness: objectSchema({
                  source: stringSchema,
                  consistency: stringSchema,
                  cache_bust: booleanSchema,
                  queried_at: stringSchema,
                  query_duration_ms: integerSchema,
                  retry_after_ms: integerSchema,
                  status: stringSchema,
                  next_action: stringSchema,
                }),
                render_hint: unknownObjectSchema,
                next_action: stringSchema,
              }),
              "OK",
              {
                blueprint_id: "active_users_daily",
                title: "Active users by day",
                backend: "analytics",
                rows: [{ day: "2026-06-14", dau: 42 }],
                columns: ["day", "dau"],
                row_count: 1,
                freshness: {
                  source: "posthog_hogql",
                  consistency: "eventual",
                  cache_bust: true,
                  queried_at: "2026-06-16T10:00:00.000Z",
                  query_duration_ms: 832,
                  retry_after_ms: 30000,
                  status: "complete_for_query_time",
                  next_action:
                  "Recently captured customer analytics can take a short time to appear in PostHog; re-run the same bounded blueprint read before making customer-facing claims.",
                },
                render_hint: { type: "line", x: "day", y: "dau" },
                next_action:
                  "Render rows according to render_hint. Columns is metadata for display order.",
              },
            ),
            default: errorResponse(),
          },
        }),
      },
      "/v1/openapi.json": {
        get: operation("Get this OpenAPI schema", {
          tags: ["Discovery"],
          description:
            "Canonical full HTTP schema by default. For onboarding, use ?flow=onboarding or an exact path+method lookup. Retired install-plan, signal-map write, implementation-report, and install-verify operations are absent from the public contract.",
          parameters: [
            queryParam("flow"),
            queryParam("tag"),
            queryParam("path"),
            queryParam("method", {
              type: "string",
              enum: ["get", "post", "put", "patch", "delete"],
            }),
            {
              ...queryParam("include_components", booleanSchema),
              description:
                "Filtered responses default to reference-preserving operations plus only transitively reachable components. Set false only for the larger legacy dereferenced operation form, which omits components.",
            },
            queryParam("index", booleanSchema),
          ],
          responses: {
            "200": jsonResponse(unknownObjectSchema),
          },
        }),
      },
      ...ONBOARDING_V3_OPENAPI_PATHS,
      ...AUTOMATION_OPENAPI_PATHS,
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "http",
          scheme: "bearer",
          description: "Private agentry_sk_ API key.",
        },
        AdminTokenAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Admin bearer token: Authorization: Bearer <ADMIN_TOKEN>.",
        },
        ...ONBOARDING_V3_OPENAPI_COMPONENTS.securitySchemes,
        ...AUTOMATION_OPENAPI_SECURITY_SCHEMES,
      },
      parameters: {
        projectId: {
          name: "project_id",
          in: "path",
          required: true,
          schema: stringSchema,
        },
        caseId: {
          name: "case_id",
          in: "path",
          required: true,
          schema: stringSchema,
        },
        ...ONBOARDING_V3_OPENAPI_COMPONENTS.parameters,
        ...AUTOMATION_OPENAPI_PARAMETERS,
      },
      responses: {
        ...ONBOARDING_V3_OPENAPI_COMPONENTS.responses,
      },
      schemas: {
        PosthogResourcePage: posthogResourcePageSchema,
        PosthogResourceFreshness: posthogResourceFreshnessSchema,
        PosthogResourceDataBoundary: posthogResourceDataBoundarySchema,
        PosthogBoundedValue: posthogBoundedValueSchema,
        PosthogFlagVariant: posthogFlagVariantSchema,
        PosthogSessionRecording: posthogSessionRecordingSchema,
        PosthogFeatureFlag: posthogFeatureFlagSchema,
        PosthogSurveyQuestion: posthogSurveyQuestionSchema,
        PosthogSurvey: posthogSurveySchema,
        PosthogSurveyAnswer: posthogSurveyAnswerSchema,
        PosthogSurveySubmission: posthogSurveyResponseSchema,
        PosthogSurveyStats: posthogSurveyStatsSchema,
        PosthogExperimentMetric: posthogExperimentMetricSchema,
        PosthogExperiment: posthogExperimentSchema,
        PosthogSessionRecordingListResponse: posthogListResponseSchema(
          "session_recordings",
          "#/components/schemas/PosthogSessionRecording",
        ),
        PosthogSessionRecordingResponse: posthogDetailResponseSchema(
          "session_recording",
          "#/components/schemas/PosthogSessionRecording",
        ),
        PosthogFeatureFlagListResponse: posthogListResponseSchema(
          "feature_flags",
          "#/components/schemas/PosthogFeatureFlag",
        ),
        PosthogFeatureFlagResponse: posthogDetailResponseSchema(
          "feature_flag",
          "#/components/schemas/PosthogFeatureFlag",
        ),
        PosthogSurveyListResponse: posthogListResponseSchema(
          "surveys",
          "#/components/schemas/PosthogSurvey",
        ),
        PosthogSurveyDetailResponse: posthogDetailResponseSchema(
          "survey",
          "#/components/schemas/PosthogSurvey",
        ),
        PosthogSurveyResponsesResponse: posthogSurveyResponsesResponseSchema,
        PosthogSurveyStatsResponse: posthogDetailResponseSchema(
          "stats",
          "#/components/schemas/PosthogSurveyStats",
        ),
        PosthogExperimentListResponse: posthogListResponseSchema(
          "experiments",
          "#/components/schemas/PosthogExperiment",
        ),
        PosthogExperimentResponse: posthogDetailResponseSchema(
          "experiment",
          "#/components/schemas/PosthogExperiment",
        ),
        ErrorEnvelope: objectSchema(
          {
            error: objectSchema(
              {
                code: stringSchema,
                message: stringSchema,
                next_action: stringSchema,
                details: unknownObjectSchema,
                request_id: stringSchema,
                retryable: booleanSchema,
              },
              ["code", "message"],
            ),
          },
          ["error"],
        ),
        ProjectDeletionTerminalAuditConflict: objectSchema(
          {
            error: objectSchema(
              {
                code: {
                  type: "string",
                  const: "project_deletion_terminal_audit_conflict",
                },
                message: stringSchema,
                next_action: stringSchema,
                request_id: stringSchema,
                retryable: { type: "boolean", const: false },
                details: objectSchema(
                  {
                    project_id: stringSchema,
                    command_id: stringSchema,
                    expected_audit_id: stringSchema,
                    conflicting_audit_id: stringSchema,
                    retryable: { type: "boolean", const: false },
                    operator_remediation_required: { type: "boolean", const: true },
                    project_preserved: { type: "boolean", const: true },
                  },
                  [
                    "project_id",
                    "command_id",
                    "expected_audit_id",
                    "conflicting_audit_id",
                    "retryable",
                    "operator_remediation_required",
                    "project_preserved",
                  ],
                ),
              },
              ["code", "message", "next_action", "details"],
            ),
          },
          ["error"],
        ),
        PosthogAuthStartResponse: objectSchema(
          {
            authorization_url: stringSchema,
            poll_token: stringSchema,
            expires_in: integerSchema,
            interval: integerSchema,
            next_action: stringSchema,
          },
          [
            "authorization_url",
            "poll_token",
            "expires_in",
            "interval",
            "next_action",
          ],
        ),
        PosthogAuthSuccessResponse: objectSchema(
          {
            status: { type: "string", enum: ["ok"] },
            api_key: stringSchema,
            prefix: stringSchema,
            authorization_id: stringSchema,
            authorization_expires_at: integerSchema,
            user: unknownObjectSchema,
            next_action: stringSchema,
          },
          [
            "status",
            "api_key",
            "prefix",
            "authorization_id",
            "authorization_expires_at",
            "user",
            "next_action",
          ],
        ),
        PosthogAuthPollResponse: {
          oneOf: [
            { $ref: "#/components/schemas/PosthogAuthSuccessResponse" },
            objectSchema(
              {
                status: {
                  type: "string",
                  enum: ["pending", "slow_down", "expired", "failed"],
                },
                interval: integerSchema,
                error_code: stringSchema,
                next_action: stringSchema,
              },
              ["status", "next_action"],
            ),
          ],
        },
        CreateProjectRequest: objectSchema(
          {
            name: stringSchema,
            repo_url: stringSchema,
            default_branch: stringSchema,
            local_path: stringSchema,
          },
          ["name"],
        ),
        ProjectSummary: objectSchema(
          {
            id: stringSchema,
            name: stringSchema,
            repo_url: stringSchema,
            default_branch: stringSchema,
            local_path: stringSchema,
            created_at: integerSchema,
            role: { type: "string", enum: ["owner", "member"] },
          },
          ["id", "name", "created_at"],
        ),
        ProjectDetail: objectSchema(
          {
            id: stringSchema,
            name: stringSchema,
            repo_url: stringSchema,
            default_branch: stringSchema,
            local_path: stringSchema,
            created_at: integerSchema,
            role: { type: "string", enum: ["owner", "member"] },
            analytics: unknownObjectSchema,
            next_action: stringSchema,
          },
          ["id", "name", "created_at", "next_action"],
        ),
        CreateProjectResponse: objectSchema(
          {
            command_id: stringSchema,
            id: stringSchema,
            name: stringSchema,
            role: { type: "string", enum: ["owner", "member"] },
            deploys_url: stringSchema,
            deploys_note: stringSchema,
            idempotent_replay: booleanSchema,
            next_action: stringSchema,
          },
          [
            "command_id",
            "id",
            "name",
            "role",
            "deploys_url",
            "deploys_note",
            "idempotent_replay",
            "next_action",
          ],
        ),
        AutomationDeletionManifest: objectSchema(
          {
            as_of: integerSchema,
            project_ids: { type: "array", items: stringSchema },
            sample_limit: { type: "integer", const: 20 },
            counts: objectSchema(
              {
                enabled_contracts: integerSchema,
                enabled_schedules: integerSchema,
                active_runner_credentials: integerSchema,
                ready_or_claimed_receipts: integerSchema,
                nonterminal_runs: integerSchema,
                active_claims: integerSchema,
                pending_approvals: integerSchema,
                issued_or_consumed_draft_pr_grants: integerSchema,
                known_pr_identifiers: integerSchema,
                known_pr_proof_identifiers: integerSchema,
                known_deploy_identifiers: integerSchema,
                known_external_effects: integerSchema,
                possible_or_unknown_external_effects: integerSchema,
                workflow_v3_project_controls: integerSchema,
                workflow_v3_workflows: integerSchema,
                workflow_v3_revisions: integerSchema,
                workflow_v3_execution_authorities: integerSchema,
                workflow_v3_trigger_receipts: integerSchema,
                workflow_v3_runs: integerSchema,
                workflow_v3_system_node_claims: integerSchema,
                workflow_v3_run_leases: integerSchema,
                workflow_v3_budget_charges: integerSchema,
                workflow_v3_run_states: integerSchema,
                workflow_v3_commands: integerSchema,
                workflow_v3_run_events: integerSchema,
                workflow_v3_suspensions: integerSchema,
                workflow_v3_effects: integerSchema,
                workflow_v3_effect_events: integerSchema,
                workflow_v3_enabled_workflows: integerSchema,
                workflow_v3_ready_trigger_receipts: integerSchema,
                workflow_v3_nonterminal_runs: integerSchema,
                workflow_v3_active_leases: integerSchema,
                workflow_v3_active_system_node_claims: integerSchema,
                workflow_v3_pending_suspensions: integerSchema,
                workflow_v3_external_reserved_effects: integerSchema,
                workflow_v3_external_indeterminate_effects: integerSchema,
                workflow_v3_external_manual_follow_up_effects: integerSchema,
                workflow_v3_external_succeeded_effects: integerSchema,
              },
              [
                "enabled_contracts",
                "enabled_schedules",
                "active_runner_credentials",
                "ready_or_claimed_receipts",
                "nonterminal_runs",
                "active_claims",
                "pending_approvals",
                "issued_or_consumed_draft_pr_grants",
                "known_pr_identifiers",
                "known_pr_proof_identifiers",
                "known_deploy_identifiers",
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
              ],
            ),
            samples: {
              type: "array",
              maxItems: 20,
              items: objectSchema(
                {
                  project_id: stringSchema,
                  kind: {
                    type: "string",
                    enum: [
                      "enabled_contract",
                      "enabled_schedule",
                      "active_runner_credential",
                      "ready_or_claimed_receipt",
                      "nonterminal_run",
                      "active_claim",
                      "pending_approval",
                      "draft_pr_grant",
                      "known_run_effect",
                      "known_deploy",
                      "workflow_v3_enabled_workflow",
                      "workflow_v3_trigger_receipt",
                      "workflow_v3_nonterminal_run",
                      "workflow_v3_active_lease",
                      "workflow_v3_active_system_node_claim",
                      "workflow_v3_pending_suspension",
                      "workflow_v3_effect",
                    ],
                  },
                  id: stringSchema,
                  automation_id: { oneOf: [stringSchema, nullSchema] },
                  run_id: { oneOf: [stringSchema, nullSchema] },
                  status: stringSchema,
                  external_effect_state: {
                    type: "string",
                    enum: ["none_known", "known", "possible_or_unknown"],
                  },
                  recorded_at: { oneOf: [integerSchema, nullSchema] },
                  pr_url: stringSchema,
                  pr_proof_hash: stringSchema,
                  deploy_id: stringSchema,
                  deploy_sha: stringSchema,
                  provider_ref: { type: "string", maxLength: 500 },
                },
                [
                  "project_id",
                  "kind",
                  "id",
                  "automation_id",
                  "run_id",
                  "status",
                  "external_effect_state",
                  "recorded_at",
                ],
              ),
            },
            samples_truncated: booleanSchema,
            external_follow_up: objectSchema(
              {
                required: booleanSchema,
                provider_state_reversible_by_agentry: { type: "boolean", const: false },
                actions: { type: "array", items: stringSchema },
                note: stringSchema,
              },
              ["required", "provider_state_reversible_by_agentry", "actions", "note"],
            ),
          },
          [
            "as_of",
            "project_ids",
            "sample_limit",
            "counts",
            "samples",
            "samples_truncated",
            "external_follow_up",
          ],
        ),
        DeleteProjectResponse: objectSchema(
          {
            id: stringSchema,
            command_id: stringSchema,
            status: { type: "string", enum: ["in_progress", "succeeded"] },
            deleted: booleanSchema,
            project_name: stringSchema,
            cleanup: objectSchema({
              automation_deletion_manifest: {
                $ref: "#/components/schemas/AutomationDeletionManifest",
              },
            }, ["automation_deletion_manifest"], true),
            idempotent_replay: booleanSchema,
            next_action: stringSchema,
          },
          ["id", "command_id", "status", "deleted", "cleanup", "next_action"],
          true,
        ),
        DeployIngestRequest: {
          ...objectSchema(
            {
              sha: stringSchema,
              branch: stringSchema,
              environment: stringSchema,
              message: stringSchema,
              url: stringSchema,
              actor: stringSchema,
              automation_run_id: stringSchema,
              source_commit_sha: stringSchema,
            },
            ["sha"],
            true,
          ),
          dependentRequired: {
            automation_run_id: ["source_commit_sha"],
            source_commit_sha: ["automation_run_id"],
          },
        },
        DeployAcceptedResponse: objectSchema(
          {
            data_boundary: unknownObjectSchema,
            content_inspection: unknownObjectSchema,
            id: stringSchema,
            project_id: stringSchema,
            sha: stringSchema,
            automation_run_id: { oneOf: [stringSchema, nullSchema] },
            source_commit_sha: { oneOf: [stringSchema, nullSchema] },
            received_at: integerSchema,
            idempotent_replay: booleanSchema,
            provenance: objectSchema(
              {
                trust_level: { type: "string", enum: ["trusted_ci"] },
                credential_kind: { type: "string", enum: ["ci_deploy"] },
                credential_id: stringSchema,
              },
              ["trust_level", "credential_kind", "credential_id"],
            ),
            next_action: stringSchema,
          },
          ["id", "project_id", "sha", "received_at", "idempotent_replay"],
          true,
        ),
        CaseStatus: {
          type: "string",
          enum: ["active", "resolved", "suppressed"],
        },
        CaseListStatus: {
          type: "string",
          enum: ["active", "resolved", "suppressed", "all"],
        },
        CaseProjectionRefresh: objectSchema(
          {
            source: {
              type: "string",
              enum: ["posthog_error_tracking"],
            },
            provider_status_filter: {
              type: "string",
              enum: ["all"],
            },
            requested_case_status: {
              $ref: "#/components/schemas/CaseListStatus",
            },
            page_size: integerSchema,
            max_pages: integerSchema,
            pages: integerSchema,
            projected: integerSchema,
            changed: integerSchema,
            complete: {
              ...booleanSchema,
              description:
                "true only when PostHog reported no additional issue page during this bounded refresh.",
            },
            truncated: {
              ...booleanSchema,
              description:
                "true when the owner read reached max_pages while PostHog still reported more issues; local rows beyond next_offset may remain stale until the durable sweep reaches them.",
            },
            next_offset: {
              oneOf: [integerSchema, nullSchema],
              description:
                "Next PostHog issue offset when truncated, otherwise null. This is projection freshness metadata, not the local result-page cursor.",
            },
          },
          [
            "source",
            "provider_status_filter",
            "requested_case_status",
            "page_size",
            "max_pages",
            "pages",
            "projected",
            "changed",
            "complete",
            "truncated",
            "next_offset",
          ],
        ),
        CaseSummary: objectSchema(
          {
            id: stringSchema,
            project_id: stringSchema,
            fingerprint: stringSchema,
            status: { $ref: "#/components/schemas/CaseStatus" },
            revision: integerSchema,
            event_count: integerSchema,
            first_seen_at: integerSchema,
            last_seen_at: integerSchema,
            last_deploy_sha: { oneOf: [stringSchema, nullSchema] },
            latest_observation: objectSchema(
              {
                emitter: unknownObjectSchema,
                evidence: unknownObjectSchema,
                inspection: unknownObjectSchema,
              },
              ["emitter", "evidence", "inspection"],
              true,
            ),
            annotations: unknownObjectSchema,
            last_agent_run_at: { oneOf: [integerSchema, nullSchema] },
            last_agent_run_status: { oneOf: [stringSchema, nullSchema] },
            agent_run_count: integerSchema,
            active_claim: {
              oneOf: [
                objectSchema(
                  {
                    id: stringSchema,
                    automation_id: stringSchema,
                    expires_at: integerSchema,
                  },
                  ["id", "automation_id", "expires_at"],
                ),
                nullSchema,
              ],
            },
          },
          [
            "id",
            "project_id",
            "fingerprint",
            "status",
            "revision",
            "event_count",
            "first_seen_at",
            "last_seen_at",
            "latest_observation",
            "annotations",
            "agent_run_count",
            "active_claim",
          ],
          true,
        ),
        CaseDetail: objectSchema(
          {
            data_boundary: unknownObjectSchema,
            id: stringSchema,
            provider_issue_id: stringSchema,
            project_id: stringSchema,
            fingerprint: stringSchema,
            status: { $ref: "#/components/schemas/CaseStatus" },
            revision: integerSchema,
            event_count: integerSchema,
            first_seen_at: integerSchema,
            last_seen_at: integerSchema,
            last_deploy_sha: { oneOf: [stringSchema, nullSchema] },
            latest_observation: unknownObjectSchema,
            observations: arraySchema(unknownObjectSchema),
            annotations: unknownObjectSchema,
            project_context: unknownObjectSchema,
            recent_deploys: arraySchema({
              $ref: "#/components/schemas/Deploy",
            }),
            affected_users: objectSchema(
              {
                count: integerSchema,
                sample: arraySchema(unknownObjectSchema),
              },
              ["count", "sample"],
              true,
            ),
            control: unknownObjectSchema,
          },
          [
            "data_boundary",
            "id",
            "provider_issue_id",
            "project_id",
            "fingerprint",
            "status",
            "revision",
            "latest_observation",
            "observations",
            "annotations",
            "control",
          ],
          true,
        ),
        UpdateCaseRequest: objectSchema({
          agent_summary: stringSchema,
          pr_url: stringSchema,
        }),
        Deploy: objectSchema(
          {
            id: stringSchema,
            emitter: objectSchema(
              {
                trust_level: { type: "string", enum: ["trusted_ci"] },
                credential_kind: {
                  type: "string",
                  enum: ["ci_deploy"],
                },
                credential_id: stringSchema,
              },
              ["trust_level", "credential_kind", "credential_id"],
            ),
            control: objectSchema(
              {
                automation_run_id: { oneOf: [stringSchema, nullSchema] },
                source_commit_sha: { oneOf: [stringSchema, nullSchema] },
                binding_authority: { oneOf: [stringSchema, nullSchema] },
                attribution_authority: {
                  type: "string",
                  enum: ["credential_bound_ci"],
                },
              },
              ["automation_run_id", "source_commit_sha", "binding_authority", "attribution_authority"],
            ),
            evidence: unknownObjectSchema,
            inspection: unknownObjectSchema,
            received_at: integerSchema,
          },
          ["id", "emitter", "control", "evidence", "inspection", "received_at"],
        ),
        SignalMap: objectSchema(
          {
            project_id: stringSchema,
            contract_version: { type: "string", enum: [ONBOARDING_V3_CONTRACT_VERSION] },
            mode: { type: "string", enum: ["onboarding_v3"] },
            plan_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            business_question: stringSchema,
            plan_markdown: stringSchema,
            source_snapshot: { $ref: "#/components/schemas/OnboardingV3SourceSnapshot" },
            historical_evidence: {
              oneOf: [
                { $ref: "#/components/schemas/OnboardingV3HistoricalEvidence" },
                nullSchema,
              ],
            },
            evidence_status: objectSchema(
              {
                historical: {
                  type: "string",
                  enum: ["not_established", "historically_observed"],
                },
                source: {
                  type: "string",
                  enum: ["pending", "source_verified"],
                },
              },
              ["historical", "source"],
            ),
            milestones: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/OnboardingV3Milestone" },
            },
            failures: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/components/schemas/OnboardingV3Failure" },
            },
            deploy: { $ref: "#/components/schemas/OnboardingV3Deploy" },
            receipt: {
              oneOf: [
                { $ref: "#/components/schemas/OnboardingV3VerifiedReceipt" },
                nullSchema,
              ],
            },
          },
          [
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
          ],
        ),
        ...ONBOARDING_V3_OPENAPI_COMPONENTS.schemas,
        ...AUTOMATION_OPENAPI_SCHEMAS,
      },
    },
  };
  applyMutationRoutePolicies(schema as Record<string, unknown>);
  return schema;
}

function applyMutationRoutePolicies(schema: Record<string, unknown>): void {
  const paths = schema.paths && typeof schema.paths === "object" && !Array.isArray(schema.paths)
    ? schema.paths as Record<string, Record<string, unknown>>
    : {};
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const rawOperation = pathItem[method];
      if (!rawOperation || typeof rawOperation !== "object" || Array.isArray(rawOperation)) continue;
      const routePolicy = mutationRoutePolicyFor(method, path);
      if (!routePolicy) continue;
      const operationRecord = rawOperation as Record<string, unknown>;
      Object.assign(operationRecord, mutationRoutePolicyExtension(routePolicy));

      if (routePolicy.body.kind === "none") {
        delete operationRecord.requestBody;
        operationRecord["x-agentry-request-body"] = "none";
      } else if (routePolicy.body.kind === "json" && routePolicy.body.optional_empty) {
        const requestBody = operationRecord.requestBody;
        if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
          (requestBody as Record<string, unknown>).required = false;
        }
      }

      if (routePolicy.retry.idempotency_key_required) {
        const parameters = Array.isArray(operationRecord.parameters)
          ? [...operationRecord.parameters]
          : [];
        const hasIdempotencyKey = parameters.some((parameter) => {
          if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return false;
          const record = parameter as Record<string, unknown>;
          return record.$ref === "#/components/parameters/idempotencyKey" ||
            (typeof record.name === "string" && record.name.toLowerCase() === "idempotency-key");
        });
        if (!hasIdempotencyKey) {
          parameters.push({ $ref: "#/components/parameters/idempotencyKey" });
          operationRecord.parameters = parameters;
        }
      }
    }
  }
}

const schemaHttpMethods = new Set(["get", "post", "put", "patch", "delete"]);

function openApiPaths(schema: Record<string, unknown>) {
  return schema.paths &&
    typeof schema.paths === "object" &&
    !Array.isArray(schema.paths)
    ? (schema.paths as Record<string, Record<string, unknown>>)
    : {};
}

function openApiFlows(schema: Record<string, unknown>) {
  return schema["x-agentry-flows"] &&
    typeof schema["x-agentry-flows"] === "object" &&
    !Array.isArray(schema["x-agentry-flows"])
    ? (schema["x-agentry-flows"] as Record<string, unknown>)
    : {};
}

function openApiOperationIndex(paths: Record<string, Record<string, unknown>>) {
  const operations: Array<{
    method: string;
    path: string;
    operationId?: string;
    summary?: string;
    tags: string[];
  }> = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      const lowerMethod = method.toLowerCase();
      if (!schemaHttpMethods.has(lowerMethod)) continue;
      const record =
        operation && typeof operation === "object" && !Array.isArray(operation)
          ? (operation as Record<string, unknown>)
          : {};
      operations.push({
        method: lowerMethod,
        path: pathKey,
        operationId:
          typeof record.operationId === "string"
            ? record.operationId
            : undefined,
        summary:
          typeof record.summary === "string" ? record.summary : undefined,
        tags: Array.isArray(record.tags) ? record.tags.map(String) : [],
      });
    }
  }

  return operations.sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}

type OpenApiOperationIndexItem = ReturnType<
  typeof openApiOperationIndex
>[number];

function openApiOperationKey(
  operation: Pick<OpenApiOperationIndexItem, "method" | "path">,
) {
  return `${operation.method.toLowerCase()} ${operation.path}`;
}

const coreAgentOperationKeys = new Set([
  "get /",
  "get /adapters",
  "get /v1/openapi.json",
  "get /v1/setup/manifest",
  `get ${ONBOARDING_SOURCE_SNAPSHOT_PATH}`,
  "post /v1/auth/posthog",
  "post /v1/auth/posthog/poll",
  "get /v1/me",
  "get /v1/projects",
  "post /v1/projects",
  "get /v1/projects/{project_id}",
  "get /v1/projects/{project_id}/setup",
  "get /v1/integrations/posthog/oauth/client",
  "get /v1/projects/{project_id}/posthog-connection",
  "post /v1/projects/{project_id}/posthog-connection",
  "delete /v1/projects/{project_id}/posthog-connection",
  "get /v1/projects/{project_id}/onboarding",
  "post /v1/projects/{project_id}/onboarding",
  "post /v1/projects/{project_id}/onboarding/review",
  "post /v1/projects/{project_id}/onboarding/proof",
  "post /v1/projects/{project_id}/onboarding/verify",
  "get /v1/projects/{project_id}/signal-map",
  "post /v1/deploys/",
  "get /v1/projects/{project_id}/cases",
  "get /v1/cases/{case_id}",
  "post /v1/projects/{project_id}/analytics/query",
  "get /v1/projects/{project_id}/event-names",
  "get /v1/projects/{project_id}/event-property-keys",
  "get /v1/projects/{project_id}/deploys",
]);

const dailyUseOperationKeys = new Set([
  "get /v1/docs/query",
  "get /v1/docs/automation",
  "get /v1/privacy/disclosure",
  "get /v1/capabilities",
  "get /v1/projects/{project_id}/signal-map",
  "get /v1/projects/{project_id}/event-names",
  "get /v1/projects/{project_id}/event-property-keys",
  "get /v1/projects/{project_id}/cases",
  "get /v1/cases/{case_id}",
  "get /v1/projects/{project_id}/deploys",
  "post /v1/projects/{project_id}/analytics/query",
  "get /v1/query-blueprints",
  "get /v1/query-blueprints/{blueprint_id}",
  "post /v1/projects/{project_id}/query-blueprints/{blueprint_id}/run",
  "get /v1/projects/{project_id}/next-steps",
  "get /v1/projects/{project_id}/health",
  "patch /v1/cases/{case_id}",
  "get /v1/cases/{case_id}/users",
  "get /v1/projects/{project_id}/users",
  "get /v1/projects/{project_id}/session-recordings",
  "get /v1/projects/{project_id}/session-recordings/{recording_id}",
  "get /v1/projects/{project_id}/feature-flags",
  "get /v1/projects/{project_id}/feature-flags/{flag_id}",
  "get /v1/projects/{project_id}/surveys",
  "get /v1/projects/{project_id}/surveys/{survey_id}",
  "get /v1/projects/{project_id}/surveys/{survey_id}/responses",
  "get /v1/projects/{project_id}/surveys/{survey_id}/stats",
  "get /v1/projects/{project_id}/experiments",
  "get /v1/projects/{project_id}/experiments/{experiment_id}",
  "post /v1/feedback",
  "get /v1/audit/recent",
]);

const posthogResourceOperationKeys = new Set([
  "get /v1/projects/{project_id}/session-recordings",
  "get /v1/projects/{project_id}/session-recordings/{recording_id}",
  "get /v1/projects/{project_id}/feature-flags",
  "get /v1/projects/{project_id}/feature-flags/{flag_id}",
  "get /v1/projects/{project_id}/surveys",
  "get /v1/projects/{project_id}/surveys/{survey_id}",
  "get /v1/projects/{project_id}/surveys/{survey_id}/responses",
  "get /v1/projects/{project_id}/surveys/{survey_id}/stats",
  "get /v1/projects/{project_id}/experiments",
  "get /v1/projects/{project_id}/experiments/{experiment_id}",
]);

function isCoreAgentOperation(operation: OpenApiOperationIndexItem) {
  return coreAgentOperationKeys.has(openApiOperationKey(operation));
}

function isDailyUseOperation(operation: OpenApiOperationIndexItem) {
  return dailyUseOperationKeys.has(openApiOperationKey(operation));
}

function isPosthogResourceOperation(operation: OpenApiOperationIndexItem) {
  return posthogResourceOperationKeys.has(openApiOperationKey(operation));
}

function advancedCapabilityGroups() {
  return [
    {
      id: "automation",
      use_when:
        "The user asks for alerts, signed webhooks, self-healing software, scheduled agent reports, or other agent-triggered automations.",
      schema_filters: [
        "/v1/openapi.json?flow=automation",
        "/v1/openapi.json?tag=Automation&include_components=false",
        "/v1/openapi.json?tag=Alerts&include_components=false",
        "/v1/openapi.json?tag=Webhooks&include_components=false",
      ],
      guide: "/v1/docs/automation",
      templates: "/v1/automation-playbooks",
      workflow_components: "/v1/automation-workflow-components",
      workflow_contracts: "/v1/automation-workflow-contracts",
      workflow_production_boundary:
        "Workflow v3 currently enables only schedule cron + ordered funnel period comparison + funnel-review agent task + private report; every other graph fails readiness closed.",
    },
    {
      id: "team_billing",
      use_when:
        "The user asks about teammates, invites, Nerve checkout, or the billing portal.",
      schema_filters: [
        "/v1/openapi.json?tag=Invites&include_components=false",
        "/v1/openapi.json?tag=Billing&include_components=false",
      ],
    },
  ];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveOpenApiRef(
  root: Record<string, unknown>,
  ref: string,
): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    if (!isPlainRecord(current)) return undefined;
    current = current[decodeJsonPointerSegment(rawPart)];
  }
  return current;
}

function dereferenceOpenApiValue(
  root: Record<string, unknown>,
  value: unknown,
  seenRefs = new Set<string>(),
  depth = 0,
): unknown {
  if (depth > 24) return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      dereferenceOpenApiValue(root, item, seenRefs, depth + 1),
    );
  }
  if (!isPlainRecord(value)) return value;

  const ref = typeof value.$ref === "string" ? value.$ref : null;
  if (ref) {
    const resolved = resolveOpenApiRef(root, ref);
    if (resolved !== undefined && !seenRefs.has(ref)) {
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(ref);
      const dereferenced = dereferenceOpenApiValue(
        root,
        resolved,
        nextSeenRefs,
        depth + 1,
      );
      const siblingEntries = Object.entries(value).filter(
        ([key]) => key !== "$ref",
      );
      if (siblingEntries.length === 0) return dereferenced;
      if (isPlainRecord(dereferenced)) {
        return {
          ...dereferenced,
          ...Object.fromEntries(
            siblingEntries.map(([key, sibling]) => [
              key,
              dereferenceOpenApiValue(root, sibling, seenRefs, depth + 1),
            ]),
          ),
        };
      }
      return dereferenced;
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      dereferenceOpenApiValue(root, item, seenRefs, depth + 1),
    ]),
  );
}

function dereferenceOpenApiPathItem(
  schema: Record<string, unknown>,
  pathItem: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(pathItem).map(([method, operation]) => [
      method,
      schemaHttpMethods.has(method.toLowerCase())
        ? dereferenceOpenApiValue(schema, operation)
        : operation,
    ]),
  );
}

function openApiComponentLocation(
  ref: string,
): { section: string; name: string } | null {
  if (!ref.startsWith("#/components/")) return null;
  const parts = ref
    .slice(2)
    .split("/")
    .map(decodeJsonPointerSegment);
  if (parts[0] !== "components" || !parts[1] || !parts[2]) return null;
  return { section: parts[1], name: parts[2] };
}

/**
 * Build the smallest components map that resolves every local component ref in
 * the selected filter result. Security requirements name schemes rather than
 * using `$ref`, so those schemes are included through the same closure.
 */
function reachableOpenApiComponents(
  schema: Record<string, unknown>,
  selectedValues: unknown[],
): Record<string, unknown> {
  const sourceComponents = isPlainRecord(schema.components)
    ? schema.components
    : {};
  const selectedComponents: Record<string, Record<string, unknown>> = {};
  const pending = new Map<string, { section: string; name: string }>();
  const visited = new Set<string>();

  const enqueueComponent = (section: string, name: string) => {
    const key = `${section}\u0000${name}`;
    if (!visited.has(key) && !pending.has(key)) {
      pending.set(key, { section, name });
    }
  };

  const scan = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }
    if (!isPlainRecord(value)) return;

    if (typeof value.$ref === "string") {
      const location = openApiComponentLocation(value.$ref);
      if (location) enqueueComponent(location.section, location.name);
    }
    if (Array.isArray(value.security)) {
      for (const requirement of value.security) {
        if (!isPlainRecord(requirement)) continue;
        for (const schemeName of Object.keys(requirement)) {
          enqueueComponent("securitySchemes", schemeName);
        }
      }
    }
    for (const item of Object.values(value)) scan(item);
  };

  for (const value of selectedValues) scan(value);
  while (pending.size > 0) {
    const [key, location] = pending.entries().next().value as [
      string,
      { section: string; name: string },
    ];
    pending.delete(key);
    if (visited.has(key)) continue;
    visited.add(key);

    const rawSourceSection = sourceComponents[location.section];
    const sourceSection = isPlainRecord(rawSourceSection)
      ? rawSourceSection
      : null;
    if (!sourceSection || !(location.name in sourceSection)) continue;
    const entry = sourceSection[location.name];
    selectedComponents[location.section] =
      selectedComponents[location.section] ?? {};
    selectedComponents[location.section]![location.name] = entry;
    scan(entry);
  }

  return Object.keys(selectedComponents).length > 0
    ? { components: selectedComponents }
    : {};
}

function extractFlowOperationRefs(
  flow: unknown,
): Array<{ method: string; path: string }> {
  if (!isPlainRecord(flow)) return [];
  const refs: Array<{ method: string; path: string }> = [];
  const addFromText = (value: unknown) => {
    if (typeof value !== "string") return;
    const matches = value.matchAll(
      /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;]+)/gi,
    );
    for (const match of matches) {
      const method = match[1]?.toLowerCase();
      const path = match[2]?.replace(/[.)\]]+$/g, "");
      if (method && path) refs.push({ method, path });
    }
  };

  const explicitGroups = [flow.operations, flow.support_operations];
  for (const group of explicitGroups) {
    const explicit = Array.isArray(group) ? group : [];
    for (const entry of explicit) {
      if (
        isPlainRecord(entry) &&
        typeof entry.method === "string" &&
        typeof entry.path === "string"
      ) {
        refs.push({ method: entry.method.toLowerCase(), path: entry.path });
      } else {
        addFromText(entry);
      }
    }
  }

  if (Array.isArray(flow.transitions)) {
    for (const transition of flow.transitions) {
      if (isPlainRecord(transition)) addFromText(transition.operation);
      else addFromText(transition);
    }
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.method} ${ref.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filteredOpenApiSchema(options: {
  path?: string;
  method?: string;
  tag?: string;
  flow?: string;
  include_components?: boolean;
  include_advanced?: boolean;
  index?: boolean;
}): { status: 200 | 404; body: unknown } {
  const schema = buildOpenApiSchema() as Record<string, unknown>;
  const paths = openApiPaths(schema);
  const flows = openApiFlows(schema);
  const operations = openApiOperationIndex(paths);
  const availableTags = Array.from(
    new Set(operations.flatMap((operation) => operation.tags)),
  ).sort();
  const availableFlows = Object.keys(flows).sort();
  const includeComponents = options.include_components !== false;
  const canonicalUrl = "/v1/openapi.json";
  const componentMode = includeComponents
    ? "reachable_references"
    : "legacy_dereferenced_without_components";
  const filteredValue = (value: unknown) =>
    includeComponents ? value : dereferenceOpenApiValue(schema, value);
  const filteredPathItem = (pathItem: Record<string, unknown>) =>
    includeComponents
      ? pathItem
      : dereferenceOpenApiPathItem(schema, pathItem);
  const filteredComponents = (...selectedValues: unknown[]) =>
    includeComponents
      ? reachableOpenApiComponents(schema, selectedValues)
      : {};

  function normalizeLookupPath(input: string): string {
    let candidate = input.trim();
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Keep the original value if it is not valid percent-encoding.
    }
    candidate = candidate.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    if (paths[candidate]) return candidate;
    const candidateParts = candidate.split("/").filter(Boolean);
    const match = Object.keys(paths).find((schemaPath) => {
      const schemaParts = schemaPath.split("/").filter(Boolean);
      if (schemaParts.length !== candidateParts.length) return false;
      return schemaParts.every(
        (part, index) =>
          part === candidateParts[index] ||
          (part.startsWith("{") &&
            part.endsWith("}") &&
            candidateParts[index] !== ""),
      );
    });
    return match ?? candidate;
  }

  if (options.flow) {
    const flowKey = options.flow.replace(/-/g, "_");
    const flow = flows[flowKey];
    if (!flow) {
      return {
        status: 404,
        body: {
          error: {
            code: "schema_flow_not_found",
            message: `No Agentry flow named ${options.flow}.`,
            available_flows: availableFlows,
          },
        },
      };
    }
    const filtered: Record<string, Record<string, unknown>> = {};
    const missingOperations: Array<{ method: string; path: string }> = [];
    for (const ref of extractFlowOperationRefs(flow)) {
      const lookupPath = normalizeLookupPath(ref.path);
      const pathItem = paths[lookupPath];
      const operation = pathItem?.[ref.method];
      if (!operation) {
        missingOperations.push({ method: ref.method, path: ref.path });
        continue;
      }
      filtered[lookupPath] = filtered[lookupPath] ?? {};
      filtered[lookupPath]![ref.method] = filteredValue(operation);
    }
    return {
      status: 200,
      body: {
        flow: options.flow,
        definition: flow,
        paths: filtered,
        count: Object.values(filtered).reduce(
          (sum, pathItem) => sum + Object.keys(pathItem).length,
          0,
        ),
        missing_operations: missingOperations,
        ...filteredComponents(flow, filtered),
        component_mode: componentMode,
        canonical_url: canonicalUrl,
        next_action:
          "Follow the flow transitions in order. Use paths[path][method] for flow operations, then query /v1/openapi.json?path=...&method=... when you need one operation in isolation.",
      },
    };
  }

  if (options.path) {
    const lookupPath = normalizeLookupPath(options.path);
    const pathItem = paths[lookupPath];
    if (!pathItem) {
      return {
        status: 404,
        body: {
          error: {
            code: "schema_path_not_found",
            message: `No OpenAPI path found for ${options.path}. Use one of available_paths exactly, including {param} names.`,
            available_paths: Object.keys(paths).sort(),
          },
        },
      };
    }
    if (options.method) {
      const method = options.method.toLowerCase();
      const operation = pathItem[method];
      if (!operation) {
        return {
          status: 404,
          body: {
            error: {
              code: "schema_method_not_found",
              message: `No ${method.toUpperCase()} operation found for ${options.path}.`,
              available_methods: Object.keys(pathItem).sort(),
            },
          },
        };
      }
      const resolvedOperation = filteredValue(operation);
      return {
        status: 200,
        body: {
          path: lookupPath,
          method,
          operation: resolvedOperation,
          paths: {
            [lookupPath]: {
              [method]: resolvedOperation,
            },
          },
          ...filteredComponents(resolvedOperation),
          component_mode: componentMode,
          canonical_url: canonicalUrl,
          next_action:
            "Use paths[path][method] or operation.parameters/requestBody/responses plus components.schemas to build the exact HTTP call.",
        },
      };
    }
    const availableMethods = Object.keys(pathItem)
      .map((method) => method.toLowerCase())
      .filter((method) => schemaHttpMethods.has(method))
      .sort();
    if (availableMethods.length === 1) {
      const method = availableMethods[0]!;
      const resolvedOperation = filteredValue(pathItem[method]);
      const resolvedPathItem = filteredPathItem(pathItem);
      return {
        status: 200,
        body: {
          path: lookupPath,
          method,
          operation: resolvedOperation,
          paths: {
            [lookupPath]: {
              [method]: resolvedOperation,
            },
          },
          operations: resolvedPathItem,
          available_methods: availableMethods,
          ...filteredComponents(resolvedPathItem),
          component_mode: componentMode,
          canonical_url: canonicalUrl,
          next_action:
            "Method was omitted, but this path has one operation. Use paths[path][method] or operation.parameters/requestBody/responses plus components.schemas to build the exact HTTP call.",
        },
      };
    }
    return {
      status: 200,
      body: {
        path: lookupPath,
        operations: filteredPathItem(pathItem),
        available_methods: availableMethods,
        ...filteredComponents(filteredPathItem(pathItem)),
        component_mode: componentMode,
        canonical_url: canonicalUrl,
        next_action:
          "Pick the needed HTTP method from operations, then query path + method for a single operation.",
      },
    };
  }

  if (options.tag) {
    const filtered: Record<string, Record<string, unknown>> = {};
    for (const [pathKey, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const record =
          operation &&
          typeof operation === "object" &&
          !Array.isArray(operation)
            ? (operation as { tags?: unknown })
            : {};
        const tags = Array.isArray(record.tags) ? record.tags.map(String) : [];
        if (!tags.includes(options.tag)) continue;
        filtered[pathKey] = filtered[pathKey] ?? {};
        filtered[pathKey]![method] = filteredValue(operation);
      }
    }
    return {
      status: 200,
      body: {
        tag: options.tag,
        paths: filtered,
        count: Object.values(filtered).reduce(
          (sum, pathItem) => sum + Object.keys(pathItem).length,
          0,
        ),
        ...filteredComponents(filtered),
        component_mode: componentMode,
        canonical_url: canonicalUrl,
        next_action:
          "Use these filtered operations for the selected feature area. Query again with path + method for a single operation.",
      },
    };
  }

  if (options.index) {
    const isOperatorInternalOperation = (operation: { path: string }) =>
      operation.path.startsWith("/admin/") ||
      operation.path === "/v1/auth/_test/login";
    const coreAgentOperations = operations.filter(
      (operation) =>
        !isOperatorInternalOperation(operation) &&
        isCoreAgentOperation(operation),
    );
    const dailyUseOperations = operations.filter(
      (operation) =>
        !isOperatorInternalOperation(operation) &&
        isDailyUseOperation(operation),
    );
    const posthogResourceOperations = operations.filter(
      (operation) =>
        !isOperatorInternalOperation(operation) &&
        isPosthogResourceOperation(operation),
    );
    const advancedAgentOperations = operations.filter(
      (operation) =>
        !isOperatorInternalOperation(operation) &&
        !isCoreAgentOperation(operation) &&
        !isDailyUseOperation(operation),
    );
    const includeAdvanced = options.include_advanced === true;
    const uniqueOperations = (items: OpenApiOperationIndexItem[]) => {
      const seen = new Set<string>();
      return items.filter((item) => {
        const key = openApiOperationKey(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const visibleAgentOperations = includeAdvanced
      ? uniqueOperations([
          ...coreAgentOperations,
          ...dailyUseOperations,
          ...advancedAgentOperations,
        ])
      : uniqueOperations([...coreAgentOperations, ...dailyUseOperations]);
    const operatorInternalOperations = operations.filter(
      isOperatorInternalOperation,
    );
    const uniquePaths = (items: Array<{ path: string }>) =>
      Array.from(new Set(items.map((item) => item.path))).sort();
    return {
      status: 200,
      body: {
        available_filters: {
          flow: availableFlows,
          tag: availableTags,
          path_method:
            "Use one available_operations entry as path + method for a single operation.",
          include_advanced:
            "Set include_advanced=true to list advanced/management operations in this index. Exact path, tag, and full-schema lookups always remain available.",
        },
        available_flows: availableFlows,
        available_tags: availableTags,
        available_paths: uniquePaths(visibleAgentOperations),
        available_operations: visibleAgentOperations,
        core_agent_paths: uniquePaths(coreAgentOperations),
        core_agent_operations: coreAgentOperations,
        daily_use_paths: uniquePaths(dailyUseOperations),
        daily_use_operations: dailyUseOperations,
        posthog_resource_paths: uniquePaths(posthogResourceOperations),
        posthog_resource_operations: posthogResourceOperations,
        agent_facing_paths: uniquePaths(visibleAgentOperations),
        agent_facing_operations: visibleAgentOperations,
        advanced_index_url: "/v1/openapi.json?index=true&include_advanced=true",
        advanced_agent_operations_count: advancedAgentOperations.length,
        advanced_capability_groups: advancedCapabilityGroups(),
        ...(includeAdvanced
          ? {
              advanced_agent_paths: uniquePaths(advancedAgentOperations),
              advanced_agent_operations: advancedAgentOperations,
            }
          : {}),
        operator_internal_paths: uniquePaths(operatorInternalOperations),
        operator_internal_operations: operatorInternalOperations,
        full_schema_url: canonicalUrl,
        all_operations_count: operations.length,
        examples: [
          "/v1/openapi.json?flow=onboarding",
          "/v1/openapi.json?flow=automation",
          "/v1/openapi.json?flow=posthog",
          "/v1/openapi.json?tag=Surveys",
          "/v1/openapi.json?tag=Onboarding&include_components=false",
          "/v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fonboarding&method=post",
        ],
        canonical_url: canonicalUrl,
        next_action: includeAdvanced
          ? "Use core_agent_operations for onboarding/read/write primitives and advanced_agent_operations only for explicit management asks. Pick the narrowest filter and fetch the schema again with flow, tag, or exact path + method before constructing HTTP payloads."
          : "Start with core_agent_operations and /v1/openapi.json?flow=onboarding for onboarding. Use posthog_resource_operations for current recording, flag, survey, and experiment state, and daily_use_operations for normal questions. For self-healing or scheduled agent workflows, go directly to /v1/docs/automation and /v1/openapi.json?flow=automation; do not infer automation from the advanced route list. Set include_advanced=true only for another explicitly requested management surface.",
      },
    };
  }

  return { status: 200, body: schema };
}

const QUERY_DOCS = `# Agentry — agent query reference

Agentry has no built-in dashboard. You are the answer layer: prove the answer
from live product data first, then build a visualization or persistent UI only
when it helps. To answer product questions, start from the project's saved
signal map and its \`source_verified\` receipt, then prove the needed event and
property rows before choosing a query blueprint or custom HogQL. Do not begin
with generic event guesses or default funnel steps.

## Mental model: four read families

Users ask about four things:

| User intent | Agentry concept | Primary endpoint |
|---|---|---|
| "What broke?" / "What errors are open?" | Cases | GET /v1/projects/:id/cases, then GET /v1/cases/:case_id |
| "What did users do?" / funnels / usage / revenue | Analytics | POST /v1/projects/:id/analytics/query or query blueprints |
| "What is configured in PostHog?" / recordings / flags / surveys / experiments | PostHog resources | GET /v1/projects/:id/session-recordings, /feature-flags, /surveys, or /experiments; discover all operations at /v1/openapi.json?flow=posthog |
| "What changed?" / "Did a deploy cause this?" | Deploys | GET /v1/projects/:id/deploys |

Everything else is a helper around those four families. Event-name endpoints help
you write better analytics queries. Query blueprints package common deterministic
reads. Next-steps suggests the next useful workflow from current project state.

## Product-question workflow

1. Read \`GET /v1/projects/:id/signal-map\` for the approved business question,
   connected value-flow explanation, milestones/events/properties, failure
   targets, deploy target, and \`receipt\`. Trust current source semantics only
   when \`receipt.evidence_status\` is \`source_verified\`. If the receipt is null,
   has weaker evidence, or the map is absent, read
   \`GET /v1/projects/:id/onboarding\` and follow its one recovery action.
2. Read \`GET /v1/projects/:id/event-names\` plus
   \`GET /v1/projects/:id/event-property-keys?events=a,b,c\` to confirm live
   non-synthetic event/property coverage for the selected question.
3. For funnels, pick step events from the saved \`milestones\` in the
   source-backed journey order described by \`plan_markdown\`; pass those as
   query-blueprint params. Do not run
   the default signup funnel unless \`page_view\`, \`signup_started\`, and
   \`signup_completed\` are actually the approved signal contract.
   For drop-off by device/source/plan/account type, prefer
   \`funnel_3_step_by_property\` and set \`segment_property\` to the property
   captured on the entry event. Its \`parameterized_required_event_properties\`
   means you must verify the chosen \`segment_property\` on the chosen \`step1\`
   event, not a static default event.
4. If no blueprint fits the approved question, use custom HogQL with the same
   event names/properties. If required events or properties are missing, report
   the readiness gap instead of inventing a metric.

## Answerability states

Classify the answer before rendering a report, dashboard, or product recommendation:

- \`Ready\`: the signal map has a receipt with
  \`evidence_status: "source_verified"\` for the selected question's
  events/properties, those events/properties have live rows, and freshness says
  the read is complete enough for the question.
- \`Queryable but unverified\`: event names or HogQL rows exist, but there is no
  current source-verification receipt. Historical rows can establish
  \`historically_observed\`; answer with that caveat and follow the state's one
  \`next_action\` rather than claiming current source ownership.
- \`Needs more data\`: instrumentation appears wired, but the relevant event has
  no real rows yet or freshness says recent PostHog capture may still be delayed.
  Name the product flow to trigger and retry after \`freshness.retry_after_ms\` when present.
- \`Needs instrumentation\`: required event/property is absent from signal map,
  event names, or property keys. Give the exact missing event/property and the
  source flow that should emit it.

If \`GET /v1/projects/:id/onboarding\` returns 404 or a non-verified state,
treat the project as \`Queryable but unverified\` when event rows exist, not as
automatically empty. Follow the returned state action or start onboarding; never
fall back to a legacy verify report or caller-authored readiness claim.

## Analytics query surfaces

1. **Query blueprints** — deterministic query templates with parameters and render hints.
   - List: GET /v1/query-blueprints (no auth)
   - Detail: GET /v1/query-blueprints/:blueprint_id (no auth)
   - Run: POST /v1/projects/:id/query-blueprints/:blueprint_id/run body: {params: {...}}
2. **Ad-hoc HogQL** — for custom analysis, reports, and dashboards.
   - POST /v1/projects/:id/analytics/query  body: {query: "<HogQL>"}

## Response shape rule

For any Agentry endpoint that returns table-like query output, **read \`rows\` first**.
\`rows\` is always an array of objects keyed by column name:

\`\`\`json
{
  "rows": [{ "event": "signup_completed", "users": 42 }],
  "columns": ["event", "users"],
  "row_count": 1
}
\`\`\`

\`columns\` is metadata for display/order. **Do not read \`results\` from
\`analytics/query\`, query-blueprint runs, or public-query responses.** If an
agent helper expects \`response.results\`, fix the helper; Agentry normalizes
PostHog's internal \`columns\` + \`results\` arrays before they cross
agent-facing query endpoints. Non-tabular reads keep domain names such as \`cases\`,
\`deploys\`, \`session_recordings\`, \`feature_flags\`, \`surveys\`, \`responses\`,
\`stats\`, \`experiments\`, \`analytics_events\`, \`keys\`, \`publications\`, or
\`next_steps\`.

Analytics query responses also include \`freshness\`. PostHog-backed analytics is
eventually consistent after the customer application sends events directly to
PostHog. If you just exercised a product flow and the rows look empty or partial,
do not make customer-facing claims yet: read
\`freshness.retry_after_ms\`, wait at least that long, then re-query with the same
exact event names and run-specific identifiers.

## When to render what

Query blueprints return a \`render_hint\`. Translate it like this:
- \`type: "table"\` → markdown table
- \`type: "line"\` / \`"bar"\` → markdown table + ASCII chart, or Mermaid pie/xychart
- \`type: "funnel"\` → 3-row table (step, count, drop-off %), compute drop-offs from
  consecutive counts: \`drop_n = 1 - (count_{n+1} / count_n)\`
- \`type: "scalar"\` → one-sentence summary
- \`type: "stacked_bar"\` → cohort heatmap if your UI supports it; markdown otherwise

## Analytics schema (PostHog, queried via HogQL)

Each customer has their own PostHog project, isolated from other customers.

### Table: \`events\`
| column | type | meaning |
|---|---|---|
| event | string | The event name (e.g. \`signup_completed\`, \`page_view\`). Required. |
| distinct_id | string | Identity supplied by the customer's official PostHog SDK setup. Verify its source semantics before joining journeys. |
| timestamp | DateTime | When the event happened. |
| properties | Map<string, ?> | Arbitrary key/value sent with the event. |

Event properties come from the customer's existing official PostHog SDK setup
and application instrumentation. Agentry does not inject application telemetry
code, add ambient context, or operate a telemetry transport. Treat common
PostHog properties such as \`$device_type\`, \`$os\`, \`$browser\`, UTM fields, or
application identifiers as available only after they appear on the selected
event and the approved source map establishes their intended meaning.

For funnel drop-off by device, first call
\`GET /v1/projects/:id/event-property-keys?events=<step1>\`. Use
\`segment_property: "$device_type"\` for device class, \`"$os"\` for operating
system, or \`"$browser"\` for browser. Compatibility fields \`$is_mobile\` and
\`$platform\` may also exist in a customer's PostHog setup. Always prove the
chosen key on the selected entry event first. If metadata has
\`analytics_read.status: "partial"\`, its
\`missing_events\` are not safe to segment yet.

For retention, pick an explicit \`activity_event\` from the saved signal map
that proves the user returned or got value. Do not count any event as retention;
page views, background jobs, and server noise can make a dashboard look healthier
than the product really is.

Agentry excludes onboarding-proof synthetic rows and rehearsal/test traffic from
metadata reads and custom \`analytics/query\` event-table reads by default. Pass
\`include_synthetic: true\` only while explicitly debugging the project's marked
onboarding-proof observation. The server-applied predicate is:

\`\`\`sql
WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
\`\`\`

## HogQL primer

HogQL ≈ ClickHouse SQL. The most useful patterns:

\`\`\`sql
-- Time bucketing
SELECT toDate(timestamp) AS day, count() FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} AND timestamp > now() - INTERVAL 7 DAY GROUP BY day
SELECT toMonday(toDate(timestamp)) AS week, count() FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} GROUP BY week

-- Distinct users
SELECT count(DISTINCT distinct_id) FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} AND event = 'page_view'

-- Property access
SELECT properties.\$pathname AS path, count() FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} GROUP BY path ORDER BY count() DESC

-- Funnels (manual)
WITH customer_events AS (SELECT uuid, event, properties, timestamp, distinct_id, elements_chain, created_at, person_id FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}),
     a AS (SELECT distinct_id, min(timestamp) AS t FROM customer_events WHERE event = 'A' GROUP BY distinct_id),
     b AS (SELECT e.distinct_id FROM customer_events e JOIN a ON a.distinct_id = e.distinct_id WHERE e.event = 'B' AND e.timestamp >= a.t)
SELECT (SELECT count() FROM a) AS step1, (SELECT count() FROM b) AS step2

-- Cohort retention skeleton
WITH customer_events AS (SELECT uuid, event, properties, timestamp, distinct_id, elements_chain, created_at, person_id FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}),
     first_signups AS (SELECT distinct_id, min(timestamp) AS first_seen_at FROM customer_events WHERE event = 'signup_completed' GROUP BY distinct_id),
     signups AS (SELECT distinct_id, toMonday(first_seen_at) AS cohort FROM first_signups),
     activity AS (SELECT distinct_id, toMonday(timestamp) AS active_week FROM customer_events WHERE event = 'core_product_event' GROUP BY distinct_id, active_week)
SELECT cohort, active_week, count(DISTINCT signups.distinct_id) FROM signups JOIN activity USING (distinct_id) GROUP BY cohort, active_week ORDER BY cohort, active_week
\`\`\`

## PostHog resource reads

Use \`GET /v1/openapi.json?flow=posthog\` for the canonical session-recording,
feature-flag, survey, and experiment operations. These GET-only endpoints read
live provider state through read-only OAuth and return bounded typed projections
with \`freshness\` and \`data_boundary\`. Recording reads return metadata and a
PostHog \`player_url\`, never replay content. Survey response reads require an
explicit window no longer than 90 days and carry redaction metadata. There is no
experiment-results proxy and no resource mutation authority.

Current provider configuration can answer a direct provider-state question. A
claim about runtime flag application, survey rendering, experiment exposure or
outcome, recording consent, or product behavior still requires the approved
source map plus live event/property, deploy, traffic, and maturity evidence as
appropriate.

## Errors / cases / deploys

PostHog is authoritative for exception events, grouping, lifecycle, affected
users, and symbolication. Agentry projects provider issues into bounded case
control rows and joins them to trusted deploy records. These concepts are
queryable via query blueprints that have \`backend: "operational"\`.
Custom HogQL is exposed for analytics events through
\`POST /v1/projects/:id/analytics/query\`; ad-hoc SQL over Agentry's operational
DB is not exposed. For operational data, use query blueprints or the typed
endpoints (/v1/cases/:id, /v1/projects/:id/deploys,
/v1/projects/:id/cases?status=active).

### \`cases\`
\`id\`, \`provider_issue_id\`, \`fingerprint\`, \`error_type\`, \`message\`, \`status\` (active|resolved|suppressed),
\`event_count\`, \`first_seen_at\`, \`last_seen_at\`, \`last_deploy_sha\`, \`agent_summary\`, \`pr_url\`

### \`deploys\`
\`id\`, \`sha\`, \`branch\`, \`environment\`, \`message\`, \`url\`, \`actor\`, \`received_at\`

## Tips for the agent

1. Read the signal map and require a \`source_verified\` receipt before relying on current source semantics.
2. Classify the user's request as cases, analytics, PostHog resources, deploys, or a combined
   answer before choosing endpoints.
3. For common analytics, use \`GET /v1/query-blueprints\`, but always pass
   params from the saved signal map/funnel instead of accepting defaults blindly.
4. If no blueprint fits, \`POST /v1/projects/:id/analytics/query\` with
   hand-rolled HogQL over the approved event/property contract.
5. ALWAYS validate the rows match the user's question before rendering. If a metric
   looks suspicious, mention it (e.g. "DAU dropped to 0 on Tuesday — likely a tracking
   gap, not a real outage").
6. For visualization in chat: prefer markdown tables for accuracy and ASCII charts for
   shape. Use Mermaid only when the UI supports it. NEVER fabricate data.
`;

// Root discovery points SKILL.md-capable agents to the canonical repository
// copy instead of serving a second authored copy from the API.

router.get("/", (c) => {
  return c.json({
    name: "Agentry",
    version: ONBOARDING_V3_CONTRACT_VERSION,
    contract_version: ONBOARDING_V3_CONTRACT_VERSION,
    deploy_sha: c.env.AGENTRY_DEPLOY_SHA ?? null,
    repository: PUBLIC_REPOSITORY_URL,
    docs: PUBLIC_AGENT_REFERENCE_URL,
    install_docs: PUBLIC_INSTALL_DOC_URL,
    reference_docs: PUBLIC_AGENT_REFERENCE_URL,
    api_schema: "/v1/openapi.json",
    onboarding: "/v1/projects/:project_id/onboarding",
    onboarding_flow: "/v1/openapi.json?flow=onboarding",
    posthog_flow: "/v1/openapi.json?flow=posthog",
    onboarding_source_snapshot_helper: ONBOARDING_SOURCE_SNAPSHOT_PATH,
    automation_docs: "/v1/docs/automation",
    automation_flow: "/v1/openapi.json?flow=automation",
    automation_playbooks: "/v1/automation-playbooks",
    automation_workflow_components: "/v1/automation-workflow-components",
    automation_workflow_contracts: "/v1/automation-workflow-contracts",
    automation_workflow_control:
      "/v1/projects/:project_id/automation-workflow-control",
    capabilities: "/v1/capabilities",
    setup_manifest: "/v1/setup/manifest",
    quick_start: [
      {
        when: "installing",
        action:
          `Fetch ${PUBLIC_INSTALL_DOC_URL} first, resolve auth/project state, then plan from the repo's important business question and funnel/business logic flow before editing code.`,
        urls: [
          PUBLIC_INSTALL_DOC_URL,
          "/v1/setup/manifest",
          "/v1/openapi.json?flow=onboarding",
          "/v1/projects/:project_id/onboarding",
          ONBOARDING_SOURCE_SNAPSHOT_PATH,
        ],
      },
      {
        when: "day_to_day_use",
        action:
          `Fetch ${PUBLIC_AGENT_REFERENCE_URL}. Use the posthog flow for direct provider-state questions; for runtime behavior or effects, start from the saved signal map, its source_verified receipt, and bounded customer PostHog event/property reads before query blueprints or HogQL.`,
        urls: [
          PUBLIC_AGENT_REFERENCE_URL,
          "/v1/openapi.json?flow=posthog",
          "/v1/projects/:project_id/onboarding",
          "/v1/projects/:project_id/signal-map",
          "/v1/projects/:project_id/event-names",
          "/v1/projects/:project_id/event-property-keys",
          "/v1/projects/:project_id/cases",
          "/v1/projects/:project_id/analytics/query",
          "/v1/projects/:project_id/deploys",
          "/v1/query-blueprints",
        ],
      },
      {
        when: "agentic_automation",
        action:
          "Fetch the automation guide and dependency-ordered OpenAPI flow. For workflow v3, read both catalogs, compile/save disabled, pass exact readiness, enable one reviewed revision, and follow only each run's recoverable next_action. The production v3 slice is scheduled funnel review; unsupported graphs remain blocked. For automation v2, select and render one immutable disabled playbook candidate. Never infer scheduler authority, trigger payloads, clocks, or mutation fields from examples.",
        urls: [
          "/v1/docs/automation",
          "/v1/openapi.json?flow=automation",
          "/v1/automation-workflow-components",
          "/v1/automation-workflow-contracts",
          "/v1/projects/:project_id/automation-workflow-control",
          "/v1/automation-playbooks",
          "/v1/projects/:project_id/automation-control",
        ],
      },
      {
        when: "exact_payload_shape",
        action:
          "Fetch a filtered OpenAPI operation schema before mutating calls; do not infer request bodies from prose examples.",
        urls: [
          "/v1/openapi.json?index=true",
          "/v1/openapi.json?flow=onboarding",
          "/v1/openapi.json?flow=automation",
        ],
      },
    ],
    mental_model: {
      customer_data_plane: {
        analytics_and_errors:
          "Applications send telemetry directly to the customer-owned PostHog Cloud project through official PostHog SDKs.",
        source_maps:
          "Release tooling uploads source maps directly with the official PostHog CLI and customer-owned PostHog credentials.",
        agentry_access:
          "Agentry uses read-only PostHog OAuth for bounded queries; it does not proxy or retain the raw event stream.",
      },
      write: [
        {
          concept: "deploys",
          endpoint: "POST /v1/deploys/",
          use_when:
            "CI/provider post-deploy release attribution after a successful deploy",
        },
      ],
      read: [
        {
          concept: "cases",
          endpoint: "GET /v1/projects/:project_id/cases",
          use_when: "what broke",
        },
        {
          concept: "analytics",
          endpoint: "POST /v1/projects/:project_id/analytics/query",
          use_when:
            "what users did; start from the signal map, its source_verified receipt, and bounded customer PostHog event/property reads before query blueprints or custom HogQL",
        },
        {
          concept: "posthog_resources",
          endpoint: "GET /v1/projects/:project_id/{session-recordings|feature-flags|surveys|experiments}",
          use_when:
            "current provider recording metadata, flag definitions, survey definitions/outcomes, or experiment definitions; discover exact operations at /v1/openapi.json?flow=posthog",
        },
        {
          concept: "deploys",
          endpoint: "GET /v1/projects/:project_id/deploys",
          use_when: "what changed",
        },
      ],
      helpers:
        "Query blueprints, event names, public queries, health, and next-steps support the four read families. Provider configuration can answer direct provider-state questions; runtime or effect claims still require the signal map and source-verification receipt.",
    },
    proof_contract: {
      install:
        "Submit a complete source-grounded value-flow plan, get explicit human approval, implement and commit it, submit the final source snapshot, then complete one real proof session for every approved milestone, the safe error, and the exact CI deploy. Follow state.next_action through the five project operations; installation is complete only at status=verified, installation_complete=true, and next_action=null.",
      answering:
        "Before query blueprints or custom HogQL, read the saved signal map, require source_verified for current source semantics, and inspect bounded customer PostHog event/property evidence. If telemetry is missing, name the missing event/property and wire or trigger that product flow.",
    },
    response_shapes: {
      tabular_query_data:
        "Consume `rows` first. Agentry query endpoints return object-shaped rows; `columns` is display/order metadata; `results` is intentionally absent.",
      raw_posthog_shape:
        "PostHog internally returns array rows as `results`, but Agentry normalizes those before they cross agent-facing query endpoints. If a helper reads `response.results`, fix it to read `response.rows`.",
      non_tabular_reads:
        "Typed resources keep domain names such as cases, deploys, session_recordings, feature_flags, surveys, responses, stats, experiments, analytics_events, keys, publications, or next_steps.",
    },
    signal_map: "/v1/projects/:project_id/signal-map",
    skill: PUBLIC_SKILL_URL,
    adapters: "/adapters",
    next_action:
      "Choose one quick_start entry. Installing starts at install_docs and the onboarding flow; direct provider-state questions start at /v1/openapi.json?flow=posthog; runtime and effect answers add the saved signal map and its source_verified receipt; automation starts at /v1/docs/automation plus its filtered flow and immutable playbook catalog. Use exact filtered OpenAPI before every mutation.",
  });
});

// Cross-platform install adapters — thin wrappers over the canonical skill +
// /v1/openapi.json, generated from one source (apps/api/src/adapters.ts) so they
// never drift. The install flow writes the relevant file into the user's repo.
router.get("/adapters", (c) => c.json(adaptersIndex()));
router.get("/adapters/AGENTS.md", (c) =>
  c.text(renderAgentsSection(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/cursor.mdc", (c) =>
  c.text(renderCursorMdc(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/copilot-instructions.md", (c) =>
  c.text(renderCopilotInstructions(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/agentry.instructions.md", (c) =>
  c.text(renderVSCodeInstructions(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/windsurf.md", (c) =>
  c.text(renderWindsurfWorkspaceRule(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/windsurfrules", (c) =>
  c.text(renderWindsurfRules(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/cline.md", (c) =>
  c.text(renderClineRules(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/roo.md", (c) =>
  c.text(renderRooRules(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/continue.md", (c) =>
  c.text(renderContinueRule(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/zed.rules", (c) =>
  c.text(renderZedRules(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/GEMINI.md", (c) =>
  c.text(renderGeminiMd(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/aider-conventions.md", (c) =>
  c.text(renderAiderConventions(), 200, {
    "content-type": "text/markdown; charset=utf-8",
  }),
);
router.get("/adapters/claude-plugin.json", (c) =>
  c.json(renderClaudePluginManifest()),
);

router.get("/v1/capabilities", (c) => {
  return c.json(buildCapabilitiesManifest());
});

router.get("/v1/setup/manifest", (c) => {
  return c.json(buildSetupManifest());
});

function openApiSchemaResponse(c: import("hono").Context<AppBindings>) {
  const includeComponentsParam = c.req.query("include_components");
  const result = filteredOpenApiSchema({
    path: c.req.query("path"),
    method: c.req.query("method")?.toLowerCase(),
    tag: c.req.query("tag"),
    flow: c.req.query("flow"),
    include_components:
      includeComponentsParam === undefined
        ? undefined
        : includeComponentsParam !== "false",
    include_advanced: c.req.query("include_advanced") === "true",
    index: c.req.query("index") === "true",
  });
  if (result.status === 404) return c.json(result.body, 404);
  return c.json(result.body);
}

router.get("/v1/openapi.json", (c) => openApiSchemaResponse(c));

router.get("/v1/docs/query", (c) => {
  return c.text(QUERY_DOCS, 200, {
    "content-type": "text/markdown; charset=utf-8",
  });
});

router.get("/v1/docs/automation", (c) => {
  return c.text(AUTOMATION_DOCS, 200, {
    "content-type": "text/markdown; charset=utf-8",
  });
});

router.get("/v1/privacy/disclosure", (c) => {
  // Returns the canonical privacy-policy clauses for client / server. Customers'
  // policies link here as the authoritative source so we can update without
  // them having to re-edit their policy.
  const variant = (c.req.query("variant") ?? "server").toLowerCase();
  const includeErrors = (c.req.query("errors") ?? "true") !== "false";
  const includeAnalytics = (c.req.query("analytics") ?? "true") !== "false";

  return c.json({
    canonical_url: PUBLIC_PRIVACY_URL,
    variant: variant === "client" ? "client" : "server",
    last_updated: "2026-07-15",
    data_residency: {
      telemetry_backend: "Customer-owned PostHog Cloud project",
      analytics_backend: "PostHog Cloud, selected and controlled by the customer",
      error_backend: "PostHog Cloud Error Tracking",
      sourcemap_storage: "PostHog Cloud via the customer's official PostHog CLI setup",
      agentry_control_plane:
        "Encrypted read-only OAuth access and refresh tokens, connection metadata, bounded/redacted evidence, source-backed plans, deploy evidence, automation state, and immutable receipts",
      transit_encryption: "TLS 1.3 end-to-end",
    },
    includes: {
      errors: includeErrors,
      analytics: includeAnalytics,
    },
    paste_ready_markdown:
      "## Monitoring & analytics\n\n" +
      (includeErrors
        ? `### Error monitoring\n\nOur application sends error telemetry directly to our PostHog Cloud project. [Agentry](${PUBLIC_REPOSITORY_URL}) has read-only access to bounded PostHog evidence so our coding agent can investigate errors and correlate them with reviewed source and deploys. Agentry does not proxy or retain our raw error event stream.`
        : "") +
      (includeAnalytics
        ? "\n\n### Product analytics\n\nOur application sends product analytics directly to our PostHog Cloud project. Agentry may run bounded read-only queries and retain redacted evidence needed for reviewed improvement proposals; it does not proxy telemetry, store raw events, or operate a shadow analytics warehouse."
        : "") +
      "\n\n### Data boundary\n\nPostHog Cloud remains the authoritative store for our analytics and error telemetry. Agentry stores only encrypted connection authorization and bounded control-plane evidence required for source review, deploy correlation, approvals, and automation receipts." +
      `\n\n*The review and automation control plane is provided by [Agentry](${PUBLIC_REPOSITORY_URL}).*\n`,
    learn_more: PUBLIC_REPOSITORY_URL,
  });
});

export default router;
