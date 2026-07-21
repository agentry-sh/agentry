import { describe, expect, it } from "vitest";
import { buildOpenApiSchema } from "../src/routes/discovery.js";

describe("customer-owned PostHog hard-cut contract", () => {
  it("exposes OAuth and bounded reads without telemetry or provider-write proxies", () => {
    const schema = buildOpenApiSchema() as {
      paths: Record<string, Record<string, unknown>>;
      components: {
        securitySchemes: Record<string, unknown>;
        schemas: Record<string, unknown>;
      };
    };

    for (const path of [
      "/v1/logs/",
      "/v1/analytics/",
      "/v1/analytics/browser-config",
      "/v1/usage",
      "/v1/usage/history",
      "/v1/projects/{project_id}/posthog/provision",
      "/v1/projects/{project_id}/posthog/provisioning",
      "/api/projects/{project_id}/error_tracking/symbol_sets/bulk_start_upload/",
      "/api/projects/{project_id}/error_tracking/symbol_sets/bulk_finish_upload/",
      "/api/projects/{project_id}/error_tracking/releases",
      "/api/projects/{project_id}/error_tracking/releases/hash/{hash_id}",
      "/v1/projects/{project_id}/posthog/session-replay/configure",
      "/v1/projects/{project_id}/cohorts",
      "/v1/projects/{project_id}/session-replays",
      "/v1/projects/{project_id}/ab-tests",
      "/v1/projects/{project_id}/public-key",
      "/v1/projects/{project_id}/public-key/verify",
      "/v1/projects/{project_id}/public-key/rotate",
    ]) {
      expect(schema.paths[path], path).toBeUndefined();
    }

    expect(schema.paths["/v1/integrations/posthog/oauth/client"]?.get).toBeTruthy();
    expect(schema.paths["/v1/integrations/posthog/oauth/callback"]?.get).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/posthog-connection"]).toEqual(
      expect.objectContaining({
        get: expect.any(Object),
        post: expect.any(Object),
        delete: expect.any(Object),
      }),
    );
    const connectOperation = schema.paths[
      "/v1/projects/{project_id}/posthog-connection"
    ]?.post as {
      requestBody?: {
        content?: {
          "application/json"?: {
            schema?: { properties?: Record<string, unknown> };
          };
        };
      };
    };
    expect(connectOperation.requestBody?.content?.["application/json"]?.schema
      ?.properties?.posthog_project_id).toEqual(
      expect.objectContaining({ type: "integer", minimum: 1 }),
    );
    expect(schema.paths["/v1/projects/{project_id}/analytics/query"]?.post).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/event-names"]?.get).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/event-property-keys"]?.get).toBeTruthy();
    expect(schema.paths["/v1/projects/{project_id}/cases"]?.get).toBeTruthy();
    expect(schema.paths["/v1/deploys/"]?.post).toBeTruthy();

    const resourcePaths = [
      "/v1/projects/{project_id}/session-recordings",
      "/v1/projects/{project_id}/session-recordings/{recording_id}",
      "/v1/projects/{project_id}/feature-flags",
      "/v1/projects/{project_id}/feature-flags/{flag_id}",
      "/v1/projects/{project_id}/surveys",
      "/v1/projects/{project_id}/surveys/{survey_id}",
      "/v1/projects/{project_id}/surveys/{survey_id}/responses",
      "/v1/projects/{project_id}/surveys/{survey_id}/stats",
      "/v1/projects/{project_id}/experiments",
      "/v1/projects/{project_id}/experiments/{experiment_id}",
    ];
    for (const path of resourcePaths) {
      expect(schema.paths[path]?.get, path).toBeTruthy();
      expect(schema.paths[path]?.post, path).toBeUndefined();
      expect(schema.paths[path]?.put, path).toBeUndefined();
      expect(schema.paths[path]?.patch, path).toBeUndefined();
      expect(schema.paths[path]?.delete, path).toBeUndefined();
    }
    expect(
      schema.paths["/v1/projects/{project_id}/experiments/{experiment_id}/results"],
    ).toBeUndefined();

    for (const component of [
      "PosthogResourcePage",
      "PosthogResourceFreshness",
      "PosthogResourceDataBoundary",
      "PosthogSessionRecordingListResponse",
      "PosthogFeatureFlagListResponse",
      "PosthogSurveyResponsesResponse",
      "PosthogSurveyStatsResponse",
      "PosthogExperimentListResponse",
    ]) {
      expect(schema.components.schemas[component], component).toBeTruthy();
    }
    const featureFlagSchema = schema.components.schemas.PosthogFeatureFlag as {
      properties?: {
        targeting_groups?: {
          items?: {
            properties?: { conditions?: { maxItems?: number } };
            required?: string[];
          };
        };
      };
    };
    expect(
      featureFlagSchema.properties?.targeting_groups?.items?.properties?.conditions
        ?.maxItems,
    ).toBe(50);
    expect(
      featureFlagSchema.properties?.targeting_groups?.items?.required,
    ).toContain("conditions");
    const experimentMetricSchema = schema.components.schemas.PosthogExperimentMetric as {
      properties?: { event_names?: { maxItems?: number } };
      required?: string[];
    };
    expect(experimentMetricSchema.properties?.event_names?.maxItems).toBe(50);
    expect(experimentMetricSchema.required).toContain("event_names");

    expect(schema.components.securitySchemes.PublicIngestAuth).toBeUndefined();
    expect(schema.components.securitySchemes.ServerIngestAuth).toBeUndefined();
    expect(schema.components.schemas.LogIngestRequest).toBeUndefined();
    expect(schema.components.schemas.AnalyticsIngestRequest).toBeUndefined();
    expect(schema.components.schemas.IngestAcceptedResponse).toBeUndefined();
    expect(schema.components.schemas.AnalyticsAcceptedResponse).toBeUndefined();
    const updateCaseRequest = schema.components.schemas.UpdateCaseRequest as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(updateCaseRequest.properties?.agent_summary).toBeTruthy();
    expect(updateCaseRequest.properties?.pr_url).toBeTruthy();
    expect(updateCaseRequest.properties?.status).toBeUndefined();
    expect(updateCaseRequest.additionalProperties).toBe(false);

    const serialized = JSON.stringify(schema);
    expect(serialized).not.toContain("AGENTRY_PUBLIC_API_KEY");
    expect(serialized).not.toContain("AGENTRY_SERVER_API_KEY");
    expect(serialized).not.toContain("server_ingest");
    expect(serialized).not.toContain("ingest_boundary");
    expect(serialized).not.toContain("selection_required");
    expect(serialized).not.toContain("select_project");
    expect(serialized).not.toContain("legacy_unverified");
    expect(serialized).not.toContain("legacy_deploy");
    expect(serialized).not.toContain("historical_clue_only");
    expect(serialized).not.toContain("$agentry_user_email");
  });
});
