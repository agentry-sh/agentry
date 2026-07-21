import { Hono, type Context } from "hono";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { projectCredentials } from "@agentry/db/schema";
import { errors, sha256Hex } from "@agentrysh/shared";
import { z } from "zod";
import type { AppBindings } from "../env.js";
import { getDb } from "../db.js";
import { readBoundedBytes, readBoundedJson } from "../bounded-json.js";
import { requireApiKey, requireProjectOwner } from "../middleware.js";
import {
  ONBOARDING_V3_BROWSER_PROOF_SESSION_STORAGE_KEY,
  ONBOARDING_V3_NOTHING_REMAINING,
  ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE,
  ONBOARDING_V3_RUNTIME_PROOF_PROPERTY,
  OnboardingV3ProofStartRequestSchema,
  OnboardingV3ProofStartResponseSchema,
  OnboardingV3ReviewRequestSchema,
  OnboardingV3StartRequestSchema,
  OnboardingV3VerifiedReceiptSchema,
  OnboardingV3VerifyResponseSchema,
  type OnboardingV3State,
} from "../onboarding-v3-contract.js";
import {
  approveOnboardingV3State,
  createOrReplacePlannedOnboardingV3State,
  loadOnboardingV3State,
  onboardingV3PlanSha256,
  recordVerifiedOnboardingV3State,
  startProvingOnboardingV3State,
  type OnboardingV3StateWriteResult,
} from "../onboarding-v3-state-store.js";
import {
  ONBOARDING_PROOF_SESSION_DEFAULT_TTL_SECONDS,
  completeOnboardingProofSessionInTransaction,
  loadOnboardingProofSession,
  restartOnboardingProofSessionInTransaction,
  revokeOnboardingProofSessionInTransaction,
} from "../onboarding-proof-sessions.js";
import {
  ONBOARDING_SOURCE_SNAPSHOT_FILENAME,
  ONBOARDING_SOURCE_SNAPSHOT_NODE,
  ONBOARDING_SOURCE_SNAPSHOT_PATH,
} from "../onboarding-source-snapshot.js";
import { verifyOnboardingV3LiveProof } from "../onboarding-v3-live-proof.js";

const router = new Hono<AppBindings>();
const ownerAuth = requireApiKey();
const STRONG_ETAG = /^"[A-Za-z0-9._:-]+"$/;
const PLAN_BODY_MAX_BYTES = 512 * 1_024;
const PROOF_BODY_MAX_BYTES = 4 * 1_024;
const VERIFY_BODY_MAX_BYTES = 1_024;

type Db = ReturnType<typeof getDb>;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function parseBody<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw errors.invalidPayload({
      zod: parsed.error.flatten(),
      zod_issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function optionalIfMatch(c: Context<AppBindings>): string | undefined {
  const value = c.req.header("if-match")?.trim();
  if (!value) return undefined;
  if (!STRONG_ETAG.test(value)) {
    throw errors.preconditionFailed(
      "If-Match must contain one exact strong onboarding ETag.",
      "Read current onboarding state and copy its ETag exactly; wildcards and weak validators are not accepted.",
      { received_etag: value },
    );
  }
  return value;
}

function requiredIfMatch(c: Context<AppBindings>): string {
  const value = optionalIfMatch(c);
  if (!value) {
    throw errors.preconditionRequired(
      "If-Match is required for this onboarding transition.",
      "Read current onboarding state and retry this operation with its exact ETag.",
    );
  }
  return value;
}

function assertCurrentEtag(state: OnboardingV3State, expectedEtag: string): void {
  if (state.etag !== expectedEtag) {
    throw errors.preconditionFailed(
      "The onboarding state changed before this operation.",
      "Read current onboarding state and retry only if this operation still applies.",
      { current_revision: state.revision, current_etag: state.etag },
    );
  }
}

function stateHeaders(
  c: Context<AppBindings>,
  state: OnboardingV3State,
  idempotentReplay?: boolean,
): void {
  c.header("etag", state.etag);
  c.header("cache-control", "no-store");
  if (idempotentReplay !== undefined) {
    c.header("x-agentry-idempotent-replay", String(idempotentReplay));
  }
}

function stateResponse(
  c: Context<AppBindings>,
  result: OnboardingV3StateWriteResult,
  created = false,
) {
  stateHeaders(c, result.state, result.idempotent_replay);
  return c.json(result.state, created && !result.idempotent_replay ? 201 : 200);
}

async function requireCurrentState(db: Db, projectId: string): Promise<OnboardingV3State> {
  const state = await loadOnboardingV3State(db, projectId);
  if (!state) throw errors.notFound("onboarding state");
  return state;
}

async function activeProofReferencedBy(
  db: Db,
  state: OnboardingV3State | null,
) {
  if (state?.status !== "proving") return null;
  const session = await loadOnboardingProofSession(
    db,
    state.project_id,
    state.proof_session.proof_session_id,
  );
  return session?.status === "active" ? session : null;
}

async function replacePlan(
  db: Db,
  input: Parameters<typeof createOrReplacePlannedOnboardingV3State>[1],
  prior: OnboardingV3State | null,
): Promise<OnboardingV3StateWriteResult> {
  const activeProof = await activeProofReferencedBy(db, prior);
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const result = await createOrReplacePlannedOnboardingV3State(tx, input);
    if (activeProof && !result.idempotent_replay) {
      await revokeOnboardingProofSessionInTransaction(tx, {
        project_id: activeProof.project_id,
        session_id: activeProof.session_id,
        reason: "plan_replaced",
      });
    }
    return result;
  });
}

type ProofBindings = {
  ci_credential_id: string;
};

async function loadProofBindings(
  db: Db,
  projectId: string,
): Promise<ProofBindings> {
  const minimumExpiry = nowSeconds() + ONBOARDING_PROOF_SESSION_DEFAULT_TTL_SECONDS;
  const ci = (
    await db.select({ id: projectCredentials.id }).from(projectCredentials).where(and(
      eq(projectCredentials.projectId, projectId),
      eq(projectCredentials.kind, "ci_deploy"),
      isNull(projectCredentials.revokedAt),
      gt(projectCredentials.expiresAt, minimumExpiry),
    )).orderBy(desc(projectCredentials.createdAt), desc(projectCredentials.id)).limit(1)
  )[0] ?? null;
  if (!ci) {
    throw errors.conflict(
      "onboarding_operational_credentials_missing",
      "Trusted deploy attribution needs an active CI credential for the complete proof window.",
      "Create and install AGENTRY_CI_API_KEY only in the reviewed provider-success job, then retry proof with the current ETag.",
      { missing_env_vars: ["AGENTRY_CI_API_KEY"] },
    );
  }
  return { ci_credential_id: ci.id };
}

router.get(ONBOARDING_SOURCE_SNAPSHOT_PATH, async (c) => {
  const etag = `"${await sha256Hex(
    `onboarding-v3-source-snapshot:${ONBOARDING_SOURCE_SNAPSHOT_NODE}`,
  )}"`;
  const cacheHeaders = {
    etag,
    "cache-control": "public, max-age=0, must-revalidate",
  };
  const validators = (c.req.header("if-none-match") ?? "")
    .split(",")
    .map((value) => value.trim());
  if (validators.some((value) => value === "*" || value === etag || value === `W/${etag}`)) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return new Response(ONBOARDING_SOURCE_SNAPSHOT_NODE, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "content-disposition": `inline; filename="${ONBOARDING_SOURCE_SNAPSHOT_FILENAME}"`,
      ...cacheHeaders,
      "x-content-type-options": "nosniff",
    },
  });
});

router.get("/v1/projects/:project_id/onboarding", ownerAuth, async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  if (new URL(c.req.url).search.length > 0) {
    throw errors.invalidPayload({ reason: "onboarding state has no query views" });
  }
  const state = await requireCurrentState(getDb(c.env), projectId);
  stateHeaders(c, state);
  return c.json(state);
});

router.post("/v1/projects/:project_id/onboarding", ownerAuth, async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  const request = parseBody(
    OnboardingV3StartRequestSchema,
    await readBoundedJson(c, PLAN_BODY_MAX_BYTES),
  );
  const expectedEtag = optionalIfMatch(c);
  const db = getDb(c.env);
  const current = await loadOnboardingV3State(db, projectId);
  if (!current && expectedEtag) {
    throw errors.preconditionFailed(
      "Initial onboarding cannot match an ETag because no state exists.",
      "Retry the same start request without If-Match.",
    );
  }
  return stateResponse(c, await replacePlan(db, {
    project_id: projectId,
    created_by: c.get("user").id,
    plan: request.plan,
    expected_etag: expectedEtag,
  }, current), current === null);
});

router.post("/v1/projects/:project_id/onboarding/review", ownerAuth, async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  const request = parseBody(
    OnboardingV3ReviewRequestSchema,
    await readBoundedJson(c, PLAN_BODY_MAX_BYTES),
  );
  const expectedEtag = requiredIfMatch(c);
  const db = getDb(c.env);
  const current = await requireCurrentState(db, projectId);
  if (request.decision === "approve") {
    return stateResponse(c, await approveOnboardingV3State(db, {
      project_id: projectId,
      onboarding_id: current.onboarding_id,
      expected_etag: expectedEtag,
      plan_sha256: request.plan_sha256,
    }));
  }

  const replacementHash = await onboardingV3PlanSha256(request.replacement_plan);
  const exactReplacementReplay = current.status === "planned" &&
    current.plan_sha256 === replacementHash;
  if (!exactReplacementReplay) {
    assertCurrentEtag(current, expectedEtag);
    if (current.status !== "planned") {
      throw errors.conflict(
        "onboarding_not_awaiting_review",
        "Plan review applies only to the current planned state.",
        "Use the start operation with the current ETag to replace a plan after approval.",
        { current_status: current.status },
      );
    }
    if (current.plan_sha256 !== request.plan_sha256) {
      throw errors.conflict(
        "onboarding_plan_hash_mismatch",
        "Replacement does not name the exact plan that was reviewed.",
        "Read the current plan and replace only its exact plan_sha256.",
        { current_plan_sha256: current.plan_sha256 },
      );
    }
  }
  return stateResponse(c, await createOrReplacePlannedOnboardingV3State(db, {
    project_id: projectId,
    created_by: c.get("user").id,
    plan: request.replacement_plan,
    expected_etag: expectedEtag,
  }));
});

router.post("/v1/projects/:project_id/onboarding/proof", ownerAuth, async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  const request = parseBody(
    OnboardingV3ProofStartRequestSchema,
    await readBoundedJson(c, PROOF_BODY_MAX_BYTES),
  );
  const expectedEtag = requiredIfMatch(c);
  const db = getDb(c.env);
  const current = await requireCurrentState(db, projectId);
  assertCurrentEtag(current, expectedEtag);
  if (current.status !== "approved" && current.status !== "proving") {
    throw errors.conflict(
      "onboarding_not_approved",
      "Proof can start only after plan approval.",
      "Read current onboarding state and complete its current stage.",
      { current_status: current.status },
    );
  }
  const bindings = await loadProofBindings(db, projectId);
  // Session restart and the state CAS are one transaction. A concurrent
  // same-ETag loser rolls back its revocation/new marker pair instead of
  // leaving the winning proving state pointed at a revoked session.
  const { issued, stateResult } = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const issued = await restartOnboardingProofSessionInTransaction(tx, {
      project_id: projectId,
      onboarding_id: current.onboarding_id,
      approved_state_etag: current.etag,
      ...bindings,
      expires_in_seconds: ONBOARDING_PROOF_SESSION_DEFAULT_TTL_SECONDS,
    });
    const stateResult = await startProvingOnboardingV3State(tx, {
      project_id: projectId,
      onboarding_id: current.onboarding_id,
      expected_etag: current.etag,
      implementation_source_snapshot: request.implementation_source_snapshot,
      proof_session: {
        proof_session_id: issued.session.session_id,
        status: "open",
        started_at: issued.session.started_at,
        expires_at: issued.session.expires_at,
      },
    });
    return { issued, stateResult };
  });
  const response = OnboardingV3ProofStartResponseSchema.parse({
    state: stateResult.state,
    one_time_markers: {
      runtime: {
        property_name: ONBOARDING_V3_RUNTIME_PROOF_PROPERTY,
        value: issued.markers.runtime.value,
        environment_variable: ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE,
        browser_session_storage_key:
          ONBOARDING_V3_BROWSER_PROOF_SESSION_STORAGE_KEY,
      },
      ci: {
        header_name: issued.markers.ci.header_name,
        value: issued.markers.ci.value,
        environment_variable: ONBOARDING_V3_PROOF_ENVIRONMENT_VARIABLE,
      },
    },
  });
  stateHeaders(c, stateResult.state, false);
  return c.json(response, 201);
});

router.post("/v1/projects/:project_id/onboarding/verify", ownerAuth, async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  const body = await readBoundedBytes(c, VERIFY_BODY_MAX_BYTES, { allowEmpty: true });
  if (body) {
    throw errors.invalidPayload({ reason: "onboarding verification is bodyless" });
  }
  const expectedEtag = requiredIfMatch(c);
  const db = getDb(c.env);
  const current = await requireCurrentState(db, projectId);
  assertCurrentEtag(current, expectedEtag);
  if (current.status !== "proving") {
    throw errors.conflict(
      "onboarding_not_proving",
      "Live verification requires a current proving state.",
      "Start or restart proof, run the real approved paths, then verify its current ETag.",
      { current_status: current.status },
    );
  }
  const session = await loadOnboardingProofSession(
    db,
    projectId,
    current.proof_session.proof_session_id,
  );
  if (
    !session || session.status !== "active" ||
    session.onboarding_id !== current.onboarding_id ||
    session.session_id !== current.proof_session.proof_session_id
  ) {
    throw errors.conflict(
      "onboarding_proof_session_not_active",
      "The exact proof session referenced by onboarding is no longer active.",
      "Restart proof with the current onboarding ETag to get a fresh marker pair.",
      {
        proof_session_id: current.proof_session.proof_session_id,
        durable_status: session?.status ?? "missing",
      },
    );
  }
  const verification = await verifyOnboardingV3LiveProof(c.env, {
    project_id: projectId,
    plan: current.plan,
    implementation_source_snapshot: current.implementation_source_snapshot,
    session,
  });
  if (!verification.ok) {
    const response = OnboardingV3VerifyResponseSchema.parse({
      ok: false,
      state: current,
      remaining: verification.remaining,
    });
    stateHeaders(c, current, false);
    return c.json(response);
  }

  const receipt = OnboardingV3VerifiedReceiptSchema.parse(verification.receipt);
  const stateResult = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const recorded = await recordVerifiedOnboardingV3State(tx, {
      project_id: projectId,
      onboarding_id: current.onboarding_id,
      expected_etag: current.etag,
      receipt,
    });
    const completed = await completeOnboardingProofSessionInTransaction(tx, {
      project_id: projectId,
      session_id: session.session_id,
    });
    if (completed.status !== "completed") {
      throw errors.conflict(
        "onboarding_proof_session_not_active",
        "The proof session ended before verification could commit.",
        "Restart proof with the current onboarding ETag and exercise the real paths again.",
        { proof_session_id: session.session_id, durable_status: completed.status },
      );
    }
    return recorded;
  });
  const response = OnboardingV3VerifyResponseSchema.parse({
    ok: true,
    state: stateResult.state,
    remaining: ONBOARDING_V3_NOTHING_REMAINING,
  });
  stateHeaders(c, stateResult.state, stateResult.idempotent_replay);
  return c.json(response);
});

export default router;
