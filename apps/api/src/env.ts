import type { ApiKey, User } from "@agentry/db/schema";
import type { ProjectCredentialPrincipal } from "./project-credential-auth.js";

export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  TURSO_DATABASE_URL: string;
  TURSO_AUTH_TOKEN: string;
  // Operator-controlled, fail-closed gate for core database maintenance.
  // Absent or the exact value "off" leaves traffic enabled. Any other value
  // pauses HTTP and scheduled work before Hono, telemetry, or database access.
  AGENTRY_CORE_DB_MAINTENANCE?: string;
  // PostHog Cloud OAuth (customer-owned data plane). The defaults are the
  // canonical api.agentry.sh CIMD document and callback; local/test deployments
  // override both so the exact redirect remains explicit.
  POSTHOG_OAUTH_CLIENT_ID?: string;
  POSTHOG_OAUTH_REDIRECT_URI?: string;
  AUTH_START_RATE_LIMITER?: RateLimitBinding;
  AUTH_POLL_RATE_LIMITER?: RateLimitBinding;
  // 32-byte base64url AES-256 key for PostHog OAuth tokens and other
  // recoverable control-plane secrets. Application telemetry credentials are
  // customer-owned and never enter this environment.
  AGENTRY_TOKEN_ENC_KEY?: string;
  // Body / scan caps
  MAX_BODY_BYTES?: string;
  INSTALL_PLAN_RATE_LIMIT_PER_MINUTE?: string;
  // Test backdoor — only enabled in local dev. Production secret store must NOT set this.
  ENABLE_TEST_LOGIN?: string;
  // Admin token gating /admin/* endpoints. If unset, admin routes refuse all
  // requests. Compared against the Authorization: Bearer header via constant-time
  // comparison. Set with `wrangler secret put ADMIN_TOKEN`.
  ADMIN_TOKEN?: string;
  // Stripe billing. Webhook secret is required for plan updates.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_NERVE?: string;
  BILLING_SUCCESS_URL?: string;
  BILLING_CANCEL_URL?: string;
  BILLING_PORTAL_RETURN_URL?: string;
  AGENTRY_URL?: string;
  AGENTRY_DEPLOY_SHA?: string;
  AGENTRY_ENVIRONMENT?: string;
  AGENTRY_ONBOARDING_PROOF?: string;
}

// Hono context variable map.
export interface AppVariables {
  user: User;
  apiKey: ApiKey;
  projectCredential: ProjectCredentialPrincipal | null;
  requestId: string;
  endpointErrorCode?: string;
}

export type AppBindings = { Bindings: Env; Variables: AppVariables };
