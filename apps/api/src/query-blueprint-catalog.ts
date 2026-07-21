// Query blueprint catalog: canonical templates for the most-asked questions.
//
// Premise: agentry has no dashboard. Instead, the user's Claude Code asks
// natural-language questions ("how many users do we have by cohort?", "show me
// the signup funnel with drop-offs") and runs a query blueprint that returns
// rows + a render_hint. The agent assembles a markdown table, ASCII bar chart, or
// Mermaid diagram in chat.
//
// Two backends:
//   - "analytics"  → HogQL query against the user's PostHog project
//   - "operational" → bounded server executors over PostHog issues plus Agentry control/deploy tables

import {
  CUSTOMER_ANALYTICS_HOGQL_FILTER,
  CUSTOMER_CASE_SQL,
  TRUSTED_CUSTOMER_DEPLOY_SQL,
} from "./customer-data.js";

export type QueryBlueprintBackend = "analytics" | "operational";

export interface QueryBlueprintParam {
  name: string;
  type: "string" | "number";
  description: string;
  default?: string | number;
  required?: boolean;
  /** Additional validation applied before interpolation. */
  format?: "rfc3339" | "event_name" | "event_name_list_json";
  /** Numeric params can opt into exact integer-only semantics. */
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  minimum_length?: number;
  maximum_length?: number;
  /** For timestamp params, require this value to be strictly after another timestamp param. */
  after_param?: string;
  /** Optional upper bound for the exact interval from after_param. */
  maximum_interval_seconds?: number;
}

export interface QueryBlueprintAutomationReadiness {
  kind: "all_rows_boolean";
  column: string;
  expected_rows: number;
  row_identity: {
    column: string;
    values: string[];
  };
}

export interface QueryBlueprintAutomationVerification {
  kind: "case_recurrence" | "deploy_traffic_sample";
  count_column: "recurrence_count" | "sample_count";
  expected_rows: 1;
  exact_window: {
    start_param: "deployed_at";
    end_param: "checked_at";
    bounds: "[start,end)";
    maximum_seconds: 2_592_000;
  };
}

export interface ParameterizedRequiredEventProperty {
  /** Query param whose resolved value names the event to check. */
  event_param: string;
  /** Query param whose resolved value names the property to check on that event. */
  property_param: string;
  check_endpoint: string;
  description: string;
}

export interface RenderHint {
  type: "table" | "line" | "bar" | "funnel" | "scalar" | "stacked_bar";
  /** Column or field for the X axis / categorical key. */
  x?: string;
  /** Column for Y axis / value. */
  y?: string;
  /** For funnels: ordered list of column names (counts at each step). */
  stages?: string[];
  /** Short title the agent should use as the chart title. */
  title: string;
  /** What the agent should remind the user of in their explanation. */
  notes?: string[];
}

export interface QueryBlueprintPublicationSafety {
  /** Stable policy class agents can inspect before proposing a public URL. */
  status:
    | "safe_aggregate"
    | "private_identifiers"
    | "private_dynamic_segment"
    | "private_automation"
    | "private_operational";
  /** Public endpoints fail closed unless this is allowed and every invariant below holds. */
  public_access: "allowed" | "denied";
  output_granularity: "aggregate" | "row_level";
  /** Direct person/session/account identifiers returned by the blueprint, if any. */
  identifier_columns: readonly string[];
  /** True when a caller can choose an arbitrary event property whose values become output rows. */
  accepts_arbitrary_segment_property: boolean;
  reason: string;
}

const SAFE_AGGREGATE_PUBLICATION = Object.freeze({
  status: "safe_aggregate",
  public_access: "allowed",
  output_granularity: "aggregate",
  identifier_columns: Object.freeze([]),
  accepts_arbitrary_segment_property: false,
  reason:
    "Returns aggregate analytics only; it exposes no person, account, or session identifiers and cannot select an arbitrary segment property.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_DYNAMIC_SEGMENT_PUBLICATION = Object.freeze({
  status: "private_dynamic_segment",
  public_access: "denied",
  output_granularity: "aggregate",
  identifier_columns: Object.freeze([]),
  accepts_arbitrary_segment_property: true,
  reason:
    "The caller chooses an arbitrary event property whose raw values become result rows; those values can contain identifiers or sensitive customer data.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_IDENTIFIER_PUBLICATION = Object.freeze({
  status: "private_identifiers",
  public_access: "denied",
  output_granularity: "row_level",
  identifier_columns: Object.freeze([
    "distinct_id",
    "session_id",
    "session_recording_id",
  ]),
  accepts_arbitrary_segment_property: false,
  reason:
    "Returns row-level person and session identifiers for owner-side investigation.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_AUTOMATION_REPORT_PUBLICATION = Object.freeze({
  status: "private_automation",
  public_access: "denied",
  output_granularity: "aggregate",
  identifier_columns: Object.freeze([]),
  accepts_arbitrary_segment_property: false,
  reason:
    "This exact-period aggregate is a run-bound automation source. Its scheduled_for anchor must come from the trusted trigger receipt; it is not a free-running public dashboard query.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_AUTOMATION_VERIFICATION_PUBLICATION = Object.freeze({
  status: "private_automation",
  public_access: "denied",
  output_granularity: "aggregate",
  identifier_columns: Object.freeze([]),
  accepts_arbitrary_segment_property: false,
  reason:
    "This aggregate is server-owned post-deploy verification evidence bound to an exact run/deploy window. It is not a public dashboard or scheduled-report source.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_OPERATIONAL_ROW_PUBLICATION = Object.freeze({
  status: "private_operational",
  public_access: "denied",
  output_granularity: "row_level",
  identifier_columns: Object.freeze([]),
  accepts_arbitrary_segment_property: false,
  reason:
    "Reads owner-only operational data; public publications are limited to aggregate analytics blueprints.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_OPERATIONAL_AGGREGATE_PUBLICATION = Object.freeze({
  status: "private_operational",
  public_access: "denied",
  output_granularity: "aggregate",
  identifier_columns: Object.freeze([]),
  accepts_arbitrary_segment_property: false,
  reason:
    "Returns an aggregate, but reads owner-only operational data; public publications are limited to aggregate analytics blueprints.",
} satisfies QueryBlueprintPublicationSafety);

const PRIVATE_OPERATIONAL_IDENTIFIER_PUBLICATION = Object.freeze({
  status: "private_operational",
  public_access: "denied",
  output_granularity: "row_level",
  identifier_columns: Object.freeze(["user_id"]),
  accepts_arbitrary_segment_property: false,
  reason:
    "Returns direct user identifiers from owner-only operational data and must stay behind owner authentication.",
} satisfies QueryBlueprintPublicationSafety);

export interface QueryBlueprintTemplate {
  id: string;
  category:
    | "users"
    | "funnels"
    | "events"
    | "errors"
    | "deploys"
    | "retention";
  title: string;
  description: string;
  backend: QueryBlueprintBackend;
  publication_safety: QueryBlueprintPublicationSafety;
  params: QueryBlueprintParam[];
  /** HogQL template. {{paramName}} placeholders are interpolated server-side. */
  query: string;
  /** Optional bounded server-side builder for a query whose shape depends on validated params. */
  query_builder?: "ordered_funnel_period_compare";
  expected_columns: string[];
  render_hint: RenderHint;
  example_user_question: string;
  example_params?: Record<string, string | number>;
  recommended_segment_properties?: string[];
  required_event_properties?: Record<string, string[]>;
  parameterized_required_event_properties?: ParameterizedRequiredEventProperty[];
  /** Reject every caller-supplied key that is not declared in params. */
  strict_params?: boolean;
  /** Event-name params that must be distinct and approved by the saved signal map. */
  required_event_params?: string[];
  /** Canonical JSON-string param containing distinct ordered approved event names. */
  required_event_list_param?: string;
  /** Machine-readable report gate; callers must not infer readiness from arbitrary columns. */
  automation_readiness?: QueryBlueprintAutomationReadiness;
  /** Server verification role. Deliberately separate from scheduled-report readiness. */
  automation_verification?: QueryBlueprintAutomationVerification;
}

export const QUERY_BLUEPRINT_CATALOG: QueryBlueprintTemplate[] = [
  // ---------- USERS ----------
  {
    id: "active_users_daily",
    category: "users",
    title: "Daily Active Users (last N days)",
    description: "Count of unique distinct_ids per day from analytics events.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "days", type: "number", description: "Lookback window in days", default: 14 },
    ],
    query: `SELECT toDate(timestamp) AS day, count(DISTINCT distinct_id) AS dau
FROM events
WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
  AND timestamp > now() - INTERVAL {{days}} DAY
GROUP BY day
ORDER BY day`,
    expected_columns: ["day", "dau"],
    render_hint: {
      type: "line",
      x: "day",
      y: "dau",
      title: "Daily Active Users",
      notes: ["DAU counts unique distinct_id per day. Anonymous users count if they generated any event."],
    },
    example_user_question: "how many active users did we have each day this week?",
  },
  {
    id: "users_by_cohort_signup_week",
    category: "users",
    title: "Users by signup-week cohort",
    description: "Groups users by the week they first signed up; useful for cohort sizing.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "weeks", type: "number", description: "Lookback in weeks", default: 12 },
      { name: "signup_event", type: "string", description: "The event that marks signup. Choose this from the saved signal map or observed event names.", required: true },
    ],
    query: `SELECT
  cohort_week,
  count() AS users
FROM (
  SELECT distinct_id, toMonday(first_seen_at) AS cohort_week
  FROM (
    SELECT distinct_id, min(timestamp) AS first_seen_at
    FROM events
    WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
      AND event = '{{signup_event}}'
      AND timestamp > now() - INTERVAL {{weeks}} WEEK
    GROUP BY distinct_id
  )
)
GROUP BY cohort_week
ORDER BY cohort_week`,
    expected_columns: ["cohort_week", "users"],
    render_hint: {
      type: "bar",
      x: "cohort_week",
      y: "users",
      title: "New users per signup-week cohort",
    },
    example_user_question: "show me users grouped by the week they signed up",
  },

  // ---------- RETENTION ----------
  {
    id: "weekly_retention",
    category: "retention",
    title: "Weekly retention by signup cohort",
    description:
      "For each signup-week cohort, the % of users who performed the chosen product activity event in week 1, 2, 3, ...",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "weeks", type: "number", description: "How many cohort weeks to compute", default: 8 },
      { name: "signup_event", type: "string", description: "Cohort-defining event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "activity_event", type: "string", description: "The event that proves a user returned or got value. Choose an approved product activity event from the signal map; do not use background/server noise.", required: true },
    ],
    query: `WITH signups AS (
  SELECT distinct_id, cohort
  FROM (
    SELECT distinct_id, toMonday(first_seen_at) AS cohort
    FROM (
      SELECT distinct_id, min(timestamp) AS first_seen_at
      FROM events
      WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
        AND event = '{{signup_event}}'
        AND timestamp > now() - INTERVAL {{weeks}} WEEK
      GROUP BY distinct_id
    )
  )
),
activity AS (
  SELECT distinct_id, active_week
  FROM (
    SELECT distinct_id, toMonday(timestamp) AS active_week
    FROM events
    WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
      AND event = '{{activity_event}}'
      AND timestamp > now() - INTERVAL {{weeks}} WEEK
    GROUP BY distinct_id, active_week
  )
),
cohort_sizes AS (
  SELECT cohort, count(DISTINCT distinct_id) AS cohort_size
  FROM signups
  GROUP BY cohort
)
SELECT
  s.cohort AS cohort_week,
  dateDiff('week', s.cohort, a.active_week) AS week_offset,
  cs.cohort_size AS cohort_size,
  count(DISTINCT s.distinct_id) AS retained_users,
  round(100.0 * count(DISTINCT s.distinct_id) / nullIf(cs.cohort_size, 0), 2) AS retention_pct
FROM signups s
JOIN activity a ON s.distinct_id = a.distinct_id
JOIN cohort_sizes cs ON cs.cohort = s.cohort
WHERE a.active_week >= s.cohort
GROUP BY cohort_week, week_offset, cohort_size
ORDER BY cohort_week, week_offset`,
    expected_columns: ["cohort_week", "week_offset", "cohort_size", "retained_users", "retention_pct"],
    render_hint: {
      type: "stacked_bar",
      x: "cohort_week",
      y: "retention_pct",
      title: "Weekly retention percentage by cohort",
      notes: [
        "week_offset=0 is the cohort itself. retention_pct is retained_users divided by cohort_size.",
        "activity_event defines retention. Pick a source-backed product activity event from the saved signal map instead of counting any event.",
        "Render as a triangle/cohort heatmap if your UI supports it; markdown table is fine otherwise.",
      ],
    },
    example_user_question: "what does our weekly retention look like by cohort?",
    example_params: {
      weeks: 8,
      signup_event: "signup_completed",
      activity_event: "activation_completed",
    },
  },

  // ---------- FUNNELS ----------
  {
    id: "funnel_3_step",
    category: "funnels",
    title: "3-step funnel with drop-offs",
    description:
      "Counts users who fired step1, then step2 (after step1), then step3 (after step2). " +
      "Drop-off % between each step is computed by the agent from the returned counts.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "step1", type: "string", description: "First event (entry). Choose this from the saved signal map or observed event names.", required: true },
      { name: "step2", type: "string", description: "Second event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "step3", type: "string", description: "Third event (conversion). Choose this from the saved signal map or observed event names.", required: true },
      { name: "days", type: "number", description: "Lookback window in days", default: 30 },
    ],
    query: `WITH s1 AS (
  SELECT distinct_id, min(timestamp) AS t1
  FROM events
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND event = '{{step1}}' AND timestamp > now() - INTERVAL {{days}} DAY
  GROUP BY distinct_id
),
s2 AS (
  SELECT e.distinct_id, min(e.timestamp) AS t2
  FROM events e
  JOIN s1 ON s1.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.event = '{{step2}}' AND e.timestamp >= s1.t1
  GROUP BY e.distinct_id
),
s3 AS (
  SELECT e.distinct_id, min(e.timestamp) AS t3
  FROM events e
  JOIN s2 ON s2.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.event = '{{step3}}' AND e.timestamp >= s2.t2
  GROUP BY e.distinct_id
)
SELECT
  (SELECT count() FROM s1) AS step1_count,
  (SELECT count() FROM s2) AS step2_count,
  (SELECT count() FROM s3) AS step3_count`,
    expected_columns: ["step1_count", "step2_count", "step3_count"],
    render_hint: {
      type: "funnel",
      stages: ["step1_count", "step2_count", "step3_count"],
      title: "3-step funnel",
      notes: [
        "Compute drop-off % from the returned counts: drop_n = 1 - (step_n+1 / step_n).",
        "Render as a 3-row table (step name, count, drop-off %) or an ASCII funnel.",
      ],
    },
    example_user_question: "what's the drop-off in our signup funnel?",
  },
  {
    id: "ordered_funnel_period_compare",
    category: "funnels",
    title: "Exact current-versus-prior ordered funnel",
    description:
      "Compares a 2–20 step ordered funnel across two adjacent exact half-open periods. " +
      "scheduled_for is the exclusive end of the current period and must come from the trusted schedule receipt in unattended runs; direct owner calls must pass an explicit historical anchor.",
    backend: "analytics",
    publication_safety: PRIVATE_AUTOMATION_REPORT_PUBLICATION,
    strict_params: true,
    required_event_list_param: "funnel_events_json",
    query_builder: "ordered_funnel_period_compare",
    automation_readiness: {
      kind: "all_rows_boolean",
      column: "sample_ready",
      expected_rows: 2,
      row_identity: {
        column: "period",
        values: ["prior", "current"],
      },
    },
    params: [
      {
        name: "scheduled_for",
        type: "string",
        format: "rfc3339",
        description:
          "Trusted trigger-receipt timestamp and exclusive current-window end. Direct owner execution may supply an explicit RFC3339 timestamp with Z or a numeric offset; unattended runners must not invent or move it.",
        required: true,
      },
      {
        name: "period_days",
        type: "number",
        integer: true,
        minimum: 1,
        maximum: 90,
        description: "Exact length of each adjacent comparison period in 24-hour days (1..90).",
        required: true,
      },
      {
        name: "funnel_events_json",
        type: "string",
        format: "event_name_list_json",
        description: "Canonical JSON array of 2–20 distinct approved events in funnel order.",
        required: true,
      },
      {
        name: "minimum_sample_size",
        type: "number",
        integer: true,
        minimum: 1,
        maximum: 100000,
        description:
          "Minimum distinct step1 users required independently in both current and prior rows before sample_ready can be true.",
        required: true,
      },
    ],
    query: "/* generated server-side by ordered_funnel_period_compare after strict param validation */",
    expected_columns: [
      "period",
      "window_start",
      "window_end",
      "funnel_events_json",
      "observed_users_json",
      "counts_json",
      "conversion_percentages_json",
      "overall_conversion_pct",
      "sample_size",
      "minimum_sample_size",
      "all_selected_events_observed",
      "sample_ready",
      "readiness_status",
    ],
    render_hint: {
      type: "table",
      title: "Current versus prior funnel",
      notes: [
        "The two rows are exact adjacent half-open periods: prior then current. window_start is inclusive and window_end is exclusive.",
        "The JSON arrays preserve the exact ordered event list, raw observed-user counts, ordered funnel counts, and step-to-step conversion percentages.",
        "Do not publish conversion recommendations unless both rows have sample_ready=true. A false value is a readiness result, not permission to move scheduled_for or widen the period silently.",
        "Marked onboarding-proof, rehearsal, and test analytics are excluded by the server-owned customer-data filter.",
      ],
    },
    example_user_question:
      "How did our approved signup funnel perform this week versus the prior week?",
    example_params: {
      scheduled_for: "2026-07-13T00:00:00.000Z",
      period_days: 7,
      funnel_events_json: "[\"signup_started\",\"signup_completed\",\"activation_completed\",\"first_value_reached\"]",
      minimum_sample_size: 20,
    },
  },
  {
    id: "funnel_3_step_by_property",
    category: "funnels",
    title: "3-step funnel segmented by property",
    description:
      "Counts users through a 3-step funnel, grouped by a property from the entry event. " +
      "Use this for drop-off by mobile/desktop, platform, browser, source, plan, account type, or any property captured on step1.",
    backend: "analytics",
    publication_safety: PRIVATE_DYNAMIC_SEGMENT_PUBLICATION,
    params: [
      { name: "step1", type: "string", description: "First event (entry). Choose this from the saved signal map or observed event names.", required: true },
      { name: "step2", type: "string", description: "Second event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "step3", type: "string", description: "Third event (conversion). Choose this from the saved signal map or observed event names.", required: true },
      { name: "segment_property", type: "string", description: "Property to group by from step1. Check event-property-keys for that exact event first; do not assume an SDK ambient property exists. Prefer a source-verified business property, or an observed PostHog property such as $device_type, $os, or $browser when its meaning fits the question.", required: true },
      { name: "days", type: "number", description: "Lookback window in days", default: 30 },
    ],
    query: `WITH s1 AS (
  SELECT
    distinct_id,
    min(timestamp) AS t1,
    argMin(
      ifNull(nullIf(toString(properties['{{segment_property}}']), ''), 'unknown'),
      timestamp
    ) AS segment
  FROM events
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND event = '{{step1}}' AND timestamp > now() - INTERVAL {{days}} DAY
  GROUP BY distinct_id
),
s2 AS (
  SELECT e.distinct_id, min(e.timestamp) AS t2
  FROM events e
  JOIN s1 ON s1.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.event = '{{step2}}' AND e.timestamp >= s1.t1
  GROUP BY e.distinct_id
),
s3 AS (
  SELECT e.distinct_id, min(e.timestamp) AS t3
  FROM events e
  JOIN s2 ON s2.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.event = '{{step3}}' AND e.timestamp >= s2.t2
  GROUP BY e.distinct_id
)
SELECT
  s1.segment AS segment,
  count() AS step1_count,
  countIf(s2.distinct_id IS NOT NULL) AS step2_count,
  countIf(s3.distinct_id IS NOT NULL) AS step3_count
FROM s1
LEFT JOIN s2 ON s2.distinct_id = s1.distinct_id
LEFT JOIN s3 ON s3.distinct_id = s1.distinct_id
GROUP BY segment
ORDER BY step1_count DESC
LIMIT 50`,
    expected_columns: ["segment", "step1_count", "step2_count", "step3_count"],
    render_hint: {
      type: "funnel",
      stages: ["step1_count", "step2_count", "step3_count"],
      title: "3-step funnel by segment",
      notes: [
        "Compute drop-off % within each segment from the returned counts.",
        "If segment is unknown, the chosen property is missing on step1; report that as a telemetry gap before over-interpreting the split.",
      ],
    },
    example_user_question: "where does our signup funnel drop off by device type?",
    example_params: {
      step1: "page_view",
      step2: "signup_started",
      step3: "signup_completed",
      segment_property: "$device_type",
      days: 30,
    },
    recommended_segment_properties: ["$device_type", "$os", "$browser", "$is_mobile", "$platform", "$pathname", "source", "plan"],
    parameterized_required_event_properties: [
      {
        event_param: "step1",
        property_param: "segment_property",
        check_endpoint: "/v1/projects/:project_id/event-property-keys?events={{step1}}",
        description:
          "Before running or rendering this segmented funnel, resolve step1 and segment_property from params and confirm the selected property is observed on the selected entry event.",
      },
    ],
  },
  {
    id: "funnel_dropoff_users",
    category: "funnels",
    title: "Users who entered a funnel but did not complete",
    description:
      "Returns bounded distinct_id rows for users who fired an entry event in the lookback window " +
      "but did not later fire the completion event. If the customer records sessions, use the ids only " +
      "to locate candidate recordings directly in PostHog; Agentry never proxies replay snapshots.",
    backend: "analytics",
    publication_safety: PRIVATE_IDENTIFIER_PUBLICATION,
    params: [
      { name: "entry_event", type: "string", description: "Funnel entry event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "completion_event", type: "string", description: "Funnel completion event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "days", type: "number", description: "Lookback window in days", default: 7 },
      { name: "limit", type: "number", description: "Max drop-off users to return for replay review", default: 25 },
    ],
    query: `WITH entry AS (
  SELECT
    distinct_id,
    min(timestamp) AS entry_at,
    argMin(ifNull(toString(properties['$session_id']), ''), timestamp) AS session_id,
    argMin(ifNull(toString(properties['$session_recording_id']), ''), timestamp) AS session_recording_id
  FROM events
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND event = '{{entry_event}}'
    AND timestamp > now() - INTERVAL {{days}} DAY
  GROUP BY distinct_id
),
completion AS (
  SELECT e.distinct_id, min(e.timestamp) AS completed_at
  FROM events e
  JOIN entry ON entry.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.event = '{{completion_event}}'
    AND e.timestamp >= entry.entry_at
  GROUP BY e.distinct_id
),
activity AS (
  SELECT e.distinct_id, max(e.timestamp) AS last_seen_at
  FROM events e
  JOIN entry ON entry.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.timestamp >= entry.entry_at
  GROUP BY e.distinct_id
)
SELECT
  entry.distinct_id AS distinct_id,
  entry.entry_at AS entry_at,
  activity.last_seen_at AS last_seen_at,
  dateDiff('minute', entry.entry_at, activity.last_seen_at) AS minutes_observed,
  entry.session_id AS session_id,
  entry.session_recording_id AS session_recording_id
FROM entry
LEFT JOIN completion ON completion.distinct_id = entry.distinct_id
LEFT JOIN activity ON activity.distinct_id = entry.distinct_id
WHERE completion.distinct_id IS NULL
ORDER BY entry.entry_at DESC
LIMIT {{limit}}`,
    expected_columns: [
      "distinct_id",
      "entry_at",
      "last_seen_at",
      "minutes_observed",
      "session_id",
      "session_recording_id",
    ],
    render_hint: {
      type: "table",
      title: "Funnel drop-off users",
      notes: [
        "Use these private identifier rows as investigation candidates, not as a final statistical summary.",
        "If session_recording_id is present, an owner may locate that recording directly in PostHog. Agentry does not fetch or store replay snapshots.",
        "If no recording id is present, report the missing evidence rather than inventing a replay lookup through Agentry.",
      ],
    },
    example_user_question:
      "which incomplete onboarding sessions should I consider reviewing directly in PostHog?",
    example_params: {
      entry_event: "onboarding_started",
      completion_event: "onboarding_completed",
      days: 7,
      limit: 25,
    },
  },

  // ---------- EVENTS ----------
  {
    id: "top_events_30d",
    category: "events",
    title: "Top events by frequency (last N days)",
    description: "Most-fired event names — useful for understanding what your users actually do.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "days", type: "number", description: "Lookback in days", default: 30 },
      { name: "limit", type: "number", description: "Max rows", default: 20 },
    ],
    query: `SELECT event, count() AS occurrences
FROM events
WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
  AND timestamp > now() - INTERVAL {{days}} DAY
GROUP BY event
ORDER BY occurrences DESC
LIMIT {{limit}}`,
    expected_columns: ["event", "occurrences"],
    render_hint: {
      type: "bar",
      x: "event",
      y: "occurrences",
      title: "Top events by frequency",
    },
    example_user_question: "what events do my users fire most?",
  },
  {
    id: "event_count_per_day",
    category: "events",
    title: "Daily count of a specific event",
    description: "Time-series count of one event by day — for tracking growth or regressions.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "event_name", type: "string", description: "The event to count. Choose this from the saved signal map or observed event names.", required: true },
      { name: "days", type: "number", description: "Lookback in days", default: 30 },
    ],
    query: `SELECT toDate(timestamp) AS day, count() AS occurrences
FROM events
WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
  AND event = '{{event_name}}'
  AND timestamp > now() - INTERVAL {{days}} DAY
GROUP BY day
ORDER BY day`,
    expected_columns: ["day", "occurrences"],
    render_hint: {
      type: "line",
      x: "day",
      y: "occurrences",
      title: "Daily count",
    },
    example_user_question: "how many checkouts did we have each day last month?",
  },
  {
    id: "conversion_rate",
    category: "events",
    title: "Conversion rate from event A to event B",
    description:
      "% of users who fired event A in the lookback window who later fired event B.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "event_a", type: "string", description: "Entry event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "event_b", type: "string", description: "Conversion event. Choose this from the saved signal map or observed event names.", required: true },
      { name: "days", type: "number", description: "Lookback window", default: 30 },
    ],
    query: `WITH a AS (
  SELECT distinct_id, min(timestamp) AS event_a_at
  FROM events
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND event = '{{event_a}}' AND timestamp > now() - INTERVAL {{days}} DAY
  GROUP BY distinct_id
),
b AS (
  SELECT e.distinct_id, min(e.timestamp) AS event_b_at
  FROM events e
  JOIN a ON a.distinct_id = e.distinct_id
  WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
    AND e.event = '{{event_b}}' AND e.timestamp > a.event_a_at
  GROUP BY e.distinct_id
)
SELECT
  (SELECT count() FROM a) AS users_a,
  (SELECT count() FROM b) AS users_b,
  round(100.0 * (SELECT count() FROM b) / nullif((SELECT count() FROM a), 0), 2) AS conversion_pct`,
    expected_columns: ["users_a", "users_b", "conversion_pct"],
    render_hint: {
      type: "scalar",
      title: "Conversion rate",
      notes: ["Render as: 'X of Y users (Z%) converted from event_a to event_b.'"],
    },
    example_user_question: "what % of signups end up paying?",
  },

  // ---------- AUTOMATION VERIFICATION ----------
  {
    id: "automation_case_recurrence_after_deploy",
    category: "errors",
    title: "Exact case recurrence after trusted deploy",
    description:
      "Counts customer error events for one run-bound case fingerprint and exact trusted deploy in [deployed_at, checked_at). The operational executor first proves the run, claimed case revision, CI deploy SHA/time, and source commit binding.",
    backend: "operational",
    publication_safety: PRIVATE_AUTOMATION_VERIFICATION_PUBLICATION,
    strict_params: true,
    automation_verification: {
      kind: "case_recurrence",
      count_column: "recurrence_count",
      expected_rows: 1,
      exact_window: {
        start_param: "deployed_at",
        end_param: "checked_at",
        bounds: "[start,end)",
        maximum_seconds: 2_592_000,
      },
    },
    params: [
      {
        name: "run_id",
        type: "string",
        required: true,
        minimum_length: 1,
        maximum_length: 200,
        description: "Exact server-owned automation run id.",
      },
      {
        name: "case_id",
        type: "string",
        required: true,
        minimum_length: 1,
        maximum_length: 200,
        description: "Exact case id captured by the run.",
      },
      {
        name: "case_revision",
        type: "number",
        integer: true,
        minimum: 1,
        maximum: 2_147_483_647,
        required: true,
        description: "Exact case revision claimed by the run before the fix.",
      },
      {
        name: "deploy_sha",
        type: "string",
        required: true,
        minimum_length: 1,
        maximum_length: 200,
        description: "Exact trusted CI deploy SHA bound to the run.",
      },
      {
        name: "deployed_at",
        type: "string",
        format: "rfc3339",
        required: true,
        description: "Exact whole-second trusted deploy receipt time; inclusive window start.",
      },
      {
        name: "checked_at",
        type: "string",
        format: "rfc3339",
        after_param: "deployed_at",
        maximum_interval_seconds: 2_592_000,
        required: true,
        description: "Exact whole-second verification time; exclusive window end, at most 30 days after deploy.",
      },
    ],
    query: `VALIDATE the run, claimed provider issue revision, and exact trusted CI deploy binding.
POSTHOG error_tracking/query/issues status=all release=:deploy_sha
  date_from=:deployed_at date_to=:checked_at
RETURN the matching :case_id issue occurrence aggregate AS recurrence_count`,
    expected_columns: ["recurrence_count"],
    render_hint: {
      type: "scalar",
      title: "Case recurrence after deploy",
      notes: [
        "Zero means no matching recurrence was observed in this exact window; it is an outcome value, not traffic proof.",
        "Pair this outcome with automation_deploy_traffic_sample. Zero recurrence plus zero approved traffic never proves a fix.",
        "The recurrence aggregate comes from PostHog Error Tracking for the exact provider issue, release, and half-open verification window.",
      ],
    },
    example_user_question:
      "Did this exact case recur after the trusted deploy for its automation run?",
  },
  {
    id: "automation_deploy_traffic_sample",
    category: "deploys",
    title: "Exact approved traffic sample after trusted deploy",
    description:
      "Counts one approved, currently verified customer event carrying the application's exact deploy SHA in [deployed_at, checked_at). This is the traffic proof paired with case recurrence; zero traffic remains pending/failure evidence, never success.",
    backend: "analytics",
    publication_safety: PRIVATE_AUTOMATION_VERIFICATION_PUBLICATION,
    strict_params: true,
    required_event_params: ["event_name"],
    automation_verification: {
      kind: "deploy_traffic_sample",
      count_column: "sample_count",
      expected_rows: 1,
      exact_window: {
        start_param: "deployed_at",
        end_param: "checked_at",
        bounds: "[start,end)",
        maximum_seconds: 2_592_000,
      },
    },
    params: [
      {
        name: "deploy_sha",
        type: "string",
        required: true,
        minimum_length: 1,
        maximum_length: 200,
        description: "Exact trusted CI deploy SHA whose traffic is sampled.",
      },
      {
        name: "deployed_at",
        type: "string",
        format: "rfc3339",
        required: true,
        description: "Exact whole-second trusted deploy receipt time; inclusive window start.",
      },
      {
        name: "checked_at",
        type: "string",
        format: "rfc3339",
        after_param: "deployed_at",
        maximum_interval_seconds: 2_592_000,
        required: true,
        description: "Exact whole-second verification time; exclusive window end, at most 30 days after deploy.",
      },
      {
        name: "event_name",
        type: "string",
        format: "event_name",
        required: true,
        description: "One approved signal-map event whose receipt has evidence_status=source_verified.",
      },
    ],
    query: `WITH
  parseDateTimeBestEffort('{{deployed_at}}', 'UTC') AS deployed_at,
  parseDateTimeBestEffort('{{checked_at}}', 'UTC') AS checked_at
SELECT count() AS sample_count
FROM events
WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
  AND event = '{{event_name}}'
  AND ifNull(toString(properties['deploy_sha']), '') = '{{deploy_sha}}'
  AND timestamp >= deployed_at
  AND timestamp < checked_at`,
    expected_columns: ["sample_count"],
    render_hint: {
      type: "scalar",
      title: "Approved post-deploy traffic sample",
      notes: [
        "sample_count is approved real product traffic for the exact deploy and half-open verification window.",
        "Zero is never enough proof to resolve a case; wait or fail according to the immutable verification policy.",
        "Marked onboarding-proof, rehearsal, and test analytics are excluded.",
      ],
    },
    example_user_question:
      "Was there enough approved product traffic after this exact deploy to trust a zero-recurrence result?",
    example_params: {
      deploy_sha: "0123456789abcdef0123456789abcdef01234567",
      deployed_at: "2026-07-10T09:00:00.000Z",
      checked_at: "2026-07-10T10:00:00.000Z",
      event_name: "request_completed",
    },
  },

  // ---------- ERRORS (operational backend) ----------
  {
    id: "active_cases_top",
    category: "errors",
    title: "Top active cases by occurrence count",
    description: "Most-frequent unresolved errors right now.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_ROW_PUBLICATION,
    params: [
      { name: "limit", type: "number", description: "Max rows", default: 10 },
    ],
    query: `SELECT id, error_type, message, event_count, last_seen_at, last_deploy_sha
FROM cases
WHERE project_id = :project_id
  AND ${CUSTOMER_CASE_SQL}
  AND status = 'active'
ORDER BY event_count DESC
LIMIT :limit`,
    expected_columns: ["id", "error_type", "message", "event_count", "last_seen_at", "last_deploy_sha"],
    render_hint: {
      type: "table",
      title: "Top active cases",
      notes: ["For each case, agent should call GET /v1/cases/:case_id for the stack trace and proposed fix."],
    },
    example_user_question: "what are my worst current bugs?",
  },
  {
    id: "errors_by_hour_24h",
    category: "errors",
    title: "Errors per hour (last 24h)",
    description: "Time-series of new error events bucketed by hour.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_AGGREGATE_PUBLICATION,
    params: [],
    query: `SELECT toStartOfHour(timestamp) AS hour, count() AS errors
FROM events
WHERE event = '$exception' AND timestamp > now() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour`,
    expected_columns: ["hour", "errors"],
    render_hint: {
      type: "line",
      x: "hour",
      y: "errors",
      title: "Errors per hour, last 24h",
      notes: ["Rows come from PostHog's authoritative $exception events."],
    },
    example_user_question: "are errors spiking right now?",
  },
  {
    id: "errors_after_last_deploy",
    category: "errors",
    title: "Cases that started after the most recent deploy",
    description:
      "Useful for 'did we ship a bug?' — lists cases first seen after the latest deploy timestamp.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_ROW_PUBLICATION,
    params: [],
    query: `WITH latest_deploy AS (
  SELECT received_at AS deploy_ts, sha AS deploy_sha
  FROM deploys
  WHERE project_id = :project_id
    AND ${TRUSTED_CUSTOMER_DEPLOY_SQL}
  ORDER BY received_at DESC
  LIMIT 1
)
SELECT
  id,
  error_type,
  message,
  event_count,
  first_seen_at,
  last_deploy_sha,
  (SELECT deploy_sha FROM latest_deploy) AS latest_deploy_sha,
  CASE
    WHEN last_deploy_sha = (SELECT deploy_sha FROM latest_deploy) THEN 'sha_match'
    WHEN last_deploy_sha IS NULL OR last_deploy_sha = '' THEN 'time_after_latest_no_sha'
    ELSE 'time_after_latest_different_sha'
  END AS attribution
FROM cases
WHERE project_id = :project_id
  AND ${CUSTOMER_CASE_SQL}
  AND (SELECT deploy_ts FROM latest_deploy) IS NOT NULL
  AND first_seen_at >= (SELECT deploy_ts FROM latest_deploy)
ORDER BY first_seen_at DESC`,
    expected_columns: ["id", "error_type", "message", "event_count", "first_seen_at", "last_deploy_sha", "latest_deploy_sha", "attribution"],
    render_hint: {
      type: "table",
      title: "Cases since latest deploy",
      notes: [
        "Only call a deploy suspect when attribution is sha_match. Time-only rows are correlation, not proof.",
        "If the table is empty, first confirm the project has a recorded customer deploy; no deploy baseline returns no rows and is not proof of no regression.",
        "Agent should follow up with GET /v1/cases/:case_id for each to propose a fix.",
      ],
    },
    example_user_question: "did the last deploy break anything?",
  },

  // ---------- USER IDENTIFICATION (operational backend) ----------
  {
    id: "top_users_by_errors",
    category: "users",
    title: "Top users by error count (last N days)",
    description: "Which identified users are hitting the most errors? Useful for outreach or user-specific debugging.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_IDENTIFIER_PUBLICATION,
    params: [
      { name: "days", type: "number", description: "Lookback in days", default: 7 },
      { name: "limit", type: "number", description: "Max users", default: 25 },
    ],
    query: `SELECT distinct_id AS user_id,
       count() AS error_count, max(timestamp) AS last_seen_at
FROM events
WHERE event = '$exception'
  AND timestamp > now() - INTERVAL :days DAY
  AND distinct_id NOT LIKE 'anonymous_%'
GROUP BY distinct_id ORDER BY error_count DESC LIMIT :limit`,
    expected_columns: ["user_id", "error_count", "last_seen_at"],
    render_hint: {
      type: "table",
      title: "Top users by error count",
      notes: ["Counts come from identified PostHog $exception events; inspect issue samples before attributing cause."],
    },
    example_user_question: "which users are hitting the most errors right now?",
  },
  {
    id: "unique_users_24h",
    category: "users",
    title: "Unique identified users with errors in last 24h",
    description: "How many distinct users were affected today?",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_AGGREGATE_PUBLICATION,
    params: [],
    query: `SELECT count(DISTINCT distinct_id) AS unique_users, count() AS total_events
FROM events
WHERE event = '$exception'
  AND timestamp > now() - INTERVAL 24 HOUR
  AND distinct_id NOT LIKE 'anonymous_%'`,
    expected_columns: ["unique_users", "total_events"],
    render_hint: {
      type: "scalar",
      title: "Affected users (last 24h)",
      notes: ["Render as: 'X distinct users hit Y errors in the last 24h.'"],
    },
    example_user_question: "how many users were affected today?",
  },
  {
    id: "users_affected_by_case",
    category: "users",
    title: "Users affected by a specific case",
    description: "Bounded identified-user sample from the PostHog issue's recent exception events.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_IDENTIFIER_PUBLICATION,
    params: [
      { name: "fingerprint", type: "string", description: "PostHog issue id returned as the case fingerprint", required: true },
      { name: "limit", type: "number", description: "Max users", default: 50 },
    ],
    query: `POSTHOG issue_events(issue_id=:fingerprint, verbosity=raw, limit=min(:limit,20))
GROUP sampled events BY distinct_id ORDER BY last_seen_at DESC`,
    expected_columns: ["user_id", "error_count", "last_seen_at"],
    render_hint: {
      type: "table",
      title: "Users affected by case",
    },
    example_user_question: "who's been hit by this bug?",
  },

  // ---------- DEPLOYS ----------
  {
    id: "deploy_frequency_30d",
    category: "deploys",
    title: "Deploys per day (last 30 days)",
    description: "How often we ship. Useful baseline metric.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_AGGREGATE_PUBLICATION,
    params: [],
    query: `SELECT
  date(received_at, 'unixepoch') AS day,
  count() AS deploys
FROM deploys
WHERE project_id = :project_id
  AND ${TRUSTED_CUSTOMER_DEPLOY_SQL}
  AND received_at > unixepoch() - 30 * 86400
GROUP BY day
ORDER BY day`,
    expected_columns: ["day", "deploys"],
    render_hint: {
      type: "bar",
      x: "day",
      y: "deploys",
      title: "Deploys per day",
    },
    example_user_question: "how often do we ship?",
  },
  {
    id: "errors_by_deploy",
    category: "deploys",
    title: "Error volume per deploy",
    description:
      "Groups PostHog exception events by the application's deploy_sha or SDK release property. Missing release metadata stays explicit rather than being inferred by Agentry.",
    backend: "operational",
    publication_safety: PRIVATE_OPERATIONAL_AGGREGATE_PUBLICATION,
    params: [
      { name: "days", type: "number", description: "Lookback window in days", default: 14 },
    ],
    query: `SELECT
  coalesce(
    nullIf(toString(properties.deploy_sha), ''),
    nullIf(toString(properties.$exception_release), ''),
    '(release property missing)'
  ) AS deploy_sha,
  count() AS error_events,
  min(timestamp) AS first_error_at,
  max(timestamp) AS last_error_at
FROM events
WHERE event = '$exception' AND timestamp > now() - INTERVAL :days DAY
GROUP BY deploy_sha
ORDER BY last_error_at DESC`,
    expected_columns: ["deploy_sha", "error_events", "first_error_at", "last_error_at"],
    render_hint: {
      type: "table",
      title: "Errors per deploy",
      notes: [
        "Cross-reference deploy_sha with GET /v1/projects/:id/deploys for commit message/branch/actor.",
        "Rows tagged '(release property missing)' can only be correlated by time, which is not proof of the producing release.",
      ],
    },
    example_user_question: "which deploy introduced the current errors?",
  },
  {
    id: "analytics_events_by_deploy",
    category: "deploys",
    title: "Analytics event volume per deploy",
    description:
      "Groups product analytics events by an application-emitted properties.deploy_sha. Use it to compare activity across releases only when source instrumentation proves that property is present.",
    backend: "analytics",
    publication_safety: SAFE_AGGREGATE_PUBLICATION,
    params: [
      { name: "days", type: "number", description: "Lookback window in days", default: 14 },
    ],
    query: `SELECT
  coalesce(nullIf(properties.deploy_sha, ''), '(no deploy recorded)') AS deploy_sha,
  count() AS events,
  count(DISTINCT distinct_id) AS unique_users,
  min(timestamp) AS first_event_at,
  max(timestamp) AS last_event_at
FROM events
WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
  AND timestamp > now() - INTERVAL {{days}} DAY
GROUP BY deploy_sha
ORDER BY last_event_at DESC`,
    expected_columns: ["deploy_sha", "events", "unique_users", "first_event_at", "last_event_at"],
    render_hint: {
      type: "table",
      title: "Analytics events per deploy",
      notes: [
        "Agentry does not stamp customer events. A deploy_sha row is exact only to the degree the application's source instrumentation emits the producing release correctly.",
        "Cross-reference deploy_sha with GET /v1/projects/:id/deploys for commit context.",
      ],
    },
    example_user_question: "did activity or conversions change after the last deploy?",
  },
];

export function getQueryBlueprintTemplate(id: string): QueryBlueprintTemplate | null {
  return QUERY_BLUEPRINT_CATALOG.find((r) => r.id === id) ?? null;
}

export function listQueryBlueprintTemplates(category?: string): QueryBlueprintTemplate[] {
  if (!category) return QUERY_BLUEPRINT_CATALOG;
  return QUERY_BLUEPRINT_CATALOG.filter((r) => r.category === category);
}

export interface QueryBlueprintParamValidationOptions {
  reject_unknown?: boolean;
}

const RFC3339_WITH_ZONE =
  /^(?!0000)(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
const EVENT_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Resolve defaults and canonicalize params before interpolation. Exact-period
 * automation blueprints use this result in their input-readiness checks and
 * hash material, so equivalent RFC3339 offsets normalize to the same UTC value.
 */
export function resolveQueryBlueprintParams(
  params: Record<string, unknown>,
  defs: QueryBlueprintParam[],
  options: QueryBlueprintParamValidationOptions = {},
): Record<string, string | number> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("params must be an object");
  }

  if (options.reject_unknown) {
    const names = new Set(defs.map((def) => def.name));
    const unknown = Object.keys(params).filter((name) => !names.has(name)).sort();
    if (unknown.length > 0) {
      throw new Error(`unknown param(s): ${unknown.join(", ")}`);
    }
  }

  const resolved = Object.fromEntries(
    defs.map((def) => [def.name, resolveQueryBlueprintParamValue(def, params)]),
  );
  for (const def of defs) {
    if (!def.after_param) continue;
    const end = resolved[def.name];
    const start = resolved[def.after_param];
    if (typeof end !== "string" || typeof start !== "string") {
      throw new Error(
        `param '${def.name}' requires string timestamp param '${def.after_param}'`,
      );
    }
    const intervalSeconds = (Date.parse(end) - Date.parse(start)) / 1_000;
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error(
        `param '${def.name}' must be strictly after param '${def.after_param}'`,
      );
    }
    if (
      def.maximum_interval_seconds !== undefined &&
      intervalSeconds > def.maximum_interval_seconds
    ) {
      throw new Error(
        `interval '${def.after_param}' to '${def.name}' must be at most ${def.maximum_interval_seconds} seconds`,
      );
    }
  }
  return resolved;
}

// Interpolate {{name}} HogQL placeholders. Validates against `params` so a
// malicious input can't sneak through unexpected substitutions.
export function interpolateQuery(
  template: string,
  params: Record<string, unknown>,
  defs: QueryBlueprintParam[],
  options: QueryBlueprintParamValidationOptions = {},
): string {
  const rejectUnknown = options.reject_unknown ?? QUERY_BLUEPRINT_CATALOG.some(
    (blueprint) =>
      blueprint.strict_params === true &&
      blueprint.query === template &&
      blueprint.params === defs,
  );
  const resolved = resolveQueryBlueprintParams(params, defs, {
    ...options,
    reject_unknown: rejectUnknown,
  });
  let out = template;
  for (const def of defs) {
    const value = resolved[def.name]!;
    const stringValue = typeof value === "number" ? String(value) : escapeHogQL(value);
    out = out.replaceAll(`{{${def.name}}}`, stringValue);
  }
  return out;
}

export function prepareQueryBlueprintExecution(
  blueprint: QueryBlueprintTemplate,
  params: Record<string, unknown>,
): { params: Record<string, string | number>; query: string } {
  const options = { reject_unknown: blueprint.strict_params === true };
  const resolved = resolveQueryBlueprintParams(params, blueprint.params, options);
  return {
    params: resolved,
    query: blueprint.query_builder === "ordered_funnel_period_compare"
      ? buildOrderedFunnelPeriodCompareQuery(resolved)
      : interpolateQuery(blueprint.query, resolved, blueprint.params, options),
  };
}

export function parseOrderedFunnelEventsJson(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("funnel event list must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 2 || parsed.length > 20) {
    throw new Error("funnel event list must contain 2 to 20 ordered events");
  }
  const events = parsed.map((event, index) => {
    if (typeof event !== "string" || event.length === 0 || event.length > 200) {
      throw new Error(`funnel event at index ${index} must be a non-empty string of at most 200 characters`);
    }
    if (event !== event.trim() || /\s/u.test(event) || EVENT_NAME_CONTROL_CHARACTERS.test(event)) {
      throw new Error(`funnel event at index ${index} must not contain whitespace or control characters`);
    }
    return event;
  });
  if (new Set(events).size !== events.length) {
    throw new Error("funnel event list must contain distinct ordered events");
  }
  return events;
}

function buildOrderedFunnelPeriodCompareQuery(
  params: Record<string, string | number>,
): string {
  const eventsValue = params.funnel_events_json;
  if (typeof eventsValue !== "string") {
    throw new Error("param 'funnel_events_json' must be a string");
  }
  const events = parseOrderedFunnelEventsJson(eventsValue);
  const scheduledFor = escapeHogQL(String(params.scheduled_for));
  const periodDays = Number(params.period_days);
  const minimumSampleSize = Number(params.minimum_sample_size);
  const literals = events.map((event) => `'${escapeHogQL(event)}'`);
  const observedColumns = events.map((_, index) =>
    `count(DISTINCT if(event = ${literals[index]}, distinct_id, NULL)) AS event_${index + 1}_observed_users`
  );
  const stepCtes = events.map((_, index) => {
    const step = index + 1;
    if (step === 1) {
      return `s1 AS (
    SELECT p.period, p.window_end, e.distinct_id, min(e.timestamp) AS t1
    FROM periods p
    JOIN events e ON e.timestamp >= p.window_start AND e.timestamp < p.window_end
    WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER} AND e.event = ${literals[index]}
    GROUP BY p.period, p.window_end, e.distinct_id
  )`;
    }
    const previous = step - 1;
    return `s${step} AS (
    SELECT s${previous}.period, s${previous}.window_end, e.distinct_id, min(e.timestamp) AS t${step}
    FROM events e
    JOIN s${previous} ON s${previous}.distinct_id = e.distinct_id
    WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
      AND e.event = ${literals[index]}
      AND e.timestamp >= s${previous}.t${previous}
      AND e.timestamp < s${previous}.window_end
    GROUP BY s${previous}.period, s${previous}.window_end, e.distinct_id
  )`;
  });
  const funnelCounts = events.map((_, index) =>
    `count(DISTINCT s${index + 1}.distinct_id) AS step_${index + 1}_count`
  );
  const joins = events.map((_, index) => {
    const step = index + 1;
    if (step === 1) return "LEFT JOIN s1 ON s1.period = p.period";
    return `LEFT JOIN s${step} ON s${step}.period = p.period AND s${step}.distinct_id = s${step - 1}.distinct_id`;
  });
  const observedValues = events.map((_, index) =>
    `coalesce(o.event_${index + 1}_observed_users, 0)`
  );
  const countValues = events.map((_, index) => `f.step_${index + 1}_count`);
  const conversions = events.slice(1).map((_, index) =>
    `round(100.0 * f.step_${index + 2}_count / nullIf(f.step_${index + 1}_count, 0), 2)`
  );
  const allObserved = observedValues.map((value) => `${value} > 0`).join(" AND ");

  return `WITH
  parseDateTimeBestEffort('${scheduledFor}', 'UTC') AS anchor,
  anchor - INTERVAL ${periodDays} DAY AS current_start,
  current_start - INTERVAL ${periodDays} DAY AS prior_start,
  periods AS (
    SELECT 'prior' AS period, prior_start AS window_start, current_start AS window_end
    UNION ALL
    SELECT 'current' AS period, current_start AS window_start, anchor AS window_end
  ),
  observed AS (
    SELECT if(timestamp < current_start, 'prior', 'current') AS period,
      ${observedColumns.join(",\n      ")}
    FROM events
    WHERE ${CUSTOMER_ANALYTICS_HOGQL_FILTER}
      AND event IN (${literals.join(", ")})
      AND timestamp >= prior_start AND timestamp < anchor
    GROUP BY period
  ),
  ${stepCtes.join(",\n  ")},
  funnel AS (
    SELECT p.period, p.window_start, p.window_end,
      ${funnelCounts.join(",\n      ")}
    FROM periods p
    ${joins.join("\n    ")}
    GROUP BY p.period, p.window_start, p.window_end
  )
SELECT
  f.period AS period,
  f.window_start AS window_start,
  f.window_end AS window_end,
  toJSONString([${literals.join(", ")}]) AS funnel_events_json,
  toJSONString([${observedValues.join(", ")}]) AS observed_users_json,
  toJSONString([${countValues.join(", ")}]) AS counts_json,
  toJSONString([${conversions.join(", ")}]) AS conversion_percentages_json,
  round(100.0 * f.step_${events.length}_count / nullIf(f.step_1_count, 0), 2) AS overall_conversion_pct,
  f.step_1_count AS sample_size,
  ${minimumSampleSize} AS minimum_sample_size,
  toBool(${allObserved}) AS all_selected_events_observed,
  toBool(f.step_1_count >= ${minimumSampleSize} AND ${allObserved}) AS sample_ready,
  multiIf(
    f.step_1_count < ${minimumSampleSize}, 'insufficient_entry_sample',
    NOT (${allObserved}), 'selected_event_absent_in_window',
    'ready'
  ) AS readiness_status
FROM funnel f
LEFT JOIN observed o ON o.period = f.period
ORDER BY if(f.period = 'prior', 0, 1)`;
}

function resolveQueryBlueprintParamValue(
  def: QueryBlueprintParam,
  params: Record<string, unknown>,
): string | number {
  const provided = params[def.name];
  const hasProvided = provided !== undefined && provided !== null;
  if (!hasProvided) {
    if (def.required) {
      throw new Error(
        `param '${def.name}' is required; choose it from the saved signal map, live event/property metadata, or the user's explicit question`,
      );
    }
    if (def.default === undefined) {
      throw new Error(`param '${def.name}' is missing and has no default`);
    }
  }
  const value = hasProvided ? provided : def.default;

  if (def.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`param '${def.name}' must be a finite number`);
    }
    if (def.integer && !Number.isInteger(value)) {
      throw new Error(`param '${def.name}' must be an integer`);
    }
    if (def.minimum !== undefined && value < def.minimum) {
      throw new Error(`param '${def.name}' must be at least ${def.minimum}`);
    }
    if (def.maximum !== undefined && value > def.maximum) {
      throw new Error(`param '${def.name}' must be at most ${def.maximum}`);
    }
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(`param '${def.name}' must be a string`);
  }
  if (def.required && value.trim() === "") {
    throw new Error(`param '${def.name}' is required and cannot be blank`);
  }
  if (def.minimum_length !== undefined && value.length < def.minimum_length) {
    throw new Error(`param '${def.name}' must be at least ${def.minimum_length} characters`);
  }
  if (def.maximum_length !== undefined && value.length > def.maximum_length) {
    throw new Error(`param '${def.name}' must be at most ${def.maximum_length} characters`);
  }
  if (def.format === "rfc3339") {
    const match = RFC3339_WITH_ZONE.exec(value);
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    const daysInMonth = match
      ? new Date(Date.UTC(year, month, 0)).getUTCDate()
      : 0;
    if (
      !match ||
      day > daysInMonth ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new Error(
        `param '${def.name}' must be an RFC3339 timestamp with Z or an explicit numeric offset`,
      );
    }
    const timestamp = new Date(value);
    if (timestamp.getTime() % 1_000 !== 0) {
      throw new Error(`param '${def.name}' must be aligned to an exact whole second`);
    }
    return timestamp.toISOString();
  }
  if (def.format === "event_name") {
    if (value !== value.trim()) {
      throw new Error(`param '${def.name}' must not have leading or trailing whitespace`);
    }
    if (value.length > 200) {
      throw new Error(`param '${def.name}' must be at most 200 characters`);
    }
    if (EVENT_NAME_CONTROL_CHARACTERS.test(value)) {
      throw new Error(`param '${def.name}' must not contain control characters`);
    }
  }
  if (def.format === "event_name_list_json") {
    return JSON.stringify(parseOrderedFunnelEventsJson(value));
  }
  return value;
}

function escapeHogQL(s: string): string {
  // HogQL string literals — escape single quotes and backslashes.
  // Keep paranoid since this is concatenated into SQL.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
