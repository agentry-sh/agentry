// Public-fetchable query publications.
//
// The user (via their agent) calls POST /v1/projects/:project_id/public-queries to mint a
// publication for a (blueprint_id, params) tuple. The publication has its own
// unguessable UUID. Visitors fetch:
//
//   GET /v1/public/q/<publication_id>
//
// …and get the blueprint's rows, scoped to the user's PostHog team
// (PostHog enforces team_id on every events read at the AST level — same
// isolation as the user's private queries).
//
// The publication_id is unguessable and only exists for a query the owner
// explicitly published. It is the complete visitor capability: there is no
// second query-key authentication branch.
//
// CORS is open on the public endpoint — meant to be called from browsers.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  TELEMETRY_DATA_BOUNDARY,
  errors,
  prepareTelemetryObservation,
  uuidv7,
} from "@agentrysh/shared";
import {
  auditLog,
  mutationCommands,
  publicQueryPublications,
  projects,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess, requireProjectOwner } from "../middleware.js";
import {
  getQueryBlueprint,
  getQueryBlueprintPublicationSafetyViolations,
  interpolateQuery,
} from "../query-blueprints.js";
import { hogQlRowsToObjects, isPosthogConfigured, runHogQl } from "../posthog.js";
import { prepareAuditEvent } from "../audit.js";
import { publicQueryRateLimit } from "../rate-limit.js";
import type { AppBindings } from "../env.js";
import { readBoundedJson } from "../bounded-json.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";

const router = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// Owner-side management (api-key auth) — list / publish / revoke.
// ---------------------------------------------------------------------------

router.post(
  "/v1/projects/:project_id/public-queries",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const proj = await requireProjectOwner(c, projectId);
    const rawBody = await readBoundedJson(c, 65_536);
    const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)
      ? rawBody as Record<string, unknown>
      : {};
    const blueprintId = String(body.blueprint_id ?? "").trim();
    const description = body.description ? String(body.description).slice(0, 400) : null;
    const paramsObj = body.params && typeof body.params === "object"
      ? (body.params as Record<string, unknown>) : {};
    if (!blueprintId) {
      throw errors.invalidPayload({ reason: "blueprint_id is required" });
    }
    const blueprint = getQueryBlueprint(blueprintId);
    if (!blueprint) {
      throw errors.notFound("query_blueprint");
    }
    if (blueprint.backend !== "analytics") {
      throw errors.unsupportedOperation(
        `blueprint_id "${blueprintId}" is ${blueprint.backend}-backed and cannot be published as a browser-safe analytics query.`,
        "Use analytics-backed query blueprints for public dashboard publications. For cases and deploys, use the typed owner endpoints from server-side code.",
        { blueprint_id: blueprintId, backend: blueprint.backend },
      );
    }
    const publicationSafetyViolations =
      getQueryBlueprintPublicationSafetyViolations(blueprint);
    if (publicationSafetyViolations.length > 0) {
      throw errors.unsupportedOperation(
        `blueprint_id "${blueprintId}" is analytics-backed but its publication_safety policy denies public access.`,
        "Run this blueprint only through the owner-authenticated query-blueprint endpoint. For browser or shareable output, choose a blueprint with publication_safety.status=safe_aggregate and public_access=allowed.",
        {
          blueprint_id: blueprintId,
          backend: blueprint.backend,
          publication_safety: blueprint.publication_safety,
          publication_safety_violations: publicationSafetyViolations,
        },
      );
    }
    // Validate params by attempting interpolation — surfaces missing/bad ones
    // up front instead of at first visitor fetch.
    try {
      interpolateQuery(blueprint.query, paramsObj, blueprint.params);
    } catch (err) {
      throw errors.invalidPayload({
        reason: "params don't satisfy blueprint.params",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const identity = await mutationIdentity(c, {
      action: "publication.mint",
      projectId: proj.id,
      request: {
        blueprint_id: blueprintId,
        params: paramsObj,
        description,
      },
    });
    const existing = await loadMutationCommand(c, identity);
    if (existing) {
      return c.json({
        ...mutationResponse<Record<string, unknown>>(existing),
        idempotent_replay: true,
      });
    }

    const db = getDb(c.env);
    const id = uuidv7();
    const createdAt = Math.floor(Date.now() / 1000);
    const publicationWrite = db.insert(publicQueryPublications).values({
      id,
      userId: proj.userId,
      projectId: proj.id,
      recipeId: blueprintId,
      paramsJson: JSON.stringify(paramsObj),
      description,
      createdAt,
    });
    const baseUrl = new URL(c.req.url);
    const durableResponse = {
      id,
      project_id: proj.id,
      blueprint_id: blueprintId,
      params: paramsObj,
      description,
      publication_safety: blueprint.publication_safety,
      public_url: `${baseUrl.protocol}//${baseUrl.host}/v1/public/q/${id}`,
      next_action:
        "Return or embed the full public query URL. CORS is open. Each publication is " +
        "fingerprinted to one (blueprint_id, params) tuple — revoke with DELETE /v1/projects/:project_id/public-queries/:publication_id " +
        "and its own stable Idempotency-Key if it's no longer needed.",
    };
    const preparedAudit = await prepareAuditEvent(c, {
      userId: c.get("user").id,
      projectId: proj.id,
      action: "publication.minted",
      resourceType: "publication",
      resourceId: id,
      summary: `Minted publication for query blueprint '${blueprintId}'${description ? `: ${description}` : ""}`,
      metadata: { command_id: identity.id, blueprint_id: blueprintId, params: paramsObj },
    });
    try {
      await db.batch([
        publicationWrite,
        db.insert(mutationCommands).values(mutationCommandValues(identity, {
          resourceType: "publication",
          resourceId: id,
          response: durableResponse,
          createdAt,
        })),
        db.insert(auditLog).values(preparedAudit.values),
      ] as const);
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (winner) {
        return c.json({
          ...mutationResponse<Record<string, unknown>>(winner),
          idempotent_replay: true,
        });
      }
      throw error;
    }
    return c.json({ ...durableResponse, idempotent_replay: false });
  },
);

router.get(
  "/v1/projects/:project_id/public-queries",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const proj = await requireProjectAccess(c, projectId);
    const db = getDb(c.env);
    const rows = await db
      .select()
      .from(publicQueryPublications)
      .where(
        and(
          eq(publicQueryPublications.projectId, proj.id),
          isNull(publicQueryPublications.revokedAt),
        ),
      )
      .orderBy(desc(publicQueryPublications.createdAt))
      .limit(200);
    const baseUrl = new URL(c.req.url);
    return c.json({
      project_id: proj.id,
      count: rows.length,
      publications: rows.map((r) => ({
        id: r.id,
        blueprint_id: r.recipeId,
        params: safeJson(r.paramsJson),
        description: r.description,
        created_at: r.createdAt,
        last_used_at: r.lastUsedAt,
        public_url: `${baseUrl.protocol}//${baseUrl.host}/v1/public/q/${r.id}`,
      })),
    });
  },
);

router.delete(
  "/v1/projects/:project_id/public-queries/:publication_id",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const publicationId = c.req.param("publication_id");
    const proj = await requireProjectOwner(c, projectId);
    const identity = await mutationIdentity(c, {
      action: "publication.revoke",
      projectId: proj.id,
      request: { publication_id: publicationId },
    });
    const existing = await loadMutationCommand(c, identity);
    if (existing) {
      return c.json({
        ...mutationResponse<Record<string, unknown>>(existing),
        idempotent_replay: true,
      });
    }
    const db = getDb(c.env);
    const rows = await db
      .select()
      .from(publicQueryPublications)
      .where(eq(publicQueryPublications.id, publicationId))
      .limit(1);
    const row = rows[0];
    if (!row || row.projectId !== proj.id) {
      throw errors.notFound("publication");
    }
    if (row.revokedAt !== null) {
      throw errors.conflict(
        "publication_already_revoked",
        "This publication is already revoked.",
        "Treat the publication as gone and remove any remaining embedded public URL; do not mint a second revocation event.",
        { publication_id: publicationId, revoked_at: row.revokedAt },
      );
    }
    const revokedAt = Math.floor(Date.now() / 1000);
    const durableResponse = {
      id: publicationId,
      revoked: true,
      revoked_at: revokedAt,
      next_action:
        "Embedded `public_url` will now 410 (Gone). Update or remove the dashboard reference.",
    };
    const preparedAudit = await prepareAuditEvent(c, {
      userId: c.get("user").id,
      projectId: proj.id,
      action: "publication.revoked",
      resourceType: "publication",
      resourceId: publicationId,
      summary: `Revoked publication ${publicationId}`,
      metadata: { command_id: identity.id },
    });
    const revokeWrite = db.update(publicQueryPublications)
      .set({ revokedAt })
      .where(and(
        eq(publicQueryPublications.id, publicationId),
        isNull(publicQueryPublications.revokedAt),
      ));
    const commandValues = mutationCommandValues(identity, {
      resourceType: "publication",
      resourceId: publicationId,
      response: durableResponse,
      createdAt: revokedAt,
    });
    const guardedCommandValues = {
      ...commandValues,
      action: sql<string>`CASE WHEN changes() = 1 THEN ${commandValues.action} ELSE NULL END`,
    };
    try {
      await db.batch([
        revokeWrite,
        db.insert(mutationCommands).values(guardedCommandValues),
        db.insert(auditLog).values(preparedAudit.values),
      ] as const);
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (winner) {
        return c.json({
          ...mutationResponse<Record<string, unknown>>(winner),
          idempotent_replay: true,
        });
      }
      const current = (
        await db.select({ revokedAt: publicQueryPublications.revokedAt })
          .from(publicQueryPublications)
          .where(eq(publicQueryPublications.id, publicationId))
          .limit(1)
      )[0];
      if (current?.revokedAt === null) throw error;
      throw errors.conflict(
        "publication_revoke_conflict",
        "The publication changed while this revocation was being committed.",
        "Re-read the publication. If it is already revoked by another command, treat it as gone; otherwise retry this exact request with the same Idempotency-Key.",
        { publication_id: publicationId },
      );
    }
    return c.json({ ...durableResponse, idempotent_replay: false });
  },
);

// ---------------------------------------------------------------------------
// Visitor-side execution — the unguessable publication URL is the capability.
// Wide-open CORS so any web app can hit it.
// ---------------------------------------------------------------------------

const publicRouter = new Hono<AppBindings>();
publicRouter.use("/v1/public/q/*", cors({ origin: "*", allowMethods: ["GET", "HEAD"] }));
publicRouter.use("/v1/public/q/*", publicQueryRateLimit());

publicRouter.get("/v1/public/q/:publication_id", async (c) => {
  const publicationId = c.req.param("publication_id");
  const db = getDb(c.env);

  // Look up the publication.
  const pubRows = await db
    .select()
    .from(publicQueryPublications)
    .where(eq(publicQueryPublications.id, publicationId))
    .limit(1);
  const pub = pubRows[0];
  if (!pub || pub.revokedAt) {
    // 410 Gone if revoked, 404 if never existed.
    return c.json({
      error: { code: "not_found", message: "publication not found or revoked" },
    }, pub?.revokedAt ? 410 : 404);
  }

  // Verify the project still exists (owner could have deleted it).
  const projRows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, pub.projectId))
    .limit(1);
  if (!projRows[0]) {
    throw errors.publicationProjectDeleted(pub.id);
  }

  // Run the blueprint. Per-team_id isolation is enforced by PostHog at the AST
  // level through the project-scoped binding. No additional filter injection
  // needed.
  const blueprint = getQueryBlueprint(pub.recipeId);
  if (!blueprint) {
    throw errors.catalogInconsistent(
      `query blueprint ${pub.recipeId} no longer exists`,
      { blueprint_id: pub.recipeId, publication_id: pub.id },
    );
  }
  if (blueprint.backend !== "analytics") {
    throw errors.catalogInconsistent(
      `public query ${pub.id} references non-analytics blueprint ${pub.recipeId}`,
      { blueprint_id: pub.recipeId, publication_id: pub.id, backend: blueprint.backend },
    );
  }
  const publicationSafetyViolations =
    getQueryBlueprintPublicationSafetyViolations(blueprint);
  if (publicationSafetyViolations.length > 0) {
    throw errors.unsupportedOperation(
      "This publication's blueprint is no longer safe for public access.",
      "The project owner must revoke this publication and replace it with a safe_aggregate blueprint that returns no identifiers or arbitrary segment values.",
      {
        publication_id: pub.id,
        blueprint_id: pub.recipeId,
        publication_safety: blueprint.publication_safety,
        publication_safety_violations: publicationSafetyViolations,
      },
    );
  }
  if (!isPosthogConfigured(c.env)) {
    throw errors.posthogConnectionRequired({ operation: "fetch_public_query" });
  }
  const params: Record<string, unknown> = safeJson(pub.paramsJson) ?? {};
  const interpolated = interpolateQuery(blueprint.query, params, blueprint.params);
  const queryStartedAt = Date.now();
  const out = await runHogQl(c.env, pub.projectId, interpolated, { cacheBust: true });
  const rows = hogQlRowsToObjects(out.results, out.columns, blueprint.expected_columns);
  const outputObservation = prepareTelemetryObservation({
    rows,
    columns: out.columns ?? blueprint.expected_columns,
    types: out.types,
  });
  const safeOutput = outputObservation.content as {
    rows: Array<Record<string, unknown>>;
    columns: unknown;
    types: unknown;
  };
  const freshness = {
    source: "posthog_hogql",
    consistency: "eventual",
    cache_bust: true,
    queried_at: new Date(queryStartedAt).toISOString(),
    query_duration_ms: Date.now() - queryStartedAt,
    retry_after_ms: 30_000,
    status: "complete_for_query_time",
    next_action:
      "Freshly ingested analytics can take a short time to appear in PostHog-backed public query reads. " +
      "If this browser dashboard is showing a recent empty or partial result, treat it as pending, wait at least retry_after_ms, then fetch this same public URL again before making customer-facing claims.",
  };

  // Stamp last_used_at fire-and-forget.
  try {
    await db
      .update(publicQueryPublications)
      .set({ lastUsedAt: Math.floor(Date.now() / 1000) })
      .where(eq(publicQueryPublications.id, publicationId));
  } catch {
    /* non-fatal */
  }

  return c.json({
    data_boundary: {
      ...TELEMETRY_DATA_BOUNDARY,
      applies_to: "rows, columns, and types",
      inspection: outputObservation.inspection,
    },
    publication_id: publicationId,
    blueprint_id: pub.recipeId,
    title: blueprint.title,
    description: pub.description,
    publication_safety: blueprint.publication_safety,
    rows: safeOutput.rows,
    columns: safeOutput.columns,
    types: safeOutput.types,
    row_count: safeOutput.rows.length,
    freshness,
    render_hint: blueprint.render_hint,
    next_action:
      "Consume rows as the canonical object-shaped result set. Columns is metadata for display order. Check freshness before treating recent empty or partial rows as final. This public URL is read-only and scoped to the published blueprint+params.",
  });
});

function safeJson<T = unknown>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

export default router;
export { publicRouter };
