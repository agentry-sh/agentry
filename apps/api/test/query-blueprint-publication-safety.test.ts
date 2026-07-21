import { describe, expect, it } from "vitest";
import {
  QUERY_BLUEPRINTS,
  getQueryBlueprint,
  getQueryBlueprintPublicationSafetyViolations,
  isQueryBlueprintPublishable,
  serializeQueryBlueprint,
} from "../src/query-blueprints.js";

describe("query blueprint publication safety", () => {
  it("requires every public blueprint to be aggregate analytics without identifiers or dynamic segments", () => {
    const publishable = QUERY_BLUEPRINTS.filter(isQueryBlueprintPublishable);

    expect(publishable.length).toBeGreaterThan(0);
    for (const blueprint of publishable) {
      expect(blueprint.backend).toBe("analytics");
      expect(blueprint.publication_safety).toEqual(expect.objectContaining({
        status: "safe_aggregate",
        public_access: "allowed",
        output_granularity: "aggregate",
        identifier_columns: [],
        accepts_arbitrary_segment_property: false,
      }));
      expect(getQueryBlueprintPublicationSafetyViolations(blueprint)).toEqual([]);
    }
  });

  it("marks identifier rows and caller-selected segment values private in discovery", () => {
    const identifiers = getQueryBlueprint("funnel_dropoff_users");
    const dynamicSegment = getQueryBlueprint("funnel_3_step_by_property");
    expect(identifiers).not.toBeNull();
    expect(dynamicSegment).not.toBeNull();
    if (!identifiers || !dynamicSegment) return;

    expect(getQueryBlueprintPublicationSafetyViolations(identifiers)).toEqual(
      expect.arrayContaining([
        "public_access_denied",
        "not_safe_aggregate",
        "non_aggregate_output",
        "identifier_columns",
      ]),
    );
    expect(getQueryBlueprintPublicationSafetyViolations(dynamicSegment)).toEqual(
      expect.arrayContaining([
        "public_access_denied",
        "not_safe_aggregate",
        "arbitrary_segment_property",
      ]),
    );

    const identifierDiscovery = serializeQueryBlueprint(identifiers);
    expect(identifierDiscovery).toEqual(expect.objectContaining({
      publishable: false,
      publication_safety: expect.objectContaining({
        status: "private_identifiers",
        public_access: "denied",
        identifier_columns: ["distinct_id", "session_id", "session_recording_id"],
      }),
      endpoints: expect.not.objectContaining({ publish: expect.anything() }),
    }));
    expect(identifierDiscovery.next_action).toContain("owner-authenticated");

    const segmentDiscovery = serializeQueryBlueprint(dynamicSegment);
    expect(segmentDiscovery).toEqual(expect.objectContaining({
      publishable: false,
      publication_safety: expect.objectContaining({
        status: "private_dynamic_segment",
        public_access: "denied",
        accepts_arbitrary_segment_property: true,
      }),
      endpoints: expect.not.objectContaining({ publish: expect.anything() }),
    }));
  });

  it("keeps operational blueprints owner-only even when their rows are aggregate", () => {
    const aggregateOperational = getQueryBlueprint("errors_by_hour_24h");
    expect(aggregateOperational).not.toBeNull();
    if (!aggregateOperational) return;

    expect(isQueryBlueprintPublishable(aggregateOperational)).toBe(false);
    expect(aggregateOperational.publication_safety).toEqual(expect.objectContaining({
      status: "private_operational",
      public_access: "denied",
    }));
    expect(getQueryBlueprintPublicationSafetyViolations(aggregateOperational)).toContain(
      "non_analytics_backend",
    );
  });
});
