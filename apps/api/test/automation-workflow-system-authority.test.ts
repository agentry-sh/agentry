import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertAuthority: vi.fn(),
  readRun: vi.fn(),
  applyCommand: vi.fn(),
  loadRevision: vi.fn(),
  nextAction: vi.fn(),
  requireAdapter: vi.fn(),
  assertBlueprintReadiness: vi.fn(),
  assertExecutionDescriptor: vi.fn(),
  acquireSystemClaim: vi.fn(),
  completeSystemClaim: vi.fn(),
  releaseSystemClaim: vi.fn(),
  runHogQl: vi.fn(),
}));

vi.mock("../src/automation-workflow-controls.js", () => ({
  assertAutomationWorkflowAuthorityOpen: (...args: unknown[]) => mocks.assertAuthority(...args),
}));

vi.mock("../src/automation-workflow-service.js", () => ({
  readAutomationWorkflowRun: (...args: unknown[]) => mocks.readRun(...args),
  applyAutomationWorkflowCommand: (...args: unknown[]) => mocks.applyCommand(...args),
}));

vi.mock("../src/automation-workflow-store.js", () => ({
  loadAutomationWorkflowRevision: (...args: unknown[]) => mocks.loadRevision(...args),
}));

vi.mock("../src/automation-workflow-runtime.js", () => ({
  nextAutomationWorkflowAction: (...args: unknown[]) => mocks.nextAction(...args),
}));

vi.mock("../src/automation-workflow-adapters.js", () => ({
  automationWorkflowFunnelSourceHash: vi.fn(),
  requireAutomationWorkflowComponentAdapter: (...args: unknown[]) => mocks.requireAdapter(...args),
}));

vi.mock("../src/query-blueprint-readiness.js", () => ({
  assertQueryBlueprintInputReadiness: (...args: unknown[]) => mocks.assertBlueprintReadiness(...args),
}));

vi.mock("../src/automation-workflow-execution-authority.js", () => ({
  assertLiveOrderedFunnelExecutionAuthority: (...args: unknown[]) =>
    mocks.assertExecutionDescriptor(...args),
}));

vi.mock("../src/automation-workflow-system-claims.js", () => ({
  acquireAutomationWorkflowSystemNodeClaim: (...args: unknown[]) => mocks.acquireSystemClaim(...args),
  completeAutomationWorkflowSystemNodeClaim: (...args: unknown[]) => mocks.completeSystemClaim(...args),
  releaseAutomationWorkflowSystemNodeClaim: (...args: unknown[]) => mocks.releaseSystemClaim(...args),
}));

vi.mock("../src/posthog.js", () => ({
  hogQlRowsToObjects: vi.fn(),
  isPosthogConfigured: vi.fn(() => true),
  runHogQl: (...args: unknown[]) => mocks.runHogQl(...args),
}));

import { advanceAutomationWorkflowSystemNodes } from "../src/automation-workflow-system-executor.js";

describe("automation workflow system live-authority preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readRun.mockResolvedValue({
      project_id: "authority-project",
      automation_id: "weekly_funnel_review",
      run_id: "awrun_authority_closed",
      workflow_revision_id: "awrev_authority_closed",
      runner_credential_id: "runner-authority-closed",
      execution_authority_id: "a".repeat(64),
      execution_descriptor_hash: "b".repeat(64),
      authority: { open: false, reason: "project_paused" },
      state: { revision: 1 },
      next_action: null,
    });
    mocks.assertAuthority.mockRejectedValue(Object.assign(
      new Error("workflow authority is closed"),
      { code: "automation_workflow_kill_switch_active" },
    ));
  });

  it("does not load an adapter or invoke PostHog when live authority is closed", async () => {
    await expect(advanceAutomationWorkflowSystemNodes(
      {} as never,
      {} as never,
      {
        project_id: "authority-project",
        automation_id: "weekly_funnel_review",
        run_id: "awrun_authority_closed",
      },
    )).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });

    expect(mocks.assertAuthority).toHaveBeenCalledWith(
      expect.anything(),
      "authority-project",
      "weekly_funnel_review",
      "awrev_authority_closed",
      "runner-authority-closed",
      "a".repeat(64),
    );
    expect(mocks.loadRevision).not.toHaveBeenCalled();
    expect(mocks.runHogQl).not.toHaveBeenCalled();
    expect(mocks.applyCommand).not.toHaveBeenCalled();
  });

  it("rechecks immediately before the analytics boundary and never invokes PostHog after authority closes", async () => {
    mocks.readRun.mockResolvedValue({
      project_id: "authority-project",
      automation_id: "weekly_funnel_review",
      run_id: "awrun_authority_closes_during_prepare",
      workflow_revision_id: "awrev_authority_closes_during_prepare",
      runner_credential_id: "runner-authority-closes-during-prepare",
      execution_authority_id: "c".repeat(64),
      execution_descriptor_hash: "d".repeat(64),
      authority: { open: true, reason: "open" },
      state: { revision: 1 },
      next_action: {},
    });
    mocks.assertAuthority
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(
        new Error("workflow authority closed before provider read"),
        { code: "automation_workflow_kill_switch_active" },
      ));
    mocks.loadRevision.mockResolvedValue({ compiled: {} });
    mocks.nextAction.mockResolvedValue({
      kind: "execute_component",
      node_id: "funnel_source",
      component: {
        id: "query.analytics.ordered-funnel-period-compare",
        version: "1.0.0",
      },
      component_hash: "a".repeat(64),
      input_hash: "b".repeat(64),
      inputs: {
        schedule: {
          payload: {
            receipt_id: "awtr_authority_closes_during_prepare",
            scheduled_for: 2_000_000,
            window_start: 1_999_900,
            window_end: 2_000_100,
            instruction_authority: "none",
          },
        },
      },
      config: {
        events: ["account_created", "project_created", "first_value_reached"],
        period_days: 7,
        minimum_sample_size: 25,
      },
    });
    mocks.requireAdapter.mockResolvedValue({ execution: { owner: "agentry_runtime" } });
    mocks.assertBlueprintReadiness.mockResolvedValue(undefined);
    mocks.assertExecutionDescriptor.mockResolvedValue({});
    mocks.acquireSystemClaim.mockResolvedValue({
      outcome: "acquired",
      claim: {
        claim_id: "claim-authority-closes-during-prepare",
        claim_epoch: 1,
        claim_token: "claim-token-authority-closes-during-prepare",
      },
    });
    mocks.releaseSystemClaim.mockResolvedValue(undefined);
    const query = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      limit: vi.fn().mockResolvedValue([{
        authorityId: "c".repeat(64),
        descriptorJson: "{}",
        descriptorHash: "d".repeat(64),
      }]),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    const db = { select: vi.fn(() => query) };

    await expect(advanceAutomationWorkflowSystemNodes(
      db as never,
      {} as never,
      {
        project_id: "authority-project",
        automation_id: "weekly_funnel_review",
        run_id: "awrun_authority_closes_during_prepare",
      },
    )).rejects.toMatchObject({ code: "automation_workflow_kill_switch_active" });

    expect(mocks.assertAuthority).toHaveBeenCalledTimes(2);
    expect(mocks.assertBlueprintReadiness).toHaveBeenCalledTimes(1);
    expect(mocks.runHogQl).not.toHaveBeenCalled();
    expect(mocks.applyCommand).not.toHaveBeenCalled();
    expect(mocks.releaseSystemClaim).toHaveBeenCalledTimes(1);
  });
});
