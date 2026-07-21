import { afterEach, describe, expect, it, vi } from "vitest";
import {
  POSTHOG_OAUTH_CALLBACK_PATH,
  POSTHOG_OAUTH_SCOPES,
  createPosthogOauthAuthorization,
  exchangePosthogOauthCode,
  refreshPosthogOauthTokens,
  revokePosthogOauthToken,
  resolvePosthogScopedProject,
  verifyPosthogReadCapabilities,
} from "../src/posthog-oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PostHog Cloud OAuth primitives", () => {
  it("builds a PKCE authorization URL with OIDC identity and approved read scopes", async () => {
    const authorization = await createPosthogOauthAuthorization({
      env: {
        TURSO_DATABASE_URL: "file:test",
        TURSO_AUTH_TOKEN: "test",
      },
      request_origin: "https://api.agentry.sh",
      region: "eu",
    });

    const url = new URL(authorization.authorization_url);
    expect(url.origin).toBe("https://eu.posthog.com");
    expect(url.pathname).toBe("/oauth/authorize/");
    expect(url.searchParams.get("client_id")).toBe(
      "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      `https://api.agentry.sh${POSTHOG_OAUTH_CALLBACK_PATH}`,
    );
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...POSTHOG_OAUTH_SCOPES]);
    expect(POSTHOG_OAUTH_SCOPES).toEqual(expect.arrayContaining(["openid", "email"]));
    expect(POSTHOG_OAUTH_SCOPES).not.toContain("profile");
    expect(url.searchParams.get("required_access_level")).toBe("project");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBe(authorization.nonce);
    expect(authorization.state).not.toBe(authorization.state_sha256);
    expect(authorization.nonce).not.toBe(authorization.nonce_sha256);
    expect(authorization.nonce_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(authorization.code_verifier).not.toBe(authorization.code_challenge);
  });

  it("exchanges the code without exposing provider tokens in a URL", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(String(request)).toBe("https://us.posthog.com/oauth/token/");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        grant_type: "authorization_code",
        code: "provider-code",
        code_verifier: "pkce-verifier",
      });
      expect(String(request)).not.toContain("provider-code");
      return Response.json({
        access_token: "pha_access",
        refresh_token: "phr_refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: POSTHOG_OAUTH_SCOPES.join(" "),
        id_token: "header.payload.signature",
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await exchangePosthogOauthCode({
      region: "us",
      code: "provider-code",
      code_verifier: "pkce-verifier",
      client_id: "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      redirect_uri: `https://api.agentry.sh${POSTHOG_OAUTH_CALLBACK_PATH}`,
    });

    expect(tokens.access_token).toBe("pha_access");
    expect(tokens.refresh_token).toBe("phr_refresh");
    expect(tokens.id_token).toBe("header.payload.signature");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires an ID token on the initial exchange but not on refresh", async () => {
    const fetchMock = vi.fn(async (_request: RequestInfo | URL, _init?: RequestInit) => {
      return Response.json({
        access_token: "pha_access",
        refresh_token: "phr_refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: POSTHOG_OAUTH_SCOPES.join(" "),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangePosthogOauthCode({
      region: "us",
      code: "provider-code",
      code_verifier: "pkce-verifier",
      client_id: "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      redirect_uri: `https://api.agentry.sh${POSTHOG_OAUTH_CALLBACK_PATH}`,
    })).rejects.toMatchObject({
      operation: "oauth_code_exchange",
      status: 502,
    });

    await expect(refreshPosthogOauthTokens({
      region: "us",
      refresh_token: "phr_refresh",
      client_id: "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
    })).resolves.toMatchObject({
      access_token: "pha_access",
      refresh_token: "phr_refresh",
    });
  });

  it("does not follow redirects while sending a provider token for revocation", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(String(request)).toBe("https://eu.posthog.com/oauth/revoke/");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(JSON.parse(String(init?.body))).toEqual({
        token: "provider-refresh-token",
        token_type_hint: "refresh_token",
        client_id: "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokePosthogOauthToken({
      region: "eu",
      token: "provider-refresh-token",
      token_type_hint: "refresh_token",
      client_id: "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
    })).resolves.toBe(true);
  });

  it("resolves exactly one provider-scoped project without a metadata lookup", () => {
    const baseTokens = {
      access_token: "pha_access",
      refresh_token: "phr_refresh",
      expires_in: 3_600,
      token_type: "Bearer",
      scope: POSTHOG_OAUTH_SCOPES.join(" "),
    };

    expect(resolvePosthogScopedProject({
      ...baseTokens,
      scoped_teams: [42],
      scoped_organizations: ["11111111-1111-4111-8111-111111111111"],
    })).toEqual({
      posthog_project_id: 42,
      organization_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(resolvePosthogScopedProject({ ...baseTokens, scoped_teams: [42] }))
      .toEqual({ posthog_project_id: 42, organization_id: null });
    expect(resolvePosthogScopedProject({ ...baseTokens, scoped_teams: [] })).toBeNull();
    expect(resolvePosthogScopedProject({ ...baseTokens, scoped_teams: [42, 43] })).toBeNull();
    expect(resolvePosthogScopedProject({ ...baseTokens, scoped_teams: [42, 42] })).toBeNull();
  });

  it("requires constant-query access but records optional read gaps", async () => {
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      const url = new URL(String(request));
      if (url.pathname.endsWith("/query/")) return Response.json({ results: [[1]] });
      if (url.pathname.includes("error_tracking")) {
        return Response.json({ detail: "not enabled" }, { status: 403 });
      }
      return Response.json({ count: 0, results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await verifyPosthogReadCapabilities({
      region: "eu",
      access_token: "pha_access",
      posthog_project_id: 42,
    });

    expect(snapshot.query_read).toBe(true);
    expect(snapshot.version).toBe("posthog-cloud-read-v2");
    expect(snapshot.event_definitions_read).toBe(true);
    expect(snapshot.property_definitions_read).toBe(true);
    expect(snapshot.error_tracking_read).toBe(false);
    expect(snapshot.session_recordings_read).toBe(true);
    expect(snapshot.feature_flags_read).toBe(true);
    expect(snapshot.surveys_read).toBe(true);
    expect(snapshot.experiments_read).toBe(true);
    expect(snapshot.issues).toEqual([{
      capability: "error_tracking_read",
      upstream_status: 403,
    }]);
  });
});
