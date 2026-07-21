import { Hono } from "hono";
import { desc, eq, gte, and, inArray, sql } from "drizzle-orm";
import {
  AutomationDefinitionSchema,
  TELEMETRY_DATA_BOUNDARY,
  canonicalJsonStringify,
  errors,
  mergeTelemetryInspections,
  prepareTelemetryObservation,
  sha256Hex,
  uuidv7,
} from "@agentrysh/shared";
import {
  automationRunEvents,
  automationRuns,
  deploys,
  projectCredentials,
  webhookDeliveries,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess, waitUntilOf } from "../middleware.js";
import { requireSignalCredential } from "../project-credential-auth.js";
import { resolveOnboardingProofMarker } from "../onboarding-proof-marker.js";
import {
  assertWebhookOutboxPersisted,
  dispatchPersistedWebhookDeliveries,
  guardedWebhookDeliveryInsert,
  prepareWebhookOutbox,
} from "../webhooks.js";
import { assertProjectExternalWritesOpen } from "../external-mutation-boundary.js";
import type { AppBindings } from "../env.js";
import { customerDeployFilter } from "../customer-data.js";
import { positiveIntOr, readBoundedJson } from "../bounded-json.js";
import { automationWritesOpenForProject } from "../automation-deletion-boundary.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Deploy events
//
// CI/provider jobs ingest via POST /v1/deploys/ with agentry_ci_ auth.
// Agents read via GET /v1/projects/:project_id/deploys (api-key auth).
// ---------------------------------------------------------------------------

router.post("/v1/deploys/", async (c) => {
  return await handleDeployIngest(c);
});

router.get("/v1/projects/:project_id/deploys", requireApiKey(), async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectAccess(c, projectId);

  const limit = clamp(parseInt(c.req.query("limit") ?? "20", 10), 1, 200, 20);
  const since = parseInt(c.req.query("since") ?? "0", 10);

  const db = getDb(c.env);
  const where = since
    ? and(eq(deploys.projectId, projectId), customerDeployFilter, gte(deploys.receivedAt, since))
    : and(eq(deploys.projectId, projectId), customerDeployFilter);

  const rows = await db
    .select()
    .from(deploys)
    .where(where)
    .orderBy(desc(deploys.receivedAt))
    .limit(limit);

  const authority = await loadDeployAuthority(db, rows);
  const serialized = rows.map((row) => serializeDeploy(row, authority.get(row.id)));
  return c.json({
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      applies_to: "deploys[].evidence",
      inspection: mergeTelemetryInspections(serialized.map((row) => row.inspection)),
    },
    deploys: serialized,
    next_action:
      rows.length === 0
        ? "No deploys recorded yet. Have CI call POST /v1/deploys/ with AGENTRY_CI_API_KEY after every successful deploy."
        : "Every deploy is bound to an exact same-project CI credential. Correlate timestamps with source-backed telemetry before making a causal claim.",
  });
});

async function handleDeployIngest(c: import("hono").Context<AppBindings>) {
  const principal = await requireSignalCredential(c, "deploys:write");
  const proof = await resolveOnboardingProofMarker(c, principal);
  const projectId = principal.projectId;
  const db = getDb(c.env);

  const body = await readBoundedJson(
    c,
    positiveIntOr(c.env.MAX_BODY_BYTES, 262_144),
  );

  if (!body || typeof body !== "object") {
    throw errors.invalidPayload({ reason: "body must be a JSON object" });
  }
  const b = body as Record<string, unknown>;
  const observation = prepareTelemetryObservation(b);
  const accepted = observation.content as Record<string, unknown>;
  const sha = typeof accepted.sha === "string" ? accepted.sha.slice(0, 200) : null;
  if (!sha) {
    throw errors.invalidPayload({ reason: "sha is required" });
  }

  const now = Math.floor(Date.now() / 1000);
  const branch = typeof accepted.branch === "string" ? accepted.branch.slice(0, 200) : null;
  const environment = typeof accepted.environment === "string" ? accepted.environment.slice(0, 100) : null;
  const message = typeof accepted.message === "string" ? accepted.message.slice(0, 4000) : null;
  const url = httpsUrlOrNull(accepted.url);
  const actor = typeof accepted.actor === "string" ? accepted.actor.slice(0, 200) : null;
  const automationRunId = typeof accepted.automation_run_id === "string"
    ? accepted.automation_run_id.slice(0, 200)
    : null;
  const sourceCommitSha = typeof accepted.source_commit_sha === "string"
    ? accepted.source_commit_sha.slice(0, 200)
    : null;
  if (Boolean(automationRunId) !== Boolean(sourceCommitSha)) {
    throw errors.invalidPayload({
      reason: "automation_run_id and source_commit_sha must be supplied together",
    });
  }
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 500) {
    throw errors.preconditionRequired(
      "Deploy ingest requires a stable 8-500 character Idempotency-Key header.",
      "Use the CI provider deployment/run id (or another stable per-deployment id) and preserve it across retries. Never reuse it for different deploy evidence.",
      { header: "Idempotency-Key" },
    );
  }
  const id = `deploy_${await sha256Hex(`${projectId}\u0000${idempotencyKey}`)}`;
  const extraJson = pickExtras(accepted);
  const existingByCommand = (
    await db.select().from(deploys).where(eq(deploys.id, id)).limit(1)
  )[0];
  if (existingByCommand) {
    await assertPersistedDeployAuthority(db, existingByCommand);
    assertSameDeployRequest(existingByCommand, {
      projectId,
      sha,
      branch,
      environment,
      message,
      url,
      actor,
      automationRunId,
      sourceCommitSha,
      extraJson,
      onboardingProofSessionId: proof?.proofSessionId ?? null,
      onboardingProofCredentialId: proof?.proofCredentialId ?? null,
    });
    return deployReplayResponse(c, existingByCommand);
  }
  let automationRun: typeof automationRuns.$inferSelect | null = null;
  if (automationRunId && sourceCommitSha) {
    automationRun = (
      await db.select().from(automationRuns).where(eq(automationRuns.id, automationRunId)).limit(1)
    )[0] ?? null;
    if (!automationRun || automationRun.projectId !== projectId) {
      throw errors.notFound("automation_run");
    }
    if (!automationRun.prProofHash || !automationRun.prProofCredentialId || !automationRun.commitSha) {
      throw errors.conflict(
        "trusted_pr_proof_missing",
        "The automation run has no immutable trusted-CI PR proof.",
        "Record provider proof for the exact draft PR before binding a deployment.",
        { run_id: automationRun.id },
      );
    }
    if (automationRun.commitSha !== sourceCommitSha) {
      throw errors.conflict(
        "deploy_source_commit_mismatch",
        "The deployed source commit does not match the provider-proven run commit.",
        "Stop verification and deploy only the exact proven commit; never substitute a SHA from runner evidence.",
        { expected: automationRun.commitSha, received: sourceCommitSha },
      );
    }
    const policyParsed = AutomationDefinitionSchema.safeParse(safeParseJson(automationRun.policySnapshotJson));
    if (!policyParsed.success) {
      throw errors.persistenceFailed("automation run policy snapshot is invalid", "Stop and escalate; do not infer deploy authority.", { run_id: automationRun.id });
    }
    if (policyParsed.data.runner.environment && environment !== policyParsed.data.runner.environment) {
      throw errors.conflict(
        "deploy_environment_mismatch",
        "The deployment environment does not match the immutable run policy.",
        "Record verification only for the configured environment.",
        { expected: policyParsed.data.runner.environment, received: environment },
      );
    }
    const existingBinding = (
      await db
        .select()
        .from(deploys)
        .where(and(eq(deploys.automationRunId, automationRun.id), eq(deploys.sha, sha)))
        .limit(1)
    )[0];
    if (existingBinding) {
      await assertPersistedDeployAuthority(db, existingBinding, { requireBinding: true });
      if (existingBinding.sourceCommitSha !== sourceCommitSha) {
        throw errors.conflict("deploy_binding_immutable", "This run/deploy binding already names a different source commit.", "Read the durable deploy binding; do not overwrite it.");
      }
      let evidenceMatches = true;
      try {
        assertSameDeployRequest(existingBinding, {
          projectId,
          sha,
          branch,
          environment,
          message,
          url,
          actor,
          automationRunId,
          sourceCommitSha,
          extraJson,
          onboardingProofSessionId: proof?.proofSessionId ?? null,
          onboardingProofCredentialId: proof?.proofCredentialId ?? null,
        });
      } catch {
        evidenceMatches = false;
      }
      throw errors.conflict(
        evidenceMatches ? "deploy_binding_idempotency_key_changed" : "deploy_binding_immutable",
        evidenceMatches
          ? "This exact run/deploy binding already exists under a different Idempotency-Key."
          : "This run/deploy binding already exists with different immutable release evidence.",
        "Read the existing deploy receipt and reuse its original CI provider idempotency key for transport retries. Never overwrite a run/deploy binding or report changed evidence as a replay.",
        { deploy_id: existingBinding.id, run_id: automationRun.id, evidence_matches: evidenceMatches },
      );
    }
    if (automationRun.status !== "draft_pr_opened") {
      throw errors.conflict(
        "automation_deploy_not_expected",
        "The run is not waiting for its first trusted deployment.",
        "Read the current run; do not bind another deploy to a verifying or terminal run.",
        { status: automationRun.status },
      );
    }
  }
  const deployValues: typeof deploys.$inferInsert = {
    id,
    projectId,
    sha,
    branch,
    environment,
    message,
    url,
    actor,
    automationRunId,
    sourceCommitSha,
    extraJson,
    trustLevel: "trusted_ci",
    credentialKind: "ci_deploy",
    credentialId: principal.credentialId,
    onboardingProofSessionId: proof?.proofSessionId ?? null,
    onboardingProofCredentialId: proof?.proofCredentialId ?? null,
    receivedAt: now,
  };
  const outbox = await prepareWebhookOutbox(
    c.env,
    projectId,
    "deploy.recorded",
    {
      deploy_id: id,
      sha,
      branch,
      environment,
      message,
      url,
      actor,
      automation_run_id: automationRunId,
      source_commit_sha: sourceCommitSha,
      extra: extraJson ? safeParseJson(extraJson) : null,
      trust_level: principal.trustLevel,
      credential_kind: principal.kind,
      received_at: now,
    },
    {
      sourceEventId: `deploy:${id}`,
      contentInspection: observation.inspection,
    },
  );
  const outboxWrite = outbox.deliveries.length > 0
    ? outbox.deliveries.map((delivery) => guardedWebhookDeliveryInsert(db, delivery))
    : null;

  try {
    if (automationRun) {
      const eventId = uuidv7();
      const transitioned = db
      .update(automationRuns)
      .set({
        status: "verifying",
        deploySha: sha,
        verificationStartedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(automationRuns.id, automationRun.id),
        eq(automationRuns.status, "draft_pr_opened"),
        automationWritesOpenForProject(automationRuns.projectId),
      ))
      .returning({ id: automationRuns.id });
      const eventWrite = db.insert(automationRunEvents).select(
        db.select({
          id: sql<string>`CASE WHEN changes() = 1 THEN ${eventId} ELSE NULL END`.as("id"),
          projectId: sql<string>`${projectId}`.as("project_id"),
          runId: automationRuns.id,
          event: sql<string>`'deploy.bound'`.as("event"),
          fromStatus: sql<string>`'draft_pr_opened'`.as("from_status"),
          toStatus: sql<string>`'verifying'`.as("to_status"),
          actor: sql<string>`${`credential:${principal.credentialId}`}`.as("actor"),
          dataJson: sql<string>`${canonicalJsonStringify({ deploy_id: id, deploy_sha: sha, source_commit_sha: sourceCommitSha })}`.as("data_json"),
          at: sql<number>`${now}`.as("at"),
        })
          .from(automationRuns)
          .where(eq(automationRuns.id, automationRun.id)),
      );
      await db.batch([
        transitioned,
        eventWrite,
        db.insert(deploys).values(deployValues),
        ...(outboxWrite ?? []),
      ] as const);
    } else {
      await db.batch([
        db.insert(deploys).values(deployValues),
        ...(outboxWrite ?? []),
      ] as const);
    }
  } catch (error) {
    const winner = (
      await db.select().from(deploys).where(eq(deploys.id, id)).limit(1)
    )[0];
    if (winner) {
      await assertPersistedDeployAuthority(db, winner);
      assertSameDeployRequest(winner, {
        projectId,
        sha,
        branch,
        environment,
        message,
        url,
        actor,
        automationRunId,
        sourceCommitSha,
        extraJson,
        onboardingProofSessionId: proof?.proofSessionId ?? null,
        onboardingProofCredentialId: proof?.proofCredentialId ?? null,
      });
      return deployReplayResponse(c, winner);
    }
    await assertProjectExternalWritesOpen(c.env, projectId);
    if (automationRun) {
      const current = (
        await db.select({ status: automationRuns.status }).from(automationRuns)
          .where(eq(automationRuns.id, automationRun.id)).limit(1)
      )[0];
      if (current && current.status !== "draft_pr_opened") {
        throw errors.conflict(
          "run_changed_before_deploy_commit",
          "The automation run changed before deploy state, history, and outbox could commit.",
          "Do not deploy again. Read the run and deploy history, then reconcile with a human.",
          { run_id: automationRun.id, current_status: current.status },
        );
      }
    }
    throw error;
  }
  const waitUntil = waitUntilOf(c);
  await assertWebhookOutboxPersisted(c.env, outbox);
  await dispatchPersistedWebhookDeliveries(
    c.env,
    outbox.deliveryIds,
    waitUntil,
  );

  return c.json({
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      applies_to: "accepted_deploy_metadata",
      persisted_view: "secret_redacted_control_escaped_bounded",
    },
    content_inspection: observation.inspection,
    id,
    project_id: projectId,
    sha,
    automation_run_id: automationRunId,
    source_commit_sha: sourceCommitSha,
    received_at: now,
    idempotent_replay: false,
    provenance: {
      trust_level: principal.trustLevel,
      credential_kind: principal.kind,
      credential_id: principal.credentialId,
    },
    next_action:
      "Deploy recorded as trusted CI evidence. Correlate PostHog errors and analytics by an application-emitted release/deploy property when one exists; otherwise report timestamp-only correlation as uncertain. Agentry does not stamp or rewrite customer PostHog events.",
  });
}

interface DeployRequestIdentity {
  projectId: string;
  sha: string;
  branch: string | null;
  environment: string | null;
  message: string | null;
  url: string | null;
  actor: string | null;
  automationRunId: string | null;
  sourceCommitSha: string | null;
  extraJson: string | null;
  onboardingProofSessionId: string | null;
  onboardingProofCredentialId: string | null;
}

function assertSameDeployRequest(
  existing: typeof deploys.$inferSelect,
  expected: DeployRequestIdentity,
): void {
  const actual = {
    projectId: existing.projectId,
    sha: existing.sha,
    branch: existing.branch,
    environment: existing.environment,
    message: existing.message,
    url: existing.url,
    actor: existing.actor,
    automationRunId: existing.automationRunId,
    sourceCommitSha: existing.sourceCommitSha,
    extraJson: existing.extraJson,
    onboardingProofSessionId: existing.onboardingProofSessionId,
    onboardingProofCredentialId: existing.onboardingProofCredentialId,
  };
  if (canonicalJsonStringify(actual) !== canonicalJsonStringify(expected)) {
    throw errors.conflict(
      "idempotency_key_reused",
      "This deploy Idempotency-Key was already used with different release evidence.",
      "Replay the exact original deploy request or use the CI provider id for the distinct deployment. Never overwrite a recorded release.",
      { deploy_id: existing.id },
    );
  }
}

function deployReplayResponse(
  c: import("hono").Context<AppBindings>,
  row: typeof deploys.$inferSelect,
) {
  return c.json({
    id: row.id,
    project_id: row.projectId,
    sha: row.sha,
    automation_run_id: row.automationRunId,
    source_commit_sha: row.sourceCommitSha,
    received_at: row.receivedAt,
    idempotent_replay: true,
    next_action: row.automationRunId
      ? "The exact deploy is already bound. Run server verification after the saved observation window."
      : "The exact deploy is already recorded. Do not emit it again; continue with post-deploy monitoring.",
  });
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Capture every top-level field that's NOT one of the structured columns into
// extra_json. Lets customers attach things like commit_count, ci_run_id,
// build_id, pipeline_url — anything — and have them queryable via json_extract.
const KNOWN_DEPLOY_FIELDS = new Set([
  "sha", "branch", "environment", "message", "url", "actor", "kind",
  "automation_run_id", "source_commit_sha",
  "$agentry_onboarding_proof_session_id", "$agentry_onboarding_proof_credential_id",
  "onboarding_proof_session_id", "onboarding_proof_credential_id",
]);
function pickExtras(b: Record<string, unknown> | null): string | null {
  if (!b) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (KNOWN_DEPLOY_FIELDS.has(k)) continue;
    out[k] = v;
  }
  if (Object.keys(out).length === 0) return null;
  // Preserve valid JSON while applying the 16 KiB column budget. Keys that do
  // not fit are omitted instead of slicing JSON into an unparsable fragment.
  const bounded: Record<string, unknown> = {};
  let omitted = 0;
  for (const [key, value] of Object.entries(out)) {
    bounded[key] = value;
    if (JSON.stringify(bounded).length > 16_384) {
      delete bounded[key];
      omitted += 1;
    }
  }
  if (omitted > 0) bounded.$agentry_omitted_extra_fields = omitted;
  return canonicalJsonStringify(bounded);
}

function httpsUrlOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 500) {
    throw errors.invalidPayload({ reason: "url must be an absolute HTTPS URL of at most 500 characters" });
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
    return parsed.toString();
  } catch {
    throw errors.invalidPayload({ reason: "url must be an absolute HTTPS URL without embedded credentials" });
  }
}

interface DeployAuthority {
  credentialBoundCi: boolean;
  automationBindingValid: boolean;
}

export function serializeDeploy(
  d: import("@agentry/db/schema").Deploy,
  authority: DeployAuthority | undefined,
) {
  const observation = prepareTelemetryObservation({
    sha: d.sha,
    branch: d.branch,
    environment: d.environment,
    message: d.message,
    url: d.url,
    actor: d.actor,
    extra: d.extraJson ? safeParseJson(d.extraJson) : null,
  });
  // Labels and non-null identifiers are observations, not authority. Every
  // live row must still prove its exact same-project credential join.
  if (authority?.credentialBoundCi !== true) {
    throw errors.persistenceFailed(
      "The stored deploy receipt lacks exact trusted CI credential provenance.",
      "Stop and repair the immutable deploy record; never reinterpret labels, a dangling id, or a wrong-project credential as trusted release evidence.",
      { deploy_id: d.id, automation_run_id: d.automationRunId },
    );
  }
  return {
    id: d.id,
    emitter: {
      trust_level: d.trustLevel,
      credential_kind: d.credentialKind,
      credential_id: d.credentialId,
    },
    control: {
      automation_run_id: d.automationRunId,
      source_commit_sha: d.sourceCommitSha,
      binding_authority:
        authority.automationBindingValid === true
          ? "trusted_ci"
          : null,
      attribution_authority: "credential_bound_ci",
    },
    evidence: observation.content,
    inspection: observation.inspection,
    received_at: d.receivedAt,
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Helper exported for cases.ts to look up nearby deploys.
export async function recentDeploysFor(
  c: import("hono").Context<AppBindings>,
  projectId: string,
  limit: number = 5,
) {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(deploys)
    .where(and(eq(deploys.projectId, projectId), customerDeployFilter))
    .orderBy(desc(deploys.receivedAt))
    .limit(limit);
  const authority = await loadDeployAuthority(db, rows);
  return rows.map((row) => serializeDeploy(row, authority.get(row.id)));
}

async function loadDeployAuthority(
  db: ReturnType<typeof getDb>,
  rows: Array<typeof deploys.$inferSelect>,
): Promise<Map<string, DeployAuthority>> {
  const runIds = [...new Set(rows.flatMap((row) => row.automationRunId ? [row.automationRunId] : []))];
  const runRows = runIds.length === 0
    ? []
    : await db.select({
      id: automationRuns.id,
      projectId: automationRuns.projectId,
      commitSha: automationRuns.commitSha,
      deploySha: automationRuns.deploySha,
      prProofHash: automationRuns.prProofHash,
      prProofCredentialId: automationRuns.prProofCredentialId,
    }).from(automationRuns).where(inArray(automationRuns.id, runIds));
  const credentialIds = [...new Set([
    ...rows.flatMap((row) => row.credentialId ? [row.credentialId] : []),
    ...runRows.flatMap((row) => row.prProofCredentialId ? [row.prProofCredentialId] : []),
  ])];
  const credentialRows = credentialIds.length === 0
    ? []
    : await db.select({
      id: projectCredentials.id,
      projectId: projectCredentials.projectId,
      kind: projectCredentials.kind,
      tokenHash: projectCredentials.tokenHash,
    }).from(projectCredentials).where(inArray(projectCredentials.id, credentialIds));
  const credentialById = new Map(credentialRows.map((row) => [row.id, row]));
  const runById = new Map(runRows.map((row) => [row.id, row]));
  return new Map(rows.map((row) => {
    const credential = row.credentialId ? credentialById.get(row.credentialId) : undefined;
    const run = row.automationRunId ? runById.get(row.automationRunId) : undefined;
    const proofCredential = run?.prProofCredentialId
      ? credentialById.get(run.prProofCredentialId)
      : undefined;
    const credentialBoundCi =
      row.trustLevel === "trusted_ci" &&
      row.credentialKind === "ci_deploy" &&
      credential?.projectId === row.projectId &&
      credential.kind === "ci_deploy" &&
      !credential.tokenHash.startsWith("legacy-disabled:");
    const automationBindingValid = Boolean(
      credentialBoundCi &&
      row.automationRunId &&
      row.sourceCommitSha &&
      run &&
      run.projectId === row.projectId &&
      run.commitSha &&
      run.commitSha === row.sourceCommitSha &&
      run.deploySha === row.sha &&
      run.prProofHash &&
      run.prProofHash.trim().length > 0 &&
      run.prProofCredentialId &&
      proofCredential?.projectId === run.projectId &&
      proofCredential.kind === "ci_deploy" &&
      !proofCredential.tokenHash.startsWith("legacy-disabled:"),
    );
    return [row.id, { credentialBoundCi, automationBindingValid }];
  }));
}

async function assertPersistedDeployAuthority(
  db: ReturnType<typeof getDb>,
  row: typeof deploys.$inferSelect,
  options: { requireBinding?: boolean } = {},
): Promise<void> {
  const authority = (await loadDeployAuthority(db, [row])).get(row.id)!;
  if (!authority.credentialBoundCi) {
    throw errors.persistenceFailed(
      "The stored deploy receipt lacks exact trusted CI credential provenance.",
      "Stop and repair the immutable deploy record; never reinterpret labels, a dangling id, or a wrong-project credential as trusted release evidence.",
      { deploy_id: row.id, automation_run_id: row.automationRunId },
    );
  }
  const hasRun = row.automationRunId !== null;
  const hasCommit = row.sourceCommitSha !== null;
  if (hasRun !== hasCommit || ((options.requireBinding || hasRun) && !authority.automationBindingValid)) {
    throw errors.persistenceFailed(
      "The stored automation deploy binding is incomplete or does not match its exact same-project run and commit.",
      "Stop verification and repair the immutable deploy/run binding; do not report this record as an idempotent trusted replay.",
      { deploy_id: row.id, automation_run_id: row.automationRunId, source_commit_sha: row.sourceCommitSha },
    );
  }
}

export default router;
