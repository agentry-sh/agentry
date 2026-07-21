import type { getDb } from "./db.js";
import {
  loadOnboardingV3State,
  type OnboardingV3State,
} from "./onboarding-v3-state-store.js";

export type VerifiedOnboarding = Extract<OnboardingV3State, { status: "verified" }>;

export type OnboardingReadiness = {
  verified: boolean;
  observed_events: string[];
  all_approved_events_observed: boolean;
  safe_error_proved: boolean;
  exact_deploy_proved: boolean;
};

export async function loadVerifiedOnboarding(
  db: ReturnType<typeof getDb>,
  projectId: string,
): Promise<VerifiedOnboarding | null> {
  const state = await loadOnboardingV3State(db, projectId);
  return state?.status === "verified" &&
      state.evidence_status.source === "source_verified" &&
      state.installation_complete
    ? state
    : null;
}

/** The verified onboarding plan is the signal map; no duplicate artifact is required. */
export function evaluateOnboardingReadiness(
  state: VerifiedOnboarding | null,
): OnboardingReadiness {
  if (!state) {
    return {
      verified: false,
      observed_events: [],
      all_approved_events_observed: false,
      safe_error_proved: false,
      exact_deploy_proved: false,
    };
  }
  const observedEvents = [...new Set(
    state.receipt.analytics
      .filter((row) => row.row_count > 0)
      .map((row) => row.event),
  )].sort();
  const approvedEvents = [...new Set(state.plan.milestones.map((row) => row.event))].sort();
  const allApprovedEventsObserved = approvedEvents.length === observedEvents.length &&
    approvedEvents.every((event, index) => event === observedEvents[index]);
  return {
    verified: state.evidence_status.source === "source_verified" &&
      state.receipt.evidence_status === "source_verified" &&
      allApprovedEventsObserved &&
      state.receipt.error.row_count > 0 &&
      state.receipt.deploy.row_count > 0,
    observed_events: observedEvents,
    all_approved_events_observed: allApprovedEventsObserved,
    safe_error_proved: state.receipt.error.row_count > 0,
    exact_deploy_proved: state.receipt.deploy.row_count > 0,
  };
}
