import { and, eq, sql } from "drizzle-orm";
import {
  automationContracts,
  automationWorkflowProjectControls,
  automationWorkflowRevisions,
  automationWorkflows,
  projects,
} from "@agentry/db/schema";
import {
  AgentryError,
  AutomationContractSchema,
  AutomationWorkflowDefinitionSchema,
  canonicalJsonStringify,
  errors,
  prepareTelemetryObservation,
  sha256Hex,
  type AutomationWorkflowDefinition,
} from "@agentrysh/shared";
import { z } from "zod";
import type { getDb } from "./db.js";
import {
  compileAutomationWorkflow,
  type AutomationWorkflowCompileIssue,
  type CompiledAutomationWorkflow,
} from "./automation-workflow-compiler.js";
import {
  automationWorkflowHeadEtag,
  automationWorkflowProjectControlEtag,
} from "./automation-workflow-identities.js";
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "./automation-deletion-boundary.js";

const IdSchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const WorkflowIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);
const StrongEtagSchema = z.string().regex(/^"[A-Za-z0-9._:-]+"$/);
const UnixSecondsSchema = z.number().int().nonnegative();
const MAX_WORKFLOW_JSON_BYTES = 1_048_576;
const MAX_COMPILED_JSON_BYTES = 4_194_304;
const MAX_COMPONENT_HASHES_JSON_BYTES = 262_144;

const SaveDisabledWorkflowSchema = z.object({
  project_id: IdSchema,
  actor_user_id: IdSchema,
  workflow: z.unknown(),
  expected_etag: StrongEtagSchema.optional(),
  observed_at: UnixSecondsSchema.optional(),
}).strict();

type Db = ReturnType<typeof getDb>;
type WorkflowHeadRow = typeof automationWorkflows.$inferSelect;
type WorkflowRevisionRow = typeof automationWorkflowRevisions.$inferSelect;

export type SaveDisabledAutomationWorkflowInput = z.input<typeof SaveDisabledWorkflowSchema>;

export type StoredAutomationWorkflow = {
  kind: "automation_workflow";
  schema_version: "3";
  project_id: string;
  automation_id: string;
  revision_id: string;
  revision: number;
  etag: string;
  enabled: boolean;
  active_revision_id: string | null;
  active_execution_authority_id: string | null;
  paused_at: number | null;
  pause_reason: string | null;
  workflow_hash: string;
  compile_hash: string;
  component_hashes: Record<string, string>;
  workflow: AutomationWorkflowDefinition;
  compiled: CompiledAutomationWorkflow;
  created_at: number;
  updated_at: number;
  next_action: string;
};

export type SaveDisabledAutomationWorkflowResult = {
  workflow: StoredAutomationWorkflow;
  created: boolean;
};

/**
 * Immutable execution artifact loaded by revision id. Unlike
 * `StoredAutomationWorkflow`, this deliberately has no control-head fields:
 * an already-created run must remain replayable after the workflow is paused,
 * replaced, or disabled. Live authority is checked separately by the runtime
 * service before it issues new work.
 */
export type StoredAutomationWorkflowRevision = {
  kind: "automation_workflow_revision";
  schema_version: "3";
  project_id: string;
  automation_id: string;
  revision_id: string;
  revision: number;
  workflow_hash: string;
  compile_hash: string;
  component_hashes: Record<string, string>;
  workflow: AutomationWorkflowDefinition;
  compiled: CompiledAutomationWorkflow;
  created_at: number;
};

function nowSeconds(observedAt?: number): number {
  return observedAt ?? Math.floor(Date.now() / 1_000);
}

function compileFailed(issues: AutomationWorkflowCompileIssue[]): never {
  throw new AgentryError({
    status: 422,
    code: "automation_workflow_compile_failed",
    message: "The workflow is structurally valid JSON but cannot be compiled into an executable policy.",
    nextAction: "Fix every reported graph, component, authority, or budget issue and compile the disabled workflow again.",
    details: { issues },
  });
}

function corrupt(
  projectId: string,
  automationId: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw errors.persistenceFailed(
    message,
    "Keep the workflow disabled and repair or remove the corrupt workflow revision before attempting execution.",
    { project_id: projectId, automation_id: automationId, ...details },
  );
}

function parseStoredJson(text: string, field: string, row: WorkflowRevisionRow): unknown {
  try {
    return JSON.parse(text);
  } catch {
    corrupt(row.projectId, row.automationId, `Persisted workflow ${field} is not valid JSON.`, {
      revision_id: row.id,
      field,
    });
  }
}

function componentHashes(compiled: CompiledAutomationWorkflow): Record<string, string> {
  return Object.fromEntries(
    compiled.resolved_components
      .map((component) => [
        `${component.id}@${component.version}`,
        component.component_hash,
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function validateFrozenCompilation(
  revision: WorkflowRevisionRow,
  workflow: AutomationWorkflowDefinition,
): Promise<{ compiled: CompiledAutomationWorkflow; componentHashes: Record<string, string> }> {
  const raw = parseStoredJson(revision.compiledJson, "compilation", revision);
  if (!isRecord(raw) || canonicalJsonStringify(raw) !== revision.compiledJson) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow compilation is not a canonical JSON object.", {
      revision_id: revision.id,
    });
  }
  if (
    raw.kind !== "automation_workflow_compile" ||
    raw.schema_version !== "3" ||
    raw.workflow_hash !== revision.workflowHash ||
    raw.compile_hash !== revision.compileHash ||
    !isRecord(raw.candidate) ||
    raw.candidate.enabled !== false ||
    !Array.isArray(raw.resolved_components) ||
    !Array.isArray(raw.resolved_nodes) ||
    !Array.isArray(raw.requirements) ||
    !isRecord(raw.principals) ||
    !isRecord(raw.policy) ||
    !isRecord(raw.readiness) ||
    !isRecord(raw.compile_side_effects) ||
    typeof raw.next_action !== "string"
  ) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow compilation envelope is invalid.", {
      revision_id: revision.id,
    });
  }

  const embeddedWorkflow = AutomationWorkflowDefinitionSchema.safeParse(raw.workflow);
  const candidateWorkflow = AutomationWorkflowDefinitionSchema.safeParse(raw.candidate.workflow);
  if (
    !embeddedWorkflow.success ||
    !candidateWorkflow.success ||
    canonicalJsonStringify(embeddedWorkflow.data) !== canonicalJsonStringify(workflow) ||
    canonicalJsonStringify(candidateWorkflow.data) !== canonicalJsonStringify(workflow) ||
    raw.candidate.workflow_hash !== revision.workflowHash
  ) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow compilation embeds a different workflow definition.", {
      revision_id: revision.id,
    });
  }

  const { compile_hash: _storedCompileHash, ...canonicalOutput } = raw;
  const computedCompileHash = await sha256Hex(canonicalJsonStringify(canonicalOutput));
  if (computedCompileHash !== revision.compileHash) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow compile hash does not match its frozen compilation.", {
      revision_id: revision.id,
    });
  }

  const hashes: Array<readonly [string, string]> = [];
  for (const component of raw.resolved_components) {
    if (
      !isRecord(component) ||
      typeof component.id !== "string" ||
      typeof component.version !== "string" ||
      typeof component.component_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(component.component_hash)
    ) {
      corrupt(revision.projectId, revision.automationId, "Persisted workflow contains an invalid frozen component descriptor.", {
        revision_id: revision.id,
      });
    }
    hashes.push([`${component.id}@${component.version}`, component.component_hash]);
  }
  hashes.sort(([left], [right]) => left.localeCompare(right));
  const frozenComponentHashes = Object.fromEntries(hashes);
  if (Object.keys(frozenComponentHashes).length !== hashes.length) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow compilation contains duplicate component versions.", {
      revision_id: revision.id,
    });
  }

  return {
    // The compiler output is frozen and self-hashed. Runtime admission still
    // revalidates exact supported component/schema hashes before execution.
    compiled: raw as unknown as CompiledAutomationWorkflow,
    componentHashes: frozenComponentHashes,
  };
}

async function workflowRevisionId(input: {
  project_id: string;
  automation_id: string;
  revision: number;
  workflow_hash: string;
  compile_hash: string;
}): Promise<string> {
  const digest = await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-revision-id-v1",
    ...input,
  }));
  return `awfr_${digest}`;
}

async function validatePersistedRevision(
  head: WorkflowHeadRow,
  revision: WorkflowRevisionRow,
): Promise<StoredAutomationWorkflow> {
  if (
    head.projectId !== revision.projectId ||
    head.automationId !== revision.automationId ||
    head.currentRevisionId !== revision.id ||
    head.currentRevision !== revision.revision
  ) {
    corrupt(head.projectId, head.automationId, "Workflow head does not identify its exact immutable revision.", {
      current_revision_id: head.currentRevisionId,
      current_revision: head.currentRevision,
    });
  }
  if (revision.schemaVersion !== "3") {
    corrupt(head.projectId, head.automationId, "Persisted workflow revision has an unsupported schema version.", {
      schema_version: revision.schemaVersion,
      revision_id: revision.id,
    });
  }

  const parsedWorkflow = AutomationWorkflowDefinitionSchema.safeParse(
    parseStoredJson(revision.workflowJson, "definition", revision),
  );
  if (!parsedWorkflow.success) {
    corrupt(head.projectId, head.automationId, "Persisted workflow definition no longer matches schema v3.", {
      revision_id: revision.id,
    });
  }
  const workflowJson = canonicalJsonStringify(parsedWorkflow.data);
  const workflowHash = await sha256Hex(workflowJson);
  if (workflowJson !== revision.workflowJson || workflowHash !== revision.workflowHash) {
    corrupt(head.projectId, head.automationId, "Persisted workflow definition hash does not match its canonical JSON.", {
      revision_id: revision.id,
    });
  }

  const frozen = await validateFrozenCompilation(revision, parsedWorkflow.data);
  const expectedComponentHashes = frozen.componentHashes;
  const parsedComponentHashes = parseStoredJson(
    revision.componentHashesJson,
    "component hashes",
    revision,
  );
  if (canonicalJsonStringify(parsedComponentHashes) !== canonicalJsonStringify(expectedComponentHashes)) {
    corrupt(head.projectId, head.automationId, "Persisted workflow component hashes do not match its compilation.", {
      revision_id: revision.id,
    });
  }

  const expectedEtag = await automationWorkflowHeadEtag({
    project_id: head.projectId,
    automation_id: head.automationId,
    current_revision_id: head.currentRevisionId,
    current_revision: head.currentRevision,
    workflow_hash: revision.workflowHash,
    compile_hash: revision.compileHash,
    enabled: head.enabled === 1,
    active_revision_id: head.activeRevisionId,
    active_execution_authority_id: head.activeExecutionAuthorityId,
    paused_at: head.pausedAt,
    pause_reason: head.pauseReason,
    updated_at: head.updatedAt,
  });
  if (head.etag !== expectedEtag) {
    corrupt(head.projectId, head.automationId, "Persisted workflow head ETag does not match its canonical state.", {
      current_revision_id: head.currentRevisionId,
    });
  }

  return {
    kind: "automation_workflow",
    schema_version: "3",
    project_id: head.projectId,
    automation_id: head.automationId,
    revision_id: revision.id,
    revision: revision.revision,
    etag: head.etag,
    enabled: head.enabled === 1,
    active_revision_id: head.activeRevisionId,
    active_execution_authority_id: head.activeExecutionAuthorityId,
    paused_at: head.pausedAt,
    pause_reason: head.pauseReason,
    workflow_hash: revision.workflowHash,
    compile_hash: revision.compileHash,
    component_hashes: expectedComponentHashes,
    workflow: parsedWorkflow.data,
    compiled: frozen.compiled,
    created_at: head.createdAt,
    updated_at: head.updatedAt,
    next_action: head.enabled === 1
      ? "This exact revision is active. Use the emergency pause before changing or investigating unsafe behavior."
      : head.pausedAt !== null
        ? "Execution is paused. Inspect pause_reason and readiness, then an owner may re-enable only this exact reviewed revision."
        : "Review the immutable revision and satisfy every readiness requirement, then use the separate owner-only enable operation.",
  };
}

async function validatePersistedRevisionArtifact(
  revision: WorkflowRevisionRow,
): Promise<StoredAutomationWorkflowRevision> {
  if (revision.schemaVersion !== "3") {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow revision has an unsupported schema version.", {
      schema_version: revision.schemaVersion,
      revision_id: revision.id,
    });
  }

  const parsedWorkflow = AutomationWorkflowDefinitionSchema.safeParse(
    parseStoredJson(revision.workflowJson, "definition", revision),
  );
  if (!parsedWorkflow.success) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow definition no longer matches schema v3.", {
      revision_id: revision.id,
    });
  }
  const workflowJson = canonicalJsonStringify(parsedWorkflow.data);
  const workflowHash = await sha256Hex(workflowJson);
  if (workflowJson !== revision.workflowJson || workflowHash !== revision.workflowHash) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow definition hash does not match its canonical JSON.", {
      revision_id: revision.id,
    });
  }

  const frozen = await validateFrozenCompilation(revision, parsedWorkflow.data);
  const parsedComponentHashes = parseStoredJson(
    revision.componentHashesJson,
    "component hashes",
    revision,
  );
  if (canonicalJsonStringify(parsedComponentHashes) !== canonicalJsonStringify(frozen.componentHashes)) {
    corrupt(revision.projectId, revision.automationId, "Persisted workflow component hashes do not match its compilation.", {
      revision_id: revision.id,
    });
  }

  return {
    kind: "automation_workflow_revision",
    schema_version: "3",
    project_id: revision.projectId,
    automation_id: revision.automationId,
    revision_id: revision.id,
    revision: revision.revision,
    workflow_hash: revision.workflowHash,
    compile_hash: revision.compileHash,
    component_hashes: frozen.componentHashes,
    workflow: parsedWorkflow.data,
    compiled: frozen.compiled,
    created_at: revision.createdAt,
  };
}

async function loadRows(
  db: Db,
  projectId: string,
  automationId: string,
): Promise<{ head: WorkflowHeadRow; revision: WorkflowRevisionRow } | null> {
  return (
    await db.select({
      head: automationWorkflows,
      revision: automationWorkflowRevisions,
    }).from(automationWorkflows).innerJoin(
      automationWorkflowRevisions,
      and(
        eq(automationWorkflowRevisions.id, automationWorkflows.currentRevisionId),
        eq(automationWorkflowRevisions.projectId, automationWorkflows.projectId),
        eq(automationWorkflowRevisions.automationId, automationWorkflows.automationId),
        eq(automationWorkflowRevisions.revision, automationWorkflows.currentRevision),
      ),
    ).where(and(
      eq(automationWorkflows.projectId, projectId),
      eq(automationWorkflows.automationId, automationId),
    )).limit(1)
  )[0] ?? null;
}

export async function loadAutomationWorkflow(
  db: Db,
  projectIdInput: string,
  automationIdInput: string,
): Promise<StoredAutomationWorkflow | null> {
  const projectId = IdSchema.parse(projectIdInput);
  const automationId = WorkflowIdSchema.parse(automationIdInput);
  const rows = await loadRows(db, projectId, automationId);
  return rows ? validatePersistedRevision(rows.head, rows.revision) : null;
}

export async function loadAutomationWorkflowRevision(
  db: Db,
  projectIdInput: string,
  revisionIdInput: string,
): Promise<StoredAutomationWorkflowRevision | null> {
  const projectId = IdSchema.parse(projectIdInput);
  const revisionId = IdSchema.parse(revisionIdInput);
  const revision = (
    await db.select().from(automationWorkflowRevisions).where(and(
      eq(automationWorkflowRevisions.projectId, projectId),
      eq(automationWorkflowRevisions.id, revisionId),
    )).limit(1)
  )[0] ?? null;
  return revision ? validatePersistedRevisionArtifact(revision) : null;
}

export async function saveDisabledAutomationWorkflow(
  db: Db,
  input: SaveDisabledAutomationWorkflowInput,
): Promise<SaveDisabledAutomationWorkflowResult> {
  const parsed = SaveDisabledWorkflowSchema.parse(input);
  await assertAutomationWritesOpen(db, parsed.project_id);
  const compiled = await compileAutomationWorkflow(parsed.workflow);
  if (!compiled.success) compileFailed(compiled.issues);

  const inspection = prepareTelemetryObservation(compiled.data.workflow, {
    // Match the complete schema/body boundary used by the HTTP route so a
    // future internal caller cannot hide credential material beyond the
    // telemetry helper's intentionally smaller display defaults.
    max_depth: 24,
    max_nodes: MAX_WORKFLOW_JSON_BYTES,
    max_object_keys: 100,
    max_array_items: 100,
    max_string_chars: 100_000,
  }).inspection;
  if (inspection.indicators.includes("content_truncated")) {
    throw new AgentryError({
      status: 400,
      code: "automation_workflow_inspection_incomplete",
      message: "The workflow could not be inspected completely and was not saved.",
      nextAction: "Reduce workflow nesting or size, then compile the disabled workflow again.",
      details: { truncated_paths: inspection.truncated_paths },
    });
  }
  if (inspection.indicators.includes("potential_secret")) {
    throw new AgentryError({
      status: 400,
      code: "automation_workflow_contains_secret",
      message: "The workflow appears to contain credential material and was not saved.",
      nextAction: "Remove secrets from workflow text and config. Reference separately scoped server-side credentials by capability instead.",
      details: { redacted_paths: inspection.redacted_paths },
    });
  }

  const observedAt = nowSeconds(parsed.observed_at);
  const workflow = compiled.data.workflow;
  const workflowJson = canonicalJsonStringify(workflow);
  const compiledJson = canonicalJsonStringify(compiled.data);
  const frozenComponentHashes = componentHashes(compiled.data);
  const componentHashesJson = canonicalJsonStringify(frozenComponentHashes);
  const sizes = {
    workflow_json_bytes: new TextEncoder().encode(workflowJson).byteLength,
    compiled_json_bytes: new TextEncoder().encode(compiledJson).byteLength,
    component_hashes_json_bytes: new TextEncoder().encode(componentHashesJson).byteLength,
  };
  if (
    sizes.workflow_json_bytes > MAX_WORKFLOW_JSON_BYTES ||
    sizes.compiled_json_bytes > MAX_COMPILED_JSON_BYTES ||
    sizes.component_hashes_json_bytes > MAX_COMPONENT_HASHES_JSON_BYTES
  ) {
    throw new AgentryError({
      status: 413,
      code: "automation_workflow_compilation_too_large",
      message: "The compiled workflow exceeds its durable storage boundary.",
      nextAction: "Reduce workflow nodes, labels, configuration, and repeated text, then compile the disabled candidate again.",
      details: sizes,
    });
  }

  try {
    return await db.transaction(async (tx) => {
      const existingProjectControl = (
        await tx.select().from(automationWorkflowProjectControls).where(
          eq(automationWorkflowProjectControls.projectId, parsed.project_id),
        ).limit(1)
      )[0] ?? null;
      if (!existingProjectControl) {
        const controlEtag = await automationWorkflowProjectControlEtag({
          project_id: parsed.project_id,
          revision: 1,
          paused_at: null,
          pause_reason: null,
          updated_at: observedAt,
        });
        const insertedControl = await tx.insert(automationWorkflowProjectControls).select(
          tx.select({
            projectId: sql<string>`${parsed.project_id}`.as("project_id"),
            revision: sql<number>`1`.as("revision"),
            etag: sql<string>`${controlEtag}`.as("etag"),
            createdBy: sql<string>`${parsed.actor_user_id}`.as("created_by"),
            updatedBy: sql<string>`${parsed.actor_user_id}`.as("updated_by"),
            createdAt: sql<number>`${observedAt}`.as("created_at"),
            updatedAt: sql<number>`${observedAt}`.as("updated_at"),
            pausedAt: sql<null>`NULL`.as("paused_at"),
            pauseReason: sql<null>`NULL`.as("pause_reason"),
          }).from(projects).where(and(
            eq(projects.id, parsed.project_id),
            automationWritesOpenForProject(projects.id),
          )),
        ).onConflictDoNothing().returning({ projectId: automationWorkflowProjectControls.projectId });
        if (insertedControl.length === 0) {
          const racedControl = (
            await tx.select({ projectId: automationWorkflowProjectControls.projectId })
              .from(automationWorkflowProjectControls)
              .where(eq(automationWorkflowProjectControls.projectId, parsed.project_id))
              .limit(1)
          )[0] ?? null;
          if (!racedControl) {
            await assertAutomationWritesOpen(tx as unknown as Db, parsed.project_id);
            throw errors.persistenceFailed(
              "The workflow project control could not be initialized.",
              "Keep workflow execution disabled and inspect project/control persistence before retrying.",
              { project_id: parsed.project_id },
            );
          }
        }
      }
    const current = (
      await tx.select().from(automationWorkflows).where(and(
        eq(automationWorkflows.projectId, parsed.project_id),
        eq(automationWorkflows.automationId, workflow.id),
      )).limit(1)
    )[0] ?? null;

    const legacyContractRow = (
      await tx.select({ documentJson: automationContracts.documentJson })
        .from(automationContracts)
        .where(eq(automationContracts.projectId, parsed.project_id))
        .limit(1)
    )[0] ?? null;
    if (legacyContractRow) {
      let legacyDocument: unknown;
      try {
        legacyDocument = JSON.parse(legacyContractRow.documentJson);
      } catch {
        throw errors.conflict(
          "automation_id_namespace_unverifiable",
          "The existing automation-v2 contract is corrupt, so workflow id ownership cannot be verified.",
          "Repair the automation-v2 contract through its canonical PUT route before saving a workflow-v3 revision.",
          { automation_id: workflow.id },
        );
      }
      const legacyContract = AutomationContractSchema.safeParse(legacyDocument);
      if (!legacyContract.success) {
        throw errors.conflict(
          "automation_id_namespace_unverifiable",
          "The existing automation-v2 contract is invalid, so workflow id ownership cannot be verified.",
          "Repair the automation-v2 contract through its canonical PUT route before saving a workflow-v3 revision.",
          { automation_id: workflow.id },
        );
      }
      if (legacyContract.data.automations.some((automation) => automation.id === workflow.id)) {
        throw errors.conflict(
          "automation_id_namespace_conflict",
          `Automation id ${workflow.id} already belongs to the automation-v2 contract.`,
          "Choose a distinct workflow-v3 id. Automation v2 and workflow v3 are separate execution generations with no implicit migration bridge.",
          { automation_id: workflow.id, existing_generation: "automation_v2" },
        );
      }
    }

    if (!current && parsed.expected_etag) {
      throw errors.preconditionFailed(
        "If-Match named a workflow head that does not exist.",
        "Remove If-Match only for the first save, after confirming this workflow id is unused.",
        { automation_id: workflow.id },
      );
    }
    if (current && !parsed.expected_etag) {
      throw errors.preconditionRequired(
        "Replacing an automation workflow requires its current ETag.",
        "Reload the workflow and retry with If-Match set to its exact ETag.",
        { current_etag: current.etag, current_revision: current.currentRevision },
      );
    }
    if (current && current.etag !== parsed.expected_etag) {
      throw errors.preconditionFailed(
        "The automation workflow changed before this save.",
        "Reload the workflow, review the current immutable revision, and retry only if replacement is still intended.",
        { current_etag: current.etag, current_revision: current.currentRevision },
      );
    }

    const revision = (current?.currentRevision ?? 0) + 1;
    const revisionId = await workflowRevisionId({
      project_id: parsed.project_id,
      automation_id: workflow.id,
      revision,
      workflow_hash: compiled.data.workflow_hash,
      compile_hash: compiled.data.compile_hash,
    });
    const etag = await automationWorkflowHeadEtag({
      project_id: parsed.project_id,
      automation_id: workflow.id,
      current_revision_id: revisionId,
      current_revision: revision,
      workflow_hash: compiled.data.workflow_hash,
      compile_hash: compiled.data.compile_hash,
      enabled: false,
      active_revision_id: null,
      active_execution_authority_id: null,
      paused_at: null,
      pause_reason: null,
      updated_at: observedAt,
    });

    const insertedRevision = await tx.insert(automationWorkflowRevisions).values({
      id: revisionId,
      projectId: parsed.project_id,
      automationId: workflow.id,
      revision,
      schemaVersion: "3",
      workflowJson,
      workflowHash: compiled.data.workflow_hash,
      compiledJson,
      compileHash: compiled.data.compile_hash,
      componentHashesJson,
      createdBy: parsed.actor_user_id,
      createdAt: observedAt,
    }).onConflictDoNothing().returning({ id: automationWorkflowRevisions.id });
    if (insertedRevision.length === 0) {
      throw errors.preconditionFailed(
        "Another save created this immutable workflow revision concurrently.",
        "Reload the current workflow head and retry only with its exact ETag if another replacement is still required.",
        { automation_id: workflow.id, revision },
      );
    }

    if (!current) {
      const inserted = await tx.insert(automationWorkflows).select(
        tx.select({
          projectId: sql<string>`${parsed.project_id}`.as("project_id"),
          automationId: sql<string>`${workflow.id}`.as("automation_id"),
          currentRevisionId: sql<string>`${revisionId}`.as("current_revision_id"),
          currentRevision: sql<number>`${revision}`.as("current_revision"),
          activeRevisionId: sql<null>`NULL`.as("active_revision_id"),
          activeExecutionAuthorityId: sql<null>`NULL`.as("active_execution_authority_id"),
          etag: sql<string>`${etag}`.as("etag"),
          enabled: sql<number>`0`.as("enabled"),
          createdBy: sql<string>`${parsed.actor_user_id}`.as("created_by"),
          updatedBy: sql<string>`${parsed.actor_user_id}`.as("updated_by"),
          createdAt: sql<number>`${observedAt}`.as("created_at"),
          updatedAt: sql<number>`${observedAt}`.as("updated_at"),
          pausedAt: sql<null>`NULL`.as("paused_at"),
          pauseReason: sql<null>`NULL`.as("pause_reason"),
        }).from(projects).where(and(
          eq(projects.id, parsed.project_id),
          automationWritesOpenForProject(projects.id),
        )),
      ).onConflictDoNothing().returning({ projectId: automationWorkflows.projectId });
      if (inserted.length === 0) {
        await assertAutomationWritesOpen(tx as unknown as Db, parsed.project_id);
        throw errors.preconditionFailed(
          "Another save created this workflow concurrently.",
          "Reload the workflow and retry a replacement with its exact ETag.",
          { automation_id: workflow.id },
        );
      }
    } else {
      const updated = await tx.update(automationWorkflows).set({
        currentRevisionId: revisionId,
        currentRevision: revision,
        activeRevisionId: null,
        activeExecutionAuthorityId: null,
        etag,
        enabled: 0,
        updatedBy: parsed.actor_user_id,
        updatedAt: observedAt,
        pausedAt: null,
        pauseReason: null,
      }).where(and(
        eq(automationWorkflows.projectId, parsed.project_id),
        eq(automationWorkflows.automationId, workflow.id),
        eq(automationWorkflows.etag, current.etag),
        automationWritesOpenForProject(automationWorkflows.projectId),
      )).returning({ projectId: automationWorkflows.projectId });
      if (updated.length === 0) {
        await assertAutomationWritesOpen(tx as unknown as Db, parsed.project_id);
        throw errors.preconditionFailed(
          "The automation workflow changed during this save.",
          "Reload the workflow and retry only against its new exact ETag.",
          { automation_id: workflow.id },
        );
      }
    }

    const stored = await loadRows(tx as unknown as Db, parsed.project_id, workflow.id);
    if (!stored) {
      throw errors.persistenceFailed(
        "The workflow revision was written but its control head could not be loaded in the same transaction.",
        "Keep the workflow disabled and inspect database integrity before retrying.",
        { automation_id: workflow.id, revision_id: revisionId },
      );
    }
    return {
      workflow: await validatePersistedRevision(stored.head, stored.revision),
      created: current === null,
    };
    });
  } catch (error) {
    await assertAutomationWritesOpen(db, parsed.project_id);
    throw error;
  }
}
