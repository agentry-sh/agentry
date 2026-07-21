import { Hono } from "hono";
import {
  TELEMETRY_DATA_BOUNDARY,
  errors,
  prepareTelemetryObservation,
} from "@agentrysh/shared";
import { getDb } from "../db.js";
import { requireApiKey, requireProjectAccess } from "../middleware.js";
import { hogQlRowsToObjects, isPosthogConfigured, runHogQl } from "../posthog.js";
import {
  getQueryBlueprint,
  listQueryBlueprints,
  prepareQueryBlueprintExecution,
  serializeQueryBlueprint,
} from "../query-blueprints.js";
import { assertQueryBlueprintInputReadiness } from "../query-blueprint-readiness.js";
import type { AppBindings } from "../env.js";
import { runOperationalBlueprintRows } from "../operational-blueprints.js";
import { readOptionalBoundedJson } from "../bounded-json.js";

const router = new Hono<AppBindings>();

function readinessBoolean(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

function evaluateAutomationReadiness(
  blueprint: NonNullable<ReturnType<typeof getQueryBlueprint>>,
  rows: Array<Record<string, unknown>>,
) {
  const contract = blueprint.automation_readiness;
  if (!contract) return null;
  const observedIdentity = rows.map((row) =>
    String(row[contract.row_identity.column] ?? "")
  );
  const identityMatches =
    observedIdentity.length === contract.row_identity.values.length &&
    observedIdentity.every((value, index) =>
      value === contract.row_identity.values[index]
    );
  const failingRows = rows
    .filter((row) => readinessBoolean(row[contract.column]) !== true)
    .map((row) => String(row[contract.row_identity.column] ?? "unknown"));
  const rowCountMatches = rows.length === contract.expected_rows;
  return {
    ...contract,
    observed_rows: rows.length,
    observed_row_identity: observedIdentity,
    row_count_matches: rowCountMatches,
    row_identity_matches: identityMatches,
    failing_rows: failingRows,
    ready: rowCountMatches && identityMatches && failingRows.length === 0,
  };
}

function automationVerificationNextAction(
  blueprint: NonNullable<ReturnType<typeof getQueryBlueprint>>,
  rows: Array<Record<string, unknown>>,
): string | null {
  const contract = blueprint.automation_verification;
  if (!contract) return null;
  const value = rows[0]?.[contract.count_column];
  const count = typeof value === "number" && Number.isFinite(value)
    ? value
    : null;
  if (contract.kind === "deploy_traffic_sample") {
    return count === 0
      ? "Zero approved traffic was observed for this exact deploy window. Do not treat zero recurrence as a verified fix; keep verification pending or fail at the immutable deadline."
      : "Use this exact sample_count only as observation-opportunity proof, paired with automation_case_recurrence_after_deploy for the same deploy and [deployed_at,checked_at) window. Traffic alone does not prove the fix.";
  }
  return "Pair this exact recurrence_count with automation_deploy_traffic_sample for the same trusted deploy and [deployed_at,checked_at) window. Zero recurrence without sufficient approved traffic never proves the fix.";
}

router.get("/v1/query-blueprints", (c) => {
  const category = c.req.query("category");
  const blueprints = listQueryBlueprints(category ?? undefined).map(serializeQueryBlueprint);
  return c.json({
    count: blueprints.length,
    categories: ["users", "retention", "funnels", "events", "errors", "deploys"],
    kind: "query_blueprints",
    blueprints,
    next_action:
      "Start from the saved signal map, current verified onboarding receipt, event names, and property keys, then pick a deterministic query blueprint when the user asks for common rows or metrics. For funnel blueprints, pass the approved signal-map events as params instead of relying on generic defaults. For custom analysis, use POST /v1/projects/:project_id/analytics/query with HogQL.",
  });
});

router.get("/v1/query-blueprints/:id", (c) => {
  const id = c.req.param("id");
  const blueprint = getQueryBlueprint(id);
  if (!blueprint) throw errors.notFound("query_blueprint");
  return c.json(serializeQueryBlueprint(blueprint));
});

router.post(
  "/v1/projects/:project_id/query-blueprints/:blueprint_id/run",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    const blueprintId = c.req.param("blueprint_id");
    const proj = await requireProjectAccess(c, projectId);
    const blueprint = getQueryBlueprint(blueprintId);
    if (!blueprint) throw errors.notFound("query_blueprint");

    let body: { params?: unknown } & Record<string, unknown> = {};
    const rawBody = await readOptionalBoundedJson(c, 65_536);
    if (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody)) {
      body = rawBody as typeof body;
    } else if (rawBody !== undefined && blueprint.strict_params) {
      throw errors.invalidPayload({ reason: "body must be an object" });
    }
    if (blueprint.strict_params) {
      const unknownBodyFields = Object.keys(body).filter((key) => key !== "params");
      if (unknownBodyFields.length > 0) {
        throw errors.invalidPayload({
          reason: `unknown request field(s): ${unknownBodyFields.sort().join(", ")}`,
        });
      }
    }
    const rawParams = body.params ?? {};
    if (
      !rawParams ||
      typeof rawParams !== "object" ||
      Array.isArray(rawParams)
    ) {
      throw errors.invalidPayload({ reason: "params must be an object" });
    }
    let prepared: ReturnType<typeof prepareQueryBlueprintExecution>;
    try {
      prepared = prepareQueryBlueprintExecution(
        blueprint,
        rawParams as Record<string, unknown>,
      );
    } catch (err) {
      throw errors.invalidPayload({
        reason: "params don't satisfy blueprint.params",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    const params = prepared.params;
    const db = getDb(c.env);
    const inputReadiness = await assertQueryBlueprintInputReadiness(
      db,
      proj.id,
      blueprint,
      params,
    );

    if (blueprint.backend === "analytics") {
      if (!isPosthogConfigured(c.env)) {
        throw errors.posthogConnectionRequired({ operation: "run_query_blueprint", blueprint_id: blueprint.id });
      }
      const queryStartedAt = Date.now();
      const out = await runHogQl(c.env, proj.id, prepared.query, { cacheBust: true });
      const rows = hogQlRowsToObjects(out.results, out.columns, blueprint.expected_columns);
      const outputObservation = prepareTelemetryObservation({
        rows,
        columns: out.columns ?? blueprint.expected_columns,
      });
      const safeOutput = outputObservation.content as {
        rows: Array<Record<string, unknown>>;
        columns: unknown;
      };
      const queryDurationMs = Date.now() - queryStartedAt;
      const automationReadiness = evaluateAutomationReadiness(
        blueprint,
        safeOutput.rows,
      );
      const verificationNextAction = automationVerificationNextAction(
        blueprint,
        safeOutput.rows,
      );
      const freshness = {
        source: "posthog_hogql",
        consistency: "eventual",
        cache_bust: true,
        queried_at: new Date(queryStartedAt).toISOString(),
        query_duration_ms: queryDurationMs,
        retry_after_ms: 30_000,
        status: "complete_for_query_time",
        next_action:
          "Freshly ingested analytics can take a short time to appear in PostHog-backed query-blueprint runs. " +
          "If this run is verifying events sent in the last few minutes and rows look empty or partial, " +
          "treat the result as pending, wait at least retry_after_ms, then re-run the same blueprint with the same exact params before making customer-facing claims.",
      };
      return c.json({
        data_boundary: {
          ...TELEMETRY_DATA_BOUNDARY,
          applies_to: "rows and columns",
          inspection: outputObservation.inspection,
        },
        blueprint_id: blueprint.id,
        title: blueprint.title,
        backend: "analytics",
        rows: safeOutput.rows,
        columns: safeOutput.columns,
        row_count: safeOutput.rows.length,
        ...(inputReadiness ? { input_readiness: inputReadiness } : {}),
        ...(automationReadiness
          ? { automation_readiness: automationReadiness }
          : {}),
        ...(blueprint.automation_verification
          ? { automation_verification: blueprint.automation_verification }
          : {}),
        freshness,
        render_hint: blueprint.render_hint,
        next_action: automationReadiness && !automationReadiness.ready
          ? "Do not generate or publish the scheduled funnel recommendation yet. Keep the exact scheduled_for and period unchanged, use automation_readiness plus each row's readiness_status to identify insufficient traffic or absent selected events, then retry only after the configured schedule or freshness delay."
          : verificationNextAction
            ? verificationNextAction
          : "Format these rows according to render_hint and check freshness before treating recent empty or partial rows as final. For funnels, compute drop-off percentages between returned step counts. For dashboard code, prefer a bounded fixed batch or public-query publication only when the user asked for browser/shareable output.",
      });
    }

    const queryStartedAt = Date.now();
    const rows = await runOperationalBlueprintRows(c.env, db, projectId, blueprint, params);
    const outputObservation = prepareTelemetryObservation({
      rows,
      columns: blueprint.expected_columns,
    });
    const safeOutput = outputObservation.content as {
      rows: Array<Record<string, unknown>>;
      columns: unknown;
    };

    const queryDurationMs = Date.now() - queryStartedAt;
    const freshness = {
      source: "agentry_db",
      consistency: "read_after_write",
      cache_bust: false,
      queried_at: new Date(queryStartedAt).toISOString(),
      query_duration_ms: queryDurationMs,
      retry_after_ms: 0,
      status: "complete_for_query_time",
      next_action:
        "Operational query-blueprint rows are read from Agentry's project tables. Re-run after new error, case, or deploy ingest if you are checking data produced in the current session.",
    };
    const verificationNextAction = automationVerificationNextAction(
      blueprint,
      safeOutput.rows,
    );

    return c.json({
      data_boundary: {
        ...TELEMETRY_DATA_BOUNDARY,
        applies_to: "rows and columns",
        inspection: outputObservation.inspection,
      },
      blueprint_id: blueprint.id,
      title: blueprint.title,
      backend: blueprint.backend,
      rows: safeOutput.rows,
      columns: safeOutput.columns,
      row_count: safeOutput.rows.length,
      ...(blueprint.automation_verification
        ? { automation_verification: blueprint.automation_verification }
        : {}),
      freshness,
      render_hint: blueprint.render_hint,
      next_action:
        verificationNextAction ??
        "Consume rows as the canonical object-shaped result set.",
    });
  },
);

export default router;
