import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  AgentryError,
  AutomationContractSchema,
  canonicalJsonStringify,
  CreateProjectRequestSchema,
  errors,
  uuidv7,
} from "@agentrysh/shared";
import type { AutomationContract } from "@agentrysh/shared";
import {
  accountDeletionFences,
  alerts,
  auditLog,
  automationContracts,
  automationWorkflows,
  mutationCommands,
  projectMemberships,
  projects,
  projectDeletionFences,
  users,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import {
  invalidateProjectAccessCache,
  requireApiKey,
  requireProjectAccess,
  requireProjectOwner,
} from "../middleware.js";
import {
  loadOnboardingV3State,
  type OnboardingV3State,
} from "../onboarding-v3-state-store.js";
import {
  prepareAuditEvent,
  type AuditInput,
} from "../audit.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";
import type { AppBindings } from "../env.js";
import {
  automationContractEtag,
  loadAutomationContract,
} from "../automation-contracts.js";
import { readBoundedJson } from "../bounded-json.js";
import {
  getQueryBlueprint,
  prepareQueryBlueprintExecution,
} from "../query-blueprints.js";
import { assertQueryBlueprintInputReadiness } from "../query-blueprint-readiness.js";
import {
  acquireDeletionCommandLease,
  loadDeletionCommandById,
  releaseDeletionCommandLease,
  type DurableDeletionCommand,
  type DurableDeletionLease,
} from "../durable-deletion.js";
import {
  externalMutationManifest,
  webhookDeliveryDrainState,
} from "../external-mutation-boundary.js";
import {
  assertAutomationWritesOpen,
  automationDeletionManifest,
  automationWritesOpenForProject,
  deleteAutomationWorkflowStateForProjects,
  type AutomationDeletionManifest,
} from "../automation-deletion-boundary.js";
import { requireNerveForProject } from "../billing.js";

const router = new Hono<AppBindings>();

function missingInstallArtifact(projectId: string): AgentryError {
  return new AgentryError({
    status: 404,
    code: "install_artifact_missing",
    message: "signal_map not found for this project.",
    nextAction:
      "Read or start the server-owned onboarding state at GET/POST /v1/projects/:project_id/onboarding and follow its one next_action. The signal map becomes available after the exact plan is approved; do not recreate retired planner or artifact files locally.",
    details: {
      resource: "signal_map",
      project_id: projectId,
      recovery_flow: [
        "GET /v1/projects/:project_id/onboarding",
        "POST /v1/projects/:project_id/onboarding",
        "follow state.next_action",
        "GET /v1/projects/:project_id/signal-map",
      ],
    },
  });
}

type ApprovedOnboardingState = Exclude<OnboardingV3State, { status: "planned" }>;

function publicSignalMapProjection(state: ApprovedOnboardingState) {
  return {
    project_id: state.project_id,
    contract_version: state.contract_version,
    mode: "onboarding_v3" as const,
    plan_sha256: state.plan_sha256,
    business_question: state.plan.business_question,
    plan_markdown: state.plan.plan_markdown,
    source_snapshot: state.plan.source_snapshot,
    historical_evidence: state.plan.historical_evidence,
    evidence_status: state.evidence_status,
    milestones: state.plan.milestones,
    failures: state.plan.failures,
    deploy: state.plan.deploy,
    receipt: state.status === "verified" ? state.receipt : null,
  };
}

router.use("*", requireApiKey());

router.post("/", async (c) => {
  const body = await readBoundedJson(c, 16_384);
  const parsed = CreateProjectRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw errors.invalidPayload({ zod: parsed.error.flatten() });
  }
  const { name, repo_url, default_branch, local_path } = parsed.data;

  const user = c.get("user");
  const db = getDb(c.env);
  const identity = await mutationIdentity(c, {
    action: "project.create",
    projectId: null,
    request: parsed.data,
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) return replayProjectCreateCommand(c, existing);

  const projectId = uuidv7();
  const createdAt = Math.floor(Date.now() / 1000);
  const reqUrl = new URL(c.req.url);
  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  const durableResponse = {
    command_id: identity.id,
    id: projectId,
    name,
    role: "owner",
    deploys_url: `${baseUrl}/v1/deploys/`,
    deploys_note:
      "Create a ci_deploy credential at POST /v1/projects/:id/credentials and use its AGENTRY_CI_API_KEY only from a CI/provider post-deploy hook after success.",
    next_action:
      "Continue with the CLI's PostHog OAuth checkpoint to connect this Agentry project to one existing customer-owned PostHog Cloud project. " +
      "Then start POST /v1/projects/:project_id/onboarding with complete source-grounded business-value discovery and follow the returned state's one next_action through plan approval and source verification. " +
      "Agentry never provisions or deletes the customer's PostHog project. " +
      "ALWAYS set a custom User-Agent header on non-browser direct HTTP calls — Cloudflare's Browser Integrity " +
      "Check can return 403 (CF error 1010) for defaults such as Python-urllib.",
  };
  const projectValues = {
    id: projectId,
    userId: user.id,
    name,
    repoUrl: repo_url ?? null,
    defaultBranch: default_branch ?? "main",
    localPath: local_path ?? null,
    createdAt,
  } as const;
  const ownerMembershipValues = {
    id: uuidv7(),
    projectId,
    userId: user.id,
    role: "owner",
    invitedBy: null,
    createdAt,
  } as const;
  const commandValues = mutationCommandValues(identity, {
    resourceType: "project",
    resourceId: projectId,
    response: durableResponse,
    createdAt,
  });
  const localAudit = await prepareAuditEvent(c, {
    userId: user.id,
    projectId,
    action: "project.created",
    resourceType: "project",
    resourceId: projectId,
    summary: `Created project ${name}`,
    metadata: {
      command_id: identity.id,
      has_repo_url: repo_url !== undefined,
      has_local_path: local_path !== undefined,
    },
  });
  const projectWrite = db.insert(projects).select(
    db.select({
      id: sql<string>`${projectValues.id}`.as("id"),
      userId: sql<string>`${projectValues.userId}`.as("user_id"),
      name: sql<string>`${projectValues.name}`.as("name"),
      repoUrl: sql<string | null>`${projectValues.repoUrl}`.as("repo_url"),
      defaultBranch: sql<string>`${projectValues.defaultBranch}`.as("default_branch"),
      localPath: sql<string | null>`${projectValues.localPath}`.as("local_path"),
      createdAt: sql<number>`${projectValues.createdAt}`.as("created_at"),
    })
      .from(users)
      .where(and(
        eq(users.id, user.id),
        sql`NOT EXISTS (
          SELECT 1 FROM ${accountDeletionFences}
          WHERE ${accountDeletionFences.userId} = ${user.id}
        )`,
      )),
  );
  const guardedCommandValues = {
    ...commandValues,
    action: sql<string>`CASE WHEN EXISTS (
      SELECT 1 FROM ${projects} WHERE ${projects.id} = ${projectId}
    ) THEN ${commandValues.action} ELSE NULL END`,
  };
  try {
    await db.batch([
      projectWrite,
      db.insert(projectMemberships).values(ownerMembershipValues),
      db.insert(mutationCommands).values(guardedCommandValues),
      db.insert(auditLog).values(localAudit.values),
    ] as const);
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner) return replayProjectCreateCommand(c, winner);
    const fence = (
      await db.select().from(accountDeletionFences)
        .where(eq(accountDeletionFences.userId, user.id)).limit(1)
    )[0];
    if (fence) {
      throw errors.conflict(
        "account_deletion_in_progress",
        "Account deletion fenced project creation before the project could commit.",
        "Do not create another project or switch Idempotency-Keys. Resume the existing account deletion command with its original Idempotency-Key.",
        { command_id: fence.commandId, retryable: false },
      );
    }
    throw error;
  }

  return c.json({
    ...durableResponse,
    idempotent_replay: false,
  });
});

async function replayProjectCreateCommand(
  c: Context<AppBindings>,
  command: typeof mutationCommands.$inferSelect,
) {
  return c.json({
    ...mutationResponse<Record<string, unknown>>(command),
    idempotent_replay: true,
  });
}

router.get("/", async (c) => {
  const user = c.get("user");
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      localPath: projects.localPath,
      createdAt: projects.createdAt,
      role: projectMemberships.role,
    })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(eq(projectMemberships.userId, user.id))
    .orderBy(desc(projects.createdAt));

  return c.json({
    projects: rows.map((r) => ({
      id: r.id,
      name: r.name,
      repo_url: r.repoUrl,
      default_branch: r.defaultBranch,
      local_path: r.localPath,
      created_at: r.createdAt,
      role: r.role,
    })),
    next_action:
      "Use GET /v1/projects/:id for detail, or POST /v1/projects to create another. PostHog OAuth connection state is managed separately from the Agentry project lifecycle.",
  });
});

router.get("/:id", async (c) => {
  const id = c.req.param("id");
  const proj = await requireProjectAccess(c, id);
  return c.json({
    id: proj.id,
    name: proj.name,
    repo_url: proj.repoUrl,
    default_branch: proj.defaultBranch,
    local_path: proj.localPath,
    created_at: proj.createdAt,
    next_action:
      "Continue or inspect the project's PostHog OAuth connection, then follow the current source-backed onboarding checkpoint. Agentry project lifecycle operations never provision, mutate, or delete the customer-owned PostHog project.",
  });
});

router.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const db = getDb(c.env);
  // Preserve authorization-first behavior for malformed first attempts. A
  // valid exact retry with a durable receipt can still resolve after the
  // project row has been deleted.
  if (!c.req.header("idempotency-key")?.trim()) {
    await requireProjectOwner(c, id);
  }
  // Keep this receipt actor-scoped and bind project_id in requestHash. That
  // lets the exact retry resolve after the project row is gone, while final
  // cleanup can explicitly remove every older project-scoped command.
  const identity = await mutationIdentity(c, {
    action: "project.delete",
    projectId: null,
    request: { project_id: id },
  });
  let command = await loadMutationCommand(c, identity);
  if (command?.status === "succeeded") {
    return c.json({ ...mutationResponse<Record<string, unknown>>(command), idempotent_replay: true });
  }

  let projectName: string;
  if (!command) {
    const proj = await requireProjectOwner(c, id);
    projectName = proj.name;
    const targetCount = 0;
    const progress = projectDeletionProgress({
      id,
      commandId: identity.id,
      targetCount,
      processedCount: 0,
      remaining: targetCount,
      pageDeleted: 0,
      pageAlreadyMissing: 0,
      pageFailed: 0,
      projectName,
    });
    const auditInput = projectDeletionAuditInput(user.id, id, projectName);
    const intentAudit = await prepareAuditEvent(c, auditInput, "intent");
    try {
      await db.transaction(async (tx) => {
        await tx.insert(mutationCommands).values({
          ...mutationCommandValues(identity, {
            resourceType: "project",
            resourceId: id,
            response: progress,
          }),
          status: "intent",
          targetCount,
          processedCount: 0,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        });
        await tx.insert(projectDeletionFences).values({
          projectId: id,
          commandId: identity.id,
          reason: "project_delete",
          actor: `user:${user.id}`,
        });
        await tx.insert(auditLog).values(intentAudit.values);
      });
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (!winner) {
        const fence = (
          await db.select().from(projectDeletionFences)
            .where(eq(projectDeletionFences.projectId, id)).limit(1)
        )[0];
        if (fence) {
          throw errors.conflict(
            "project_cleanup_in_progress",
            "A different durable deletion command already fenced this project.",
            "Resume the original command with its Idempotency-Key before starting another deletion.",
            { project_id: id, command_id: fence.commandId },
          );
        }
        throw error;
      }
      command = winner;
    }
    command ??= await loadMutationCommand(c, identity);
    if (!command) {
      throw errors.persistenceFailed(
        "Project deletion intent did not commit.",
        "Retry the same DELETE with the same Idempotency-Key after database health is restored.",
        { command_id: identity.id, project_id: id },
      );
    }
  } else {
    const saved = mutationResponse<Record<string, unknown>>(command);
    projectName = typeof saved.project_name === "string" ? saved.project_name : id;
  }

  const lease = await acquireDeletionCommandLease(db, command);
  if (!lease) {
    const winner = await loadDeletionCommandById(db, command.id);
    if (winner?.status === "succeeded") {
      return c.json({ ...mutationResponse<Record<string, unknown>>(winner), idempotent_replay: true });
    }
    const busy = projectDeletionBusyResponse(id, projectName, winner ?? command);
    c.header("Retry-After", String(busy.retry_after_seconds));
    return c.json(busy, 202);
  }

  const targetCount = 0;
  const processedCount = 0;

  const externalOperations = await externalMutationManifest(db, [id]);
  if (externalOperations.counts.active > 0) {
    const progress = {
      ...projectDeletionProgress({
        id,
        commandId: command.id,
        targetCount,
        processedCount,
        remaining: 0,
        pageDeleted: 0,
        pageAlreadyMissing: 0,
        pageFailed: 0,
        projectName,
        blocker: "external_provider_mutation_active",
      }),
      external_operations: externalOperations,
      active_until: externalOperations.active_until,
      retry_after_seconds: externalOperations.retry_after_seconds,
    };
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: {
        code: "external_provider_mutation_active",
        active_until: externalOperations.active_until,
        retry_after_seconds: externalOperations.retry_after_seconds,
      },
    });
    c.header("Retry-After", String(externalOperations.retry_after_seconds));
    return c.json(progress, 202);
  }

  const webhookDrain = await webhookDeliveryDrainState(db, [id]);
  if (!webhookDrain.drained) {
    const progress = {
      ...projectDeletionProgress({
        id,
        commandId: command.id,
        targetCount,
        processedCount,
        remaining: 0,
        pageDeleted: 0,
        pageAlreadyMissing: 0,
        pageFailed: 0,
        projectName,
        blocker: "external_webhook_drain_active",
      }),
      webhook_delivery_drain: webhookDrain,
      active_until: webhookDrain.active_until,
      retry_after_seconds: webhookDrain.retry_after_seconds,
    };
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: {
        code: "external_webhook_drain_active",
        active_until: webhookDrain.active_until,
        retry_after_seconds: webhookDrain.retry_after_seconds,
      },
    });
    c.header("Retry-After", String(webhookDrain.retry_after_seconds));
    return c.json(progress, 202);
  }

  const genericFollowUpRequired =
    externalOperations.counts.retained_external_state > 0 ||
    externalOperations.counts.external_state_unknown > 0;
  const webhookFollowUpRequired = webhookDrain.external_follow_up.required;
  const automationManifest = await automationDeletionManifest(db, [id]);

  const response = {
    id,
    command_id: command.id,
    status: "succeeded",
    deleted: true,
    project_name: projectName,
    cleanup: {
      webhook_delivery_drain: webhookDrain,
      automation_deletion_manifest: automationManifest,
      customer_posthog_data_affected: false,
      external_operations: externalOperations,
    },
    idempotent_replay: false,
    next_action:
      genericFollowUpRequired || webhookFollowUpRequired || automationManifest.external_follow_up.required
        ? "The Agentry project and its local connection metadata are deleted. Customer-owned PostHog data is untouched. Reconcile only the explicitly listed webhook, scheduler, repository, or other external-operation entries."
        : "The Agentry project and its local connection metadata are deleted. Customer-owned PostHog data is untouched; remove any obsolete Agentry CI and runner credentials from external environments.",
  };
  const auditInput = projectDeletionAuditInput(user.id, id, projectName);
  const intentAudit = await prepareAuditEvent(c, auditInput, "intent");
  const completedAudit = await prepareAuditEvent(c, {
    ...auditInput,
    projectId: null,
    summary: `Deleted project ${projectName}`,
    metadata: {
      project_id: id,
      project_name: projectName,
      customer_posthog_data_affected: false,
      external_operation_counts: externalOperations.counts,
      external_operation_sample_truncated: externalOperations.operations_truncated,
      webhook_known_delivered_after_fence_count:
        webhookDrain.known_delivered_after_fence_count,
      webhook_unknown_outcome_count: webhookDrain.unknown_outcome_count,
      automation_deletion_counts: automationManifest.counts,
    },
  }, "succeeded", {
    operationId: intentAudit.receipt.operationId,
    requestHash: intentAudit.receipt.requestHash,
    input: auditInput,
  });

  try {
    await finalizeProjectDeletion(
      db,
      lease,
      id,
      response,
      completedAudit.values,
      automationManifest,
    );
  } catch (error) {
    const terminalAuditById = (
      await db.select({ id: auditLog.id }).from(auditLog)
        .where(eq(auditLog.id, completedAudit.receipt.id)).limit(1)
    )[0];
    const terminalAuditByOperation = terminalAuditById
      ? null
      : (
          await db.select({ id: auditLog.id }).from(auditLog).where(and(
            eq(auditLog.operationId, completedAudit.receipt.operationId),
            eq(auditLog.phase, "succeeded"),
          )).limit(1)
        )[0];
    const conflictingTerminalAudit = terminalAuditById ?? terminalAuditByOperation;
    if (conflictingTerminalAudit) {
      const conflictResponse = {
        id,
        command_id: command.id,
        status: "blocked_integrity",
        deleted: false,
        retryable: false,
        operator_remediation_required: true,
        cleanup: { blocker: "terminal_audit_conflict" },
        next_action:
          "Stop retrying this deletion. An operator must compare the immutable audit row with the project-deletion command and restore canonical terminal evidence without deleting the project manually.",
      };
      await releaseDeletionCommandLease(db, lease, {
        targetCount,
        processedCount,
        response: conflictResponse,
        error: {
          code: "project_deletion_terminal_audit_conflict",
          retryable: false,
          operator_remediation_required: true,
          audit_id: conflictingTerminalAudit.id,
        },
      });
      throw errors.conflict(
        "project_deletion_terminal_audit_conflict",
        "Project deletion was rolled back because immutable terminal audit evidence conflicts with this exact command.",
        conflictResponse.next_action,
        {
          project_id: id,
          command_id: command.id,
          expected_audit_id: completedAudit.receipt.id,
          conflicting_audit_id: conflictingTerminalAudit.id,
          retryable: false,
          operator_remediation_required: true,
          project_preserved: true,
        },
      );
    }
    const progress = projectDeletionProgress({
      id,
      commandId: command.id,
      targetCount,
      processedCount,
      remaining: 0,
      pageDeleted: 0,
      pageAlreadyMissing: 0,
      pageFailed: 0,
      projectName,
      blocker: "local_finalize_incomplete",
    });
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: { code: "local_finalize_incomplete" },
    }).catch(() => null);
    const winner = await loadDeletionCommandById(db, command.id);
    if (winner?.status === "succeeded") {
      return c.json({ ...mutationResponse<Record<string, unknown>>(winner), idempotent_replay: true });
    }
    c.header("Retry-After", String(progress.retry_after_seconds));
    return c.json(progress, 202);
  }

  invalidateProjectAccessCache(id);
  return c.json(response);
});

function projectDeletionAuditInput(
  userId: string,
  projectId: string,
  projectName: string,
): AuditInput {
  return {
    userId,
    projectId,
    action: "project.deleted",
    resourceType: "project",
    resourceId: projectId,
    summary: `Delete project ${projectName}`,
    metadata: {
      project_name: projectName,
    },
  };
}

function projectDeletionProgress(input: {
  id: string;
  commandId: string;
  targetCount: number;
  processedCount: number;
  remaining: number;
  pageDeleted: number;
  pageAlreadyMissing: number;
  pageFailed: number;
  projectName: string;
  blocker?: string;
}) {
  return {
    id: input.id,
    command_id: input.commandId,
    status: "in_progress",
    deleted: false,
    project_name: input.projectName,
    cleanup: {
      targeted: input.targetCount,
      processed: input.processedCount,
      remaining: input.remaining,
      page: {
        deleted: input.pageDeleted,
        already_missing: input.pageAlreadyMissing,
        failed: input.pageFailed,
      },
      blocker: input.blocker ?? null,
    },
    retry_after_seconds: 1,
    idempotent_replay: false,
    next_action: input.blocker === "external_provider_mutation_active"
          ? "A provider mutation reserved durable intent before deletion fenced the project and may still be in flight. Retry this exact DELETE with the same Idempotency-Key after retry_after_seconds; do not call the provider or start another deletion command."
        : input.blocker === "external_webhook_drain_active"
          ? "A webhook POST passed its final authority check before deletion fenced the project. Retry this exact DELETE with the same Idempotency-Key after retry_after_seconds; the bounded request is aborted by then and no new delivery can start."
        : "Retry this exact DELETE with the same Idempotency-Key to resume local cleanup.",
  };
}

function projectDeletionBusyResponse(
  id: string,
  projectName: string,
  command: DurableDeletionCommand,
) {
  const remaining = Math.max(0, command.targetCount - command.processedCount);
  const leaseExpiresAt = command.leaseExpiresAt;
  const retryAfterSeconds = leaseExpiresAt === null
    ? 1
    : Math.max(1, leaseExpiresAt - Math.floor(Date.now() / 1_000));
  return {
    ...projectDeletionProgress({
      id,
      commandId: command.id,
      targetCount: command.targetCount,
      processedCount: command.processedCount,
      remaining,
      pageDeleted: 0,
      pageAlreadyMissing: 0,
      pageFailed: 0,
      projectName,
      blocker: "command_lease_busy",
    }),
    lease_expires_at: leaseExpiresAt,
    retry_after_seconds: retryAfterSeconds,
    next_action:
      `Another exact request owns this deletion lease. Retry the same DELETE with the same Idempotency-Key after ${retryAfterSeconds} seconds, or sooner only after a terminal response. Do not start a new command.`,
  };
}

async function finalizeProjectDeletion(
  db: ReturnType<typeof getDb>,
  lease: DurableDeletionLease,
  projectId: string,
  response: Record<string, unknown>,
  auditValues: typeof auditLog.$inferInsert,
  expectedAutomationManifest?: AutomationDeletionManifest,
): Promise<void> {
  await db.transaction(async (tx) => {
    const externalOperations = await externalMutationManifest(tx as unknown as ReturnType<typeof getDb>, [projectId]);
    if (externalOperations.counts.active > 0) {
      throw new Error("generic provider operation remains active");
    }
    const webhookDrain = await webhookDeliveryDrainState(
      tx as unknown as ReturnType<typeof getDb>,
      [projectId],
    );
    if (!webhookDrain.drained) throw new Error("external webhook drain remains active");
    if (expectedAutomationManifest) {
      const currentAutomationManifest = await automationDeletionManifest(
        tx as unknown as ReturnType<typeof getDb>,
        [projectId],
      );
      if (
        automationDeletionEvidence(currentAutomationManifest) !==
        automationDeletionEvidence(expectedAutomationManifest)
      ) throw new Error("automation deletion manifest changed before cascade");
    }

    await deleteAutomationWorkflowStateForProjects(
      tx as unknown as ReturnType<typeof getDb>,
      [projectId],
    );
    await tx.delete(projectDeletionFences).where(and(
      eq(projectDeletionFences.projectId, projectId),
      eq(projectDeletionFences.commandId, lease.command.id),
    ));
    // mutation_commands has intentionally non-FK scope columns. Remove every
    // older project-scoped receipt only after external inventory is terminal;
    // this deletion receipt is actor-scoped and survives for exact replay.
    await tx.delete(mutationCommands).where(eq(mutationCommands.projectId, projectId));
    const deleted = await tx.delete(projects).where(eq(projects.id, projectId))
      .returning({ id: projects.id });
    if (deleted.length !== 1) throw new Error("project delete CAS lost");
    const completed = await tx.update(mutationCommands).set({
      status: "succeeded",
      responseJson: canonicalJsonStringify(response),
      errorJson: null,
      targetCount: lease.command.targetCount,
      processedCount: lease.command.targetCount,
      leaseToken: null,
      leaseExpiresAt: null,
      version: lease.command.version + 1,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(mutationCommands.id, lease.command.id),
      eq(mutationCommands.version, lease.command.version),
      eq(mutationCommands.leaseToken, lease.token),
      ne(mutationCommands.status, "succeeded"),
    )).returning({ id: mutationCommands.id });
    if (completed.length !== 1) throw new Error("project deletion command CAS lost");
    // The terminal deletion receipt is part of the same atomic settlement as
    // the cascade and command completion. A conflicting deterministic audit
    // id must roll the whole transaction back; silently accepting it would
    // delete the project without its canonical immutable evidence.
    await tx.insert(auditLog).values(auditValues);
  });
}

function automationDeletionEvidence(manifest: AutomationDeletionManifest): string {
  return canonicalJsonStringify({
    project_ids: manifest.project_ids,
    counts: manifest.counts,
    samples: manifest.samples,
    samples_truncated: manifest.samples_truncated,
    external_follow_up: manifest.external_follow_up,
  });
}

router.get("/:id/signal-map", async (c) => {
  const proj = await requireProjectAccess(c, c.req.param("id"));
  const db = getDb(c.env);
  const state = await loadOnboardingV3State(db, proj.id);
  if (!state || state.status === "planned") throw missingInstallArtifact(proj.id);
  c.header("ETag", state.etag);
  c.header("Cache-Control", "no-store");
  return c.json(publicSignalMapProjection(state));
});

router.get("/:id/setup", async (c) => {
  const proj = await requireProjectAccess(c, c.req.param("id"));
  return c.json({
    schema_version: 3,
    project_id: proj.id,
    principle:
      "Product telemetry stays in the customer-owned PostHog Cloud project. Agentry stores an encrypted read-only OAuth grant; only CI deploys, one automation runner, and human owner operations use Agentry credentials.",
    posthog_connection: {
      endpoint: `/v1/projects/${proj.id}/posthog-connection`,
      ownership: "customer_owned",
      access: "oauth_read_only",
      regions: ["us", "eu"],
      next_action:
        "Use the CLI connection checkpoint to authorize PostHog and select one exact environment. Never copy a PostHog personal key into the repository.",
    },
    env_matrix: [
      {
        token_kind: "ci_deploy_key",
        env_var: "AGENTRY_CI_API_KEY",
        required: false,
        secret_level: "project_secret",
        token_prefix: "agentry_ci_",
        allowed_contexts: ["ci_deploy"],
        commit_to_git: false,
        browser_safe: false,
        host_or_ci_placement:
          "Create kind=ci_deploy at POST /v1/projects/:project_id/credentials and store it only in the successful post-deploy job/provider hook.",
        verify_endpoint: `/v1/projects/${proj.id}/deploys`,
        rotate_endpoint: `/v1/projects/${proj.id}/credentials`,
        notes: "Accepted only for deploy attribution and automation PR proof. It cannot read PostHog, run agents, or make owner decisions.",
      },
      {
        token_kind: "automation_runner_key",
        env_var: "AGENTRY_RUNNER_API_KEY",
        required: false,
        secret_level: "project_secret",
        token_prefix: "agentry_runner_",
        allowed_contexts: ["codex_cli_scheduler", "claude_code_scheduler", "github_actions_workflow", "custom_scheduler"],
        commit_to_git: false,
        browser_safe: false,
        host_or_ci_placement:
          "After saving the contract, create kind=automation_runner bound to one automation_id and store it only in the selected executable handoff. ChatGPT Scheduled tasks are advisory-only because no per-task secret-injection contract is documented.",
        verify_endpoint: `/v1/projects/${proj.id}/automation-runs`,
        rotate_endpoint: `/v1/projects/${proj.id}/credentials`,
        notes: "Can issue/read server trigger receipts, claim cases, report bounded run usage/evidence, request approvals, and consume one-time action grants for one automation. It cannot author trigger facts, mutate policy, approve itself, attest CI proof, verify itself, merge, deploy, or use generic case status PATCH.",
      },
      {
        token_kind: "owner_api_key",
        env_var: "AGENTRY_PRIVATE_API_KEY",
        required: false,
        secret_level: "owner_private_key",
        token_prefix: "agentry_sk_",
        allowed_contexts: ["agent_local", "human_management"],
        commit_to_git: false,
        browser_safe: false,
        host_or_ci_placement:
          "Use locally for owner reads and mutations, approval decisions, PostHog OAuth lifecycle, and public-query publishing. Never install it in an unattended runner or deploy job.",
        verify_endpoint: "/v1/me",
        rotate_endpoint: "/v1/auth/keys/rotate",
        notes: "Never expose this in browser bundles or public dashboards.",
      },
      {
        token_kind: "api_base_url",
        env_var: "AGENTRY_URL",
        required: false,
        default: "https://api.agentry.sh",
        secret_level: "none",
        allowed_contexts: ["agent_local", "ci_admin", "automation_runner"],
        commit_to_git: false,
        browser_safe: true,
        host_or_ci_placement: "Leave unset for hosted Agentry. Set only for self-hosted or local API development.",
        verify_endpoint: "/",
        rotate_endpoint: null,
      },
      {
        token_kind: "deploy_sha",
        env_var: "AGENTRY_DEPLOY_SHA",
        required: false,
        secret_level: "none",
        allowed_contexts: ["ci_deploy"],
        commit_to_git: false,
        browser_safe: true,
        host_or_ci_placement:
          "Use when the host does not provide a git SHA env var. Agentry also accepts common provider aliases.",
        verify_endpoint: `/v1/projects/${proj.id}/deploys`,
        rotate_endpoint: null,
      },
      {
        token_kind: "environment_label",
        env_var: "AGENTRY_ENVIRONMENT",
        required: false,
        default: "production",
        secret_level: "none",
        allowed_contexts: ["ci_deploy"],
        commit_to_git: false,
        browser_safe: true,
        host_or_ci_placement: "Set per host environment when staging/preview/prod need separate labels.",
        verify_endpoint: `/v1/projects/${proj.id}/deploys`,
        rotate_endpoint: null,
      },
    ],
    public_queries: {
      token_kind: "published_public_query_url",
      token_prefix: "/v1/public/q/",
      default_agent_behavior:
        "Publish a query and embed or return the full public URL (unguessable by design). It is the complete visitor capability; do not add or store a second query key.",
    },
    next_action:
      "Connect PostHog, review existing telemetry and source coverage, then create only the CI and runner credentials required by the approved automation contract.",
  });
});

router.get("/:id/automation-contract", async (c) => {
  const proj = await requireProjectAccess(c, c.req.param("id"));
  const loaded = await loadAutomationContract(getDb(c.env), proj.id);
  if (!loaded) throw errors.notFound("automation_contract");
  c.header("etag", loaded.row.etag);
  return c.json({
    artifact: "automation_contract",
    project_id: proj.id,
    ...loaded.contract,
    etag: loaded.row.etag,
    paused_at: loaded.row.pausedAt,
    pause_reason: loaded.row.pauseReason,
    created_at: loaded.row.createdAt,
    updated_at: loaded.row.updatedAt,
    next_action:
      loaded.row.enabled === 1
        ? "The contract is enabled. Runners must request server-issued trigger receipts, consume each receipt once through its claim/run chain, obey the immutable run policy, and stop when a kill switch, lease, deadline, or budget blocks progress."
        : "The contract is disabled. Review validation, then enable it explicitly with If-Match: <etag>; saving a contract never enables unattended work.",
  });
});

router.post("/:id/automation-contract/validate", async (c) => {
  const proj = await requireProjectAccess(c, c.req.param("id"));
  const body = await readAutomationContractBody(c);
  const validation = await validateAutomationContractForProject(c, proj, body);
  return c.json({
    ...validation,
    next_action: validation.valid
      ? "Validation passed. A project owner can PUT this contract; it will save disabled and require a separate explicit enable call."
      : "Fix every issue, then validate again. Do not save or run a partially valid contract.",
  });
});

router.put("/:id/automation-contract", async (c) => {
  const proj = await requireProjectOwner(c, c.req.param("id"));
  const db = getDb(c.env);
  await assertAutomationWritesOpen(db, proj.id);
  const body = await readAutomationContractBody(c);
  const validation = await validateAutomationContractForProject(c, proj, body);
  if (!validation.valid || !validation.contract) {
    throw errors.invalidPayload({
      reason: "automation contract validation failed",
      issues: validation.issues,
    });
  }
  // Read the physical row, not only a successfully parsed contract. This lets
  // an owner repair a corrupt/inconsistent document through the canonical PUT
  // path instead of hitting a primary-key conflict with no recovery route.
  const existingRow = (
    await db
      .select()
      .from(automationContracts)
      .where(eq(automationContracts.projectId, proj.id))
      .limit(1)
  )[0] ?? null;
  if (existingRow) requireMatchingEtag(c.req.header("if-match"), existingRow.etag);
  if (validation.contract.enabled) {
    throw errors.invalidPayload({
      reason: "PUT saves automation contracts disabled; set enabled=false, then use the explicit enable operation after reviewing validation",
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const revision = (existingRow?.revision ?? 0) + 1;
  const contract: AutomationContract = {
    ...validation.contract,
    schema_version: "2",
    revision,
    enabled: false,
  };
  const etag = await automationContractEtag(contract);
  const automationIds = contract.automations.map((automation) => automation.id);
  if (existingRow) {
    const updated = await db
      .update(automationContracts)
      .set({
        schemaVersion: contract.schema_version,
        revision,
        enabled: 0,
        etag,
        documentJson: JSON.stringify(contract),
        updatedBy: c.get("user").id,
        updatedAt: now,
        pausedAt: now,
        pauseReason: "contract_updated_requires_explicit_enable",
      })
      .where(
        and(
          eq(automationContracts.projectId, proj.id),
          eq(automationContracts.etag, existingRow.etag),
          noWorkflowV3IdCollision(proj.id, automationIds),
          automationWritesOpenForProject(automationContracts.projectId),
        ),
      )
      .returning({ projectId: automationContracts.projectId });
    if (updated.length === 0) {
      await throwIfWorkflowV3IdCollision(db, proj.id, automationIds);
      throwAutomationContractChanged(existingRow.etag);
    }
  } else {
    try {
      await db.run(sql`
        INSERT INTO ${automationContracts} (
          project_id, schema_version, revision, enabled, etag, document_json,
          created_by, updated_by, created_at, updated_at, paused_at, pause_reason
        )
        SELECT ${proj.id}, ${contract.schema_version}, ${revision}, 0, ${etag},
          ${JSON.stringify(contract)}, ${c.get("user").id}, ${c.get("user").id},
          ${now}, ${now}, ${now}, 'contract_saved_requires_explicit_enable'
        WHERE ${automationWritesOpenForProject(proj.id)}
          AND ${noWorkflowV3IdCollision(proj.id, automationIds)}
          AND EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${proj.id})
        ON CONFLICT(project_id) DO NOTHING
      `);
      const inserted = (
        await db.select({ etag: automationContracts.etag })
          .from(automationContracts)
          .where(eq(automationContracts.projectId, proj.id))
          .limit(1)
      )[0];
      if (!inserted || inserted.etag !== etag) {
        await assertAutomationWritesOpen(db, proj.id);
        await throwIfWorkflowV3IdCollision(db, proj.id, automationIds);
        throwAutomationContractChanged(inserted?.etag ?? "missing");
      }
    } catch (error) {
      await assertAutomationWritesOpen(db, proj.id);
      await throwIfWorkflowV3IdCollision(db, proj.id, automationIds);
      const current = (
        await db
          .select({ etag: automationContracts.etag })
          .from(automationContracts)
          .where(eq(automationContracts.projectId, proj.id))
          .limit(1)
      )[0];
      if (current) throwAutomationContractChanged(current.etag);
      throw error;
    }
  }
  c.header("etag", etag);
  return c.json({
    artifact: "automation_contract",
    project_id: proj.id,
    ...contract,
    etag,
    validation: { valid: true, warnings: validation.warnings },
    next_action:
      "Contract saved disabled. Review the normalized contract and warnings, then POST /v1/projects/:id/automation-contract/enable with If-Match: <etag> when unattended execution is authorized.",
  });
});

router.post("/:id/automation-contract/enable", async (c) => {
  const proj = await requireProjectOwner(c, c.req.param("id"));
  await requireNerveForProject(c.env, proj.id);
  const db = getDb(c.env);
  await assertAutomationWritesOpen(db, proj.id);
  const loaded = await loadAutomationContract(db, proj.id);
  if (!loaded) throw errors.notFound("automation_contract");
  requireMatchingEtag(c.req.header("if-match"), loaded.row.etag);
  const validation = await validateAutomationContractForProject(c, proj, {
    ...loaded.contract,
    enabled: false,
  }, { requireExecutionReadiness: true });
  if (!validation.valid || !validation.contract) {
    throw errors.conflict(
      "automation_contract_stale",
      "The saved automation contract no longer validates against current alerts, blueprints, or project metadata.",
      "Fix the reported issues with PUT, then enable the new ETag.",
      { issues: validation.issues },
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const contract = {
    ...validation.contract,
    enabled: true,
    revision: loaded.row.revision + 1,
  };
  const etag = await automationContractEtag(contract);
  const updated = await db
    .update(automationContracts)
    .set({
      revision: contract.revision,
      enabled: 1,
      etag,
      documentJson: JSON.stringify(contract),
      updatedBy: c.get("user").id,
      updatedAt: now,
      pausedAt: null,
      pauseReason: null,
    })
    .where(
      and(
        eq(automationContracts.projectId, proj.id),
        eq(automationContracts.etag, loaded.row.etag),
        automationWritesOpenForProject(automationContracts.projectId),
      ),
    )
    .returning({ projectId: automationContracts.projectId });
  if (updated.length === 0) throwAutomationContractChanged(loaded.row.etag);
  c.header("etag", etag);
  return c.json({
    project_id: proj.id,
    enabled: true,
    revision: contract.revision,
    etag,
    next_action: "Contract enabled. Runners may claim eligible cases and create runs; monitor budgets, pending approvals, and failed runs.",
  });
});

router.post("/:id/automation-contract/pause", async (c) => {
  const proj = await requireProjectOwner(c, c.req.param("id"));
  const body = await readObjectBody(c);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2_000) : "";
  if (!reason) throw errors.invalidPayload({ reason: "pause requires a non-empty reason" });
  const db = getDb(c.env);
  await assertAutomationWritesOpen(db, proj.id);
  let loaded = await loadAutomationContract(db, proj.id);
  if (!loaded) throw errors.notFound("automation_contract");
  // Emergency pause intentionally needs no caller-supplied ETag. Retry a
  // concurrent policy edit so the kill switch wins without overwriting it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Math.floor(Date.now() / 1000);
    const contract = { ...loaded.contract, enabled: false, revision: loaded.row.revision + 1 };
    const etag = await automationContractEtag(contract);
    const updated = await db
      .update(automationContracts)
      .set({
        revision: contract.revision,
        enabled: 0,
        etag,
        documentJson: JSON.stringify(contract),
        updatedBy: c.get("user").id,
        updatedAt: now,
        pausedAt: now,
        pauseReason: reason,
      })
      .where(
        and(
          eq(automationContracts.projectId, proj.id),
          eq(automationContracts.etag, loaded.row.etag),
          automationWritesOpenForProject(automationContracts.projectId),
        ),
      )
      .returning({ projectId: automationContracts.projectId });
    if (updated.length > 0) {
      c.header("etag", etag);
      return c.json({
        project_id: proj.id,
        enabled: false,
        paused_at: now,
        pause_reason: reason,
        revision: contract.revision,
        etag,
        next_action: "Kill switch is active. New claims/runs and non-terminal run transitions are blocked; active runners will also be stopped on lease renewal.",
      });
    }
    loaded = await loadAutomationContract(db, proj.id);
    if (!loaded) throw errors.notFound("automation_contract");
  }
  throw errors.conflict(
    "automation_pause_contention",
    "The contract kept changing while the emergency pause was being applied.",
    "Retry the pause immediately; runners remain subject to lease expiry and current policy until it succeeds.",
  );
});

router.patch("/:id/automation-contract/automations/:automation_id", async (c) => {
  const proj = await requireProjectOwner(c, c.req.param("id"));
  const body = await readObjectBody(c);
  if (typeof body.enabled !== "boolean") {
    throw errors.invalidPayload({ reason: "enabled boolean is required" });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2_000) : "";
  if (!reason) throw errors.invalidPayload({ reason: "reason is required" });
  if (body.enabled === true) await requireNerveForProject(c.env, proj.id);
  const db = getDb(c.env);
  await assertAutomationWritesOpen(db, proj.id);
  const loaded = await loadAutomationContract(db, proj.id);
  if (!loaded) throw errors.notFound("automation_contract");
  requireMatchingEtag(c.req.header("if-match"), loaded.row.etag);
  const automationId = c.req.param("automation_id");
  const index = loaded.contract.automations.findIndex((automation) => automation.id === automationId);
  if (index < 0) throw errors.notFound("automation");
  const automations = loaded.contract.automations.map((automation, automationIndex) =>
    automationIndex === index ? { ...automation, enabled: body.enabled as boolean } : automation
  );
  const contract = {
    ...loaded.contract,
    automations,
    revision: loaded.row.revision + 1,
    notes: [...loaded.contract.notes, `${automationId} ${body.enabled ? "enabled" : "paused"}: ${reason}`].slice(-20),
  };
  const etag = await automationContractEtag(contract);
  const now = Math.floor(Date.now() / 1000);
  const updated = await db
    .update(automationContracts)
    .set({
      revision: contract.revision,
      etag,
      documentJson: JSON.stringify(contract),
      updatedBy: c.get("user").id,
      updatedAt: now,
    })
    .where(
      and(
        eq(automationContracts.projectId, proj.id),
        eq(automationContracts.etag, loaded.row.etag),
        automationWritesOpenForProject(automationContracts.projectId),
      ),
    )
    .returning({ projectId: automationContracts.projectId });
  if (updated.length === 0) throwAutomationContractChanged(loaded.row.etag);
  c.header("etag", etag);
  return c.json({
    project_id: proj.id,
    automation_id: automationId,
    enabled: body.enabled,
    revision: contract.revision,
    etag,
    next_action: body.enabled
      ? "Automation enabled within the current global contract state."
      : "Automation-specific kill switch is active; its runners may only fail, escalate, or cancel.",
  });
});

type ContractValidationIssue = { code: string; path: string; message: string };

function isAutomationSafeReportBlueprint(
  blueprint: NonNullable<ReturnType<typeof getQueryBlueprint>>,
): boolean {
  const readiness = blueprint.automation_readiness;
  const hasScalarEventParams = Array.isArray(blueprint.required_event_params) &&
    blueprint.required_event_params.length > 0;
  const hasEventListParam = typeof blueprint.required_event_list_param === "string" &&
    blueprint.required_event_list_param.length > 0;
  return (
    blueprint.strict_params === true &&
    hasScalarEventParams !== hasEventListParam &&
    readiness?.kind === "all_rows_boolean" &&
    Number.isSafeInteger(readiness.expected_rows) &&
    readiness.expected_rows > 0 &&
    readiness.expected_rows <= 100 &&
    readiness.row_identity.values.length === readiness.expected_rows &&
    blueprint.expected_columns.includes(readiness.column) &&
    blueprint.expected_columns.includes(readiness.row_identity.column) &&
    blueprint.publication_safety.output_granularity === "aggregate" &&
    blueprint.publication_safety.identifier_columns.length === 0 &&
    !blueprint.publication_safety.accepts_arbitrary_segment_property &&
    blueprint.expected_columns.every((column) => {
      const normalized = column.toLowerCase();
      return !(
        normalized === "id" ||
        normalized === "email" ||
        normalized.endsWith("_id") ||
        normalized.endsWith("_email") ||
        normalized.endsWith("_phone") ||
        normalized.endsWith("_ip") ||
        normalized.includes("token") ||
        normalized.includes("secret") ||
        normalized.includes("password") ||
        normalized.includes("credential")
      );
    })
  );
}

async function validateAutomationContractForProject(
  c: Context<AppBindings>,
  proj: typeof projects.$inferSelect,
  body: unknown,
  options: { requireExecutionReadiness?: boolean } = {},
): Promise<{
  valid: boolean;
  contract: AutomationContract | null;
  issues: ContractValidationIssue[];
  warnings: ContractValidationIssue[];
}> {
  const parsed = AutomationContractSchema.safeParse(body);
  if (!parsed.success) {
    return {
      valid: false,
      contract: null,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        path: issue.path.join("."),
        message: issue.message,
      })),
      warnings: [],
    };
  }
  const issues: ContractValidationIssue[] = [];
  const warnings: ContractValidationIssue[] = [];
  const db = getDb(c.env);
  const reservedWorkflowV3Ids = new Set(
    (await db.select({ automationId: automationWorkflows.automationId })
      .from(automationWorkflows)
      .where(eq(automationWorkflows.projectId, proj.id)))
      .map((workflow) => workflow.automationId),
  );
  const knownAlerts = new Set(
    (await db.select({ id: alerts.id }).from(alerts).where(eq(alerts.projectId, proj.id)))
      .map((alert) => alert.id),
  );
  for (const automation of parsed.data.automations) {
    const base = `automations.${automation.id}`;
    if (reservedWorkflowV3Ids.has(automation.id)) {
      issues.push({
        code: "automation_id_namespace_conflict",
        path: `${base}.id`,
        message:
          "This id already belongs to a saved workflow-v3 definition. Automation v2 and workflow v3 cannot share an id because they are separate execution generations with no implicit migration bridge.",
      });
    }
    if (automation.trigger.kind === "alert" && !knownAlerts.has(automation.trigger.alert_id)) {
      issues.push({
        code: "alert_not_found",
        path: `${base}.trigger.alert_id`,
        message: `Alert ${automation.trigger.alert_id} does not exist in this project.`,
      });
    }
    if (automation.trigger.kind === "schedule") {
      const unsafeActions = automation.allowed_actions.filter((action) =>
        action !== "record_report" && action !== "escalate"
      );
      if (unsafeActions.length > 0) {
        issues.push({
          code: "scheduled_action_not_allowed",
          path: `${base}.allowed_actions`,
          message: `Scheduled reports cannot request ${unsafeActions.join(", ")}.`,
        });
      }
    }
    if (automation.allowed_actions.includes("draft_pr") && !proj.repoUrl) {
      issues.push({
        code: "repository_required",
        path: `${base}.runner.repository`,
        message: "Code-changing automations require a repository bound to the Agentry project.",
      });
    } else if (
      automation.runner.repository &&
      proj.repoUrl &&
      normalizeRepo(proj.repoUrl) !== normalizeRepo(automation.runner.repository)
    ) {
      issues.push({
        code: "repository_mismatch",
        path: `${base}.runner.repository`,
        message: "Runner repository must match the project repository.",
      });
    }
    if (
      automation.runner.default_branch &&
      automation.runner.default_branch !== proj.defaultBranch
    ) {
      issues.push({
        code: "default_branch_mismatch",
        path: `${base}.runner.default_branch`,
        message: `Runner default branch must be ${proj.defaultBranch}.`,
      });
    }
    if (automation.budgets.max_prs_per_day > automation.budgets.max_runs_per_day) {
      issues.push({
        code: "budget_inconsistent",
        path: `${base}.budgets.max_prs_per_day`,
        message: "max_prs_per_day cannot exceed max_runs_per_day.",
      });
    }
    if (automation.report_plan) {
      const reportBlueprint = getQueryBlueprint(automation.report_plan.blueprint_id);
      if (!reportBlueprint) {
        issues.push({
          code: "report_blueprint_not_found",
          path: `${base}.report_plan.blueprint_id`,
          message: `Query blueprint ${automation.report_plan.blueprint_id} does not exist.`,
        });
      } else if (!isAutomationSafeReportBlueprint(reportBlueprint)) {
        issues.push({
          code: "report_blueprint_not_automation_safe",
          path: `${base}.report_plan.blueprint_id`,
          message:
            "Scheduled reports require an aggregate-only strict blueprint with explicit event-input and output-readiness metadata.",
        });
      } else {
        const paramNames = reportBlueprint.params.map((param) => param.name).sort();
        const savedParamNames = Object.keys(automation.report_plan.params).sort();
        if (
          paramNames.length !== savedParamNames.length ||
          paramNames.some((name, index) => name !== savedParamNames[index])
        ) {
          issues.push({
            code: "report_blueprint_params_invalid",
            path: `${base}.report_plan.params`,
            message:
              `Scheduled reports must lock every blueprint param and no unknown params. Expected: ${paramNames.join(", ")}.`,
          });
        } else {
          const validationAnchor = Math.floor(
            Date.parse("2026-07-13T00:00:00.000Z") / 1_000,
          );
          const validationEnd =
            validationAnchor - automation.report_plan.period.offset_seconds;
          const validationStart =
            validationEnd - automation.report_plan.period.lookback_seconds;
          const validationValues = {
            scheduled_for: new Date(validationAnchor * 1_000).toISOString(),
            period_start: new Date(validationStart * 1_000).toISOString(),
            period_end: new Date(validationEnd * 1_000).toISOString(),
            previous_period_start: new Date(
              (validationStart - automation.report_plan.period.lookback_seconds) * 1_000,
            ).toISOString(),
            previous_period_end: new Date(validationStart * 1_000).toISOString(),
          } as const;
          const validationParams = Object.fromEntries(
            Object.entries(automation.report_plan.params).map(([key, value]) => [
              key,
              value && typeof value === "object" && !Array.isArray(value)
                ? validationValues[value.field]
                : value,
            ]),
          );
          let prepared: ReturnType<typeof prepareQueryBlueprintExecution> | null = null;
          try {
            prepared = prepareQueryBlueprintExecution(reportBlueprint, validationParams);
            if (
              reportBlueprint.id === "ordered_funnel_period_compare" &&
              (
                typeof prepared.params.period_days !== "number" ||
                prepared.params.period_days * 86_400 !==
                  automation.report_plan.period.lookback_seconds
              )
            ) {
              throw new Error(
                "period_days must exactly match report_plan.period.lookback_seconds",
              );
            }
          } catch (error) {
            issues.push({
              code: "report_blueprint_params_invalid",
              path: `${base}.report_plan.params`,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          if (prepared) {
            try {
              await assertQueryBlueprintInputReadiness(
                db,
                proj.id,
                reportBlueprint,
                prepared.params,
              );
            } catch (error) {
              const finding = {
                code: "report_blueprint_not_ready",
                path: `${base}.report_plan`,
                message: error instanceof Error ? error.message : String(error),
              };
              (options.requireExecutionReadiness ? issues : warnings).push(finding);
            }
          }
        }
      }
    }
    if (automation.verification) {
      const verificationPlans = [
        ["outcome", automation.verification.outcome] as const,
        ["sample", automation.verification.sample] as const,
      ];
      for (const [kind, plan] of verificationPlans) {
        const blueprint = getQueryBlueprint(plan.blueprint_id);
        if (!blueprint) {
          issues.push({
            code: "blueprint_not_found",
            path: `${base}.verification.${kind}.blueprint_id`,
            message: `Query blueprint ${plan.blueprint_id} does not exist.`,
          });
          continue;
        }
        let prepared: ReturnType<typeof prepareQueryBlueprintExecution> | null = null;
        try {
          const validationParams = Object.fromEntries(
            Object.entries(plan.params).map(([key, value]) => {
              if (!value || typeof value !== "object" || Array.isArray(value)) {
                return [key, value];
              }
              const field = value.field;
              if (field === "case_revision") return [key, 1];
              if (field === "deploy_received_at") return [key, "2026-01-01T00:00:00.000Z"];
              if (field === "verification_checked_at") return [key, "2026-01-01T01:00:00.000Z"];
              if (field === "deploy_sha") return [key, "abcdef0123456789"];
              return [key, `validation-${field}`];
            }),
          );
          prepared = prepareQueryBlueprintExecution(blueprint, validationParams);
        } catch (error) {
          issues.push({
            code: "blueprint_params_invalid",
            path: `${base}.verification.${kind}.params`,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (kind === "sample" && prepared) {
          try {
            await assertQueryBlueprintInputReadiness(
              db,
              proj.id,
              blueprint,
              prepared.params,
              { requireTrustedDeploy: false },
            );
          } catch (error) {
            const finding = {
              code: "verification_sample_not_ready",
              path: `${base}.verification.sample.params.event_name`,
              message: error instanceof Error ? error.message : String(error),
            };
            (options.requireExecutionReadiness ? issues : warnings).push(finding);
          }
        }
        const requiredColumn = kind === "outcome"
          ? plan.predicate.column
          : plan.sample_size.column;
        if (!blueprint.expected_columns.includes(requiredColumn)) {
          issues.push({
            code: kind === "outcome"
              ? "verification_column_invalid"
              : "verification_sample_column_invalid",
            path: `${base}.verification.${kind}.${kind === "outcome" ? "predicate" : "sample_size"}.column`,
            message: `Column must be one of: ${blueprint.expected_columns.join(", ")}.`,
          });
        }
      }
    }
    if (!automation.enabled) {
      warnings.push({
        code: "automation_disabled",
        path: `${base}.enabled`,
        message: "This automation remains disabled even when the global contract is enabled.",
      });
    }
  }
  return { valid: issues.length === 0, contract: parsed.data, issues, warnings };
}

async function readAutomationContractBody(c: Context<AppBindings>): Promise<unknown> {
  return readBoundedJson(c, 262_144);
}

async function readObjectBody(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const body = await readAutomationContractBody(c);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw errors.invalidPayload({ reason: "body must be a JSON object" });
  }
  return body as Record<string, unknown>;
}

function requireMatchingEtag(received: string | undefined, current: string) {
  if (!received) {
    throw errors.preconditionRequired(
      "If-Match is required when changing an existing automation contract.",
      "GET the current contract, review it, then retry with its exact ETag in If-Match.",
      { current_etag: current },
    );
  }
  if (received !== current) {
    throw errors.preconditionFailed(
      "The automation contract changed after it was read.",
      "Reload the current contract and reconcile changes before retrying; do not overwrite another editor's policy.",
      { current_etag: current, received_etag: received },
    );
  }
}

function throwAutomationContractChanged(previousEtag: string): never {
  throw errors.preconditionFailed(
    "The automation contract changed while this operation was being applied.",
    "Reload the current contract and reconcile changes before retrying; do not overwrite another editor's policy.",
    { previous_etag: previousEtag },
  );
}

function normalizeRepo(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function noWorkflowV3IdCollision(projectId: string, automationIds: string[]) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${automationWorkflows}
    WHERE ${automationWorkflows.projectId} = ${projectId}
      AND ${automationWorkflows.automationId} IN (${sql.join(
        automationIds.map((automationId) => sql`${automationId}`),
        sql`, `,
      )})
  )`;
}

async function workflowV3IdCollisions(
  db: ReturnType<typeof getDb>,
  projectId: string,
  automationIds: string[],
): Promise<string[]> {
  if (automationIds.length === 0) return [];
  return (
    await db.select({ automationId: automationWorkflows.automationId })
      .from(automationWorkflows)
      .where(and(
        eq(automationWorkflows.projectId, projectId),
        inArray(automationWorkflows.automationId, automationIds),
      ))
  ).map((row) => row.automationId).sort();
}

async function throwIfWorkflowV3IdCollision(
  db: ReturnType<typeof getDb>,
  projectId: string,
  automationIds: string[],
): Promise<void> {
  const collisions = await workflowV3IdCollisions(db, projectId, automationIds);
  if (collisions.length === 0) return;
  throw errors.conflict(
    "automation_id_namespace_conflict",
    "One or more automation ids already belong to saved workflow-v3 definitions.",
    "Rename the automation-v2 definitions or use an explicit reviewed migration flow. The execution generations cannot share an id.",
    { automation_ids: collisions, existing_generation: "workflow_v3" },
  );
}

export default router;
