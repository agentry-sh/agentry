import type { Context } from "hono";
import { matchedRoutes } from "hono/route";

export function canonicalRouteFor(c: Context): string {
  const matched = matchedRoutes(c)
    .map((route) => route.path.trim())
    .filter((path) => path && path !== "*" && path !== "/*")
    .at(-1);
  return matched ?? "unmatched";
}

export function normalizedRouteShape(path: string): string {
  return path
    .replace(/\{[^}/]+\}/g, ":param")
    .replace(/:[A-Za-z0-9_]+/g, ":param");
}

export function routeKindFor(path: string): string {
  if (path.startsWith("/admin/")) return "admin";
  if (path.startsWith("/v1/deploys")) return "ingest_deploys";
  if (path.startsWith("/v1/auth/")) return "auth";
  if (path.includes("/webhooks")) return "webhook";
  if (
    path.startsWith("/v1/query-blueprints") ||
    /^\/v1\/projects\/[^/]+\/query-blueprints(?:\/|$)/.test(path)
  ) {
    return "query_blueprint";
  }
  if (
    path.startsWith("/v1/cases") ||
    /^\/v1\/projects\/[^/]+\/cases(?:\/|$)/.test(path)
  ) {
    return "case";
  }
  if (path.startsWith("/v1/projects")) return "project";
  if (path === "/" || path.endsWith(".md") || path.includes("openapi")) return "discovery";
  return path.startsWith("/v1/") ? "api" : "public";
}

export function commandNameFor(method: string, path: string): string {
  return `${method.toLowerCase()} ${path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/:token")}`;
}

export function isDataQueryPath(method: string, path: string): boolean {
  if (method === "GET" && path === "/v1/audit/recent") return true;
  if (path.startsWith("/v1/cases")) return true;
  if (/^\/v1\/projects\/[^/]+\/cases(?:\/|$)/.test(path)) return true;
  if (method === "GET" && /^\/v1\/projects\/[^/]+\/deploys(?:\/|$)/.test(path)) return true;
  if (method === "GET" && /^\/v1\/projects\/[^/]+\/users(?:\/|$)/.test(path)) return true;
  if (method === "GET" && /^\/v1\/cases\/[^/]+\/users(?:\/|$)/.test(path)) return true;
  if (method === "POST" && /^\/v1\/projects\/[^/]+\/analytics\/query\/?$/.test(path)) return true;
  if (method === "POST" && /^\/v1\/projects\/[^/]+\/query-blueprints\/[^/]+\/run\/?$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/projects\/[^/]+\/event-names\/?$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/projects\/[^/]+\/event-property-keys\/?$/.test(path)) return true;
  if (
    method === "GET" &&
    /^\/v1\/projects\/[^/]+\/(?:session-recordings|feature-flags|surveys|experiments)(?:\/|$)/.test(path)
  ) return true;
  return false;
}

export function isCoreAgentRowQueryPath(method: string, path: string): boolean {
  return (method === "POST" && /^\/v1\/projects\/[^/]+\/analytics\/query\/?$/.test(path)) ||
    (method === "POST" && /^\/v1\/projects\/[^/]+\/query-blueprints\/[^/]+\/run\/?$/.test(path));
}
