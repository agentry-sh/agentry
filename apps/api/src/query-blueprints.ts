import {
  getQueryBlueprintTemplate,
  interpolateQuery,
  listQueryBlueprintTemplates,
  prepareQueryBlueprintExecution,
  QUERY_BLUEPRINT_CATALOG,
  resolveQueryBlueprintParams,
  type QueryBlueprintTemplate,
  type QueryBlueprintParam as CatalogQueryBlueprintParam,
  type QueryBlueprintAutomationReadiness,
  type ParameterizedRequiredEventProperty,
  type RenderHint,
} from "./query-blueprint-catalog.js";

export type QueryBlueprintBackend = QueryBlueprintTemplate["backend"];
export type QueryBlueprintParam = CatalogQueryBlueprintParam;
export type QueryBlueprintRenderHint = RenderHint;
export type QueryBlueprintReportReadiness = QueryBlueprintAutomationReadiness;
export type QueryBlueprintParameterizedRequiredEventProperty =
  ParameterizedRequiredEventProperty;

export interface QueryBlueprint extends Omit<QueryBlueprintTemplate, "id"> {
  id: string;
}

export const QUERY_BLUEPRINTS: QueryBlueprint[] = QUERY_BLUEPRINT_CATALOG;

export function getQueryBlueprint(id: string): QueryBlueprint | null {
  return getQueryBlueprintTemplate(id);
}

export function listQueryBlueprints(category?: string): QueryBlueprint[] {
  return listQueryBlueprintTemplates(category);
}

export type QueryBlueprintPublicationSafetyViolation =
  | "non_analytics_backend"
  | "public_access_denied"
  | "not_safe_aggregate"
  | "non_aggregate_output"
  | "identifier_columns"
  | "arbitrary_segment_property";

const IDENTIFIER_OUTPUT_COLUMNS = new Set([
  "account_id",
  "distinct_id",
  "email",
  "ip",
  "ip_address",
  "person_id",
  "session_id",
  "session_recording_id",
  "user_email",
  "user_id",
]);

function isIdentifierOutputColumn(column: string): boolean {
  const normalized = column.toLowerCase();
  return IDENTIFIER_OUTPUT_COLUMNS.has(normalized) ||
    normalized.endsWith("_id") ||
    normalized.endsWith("_email") ||
    normalized.endsWith("_phone") ||
    normalized.endsWith("_ip") ||
    normalized === "address" ||
    normalized.endsWith("_address");
}

/**
 * Publication is a separate, stricter boundary than owner-side execution.
 * Metadata must explicitly allow it, and structural checks fail closed if a
 * future catalog edit accidentally adds identifiers or a caller-selected
 * property projection without updating that metadata.
 */
export function getQueryBlueprintPublicationSafetyViolations(
  blueprint: QueryBlueprint,
): QueryBlueprintPublicationSafetyViolation[] {
  const violations = new Set<QueryBlueprintPublicationSafetyViolation>();
  const safety = blueprint.publication_safety;

  if (blueprint.backend !== "analytics") violations.add("non_analytics_backend");
  if (safety.public_access !== "allowed") violations.add("public_access_denied");
  if (safety.status !== "safe_aggregate") violations.add("not_safe_aggregate");
  if (safety.output_granularity !== "aggregate") violations.add("non_aggregate_output");

  const declaredIdentifiers = safety.identifier_columns.length > 0;
  const inferredIdentifiers = blueprint.expected_columns.some(isIdentifierOutputColumn);
  if (declaredIdentifiers || inferredIdentifiers) violations.add("identifier_columns");

  const projectsCallerSelectedProperty =
    /\bproperties\s*\[\s*['"]\{\{[^}]+\}\}['"]\s*\]/i.test(blueprint.query);
  if (safety.accepts_arbitrary_segment_property || projectsCallerSelectedProperty) {
    violations.add("arbitrary_segment_property");
  }

  return [...violations];
}

export function isQueryBlueprintPublishable(blueprint: QueryBlueprint): boolean {
  return getQueryBlueprintPublicationSafetyViolations(blueprint).length === 0;
}

export function serializeQueryBlueprint(blueprint: QueryBlueprint) {
  const publishable = isQueryBlueprintPublishable(blueprint);
  const endpoints: { run: string; publish?: string } = {
    run: `/v1/projects/:project_id/query-blueprints/${blueprint.id}/run`,
  };
  if (publishable) endpoints.publish = "/v1/projects/:project_id/public-queries";

  return {
    id: blueprint.id,
    kind: "query_blueprint" as const,
    title: blueprint.title,
    description: blueprint.description,
    category: blueprint.category,
    backend: blueprint.backend,
    publication_safety: blueprint.publication_safety,
    params: blueprint.params,
    query: blueprint.query,
    expected_columns: blueprint.expected_columns,
    render_hint: blueprint.render_hint,
    example_user_question: blueprint.example_user_question,
    ...(blueprint.example_params ? { example_params: blueprint.example_params } : {}),
    ...(blueprint.recommended_segment_properties
      ? { recommended_segment_properties: blueprint.recommended_segment_properties }
      : {}),
    ...(blueprint.required_event_properties
      ? { required_event_properties: blueprint.required_event_properties }
      : {}),
    ...(blueprint.parameterized_required_event_properties
      ? {
          parameterized_required_event_properties:
            blueprint.parameterized_required_event_properties,
        }
      : {}),
    ...(blueprint.strict_params ? { strict_params: true } : {}),
    ...(blueprint.query_builder ? { query_builder: blueprint.query_builder } : {}),
    ...(blueprint.required_event_params
      ? { required_event_params: blueprint.required_event_params }
      : {}),
    ...(blueprint.required_event_list_param
      ? { required_event_list_param: blueprint.required_event_list_param }
      : {}),
    ...(blueprint.automation_readiness
      ? { automation_readiness: blueprint.automation_readiness }
      : {}),
    ...(blueprint.automation_verification
      ? { automation_verification: blueprint.automation_verification }
      : {}),
    endpoints,
    publishable,
    next_action:
      publishable
        ? "Before running this analytics template for a product answer, compare its params with the saved signal map, current verified onboarding receipt, event names, and property keys. Query blueprints are executable templates, not answer-readiness proof. Blueprint defaults are examples, not proof of the customer's funnel; pass approved events/properties as params. If parameterized_required_event_properties is present, resolve the named params first and verify that exact event/property pair with event-property-keys. Publish with POST /v1/projects/:project_id/public-queries only when the user asked for browser-safe reports or dashboards."
        : blueprint.automation_verification
          ? "Use this only as server-owned post-deploy verification evidence. Preserve every exact param and the [deployed_at,checked_at) window. Case recurrence proves the outcome; approved deploy traffic proves the observation opportunity. Never treat zero recurrence with zero traffic as success, never substitute a different run/case/deploy, and never use either verification blueprint as a scheduled-report or public-query source."
        : blueprint.automation_readiness
          ? "For unattended execution, source scheduled_for only from the server-issued trigger receipt, preserve the exact declared params, and require automation_readiness.expected_rows with the exact row_identity order and every automation_readiness.column value true. Direct owner execution may pass an explicit historical scheduled_for. Never move the anchor or widen the period to manufacture readiness; false sample_ready rows are a truthful wait/telemetry result. This automation source is not public-query publishable."
        : blueprint.backend === "analytics"
          ? "Run this template only through the owner-authenticated query-blueprint endpoint. Compare its params with the saved signal map, current verified onboarding receipt, event names, and property keys first. If parameterized_required_event_properties is present, resolve and verify the exact event/property pair before running it. publication_safety explains why it cannot be made public: identifier-bearing rows and caller-selected segment values stay private even when the backend is analytics. Choose a safe_aggregate blueprint for browser or shareable output."
        : "Run this deterministic owner-side query template with POST /v1/projects/:project_id/query-blueprints/:blueprint_id/run. Operational blueprints cover Agentry-owned cases, errors, deploys, and related tables; they are not browser-publishable. Use the typed cases/deploys endpoints from server-side or agent code for reports, dashboards, or automations.",
  };
}

export {
  interpolateQuery,
  prepareQueryBlueprintExecution,
  resolveQueryBlueprintParams,
};
