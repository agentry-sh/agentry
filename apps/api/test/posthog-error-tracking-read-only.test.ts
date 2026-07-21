import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  cases,
  posthogConnections,
  projects,
  users,
} from "@agentry/db/schema";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";
import { customerCaseFilter } from "../src/customer-data.js";

const posthogTeamApiMock = vi.hoisted(() => vi.fn());

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

vi.mock("../src/posthog.js", () => ({
  posthogTeamApi: (...args: unknown[]) => posthogTeamApiMock(...args),
  encryptToken: vi.fn(),
  decryptToken: vi.fn(),
}));

import {
  listPosthogIssues,
  posthogEventObservation,
  projectPosthogIssue,
  synchronizeAllPosthogCasesForProject,
  sweepPosthogCaseProjections,
} from "../src/posthog-error-tracking.js";

const OWNER_ID = "user_posthog_error_projection";
const ACTIVE_PROJECT_ID = "project_posthog_active";
const DETACHED_PROJECT_ID = "project_posthog_detached";
const NOW = 1_784_076_000;

let env: TestEnv;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(users).values({ id: OWNER_ID, email: "posthog-errors@example.test" });
  await db.insert(projects).values([
    {
      id: ACTIVE_PROJECT_ID,
      userId: OWNER_ID,
      name: "Active PostHog project",
    },
    {
      id: DETACHED_PROJECT_ID,
      userId: OWNER_ID,
      name: "Detached PostHog project",
    },
  ]);
  await db.insert(posthogConnections).values([
    {
      id: "phconn_active",
      projectId: ACTIVE_PROJECT_ID,
      authorizedByUserId: OWNER_ID,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: NOW + 3_600,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org_active",
      posthogEnvironmentId: 42,
      authorizedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "phconn_detached",
      projectId: DETACHED_PROJECT_ID,
      authorizedByUserId: OWNER_ID,
      detachedByUserId: OWNER_ID,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "detached",
      posthogHost: "https://eu.posthog.com",
      posthogRegion: "eu",
      authorizedAt: NOW,
      detachedAt: NOW + 1,
      createdAt: NOW,
      updatedAt: NOW + 1,
    },
  ]);
  posthogTeamApiMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  disposeTestEnv(env);
});

describe("read-only PostHog Error Tracking projection", () => {
  it("uses only the bounded Error Tracking read query", async () => {
    posthogTeamApiMock.mockResolvedValue({
      teamId: 42,
      status: 200,
      data: {
        results: Array.from({ length: 4 }, (_, index) => ({
          id: `issue-${index}`,
          status: "active",
        })),
        hasMore: true,
        limit: 4,
        offset: 0,
        nextOffset: 4,
      },
    });

    const result = await listPosthogIssues(env, ACTIVE_PROJECT_ID, { limit: 2 });

    expect(result.results.map((issue) => issue.id)).toEqual(["issue-0", "issue-1"]);
    expect(posthogTeamApiMock).toHaveBeenCalledWith(
      env,
      ACTIVE_PROJECT_ID,
      "error_tracking/query/issues/",
      expect.objectContaining({ method: "POST" }),
    );
    expect(posthogTeamApiMock.mock.calls).toSatisfy((calls: unknown[][]) =>
      calls.every((call) => (call[3] as { method?: string }).method === "POST")
    );
  });

  it("projects redacted evidence with customer PostHog OAuth provenance", async () => {
    const rawSecret = "agentry_sk_this_must_not_be_persisted";
    const projected = await projectPosthogIssue(
      env,
      ACTIVE_PROJECT_ID,
      {
        id: "issue-redacted",
        name: "TypeError",
        description: "fallback",
        status: "active",
        first_seen: "2026-07-14T12:00:00.000Z",
        last_seen: "2026-07-15T12:00:00.000Z",
        aggregations: { occurrences: 3, users: 2 },
      },
      {
        uuid: "event-redacted",
        timestamp: "2026-07-15T12:00:00.000Z",
        properties: {
          $agentry_trust_level: "customer_posthog",
          $agentry_credential_kind: "posthog_oauth",
          $agentry_credential_id: "forged-credential",
          $exception_list: [{
            type: "TypeError",
            value: `failed with ${rawSecret} at https://example.test/path?email=user@example.test#private`,
          }],
        },
      },
    );

    expect(projected.row).toMatchObject({
      lastTrustLevel: "customer_posthog",
      lastCredentialKind: "posthog_oauth",
      providerIssueId: "issue-redacted",
      providerEventClassification: "customer_exception",
      eventCount: 3,
    });
    expect(projected.row.message).not.toContain(rawSecret);
    expect(projected.row.message).not.toContain("user@example.test");
    expect(projected.row.message).toContain("[REDACTED_SECRET]");
    expect(projected.row.message).toContain("https://example.test/path");

    const stored = (
      await getDbForUrl(env.TURSO_DATABASE_URL).select().from(cases)
        .where(eq(cases.id, "issue-redacted")).limit(1)
    )[0]!;
    expect(stored.lastTrustLevel).toBe("customer_posthog");
    expect(stored.lastCredentialKind).toBe("posthog_oauth");
    expect(stored.providerEventClassification).toBe("customer_exception");
    expect(stored.message).not.toContain(rawSecret);
  });

  it("fails closed on an unknown provider issue status", async () => {
    posthogTeamApiMock.mockResolvedValue({
      teamId: 42,
      status: 200,
      data: {
        results: [{ id: "issue-new-status", status: "provider_added_this_yesterday" }],
        hasMore: false,
        limit: 1,
        offset: 0,
        nextOffset: null,
      },
    });

    await expect(listPosthogIssues(env, ACTIVE_PROJECT_ID, { limit: 1 }))
      .rejects.toMatchObject({ code: "posthog_upstream_failed" });
    expect((await getDbForUrl(env.TURSO_DATABASE_URL).select().from(cases)).length).toBe(0);
  });

  it("keeps a merged onboarding-proof exception sticky and out of customer classification", async () => {
    const issueId = "issue-merged-onboarding-proof";
    const baseIssue = {
      id: issueId,
      name: "ExpectedProofError",
      description: "safe proof",
      status: "active",
      first_seen: "2026-07-15T12:00:00.000Z",
      last_seen: "2026-07-15T12:00:01.000Z",
      aggregations: { occurrences: 1, users: 1 },
    };
    const first = await projectPosthogIssue(env, ACTIVE_PROJECT_ID, baseIssue, {
      uuid: "event-customer-first",
      properties: { $exception_list: [{ type: "Error", value: "customer error" }] },
    });
    expect(first.row.providerEventClassification).toBe("customer_exception");

    const proofMarker = "agentry_proof_runtime_secret-marker-never-store";
    const merged = await projectPosthogIssue(
      env,
      ACTIVE_PROJECT_ID,
      {
        ...baseIssue,
        last_seen: "2026-07-15T12:00:02.000Z",
        aggregations: { occurrences: 2, users: 1 },
      },
      {
        uuid: "event-proof-merged",
        properties: {
          agentry_onboarding_proof: proofMarker,
          agentry_onboarding_failure: "expected-safe-failure",
          $exception_list: [{ type: "ExpectedProofError", value: "safe proof" }],
        },
      },
    );
    expect(merged.row).toMatchObject({
      id: issueId,
      providerEventClassification: "onboarding_proof_exception",
      revision: 2,
    });
    expect(JSON.stringify(merged.row)).not.toContain(proofMarker);

    const laterCustomerEvent = await projectPosthogIssue(
      env,
      ACTIVE_PROJECT_ID,
      {
        ...baseIssue,
        last_seen: "2026-07-15T12:00:03.000Z",
        aggregations: { occurrences: 3, users: 1 },
      },
      {
        uuid: "event-customer-later",
        properties: { $exception_list: [{ type: "Error", value: "customer error again" }] },
      },
    );
    expect(laterCustomerEvent.row.providerEventClassification)
      .toBe("onboarding_proof_exception");
    expect((await getDbForUrl(env.TURSO_DATABASE_URL).select().from(cases)
      .where(customerCaseFilter)).map((row) => row.id)).not.toContain(issueId);
  });

  it("re-reads the winner when concurrent callers create the first projection", async () => {
    const issue = {
      id: "issue-concurrent-first-projection",
      name: "ConcurrentError",
      status: "active",
      first_seen: "2026-07-15T12:00:00.000Z",
      last_seen: "2026-07-15T12:00:01.000Z",
      aggregations: { occurrences: 1, users: 1 },
    };
    const event = {
      uuid: "event-concurrent-first-projection",
      properties: { $exception_list: [{ type: "ConcurrentError", value: "boom" }] },
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        projectPosthogIssue(env, ACTIVE_PROJECT_ID, issue, event)),
    );

    expect(results).toHaveLength(4);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await getDbForUrl(env.TURSO_DATABASE_URL).select().from(cases)
      .where(eq(cases.providerIssueId, issue.id))).length).toBe(1);
  });

  it("discloses a resumable cursor when the bounded full sync truncates", async () => {
    posthogTeamApiMock.mockImplementation(async (
      _env: unknown,
      _projectId: string,
      path: string,
      options: { body?: { offset?: number } },
    ) => {
      if (path === "error_tracking/query/issue_events/") {
        return {
          teamId: 42,
          status: 200,
          data: {
            results: [{
              uuid: "event-pagination-disclosure",
              properties: { $exception_list: [{ type: "Error", value: "bounded" }] },
            }],
            hasMore: false,
            limit: 20,
            offset: 0,
            nextOffset: null,
          },
        };
      }
      expect(path).toBe("error_tracking/query/issues/");
      const offset = options.body?.offset ?? 0;
      return {
        teamId: 42,
        status: 200,
        data: {
          results: [{
            id: "issue-pagination-disclosure",
            name: "PaginationError",
            status: "active",
            first_seen: "2026-07-15T12:00:00.000Z",
            last_seen: "2026-07-15T12:00:01.000Z",
            aggregations: { occurrences: 1, users: 1 },
          }],
          hasMore: offset < 5,
          limit: 100,
          offset,
          nextOffset: offset < 5 ? offset + 1 : null,
        },
      };
    });

    await expect(synchronizeAllPosthogCasesForProject(env, ACTIVE_PROJECT_ID))
      .resolves.toEqual({
        pages: 5,
        projected: 5,
        changed: 1,
        truncated: true,
        has_more: true,
        cursor: 5,
      });
    await expect(synchronizeAllPosthogCasesForProject(env, ACTIVE_PROJECT_ID, { cursor: 5 }))
      .resolves.toEqual({
        pages: 1,
        projected: 1,
        changed: 0,
        truncated: false,
        has_more: false,
        cursor: null,
      });
  });

  it("returns a bounded live sample without raw request secrets or URL queries", () => {
    const observation = posthogEventObservation({
      uuid: "event-observation",
      distinct_id: "person-1",
      timestamp: "2026-07-15T12:00:00.000Z",
      properties: {
        $agentry_trust_level: "customer_posthog",
        $agentry_credential_kind: "posthog_oauth",
        $current_url: "https://app.example.test/settings?token=secret#account",
        $exception_request: {
          method: "POST",
          url: "https://api.example.test/action?authorization=secret#fragment",
          headers: { authorization: "Bearer do-not-return" },
          body: "do-not-return",
        },
        $exception_list: [{
          type: "Error",
          value: "boom",
          stacktrace: {
            frames: [{
              filename: "https://cdn.example.test/app.js?build=secret#source",
              function: "submit",
              lineno: 10,
            }],
          },
        }],
      },
    });

    expect(observation.emitter).toEqual({
      trust_level: "customer_posthog",
      credential_kind: "posthog_oauth",
      credential_id: null,
    });
    expect(observation.evidence.current_url).toBe("https://app.example.test/settings");
    expect(observation.evidence.request).toEqual({
      method: "POST",
      url: "https://api.example.test/action",
      path: null,
    });
    expect(JSON.stringify(observation.evidence)).not.toContain("do-not-return");
    expect(JSON.stringify(observation.evidence)).not.toContain("build=secret");
  });

  it("sweeps only active OAuth connections", async () => {
    posthogTeamApiMock.mockResolvedValue({
      teamId: 42,
      status: 200,
      data: { results: [], hasMore: false, limit: 100, offset: 0, nextOffset: null },
    });

    await expect(sweepPosthogCaseProjections(env)).resolves.toEqual({
      projects: 1,
      projected: 0,
      changed: 0,
      errors: [],
    });
    expect(posthogTeamApiMock).toHaveBeenCalledTimes(1);
    expect(posthogTeamApiMock.mock.calls[0]?.[1]).toBe(ACTIVE_PROJECT_ID);
    expect(posthogTeamApiMock.mock.calls.some((call) => call[1] === DETACHED_PROJECT_ID)).toBe(false);
    const connection = (await getDbForUrl(env.TURSO_DATABASE_URL)
      .select()
      .from(posthogConnections)
      .where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID)))[0]!;
    expect(connection.caseProjectionOffset).toBe(0);
    expect(connection.caseProjectionLastAttemptAt).toBeGreaterThan(0);
    expect(connection.caseProjectionLastCompletedAt).toBe(
      connection.caseProjectionLastAttemptAt,
    );
  });

  it("persists page progress and round-robins connections by last attempt", async () => {
    const secondProjectId = "project_posthog_second";
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    await db.insert(projects).values({
      id: secondProjectId,
      userId: OWNER_ID,
      name: "Second active PostHog project",
    });
    await db.insert(posthogConnections).values({
      id: "phconn_second",
      projectId: secondProjectId,
      authorizedByUserId: OWNER_ID,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access-2",
      accessTokenIv: "access-iv-2",
      refreshTokenCiphertext: "encrypted-refresh-2",
      refreshTokenIv: "refresh-iv-2",
      accessTokenExpiresAt: NOW + 3_600,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org_second",
      posthogEnvironmentId: 43,
      authorizedAt: NOW,
      createdAt: NOW + 1,
      updatedAt: NOW + 1,
    });

    posthogTeamApiMock.mockImplementation(async (
      _env: unknown,
      projectId: string,
      path: string,
      options: { body?: { offset?: number } },
    ) => {
      if (path === "error_tracking/query/issue_events/") {
        return {
          teamId: 42,
          status: 200,
          data: { results: [], hasMore: false, limit: 1, offset: 0, nextOffset: null },
        };
      }
      expect(path).toBe("error_tracking/query/issues/");
      const offset = options.body?.offset ?? 0;
      if (projectId === secondProjectId) {
        return {
          teamId: 43,
          status: 200,
          data: { results: [], hasMore: false, limit: 1, offset, nextOffset: null },
        };
      }
      const issueNumber = offset + 1;
      return {
        teamId: 42,
        status: 200,
        data: {
          results: [{
            id: `issue-page-${issueNumber}`,
            name: "PagedError",
            description: `page ${issueNumber}`,
            status: "active",
            first_seen: "2026-07-15T12:00:00.000Z",
            last_seen: `2026-07-15T12:00:0${issueNumber}.000Z`,
            aggregations: { occurrences: issueNumber, users: 1 },
          }],
          hasMore: offset === 0,
          limit: 1,
          offset,
          nextOffset: offset === 0 ? 1 : null,
        },
      };
    });

    await sweepPosthogCaseProjections(env, { projectLimit: 1, issueLimit: 1 });
    let first = (await db.select().from(posthogConnections)
      .where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID)))[0]!;
    expect(first).toMatchObject({
      caseProjectionOffset: 1,
      caseProjectionLastCompletedAt: null,
    });

    await sweepPosthogCaseProjections(env, { projectLimit: 1, issueLimit: 1 });
    const second = (await db.select().from(posthogConnections)
      .where(eq(posthogConnections.projectId, secondProjectId)))[0]!;
    expect(second.caseProjectionOffset).toBe(0);
    expect(second.caseProjectionLastCompletedAt).toBeGreaterThan(0);

    await sweepPosthogCaseProjections(env, { projectLimit: 1, issueLimit: 1 });
    first = (await db.select().from(posthogConnections)
      .where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID)))[0]!;
    expect(first.caseProjectionOffset).toBe(0);
    expect(first.caseProjectionLastCompletedAt).toBeGreaterThan(0);

    const issueListProjects = posthogTeamApiMock.mock.calls
      .filter((call) => call[2] === "error_tracking/query/issues/")
      .map((call) => call[1]);
    expect(issueListProjects).toEqual([
      ACTIVE_PROJECT_ID,
      secondProjectId,
      ACTIVE_PROJECT_ID,
    ]);
  });

  it("does not write a cursor when the connection version changes during a sweep", async () => {
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    posthogTeamApiMock.mockImplementation(async (
      _env: unknown,
      projectId: string,
      path: string,
    ) => {
      expect(projectId).toBe(ACTIVE_PROJECT_ID);
      expect(path).toBe("error_tracking/query/issues/");
      await db.update(posthogConnections).set({
        version: sql`${posthogConnections.version} + 1`,
      }).where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID));
      return {
        teamId: 42,
        status: 200,
        data: { results: [], hasMore: false, limit: 100, offset: 0, nextOffset: null },
      };
    });

    const result = await sweepPosthogCaseProjections(env);

    expect(result).toMatchObject({ projects: 1, projected: 0, changed: 0 });
    expect(result.errors).toEqual([{
      project_id: ACTIVE_PROJECT_ID,
      error: expect.stringContaining("no stale cursor was written"),
    }]);
    const connection = (await db.select().from(posthogConnections)
      .where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID)))[0]!;
    expect(connection).toMatchObject({
      version: 2,
      caseProjectionOffset: 0,
      caseProjectionLastAttemptAt: null,
      caseProjectionLastCompletedAt: null,
    });
  });

  it("purges a late old-provider projection and resets the winner identity after a rebind race", async () => {
    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    let rebound = false;
    posthogTeamApiMock.mockImplementation(async (
      _env: unknown,
      projectId: string,
      path: string,
    ) => {
      expect(projectId).toBe(ACTIVE_PROJECT_ID);
      if (path === "error_tracking/query/issues/") {
        if (!rebound) {
          rebound = true;
          await db.update(posthogConnections).set({
            posthogHost: "https://eu.posthog.com",
            posthogRegion: "eu",
            posthogEnvironmentId: 43,
            caseProjectionOffset: 9,
            caseProjectionLastAttemptAt: NOW + 10,
            caseProjectionLastCompletedAt: NOW + 10,
            version: sql`${posthogConnections.version} + 1`,
            updatedAt: NOW + 10,
          }).where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID));
        }
        return {
          teamId: 42,
          status: 200,
          data: {
            results: [{
              id: "old-provider-race-issue",
              name: "OldProviderError",
              description: "must not survive",
              status: "active",
              first_seen: "2026-07-15T12:00:00.000Z",
              last_seen: "2026-07-15T12:01:00.000Z",
              aggregations: { occurrences: 1, users: 1 },
            }],
            hasMore: false,
            limit: 100,
            offset: 0,
            nextOffset: null,
          },
        };
      }
      expect(path).toBe("error_tracking/query/issue_events/");
      return {
        teamId: 42,
        status: 200,
        data: {
          results: [{
            uuid: "old-provider-race-event",
            timestamp: "2026-07-15T12:01:00.000Z",
            properties: {
              $exception_list: [{ type: "OldProviderError", value: "must not survive" }],
            },
          }],
          hasMore: false,
          limit: 1,
          offset: 0,
          nextOffset: null,
        },
      };
    });

    const result = await sweepPosthogCaseProjections(env);

    expect(result).toMatchObject({ projects: 1, projected: 0, changed: 0 });
    expect(result.errors).toEqual([{
      project_id: ACTIVE_PROJECT_ID,
      error: expect.stringContaining("stale projections were discarded"),
    }]);
    expect(await db.select().from(cases)
      .where(eq(cases.projectId, ACTIVE_PROJECT_ID))).toEqual([]);
    const connection = (await db.select().from(posthogConnections)
      .where(eq(posthogConnections.projectId, ACTIVE_PROJECT_ID)))[0]!;
    expect(connection).toMatchObject({
      posthogHost: "https://eu.posthog.com",
      posthogEnvironmentId: 43,
      caseProjectionOffset: 0,
      caseProjectionLastAttemptAt: null,
      caseProjectionLastCompletedAt: null,
      version: 3,
    });
  });
});
