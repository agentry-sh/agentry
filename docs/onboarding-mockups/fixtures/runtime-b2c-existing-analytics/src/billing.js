const PAID_PLANS = new Set(["plus", "pro"]);

export function createCheckout({ userId, plan }) {
  if (!PAID_PLANS.has(plan)) {
    const error = new Error("invalid_plan");
    error.status = 400;
    throw error;
  }
  return {
    id: `checkout_${userId}_${plan}`,
    plan,
    url: `https://checkout.example.test/${userId}/${plan}`,
  };
}
