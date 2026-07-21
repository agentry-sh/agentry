import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import {
  projectInstallPlanApprovals,
  projectInstallPlans,
  projectSignalMaps,
} from "@agentry/db/schema";
import type { getDb } from "./db.js";

export const INSTALL_SIGNAL_TYPES = ["errors", "analytics", "deploys"] as const;
export type InstallSignalType = (typeof INSTALL_SIGNAL_TYPES)[number];

const SHA256_HEX = /^[a-f0-9]{64}$/;
const GIT_OBJECT_HEX = /^[a-f0-9]{7,64}$/;

export const OWNER_ATTESTATION_STATEMENT =
  "I attest that the project owner received and approved this exact install plan scope. This owner attestation is not independent proof that a human interaction occurred.";

export const REPO_SOURCE_FINGERPRINT_ALGORITHM = {
  id: "agentry-source-tree-sha256-v1",
  root: "repository root",
  files:
    "Regular files only; do not follow symlinks. Normalize every relative path to NFC POSIX form without a leading './'.",
  ordering:
    "Sort entries by the unsigned UTF-8 bytes of normalized relative_path (bytewise ascending, not locale order).",
  entry: {
    relative_path: "normalized relative path",
    byte_length: "exact file byte length",
    content_sha256: "lowercase SHA-256 of the exact file bytes",
  },
  exclusions: [
    ".git/**",
    ".hg/**",
    ".svn/**",
    "node_modules/**",
    "vendor/**",
    ".venv/**",
    "venv/**",
    "dist/**",
    "build/**",
    "out/**",
    ".next/**",
    ".nuxt/**",
    "coverage/**",
    ".turbo/**",
    ".cache/**",
    ".agentry/**",
    ".env",
    ".env.* (except .env.example and .env.sample)",
  ],
  digest:
    "SHA-256 of UTF-8 canonical JSON for the sorted array of {relative_path,byte_length,content_sha256}; canonical JSON sorts object keys recursively and preserves array order.",
} as const;

export const REPO_SNAPSHOT_REQUEST_EXAMPLE = {
  git_head_sha: "0123456789abcdef0123456789abcdef01234567",
  source_fingerprint_sha256: "0".repeat(64),
  source_fingerprint_algorithm: REPO_SOURCE_FINGERPRINT_ALGORITHM.id,
} as const;

export const REPO_SOURCE_FINGERPRINT_NODE_HELPER = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const excludedDirs = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", ".venv", "venv",
  "dist", "build", "out", ".next", ".nuxt", "coverage", ".turbo",
  ".cache", ".agentry",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isExcludedFile = (name) =>
  name === ".env" || (name.startsWith(".env.") && name !== ".env.example" && name !== ".env.sample");

const entries = [];
async function walk(absoluteDir, relativeDir = "") {
  const names = await readdir(absoluteDir);
  names.sort((a, b) => Buffer.compare(Buffer.from(a.normalize("NFC")), Buffer.from(b.normalize("NFC"))));
  for (const name of names) {
    if (excludedDirs.has(name) || isExcludedFile(name)) continue;
    const absolute = path.join(absoluteDir, name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) continue;
    const relative = path.posix.join(relativeDir, name.normalize("NFC"));
    if (stat.isDirectory()) {
      await walk(absolute, relative);
      continue;
    }
    if (!stat.isFile()) continue;
    const bytes = await readFile(absolute);
    entries.push({
      byte_length: bytes.length,
      content_sha256: sha256(bytes),
      relative_path: relative,
    });
  }
}
await walk(root);
entries.sort((a, b) => Buffer.compare(Buffer.from(a.relative_path), Buffer.from(b.relative_path)));
for (let i = 1; i < entries.length; i += 1) {
  if (entries[i - 1].relative_path === entries[i].relative_path) {
    throw new Error("NFC-normalized relative path collision: " + entries[i].relative_path);
  }
}
let gitHeadSha = null;
try {
  const candidate = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().toLowerCase();
  if (/^[a-f0-9]{7,64}$/.test(candidate)) gitHeadSha = candidate;
} catch {}
process.stdout.write(JSON.stringify({
  git_head_sha: gitHeadSha,
  source_fingerprint_sha256: sha256(Buffer.from(JSON.stringify(entries), "utf8")),
  source_fingerprint_algorithm: "agentry-source-tree-sha256-v1",
}, null, 2) + "\n");
`;

export const RepoSnapshotRequestSchema = z.object({
  git_head_sha: z.string().regex(GIT_OBJECT_HEX).nullable(),
  source_fingerprint_sha256: z.string().regex(SHA256_HEX),
  source_fingerprint_algorithm: z.literal(REPO_SOURCE_FINGERPRINT_ALGORITHM.id),
}).strict();

export const IssuedRepoSnapshotSchema = RepoSnapshotRequestSchema.extend({
  discovery_sha256: z.string().regex(SHA256_HEX),
}).strict();

const NonEmptyString = z.string().trim().min(1);
const JsonObjectSchema = z.record(z.unknown());
function uniqueStringArray(minimum = 0) {
  return z.array(NonEmptyString).min(minimum).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "values must be unique" });
    }
  });
}
const SignalTypesSchema = z.array(z.enum(INSTALL_SIGNAL_TYPES)).min(1).max(3)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "signal_types must be unique" });
    }
  });

/**
 * The exact semantic contract persisted for a signal map. Approval metadata,
 * timestamps, hashes, and transport hints intentionally do not belong here.
 */
const InstallSignalMapSemanticShape = {
  contract_version: NonEmptyString,
  framework: NonEmptyString,
  surface: NonEmptyString,
  signal_types: SignalTypesSchema,
  shapes: uniqueStringArray(1),
  has_revenue: z.boolean(),
  is_b2b: z.boolean(),
  is_two_sided: z.boolean(),
  approved_events: uniqueStringArray(),
  approved_event_properties: z.record(uniqueStringArray()),
  provider_satisfied_events: z.array(JsonObjectSchema),
  discovery_map: JsonObjectSchema,
  happy_path_funnel: z.array(JsonObjectSchema),
  event_buckets: z.array(JsonObjectSchema),
  failure_surface_map: z.array(JsonObjectSchema),
  planned_wiring_map: z.array(JsonObjectSchema).min(1),
  questions_to_answer: z.array(JsonObjectSchema),
  answer_contracts: z.array(JsonObjectSchema),
  post_setup_blueprint: JsonObjectSchema,
} as const;

const InstallSignalMapSemanticObjectSchema = z.object(InstallSignalMapSemanticShape).strict();
type InstallSignalMapSemanticObject = z.infer<typeof InstallSignalMapSemanticObjectSchema>;

function refineInstallSignalMapSemantic(
  contract: InstallSignalMapSemanticObject,
  ctx: z.RefinementCtx,
) {
  const signalTypes = new Set<InstallSignalType>(contract.signal_types);
  if (signalTypes.has("analytics")) {
    if (contract.approved_events.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_events"],
        message: "approved_events must be non-empty when analytics is enabled",
      });
    }
    if (contract.event_buckets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["event_buckets"],
        message: "event_buckets must be non-empty when analytics is enabled",
      });
    }
    if (contract.happy_path_funnel.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["happy_path_funnel"],
        message: "happy_path_funnel must contain the selected value-flow transitions when analytics is enabled",
      });
    }
  } else if (
    contract.approved_events.length > 0 ||
    Object.keys(contract.approved_event_properties).length > 0 ||
    contract.event_buckets.length > 0 ||
    contract.happy_path_funnel.length > 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["signal_types"],
      message: "analytics contract fields must be empty when analytics is not enabled",
    });
  }
  for (const eventName of Object.keys(contract.approved_event_properties)) {
    if (!contract.approved_events.includes(eventName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_event_properties", eventName],
        message: "property contracts may only reference approved_events",
      });
    }
  }
  if (signalTypes.has("errors") && contract.failure_surface_map.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_surface_map"],
      message: "failure_surface_map must be non-empty when errors are enabled",
    });
  }
  if (
    signalTypes.has("deploys") &&
    !contract.planned_wiring_map.some((item) => item.kind === "deploy")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["planned_wiring_map"],
      message: "planned_wiring_map must include a deploy item when deploys are enabled",
    });
  }
  const metricLens = contract.discovery_map.metric_lens;
  const primaryOutcome = contract.discovery_map.primary_outcome;
  const journeys = contract.discovery_map.key_user_journeys;
  if (typeof metricLens !== "string" || !metricLens.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery_map", "metric_lens"], message: "metric_lens is required" });
  }
  if (typeof primaryOutcome !== "string" || !primaryOutcome.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery_map", "primary_outcome"], message: "primary_outcome is required" });
  }
  if (!Array.isArray(journeys) || journeys.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery_map", "key_user_journeys"], message: "key_user_journeys must be non-empty" });
  }
}

export const InstallSignalMapSemanticSchema = InstallSignalMapSemanticObjectSchema
  .superRefine(refineInstallSignalMapSemantic);

export const OwnerApprovalAttestationSchema = z.object({
  kind: z.literal("owner_attested_user_approval"),
  source: z.literal("owner_api_request"),
  statement: z.literal(OWNER_ATTESTATION_STATEMENT),
  independently_human_verified: z.literal(false),
  notes: z.array(z.never()).length(0),
}).strict();

export const SignalMapActivationSchema = z.object({
  ...InstallSignalMapSemanticShape,
  project_id: NonEmptyString,
  plan_id: NonEmptyString,
  plan_revision: z.number().int().positive(),
  plan_etag: NonEmptyString,
  repo_snapshot: IssuedRepoSnapshotSchema,
  approved_plan_hash: z.string().regex(SHA256_HEX),
  approval_attestation: OwnerApprovalAttestationSchema,
}).strict().superRefine(refineInstallSignalMapSemantic);

export type InstallSignalMapSemantic = z.infer<typeof InstallSignalMapSemanticSchema>;
export type IssuedRepoSnapshot = z.infer<typeof IssuedRepoSnapshotSchema>;
export type SignalMapActivation = z.infer<typeof SignalMapActivationSchema>;

export interface IssuedInstallPlan {
  plan_id: string;
  project_id: string;
  plan_revision: number;
  approved_plan_hash: string;
  plan_etag: string;
  base_signal_map_etag: string | null;
  repo_snapshot: IssuedRepoSnapshot;
  signal_map_contract: InstallSignalMapSemantic;
  source_request_sha256: string;
  created_by: string;
  created_at: number;
  activated: boolean;
  activated_at: number | null;
  activated_by: string | null;
  signal_map_etag: string | null;
  issuance_replayed?: boolean;
}

function parsePersistedJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw errors.conflict(
      "install_plan_corrupt",
      `Persisted ${label} is not valid JSON.`,
      "Stop activation and repair the immutable install-plan record; do not reconstruct or infer its contents.",
    );
  }
}

async function strongEtag(namespace: string, value: unknown): Promise<string> {
  return `"${await sha256Hex(`${namespace}\u0000${canonicalJsonStringify(value)}`)}"`;
}

export async function installPlanEtag(input: {
  plan_id: string;
  plan_revision: number;
  approved_plan_hash: string;
}): Promise<string> {
  return strongEtag("agentry-install-plan-v1", input);
}

export async function signalMapEtagForPlan(input: {
  project_id: string;
  plan_id: string;
  plan_revision: number;
  approved_plan_hash: string;
}): Promise<string> {
  return strongEtag("agentry-signal-map-v1", input);
}

async function legacySignalMapEtag(
  row: typeof projectSignalMaps.$inferSelect,
): Promise<string> {
  return strongEtag("agentry-legacy-signal-map-v1", {
    project_id: row.projectId,
    approved_plan_hash: row.approvedPlanHash,
    updated_at: row.updatedAt,
  });
}

export async function currentSignalMapEtag(
  db: ReturnType<typeof getDb>,
  projectId: string,
): Promise<string | null> {
  const row = (
    await db.select().from(projectSignalMaps)
      .where(eq(projectSignalMaps.projectId, projectId)).limit(1)
  )[0];
  if (!row) return null;
  if (row.signalMapEtag) return row.signalMapEtag;
  const etag = await legacySignalMapEtag(row);
  await db.update(projectSignalMaps)
    .set({ signalMapEtag: etag })
    .where(and(
      eq(projectSignalMaps.projectId, projectId),
      isNull(projectSignalMaps.signalMapEtag),
    ));
  const current = (
    await db.select({ etag: projectSignalMaps.signalMapEtag })
      .from(projectSignalMaps)
      .where(eq(projectSignalMaps.projectId, projectId))
      .limit(1)
  )[0];
  return current?.etag ?? etag;
}

export function semanticSignalMapFromPlannerTemplate(
  template: unknown,
): InstallSignalMapSemantic {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw errors.invalidPayload({ reason: "planner signal_map_template must be an object" });
  }
  const { approved_plan_hash: _previewHash, ...candidate } = template as Record<string, unknown>;
  const parsed = InstallSignalMapSemanticSchema.safeParse(candidate);
  if (!parsed.success) {
    throw errors.invalidPayload({
      reason: "planner produced a signal-map contract that cannot be issued",
      zod: parsed.error.flatten(),
      zod_issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
  return parsed.data;
}

async function installPlanDigest(
  projectId: string,
  repoSnapshot: IssuedRepoSnapshot,
  contract: InstallSignalMapSemantic,
): Promise<string> {
  return sha256Hex(canonicalJsonStringify({
    project_id: projectId,
    repo_snapshot: repoSnapshot,
    signal_map_contract: contract,
  }));
}

function retryableRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("unique") || message.includes("constraint");
}

export async function issueProjectInstallPlanRevision(
  db: ReturnType<typeof getDb>,
  input: {
    project_id: string;
    created_by: string;
    repo_snapshot: z.infer<typeof RepoSnapshotRequestSchema>;
    signal_map_template: unknown;
    source_request: unknown;
  },
): Promise<IssuedInstallPlan> {
  const repoRequest = RepoSnapshotRequestSchema.parse(input.repo_snapshot);
  const contract = semanticSignalMapFromPlannerTemplate(input.signal_map_template);
  const repoSnapshot: IssuedRepoSnapshot = {
    ...repoRequest,
    discovery_sha256: await sha256Hex(canonicalJsonStringify(contract.discovery_map)),
  };
  const approvedPlanHash = await installPlanDigest(input.project_id, repoSnapshot, contract);
  const contractJson = canonicalJsonStringify(contract);
  const repoSnapshotJson = canonicalJsonStringify(repoSnapshot);
  const sourceRequestSha256 = await sha256Hex(canonicalJsonStringify(input.source_request));
  const baseSignalMapEtag = await currentSignalMapEtag(db, input.project_id);
  const issuanceKeySha256 = await sha256Hex(canonicalJsonStringify({
    project_id: input.project_id,
    source_request_sha256: sourceRequestSha256,
    base_signal_map_etag: baseSignalMapEtag,
  }));
  const id = `iplan_${issuanceKeySha256}`;
  const existing = await loadIssuedInstallPlan(db, input.project_id, id);
  if (existing) return { ...existing, issuance_replayed: true };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest = (
      await db.select({ revision: projectInstallPlans.revision })
        .from(projectInstallPlans)
        .where(eq(projectInstallPlans.projectId, input.project_id))
        .orderBy(desc(projectInstallPlans.revision))
        .limit(1)
    )[0];
    const revision = (latest?.revision ?? 0) + 1;
    const createdAt = Math.floor(Date.now() / 1000);
    try {
      await db.insert(projectInstallPlans).values({
        id,
        projectId: input.project_id,
        revision,
        contractJson,
        contractSha256: approvedPlanHash,
        repoSnapshotJson,
        sourceRequestSha256,
        baseSignalMapEtag,
        createdBy: input.created_by,
        createdAt,
      });
      const planEtag = await installPlanEtag({
        plan_id: id,
        plan_revision: revision,
        approved_plan_hash: approvedPlanHash,
      });
      return {
        plan_id: id,
        project_id: input.project_id,
        plan_revision: revision,
        approved_plan_hash: approvedPlanHash,
        plan_etag: planEtag,
        base_signal_map_etag: baseSignalMapEtag,
        repo_snapshot: repoSnapshot,
        signal_map_contract: contract,
        source_request_sha256: sourceRequestSha256,
        created_by: input.created_by,
        created_at: createdAt,
        activated: false,
        activated_at: null,
        activated_by: null,
        signal_map_etag: null,
        issuance_replayed: false,
      };
    } catch (error) {
      const concurrentReplay = await loadIssuedInstallPlan(db, input.project_id, id);
      if (concurrentReplay) return { ...concurrentReplay, issuance_replayed: true };
      if (attempt === 3 || !retryableRevisionConflict(error)) throw error;
    }
  }
  throw errors.conflict(
    "install_plan_revision_conflict",
    "Could not allocate an immutable install-plan revision after concurrent planner requests.",
    "Read the current onboarding state, then retry its exact start or review action once with the same source snapshot, discovery, and precondition.",
  );
}

function serializePlanRows(
  plan: typeof projectInstallPlans.$inferSelect,
  approval?: typeof projectInstallPlanApprovals.$inferSelect | null,
): Promise<IssuedInstallPlan> {
  return (async () => {
    const planEtag = await installPlanEtag({
      plan_id: plan.id,
      plan_revision: plan.revision,
      approved_plan_hash: plan.contractSha256,
    });
    return {
      plan_id: plan.id,
      project_id: plan.projectId,
      plan_revision: plan.revision,
      approved_plan_hash: plan.contractSha256,
      plan_etag: planEtag,
      base_signal_map_etag: plan.baseSignalMapEtag,
      repo_snapshot: IssuedRepoSnapshotSchema.parse(parsePersistedJson(plan.repoSnapshotJson, "repo snapshot")),
      signal_map_contract: InstallSignalMapSemanticSchema.parse(parsePersistedJson(plan.contractJson, "signal-map contract")),
      source_request_sha256: plan.sourceRequestSha256,
      created_by: plan.createdBy,
      created_at: plan.createdAt,
      activated: Boolean(approval),
      activated_at: approval?.attestedAt ?? null,
      activated_by: approval?.attestedBy ?? null,
      signal_map_etag: approval?.signalMapEtag ?? null,
    };
  })();
}

export async function loadIssuedInstallPlan(
  db: ReturnType<typeof getDb>,
  projectId: string,
  planId: string,
): Promise<IssuedInstallPlan | null> {
  const row = (
    await db.select({ plan: projectInstallPlans, approval: projectInstallPlanApprovals })
      .from(projectInstallPlans)
      .leftJoin(projectInstallPlanApprovals, eq(projectInstallPlanApprovals.planId, projectInstallPlans.id))
      .where(and(eq(projectInstallPlans.projectId, projectId), eq(projectInstallPlans.id, planId)))
      .limit(1)
  )[0];
  return row ? serializePlanRows(row.plan, row.approval) : null;
}

export async function listIssuedInstallPlans(
  db: ReturnType<typeof getDb>,
  projectId: string,
  limit = 25,
): Promise<IssuedInstallPlan[]> {
  const rows = await db.select({ plan: projectInstallPlans, approval: projectInstallPlanApprovals })
    .from(projectInstallPlans)
    .leftJoin(projectInstallPlanApprovals, eq(projectInstallPlanApprovals.planId, projectInstallPlans.id))
    .where(eq(projectInstallPlans.projectId, projectId))
    .orderBy(desc(projectInstallPlans.revision))
    .limit(Math.max(1, Math.min(100, limit)));
  return Promise.all(rows.map((row) => serializePlanRows(row.plan, row.approval)));
}

export function activationTemplateForIssue(plan: IssuedInstallPlan): SignalMapActivation {
  return SignalMapActivationSchema.parse({
    ...plan.signal_map_contract,
    project_id: plan.project_id,
    plan_id: plan.plan_id,
    plan_revision: plan.plan_revision,
    plan_etag: plan.plan_etag,
    repo_snapshot: plan.repo_snapshot,
    approved_plan_hash: plan.approved_plan_hash,
    approval_attestation: {
      kind: "owner_attested_user_approval",
      source: "owner_api_request",
      statement: OWNER_ATTESTATION_STATEMENT,
      independently_human_verified: false,
      notes: [],
    },
  });
}

export function activationPreconditionForIssue(plan: IssuedInstallPlan): {
  header: "If-None-Match" | "If-Match";
  value: string;
} {
  return plan.base_signal_map_etag
    ? { header: "If-Match", value: plan.base_signal_map_etag }
    : { header: "If-None-Match", value: "*" };
}

export async function activationExactlyMatchesIssuedPlan(
  plan: IssuedInstallPlan,
  activation: SignalMapActivation,
): Promise<boolean> {
  try {
    return (
      activation.project_id === plan.project_id &&
      activation.plan_id === plan.plan_id &&
      activation.plan_revision === plan.plan_revision &&
      activation.plan_etag === plan.plan_etag &&
      activation.approved_plan_hash === plan.approved_plan_hash &&
      await installPlanDigest(plan.project_id, plan.repo_snapshot, plan.signal_map_contract) ===
        plan.approved_plan_hash &&
      canonicalJsonStringify(activation.repo_snapshot) === canonicalJsonStringify(plan.repo_snapshot) &&
      canonicalJsonStringify(signalMapActivationSemantic(activation)) ===
        canonicalJsonStringify(plan.signal_map_contract)
    );
  } catch {
    return false;
  }
}

export function requireSignalMapWritePrecondition(
  currentEtag: string | null,
  headers: { if_match?: string; if_none_match?: string },
): void {
  const ifMatch = headers.if_match?.trim();
  const ifNoneMatch = headers.if_none_match?.trim();
  if (ifMatch && ifNoneMatch) {
    throw errors.preconditionFailed(
      "Signal-map activation accepts exactly one conditional-write header.",
      currentEtag
        ? "Retry with only If-Match set to the current signal-map ETag."
        : "Retry with only If-None-Match: * for the first signal map.",
      { current_etag: currentEtag },
    );
  }
  if (currentEtag === null) {
    if (!ifNoneMatch) {
      throw errors.preconditionRequired(
        "If-None-Match: * is required for initial signal-map activation.",
        "Use the activation_precondition returned by the authenticated install planner.",
        { required_header: "If-None-Match", required_value: "*" },
      );
    }
    if (ifNoneMatch !== "*" || ifMatch) {
      throw errors.preconditionFailed(
        "Initial signal-map activation must use exactly If-None-Match: *.",
        "Reload or reissue the install plan, then use its exact activation_precondition.",
        { received_if_none_match: ifNoneMatch, received_if_match: ifMatch ?? null },
      );
    }
    return;
  }
  if (!ifMatch) {
    throw errors.preconditionRequired(
      "If-Match is required when replacing an existing signal map.",
      "Issue a new install-plan revision against the current signal map, then retry with the returned If-Match value.",
      { current_etag: currentEtag, required_header: "If-Match" },
    );
  }
  if (ifNoneMatch || ifMatch !== currentEtag) {
    throw errors.preconditionFailed(
      "The signal map changed after this install plan was issued.",
      "Reload the current signal map and issue a corrected planner revision; never overwrite it with a stale plan.",
      { current_etag: currentEtag, received_etag: ifMatch },
    );
  }
}

export async function validateSignalMapActivation(
  db: ReturnType<typeof getDb>,
  projectId: string,
  activation: SignalMapActivation,
  currentEtag: string | null,
  options: { require_latest_plan?: boolean } = {},
): Promise<{ plan: IssuedInstallPlan; signal_map_etag: string }> {
  if (activation.project_id !== projectId) {
    throw errors.conflict(
      "install_plan_project_mismatch",
      "The signal-map template was issued for a different project.",
      "Discard it and call the authenticated planner with this exact current_project_id.",
      { expected_project_id: projectId, received_project_id: activation.project_id },
    );
  }
  const plan = await loadIssuedInstallPlan(db, projectId, activation.plan_id);
  if (!plan) {
    throw errors.conflict(
      "install_plan_not_issued",
      "The referenced install plan was not issued by this server for this project.",
      "Read the current onboarding state and follow its exact next_action; never invent or activate an unissued plan.",
    );
  }
  if (plan.activated) {
    throw errors.conflict(
      "install_plan_replayed",
      "This immutable install-plan revision has already been activated.",
      "Read the active signal map. Any corrected or changed scope requires a new planner revision.",
      { plan_id: plan.plan_id, plan_revision: plan.plan_revision },
    );
  }
  if (options.require_latest_plan !== false) {
    const latest = (
      await db.select({ id: projectInstallPlans.id, revision: projectInstallPlans.revision })
        .from(projectInstallPlans)
        .where(eq(projectInstallPlans.projectId, projectId))
        .orderBy(desc(projectInstallPlans.revision))
        .limit(1)
    )[0];
    if (!latest || latest.id !== plan.plan_id) {
      throw errors.conflict(
        "install_plan_stale_revision",
        "A newer immutable install-plan revision exists for this project.",
        "Use the newest revision. If its scope is wrong, call the planner again to create another revision; do not mutate an older template.",
        { received_revision: plan.plan_revision, latest_revision: latest?.revision ?? null },
      );
    }
  }
  if (plan.base_signal_map_etag !== currentEtag) {
    throw errors.preconditionFailed(
      "The active signal map changed after this plan was issued.",
      "Issue a corrected planner revision against the current signal map before activation.",
      { plan_base_etag: plan.base_signal_map_etag, current_etag: currentEtag },
    );
  }
  const expectedContractJson = canonicalJsonStringify(plan.signal_map_contract);
  const receivedContract = signalMapActivationSemantic(activation);
  if (canonicalJsonStringify(receivedContract) !== expectedContractJson) {
    throw errors.conflict(
      "install_plan_contract_mutated",
      "The activation signal-map contract differs from the immutable server-issued plan.",
      "Do not edit the template. Corrected scope requires a new authenticated planner revision.",
    );
  }
  if (canonicalJsonStringify(activation.repo_snapshot) !== canonicalJsonStringify(plan.repo_snapshot)) {
    throw errors.conflict(
      "install_plan_repo_snapshot_mismatch",
      "The activation repo snapshot differs from the immutable server-issued plan.",
      "Recompute the documented source fingerprint and issue a new planner revision for the current source tree.",
    );
  }
  if (
    activation.plan_revision !== plan.plan_revision ||
    activation.plan_etag !== plan.plan_etag ||
    activation.approved_plan_hash !== plan.approved_plan_hash
  ) {
    throw errors.conflict(
      "install_plan_identity_mismatch",
      "Plan revision, ETag, or digest does not match the immutable issued record.",
      "Use the complete activation-ready template from the newest planner response unchanged.",
    );
  }
  const recomputed = await installPlanDigest(projectId, plan.repo_snapshot, plan.signal_map_contract);
  if (recomputed !== plan.approved_plan_hash) {
    throw errors.conflict(
      "install_plan_digest_invalid",
      "The persisted install-plan digest no longer matches its immutable contract.",
      "Stop activation and repair the plan store; do not infer or regenerate the digest client-side.",
    );
  }
  return {
    plan,
    signal_map_etag: await signalMapEtagForPlan({
      project_id: projectId,
      plan_id: plan.plan_id,
      plan_revision: plan.plan_revision,
      approved_plan_hash: plan.approved_plan_hash,
    }),
  };
}

export function signalMapActivationSemantic(
  activation: SignalMapActivation,
): InstallSignalMapSemantic {
  const {
    project_id: _projectId,
    plan_id: _planId,
    plan_revision: _planRevision,
    plan_etag: _planEtag,
    repo_snapshot: _repoSnapshot,
    approved_plan_hash: _approvedPlanHash,
    approval_attestation: _approvalAttestation,
    ...semantic
  } = activation;
  return InstallSignalMapSemanticSchema.parse(semantic);
}

export function installPlanRevisionGuardSql(planId: string) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${projectInstallPlanApprovals}
    WHERE ${projectInstallPlanApprovals.planId} = ${planId}
  )`;
}
