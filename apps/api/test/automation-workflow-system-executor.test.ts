import { describe, expect, it } from "vitest";
import { canonicalJsonStringify } from "@agentrysh/shared";
import { automationWorkflowFunnelSourceHash } from "../src/automation-workflow-adapters.js";
import { buildAutomationWorkflowOrderedFunnelSource } from "../src/automation-workflow-system-executor.js";

const COLUMNS = [
  "period",
  "window_start",
  "window_end",
  "funnel_events_json",
  "observed_users_json",
  "counts_json",
  "conversion_percentages_json",
  "overall_conversion_pct",
  "sample_size",
  "minimum_sample_size",
  "all_selected_events_observed",
  "sample_ready",
  "readiness_status",
] as const;

const schedule = {
  receipt_id: "awtr_schedule_test",
  scheduled_for: 2_000_000,
  window_start: 1_999_900,
  window_end: 2_000_100,
  instruction_authority: "none",
};
const config = {
  events: ["account_created", "project_created", "first_value_reached"],
  period_days: 1,
  minimum_sample_size: 25,
};

function iso(second: number) {
  return new Date(second * 1_000).toISOString();
}

function rows() {
  return [
    {
      period: "prior",
      window_start: iso(schedule.scheduled_for - 172_800),
      window_end: iso(schedule.scheduled_for - 86_400),
      funnel_events_json: canonicalJsonStringify(config.events),
      observed_users_json: "[42,38,30]",
      counts_json: "[40,34,27]",
      conversion_percentages_json: "[85,79.41176470588235]",
      overall_conversion_pct: 67.5,
      sample_size: 40,
      minimum_sample_size: 25,
      all_selected_events_observed: 1,
      sample_ready: 1,
      readiness_status: "ready",
    },
    {
      period: "current",
      window_start: iso(schedule.scheduled_for - 86_400),
      window_end: iso(schedule.scheduled_for),
      funnel_events_json: canonicalJsonStringify(config.events),
      observed_users_json: "[35,31,24]",
      counts_json: "[33,29,21]",
      conversion_percentages_json: "[87.87878787878788,72.41379310344827]",
      overall_conversion_pct: 63.63636363636363,
      sample_size: 33,
      minimum_sample_size: 25,
      all_selected_events_observed: true,
      sample_ready: true,
      readiness_status: "ready",
    },
  ];
}

describe("automation workflow ordered-funnel system adapter", () => {
  it("builds a source bound to the exact schedule, config, periods, and rows", async () => {
    const source = await buildAutomationWorkflowOrderedFunnelSource({
      schedule,
      config,
      columns: [...COLUMNS],
      expected_columns: COLUMNS,
      rows: rows(),
    });

    expect(source).toMatchObject({
      current_period: { start: schedule.scheduled_for - 86_400, end: schedule.scheduled_for },
      previous_period: {
        start: schedule.scheduled_for - 172_800,
        end: schedule.scheduled_for - 86_400,
      },
      events: config.events,
      current: {
        observed_users: 33,
        steps: [
          { event: "account_created", users: 33 },
          { event: "project_created", users: 29 },
          { event: "first_value_reached", users: 21 },
        ],
      },
      previous: { observed_users: 40 },
      readiness: { status: "ready", limitations: [] },
      instruction_authority: "none",
    });
    await expect(automationWorkflowFunnelSourceHash({ schedule, config, source }))
      .resolves.toBe(source.source_hash);
  });

  it("turns a valid low-sample result into typed insufficient evidence", async () => {
    const lowSample = rows();
    lowSample[1]!.counts_json = "[20,18,12]";
    lowSample[1]!.sample_size = 20;
    lowSample[1]!.sample_ready = 0;
    lowSample[1]!.readiness_status = "insufficient_entry_sample";
    const source = await buildAutomationWorkflowOrderedFunnelSource({
      schedule,
      config,
      columns: [...COLUMNS],
      expected_columns: COLUMNS,
      rows: lowSample,
    });

    expect(source.readiness.status).toBe("insufficient_sample");
    expect(source.readiness.limitations).toEqual([
      "current period failed the frozen minimum-sample or selected-event observation gate",
    ]);
  });

  it("rejects a row whose window moves the server-issued schedule anchor", async () => {
    const shifted = rows();
    shifted[1]!.window_end = iso(schedule.scheduled_for + 1);
    await expect(buildAutomationWorkflowOrderedFunnelSource({
      schedule,
      config,
      columns: [...COLUMNS],
      expected_columns: COLUMNS,
      rows: shifted,
    })).rejects.toMatchObject({
      code: "persistence_failed",
      nextAction: expect.stringContaining("replay the exact system-advance request"),
    });
  });

  it("rejects reordered or increasing funnel evidence instead of repairing it", async () => {
    const increasing = rows();
    increasing[0]!.counts_json = "[40,41,27]";
    await expect(buildAutomationWorkflowOrderedFunnelSource({
      schedule,
      config,
      columns: [...COLUMNS],
      expected_columns: COLUMNS,
      rows: increasing,
    })).rejects.toMatchObject({ code: "persistence_failed" });
  });
});
