import { Hono } from "hono";
import { z } from "zod";
import { errors } from "@agentrysh/shared";
import type { AppBindings } from "../env.js";
import { readBoundedJson } from "../bounded-json.js";
import { requireApiKey, requireProjectOwner } from "../middleware.js";
import {
  beginPosthogConnection,
  claimPosthogAuthorization,
  detachPosthogConnection,
  readPosthogConnection,
  settlePosthogOauthCallback,
  type PosthogOauthCallbackResult,
} from "../posthog-connection.js";
import {
  POSTHOG_OAUTH_CALLBACK_PATH,
  POSTHOG_OAUTH_CLIENT_PATH,
  POSTHOG_OAUTH_SCOPES,
  posthogOauthClientId,
  posthogOauthRedirectUri,
} from "../posthog-oauth.js";

const router = new Hono<AppBindings>();
const MAX_CONNECTION_BODY_BYTES = 4_096;

const ConnectSchema = z.object({
  intent: z.literal("connect"),
  region: z.enum(["us", "eu"]),
  // Optional assertion for callers that already know the intended project.
  // Project selection itself still happens in PostHog's consent screen.
  posthog_project_id: z.number().int().positive().optional(),
}).strict();

const ClaimSchema = z.object({
  intent: z.literal("claim"),
  authorization_id: z.string().uuid(),
}).strict();

const ConnectionIntentSchema = z.discriminatedUnion("intent", [
  ConnectSchema,
  ClaimSchema,
]);

router.get(POSTHOG_OAUTH_CLIENT_PATH, (c) => {
  const origin = new URL(c.req.url).origin;
  const clientId = posthogOauthClientId(c.env, origin);
  const redirectUri = posthogOauthRedirectUri(c.env, origin);
  return c.json({
    client_id: clientId,
    client_name: "Agentry",
    client_uri: "https://agentry.sh",
    application_type: "web",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    // PostHog CIMD reads its server-side scope ceiling from this namespace.
    // The authorization request repeats the same exact set, so neither the
    // metadata document nor a future client change can silently broaden it.
    "com.posthog": {
      scopes: [...POSTHOG_OAUTH_SCOPES],
    },
  }, 200, {
    "cache-control": "public, max-age=300",
  });
});

router.get(POSTHOG_OAUTH_CALLBACK_PATH, async (c) => {
  const state = boundedQuery(c.req.query("state"), 1_024);
  const code = boundedQuery(c.req.query("code"), 8_192);
  const providerError = boundedQuery(c.req.query("error"), 200);
  const result = state
    ? await settlePosthogOauthCallback({
        env: c.env,
        state,
        ...(code ? { code } : {}),
        ...(providerError ? { provider_error: providerError } : {}),
      })
    : { outcome: "failed", project_id: null, error_code: "invalid_oauth_state" } as const;
  return oauthCallbackPage(result);
});

router.get(
  "/v1/projects/:project_id/posthog-connection",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    return c.json({ connection: await readPosthogConnection(c.env, projectId) });
  },
);

router.post(
  "/v1/projects/:project_id/posthog-connection",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    const parsed = ConnectionIntentSchema.safeParse(
      await readBoundedJson(c, MAX_CONNECTION_BODY_BYTES),
    );
    if (!parsed.success) {
      throw errors.invalidPayload({ zod: parsed.error.flatten() });
    }
    const user = c.get("user");
    if (parsed.data.intent === "claim") {
      return c.json(await claimPosthogAuthorization({
        env: c.env,
        authorization_id: parsed.data.authorization_id,
        project_id: projectId,
        user_id: user.id,
      }));
    }
    return c.json(await beginPosthogConnection({
      env: c.env,
      project_id: projectId,
      user_id: user.id,
      request_origin: new URL(c.req.url).origin,
      region: parsed.data.region,
      ...(parsed.data.posthog_project_id
        ? { posthog_project_id: parsed.data.posthog_project_id }
        : {}),
    }));
  },
);

router.delete(
  "/v1/projects/:project_id/posthog-connection",
  requireApiKey(),
  async (c) => {
    const projectId = c.req.param("project_id");
    await requireProjectOwner(c, projectId);
    return c.json(await detachPosthogConnection({
      env: c.env,
      project_id: projectId,
      user_id: c.get("user").id,
    }));
  },
);

function boundedQuery(value: string | undefined, maxLength: number): string | undefined {
  return value && value.length <= maxLength ? value : undefined;
}

function oauthCallbackPage(result: PosthogOauthCallbackResult): Response {
  if (result.outcome === "authorization_ready") {
    const target = new URL(result.handoff_redirect_uri);
    if (result.handoff_ticket) target.searchParams.set("ticket", result.handoff_ticket);
    else target.searchParams.set("error", "posthog_handoff_replayed");
    return loopbackRedirect(target);
  }
  if (
    (result.outcome === "failed" || result.outcome === "expired") &&
    result.handoff_redirect_uri
  ) {
    const target = new URL(result.handoff_redirect_uri);
    target.searchParams.set(
      "error",
      result.outcome === "failed" ? result.error_code : "posthog_authorization_expired",
    );
    return loopbackRedirect(target);
  }
  const presentation = result.outcome === "active"
    ? {
        status: 200,
        title: "PostHog connected",
        message: "The selected project passed Agentry's read-capability checks. Return to the terminal.",
      }
    : result.outcome === "already_authorized"
        ? {
            status: 200,
            title: "PostHog already authorized",
            message: "This authorization was already completed. Return to the terminal.",
          }
        : result.outcome === "in_progress"
          ? {
              status: 202,
              title: "Connection is finishing",
              message: "Another callback is completing the same authorization. Return to the terminal and retry shortly.",
            }
          : result.outcome === "expired"
            ? {
                status: 410,
                title: "Authorization expired",
                message: "Return to the terminal and start a new PostHog connection.",
              }
            : {
                status: 400,
                title: "PostHog connection failed",
                message: `Return to the terminal and retry. Error: ${result.error_code}.`,
              };
  const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(presentation.title)}</title></head>
<body><main><h1>${escapeHtml(presentation.title)}</h1><p>${escapeHtml(presentation.message)}</p></main></body>
</html>`;
  return new Response(body, {
    status: presentation.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function loopbackRedirect(target: URL): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: target.toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export default router;
