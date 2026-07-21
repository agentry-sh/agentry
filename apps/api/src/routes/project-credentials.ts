import { Hono } from "hono";
import { and, desc, eq, gt, isNull, notLike, sql } from "drizzle-orm";
import {
  CreateProjectCredentialRequestSchema,
  errors,
  mintProjectCredential,
  prepareTelemetryObservation,
  scopesForProjectCredential,
  uuidv7,
} from "@agentrysh/shared";
import { auditLog, mutationCommands, projectCredentials, projects } from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectOwner } from "../middleware.js";
import { findAutomation, loadAutomationContract } from "../automation-contracts.js";
import { loadAutomationWorkflow } from "../automation-workflow-store.js";
import type { AppBindings } from "../env.js";
import { prepareAuditEvent } from "../audit.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";
import {
  assertAutomationWritesOpen,
  automationWritesOpenForProject,
} from "../automation-deletion-boundary.js";
import { readBoundedJson } from "../bounded-json.js";

const router = new Hono<AppBindings>();
class CredentialRevocationConflict extends Error {}
class CredentialCreationFenced extends Error {}
class ActiveWorkflowRunnerCredentialConflict extends Error {
  constructor(readonly credentials: Array<{ id: string; prefix: string; expiresAt: number }>) {
    super("workflow v3 already has an active runner credential");
  }
}

router.use("/v1/projects/:project_id/credentials", requireApiKey());
router.use("/v1/project-credentials/*", requireApiKey());

router.get("/v1/projects/:project_id/credentials", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  const rows = await getDb(c.env)
    .select()
    .from(projectCredentials)
    .where(eq(projectCredentials.projectId, projectId))
    .orderBy(desc(projectCredentials.createdAt));
  return c.json({
    credentials: rows.map(serializeCredential),
    next_action:
      "Use a separate active credential for each execution boundary. Raw keys are never recoverable; revoke an exposed key and create a replacement.",
  });
});

router.post("/v1/projects/:project_id/credentials", async (c) => {
  const projectId = c.req.param("project_id");
  await requireProjectOwner(c, projectId);
  const body = await readBoundedJson(c, 16_384);
  const parsed = CreateProjectCredentialRequestSchema.safeParse(body);
  if (!parsed.success) throw errors.invalidPayload({ zod: parsed.error.flatten() });
  const db = getDb(c.env);
  await assertAutomationWritesOpen(db, projectId);
  const identity = await mutationIdentity(c, {
    action: "project_credential.create",
    projectId,
    request: parsed.data,
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) return unrecoverableCredentialReplay(c, existing);

  let runnerBindingGeneration: "automation_v2" | "workflow_v3" | null = null;
  if (parsed.data.kind === "automation_runner") {
    const automationId = parsed.data.automation_id!;
    const [contract, workflow] = await Promise.all([
      loadAutomationContract(db, projectId),
      loadAutomationWorkflow(db, projectId, automationId),
    ]);
    const automation = contract ? findAutomation(contract, automationId) : null;
    if (automation && workflow) {
      throw errors.conflict(
        "automation_id_namespace_conflict",
        "The automation id exists in both automation v2 and workflow v3, so runner authority cannot be assigned safely.",
        "Keep both generations disabled and repair the shared automation_id namespace before creating a runner credential.",
        { automation_id: automationId },
      );
    }
    if (!automation && !workflow) {
      throw errors.conflict(
        "automation_not_found",
        "Runner credentials can only be bound to an existing saved automation v2 policy or workflow v3 revision.",
        "Save the disabled automation first, then create a credential for its exact automation_id.",
        { automation_id: automationId },
      );
    }
    runnerBindingGeneration = workflow ? "workflow_v3" : "automation_v2";
  }

  const now = Math.floor(Date.now() / 1000);
  if (runnerBindingGeneration === "workflow_v3") {
    const active = await activeWorkflowRunnerCredentials(
      db,
      projectId,
      parsed.data.automation_id!,
      now,
    );
    if (active.length > 0) throwWorkflowRunnerCredentialConflict(
      parsed.data.automation_id!,
      active,
    );
  }
  const lifetime = parsed.data.expires_in_seconds ??
    (parsed.data.kind === "automation_runner" ? 2_592_000 : 31_536_000);
  const minted = await mintProjectCredential(projectId, parsed.data.kind);
  const row = {
    id: uuidv7(),
    projectId,
    kind: parsed.data.kind,
    name: parsed.data.name,
    prefix: minted.prefix,
    tokenHash: minted.hash,
    automationId: parsed.data.automation_id ?? null,
    createdBy: c.get("user").id,
    createdAt: now,
    expiresAt: now + lifetime,
    lastUsedAt: null,
    revokedAt: null,
    revokeReason: null,
  };
  const durableResponse = {
    ...serializeCredential(row),
    env_var: envVarFor(row.kind),
    runner_id: row.kind === "automation_runner" ? `credential:${row.id}` : null,
  };
  const audit = await prepareAuditEvent(c, {
    userId: c.get("user").id,
    projectId,
    action: "project_credential.created",
    resourceType: "project_credential",
    resourceId: row.id,
    summary: `Created ${row.kind} credential ${row.name}`,
    metadata: {
      command_id: identity.id,
      kind: row.kind,
      automation_id: row.automationId,
      expires_at: row.expiresAt,
    },
  });
  try {
    await db.transaction(async (tx) => {
      await tx.run(sql`
        INSERT INTO ${projectCredentials} (
          id, project_id, kind, name, prefix, token_hash, automation_id,
          created_by, created_at, expires_at, last_used_at, revoked_at,
          revoke_reason
        )
        SELECT ${row.id}, ${row.projectId}, ${row.kind}, ${row.name},
          ${row.prefix}, ${row.tokenHash}, ${row.automationId}, ${row.createdBy},
          ${row.createdAt}, ${row.expiresAt}, NULL, NULL, NULL
        FROM ${projects}
        WHERE ${projects.id} = ${row.projectId}
          AND ${automationWritesOpenForProject(projects.id)}
          ${runnerBindingGeneration === "workflow_v3" ? sql`
            AND NOT EXISTS (
              SELECT 1
                FROM ${projectCredentials} AS active_runner
               WHERE active_runner.project_id = ${row.projectId}
                 AND active_runner.kind = 'automation_runner'
                 AND active_runner.automation_id = ${row.automationId}
                 AND active_runner.revoked_at IS NULL
                 AND active_runner.expires_at > ${now}
                 AND active_runner.token_hash NOT LIKE 'legacy-disabled:%'
            )
          ` : sql``}
      `);
      const inserted = await tx.select({ id: projectCredentials.id })
        .from(projectCredentials)
        .where(eq(projectCredentials.id, row.id))
        .limit(1);
      if (inserted.length !== 1) {
        if (runnerBindingGeneration === "workflow_v3") {
          const active = await activeWorkflowRunnerCredentials(
            tx,
            projectId,
            parsed.data.automation_id!,
            now,
          );
          if (active.length > 0) {
            throw new ActiveWorkflowRunnerCredentialConflict(active);
          }
        }
        throw new CredentialCreationFenced();
      }
      await tx.insert(mutationCommands).values(
        mutationCommandValues(identity, {
          resourceType: "project_credential",
          resourceId: row.id,
          response: durableResponse,
          createdAt: now,
        }),
      );
      await tx.insert(auditLog).values(audit.values);
    });
  } catch (error) {
    await assertAutomationWritesOpen(db, projectId);
    const winner = await loadMutationCommand(c, identity);
    if (winner) return unrecoverableCredentialReplay(c, winner);
    if (error instanceof ActiveWorkflowRunnerCredentialConflict) {
      throwWorkflowRunnerCredentialConflict(
        parsed.data.automation_id!,
        error.credentials,
      );
    }
    throw error;
  }
  return c.json({
    ...durableResponse,
    credential: minted.raw,
    idempotent_replay: false,
    next_action:
      "Store credential in the named secret environment only. This is the only response containing the raw value; never commit it or copy it into telemetry, reports, or agent artifacts.",
  });
});

router.post("/v1/project-credentials/:credential_id/revoke", async (c) => {
  const body = await readBoundedJson(c, 8_192);
  const rawReason = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { reason?: unknown }).reason === "string"
    ? (body as { reason: string }).reason.trim().slice(0, 2_000)
    : "";
  const reason = prepareTelemetryObservation(rawReason, {
    max_string_chars: 2_000,
  }).content;
  if (!reason) throw errors.invalidPayload({ reason: "a non-empty revoke reason is required" });
  const db = getDb(c.env);
  const row = (
    await db
      .select()
      .from(projectCredentials)
      .where(eq(projectCredentials.id, c.req.param("credential_id")))
      .limit(1)
  )[0];
  if (!row) throw errors.notFound("project_credential");
  await requireProjectOwner(c, row.projectId);
  await assertAutomationWritesOpen(db, row.projectId);
  const identity = await mutationIdentity(c, {
    action: "project_credential.revoke",
    projectId: row.projectId,
    request: { credential_id: row.id, reason },
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) return replayCredentialRevocation(c, existing, row);
  if (row.revokedAt !== null) {
    throw errors.conflict(
      "credential_already_revoked",
      "This credential was revoked by a different durable command or predates command receipts.",
      "Read revoked_at and revoke_reason. Do not relabel a different reason or Idempotency-Key as an exact replay.",
      { credential_id: row.id, revoked_at: row.revokedAt },
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const committed = { ...row, revokedAt: now, revokeReason: reason };
  const durableResponse = {
    ...serializeCredential(committed),
    next_action:
      "Remove the revoked value from its host or runner, then create a replacement only if that execution boundary still needs access.",
  };
  const audit = await prepareAuditEvent(c, {
    userId: c.get("user").id,
    projectId: row.projectId,
    action: "project_credential.revoked",
    resourceType: "project_credential",
    resourceId: row.id,
    summary: `Revoked ${row.kind} credential ${row.name}`,
    metadata: {
      command_id: identity.id,
      kind: row.kind,
      automation_id: row.automationId,
      reason,
      revoked_at: now,
    },
  });
  try {
    await db.transaction(async (tx) => {
      const revoked = await tx
        .update(projectCredentials)
        .set({ revokedAt: now, revokeReason: reason })
        .where(and(
          eq(projectCredentials.id, row.id),
          eq(projectCredentials.projectId, row.projectId),
          isNull(projectCredentials.revokedAt),
          automationWritesOpenForProject(projectCredentials.projectId),
        ))
        .returning({ id: projectCredentials.id });
      if (revoked.length !== 1) throw new CredentialRevocationConflict();
      const receipt = await tx
        .insert(mutationCommands)
        .values(mutationCommandValues(identity, {
          resourceType: "project_credential",
          resourceId: row.id,
          response: durableResponse,
          createdAt: now,
        }))
        .onConflictDoNothing()
        .returning({ id: mutationCommands.id });
      if (receipt.length !== 1) throw new CredentialRevocationConflict();
      await tx.insert(auditLog).values(audit.values);
    });
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner) return replayCredentialRevocation(c, winner, row);
    if (error instanceof CredentialRevocationConflict) {
      throw errors.conflict(
        "credential_revoke_conflict",
        "The credential changed while revocation was being committed.",
        "Re-read the credential. Use the original exact command receipt if it exists; never overwrite different revocation evidence.",
        { credential_id: row.id },
      );
    }
    throw error;
  }
  return c.json({
    ...durableResponse,
    idempotent_replay: false,
  });
});

function serializeCredential(row: typeof projectCredentials.$inferSelect) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: row.id,
    project_id: row.projectId,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    scopes: scopesForProjectCredential(row.kind),
    automation_id: row.automationId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    active: row.revokedAt === null && row.expiresAt > now,
  };
}

function envVarFor(kind: typeof projectCredentials.$inferSelect.kind): string {
  if (kind === "ci_deploy") return "AGENTRY_CI_API_KEY";
  return "AGENTRY_RUNNER_API_KEY";
}

type CredentialReadDb = Pick<ReturnType<typeof getDb>, "select">;

async function activeWorkflowRunnerCredentials(
  db: CredentialReadDb,
  projectId: string,
  automationId: string,
  now: number,
): Promise<Array<{ id: string; prefix: string; expiresAt: number }>> {
  return db.select({
    id: projectCredentials.id,
    prefix: projectCredentials.prefix,
    expiresAt: projectCredentials.expiresAt,
  }).from(projectCredentials).where(and(
    eq(projectCredentials.projectId, projectId),
    eq(projectCredentials.kind, "automation_runner"),
    eq(projectCredentials.automationId, automationId),
    isNull(projectCredentials.revokedAt),
    gt(projectCredentials.expiresAt, now),
    notLike(projectCredentials.tokenHash, "legacy-disabled:%"),
  ));
}

function throwWorkflowRunnerCredentialConflict(
  automationId: string,
  active: Array<{ id: string; prefix: string; expiresAt: number }>,
): never {
  throw errors.conflict(
    "automation_workflow_runner_credential_exists",
    "Workflow v3 permits exactly one active runner credential for one automation_id.",
    "Use the existing credential if its raw value is still installed. If it was lost or exposed, revoke it explicitly, then create one replacement with a new Idempotency-Key.",
    {
      automation_id: automationId,
      active_credentials: active
        .map((credential) => ({
          credential_id: credential.id,
          prefix: credential.prefix,
          expires_at: credential.expiresAt,
        }))
        .sort((left, right) => left.credential_id.localeCompare(right.credential_id)),
    },
  );
}

async function unrecoverableCredentialReplay(
  c: Parameters<typeof loadMutationCommand>[0],
  command: typeof mutationCommands.$inferSelect,
): Promise<never> {
  const response = mutationResponse<{
    id: string;
    project_id: string;
    kind: string;
    prefix: string;
    active: boolean;
    env_var: string;
    runner_id: string | null;
  }>(command);
  const row = (
    await getDb(c.env)
      .select()
      .from(projectCredentials)
      .where(eq(projectCredentials.id, response.id))
      .limit(1)
  )[0];
  throw errors.conflict(
    "credential_secret_not_recoverable",
    "This command already created a project credential, whose raw value is intentionally not recoverable.",
    "Do not retry with a new key while this credential is active. If the first response was lost, explicitly revoke this credential, then create one replacement with a new Idempotency-Key.",
    {
      command_id: command.id,
      credential_id: response.id,
      project_id: response.project_id,
      kind: response.kind,
      prefix: response.prefix,
      active: row ? serializeCredential(row).active : false,
      env_var: response.env_var,
      runner_id: response.runner_id,
      idempotent_replay: true,
    },
  );
}

async function replayCredentialRevocation(
  c: Parameters<typeof loadMutationCommand>[0],
  command: typeof mutationCommands.$inferSelect,
  credential: typeof projectCredentials.$inferSelect,
) {
  const response = mutationResponse<ReturnType<typeof serializeCredential> & {
    next_action: string;
  }>(command);
  const stored = (
    await getDb(c.env)
      .select()
      .from(projectCredentials)
      .where(and(
        eq(projectCredentials.id, credential.id),
        eq(projectCredentials.projectId, credential.projectId),
      ))
      .limit(1)
  )[0];
  if (
    !stored ||
    response.id !== stored.id ||
    response.project_id !== stored.projectId ||
    response.revoked_at !== stored.revokedAt ||
    response.revoke_reason !== stored.revokeReason ||
    stored.revokedAt === null
  ) {
    throw errors.persistenceFailed(
      "The credential revocation receipt does not match the durable credential state.",
      "Stop and inspect the command, audit, and credential rows; never infer or repeat revocation authority.",
      { command_id: command.id, credential_id: credential.id },
    );
  }
  return c.json({
    ...response,
    idempotent_replay: true,
  });
}

export default router;
