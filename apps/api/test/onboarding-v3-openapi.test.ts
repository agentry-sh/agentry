import { describe, expect, it } from "vitest";
import {
  ONBOARDING_V3_SOURCE_FINGERPRINT_ALGORITHM,
  OnboardingV3ProofStartRequestSchema,
  OnboardingV3ReviewRequestSchema,
  OnboardingV3StartRequestSchema,
} from "../src/onboarding-v3-contract.js";
import {
  ONBOARDING_V3_OPENAPI,
  ONBOARDING_V3_OPENAPI_FLOW,
  ONBOARDING_V3_OPENAPI_PATHS,
  ONBOARDING_V3_OPENAPI_PROJECT_PATHS,
  ONBOARDING_V3_OPENAPI_SCHEMAS,
  ONBOARDING_V3_OPENAPI_SUPPORT_PATHS,
} from "../src/onboarding-v3-openapi.js";
import { ONBOARDING_SOURCE_SNAPSHOT_PATH } from "../src/onboarding-source-snapshot.js";
import {
  PUBLIC_INSTALL_PROOF_ANCHOR,
  PUBLIC_INSTALL_REVIEW_ANCHOR,
  PUBLIC_INSTALL_VERIFY_ANCHOR,
} from "../src/public-links.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as JsonObject;
}

function collectRefs(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") result.push(item);
      else collectRefs(item, result);
    }
  }
  return result;
}

function resolveLocalRef(root: unknown, reference: string): unknown {
  expect(reference.startsWith("#/"), reference).toBe(true);
  return reference.slice(2).split("/").reduce<unknown>((current, segment) => {
    return object(current)[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }, root);
}

function snapshot(fingerprint = "c".repeat(64)) {
  return {
    git_head_sha: "a".repeat(40),
    source_fingerprint_sha256: fingerprint,
    source_fingerprint_algorithm: ONBOARDING_V3_SOURCE_FINGERPRINT_ALGORITHM,
  };
}

function plan() {
  return {
    business_question: "Where does the user receive durable value?",
    plan_markdown: "Actor enters, persists useful work, and receives the business result.",
    source_snapshot: snapshot(),
    historical_evidence: {
      status: "historically_observed" as const,
      source: "posthog_cloud" as const,
      posthog_project_id: 42,
      observed_at: 100,
      window: { from: 1, to: 99 },
      query_receipt_sha256: "e".repeat(64),
      observations: [{
        kind: "analytics" as const,
        event: "Value reached / repo spelling 🧪",
        observed_properties: ["result_id"],
        row_count: 5,
      }],
    },
    milestones: [{
      event: "Value reached / repo spelling 🧪",
      meaning: "The durable result exists.",
      posthog_boundary: "server_posthog" as const,
      properties: ["result_id", "token_count"],
      targets: [{ file: "src/value.ts", anchor: "return storedResult" }],
    }],
    failures: [{
      marker: "Input rejected safely 🧪",
      meaning: "Validation rejects before side effects.",
      posthog_boundary: "server_posthog" as const,
      context: ["reason_code"],
      safe_live_proof: true,
      targets: [{ file: "src/value.ts", anchor: "return invalidInput" }],
    }],
    deploy: {
      environment: "production",
      sha_source: "git_head" as const,
      targets: [{
        file: ".github/workflows/deploy.yml",
        anchor: "uses: provider/deploy@v1",
      }],
    },
  };
}

describe("onboarding v3 compact OpenAPI", () => {
  it("exposes exactly five project operations and keeps the helper separate", () => {
    const operations = [
      { method: "get", path: "/v1/projects/{project_id}/onboarding" },
      { method: "post", path: "/v1/projects/{project_id}/onboarding" },
      { method: "post", path: "/v1/projects/{project_id}/onboarding/review" },
      { method: "post", path: "/v1/projects/{project_id}/onboarding/proof" },
      { method: "post", path: "/v1/projects/{project_id}/onboarding/verify" },
    ] as const;

    expect(ONBOARDING_V3_OPENAPI_FLOW.operation_count).toBe(5);
    expect(ONBOARDING_V3_OPENAPI_FLOW.operations).toEqual(operations);
    expect(ONBOARDING_V3_OPENAPI_FLOW.support_operation_count).toBe(1);
    expect(ONBOARDING_V3_OPENAPI_FLOW.support_operations).toEqual([
      { method: "get", path: ONBOARDING_SOURCE_SNAPSHOT_PATH },
    ]);

    for (const entry of operations) {
      expect(object(ONBOARDING_V3_OPENAPI_PROJECT_PATHS[entry.path])[entry.method])
        .toBeTruthy();
    }
    expect(Object.keys(ONBOARDING_V3_OPENAPI_PROJECT_PATHS)).toEqual([
      "/v1/projects/{project_id}/onboarding",
      "/v1/projects/{project_id}/onboarding/review",
      "/v1/projects/{project_id}/onboarding/proof",
      "/v1/projects/{project_id}/onboarding/verify",
    ]);
    expect(object(ONBOARDING_V3_OPENAPI_SUPPORT_PATHS[ONBOARDING_SOURCE_SNAPSHOT_PATH]).get)
      .toBeTruthy();
    expect(ONBOARDING_V3_OPENAPI_PATHS).toEqual({
      ...ONBOARDING_V3_OPENAPI_PROJECT_PATHS,
      ...ONBOARDING_V3_OPENAPI_SUPPORT_PATHS,
    });
  });

  it("keeps the plan shape opaque, unbounded, and aligned with the executable contract", () => {
    const planSchema = object(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3Plan);
    const planProperties = object(planSchema.properties);
    expect(Object.keys(planProperties)).toEqual([
      "business_question",
      "plan_markdown",
      "source_snapshot",
      "historical_evidence",
      "milestones",
      "failures",
      "deploy",
    ]);
    expect(planSchema.required).toEqual(Object.keys(planProperties));

    const milestones = object(planProperties.milestones);
    expect(milestones.minItems).toBe(1);
    expect(milestones).not.toHaveProperty("maxItems");
    expect(milestones).not.toHaveProperty("uniqueItems");
    const failures = object(planProperties.failures);
    expect(failures.minContains).toBe(1);
    expect(failures.maxContains).toBe(1);
    expect(failures).not.toHaveProperty("maxItems");

    const milestone = object(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3Milestone);
    const milestoneProperties = object(milestone.properties);
    expect(object(milestoneProperties.event)).not.toHaveProperty("enum");
    expect(object(milestoneProperties.event)).not.toHaveProperty("pattern");
    expect(object(milestoneProperties.properties)).not.toHaveProperty("uniqueItems");
    const failure = object(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3Failure);
    expect(object(object(failure.properties).marker)).not.toHaveProperty("pattern");
    const target = object(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3SourceTarget);
    expect(Object.keys(object(target.properties))).toEqual(["file", "anchor"]);
    const historical = object(
      ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3HistoricalEvidence,
    );
    const observations = object(object(historical.properties).observations);
    expect(observations.maxItems).toBe(200);
    expect(JSON.stringify(historical)).toContain("non-authorizing");
    expect(JSON.stringify(historical)).not.toContain("payload_json");

    const candidatePlan = plan();
    expect(OnboardingV3StartRequestSchema.safeParse({
      intent: "start",
      plan: candidatePlan,
    }).success).toBe(true);
    expect(OnboardingV3ReviewRequestSchema.safeParse({
      decision: "replace",
      plan_sha256: "b".repeat(64),
      replacement_plan: candidatePlan,
    }).success).toBe(true);
    expect(OnboardingV3ProofStartRequestSchema.safeParse({
      implementation_source_snapshot: snapshot("d".repeat(64)),
    }).success).toBe(true);
  });

  it("contains no retired workflow surfaces or embedded payload samples", () => {
    const serialized = JSON.stringify(ONBOARDING_V3_OPENAPI).toLowerCase();
    for (const retired of [
      "implementation_evidence",
      "baseline",
      "pointer",
      "needs_input",
      "supersede",
      "approval_message",
      "preserve_targets",
      "event_count",
    ]) {
      expect(serialized).not.toContain(retired);
    }
    expect(serialized).not.toContain('"example"');
    expect(serialized).not.toContain('"examples"');
  });

  it("publishes resolvable refs and minimal prerequisite schema links", () => {
    const references = collectRefs(ONBOARDING_V3_OPENAPI);
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expect(resolveLocalRef(ONBOARDING_V3_OPENAPI, reference), reference).toBeTruthy();
    }

    expect(ONBOARDING_V3_OPENAPI_FLOW.prerequisite_operations).toEqual([
      { method: "post", path: "/v1/auth/posthog", schema_url: "/v1/openapi.json?path=%2Fv1%2Fauth%2Fposthog&method=post" },
      { method: "post", path: "/v1/auth/posthog/poll", schema_url: "/v1/openapi.json?path=%2Fv1%2Fauth%2Fposthog%2Fpoll&method=post" },
      { method: "post", path: "/v1/projects", schema_url: "/v1/openapi.json?path=%2Fv1%2Fprojects&method=post" },
      { method: "post", path: "/v1/projects/{project_id}/credentials", schema_url: "/v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcredentials&method=post" },
    ]);
    expect(ONBOARDING_V3_OPENAPI_FLOW.source_snapshot_helper).toEqual({
      method: "get",
      path: ONBOARDING_SOURCE_SNAPSHOT_PATH,
    });
    for (const prerequisite of ONBOARDING_V3_OPENAPI_FLOW.prerequisite_operations) {
      expect(ONBOARDING_V3_OPENAPI_FLOW.operations).not.toContainEqual({
        method: prerequisite.method,
        path: prerequisite.path,
      });
    }
  });

  it("documents the status progression without extra state branches", () => {
    expect(ONBOARDING_V3_OPENAPI_FLOW.statuses).toEqual([
      "planned",
      "approved",
      "proving",
      "verified",
    ]);
    expect(Object.keys(ONBOARDING_V3_OPENAPI_FLOW.status_actions)).toEqual([
      "planned",
      "approved",
      "proving",
      "verified",
    ]);
    const state = object(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3State);
    expect(state.oneOf).toHaveLength(4);

    for (const name of [
      "OnboardingV3PlannedState",
      "OnboardingV3ApprovedState",
      "OnboardingV3ProvingState",
      "OnboardingV3VerifiedState",
    ]) {
      expect(Object.keys(object(object(ONBOARDING_V3_OPENAPI_SCHEMAS[name]).properties))
        .slice(0, 5)).toEqual([
          "status",
          "installation_complete",
          "evidence_status",
          "etag",
          "next_action",
        ]);
    }

    for (const [name, id, guideAnchor] of [
      ["OnboardingV3PlannedNextAction", "review_exact_plan", PUBLIC_INSTALL_REVIEW_ANCHOR],
      ["OnboardingV3ApprovedNextAction", "instrument_and_start_proof", PUBLIC_INSTALL_PROOF_ANCHOR],
      ["OnboardingV3ProvingNextAction", "exercise_and_verify", PUBLIC_INSTALL_VERIFY_ANCHOR],
    ] as const) {
      const action = object(ONBOARDING_V3_OPENAPI_SCHEMAS[name]);
      const properties = object(action.properties);
      expect(Object.keys(properties)).toEqual([
        "id",
        "instruction",
        "requires_human",
        "operation",
        "checklist",
        "completion_condition",
        "guide_anchor",
      ]);
      expect(object(properties.id).const).toBe(id);
      expect(object(properties.operation).required).toEqual(["method", "path"]);
      expect(object(properties.guide_anchor).const).toBe(guideAnchor);
    }

    const remaining = object(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3Remaining);
    expect(Object.keys(object(remaining.properties))).toEqual([
      "analytics",
      "safe_error",
      "deploy",
    ]);
    const verify = JSON.stringify(ONBOARDING_V3_OPENAPI_SCHEMAS.OnboardingV3VerifyResponse);
    expect(verify).toContain("remaining");
    expect(verify).not.toContain("missing");
  });
});
