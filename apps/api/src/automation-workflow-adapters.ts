import {
  AutomationWorkflowRepositoryUrlSchema,
  AutomationWorkflowRunnerSchema,
  canonicalJsonStringify,
  sha256Hex,
  type AutomationWorkflowDefinition,
  type AutomationWorkflowJsonValue,
} from "@agentrysh/shared";
import {
  AUTOMATION_WORKFLOW_COMPONENT_VERSION,
  getAutomationWorkflowComponent,
  serializeAutomationWorkflowComponent,
  type AutomationWorkflowPrincipal,
} from "./automation-workflow-components.js";
import { validateAutomationWorkflowPayload } from "./automation-workflow-contracts.js";

export const AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION = "1" as const;

type WorkflowRunner = AutomationWorkflowDefinition["runner"];
type JsonObject = Record<string, AutomationWorkflowJsonValue>;

export type AutomationWorkflowAdapterExecution = Readonly<{
  owner: "agentry_runtime" | "customer_runner";
  principal: AutomationWorkflowPrincipal;
}>;

export type AutomationWorkflowEffectReconciliationPolicy = Readonly<{
  protocol_version: typeof AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION;
  strategy: "provider_lookup_before_retry";
  provider: "github";
  stable_operation_key: "intent_hash";
  native_provider_idempotency: false;
  provider_intent_marker_required: true;
  absence_consistency_window_seconds: number;
  backoff_source: "frozen_workflow_limit";
  max_automatic_reconciliations: number;
  max_provider_call_attempts: number;
  outcomes: readonly ["found", "definitively_absent", "unknown"];
  absence_before_consistency_window: "unknown";
  retry_after_definitive_absence: "manual_follow_up_no_provider_retry";
  ambiguous_outcome: "indeterminate";
  exhausted_outcome: "manual_follow_up";
  absence_evidence_required: true;
}>;

export type AutomationWorkflowComponentAdapter = Readonly<{
  protocol_version: typeof AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION;
  component: Readonly<{ id: string; version: string }>;
  component_hash: string;
  execution: AutomationWorkflowAdapterExecution;
  canonical_target: "repository" | "project";
  semantic_validator_version: number;
  reconciliation_policy: AutomationWorkflowEffectReconciliationPolicy | null;
}>;

export type AutomationWorkflowAdapterInput = Readonly<{
  contract: string;
  payload: AutomationWorkflowJsonValue;
  payload_hash: string;
}>;

export type AutomationWorkflowAdapterContext = Readonly<{
  project_id: string;
  node_id: string;
  component: Readonly<{ id: string; version: string }>;
  component_hash: string;
  runner: WorkflowRunner;
  config: Record<string, AutomationWorkflowJsonValue>;
  inputs: Record<string, AutomationWorkflowAdapterInput>;
  intent: null | Readonly<{
    intent_hash: string;
    provider_target: string;
  }>;
  at: number;
}>;

export type AutomationWorkflowAdapterValidationIssue = Readonly<{
  code:
    | "adapter_context_invalid"
    | "input_contract_mismatch"
    | "input_payload_invalid"
    | "input_payload_hash_mismatch"
    | "output_payload_invalid"
    | "semantic_binding_mismatch"
    | "workspace_policy_violation";
  path: readonly (string | number)[];
  message: string;
}>;

export type AutomationWorkflowAdapterValidationResult =
  | Readonly<{
      success: true;
      adapter: AutomationWorkflowComponentAdapter;
      canonical_target: string;
      output: AutomationWorkflowJsonValue;
      output_hash: string;
    }>
  | Readonly<{
      success: false;
      adapter: AutomationWorkflowComponentAdapter;
      canonical_target: string | null;
      issues: readonly AutomationWorkflowAdapterValidationIssue[];
    }>;

export class AutomationWorkflowAdapterError extends Error {
  constructor(
    readonly code:
      | "component_adapter_not_installed"
      | "component_adapter_manifest_drift"
      | "component_adapter_target_invalid",
    message: string,
    readonly next_action: string,
  ) {
    super(message);
    this.name = "AutomationWorkflowAdapterError";
  }
}

type MutableIssue = {
  code: AutomationWorkflowAdapterValidationIssue["code"];
  path: (string | number)[];
  message: string;
};

type SemanticValidationContext = {
  adapterContext: AutomationWorkflowAdapterContext;
  canonicalTarget: string;
  config: JsonObject;
  inputs: Record<string, JsonObject>;
  output: JsonObject;
  issues: MutableIssue[];
};

type AdapterDefinition = {
  descriptor: AutomationWorkflowComponentAdapter;
  validate: (context: SemanticValidationContext) => Promise<void> | void;
};

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;
const NODE_ID = /^[a-z][a-z0-9_-]{0,99}$/u;

const GITHUB_RECONCILIATION_POLICY = deepFreeze({
  protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
  strategy: "provider_lookup_before_retry",
  provider: "github",
  stable_operation_key: "intent_hash",
  native_provider_idempotency: false,
  provider_intent_marker_required: true,
  absence_consistency_window_seconds: 60,
  backoff_source: "frozen_workflow_limit",
  max_automatic_reconciliations: 3,
  // GitHub has no native create-PR idempotency key. The first production
  // protocol therefore never reauthorizes a provider call after call-start;
  // bounded reconciliation can find the result or require manual follow-up.
  max_provider_call_attempts: 1,
  outcomes: ["found", "definitively_absent", "unknown"],
  absence_before_consistency_window: "unknown",
  retry_after_definitive_absence: "manual_follow_up_no_provider_retry",
  ambiguous_outcome: "indeterminate",
  exhausted_outcome: "manual_follow_up",
  absence_evidence_required: true,
} satisfies AutomationWorkflowEffectReconciliationPolicy);

// These hashes deliberately pin reviewed adapter implementations to the exact
// serialized component and data-contract manifests. A manifest change must
// update the adapter and this pin together; it is never adopted implicitly.
const DEFINITIONS: readonly AdapterDefinition[] = deepFreeze([
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "trigger.cases.unhandled", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "0840d6b718ec8857aa52f6766dd200a87caf4faef44cc07721832187bf116b1a",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateTriggerReceipt,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "trigger.schedule.cron", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "8871bc13fc89eff666fef858516aadb6604d78ab4e74208856e60a1d0bc661c9",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateTriggerReceipt,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "query.cases.claimed-evidence", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "ef5ef63e2f0cd59fa25bee259112078702230ca93248481f208aa9a48f86aea7",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateClaimedCaseEvidence,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "query.analytics.ordered-funnel-period-compare", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "a280799c8268f66143991150def56400a56714da0d18716ff8066e773db1a667",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateOrderedFunnelSource,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "agent.code-fix", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "b9e0585cb5567ff4491ea4072d0e0e9d9deece55e139deb7bdebffec419ee186",
      execution: { owner: "customer_runner", principal: "automation_runner" },
      canonical_target: "repository",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateCodeFix,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "agent.funnel-review", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "cdcc55a7c8956f2e7b779c3d2c9f592cc23846a9f47a8be346a431bcfd24f5d1",
      execution: { owner: "customer_runner", principal: "automation_runner" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateFunnelReview,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "effect.github.draft-pr", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "d1c2e0025a892c6f0428d7469e25c93a88732892b34c5462172801cca5e203fa",
      execution: { owner: "customer_runner", principal: "automation_runner" },
      canonical_target: "repository",
      semantic_validator_version: 1,
      reconciliation_policy: GITHUB_RECONCILIATION_POLICY,
    },
    validate: validateDraftPullRequest,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "effect.report.private", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "470b7f44d2d9ea02d3acd99c0e54afa9184c630a65c034af77d6efe928b07ee6",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validatePrivateReport,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "wait.deploy.observed", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "233f826c03553fca9863794c3cbdefb117c8bd036890925b3485672cba567442",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateObservedDeploy,
  },
  {
    descriptor: {
      protocol_version: AUTOMATION_WORKFLOW_ADAPTER_PROTOCOL_VERSION,
      component: { id: "verify.cases.no-recurrence-after-deploy", version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
      component_hash: "8222663cce994d6cb3427bd45d70be7f75a6a23b12c175d8431c4fa748ba2711",
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      semantic_validator_version: 1,
      reconciliation_policy: null,
    },
    validate: validateCaseRecurrence,
  },
]);

const DEFINITION_BY_COMPONENT = new Map(DEFINITIONS.map((definition) => [
  componentKey(definition.descriptor.component),
  definition,
]));
const manifestVerification = new Map<string, Promise<void>>();

export async function listAutomationWorkflowComponentAdapters(): Promise<readonly AutomationWorkflowComponentAdapter[]> {
  await Promise.all(DEFINITIONS.map(async ({ descriptor }) => {
    await assertPinnedManifest(descriptor);
  }));
  return DEFINITIONS.map(({ descriptor }) => descriptor);
}

export async function requireAutomationWorkflowComponentAdapter(
  ref: Readonly<{ id: string; version: string; component_hash: string }>,
): Promise<AutomationWorkflowComponentAdapter> {
  const definition = DEFINITION_BY_COMPONENT.get(componentKey(ref));
  if (!definition || definition.descriptor.component_hash !== ref.component_hash) {
    throw new AutomationWorkflowAdapterError(
      "component_adapter_not_installed",
      `No reviewed runtime adapter is installed for exact component ${componentKey(ref)} and hash ${ref.component_hash}.`,
      "Keep the workflow disabled and install an adapter reviewed for this exact immutable component hash.",
    );
  }
  await assertPinnedManifest(definition.descriptor);
  return definition.descriptor;
}

export async function resolveAutomationWorkflowAdapterTarget(
  context: AutomationWorkflowAdapterContext,
): Promise<string> {
  const adapter = await requireAutomationWorkflowComponentAdapter({
    ...context.component,
    component_hash: context.component_hash,
  });
  return canonicalTarget(adapter, context);
}

export async function validateAutomationWorkflowAdapterOutput(
  context: AutomationWorkflowAdapterContext,
  rawOutput: unknown,
): Promise<AutomationWorkflowAdapterValidationResult> {
  const adapter = await requireAutomationWorkflowComponentAdapter({
    ...context.component,
    component_hash: context.component_hash,
  });
  const definition = DEFINITION_BY_COMPONENT.get(componentKey(adapter.component));
  if (!definition) throw new Error("resolved workflow adapter definition is missing");
  const manifest = getAutomationWorkflowComponent(adapter.component);
  if (!manifest) throw new Error("resolved workflow adapter manifest is missing");
  const issues: MutableIssue[] = [];

  if (!IDENTIFIER.test(context.project_id)) {
    issue(issues, "adapter_context_invalid", ["project_id"], "project_id must be a bounded stable identifier");
  }
  if (!NODE_ID.test(context.node_id)) {
    issue(issues, "adapter_context_invalid", ["node_id"], "node_id must be a canonical workflow node identifier");
  }
  if (!Number.isSafeInteger(context.at) || context.at < 0) {
    issue(issues, "adapter_context_invalid", ["at"], "at must be a nonnegative server-owned integer timestamp");
  }
  const parsedConfig = manifest.config_schema.safeParse(context.config);
  if (!parsedConfig.success) {
    for (const configIssue of parsedConfig.error.issues) {
      issue(issues, "adapter_context_invalid", ["config", ...configIssue.path], configIssue.message);
    }
  }

  let target: string | null = null;
  try {
    target = canonicalTarget(adapter, context);
  } catch (error) {
    issue(
      issues,
      "adapter_context_invalid",
      ["runner"],
      error instanceof Error ? error.message : "adapter target is invalid",
    );
  }

  const expectedPorts = Object.keys(manifest.serializable.input_ports).sort();
  const actualPorts = Object.keys(context.inputs).sort();
  if (expectedPorts.join("\u0000") !== actualPorts.join("\u0000")) {
    issue(
      issues,
      "input_contract_mismatch",
      ["inputs"],
      `inputs must contain exactly the frozen ports: ${expectedPorts.join(", ")}`,
    );
  }

  const parsedInputs: Record<string, JsonObject> = {};
  for (const port of expectedPorts) {
    const expected = manifest.serializable.input_ports[port];
    const input = context.inputs[port];
    if (!expected || !input) continue;
    if (input.contract !== expected.contract) {
      issue(
        issues,
        "input_contract_mismatch",
        ["inputs", port, "contract"],
        `input ${port} must use ${expected.contract}`,
      );
      continue;
    }
    const validated = await validateAutomationWorkflowPayload(input.contract, input.payload);
    if (!validated.success) {
      for (const inputIssue of validated.issues) {
        issue(
          issues,
          "input_payload_invalid",
          ["inputs", port, "payload", ...inputIssue.path],
          inputIssue.message,
        );
      }
      continue;
    }
    if (validated.payload_hash !== input.payload_hash) {
      issue(
        issues,
        "input_payload_hash_mismatch",
        ["inputs", port, "payload_hash"],
        "input payload_hash does not match its canonical payload",
      );
      continue;
    }
    if (!isJsonObject(validated.payload)) throw new Error("workflow component input contract is not object-shaped");
    parsedInputs[port] = validated.payload;
  }

  const validatedOutput = await validateAutomationWorkflowPayload(
    manifest.serializable.output_contract,
    rawOutput,
  );
  if (!validatedOutput.success) {
    for (const outputIssue of validatedOutput.issues) {
      issue(issues, "output_payload_invalid", ["output", ...outputIssue.path], outputIssue.message);
    }
  }

  if (issues.length > 0 || !target || !parsedConfig.success || !validatedOutput.success) {
    return deepFreeze({ success: false, adapter, canonical_target: target, issues });
  }
  if (!isJsonObject(validatedOutput.payload)) throw new Error("workflow component output contract is not object-shaped");

  await definition.validate({
    adapterContext: context,
    canonicalTarget: target,
    config: parsedConfig.data as JsonObject,
    inputs: parsedInputs,
    output: validatedOutput.payload,
    issues,
  });
  if (issues.length > 0) {
    return deepFreeze({ success: false, adapter, canonical_target: target, issues });
  }
  return deepFreeze({
    success: true,
    adapter,
    canonical_target: target,
    output: validatedOutput.payload,
    output_hash: validatedOutput.payload_hash,
  });
}

export async function automationWorkflowCodeFixProposalHash(proposal: unknown): Promise<string> {
  const value = requireJsonObject(proposal, "code-fix proposal");
  return sha256Hex(canonicalJsonStringify({
    evidence_hash: value.evidence_hash,
    repository: value.repository,
    base_sha: value.base_sha,
    head_sha: value.head_sha,
    branch: value.branch,
    changed_files: value.changed_files,
    tests: value.tests,
    summary: value.summary,
    instruction_authority: value.instruction_authority,
  }));
}

export async function automationWorkflowFunnelReportHash(report: unknown): Promise<string> {
  const value = requireJsonObject(report, "funnel review report");
  return sha256Hex(canonicalJsonStringify({
    source_hash: value.source_hash,
    findings: value.findings,
    limitations: value.limitations,
    instruction_authority: value.instruction_authority,
  }));
}

async function assertPinnedManifest(adapter: AutomationWorkflowComponentAdapter): Promise<void> {
  const key = componentKey(adapter.component);
  let verification = manifestVerification.get(key);
  if (!verification) {
    verification = (async () => {
      const manifest = getAutomationWorkflowComponent(adapter.component);
      if (!manifest) {
        throw new AutomationWorkflowAdapterError(
          "component_adapter_manifest_drift",
          `Installed adapter ${key} has no matching component manifest.`,
          "Restore the reviewed immutable component manifest or install a newly reviewed adapter.",
        );
      }
      const serialized = await serializeAutomationWorkflowComponent(manifest);
      if (serialized.component_hash !== adapter.component_hash) {
        throw new AutomationWorkflowAdapterError(
          "component_adapter_manifest_drift",
          `Installed adapter ${key} is pinned to a different immutable component hash.`,
          "Keep workflow enablement closed until the adapter implementation is reviewed and pinned to the current component hash.",
        );
      }
    })();
    manifestVerification.set(key, verification);
  }
  await verification;
}

function canonicalTarget(
  adapter: AutomationWorkflowComponentAdapter,
  context: AutomationWorkflowAdapterContext,
): string {
  if (adapter.canonical_target === "project") {
    if (!IDENTIFIER.test(context.project_id)) {
      throw new AutomationWorkflowAdapterError(
        "component_adapter_target_invalid",
        "Project adapter target is not a bounded stable identifier.",
        "Load the project id from authenticated runtime state; never accept a caller-selected target.",
      );
    }
    return `agentry:project:${context.project_id}`;
  }
  const parsedRunner = AutomationWorkflowRunnerSchema.safeParse(context.runner);
  if (!parsedRunner.success) {
    throw new AutomationWorkflowAdapterError(
      "component_adapter_target_invalid",
      "Repository adapter runner configuration does not satisfy the immutable workflow runner contract.",
      "Load the runner configuration from the server-validated immutable workflow revision.",
    );
  }
  if (!parsedRunner.data.repository) {
    throw new AutomationWorkflowAdapterError(
      "component_adapter_target_invalid",
      "Repository adapter requires the frozen workflow runner repository.",
      "Use the repository stored in the immutable workflow revision.",
    );
  }
  const githubOnly = adapter.component.id === "effect.github.draft-pr";
  if (githubOnly && parsedRunner.data.repository_provider !== "github") {
    throw new AutomationWorkflowAdapterError(
      "component_adapter_target_invalid",
      "GitHub draft-PR adapter requires repository_provider github.",
      "Use the exact GitHub repository provider declared by the immutable workflow revision.",
    );
  }
  return canonicalRepositoryTarget(
    parsedRunner.data.repository,
    githubOnly ? "github" : parsedRunner.data.repository_provider,
  );
}

function canonicalRepositoryTarget(
  raw: string,
  provider: WorkflowRunner["repository_provider"],
): string {
  const parsed = AutomationWorkflowRepositoryUrlSchema.safeParse(raw);
  if (!parsed.success) throw new Error("repository must be an immutable HTTPS repository URL");
  const url = new URL(parsed.data);
  if (provider === "github" && (url.hostname.toLowerCase() !== "github.com" || url.port !== "")) {
    throw new Error("GitHub adapter target must use https://github.com without a custom port");
  }
  const segments = canonicalUrlPathSegments(url);
  if (segments.length < 2) throw new Error("repository target must contain an owner and repository path");
  if (provider === "github" && segments.length !== 2) {
    throw new Error("GitHub adapter target must contain exactly one owner and repository path");
  }
  const normalized = provider === "github" ? segments.map((segment) => segment.toLowerCase()) : segments;
  return `https://${url.host.toLowerCase()}/${normalized.map(encodeURIComponent).join("/")}`;
}

function canonicalUrlPathSegments(url: URL): string[] {
  const rawSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const decoded = rawSegments.map((segment) => {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw new Error("repository target path has invalid percent encoding");
    }
    if (
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("repository target path contains an unsafe encoded segment");
    }
    return value;
  });
  if (decoded.length > 0) {
    decoded[decoded.length - 1] = decoded[decoded.length - 1]!.replace(/\.git$/iu, "");
    if (!decoded[decoded.length - 1]) throw new Error("repository target path is empty");
  }
  return decoded;
}

function validateTriggerReceipt(context: SemanticValidationContext): void {
  const output = context.output;
  if (context.adapterContext.component.id === "trigger.cases.unhandled") {
    if (
      Number(output.issued_at) > context.adapterContext.at ||
      Number(output.expires_at) <= context.adapterContext.at
    ) {
      bindingIssue(context, ["output"], "case trigger receipt must be issued and unexpired at the server-owned start time");
    }
  } else if (
    Number(output.window_start) > context.adapterContext.at ||
    Number(output.window_end) <= context.adapterContext.at
  ) {
    bindingIssue(context, ["output"], "schedule trigger receipt must contain the server-owned start time in its half-open window");
  }
}

function validateClaimedCaseEvidence(context: SemanticValidationContext): void {
  const receipt = context.inputs.case_receipt!;
  if (context.output.case_id !== receipt.case_id) {
    bindingIssue(context, ["output", "case_id"], "claimed evidence case_id must match the exact trigger receipt");
  }
  if (context.output.case_revision !== receipt.case_revision) {
    bindingIssue(context, ["output", "case_revision"], "claimed evidence case_revision must match the exact trigger receipt");
  }
  const error = requireJsonObject(context.output.error, "claimed case error");
  if (Number(error.first_seen_at) > Number(error.last_seen_at)) {
    bindingIssue(context, ["output", "error"], "claimed evidence first_seen_at must not follow last_seen_at");
  }
}

export async function automationWorkflowFunnelSourceHash(input: {
  schedule: unknown;
  config: unknown;
  source: unknown;
}): Promise<string> {
  const schedule = requireJsonObject(input.schedule, "schedule receipt");
  const config = requireJsonObject(input.config, "ordered funnel config");
  const source = requireJsonObject(input.source, "ordered funnel source");
  return sha256Hex(canonicalJsonStringify({
    schedule_receipt_id: schedule.receipt_id,
    scheduled_for: schedule.scheduled_for,
    events: config.events,
    period_days: config.period_days,
    minimum_sample_size: config.minimum_sample_size,
    current_period: source.current_period,
    previous_period: source.previous_period,
    current: source.current,
    previous: source.previous,
    readiness: source.readiness,
    instruction_authority: source.instruction_authority,
  }));
}

async function validateOrderedFunnelSource(context: SemanticValidationContext): Promise<void> {
  const schedule = context.inputs.schedule!;
  const output = context.output;
  const events = context.config.events as AutomationWorkflowJsonValue[];
  if (canonicalJsonStringify(output.events) !== canonicalJsonStringify(events)) {
    bindingIssue(context, ["output", "events"], "aggregate events must equal the frozen configured order");
  }
  const seconds = Number(context.config.period_days) * 86_400;
  const currentPeriod = requireJsonObject(output.current_period, "current period");
  const previousPeriod = requireJsonObject(output.previous_period, "previous period");
  if (
    currentPeriod.end !== schedule.scheduled_for ||
    Number(currentPeriod.start) !== Number(currentPeriod.end) - seconds ||
    previousPeriod.end !== currentPeriod.start ||
    Number(previousPeriod.start) !== Number(previousPeriod.end) - seconds
  ) {
    bindingIssue(context, ["output", "current_period"], "aggregate periods must be adjacent frozen windows ending at scheduled_for");
  }
  for (const snapshotName of ["current", "previous"] as const) {
    const snapshot = requireJsonObject(output[snapshotName], `${snapshotName} funnel snapshot`);
    const steps = snapshot.steps as AutomationWorkflowJsonValue[];
    let previousUsers = Number(snapshot.observed_users);
    for (const [index, rawStep] of steps.entries()) {
      const step = requireJsonObject(rawStep, "funnel step");
      const users = Number(step.users);
      if (users > previousUsers) {
        bindingIssue(context, ["output", snapshotName, "steps", index, "users"], "ordered funnel users must be nonincreasing and no larger than observed_users");
      }
      previousUsers = users;
    }
  }
  const readiness = requireJsonObject(output.readiness, "funnel readiness");
  const minimum = Number(context.config.minimum_sample_size);
  const current = requireJsonObject(output.current, "current funnel snapshot");
  const previous = requireJsonObject(output.previous, "previous funnel snapshot");
  const sampleReady = Number(current.observed_users) >= minimum && Number(previous.observed_users) >= minimum;
  if ((readiness.status === "ready") !== sampleReady) {
    bindingIssue(context, ["output", "readiness", "status"], "readiness must be derived from both frozen minimum samples");
  }
  const limitations = readiness.limitations as AutomationWorkflowJsonValue[];
  if ((readiness.status === "ready" && limitations.length !== 0) ||
      (readiness.status === "insufficient_sample" && limitations.length === 0)) {
    bindingIssue(context, ["output", "readiness", "limitations"], "readiness limitations must be empty exactly when the aggregate is ready");
  }
  const expectedHash = await automationWorkflowFunnelSourceHash({
    schedule,
    config: context.config,
    source: output,
  });
  if (output.source_hash !== expectedHash) {
    bindingIssue(context, ["output", "source_hash"], "source_hash must bind the exact receipt, plan, periods, rows, and readiness");
  }
}

function validateObservedDeploy(context: SemanticValidationContext): void {
  const pullRequest = context.inputs.draft_pr!;
  const output = context.output;
  if (output.draft_pr_intent_id !== pullRequest.intent_id) {
    bindingIssue(context, ["output", "draft_pr_intent_id"], "deploy receipt must bind the exact draft-PR intent");
  }
  if (
    String(output.source_commit_sha).toLowerCase() !== String(pullRequest.head_sha).toLowerCase() ||
    String(output.deploy_sha).toLowerCase() !== String(pullRequest.head_sha).toLowerCase()
  ) {
    bindingIssue(context, ["output", "deploy_sha"], "deploy receipt must identify the exact approved draft-PR head commit");
  }
  if (output.received_at !== context.adapterContext.at) {
    bindingIssue(context, ["output", "received_at"], "deploy receipt received_at must equal the server-owned resolution time");
  }
}

function validateCaseRecurrence(context: SemanticValidationContext): void {
  const receipt = context.inputs.case_receipt!;
  const deploy = context.inputs.deploy!;
  const output = context.output;
  if (output.case_id !== receipt.case_id || output.case_revision !== receipt.case_revision) {
    bindingIssue(context, ["output", "case_id"], "verification must bind the original case id and revision");
  }
  if (String(output.deploy_sha).toLowerCase() !== String(deploy.deploy_sha).toLowerCase()) {
    bindingIssue(context, ["output", "deploy_sha"], "verification must bind the exact trusted deploy");
  }
  if (output.checked_at !== context.adapterContext.at || Number(output.window_end) > context.adapterContext.at) {
    bindingIssue(context, ["output", "checked_at"], "verification time and observation window must be server-owned and not future-dated");
  }
  if (Number(output.window_start) < Number(deploy.received_at)) {
    bindingIssue(context, ["output", "window_start"], "verification observation must begin no earlier than the exact deploy proof");
  }
  if (Number(output.window_end) - Number(output.window_start) < Number(context.config.observation_window_seconds)) {
    bindingIssue(context, ["output", "window_end"], "verification must cover the frozen minimum observation window");
  }
  if (output.passed === true) {
    if (Number(output.traffic_sample_size) < Number(context.config.min_sample_size) || Number(output.recurrence_count) !== 0) {
      bindingIssue(context, ["output", "passed"], "passed verification requires the minimum traffic sample and zero recurrence");
    }
  } else if (Number(output.recurrence_count) < 1) {
    bindingIssue(context, ["output", "recurrence_count"], "negative verification requires at least one observed recurrence");
  }
}

async function validateCodeFix(context: SemanticValidationContext): Promise<void> {
  const evidence = context.inputs.evidence!;
  const output = context.output;
  if (output.evidence_hash !== evidence.evidence_hash) {
    bindingIssue(context, ["output", "evidence_hash"], "proposal evidence_hash must match the exact input evidence");
  }
  try {
    const outputTarget = canonicalRepositoryTarget(String(output.repository), context.adapterContext.runner.repository_provider);
    if (outputTarget !== context.canonicalTarget) {
      bindingIssue(context, ["output", "repository"], "proposal repository must match the frozen workflow repository");
    }
  } catch (error) {
    bindingIssue(context, ["output", "repository"], error instanceof Error ? error.message : "proposal repository is invalid");
  }

  const changedFiles = output.changed_files as AutomationWorkflowJsonValue[];
  const allowedPaths = context.config.allowed_paths as string[];
  const maximumFiles = context.config.max_files_changed as number;
  const maximumLines = context.config.max_changed_lines as number;
  if (changedFiles.length > maximumFiles) {
    workspaceIssue(context, ["output", "changed_files"], `changed file count exceeds configured maximum ${maximumFiles}`);
  }
  const seenPaths = new Set<string>();
  let changedLines = 0;
  for (const [index, rawFile] of changedFiles.entries()) {
    const file = requireJsonObject(rawFile, "changed file");
    const path = String(file.path);
    if (!isConcreteRepositoryPath(path)) {
      workspaceIssue(context, ["output", "changed_files", index, "path"], "changed file path is not one canonical repository-relative file path");
      continue;
    }
    if (seenPaths.has(path)) {
      workspaceIssue(context, ["output", "changed_files", index, "path"], "changed file paths must be distinct");
    }
    seenPaths.add(path);
    if (!allowedPaths.some((glob) => repositoryGlobMatches(glob, path))) {
      workspaceIssue(context, ["output", "changed_files", index, "path"], "changed file is outside every configured allowed_paths glob");
    }
    if (CODE_FIX_FORBIDDEN_PATHS.some((glob) => repositoryGlobMatches(glob, path))) {
      workspaceIssue(context, ["output", "changed_files", index, "path"], "changed file matches the immutable deny-precedence workspace policy");
    }
    const fileLines = Number(file.added_lines) + Number(file.deleted_lines);
    if (!Number.isSafeInteger(fileLines)) {
      workspaceIssue(context, ["output", "changed_files", index], "changed line count must remain a safe integer");
    } else {
      changedLines += fileLines;
    }
  }
  if (!Number.isSafeInteger(changedLines) || changedLines > maximumLines) {
    workspaceIssue(context, ["output", "changed_files"], `aggregate changed lines exceed configured maximum ${maximumLines}`);
  }

  const requiredTests = context.config.test_commands as string[];
  const tests = output.tests as AutomationWorkflowJsonValue[];
  const seenCommands = new Set<string>();
  for (const [index, rawTest] of tests.entries()) {
    const test = requireJsonObject(rawTest, "test result");
    const command = String(test.command);
    if (seenCommands.has(command)) {
      workspaceIssue(context, ["output", "tests", index, "command"], "test commands must be distinct");
    }
    seenCommands.add(command);
    if (test.status !== "passed" || test.exit_code !== 0) {
      workspaceIssue(context, ["output", "tests", index], "every recorded proposal test must pass with exit_code 0");
    }
  }
  for (const command of requiredTests) {
    if (!seenCommands.has(command)) {
      workspaceIssue(context, ["output", "tests"], `required configured test command was not executed: ${command}`);
    }
  }
  if (output.base_sha === output.head_sha) {
    bindingIssue(context, ["output", "head_sha"], "proposal head_sha must differ from base_sha");
  }
  const expectedHash = await automationWorkflowCodeFixProposalHash(output);
  if (output.proposal_hash !== expectedHash) {
    bindingIssue(context, ["output", "proposal_hash"], "proposal_hash must match the canonical bounded proposal contents");
  }
}

async function validateFunnelReview(context: SemanticValidationContext): Promise<void> {
  const source = context.inputs.source!;
  const output = context.output;
  if (output.source_hash !== source.source_hash) {
    bindingIssue(context, ["output", "source_hash"], "report source_hash must match the exact aggregate source input");
  }
  const readiness = isJsonObject(source.readiness) ? source.readiness.status : null;
  if (readiness !== "ready") {
    bindingIssue(context, ["inputs", "source", "payload", "readiness", "status"], "funnel review requires an exact ready aggregate source");
  }
  const findings = output.findings as AutomationWorkflowJsonValue[];
  for (const [findingIndex, rawFinding] of findings.entries()) {
    const finding = requireJsonObject(rawFinding, "funnel finding");
    const evidencePaths = finding.evidence_paths as AutomationWorkflowJsonValue[];
    for (const [pathIndex, evidencePath] of evidencePaths.entries()) {
      if (typeof evidencePath !== "string" || !jsonPathExists(source, evidencePath)) {
        bindingIssue(
          context,
          ["output", "findings", findingIndex, "evidence_paths", pathIndex],
          "evidence path must resolve inside the exact aggregate source input",
        );
      }
    }
  }
  const expectedHash = await automationWorkflowFunnelReportHash(output);
  if (output.report_hash !== expectedHash) {
    bindingIssue(context, ["output", "report_hash"], "report_hash must match the canonical source-bound report contents");
  }
}

async function validateDraftPullRequest(context: SemanticValidationContext): Promise<void> {
  const proposal = context.inputs.proposal!;
  const output = context.output;
  const intent = context.adapterContext.intent;
  if (!intent || !SHA256_HEX.test(intent.intent_hash)) {
    bindingIssue(context, ["intent", "intent_hash"], "draft PR adapter requires the exact durable effect intent hash");
    return;
  }
  let intentTarget: string | null = null;
  try {
    intentTarget = canonicalRepositoryTarget(intent.provider_target, "github");
  } catch (error) {
    bindingIssue(context, ["intent", "provider_target"], error instanceof Error ? error.message : "intent provider target is invalid");
  }
  if (intentTarget !== context.canonicalTarget) {
    bindingIssue(context, ["intent", "provider_target"], "intent provider_target must match the canonical frozen repository target");
  }
  if (output.intent_id !== intent.intent_hash) {
    bindingIssue(context, ["output", "intent_id"], "receipt intent_id must equal the exact durable intent_hash");
  }
  if (output.proposal_hash !== proposal.proposal_hash) {
    bindingIssue(context, ["output", "proposal_hash"], "receipt proposal_hash must match the exact approved proposal");
  }
  if (String(output.head_sha).toLowerCase() !== String(proposal.head_sha).toLowerCase()) {
    bindingIssue(context, ["output", "head_sha"], "receipt head_sha must match the exact approved proposal head_sha");
  }
  try {
    const proposalTarget = canonicalRepositoryTarget(String(proposal.repository), "github");
    if (proposalTarget !== context.canonicalTarget) {
      bindingIssue(context, ["inputs", "proposal", "payload", "repository"], "approved proposal repository does not match the frozen target");
    }
    const receiptTarget = canonicalRepositoryTarget(String(output.provider_target), "github");
    if (receiptTarget !== context.canonicalTarget) {
      bindingIssue(context, ["output", "provider_target"], "receipt provider_target does not match the frozen target");
    }
  } catch (error) {
    bindingIssue(context, ["output", "provider_target"], error instanceof Error ? error.message : "receipt provider target is invalid");
  }
  const expectedProposalHash = await automationWorkflowCodeFixProposalHash(proposal);
  if (proposal.proposal_hash !== expectedProposalHash) {
    bindingIssue(context, ["inputs", "proposal", "payload", "proposal_hash"], "approved proposal has an invalid canonical proposal_hash");
  }
  try {
    const pullRequestUrl = canonicalGithubPullRequestUrl(String(output.pr_url), Number(output.pr_number));
    const expected = `${context.canonicalTarget}/pull/${output.pr_number}`;
    if (pullRequestUrl !== expected) {
      bindingIssue(context, ["output", "pr_url"], "receipt pr_url and pr_number must identify the exact frozen repository");
    }
  } catch (error) {
    bindingIssue(context, ["output", "pr_url"], error instanceof Error ? error.message : "receipt pull request URL is invalid");
  }
  if (output.recorded_at !== context.adapterContext.at) {
    bindingIssue(context, ["output", "recorded_at"], "receipt recorded_at must be the server-owned command timestamp");
  }
}

async function validatePrivateReport(context: SemanticValidationContext): Promise<void> {
  const source = context.inputs.source!;
  const report = context.inputs.report!;
  const output = context.output;
  if (report.source_hash !== source.source_hash) {
    bindingIssue(context, ["inputs", "report", "payload", "source_hash"], "report input must be bound to the exact aggregate source");
  }
  if (output.source_hash !== source.source_hash) {
    bindingIssue(context, ["output", "source_hash"], "private report receipt source_hash must match the exact aggregate source");
  }
  if (output.report_hash !== report.report_hash) {
    bindingIssue(context, ["output", "report_hash"], "private report receipt report_hash must match the exact report input");
  }
  const expectedReportHash = await automationWorkflowFunnelReportHash(report);
  if (report.report_hash !== expectedReportHash) {
    bindingIssue(context, ["inputs", "report", "payload", "report_hash"], "report input has an invalid canonical report_hash");
  }
  if (output.recorded_at !== context.adapterContext.at) {
    bindingIssue(context, ["output", "recorded_at"], "private report recorded_at must be the server-owned command timestamp");
  }
}

function canonicalGithubPullRequestUrl(raw: string, number: number): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("draft PR URL must be a canonical credential-free github.com HTTPS URL");
  }
  const segments = canonicalUrlPathSegments(url);
  if (
    segments.length !== 4 ||
    segments[2]!.toLowerCase() !== "pull" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    segments[3] !== String(number)
  ) {
    throw new Error("draft PR URL must contain the exact /owner/repository/pull/{pr_number} path");
  }
  return `https://github.com/${segments[0]!.toLowerCase()}/${segments[1]!.toLowerCase()}/pull/${number}`;
}

const CODE_FIX_FORBIDDEN_PATHS = Object.freeze([
  ".env*",
  "**/.env*",
  "secrets/**",
  "**/secrets/**",
  "credentials*",
  "**/credentials*",
  ".github/workflows/**",
]);

function isConcreteRepositoryPath(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f*?[\]{}]/u.test(path)
  ) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function repositoryGlobMatches(glob: string, path: string): boolean {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:[^/]+/)*";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`, "u").test(path);
}

function jsonPathExists(root: JsonObject, path: string): boolean {
  if (path.length < 1 || path.length > 500 || path.startsWith(".") || path.endsWith(".")) return false;
  const segments = path.split(".");
  if (segments.some((segment) => !/^(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*)$/u.test(segment))) {
    return false;
  }
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return false;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return false;
      current = current[index];
    } else if (isJsonObject(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return false;
    }
  }
  return current !== undefined;
}

function bindingIssue(
  context: SemanticValidationContext,
  path: (string | number)[],
  message: string,
): void {
  issue(context.issues, "semantic_binding_mismatch", path, message);
}

function workspaceIssue(
  context: SemanticValidationContext,
  path: (string | number)[],
  message: string,
): void {
  issue(context.issues, "workspace_policy_violation", path, message);
}

function issue(
  issues: MutableIssue[],
  code: MutableIssue["code"],
  path: (string | number)[],
  message: string,
): void {
  issues.push({ code, path, message });
}

function componentKey(ref: { id: string; version: string }): string {
  return `${ref.id}@${ref.version}`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
