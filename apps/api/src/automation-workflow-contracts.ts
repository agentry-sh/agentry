import { z } from "zod";
import {
  canonicalJsonStringify,
  sha256Hex,
  type AutomationWorkflowJsonValue,
} from "@agentrysh/shared";

type JsonSchema = Record<string, AutomationWorkflowJsonValue>;

export type SerializableAutomationWorkflowDataContract = {
  ref: string;
  id: string;
  version: number;
  title: string;
  description: string;
  instruction_authority: "none";
  minimum_assurance: "reported" | "recorded" | "observed" | "verified";
  validator_semantics_version: 1;
  validator_semantics: string[];
  json_schema: JsonSchema;
};

export type AutomationWorkflowDataContract = {
  serializable: SerializableAutomationWorkflowDataContract;
  payload_schema: z.ZodTypeAny;
};

export type SerializedAutomationWorkflowDataContract =
  SerializableAutomationWorkflowDataContract & {
    json_schema_hash: string;
    schema_hash: string;
    contract_hash: string;
  };

export type AutomationWorkflowPayloadValidationResult =
  | {
      success: true;
      contract: string;
      payload: AutomationWorkflowJsonValue;
      payload_hash: string;
    }
  | {
      success: false;
      contract: string;
      issues: Array<{ path: Array<string | number>; message: string }>;
    };

const boundedId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const gitSha = z.string().regex(/^[a-fA-F0-9]{7,64}$/u);
const timestamp = z.number().int().min(0);
const instructionAuthority = z.literal("none");
const eventName = z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const boundedText = (maximum: number) => z.string().min(1).max(maximum);
const nonnegativeInteger = z.number().int().min(0);
const repositoryPath = z.string().min(1).max(500).refine((value) =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.split("/").includes("..") &&
  !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) &&
  !/[\u0000-\u001f\u007f]/u.test(value),
"must be a repository-relative path");
const safeHttpsUrl = z.string().url().max(500).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "must be an HTTPS URL without embedded credentials");

const scalarJsonSchema = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
} as JsonSchema;

function objectSchema(
  properties: Record<string, AutomationWorkflowJsonValue>,
  required: string[],
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function arraySchema(
  items: AutomationWorkflowJsonValue,
  minimum: number,
  maximum: number,
): JsonSchema {
  return { type: "array", items, minItems: minimum, maxItems: maximum };
}

const stringJson = (maximum: number, minimum = 1): JsonSchema => ({
  type: "string",
  minLength: minimum,
  maxLength: maximum,
});
const integerJson = (minimum = 0, maximum?: number): JsonSchema => ({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const literalJson = (value: string | number | boolean): JsonSchema => ({
  type: typeof value,
  const: value,
});
const enumJson = (values: string[]): JsonSchema => ({ type: "string", enum: values });

function contract(
  ref: string,
  title: string,
  description: string,
  payloadSchema: z.ZodTypeAny,
  jsonSchema: JsonSchema,
): AutomationWorkflowDataContract {
  const separator = ref.lastIndexOf("@");
  if (separator < 1) throw new Error(`invalid automation workflow contract ref ${ref}`);
  const id = ref.slice(0, separator);
  const version = Number(ref.slice(separator + 1));
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`invalid automation workflow contract version ${ref}`);
  }
  return Object.freeze({
    serializable: deepFreeze({
      ref,
      id,
      version,
      title,
      description,
      instruction_authority: "none" as const,
      minimum_assurance: assuranceFor(ref),
      validator_semantics_version: 1 as const,
      validator_semantics: validatorSemanticsFor(ref),
      json_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://api.agentry.sh/schemas/automation-workflows/${id}/${version}`,
        title,
        ...jsonSchema,
      },
    }),
    payload_schema: payloadSchema,
  });
}

function validatorSemanticsFor(ref: string): string[] {
  const common = [
    "zod_strict_objects_reject_unknown_fields",
    "zod_numeric_values_must_be_finite",
    "zod_string_and_array_bounds_are_executable",
  ];
  const specific: Record<string, string[]> = {
    "case_trigger_receipt@1": ["expires_at_must_be_after_issued_at"],
    "schedule_trigger_receipt@1": [
      "window_end_must_be_after_window_start",
      "scheduled_for_must_be_inside_half_open_window",
    ],
    "claimed_case_evidence@1": [],
    "ordered_funnel_source@1": [
      "each_period_end_must_be_after_start",
      "current_and_previous_steps_must_exactly_preserve_events_order",
    ],
    "code_fix_proposal@1": [
      "repository_must_be_https_without_embedded_credentials",
      "changed_file_paths_must_be_repository_relative_without_parent_or_scheme_escape",
    ],
    "funnel_review_report@1": [],
    "draft_pr_receipt@1": ["pr_url_must_be_https_without_embedded_credentials"],
    "private_report_receipt@1": [],
    "trusted_deploy_receipt@1": [],
    "case_recurrence_verification@1": [],
  };
  const semantics = specific[ref];
  if (!semantics) throw new Error(`missing immutable validator semantics for ${ref}`);
  return [...common, ...semantics];
}

function assuranceFor(
  ref: string,
): SerializableAutomationWorkflowDataContract["minimum_assurance"] {
  if (ref === "code_fix_proposal@1" || ref === "funnel_review_report@1" || ref === "draft_pr_receipt@1") {
    return "reported";
  }
  if (ref === "trusted_deploy_receipt@1") return "observed";
  if (ref === "case_recurrence_verification@1") return "verified";
  return "recorded";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

const caseTriggerReceipt = z.object({
  receipt_id: boundedId,
  case_id: boundedId,
  case_revision: z.number().int().min(1),
  snapshot_hash: sha256,
  source_trust: z.literal("customer_posthog"),
  issued_at: timestamp,
  expires_at: timestamp,
  instruction_authority: instructionAuthority,
}).strict().superRefine((value, ctx) => {
  if (value.expires_at <= value.issued_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expires_at"], message: "must be after issued_at" });
  }
});

const scheduleTriggerReceipt = z.object({
  receipt_id: boundedId,
  scheduled_for: timestamp,
  window_start: timestamp,
  window_end: timestamp,
  instruction_authority: instructionAuthority,
}).strict().superRefine((value, ctx) => {
  if (value.window_end <= value.window_start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["window_end"], message: "must be after window_start" });
  }
  if (value.scheduled_for < value.window_start || value.scheduled_for >= value.window_end) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scheduled_for"], message: "must fall within the half-open schedule window" });
  }
});

const claimedCaseEvidence = z.object({
  case_id: boundedId,
  case_revision: z.number().int().min(1),
  evidence_hash: sha256,
  error: z.object({
    type: boundedText(500),
    message: boundedText(4_000),
    event_count: z.number().int().min(1),
    first_seen_at: timestamp,
    last_seen_at: timestamp,
  }).strict(),
  last_deploy_sha: gitSha.nullable(),
  instruction_authority: instructionAuthority,
}).strict();

const funnelPeriod = z.object({
  start: timestamp,
  end: timestamp,
}).strict().superRefine((value, ctx) => {
  if (value.end <= value.start) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["end"], message: "must be after start" });
  }
});
const funnelStep = z.object({ event: eventName, users: nonnegativeInteger }).strict();
const funnelSnapshot = z.object({
  observed_users: nonnegativeInteger,
  steps: z.array(funnelStep).min(2).max(20),
}).strict();
const orderedFunnelSource = z.object({
  source_hash: sha256,
  current_period: funnelPeriod,
  previous_period: funnelPeriod,
  events: z.array(eventName).min(2).max(20),
  current: funnelSnapshot,
  previous: funnelSnapshot,
  readiness: z.object({
    status: z.enum(["ready", "insufficient_sample"]),
    limitations: z.array(boundedText(1_000)).max(50),
  }).strict(),
  instruction_authority: instructionAuthority,
}).strict().superRefine((value, ctx) => {
  const expected = value.events.join("\u0000");
  if (value.current.steps.map((step) => step.event).join("\u0000") !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["current", "steps"], message: "must preserve configured funnel event order" });
  }
  if (value.previous.steps.map((step) => step.event).join("\u0000") !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["previous", "steps"], message: "must preserve configured funnel event order" });
  }
});

const changedFile = z.object({
  path: repositoryPath,
  added_lines: nonnegativeInteger,
  deleted_lines: nonnegativeInteger,
}).strict();
const testResult = z.object({
  command: boundedText(500),
  status: z.enum(["passed", "failed"]),
  exit_code: z.number().int().min(0).max(255),
}).strict();
const codeFixProposal = z.object({
  proposal_hash: sha256,
  evidence_hash: sha256,
  repository: safeHttpsUrl,
  base_sha: gitSha,
  head_sha: gitSha,
  branch: boundedText(200),
  changed_files: z.array(changedFile).min(1).max(100),
  tests: z.array(testResult).min(1).max(30),
  summary: boundedText(4_000),
  instruction_authority: instructionAuthority,
}).strict();

const reportFinding = z.object({
  kind: z.enum(["metric", "hypothesis", "readiness_gap"]),
  statement: boundedText(2_000),
  evidence_paths: z.array(boundedText(500)).max(20),
}).strict();
const funnelReviewReport = z.object({
  report_hash: sha256,
  source_hash: sha256,
  findings: z.array(reportFinding).min(1).max(100),
  limitations: z.array(boundedText(1_000)).max(50),
  instruction_authority: instructionAuthority,
}).strict();

const draftPrReceipt = z.object({
  intent_id: boundedId,
  proposal_hash: sha256,
  provider: z.literal("github"),
  provider_target: boundedText(500),
  pr_number: z.number().int().min(1),
  pr_url: safeHttpsUrl,
  head_sha: gitSha,
  recorded_at: timestamp,
  instruction_authority: instructionAuthority,
}).strict();

const privateReportReceipt = z.object({
  report_id: boundedId,
  source_hash: sha256,
  report_hash: sha256,
  visibility: z.literal("private"),
  recorded_at: timestamp,
  instruction_authority: instructionAuthority,
}).strict();

const trustedDeployReceipt = z.object({
  draft_pr_intent_id: boundedId,
  source_commit_sha: gitSha,
  deploy_sha: gitSha,
  provider_proof_hash: sha256,
  received_at: timestamp,
  source_trust: z.literal("trusted_ci"),
  instruction_authority: instructionAuthority,
}).strict();

const caseRecurrenceVerification = z.object({
  passed: z.boolean(),
  case_id: boundedId,
  case_revision: z.number().int().min(1),
  deploy_sha: gitSha,
  window_start: timestamp,
  window_end: timestamp,
  traffic_sample_size: nonnegativeInteger,
  recurrence_count: nonnegativeInteger,
  checked_at: timestamp,
  reason: boundedText(2_000),
  instruction_authority: instructionAuthority,
}).strict();

const authorityJson = literalJson("none");
const shaJson = { type: "string", pattern: "^[a-f0-9]{64}$" } as JsonSchema;
const gitShaJson = { type: "string", pattern: "^[a-fA-F0-9]{7,64}$" } as JsonSchema;
const idJson = { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" } as JsonSchema;
const timestampJson = integerJson(0);
const httpsJson = { type: "string", format: "uri", pattern: "^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)", maxLength: 500 } as JsonSchema;

const CONTRACTS: readonly AutomationWorkflowDataContract[] = Object.freeze([
  contract("case_trigger_receipt@1", "Case trigger receipt", "One trusted server-issued case revision trigger.", caseTriggerReceipt,
    objectSchema({ receipt_id: idJson, case_id: idJson, case_revision: integerJson(1), snapshot_hash: shaJson, source_trust: literalJson("customer_posthog"), issued_at: timestampJson, expires_at: timestampJson, instruction_authority: authorityJson }, ["receipt_id", "case_id", "case_revision", "snapshot_hash", "source_trust", "issued_at", "expires_at", "instruction_authority"])),
  contract("schedule_trigger_receipt@1", "Schedule trigger receipt", "One server-issued cron occurrence and half-open start window.", scheduleTriggerReceipt,
    objectSchema({ receipt_id: idJson, scheduled_for: timestampJson, window_start: timestampJson, window_end: timestampJson, instruction_authority: authorityJson }, ["receipt_id", "scheduled_for", "window_start", "window_end", "instruction_authority"])),
  contract("claimed_case_evidence@1", "Claimed case evidence", "Bounded evidence for one actively claimed trusted case revision.", claimedCaseEvidence,
    objectSchema({ case_id: idJson, case_revision: integerJson(1), evidence_hash: shaJson, error: objectSchema({ type: stringJson(500), message: stringJson(4_000), event_count: integerJson(1), first_seen_at: timestampJson, last_seen_at: timestampJson }, ["type", "message", "event_count", "first_seen_at", "last_seen_at"]), last_deploy_sha: { oneOf: [gitShaJson, { type: "null" }] }, instruction_authority: authorityJson }, ["case_id", "case_revision", "evidence_hash", "error", "last_deploy_sha", "instruction_authority"])),
  contract("ordered_funnel_source@1", "Ordered funnel source", "One immutable current/prior ordered-funnel aggregate source.", orderedFunnelSource,
    objectSchema({ source_hash: shaJson, current_period: objectSchema({ start: timestampJson, end: timestampJson }, ["start", "end"]), previous_period: objectSchema({ start: timestampJson, end: timestampJson }, ["start", "end"]), events: arraySchema(stringJson(200), 2, 20), current: objectSchema({ observed_users: integerJson(), steps: arraySchema(objectSchema({ event: stringJson(200), users: integerJson() }, ["event", "users"]), 2, 20) }, ["observed_users", "steps"]), previous: objectSchema({ observed_users: integerJson(), steps: arraySchema(objectSchema({ event: stringJson(200), users: integerJson() }, ["event", "users"]), 2, 20) }, ["observed_users", "steps"]), readiness: objectSchema({ status: enumJson(["ready", "insufficient_sample"]), limitations: arraySchema(stringJson(1_000), 0, 50) }, ["status", "limitations"]), instruction_authority: authorityJson }, ["source_hash", "current_period", "previous_period", "events", "current", "previous", "readiness", "instruction_authority"])),
  contract("code_fix_proposal@1", "Code-fix proposal", "A bounded tested workspace proposal with no provider authority.", codeFixProposal,
    objectSchema({ proposal_hash: shaJson, evidence_hash: shaJson, repository: httpsJson, base_sha: gitShaJson, head_sha: gitShaJson, branch: stringJson(200), changed_files: arraySchema(objectSchema({ path: stringJson(500), added_lines: integerJson(), deleted_lines: integerJson() }, ["path", "added_lines", "deleted_lines"]), 1, 100), tests: arraySchema(objectSchema({ command: stringJson(500), status: enumJson(["passed", "failed"]), exit_code: integerJson(0, 255) }, ["command", "status", "exit_code"]), 1, 30), summary: stringJson(4_000), instruction_authority: authorityJson }, ["proposal_hash", "evidence_hash", "repository", "base_sha", "head_sha", "branch", "changed_files", "tests", "summary", "instruction_authority"])),
  contract("funnel_review_report@1", "Funnel review report", "Typed metrics, hypotheses, and readiness gaps bound to one source hash.", funnelReviewReport,
    objectSchema({ report_hash: shaJson, source_hash: shaJson, findings: arraySchema(objectSchema({ kind: enumJson(["metric", "hypothesis", "readiness_gap"]), statement: stringJson(2_000), evidence_paths: arraySchema(stringJson(500), 0, 20) }, ["kind", "statement", "evidence_paths"]), 1, 100), limitations: arraySchema(stringJson(1_000), 0, 50), instruction_authority: authorityJson }, ["report_hash", "source_hash", "findings", "limitations", "instruction_authority"])),
  contract("draft_pr_receipt@1", "Draft PR receipt", "Provider receipt for one intent-bound draft pull request.", draftPrReceipt,
    objectSchema({ intent_id: idJson, proposal_hash: shaJson, provider: literalJson("github"), provider_target: stringJson(500), pr_number: integerJson(1), pr_url: httpsJson, head_sha: gitShaJson, recorded_at: timestampJson, instruction_authority: authorityJson }, ["intent_id", "proposal_hash", "provider", "provider_target", "pr_number", "pr_url", "head_sha", "recorded_at", "instruction_authority"])),
  contract("private_report_receipt@1", "Private report receipt", "Receipt for one private source-bound report record.", privateReportReceipt,
    objectSchema({ report_id: idJson, source_hash: shaJson, report_hash: shaJson, visibility: literalJson("private"), recorded_at: timestampJson, instruction_authority: authorityJson }, ["report_id", "source_hash", "report_hash", "visibility", "recorded_at", "instruction_authority"])),
  contract("trusted_deploy_receipt@1", "Trusted deploy receipt", "Trusted-CI deploy proof for the exact draft-PR commit.", trustedDeployReceipt,
    objectSchema({ draft_pr_intent_id: idJson, source_commit_sha: gitShaJson, deploy_sha: gitShaJson, provider_proof_hash: shaJson, received_at: timestampJson, source_trust: literalJson("trusted_ci"), instruction_authority: authorityJson }, ["draft_pr_intent_id", "source_commit_sha", "deploy_sha", "provider_proof_hash", "received_at", "source_trust", "instruction_authority"])),
  contract("case_recurrence_verification@1", "Case recurrence verification", "Traffic-backed recurrence result for one case revision and exact deploy.", caseRecurrenceVerification,
    objectSchema({ passed: { type: "boolean" }, case_id: idJson, case_revision: integerJson(1), deploy_sha: gitShaJson, window_start: timestampJson, window_end: timestampJson, traffic_sample_size: integerJson(), recurrence_count: integerJson(), checked_at: timestampJson, reason: stringJson(2_000), instruction_authority: authorityJson }, ["passed", "case_id", "case_revision", "deploy_sha", "window_start", "window_end", "traffic_sample_size", "recurrence_count", "checked_at", "reason", "instruction_authority"])),
]);

const CONTRACT_BY_REF = new Map(CONTRACTS.map((entry) => [entry.serializable.ref, entry]));

export function listAutomationWorkflowDataContracts(): readonly AutomationWorkflowDataContract[] {
  return CONTRACTS;
}

export function getAutomationWorkflowDataContract(
  ref: string,
): AutomationWorkflowDataContract | null {
  return CONTRACT_BY_REF.get(ref) ?? null;
}

export async function serializeAutomationWorkflowDataContract(
  entry: AutomationWorkflowDataContract,
): Promise<SerializedAutomationWorkflowDataContract> {
  const jsonSchemaHash = await sha256Hex(canonicalJsonStringify(entry.serializable.json_schema));
  const schemaHash = await sha256Hex(canonicalJsonStringify({
    json_schema_hash: jsonSchemaHash,
    validator_semantics_version: entry.serializable.validator_semantics_version,
    validator_semantics: entry.serializable.validator_semantics,
  }));
  return {
    ...entry.serializable,
    json_schema_hash: jsonSchemaHash,
    schema_hash: schemaHash,
    contract_hash: await sha256Hex(canonicalJsonStringify({
      ...entry.serializable,
      schema_hash: schemaHash,
    })),
  };
}

export async function serializeAutomationWorkflowDataContractCatalog() {
  const contracts = await Promise.all(CONTRACTS.map(serializeAutomationWorkflowDataContract));
  return {
    kind: "automation_workflow_data_contract_catalog" as const,
    version_policy: "immutable_integer" as const,
    count: contracts.length,
    contracts,
  };
}

export async function validateAutomationWorkflowPayload(
  contractRef: string,
  input: unknown,
): Promise<AutomationWorkflowPayloadValidationResult> {
  const entry = getAutomationWorkflowDataContract(contractRef);
  if (!entry) {
    return {
      success: false,
      contract: contractRef,
      issues: [{ path: [], message: `unknown immutable payload contract ${contractRef}` }],
    };
  }
  const parsed = entry.payload_schema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      contract: contractRef,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    };
  }
  const payload = parsed.data as AutomationWorkflowJsonValue;
  return {
    success: true,
    contract: contractRef,
    payload,
    payload_hash: await sha256Hex(canonicalJsonStringify(payload)),
  };
}

export { scalarJsonSchema };
