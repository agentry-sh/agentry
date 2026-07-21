import { describe, expect, it } from "vitest";
import {
  OnboardingV3VerifiedReceiptSchema,
  type OnboardingV3Plan,
} from "../src/onboarding-v3-contract.js";
import type { SafeOnboardingProofSession } from "../src/onboarding-proof-sessions.js";
import type { AgentryDb } from "../src/db.js";
import type { Env } from "../src/env.js";
import {
  assembleOnboardingV3LiveProofResult,
  buildOnboardingV3AnalyticsProofQuery,
  buildOnboardingV3ErrorProofQuery,
  verifyOnboardingV3LiveProof,
} from "../src/onboarding-v3-live-proof.js";
import { CUSTOMER_ANALYTICS_HOGQL_FILTER } from "../src/customer-data.js";

const NOW = Math.floor(Date.now() / 1_000);

function snapshot() {
  return {
    git_head_sha: "a".repeat(40),
    source_fingerprint_sha256: "b".repeat(64),
    source_fingerprint_algorithm: "agentry-source-tree-sha256-v1" as const,
  };
}

function plan(): OnboardingV3Plan {
  return {
    business_question: "Where does a customer receive durable value?",
    plan_markdown: "Actor → entry → durable progress → first value → business result.",
    source_snapshot: snapshot(),
    historical_evidence: {
      status: "historically_observed",
      source: "posthog_cloud",
      posthog_project_id: 42,
      observed_at: NOW - 100,
      window: { from: NOW - 86_400, to: NOW - 101 },
      query_receipt_sha256: "e".repeat(64),
      observations: [{
        kind: "analytics",
        event: "Work accepted / user's choice 🧪",
        observed_properties: ["result.id"],
        row_count: 9,
      }],
    },
    milestones: [
      {
        event: "Work accepted / user's choice 🧪",
        meaning: "The first durable result was accepted.",
        posthog_boundary: "browser_posthog",
        properties: ["result.id", "result.id"],
        targets: [{ file: "src/browser.ts", anchor: "persisted result" }],
      },
      {
        event: "Work accepted / user's choice 🧪",
        meaning: "A separately approved server boundary uses the same event name.",
        posthog_boundary: "server_posthog",
        properties: [],
        targets: [{ file: "src/server.ts", anchor: "return durable result" }],
      },
    ],
    failures: [{
      marker: "provider safely rejected / opaque",
      meaning: "The provider rejected input before mutation.",
      posthog_boundary: "server_posthog",
      context: [],
      safe_live_proof: true,
      targets: [{ file: "src/server.ts", anchor: "validation rejected" }],
    }],
    deploy: {
      environment: "customer-production",
      sha_source: "git_head",
      targets: [{ file: ".github/workflows/release.yml", anchor: "deploy completed" }],
    },
  };
}

function credential(id: string) {
  return {
    credential_id: id,
    kind: "ci_deploy" as const,
    name: "CI proof",
    prefix: "agentry_ci_proof",
    created_at: NOW - 100,
    expires_at: NOW + 7_200,
    revoked_at: null,
    revoke_reason: null,
  };
}

function session(): SafeOnboardingProofSession {
  return {
    session_id: "proof-session-0001",
    project_id: "project-0001",
    onboarding_id: "onboarding-0001",
    approved_state_etag: `"${"d".repeat(64)}"`,
    status: "active",
    started_at: NOW - 60,
    expires_at: NOW + 3_600,
    terminal_at: null,
    terminal_reason: null,
    updated_at: NOW - 60,
    runtime_marker_hash: "c".repeat(64),
    ci_deploy: credential("credential-ci-0001"),
  };
}

describe("onboarding v3 lean live proof", () => {
  it("builds a bounded PostHog read scoped by the transient runtime marker", () => {
    const query = buildOnboardingV3AnalyticsProofQuery(plan(), session());

    expect(query).not.toContain(CUSTOMER_ANALYTICS_HOGQL_FILTER);
    expect(query).not.toContain("event NOT IN");
    expect(query).toContain("event = 'Work accepted / user''s choice 🧪'");
    expect(query).toContain("properties['agentry_onboarding_proof']");
    expect(query).toContain("startsWith(");
    expect(query).toContain("'agentry_proof_runtime_'");
    expect(query).toContain("GROUP BY proof_marker");
    expect(query).toContain("JSONExtractRaw(properties, 'result.id')");
    expect(query).toContain("notEmpty(trim(");
    expect(query).not.toContain("trimBoth(");
    expect(query.match(/ UNION ALL /g)).toHaveLength(1);
    expect(query).not.toContain("proof-session-0001");
    expect(query).not.toContain("credential-ci-0001");
    expect(query).not.toContain("$agentry_credential_id");
    expect(query).not.toContain("src/browser.ts");
    expect(query).not.toContain("target_id");
  });

  it("queries safe failures as PostHog exceptions without raw error payloads", () => {
    const query = buildOnboardingV3ErrorProofQuery(plan(), session());
    expect(query).toContain("event = '$exception'");
    expect(query).toContain("properties['agentry_onboarding_failure']");
    expect(query).toContain("properties['agentry_onboarding_proof']");
    expect(query).toContain("GROUP BY proof_marker, failure_marker");
    expect(query).not.toContain("$exception_message");
    expect(query).not.toContain("$exception_stack_trace");
    expect(query).not.toContain("$agentry_credential_id");
  });

  it("issues a compact receipt when every approved opaque signal is observed", () => {
    const candidate = assembleOnboardingV3LiveProofResult({
      plan: plan(),
      implementation_source_snapshot: snapshot(),
      analytics: [
        {
          milestone_index: 0,
          source_row_count: 3,
          qualifying_row_count: 2,
          observed_property_keys: ["result.id"],
        },
        {
          milestone_index: 1,
          source_row_count: 1,
          qualifying_row_count: 1,
          observed_property_keys: [],
        },
      ],
      error: {
        marker_row_count: 1,
        qualifying_row_count: 1,
        observed_context: [],
      },
      deploy: { qualifying_row_count: 1 },
      source_verified_at: NOW,
    });

    expect(candidate).toEqual({
      ok: true,
      remaining: {
        analytics: { blockers: [], milestones: [], properties: [] },
        safe_error: null,
        deploy: null,
      },
      receipt: expect.objectContaining({
        evidence_status: "source_verified",
        source_verified_at: NOW,
        analytics: [
          expect.objectContaining({
            event: "Work accepted / user's choice 🧪",
            row_count: 2,
          }),
          expect.objectContaining({
            event: "Work accepted / user's choice 🧪",
            required_properties: [],
            row_count: 1,
          }),
        ],
        error: expect.objectContaining({ row_count: 1, required_context: [] }),
        deploy: expect.objectContaining({
          environment: "customer-production",
          source_snapshot: snapshot(),
          row_count: 1,
        }),
      }),
    });
    expect(OnboardingV3VerifiedReceiptSchema.safeParse(candidate.receipt).success).toBe(true);
  });

  it("requires each approved property to be present and nonempty", () => {
    const result = assembleOnboardingV3LiveProofResult({
      plan: plan(),
      implementation_source_snapshot: snapshot(),
      analytics: [
        {
          milestone_index: 0,
          source_row_count: 1,
          qualifying_row_count: 1,
          observed_property_keys: [],
        },
        {
          milestone_index: 1,
          source_row_count: 1,
          qualifying_row_count: 1,
          observed_property_keys: [],
        },
      ],
      error: { marker_row_count: 1, qualifying_row_count: 1, observed_context: [] },
      deploy: { qualifying_row_count: 1 },
    });

    expect(result.ok).toBe(false);
    expect(result.remaining.analytics.properties).toEqual([{
      milestone_index: 0,
      event: "Work accepted / user's choice 🧪",
      properties: ["result.id"],
      requirement: "present_and_nonempty_together",
    }]);
  });

  it("reports missing events, nonempty properties, safe error context, and deploy proof without a receipt", () => {
    const withContext: OnboardingV3Plan = {
      ...plan(),
      failures: [{ ...plan().failures[0]!, context: ["provider.reason"] }],
    };
    const result = assembleOnboardingV3LiveProofResult({
      plan: withContext,
      implementation_source_snapshot: snapshot(),
      analytics: [
        {
          milestone_index: 0,
          source_row_count: 1,
          qualifying_row_count: 0,
          observed_property_keys: [],
        },
        {
          milestone_index: 1,
          source_row_count: 0,
          qualifying_row_count: 0,
          observed_property_keys: [],
        },
      ],
      error: {
        marker_row_count: 1,
        qualifying_row_count: 0,
        observed_context: [],
      },
      deploy: { qualifying_row_count: 0 },
    });

    expect(result.ok).toBe(false);
    expect(result.receipt).toBeNull();
    expect(result.remaining).toMatchObject({
      analytics: {
        blockers: [],
        milestones: [{
          milestone_index: 1,
          event: withContext.milestones[1]!.event,
          posthog_boundary: "server_posthog",
        }],
        properties: [{
          milestone_index: 0,
          event: withContext.milestones[0]!.event,
          properties: expect.arrayContaining([
            "result.id",
          ]),
          requirement: "present_and_nonempty_together",
        }],
      },
      safe_error: {
        marker: "provider safely rejected / opaque",
        marker_missing: false,
        context: ["provider.reason"],
        blockers: [],
      },
      deploy: {
        environment: "customer-production",
        blockers: ["deploy_not_observed"],
      },
    });
  });

  it("turns read failures into missing proof and never fabricates a receipt", () => {
    const result = assembleOnboardingV3LiveProofResult({
      plan: plan(),
      implementation_source_snapshot: snapshot(),
      read_failures: ["analytics", "error", "deploy"],
    });

    expect(result).toEqual({
      ok: false,
      receipt: null,
      remaining: {
        analytics: {
          blockers: ["analytics_read_failed"],
          milestones: [],
          properties: [],
        },
        safe_error: {
          marker: "provider safely rejected / opaque",
          posthog_boundary: "server_posthog",
          marker_missing: true,
          context: [],
          context_requirement: "present_and_nonempty_together",
          blockers: ["safe_error_read_failed"],
        },
        deploy: {
          environment: "customer-production",
          blockers: ["deploy_read_failed"],
        },
      },
    });
  });

  it("converts rejected provider and database reads into missing proof", async () => {
    const unavailableDb = {
      select() {
        throw new Error("database unavailable");
      },
    } as unknown as AgentryDb;
    const result = await verifyOnboardingV3LiveProof({} as Env, {
      db: unavailableDb,
      project_id: "project-0001",
      plan: plan(),
      implementation_source_snapshot: snapshot(),
      session: session(),
    });

    expect(result).toEqual({
      ok: false,
      receipt: null,
      remaining: {
        analytics: {
          blockers: ["analytics_read_failed"],
          milestones: [],
          properties: [],
        },
        safe_error: {
          marker: "provider safely rejected / opaque",
          posthog_boundary: "server_posthog",
          marker_missing: true,
          context: [],
          context_requirement: "present_and_nonempty_together",
          blockers: ["safe_error_read_failed"],
        },
        deploy: {
          environment: "customer-production",
          blockers: ["deploy_read_failed"],
        },
      },
    });
  });
});
