export function createCheckoutSession({ workspaceId, plan }) {
  if (!workspaceId) {
    throw new Error("workspace_id_required");
  }
  if (plan === "broken") {
    const error = new Error("stripe_checkout_unavailable");
    error.code = "stripe_down";
    throw error;
  }
  return {
    id: `cs_${workspaceId}_${Date.now()}`,
    plan,
    url: `https://billing.example.test/checkout/${workspaceId}`,
  };
}

export function applyStripeWebhook(store, payload) {
  const eventType = String(payload.type || "");
  const workspaceId = String(payload.workspace_id || "");
  if (!eventType || !workspaceId) {
    const error = new Error("invalid_webhook_payload");
    error.code = "invalid_webhook_payload";
    throw error;
  }
  const workspace = store.workspaces.get(workspaceId);
  if (!workspace) {
    const error = new Error("workspace_not_found");
    error.code = "workspace_not_found";
    throw error;
  }
  if (eventType === "customer.subscription.created") {
    workspace.plan = String(payload.plan || "pro");
    workspace.subscriptionStatus = "active";
    return { applied: true, subscription_status: workspace.subscriptionStatus };
  }
  if (eventType === "invoice.payment_failed") {
    workspace.subscriptionStatus = "past_due";
    return {
      applied: true,
      subscription_status: workspace.subscriptionStatus,
      decline_code: String(payload.decline_code || "generic_decline"),
    };
  }
  return { applied: false, ignored_type: eventType };
}
