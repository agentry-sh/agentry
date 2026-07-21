import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MUTATION_ROUTE_POLICIES,
  mutationRoutePolicyFor,
} from "../src/mutation-route-policy.js";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", () => ({
  getDb: (env: { TURSO_DATABASE_URL: string }) => getDbForUrl(env.TURSO_DATABASE_URL),
}));

const { createApp } = await import("../src/index.js");

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ enableTestLogin: true, withEncKey: true, fileDb: true });
  app = createApp();
});

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function chunkedBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoded = chunks.map((chunk) => new TextEncoder().encode(chunk));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = encoded.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
}

function streamedRequest(
  path: string,
  body: ReadableStream<Uint8Array>,
  init: { headers?: HeadersInit } = {},
): Request {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: init.headers,
    body,
    // Node's Request requires this for a streaming test body. Workers ignore it.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function jsonCall(path: string, init: { method?: string; headers?: HeadersInit; body?: unknown }) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return app.fetch(new Request(`http://test${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }), env);
}

describe("mutation request and retry policy", () => {
  it("keeps every runtime mutation in one explicit policy inventory", () => {
    const runtime = new Set(
      ((app as unknown as { routes: Array<{ method: string; path: string }> }).routes ?? [])
        .filter((route) => MUTATION_METHODS.has(route.method))
        .map((route) => `${route.method} ${route.path}`),
    );
    expect([...runtime].sort()).toEqual(Object.keys(MUTATION_ROUTE_POLICIES).sort());
    for (const [route, policy] of Object.entries(MUTATION_ROUTE_POLICIES)) {
      expect(policy.retry.rationale, `${route} retry rationale`).not.toHaveLength(0);
      if (policy.body.kind === "json" || policy.body.kind === "raw") {
        expect(policy.body.max_bytes, `${route} body limit`).toBeGreaterThan(0);
      }
      if (policy.body.kind === "none") expect(policy.body.max_bytes).toBe(0);
    }
  });

  it("publishes each body limit and retry contract in OpenAPI", async () => {
    const response = await app.fetch(new Request("http://test/v1/openapi.json"), env);
    expect(response.status).toBe(200);
    const schema = await response.json() as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    for (const [path, pathItem] of Object.entries(schema.paths)) {
      for (const method of ["post", "put", "patch", "delete"] as const) {
        const operation = pathItem[method];
        if (!operation) continue;
        const policy = mutationRoutePolicyFor(method, path);
        expect(policy, `${method.toUpperCase()} ${path} policy`).toBeDefined();
        expect(operation["x-agentry-request-body-policy"]).toEqual(policy!.body);
        expect(operation["x-agentry-retry-policy"]).toEqual(policy!.retry);
        if (policy!.body.kind === "none") {
          expect(operation.requestBody).toBeUndefined();
          expect(operation["x-agentry-request-body"]).toBe("none");
        }
        if (policy!.retry.idempotency_key_required) {
          const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
          expect(parameters).toContainEqual({ $ref: "#/components/parameters/idempotencyKey" });
        }
      }
    }
  });

  it("publishes the emergency automation pause reason required by runtime", async () => {
    const response = await app.fetch(new Request("http://test/v1/openapi.json"), env);
    expect(response.status).toBe(200);
    const schema = await response.json() as {
      paths: Record<string, Record<string, {
        requestBody?: {
          required?: boolean;
          content?: Record<string, { schema?: { required?: string[] } }>;
        };
        "x-agentry-request-body-policy"?: { kind?: string; max_bytes?: number };
      }>>;
    };
    const operation = schema.paths["/v1/projects/{project_id}/automation-contract/pause"]?.post;
    expect(operation?.["x-agentry-request-body-policy"]).toMatchObject({
      kind: "json",
      max_bytes: 262_144,
    });
    expect(operation?.requestBody?.required).toBe(true);
    expect(operation?.requestBody?.content?.["application/json"]?.schema?.required)
      .toContain("reason");
  });

  it("publishes the terminal project-deletion audit-conflict remediation", async () => {
    const response = await app.fetch(new Request("http://test/v1/openapi.json"), env);
    expect(response.status).toBe(200);
    const schema = await response.json() as {
      paths: Record<string, Record<string, {
        responses?: Record<string, {
          description?: string;
          content?: Record<string, { schema?: { oneOf?: Array<{ $ref?: string }> } }>;
        }>;
      }>>;
      components: { schemas: Record<string, any> };
    };
    const conflict = schema.paths["/v1/projects/{project_id}"]?.delete?.responses?.["409"];
    expect(conflict?.description).toMatch(/terminal and non-retryable.*stop retrying.*operator/i);
    expect(conflict?.content?.["application/json"]?.schema?.oneOf).toContainEqual({
      $ref: "#/components/schemas/ProjectDeletionTerminalAuditConflict",
    });
    const details = schema.components.schemas.ProjectDeletionTerminalAuditConflict
      ?.properties?.error?.properties?.details;
    expect(details?.required).toEqual(expect.arrayContaining([
      "command_id",
      "expected_audit_id",
      "conflicting_audit_id",
      "retryable",
      "operator_remediation_required",
      "project_preserved",
    ]));
    expect(details?.properties?.retryable?.const).toBe(false);
    expect(details?.properties?.operator_remediation_required?.const).toBe(true);
    expect(details?.properties?.project_preserved?.const).toBe(true);
  });

  it("forbids direct unbounded request parsing in runtime source", () => {
    const direct: string[] = [];
    const rawStreams: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      const name = relative(sourceRoot, file);
      if (name !== "bounded-json.ts") {
        for (const match of source.matchAll(/c\.req\.(json|text|arrayBuffer|blob|formData)\s*\(/g)) {
          direct.push(`${name}:${match[1]}`);
        }
      }
      if (name !== "bounded-json.ts" && /c\.req\.raw\.body/.test(source)) rawStreams.push(name);
    }
    expect(direct).toEqual([]);
    expect(rawStreams).toEqual([]);
  });

  it("rejects chunked, dishonest-length, and malformed PostHog auth bodies", async () => {
    const chunked = await app.fetch(streamedRequest(
      "/v1/auth/posthog",
      chunkedBody(["{\"client_name\":\"", "x".repeat(4_100), "\"}"]),
      { headers: { "content-type": "application/json" } },
    ), env);
    expect(chunked.status).toBe(413);
    expect(await chunked.json()).toMatchObject({ error: { code: "payload_too_large" } });

    const underreported = await app.fetch(streamedRequest(
      "/v1/auth/posthog",
      chunkedBody(["{\"client_name\":\"", "y".repeat(4_100), "\"}"]),
      { headers: { "content-type": "application/json", "content-length": "2" } },
    ), env);
    expect(underreported.status).toBe(413);

    const malformed = await app.fetch(streamedRequest(
      "/v1/auth/posthog",
      chunkedBody(["{not-json"]),
      { headers: { "content-type": "application/json" } },
    ), env);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "invalid_payload" } });
  });

  it("rejects a chunked oversized authenticated control body before mutation", async () => {
    const login = await jsonCall("/v1/auth/_test/login", {
      body: { email: "bounded-control@example.com" },
    });
    const { api_key: apiKey } = await login.json() as { api_key: string };
    const response = await app.fetch(streamedRequest(
      "/v1/feedback",
      chunkedBody(["{\"message\":\"", "z".repeat(17_000), "\"}"]),
      {
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": "bounded-feedback-control-1",
        },
      },
    ), env);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });

});
