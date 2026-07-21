import { Hono, type Context, type MiddlewareHandler } from "hono";
import { and, desc, eq, lt, or } from "drizzle-orm";
import {
  automationWorkflowRuns,
  automationWorkflowRunStates,
} from "@agentry/db/schema";
import {
  errors,
  sha256Hex,
  type ProjectCredentialScope,
} from "@agentrysh/shared";
import { z } from "zod";
import {
  automationListPagination,
  decodeAutomationListCursor,
} from "../automation-pagination.js";
import {
  acquireAutomationWorkflowRunLease,
  releaseAutomationWorkflowRunLease,
  renewAutomationWorkflowRunLease,
} from "../automation-workflow-leases.js";
import {
  reconcileAutomationWorkflowEffect,
} from "../automation-workflow-reconciliation.js";
import {
  applyAutomationWorkflowCommand,
  automationWorkflowRunRoutes,
  readAutomationWorkflowEffect,
  readAutomationWorkflowRun,
  startAutomationWorkflowRun,
  type ApplyAutomationWorkflowCommandInput,
} from "../automation-workflow-service.js";
import { advanceAutomationWorkflowSystemNodes } from "../automation-workflow-system-executor.js";
import {
  issueAutomationWorkflowTriggerReceipts,
  listAutomationWorkflowTriggerReceipts,
  readAutomationWorkflowTriggerReceipt,
  type AutomationWorkflowTriggerReceiptStatus,
} from "../automation-workflow-triggers.js";
import { readBoundedJson } from "../bounded-json.js";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";
import {
  requireApiKeyOrAutomationRunner,
  requireApiKeyOrProjectCredential,
  requireProjectAccess,
  requireProjectOwner,
} from "../middleware.js";
import {
  authenticateProjectCredential,
  requireCredentialScope,
  type ProjectCredentialPrincipal,
} from "../project-credential-auth.js";

const router = new Hono<AppBindings>();
const runnerOrOwner = requireApiKeyOrAutomationRunner();
const effectReader = requireApiKeyOrProjectCredential(["automation_runner", "ci_deploy"]);
const BODY_LIMIT = 262_144;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const WORKFLOW_ID = /^[a-z][a-z0-9_-]{0,99}$/u;
const IDEMPOTENCY_KEY = /^[\u0021-\u007E]{8,500}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{32,500}$/u;
const COMMAND_KINDS = new Set([
  "component_succeeded",
  "component_domain_failed",
  "approval_decided",
  "effect_call_started",
  "effect_receipt_recorded",
]);
const RUN_STATUSES = new Set([
  "running",
  "awaiting_component",
  "awaiting_approval",
  "effect_reserved",
  "effect_indeterminate",
  "waiting",
  "verifying",
  "completed",
  "escalated",
  "cancelled",
  "quarantined",
]);
const RECEIPT_STATUSES = new Set<AutomationWorkflowTriggerReceiptStatus>([
  "ready",
  "consumed",
  "expired",
  "cancelled",
]);

const IdSchema = z.string().regex(ID);
const WorkflowIdSchema = z.string().regex(WORKFLOW_ID);
const RevisionSchema = z.number().int().min(0).safe();
const LeaseFenceSchema = z.object({
  lease_epoch: z.number().int().positive().safe(),
  lease_token: z.string().regex(TOKEN),
}).strict();
const UsageSchema = z.object({
  sequence: z.number().int().positive().safe(),
  turns_used: z.number().int().min(0).safe(),
  cost_micros: z.number().int().min(0).safe(),
  touched_files: z.array(z.string().min(1).max(1_000)).max(1_000),
  changed_line_churn: z.number().int().min(0).safe(),
}).strict();
const ComponentSucceededSchema = z.object({
  kind: z.literal("component_succeeded"),
  command_id: IdSchema,
  expected_revision: RevisionSchema,
  node_id: IdSchema,
  output: z.unknown(),
  usage: UsageSchema.optional(),
  lease: LeaseFenceSchema,
}).strict();
const ComponentDomainFailedSchema = z.object({
  kind: z.literal("component_domain_failed"),
  command_id: IdSchema,
  expected_revision: RevisionSchema,
  node_id: IdSchema,
  error: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_.:-]{0,199}$/u),
    message: z.string().trim().min(1).max(4_000),
  }).strict(),
  usage: UsageSchema.optional(),
  lease: LeaseFenceSchema,
}).strict();
const ApprovalDecidedSchema = z.object({
  kind: z.literal("approval_decided"),
  command_id: IdSchema,
  expected_revision: RevisionSchema,
  node_id: IdSchema,
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const EffectCallStartedSchema = z.object({
  kind: z.literal("effect_call_started"),
  command_id: IdSchema,
  expected_revision: RevisionSchema,
  node_id: IdSchema,
  intent_hash: z.string().regex(HASH),
  lease: LeaseFenceSchema,
}).strict();
const EffectReceiptRecordedSchema = z.object({
  kind: z.literal("effect_receipt_recorded"),
  command_id: IdSchema,
  expected_revision: RevisionSchema,
  node_id: IdSchema,
  intent_hash: z.string().regex(HASH),
  output: z.unknown(),
}).strict();
const PublicCommandSchema = z.discriminatedUnion("kind", [
  ComponentSucceededSchema,
  ComponentDomainFailedSchema,
  ApprovalDecidedSchema,
  EffectCallStartedSchema,
  EffectReceiptRecordedSchema,
]);
const StartSchema = z.object({ trigger_receipt_id: IdSchema }).strict();
const EmptySchema = z.object({}).strict();
const AdvanceSchema = z.object({ max_steps: z.number().int().min(1).max(32).optional() }).strict();
const AcquireLeaseSchema = z.object({
  lease_token: z.string().regex(TOKEN),
  lease_seconds: z.number().int().min(30).max(3_600),
}).strict();
const RenewLeaseSchema = AcquireLeaseSchema.extend({
  lease_epoch: z.number().int().positive().safe(),
}).strict();
const ReleaseLeaseSchema = z.object({
  lease_epoch: z.number().int().positive().safe(),
  lease_token: z.string().regex(TOKEN),
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const CancelSchema = z.object({
  expected_revision: RevisionSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const GithubEvidenceSchema = z.object({
  provider: z.literal("github"),
  provider_operation_key: z.string().min(1).max(200),
  provider_target: z.string().min(1).max(2_000),
  intent_marker: z.string().regex(HASH),
  expected_head_sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/u),
  lookup_started_at: z.number().int().min(0).safe(),
  lookup_completed_at: z.number().int().min(0).safe(),
  lookup_result: z.enum(["found", "not_found", "unknown"]),
  matched_provider_ref: z.string().min(1).max(2_000).nullable(),
}).strict();
const ReconcileSchema = z.object({
  outcome: z.enum(["found", "definitively_absent", "unknown"]),
  evidence: GithubEvidenceSchema,
  output: z.unknown().optional(),
}).strict();

type Db = ReturnType<typeof getDb>;
type WorkflowRunStatus = typeof automationWorkflowRunStates.$inferSelect["status"];

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw errors.invalidPayload({ zod: parsed.error.flatten() });
  return parsed.data;
}

function pathIdentity(c: Context<AppBindings>) {
  const projectId = c.req.param("project_id") ?? "";
  const automationId = c.req.param("automation_id") ?? "";
  if (!ID.test(projectId) || !WORKFLOW_ID.test(automationId)) {
    throw errors.invalidPayload({ reason: "project_id or automation_id is invalid" });
  }
  return { projectId, automationId };
}

function runId(c: Context<AppBindings>): string {
  const value = c.req.param("run_id") ?? "";
  if (!ID.test(value)) throw errors.invalidPayload({ reason: "run_id is invalid" });
  return value;
}

function requiredIdempotencyKey(c: Context<AppBindings>): string {
  const value = c.req.header("idempotency-key")?.trim();
  if (!value) {
    throw errors.preconditionRequired(
      "This mutation requires Idempotency-Key.",
      "Choose one stable 8-500 character key for this logical operation and reuse it unchanged after response loss.",
      { header: "Idempotency-Key" },
    );
  }
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw errors.invalidPayload({ reason: "Idempotency-Key must contain 8-500 visible ASCII characters" });
  }
  return value;
}

function parseLimit(value: string | undefined, defaultValue: number, maximum: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw errors.invalidPayload({ reason: `limit must be an integer between 1 and ${maximum}` });
  }
  return parsed;
}

function exactRunner(
  c: Context<AppBindings>,
  projectId: string,
  automationId: string,
  scope: ProjectCredentialScope,
): ProjectCredentialPrincipal {
  const principal = c.get("projectCredential");
  if (!principal || principal.kind !== "automation_runner") {
    throw errors.credentialScopeDenied(scope, principal?.kind ?? "private_api_key", {
      required_env_var: "AGENTRY_RUNNER_API_KEY",
      automation_id: automationId,
    });
  }
  requireCredentialScope(c, scope, projectId, automationId);
  return principal;
}

async function ownerOrExactRunner(
  c: Context<AppBindings>,
  projectId: string,
  automationId: string,
  scope: ProjectCredentialScope,
): Promise<ProjectCredentialPrincipal | null> {
  const principal = c.get("projectCredential");
  if (principal) return exactRunner(c, projectId, automationId, scope);
  await requireProjectOwner(c, projectId);
  return null;
}

const runnerOnly: MiddlewareHandler<AppBindings> = async (c, next) => {
  const principal = await authenticateProjectCredential(c);
  if (principal.kind !== "automation_runner") {
    throw errors.credentialScopeDenied("automation_runner", principal.kind, {
      credential_id: principal.credentialId,
      required_env_var: "AGENTRY_RUNNER_API_KEY",
    });
  }
  c.set("projectCredential", principal);
  await next();
};

async function assertRunScope(
  db: Db,
  projectId: string,
  automationId: string,
  selectedRunId: string,
): Promise<void> {
  const row = (
    await db.select({ id: automationWorkflowRuns.id }).from(automationWorkflowRuns).where(and(
      eq(automationWorkflowRuns.id, selectedRunId),
      eq(automationWorkflowRuns.projectId, projectId),
      eq(automationWorkflowRuns.automationId, automationId),
    )).limit(1)
  )[0] ?? null;
  if (!row) throw errors.notFound("automation_workflow_run");
}

function commandRecovery(projectId: string, automationId: string, selectedRunId: string) {
  return {
    method: "GET" as const,
    path: automationWorkflowRunRoutes(projectId, automationId, selectedRunId).run,
    instruction: "Read the strict replay-verified run projection and execute only its next_action with the required principal, revision, lease, and timing.",
  };
}

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/trigger-receipts/issue",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await ownerOrExactRunner(c, projectId, automationId, "triggers:issue");
    parseBody(EmptySchema, await readBoundedJson(c, 16_384));
    return c.json(await issueAutomationWorkflowTriggerReceipts(getDb(c.env), {
      project_id: projectId,
      automation_id: automationId,
    }));
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id/trigger-receipts",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await requireProjectAccess(c, projectId);
    requireCredentialScope(c, "triggers:read", projectId, automationId);
    const rawStatus = c.req.query("status") ?? "ready";
    const status = rawStatus === "all"
      ? undefined
      : RECEIPT_STATUSES.has(rawStatus as AutomationWorkflowTriggerReceiptStatus)
        ? rawStatus as AutomationWorkflowTriggerReceiptStatus
        : null;
    if (status === null) {
      throw errors.invalidPayload({ reason: "status must be all, ready, consumed, expired, or cancelled" });
    }
    const limit = parseLimit(c.req.query("limit"), 20, 100);
    const cursorValue = c.req.query("cursor");
    const cursor = cursorValue ? decodeAutomationListCursor(cursorValue) : null;
    if (cursorValue && !cursor) throw errors.invalidPayload({ reason: "cursor is invalid" });
    const receipts = await listAutomationWorkflowTriggerReceipts(getDb(c.env), {
      project_id: projectId,
      automation_id: automationId,
      status,
      limit,
      cursor: cursor ? { issued_at: cursor.at, receipt_id: cursor.id } : undefined,
    });
    const last = receipts.at(-1) ?? null;
    const following = receipts.length === limit && last
      ? await listAutomationWorkflowTriggerReceipts(getDb(c.env), {
          project_id: projectId,
          automation_id: automationId,
          status,
          limit: 1,
          cursor: { issued_at: last.issued_at, receipt_id: last.receipt_id },
        })
      : [];
    const pagination = automationListPagination({
      operationId: "list_automation_workflow_trigger_receipts",
      requiredPrincipal: "human_or_exact_bound_runner",
      basePath: `/v1/projects/${encodeURIComponent(projectId)}/automation-workflows/${encodeURIComponent(automationId)}/trigger-receipts`,
      filters: { status: rawStatus },
      limit,
      hasMore: following.length > 0,
      lastRow: last ? { at: last.issued_at, id: last.receipt_id } : null,
    });
    return c.json({
      kind: "automation_workflow_trigger_receipt_list",
      schema_version: "1",
      project_id: projectId,
      automation_id: automationId,
      status: rawStatus,
      receipts,
      pagination,
      next_action: receipts.some((receipt) => receipt.status === "ready")
        ? "Start each selected ready receipt exactly once using only trigger_receipt_id and one stable Idempotency-Key. Never copy trigger_output into the start request."
        : pagination.follow_up
          ? "Call pagination.follow_up exactly before declaring the filtered receipt history complete."
          : "No matching receipt is available. Request a server eligibility sweep only after resolving any structured issuance blocker.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id/trigger-receipts/:receipt_id",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await requireProjectAccess(c, projectId);
    requireCredentialScope(c, "triggers:read", projectId, automationId);
    const receipt = await readAutomationWorkflowTriggerReceipt(getDb(c.env), {
      project_id: projectId,
      automation_id: automationId,
      receipt_id: c.req.param("receipt_id") ?? "",
    });
    if (!receipt) throw errors.notFound("automation_workflow_trigger_receipt");
    return c.json(receipt);
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs",
  runnerOnly,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const principal = exactRunner(c, projectId, automationId, "runs:write");
    const idempotencyKey = requiredIdempotencyKey(c);
    const body = parseBody(StartSchema, await readBoundedJson(c, 16_384));
    const receipt = await startAutomationWorkflowRun(getDb(c.env), {
      project_id: projectId,
      automation_id: automationId,
      idempotency_key: idempotencyKey,
      trigger_receipt_id: body.trigger_receipt_id,
      runner_credential_id: principal.credentialId,
    });
    return c.json({
      ...receipt,
      recovery: commandRecovery(projectId, automationId, receipt.run_id),
    }, receipt.idempotent_replay ? 200 : 201);
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await requireProjectAccess(c, projectId);
    requireCredentialScope(c, "runs:read", projectId, automationId);
    const limit = parseLimit(c.req.query("limit"), 20, 100);
    const statusValue = c.req.query("status");
    if (statusValue && !RUN_STATUSES.has(statusValue)) {
      throw errors.invalidPayload({ reason: "status is not a workflow run status" });
    }
    const cursorValue = c.req.query("cursor");
    const cursor = cursorValue ? decodeAutomationListCursor(cursorValue) : null;
    if (cursorValue && !cursor) throw errors.invalidPayload({ reason: "cursor is invalid" });
    const rows = await getDb(c.env).select({
      runId: automationWorkflowRuns.id,
      workflowRevisionId: automationWorkflowRuns.workflowRevisionId,
      triggerReceiptId: automationWorkflowRuns.triggerReceiptId,
      triggerKind: automationWorkflowRuns.triggerKind,
      attempt: automationWorkflowRuns.attempt,
      createdAt: automationWorkflowRuns.createdAt,
      status: automationWorkflowRunStates.status,
      stateRevision: automationWorkflowRunStates.stateVersion,
      updatedAt: automationWorkflowRunStates.updatedAt,
    }).from(automationWorkflowRuns).innerJoin(
      automationWorkflowRunStates,
      eq(automationWorkflowRunStates.runId, automationWorkflowRuns.id),
    ).where(and(
      eq(automationWorkflowRuns.projectId, projectId),
      eq(automationWorkflowRuns.automationId, automationId),
      statusValue ? eq(automationWorkflowRunStates.status, statusValue as WorkflowRunStatus) : undefined,
      cursor ? or(
        lt(automationWorkflowRuns.createdAt, cursor.at),
        and(
          eq(automationWorkflowRuns.createdAt, cursor.at),
          lt(automationWorkflowRuns.id, cursor.id),
        ),
      ) : undefined,
    )).orderBy(desc(automationWorkflowRuns.createdAt), desc(automationWorkflowRuns.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1) ?? null;
    const pagination = automationListPagination({
      operationId: "list_automation_workflow_runs",
      requiredPrincipal: "human_or_exact_bound_runner",
      basePath: `/v1/projects/${encodeURIComponent(projectId)}/automation-workflows/${encodeURIComponent(automationId)}/runs`,
      filters: { status: statusValue },
      limit,
      hasMore: rows.length > limit,
      lastRow: last ? { at: last.createdAt, id: last.runId } : null,
    });
    return c.json({
      kind: "automation_workflow_run_list",
      schema_version: "1",
      project_id: projectId,
      automation_id: automationId,
      runs: page.map((row) => ({
        run_id: row.runId,
        workflow_revision_id: row.workflowRevisionId,
        trigger_receipt_id: row.triggerReceiptId,
        trigger_kind: row.triggerKind,
        attempt: row.attempt,
        status: row.status,
        state_revision: row.stateRevision,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        read: {
          method: "GET" as const,
          path: automationWorkflowRunRoutes(projectId, automationId, row.runId).run,
        },
      })),
      pagination,
      next_action: page.length > 0
        ? "GET the selected run.read.path. Treat its strict next_action as the only executable continuation authority."
        : pagination.follow_up
          ? "Call pagination.follow_up exactly before declaring the filtered run history complete."
          : "No workflow runs match this filter.",
    });
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await requireProjectAccess(c, projectId);
    requireCredentialScope(c, "runs:read", projectId, automationId);
    const run = await readAutomationWorkflowRun(getDb(c.env), projectId, runId(c));
    if (!run || run.automation_id !== automationId) throw errors.notFound("automation_workflow_run");
    return c.json(run);
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease",
  runnerOnly,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const principal = exactRunner(c, projectId, automationId, "runs:write");
    const selectedRunId = runId(c);
    await assertRunScope(getDb(c.env), projectId, automationId, selectedRunId);
    const body = parseBody(AcquireLeaseSchema, await readBoundedJson(c, 16_384));
    const receipt = await acquireAutomationWorkflowRunLease(getDb(c.env), {
      run_id: selectedRunId,
      holder_credential_id: principal.credentialId,
      ...body,
    });
    return c.json({ ...receipt, recovery: commandRecovery(projectId, automationId, selectedRunId) });
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease/renew",
  runnerOnly,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const principal = exactRunner(c, projectId, automationId, "runs:write");
    const selectedRunId = runId(c);
    await assertRunScope(getDb(c.env), projectId, automationId, selectedRunId);
    const body = parseBody(RenewLeaseSchema, await readBoundedJson(c, 16_384));
    const receipt = await renewAutomationWorkflowRunLease(getDb(c.env), {
      run_id: selectedRunId,
      holder_credential_id: principal.credentialId,
      ...body,
    });
    return c.json({ ...receipt, recovery: commandRecovery(projectId, automationId, selectedRunId) });
  },
);

router.delete(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease",
  runnerOnly,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const principal = exactRunner(c, projectId, automationId, "runs:write");
    const selectedRunId = runId(c);
    await assertRunScope(getDb(c.env), projectId, automationId, selectedRunId);
    const body = parseBody(ReleaseLeaseSchema, await readBoundedJson(c, 16_384));
    const receipt = await releaseAutomationWorkflowRunLease(getDb(c.env), {
      run_id: selectedRunId,
      holder_credential_id: principal.credentialId,
      ...body,
    });
    return c.json({ ...receipt, recovery: commandRecovery(projectId, automationId, selectedRunId) });
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/commands",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const selectedRunId = runId(c);
    const authenticatedPrincipal = c.get("projectCredential");
    if (authenticatedPrincipal) {
      exactRunner(c, projectId, automationId, "runs:write");
    } else {
      await requireProjectOwner(c, projectId);
    }
    await assertRunScope(getDb(c.env), projectId, automationId, selectedRunId);
    const raw = await readBoundedJson(c, BODY_LIMIT);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !COMMAND_KINDS.has(String((raw as { kind?: unknown }).kind))) {
      throw errors.invalidPayload({
        reason: "kind must be one of component_succeeded, component_domain_failed, approval_decided, effect_call_started, or effect_receipt_recorded",
      });
    }
    const parsed = parseBody(PublicCommandSchema, raw);
    if (
      (parsed.kind === "component_succeeded" || parsed.kind === "effect_receipt_recorded") &&
      !Object.prototype.hasOwnProperty.call(raw, "output")
    ) {
      throw errors.invalidPayload({ reason: "output is required for this command kind" });
    }
    if (parsed.kind === "approval_decided") {
      // The shared middleware authenticates either principal so the request can
      // be parsed once, but only a human owner may grant approval authority.
      // Reassert that boundary here before reading the private API-key actor.
      await requireProjectOwner(c, projectId);
      const { kind, command_id, expected_revision, node_id, decision, reason } = parsed;
      const receipt = await applyAutomationWorkflowCommand(getDb(c.env), {
        run_id: selectedRunId,
        command: { kind, command_id, expected_revision, node_id, decision, reason },
        actor: { principal: "human_project_owner", credential_id: c.get("apiKey").id },
      });
      return c.json({ ...receipt, recovery: commandRecovery(projectId, automationId, selectedRunId) });
    }
    const runner = exactRunner(c, projectId, automationId, "runs:write");
    if (
      !authenticatedPrincipal ||
      authenticatedPrincipal.credentialId !== runner.credentialId
    ) throw errors.forbidden();
    const { lease, ...command } = parsed as typeof parsed & { lease?: z.infer<typeof LeaseFenceSchema> };
    const receipt = await applyAutomationWorkflowCommand(getDb(c.env), {
      run_id: selectedRunId,
      command: command as ApplyAutomationWorkflowCommandInput["command"],
      actor: { principal: "automation_runner", credential_id: runner.credentialId },
      lease,
    });
    return c.json({ ...receipt, recovery: commandRecovery(projectId, automationId, selectedRunId) });
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/cancel",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await requireProjectOwner(c, projectId);
    const selectedRunId = runId(c);
    await assertRunScope(getDb(c.env), projectId, automationId, selectedRunId);
    const key = requiredIdempotencyKey(c);
    const body = parseBody(CancelSchema, await readBoundedJson(c, 16_384));
    const digest = await sha256Hex(`automation-workflow-cancel:${projectId}:${selectedRunId}:${key}`);
    const receipt = await applyAutomationWorkflowCommand(getDb(c.env), {
      run_id: selectedRunId,
      command: {
        kind: "cancel",
        command_id: `cancel:${digest}`,
        expected_revision: body.expected_revision,
        reason: body.reason,
      },
      actor: { principal: "human_project_owner", credential_id: c.get("apiKey").id },
    });
    return c.json({ ...receipt, recovery: commandRecovery(projectId, automationId, selectedRunId) });
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/advance",
  runnerOrOwner,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    await ownerOrExactRunner(c, projectId, automationId, "runs:write");
    const selectedRunId = runId(c);
    await assertRunScope(getDb(c.env), projectId, automationId, selectedRunId);
    const body = parseBody(AdvanceSchema, await readBoundedJson(c, 16_384));
    return c.json(await advanceAutomationWorkflowSystemNodes(getDb(c.env), c.env, {
      project_id: projectId,
      automation_id: automationId,
      run_id: selectedRunId,
      max_steps: body.max_steps,
    }));
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/effects/:effect_id",
  effectReader,
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const principal = c.get("projectCredential");
    if (principal?.kind === "automation_runner") {
      exactRunner(c, projectId, automationId, "runs:read");
    } else if (principal?.kind === "ci_deploy") {
      if (principal.projectId !== projectId || !principal.scopes.includes("automation_proofs:write")) {
        throw errors.credentialScopeDenied("automation_proofs:write", principal.kind, {
          credential_id: principal.credentialId,
        });
      }
    } else {
      await requireProjectAccess(c, projectId);
    }
    const effect = await readAutomationWorkflowEffect(
      getDb(c.env),
      projectId,
      automationId,
      runId(c),
      c.req.param("effect_id") ?? "",
    );
    if (!effect) throw errors.notFound("automation_workflow_effect");
    return c.json(effect);
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/effects/:effect_id/reconcile",
  async (c) => {
    const { projectId, automationId } = pathIdentity(c);
    const principal = await authenticateProjectCredential(c);
    if (
      principal.kind !== "ci_deploy" ||
      principal.projectId !== projectId ||
      !principal.scopes.includes("automation_proofs:write")
    ) {
      throw errors.credentialScopeDenied("automation_proofs:write", principal.kind, {
        credential_id: principal.credentialId,
        required_env_var: "AGENTRY_CI_API_KEY",
      });
    }
    const selectedRunId = runId(c);
    const effectId = c.req.param("effect_id") ?? "";
    const effect = await readAutomationWorkflowEffect(
      getDb(c.env),
      projectId,
      automationId,
      selectedRunId,
      effectId,
    );
    if (!effect) throw errors.notFound("automation_workflow_effect");
    const key = requiredIdempotencyKey(c);
    const raw = await readBoundedJson(c, BODY_LIMIT);
    const body = parseBody(ReconcileSchema, raw);
    if (body.outcome === "found" && !Object.prototype.hasOwnProperty.call(raw as object, "output")) {
      throw errors.invalidPayload({ reason: "output is required when outcome is found" });
    }
    const receipt = await reconcileAutomationWorkflowEffect(getDb(c.env), {
      project_id: projectId,
      effect_id: effectId,
      idempotency_key: key,
      outcome: body.outcome,
      evidence: body.evidence,
      output: body.output,
      actor: { principal: "trusted_ci", credential_id: principal.credentialId },
    });
    return c.json(receipt);
  },
);

export default router;
