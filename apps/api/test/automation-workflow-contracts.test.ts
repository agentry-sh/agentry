import { describe, expect, it } from "vitest";
import {
  serializeAutomationWorkflowDataContractCatalog,
  validateAutomationWorkflowPayload,
} from "../src/automation-workflow-contracts.js";

describe("automation workflow v3 payload contracts", () => {
  it("hashes executable validator semantics separately from presentation JSON Schema", async () => {
    const catalog = await serializeAutomationWorkflowDataContractCatalog();
    expect(catalog.count).toBe(10);
    for (const contract of catalog.contracts) {
      expect(contract.validator_semantics_version).toBe(1);
      expect(contract.validator_semantics.length).toBeGreaterThan(0);
      expect(contract.json_schema_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.schema_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.contract_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(contract.schema_hash).not.toBe(contract.json_schema_hash);
    }
  });

  it("executes relational receipt and ordered-funnel constraints", async () => {
    const invalidSchedule = await validateAutomationWorkflowPayload("schedule_trigger_receipt@1", {
      receipt_id: "schedule-1",
      scheduled_for: 100,
      window_start: 200,
      window_end: 300,
      instruction_authority: "none",
    });
    expect(invalidSchedule).toMatchObject({ success: false, contract: "schedule_trigger_receipt@1" });

    const invalidFunnel = await validateAutomationWorkflowPayload("ordered_funnel_source@1", {
      source_hash: "a".repeat(64),
      current_period: { start: 200, end: 300 },
      previous_period: { start: 100, end: 200 },
      events: ["created", "activated"],
      current: {
        observed_users: 2,
        steps: [{ event: "activated", users: 1 }, { event: "created", users: 2 }],
      },
      previous: {
        observed_users: 1,
        steps: [{ event: "created", users: 1 }, { event: "activated", users: 1 }],
      },
      readiness: { status: "ready", limitations: [] },
      instruction_authority: "none",
    });
    expect(invalidFunnel).toMatchObject({ success: false, contract: "ordered_funnel_source@1" });
  });

  it("rejects unknown fields instead of silently weakening payload identity", async () => {
    const result = await validateAutomationWorkflowPayload("schedule_trigger_receipt@1", {
      receipt_id: "schedule-1",
      scheduled_for: 200,
      window_start: 100,
      window_end: 300,
      instruction_authority: "none",
      unbound: true,
    });
    expect(result.success).toBe(false);
  });
});
