/** Compact OpenAPI 3.1 fragments for the lean onboarding state machine. */
import {
  ONBOARDING_V3_BROWSER_PROOF_SESSION_STORAGE_KEY,
  ONBOARDING_V3_CONTRACT_VERSION,
  ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE,
  ONBOARDING_V3_RUNTIME_PROOF_PROPERTY,
  ONBOARDING_V3_SOURCE_FINGERPRINT_ALGORITHM,
  ONBOARDING_V3_STATUSES,
} from "./onboarding-v3-contract.js";
import {
  PUBLIC_INSTALL_PROOF_ANCHOR,
  PUBLIC_INSTALL_REVIEW_ANCHOR,
  PUBLIC_INSTALL_VERIFY_ANCHOR,
} from "./public-links.js";
import { ONBOARDING_SOURCE_SNAPSHOT_PATH } from "./onboarding-source-snapshot.js";

type OpenApiObject = Record<string, unknown>;

const ref = (name: string): OpenApiObject => ({ $ref: `#/components/schemas/${name}` });
const parameterRef = (name: string): OpenApiObject => ({
  $ref: `#/components/parameters/${name}`,
});
const responseRef = (name: string): OpenApiObject => ({
  $ref: `#/components/responses/${name}`,
});
const strictObject = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
): OpenApiObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const array = (items: unknown, minItems?: number): OpenApiObject => ({
  type: "array",
  items,
  ...(minItems === undefined ? {} : { minItems }),
});
const string = (maxLength = 1_000): OpenApiObject => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const literal = (value: string | boolean): OpenApiObject => ({
  type: typeof value,
  const: value,
});

const identifier = {
  type: "string",
  minLength: 8,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
} as const;
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" } as const;
const gitSha = {
  oneOf: [
    { type: "string", pattern: "^[a-f0-9]{7,64}$" },
    { type: "null" },
  ],
} as const;
const unixSeconds = { type: "integer", minimum: 0 } as const;
const positiveInteger = { type: "integer", minimum: 1 } as const;
const posthogProjectId = { type: "integer", minimum: 1 } as const;
const posthogBoundary = {
  type: "string",
  enum: ["browser_posthog", "server_posthog"],
} as const;
const opaqueName = {
  ...string(200),
  description: "Repository-chosen opaque value; spelling is not an acceptance signal.",
} as const;
const propertyName = {
  ...string(160),
  description:
    "Repository-chosen opaque key available at this exact boundary. Direct personal data and secret keys are rejected.",
} as const;
const sourceSnapshot = strictObject({
  git_head_sha: gitSha,
  source_fingerprint_sha256: sha256,
  source_fingerprint_algorithm: literal(
    ONBOARDING_V3_SOURCE_FINGERPRINT_ALGORITHM,
  ),
});
const sourceTarget = strictObject({
  file: {
    ...string(800),
    description: "Repository-relative shipped source or configuration path.",
  },
  anchor: {
    ...string(500),
    description: "Exact source text locating the outcome boundary in this file.",
  },
});
const milestone = strictObject({
  event: opaqueName,
  meaning: {
    ...string(),
    description: "Durable value progress proved after this target succeeds.",
  },
  posthog_boundary: posthogBoundary,
  properties: array(propertyName),
  targets: array(ref("OnboardingV3SourceTarget"), 1),
});
const failure = strictObject({
  marker: opaqueName,
  meaning: {
    ...string(),
    description: "Business-impacting failure proved at this exact exit.",
  },
  posthog_boundary: posthogBoundary,
  context: array(propertyName),
  safe_live_proof: { type: "boolean" },
  targets: array(ref("OnboardingV3SourceTarget"), 1),
});
const deploy = strictObject({
  environment: string(160),
  sha_source: { type: "string", enum: ["git_head"] },
  targets: array(ref("OnboardingV3SourceTarget"), 1),
});
const historicalObservationFields = {
  observed_properties: {
    ...array(propertyName),
    maxItems: 100,
    description: "Bounded property identifiers only; never raw values or payload samples.",
  },
  row_count: {
    ...positiveInteger,
    maximum: Number.MAX_SAFE_INTEGER,
  },
};
const historicalObservation = {
  oneOf: [
    strictObject({
      kind: literal("analytics"),
      event: {
        ...opaqueName,
        description: "PostHog event identifier; never a payload sample.",
      },
      ...historicalObservationFields,
    }),
    strictObject({
      kind: literal("error"),
      issue_id: {
        ...identifier,
        description: "Stable PostHog Error Tracking issue identifier; never an error message.",
      },
      ...historicalObservationFields,
    }),
  ],
  discriminator: { propertyName: "kind" },
};
const historicalEvidence = strictObject({
  status: literal("historically_observed"),
  source: literal("posthog_cloud"),
  posthog_project_id: posthogProjectId,
  observed_at: unixSeconds,
  window: strictObject({ from: unixSeconds, to: unixSeconds }),
  query_receipt_sha256: sha256,
  observations: {
    ...array(ref("OnboardingV3HistoricalObservation"), 1),
    maxItems: 200,
    description:
      "Bounded counts, timestamps, signal identifiers, and property identifiers from PostHog. This is non-authorizing historical evidence, never source proof.",
  },
});
const pendingEvidenceStatus = strictObject({
  historical: { type: "string", enum: ["not_established", "historically_observed"] },
  source: literal("pending"),
});
const sourceVerifiedEvidenceStatus = strictObject({
  historical: { type: "string", enum: ["not_established", "historically_observed"] },
  source: literal("source_verified"),
});

const stateIdentity = {
  contract_version: literal(ONBOARDING_V3_CONTRACT_VERSION),
  project_id: identifier,
  onboarding_id: identifier,
  revision: positiveInteger,
  plan_sha256: sha256,
  updated_at: unixSeconds,
};
const stateEtag = { type: "string", pattern: '^"[A-Za-z0-9._:-]+"$' } as const;
const nextOperation = strictObject({
  method: literal("POST"),
  path: {
    ...string(500),
    description: "Exact project-scoped operation that completes this action after its checklist.",
  },
});
const nextAction = (
  id: string,
  instruction: string,
  requiresHuman: boolean,
  checklist: string[],
  completionCondition: string,
  guideAnchor: string,
): OpenApiObject => strictObject({
  id: literal(id),
  instruction: literal(instruction),
  requires_human: literal(requiresHuman),
  operation: nextOperation,
  checklist: {
    type: "array",
    prefixItems: checklist.map(literal),
    minItems: checklist.length,
    maxItems: checklist.length,
  },
  completion_condition: literal(completionCondition),
  guide_anchor: literal(guideAnchor),
});
const proofSession = (status?: "open" | "satisfied") => strictObject({
  proof_session_id: identifier,
  status: status ? literal(status) : { type: "string", enum: ["open", "satisfied"] },
  started_at: unixSeconds,
  expires_at: unixSeconds,
});
const jsonContent = (schemaName: string): OpenApiObject => ({
  content: { "application/json": { schema: ref(schemaName) } },
});

export const ONBOARDING_V3_OPENAPI_SCHEMAS: Record<string, OpenApiObject> = {
  OnboardingV3SourceSnapshot: sourceSnapshot,
  OnboardingV3SourceTarget: sourceTarget,
  OnboardingV3Milestone: milestone,
  OnboardingV3Failure: failure,
  OnboardingV3Deploy: deploy,
  OnboardingV3HistoricalObservation: historicalObservation,
  OnboardingV3HistoricalEvidence: historicalEvidence,
  OnboardingV3Plan: {
    ...strictObject({
      business_question: string(),
      plan_markdown: {
        ...string(65_536),
        description:
          "Human-readable actor or interacting actors, entry, complete connected value flow, first value, business result, failures, and deploy rationale. Multi-actor products include the producer/setup side through the consumer result. Never include credentials or raw telemetry.",
      },
      source_snapshot: ref("OnboardingV3SourceSnapshot"),
      historical_evidence: {
        oneOf: [
          { type: "null" },
          ref("OnboardingV3HistoricalEvidence"),
        ],
        description:
          "Null when no bounded PostHog history has established a matching signal. Historical rows are non-authorizing and never prove current source placement.",
      },
      milestones: {
        ...array(ref("OnboardingV3Milestone"), 1),
        description: "Every material durable transition in the selected value flow.",
      },
      failures: {
        ...array(ref("OnboardingV3Failure"), 1),
        contains: {
          type: "object",
          required: ["safe_live_proof"],
          properties: { safe_live_proof: literal(true) },
        },
        minContains: 1,
        maxContains: 1,
      },
      deploy: ref("OnboardingV3Deploy"),
    }),
  },
  OnboardingV3StartRequest: strictObject({
    intent: literal("start"),
    plan: ref("OnboardingV3Plan"),
  }),
  OnboardingV3ReviewRequest: {
    oneOf: [
      strictObject({ decision: literal("approve"), plan_sha256: sha256 }),
      strictObject({
        decision: literal("replace"),
        plan_sha256: sha256,
        replacement_plan: ref("OnboardingV3Plan"),
      }),
    ],
    discriminator: { propertyName: "decision" },
  },
  OnboardingV3ProofStartRequest: strictObject({
    implementation_source_snapshot: ref("OnboardingV3SourceSnapshot"),
  }),
  OnboardingV3ProofSession: proofSession(),
  OnboardingV3ObservedMilestone: strictObject({
    event: opaqueName,
    posthog_boundary: posthogBoundary,
    required_properties: array(propertyName),
    observed_properties: array(propertyName),
    row_count: positiveInteger,
  }),
  OnboardingV3VerifiedReceipt: strictObject({
    evidence_status: literal("source_verified"),
    source_verified_at: unixSeconds,
    analytics: array(ref("OnboardingV3ObservedMilestone"), 1),
    error: strictObject({
      marker: opaqueName,
      posthog_boundary: posthogBoundary,
      required_context: array(propertyName),
      observed_context: array(propertyName),
      row_count: positiveInteger,
    }),
    deploy: strictObject({
      environment: string(160),
      source_snapshot: ref("OnboardingV3SourceSnapshot"),
      row_count: positiveInteger,
    }),
  }),
  OnboardingV3PlannedNextAction: nextAction(
    "review_exact_plan",
    "Show the bounded historical PostHog evidence, exact source-backed plan, and plan_sha256 to the human, then submit only their explicit approve or replace decision.",
    true,
    [
      "Show the historical evidence window and query receipt separately from the source targets, properties, safe error, deploy boundary, and plan_sha256.",
      "State explicitly that historically_observed rows do not prove current source placement.",
      "Wait for the human to explicitly approve the exact hash or request a replacement.",
      "POST that decision with If-Match set to this state.etag.",
    ],
    "The returned state is approved for this exact plan_sha256.",
    PUBLIC_INSTALL_REVIEW_ANCHOR,
  ),
  OnboardingV3ApprovedNextAction: nextAction(
    "instrument_and_start_proof",
    "Implement the approved plan through the customer's existing official PostHog SDKs, test it, commit a clean tree, capture the final source snapshot, then start proof.",
    false,
    [
      "Use the customer's existing official PostHog SDK configuration; Agentry issues no browser or server telemetry credential.",
      "Add every approved direct-to-PostHog analytics and error capture while preserving correct existing telemetry.",
      "Add the short-lived proof property only when its browser session-storage or trusted server environment value is present; never bundle a marker.",
      "Run relevant tests, commit a clean shipped tree, and capture its final source snapshot.",
      "POST the final snapshot with If-Match set to this state.etag.",
    ],
    "The returned state is proving and fresh runtime and CI proof markers were received.",
    PUBLIC_INSTALL_PROOF_ANCHOR,
  ),
  OnboardingV3ProvingNextAction: nextAction(
    "exercise_and_verify",
    "Deploy the approved final source with the CI marker, then exercise every approved real milestone and safe error with the short-lived PostHog proof property, then verify.",
    false,
    [
      "If either one-time marker was not received, is unavailable, or expired, reread state and restart the proof operation with the same final snapshot and current ETag; keep only the new pair. This is the sole recovery exception to next_action.operation.",
      "For browser_posthog proof, set the marker only in sessionStorage.agentry_onboarding_proof for the proof tab. For server_posthog proof, set AGENTRY_ONBOARDING_PROOF only in the trusted runtime.",
      "Attach that exact marker as the agentry_onboarding_proof property on the approved PostHog analytics and exception captures; it is correlation data, never authorization.",
      "Run the reviewed real deploy with the CI proof marker and final source fingerprint so the committed instrumentation is live.",
      "Exercise every approved milestone through the real product with that runtime proof marker.",
      "Exercise the one approved non-mutating safe error with the runtime proof marker.",
      "POST a bodyless verify request with If-Match set to this state.etag; repeat only returned remaining work.",
    ],
    "The returned state has evidence_status.source source_verified, installation_complete true, and next_action null.",
    PUBLIC_INSTALL_VERIFY_ANCHOR,
  ),
  OnboardingV3PlannedState: strictObject({
    status: literal("planned"),
    installation_complete: { type: "boolean", const: false },
    evidence_status: pendingEvidenceStatus,
    etag: stateEtag,
    next_action: ref("OnboardingV3PlannedNextAction"),
    ...stateIdentity,
    plan: ref("OnboardingV3Plan"),
  }),
  OnboardingV3ApprovedState: strictObject({
    status: literal("approved"),
    installation_complete: { type: "boolean", const: false },
    evidence_status: pendingEvidenceStatus,
    etag: stateEtag,
    next_action: ref("OnboardingV3ApprovedNextAction"),
    ...stateIdentity,
    approved_at: unixSeconds,
    plan: ref("OnboardingV3Plan"),
  }),
  OnboardingV3ProvingState: strictObject({
    status: literal("proving"),
    installation_complete: { type: "boolean", const: false },
    evidence_status: pendingEvidenceStatus,
    etag: stateEtag,
    next_action: ref("OnboardingV3ProvingNextAction"),
    ...stateIdentity,
    implementation_source_snapshot: ref("OnboardingV3SourceSnapshot"),
    proof_session: proofSession("open"),
    plan: ref("OnboardingV3Plan"),
  }),
  OnboardingV3VerifiedState: strictObject({
    status: literal("verified"),
    installation_complete: { type: "boolean", const: true },
    evidence_status: sourceVerifiedEvidenceStatus,
    etag: stateEtag,
    next_action: { type: "null" },
    ...stateIdentity,
    implementation_source_snapshot: ref("OnboardingV3SourceSnapshot"),
    proof_session: proofSession("satisfied"),
    receipt: ref("OnboardingV3VerifiedReceipt"),
    plan: ref("OnboardingV3Plan"),
  }),
  OnboardingV3State: {
    oneOf: ONBOARDING_V3_STATUSES.map((status) =>
      ref(`OnboardingV3${status[0]!.toUpperCase()}${status.slice(1)}State`)
    ),
    discriminator: { propertyName: "status" },
  },
  OnboardingV3RuntimeProofMarker: strictObject({
    property_name: literal(ONBOARDING_V3_RUNTIME_PROOF_PROPERTY),
    value: { type: "string", minLength: 20, maxLength: 1_000 },
    environment_variable: literal(ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE),
    browser_session_storage_key: literal(
      ONBOARDING_V3_BROWSER_PROOF_SESSION_STORAGE_KEY,
    ),
  }),
  OnboardingV3CiProofMarker: strictObject({
    header_name: literal("X-Agentry-Onboarding-Proof"),
    value: { type: "string", minLength: 20, maxLength: 1_000 },
    environment_variable: literal(ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE),
  }),
  OnboardingV3ProofStartResponse: strictObject({
    state: ref("OnboardingV3ProvingState"),
    one_time_markers: strictObject({
      runtime: ref("OnboardingV3RuntimeProofMarker"),
      ci: ref("OnboardingV3CiProofMarker"),
    }),
  }),
  OnboardingV3ProofBlocker: {
    type: "string",
    enum: [
      "proof_session_project_mismatch",
      "proof_session_not_active",
      "proof_session_outside_window",
      "runtime_marker_binding_invalid",
      "ci_credential_binding_unavailable",
      "source_git_sha_missing",
      "analytics_read_failed",
      "safe_error_read_failed",
      "deploy_read_failed",
      "deploy_not_observed",
    ],
  },
  OnboardingV3Remaining: strictObject({
    analytics: strictObject({
      blockers: array(ref("OnboardingV3ProofBlocker")),
      milestones: array(strictObject({
        milestone_index: { type: "integer", minimum: 0 },
        event: opaqueName,
        posthog_boundary: posthogBoundary,
      })),
      properties: array(strictObject({
        milestone_index: { type: "integer", minimum: 0 },
        event: opaqueName,
        properties: {
          ...array(propertyName, 1),
          description: "Approved keys that must be present and nonempty together on the proof-tagged PostHog event.",
        },
        requirement: {
          type: "string",
          enum: ["present_and_nonempty_together"],
        },
      })),
    }),
    safe_error: {
      oneOf: [
        { type: "null" },
        strictObject({
          marker: opaqueName,
          posthog_boundary: posthogBoundary,
          marker_missing: { type: "boolean" },
          context: array(propertyName),
          context_requirement: literal("present_and_nonempty_together"),
          blockers: array(ref("OnboardingV3ProofBlocker")),
        }),
      ],
    },
    deploy: {
      oneOf: [
        { type: "null" },
        strictObject({
          environment: string(160),
          blockers: array(ref("OnboardingV3ProofBlocker"), 1),
        }),
      ],
    },
  }),
  OnboardingV3VerifyResponse: {
    oneOf: [
      strictObject({
        ok: literal(false),
        state: ref("OnboardingV3ProvingState"),
        remaining: ref("OnboardingV3Remaining"),
      }),
      strictObject({
        ok: literal(true),
        state: ref("OnboardingV3VerifiedState"),
        remaining: ref("OnboardingV3Remaining"),
      }),
    ],
    discriminator: { propertyName: "ok" },
  },
  AgentErrorResponse: strictObject({
    error: strictObject({
      code: string(160),
      message: string(2_000),
      next_action: string(2_000),
      details: { type: "object", additionalProperties: true },
    }, ["code", "message"]),
  }),
};

export const ONBOARDING_V3_OPENAPI_PARAMETERS: Record<string, OpenApiObject> = {
  projectId: {
    name: "project_id",
    in: "path",
    required: true,
    schema: identifier,
  },
  ifMatchCurrent: {
    name: "If-Match",
    in: "header",
    required: true,
    schema: stateEtag,
    description: "Current state.etag. On 412, read state and retry only if still applicable.",
  },
  ifMatchStart: {
    name: "If-Match",
    in: "header",
    required: false,
    schema: stateEtag,
    description: "Omit only when no onboarding exists; replacing a current plan requires state.etag.",
  },
};

export const ONBOARDING_V3_OPENAPI_RESPONSES: Record<string, OpenApiObject> = {
  AgentError: {
    description: "Agent-readable failure with a stable code and recovery action.",
    ...jsonContent("AgentErrorResponse"),
  },
};

export const ONBOARDING_V3_OPENAPI_COMPONENTS = {
  schemas: ONBOARDING_V3_OPENAPI_SCHEMAS,
  parameters: ONBOARDING_V3_OPENAPI_PARAMETERS,
  responses: ONBOARDING_V3_OPENAPI_RESPONSES,
  securitySchemes: {
    ownerApiKey: { type: "http", scheme: "bearer", bearerFormat: "agentry_sk_" },
  },
} as const;

const ownerSecurity = [{ ownerApiKey: [] }];
const errorResponses = { default: responseRef("AgentError") };
const projectId = parameterRef("projectId");
const currentEtag = parameterRef("ifMatchCurrent");
const operation = (input: OpenApiObject): OpenApiObject => ({
  tags: ["Onboarding"],
  security: ownerSecurity,
  "x-agentry-flow": "onboarding_v3",
  ...input,
});
const requestBody = (schemaName: string): OpenApiObject => ({
  required: true,
  ...jsonContent(schemaName),
});
const stateResponse = (description: string): OpenApiObject => ({
  description,
  ...jsonContent("OnboardingV3State"),
});

export const ONBOARDING_V3_OPENAPI_PROJECT_PATHS: Record<string, OpenApiObject> = {
  "/v1/projects/{project_id}/onboarding": {
    get: operation({
      operationId: "read_onboarding_v3",
      summary: "Read current onboarding state",
      description:
        "Read before each action. A 404 means discovery has not started; create a source snapshot, deeply scan the shipped product and deployment surfaces, then submit the complete plan.",
      parameters: [projectId],
      responses: {
        "200": stateResponse("Current planned, approved, proving, or verified state."),
        ...errorResponses,
      },
    }),
    post: operation({
      operationId: "start_onboarding_v3",
      summary: "Start or replace onboarding from complete discovery",
      description:
        "First audit a bounded window of the connected customer-owned PostHog Cloud project. Persist only counts, timestamps, signal/property identifiers, project identity, and a query-receipt hash; never raw payloads. Then deeply scan shipped docs and UI, routes/actions/jobs/webhooks, persistence, tests, existing telemetry, and CI/provider configuration. Map the actor and entry through every material durable transition, first value, and business result. Historical rows are non-authorizing and do not prove current source placement. Names are opaque. Do not truncate the flow to a fixed size.",
      parameters: [projectId, parameterRef("ifMatchStart")],
      requestBody: requestBody("OnboardingV3StartRequest"),
      responses: {
        "200": stateResponse("Replacement planned state."),
        "201": stateResponse("New planned state."),
        ...errorResponses,
      },
    }),
  },
  "/v1/projects/{project_id}/onboarding/review": {
    post: operation({
      operationId: "review_onboarding_v3",
      summary: "Approve or replace the exact plan",
      description:
        "Show the full plan to the human. Only their explicit decision approves the exact plan hash or replaces it with a fresh complete plan.",
      parameters: [projectId, currentEtag],
      requestBody: requestBody("OnboardingV3ReviewRequest"),
      responses: {
        "200": stateResponse("Approved state or replacement planned state."),
        ...errorResponses,
      },
    }),
  },
  "/v1/projects/{project_id}/onboarding/proof": {
    post: operation({
      operationId: "start_onboarding_v3_proof",
      summary: "Start live proof from the final committed source",
      description:
        "After approval, use the customer's existing official PostHog SDKs to capture analytics after every approved durable success and exceptions at approved failure exits. Agentry provides no browser or server telemetry credential. Test, commit a clean shipped tree, run the source helper with --final, and submit only its snapshot. Attach the returned short-lived runtime marker as the agentry_onboarding_proof PostHog event property while exercising real product paths. Use the separate CI marker header only on trusted Agentry deploy attribution. Neither marker authorizes writes.",
      parameters: [projectId, currentEtag],
      requestBody: requestBody("OnboardingV3ProofStartRequest"),
      responses: {
        "201": {
          description: "Proving state plus a one-time PostHog event-property marker and a distinct CI header marker.",
          ...jsonContent("OnboardingV3ProofStartResponse"),
        },
        ...errorResponses,
      },
    }),
  },
  "/v1/projects/{project_id}/onboarding/verify": {
    post: operation({
      operationId: "verify_onboarding_v3",
      summary: "Establish source_verified from reviewed real execution",
      "x-agentry-request-body": "none",
      description:
        "Send no body. Through the connected read-only PostHog OAuth query path, verification checks the short-lived proof property on every approved event/property and on the selected $exception failure marker/context. It separately checks trusted Agentry CI deploy attribution against the active proof session. No PostHog row is matched by an Agentry browser/server credential or public-key hash. If incomplete, follow the structured remaining analytics, safe_error, and deploy groups, run only those real paths, read the new ETag, and retry. Historical rows never satisfy this operation. Completion requires evidence_status.source=source_verified and a bounded source-verification receipt.",
      parameters: [projectId, currentEtag],
      responses: {
        "200": {
          description: "Structured remaining source proof or a source_verified state and receipt.",
          ...jsonContent("OnboardingV3VerifyResponse"),
        },
        ...errorResponses,
      },
    }),
  },
};

export const ONBOARDING_V3_OPENAPI_SUPPORT_PATHS: Record<string, OpenApiObject> = {
  [ONBOARDING_SOURCE_SNAPSHOT_PATH]: {
    get: {
      operationId: "get_onboarding_v3_source_snapshot_helper",
      summary: "Download the source snapshot helper",
      description:
        "Public Node 20+ helper. Run it before planning; after implementation and a clean commit run it with --final. It prints only the source snapshot accepted by start and proof.",
      tags: ["Onboarding support"],
      security: [],
      "x-agentry-flow": "onboarding_v3",
      "x-agentry-support-operation": true,
      responses: {
        "200": {
          description: "Executable ECMAScript module.",
          content: { "text/javascript": { schema: { type: "string" } } },
        },
        "304": { description: "Cached helper is current." },
        ...errorResponses,
      },
    },
  },
};

export const ONBOARDING_V3_OPENAPI_PATHS: Record<string, OpenApiObject> = {
  ...ONBOARDING_V3_OPENAPI_PROJECT_PATHS,
  ...ONBOARDING_V3_OPENAPI_SUPPORT_PATHS,
};

export const ONBOARDING_V3_OPENAPI_FLOW = {
  id: "onboarding_v3",
  operation_count: 5,
  support_operation_count: 1,
  operations: [
    { method: "get", path: "/v1/projects/{project_id}/onboarding" },
    { method: "post", path: "/v1/projects/{project_id}/onboarding" },
    { method: "post", path: "/v1/projects/{project_id}/onboarding/review" },
    { method: "post", path: "/v1/projects/{project_id}/onboarding/proof" },
    { method: "post", path: "/v1/projects/{project_id}/onboarding/verify" },
  ],
  support_operations: [
    { method: "get", path: ONBOARDING_SOURCE_SNAPSHOT_PATH },
  ],
  statuses: ONBOARDING_V3_STATUSES,
  status_actions: {
    planned: "Get explicit human review, then POST /review.",
    approved: "Implement, test, commit clean source, then POST /proof.",
    proving: "Run real approved paths, then POST /verify.",
    verified: "Installation is complete because evidence_status.source is source_verified.",
  },
  prerequisite_operations: [
    { method: "post", path: "/v1/auth/posthog", schema_url: "/v1/openapi.json?path=%2Fv1%2Fauth%2Fposthog&method=post" },
    { method: "post", path: "/v1/auth/posthog/poll", schema_url: "/v1/openapi.json?path=%2Fv1%2Fauth%2Fposthog%2Fpoll&method=post" },
    { method: "post", path: "/v1/projects", schema_url: "/v1/openapi.json?path=%2Fv1%2Fprojects&method=post" },
    { method: "post", path: "/v1/projects/{project_id}/credentials", schema_url: "/v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcredentials&method=post" },
  ],
  source_snapshot_helper: {
    method: "get",
    path: ONBOARDING_SOURCE_SNAPSHOT_PATH,
  },
} as const;

export const ONBOARDING_V3_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Agentry onboarding",
    version: ONBOARDING_V3_CONTRACT_VERSION,
    description: "Lean plan, human review, real telemetry proof, and verification.",
  },
  paths: ONBOARDING_V3_OPENAPI_PATHS,
  components: ONBOARDING_V3_OPENAPI_COMPONENTS,
  "x-agentry-flow": ONBOARDING_V3_OPENAPI_FLOW,
} as const;
