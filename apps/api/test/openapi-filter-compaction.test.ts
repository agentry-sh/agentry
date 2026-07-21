import { describe, expect, it } from "vitest";
import discoveryRouter from "../src/routes/discovery.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveLocalRef(root: JsonRecord, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let value: unknown = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function localRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) localRefs(item, refs);
    return refs;
  }
  if (!isRecord(value)) return refs;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    refs.add(value.$ref);
  }
  for (const item of Object.values(value)) localRefs(item, refs);
  return refs;
}

function expectNoDanglingLocalRefs(document: JsonRecord): void {
  for (const ref of localRefs(document)) {
    expect(resolveLocalRef(document, ref), `dangling local ref ${ref}`).toBeDefined();
  }
}

async function filteredSchema(query: string): Promise<{
  body: JsonRecord;
  bytes: number;
}> {
  const response = await discoveryRouter.request(`/v1/openapi.json?${query}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  return { body: JSON.parse(text) as JsonRecord, bytes: Buffer.byteLength(text) };
}

describe("compact OpenAPI filters", () => {
  it("keeps the onboarding flow compact with a closed component graph", async () => {
    const { body, bytes } = await filteredSchema("flow=onboarding");
    expect(body.component_mode).toBe("reachable_references");
    expect((body.definition as JsonRecord).id).toBe("onboarding_v3");
    expect(bytes).toBeLessThanOrEqual(100_000);
    expectNoDanglingLocalRefs(body);

    const components = body.components as JsonRecord;
    const schemas = components.schemas as JsonRecord;
    expect(schemas.OnboardingV3StartRequest).toBeDefined();
    expect(Object.keys(schemas).length).toBeLessThan(30);
    const serialized = JSON.stringify(body).toLowerCase();
    for (const retired of [
      "onboarding_v2",
      "implementation_evidence",
      "evidence-helper",
      "baseline",
      "pointer",
      "source_contract",
    ]) {
      expect(serialized).not.toContain(retired);
    }

    const retiredFlow = await discoveryRouter.request(
      "/v1/openapi.json?flow=onboarding_v2",
    );
    expect(retiredFlow.status).toBe(404);
  });

  it("keeps an exact onboarding operation under the agent payload budget", async () => {
    const query =
      `path=${encodeURIComponent("/v1/projects/{project_id}/onboarding")}&method=post`;
    const { body, bytes } = await filteredSchema(query);
    expect(bytes).toBeLessThanOrEqual(150_000);
    expectNoDanglingLocalRefs(body);

    const operation = body.operation as JsonRecord;
    const requestBody = operation.requestBody as JsonRecord;
    const content = requestBody.content as JsonRecord;
    const json = content["application/json"] as JsonRecord;
    const requestSchema = json.schema as JsonRecord;
    expect(requestSchema.$ref).toBe(
      "#/components/schemas/OnboardingV3StartRequest",
    );
    expect(resolveLocalRef(body, String(requestSchema.$ref))).toBeDefined();

    const security = operation.security as Array<JsonRecord>;
    const securitySchemes = (body.components as JsonRecord)
      .securitySchemes as JsonRecord;
    for (const requirement of security) {
      for (const scheme of Object.keys(requirement)) {
        expect(securitySchemes[scheme]).toBeDefined();
      }
    }
  });

  it("applies the same closed-reference filter to automation", async () => {
    const { body, bytes } = await filteredSchema("flow=automation");
    expect(body.component_mode).toBe("reachable_references");
    expect(bytes).toBeLessThan(700_000);
    expectNoDanglingLocalRefs(body);
  });

  it("defines include_components=false as the legacy dereferenced form", async () => {
    const query =
      `path=${encodeURIComponent("/v1/projects/{project_id}/onboarding")}` +
      "&method=post&include_components=false";
    const { body } = await filteredSchema(query);
    expect(body.component_mode).toBe("legacy_dereferenced_without_components");
    expect(body.components).toBeUndefined();

    const operation = body.operation as JsonRecord;
    const requestBody = operation.requestBody as JsonRecord;
    const content = requestBody.content as JsonRecord;
    const json = content["application/json"] as JsonRecord;
    expect((json.schema as JsonRecord).$ref).toBeUndefined();
  });
});
