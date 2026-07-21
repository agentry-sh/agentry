import { sql } from "drizzle-orm";
import { cases, deploys } from "@agentry/db/schema";

export const SYNTHETIC_VERIFY_ERROR_TYPE = "AgentryVerifyError";
export const SYNTHETIC_VERIFY_DEPLOY_SHA = "agentry-verify";
export const SYNTHETIC_VERIFY_ENVIRONMENT = "agentry-http-verify";
export const SYNTHETIC_VERIFY_DEPLOY_ENVIRONMENT = "agentry-verify";
export const SYNTHETIC_VERIFY_SOURCE = "install_verify_http";
export const SYNTHETIC_VERIFY_ANALYTICS_EVENTS = [
  "install.verify.synthetic",
  "install.verify.http.synthetic",
] as const;
export const CUSTOMER_ANALYTICS_EXCLUDED_BOOLEAN_PROPERTIES = [
  "synthetic",
  "agentry_rehearsal_event",
  "agentry_test_event",
  "test_event",
] as const;
export const CUSTOMER_ANALYTICS_EXCLUDED_SOURCE_PROPERTIES = [
  "source",
  "event_source",
] as const;
export const CUSTOMER_ANALYTICS_EXCLUDED_SOURCE_VALUES = [
  SYNTHETIC_VERIFY_SOURCE,
  "direct_rehearsal_ingest",
  "agentry_rehearsal",
  "install_rehearsal",
  "codex_rehearsal",
  "test_ingest",
] as const;
export const ONBOARDING_PROOF_ANALYTICS_PROPERTY =
  "agentry_onboarding_proof" as const;
export const ONBOARDING_PROOF_ERROR_MARKER_PROPERTY =
  "agentry_onboarding_failure" as const;

function hogqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function hogqlPropertyString(property: string): string {
  return `lower(ifNull(toString(properties['${property.replace(/'/g, "''")}']), ''))`;
}

export const customerCaseFilter = sql`
  ${cases.providerEventClassification} = 'customer_exception'
  AND ${cases.errorType} != ${SYNTHETIC_VERIFY_ERROR_TYPE}
  AND COALESCE(${cases.lastDeploySha}, '') != ${SYNTHETIC_VERIFY_DEPLOY_SHA}
`;

export const customerDeployFilter = sql`
  COALESCE(${deploys.branch}, '') != ${SYNTHETIC_VERIFY_DEPLOY_ENVIRONMENT}
  AND COALESCE(${deploys.environment}, '') != ${SYNTHETIC_VERIFY_DEPLOY_ENVIRONMENT}
  AND COALESCE(json_extract(${deploys.extraJson}, '$.source'), '') != ${SYNTHETIC_VERIFY_SOURCE}
`;

// Only exact scoped CI receipts may drive automatic stamping, readiness,
// verification, or causal deploy analytics. The live schema admits no legacy
// or unbound deploy rows; these predicates remain defense in depth.
export const trustedCustomerDeployFilter = sql`
  ${customerDeployFilter}
  AND ${deploys.trustLevel} = 'trusted_ci'
  AND ${deploys.credentialKind} = 'ci_deploy'
  AND ${deploys.credentialId} IS NOT NULL
`;

export const CUSTOMER_CASE_SQL =
  "provider_event_classification = 'customer_exception' " +
  `AND error_type != '${SYNTHETIC_VERIFY_ERROR_TYPE}' ` +
  `AND COALESCE(last_deploy_sha, '') != '${SYNTHETIC_VERIFY_DEPLOY_SHA}'`;

export const CUSTOMER_DEPLOY_SQL =
  `COALESCE(branch, '') != '${SYNTHETIC_VERIFY_DEPLOY_ENVIRONMENT}' ` +
  `AND COALESCE(environment, '') != '${SYNTHETIC_VERIFY_DEPLOY_ENVIRONMENT}' ` +
  `AND COALESCE(json_extract(extra_json, '$.source'), '') != '${SYNTHETIC_VERIFY_SOURCE}'`;

export const TRUSTED_CUSTOMER_DEPLOY_SQL =
  `${CUSTOMER_DEPLOY_SQL} ` +
  "AND trust_level = 'trusted_ci' " +
  "AND credential_kind = 'ci_deploy' " +
  "AND credential_id IS NOT NULL";

export const CUSTOMER_ANALYTICS_HOGQL_FILTER =
  `event NOT IN (${hogqlStringList(SYNTHETIC_VERIFY_ANALYTICS_EVENTS)}) ` +
  `AND ${hogqlPropertyString(ONBOARDING_PROOF_ANALYTICS_PROPERTY)} = '' ` +
  CUSTOMER_ANALYTICS_EXCLUDED_BOOLEAN_PROPERTIES.map(
    (property) => `AND ${hogqlPropertyString(property)} NOT IN ('true', '1')`,
  ).join(" ") +
  " " +
  CUSTOMER_ANALYTICS_EXCLUDED_SOURCE_PROPERTIES.map(
    (property) =>
      `AND ${hogqlPropertyString(property)} NOT IN (${hogqlStringList(
        CUSTOMER_ANALYTICS_EXCLUDED_SOURCE_VALUES,
      )})`,
  ).join(" ");

export const CUSTOMER_ANALYTICS_FILTER_EXPLANATION =
  "Customer analytics reads exclude Agentry onboarding-proof/install-verify rows and rows explicitly marked as rehearsal/test traffic via synthetic, agentry_rehearsal_event, agentry_test_event, test_event, source, or event_source properties.";

const HOGQL_TABLE_REF_STOP_WORDS = [
  "where",
  "prewhere",
  "on",
  "using",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "settings",
  "union",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "join",
  "final",
  "sample",
];

const EVENTS_TABLE_REFERENCE_PATTERN = new RegExp(
  String.raw`(^|[\s(,])(from|join)\s+events(?:\s+(?:as\s+)?(?!${HOGQL_TABLE_REF_STOP_WORDS.join("\\b|")}\\b)([A-Za-z_][A-Za-z0-9_]*))?`,
  "gi",
);

export interface CustomerAnalyticsHogqlFilterResult {
  query: string;
  filterApplied: boolean;
  includeSynthetic: boolean;
  reason: "server_enforced" | "disabled_by_request" | "no_events_table_reference";
}

const FILTERED_EVENTS_COLUMNS =
  "uuid, event, properties, timestamp, distinct_id, elements_chain, created_at, person_id";

export function applyCustomerAnalyticsHogqlFilter(
  query: string,
  opts: { includeSynthetic?: boolean } = {},
): CustomerAnalyticsHogqlFilterResult {
  const includeSynthetic = opts.includeSynthetic === true;
  if (includeSynthetic) {
    return {
      query,
      filterApplied: false,
      includeSynthetic: true,
      reason: "disabled_by_request",
    };
  }

  let filterApplied = false;
  // Explicit column list, not SELECT *: newer PostHog builds expand `*` on the
  // events table into lazy error-tracking/person fields while dropping
  // `properties`, so a star-wrapped subquery makes any outer `properties.*`
  // reference fail with ClickHouse code 47 ("cannot be resolved from
  // subquery"). Listing the physical event columns keeps the wrap stable
  // across PostHog upgrades.
  const filteredEventsTable = `(SELECT ${FILTERED_EVENTS_COLUMNS} FROM events WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER})`;
  const rewritten = query.replace(
    EVENTS_TABLE_REFERENCE_PATTERN,
    (_match, prefix: string, clause: string, alias: string | undefined) => {
      filterApplied = true;
      return `${prefix}${clause} ${filteredEventsTable} AS ${alias ?? "events"}`;
    },
  );

  return {
    query: rewritten,
    filterApplied,
    includeSynthetic: false,
    reason: filterApplied ? "server_enforced" : "no_events_table_reference",
  };
}
