import { Hono } from "hono";
import {
  AutomationWorkflowDefinitionSchema,
  errors,
  prepareTelemetryObservation,
} from "@agentrysh/shared";
import { compileAutomationWorkflow } from "../automation-workflow-compiler.js";
import { serializeAutomationWorkflowComponentCatalog } from "../automation-workflow-components.js";
import { serializeAutomationWorkflowDataContractCatalog } from "../automation-workflow-contracts.js";
import {
  loadAutomationWorkflow,
  saveDisabledAutomationWorkflow,
} from "../automation-workflow-store.js";
import { readBoundedJson } from "../bounded-json.js";
import { getDb } from "../db.js";
import type { AppBindings } from "../env.js";
import {
  requireApiKey,
  requireProjectAccess,
  requireProjectOwner,
} from "../middleware.js";

const router = new Hono<AppBindings>();

const MAX_WORKFLOW_BODY_BYTES = 1_048_576;
const STRONG_ETAG = /^"[A-Za-z0-9._:-]+"$/;

function automationId(value: unknown, source: "path" | "body"): string {
  const parsed = AutomationWorkflowDefinitionSchema.shape.id.safeParse(value);
  if (!parsed.success) {
    throw errors.invalidPayload({
      reason: `${source} automation_id must match ^[a-z][a-z0-9_-]{0,99}$`,
      zod: parsed.error.flatten(),
      zod_issues: parsed.error.issues.map((issue) => ({
        path: source === "path" ? ["automation_id"] : ["id"],
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

function rejectCredentialMaterial(value: unknown): void {
  const inspection = prepareTelemetryObservation(value, {
    // These limits cover the complete maximum-size workflow rather than
    // returning a partially inspected copy that could hide a later secret.
    max_depth: 24,
    max_nodes: MAX_WORKFLOW_BODY_BYTES,
    max_object_keys: 100,
    max_array_items: 100,
    max_string_chars: 100_000,
  }).inspection;
  if (inspection.indicators.includes("potential_secret")) {
    throw errors.invalidPayload({
      reason: "automation workflows must not contain secrets or credentials",
      redacted_paths: inspection.redacted_paths,
    });
  }
}

function optionalIfMatch(value: string | undefined): string | undefined {
  const etag = value?.trim();
  if (!etag) return undefined;
  if (!STRONG_ETAG.test(etag)) {
    throw errors.invalidPayload({
      reason: "If-Match must contain one exact quoted strong workflow ETag",
    });
  }
  return etag;
}

router.get("/v1/automation-workflow-components", requireApiKey(), async (c) => {
  return c.json({
    ...(await serializeAutomationWorkflowComponentCatalog()),
    next_action:
      "Choose exact immutable component versions, then assemble their typed ports into a workflow v3 candidate and compile it in one accessible project.",
  });
});

router.get("/v1/automation-workflow-contracts", requireApiKey(), async (c) => {
  return c.json({
    ...(await serializeAutomationWorkflowDataContractCatalog()),
    next_action:
      "Use these immutable data contracts to connect only compatible component outputs and named input ports before compiling a workflow.",
  });
});

router.post(
  "/v1/projects/:project_id/automation-workflows/compile",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const body = await readBoundedJson(c, MAX_WORKFLOW_BODY_BYTES);
    rejectCredentialMaterial(body);

    const result = await compileAutomationWorkflow(body);
    return c.json({
      ...result,
      next_action: result.success
        ? "Review the deterministic candidate, then an owner may save it disabled at its exact workflow URL."
        : "Fix every reported issue, then compile the workflow again. No workflow was saved.",
    });
  },
);

router.put(
  "/v1/projects/:project_id/automation-workflows/:automation_id",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    const pathAutomationId = automationId(c.req.param("automation_id"), "path");
    const body = await readBoundedJson(c, MAX_WORKFLOW_BODY_BYTES);
    rejectCredentialMaterial(body);
    const bodyAutomationId = automationId(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).id
        : undefined,
      "body",
    );
    if (bodyAutomationId !== pathAutomationId) {
      throw errors.invalidPayload({
        reason: "workflow body id must exactly match the URL automation_id",
        automation_id: pathAutomationId,
        workflow_id: bodyAutomationId,
      });
    }

    const saved = await saveDisabledAutomationWorkflow(getDb(c.env), {
      project_id: projectId,
      actor_user_id: c.get("user").id,
      workflow: body,
      expected_etag: optionalIfMatch(c.req.header("if-match")),
    });
    c.header("etag", saved.workflow.etag);
    return c.json({
      ...saved.workflow,
      created: saved.created,
    });
  },
);

router.get(
  "/v1/projects/:project_id/automation-workflows/:automation_id",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectAccess(c, projectId);
    const pathAutomationId = automationId(c.req.param("automation_id"), "path");
    const workflow = await loadAutomationWorkflow(
      getDb(c.env),
      projectId,
      pathAutomationId,
    );
    if (!workflow) throw errors.notFound("automation_workflow");
    c.header("etag", workflow.etag);
    return c.json(workflow);
  },
);

export default router;
