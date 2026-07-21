import { AgentryError, constantTimeEqual, errors, toHex } from "@agentrysh/shared";
import { and, eq, sql } from "drizzle-orm";
import { projects, users, type User } from "@agentry/db/schema";
import { getDb } from "./db.js";
import { planFor, type PlanId, type PlanLimits } from "./plans.js";
import type { Env } from "./env.js";
import {
  AUTH_BILLING_SUCCESS_URL,
  PUBLIC_PRICING_URL,
} from "./public-links.js";

export type PaidPlanId = Exclude<PlanId, "free">;

export interface BillingAction {
  configured: boolean;
  recommended_plan: PaidPlanId | null;
  checkout: {
    method: "POST";
    path: "/v1/billing/checkout";
    body: { plan: PaidPlanId };
    returns: "checkout_url";
  } | null;
  portal: {
    method: "POST";
    path: "/v1/billing/portal";
    returns: "url";
  };
}

export interface AccountCheckoutLink {
  checkout_url: string;
  session_id: string;
  plan: PaidPlanId;
  price_id: string;
  customer_id: string;
  subscription_id: string | null;
}

export interface AccountBillingContext {
  plan: PlanLimits;
  upgrade: BillingAction;
}

export interface StripeCustomer {
  id: string;
  email?: string | null;
}

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer?: string | { id?: string } | null;
  subscription?: string | { id?: string } | null;
}

export interface StripePortalSession {
  id: string;
  url: string;
}

export function isBillingConfigured(env: Env, plan?: PaidPlanId | null): boolean {
  if (!env.STRIPE_SECRET_KEY) return false;
  if (plan) return Boolean(stripePriceIdFor(env, plan));
  return Boolean(env.STRIPE_PRICE_NERVE);
}

export function stripePriceIdFor(env: Env, _plan: PaidPlanId): string | null {
  return env.STRIPE_PRICE_NERVE ?? null;
}

export function planForStripePriceId(env: Env, priceId: string | null | undefined): PaidPlanId | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_NERVE) return "nerve";
  return null;
}

export function recommendedUpgradePlan(planId: string | null | undefined): PaidPlanId | null {
  return planId === "nerve" ? null : "nerve";
}

export function billingActionFor(
  env: Env,
  currentPlanId: string | null | undefined,
  recommendedPlan: PaidPlanId | null = recommendedUpgradePlan(currentPlanId),
): BillingAction {
  return {
    configured: isBillingConfigured(env, recommendedPlan),
    recommended_plan: recommendedPlan,
    checkout: recommendedPlan
      ? {
          method: "POST",
          path: "/v1/billing/checkout",
          body: { plan: recommendedPlan },
          returns: "checkout_url",
        }
      : null,
    portal: {
      method: "POST",
      path: "/v1/billing/portal",
      returns: "url",
    },
  };
}

export function accountBillingContext(
  env: Env,
  user: User,
): AccountBillingContext {
  const plan = planFor(user.plan);
  const upgrade = billingActionFor(env, plan.id, recommendedUpgradePlan(plan.id));
  return { plan, upgrade };
}

/**
 * Admission gate for hosted unattended automation. Reads, onboarding, manual
 * CLI workflows, and already-started settlement remain outside this gate.
 * Customer PostHog volume and customer-run inference never affect it.
 */
export async function requireNerveForProject(env: Env, projectId: string): Promise<void> {
  // A deployment without the Nerve price configured is self-hosted/open-source
  // and has no Agentry Cloud billing authority. Do not turn a missing Stripe
  // configuration into a remote feature lock.
  if (!env.STRIPE_PRICE_NERVE) return;
  const row = (
    await getDb(env)
      .select({ plan: users.plan })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.userId))
      .where(eq(projects.id, projectId))
      .limit(1)
  )[0];
  if (!row) throw errors.notFound("project");
  if (planFor(row.plan).id === "nerve") return;
  throw new AgentryError({
    status: 402,
    code: "nerve_required",
    message: "Continuous hosted automation requires the Nerve plan.",
    nextAction:
      "Keep using read-only PostHog analysis and manual CLI workflows, or have the owner call POST /v1/billing/checkout with {\"plan\":\"nerve\"} and a stable Idempotency-Key before enabling unattended automation.",
    details: {
      project_id: projectId,
      plan: "free",
      metered_by_events: false,
      bundled_inference: false,
    },
  });
}

export async function createAccountCheckoutLink(
  env: Env,
  user: User,
  requestedPlan: PaidPlanId,
  opts: {
    successUrl?: string | null;
    cancelUrl?: string | null;
    stripeCustomerIdempotencyKey: string;
    stripeSessionIdempotencyKey: string;
  },
): Promise<AccountCheckoutLink> {
  requireBillingConfigured(env, requestedPlan);
  const priceId = stripePriceIdFor(env, requestedPlan);
  if (!priceId) {
    throw errors.configurationMissing(
      "billing_price_not_configured",
      `Stripe price id for ${requestedPlan} is not configured.`,
      "Set STRIPE_PRICE_NERVE on the Agentry API Worker, redeploy, then retry POST /v1/billing/checkout.",
    );
  }

  const db = getDb(env);
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const latest = (await db
      .select({
        stripeCustomerId: users.stripeCustomerId,
        stripeSubscriptionId: users.stripeSubscriptionId,
        stripePriceId: users.stripePriceId,
        billingStatus: users.billingStatus,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1))[0];
    if (latest?.stripeCustomerId) {
      customerId = latest.stripeCustomerId;
      user.stripeCustomerId = latest.stripeCustomerId;
      user.stripeSubscriptionId = latest.stripeSubscriptionId;
      user.stripePriceId = latest.stripePriceId;
      user.billingStatus = latest.billingStatus;
    }
  }
  if (!customerId) {
    const customer = await createStripeCustomer(env, {
      userId: user.id,
      email: user.email,
    }, opts.stripeCustomerIdempotencyKey);
    customerId = customer.id;
    const persisted = await db
      .update(users)
      .set({
        stripeCustomerId: customerId,
        billingStatus: "customer_created",
      })
      .where(and(
        eq(users.id, user.id),
        sql`NOT EXISTS (
          SELECT 1 FROM account_deletion_fences
           WHERE user_id = ${user.id}
        )`,
      )).returning({ id: users.id });
    if (persisted.length !== 1) {
      throw errors.persistenceFailed(
        "The Stripe customer exists, but its account binding could not be persisted behind the billing fence.",
        "Retry this exact checkout request with the same Idempotency-Key. Agentry will send Stripe the same deterministic customer key and will not create a second customer.",
        { customer_id: customerId },
      );
    }
    user.stripeCustomerId = customerId;
    user.billingStatus = "customer_created";
  }

  const successUrl = opts.successUrl
    ?? env.BILLING_SUCCESS_URL
    ?? AUTH_BILLING_SUCCESS_URL;
  const cancelUrl = opts.cancelUrl
    ?? env.BILLING_CANCEL_URL
    ?? PUBLIC_PRICING_URL;

  const session = await createStripeCheckoutSession(env, {
    customerId,
    userId: user.id,
    plan: requestedPlan,
    priceId,
    successUrl,
    cancelUrl,
  }, opts.stripeSessionIdempotencyKey);
  if (!session.url) {
    throw new AgentryError({
      status: 502,
      code: "stripe_checkout_url_missing",
      message: "Stripe created a checkout session without a URL.",
      nextAction:
        "Retry POST /v1/billing/checkout. If it repeats, inspect Stripe Checkout configuration for this account.",
      details: { session_id: session.id },
    });
  }

  return {
    checkout_url: session.url,
    session_id: session.id,
    plan: requestedPlan,
    price_id: priceId,
    customer_id: customerId,
    subscription_id: stripeObjectId(session.subscription),
  };
}

export function requireBillingConfigured(env: Env, plan?: PaidPlanId | null): void {
  const missing = [
    ["STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY],
    ...(plan
      ? [["STRIPE_PRICE_NERVE", stripePriceIdFor(env, plan)]]
      : [["STRIPE_PRICE_NERVE", env.STRIPE_PRICE_NERVE]]),
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw errors.configurationMissing(
      "billing_not_configured",
      "Stripe billing is not configured on this Agentry deployment.",
      "Set STRIPE_SECRET_KEY and the requested plan's Stripe price id on the Agentry API Worker, redeploy, then retry the billing operation.",
      { missing },
    );
  }
}

export function requireStripeSecretConfigured(env: Env): void {
  if (!env.STRIPE_SECRET_KEY) {
    throw errors.configurationMissing(
      "billing_not_configured",
      "Stripe billing is not configured on this Agentry deployment.",
      "Set STRIPE_SECRET_KEY on the Agentry API Worker, redeploy, then retry the billing operation.",
      { missing: ["STRIPE_SECRET_KEY"] },
    );
  }
}

export function requireStripeWebhookConfigured(env: Env): string {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw errors.configurationMissing(
      "stripe_webhook_not_configured",
      "Stripe webhook signing secret is not configured on this Agentry deployment.",
      "Set STRIPE_WEBHOOK_SECRET on the Agentry API Worker, redeploy, then retry the Stripe webhook delivery.",
    );
  }
  return env.STRIPE_WEBHOOK_SECRET;
}

export async function createStripeCustomer(
  env: Env,
  opts: { userId: string; email: string | null },
  idempotencyKey: string,
): Promise<StripeCustomer> {
  return stripePost<StripeCustomer>(env, "/v1/customers", {
    ...(opts.email ? { email: opts.email } : {}),
    "metadata[user_id]": opts.userId,
    "metadata[agentry_user_id]": opts.userId,
  }, idempotencyKey);
}

export async function createStripeCheckoutSession(
  env: Env,
  opts: {
    customerId: string;
    userId: string;
    plan: PaidPlanId;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  },
  idempotencyKey: string,
): Promise<StripeCheckoutSession> {
  return stripePost<StripeCheckoutSession>(env, "/v1/checkout/sessions", {
    mode: "subscription",
    customer: opts.customerId,
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.userId,
    "line_items[0][price]": opts.priceId,
    "line_items[0][quantity]": 1,
    "metadata[user_id]": opts.userId,
    "metadata[plan]": opts.plan,
    "subscription_data[metadata][user_id]": opts.userId,
    "subscription_data[metadata][plan]": opts.plan,
  }, idempotencyKey);
}

export async function createStripePortalSession(
  env: Env,
  opts: { customerId: string; returnUrl: string },
  idempotencyKey: string,
): Promise<StripePortalSession> {
  return stripePost<StripePortalSession>(env, "/v1/billing_portal/sessions", {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  }, idempotencyKey);
}

export function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

export function paidPlanOrNull(value: unknown): PaidPlanId | null {
  return value === "nerve" ? value : null;
}

export function planMetadataFrom(value: unknown): PaidPlanId | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return paidPlanOrNull((value as { plan?: unknown }).plan);
}

export async function verifyStripeWebhookSignature(opts: {
  rawBody: string;
  signatureHeader: string | null | undefined;
  secret: string;
  nowSec?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  if (!opts.signatureHeader) return false;
  const parsed = parseStripeSignatureHeader(opts.signatureHeader);
  if (!parsed || parsed.signatures.length === 0) return false;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(nowSec - parsed.timestamp) > tolerance) return false;

  const expected = await hmacSha256Hex(opts.secret, `${parsed.timestamp}.${opts.rawBody}`);
  return parsed.signatures.some((sig) => constantTimeEqual(sig, expected));
}

function parseStripeSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (!key || !value) continue;
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) timestamp = n;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  return timestamp === null ? null : { timestamp, signatures };
}

async function stripePost<T>(
  env: Env,
  path: `/v1/${string}`,
  params: Record<string, string | number | boolean | null | undefined>,
  idempotencyKey: string,
): Promise<T> {
  requireStripeSecretConfigured(env);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) form.set(key, String(value));
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10_000);
  let res: Response;
  let body: string;
  try {
    res = await fetch(`https://api.stripe.com${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": "2024-06-20",
        "idempotency-key": idempotencyKey,
        "user-agent": "agentry-billing/1",
      },
      body: form.toString(),
      signal: controller.signal,
    });
    body = await readBoundedStripeBody(res, controller, 65_536);
  } catch (error) {
    if (error instanceof AgentryError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AgentryError({
      status: 502,
      code: timedOut ? "stripe_request_timeout" : "stripe_upstream_failed",
      message: timedOut
        ? `Stripe request ${path} exceeded the 10000ms deadline.`
        : `Stripe request ${path} did not return a complete response.`,
      nextAction:
        "Retry this exact billing request with the same Agentry Idempotency-Key. Agentry will forward the same deterministic Stripe key, so a lost provider response cannot create a duplicate customer or session.",
      details: { operation: path, cause: message.slice(0, 500), outcome: "indeterminate" },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const upstreamError = new AgentryError({
      status: res.status >= 500 ? 502 : 424,
      code: "stripe_upstream_failed",
      message: `Stripe request ${path} failed with status ${res.status}.`,
      nextAction:
        "Check the Stripe secret key, price ids, and account mode for this Agentry deployment, then retry the billing operation.",
      details: {
        operation: path,
        upstream_status: res.status,
        body_excerpt: body.slice(0, 500),
      },
    });
    if (res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status)) {
      Object.defineProperty(upstreamError, DEFINITE_STRIPE_REJECTION, { value: true });
    }
    throw upstreamError;
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new AgentryError({
      status: 502,
      code: "stripe_invalid_response",
      message: `Stripe request ${path} returned a successful but invalid JSON body.`,
      nextAction:
        "Retry this exact billing request with the same Agentry Idempotency-Key so Stripe returns the same customer or session, then inspect provider health if parsing still fails.",
      details: { operation: path, outcome: "indeterminate" },
    });
  }
}

const DEFINITE_STRIPE_REJECTION = Symbol("agentry.definite-stripe-rejection");

export function stripeFailureIsDefinite(error: unknown): boolean {
  return error instanceof AgentryError &&
    (error as AgentryError & { [DEFINITE_STRIPE_REJECTION]?: boolean })[DEFINITE_STRIPE_REJECTION] === true;
}

async function readBoundedStripeBody(
  response: Response,
  controller: AbortController,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    total += next.value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      throw new AgentryError({
        status: 502,
        code: "stripe_response_too_large",
        message: `Stripe response exceeded the ${maxBytes}-byte limit.`,
        nextAction:
          "Treat the provider result as indeterminate and retry this exact billing request with the same Idempotency-Key.",
        details: { max_bytes: maxBytes, outcome: "indeterminate" },
      });
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(new Uint8Array(sig));
}
