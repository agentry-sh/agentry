import { Hono } from "hono";
import { mutationCommands } from "@agentry/db/schema";
import { AgentryError, errors } from "@agentrysh/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  enableAutomationWorkflow,
  pauseAutomationWorkflow,
  pauseAutomationWorkflowProject,
  readAutomationWorkflowProjectControl,
  resumeAutomationWorkflowProject,
} from "../automation-workflow-controls.js";
import { readAutomationWorkflowReadiness } from "../automation-workflow-readiness.js";
import { readBoundedJson } from "../bounded-json.js";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";
import {
  requireApiKey,
  requireProjectAccess,
  requireProjectOwner,
} from "../middleware.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";
import { requireNerveForProject } from "../billing.js";

const router = new Hono<AppBindings>();
const WorkflowIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/u);
const RevisionIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const AssertionIdSchema = z.string().trim().min(1).max(200)
  .regex(/^[a-z][a-z0-9_.:-]*$/u);
const ReasonSchema = z.string().trim().min(1).max(1_000);
const EnableBodySchema = z.object({
  revision_id: RevisionIdSchema,
  readiness_hash: HashSchema,
  owner_confirmed_caller_assertion_ids: z.array(AssertionIdSchema).max(100).default([]),
}).strict();
const PauseBodySchema = z.object({ reason: ReasonSchema }).strict();
const EmptyBodySchema = z.object({}).strict();
const STRONG_ETAG = /^"[A-Za-z0-9._:-]+"$/u;
const BODY_LIMIT = 16_384;

type Db = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function workflowId(value: string): string {
  const parsed = WorkflowIdSchema.safeParse(value);
  if (!parsed.success) throw errors.invalidPayload({
    reason: "automation_id must match ^[a-z][a-z0-9_-]{0,99}$",
  });
  return parsed.data;
}

function requiredIfMatch(value: string | undefined): string {
  const etag = value?.trim();
  if (!etag) {
    throw errors.preconditionRequired(
      "This control mutation requires an exact If-Match workflow ETag.",
      "Read the current workflow or project workflow control, review it, then retry with its exact ETag in If-Match.",
      { header: "If-Match" },
    );
  }
  if (!STRONG_ETAG.test(etag)) throw errors.invalidPayload({
    reason: "If-Match must contain one exact quoted strong ETag",
  });
  return etag;
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw errors.invalidPayload({ zod: parsed.error.flatten() });
  return parsed.data;
}

async function transactionMutationReceipt(
  tx: Transaction,
  commandId: string,
) {
  return (
    await tx.select().from(mutationCommands).where(eq(mutationCommands.id, commandId)).limit(1)
  )[0] ?? null;
}

router.get(
  "/v1/projects/:project_id/automation-workflow-control",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const control = await readAutomationWorkflowProjectControl(getDb(c.env), projectId);
    if (!control) throw errors.notFound("automation_workflow_project_control");
    c.header("etag", control.etag);
    return c.json(control);
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflow-control/pause",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    const body = parseBody(PauseBodySchema, await readBoundedJson(c, BODY_LIMIT));
    const control = await pauseAutomationWorkflowProject(getDb(c.env), {
      project_id: projectId,
      actor_user_id: c.get("user").id,
      reason: body.reason,
    });
    c.header("etag", control.etag);
    return c.json({
      kind: "automation_workflow_project_pause_receipt",
      schema_version: "1",
      ...control,
      next_action:
        "All new workflow work is stopped. Read affected runs and reconcile only provider effects whose call-start was already committed; after fixing the reason, resume with this project-control ETag.",
    });
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflow-control/resume",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    const expectedEtag = requiredIfMatch(c.req.header("if-match"));
    parseBody(EmptyBodySchema, await readBoundedJson(c, BODY_LIMIT));
    const identity = await mutationIdentity(c, {
      action: "automation_workflow.project_resume",
      projectId,
      request: { expected_etag: expectedEtag },
    });
    const existing = await loadMutationCommand(c, identity);
    if (existing) return c.json({
      ...mutationResponse<Record<string, unknown>>(existing),
      idempotent_replay: true,
    });
    const db = getDb(c.env);
    try {
      const response = await db.transaction(async (tx) => {
        const concurrent = await transactionMutationReceipt(tx, identity.id);
        if (concurrent) return mutationResponse<Record<string, unknown>>(concurrent);
        const control = await resumeAutomationWorkflowProject(tx as unknown as Db, {
          project_id: projectId,
          actor_user_id: c.get("user").id,
          expected_etag: expectedEtag,
        });
        if (!control) throw errors.persistenceFailed(
          "Project workflow control disappeared during resume.",
          "Keep execution paused and repair the control row before retrying.",
          { project_id: projectId },
        );
        const durable = {
          kind: "automation_workflow_project_resume_receipt",
          schema_version: "1",
          control,
          next_action:
            "Project workflow authority is open. Individual paused workflows remain disabled; re-read their readiness and enable only exact reviewed revisions.",
        };
        await tx.insert(mutationCommands).values(mutationCommandValues(identity, {
          resourceType: "automation_workflow_project_control",
          resourceId: projectId,
          response: durable,
        }));
        return durable;
      });
      if ("control" in response && response.control && typeof response.control === "object") {
        const etag = (response.control as { etag?: unknown }).etag;
        if (typeof etag === "string") c.header("etag", etag);
      }
      return c.json({ ...response, idempotent_replay: false });
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (winner) return c.json({
        ...mutationResponse<Record<string, unknown>>(winner),
        idempotent_replay: true,
      });
      throw error;
    }
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id/readiness",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const automationId = workflowId(c.req.param("automation_id"));
    const confirmations = new URL(c.req.url).searchParams.getAll("confirm");
    const readiness = await readAutomationWorkflowReadiness(getDb(c.env), {
      project_id: projectId,
      automation_id: automationId,
      owner_confirmed_caller_assertion_ids: confirmations,
    });
    c.header("etag", readiness.etag);
    return c.json(readiness);
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/enable",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    await requireNerveForProject(c.env, projectId);
    const automationId = workflowId(c.req.param("automation_id"));
    const expectedEtag = requiredIfMatch(c.req.header("if-match"));
    const body = parseBody(EnableBodySchema, await readBoundedJson(c, BODY_LIMIT));
    const confirmations = [...new Set(body.owner_confirmed_caller_assertion_ids)].sort();
    const request = {
      automation_id: automationId,
      revision_id: body.revision_id,
      readiness_hash: body.readiness_hash,
      owner_confirmed_caller_assertion_ids: confirmations,
      expected_etag: expectedEtag,
    };
    const identity = await mutationIdentity(c, {
      action: "automation_workflow.enable",
      projectId,
      request,
    });
    const existing = await loadMutationCommand(c, identity);
    if (existing) return c.json({
      ...mutationResponse<Record<string, unknown>>(existing),
      idempotent_replay: true,
    });
    const db = getDb(c.env);
    try {
      const response = await db.transaction(async (tx) => {
        const concurrent = await transactionMutationReceipt(tx, identity.id);
        if (concurrent) return mutationResponse<Record<string, unknown>>(concurrent);
        const readiness = await readAutomationWorkflowReadiness(tx as unknown as Db, {
          project_id: projectId,
          automation_id: automationId,
          expected_revision_id: body.revision_id,
          expected_etag: expectedEtag,
          owner_confirmed_caller_assertion_ids: confirmations,
        });
        if (readiness.readiness_hash !== body.readiness_hash) {
          throw errors.preconditionFailed(
            "Workflow readiness changed before enablement.",
            "Re-read readiness with the same explicit caller confirmations, review every check, then retry with its new readiness_hash and current workflow ETag.",
            {
              current_readiness_hash: readiness.readiness_hash,
              received_readiness_hash: body.readiness_hash,
              status: readiness.status,
            },
          );
        }
        if (readiness.status !== "ready") {
          throw new AgentryError({
            status: 409,
            code: "automation_workflow_not_ready",
            message: "The exact workflow revision has unresolved enablement blockers.",
            nextAction: readiness.next_action,
            details: { blockers: readiness.blockers, readiness_hash: readiness.readiness_hash },
          });
        }
        const enabled = await enableAutomationWorkflow(tx as unknown as Db, {
          project_id: projectId,
          automation_id: automationId,
          workflow_revision_id: body.revision_id,
          actor_user_id: c.get("user").id,
          expected_etag: expectedEtag,
          readiness_hash: readiness.readiness_hash,
          owner_confirmed_caller_assertion_ids: confirmations,
        });
        if (!enabled.workflow) throw errors.persistenceFailed(
          "The workflow head disappeared after its enable transaction.",
          "Pause project workflow authority and inspect the control-plane transaction before retrying.",
          { project_id: projectId, automation_id: automationId },
        );
        const durable = {
          kind: "automation_workflow_enable_receipt",
          schema_version: "1",
          workflow: enabled.workflow,
          runner_credential_id: enabled.runner_credential_id,
          execution_authority_id: enabled.execution_authority_id,
          execution_descriptor_hash: enabled.execution_descriptor_hash,
          readiness: {
            revision_id: readiness.revision_id,
            readiness_hash: readiness.readiness_hash,
            owner_confirmed_caller_assertion_ids: confirmations,
          },
          next_action:
            "Workflow execution is enabled for this exact revision. Configure the customer scheduler to request server-issued trigger receipts and follow each run's next_action; keep the runner credential out of source control.",
        };
        await tx.insert(mutationCommands).values(mutationCommandValues(identity, {
          resourceType: "automation_workflow",
          resourceId: automationId,
          response: durable,
        }));
        return durable;
      });
      if ("workflow" in response && response.workflow && typeof response.workflow === "object") {
        const etag = (response.workflow as { etag?: unknown }).etag;
        if (typeof etag === "string") c.header("etag", etag);
      }
      return c.json({ ...response, idempotent_replay: false });
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (winner) return c.json({
        ...mutationResponse<Record<string, unknown>>(winner),
        idempotent_replay: true,
      });
      throw error;
    }
  },
);

router.post(
  "/v1/projects/:project_id/automation-workflows/:automation_id/pause",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    const automationId = workflowId(c.req.param("automation_id"));
    const body = parseBody(PauseBodySchema, await readBoundedJson(c, BODY_LIMIT));
    const paused = await pauseAutomationWorkflow(getDb(c.env), {
      project_id: projectId,
      automation_id: automationId,
      actor_user_id: c.get("user").id,
      reason: body.reason,
    });
    c.header("etag", paused.etag);
    return c.json({
      kind: "automation_workflow_pause_receipt",
      schema_version: "1",
      ...paused,
      next_action:
        "New work is stopped for this workflow. Read nonterminal runs and reconcile only already-started provider effects; after fixing the reason, re-read readiness and enable the exact reviewed revision again.",
    });
  },
);

export default router;
