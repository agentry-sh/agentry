import { z } from "zod";
import {
  PUBLIC_INSTALL_PROOF_ANCHOR,
  PUBLIC_INSTALL_REVIEW_ANCHOR,
  PUBLIC_INSTALL_VERIFY_ANCHOR,
} from "./public-links.js";

export const ONBOARDING_V3_CONTRACT_VERSION = "3" as const;
export const ONBOARDING_V3_SOURCE_FINGERPRINT_ALGORITHM =
  "agentry-source-tree-sha256-v1" as const;
export const ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE =
  "AGENTRY_ONBOARDING_PROOF" as const;
export const ONBOARDING_V3_BROWSER_PROOF_SESSION_STORAGE_KEY =
  "agentry_onboarding_proof" as const;
export const ONBOARDING_V3_RUNTIME_PROOF_PROPERTY =
  "agentry_onboarding_proof" as const;
export const ONBOARDING_V3_STATUSES = [
  "planned",
  "approved",
  "proving",
  "verified",
] as const;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const RAW_CREDENTIAL =
  /\bagentry_(?:sk|pk|server|ci|runner)_(?!api_key\b)[A-Za-z0-9._-]{6,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i;
const DIRECT_SENSITIVE_PROPERTY_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "card_number",
  "cookie",
  "credit_card_number",
  "email",
  "first_name",
  "full_name",
  "ip_address",
  "last_name",
  "password",
  "password_hash",
  "phone",
  "phone_number",
  "raw_ip",
  "refresh_token",
  "secret",
  "set_cookie",
  "street_address",
  "token",
]);

const opaqueString = (minimum: number, maximum: number) =>
  z.string().trim().min(minimum).max(maximum).refine(
    (value) => !CONTROL_CHARACTERS.test(value),
    "value cannot contain control characters",
  );

const sourceAnchorString = z.string().trim().min(1).max(500).refine(
  (value) => !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  "source anchor cannot contain unsafe control characters",
);

const IdSchema = z.string().trim().min(8).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const GitShaSchema = z.string().regex(/^[a-f0-9]{7,64}$/).nullable();
const StrongEtagSchema = z.string().regex(/^"[A-Za-z0-9._:-]+"$/);
const UnixSecondsSchema = z.number().int().nonnegative();
const PosthogBoundarySchema = z.enum(["browser_posthog", "server_posthog"]);
const PosthogProjectIdSchema = z.number().int().positive();

function normalizePropertyName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const PropertyNameSchema = opaqueString(1, 160).superRefine((value, ctx) => {
  if (DIRECT_SENSITIVE_PROPERTY_KEYS.has(normalizePropertyName(value))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "direct secrets and personal data are not safe baseline properties",
    });
  }
});

function containsRawCredential(value: unknown): boolean {
  return RAW_CREDENTIAL.test(JSON.stringify(value));
}

function isSafeSourcePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("./") || value.includes("\\")) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export const OnboardingV3SourceSnapshotSchema = z.object({
  git_head_sha: GitShaSchema,
  source_fingerprint_sha256: Sha256Schema,
  source_fingerprint_algorithm: z.literal(
    ONBOARDING_V3_SOURCE_FINGERPRINT_ALGORITHM,
  ),
}).strict();

export const OnboardingV3SourceTargetSchema = z.object({
  file: opaqueString(1, 800).refine(
    isSafeSourcePath,
    "file must be a repository-relative source path without traversal",
  ),
  anchor: sourceAnchorString,
}).strict();

export const OnboardingV3MilestoneSchema = z.object({
  event: opaqueString(1, 200),
  meaning: opaqueString(1, 1_000),
  posthog_boundary: PosthogBoundarySchema,
  properties: z.array(PropertyNameSchema),
  targets: z.array(OnboardingV3SourceTargetSchema).min(1),
}).strict();

export const OnboardingV3FailureSchema = z.object({
  marker: opaqueString(1, 200),
  meaning: opaqueString(1, 1_000),
  posthog_boundary: PosthogBoundarySchema,
  context: z.array(PropertyNameSchema),
  safe_live_proof: z.boolean(),
  targets: z.array(OnboardingV3SourceTargetSchema).min(1),
}).strict();

export const OnboardingV3DeploySchema = z.object({
  environment: opaqueString(1, 160),
  sha_source: z.literal("git_head"),
  targets: z.array(OnboardingV3SourceTargetSchema).min(1),
}).strict();

export const OnboardingV3HistoricalObservationSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("analytics"),
      event: opaqueString(1, 200),
      observed_properties: z.array(PropertyNameSchema).max(100),
      row_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
    z.object({
      kind: z.literal("error"),
      issue_id: IdSchema,
      observed_properties: z.array(PropertyNameSchema).max(100),
      row_count: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  ],
);

/**
 * A bounded audit receipt from the customer-owned PostHog Cloud project.
 * It is intentionally plan input rather than source proof: the exact audit is
 * reviewed with the source-backed plan, but old rows cannot attest current
 * source placement.
 */
export const OnboardingV3HistoricalEvidenceSchema = z.object({
  status: z.literal("historically_observed"),
  source: z.literal("posthog_cloud"),
  posthog_project_id: PosthogProjectIdSchema,
  observed_at: UnixSecondsSchema,
  window: z.object({
    from: UnixSecondsSchema,
    to: UnixSecondsSchema,
  }).strict(),
  query_receipt_sha256: Sha256Schema,
  observations: z.array(OnboardingV3HistoricalObservationSchema).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  if (value.window.to <= value.window.from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["window", "to"],
      message: "historical evidence window must end after it starts",
    });
  }
  if (value.observed_at < value.window.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_at"],
      message: "historical evidence cannot be observed before its window ends",
    });
  }
});

export const OnboardingV3EvidenceStatusSchema = z.object({
  historical: z.enum(["not_established", "historically_observed"]),
  source: z.enum(["pending", "source_verified"]),
}).strict();

const OnboardingV3PendingEvidenceStatusSchema = z.object({
  historical: z.enum(["not_established", "historically_observed"]),
  source: z.literal("pending"),
}).strict();

const OnboardingV3SourceVerifiedEvidenceStatusSchema = z.object({
  historical: z.enum(["not_established", "historically_observed"]),
  source: z.literal("source_verified"),
}).strict();

export const OnboardingV3PlanSchema = z.object({
  business_question: opaqueString(1, 1_000),
  plan_markdown: z.string().trim().min(1).max(65_536)
    .refine((value) => !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
      "plan markdown cannot contain unsafe control characters"),
  source_snapshot: OnboardingV3SourceSnapshotSchema,
  historical_evidence: OnboardingV3HistoricalEvidenceSchema.nullable(),
  milestones: z.array(OnboardingV3MilestoneSchema).min(1),
  failures: z.array(OnboardingV3FailureSchema).min(1),
  deploy: OnboardingV3DeploySchema,
}).strict().superRefine((value, ctx) => {
  if (value.failures.filter((failure) => failure.safe_live_proof).length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failures"],
      message: "exactly one failure must be selected for safe live proof",
    });
  }
  if (containsRawCredential(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "telemetry plans cannot contain raw credential material",
    });
  }
});

export const OnboardingV3StartRequestSchema = z.object({
  intent: z.literal("start"),
  plan: OnboardingV3PlanSchema,
}).strict();

export const OnboardingV3ReviewRequestSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    plan_sha256: Sha256Schema,
  }).strict(),
  z.object({
    decision: z.literal("replace"),
    plan_sha256: Sha256Schema,
    replacement_plan: OnboardingV3PlanSchema,
  }).strict(),
]);

export const OnboardingV3ProofStartRequestSchema = z.object({
  implementation_source_snapshot: OnboardingV3SourceSnapshotSchema,
}).strict();

export const OnboardingV3ProofSessionSchema = z.object({
  proof_session_id: IdSchema,
  status: z.enum(["open", "satisfied"]),
  started_at: UnixSecondsSchema,
  expires_at: UnixSecondsSchema,
}).strict().superRefine((value, ctx) => {
  if (value.expires_at <= value.started_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "proof expiry must follow proof start",
    });
  }
});

export const OnboardingV3ObservedMilestoneSchema = z.object({
  event: opaqueString(1, 200),
  posthog_boundary: PosthogBoundarySchema,
  required_properties: z.array(PropertyNameSchema),
  observed_properties: z.array(PropertyNameSchema),
  row_count: z.number().int().positive(),
}).strict();

export const OnboardingV3VerifiedReceiptSchema = z.object({
  evidence_status: z.literal("source_verified"),
  source_verified_at: UnixSecondsSchema,
  analytics: z.array(OnboardingV3ObservedMilestoneSchema).min(1),
  error: z.object({
    marker: opaqueString(1, 200),
    posthog_boundary: PosthogBoundarySchema,
    required_context: z.array(PropertyNameSchema),
    observed_context: z.array(PropertyNameSchema),
    row_count: z.number().int().positive(),
  }).strict(),
  deploy: z.object({
    environment: opaqueString(1, 160),
    source_snapshot: OnboardingV3SourceSnapshotSchema,
    row_count: z.number().int().positive(),
  }).strict(),
}).strict();

export function onboardingV3EvidenceStatus(
  plan: z.infer<typeof OnboardingV3PlanSchema>,
  source: "pending" | "source_verified" = "pending",
) {
  return OnboardingV3EvidenceStatusSchema.parse({
    historical: plan.historical_evidence
      ? "historically_observed"
      : "not_established",
    source,
  });
}

const ApiOperationSchema = z.object({
  method: z.literal("POST"),
  path: opaqueString(1, 500),
}).strict();

const REVIEW_INSTRUCTION =
  "Show the bounded historical PostHog evidence, exact source-backed plan, and plan_sha256 to the human, then submit only their explicit approve or replace decision.";
const APPROVED_INSTRUCTION =
  "Implement the approved plan through the customer's existing official PostHog SDKs, test it, commit a clean tree, capture the final source snapshot, then start proof.";
const PROVING_INSTRUCTION =
  "Deploy the approved final source with the CI marker, then exercise every approved real milestone and safe error with the short-lived PostHog proof property, then verify.";

export const OnboardingV3PlannedNextActionSchema = z.object({
  id: z.literal("review_exact_plan"),
  instruction: z.literal(REVIEW_INSTRUCTION),
  requires_human: z.literal(true),
  operation: ApiOperationSchema,
  checklist: z.tuple([
    z.literal("Show the historical evidence window and query receipt separately from the source targets, properties, safe error, deploy boundary, and plan_sha256."),
    z.literal("State explicitly that historically_observed rows do not prove current source placement."),
    z.literal("Wait for the human to explicitly approve the exact hash or request a replacement."),
    z.literal("POST that decision with If-Match set to this state.etag."),
  ]),
  completion_condition: z.literal(
    "The returned state is approved for this exact plan_sha256.",
  ),
  guide_anchor: z.literal(
    PUBLIC_INSTALL_REVIEW_ANCHOR,
  ),
}).strict();

export const OnboardingV3ApprovedNextActionSchema = z.object({
  id: z.literal("instrument_and_start_proof"),
  instruction: z.literal(APPROVED_INSTRUCTION),
  requires_human: z.literal(false),
  operation: ApiOperationSchema,
  checklist: z.tuple([
    z.literal("Use the customer's existing official PostHog SDK configuration; Agentry issues no browser or server telemetry credential."),
    z.literal("Add every approved direct-to-PostHog analytics and error capture while preserving correct existing telemetry."),
    z.literal("Add the short-lived proof property only when its browser session-storage or trusted server environment value is present; never bundle a marker."),
    z.literal("Run relevant tests, commit a clean shipped tree, and capture its final source snapshot."),
    z.literal("POST the final snapshot with If-Match set to this state.etag."),
  ]),
  completion_condition: z.literal(
    "The returned state is proving and fresh runtime and CI proof markers were received.",
  ),
  guide_anchor: z.literal(
    PUBLIC_INSTALL_PROOF_ANCHOR,
  ),
}).strict();

export const OnboardingV3ProvingNextActionSchema = z.object({
  id: z.literal("exercise_and_verify"),
  instruction: z.literal(PROVING_INSTRUCTION),
  requires_human: z.literal(false),
  operation: ApiOperationSchema,
  checklist: z.tuple([
    z.literal("If either one-time marker was not received, is unavailable, or expired, reread state and restart the proof operation with the same final snapshot and current ETag; keep only the new pair. This is the sole recovery exception to next_action.operation."),
    z.literal("For browser_posthog proof, set the marker only in sessionStorage.agentry_onboarding_proof for the proof tab. For server_posthog proof, set AGENTRY_ONBOARDING_PROOF only in the trusted runtime."),
    z.literal("Attach that exact marker as the agentry_onboarding_proof property on the approved PostHog analytics and exception captures; it is correlation data, never authorization."),
    z.literal("Run the reviewed real deploy with the CI proof marker and final source fingerprint so the committed instrumentation is live."),
    z.literal("Exercise every approved milestone through the real product with that runtime proof marker."),
    z.literal("Exercise the one approved non-mutating safe error with the runtime proof marker."),
    z.literal("POST a bodyless verify request with If-Match set to this state.etag; repeat only returned remaining work."),
  ]),
  completion_condition: z.literal(
    "The returned state has evidence_status.source source_verified, installation_complete true, and next_action null.",
  ),
  guide_anchor: z.literal(
    PUBLIC_INSTALL_VERIFY_ANCHOR,
  ),
}).strict();

export function onboardingV3PlannedNextAction(projectId: string) {
  const id = IdSchema.parse(projectId);
  return OnboardingV3PlannedNextActionSchema.parse({
    id: "review_exact_plan",
    instruction: REVIEW_INSTRUCTION,
    requires_human: true,
    operation: { method: "POST", path: `/v1/projects/${id}/onboarding/review` },
    checklist: [
      "Show the historical evidence window and query receipt separately from the source targets, properties, safe error, deploy boundary, and plan_sha256.",
      "State explicitly that historically_observed rows do not prove current source placement.",
      "Wait for the human to explicitly approve the exact hash or request a replacement.",
      "POST that decision with If-Match set to this state.etag.",
    ],
    completion_condition: "The returned state is approved for this exact plan_sha256.",
    guide_anchor: PUBLIC_INSTALL_REVIEW_ANCHOR,
  });
}

export function onboardingV3ApprovedNextAction(projectId: string) {
  const id = IdSchema.parse(projectId);
  return OnboardingV3ApprovedNextActionSchema.parse({
    id: "instrument_and_start_proof",
    instruction: APPROVED_INSTRUCTION,
    requires_human: false,
    operation: { method: "POST", path: `/v1/projects/${id}/onboarding/proof` },
    checklist: [
      "Use the customer's existing official PostHog SDK configuration; Agentry issues no browser or server telemetry credential.",
      "Add every approved direct-to-PostHog analytics and error capture while preserving correct existing telemetry.",
      "Add the short-lived proof property only when its browser session-storage or trusted server environment value is present; never bundle a marker.",
      "Run relevant tests, commit a clean shipped tree, and capture its final source snapshot.",
      "POST the final snapshot with If-Match set to this state.etag.",
    ],
    completion_condition:
      "The returned state is proving and fresh runtime and CI proof markers were received.",
    guide_anchor: PUBLIC_INSTALL_PROOF_ANCHOR,
  });
}

export function onboardingV3ProvingNextAction(projectId: string) {
  const id = IdSchema.parse(projectId);
  return OnboardingV3ProvingNextActionSchema.parse({
    id: "exercise_and_verify",
    instruction: PROVING_INSTRUCTION,
    requires_human: false,
    operation: { method: "POST", path: `/v1/projects/${id}/onboarding/verify` },
    checklist: [
      "If either one-time marker was not received, is unavailable, or expired, reread state and restart the proof operation with the same final snapshot and current ETag; keep only the new pair. This is the sole recovery exception to next_action.operation.",
      "For browser_posthog proof, set the marker only in sessionStorage.agentry_onboarding_proof for the proof tab. For server_posthog proof, set AGENTRY_ONBOARDING_PROOF only in the trusted runtime.",
      "Attach that exact marker as the agentry_onboarding_proof property on the approved PostHog analytics and exception captures; it is correlation data, never authorization.",
      "Run the reviewed real deploy with the CI proof marker and final source fingerprint so the committed instrumentation is live.",
      "Exercise every approved milestone through the real product with that runtime proof marker.",
      "Exercise the one approved non-mutating safe error with the runtime proof marker.",
      "POST a bodyless verify request with If-Match set to this state.etag; repeat only returned remaining work.",
    ],
    completion_condition:
      "The returned state has evidence_status.source source_verified, installation_complete true, and next_action null.",
    guide_anchor: PUBLIC_INSTALL_VERIFY_ANCHOR,
  });
}

function actionMatchesProject(
  action: { operation: { path: string } },
  projectId: string,
  suffix: "review" | "proof" | "verify",
): boolean {
  return action.operation.path === `/v1/projects/${projectId}/onboarding/${suffix}`;
}

const StateIdentity = {
  contract_version: z.literal(ONBOARDING_V3_CONTRACT_VERSION),
  project_id: IdSchema,
  onboarding_id: IdSchema,
  revision: z.number().int().positive(),
  plan_sha256: Sha256Schema,
  updated_at: UnixSecondsSchema,
};

export const OnboardingV3PlannedStateSchema = z.object({
  status: z.literal("planned"),
  installation_complete: z.literal(false),
  evidence_status: OnboardingV3PendingEvidenceStatusSchema,
  etag: StrongEtagSchema,
  next_action: OnboardingV3PlannedNextActionSchema,
  ...StateIdentity,
  plan: OnboardingV3PlanSchema,
}).strict().superRefine((value, ctx) => {
  if (
    value.evidence_status.historical !==
      onboardingV3EvidenceStatus(value.plan).historical
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_status", "historical"],
      message: "historical evidence status must match the bounded PostHog audit in the plan",
    });
  }
  if (!actionMatchesProject(value.next_action, value.project_id, "review")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["next_action", "operation", "path"],
      message: "next action path must name this project review operation",
    });
  }
});

export const OnboardingV3ApprovedStateSchema = z.object({
  status: z.literal("approved"),
  installation_complete: z.literal(false),
  evidence_status: OnboardingV3PendingEvidenceStatusSchema,
  etag: StrongEtagSchema,
  next_action: OnboardingV3ApprovedNextActionSchema,
  ...StateIdentity,
  approved_at: UnixSecondsSchema,
  plan: OnboardingV3PlanSchema,
}).strict().superRefine((value, ctx) => {
  if (
    value.evidence_status.historical !==
      onboardingV3EvidenceStatus(value.plan).historical
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_status", "historical"],
      message: "historical evidence status must match the bounded PostHog audit in the plan",
    });
  }
  if (!actionMatchesProject(value.next_action, value.project_id, "proof")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["next_action", "operation", "path"],
      message: "next action path must name this project proof operation",
    });
  }
});

export const OnboardingV3ProvingStateSchema = z.object({
  status: z.literal("proving"),
  installation_complete: z.literal(false),
  evidence_status: OnboardingV3PendingEvidenceStatusSchema,
  etag: StrongEtagSchema,
  next_action: OnboardingV3ProvingNextActionSchema,
  ...StateIdentity,
  implementation_source_snapshot: OnboardingV3SourceSnapshotSchema,
  proof_session: OnboardingV3ProofSessionSchema,
  plan: OnboardingV3PlanSchema,
}).strict().superRefine((value, ctx) => {
  if (
    value.evidence_status.historical !==
      onboardingV3EvidenceStatus(value.plan).historical
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_status", "historical"],
      message: "historical evidence status must match the bounded PostHog audit in the plan",
    });
  }
  if (!actionMatchesProject(value.next_action, value.project_id, "verify")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["next_action", "operation", "path"],
      message: "next action path must name this project verify operation",
    });
  }
  if (value.proof_session.status !== "open") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proof_session", "status"],
      message: "proving requires an open proof session",
    });
  }
});

const VerifiedStateObjectSchema = z.object({
  status: z.literal("verified"),
  installation_complete: z.literal(true),
  evidence_status: OnboardingV3SourceVerifiedEvidenceStatusSchema,
  etag: StrongEtagSchema,
  next_action: z.null(),
  ...StateIdentity,
  implementation_source_snapshot: OnboardingV3SourceSnapshotSchema,
  proof_session: OnboardingV3ProofSessionSchema,
  receipt: OnboardingV3VerifiedReceiptSchema,
  plan: OnboardingV3PlanSchema,
}).strict();

export const OnboardingV3VerifiedStateSchema = VerifiedStateObjectSchema.superRefine(
  (value, ctx) => {
    if (
      value.evidence_status.historical !==
        onboardingV3EvidenceStatus(value.plan).historical
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_status", "historical"],
        message: "historical evidence status must match the bounded PostHog audit in the plan",
      });
    }
    if (value.receipt.evidence_status !== "source_verified") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt", "evidence_status"],
        message: "installation completion requires a source_verified receipt",
      });
    }
    if (value.proof_session.status !== "satisfied") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proof_session", "status"],
        message: "verified requires a satisfied proof session",
      });
    }
    if (value.receipt.analytics.length !== value.plan.milestones.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt", "analytics"],
        message: "receipt must cover every approved milestone",
      });
    }
    value.plan.milestones.forEach((milestone, index) => {
      const observed = value.receipt.analytics[index];
      if (!observed) return;
      if (
        observed.event !== milestone.event ||
        observed.posthog_boundary !== milestone.posthog_boundary ||
        JSON.stringify(observed.required_properties) !== JSON.stringify(milestone.properties) ||
        !milestone.properties.every((property) =>
          observed.observed_properties.includes(property)
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["receipt", "analytics", index],
          message: "observed milestone must match its approved opaque event and properties",
        });
      }
    });
    const safeFailure = value.plan.failures.find((failure) => failure.safe_live_proof)!;
    if (
      value.receipt.error.marker !== safeFailure.marker ||
      value.receipt.error.posthog_boundary !== safeFailure.posthog_boundary ||
      JSON.stringify(value.receipt.error.required_context) !==
        JSON.stringify(safeFailure.context) ||
      !safeFailure.context.every((property) =>
        value.receipt.error.observed_context.includes(property)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt", "error"],
        message: "receipt error must match the one approved safe failure",
      });
    }
    if (
      value.receipt.deploy.environment !== value.plan.deploy.environment ||
      JSON.stringify(value.receipt.deploy.source_snapshot) !==
        JSON.stringify(value.implementation_source_snapshot)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt", "deploy"],
        message: "receipt deploy must match the approved environment and final source snapshot",
      });
    }
  },
);

export const OnboardingV3StateSchema = z.union([
  OnboardingV3PlannedStateSchema,
  OnboardingV3ApprovedStateSchema,
  OnboardingV3ProvingStateSchema,
  OnboardingV3VerifiedStateSchema,
]);

const OneTimeProofMarkerSchema = z.object({
  value: opaqueString(20, 1_000),
}).strict();

const RuntimeProofMarkerSchema = OneTimeProofMarkerSchema.extend({
  property_name: z.literal(ONBOARDING_V3_RUNTIME_PROOF_PROPERTY),
  environment_variable: z.literal(ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE),
  browser_session_storage_key: z.literal(
    ONBOARDING_V3_BROWSER_PROOF_SESSION_STORAGE_KEY,
  ),
}).strict();

const CiProofMarkerSchema = OneTimeProofMarkerSchema.extend({
  header_name: z.literal("X-Agentry-Onboarding-Proof"),
  environment_variable: z.literal(ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE),
}).strict();

export const OnboardingV3ProofStartResponseSchema = z.object({
  state: OnboardingV3ProvingStateSchema,
  one_time_markers: z.object({
    runtime: RuntimeProofMarkerSchema,
    ci: CiProofMarkerSchema,
  }).strict().superRefine((value, ctx) => {
    if (value.runtime.value === value.ci.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime and CI proof markers must be distinct",
      });
    }
  }),
}).strict();

export const ONBOARDING_V3_PROOF_BLOCKERS = [
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
] as const;

const OnboardingV3ProofBlockerSchema = z.enum(ONBOARDING_V3_PROOF_BLOCKERS);

const OnboardingV3RemainingAnalyticsSchema = z.object({
  blockers: z.array(OnboardingV3ProofBlockerSchema),
  milestones: z.array(z.object({
    milestone_index: z.number().int().nonnegative(),
    event: opaqueString(1, 200),
    posthog_boundary: PosthogBoundarySchema,
  }).strict()),
  properties: z.array(z.object({
    milestone_index: z.number().int().nonnegative(),
    event: opaqueString(1, 200),
    properties: z.array(PropertyNameSchema).min(1),
    requirement: z.literal("present_and_nonempty_together"),
  }).strict()),
}).strict();

const OnboardingV3RemainingSafeErrorSchema = z.object({
  marker: opaqueString(1, 200),
  posthog_boundary: PosthogBoundarySchema,
  marker_missing: z.boolean(),
  context: z.array(PropertyNameSchema),
  context_requirement: z.literal("present_and_nonempty_together"),
  blockers: z.array(OnboardingV3ProofBlockerSchema),
}).strict().superRefine((value, ctx) => {
  if (!value.marker_missing && value.context.length === 0 && value.blockers.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "remaining safe error must name missing proof",
    });
  }
});

const OnboardingV3RemainingDeploySchema = z.object({
  environment: opaqueString(1, 160),
  blockers: z.array(OnboardingV3ProofBlockerSchema).min(1),
}).strict();

export const OnboardingV3RemainingSchema = z.object({
  analytics: OnboardingV3RemainingAnalyticsSchema,
  safe_error: OnboardingV3RemainingSafeErrorSchema.nullable(),
  deploy: OnboardingV3RemainingDeploySchema.nullable(),
}).strict();

export const ONBOARDING_V3_NOTHING_REMAINING = {
  analytics: { blockers: [], milestones: [], properties: [] },
  safe_error: null,
  deploy: null,
} as const;

function hasRemainingWork(value: z.infer<typeof OnboardingV3RemainingSchema>): boolean {
  return value.analytics.blockers.length > 0 ||
    value.analytics.milestones.length > 0 ||
    value.analytics.properties.length > 0 ||
    value.safe_error !== null || value.deploy !== null;
}

export const OnboardingV3VerifyResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(false),
    state: OnboardingV3ProvingStateSchema,
    remaining: OnboardingV3RemainingSchema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    state: OnboardingV3VerifiedStateSchema,
    remaining: OnboardingV3RemainingSchema,
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.ok === hasRemainingWork(value.remaining)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remaining"],
      message: value.ok
        ? "verified onboarding cannot have remaining proof"
        : "incomplete verification must name remaining proof",
    });
  }
});

export type OnboardingV3Plan = z.infer<typeof OnboardingV3PlanSchema>;
export type OnboardingV3StartRequest = z.infer<typeof OnboardingV3StartRequestSchema>;
export type OnboardingV3ReviewRequest = z.infer<typeof OnboardingV3ReviewRequestSchema>;
export type OnboardingV3ProofStartRequest = z.infer<typeof OnboardingV3ProofStartRequestSchema>;
export type OnboardingV3State = z.infer<typeof OnboardingV3StateSchema>;
export type OnboardingV3Remaining = z.infer<typeof OnboardingV3RemainingSchema>;
export type OnboardingV3VerifyResponse = z.infer<typeof OnboardingV3VerifyResponseSchema>;
