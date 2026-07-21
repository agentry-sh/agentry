import { describe, expect, it } from "vitest";
import {
  ONBOARDING_V3_NOTHING_REMAINING,
  ONBOARDING_V3_STATUSES,
  OnboardingV3ApprovedStateSchema,
  OnboardingV3PlanSchema,
  OnboardingV3PlannedStateSchema,
  OnboardingV3ProofStartRequestSchema,
  OnboardingV3ProofStartResponseSchema,
  OnboardingV3ProvingStateSchema,
  OnboardingV3ReviewRequestSchema,
  OnboardingV3SourceTargetSchema,
  OnboardingV3StartRequestSchema,
  OnboardingV3StateSchema,
  OnboardingV3VerifiedStateSchema,
  OnboardingV3VerifyResponseSchema,
  onboardingV3ApprovedNextAction,
  onboardingV3PlannedNextAction,
  onboardingV3ProvingNextAction,
  type OnboardingV3Plan,
} from "../src/onboarding-v3-contract.js";

const SHA = "a".repeat(40);
const PLAN_SHA = "b".repeat(64);
const FINGERPRINT = "c".repeat(64);
const FINAL_FINGERPRINT = "d".repeat(64);

function snapshot(
  gitHead = SHA,
  sourceFingerprint = FINGERPRINT,
) {
  return {
    git_head_sha: gitHead,
    source_fingerprint_sha256: sourceFingerprint,
    source_fingerprint_algorithm: "agentry-source-tree-sha256-v1" as const,
  };
}

function target(file = "src/product.ts", anchor = "handler") {
  return { file, anchor };
}

function historicalEvidence() {
  return {
    status: "historically_observed" as const,
    source: "posthog_cloud" as const,
    posthog_project_id: 42,
    observed_at: 100,
    window: { from: 1, to: 99 },
    query_receipt_sha256: "f".repeat(64),
    observations: [{
      kind: "analytics" as const,
      event: "value reached",
      observed_properties: ["account_id"],
      row_count: 12,
    }],
  };
}

function plan(): OnboardingV3Plan {
  return {
    business_question: "Where do users reach the product's valuable result?",
    plan_markdown:
      "A user enters the product, persists useful work, receives the result, and the release is attributed.",
    source_snapshot: snapshot(),
    historical_evidence: historicalEvidence(),
    milestones: [{
      event: "value reached",
      meaning: "The durable business result exists.",
      posthog_boundary: "server_posthog",
      properties: ["account_id", "result_id"],
      targets: [target()],
    }],
    failures: [{
      marker: "value rejected safely",
      meaning: "A validation guard rejects the request before side effects.",
      posthog_boundary: "server_posthog",
      context: ["reason_code"],
      safe_live_proof: true,
      targets: [target("src/product.ts", "validate")],
    }],
    deploy: {
      environment: "production",
      sha_source: "git_head",
      targets: [target(".github/workflows/deploy.yml", "provider deploy")],
    },
  };
}

function commonState(planValue = plan()) {
  return {
    contract_version: "3" as const,
    project_id: "project-0001",
    onboarding_id: "onboarding-0001",
    revision: 1,
    etag: `"${"e".repeat(64)}"`,
    plan_sha256: PLAN_SHA,
    plan: planValue,
    evidence_status: {
      historical: planValue.historical_evidence
        ? "historically_observed" as const
        : "not_established" as const,
      source: "pending" as const,
    },
    updated_at: 100,
  };
}

function openProof() {
  return {
    proof_session_id: "proof-session-0001",
    status: "open" as const,
    started_at: 101,
    expires_at: 3_701,
  };
}

function provingState(planValue = plan()) {
  return {
    ...commonState(planValue),
    revision: 3,
    status: "proving" as const,
    installation_complete: false as const,
    next_action: onboardingV3ProvingNextAction("project-0001"),
    implementation_source_snapshot: snapshot(SHA, FINAL_FINGERPRINT),
    proof_session: openProof(),
    updated_at: 102,
  };
}

function verifiedState(planValue = plan()) {
  const proving = provingState(planValue);
  const safeFailure = planValue.failures.find((failure) => failure.safe_live_proof)!;
  return {
    ...proving,
    revision: 4,
    status: "verified" as const,
    installation_complete: true as const,
    next_action: null,
    proof_session: { ...proving.proof_session, status: "satisfied" as const },
    receipt: {
      evidence_status: "source_verified" as const,
      source_verified_at: 200,
      analytics: planValue.milestones.map((milestone) => ({
        event: milestone.event,
        posthog_boundary: milestone.posthog_boundary,
        required_properties: milestone.properties,
        observed_properties: milestone.properties,
        row_count: 1,
      })),
      error: {
        marker: safeFailure.marker,
        posthog_boundary: safeFailure.posthog_boundary,
        required_context: safeFailure.context,
        observed_context: safeFailure.context,
        row_count: 1,
      },
      deploy: {
        environment: planValue.deploy.environment,
        source_snapshot: proving.implementation_source_snapshot,
        row_count: 1,
      },
    },
    evidence_status: {
      historical: planValue.historical_evidence
        ? "historically_observed" as const
        : "not_established" as const,
      source: "source_verified" as const,
    },
    updated_at: 200,
  };
}

describe("onboarding v3 compact contract", () => {
  it("requires the final committed git HEAD as the deploy proof identity", () => {
    expect(OnboardingV3PlanSchema.safeParse({
      ...plan(),
      deploy: { ...plan().deploy, sha_source: "provider_commit" },
    }).success).toBe(false);
  });

  it("accepts opaque names, duplicate names, generic anchors, and a long value flow", () => {
    const milestones = Array.from({ length: 40 }, (_, index) => ({
      event: index % 2 === 0
        ? "Checkout / Completed 🧪"
        : "same event is intentionally reusable",
      meaning: index === 39 ? "Paid" : `Durable milestone ${index + 1}`,
      posthog_boundary: index % 3 === 0
        ? "browser_posthog" as const
        : "server_posthog" as const,
      properties: ["workspace.id:stable", "token_count", "token_count"],
      targets: [
        target(`src/flows/step-${index}.ts`, "handler"),
        target(`src/flows/step-${index}.ts`, "console.error"),
      ],
    }));
    const candidate = {
      ...plan(),
      milestones,
      failures: [{
        ...plan().failures[0],
        marker: "Payment provider: declined / safe 🧪",
      }],
    };

    const parsed = OnboardingV3PlanSchema.parse(candidate);
    expect(parsed.milestones).toHaveLength(40);
    expect(parsed.milestones[0]?.properties).toEqual([
      "workspace.id:stable",
      "token_count",
      "token_count",
    ]);
    expect(parsed.milestones[0]?.targets).toHaveLength(2);
    expect(parsed.failures[0]?.marker).toBe(
      "Payment provider: declined / safe 🧪",
    );
  });

  it("accepts unique multiline source anchors but rejects unsafe control bytes", () => {
    expect(OnboardingV3SourceTargetSchema.safeParse({
      file: "src/product.ts",
      anchor: "await persist(result);\nreturn committed(result);",
    }).success).toBe(true);

    expect(OnboardingV3SourceTargetSchema.safeParse({
      file: "src/product.ts",
      anchor: "await persist(result);\u0000return committed(result);",
    }).success).toBe(false);
  });

  it("has no target ids, chain fields, naming policy, preservation ledger, or derived mirrors", () => {
    const parsed = OnboardingV3PlanSchema.parse(plan()) as Record<string, unknown>;
    for (const retired of [
      "id",
      "from",
      "to",
      "runtime_marker_binding_invalid",
      "browser_context_profile",
      "preserve_targets",
      "approval_message",
      "signal_types",
    ]) {
      expect(parsed).not.toHaveProperty(retired);
    }
    expect(parsed.milestones).toEqual([
      expect.not.objectContaining({ id: expect.anything(), from: expect.anything(), to: expect.anything() }),
    ]);
  });

  it("requires one or more milestones but imposes no maximum or uniqueness rule", () => {
    expect(OnboardingV3PlanSchema.safeParse({ ...plan(), milestones: [] }).success)
      .toBe(false);
    expect(OnboardingV3PlanSchema.safeParse({
      ...plan(),
      milestones: Array.from({ length: 250 }, () => plan().milestones[0]),
    }).success).toBe(true);
  });

  it("requires exactly one selected safe failure and exactly one deploy object", () => {
    const unsafeOnly = {
      ...plan(),
      failures: [{ ...plan().failures[0], safe_live_proof: false }],
    };
    const twoSafe = {
      ...plan(),
      failures: [plan().failures[0], {
        ...plan().failures[0],
        marker: "another safe rejection",
      }],
    };
    expect(OnboardingV3PlanSchema.safeParse(unsafeOnly).success).toBe(false);
    expect(OnboardingV3PlanSchema.safeParse(twoSafe).success).toBe(false);
    expect(OnboardingV3PlanSchema.safeParse({ ...plan(), deploy: undefined }).success)
      .toBe(false);
    expect(OnboardingV3PlanSchema.safeParse({ ...plan(), deploy: [plan().deploy] }).success)
      .toBe(false);
  });

  it("blocks only direct sensitive property keys while allowing useful similar names", () => {
    const useful = {
      ...plan(),
      milestones: [{
        ...plan().milestones[0],
        properties: ["token_count", "email_domain", "address_type", "is_authorized"],
      }],
    };
    expect(OnboardingV3PlanSchema.safeParse(useful).success).toBe(true);

    for (const sensitive of ["password", "apiKey", "email", "phone_number", "raw-ip"] ) {
      const candidate = {
        ...plan(),
        milestones: [{ ...plan().milestones[0], properties: [sensitive] }],
      };
      expect(OnboardingV3PlanSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects raw credentials and unsafe paths without interpreting repository semantics", () => {
    expect(OnboardingV3PlanSchema.safeParse({
      ...plan(),
      plan_markdown: "Use agentry_sk_this-is-a-real-looking-secret-value in production.",
    }).success).toBe(false);
    for (const file of ["/tmp/source.ts", "../source.ts", "src/../source.ts", "src\\source.ts"]) {
      const candidate = {
        ...plan(),
        milestones: [{ ...plan().milestones[0], targets: [target(file)] }],
      };
      expect(OnboardingV3PlanSchema.safeParse(candidate).success).toBe(false);
    }
    expect(OnboardingV3PlanSchema.safeParse({
      ...plan(),
      milestones: [{
        ...plan().milestones[0],
        targets: [target("src/routes.ts", "GET")],
      }],
    }).success).toBe(true);
  });

  it("allows canonical credential env names without allowing raw credential values", () => {
    const candidate = plan();
    candidate.plan_markdown +=
      "\nPlace AGENTRY_PRIVATE_API_KEY, AGENTRY_CI_API_KEY, and AGENTRY_RUNNER_API_KEY only at their scoped boundaries.";
    expect(OnboardingV3PlanSchema.safeParse(candidate).success).toBe(true);
    expect(OnboardingV3PlanSchema.safeParse({
      ...candidate,
      plan_markdown: candidate.plan_markdown +
        "\nNever include agentry_ci_project.secretvalue in a plan.",
    }).success).toBe(false);
  });

  it("keeps start and exact approve-or-replace requests small", () => {
    expect(OnboardingV3StartRequestSchema.parse({ intent: "start", plan: plan() }))
      .toMatchObject({ intent: "start" });
    expect(OnboardingV3ReviewRequestSchema.parse({
      decision: "approve",
      plan_sha256: PLAN_SHA,
    })).toEqual({ decision: "approve", plan_sha256: PLAN_SHA });
    expect(OnboardingV3ReviewRequestSchema.parse({
      decision: "replace",
      plan_sha256: PLAN_SHA,
      replacement_plan: plan(),
    })).toMatchObject({ decision: "replace", plan_sha256: PLAN_SHA });
    expect(OnboardingV3ReviewRequestSchema.safeParse({
      decision: "approve",
      plan_sha256: PLAN_SHA,
      replacement_plan: plan(),
    }).success).toBe(false);
  });

  it("starts proof with only the final committed source snapshot", () => {
    const finalSnapshot = snapshot(SHA, FINAL_FINGERPRINT);
    expect(OnboardingV3ProofStartRequestSchema.parse({
      implementation_source_snapshot: finalSnapshot,
    })).toEqual({ implementation_source_snapshot: finalSnapshot });
    expect(OnboardingV3ProofStartRequestSchema.safeParse({
      implementation_source_snapshot: finalSnapshot,
      implementation_evidence: {},
    }).success).toBe(false);
  });

  it("has only planned, approved, proving, and verified states", () => {
    const planned = {
      ...commonState(),
      status: "planned" as const,
      installation_complete: false as const,
      next_action: onboardingV3PlannedNextAction("project-0001"),
    };
    const approved = {
      ...commonState(),
      revision: 2,
      status: "approved" as const,
      installation_complete: false as const,
      next_action: onboardingV3ApprovedNextAction("project-0001"),
      approved_at: 101,
    };
    const proving = provingState();
    const verified = verifiedState();

    expect(ONBOARDING_V3_STATUSES).toEqual([
      "planned",
      "approved",
      "proving",
      "verified",
    ]);
    expect(OnboardingV3PlannedStateSchema.safeParse(planned).success).toBe(true);
    expect(OnboardingV3ApprovedStateSchema.safeParse(approved).success).toBe(true);
    expect(OnboardingV3ProvingStateSchema.safeParse(proving).success).toBe(true);
    expect(OnboardingV3VerifiedStateSchema.safeParse(verified).success).toBe(true);
    for (const state of [planned, approved, proving, verified]) {
      expect(OnboardingV3StateSchema.safeParse(state).success).toBe(true);
      expect(state).not.toHaveProperty("baseline");
      expect(state).not.toHaveProperty("implementation_evidence");
      expect(state).not.toHaveProperty("pointer");
    }
    expect(planned.next_action).toMatchObject({
      id: "review_exact_plan",
      requires_human: true,
      operation: {
        method: "POST",
        path: "/v1/projects/project-0001/onboarding/review",
      },
    });
    expect(approved.next_action).toMatchObject({
      id: "instrument_and_start_proof",
      requires_human: false,
      operation: {
        method: "POST",
        path: "/v1/projects/project-0001/onboarding/proof",
      },
    });
    expect(proving.next_action).toMatchObject({
      id: "exercise_and_verify",
      requires_human: false,
      operation: {
        method: "POST",
        path: "/v1/projects/project-0001/onboarding/verify",
      },
    });
    expect(OnboardingV3PlannedStateSchema.safeParse({
      ...planned,
      next_action: {
        ...planned.next_action,
        operation: { method: "POST", path: "/v1/projects/other-0001/onboarding/review" },
      },
    }).success).toBe(false);
  });

  it("keeps bounded historical PostHog evidence non-authorizing until source verification", () => {
    const planned = {
      ...commonState(),
      status: "planned" as const,
      installation_complete: false as const,
      next_action: onboardingV3PlannedNextAction("project-0001"),
    };
    expect(planned.evidence_status).toEqual({
      historical: "historically_observed",
      source: "pending",
    });
    expect(planned.plan.historical_evidence?.observations[0]).toEqual({
      kind: "analytics",
      event: "value reached",
      observed_properties: ["account_id"],
      row_count: 12,
    });
    expect(JSON.stringify(planned.plan.historical_evidence)).not.toContain("payload");
    expect(OnboardingV3PlannedStateSchema.safeParse({
      ...planned,
      installation_complete: true,
    }).success).toBe(false);
    expect(OnboardingV3VerifiedStateSchema.safeParse({
      ...verifiedState(),
      evidence_status: {
        historical: "historically_observed",
        source: "pending",
      },
    }).success).toBe(false);

    const withoutHistoryPlan = { ...plan(), historical_evidence: null };
    const withoutHistory = {
      ...commonState(withoutHistoryPlan),
      status: "planned" as const,
      installation_complete: false as const,
      next_action: onboardingV3PlannedNextAction("project-0001"),
    };
    expect(withoutHistory.evidence_status).toEqual({
      historical: "not_established",
      source: "pending",
    });
    expect(OnboardingV3PlannedStateSchema.safeParse(withoutHistory).success).toBe(true);
  });

  it("rejects unbounded or payload-shaped historical evidence", () => {
    const current = plan();
    expect(OnboardingV3PlanSchema.safeParse({
      ...current,
      historical_evidence: {
        ...historicalEvidence(),
        observations: [{
          kind: "analytics",
          event: "value reached",
          observed_properties: ["account_id"],
          row_count: 1,
          payload: { account_id: "customer-123" },
        }],
      },
    }).success).toBe(false);
    expect(OnboardingV3PlanSchema.safeParse({
      ...current,
      historical_evidence: {
        ...historicalEvidence(),
        window: { from: 99, to: 1 },
      },
    }).success).toBe(false);
  });

  it("returns distinct one-time markers without putting them in durable state", () => {
    const response = OnboardingV3ProofStartResponseSchema.parse({
      state: provingState(),
      one_time_markers: {
        runtime: {
          property_name: "agentry_onboarding_proof",
          value: "runtime-proof-marker-value-0001",
          environment_variable: "AGENTRY_ONBOARDING_PROOF",
          browser_session_storage_key: "agentry_onboarding_proof",
        },
        ci: {
          header_name: "X-Agentry-Onboarding-Proof",
          value: "ci-proof-marker-value-00000001",
          environment_variable: "AGENTRY_ONBOARDING_PROOF",
        },
      },
    });
    expect(response.state).not.toHaveProperty("one_time_markers");
    expect(OnboardingV3ProofStartResponseSchema.safeParse({
      ...response,
      one_time_markers: {
        runtime: response.one_time_markers.runtime,
        ci: response.one_time_markers.runtime,
      },
    }).success).toBe(false);
  });

  it("keeps incomplete verification actionable and accepts only plan-bound green proof", () => {
    expect(OnboardingV3VerifyResponseSchema.safeParse({
      ok: false,
      state: provingState(),
      remaining: {
        analytics: {
          blockers: [],
          milestones: [{
            milestone_index: 0,
            event: "value reached",
            posthog_boundary: "server_posthog",
          }],
          properties: [],
        },
        safe_error: null,
        deploy: null,
      },
    }).success).toBe(true);
    expect(OnboardingV3VerifyResponseSchema.safeParse({
      ok: false,
      state: provingState(),
      remaining: ONBOARDING_V3_NOTHING_REMAINING,
    }).success).toBe(false);

    const green = {
      ok: true as const,
      state: verifiedState(),
      remaining: ONBOARDING_V3_NOTHING_REMAINING,
    };
    expect(OnboardingV3VerifyResponseSchema.safeParse(green).success).toBe(true);
    expect(OnboardingV3VerifyResponseSchema.safeParse({
      ...green,
      state: {
        ...green.state,
        receipt: {
          ...green.state.receipt,
          analytics: [{
            ...green.state.receipt.analytics[0],
            event: "a fixed evaluator event name",
          }],
        },
      },
    }).success).toBe(false);
    expect(OnboardingV3VerifyResponseSchema.safeParse({
      ...green,
      state: {
        ...green.state,
        receipt: {
          ...green.state.receipt,
          deploy: {
            ...green.state.receipt.deploy,
            source_snapshot: snapshot(SHA, "f".repeat(64)),
          },
        },
      },
    }).success).toBe(false);
  });
});
