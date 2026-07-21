import type { Context, MiddlewareHandler } from "hono";
import {
  errors,
  parseProjectCredential,
  sha256Hex,
  type ProjectCredentialKind,
} from "@agentrysh/shared";
import { apiKeys, cases, projectMemberships, projects, users } from "@agentry/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { ApiKey, Case, Project, ProjectMembership, User } from "@agentry/db/schema";
import { getDb } from "./db.js";
import type { AppBindings } from "./env.js";
import { authenticateProjectCredential } from "./project-credential-auth.js";

// API-key revokes and self-deletes must be visible across Cloudflare isolates.
// Keep this off until there is distributed invalidation.
const AUTH_CACHE_TTL_MS = 0;
// Project memberships/deletes must be visible across Cloudflare isolates; keep this off until there is distributed invalidation.
const PROJECT_ACCESS_CACHE_TTL_MS = 0;
const LAST_USED_TOUCH_INTERVAL_MS = 60_000;

interface ApiKeyAuthCacheEntry {
  apiKey: ApiKey;
  user: User;
  expiresAt: number;
}

interface ProjectAccessCacheEntry {
  project: Project;
  membership: ProjectMembership;
  expiresAt: number;
}

const apiKeyAuthCache = new Map<string, ApiKeyAuthCacheEntry>();
const projectAccessCache = new Map<string, ProjectAccessCacheEntry>();
const apiKeyLastUsedTouchCache = new Map<string, number>();

export function invalidateApiKeyAuthCache(keyHash: string): void {
  const cached = apiKeyAuthCache.get(keyHash);
  if (cached) apiKeyLastUsedTouchCache.delete(cached.apiKey.id);
  apiKeyAuthCache.delete(keyHash);
}

export function invalidateUserAuthCache(userId: string): void {
  for (const [keyHash, entry] of apiKeyAuthCache.entries()) {
    if (entry.user.id !== userId) continue;
    apiKeyLastUsedTouchCache.delete(entry.apiKey.id);
    apiKeyAuthCache.delete(keyHash);
  }
  for (const key of projectAccessCache.keys()) {
    if (key.startsWith(`${userId}:`)) projectAccessCache.delete(key);
  }
}

export function invalidateProjectAccessCache(projectId: string): void {
  for (const key of projectAccessCache.keys()) {
    if (key.endsWith(`:${projectId}`)) projectAccessCache.delete(key);
  }
}

/**
 * Safely extract a waitUntil function from a Hono Context.
 *
 * Hono's `c.executionCtx` getter THROWS synchronously when the underlying
 * runtime is not Cloudflare Workers (e.g. plain Node in tests, or any non-Workers
 * fetch handler). Optional chaining (`c.executionCtx?.waitUntil`) does NOT catch
 * a thrown getter — it only protects against null/undefined receivers.
 *
 * This helper handles both cases: returns a real waitUntil when available,
 * falls back to fire-and-forget with error swallowing otherwise.
 */
export function waitUntilOf(c: Context<AppBindings>): (p: Promise<unknown>) => void {
  let waitUntil: (p: Promise<unknown>) => void;
  try {
    const ec = c.executionCtx;
    if (ec && typeof ec.waitUntil === "function") {
      waitUntil = (p) => ec.waitUntil(p);
      return waitUntil;
    }
  } catch {
    /* no executionCtx — fall through to inline */
  }
  waitUntil = (p) => {
    void p.catch(() => {});
  };
  return waitUntil;
}

export async function authenticatePrivateApiKey(c: Context<AppBindings>): Promise<{
  apiKey: ApiKey;
  user: User;
  keyHash: string;
}> {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!auth) throw errors.unauthorized();
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || !m[1]) throw errors.unauthorized();
  const token = m[1].trim();
  if (!token) throw errors.unauthorized();

  const hash = await sha256Hex(token);
  const db = getDb(c.env);
  const nowMs = Date.now();
  const cached = apiKeyAuthCache.get(hash);
  let row =
    cached && cached.expiresAt > nowMs
      ? { apiKey: cached.apiKey, user: cached.user }
      : null;

  if (!row) {
    const rows = await db
      .select({ apiKey: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
      .limit(1);

    row = rows[0] ?? null;
    if (row && row.apiKey.kind === "private" && AUTH_CACHE_TTL_MS > 0) {
      apiKeyAuthCache.set(hash, {
        apiKey: row.apiKey,
        user: row.user,
        expiresAt: nowMs + AUTH_CACHE_TTL_MS,
      });
    }
  }

  if (!row || row.apiKey.kind !== "private") throw errors.invalidApiKey();

  c.set("apiKey", row.apiKey);
  c.set("user", row.user);

  // Best-effort touch — don't block on it.
  const lastTouchedAt = apiKeyLastUsedTouchCache.get(row.apiKey.id) ?? 0;
  if (nowMs - lastTouchedAt >= LAST_USED_TOUCH_INTERVAL_MS) {
    apiKeyLastUsedTouchCache.set(row.apiKey.id, nowMs);
    waitUntilOf(c)(
      db
        .update(apiKeys)
        .set({ lastUsedAt: Math.floor(nowMs / 1000) })
        .where(eq(apiKeys.id, row.apiKey.id))
        .catch(() => {
          // ignore — purely an observability field
        }),
    );
  }
  return { ...row, keyHash: hash };
}

export function requireApiKey(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await authenticatePrivateApiKey(c);
    await next();
  };
}

export function requireApiKeyOrProjectCredential(
  allowedKinds: readonly ProjectCredentialKind[],
): MiddlewareHandler<AppBindings> {
  const privateKeyMiddleware = requireApiKey();
  return async (c, next) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    const token = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (token && parseProjectCredential(token)) {
      const principal = await authenticateProjectCredential(c);
      if (!allowedKinds.includes(principal.kind)) {
        throw errors.credentialScopeDenied(allowedKinds.join("_or_"), principal.kind, {
          credential_id: principal.credentialId,
        });
      }
      c.set("projectCredential", principal);
      await next();
      return;
    }
    c.set("projectCredential", null);
    await privateKeyMiddleware(c, next);
  };
}

export function requireApiKeyOrAutomationRunner(): MiddlewareHandler<AppBindings> {
  return requireApiKeyOrProjectCredential(["automation_runner"]);
}

async function loadProjectAccess(
  c: Context<AppBindings>,
  projectId: string,
): Promise<{ project: Project; membership: ProjectMembership }> {
  const user = c.get("user") as User;
  const cacheKey = `${user.id}:${projectId}`;
  const nowMs = Date.now();
  const cached = PROJECT_ACCESS_CACHE_TTL_MS > 0 ? projectAccessCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > nowMs) {
    return { project: cached.project, membership: cached.membership };
  }

  const db = getDb(c.env);
  const rows = await db
    .select({ p: projects, membership: projectMemberships })
    .from(projectMemberships)
    .innerJoin(projects, eq(projects.id, projectMemberships.projectId))
    .where(
      and(
        eq(projectMemberships.projectId, projectId),
        eq(projectMemberships.userId, user.id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    const exists = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!exists[0]) throw errors.notFound("project");
    throw errors.forbidden();
  }
  const access = { project: row.p, membership: row.membership };
  if (PROJECT_ACCESS_CACHE_TTL_MS > 0) {
    projectAccessCache.set(cacheKey, {
      ...access,
      expiresAt: nowMs + PROJECT_ACCESS_CACHE_TTL_MS,
    });
  }
  return access;
}

export async function requireProjectAccess(
  c: Context<AppBindings>,
  projectId: string,
): Promise<Project> {
  const credential = c.get("projectCredential");
  if (credential) {
    if (credential.projectId !== projectId) throw errors.forbidden();
    const project = (
      await getDb(c.env).select().from(projects).where(eq(projects.id, projectId)).limit(1)
    )[0];
    if (!project) throw errors.notFound("project");
    return project;
  }
  return (await loadProjectAccess(c, projectId)).project;
}

export async function requireProjectOwner(
  c: Context<AppBindings>,
  projectId: string,
): Promise<Project> {
  if (c.get("projectCredential")) {
    throw errors.credentialScopeDenied("human_owner_required", "automation_runner");
  }
  const { project, membership } = await loadProjectAccess(c, projectId);
  if (membership.role !== "owner") throw errors.forbidden();
  return project;
}

export async function requireCaseAccess(
  c: Context<AppBindings>,
  caseId: string,
): Promise<{ case: Case; project: Project }> {
  const db = getDb(c.env);
  const credential = c.get("projectCredential");
  if (credential) {
    const row = (
      await db
        .select({ c: cases, p: projects })
        .from(cases)
        .innerJoin(projects, eq(projects.id, cases.projectId))
        .where(and(eq(cases.id, caseId), eq(cases.projectId, credential.projectId)))
        .limit(1)
    )[0];
    if (!row) {
      const exists = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId)).limit(1);
      if (!exists[0]) throw errors.notFound("case");
      throw errors.forbidden();
    }
    return { case: row.c, project: row.p };
  }
  const user = c.get("user") as User;
  const rows = await db
    .select({ c: cases, p: projects })
    .from(cases)
    .innerJoin(projects, eq(projects.id, cases.projectId))
    .innerJoin(
      projectMemberships,
      and(
        eq(projectMemberships.projectId, projects.id),
        eq(projectMemberships.userId, user.id),
      ),
    )
    .where(eq(cases.id, caseId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // Same 404 vs 403 split as requireProjectAccess.
    const exists = await db
      .select({ id: cases.id })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1);
    if (!exists[0]) throw errors.notFound("case");
    throw errors.forbidden();
  }
  return { case: row.c, project: row.p };
}

// Re-export for type inference convenience.
export type { ApiKey };
