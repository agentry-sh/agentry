import { eq } from "drizzle-orm";
import { projects } from "@agentry/db/schema";
import { sha256Hex } from "@agentrysh/shared";
import type { OnboardingV3Plan } from "../src/onboarding-v3-contract.js";
import {
  approveOnboardingV3State,
  createOrReplacePlannedOnboardingV3State,
  loadOnboardingV3State,
  onboardingV3PlanSha256,
  recordVerifiedOnboardingV3State,
  startProvingOnboardingV3State,
} from "../src/onboarding-v3-state-store.js";
import { getDbForUrl } from "./setup.js";

type Db = ReturnType<typeof getDbForUrl>;

export type OnboardingReadinessFixtureInput = {
  db: Db;
  project_id: string;
  approved_events: readonly string[];
  approved_plan_hash: string;
};

function eventsOf(input: OnboardingReadinessFixtureInput): string[] {
  const events = [...new Set(input.approved_events)];
  if (events.length === 0) throw new Error("readiness fixture requires an event");
  return events;
}

async function fixture(input: OnboardingReadinessFixtureInput) {
  const project = (await input.db.select({ userId: projects.userId }).from(projects)
    .where(eq(projects.id, input.project_id)).limit(1))[0];
  if (!project) throw new Error(`missing fixture project ${input.project_id}`);
  const events = eventsOf(input);
  const fingerprint = await sha256Hex(
    `${input.project_id}\0${input.approved_plan_hash}\0${events.join("\0")}`,
  );
  const sourceSnapshot = {
    git_head_sha: fingerprint.slice(0, 40),
    source_fingerprint_sha256: fingerprint,
    source_fingerprint_algorithm: "agentry-source-tree-sha256-v1" as const,
  };
  const plan: OnboardingV3Plan = {
    business_question: "Where do customers stop before the durable product result?",
    plan_markdown: "A source-backed customer flow with real milestones, one safe failure, and one production deploy.",
    source_snapshot: sourceSnapshot,
    historical_evidence: {
      status: "historically_observed",
      source: "posthog_cloud",
      posthog_project_id: 42,
      observed_at: Math.floor(Date.now() / 1_000),
      window: {
        from: Math.floor(Date.now() / 1_000) - 86_400,
        to: Math.floor(Date.now() / 1_000) - 1,
      },
      query_receipt_sha256: fingerprint,
      observations: events.map((event) => ({
        kind: "analytics" as const,
        event,
        observed_properties: ["entity_id", "flow_stage"],
        row_count: 1,
      })),
    },
    milestones: events.map((event, index) => ({
      event,
      meaning: `Durable customer milestone ${index + 1}`,
      posthog_boundary: "server_posthog",
      properties: ["entity_id", "flow_stage"],
      targets: [{ file: `src/product-flow/step-${index + 1}.ts`, anchor: `recordStep${index + 1}` }],
    })),
    failures: [{
      marker: `controlled_provider_failure_${fingerprint.slice(0, 12)}`,
      meaning: "A handled provider rejection blocks the selected value flow without side effects.",
      posthog_boundary: "server_posthog",
      context: ["entity_id", "operation"],
      safe_live_proof: true,
      targets: [{ file: "src/integrations/provider.ts", anchor: "callProvider" }],
    }],
    deploy: {
      environment: "production",
      sha_source: "git_head",
      targets: [{ file: ".github/workflows/deploy.yml", anchor: "deploy" }],
    },
  };
  return { project, plan, sourceSnapshot };
}

export async function seedApprovedOnboardingPlan(
  input: OnboardingReadinessFixtureInput,
): Promise<OnboardingV3Plan> {
  const { project, plan } = await fixture(input);
  const existing = await loadOnboardingV3State(input.db, input.project_id);
  const current = await createOrReplacePlannedOnboardingV3State(input.db, {
    project_id: input.project_id,
    created_by: project.userId,
    plan,
    expected_etag: existing?.etag,
  });
  if (current.state.status === "planned") {
    await approveOnboardingV3State(input.db, {
      project_id: input.project_id,
      onboarding_id: current.state.onboarding_id,
      expected_etag: current.state.etag,
      plan_sha256: current.state.plan_sha256,
    });
  }
  return plan;
}

export async function seedVerifiedOnboardingReadiness(
  input: OnboardingReadinessFixtureInput,
) {
  const { project, plan, sourceSnapshot } = await fixture(input);
  const existing = await loadOnboardingV3State(input.db, input.project_id);
  const planSha256 = await onboardingV3PlanSha256(plan);
  let approvedState;
  if (existing?.status === "approved" && existing.plan_sha256 === planSha256) {
    approvedState = existing;
  } else {
    const planned = await createOrReplacePlannedOnboardingV3State(input.db, {
      project_id: input.project_id,
      created_by: project.userId,
      plan,
      expected_etag: existing?.etag,
    });
    approvedState = (await approveOnboardingV3State(input.db, {
      project_id: input.project_id,
      onboarding_id: planned.state.onboarding_id,
      expected_etag: planned.state.etag,
      plan_sha256: planned.state.plan_sha256,
    })).state;
  }
  const now = Math.floor(Date.now() / 1_000);
  const proving = await startProvingOnboardingV3State(input.db, {
    project_id: input.project_id,
    onboarding_id: approvedState.onboarding_id,
    expected_etag: approvedState.etag,
    implementation_source_snapshot: sourceSnapshot,
    proof_session: {
      proof_session_id: `proof-${sourceSnapshot.source_fingerprint_sha256.slice(0, 24)}`,
      status: "open",
      started_at: now,
      expires_at: now + 3_600,
    },
  });
  const safeFailure = plan.failures.find((failure) => failure.safe_live_proof)!;
  const verified = await recordVerifiedOnboardingV3State(input.db, {
    project_id: input.project_id,
    onboarding_id: proving.state.onboarding_id,
    expected_etag: proving.state.etag,
    receipt: {
      evidence_status: "source_verified",
      source_verified_at: now + 1,
      analytics: plan.milestones.map((milestone) => ({
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
        environment: plan.deploy.environment,
        source_snapshot: sourceSnapshot,
        row_count: 1,
      },
    },
  });
  return {
    plan,
    approved_plan_hash: verified.state.plan_sha256,
    verified_onboarding_etag: verified.state.etag,
  };
}
