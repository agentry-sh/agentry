/**
 * Executable policy inventory for every registered non-GET route.
 *
 * This is intentionally explicit rather than a permissive fallback: the drift
 * test compares it with Hono's runtime route table, so a new mutation cannot
 * ship without choosing a stream limit and an honest retry contract.
 */

export type RequestBodyPolicy =
  | { kind: "none"; max_bytes: 0 }
  | { kind: "json"; max_bytes: number; optional_empty?: boolean }
  | { kind: "raw"; max_bytes: number };

export type RetryPolicyKind =
  | "idempotency_key"
  | "external_audit_saga"
  | "natural_resource_key"
  | "monotonic_state_machine"
  | "safe_read_post"
  | "conditional_event_key"
  | "at_least_once"
  | "ephemeral_non_idempotent";

export type MutationRoutePolicy = {
  body: RequestBodyPolicy;
  retry: {
    kind: RetryPolicyKind;
    rationale: string;
    idempotency_key_required: boolean;
  };
};

const none = { kind: "none", max_bytes: 0 } as const;
const json = (max_bytes: number, optional_empty = false): RequestBodyPolicy => ({
  kind: "json",
  max_bytes,
  ...(optional_empty ? { optional_empty: true } : {}),
});
const raw = (max_bytes: number): RequestBodyPolicy => ({ kind: "raw", max_bytes });
const policy = (
  body: RequestBodyPolicy,
  kind: RetryPolicyKind,
  rationale: string,
): MutationRoutePolicy => ({
  body,
  retry: {
    kind,
    rationale,
    idempotency_key_required: kind === "idempotency_key" || kind === "external_audit_saga",
  },
});

const exact = "A durable command binds actor, scope, action, key, and canonical evidence; exact replay returns the original receipt.";
const natural = "The target resource or one-time token is the replay key; repeating the same desired transition cannot create a second resource.";
const state = "Lease, revision, sequence, action-token, or transition compare-and-set makes repeated evidence monotonic without creating a second effect.";
const safeRead = "POST is used for bounded query/validation input; the operation does not mutate authoritative customer state.";

export const MUTATION_ROUTE_POLICIES: Readonly<Record<string, MutationRoutePolicy>> = {
  // Destructive/resource-addressed operations.
  "DELETE /v1/projects/:id": policy(none, "idempotency_key", exact),
  "DELETE /v1/projects/:project_id/alerts/:id": policy(none, "natural_resource_key", natural),
  "DELETE /v1/projects/:project_id/public-queries/:publication_id": policy(none, "idempotency_key", exact),
  "DELETE /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease": policy(json(16_384), "monotonic_state_machine", state),
  "DELETE /v1/projects/:project_id/webhooks/:id": policy(none, "natural_resource_key", natural),
  "DELETE /v1/projects/:project_id/posthog-connection": policy(none, "natural_resource_key", "The single project connection is detached locally once; retries cannot delete or mutate customer-owned PostHog data."),

  // Desired-state and compare-and-set PATCH operations.
  "PATCH /admin/users/:user_id/plan": policy(json(4_096), "natural_resource_key", "The requested plan is desired state; setting it again is a no-op."),
  "PATCH /v1/automation-runs/:run_id": policy(json(262_144), "monotonic_state_machine", state),
  "PATCH /v1/cases/:case_id": policy(json(262_144), "idempotency_key", exact),
  "PATCH /v1/projects/:id/automation-contract/automations/:automation_id": policy(json(262_144), "monotonic_state_machine", state),

  // Operator/auth surfaces.
  "POST /admin/retention/sweep": policy(none, "natural_resource_key", "Retention deletes only rows already beyond their fixed cutoff; a repeat resumes bounded inventory."),
  "POST /v1/auth/_test/login": policy(json(8_192), "ephemeral_non_idempotent", "Local-test-only login intentionally mints a fresh disposable key and is absent from the production contract."),
  "POST /v1/auth/posthog": policy(json(4_096), "ephemeral_non_idempotent", "Each start creates one short-lived PostHog OIDC, read-only consent, PKCE, nonce, and opaque poll transaction."),
  "POST /v1/auth/posthog/poll": policy(json(4_096), "monotonic_state_machine", "The opaque poll token plus the one-time browser handoff proof can mint one owner key and one authorization_id only after the verified callback settles."),
  "POST /v1/auth/keys/:key_id/revoke": policy(json(8_192), "idempotency_key", exact),
  "POST /v1/auth/keys/rotate": policy(none, "idempotency_key", exact),
  "POST /v1/auth/self_delete": policy(json(4_096), "idempotency_key", exact),

  // Automation state machine.
  "POST /v1/automation-approvals/:approval_id/decide": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/automation-runs/:run_id/actions/draft-pr/authorize": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/automation-runs/:run_id/actions/draft-pr/consume": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/automation-runs/:run_id/actions/record-report": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/automation-runs/:run_id/approvals": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/automation-runs/:run_id/cancel": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/automation-runs/:run_id/pr-proof": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/automation-runs/:run_id/report-source": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/automation-runs/:run_id/usage": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/automation-runs/:run_id/verify": policy(none, "monotonic_state_machine", state),

  // Billing owns its own account-serialized provider saga.
  "POST /v1/billing/checkout": policy(json(16_384, true), "idempotency_key", exact),
  "POST /v1/billing/portal": policy(json(16_384, true), "idempotency_key", exact),
  "POST /v1/billing/webhook": policy(raw(262_144), "natural_resource_key", "Stripe event id plus payload hash is durable; subscription cursors reject stale reordering."),

  // Case, signal, and read operations.
  "POST /v1/cases/:case_id/claims": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/cases/:case_id/claims/:claim_id/release": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/cases/:case_id/claims/:claim_id/renew": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/deploys/": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/projects/:project_id/analytics/query": policy(json(16_384), "safe_read_post", safeRead),
  "POST /v1/projects/:project_id/query-blueprints/:blueprint_id/run": policy(json(65_536, true), "safe_read_post", safeRead),

  // Local owner resources.
  "POST /v1/feedback": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/project-credentials/:credential_id/revoke": policy(json(8_192), "idempotency_key", exact),
  "POST /v1/projects": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:id/automation-contract/enable": policy(none, "monotonic_state_machine", state),
  "POST /v1/projects/:id/automation-contract/pause": policy(json(262_144), "monotonic_state_machine", state),
  "POST /v1/projects/:id/automation-contract/validate": policy(json(262_144), "safe_read_post", safeRead),
  "POST /v1/projects/:project_id/alerts": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/alerts/:id/evaluate": policy(none, "monotonic_state_machine", "Alert state transition and deterministic webhook source identity commit atomically; repeated steady-state evaluation emits nothing."),
  "POST /v1/projects/:project_id/automation-playbooks/:id/render": policy(json(65_536), "safe_read_post", safeRead),
  "POST /v1/projects/:project_id/automation-workflow-control/pause": policy(json(16_384), "monotonic_state_machine", "The project kill switch is desired state; replaying the same bounded reason returns the existing pause receipt."),
  "POST /v1/projects/:project_id/automation-workflow-control/resume": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/enable": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/pause": policy(json(16_384), "monotonic_state_machine", "The workflow kill switch is desired state; replaying the same bounded reason returns the existing pause receipt."),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/trigger-receipts/issue": policy(json(16_384), "monotonic_state_machine", "The server-derived trigger occurrence and attempt ledger are the natural replay boundary; callers cannot submit trigger facts."),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease": policy(json(16_384), "monotonic_state_machine", state),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/lease/renew": policy(json(16_384), "monotonic_state_machine", state),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/commands": policy(json(262_144), "monotonic_state_machine", "Stable command_id plus expected_revision and an optional fenced lease bind one logical runtime transition; exact replay returns the durable command receipt."),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/cancel": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/advance": policy(json(16_384), "monotonic_state_machine", "Only deterministic Agentry-owned nodes advance; persisted command identities make response-loss replay monotonic until the runtime yields."),
  "POST /v1/projects/:project_id/automation-workflows/:automation_id/runs/:run_id/effects/:effect_id/reconcile": policy(json(262_144), "idempotency_key", "Trusted CI binds one immutable provider lookup and outcome to the effect intent; exact replay returns the original reconciliation receipt without authorizing a provider call."),
  "POST /v1/projects/:project_id/automation-workflows/compile": policy(json(1_048_576), "safe_read_post", safeRead),
  "POST /v1/projects/:project_id/automation-runs": policy(json(262_144), "idempotency_key", exact),
  "POST /v1/projects/:project_id/automation-triggers/issue": policy(json(16_384), "monotonic_state_machine", state),
  "POST /v1/projects/:project_id/credentials": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/public-queries": policy(json(65_536), "idempotency_key", exact),
  "POST /v1/projects/:project_id/posthog-connection": policy(json(4_096), "ephemeral_non_idempotent", "Connect mints a fresh short-lived OAuth state, PKCE verifier, and nonce; claim atomically moves one already-polled encrypted grant into the single project connection."),
  "POST /v1/projects/:project_id/webhook-deliveries/:delivery_id/replay": policy(none, "natural_resource_key", "The preserved delivery id and delivery state prevent a second logical delivery identity."),
  "POST /v1/projects/:project_id/webhooks": policy(json(16_384), "idempotency_key", exact),
  "POST /v1/projects/:project_id/webhooks/:id/test": policy(none, "idempotency_key", exact),

  // One plan, one approval, one short-lived proof session, one verification.
  "POST /v1/projects/:project_id/onboarding": policy(json(524_288), "monotonic_state_machine", "The exact plan body and current ETag create or replace one project onboarding state; exact replay returns the current matching plan."),
  "POST /v1/projects/:project_id/onboarding/review": policy(json(524_288), "monotonic_state_machine", "The current ETag and exact plan hash bind the human approval or replacement."),
  "POST /v1/projects/:project_id/onboarding/proof": policy(json(4_096), "ephemeral_non_idempotent", "A proof start intentionally revokes any prior marker pair and returns fresh one-time runtime and CI markers; state CAS prevents scope drift."),
  "POST /v1/projects/:project_id/onboarding/verify": policy(none, "monotonic_state_machine", "Incomplete verification is read-only; a green receipt and proof completion commit atomically under the proving-state ETag."),
  // Idempotent desired-state PUTs.
  "PUT /v1/projects/:id/automation-contract": policy(json(262_144), "monotonic_state_machine", state),
  "PUT /v1/projects/:project_id/automation-workflows/:automation_id": policy(json(1_048_576), "monotonic_state_machine", state),
};

export type MutationRecoveryInventoryItem = {
  method: string;
  path: string;
  operation: string;
  retry_kind: "idempotency_key" | "external_audit_saga";
  idempotency_key_required: true;
  request_body: RequestBodyPolicy;
  rationale: string;
  openapi_filter: string;
};

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/**
 * Agent-facing recovery inventory derived from the same executable policy that
 * decorates OpenAPI and is drift-checked against Hono's runtime route table.
 * Never hand-maintain a second subset in docs or capabilities.
 */
export function mutationRecoveryInventory(): MutationRecoveryInventoryItem[] {
  return Object.entries(MUTATION_ROUTE_POLICIES)
    .filter(([, value]) => value.retry.idempotency_key_required)
    .map(([operation, value]) => {
      const separator = operation.indexOf(" ");
      const method = operation.slice(0, separator);
      const path = openApiPath(operation.slice(separator + 1));
      return {
        method,
        path,
        operation: `${method} ${path}`,
        retry_kind: value.retry.kind as "idempotency_key" | "external_audit_saga",
        idempotency_key_required: true as const,
        request_body: value.body,
        rationale: value.retry.rationale,
        openapi_filter: `/v1/openapi.json?path=${encodeURIComponent(path)}&method=${method.toLowerCase()}`,
      };
    })
    .sort((left, right) => left.operation.localeCompare(right.operation));
}

function routeShape(path: string): string {
  return path.replace(/:[^/]+|\{[^}/]+\}/g, ":param");
}

export function mutationRoutePolicyFor(
  method: string,
  path: string,
): MutationRoutePolicy | undefined {
  const exactKey = `${method.toUpperCase()} ${path}`;
  const exactPolicy = MUTATION_ROUTE_POLICIES[exactKey];
  if (exactPolicy) return exactPolicy;
  const shape = routeShape(path);
  const match = Object.entries(MUTATION_ROUTE_POLICIES).find(([key]) => {
    const separator = key.indexOf(" ");
    return key.slice(0, separator) === method.toUpperCase() &&
      routeShape(key.slice(separator + 1)) === shape;
  });
  return match?.[1];
}

export function mutationRoutePolicyExtension(policy: MutationRoutePolicy) {
  return {
    "x-agentry-request-body-policy": policy.body,
    "x-agentry-retry-policy": policy.retry,
  };
}
