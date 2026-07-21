import { and, eq, gte, lt, sql } from "drizzle-orm";
import { deploys } from "@agentry/db/schema";
import { sha256Hex } from "@agentrysh/shared";
import type { z } from "zod";
import {
  trustedCustomerDeployFilter,
} from "./customer-data.js";
import { getDb, type AgentryDb } from "./db.js";
import type { Env } from "./env.js";
import {
  OnboardingV3SourceSnapshotSchema,
  OnboardingV3VerifiedReceiptSchema,
  ONBOARDING_V3_RUNTIME_PROOF_PROPERTY,
  type OnboardingV3Plan,
  type OnboardingV3Remaining,
} from "./onboarding-v3-contract.js";
import type { SafeOnboardingProofSession } from "./onboarding-proof-sessions.js";
import { runHogQl } from "./posthog.js";

export type OnboardingV3SourceSnapshot = z.infer<
  typeof OnboardingV3SourceSnapshotSchema
>;
export type OnboardingV3VerifiedReceipt = z.infer<
  typeof OnboardingV3VerifiedReceiptSchema
>;

export interface VerifyOnboardingV3LiveProofInput {
  db?: AgentryDb;
  project_id: string;
  plan: OnboardingV3Plan;
  implementation_source_snapshot: OnboardingV3SourceSnapshot;
  session: SafeOnboardingProofSession;
}

export type OnboardingV3LiveProofResult =
  | { ok: false; receipt: null; remaining: OnboardingV3Remaining }
  | { ok: true; receipt: OnboardingV3VerifiedReceipt; remaining: OnboardingV3Remaining };

type ProofBlocker = OnboardingV3Remaining["analytics"]["blockers"][number];

export const ONBOARDING_V3_ERROR_PROOF_EVENT = "$exception" as const;
export const ONBOARDING_V3_ERROR_PROOF_MARKER_PROPERTY =
  "agentry_onboarding_failure" as const;

export interface OnboardingV3AnalyticsProofObservation {
  milestone_index: number;
  source_row_count: number;
  qualifying_row_count: number;
  observed_property_keys: string[];
}

export interface OnboardingV3ErrorProofObservation {
  marker_row_count: number;
  qualifying_row_count: number;
  observed_context: string[];
}

export interface OnboardingV3DeployProofObservation {
  qualifying_row_count: number;
}

export interface AssembleOnboardingV3LiveProofInput {
  plan: OnboardingV3Plan;
  implementation_source_snapshot: OnboardingV3SourceSnapshot;
  analytics?: OnboardingV3AnalyticsProofObservation[];
  error?: OnboardingV3ErrorProofObservation;
  deploy?: OnboardingV3DeployProofObservation;
  read_failures?: Array<"analytics" | "error" | "deploy">;
  source_verified_at?: number;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function hogqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function posthogPropertyString(property: string): string {
  const key = hogqlString(property);
  return `ifNull(toString(properties[${key}]), '')`;
}

function runtimeProofScopeWhere(session: SafeOnboardingProofSession): string {
  const marker = posthogPropertyString(ONBOARDING_V3_RUNTIME_PROOF_PROPERTY);
  return [
    `startsWith(${marker}, 'agentry_proof_runtime_')`,
    `length(${marker}) BETWEEN 32 AND 200`,
    `timestamp >= toDateTime(${Math.max(0, Math.floor(session.started_at))})`,
    `timestamp < toDateTime(${Math.max(1, Math.floor(session.expires_at))})`,
  ].join(" AND ");
}

function nonemptyAnalyticsProperty(property: string): string {
  const key = hogqlString(property);
  const value = `JSONExtractRaw(properties, ${key})`;
  return `(has(JSONExtractKeys(properties), ${key}) ` +
    `AND notEmpty(trim(ifNull(toString(properties[${key}]), ''))) ` +
    `AND ${value} NOT IN ('', 'null', '\"\"', '[]', '{}'))`;
}

function requiredAnalyticsProperties(
  milestone: OnboardingV3Plan["milestones"][number],
): string[] {
  return sortedUnique(milestone.properties);
}

/**
 * One provider read covers an arbitrarily long plan without interpreting
 * names. Proof rows are deliberately outside the ordinary customer-data view,
 * so this exact proof-session query must not apply the customer filter.
 */
export function buildOnboardingV3AnalyticsProofQuery(
  plan: OnboardingV3Plan,
  session: SafeOnboardingProofSession,
): string {
  const proofMarker = posthogPropertyString(ONBOARDING_V3_RUNTIME_PROOF_PROPERTY);
  const rowLimit = Math.min(2_000, Math.max(100, plan.milestones.length * 20));
  return plan.milestones.map((milestone, index) => {
    const required = requiredAnalyticsProperties(milestone)
      .map(nonemptyAnalyticsProperty).join(" AND ") || "1 = 1";
    return `SELECT ${index} AS milestone_index, ${proofMarker} AS proof_marker, ` +
      `count() AS source_row_count, ` +
      `countIf(${required}) AS qualifying_row_count, ` +
      "arrayDistinct(arrayFlatten(groupArray(JSONExtractKeys(properties)))) AS observed_property_keys " +
      "FROM events WHERE " +
      `${runtimeProofScopeWhere(session)} AND ` +
      `event = ${hogqlString(milestone.event)} GROUP BY proof_marker`;
  }).join(" UNION ALL ") + ` ORDER BY milestone_index ASC LIMIT ${rowLimit}`;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readAnalyticsProof(
  env: Env,
  projectId: string,
  plan: OnboardingV3Plan,
  session: SafeOnboardingProofSession,
): Promise<OnboardingV3AnalyticsProofObservation[]> {
  const result = await runHogQl(
    env,
    projectId,
    buildOnboardingV3AnalyticsProofQuery(plan, session),
    { cacheBust: true },
  );
  const observations = new Map<number, OnboardingV3AnalyticsProofObservation>(
    plan.milestones.map((_, index) => [index, {
      milestone_index: index,
      source_row_count: 0,
      qualifying_row_count: 0,
      observed_property_keys: [],
    }]),
  );
  for (const value of result.results) {
    const row = Array.isArray(value) ? value : [];
    const index = nonnegativeInteger(row[0]);
    const proofMarker = typeof row[1] === "string" ? row[1] : "";
    const sourceRows = nonnegativeInteger(row[2]);
    const qualifyingRows = nonnegativeInteger(row[3]);
    if (
      index === null || index >= plan.milestones.length ||
      !proofMarker || sourceRows === null || qualifyingRows === null
    ) {
      throw new Error("PostHog returned a malformed onboarding analytics proof row.");
    }
    if (await sha256Hex(proofMarker) !== session.runtime_marker_hash) continue;
    observations.set(index, {
      milestone_index: index,
      source_row_count: sourceRows,
      qualifying_row_count: qualifyingRows,
      observed_property_keys: Array.isArray(row[4])
        ? sortedUnique((row[4] as unknown[]).map(String))
        : [],
    });
  }
  return [...observations.values()].sort((left, right) =>
    left.milestone_index - right.milestone_index
  );
}

export function buildOnboardingV3ErrorProofQuery(
  plan: OnboardingV3Plan,
  session: SafeOnboardingProofSession,
): string {
  const failure = plan.failures.find((candidate) => candidate.safe_live_proof);
  if (!failure) {
    return "SELECT NULL AS proof_marker, NULL AS failure_marker, 0 AS marker_row_count, " +
      "0 AS qualifying_row_count, [] AS observed_property_keys WHERE 0 = 1";
  }
  const proofMarker = posthogPropertyString(ONBOARDING_V3_RUNTIME_PROOF_PROPERTY);
  const failureMarker = posthogPropertyString(ONBOARDING_V3_ERROR_PROOF_MARKER_PROPERTY);
  const required = sortedUnique(failure.context)
    .map(nonemptyAnalyticsProperty).join(" AND ") || "1 = 1";
  return `SELECT ${proofMarker} AS proof_marker, ${failureMarker} AS failure_marker, ` +
    "count() AS marker_row_count, " +
    `countIf(${required}) AS qualifying_row_count, ` +
    "arrayDistinct(arrayFlatten(groupArray(JSONExtractKeys(properties)))) AS observed_property_keys " +
    `FROM events WHERE ${runtimeProofScopeWhere(session)} ` +
    `AND event = ${hogqlString(ONBOARDING_V3_ERROR_PROOF_EVENT)} ` +
    `AND ${failureMarker} != '' GROUP BY proof_marker, failure_marker LIMIT 100`;
}

async function readErrorProof(
  env: Env,
  projectId: string,
  plan: OnboardingV3Plan,
  session: SafeOnboardingProofSession,
): Promise<OnboardingV3ErrorProofObservation> {
  const failure = plan.failures.find((candidate) => candidate.safe_live_proof);
  if (!failure) return { marker_row_count: 0, qualifying_row_count: 0, observed_context: [] };
  const result = await runHogQl(
    env,
    projectId,
    buildOnboardingV3ErrorProofQuery(plan, session),
    { cacheBust: true },
  );
  const required = sortedUnique(failure.context);
  for (const value of result.results) {
    const row = Array.isArray(value) ? value : [];
    const proofMarker = typeof row[0] === "string" ? row[0] : "";
    const failureMarker = typeof row[1] === "string" ? row[1] : "";
    const markerRows = nonnegativeInteger(row[2]);
    const qualifyingRows = nonnegativeInteger(row[3]);
    if (!proofMarker || markerRows === null || qualifyingRows === null) {
      throw new Error("PostHog returned a malformed onboarding error proof row.");
    }
    if (
      failureMarker !== failure.marker ||
      await sha256Hex(proofMarker) !== session.runtime_marker_hash
    ) continue;
    const observed = Array.isArray(row[4])
      ? sortedUnique((row[4] as unknown[]).map(String))
      : [];
    return {
      marker_row_count: markerRows,
      qualifying_row_count: qualifyingRows,
      observed_context: required.filter((key) => observed.includes(key)),
    };
  }
  return { marker_row_count: 0, qualifying_row_count: 0, observed_context: [] };
}

async function readDeployProof(
  db: AgentryDb,
  projectId: string,
  plan: OnboardingV3Plan,
  snapshot: OnboardingV3SourceSnapshot,
  session: SafeOnboardingProofSession,
): Promise<OnboardingV3DeployProofObservation> {
  if (snapshot.git_head_sha === null) return { qualifying_row_count: 0 };
  const credentialId = session.ci_deploy.credential_id;
  const fingerprint = sql<string | null>`json_extract(${deploys.extraJson}, '$.source_fingerprint_sha256')`;
  const rows = await db.select({ row_count: sql<number>`count(*)` }).from(deploys).where(and(
    eq(deploys.projectId, projectId),
    trustedCustomerDeployFilter,
    eq(deploys.credentialId, credentialId),
    eq(deploys.onboardingProofSessionId, session.session_id),
    eq(deploys.onboardingProofCredentialId, credentialId),
    gte(deploys.receivedAt, session.started_at),
    lt(deploys.receivedAt, session.expires_at),
    eq(deploys.environment, plan.deploy.environment),
    eq(deploys.sha, snapshot.git_head_sha),
    sql<boolean>`${fingerprint} = ${snapshot.source_fingerprint_sha256}`,
  ));
  return { qualifying_row_count: nonnegativeInteger(rows[0]?.row_count) ?? 0 };
}

function emptyRemaining(): OnboardingV3Remaining {
  return {
    analytics: { blockers: [], milestones: [], properties: [] },
    safe_error: null,
    deploy: null,
  };
}

function remainingSafeError(
  plan: OnboardingV3Plan,
): NonNullable<OnboardingV3Remaining["safe_error"]> {
  const failure = plan.failures.find((candidate) => candidate.safe_live_proof)!;
  return {
    marker: failure.marker,
    posthog_boundary: failure.posthog_boundary,
    marker_missing: true,
    context: [],
    context_requirement: "present_and_nonempty_together",
    blockers: [],
  };
}

function addAnalyticsBlocker(
  remaining: OnboardingV3Remaining,
  blocker: ProofBlocker,
): void {
  if (!remaining.analytics.blockers.includes(blocker)) {
    remaining.analytics.blockers.push(blocker);
  }
}

function addSafeErrorBlocker(
  remaining: OnboardingV3Remaining,
  plan: OnboardingV3Plan,
  blocker: ProofBlocker,
): void {
  remaining.safe_error ??= remainingSafeError(plan);
  if (!remaining.safe_error.blockers.includes(blocker)) {
    remaining.safe_error.blockers.push(blocker);
  }
}

function addDeployBlocker(
  remaining: OnboardingV3Remaining,
  plan: OnboardingV3Plan,
  blocker: ProofBlocker,
): void {
  remaining.deploy ??= { environment: plan.deploy.environment, blockers: [] };
  if (!remaining.deploy.blockers.includes(blocker)) {
    remaining.deploy.blockers.push(blocker);
  }
}

function addCommonBlocker(
  remaining: OnboardingV3Remaining,
  plan: OnboardingV3Plan,
  blocker: ProofBlocker,
): void {
  addAnalyticsBlocker(remaining, blocker);
  addSafeErrorBlocker(remaining, plan, blocker);
  addDeployBlocker(remaining, plan, blocker);
}

function hasRemaining(value: OnboardingV3Remaining): boolean {
  return value.analytics.blockers.length > 0 ||
    value.analytics.milestones.length > 0 ||
    value.analytics.properties.length > 0 ||
    value.safe_error !== null || value.deploy !== null;
}

function preflightRemaining(input: VerifyOnboardingV3LiveProofInput): OnboardingV3Remaining {
  const remaining = emptyRemaining();
  const { project_id: projectId, plan, implementation_source_snapshot: snapshot, session } = input;
  if (session.project_id !== projectId) {
    addCommonBlocker(remaining, plan, "proof_session_project_mismatch");
  }
  if (session.status !== "active") {
    addCommonBlocker(remaining, plan, "proof_session_not_active");
  }
  const now = Math.floor(Date.now() / 1_000);
  if (session.started_at > now || session.expires_at <= now) {
    addCommonBlocker(remaining, plan, "proof_session_outside_window");
  }
  if (!/^[a-f0-9]{64}$/.test(session.runtime_marker_hash)) {
    addAnalyticsBlocker(remaining, "runtime_marker_binding_invalid");
    addSafeErrorBlocker(remaining, plan, "runtime_marker_binding_invalid");
  }
  const ci = session.ci_deploy;
  if (ci.revoked_at !== null || ci.expires_at < session.expires_at) {
    addDeployBlocker(remaining, plan, "ci_credential_binding_unavailable");
  }
  if (snapshot.git_head_sha === null) {
    addDeployBlocker(remaining, plan, "source_git_sha_missing");
  }
  return remaining;
}

/** Pure receipt assembly; a receipt exists only when every approved signal is observed. */
export function assembleOnboardingV3LiveProofResult(
  input: AssembleOnboardingV3LiveProofInput,
): OnboardingV3LiveProofResult {
  const failures = new Set(input.read_failures ?? []);
  const remaining = emptyRemaining();
  const analyticsByIndex = new Map(
    (input.analytics ?? []).map((observation) => [observation.milestone_index, observation]),
  );
  if (failures.has("analytics")) {
    addAnalyticsBlocker(remaining, "analytics_read_failed");
  } else {
    input.plan.milestones.forEach((milestone, index) => {
      const observation = analyticsByIndex.get(index);
      if (!observation || observation.source_row_count < 1) {
        remaining.analytics.milestones.push({
          milestone_index: index,
          event: milestone.event,
          posthog_boundary: milestone.posthog_boundary,
        });
        return;
      }
      const required = requiredAnalyticsProperties(milestone);
      const absent = required.filter((property) =>
        !observation.observed_property_keys.includes(property));
      if (observation.qualifying_row_count < 1 || absent.length > 0) {
        remaining.analytics.properties.push({
          milestone_index: index,
          event: milestone.event,
          properties: absent.length > 0
            ? absent
            : required,
          requirement: "present_and_nonempty_together",
        });
      }
    });
  }
  const safeFailure = input.plan.failures.find((failure) => failure.safe_live_proof);
  if (failures.has("error")) {
    addSafeErrorBlocker(remaining, input.plan, "safe_error_read_failed");
  } else if (!safeFailure) {
    throw new Error("Validated onboarding plan has no safe live-proof failure.");
  } else if (!input.error || input.error.marker_row_count < 1) {
    remaining.safe_error = remainingSafeError(input.plan);
  } else if (input.error.qualifying_row_count < 1) {
    const absent = sortedUnique(safeFailure.context).filter((property) =>
      !input.error!.observed_context.includes(property));
    remaining.safe_error = {
      marker: safeFailure.marker,
      posthog_boundary: safeFailure.posthog_boundary,
      marker_missing: false,
      context: absent.length > 0 ? absent : sortedUnique(safeFailure.context),
      context_requirement: "present_and_nonempty_together",
      blockers: [],
    };
  }
  if (failures.has("deploy")) {
    addDeployBlocker(remaining, input.plan, "deploy_read_failed");
  } else if (!input.deploy || input.deploy.qualifying_row_count < 1) {
    addDeployBlocker(remaining, input.plan, "deploy_not_observed");
  }
  if (hasRemaining(remaining) || !safeFailure || !input.error || !input.deploy) {
    return { ok: false, receipt: null, remaining };
  }
  const receipt = OnboardingV3VerifiedReceiptSchema.parse({
    evidence_status: "source_verified",
    source_verified_at: input.source_verified_at ?? Math.floor(Date.now() / 1_000),
    analytics: input.plan.milestones.map((milestone, index) => ({
      event: milestone.event,
      posthog_boundary: milestone.posthog_boundary,
      required_properties: [...milestone.properties],
      observed_properties: [...milestone.properties],
      row_count: analyticsByIndex.get(index)!.qualifying_row_count,
    })),
    error: {
      marker: safeFailure.marker,
      posthog_boundary: safeFailure.posthog_boundary,
      required_context: [...safeFailure.context],
      observed_context: [...safeFailure.context],
      row_count: input.error.qualifying_row_count,
    },
    deploy: {
      environment: input.plan.deploy.environment,
      source_snapshot: input.implementation_source_snapshot,
      row_count: input.deploy.qualifying_row_count,
    },
  });
  return { ok: true, receipt, remaining: emptyRemaining() };
}

/** Read-only verification. Read errors are reported as missing proof. */
export async function verifyOnboardingV3LiveProof(
  env: Env,
  input: VerifyOnboardingV3LiveProofInput,
): Promise<OnboardingV3LiveProofResult> {
  const preflight = preflightRemaining(input);
  if (hasRemaining(preflight)) return { ok: false, receipt: null, remaining: preflight };
  const db = input.db ?? getDb(env);
  const [analytics, error, deploy] = await Promise.allSettled([
    readAnalyticsProof(env, input.project_id, input.plan, input.session),
    readErrorProof(env, input.project_id, input.plan, input.session),
    readDeployProof(
      db,
      input.project_id,
      input.plan,
      input.implementation_source_snapshot,
      input.session,
    ),
  ]);
  const readFailures: Array<"analytics" | "error" | "deploy"> = [];
  if (analytics.status === "rejected") readFailures.push("analytics");
  if (error.status === "rejected") readFailures.push("error");
  if (deploy.status === "rejected") readFailures.push("deploy");
  return assembleOnboardingV3LiveProofResult({
    plan: input.plan,
    implementation_source_snapshot: input.implementation_source_snapshot,
    analytics: analytics.status === "fulfilled" ? analytics.value : [],
    error: error.status === "fulfilled" ? error.value : undefined,
    deploy: deploy.status === "fulfilled" ? deploy.value : undefined,
    read_failures: readFailures,
  });
}
