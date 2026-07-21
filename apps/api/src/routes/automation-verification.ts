import { Hono, type Context } from "hono";
import { and, eq, isNotNull, isNull, notLike } from "drizzle-orm";
import {
  AutomationApprovalSubjectSchema,
  AutomationDefinitionSchema,
  RecordAutomationPrProofSchema,
  TELEMETRY_DATA_BOUNDARY,
  canonicalJsonStringify,
  errors,
  prepareTelemetryObservation,
  sha256Hex,
  type AutomationDefinition,
  type RecordAutomationPrProof,
} from "@agentrysh/shared";
import {
  automationActionGrants,
  automationRuns,
  caseClaims,
  cases,
  deploys,
  projectCredentials,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";
import { positiveIntOr, readBoundedJson } from "../bounded-json.js";
import {
  authenticateProjectCredential,
} from "../project-credential-auth.js";
import { requireAutomationMutationAuthority } from "../automation-mutation-auth.js";
import {
  requireApiKeyOrAutomationRunner,
  requireProjectAccess,
} from "../middleware.js";
import {
  findAutomation,
  isAutomationContractEnabled,
  loadAutomationContract,
} from "../automation-contracts.js";
import {
  getQueryBlueprint,
  prepareQueryBlueprintExecution,
  type QueryBlueprint,
} from "../query-blueprints.js";
import { assertQueryBlueprintInputReadiness } from "../query-blueprint-readiness.js";
import { runOperationalBlueprintRows } from "../operational-blueprints.js";
import {
  hogQlRowsToObjects,
  isPosthogConfigured,
  runHogQl,
} from "../posthog.js";
import {
  appendAutomationRunEvent,
  atomicAutomationHistory,
  mutateAutomationRunWithEvent,
} from "../automation-atomic-history.js";
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "../automation-deletion-boundary.js";

const router = new Hono<AppBindings>();
const runnerOrOwner = requireApiKeyOrAutomationRunner();

class AtomicVerificationConflict extends Error {
  constructor() {
    super("automation verification lost run status compare-and-set");
    this.name = "AtomicVerificationConflict";
  }
}

/**
 * Trusted CI records provider-observed PR facts. Runner credentials are
 * intentionally rejected: a runner cannot attest its own branch, diff, tests,
 * draft state, or repository binding.
 */
router.post("/v1/automation-runs/:run_id/pr-proof", async (c) => {
  const principal = await authenticateProjectCredential(c);
  if (principal.kind !== "ci_deploy" || !principal.scopes.includes("automation_proofs:write")) {
    throw errors.credentialScopeDenied("automation_proofs:write", principal.kind, {
      credential_id: principal.credentialId,
    });
  }
  const parsed = RecordAutomationPrProofSchema.safeParse(await readJsonBody(c));
  if (!parsed.success) throw errors.invalidPayload({ zod: parsed.error.flatten() });
  const observation = prepareTelemetryObservation(parsed.data);
  const accepted = RecordAutomationPrProofSchema.safeParse(observation.content);
  if (!accepted.success) {
    throw errors.invalidPayload({
      reason: "CI proof became invalid after required secret redaction and control escaping",
      zod: accepted.error.flatten(),
    });
  }

  const db = getDb(c.env);
  const run = (
    await db.select().from(automationRuns).where(eq(automationRuns.id, c.req.param("run_id"))).limit(1)
  )[0];
  if (!run) throw errors.notFound("automation_run");
  if (run.projectId !== principal.projectId) {
    throw errors.forbidden("The CI credential belongs to a different project.");
  }
  const policy = parseRunPolicy(run);
  await requireCurrentAutomationEnabled(db, run);
  if (run.status !== "draft_pr_opened" || !run.prUrl || !run.branch || !run.commitSha) {
    throw errors.conflict(
      "pr_proof_not_expected",
      "The run is not waiting for trusted proof of one recorded draft PR.",
      "Record the pre-authorized draft PR first, or read the existing immutable proof.",
      { status: run.status },
    );
  }
  if (!policy.runner.repository || !policy.runner.default_branch) {
    throw errors.persistenceFailed(
      "draft-PR policy snapshot has no repository binding",
      "Stop and escalate; never infer repository or branch identity for CI proof.",
      { run_id: run.id },
    );
  }
  assertSameRepository(policy.runner.repository, accepted.data.repository);
  if (
    normalizeUrl(accepted.data.pr_url) !== normalizeUrl(run.prUrl) ||
    accepted.data.head_sha.toLowerCase() !== run.commitSha.toLowerCase() ||
    accepted.data.head_branch !== run.branch ||
    accepted.data.base_branch !== policy.runner.default_branch
  ) {
    throw errors.conflict(
      "pr_proof_mismatch",
      "Trusted CI proof does not match the run's exact repository, PR, branch, commit, and base branch.",
      "Stop the automation and reconcile the provider state; never bind a different PR or commit.",
      {
        expected_pr_url: run.prUrl,
        expected_head_sha: run.commitSha,
        expected_head_branch: run.branch,
        expected_base_branch: policy.runner.default_branch,
      },
    );
  }
  const grant = (
    await db
      .select()
      .from(automationActionGrants)
      .where(
        and(
          eq(automationActionGrants.runId, run.id),
          eq(automationActionGrants.projectId, run.projectId),
          eq(automationActionGrants.automationId, run.automationId),
          eq(automationActionGrants.action, "draft_pr"),
          eq(automationActionGrants.status, "consumed"),
        ),
      )
      .limit(1)
  )[0];
  if (!grant) {
    throw errors.persistenceFailed(
      "draft PR has no consumed pre-action grant",
      "Stop and escalate; provider proof cannot retroactively create action authority.",
      { run_id: run.id },
    );
  }
  const proofSubject = canonicalDraftSubject(accepted.data);
  const subjectHash = await sha256Hex(canonicalJsonStringify(proofSubject));
  if (subjectHash !== grant.subjectHash) {
    throw errors.conflict(
      "pr_proof_scope_mismatch",
      "The provider-observed diff or tests differ from the immutable pre-action grant.",
      "Do not continue to deploy. Escalate the out-of-scope provider state for human review.",
      { grant_subject_hash: grant.subjectHash, proof_subject_hash: subjectHash },
    );
  }
  const proofJson = canonicalJsonStringify(accepted.data);
  const proofHash = await sha256Hex(proofJson);
  if (run.prProofHash) {
    if (run.prProofHash !== proofHash || run.prProofCredentialId !== principal.credentialId) {
      throw errors.conflict(
        "pr_proof_immutable",
        "This run already has a different immutable CI proof.",
        "Read the recorded proof; do not overwrite provider evidence.",
        { proof_hash: run.prProofHash },
      );
    }
    return c.json({ run_id: run.id, proof_hash: proofHash, recorded_at: run.prProofAt, idempotent_replay: true });
  }
  const now = Math.floor(Date.now() / 1000);
  const recorded = await mutateAutomationRunWithEvent(db, {
    runId: run.id,
    expectedStatus: "draft_pr_opened",
    nextStatus: "draft_pr_opened",
    patch: {
      prProofJson: proofJson,
      prProofHash: proofHash,
      prProofCredentialId: principal.credentialId,
      prProofAt: now,
    },
    guard: isNull(automationRuns.prProofHash),
    event: {
      name: "pr.proof_recorded",
      actor: `credential:${principal.credentialId}`,
      data: { proof_hash: proofHash, subject_hash: subjectHash, pr_number: accepted.data.pr_number },
    },
    at: now,
  });
  if (!recorded.applied) {
    const winner = (await db.select().from(automationRuns).where(eq(automationRuns.id, run.id)).limit(1))[0];
    if (winner?.prProofHash === proofHash && winner.prProofCredentialId === principal.credentialId) {
      return c.json({ run_id: run.id, proof_hash: proofHash, recorded_at: winner.prProofAt, idempotent_replay: true });
    }
    throw errors.conflict("run_changed", "The run or PR proof changed concurrently.", "Read the durable proof and do not submit another provider assertion.");
  }
  return c.json({
    run_id: run.id,
    proof_hash: proofHash,
    recorded_at: now,
    idempotent_replay: false,
    next_action: "CI may deploy this exact proven commit. The deploy event must include automation_run_id and source_commit_sha.",
  });
});

/** Execute the immutable verification plan server-side; the caller supplies no result. */
router.post("/v1/automation-runs/:run_id/verify", runnerOrOwner, async (c) => {
  const run = await loadAuthorizedRun(c, c.req.param("run_id"));
  await requireAutomationMutationAuthority(c, "runs:write", run.projectId, run.automationId);
  const storedVerification = run.verificationJson ? safeObject(run.verificationJson) : null;
  if (
    ["succeeded", "failed", "escalated"].includes(run.status) &&
    storedVerification?.state === "complete"
  ) {
    return c.json({
      run_id: run.id,
      status: run.status,
      verification: storedVerification,
      idempotent_replay: true,
    });
  }
  if (run.status !== "verifying" || !run.verificationStartedAt || !run.deploySha || !run.prProofHash) {
    throw errors.conflict(
      "verification_not_ready",
      "The run lacks the trusted PR proof and CI-bound deploy required for server verification.",
      "Wait for trusted CI to record PR proof and a deploy bound to the exact source commit.",
      { status: run.status },
    );
  }
  const policy = parseRunPolicy(run);
  if (!policy.verification) {
    throw errors.conflict(
      "verification_not_configured",
      "The immutable run policy has no canonical outcome-plus-traffic verification plan.",
      "Do not infer a query, traffic event, sample gate, or success predicate.",
    );
  }
  const db = getDb(c.env);
  await requireCurrentAutomationEnabled(db, run);
  const trustedDeploys = await db
      .select({
        id: deploys.id,
        projectId: deploys.projectId,
        sha: deploys.sha,
        sourceCommitSha: deploys.sourceCommitSha,
        receivedAt: deploys.receivedAt,
        credentialId: deploys.credentialId,
        credentialKind: deploys.credentialKind,
        trustLevel: deploys.trustLevel,
      })
      .from(deploys)
      .innerJoin(projectCredentials, and(
        eq(projectCredentials.id, deploys.credentialId),
        eq(projectCredentials.projectId, deploys.projectId),
        eq(projectCredentials.kind, "ci_deploy"),
        notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
      ))
      .where(
        and(
          eq(deploys.projectId, run.projectId),
          eq(deploys.automationRunId, run.id),
          eq(deploys.sha, run.deploySha),
          eq(deploys.sourceCommitSha, run.commitSha!),
          eq(deploys.trustLevel, "trusted_ci"),
          eq(deploys.credentialKind, "ci_deploy"),
          isNotNull(deploys.credentialId),
        ),
      )
      .limit(2);
  if (trustedDeploys.length !== 1) {
    throw errors.conflict(
      "trusted_deploy_missing",
      trustedDeploys.length === 0
        ? "No trusted CI deploy binds this run to its proven source commit."
        : "More than one trusted CI deploy binds this run, SHA, and source commit.",
      "Repair or reconcile the CI deploy record; never accept a runner-supplied deploy identity or choose between ambiguous proofs.",
      { matches: trustedDeploys.length },
    );
  }
  const trustedDeploy = trustedDeploys[0]!;
  if (run.verificationStartedAt !== trustedDeploy.receivedAt) {
    throw errors.persistenceFailed(
      "the verification clock is not anchored to the exact trusted deploy receipt",
      "Stop and reconcile the atomic deploy/run transition. Do not substitute a wall-clock or runner timestamp.",
      {
        run_id: run.id,
        verification_started_at: run.verificationStartedAt,
        deploy_received_at: trustedDeploy.receivedAt,
      },
    );
  }
  const checkedAt = Math.floor(Date.now() / 1000);
  const earliest = trustedDeploy.receivedAt + policy.verification.observation_window_seconds;
  if (checkedAt < earliest) {
    return c.json({
      run_id: run.id,
      status: "verifying",
      verification_ready_at: earliest,
      retry_after_seconds: earliest - checkedAt,
      next_action: "Wait for the complete observation window before running either saved verification query.",
    }, 202);
  }

  const verification = policy.verification;
  const sampleBlueprint = requireCanonicalVerificationBlueprint(
    verification.sample.blueprint_id,
    "deploy_traffic_sample",
    "sample_count",
    "analytics",
  );
  const outcomeBlueprint = requireCanonicalVerificationBlueprint(
    verification.outcome.blueprint_id,
    "case_recurrence",
    "recurrence_count",
    "operational",
  );
  const resolved = resolveVerificationParams(run, trustedDeploy, checkedAt, verification);
  const preparedSample = prepareSavedVerificationExecution(
    sampleBlueprint,
    resolved.sample,
    run.id,
  );
  const inputReadiness = await assertQueryBlueprintInputReadiness(
    db,
    run.projectId,
    sampleBlueprint,
    preparedSample.params,
  );
  const sampleExecution = await executeVerificationCountQuery(c, {
    db,
    projectId: run.projectId,
    blueprint: sampleBlueprint,
    prepared: preparedSample,
    countColumn: "sample_count",
  });
  const sampleSize = sampleExecution.count;
  const enoughSamples = sampleSize >= verification.sample.min_sample_size;
  const deadline = trustedDeploy.receivedAt + policy.verification.max_wait_seconds;
  const window = {
    start_at: trustedDeploy.receivedAt,
    end_at: checkedAt,
    bounds: "[start,end)" as const,
  };
  const trustedDeployIdentity = {
    id: trustedDeploy.id,
    sha: trustedDeploy.sha,
    source_commit_sha: trustedDeploy.sourceCommitSha,
    received_at: trustedDeploy.receivedAt,
    credential_id: trustedDeploy.credentialId,
    credential_kind: trustedDeploy.credentialKind,
    trust_level: trustedDeploy.trustLevel,
  };
  const sampleProof = {
    state: enoughSamples ? "sufficient" as const : "insufficient" as const,
    blueprint_id: sampleBlueprint.id,
    event_name: verification.sample.params.event_name,
    sample_count: sampleSize,
    min_sample_size: verification.sample.min_sample_size,
    rows: sampleExecution.rows,
    window,
    input_readiness: inputReadiness,
    data_boundary: sampleExecution.dataBoundary,
  };
  const emptyOutcome = {
    state: "not_executed" as const,
    blueprint_id: outcomeBlueprint.id,
    reason: "sample_gate_not_met" as const,
    rows: [] as Array<Record<string, unknown>>,
    window,
    data_boundary: emptyVerificationBoundary("rows"),
  };
  if (!enoughSamples && checkedAt < deadline) {
    const pending = {
      state: "pending_sample",
      checked_at: checkedAt,
      trusted_deploy: trustedDeployIdentity,
      sample: sampleProof,
      outcome: emptyOutcome,
      retry_after_seconds: Math.min(300, deadline - checkedAt),
      deadline_at: deadline,
    };
    const pendingJson = canonicalJsonStringify(pending);
    if (pendingJson !== run.verificationJson) {
      const recordedPending = await mutateAutomationRunWithEvent(db, {
        runId: run.id,
        expectedStatus: "verifying",
        nextStatus: "verifying",
        patch: { verificationJson: pendingJson },
        guard: run.verificationJson === null
          ? isNull(automationRuns.verificationJson)
          : eq(automationRuns.verificationJson, run.verificationJson),
        event: {
          name: "verification.sample_pending",
          actor: "agentry_system",
          data: {
            sample_blueprint_id: sampleBlueprint.id,
            outcome_blueprint_id: outcomeBlueprint.id,
            deploy_id: trustedDeploy.id,
            deploy_sha: trustedDeploy.sha,
            checked_at: checkedAt,
            sample_count: sampleSize,
            min_sample_size: verification.sample.min_sample_size,
            deadline_at: deadline,
          },
        },
        at: checkedAt,
      });
      if (!recordedPending.applied) {
        throw errors.conflict(
          "run_changed",
          "The run changed while the verification sample check was being recorded.",
          "Read the durable run before retrying verification.",
        );
      }
    }
    return c.json({ run_id: run.id, status: "verifying", verification: pending, next_action: "Insufficient post-deploy samples. Retry until deadline_at; zero traffic never proves success." }, 202);
  }

  let outcomeProof = emptyOutcome as typeof emptyOutcome | {
    state: "evaluated";
    blueprint_id: string;
    recurrence_count: number;
    predicate: typeof verification.outcome.predicate;
    passed: boolean;
    rows: Array<Record<string, unknown>>;
    window: typeof window;
    data_boundary: ReturnType<typeof emptyVerificationBoundary>;
  };
  let predicatePassed = false;
  if (enoughSamples) {
    const preparedOutcome = prepareSavedVerificationExecution(
      outcomeBlueprint,
      resolved.outcome,
      run.id,
    );
    const outcomeExecution = await executeVerificationCountQuery(c, {
      db,
      projectId: run.projectId,
      blueprint: outcomeBlueprint,
      prepared: preparedOutcome,
      countColumn: "recurrence_count",
    });
    predicatePassed = comparePredicate(
      outcomeExecution.count,
      verification.outcome.predicate.operator,
      verification.outcome.predicate.value,
    );
    outcomeProof = {
      state: "evaluated",
      blueprint_id: outcomeBlueprint.id,
      recurrence_count: outcomeExecution.count,
      predicate: verification.outcome.predicate,
      passed: predicatePassed,
      rows: outcomeExecution.rows,
      window,
      data_boundary: outcomeExecution.dataBoundary,
    };
  }
  const result = {
    state: "complete",
    checked_at: checkedAt,
    trusted_deploy: trustedDeployIdentity,
    sample: sampleProof,
    outcome: outcomeProof,
    passed: predicatePassed,
  };
  const target = predicatePassed ? "succeeded" : "failed";
  let finalTarget: "succeeded" | "failed" | "escalated" = target;
  try {
    finalTarget = await atomicAutomationHistory(db, async (tx) => {
      let atomicTarget: "succeeded" | "failed" | "escalated" = target;
      if (predicatePassed && run.caseId && run.caseRevision !== null) {
        const annotated = await tx
          .update(cases)
          .set({
            agentSummary: `Automation run ${run.id} passed server verification without recurrence after its trusted deploy. PostHog issue lifecycle was not changed.`,
          })
          .where(
            and(
              eq(cases.id, run.caseId),
              eq(cases.revision, run.caseRevision),
            ),
          )
          .returning({ id: cases.id });
        if (annotated.length === 0) atomicTarget = "escalated";
      }
      const transitioned = await tx
        .update(automationRuns)
        .set({
          status: atomicTarget,
          verificationJson: canonicalJsonStringify(result),
          errorCode: atomicTarget === "escalated"
            ? "case_changed"
            : predicatePassed ? null : enoughSamples ? "verification_failed" : "verification_sample_timeout",
          errorMessage: atomicTarget === "escalated"
            ? "Case changed before the verified outcome could be annotated."
            : predicatePassed ? null : enoughSamples
              ? "The exact claimed case recurred after the trusted deploy."
              : "Approved post-deploy traffic did not reach the minimum sample before max_wait_seconds.",
          retryEligibleAt: atomicTarget === "failed"
            ? checkedAt + policy.failure_policy.retry_backoff_seconds
            : null,
          finishedAt: checkedAt,
          updatedAt: checkedAt,
        })
        .where(and(
          eq(automationRuns.id, run.id),
          eq(automationRuns.status, "verifying"),
          automationWritesOpenForProject(automationRuns.projectId),
        ))
        .returning({ id: automationRuns.id });
      if (transitioned.length !== 1) throw new AtomicVerificationConflict();
      await tx.update(caseClaims).set({
        releasedAt: checkedAt,
        releaseReason: atomicTarget === "succeeded" ? "completed" : atomicTarget === "failed" ? "failed" : "escalated",
      }).where(and(eq(caseClaims.runId, run.id), isNull(caseClaims.releasedAt)));
      await appendAutomationRunEvent(tx, {
        projectId: run.projectId,
        runId: run.id,
        name: `verification.${atomicTarget}`,
        fromStatus: "verifying",
        toStatus: atomicTarget,
        actor: "agentry_system",
        data: {
          sample_blueprint_id: sampleBlueprint.id,
          outcome_blueprint_id: outcomeBlueprint.id,
          deploy_id: trustedDeploy.id,
          deploy_sha: trustedDeploy.sha,
          checked_at: checkedAt,
          sample_count: sampleSize,
          min_sample_size: verification.sample.min_sample_size,
          recurrence_count: outcomeProof.state === "evaluated"
            ? outcomeProof.recurrence_count
            : null,
          passed: predicatePassed,
        },
        at: checkedAt,
      });
      return atomicTarget;
    });
  } catch (error) {
    if (!(error instanceof AtomicVerificationConflict)) throw error;
    const winner = (await db.select().from(automationRuns).where(eq(automationRuns.id, run.id)).limit(1))[0];
    const winnerVerification = winner?.verificationJson ? safeObject(winner.verificationJson) : null;
    if (winnerVerification?.state === "complete" && ["succeeded", "failed", "escalated"].includes(winner!.status)) {
      return c.json({ run_id: winner!.id, status: winner!.status, verification: winnerVerification, idempotent_replay: true });
    }
    throw errors.conflict("run_changed", "The run changed while server verification was completing.", "Read the durable run outcome; never apply the query result to another state.");
  }
  return c.json({
    run_id: run.id,
    status: finalTarget,
    verification: result,
    idempotent_replay: false,
    next_action: finalTarget === "succeeded"
      ? "Approved traffic met the sample gate and the exact case did not recur. The claimed case revision was annotated without changing PostHog issue lifecycle; review the draft PR lifecycle before any merge policy acts."
      : finalTarget === "escalated"
        ? "The verification query passed, but the claimed case revision changed before its outcome could be annotated. Re-read the PostHog-backed case projection before deciding whether to retry."
        : "Verification did not establish success. The claim is released with retry backoff; inspect the separate traffic and recurrence proofs before another attempt.",
  });
});

async function loadAuthorizedRun(c: Context<AppBindings>, runId: string) {
  const db = getDb(c.env);
  const run = (await db.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1))[0];
  if (!run) throw errors.notFound("automation_run");
  await requireProjectAccess(c, run.projectId);
  await assertAutomationWritesOpen(db, run.projectId);
  return run;
}

async function requireCurrentAutomationEnabled(
  db: ReturnType<typeof getDb>,
  run: typeof automationRuns.$inferSelect,
) {
  const loaded = await loadAutomationContract(db, run.projectId);
  const automation = loaded ? findAutomation(loaded, run.automationId) : null;
  if (!loaded || !isAutomationContractEnabled(loaded) || !automation?.enabled) {
    throw errors.conflict(
      "automation_kill_switch_active",
      "The automation is paused or disabled, so trusted proof and verification cannot advance it.",
      "Leave the run stopped and have an owner review the contract and in-flight work.",
    );
  }
  return automation;
}

function parseRunPolicy(run: typeof automationRuns.$inferSelect): AutomationDefinition {
  const parsed = AutomationDefinitionSchema.safeParse(safeObject(run.policySnapshotJson));
  if (!parsed.success) {
    throw errors.persistenceFailed("automation run policy snapshot is invalid", "Stop and escalate; never infer verification authority.", { run_id: run.id });
  }
  return parsed.data;
}

function canonicalDraftSubject(proof: RecordAutomationPrProof) {
  const parsed = AutomationApprovalSubjectSchema.parse({
    kind: "draft_pr",
    branch: proof.head_branch,
    commit_sha: proof.head_sha,
    change_types: [...new Set(proof.change_types)].sort(),
    changed_files: [...new Set(proof.changed_files)].sort(),
    changed_lines: proof.changed_lines,
    tests: [...proof.tests].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
  return parsed;
}

function assertSameRepository(expected: string, received: string): void {
  const normalize = (value: string) => {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\.git$/, "")}`.toLowerCase();
  };
  if (normalize(expected) !== normalize(received)) {
    throw errors.conflict("pr_repository_mismatch", "CI proof names a different repository than the immutable policy.", "Stop and submit proof only for the configured repository.", { expected, received });
  }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

type VerificationPolicy = NonNullable<AutomationDefinition["verification"]>;

function resolveVerificationParams(
  run: typeof automationRuns.$inferSelect,
  trustedDeploy: Pick<typeof deploys.$inferSelect, "sourceCommitSha" | "sha" | "receivedAt">,
  checkedAt: number,
  verification: VerificationPolicy,
): {
  sample: Record<string, string | number>;
  outcome: Record<string, string | number>;
} {
  if (
    !run.caseId ||
    run.caseRevision === null ||
    !run.deploySha ||
    trustedDeploy.sourceCommitSha !== run.commitSha ||
    trustedDeploy.sha !== run.deploySha
  ) {
    throw errors.persistenceFailed(
      "verification run parameters are not bound to one case revision and trusted deploy",
      "Stop and reconcile the run, claim, PR proof, and CI deploy. Do not invent or substitute a parameter.",
      { run_id: run.id },
    );
  }
  const deployedAt = new Date(trustedDeploy.receivedAt * 1_000).toISOString();
  const checkedAtIso = new Date(checkedAt * 1_000).toISOString();
  return {
    sample: {
      deploy_sha: trustedDeploy.sha,
      deployed_at: deployedAt,
      checked_at: checkedAtIso,
      event_name: verification.sample.params.event_name,
    },
    outcome: {
      run_id: run.id,
      case_id: run.caseId,
      case_revision: run.caseRevision,
      deploy_sha: trustedDeploy.sha,
      deployed_at: deployedAt,
      checked_at: checkedAtIso,
    },
  };
}

function requireCanonicalVerificationBlueprint(
  blueprintId: string,
  kind: "deploy_traffic_sample" | "case_recurrence",
  countColumn: "sample_count" | "recurrence_count",
  backend: "analytics" | "operational",
): QueryBlueprint {
  const blueprint = getQueryBlueprint(blueprintId);
  const metadata = blueprint?.automation_verification;
  if (
    !blueprint ||
    blueprint.backend !== backend ||
    blueprint.strict_params !== true ||
    metadata?.kind !== kind ||
    metadata.count_column !== countColumn ||
    metadata.expected_rows !== 1 ||
    metadata.exact_window.start_param !== "deployed_at" ||
    metadata.exact_window.end_param !== "checked_at" ||
    metadata.exact_window.bounds !== "[start,end)" ||
    metadata.exact_window.maximum_seconds !== 2_592_000 ||
    blueprint.expected_columns.length !== 1 ||
    blueprint.expected_columns[0] !== countColumn ||
    blueprint.publication_safety.output_granularity !== "aggregate" ||
    blueprint.publication_safety.identifier_columns.length > 0 ||
    blueprint.publication_safety.accepts_arbitrary_segment_property
  ) {
    throw errors.catalogInconsistent(
      "The canonical automation verification blueprint contract is missing or inconsistent.",
      { blueprint_id: blueprintId, expected_kind: kind, count_column: countColumn },
    );
  }
  if (
    kind === "deploy_traffic_sample" &&
    (
      blueprint.required_event_params?.length !== 1 ||
      blueprint.required_event_params[0] !== "event_name"
    )
  ) {
    throw errors.catalogInconsistent(
      "The canonical traffic sample blueprint must declare event_name as its only required event param.",
      { blueprint_id: blueprintId },
    );
  }
  return blueprint;
}

function prepareSavedVerificationExecution(
  blueprint: QueryBlueprint,
  params: Record<string, string | number>,
  runId: string,
) {
  try {
    return prepareQueryBlueprintExecution(blueprint, params);
  } catch (error) {
    throw errors.persistenceFailed(
      "saved verification params do not satisfy the canonical blueprint",
      "Escalate this run; do not substitute, default, or coerce verification parameters.",
      {
        run_id: runId,
        blueprint_id: blueprint.id,
        detail: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function executeVerificationCountQuery(
  c: Context<AppBindings>,
  input: {
    db: ReturnType<typeof getDb>;
    projectId: string;
    blueprint: QueryBlueprint;
    prepared: ReturnType<typeof prepareQueryBlueprintExecution>;
    countColumn: "sample_count" | "recurrence_count";
  },
): Promise<{
  count: number;
  rows: Array<Record<string, unknown>>;
  dataBoundary: ReturnType<typeof emptyVerificationBoundary>;
}> {
  let rows: Array<Record<string, unknown>>;
  if (input.blueprint.backend === "analytics") {
    if (!isPosthogConfigured(c.env)) {
      throw errors.posthogConnectionRequired({
        operation: "automation_verification",
        blueprint_id: input.blueprint.id,
      });
    }
    const output = await runHogQl(c.env, input.projectId, input.prepared.query, {
      cacheBust: true,
    });
    if (
      !output.columns ||
      output.columns.length !== 1 ||
      output.columns[0] !== input.countColumn
    ) {
      throw errors.persistenceFailed(
        "verification query output columns do not match the canonical count contract",
        "Stop verification and repair the catalog/upstream query shape. Do not infer a count column.",
        { blueprint_id: input.blueprint.id, columns: output.columns },
      );
    }
    rows = hogQlRowsToObjects(
      output.results,
      output.columns,
      input.blueprint.expected_columns,
    );
  } else {
    rows = await runOperationalBlueprintRows(
      c.env,
      input.db,
      input.projectId,
      input.blueprint,
      input.prepared.params,
    );
  }
  if (
    rows.length !== 1 ||
    Object.keys(rows[0] ?? {}).length !== 1 ||
    !(input.countColumn in (rows[0] ?? {}))
  ) {
    throw errors.persistenceFailed(
      "verification query did not return exactly one bounded count row",
      "Stop verification and repair the canonical executor. Never truncate, reorder, or combine verification rows.",
      { blueprint_id: input.blueprint.id, row_count: rows.length },
    );
  }
  const count = rows[0]![input.countColumn];
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw errors.persistenceFailed(
      "verification count is not a safe non-negative integer",
      "Stop verification; do not coerce the query result.",
      { blueprint_id: input.blueprint.id, column: input.countColumn },
    );
  }
  const bounded = prepareTelemetryObservation({ rows }, {
    max_array_items: 1,
    max_object_keys: 1,
    max_string_chars: 100,
  });
  const safeRows = ((bounded.content as { rows?: unknown }).rows ?? []) as Array<
    Record<string, unknown>
  >;
  return {
    count,
    rows: safeRows,
    dataBoundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      applies_to: "rows",
      inspection: bounded.inspection,
    },
  };
}

function emptyVerificationBoundary(appliesTo: string) {
  return {
    ...TELEMETRY_DATA_BOUNDARY,
    applies_to: appliesTo,
    inspection: {
      heuristic_only: true as const,
      indicators: [] as string[],
      external_url_hosts: [] as string[],
      redacted_paths: [] as string[],
      truncated_paths: [] as string[],
    },
  };
}

function comparePredicate(
  observed: number,
  operator: "eq",
  expected: 0,
): boolean {
  if (operator !== "eq" || expected !== 0) {
    throw errors.persistenceFailed(
      "the canonical recurrence predicate changed unexpectedly",
      "Stop verification and restore the exact recurrence_count == 0 policy.",
    );
  }
  return observed === expected;
}

function safeObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readJsonBody(c: Context<AppBindings>): Promise<unknown> {
  return readBoundedJson(c, positiveIntOr(c.env.MAX_BODY_BYTES, 262_144));
}

export default router;
