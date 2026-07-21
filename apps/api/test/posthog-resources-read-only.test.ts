import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeTestEnv,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const posthogProjectApiMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", async () => {
  const actual = await vi.importActual<typeof import("../src/posthog.js")>(
    "../src/posthog.js",
  );
  return {
    ...actual,
    posthogProjectApi: (...args: unknown[]) => posthogProjectApiMock(...args),
  };
});

const { createApp } = await import("../src/index.js");

type ProviderOptions = { query?: Record<string, unknown> };

const recordings = [
  {
    id: "recording-1",
    distinct_id: "buyer@example.test",
    viewed: false,
    recording_duration: 90,
    active_seconds: 60,
    inactive_seconds: 30,
    start_time: "2026-07-20T11:58:30.000Z",
    end_time: "2026-07-20T12:00:00.000Z",
    click_count: 4,
    console_error_count: 2,
    start_url: "https://app.example.test/checkout?token=secret#payment",
    expiry_time: "2026-08-19T12:00:00.000Z",
    has_summary: true,
    person: { email: "buyer@example.test", name: "Private Buyer" },
    snapshots: [{ type: 2, data: { href: "https://private.example.test" } }],
    network: [{ url: "https://api.example.test/private" }],
    viewers: ["analyst@example.test"],
    summary: "Private replay summary",
  },
  {
    id: "recording-2",
    distinct_id: "person-2",
    viewed: true,
    recording_duration: 30,
    start_time: "2026-07-20T11:50:00.000Z",
    end_time: "2026-07-20T11:50:30.000Z",
    start_url: "https://app.example.test/pricing?utm_source=private#hero",
    snapshots: [{ type: 3, data: { source: 2 } }],
  },
  {
    id: "recording-3",
    distinct_id: "person-3",
    viewed: false,
    recording_duration: 15,
    start_time: "2026-07-20T11:40:00.000Z",
    end_time: "2026-07-20T11:40:15.000Z",
    start_url: "https://app.example.test/home",
  },
];

const featureFlags = [{
  id: 7,
  key: "checkout-redesign",
  name: "Checkout redesign",
  active: true,
  archived: false,
  status: "active",
  tags: ["checkout", "conversion"],
  filters: {
    groups: [{
      rollout_percentage: 50,
      variant: "test",
      properties: [{
        key: "email",
        type: "person",
        operator: "exact",
        value: "vip@example.test",
      }],
    }],
    multivariate: {
      variants: [
        { key: "control", name: "Control", rollout_percentage: 50 },
        { key: "test", name: "Redesign", rollout_percentage: 50 },
      ],
    },
    payloads: { control: "private-control", test: "private-test" },
  },
  created_by: { email: "owner@example.test" },
  rollback_conditions: [{ threshold: 0.5 }],
}];

const surveys = [{
  id: "survey-1",
  name: "Checkout feedback",
  description: "Why did checkout fail?",
  type: "popover",
  schedule: "once",
  archived: false,
  start_date: "2026-07-01T00:00:00.000Z",
  linked_flag: { id: 7, key: "checkout-redesign", filters: { private: true } },
  questions: [{
    id: "question-1",
    type: "open",
    question: "What stopped you?",
    description: "Do not include payment information.",
    optional: true,
  }],
  appearance: { backgroundColor: "#fff", private_css: "secret" },
  conditions: { url: "https://private.example.test" },
  created_by: { email: "owner@example.test" },
}];

const surveyResponses = [
  {
    uuid: "response-1",
    distinct_id: "buyer@example.test",
    session_id: "sk_live_abcdefghijk",
    submitted_at: "2026-07-20T12:00:00.000Z",
    answers: [
      {
        question_id: "question-1",
        question_index: 0,
        question_text: "What stopped you?",
        question_type: "open",
        answer: "Contact buyer@example.test about the payment failure.",
      },
      {
        question_id: "question-2",
        question_index: 1,
        question_text: "Debug value",
        question_type: "open",
        answer: "api_key=supersecret",
      },
    ],
    extra: {
      device_type: "Desktop",
      browser: "Chrome",
      os: "macOS",
      geoip_country_code: "FI",
      geoip_country_name: "Finland",
      current_url: "https://app.example.test/checkout?email=buyer@example.test#payment",
    },
    person: { email: "buyer@example.test" },
    properties: { payment_token: "private" },
  },
  {
    uuid: "response-2",
    distinct_id: "person-2",
    session_id: "recording-2",
    submitted_at: "2026-07-21T12:00:00.000Z",
    answers: [{
      question_id: "question-1",
      question_index: 0,
      question_text: "What stopped you?",
      question_type: "open",
      answer: "Nothing",
    }],
  },
];

const experiments = [{
  id: 9,
  name: "Checkout conversion",
  description: "Measure completed checkout conversion.",
  type: "product",
  status: "running",
  archived: false,
  start_date: "2026-07-01T00:00:00.000Z",
  feature_flag: {
    id: 7,
    key: "checkout-redesign",
    active: true,
    filters: {
      multivariate: {
        variants: [
          { key: "control", name: "Control", rollout_percentage: 50 },
          { key: "test", name: "Redesign", rollout_percentage: 50 },
        ],
      },
      payloads: { test: "private-payload" },
    },
  },
  conclusion: "won",
  conclusion_comment: "Approved by owner@example.test",
  metrics: [{
    uuid: "metric-1",
    name: "Checkout completed",
    kind: "ExperimentMetric",
    metric_type: "conversion",
    source: {
      kind: "EventsNode",
      event: "checkout.completed",
      properties: [{ key: "api_key", value: "supersecret" }],
    },
    query: { kind: "TrendsQuery", private: "do-not-return" },
  }],
  metrics_secondary: [{
    uuid: "metric-2",
    name: "Payment failed",
    kind: "ExperimentMetric",
    metric_type: "conversion",
    source: { kind: "EventsNode", event: "payment.failed" },
  }],
  saved_metrics: [{ id: 1 }, { id: 2 }],
  created_by: { email: "owner@example.test" },
  parameters: { private: true },
}];

let env: TestEnv;
let app: ReturnType<typeof createApp>;
let apiKey: string;
let projectId: string;

beforeEach(async () => {
  env = await makeTestEnv();
  app = createApp();
  posthogProjectApiMock.mockReset();
  posthogProjectApiMock.mockImplementation(providerRead);

  const login = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email: `resources-${crypto.randomUUID()}@example.test` },
  });
  expect(login.status).toBe(200);
  apiKey = ((await login.json()) as { api_key: string }).api_key;

  const project = await call("/v1/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "idempotency-key": `posthog-resources-${crypto.randomUUID()}`,
    },
    json: { name: "PostHog resource reads" },
  });
  expect(project.status).toBe(200);
  projectId = ((await project.json()) as { id: string }).id;
});

afterEach(() => {
  vi.clearAllMocks();
  disposeTestEnv(env);
});

async function providerRead(
  _env: unknown,
  requestedProjectId: string,
  path: string,
  options?: ProviderOptions,
): Promise<Record<string, unknown>> {
  expect(requestedProjectId).toBe(projectId);
  const result = (data: unknown) => ({
    teamId: 42,
    posthogHost: "https://eu.posthog.com",
    status: 200,
    data,
  });
  const collection = (values: unknown[]) => {
    const limit = numberQuery(options, "limit", 50);
    const offset = numberQuery(options, "offset", 0);
    const page = values.slice(offset, offset + limit);
    return result({
      count: values.length,
      next: offset + page.length < values.length
        ? `https://eu.posthog.com/api/projects/42/${path}/?limit=${limit}&offset=${offset + page.length}`
        : null,
      previous: offset > 0 ? "https://eu.posthog.com/previous" : null,
      results: page,
    });
  };

  switch (path) {
    case "session_recordings":
      return collection(recordings);
    case "session_recordings/recording-1":
      return result(recordings[0]);
    case "feature_flags":
      return collection(featureFlags);
    case "feature_flags/7":
      return result(featureFlags[0]);
    case "surveys":
      return collection(surveys);
    case "surveys/survey-1":
      return result(surveys[0]);
    case "surveys/survey-1/responses": {
      const limit = numberQuery(options, "limit", 50);
      const offset = numberQuery(options, "offset", 0);
      const page = surveyResponses.slice(offset, offset + limit);
      return result({
        results: page,
        has_more: offset + page.length < surveyResponses.length,
        limit,
        offset,
      });
    }
    case "surveys/survey-1/stats":
      return result({
        survey_id: "survey-1",
        start_date: "2026-07-01T00:00:00.000Z",
        end_date: null,
        stats: { shown: 10, sent: 3, debug: "api_key=supersecret" },
        rates: { response_rate: 0.3 },
        per_question_stats: [{ question_id: "question-1", responses: 3 }],
        raw_responses: surveyResponses,
      });
    case "experiments":
      return collection(experiments);
    case "experiments/9":
      return result(experiments[0]);
    default:
      throw new Error(`Unexpected PostHog resource read: ${path}`);
  }
}

function numberQuery(
  options: ProviderOptions | undefined,
  name: string,
  fallback: number,
): number {
  const value = options?.query?.[name];
  return typeof value === "number" ? value : fallback;
}

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(new Request(`http://test${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
  }), env);
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

describe("first-class read-only PostHog resources", () => {
  it("returns only recording metadata with normalized pagination and a PostHog player link", async () => {
    const list = await call(
      `/v1/projects/${projectId}/session-recordings?limit=1&offset=1`,
      { headers: authHeaders() },
    );
    expect(list.status).toBe(200);
    const body = await list.json() as Record<string, any>;
    expect(body.page).toEqual({
      limit: 1,
      offset: 1,
      has_more: true,
      next_offset: 2,
    });
    expect(body.session_recordings).toHaveLength(1);
    expect(body.session_recordings[0]).toMatchObject({
      id: "recording-2",
      distinct_id: "person-2",
      viewed: true,
      recording_duration_seconds: 30,
      start_url: "https://app.example.test/pricing",
      player_url: "https://eu.posthog.com/project/42/replay/recording-2",
    });
    expect(body.session_recordings[0]).not.toHaveProperty("snapshots");
    expect(body).toMatchObject({
      freshness: {
        source: "customer_posthog_cloud_api",
        consistency: "provider_read",
        status: "complete_for_query_time",
      },
      data_boundary: {
        upstream_source: "customer_posthog_cloud",
        raw_event_stream_retained: false,
        resource_snapshot_retained: false,
        session_recording_content_returned: false,
        provider_mutations_authorized: false,
      },
    });
    expect(Number.isNaN(Date.parse(body.freshness.queried_at))).toBe(false);
    expect(posthogProjectApiMock).toHaveBeenCalledWith(
      env,
      projectId,
      "session_recordings",
      { query: { limit: 1, offset: 1 } },
    );

    const detail = await call(
      `/v1/projects/${projectId}/session-recordings/recording-1`,
      { headers: authHeaders() },
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as Record<string, any>;
    expect(detailBody.session_recording).toMatchObject({
      id: "recording-1",
      distinct_id: "[redacted-email]",
      start_url: "https://app.example.test/checkout",
      player_url: "https://eu.posthog.com/project/42/replay/recording-1",
      has_summary: true,
    });
    for (const privateField of ["person", "snapshots", "network", "viewers", "summary"]) {
      expect(detailBody.session_recording).not.toHaveProperty(privateField);
    }

    posthogProjectApiMock.mockClear();
    for (const query of ["limit=0", "limit=101", "offset=-1", "offset=1000001"]) {
      const invalid = await call(
        `/v1/projects/${projectId}/session-recordings?${query}`,
        { headers: authHeaders() },
      );
      expect(invalid.status, query).toBe(400);
    }
    expect(posthogProjectApiMock).not.toHaveBeenCalled();
  });

  it("projects flag, survey, and experiment definitions without raw targeting or query payloads", async () => {
    const flagList = await call(`/v1/projects/${projectId}/feature-flags`, {
      headers: authHeaders(),
    });
    const flagDetail = await call(`/v1/projects/${projectId}/feature-flags/7`, {
      headers: authHeaders(),
    });
    expect(flagList.status).toBe(200);
    expect(flagDetail.status).toBe(200);
    const flagBody = await flagDetail.json() as Record<string, any>;
    expect(flagBody.feature_flag).toMatchObject({
      id: 7,
      key: "checkout-redesign",
      description: "Checkout redesign",
      targeting_groups: [{
        rollout_percentage: 50,
        variant: "test",
        conditions: [{
          key: "email",
          type: "person",
          operator: "exact",
          value: "[redacted-email]",
        }],
      }],
      variants: [
        { key: "control", name: "Control", rollout_percentage: 50 },
        { key: "test", name: "Redesign", rollout_percentage: 50 },
      ],
    });
    for (const privateField of ["filters", "payloads", "created_by", "rollback_conditions"]) {
      expect(flagBody.feature_flag).not.toHaveProperty(privateField);
    }

    const surveyList = await call(`/v1/projects/${projectId}/surveys`, {
      headers: authHeaders(),
    });
    const surveyDetail = await call(`/v1/projects/${projectId}/surveys/survey-1`, {
      headers: authHeaders(),
    });
    expect(surveyList.status).toBe(200);
    expect(surveyDetail.status).toBe(200);
    const surveyBody = await surveyDetail.json() as Record<string, any>;
    expect(surveyBody.survey).toMatchObject({
      id: "survey-1",
      name: "Checkout feedback",
      linked_feature_flag: { id: 7, key: "checkout-redesign" },
      questions: [{
        id: "question-1",
        type: "open",
        question: "What stopped you?",
      }],
    });
    for (const privateField of ["appearance", "conditions", "created_by"]) {
      expect(surveyBody.survey).not.toHaveProperty(privateField);
    }

    const experimentList = await call(`/v1/projects/${projectId}/experiments`, {
      headers: authHeaders(),
    });
    const experimentDetail = await call(`/v1/projects/${projectId}/experiments/9`, {
      headers: authHeaders(),
    });
    expect(experimentList.status).toBe(200);
    expect(experimentDetail.status).toBe(200);
    const experimentBody = await experimentDetail.json() as Record<string, any>;
    expect(experimentBody.experiment).toMatchObject({
      id: 9,
      name: "Checkout conversion",
      status: "running",
      conclusion: "won",
      conclusion_comment: "Approved by [redacted-email]",
      feature_flag: {
        id: 7,
        key: "checkout-redesign",
        active: true,
        variants: [
          { key: "control", name: "Control", rollout_percentage: 50 },
          { key: "test", name: "Redesign", rollout_percentage: 50 },
        ],
      },
      primary_metrics: [{
        uuid: "metric-1",
        name: "Checkout completed",
        event_names: ["checkout.completed"],
      }],
      secondary_metrics: [{ event_names: ["payment.failed"] }],
      saved_metric_count: 2,
    });
    for (const privateField of ["metrics", "metrics_secondary", "query", "parameters", "created_by"]) {
      expect(experimentBody.experiment).not.toHaveProperty(privateField);
    }
    expect(experimentBody.experiment.primary_metrics[0]).not.toHaveProperty("query");

    for (const canonicalPath of [
      "feature_flags",
      "feature_flags/7",
      "surveys",
      "surveys/survey-1",
      "experiments",
      "experiments/9",
    ]) {
      expect(posthogProjectApiMock).toHaveBeenCalledWith(
        env,
        projectId,
        canonicalPath,
        ...(canonicalPath.includes("/")
          ? []
          : [{ query: { limit: 50, offset: 0 } }]),
      );
    }
  });

  it("requires bounded survey response windows and redacts individual response data", async () => {
    posthogProjectApiMock.mockClear();
    const invalidQueries = [
      "until=2026-07-31T00%3A00%3A00Z",
      "since=2026-07-01T00%3A00%3A00Z",
      "since=2026-07-31T00%3A00%3A00Z&until=2026-07-01T00%3A00%3A00Z",
      "since=2026-01-01T00%3A00%3A00Z&until=2026-07-01T00%3A00%3A00Z",
      "since=2026-07-01T00%3A00%3A00Z&until=2026-07-31T00%3A00%3A00Z&score_lte=6",
    ];
    for (const query of invalidQueries) {
      const response = await call(
        `/v1/projects/${projectId}/surveys/survey-1/responses?${query}`,
        { headers: authHeaders() },
      );
      expect(response.status, query).toBe(400);
    }
    expect(posthogProjectApiMock).not.toHaveBeenCalled();

    const responses = await call(
      `/v1/projects/${projectId}/surveys/survey-1/responses` +
        "?since=2026-07-01T00%3A00%3A00Z" +
        "&until=2026-07-31T00%3A00%3A00Z" +
        "&limit=1&offset=0&question_id=question-1&score_lte=6&exclude_archived=true",
      { headers: authHeaders() },
    );
    expect(responses.status).toBe(200);
    const body = await responses.json() as Record<string, any>;
    expect(body.page).toEqual({
      limit: 1,
      offset: 0,
      has_more: true,
      next_offset: 1,
    });
    expect(body.redaction).toEqual({
      free_text_max_characters: 2_000,
      email_addresses_redacted: true,
      secret_like_values_redacted: true,
    });
    expect(body.responses).toHaveLength(1);
    expect(body.responses[0]).toMatchObject({
      id: "response-1",
      distinct_id: "[redacted-email]",
      session_id: "[redacted-sensitive-value]",
      answers: [
        { answer: "Contact [redacted-email] about the payment failure." },
        { answer: "[redacted-sensitive-value]" },
      ],
      context: {
        device_type: "Desktop",
        browser: "Chrome",
        country_code: "FI",
        current_url: "https://app.example.test/checkout",
      },
    });
    expect(body.responses[0]).not.toHaveProperty("person");
    expect(body.responses[0]).not.toHaveProperty("properties");
    expect(posthogProjectApiMock).toHaveBeenCalledWith(
      env,
      projectId,
      "surveys/survey-1/responses",
      {
        query: {
          limit: 1,
          offset: 0,
          since: "2026-07-01T00:00:00.000Z",
          until: "2026-07-31T00:00:00.000Z",
          question_id: "question-1",
          score_lte: 6,
          exclude_archived: true,
        },
      },
    );

    const stats = await call(
      `/v1/projects/${projectId}/surveys/survey-1/stats` +
        "?date_from=2026-07-01&date_to=2026-07-31&include_per_question_stats=true",
      { headers: authHeaders() },
    );
    expect(stats.status).toBe(200);
    const statsBody = await stats.json() as Record<string, any>;
    expect(statsBody.stats).toMatchObject({
      survey_id: "survey-1",
      event_counts: {
        shown: 10,
        sent: 3,
        debug: "[redacted-sensitive-value]",
      },
      rates: { response_rate: 0.3 },
      per_question_stats: [{ question_id: "question-1", responses: 3 }],
    });
    expect(statsBody.stats).not.toHaveProperty("raw_responses");
    expect(posthogProjectApiMock).toHaveBeenCalledWith(
      env,
      projectId,
      "surveys/survey-1/stats",
      {
        query: {
          date_from: "2026-07-01T00:00:00.000Z",
          date_to: "2026-07-31T00:00:00.000Z",
          include_per_question_stats: true,
        },
      },
    );
  });

  it("does not expose provider mutations, replay snapshots, or retired aliases", async () => {
    posthogProjectApiMock.mockClear();
    const unavailable: Array<[string, string]> = [
      ["POST", `/v1/projects/${projectId}/feature-flags`],
      ["PATCH", `/v1/projects/${projectId}/feature-flags/7`],
      ["DELETE", `/v1/projects/${projectId}/feature-flags/7`],
      ["POST", `/v1/projects/${projectId}/feature-flags/evaluate`],
      ["POST", `/v1/projects/${projectId}/surveys`],
      ["PATCH", `/v1/projects/${projectId}/surveys/survey-1`],
      ["DELETE", `/v1/projects/${projectId}/surveys/survey-1`],
      ["POST", `/v1/projects/${projectId}/experiments`],
      ["PATCH", `/v1/projects/${projectId}/experiments/9`],
      ["DELETE", `/v1/projects/${projectId}/experiments/9`],
      ["PATCH", `/v1/projects/${projectId}/session-recordings/recording-1`],
      ["DELETE", `/v1/projects/${projectId}/session-recordings/recording-1`],
      ["GET", `/v1/projects/${projectId}/session-recordings/recording-1/snapshots`],
      ["GET", `/v1/projects/${projectId}/session-replays`],
      ["GET", `/v1/projects/${projectId}/session-replays/recording-1`],
      ["GET", `/v1/projects/${projectId}/session-replays/recording-1/snapshots`],
      ["POST", `/v1/projects/${projectId}/posthog/session-replay/configure`],
      ["GET", `/v1/projects/${projectId}/posthog/session-replay/status`],
      ["POST", `/v1/projects/${projectId}/ab-tests`],
    ];

    for (const [method, path] of unavailable) {
      const response = await call(path, {
        method,
        headers: authHeaders(),
        ...(!["GET", "HEAD"].includes(method) ? { json: {} } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(posthogProjectApiMock).not.toHaveBeenCalled();
  });
});
