import type { Context } from "hono";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  errors,
  parseProjectCredential,
  scopesForProjectCredential,
  sha256Hex,
  type ProjectCredentialKind,
  type ProjectCredentialScope,
} from "@agentrysh/shared";
import { projectCredentials, projectDeletionFences } from "@agentry/db/schema";
import { getDb } from "./db.js";
import type { AppBindings } from "./env.js";

export interface ProjectCredentialPrincipal {
  projectId: string;
  credentialId: string;
  kind: ProjectCredentialKind;
  scopes: ProjectCredentialScope[];
  automationId: string | null;
  runnerId: string | null;
}

export interface SignalCredentialPrincipal {
  projectId: string;
  credentialId: string;
  kind: "ci_deploy";
  trustLevel: "trusted_ci";
}

function extractBearerToken(c: Context<AppBindings>): string | null {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return token || null;
}

export async function authenticateProjectCredential(
  c: Context<AppBindings>,
): Promise<ProjectCredentialPrincipal> {
  const raw = extractBearerToken(c);
  if (!raw) throw errors.invalidProjectCredential();
  const parsed = parseProjectCredential(raw);
  if (!parsed) throw errors.invalidProjectCredential();
  const hash = await sha256Hex(raw);
  const now = Math.floor(Date.now() / 1000);
  const db = getDb(c.env);
  const row = (
    await db
      .select()
      .from(projectCredentials)
      .where(
        and(
          eq(projectCredentials.projectId, parsed.projectId),
          eq(projectCredentials.tokenHash, hash),
          eq(projectCredentials.kind, parsed.kind),
          isNull(projectCredentials.revokedAt),
          gt(projectCredentials.expiresAt, now),
          sql`NOT EXISTS (
            SELECT 1 FROM ${projectDeletionFences}
            WHERE ${projectDeletionFences.projectId} = ${projectCredentials.projectId}
          )`,
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw errors.invalidProjectCredential();
  const scopes = scopesForProjectCredential(row.kind);
  // last_used_at is observability only. Authentication never depends on this
  // write, so a telemetry failure cannot deny a valid request.
  void db
    .update(projectCredentials)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(projectCredentials.id, row.id),
        or(
          isNull(projectCredentials.lastUsedAt),
          lt(projectCredentials.lastUsedAt, now - 60),
        ),
      ),
    )
    .catch(() => {});
  return {
    projectId: row.projectId,
    credentialId: row.id,
    kind: row.kind,
    scopes,
    automationId: row.automationId,
    runnerId: row.kind === "automation_runner" ? `credential:${row.id}` : null,
  };
}

export async function requireSignalCredential(
  c: Context<AppBindings>,
  requiredScope: "deploys:write",
): Promise<SignalCredentialPrincipal> {
  const principal = await authenticateProjectCredential(c);
  if (!principal.scopes.includes(requiredScope)) {
    throw errors.credentialScopeDenied(requiredScope, principal.kind, {
      credential_id: principal.credentialId,
    });
  }
  if (principal.kind === "ci_deploy") {
    return {
      projectId: principal.projectId,
      credentialId: principal.credentialId,
      kind: "ci_deploy",
      trustLevel: "trusted_ci",
    };
  }
  throw errors.credentialScopeDenied(requiredScope, principal.kind, {
    credential_id: principal.credentialId,
  });
}

export function requireCredentialScope(
  c: Context<AppBindings>,
  scope: ProjectCredentialScope,
  projectId: string,
  automationId?: string,
): ProjectCredentialPrincipal | null {
  const principal = c.get("projectCredential");
  if (!principal) return null;
  if (principal.projectId !== projectId) {
    throw errors.forbidden("The project credential belongs to a different project.");
  }
  if (!principal.scopes.includes(scope)) {
    throw errors.credentialScopeDenied(scope, principal.kind, {
      credential_id: principal.credentialId,
    });
  }
  if (
    principal.kind === "automation_runner" &&
    automationId !== undefined &&
    principal.automationId !== automationId
  ) {
    throw errors.credentialScopeDenied(scope, principal.kind, {
      credential_id: principal.credentialId,
      credential_automation_id: principal.automationId,
      requested_automation_id: automationId,
    });
  }
  return principal;
}

export function requireHumanApiKey(c: Context<AppBindings>): void {
  if (c.get("projectCredential")) {
    throw errors.credentialScopeDenied("human_owner_required", "automation_runner");
  }
}
