import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestProjectCredential, getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");

type JsonObject = Record<string, unknown>;

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    next_action?: string;
    details?: JsonObject;
    request_id?: string;
    retryable?: boolean;
  };
};

type OperationLookupResponse = {
  path: string;
  method: string;
  operation: {
    requestBody?: {
      content?: Record<string, { schema?: unknown; examples?: unknown }>;
    };
  };
};

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

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
  return app.fetch(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers,
      body,
    }),
    env,
  );
}

async function signup(email: string): Promise<{ apiKey: string }> {
  const res = await call("/v1/auth/_test/login", {
    method: "POST",
    json: { email },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { api_key: string };
  return { apiKey: data.api_key };
}

async function createProject(
  apiKey: string,
  name: string,
): Promise<{ id: string }> {
  const res = await call("/v1/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": `test-project-${crypto.randomUUID()}` },
    json: { name },
  });
  expect(res.status).toBe(200);
  return await res.json() as { id: string };
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringField(obj: JsonObject, field: string): string {
  const value = obj[field];
  expect(typeof value).toBe("string");
  return value as string;
}

function defaultExample(examples: unknown): JsonObject | null {
  const record = asObject(examples);
  if (!record) return null;

  for (const candidate of [record.default, ...Object.values(record)]) {
    const wrapped = asObject(candidate);
    const value = wrapped && "value" in wrapped ? wrapped.value : candidate;
    const example = asObject(value);
    if (example) return example;
  }
  return null;
}

async function recoverInvalidPayloadAndRetry(opts: {
  failed: Response;
  method: "POST";
  path: string;
  headers: HeadersInit;
  requestId: string;
}): Promise<Response> {
  const errorJson = (await opts.failed.json()) as ErrorEnvelope;
  expect(errorJson.error.code).toBe("invalid_payload");
  expect(errorJson.error.retryable).toBe(false);
  expect(errorJson.error.request_id).toBe(opts.requestId);
  expect(opts.failed.headers.get("x-agentry-request-id")).toBe(opts.requestId);
  expect(errorJson.error.next_action).toContain("details.schema_path");
  expect(errorJson.error.next_action).toContain("/v1/openapi.json");

  const details = asObject(errorJson.error.details);
  expect(details).toBeTruthy();
  expect(details).toMatchObject({
    schema_path: "/v1/deploys/",
    schema_method: "post",
    schema_ref: "#/components/schemas/DeployIngestRequest",
    request_body_required: true,
  });
  expect(stringField(details!, "reason")).toContain("sha");

  const schemaPath = stringField(details!, "schema_path");
  const schemaMethod = stringField(details!, "schema_method");
  const schemaRes = await call(
    `/v1/openapi.json?path=${encodeURIComponent(schemaPath)}&method=${schemaMethod}`,
  );
  expect(schemaRes.status).toBe(200);

  const schemaJson = (await schemaRes.json()) as OperationLookupResponse;
  expect(schemaJson.path).toBe(schemaPath);
  expect(schemaJson.method).toBe(schemaMethod);

  const media = schemaJson.operation.requestBody?.content?.["application/json"];
  const bodyFromError = defaultExample(details!.request_example);
  const bodyFromSchema = defaultExample(media?.examples);
  const recoveredBody = bodyFromError ?? bodyFromSchema;
  expect(recoveredBody).toBeTruthy();
  expect(typeof recoveredBody!.sha).toBe("string");

  return await call(opts.path, {
    method: opts.method,
    headers: opts.headers,
    json: recoveredBody,
  });
}

describe("agent error recovery", () => {
  it("lets an agent repair a broken endpoint call from invalid_payload context", async () => {
    const { apiKey } = await signup("agent-recovery@example.com");
    const project = await createProject(apiKey, "agent-recovery");
    const ci = await createTestProjectCredential(env, project.id, "ci_deploy");
    const path = `/v1/deploys/`;
    const requestId = "00000000-0000-4000-8000-000000000002";
    const headers = {
      authorization: `Bearer ${ci.credential}`,
      "x-agentry-request-id": requestId,
      "idempotency-key": "agent-recovery-deploy-0001",
    };

    const broken = await call(path, {
      method: "POST",
      headers,
      json: {
        version: "web@broken-client",
        environment: "production",
      },
    });
    expect(broken.status).toBe(400);

    const recovered = await recoverInvalidPayloadAndRetry({
      failed: broken,
      method: "POST",
      path,
      headers,
      requestId,
    });

    expect(recovered.status).toBe(200);
    const recoveredJson = (await recovered.json()) as {
      id: string;
      project_id: string;
      sha: string;
      next_action: string;
    };
    expect(recoveredJson.project_id).toBe(project.id);
    expect(recoveredJson.sha).toBeTruthy();
    expect(recoveredJson.next_action).toContain("Deploy recorded");

    const deploys = await call(`/v1/projects/${project.id}/deploys`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(deploys.status).toBe(200);
    const deploysJson = (await deploys.json()) as {
      deploys: Array<{ id: string; evidence: { sha: string } }>;
    };
    expect(deploysJson.deploys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: recoveredJson.id,
          evidence: expect.objectContaining({ sha: recoveredJson.sha }),
        }),
      ]),
    );
  });
});
