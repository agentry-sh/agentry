import { describe, expect, it } from "vitest";
import {
  AUTOMATION_WORKFLOW_MAX_NODES,
  validateAutomationWorkflow,
} from "./automation-workflow.js";

function validWorkflow() {
  return {
    schema_version: "3",
    id: "weekly_review",
    name: "Weekly review",
    runner: { provider: "codex", environment: "production" },
    limits: {
      max_runs_per_day: 2,
      max_attempts_per_trigger: 1,
      max_turns_per_run: 24,
      max_active_runtime_seconds: 1_800,
      max_elapsed_seconds: 1_800,
      max_cost_usd_per_run: 5,
      retry_backoff_seconds: 900,
      max_external_effects_per_run: 0,
      max_external_effects_per_day: 0,
      max_files_changed_per_run: 0,
      max_changed_lines_per_run: 0,
    },
    entry: "scheduled",
    nodes: [
      {
        id: "scheduled",
        kind: "trigger",
        component: { id: "trigger.schedule.cron", version: "1.0.0" },
        config: {},
        next: "query",
        on_error: "escalate",
      },
      {
        id: "query",
        kind: "query",
        component: { id: "query.analytics.funnel", version: "1.0.0" },
        config: {},
        inputs: { schedule: { node_id: "scheduled" } },
        next: "sample_ready",
        on_error: "escalate",
      },
      {
        id: "sample_ready",
        kind: "condition",
        predicate: {
          value: { node_id: "query", path: ["sample_ready"] },
          operator: "eq",
          expected: true,
        },
        on_true: "complete",
        on_false: "escalate",
        on_error: "escalate",
      },
      {
        id: "complete",
        kind: "terminal",
        terminal: { outcome: "complete", result: { node_id: "query" } },
      },
      {
        id: "escalate",
        kind: "terminal",
        terminal: {
          outcome: "escalate",
          destination: "project owner",
          instructions: "Preserve evidence and stop.",
        },
      },
    ],
  };
}

describe("automation workflow v3 structural validation", () => {
  it("accepts one forward-only trigger graph whose branches terminate", () => {
    const result = validateAutomationWorkflow(validWorkflow());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe("3");
      expect(result.data.nodes[2]).toMatchObject({
        predicate: { value: { path: ["sample_ready"] } },
      });
    }
  });

  it("reports duplicate ids, backward edges, non-prior references, and unreachable nodes", () => {
    const workflow = validWorkflow();
    workflow.nodes[0]!.next = "complete";
    workflow.nodes[2]!.on_true = "query";
    workflow.nodes.push({
      id: "query",
      kind: "terminal",
      terminal: { outcome: "complete", result: { node_id: "scheduled" } },
    } as never);

    const result = validateAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        "duplicate_node_id",
        "edge_not_forward",
        "node_unreachable",
      ]));
    }
  });

  it("rejects missing targets and a non-trigger entry without throwing", () => {
    const workflow = validWorkflow();
    workflow.entry = "query";
    workflow.nodes[1]!.next = "missing";

    const result = validateAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        "entry_not_trigger",
        "target_not_found",
        "path_not_terminal",
      ]));
    }
  });

  it("enforces the bounded language and structured JSON config", () => {
    const workflow = validWorkflow();
    workflow.nodes = Array.from({ length: AUTOMATION_WORKFLOW_MAX_NODES + 1 }, (_, index) => ({
      id: `node_${index}`,
      kind: "terminal",
      terminal: { outcome: "complete", result: { node_id: "node_0" } },
    })) as never;
    (workflow.nodes[0] as Record<string, unknown>).config = { unsafe: undefined };

    const result = validateAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.every((issue) => issue.code === "schema_invalid")).toBe(true);
    }
  });

  it("requires numeric operands for ordered comparisons", () => {
    const workflow = validWorkflow();
    workflow.nodes[2]!.predicate.operator = "gte";
    workflow.nodes[2]!.predicate.expected = "many";

    const result = validateAutomationWorkflow(workflow);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "condition_operand_invalid",
      }));
    }
  });

  it("bounds deeply nested and cyclic component config without throwing", () => {
    const deep = validWorkflow() as any;
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let index = 0; index < 5_000; index += 1) {
      const nested: Record<string, unknown> = {};
      cursor.next = nested;
      cursor = nested;
    }
    deep.nodes[0].config = root;
    expect(() => validateAutomationWorkflow(deep)).not.toThrow();
    const deepResult = validateAutomationWorkflow(deep);
    expect(deepResult.success).toBe(false);
    if (!deepResult.success) {
      expect(deepResult.issues).toContainEqual(expect.objectContaining({
        code: "schema_invalid",
        message: expect.stringContaining("nesting depth"),
      }));
    }

    const cyclic = validWorkflow() as any;
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    cyclic.nodes[0].config = cycle;
    expect(() => validateAutomationWorkflow(cyclic)).not.toThrow();
    const cyclicResult = validateAutomationWorkflow(cyclic);
    expect(cyclicResult.success).toBe(false);
    if (!cyclicResult.success) {
      expect(cyclicResult.issues).toContainEqual(expect.objectContaining({
        code: "schema_invalid",
        message: expect.stringContaining("cyclic"),
      }));
    }
  });
});
