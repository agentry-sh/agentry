import { errors } from "@agentrysh/shared";
import type { Env } from "./env.js";
import { posthogProjectApi } from "./posthog.js";

const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;
const MAX_LIST_RESULTS = 100;
const MAX_QUESTIONS = 100;
const MAX_ANSWERS = 100;
const MAX_VARIANTS = 20;
const MAX_TAGS = 20;

export type PosthogResourcePage = {
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
};

export type PosthogResourceReadMeta = {
  freshness: {
    source: "customer_posthog_cloud_api";
    consistency: "provider_read";
    queried_at: string;
    status: "complete_for_query_time";
  };
  data_boundary: {
    upstream_source: "customer_posthog_cloud";
    raw_event_stream_retained: false;
    resource_snapshot_retained: false;
    session_recording_content_returned: false;
    provider_mutations_authorized: false;
  };
};

type ProviderList = {
  results?: unknown;
  next?: unknown;
  count?: unknown;
  has_more?: unknown;
  has_next?: unknown;
  limit?: unknown;
  offset?: unknown;
};

export function normalizePosthogPagination(input: {
  limit?: number;
  offset?: number;
}): { limit: number; offset: number } {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw errors.invalidPayload({ reason: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` });
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    throw errors.invalidPayload({ reason: `offset must be an integer from 0 to ${MAX_OFFSET}` });
  }
  return { limit, offset };
}

export function posthogResourceReadMeta(queriedAt = new Date().toISOString()): PosthogResourceReadMeta {
  return {
    freshness: {
      source: "customer_posthog_cloud_api",
      consistency: "provider_read",
      queried_at: queriedAt,
      status: "complete_for_query_time",
    },
    data_boundary: {
      upstream_source: "customer_posthog_cloud",
      raw_event_stream_retained: false,
      resource_snapshot_retained: false,
      session_recording_content_returned: false,
      provider_mutations_authorized: false,
    },
  };
}

export async function listPosthogSessionRecordings(
  env: Env,
  projectId: string,
  pagination: { limit: number; offset: number },
): Promise<{ session_recordings: Record<string, unknown>[]; page: PosthogResourcePage; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<ProviderList>(env, projectId, "session_recordings", {
    query: pagination,
  });
  const page = parseProviderList(result.data, pagination);
  return {
    session_recordings: page.results.map((item) => projectSessionRecording(
      item,
      result.posthogHost,
      result.teamId,
    )),
    page: page.page,
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function getPosthogSessionRecording(
  env: Env,
  projectId: string,
  recordingId: string,
): Promise<{ session_recording: Record<string, unknown>; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<unknown>(
    env,
    projectId,
    `session_recordings/${safeResourceId(recordingId, "recording_id")}`,
  );
  return {
    session_recording: projectSessionRecording(result.data, result.posthogHost, result.teamId),
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function listPosthogFeatureFlags(
  env: Env,
  projectId: string,
  pagination: { limit: number; offset: number },
): Promise<{ feature_flags: Record<string, unknown>[]; page: PosthogResourcePage; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<ProviderList>(env, projectId, "feature_flags", {
    query: pagination,
  });
  const page = parseProviderList(result.data, pagination);
  return {
    feature_flags: page.results.map(projectFeatureFlag),
    page: page.page,
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function getPosthogFeatureFlag(
  env: Env,
  projectId: string,
  flagId: string,
): Promise<{ feature_flag: Record<string, unknown>; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<unknown>(
    env,
    projectId,
    `feature_flags/${safeResourceId(flagId, "flag_id")}`,
  );
  return {
    feature_flag: projectFeatureFlag(result.data),
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function listPosthogSurveys(
  env: Env,
  projectId: string,
  pagination: { limit: number; offset: number },
): Promise<{ surveys: Record<string, unknown>[]; page: PosthogResourcePage; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<ProviderList>(env, projectId, "surveys", {
    query: pagination,
  });
  const page = parseProviderList(result.data, pagination);
  return {
    surveys: page.results.map(projectSurvey),
    page: page.page,
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function getPosthogSurvey(
  env: Env,
  projectId: string,
  surveyId: string,
): Promise<{ survey: Record<string, unknown>; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<unknown>(
    env,
    projectId,
    `surveys/${safeResourceId(surveyId, "survey_id")}`,
  );
  return {
    survey: projectSurvey(result.data),
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export type SurveyResponseFilters = {
  limit: number;
  offset: number;
  question_id?: string;
  score_gte?: number;
  score_lte?: number;
  since?: string;
  until?: string;
  exclude_archived?: boolean;
};

export async function listPosthogSurveyResponses(
  env: Env,
  projectId: string,
  surveyId: string,
  filters: SurveyResponseFilters,
): Promise<{ responses: Record<string, unknown>[]; page: PosthogResourcePage; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<ProviderList>(
    env,
    projectId,
    `surveys/${safeResourceId(surveyId, "survey_id")}/responses`,
    { query: filters },
  );
  const page = parseProviderList(result.data, filters, true);
  return {
    responses: page.results.map(projectSurveyResponse),
    page: page.page,
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function getPosthogSurveyStats(
  env: Env,
  projectId: string,
  surveyId: string,
  filters: {
    date_from?: string;
    date_to?: string;
    include_per_question_stats?: boolean;
  },
): Promise<{ stats: Record<string, unknown>; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<unknown>(
    env,
    projectId,
    `surveys/${safeResourceId(surveyId, "survey_id")}/stats`,
    { query: filters },
  );
  return {
    stats: projectSurveyStats(result.data),
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function listPosthogExperiments(
  env: Env,
  projectId: string,
  pagination: { limit: number; offset: number },
): Promise<{ experiments: Record<string, unknown>[]; page: PosthogResourcePage; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<ProviderList>(env, projectId, "experiments", {
    query: pagination,
  });
  const page = parseProviderList(result.data, pagination);
  return {
    experiments: page.results.map(projectExperiment),
    page: page.page,
    meta: posthogResourceReadMeta(queriedAt),
  };
}

export async function getPosthogExperiment(
  env: Env,
  projectId: string,
  experimentId: string,
): Promise<{ experiment: Record<string, unknown>; meta: PosthogResourceReadMeta }> {
  const queriedAt = new Date().toISOString();
  const result = await posthogProjectApi<unknown>(
    env,
    projectId,
    `experiments/${safeResourceId(experimentId, "experiment_id")}`,
  );
  return {
    experiment: projectExperiment(result.data),
    meta: posthogResourceReadMeta(queriedAt),
  };
}

function parseProviderList(
  value: unknown,
  requested: { limit: number; offset: number },
  providerHasMore = false,
): { results: unknown[]; page: PosthogResourcePage } {
  const source = asRecord(value, "PostHog returned a malformed resource collection.");
  if (!Array.isArray(source.results)) {
    throw malformedProvider("PostHog resource collection did not include a results array.");
  }
  const results = source.results.slice(0, Math.min(MAX_LIST_RESULTS, requested.limit));
  const limit = providerHasMore
    ? boundedProviderInteger(source.limit, requested.limit, MAX_PAGE_SIZE)
    : requested.limit;
  const offset = providerHasMore
    ? boundedProviderInteger(source.offset, requested.offset, MAX_OFFSET)
    : requested.offset;
  const count = finiteNumber(source.count);
  const providerReportsMore = providerHasMore && typeof source.has_more === "boolean"
    ? source.has_more
    : typeof source.has_next === "boolean"
      ? source.has_next
    : typeof source.next === "string" && source.next.length > 0
      ? true
      : count !== null
        ? offset + results.length < count
        : results.length >= limit;
  const nextOffset = offset + results.length;
  const hasMore = providerReportsMore && results.length > 0 && nextOffset <= MAX_OFFSET;
  return {
    results,
    page: {
      limit,
      offset,
      has_more: hasMore,
      next_offset: hasMore ? nextOffset : null,
    },
  };
}

function projectSessionRecording(
  value: unknown,
  posthogHost: string,
  teamId: number,
): Record<string, unknown> {
  const source = asRecord(value, "PostHog returned a malformed session recording.");
  const id = requiredText(source.id, 200, "session recording id");
  return {
    id,
    distinct_id: redactedText(source.distinct_id, 400),
    viewed: booleanValue(source.viewed),
    recording_duration_seconds: finiteNumber(source.recording_duration),
    active_seconds: finiteNumber(source.active_seconds),
    inactive_seconds: finiteNumber(source.inactive_seconds),
    start_time: textValue(source.start_time, 100),
    end_time: textValue(source.end_time, 100),
    click_count: finiteNumber(source.click_count),
    keypress_count: finiteNumber(source.keypress_count),
    mouse_activity_count: finiteNumber(source.mouse_activity_count),
    console_log_count: finiteNumber(source.console_log_count),
    console_warn_count: finiteNumber(source.console_warn_count),
    console_error_count: finiteNumber(source.console_error_count),
    start_url: safeUrl(source.start_url),
    retention_period_days: finiteNumber(source.retention_period_days),
    expiry_time: textValue(source.expiry_time, 100),
    snapshot_source: textValue(source.snapshot_source, 100),
    snapshot_library: textValue(source.snapshot_library, 100),
    ongoing: booleanValue(source.ongoing),
    activity_score: finiteNumber(source.activity_score),
    has_summary: booleanValue(source.has_summary),
    player_url: `${posthogHost}/project/${teamId}/replay/${encodeURIComponent(id)}`,
  };
}

function projectFeatureFlag(value: unknown): Record<string, unknown> {
  const source = asRecord(value, "PostHog returned a malformed feature flag.");
  const filters = recordValue(source.filters);
  const groups = Array.isArray(filters?.groups) ? filters.groups.slice(0, 20) : [];
  const multivariate = recordValue(filters?.multivariate);
  const variants = Array.isArray(multivariate?.variants)
    ? multivariate.variants.slice(0, MAX_VARIANTS)
    : [];
  return {
    id: identifierValue(source.id, "feature flag id"),
    key: requiredText(source.key, 400, "feature flag key"),
    description: textValue(source.name, 2_000),
    active: booleanValue(source.active),
    archived: booleanValue(source.archived),
    deleted: booleanValue(source.deleted),
    status: textValue(source.status, 100),
    created_at: textValue(source.created_at, 100),
    updated_at: textValue(source.updated_at, 100),
    last_called_at: textValue(source.last_called_at, 100),
    evaluation_runtime: textValue(source.evaluation_runtime, 100),
    bucketing_identifier: textValue(source.bucketing_identifier, 100),
    ensure_experience_continuity: booleanValue(source.ensure_experience_continuity),
    has_encrypted_payloads: booleanValue(source.has_encrypted_payloads),
    tags: stringList(source.tags, MAX_TAGS, 100),
    targeting_groups: groups.map((group) => {
      const item = recordValue(group) ?? {};
      const conditions = Array.isArray(item.properties) ? item.properties.slice(0, 50) : [];
      return {
        rollout_percentage: finiteNumber(item.rollout_percentage),
        variant: textValue(item.variant, 200),
        conditions: conditions.map((condition) => {
          const property = recordValue(condition) ?? {};
          return {
            key: textValue(property.key, 400),
            type: textValue(property.type, 100),
            operator: textValue(property.operator, 100),
            value: boundedConditionValue(property.value),
          };
        }),
      };
    }),
    variants: variants.map((variant) => {
      const item = recordValue(variant) ?? {};
      return {
        key: textValue(item.key, 200),
        name: textValue(item.name, 400),
        rollout_percentage: finiteNumber(item.rollout_percentage),
      };
    }),
    experiment_ids: numberList(source.experiment_set, 100),
  };
}

function projectSurvey(value: unknown): Record<string, unknown> {
  const source = asRecord(value, "PostHog returned a malformed survey.");
  const linkedFlag = recordValue(source.linked_flag);
  const questions = Array.isArray(source.questions) ? source.questions.slice(0, MAX_QUESTIONS) : [];
  return {
    id: requiredText(source.id, 200, "survey id"),
    name: requiredText(source.name, 400, "survey name"),
    description: textValue(source.description, 2_000),
    type: textValue(source.type, 100),
    schedule: textValue(source.schedule, 100),
    archived: booleanValue(source.archived),
    start_date: textValue(source.start_date, 100),
    end_date: textValue(source.end_date, 100),
    created_at: textValue(source.created_at, 100),
    responses_limit: finiteNumber(source.responses_limit),
    iteration_count: finiteNumber(source.iteration_count),
    iteration_frequency_days: finiteNumber(source.iteration_frequency_days),
    current_iteration: finiteNumber(source.current_iteration),
    enable_partial_responses: booleanValue(source.enable_partial_responses),
    base_language: textValue(source.base_language, 20),
    linked_feature_flag: linkedFlag
      ? {
          id: identifierOrNull(linkedFlag.id),
          key: textValue(linkedFlag.key, 400),
        }
      : null,
    questions: questions.map(projectSurveyQuestion),
  };
}

function projectSurveyQuestion(value: unknown): Record<string, unknown> {
  const source = recordValue(value) ?? {};
  return {
    id: textValue(source.id, 200),
    type: textValue(source.type, 100),
    question: textValue(source.question, 1_000),
    description: textValue(source.description, 1_000),
    optional: booleanValue(source.optional),
    choices: stringList(source.choices, 100, 500),
    scale: finiteNumber(source.scale),
    lower_bound_label: textValue(source.lowerBoundLabel, 500),
    upper_bound_label: textValue(source.upperBoundLabel, 500),
    is_nps_question: booleanValue(source.isNpsQuestion),
  };
}

function projectSurveyResponse(value: unknown): Record<string, unknown> {
  const source = asRecord(value, "PostHog returned a malformed survey response.");
  const answers = Array.isArray(source.answers) ? source.answers.slice(0, MAX_ANSWERS) : [];
  const extra = recordValue(source.extra);
  return {
    id: requiredText(source.uuid, 200, "survey response id"),
    distinct_id: redactedText(source.distinct_id, 400),
    session_id: redactedText(source.session_id, 400),
    submitted_at: textValue(source.submitted_at, 100),
    answers: answers.map((answer) => {
      const item = recordValue(answer) ?? {};
      return {
        question_id: textValue(item.question_id, 200),
        question_index: finiteNumber(item.question_index),
        question_text: textValue(item.question_text, 1_000),
        question_type: textValue(item.question_type, 100),
        answer: boundedSurveyAnswer(item.answer),
      };
    }),
    context: extra
      ? {
          device_type: textValue(extra.device_type, 100),
          browser: textValue(extra.browser, 100),
          os: textValue(extra.os, 100),
          country_code: textValue(extra.geoip_country_code, 10),
          country_name: textValue(extra.geoip_country_name, 100),
          current_url: safeUrl(extra.current_url),
          iteration: textValue(extra.iteration, 100),
        }
      : null,
  };
}

function projectSurveyStats(value: unknown): Record<string, unknown> {
  const source = asRecord(value, "PostHog returned malformed survey statistics.");
  const perQuestion = Array.isArray(source.per_question_stats)
    ? source.per_question_stats.slice(0, MAX_QUESTIONS).map((item) => boundedValue(item, 0))
    : [];
  return {
    survey_id: requiredText(source.survey_id, 200, "survey id"),
    start_date: textValue(source.start_date, 100),
    end_date: textValue(source.end_date, 100),
    event_counts: boundedValue(source.stats, 0),
    rates: boundedValue(source.rates, 0),
    per_question_stats: perQuestion,
  };
}

function projectExperiment(value: unknown): Record<string, unknown> {
  const source = asRecord(value, "PostHog returned a malformed experiment.");
  const featureFlag = recordValue(source.feature_flag);
  const primaryMetrics = Array.isArray(source.metrics) ? source.metrics.slice(0, 50) : [];
  const secondaryMetrics = Array.isArray(source.metrics_secondary)
    ? source.metrics_secondary.slice(0, 50)
    : [];
  return {
    id: identifierValue(source.id, "experiment id"),
    name: requiredText(source.name, 400, "experiment name"),
    description: textValue(source.description, 3_000),
    type: textValue(source.type, 100),
    status: textValue(source.status, 100),
    archived: booleanValue(source.archived),
    deleted: booleanValue(source.deleted),
    start_date: textValue(source.start_date, 100),
    end_date: textValue(source.end_date, 100),
    created_at: textValue(source.created_at, 100),
    updated_at: textValue(source.updated_at, 100),
    feature_flag: featureFlag
      ? {
          id: identifierOrNull(featureFlag.id),
          key: textValue(featureFlag.key, 400),
          active: booleanValue(featureFlag.active),
          variants: projectFlagVariants(featureFlag.filters),
        }
      : {
          id: null,
          key: textValue(source.feature_flag_key, 400),
          active: null,
          variants: [],
        },
    conclusion: textValue(source.conclusion, 100),
    conclusion_comment: redactedText(source.conclusion_comment, 2_000),
    is_legacy: booleanValue(source.is_legacy),
    excluded_variants: stringList(source.excluded_variants, MAX_VARIANTS, 200),
    primary_metrics: primaryMetrics.map(projectExperimentMetric),
    secondary_metrics: secondaryMetrics.map(projectExperimentMetric),
    saved_metric_count: Array.isArray(source.saved_metrics) ? Math.min(source.saved_metrics.length, 100) : 0,
  };
}

function projectExperimentMetric(value: unknown): Record<string, unknown> {
  const source = recordValue(value) ?? {};
  return {
    uuid: textValue(source.uuid, 200),
    name: textValue(source.name, 400),
    kind: textValue(source.kind, 100),
    metric_type: textValue(source.metric_type, 100),
    event_names: collectMetricEventNames(source),
  };
}

function projectFlagVariants(value: unknown): Record<string, unknown>[] {
  const filters = recordValue(value);
  const multivariate = recordValue(filters?.multivariate);
  const variants = Array.isArray(multivariate?.variants)
    ? multivariate.variants.slice(0, MAX_VARIANTS)
    : [];
  return variants.map((variant) => {
    const source = recordValue(variant) ?? {};
    return {
      key: textValue(source.key, 200),
      name: textValue(source.name, 400),
      rollout_percentage: finiteNumber(source.rollout_percentage),
    };
  });
}

function boundedSurveyAnswer(value: unknown): string | string[] | number | boolean | null {
  if (typeof value === "string") return redactedText(value, 2_000);
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => redactedText(item, 500))
      .filter((item): item is string => item !== null);
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function boundedConditionValue(
  value: unknown,
): string | Array<string | number | boolean> | number | boolean | null {
  if (typeof value === "string") return redactedText(value, 500);
  if (Array.isArray(value)) {
    const bounded: Array<string | number | boolean> = [];
    for (const item of value.slice(0, 20)) {
      if (typeof item === "string") {
        const text = redactedText(item, 200);
        if (text !== null) bounded.push(text);
        continue;
      }
      if (typeof item === "number" && Number.isFinite(item)) bounded.push(item);
      if (typeof item === "boolean") bounded.push(item);
    }
    return bounded;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function collectMetricEventNames(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 5 || names.size >= 50) return;
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 50)) visit(child, depth + 1);
      return;
    }
    const source = recordValue(item);
    if (!source) return;
    const kind = textValue(source.kind, 100);
    if (kind && /(?:Events|Actions)Node$/.test(kind)) {
      const eventName = textValue(source.event, 400) ?? textValue(source.name, 400);
      if (eventName) names.add(eventName);
    }
    for (const child of Object.values(source).slice(0, 50)) visit(child, depth + 1);
  };
  visit(value, 0);
  return [...names];
}

function boundedValue(value: unknown, depth: number): unknown {
  if (depth > 3) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactedText(value, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => boundedValue(item, depth + 1));
  const source = recordValue(value);
  if (!source) return null;
  return Object.fromEntries(
    Object.entries(source)
      .slice(0, 50)
      .map(([key, item]) => [key.slice(0, 100), boundedValue(item, depth + 1)]),
  );
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  const source = recordValue(value);
  if (!source) throw malformedProvider(message);
  return source;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, max: number, field: string): string {
  const parsed = textValue(value, max);
  if (!parsed) throw malformedProvider(`PostHog response is missing ${field}.`);
  return parsed;
}

function identifierValue(value: unknown, field: string): string | number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return requiredText(value, 200, field);
}

function identifierOrNull(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return textValue(value, 200);
}

function textValue(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function redactedText(value: unknown, max: number): string | null {
  const text = textValue(value, max);
  if (!text) return null;
  if (/\b(?:bearer\s+[a-z0-9._~-]+|sk[_-][a-z0-9_-]{8,}|api[_-]?key\s*[:=])/i.test(text)) {
    return "[redacted-sensitive-value]";
  }
  return text.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    "[redacted-email]",
  );
}

function safeUrl(value: unknown): string | null {
  const text = textValue(value, 2_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().slice(0, 2_000);
  } catch {
    return text.split(/[?#]/, 1)[0]?.slice(0, 2_000) ?? null;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .map((item) => textValue(item, maxLength))
    .filter((item): item is string => item !== null);
}

function numberList(value: unknown, maxItems: number): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .filter((item): item is number => typeof item === "number" && Number.isSafeInteger(item));
}

function boundedProviderInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : fallback;
}

function safeResourceId(value: string, field: string): string {
  if (!value || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw errors.invalidPayload({ reason: `${field} is invalid` });
  }
  return encodeURIComponent(value);
}

function malformedProvider(reason: string): Error {
  return errors.posthogUpstreamFailed({
    operation: "read typed PostHog resource",
    status: 502,
    body: reason,
    nextAction: "Retry once. If this repeats, update Agentry's PostHog resource adapter.",
  });
}
