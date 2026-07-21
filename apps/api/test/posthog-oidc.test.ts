import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { base64url } from "@agentrysh/shared";
import {
  verifyPosthogOidcIdentity,
} from "../src/posthog-oauth.js";

const ISSUER = "https://us.posthog.com";
const CLIENT_ID = "https://api.agentry.test/v1/integrations/posthog/oauth/client";
const NONCE = "oidc-nonce-abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_ID = "posthog-test-key";

let signingKey: CryptoKey;
type TestJwk = JsonWebKey & {
  kid: string;
  use: "sig";
  alg: "RS256";
  key_ops: ["verify"];
};
let posthogJwk: TestJwk;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const exportedPublicKey = await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  ) as JsonWebKey;
  posthogJwk = {
    ...exportedPublicKey,
    kid: KEY_ID,
    use: "sig",
    alg: "RS256",
    key_ops: ["verify"],
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function encodedJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedIdToken(input: {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const header = encodedJson({
    alg: "RS256",
    typ: "JWT",
    kid: KEY_ID,
    ...input.header,
  });
  const payload = encodedJson({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "posthog-user-123",
    nonce: NONCE,
    iat: now - 5,
    exp: now + 300,
    email: "owner@example.com",
    email_verified: true,
    ...input.claims,
  });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

function jwksResponse(keys: unknown[] = [posthogJwk]): Response {
  return Response.json({ keys });
}

function installJwksFetch(keys: unknown[] = [posthogJwk]) {
  const fetchMock = vi.fn(async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => jwksResponse(keys));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function verify(idToken: string) {
  return verifyPosthogOidcIdentity({
    region: "us",
    id_token: idToken,
    client_id: CLIENT_ID,
    nonce: NONCE,
  });
}

describe("PostHog OIDC identity verification", () => {
  it("verifies a signed subject and treats email as optional metadata", async () => {
    const fetchMock = installJwksFetch();

    await expect(verify(await signedIdToken())).resolves.toEqual({
      issuer: ISSUER,
      subject: "posthog-user-123",
      email: "owner@example.com",
      email_verified: true,
    });
    await expect(verify(await signedIdToken({
      claims: { email: undefined, email_verified: undefined },
    }))).resolves.toEqual({
      issuer: ISSUER,
      subject: "posthog-user-123",
      email: null,
      email_verified: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://us.posthog.com/.well-known/jwks.json");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "manual",
        cache: "no-store",
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("user-agent")).toBe("agentry-api/1.0");
      expect(headers.has("authorization")).toBe(false);
    }
  });

  it("rejects signed tokens with the wrong identity or time claims", async () => {
    installJwksFetch();
    const now = Math.floor(Date.now() / 1_000);
    const invalidClaims: Array<Record<string, unknown>> = [
      { iss: "https://eu.posthog.com" },
      { aud: "a-different-client" },
      { aud: [CLIENT_ID, "a-second-audience"] },
      { nonce: "a-different-nonce" },
      { sub: "" },
      { exp: now - 61, iat: now - 300 },
      { iat: now + 61 },
      { nbf: now + 61 },
      { email: " owner@example.com" },
      { email_verified: "true" },
    ];

    for (const claims of invalidClaims) {
      await expect(verify(await signedIdToken({ claims }))).rejects.toMatchObject({
        operation: "verify_oidc_identity",
        status: 401,
        oauthCode: "invalid_id_token",
      });
    }
  });

  it("rejects non-RS256, unknown-key, and tampered tokens", async () => {
    const fetchMock = installJwksFetch();
    await expect(verify(await signedIdToken({
      header: { alg: "HS256" },
    }))).rejects.toMatchObject({ oauthCode: "invalid_id_token" });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(verify(await signedIdToken({
      header: { kid: "unknown-key" },
    }))).rejects.toMatchObject({ oauthCode: "invalid_id_token" });

    const signed = await signedIdToken();
    const [header, payload, encodedSignature] = signed.split(".") as [string, string, string];
    const signature = Uint8Array.from(
      Buffer.from(encodedSignature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    signature[0] = signature[0]! ^ 1;
    await expect(verify(`${header}.${payload}.${base64url(signature)}`)).rejects.toMatchObject({
      oauthCode: "invalid_id_token",
    });
  });

  it("bounds tokens and the provider key set before verification", async () => {
    const fetchMock = installJwksFetch();
    await expect(verify("a".repeat(32_769))).rejects.toMatchObject({
      oauthCode: "invalid_id_token",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const valid = await signedIdToken();
    fetchMock.mockResolvedValueOnce(jwksResponse(
      Array.from({ length: 17 }, (_, index) => ({
        ...posthogJwk,
        kid: `key-${index}`,
      })),
    ));
    await expect(verify(valid)).rejects.toMatchObject({
      operation: "fetch_oidc_jwks",
      status: 502,
      oauthCode: "jwks_unavailable",
    });

    fetchMock.mockResolvedValueOnce(jwksResponse([posthogJwk, posthogJwk]));
    await expect(verify(valid)).rejects.toMatchObject({
      operation: "fetch_oidc_jwks",
      oauthCode: "jwks_unavailable",
    });
  });

  it("fails closed when the pinned JWKS response is unavailable or oversized", async () => {
    const valid = await signedIdToken();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network details must not escape"))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(verify(valid)).rejects.toMatchObject({
      operation: "fetch_oidc_jwks",
      status: 502,
      oauthCode: "jwks_unavailable",
      bodyExcerpt: "The PostHog OIDC key set could not be fetched.",
    });
    await expect(verify(valid)).rejects.toMatchObject({
      operation: "fetch_oidc_jwks",
      status: 502,
      oauthCode: "jwks_unavailable",
      bodyExcerpt: "PostHog returned an unreadable OIDC key set.",
    });
  });
});
