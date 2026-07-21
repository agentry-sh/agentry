export const AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS = 86_400;

/** Enforcement includes charges exactly at asOf - 24h. */
export function automationBudgetWindowStart(asOf: number): number {
  return asOf - AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS;
}

/**
 * When used >= limit, this is the ascending zero-based charge whose expiry
 * makes count < limit. A zero limit is policy-blocked and has no time-based
 * availability.
 */
export function automationBudgetReleaseIndex(used: number, limit: number): number | null {
  if (limit <= 0 || used < limit) return null;
  return used - limit;
}

/** The enforcement window is inclusive, so availability starts one second later. */
export function automationBudgetAvailableAt(chargeCreatedAt: number): number {
  return chargeCreatedAt + AUTOMATION_ROLLING_BUDGET_WINDOW_SECONDS + 1;
}
