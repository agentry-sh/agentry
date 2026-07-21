import { LEGACY_WORKFLOW_PATHS } from "./workflow-routes.generated.ts";

const REPOSITORY = "https://github.com/agentry-sh/agentry";
const RAW_ROOT = "https://raw.githubusercontent.com/agentry-sh/agentry/main";
const API_ORIGIN = "https://api.agentry.sh";
const AUTH_ORIGIN = "https://auth.agentry.sh";

const SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function redirect(location: string, status: 307 | 308, cacheControl: string): Response {
  return new Response(null, {
    status,
    headers: {
      location,
      "cache-control": cacheControl,
      ...SECURITY_HEADERS,
    },
  });
}

function samePathAt(origin: string, url: URL): string {
  const target = new URL(url.pathname, origin);
  target.search = url.search;
  return target.toString();
}

function isPath(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function legacyWorkflowTarget(pathname: string): string | null {
  for (const root of ["/workflows", "/playbooks", "/recipes"]) {
    if (!pathname.startsWith(`${root}/`)) continue;
    const candidate = pathname.slice(root.length + 1).replace(/\/$/, "");
    if (!/^[a-z0-9-]+(?:\.md)?$/.test(candidate)) return null;
    const slug = candidate.replace(/\.md$/, "");
    const repositoryPath = LEGACY_WORKFLOW_PATHS[slug];
    if (repositoryPath) return `${REPOSITORY}/blob/main/${repositoryPath}`;
  }
  return null;
}

function jsonResponse(
  method: string,
  body: Record<string, string>,
  status: number,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(method === "HEAD" ? null : `${JSON.stringify(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

export function routeApexRequest(request: Request): Response {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // The old apex API proxy is intentionally retired for every method. Never
  // redirect a request body or Authorization header across origins; return an
  // explicit recovery action without reflecting its query or credentials.
  if (isPath(url.pathname, "/v1")) {
    return jsonResponse(method, {
      error: "api_host_moved",
      canonical_origin: API_ORIGIN,
      canonical_url: `${API_ORIGIN}${url.pathname}`,
      next_action: "Retry against api.agentry.sh with the original method, body, credentials, and idempotency key.",
    }, 410);
  }

  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse(method, {
      error: "agentry_apex_is_read_only",
      message: "Send API requests directly to https://api.agentry.sh.",
    }, 405, { allow: "GET, HEAD" });
  }

  // The billing provider's return path keeps its exact session query on the
  // dedicated browser-page origin. Human identity now goes directly through
  // the PostHog OAuth callback on api.agentry.sh; there are no device-login or
  // invitation auth redirects at the apex.
  if (isPath(url.pathname, "/billing/success")) {
    return redirect(samePathAt(AUTH_ORIGIN, url), 307, "no-store");
  }

  if (isPath(url.pathname, "/adapters")) {
    return redirect(new URL(url.pathname, API_ORIGIN).toString(), 308, "public, max-age=300");
  }

  const permanentTargets = new Map([
    ["/install.md", `${RAW_ROOT}/INSTALL.md`],
    ["/agentry.md", `${RAW_ROOT}/AGENTRY.md`],
    ["/skill/agentry/SKILL.md", `${RAW_ROOT}/plugins/agentry/skills/agentry/SKILL.md`],
    ["/privacy", `${REPOSITORY}/blob/main/PRIVACY.md`],
    ["/terms", `${REPOSITORY}/blob/main/TERMS.md`],
    ["/pricing", `${REPOSITORY}/blob/main/PRICING.md`],
    ["/account", REPOSITORY],
  ]);
  const exactPath = url.pathname.length > 1 && url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  const exact = permanentTargets.get(exactPath);
  if (exact) return redirect(exact, 308, "public, max-age=3600");

  const workflowTarget = legacyWorkflowTarget(url.pathname);
  if (workflowTarget) {
    return redirect(workflowTarget, 308, "public, max-age=3600");
  }

  if (isPath(url.pathname, "/workflows") || isPath(url.pathname, "/playbooks") || isPath(url.pathname, "/recipes")) {
    return redirect(`${REPOSITORY}/tree/main/workflows`, 308, "public, max-age=3600");
  }

  // Unknown former marketing paths intentionally converge on the repository.
  // Query strings are dropped so OAuth codes, invite tokens, and campaign data
  // cannot leak into GitHub URLs.
  return redirect(REPOSITORY, 308, "public, max-age=3600");
}

export default {
  fetch(request: Request): Response {
    return routeApexRequest(request);
  },
};
