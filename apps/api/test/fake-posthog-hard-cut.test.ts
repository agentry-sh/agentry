import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_POSTHOG_READ_SCOPES,
  FakePosthogServer,
  type FakePosthogProjectState,
} from "./fake-posthog.js";

describe("read-only FakePosthogServer contract", () => {
  let server: FakePosthogServer;
  let project: FakePosthogProjectState;

  beforeEach(async () => {
    server = new FakePosthogServer();
    project = server.addProject({
      posthogProjectId: 42,
      authorizationCode: "provider-code",
      accessToken: "pha_access",
      refreshToken: "phr_refresh",
      eventDefinitions: [{ id: "event-definition-1", name: "checkout.completed" }],
      propertyDefinitions: [{ id: "property-definition-1", name: "plan" }],
      errorIssues: [{
        id: "issue-1",
        name: "TypeError",
        description: "boom",
        status: "active",
        first_seen: "2026-07-19T12:00:00.000Z",
        last_seen: "2026-07-20T12:00:00.000Z",
        aggregations: { occurrences: 1, users: 1 },
        eventUuids: ["event-1"],
      }],
      sessionRecordings: [
        {
          id: "recording-1",
          distinct_id: "person-1",
          viewed: false,
          recording_duration: 90,
          start_time: "2026-07-20T11:58:30.000Z",
          end_time: "2026-07-20T12:00:00.000Z",
          console_error_count: 1,
          start_url: "https://app.example.test/checkout",
          expiry_time: "2026-08-19T12:00:00.000Z",
        },
        {
          id: "recording-2",
          distinct_id: "person-2",
          viewed: true,
          recording_duration: 30,
          start_time: "2026-07-20T11:50:00.000Z",
          end_time: "2026-07-20T11:50:30.000Z",
          console_error_count: 0,
          start_url: "https://app.example.test/pricing",
        },
      ],
      featureFlags: [{
        id: 7,
        key: "checkout-redesign",
        name: "Checkout redesign",
        active: true,
        archived: false,
        status: "active",
        filters: {
          groups: [{ rollout_percentage: 50, properties: [] }],
          multivariate: {
            variants: [
              { key: "control", rollout_percentage: 50 },
              { key: "test", rollout_percentage: 50 },
            ],
          },
        },
      }],
      surveys: [{
        id: "survey-1",
        name: "Checkout feedback",
        type: "popover",
        archived: false,
        questions: [{
          id: "question-1",
          type: "open",
          question: "What stopped you?",
        }],
      }],
      surveyResponses: {
        "survey-1": [{
          uuid: "response-1",
          distinct_id: "person-1",
          session_id: "recording-1",
          submitted_at: "2026-07-20T12:00:00.000Z",
          answers: [{
            question_id: "question-1",
            question_index: 0,
            question_text: "What stopped you?",
            question_type: "open",
            answer: "The payment form failed.",
          }],
        }],
      },
      surveyStats: {
        "survey-1": {
          survey_id: "survey-1",
          start_date: "2026-07-01T00:00:00.000Z",
          end_date: null,
          stats: { shown: 10, sent: 3 },
          rates: { response_rate: 0.3 },
        },
      },
      experiments: [{
        id: 9,
        name: "Checkout conversion",
        status: "running",
        archived: false,
        feature_flag_key: "checkout-redesign",
        feature_flag: {
          id: 7,
          key: "checkout-redesign",
          active: true,
        },
        start_date: "2026-07-01T00:00:00.000Z",
        end_date: null,
      }],
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function oauthFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${project.accessToken}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${server.baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  }

  it("models one provider-scoped OAuth grant and only the canonical reads", async () => {
    const tokenResponse = await fetch(`${server.baseUrl}/oauth/token/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: "provider-code",
        code_verifier: "pkce-verifier",
        client_id: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const initialTokens = await tokenResponse.json() as Record<string, unknown>;
    expect(initialTokens).toMatchObject({
      access_token: "pha_access",
      refresh_token: "phr_refresh",
      id_token: "fake.header.signature",
      scope: FAKE_POSTHOG_READ_SCOPES.join(" "),
      scoped_teams: [42],
      scoped_organizations: ["11111111-1111-4111-8111-111111111111"],
    });

    const queryResponse = await oauthFetch("/api/environments/42/query/", {
      method: "POST",
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query: "SELECT 1 AS agentry_connection_check",
        },
      }),
    });
    expect(queryResponse.status).toBe(200);
    await expect(queryResponse.json()).resolves.toEqual({
      results: [[1]],
      columns: ["agentry_connection_check"],
      types: ["UInt8"],
    });

    const eventsResponse = await oauthFetch(
      "/api/projects/42/event_definitions/?limit=1",
    );
    await expect(eventsResponse.json()).resolves.toEqual({
      count: 1,
      results: [{ id: "event-definition-1", name: "checkout.completed" }],
    });
    const propertiesResponse = await oauthFetch(
      "/api/projects/42/property_definitions/?limit=1",
    );
    await expect(propertiesResponse.json()).resolves.toEqual({
      count: 1,
      results: [{ id: "property-definition-1", name: "plan" }],
    });

    const issuesResponse = await oauthFetch(
      "/api/environments/42/error_tracking/query/issues/",
      {
        method: "POST",
        body: JSON.stringify({ status: "active", limit: 10 }),
      },
    );
    expect(issuesResponse.status).toBe(200);
    await expect(issuesResponse.json()).resolves.toMatchObject({
      results: [{ id: "issue-1", status: "active" }],
      hasMore: false,
    });

    const refreshResponse = await fetch(`${server.baseUrl}/oauth/token/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: "phr_refresh",
        client_id: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshedTokens = await refreshResponse.json() as Record<string, unknown>;
    expect(refreshedTokens).toMatchObject({
      access_token: "pha_access",
      scoped_teams: [42],
    });
    expect(refreshedTokens).not.toHaveProperty("id_token");
    expect(server.requests.filter((request) => request.path === "/oauth/token/"))
      .not.toContainEqual(expect.objectContaining({
        body: expect.objectContaining({ refresh_token: "phr_refresh" }),
      }));
    expect(server.unexpectedRequests).toEqual([]);
  });

  it("keeps customer telemetry simulation out of the HTTP provider surface", async () => {
    server.pushEvent(42, {
      uuid: "event-1",
      event: "checkout.completed",
      distinct_id: "person-1",
      properties: { plan: "pro" },
      timestamp: "2026-07-20T12:00:00.000Z",
    });

    const queryResponse = await oauthFetch("/api/environments/42/query/", {
      method: "POST",
      body: JSON.stringify({
        query: {
          kind: "HogQLQuery",
          query: "SELECT event, count() AS c, max(timestamp) AS last_seen FROM events GROUP BY event",
        },
      }),
    });
    await expect(queryResponse.json()).resolves.toMatchObject({
      results: [["checkout.completed", 1, "2026-07-20T12:00:00.000Z"]],
    });

    const captureResponse = await fetch(`${server.baseUrl}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "must-not-be-captured" }),
    });
    expect(captureResponse.status).toBe(405);
    expect(project.capturedEvents.map((event) => event.event)).toEqual([
      "checkout.completed",
    ]);
    expect(server.unexpectedRequests).toContainEqual({
      method: "POST",
      path: "/capture/",
    });
  });

  it("serves bounded project-scoped recording, flag, survey, and experiment reads", async () => {
    const recordings = await oauthFetch(
      "/api/projects/42/session_recordings/?limit=1&offset=1",
    );
    expect(recordings.status).toBe(200);
    await expect(recordings.json()).resolves.toMatchObject({
      count: 2,
      next: null,
      results: [{ id: "recording-2" }],
    });
    await expect(oauthFetch("/api/projects/42/session_recordings/recording-1/")
      .then((response) => response.json())).resolves.toMatchObject({
        id: "recording-1",
        console_error_count: 1,
      });

    await expect(oauthFetch("/api/projects/42/feature_flags/")
      .then((response) => response.json())).resolves.toMatchObject({
        count: 1,
        results: [{ id: 7, key: "checkout-redesign" }],
      });
    await expect(oauthFetch("/api/projects/42/feature_flags/7/")
      .then((response) => response.json())).resolves.toMatchObject({
        id: 7,
        key: "checkout-redesign",
      });

    await expect(oauthFetch("/api/projects/42/surveys/")
      .then((response) => response.json())).resolves.toMatchObject({
        count: 1,
        results: [{ id: "survey-1", name: "Checkout feedback" }],
      });
    await expect(oauthFetch("/api/projects/42/surveys/survey-1/")
      .then((response) => response.json())).resolves.toMatchObject({
        id: "survey-1",
        questions: [{ id: "question-1" }],
      });
    await expect(oauthFetch(
      "/api/projects/42/surveys/survey-1/responses/?since=2026-07-01T00%3A00%3A00.000Z&until=2026-07-31T00%3A00%3A00.000Z&limit=1",
    ).then((response) => response.json())).resolves.toMatchObject({
      has_more: false,
      limit: 1,
      offset: 0,
      results: [{ uuid: "response-1" }],
    });
    await expect(oauthFetch("/api/projects/42/surveys/survey-1/stats/")
      .then((response) => response.json())).resolves.toMatchObject({
        survey_id: "survey-1",
        stats: { shown: 10, sent: 3 },
      });

    await expect(oauthFetch("/api/projects/42/experiments/")
      .then((response) => response.json())).resolves.toMatchObject({
        count: 1,
        results: [{ id: 9, status: "running" }],
      });
    await expect(oauthFetch("/api/projects/42/experiments/9/")
      .then((response) => response.json())).resolves.toMatchObject({
        id: 9,
        name: "Checkout conversion",
      });

    expect(server.unexpectedRequests).toEqual([]);
  });

  it("fails closed for every retired proxy, management, and provider-mutation family", async () => {
    const retiredRequests: Array<[string, string]> = [
      ["POST", "/agentry-admin/provision-team"],
      ["POST", "/capture/"],
      ["POST", "/decide/"],
      ["POST", "/flags/"],
      ["POST", "/fake-symbol-upload/symbol-set-1"],
      ["PATCH", "/api/environments/42"],
      ["DELETE", "/api/projects/42"],
      ["POST", "/api/projects/42/feature_flags/"],
      ["PATCH", "/api/projects/42/feature_flags/7/"],
      ["DELETE", "/api/projects/42/feature_flags/7/"],
      ["GET", "/api/projects/42/cohorts/"],
      ["POST", "/api/projects/42/cohorts/"],
      ["POST", "/api/projects/42/surveys/"],
      ["PATCH", "/api/projects/42/surveys/survey-1/"],
      ["POST", "/api/projects/42/surveys/survey-1/summarize_responses/"],
      ["GET", "/api/environments/42/session_recordings/"],
      ["POST", "/api/projects/42/session_recordings/"],
      ["PATCH", "/api/projects/42/session_recordings/recording-1/"],
      ["DELETE", "/api/projects/42/session_recordings/recording-1/"],
      ["GET", "/api/projects/42/session_recordings/recording-1/snapshots/"],
      ["POST", "/api/projects/42/experiments/"],
      ["PATCH", "/api/projects/42/experiments/9/"],
      ["DELETE", "/api/projects/42/experiments/9/"],
      ["GET", "/api/projects/42/persons/"],
      ["PATCH", "/api/environments/42/error_tracking/issues/issue-1/"],
      ["POST", "/api/environments/42/error_tracking/releases/"],
      ["POST", "/api/environments/42/error_tracking/symbol_sets/bulk_start_upload/"],
    ];

    for (const [method, path] of retiredRequests) {
      const headers = new Headers({ authorization: `Bearer ${project.accessToken}` });
      const hasBody = !["GET", "HEAD"].includes(method);
      if (hasBody) headers.set("content-type", "application/json");
      const response = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers,
        ...(hasBody ? { body: JSON.stringify({ status: "resolved" }) } : {}),
        redirect: "manual",
      });
      expect(response.status, `${method} ${path}`).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: "fake_posthog_route_not_allowed",
        method,
        path,
      });
    }

    expect(server.unexpectedRequests).toEqual(
      retiredRequests.map(([method, path]) => ({ method, path })),
    );
    expect(project.errorIssues[0]?.status).toBe("active");
    expect(server).not.toHaveProperty("provisionRequests");
    expect(server).not.toHaveProperty("projectMutationRequests");
    expect(server).not.toHaveProperty("captureRequests");
    expect(project).not.toHaveProperty("apiToken");
    expect(project).not.toHaveProperty("cohorts");
    expect(project).not.toHaveProperty("recordings");
    expect(project.sessionRecordings).toHaveLength(2);
    expect(project.featureFlags).toHaveLength(1);
    expect(project.surveys).toHaveLength(1);
    expect(project.experiments).toHaveLength(1);
    expect(project).not.toHaveProperty("symbolSets");
    expect(project).not.toHaveProperty("errorReleases");
  });
});
