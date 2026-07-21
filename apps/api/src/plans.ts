// Billing definitions for the hosted control plane. Customer telemetry lives in
// the customer's PostHog Cloud project, so plans never meter events or bundle
// inference. Retention applies only to Agentry's bounded local projections and
// control-plane evidence and is deliberately identical across plans.

export type PlanId = "free" | "nerve";

export interface PlanLimits {
  id: PlanId;
  name: string;
  // Retention window for bounded Agentry-owned projections and receipts. This
  // is not PostHog event retention and is not a pricing dimension.
  retentionDays: number;
  // Monthly price in USD cents. The first hosted contract is intentionally one
  // paid product rather than a ladder of storage tiers.
  priceCents: number;
  continuousAutomation: boolean;
}

export const PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    name: "Open source",
    retentionDays: 90,
    priceCents: 0,
    continuousAutomation: false,
  },
  nerve: {
    id: "nerve",
    name: "Nerve",
    retentionDays: 90,
    priceCents: 1_900,
    continuousAutomation: true,
  },
};

export const DEFAULT_PLAN: PlanId = "free";

export function planFor(planId: string | null | undefined): PlanLimits {
  if (planId === "nerve") return PLANS.nerve;
  return PLANS.free;
}

export function isValidPlanId(s: string): s is PlanId {
  return s === "free" || s === "nerve";
}
