import { describe, expect, it } from "vitest";
import type { AutomationWorkflowJsonValue } from "@agentrysh/shared";
import {
  automationWorkflowCodeFixProposalHash,
  automationWorkflowFunnelReportHash,
  listAutomationWorkflowComponentAdapters,
  requireAutomationWorkflowComponentAdapter,
  resolveAutomationWorkflowAdapterTarget,
  validateAutomationWorkflowAdapterOutput,
  type AutomationWorkflowAdapterContext,
  type AutomationWorkflowAdapterInput,
  type AutomationWorkflowAdapterValidationResult,
} from "../src/automation-workflow-adapters.js";
import {
  AUTOMATION_WORKFLOW_COMPONENT_VERSION,
  getAutomationWorkflowComponent,
  serializeAutomationWorkflowComponent,
} from "../src/automation-workflow-components.js";
import { validateAutomationWorkflowPayload } from "../src/automation-workflow-contracts.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

async function componentHash(id: string): Promise<string> {
  const component = getAutomationWorkflowComponent({
    id,
    version: AUTOMATION_WORKFLOW_COMPONENT_VERSION,
  });
  if (!component) throw new Error(`missing component ${id}`);
  return (await serializeAutomationWorkflowComponent(component)).component_hash;
}

async function runtimeInput(
  contract: string,
  payload: unknown,
): Promise<AutomationWorkflowAdapterInput> {
  const validated = await validateAutomationWorkflowPayload(contract, payload);
  if (!validated.success) throw new Error(JSON.stringify(validated.issues));
  return {
    contract,
    payload: validated.payload,
    payload_hash: validated.payload_hash,
  };
}

async function context(
  componentId: string,
  input: Partial<AutomationWorkflowAdapterContext> = {},
): Promise<AutomationWorkflowAdapterContext> {
  return {
    project_id: "project-1",
    node_id: "node_1",
    component: { id: componentId, version: AUTOMATION_WORKFLOW_COMPONENT_VERSION },
    component_hash: await componentHash(componentId),
    runner: { provider: "codex", environment: "production" },
    config: {},
    inputs: {},
    intent: null,
    at: 500,
    ...input,
  };
}

function issues(result: AutomationWorkflowAdapterValidationResult): string[] {
  if (result.success) throw new Error("expected adapter validation failure");
  return result.issues.map((issue) => `${issue.code}:${issue.path.join(".")}:${issue.message}`);
}

function caseEvidence() {
  return {
    case_id: "case-1",
    case_revision: 3,
    evidence_hash: HASH_A,
    error: {
      type: "TypeError",
      message: "boom",
      event_count: 4,
      first_seen_at: 100,
      last_seen_at: 200,
    },
    last_deploy_sha: null,
    instruction_authority: "none",
  };
}

async function codeFixProposal() {
  const proposal = {
    proposal_hash: HASH_B,
    evidence_hash: HASH_A,
    repository: "https://github.com/example/app",
    base_sha: "abcdef1",
    head_sha: "abcdef2",
    branch: "agentry/fix-case-1",
    changed_files: [{ path: "src/fix.ts", added_lines: 4, deleted_lines: 1 }],
    tests: [{ command: "npm test", status: "passed", exit_code: 0 }],
    summary: "Bounded exact fix",
    instruction_authority: "none",
  };
  proposal.proposal_hash = await automationWorkflowCodeFixProposalHash(proposal);
  return proposal;
}

function funnelSource() {
  const events = ["account_created", "first_value_reached"];
  return {
    source_hash: HASH_C,
    current_period: { start: 200, end: 300 },
    previous_period: { start: 100, end: 200 },
    events,
    current: {
      observed_users: 100,
      steps: [
        { event: events[0], users: 100 },
        { event: events[1], users: 70 },
      ],
    },
    previous: {
      observed_users: 80,
      steps: [
        { event: events[0], users: 80 },
        { event: events[1], users: 50 },
      ],
    },
    readiness: { status: "ready", limitations: [] },
    instruction_authority: "none",
  };
}

async function funnelReport() {
  const report = {
    report_hash: HASH_D,
    source_hash: HASH_C,
    findings: [{
      kind: "metric",
      statement: "Activation is 70 percent in the current period.",
      evidence_paths: ["current.steps", "current.observed_users"],
    }],
    limitations: ["This is descriptive evidence, not a causal claim."],
    instruction_authority: "none",
  };
  report.report_hash = await automationWorkflowFunnelReportHash(report);
  return report;
}

describe("automation workflow component adapters", () => {
  it("pins reviewed execution ownership and reconciliation policy to exact component hashes", async () => {
    const adapters = await listAutomationWorkflowComponentAdapters();
    expect(adapters.map((adapter) => adapter.component.id)).toEqual([
      "trigger.cases.unhandled",
      "trigger.schedule.cron",
      "query.cases.claimed-evidence",
      "query.analytics.ordered-funnel-period-compare",
      "agent.code-fix",
      "agent.funnel-review",
      "effect.github.draft-pr",
      "effect.report.private",
      "wait.deploy.observed",
      "verify.cases.no-recurrence-after-deploy",
    ]);
    expect(adapters.every(Object.isFrozen)).toBe(true);
    expect(adapters.find((adapter) => adapter.component.id === "effect.github.draft-pr")).toMatchObject({
      execution: { owner: "customer_runner", principal: "automation_runner" },
      canonical_target: "repository",
      reconciliation_policy: {
        strategy: "provider_lookup_before_retry",
        stable_operation_key: "intent_hash",
        native_provider_idempotency: false,
        backoff_source: "frozen_workflow_limit",
        max_automatic_reconciliations: 3,
        max_provider_call_attempts: 1,
        outcomes: ["found", "definitively_absent", "unknown"],
        absence_before_consistency_window: "unknown",
        retry_after_definitive_absence: "manual_follow_up_no_provider_retry",
        exhausted_outcome: "manual_follow_up",
      },
    });
    expect(adapters.find((adapter) => adapter.component.id === "effect.report.private")).toMatchObject({
      execution: { owner: "agentry_runtime", principal: "agentry_system" },
      canonical_target: "project",
      reconciliation_policy: null,
    });

    await expect(requireAutomationWorkflowComponentAdapter({
      id: "agent.code-fix",
      version: AUTOMATION_WORKFLOW_COMPONENT_VERSION,
      component_hash: HASH_A,
    })).rejects.toMatchObject({ code: "component_adapter_not_installed" });
    await expect(requireAutomationWorkflowComponentAdapter({
      id: "agent.analytics.funnel-review",
      version: AUTOMATION_WORKFLOW_COMPONENT_VERSION,
      component_hash: HASH_A,
    })).rejects.toMatchObject({ code: "component_adapter_not_installed" });
  });

  it("canonicalizes targets from immutable runtime state instead of caller output", async () => {
    const repositoryContext = await context("effect.github.draft-pr", {
      runner: {
        provider: "codex",
        repository_provider: "github",
        repository: "https://GitHub.com/Example/App.git/",
        default_branch: "main",
      },
    });
    expect(await resolveAutomationWorkflowAdapterTarget(repositoryContext))
      .toBe("https://github.com/example/app");
    expect(await resolveAutomationWorkflowAdapterTarget(await context("effect.report.private")))
      .toBe("agentry:project:project-1");
  });

  it("binds a code-fix proposal to evidence, repository, workspace scope, tests, and canonical hash", async () => {
    const evidence = await runtimeInput("claimed_case_evidence@1", caseEvidence());
    const baseContext = await context("agent.code-fix", {
      runner: {
        provider: "codex",
        repository_provider: "github",
        repository: "https://github.com/example/app",
        default_branch: "main",
      },
      config: {
        allowed_paths: ["src/**", "test/**"],
        test_commands: ["npm test"],
        max_files_changed: 2,
        max_changed_lines: 50,
      },
      inputs: { evidence },
    });
    const proposal = await codeFixProposal();
    expect(await validateAutomationWorkflowAdapterOutput(baseContext, proposal)).toMatchObject({
      success: true,
      canonical_target: "https://github.com/example/app",
      output_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const wrongEvidence = structuredClone(proposal);
    wrongEvidence.evidence_hash = HASH_B;
    expect(issues(await validateAutomationWorkflowAdapterOutput(baseContext, wrongEvidence)).join("\n"))
      .toContain("proposal evidence_hash must match");

    const escapedScope = structuredClone(proposal);
    escapedScope.changed_files[0]!.path = "package.json";
    escapedScope.proposal_hash = await automationWorkflowCodeFixProposalHash(escapedScope);
    expect(issues(await validateAutomationWorkflowAdapterOutput(baseContext, escapedScope)).join("\n"))
      .toContain("outside every configured allowed_paths");

    const forbidden = structuredClone(proposal);
    forbidden.changed_files[0]!.path = ".github/workflows/deploy.yml";
    forbidden.proposal_hash = await automationWorkflowCodeFixProposalHash(forbidden);
    const broadContext = { ...baseContext, config: { ...baseContext.config, allowed_paths: ["**"] } };
    expect(issues(await validateAutomationWorkflowAdapterOutput(broadContext, forbidden)).join("\n"))
      .toContain("immutable deny-precedence workspace policy");

    const tooManyLines = structuredClone(proposal);
    tooManyLines.changed_files[0]!.added_lines = 51;
    tooManyLines.proposal_hash = await automationWorkflowCodeFixProposalHash(tooManyLines);
    expect(issues(await validateAutomationWorkflowAdapterOutput(baseContext, tooManyLines)).join("\n"))
      .toContain("aggregate changed lines exceed configured maximum 50");

    const failedTest = structuredClone(proposal);
    failedTest.tests[0]!.status = "failed";
    failedTest.tests[0]!.exit_code = 1;
    failedTest.proposal_hash = await automationWorkflowCodeFixProposalHash(failedTest);
    expect(issues(await validateAutomationWorkflowAdapterOutput(baseContext, failedTest)).join("\n"))
      .toContain("every recorded proposal test must pass");

    const wrongRepository = structuredClone(proposal);
    wrongRepository.repository = "https://github.com/example/other";
    wrongRepository.proposal_hash = await automationWorkflowCodeFixProposalHash(wrongRepository);
    expect(issues(await validateAutomationWorkflowAdapterOutput(baseContext, wrongRepository)).join("\n"))
      .toContain("proposal repository must match");

    const wrongHash = structuredClone(proposal);
    wrongHash.proposal_hash = HASH_D;
    expect(issues(await validateAutomationWorkflowAdapterOutput(baseContext, wrongHash)).join("\n"))
      .toContain("proposal_hash must match");
  });

  it("binds funnel-review findings and report identity to one exact source", async () => {
    const source = await runtimeInput("ordered_funnel_source@1", funnelSource());
    const reviewContext = await context("agent.funnel-review", { inputs: { source } });
    const report = await funnelReport();
    expect(await validateAutomationWorkflowAdapterOutput(reviewContext, report)).toMatchObject({
      success: true,
      canonical_target: "agentry:project:project-1",
    });

    const wrongSource = structuredClone(report);
    wrongSource.source_hash = HASH_A;
    wrongSource.report_hash = await automationWorkflowFunnelReportHash(wrongSource);
    expect(issues(await validateAutomationWorkflowAdapterOutput(reviewContext, wrongSource)).join("\n"))
      .toContain("report source_hash must match");

    const inventedEvidence = structuredClone(report);
    inventedEvidence.findings[0]!.evidence_paths = ["current.not_a_real_metric"];
    inventedEvidence.report_hash = await automationWorkflowFunnelReportHash(inventedEvidence);
    expect(issues(await validateAutomationWorkflowAdapterOutput(reviewContext, inventedEvidence)).join("\n"))
      .toContain("evidence path must resolve");

    const wrongHash = structuredClone(report);
    wrongHash.report_hash = HASH_A;
    expect(issues(await validateAutomationWorkflowAdapterOutput(reviewContext, wrongHash)).join("\n"))
      .toContain("report_hash must match");

    const tamperedSource = {
      ...source,
      payload_hash: HASH_A,
    } satisfies AutomationWorkflowAdapterInput;
    expect(issues(await validateAutomationWorkflowAdapterOutput(
      { ...reviewContext, inputs: { source: tamperedSource } },
      report,
    )).join("\n")).toContain("input_payload_hash_mismatch");
  });

  it("binds a draft PR receipt to intent, approved proposal, target, commit, URL, and server time", async () => {
    const proposalPayload = await codeFixProposal();
    const proposal = await runtimeInput("code_fix_proposal@1", proposalPayload);
    const draftContext = await context("effect.github.draft-pr", {
      runner: {
        provider: "codex",
        repository_provider: "github",
        repository: "https://github.com/example/app",
        default_branch: "main",
      },
      inputs: { proposal },
      intent: {
        intent_hash: HASH_D,
        provider_target: "https://github.com/example/app",
      },
    });
    const receipt = {
      intent_id: HASH_D,
      proposal_hash: proposalPayload.proposal_hash,
      provider: "github",
      provider_target: "https://github.com/example/app",
      pr_number: 7,
      pr_url: "https://github.com/example/app/pull/7",
      head_sha: proposalPayload.head_sha,
      recorded_at: 500,
      instruction_authority: "none",
    };
    expect(await validateAutomationWorkflowAdapterOutput(draftContext, receipt)).toMatchObject({
      success: true,
      canonical_target: "https://github.com/example/app",
    });

    const adversarial: Array<[string, typeof receipt]> = [
      ["receipt intent_id must equal", { ...receipt, intent_id: HASH_A }],
      ["receipt proposal_hash must match", { ...receipt, proposal_hash: HASH_A }],
      ["receipt provider_target does not match", {
        ...receipt,
        provider_target: "https://github.com/example/other",
      }],
      ["receipt head_sha must match", { ...receipt, head_sha: "abcdef3" }],
      ["receipt pr_url and pr_number must identify", {
        ...receipt,
        pr_url: "https://github.com/example/other/pull/7",
      }],
      ["server-owned command timestamp", { ...receipt, recorded_at: 501 }],
    ];
    for (const [message, output] of adversarial) {
      expect(issues(await validateAutomationWorkflowAdapterOutput(draftContext, output)).join("\n"))
        .toContain(message);
    }
  });

  it("binds a private report receipt to exact source and canonical report hashes", async () => {
    const sourcePayload = funnelSource();
    const reportPayload = await funnelReport();
    const reportContext = await context("effect.report.private", {
      inputs: {
        source: await runtimeInput("ordered_funnel_source@1", sourcePayload),
        report: await runtimeInput("funnel_review_report@1", reportPayload),
      },
    });
    const receipt = {
      report_id: "report-1",
      source_hash: sourcePayload.source_hash,
      report_hash: reportPayload.report_hash,
      visibility: "private",
      recorded_at: 500,
      instruction_authority: "none",
    };
    expect(await validateAutomationWorkflowAdapterOutput(reportContext, receipt)).toMatchObject({
      success: true,
      canonical_target: "agentry:project:project-1",
    });

    const wrongSource = { ...receipt, source_hash: HASH_A };
    expect(issues(await validateAutomationWorkflowAdapterOutput(reportContext, wrongSource)).join("\n"))
      .toContain("receipt source_hash must match");
    const wrongReport = { ...receipt, report_hash: HASH_A };
    expect(issues(await validateAutomationWorkflowAdapterOutput(reportContext, wrongReport)).join("\n"))
      .toContain("receipt report_hash must match");
    const callerTime = { ...receipt, recorded_at: 499 };
    expect(issues(await validateAutomationWorkflowAdapterOutput(reportContext, callerTime)).join("\n"))
      .toContain("server-owned command timestamp");

    const extraPortContext = {
      ...reportContext,
      inputs: {
        ...reportContext.inputs,
        invented: await runtimeInput("ordered_funnel_source@1", sourcePayload),
      },
    };
    expect(issues(await validateAutomationWorkflowAdapterOutput(extraPortContext, receipt)).join("\n"))
      .toContain("inputs must contain exactly the frozen ports");
  });

  it("keeps helper payloads JSON-compatible", async () => {
    const proposal = await codeFixProposal();
    const report = await funnelReport();
    expect(JSON.parse(JSON.stringify(proposal)) as AutomationWorkflowJsonValue).toEqual(proposal);
    expect(JSON.parse(JSON.stringify(report)) as AutomationWorkflowJsonValue).toEqual(report);
  });
});
