import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AutomationContractSchema,
  uuidv7,
  type AutomationContract,
} from "@agentrysh/shared";
import {
  alerts,
  automationContracts,
  automationTriggerReceipts,
  cases,
  posthogConnections,
  projects,
  users,
} from "@agentry/db/schema";
import { getDbForUrl, makeTestEnv, type TestEnv } from "./setup.js";
import {
  alertTriggerKey,
  caseTriggerKey,
  findLatestScheduleOccurrence,
  issueAutomationTriggerReceipts,
  scheduleTriggerKey,
} from "../src/automation-trigger-orchestration.js";
import { automationContractEtag } from "../src/automation-contracts.js";

let env: TestEnv;

beforeEach(async () => {
  env = await makeTestEnv();
});

describe("server-issued automation trigger receipts", () => {
  it("issues one deterministic schedule occurrence and replays the same receipt", async () => {
    const contract = contractWith({
      id: "weekly_report",
      trigger: {
        kind: "schedule",
        cron: "0 9 * * MON",
        timezone: "UTC",
        report_kind: "funnel_review",
        start_window_seconds: 900,
      },
      report_plan: {
        blueprint_id: "ordered_funnel_period_compare",
        params: {
          scheduled_for: { source: "schedule", field: "scheduled_for" },
          period_days: 7,
          funnel_events_json: "[\"account_created\",\"workspace_created\",\"subscription_started\"]",
          minimum_sample_size: 10,
        },
        period: { lookback_seconds: 604_800 },
      },
      allowed_actions: ["record_report"],
    });
    const { db, projectId, userId } = await seedProject(contract);
    const now = Math.floor(Date.parse("2026-07-06T09:05:30.000Z") / 1_000);

    const first = await issueAutomationTriggerReceipts(db, projectId, "weekly_report", now);
    const replay = await issueAutomationTriggerReceipts(db, projectId, "weekly_report", now + 10);

    expect(first.issuedCount).toBe(1);
    expect(first.receipts[0]?.scheduledFor).toBe(Date.parse("2026-07-06T09:00:00.000Z") / 1_000);
    expect(replay.issuedCount).toBe(0);
    expect(replay.replayedCount).toBe(1);
    expect(replay.receipts[0]?.id).toBe(first.receipts[0]?.id);
    expect(first.receipts[0]?.triggerKey).toBe(scheduleTriggerKey(1, Math.floor(first.receipts[0]!.scheduledFor! / 60)));
  });

  it("issues only OAuth-backed open cases and reissues the same next claim attempt after receipt expiry", async () => {
    const contract = contractWith({
      id: "case_triage",
      trigger: {
        kind: "unhandled_cases",
        max_cases_per_sweep: 10,
        cooldown_seconds: 300,
        required_trust: "customer_posthog",
      },
      allowed_actions: ["escalate"],
    });
    const { db, projectId, userId } = await seedProject(contract);
    const trustedCaseId = uuidv7();
    await db.insert(posthogConnections).values({
      id: "phconn-trigger-test",
      projectId,
      authorizedByUserId: userId,
      oauthClientId: "https://api.agentry.test/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: 9_999_999_999,
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org-trigger-test",
      posthogEnvironmentId: 42,
      authorizedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.insert(cases).values([
      {
        id: trustedCaseId,
        projectId,
        providerIssueId: trustedCaseId,
        providerSnapshotHash: "a".repeat(64),
        providerProjectedAt: 1_000,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "trusted-case",
        errorType: "TypeError",
        message: "trusted failure",
        status: "active" as const,
        eventCount: 3,
        firstSeenAt: 900,
        lastSeenAt: 1_000,
        lastTrustLevel: "customer_posthog",
        lastCredentialKind: "posthog_oauth",
        revision: 4,
      },
      {
        id: uuidv7(),
        projectId,
        providerIssueId: "resolved-case",
        providerSnapshotHash: "b".repeat(64),
        providerProjectedAt: 1_100,
        providerEventClassification: "customer_exception" as const,
        fingerprint: "resolved-case",
        errorType: "Error",
        message: "already resolved",
        status: "resolved" as const,
        eventCount: 1,
        firstSeenAt: 950,
        lastSeenAt: 1_100,
        lastTrustLevel: "customer_posthog",
        lastCredentialKind: "posthog_oauth",
        revision: 2,
      },
      {
        id: "onboarding-proof-case",
        projectId,
        providerIssueId: "onboarding-proof-case",
        providerSnapshotHash: "c".repeat(64),
        providerProjectedAt: 1_200,
        providerEventClassification: "onboarding_proof_exception" as const,
        fingerprint: "onboarding-proof-case",
        errorType: "ExpectedProofError",
        message: "safe onboarding proof",
        status: "active" as const,
        eventCount: 1,
        firstSeenAt: 1_150,
        lastSeenAt: 1_200,
        lastTrustLevel: "customer_posthog",
        lastCredentialKind: "posthog_oauth",
        revision: 1,
      },
    ]);

    const first = await issueAutomationTriggerReceipts(db, projectId, "case_triage", 2_000);
    expect(first.issuedCount).toBe(1);
    expect(first.receipts[0]).toMatchObject({
      caseId: trustedCaseId,
      caseRevision: 4,
      attempt: 1,
      sourceTrust: "customer_posthog",
      triggerKey: caseTriggerKey(1, trustedCaseId, 4, 1, Math.floor(2_000 / 300)),
    });

    const second = await issueAutomationTriggerReceipts(db, projectId, "case_triage", 5_601);
    expect(second.issuedCount).toBe(1);
    expect(second.receipts.find((receipt) => receipt.status === "ready")).toMatchObject({
      caseId: trustedCaseId,
      caseRevision: 4,
      attempt: 1,
      triggerKey: caseTriggerKey(1, trustedCaseId, 4, 1, Math.floor(5_601 / 300)),
    });
    const persisted = await db
      .select()
      .from(automationTriggerReceipts)
      .where(eq(automationTriggerReceipts.caseId, trustedCaseId));
    expect(persisted.map((receipt) => receipt.status).sort()).toEqual(["expired", "ready"]);
  });

  it("counts distinct server alert evaluations and fails closed before the breach gate", async () => {
    const contract = contractWith({
      id: "alert_report",
      trigger: {
        kind: "alert",
        alert_id: "alert-1",
        cooldown_seconds: 300,
        min_consecutive_breaches: 2,
        required_trust: "server_evaluated",
      },
      allowed_actions: ["escalate"],
    });
    const { db, projectId } = await seedProject(contract);
    await db.insert(alerts).values({
      id: "alert-1",
      projectId,
      name: "Error rate",
      recipeId: "active_cases_top",
      paramsJson: "{}",
      thresholdColumn: "event_count",
      thresholdOp: "gt",
      thresholdValue: "10",
      active: 1,
      lastEvaluatedAt: 9_990,
      lastValue: "12",
      lastState: "triggered",
    });

    const first = await issueAutomationTriggerReceipts(db, projectId, "alert_report", 10_000);
    expect(first.receipts).toEqual([]);
    expect(first.skipped[0]?.code).toBe("consecutive_breach_gate_not_met");

    await db.update(alerts).set({ lastEvaluatedAt: 10_001, lastValue: "13" }).where(eq(alerts.id, "alert-1"));
    const second = await issueAutomationTriggerReceipts(db, projectId, "alert_report", 10_002);
    expect(second.issuedCount).toBe(1);
    expect(second.receipts[0]?.triggerKey).toBe(alertTriggerKey(1, "alert-1", 10_001));
    expect(second.receipts[0]?.sourceTrust).toBe("agentry_system");
  });
});

describe("schedule occurrence window", () => {
  it("accepts a delayed sweep only inside the configured start window", () => {
    const due = Date.parse("2026-07-06T09:14:59.000Z") / 1_000;
    const late = Date.parse("2026-07-06T09:15:00.000Z") / 1_000;
    expect(findLatestScheduleOccurrence("0 9 * * MON", "UTC", due, 900))
      .toBe(Date.parse("2026-07-06T09:00:00.000Z") / 1_000);
    expect(findLatestScheduleOccurrence("0 9 * * MON", "UTC", late, 900)).toBeNull();
  });
});

function contractWith(automation: {
  id: string;
  trigger: Record<string, unknown>;
  report_plan?: Record<string, unknown>;
  allowed_actions: string[];
}): AutomationContract {
  return AutomationContractSchema.parse({
    schema_version: "2",
    revision: 1,
    enabled: true,
    summary: "Trigger receipt test policy",
    automations: [{
      id: automation.id,
      name: automation.id,
      enabled: true,
      runner: {
        provider: "codex",
        repository: "https://github.com/example/agentry-demo",
        default_branch: "main",
        mode: "draft_only",
      },
      trigger: automation.trigger,
      ...(automation.report_plan ? { report_plan: automation.report_plan } : {}),
      allowed_actions: automation.allowed_actions,
      scope: {},
      escalation: {
        destination: "project owner",
        instructions: "Attach evidence and stop.",
      },
    }],
  });
}

async function seedProject(contract: AutomationContract) {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const userId = uuidv7();
  const projectId = uuidv7();
  await db.insert(users).values({ id: userId, email: `${userId}@example.com` });
  await db.insert(projects).values({
    id: projectId,
    userId,
    name: "trigger receipt test",
    repoUrl: "https://github.com/example/agentry-demo",
    defaultBranch: "main",
  });
  await db.insert(automationContracts).values({
    projectId,
    schemaVersion: contract.schema_version,
    revision: contract.revision,
    enabled: 1,
    etag: await automationContractEtag(contract),
    documentJson: JSON.stringify(contract),
  });
  return { db, projectId, userId };
}
