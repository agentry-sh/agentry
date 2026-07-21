import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

const getPosthogConnectionAccessMock = vi.hoisted(() => vi.fn());

vi.mock("../src/posthog-connection.js", () => ({
  getPosthogConnectionAccess: (...args: unknown[]) =>
    getPosthogConnectionAccessMock(...args),
}));

import {
  isPosthogConfigured,
  posthogProjectApi,
  posthogTeamApi,
  runHogQl,
} from "../src/posthog.js";

const env = {
  AGENTRY_TOKEN_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
} as Env;

const oauthAccess = {
  connection_id: "phconn_test",
  project_id: "project_test",
  region: "eu" as const,
  posthog_host: "https://eu.posthog.com",
  posthog_project_id: 42,
  access_token: "oauth_access_test",
  scopes: [
    "project:read",
    "query:read",
    "error_tracking:read",
    "session_recording:read",
    "feature_flag:read",
    "survey:read",
    "experiment:read",
  ],
  version: 1,
};

describe("PostHog OAuth read path", () => {
  beforeEach(() => {
    getPosthogConnectionAccessMock.mockReset();
    getPosthogConnectionAccessMock.mockResolvedValue(oauthAccess);
    vi.stubGlobal("fetch", vi.fn());
  });

  it("runs HogQL against the selected Cloud region and environment with the OAuth bearer", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [[1]],
      columns: ["one"],
      types: ["Int64"],
    }), { status: 200 }));

    await expect(runHogQl(env, "project_test", "SELECT 1 AS one")).resolves.toEqual({
      results: [[1]],
      columns: ["one"],
      types: ["Int64"],
    });

    expect(getPosthogConnectionAccessMock).toHaveBeenCalledWith(env, "project_test");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.posthog.com/api/environments/42/query/");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth_access_test");
    expect(String(url)).not.toContain("/api/projects/9001/");
  });

  it("uses the same OAuth environment boundary for resource reads", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "issue-1" }] })),
    );

    await expect(posthogTeamApi(env, "project_test", "error_tracking/issues/", {
      query: { limit: 1 },
    })).resolves.toMatchObject({ teamId: 42, status: 200 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://eu.posthog.com/api/environments/42/error_tracking/issues/?limit=1",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth_access_test");
    }
  });

  it("uses a GET-only project boundary for first-class PostHog resources", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: 7, key: "checkout-v2" }] })),
    );

    await expect(posthogProjectApi(env, "project_test", "feature_flags", {
      query: { limit: 10, offset: 0 },
    })).resolves.toMatchObject({
      teamId: 42,
      posthogHost: "https://eu.posthog.com",
      status: 200,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.posthog.com/api/projects/42/feature_flags/?limit=10&offset=0");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth_access_test");
  });

  it("allows only the explicit body-based Error Tracking read endpoints", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ results: [] })));

    await posthogTeamApi(env, "project_test", "error_tracking/query/issues/", {
      method: "POST",
      body: { status: "active", limit: 10 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.posthog.com/api/environments/42/error_tracking/query/issues/");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ status: "active", limit: 10 }));
  });

  it("fails closed before loading OAuth credentials or sending provider writes", async () => {
    const fetchMock = vi.mocked(fetch);

    await expect(posthogTeamApi(env, "project_test", "feature_flags/", {
      method: "POST",
      body: { key: "must-not-exist" },
    })).rejects.toMatchObject({ code: "posthog_write_not_authorized", status: 403 });
    await expect(posthogTeamApi(env, "project_test", "error_tracking/issues/issue-1/", {
      method: "PATCH",
      body: { status: "resolved" },
    })).rejects.toMatchObject({ code: "posthog_write_not_authorized", status: 403 });
    expect(getPosthogConnectionAccessMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires only the control-plane encryption key at deployment scope", () => {
    expect(isPosthogConfigured({} as Env)).toBe(false);
    expect(isPosthogConfigured({ AGENTRY_TOKEN_ENC_KEY: env.AGENTRY_TOKEN_ENC_KEY } as Env))
      .toBe(true);
  });
});
