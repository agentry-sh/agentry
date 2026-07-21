import { and, eq } from "drizzle-orm";
import { onboardingStates } from "@agentry/db/schema";
import { canonicalJsonStringify, errors, sha256Hex } from "@agentrysh/shared";
import type { getDb } from "./db.js";
import {
  ONBOARDING_V3_CONTRACT_VERSION,
  OnboardingV3PlanSchema,
  OnboardingV3ProofSessionSchema,
  OnboardingV3SourceSnapshotSchema,
  OnboardingV3StateSchema,
  OnboardingV3VerifiedReceiptSchema,
  onboardingV3EvidenceStatus,
  onboardingV3ApprovedNextAction,
  onboardingV3PlannedNextAction,
  onboardingV3ProvingNextAction,
} from "./onboarding-v3-contract.js";
import { z } from "zod";

const IdSchema = z.string().trim().min(8).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const StrongEtagSchema = z.string().regex(/^"[A-Za-z0-9._:-]+"$/);
const UnixSecondsSchema = z.number().int().nonnegative();

const CreateOrReplaceSchema = z.object({
  project_id: IdSchema,
  created_by: IdSchema,
  plan: OnboardingV3PlanSchema,
  expected_etag: StrongEtagSchema.optional(),
  observed_at: UnixSecondsSchema.optional(),
}).strict();

const TransitionCommon = {
  project_id: IdSchema,
  onboarding_id: IdSchema,
  expected_etag: StrongEtagSchema,
  observed_at: UnixSecondsSchema.optional(),
};

const ApproveSchema = z.object({ ...TransitionCommon, plan_sha256: Sha256Schema }).strict();
const StartProvingSchema = z.object({
  ...TransitionCommon,
  implementation_source_snapshot: OnboardingV3SourceSnapshotSchema,
  proof_session: OnboardingV3ProofSessionSchema,
}).strict();
const RecordVerifiedSchema = z.object({ ...TransitionCommon, receipt: OnboardingV3VerifiedReceiptSchema }).strict();

type Db = ReturnType<typeof getDb>;
type StateRow = typeof onboardingStates.$inferSelect;
type StateUpdate = Partial<typeof onboardingStates.$inferInsert>;
export type OnboardingV3State = z.infer<typeof OnboardingV3StateSchema>;
export type OnboardingV3StateWriteResult = { state: OnboardingV3State; idempotent_replay: boolean };
export type CreateOrReplacePlannedOnboardingV3Input = z.input<typeof CreateOrReplaceSchema>;
export type ApproveOnboardingV3Input = z.input<typeof ApproveSchema>;
export type StartProvingOnboardingV3Input = z.input<typeof StartProvingSchema>;
export type RecordVerifiedOnboardingV3Input = z.input<typeof RecordVerifiedSchema>;

function nowSeconds(observedAt?: number): number {
  return observedAt ?? Math.floor(Date.now() / 1_000);
}

export function canonicalOnboardingV3Json(value: unknown): string {
  return canonicalJsonStringify(value);
}

export async function onboardingV3PlanSha256(planInput: unknown): Promise<string> {
  const plan = OnboardingV3PlanSchema.parse(planInput);
  return sha256Hex(canonicalOnboardingV3Json(plan));
}

async function onboardingId(projectId: string, planSha256: string): Promise<string> {
  const digest = await sha256Hex(canonicalOnboardingV3Json({
    namespace: "agentry-onboarding-v3-id-v1",
    project_id: projectId,
    plan_sha256: planSha256,
  }));
  return `onb3_${digest}`;
}

export async function onboardingV3StateEtag(
  stateWithoutEtag: Record<string, unknown>,
): Promise<string> {
  if (Object.hasOwn(stateWithoutEtag, "etag")) {
    throw new Error("onboarding-v3 ETag input must exclude etag");
  }
  // next_action is a deterministic presentation of status. Its copy and guide
  // anchor may improve without changing the persisted state guarded by CAS.
  const { next_action: _derivedAction, ...persistedState } = stateWithoutEtag;
  return `"${await sha256Hex(canonicalOnboardingV3Json(persistedState))}"`;
}

function parseJson<S extends z.ZodTypeAny>(
  schema: S,
  value: string | null,
  field: string,
  row: StateRow,
): z.output<S> | null {
  if (value === null) return null;
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    corrupt(row, `Persisted onboarding ${field} is invalid.`, { field });
  }
}

function corrupt(row: StateRow, message: string, details?: Record<string, unknown>): never {
  throw errors.persistenceFailed(message,
    "Repair or remove the corrupt onboarding row before accepting another transition.",
    { project_id: row.projectId, onboarding_id: row.onboardingId, ...details });
}

async function stateFromRow(row: StateRow): Promise<OnboardingV3State> {
  const plan = parseJson(OnboardingV3PlanSchema, row.planJson, "plan", row)!;
  const implementationSourceSnapshot = parseJson(OnboardingV3SourceSnapshotSchema,
    row.implementationSourceSnapshotJson, "implementation source snapshot", row);
  const proofSession = parseJson(OnboardingV3ProofSessionSchema,
    row.proofSessionJson, "proof session", row);
  const receipt = parseJson(OnboardingV3VerifiedReceiptSchema, row.receiptJson, "receipt", row);
  const computedPlanHash = await onboardingV3PlanSha256(plan);
  if (computedPlanHash !== row.planSha256) {
    corrupt(row, "Persisted onboarding plan hash does not match its canonical plan.");
  }

  const common = {
    contract_version: ONBOARDING_V3_CONTRACT_VERSION,
    project_id: row.projectId,
    onboarding_id: row.onboardingId,
    revision: row.revision,
    plan_sha256: row.planSha256,
    plan,
    updated_at: row.updatedAt,
  };
  let core: Record<string, unknown>;
  if (row.status === "planned") {
    core = {
      ...common,
      status: "planned",
      installation_complete: false,
      evidence_status: onboardingV3EvidenceStatus(plan),
      next_action: onboardingV3PlannedNextAction(row.projectId),
    };
  } else if (row.status === "approved") {
    core = {
      ...common,
      status: "approved",
      installation_complete: false,
      evidence_status: onboardingV3EvidenceStatus(plan),
      next_action: onboardingV3ApprovedNextAction(row.projectId),
      approved_at: row.updatedAt,
    };
  } else if (row.status === "proving") {
    core = {
      ...common,
      status: "proving",
      installation_complete: false,
      evidence_status: onboardingV3EvidenceStatus(plan),
      next_action: onboardingV3ProvingNextAction(row.projectId),
      implementation_source_snapshot: implementationSourceSnapshot,
      proof_session: proofSession,
    };
  } else if (row.status === "verified") {
    core = {
      ...common,
      status: "verified",
      installation_complete: true,
      evidence_status: onboardingV3EvidenceStatus(plan, "source_verified"),
      next_action: null,
      implementation_source_snapshot: implementationSourceSnapshot,
      proof_session: proofSession,
      receipt,
    };
  } else {
    corrupt(row, "Persisted onboarding status is invalid.", { status: row.status });
  }
  const computedEtag = await onboardingV3StateEtag(core);
  if (computedEtag !== row.etag) {
    corrupt(row, "Persisted onboarding ETag does not match its canonical state.");
  }
  try {
    return OnboardingV3StateSchema.parse({ ...core, etag: computedEtag });
  } catch {
    corrupt(row, "Persisted onboarding documents do not match its status.", { status: row.status });
  }
}

async function currentRow(db: Db, projectId: string): Promise<StateRow | null> {
  return (
    await db.select().from(onboardingStates)
      .where(eq(onboardingStates.projectId, projectId)).limit(1)
  )[0] ?? null;
}

async function updateByEtag(
  db: Db,
  projectId: string,
  expectedEtag: string,
  values: StateUpdate,
): Promise<boolean> {
  const rows = await db.update(onboardingStates).set(values).where(and(
    eq(onboardingStates.projectId, projectId),
    eq(onboardingStates.etag, expectedEtag),
  )).returning({ projectId: onboardingStates.projectId });
  return rows.length > 0;
}

async function commitCas(
  db: Db,
  projectId: string,
  expectedEtag: string,
  values: StateUpdate,
  candidate: OnboardingV3State,
  isReplay: (state: OnboardingV3State) => boolean,
): Promise<OnboardingV3StateWriteResult> {
  if (await updateByEtag(db, projectId, expectedEtag, values)) {
    return { state: candidate, idempotent_replay: false };
  }
  const raced = await stateAfterFailedCas(db, projectId);
  if (isReplay(raced)) return { state: raced, idempotent_replay: true };
  assertExpectedEtag(raced, expectedEtag);
  throw errors.persistenceFailed(
    "Onboarding transition was not persisted.",
    "Reload current onboarding state before retrying.",
  );
}

export async function loadOnboardingV3State(db: Db, projectIdInput: string): Promise<OnboardingV3State | null> {
  const projectId = IdSchema.parse(projectIdInput);
  const row = await currentRow(db, projectId);
  return row ? stateFromRow(row) : null;
}

function assertStateIdentity(state: OnboardingV3State, onboardingIdInput: string): void {
  if (state.onboarding_id !== onboardingIdInput) {
    throw errors.conflict(
      "onboarding_id_mismatch",
      "This mutation names a different onboarding attempt.",
      "Reload the current onboarding state and continue only its exact onboarding_id.",
      { current_onboarding_id: state.onboarding_id },
    );
  }
}

function assertExpectedEtag(state: OnboardingV3State, expectedEtag: string): void {
  if (state.etag !== expectedEtag) {
    throw errors.preconditionFailed(
      "The onboarding state changed before this transition.",
      "Reload current onboarding state and retry only the returned next operation.",
      { current_revision: state.revision, current_etag: state.etag },
    );
  }
}

async function stateAfterFailedCas(db: Db, projectId: string): Promise<OnboardingV3State> {
  const state = await loadOnboardingV3State(db, projectId);
  if (!state) {
    throw errors.persistenceFailed(
      "Onboarding state disappeared during a transition.",
      "Reload the project and restart onboarding from a fresh plan.",
      { project_id: projectId },
    );
  }
  return state;
}

export async function createOrReplacePlannedOnboardingV3State(
  db: Db,
  input: CreateOrReplacePlannedOnboardingV3Input,
): Promise<OnboardingV3StateWriteResult> {
  const parsed = CreateOrReplaceSchema.parse(input);
  const observedAt = nowSeconds(parsed.observed_at);
  const planSha256 = await onboardingV3PlanSha256(parsed.plan);
  const nextOnboardingId = await onboardingId(parsed.project_id, planSha256);
  let current = await loadOnboardingV3State(db, parsed.project_id);

  if (!current) {
    const core = {
      contract_version: ONBOARDING_V3_CONTRACT_VERSION,
      project_id: parsed.project_id,
      onboarding_id: nextOnboardingId,
      revision: 1,
      status: "planned" as const,
      installation_complete: false as const,
      evidence_status: onboardingV3EvidenceStatus(parsed.plan),
      next_action: onboardingV3PlannedNextAction(parsed.project_id),
      plan_sha256: planSha256,
      plan: parsed.plan,
      updated_at: observedAt,
    };
    const etag = await onboardingV3StateEtag(core);
    const inserted = await db.insert(onboardingStates).values({
      projectId: parsed.project_id,
      onboardingId: nextOnboardingId,
      revision: 1,
      status: "planned",
      etag,
      planSha256,
      planJson: canonicalOnboardingV3Json(parsed.plan),
      implementationSourceSnapshotJson: null,
      proofSessionJson: null,
      receiptJson: null,
      createdBy: parsed.created_by,
      createdAt: observedAt,
      updatedAt: observedAt,
    }).onConflictDoNothing().returning({ projectId: onboardingStates.projectId });
    if (inserted.length > 0) {
      return {
        state: OnboardingV3StateSchema.parse({ ...core, etag }),
        idempotent_replay: false,
      };
    }
    current = await stateAfterFailedCas(db, parsed.project_id);
  }

  if (
    current.status === "planned" &&
    current.plan_sha256 === planSha256 &&
    current.onboarding_id === nextOnboardingId
  ) {
    return { state: current, idempotent_replay: true };
  }
  if (!parsed.expected_etag) {
    throw errors.preconditionRequired(
      "Replacing the current onboarding plan requires its ETag.",
      "Reload current onboarding state and retry with If-Match using its exact ETag.",
      { current_etag: current.etag, current_revision: current.revision },
    );
  }
  assertExpectedEtag(current, parsed.expected_etag);
  const core = {
    contract_version: ONBOARDING_V3_CONTRACT_VERSION,
    project_id: parsed.project_id,
    onboarding_id: nextOnboardingId,
    revision: current.revision + 1,
    status: "planned" as const,
    installation_complete: false as const,
    evidence_status: onboardingV3EvidenceStatus(parsed.plan),
    next_action: onboardingV3PlannedNextAction(parsed.project_id),
    plan_sha256: planSha256,
    plan: parsed.plan,
    updated_at: observedAt,
  };
  const etag = await onboardingV3StateEtag(core);
  const values: StateUpdate = {
    onboardingId: nextOnboardingId,
    revision: core.revision,
    status: "planned",
    etag,
    planSha256,
    planJson: canonicalOnboardingV3Json(parsed.plan),
    implementationSourceSnapshotJson: null,
    proofSessionJson: null,
    receiptJson: null,
    createdBy: parsed.created_by,
    createdAt: observedAt,
    updatedAt: observedAt,
  };
  const candidate = OnboardingV3StateSchema.parse({ ...core, etag });
  return commitCas(db, parsed.project_id, parsed.expected_etag, values, candidate,
    (state) => state.status === "planned" && state.plan_sha256 === planSha256 &&
      state.onboarding_id === nextOnboardingId);
}

export async function approveOnboardingV3State(
  db: Db,
  input: ApproveOnboardingV3Input,
): Promise<OnboardingV3StateWriteResult> {
  const parsed = ApproveSchema.parse(input);
  const current = await stateAfterFailedCas(db, parsed.project_id);
  assertStateIdentity(current, parsed.onboarding_id);
  if (
    current.status === "approved" &&
    current.plan_sha256 === parsed.plan_sha256
  ) {
    return { state: current, idempotent_replay: true };
  }
  assertExpectedEtag(current, parsed.expected_etag);
  if (current.status !== "planned") {
    throw errors.conflict(
      "onboarding_not_awaiting_approval",
      "The current onboarding plan is not awaiting approval.",
      "Reload current onboarding state and continue its current stage.",
      { current_status: current.status },
    );
  }
  if (current.plan_sha256 !== parsed.plan_sha256) {
    throw errors.conflict(
      "onboarding_plan_hash_mismatch",
      "Approval does not name the exact current plan hash.",
      "Review and approve only the current plan_sha256, or replace the plan.",
      { current_plan_sha256: current.plan_sha256 },
    );
  }
  const observedAt = nowSeconds(parsed.observed_at);
  const core = {
    ...current,
    revision: current.revision + 1,
    status: "approved" as const,
    installation_complete: false as const,
    evidence_status: onboardingV3EvidenceStatus(current.plan),
    next_action: onboardingV3ApprovedNextAction(parsed.project_id),
    approved_at: observedAt,
    updated_at: observedAt,
  };
  const { etag: _priorEtag, ...coreWithoutEtag } = core;
  const etag = await onboardingV3StateEtag(coreWithoutEtag);
  const candidate = OnboardingV3StateSchema.parse({ ...coreWithoutEtag, etag });
  return commitCas(db, parsed.project_id, parsed.expected_etag, {
    revision: core.revision,
    status: "approved",
    etag,
    updatedAt: observedAt,
  }, candidate, (state) => state.status === "approved" &&
    state.plan_sha256 === parsed.plan_sha256);
}

export async function startProvingOnboardingV3State(
  db: Db,
  input: StartProvingOnboardingV3Input,
): Promise<OnboardingV3StateWriteResult> {
  const parsed = StartProvingSchema.parse(input);
  const current = await stateAfterFailedCas(db, parsed.project_id);
  assertStateIdentity(current, parsed.onboarding_id);
  if (
    current.status === "proving" &&
    canonicalOnboardingV3Json(current.implementation_source_snapshot) ===
      canonicalOnboardingV3Json(parsed.implementation_source_snapshot) &&
    canonicalOnboardingV3Json(current.proof_session) ===
      canonicalOnboardingV3Json(parsed.proof_session)
  ) {
    return { state: current, idempotent_replay: true };
  }
  assertExpectedEtag(current, parsed.expected_etag);
  if (current.status !== "approved" && current.status !== "proving") {
    throw errors.conflict(
      "onboarding_not_approved",
      "Live proof can start or restart only after exact plan approval.",
      "Reload current onboarding state and complete its current stage.",
      { current_status: current.status },
    );
  }
  if (parsed.proof_session.status !== "open") {
    throw errors.conflict(
      "onboarding_proof_not_open",
      "A new proof session must be open.",
      "Create one fresh open proof session, then retry this transition.",
    );
  }
  const observedAt = nowSeconds(parsed.observed_at);
  const core = {
    contract_version: ONBOARDING_V3_CONTRACT_VERSION,
    project_id: current.project_id,
    onboarding_id: current.onboarding_id,
    revision: current.revision + 1,
    status: "proving" as const,
    installation_complete: false as const,
    evidence_status: onboardingV3EvidenceStatus(current.plan),
    next_action: onboardingV3ProvingNextAction(parsed.project_id),
    plan_sha256: current.plan_sha256,
    plan: current.plan,
    implementation_source_snapshot: parsed.implementation_source_snapshot,
    proof_session: parsed.proof_session,
    updated_at: observedAt,
  };
  const etag = await onboardingV3StateEtag(core);
  const candidate = OnboardingV3StateSchema.parse({ ...core, etag });
  return commitCas(db, parsed.project_id, parsed.expected_etag, {
    revision: core.revision,
    status: "proving",
    etag,
    implementationSourceSnapshotJson: canonicalOnboardingV3Json(
      parsed.implementation_source_snapshot,
    ),
    proofSessionJson: canonicalOnboardingV3Json(parsed.proof_session),
    updatedAt: observedAt,
  }, candidate, (state) => state.status === "proving" &&
    canonicalOnboardingV3Json(state.implementation_source_snapshot) ===
      canonicalOnboardingV3Json(parsed.implementation_source_snapshot) &&
    canonicalOnboardingV3Json(state.proof_session) ===
      canonicalOnboardingV3Json(parsed.proof_session));
}

export async function recordVerifiedOnboardingV3State(
  db: Db,
  input: RecordVerifiedOnboardingV3Input,
): Promise<OnboardingV3StateWriteResult> {
  const parsed = RecordVerifiedSchema.parse(input);
  const current = await stateAfterFailedCas(db, parsed.project_id);
  assertStateIdentity(current, parsed.onboarding_id);
  if (
    current.status === "verified" &&
    canonicalOnboardingV3Json(current.receipt) ===
      canonicalOnboardingV3Json(parsed.receipt)
  ) {
    return { state: current, idempotent_replay: true };
  }
  assertExpectedEtag(current, parsed.expected_etag);
  if (current.status !== "proving") {
    throw errors.conflict(
      "onboarding_not_proving",
      "A source_verified receipt can be recorded only for an open proof session.",
      "Reload current onboarding state and complete its current stage.",
      { current_status: current.status },
    );
  }
  const observedAt = nowSeconds(parsed.observed_at);
  const satisfiedProofSession = {
    ...current.proof_session,
    status: "satisfied" as const,
  };
  const core = {
    ...current,
    revision: current.revision + 1,
    status: "verified" as const,
    installation_complete: true as const,
    evidence_status: onboardingV3EvidenceStatus(current.plan, "source_verified"),
    next_action: null,
    proof_session: satisfiedProofSession,
    receipt: parsed.receipt,
    updated_at: observedAt,
  };
  const { etag: _priorEtag, ...coreWithoutEtag } = core;
  const etag = await onboardingV3StateEtag(coreWithoutEtag);
  const candidate = OnboardingV3StateSchema.parse({ ...coreWithoutEtag, etag });
  return commitCas(db, parsed.project_id, parsed.expected_etag, {
    revision: core.revision,
    status: "verified",
    etag,
    proofSessionJson: canonicalOnboardingV3Json(satisfiedProofSession),
    receiptJson: canonicalOnboardingV3Json(parsed.receipt),
    updatedAt: observedAt,
  }, candidate, (state) => state.status === "verified" &&
    canonicalOnboardingV3Json(state.receipt) === canonicalOnboardingV3Json(parsed.receipt));
}
