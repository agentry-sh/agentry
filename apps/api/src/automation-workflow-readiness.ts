import { and, eq, gt, isNull, notLike, sql } from "drizzle-orm";
import { posthogConnections, projectCredentials } from "@agentry/db/schema";
import {
  AgentryError,
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import { z } from "zod";
import type { getDb } from "./db.js";
import {
  AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
  AutomationWorkflowAdapterError,
  requireAutomationWorkflowComponentAdapter,
} from "./automation-workflow-adapters.js";
import type { AutomationWorkflowRequirement } from "./automation-workflow-components.js";
import {
  evaluateOnboardingReadiness,
  loadVerifiedOnboarding,
  type VerifiedOnboarding,
} from "./onboarding-readiness.js";
import { getQueryBlueprint, type QueryBlueprint } from "./query-blueprints.js";
import {
  loadLiveOrderedFunnelExecutionAuthority,
  orderedFunnelBlueprintCompatible,
} from "./automation-workflow-execution-authority.js";
import {
  loadAutomationWorkflow,
  type StoredAutomationWorkflow,
} from "./automation-workflow-store.js";

type Db = ReturnType<typeof getDb>;

const IdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const WorkflowIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/u);
const StrongEtagSchema = z.string().regex(/^"[A-Za-z0-9._:-]+"$/u);
const CallerAssertionIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[a-z][a-z0-9_.:-]*$/u);

const ReadinessInputSchema = z.object({
  project_id: IdSchema,
  automation_id: WorkflowIdSchema,
  expected_revision_id: IdSchema.optional(),
  expected_etag: StrongEtagSchema.optional(),
  owner_confirmed_caller_assertion_ids: z.array(CallerAssertionIdSchema).max(100).optional(),
  observed_at: z.number().int().nonnegative().optional(),
}).strict();

const ENABLED_COMPONENT_KEYS = new Set([
  "agent.funnel-review@1.0.0",
  "effect.report.private@1.0.0",
  "query.analytics.ordered-funnel-period-compare@1.0.0",
  "trigger.schedule.cron@1.0.0",
]);

const KNOWN_CALLER_ASSERTIONS = new Set([
  "ci_proof_callback_configured",
  "deploy_ingest_configured",
  "repository_draft_pr_access_confirmed",
  "scheduler_execution_configured",
]);

const REQUIREMENT_KINDS = new Set<AutomationWorkflowRequirement["kind"]>([
  "approval",
  "caller_assertion",
  "credential",
  "project_readiness",
  "proof",
  "runtime",
]);

export type AutomationWorkflowReadinessInput = z.input<typeof ReadinessInputSchema>;

export type AutomationWorkflowReadinessBlocker = {
  check_id: string;
  code: string;
  message: string;
  next_action: string;
};

export type AutomationWorkflowReadinessCheck = {
  id: string;
  kind: AutomationWorkflowRequirement["kind"] | "unknown";
  required_by_node_ids: string[];
  requirement: string;
  status: "ready" | "blocked";
  evidence_ids: string[];
  blocker: Omit<AutomationWorkflowReadinessBlocker, "check_id"> | null;
};

export type AutomationWorkflowReadiness = {
  kind: "automation_workflow_readiness";
  schema_version: "3";
  project_id: string;
  automation_id: string;
  revision_id: string;
  revision: number;
  etag: string;
  workflow_hash: string;
  compile_hash: string;
  status: "ready" | "blocked";
  readiness_hash: string;
  owner_confirmed_caller_assertion_ids: string[];
  checks: AutomationWorkflowReadinessCheck[];
  blockers: AutomationWorkflowReadinessBlocker[];
  next_action: string;
};

type ActiveCredential = {
  id: string;
  kind: typeof projectCredentials.$inferSelect.kind;
  automationId: string | null;
  prefix: string;
  expiresAt: number;
};

type ReadinessContext = {
  workflow: StoredAutomationWorkflow;
  verifiedOnboarding: VerifiedOnboarding | null;
  activeCredentials: ActiveCredential[];
  posthogConnectionActive: boolean;
  confirmedAssertions: Set<string>;
};

type Requirement = {
  id: string;
  kind: AutomationWorkflowRequirement["kind"];
  requirement: string;
  next_action: string;
  required_by_node_ids: string[];
};

type Decision = {
  ready: boolean;
  evidence_ids?: string[];
  code?: string;
  message?: string;
  next_action?: string;
};

async function databaseNow(db: Db, observedAt?: number): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("database clock did not return unix seconds");
  }
  if (observedAt === undefined) return now;
  if (Math.abs(observedAt - now) > 1) {
    throw errors.invalidPayload({
      reason: "observed_at must match the database clock within one second",
    });
  }
  return now;
}

function blocked(
  code: string,
  message: string,
  nextAction?: string,
  evidenceIds: string[] = [],
): Decision {
  return {
    ready: false,
    evidence_ids: evidenceIds,
    code,
    message,
    ...(nextAction ? { next_action: nextAction } : {}),
  };
}

function ready(evidenceIds: string[] = []): Decision {
  return { ready: true, evidence_ids: evidenceIds };
}

function credentialEvidence(rows: ActiveCredential[]): string[] {
  return rows
    .map((row) => `credential:${row.kind}:${row.id}:${row.prefix}:${row.expiresAt}`)
    .sort();
}

function currentSignalEvidence(state: VerifiedOnboarding | null): string[] {
  return state
    ? [
      `onboarding:${state.onboarding_id}:${state.etag}`,
      `signal_map:${state.plan_sha256}`,
    ]
    : [];
}

function expectedKind(
  requirement: Requirement,
  kind: AutomationWorkflowRequirement["kind"],
): Decision | null {
  if (requirement.kind === kind) return null;
  return blocked(
    "automation_workflow_requirement_contract_mismatch",
    `Requirement ${requirement.id} has kind ${requirement.kind}; ${kind} is required by the installed readiness evaluator.`,
    "Keep the workflow disabled and save a newly compiled revision whose immutable requirement contract matches the installed runtime.",
  );
}

function exactBlueprintDescriptor(blueprint: QueryBlueprint): Record<string, unknown> {
  return {
    id: blueprint.id,
    backend: blueprint.backend,
    strict_params: blueprint.strict_params ?? false,
    required_event_list_param: blueprint.required_event_list_param ?? null,
    query_builder: blueprint.query_builder ?? null,
    automation_readiness: blueprint.automation_readiness ?? null,
    params: blueprint.params,
    expected_columns: blueprint.expected_columns,
    publication_safety: blueprint.publication_safety,
  };
}

async function blueprintDecision(
  requirement: Requirement,
  blueprintId: string,
  exactCompatibility?: (blueprint: QueryBlueprint | null) => blueprint is QueryBlueprint,
): Promise<Decision> {
  const mismatch = expectedKind(requirement, "project_readiness");
  if (mismatch) return mismatch;
  const blueprint = getQueryBlueprint(blueprintId);
  if (!blueprint || (exactCompatibility && !exactCompatibility(blueprint))) {
    return blocked(
      "automation_workflow_query_blueprint_unavailable",
      `The installed ${blueprintId} query blueprint is missing or does not match the reviewed unattended-execution contract.`,
      requirement.next_action,
    );
  }
  const orderedFunnelAuthority = blueprintId === "ordered_funnel_period_compare"
    ? await loadLiveOrderedFunnelExecutionAuthority()
    : null;
  if (blueprintId === "ordered_funnel_period_compare" && !orderedFunnelAuthority) {
    return blocked(
      "automation_workflow_query_blueprint_unavailable",
      "The installed ordered_funnel_period_compare execution descriptor cannot be frozen exactly.",
      requirement.next_action,
    );
  }
  const hash = orderedFunnelAuthority?.descriptor_hash ??
    await sha256Hex(canonicalJsonStringify(exactBlueprintDescriptor(blueprint)));
  return ready([`query_blueprint:${blueprintId}:${hash}`]);
}

async function runtimeAdapterDecision(context: ReadinessContext): Promise<Decision> {
  const components = context.workflow.compiled.resolved_components;
  const unsupported: string[] = [];
  const evidence: string[] = [`adapter_protocol:${AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION}`];
  for (const component of components) {
    const key = `${component.id}@${component.version}`;
    if (!ENABLED_COMPONENT_KEYS.has(key)) {
      unsupported.push(key);
      continue;
    }
    try {
      const adapter = await requireAutomationWorkflowComponentAdapter({
        id: component.id,
        version: component.version,
        component_hash: component.component_hash,
      });
      evidence.push(
        `component_adapter:${key}:${adapter.component_hash}:semantic-v${adapter.semantic_validator_version}`,
      );
    } catch (error) {
      if (error instanceof AutomationWorkflowAdapterError) {
        return blocked(error.code, error.message, error.next_action, evidence.sort());
      }
      throw error;
    }
  }
  if (unsupported.length > 0) {
    return blocked(
      "automation_workflow_component_set_not_enabled",
      `Production execution is not enabled for component(s): ${unsupported.sort().join(", ")}.`,
      "Keep this workflow disabled. The first production slice supports only the exact scheduled funnel review component set; save a supported workflow or wait for reviewed adapters and execution handlers.",
      evidence.sort(),
    );
  }
  return ready(evidence.sort());
}

async function requirementDecision(
  requirement: Requirement,
  context: ReadinessContext,
): Promise<Decision> {
  if (requirement.id === "runner_credential_bound") {
    const mismatch = expectedKind(requirement, "credential");
    if (mismatch) return mismatch;
    const runners = context.activeCredentials.filter((row) =>
      row.kind === "automation_runner" && row.automationId === context.workflow.automation_id
    );
    const evidence = credentialEvidence(runners);
    if (runners.length === 1) return ready(evidence);
    if (runners.length === 0) {
      return blocked(
        "automation_workflow_runner_credential_missing",
        "No active automation-runner credential is bound to this exact workflow.",
        requirement.next_action,
      );
    }
    return blocked(
      "automation_workflow_runner_credential_ambiguous",
      `${runners.length} active automation-runner credentials are bound to this workflow; execution authority must be singular.`,
      "Revoke every unintended runner credential, leave exactly one active credential bound to this automation_id, then read readiness again.",
      evidence,
    );
  }

  if (requirement.id === "workflow_runtime_adapter_available") {
    const mismatch = expectedKind(requirement, "runtime");
    return mismatch ?? runtimeAdapterDecision(context);
  }

  if (KNOWN_CALLER_ASSERTIONS.has(requirement.id)) {
    const mismatch = expectedKind(requirement, "caller_assertion");
    if (mismatch) return mismatch;
    return context.confirmedAssertions.has(requirement.id)
      ? ready([`owner_confirmed_caller_assertion:${requirement.id}`])
      : blocked(
        "automation_workflow_caller_assertion_required",
        `A project owner has not explicitly confirmed caller assertion ${requirement.id} for this exact revision.`,
        requirement.next_action,
      );
  }

  if (requirement.id === "signal_map_saved") {
    const mismatch = expectedKind(requirement, "project_readiness");
    if (mismatch) return mismatch;
    return context.verifiedOnboarding
      ? ready(currentSignalEvidence(context.verifiedOnboarding))
      : blocked(
        "automation_workflow_verified_signal_map_missing",
        "No current verified onboarding plan is available as the project's canonical signal map.",
        requirement.next_action,
      );
  }

  if (requirement.id === "onboarding_verified_for_signal_map") {
    const mismatch = expectedKind(requirement, "project_readiness");
    if (mismatch) return mismatch;
    const proof = evaluateOnboardingReadiness(context.verifiedOnboarding);
    return context.verifiedOnboarding && proof.verified
      ? ready(currentSignalEvidence(context.verifiedOnboarding))
      : blocked(
        "automation_workflow_onboarding_not_verified",
        "The current signal map does not have a complete verified analytics, safe-error, and deploy receipt.",
        requirement.next_action,
        currentSignalEvidence(context.verifiedOnboarding),
      );
  }

  if (requirement.id === "safe_error_proved") {
    const mismatch = expectedKind(requirement, "project_readiness");
    if (mismatch) return mismatch;
    const proof = evaluateOnboardingReadiness(context.verifiedOnboarding);
    return proof.safe_error_proved
      ? ready(currentSignalEvidence(context.verifiedOnboarding))
      : blocked(
        "automation_workflow_safe_error_not_proved",
        "The current onboarding receipt does not prove the approved safe error from shipped code.",
        requirement.next_action,
      );
  }

  if (requirement.id === "posthog_connection_active") {
    const mismatch = expectedKind(requirement, "project_readiness");
    if (mismatch) return mismatch;
    return context.posthogConnectionActive
      ? ready([`posthog_connection:${context.workflow.project_id}:active`])
      : blocked(
        "automation_workflow_posthog_connection_inactive",
        "The project's read-only PostHog Cloud OAuth connection is not active.",
        requirement.next_action,
      );
  }

  if (requirement.id === "ci_credential_active") {
    const mismatch = expectedKind(requirement, "credential");
    if (mismatch) return mismatch;
    const credentialKind = "ci_deploy" as const;
    const credentials = context.activeCredentials.filter((row) => row.kind === credentialKind);
    return credentials.length > 0
      ? ready(credentialEvidence(credentials))
      : blocked(
        "automation_workflow_required_credential_missing",
        `No active ${credentialKind} credential exists for this project.`,
        requirement.next_action,
      );
  }

  if (requirement.id === "ordered_funnel_blueprint_available") {
    return blueprintDecision(
      requirement,
      "ordered_funnel_period_compare",
      orderedFunnelBlueprintCompatible,
    );
  }
  if (requirement.id === "recurrence_blueprint_available") {
    return blueprintDecision(requirement, "automation_case_recurrence_after_deploy");
  }
  if (requirement.id === "traffic_sample_blueprint_available") {
    return blueprintDecision(requirement, "automation_deploy_traffic_sample");
  }

  for (const prefix of ["event_approved:", "event_observed:"] as const) {
    if (!requirement.id.startsWith(prefix)) continue;
    const mismatch = expectedKind(requirement, "project_readiness");
    if (mismatch) return mismatch;
    const event = requirement.id.slice(prefix.length);
    if (!event) break;
    const approved = new Set(
      context.verifiedOnboarding?.plan.milestones.map((milestone) => milestone.event) ?? [],
    );
    const observed = new Set(
      evaluateOnboardingReadiness(context.verifiedOnboarding).observed_events,
    );
    const present = prefix === "event_approved:" ? approved.has(event) : observed.has(event);
    return present
      ? ready([
        ...currentSignalEvidence(context.verifiedOnboarding),
        `${prefix === "event_approved:" ? "approved" : "observed"}_event:${event}`,
      ].sort())
      : blocked(
        prefix === "event_approved:"
          ? "automation_workflow_event_not_approved"
          : "automation_workflow_event_not_observed",
        `${event} is not ${prefix === "event_approved:" ? "approved in the current verified signal map" : "observed in its current onboarding proof"}.`,
        requirement.next_action,
        currentSignalEvidence(context.verifiedOnboarding),
      );
  }

  // These requirements are enforced per run by the frozen graph/runtime. They
  // cannot grant authority at enable time, but the installed runtime can prove
  // the enforcement hook exists for the immutable compilation.
  if (requirement.id === "active_case_claim") {
    const mismatch = expectedKind(requirement, "runtime");
    return mismatch ?? ready(["runtime_invariant:active_case_revision_claim_owned_by_runner"]);
  }
  if (requirement.id === "draft_pr_approval") {
    const mismatch = expectedKind(requirement, "approval");
    return mismatch ?? ready(["compiled_invariant:exact_per_run_approval_binding"]);
  }

  if (requirement.id === "trusted_ci_pr_and_deploy_proof") {
    const mismatch = expectedKind(requirement, "proof");
    if (mismatch) return mismatch;
    return blocked(
      "automation_workflow_proof_gate_not_enableable",
      "This proof requirement has no reviewed pre-enable proof receipt for workflow v3.",
      requirement.next_action,
    );
  }

  return blocked(
    "automation_workflow_requirement_not_supported",
    `The installed readiness evaluator does not recognize requirement ${requirement.id}.`,
    "Keep the workflow disabled. Upgrade the runtime with a reviewed fail-closed evaluator for this exact immutable requirement, then save and review a new workflow revision.",
  );
}

function parseRequirements(workflow: StoredAutomationWorkflow): Array<Requirement | AutomationWorkflowReadinessCheck> {
  const parsed: Array<Requirement | AutomationWorkflowReadinessCheck> = [];
  const seen = new Set<string>();
  for (const [index, raw] of workflow.compiled.requirements.entries()) {
    const value = raw as unknown as Record<string, unknown>;
    const valid = value && typeof value === "object" &&
      typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200 &&
      typeof value.kind === "string" && REQUIREMENT_KINDS.has(value.kind as AutomationWorkflowRequirement["kind"]) &&
      typeof value.requirement === "string" && value.requirement.length > 0 && value.requirement.length <= 4_000 &&
      typeof value.next_action === "string" && value.next_action.length > 0 && value.next_action.length <= 4_000 &&
      Array.isArray(value.required_by_node_ids) && value.required_by_node_ids.every((id) =>
        typeof id === "string" && id.length > 0 && id.length <= 200
      );
    const syntheticId = `invalid_requirement:${index}`;
    if (!valid) {
      parsed.push({
        id: syntheticId,
        kind: "unknown",
        required_by_node_ids: [],
        requirement: "The persisted compilation contains a malformed readiness requirement.",
        status: "blocked",
        evidence_ids: [],
        blocker: {
          code: "automation_workflow_requirement_invalid",
          message: `Requirement at index ${index} does not match the immutable readiness contract.`,
          next_action: "Keep the workflow disabled and save a newly compiled revision after repairing the component/runtime contract.",
        },
      });
      continue;
    }
    const requirement = {
      id: value.id as string,
      kind: value.kind as AutomationWorkflowRequirement["kind"],
      requirement: value.requirement as string,
      next_action: value.next_action as string,
      required_by_node_ids: [...new Set(value.required_by_node_ids as string[])].sort(),
    };
    if (seen.has(requirement.id)) {
      parsed.push({
        id: `duplicate_requirement:${requirement.id}:${index}`,
        kind: "unknown",
        required_by_node_ids: requirement.required_by_node_ids,
        requirement: `Duplicate immutable requirement ${requirement.id}.`,
        status: "blocked",
        evidence_ids: [],
        blocker: {
          code: "automation_workflow_requirement_duplicate",
          message: `Requirement ${requirement.id} appears more than once in the persisted compilation.`,
          next_action: "Keep the workflow disabled and save a newly compiled revision with unique requirement ids.",
        },
      });
      continue;
    }
    seen.add(requirement.id);
    parsed.push(requirement);
  }
  return parsed;
}

function isResolvedCheck(
  value: Requirement | AutomationWorkflowReadinessCheck,
): value is AutomationWorkflowReadinessCheck {
  return "status" in value;
}

export async function readAutomationWorkflowReadiness(
  db: Db,
  input: AutomationWorkflowReadinessInput,
): Promise<AutomationWorkflowReadiness> {
  const parsedInput = ReadinessInputSchema.safeParse(input);
  if (!parsedInput.success) throw errors.invalidPayload({ zod: parsedInput.error.flatten() });
  const inputData = parsedInput.data;
  const workflow = await loadAutomationWorkflow(db, inputData.project_id, inputData.automation_id);
  if (!workflow) throw errors.notFound("automation_workflow");
  if (
    (inputData.expected_revision_id && inputData.expected_revision_id !== workflow.revision_id) ||
    (inputData.expected_etag && inputData.expected_etag !== workflow.etag)
  ) {
    throw errors.preconditionFailed(
      "The workflow revision changed before readiness was evaluated.",
      "Reload the workflow and readiness, review the exact current revision, and retry only with its current ETag and revision_id.",
      {
        current_revision_id: workflow.revision_id,
        current_revision: workflow.revision,
        current_etag: workflow.etag,
      },
    );
  }

  const requirements = parseRequirements(workflow);
  const callerRequirementIds = new Set(
    requirements
      .filter((value): value is Requirement => !isResolvedCheck(value))
      .filter((requirement) =>
        requirement.kind === "caller_assertion" && KNOWN_CALLER_ASSERTIONS.has(requirement.id)
      )
      .map((requirement) => requirement.id),
  );
  const confirmedAssertions = [...new Set(
    inputData.owner_confirmed_caller_assertion_ids ?? [],
  )].sort();
  const unknownAssertions = confirmedAssertions.filter((id) => !callerRequirementIds.has(id));
  if (unknownAssertions.length > 0) {
    throw new AgentryError({
      status: 422,
      code: "automation_workflow_caller_assertion_unknown",
      message: "One or more owner-confirmed caller assertion ids are not required by this exact workflow revision.",
      nextAction: "Read this revision's caller_assertion checks and confirm only their exact ids; never substitute free-form assurances.",
      details: {
        unknown_assertion_ids: unknownAssertions,
        allowed_assertion_ids: [...callerRequirementIds].sort(),
        revision_id: workflow.revision_id,
        etag: workflow.etag,
      },
    });
  }

  const now = await databaseNow(db, inputData.observed_at);
  const [verifiedOnboarding, activeCredentials, activePosthogConnections] = await Promise.all([
    loadVerifiedOnboarding(db, workflow.project_id),
    db.select({
      id: projectCredentials.id,
      kind: projectCredentials.kind,
      automationId: projectCredentials.automationId,
      prefix: projectCredentials.prefix,
      expiresAt: projectCredentials.expiresAt,
    }).from(projectCredentials).where(and(
      eq(projectCredentials.projectId, workflow.project_id),
      isNull(projectCredentials.revokedAt),
      gt(projectCredentials.expiresAt, now),
      notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
    )),
    db.select({ id: posthogConnections.id })
      .from(posthogConnections)
      .where(and(
        eq(posthogConnections.projectId, workflow.project_id),
        eq(posthogConnections.status, "active"),
      ))
      .limit(1),
  ]);
  const context: ReadinessContext = {
    workflow,
    verifiedOnboarding,
    activeCredentials,
    posthogConnectionActive: activePosthogConnections.length === 1,
    confirmedAssertions: new Set(confirmedAssertions),
  };

  const checks = (await Promise.all(requirements.map(async (requirement) => {
    if (isResolvedCheck(requirement)) return requirement;
    const decision = await requirementDecision(requirement, context);
    return {
      id: requirement.id,
      kind: requirement.kind,
      required_by_node_ids: requirement.required_by_node_ids,
      requirement: requirement.requirement,
      status: decision.ready ? "ready" : "blocked",
      evidence_ids: [...new Set(decision.evidence_ids ?? [])].sort(),
      blocker: decision.ready
        ? null
        : {
          code: decision.code ?? "automation_workflow_readiness_blocked",
          message: decision.message ?? requirement.requirement,
          next_action: decision.next_action ?? requirement.next_action,
        },
    } satisfies AutomationWorkflowReadinessCheck;
  }))).sort((left, right) => left.id.localeCompare(right.id));

  const blockers = checks.flatMap((check) => check.blocker
    ? [{ check_id: check.id, ...check.blocker }]
    : []);
  const status = blockers.length === 0 ? "ready" : "blocked";
  const hashMaterial = {
    namespace: "agentry-automation-workflow-readiness-v1",
    project_id: workflow.project_id,
    automation_id: workflow.automation_id,
    revision_id: workflow.revision_id,
    revision: workflow.revision,
    etag: workflow.etag,
    workflow_hash: workflow.workflow_hash,
    compile_hash: workflow.compile_hash,
    owner_confirmed_caller_assertion_ids: confirmedAssertions,
    checks,
  };
  const readinessHash = await sha256Hex(canonicalJsonStringify(hashMaterial));
  return {
    kind: "automation_workflow_readiness",
    schema_version: "3",
    project_id: workflow.project_id,
    automation_id: workflow.automation_id,
    revision_id: workflow.revision_id,
    revision: workflow.revision,
    etag: workflow.etag,
    workflow_hash: workflow.workflow_hash,
    compile_hash: workflow.compile_hash,
    status,
    readiness_hash: readinessHash,
    owner_confirmed_caller_assertion_ids: confirmedAssertions,
    checks,
    blockers,
    next_action: status === "ready"
      ? "An owner may enable only this exact revision with this ETag, readiness_hash, and the same explicit caller assertion ids. Re-read readiness if any credential, onboarding proof, blueprint, adapter, or workflow revision changes."
      : "Keep the workflow disabled. Resolve every blocker exactly as described, then re-read readiness for the same current revision; never reuse an earlier readiness_hash.",
  };
}
