import { Hono, type Context } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { AgentryError, canonicalJsonStringify, errors, sha256Hex } from "@agentrysh/shared";
import {
  accountDeletionFences,
  billingSubscriptionCursors,
  billingWebhookEvents,
  users,
} from "@agentry/db/schema";
import {
  accountBillingContext,
  createAccountCheckoutLink,
  createStripePortalSession,
  paidPlanOrNull,
  planForStripePriceId,
  planMetadataFrom,
  requireStripeSecretConfigured,
  requireStripeWebhookConfigured,
  requireBillingConfigured,
  stripeObjectId,
  stripePriceIdFor,
  stripeFailureIsDefinite,
  verifyStripeWebhookSignature,
} from "../billing.js";
import { getDb } from "../db.js";
import { invalidateUserAuthCache, requireApiKey } from "../middleware.js";
import { planFor, type PlanId } from "../plans.js";
import type { AppBindings, Env } from "../env.js";
import type { User } from "@agentry/db/schema";
import {
  billingMutationBusyBody,
  completeBillingMutation,
  recordBillingMutationFailure,
  requireBillingSecretRecoveryConfigured,
  reserveBillingMutation,
} from "../billing-mutation-boundary.js";
import { readBoundedBytes, readOptionalBoundedJson } from "../bounded-json.js";
import {
  AUTH_BILLING_SUCCESS_URL,
  PUBLIC_PRICING_URL,
  PUBLIC_REPOSITORY_URL,
} from "../public-links.js";

const router = new Hono<AppBindings>();

const ACTIVE_STRIPE_STATUSES = new Set(["active", "trialing", "past_due"]);
const DOWNGRADE_STRIPE_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired"]);

router.post("/v1/billing/webhook", async (c) => {
  const rawBody = await readBoundedWebhookBody(c, 256 * 1024);
  const secret = requireStripeWebhookConfigured(c.env);
  const valid = await verifyStripeWebhookSignature({
    rawBody,
    signatureHeader: c.req.header("stripe-signature"),
    secret,
  });
  if (!valid) {
    throw new AgentryError({
      status: 401,
      code: "invalid_stripe_signature",
      message: "Stripe webhook signature verification failed.",
      nextAction:
        "Verify the webhook endpoint uses the STRIPE_WEBHOOK_SECRET configured on this Agentry deployment, then retry the Stripe delivery.",
    });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw errors.invalidPayload({ reason: "body is not valid JSON" });
  }
  if (
    typeof event.id !== "string" || event.id.length === 0 || event.id.length > 255 ||
    typeof event.type !== "string" || event.type.length === 0 || event.type.length > 255 ||
    typeof event.created !== "number" || !Number.isInteger(event.created) || event.created < 0
  ) {
    throw errors.invalidPayload({
      reason: "Stripe webhook requires bounded string id/type and nonnegative integer created",
    });
  }

  const result = await handleStripeEvent(c.env, event, await sha256Hex(rawBody));
  return c.json({
    received: true,
    event_id: typeof event.id === "string" ? event.id : null,
    event_type: typeof event.type === "string" ? event.type : null,
    handled: result.handled,
    user_id: result.user_id,
    plan: result.plan,
    billing_status: result.billing_status,
    applied: result.applied,
    delivery_status: result.delivery_status,
    idempotent_replay: result.idempotent_replay,
    next_action: result.next_action,
  });
});

router.get("/v1/billing/status", requireApiKey(), async (c) => {
  const user = c.get("user") as User;
  const { plan, upgrade } = accountBillingContext(c.env, user);

  return c.json({
    user_id: user.id,
    plan: plan.id,
    plan_name: plan.name,
    price_cents: plan.priceCents,
    continuous_automation_enabled: plan.continuousAutomation,
    evidence_retention_days: plan.retentionDays,
    billing: serializeBillingUser(user),
    upgrade,
    next_action: upgrade.checkout
      ? upgrade.configured
        ? `Call POST /v1/billing/checkout with ${JSON.stringify(upgrade.checkout.body)} and a stable Idempotency-Key when the owner chooses continuous automation.`
        : "Nerve checkout is unavailable on this deployment. Configure STRIPE_SECRET_KEY and STRIPE_PRICE_NERVE, redeploy, and retry."
      : "Nerve is active. Use the billing portal to manage payment or cancellation.",
  });
});

router.post("/v1/billing/checkout", requireApiKey(), async (c) => {
  const user = c.get("user") as User;
  requireBillingSecretRecoveryConfigured(c.env);
  const body = await readOptionalJsonObject(c);
  const requestedPlan = paidPlanOrNull(body.plan);
  if (!requestedPlan) {
    throw errors.invalidPayload({ reason: "plan must be: nerve" });
  }
  const successUrl = readUrl(body.success_url, "success_url")
    ?? null;
  const cancelUrl = readUrl(body.cancel_url, "cancel_url")
    ?? null;
  requireBillingConfigured(c.env, requestedPlan);
  const priceId = stripePriceIdFor(c.env, requestedPlan);
  if (!priceId) throw new Error("billing price disappeared after configuration check");
  const resolvedSuccessUrl = successUrl
    ?? c.env.BILLING_SUCCESS_URL
    ?? AUTH_BILLING_SUCCESS_URL;
  const resolvedCancelUrl = cancelUrl
    ?? c.env.BILLING_CANCEL_URL
    ?? PUBLIC_PRICING_URL;
  const requestEvidence = {
    user_id: user.id,
    plan: requestedPlan,
    price_id: priceId,
    success_url: resolvedSuccessUrl,
    cancel_url: resolvedCancelUrl,
  };
  const target = {
    user_id: user.id,
    plan: requestedPlan,
    price_id: priceId,
    success_url: await safeBillingUrlTarget(resolvedSuccessUrl),
    cancel_url: await safeBillingUrlTarget(resolvedCancelUrl),
  };
  const reservation = await reserveBillingMutation(c, {
    operation: "checkout",
    request: requestEvidence,
    target,
  });
  if (reservation.state === "replay") return c.json(reservation.response);
  if (reservation.state === "failed") throw reservation.error;
  if (reservation.state === "busy") {
    const progress = billingMutationBusyBody(reservation);
    c.header("Retry-After", String(progress.retry_after_seconds));
    return c.json(progress, 202);
  }

  let checkout: Awaited<ReturnType<typeof createAccountCheckoutLink>>;
  try {
    checkout = await createAccountCheckoutLink(c.env, user, requestedPlan, {
      successUrl: resolvedSuccessUrl,
      cancelUrl: resolvedCancelUrl,
      stripeCustomerIdempotencyKey:
        reservation.lease.target.stripeCustomerIdempotencyKey!,
      stripeSessionIdempotencyKey:
        reservation.lease.target.stripeSessionIdempotencyKey,
    });
  } catch (error) {
    await recordBillingMutationFailure(
      c,
      reservation.lease,
      error,
      stripeFailureIsDefinite(error),
    );
    throw error;
  }
  const publicResponse = {
    command_id: reservation.lease.command.id,
    session_id: checkout.session_id,
    customer_id: checkout.customer_id,
    subscription_id: checkout.subscription_id,
    plan: requestedPlan,
    price_id: checkout.price_id,
    idempotent_replay: false,
    next_action:
      "Show checkout_url to the owner. After Stripe completes payment, the signed webhook activates Nerve automatically.",
  };
  try {
    await completeBillingMutation(c, reservation.lease, publicResponse, {
      secretResponse: { checkout_url: checkout.checkout_url },
      userPatch: {
        stripeCustomerId: checkout.customer_id,
        stripeSubscriptionId: checkout.subscription_id ?? user.stripeSubscriptionId,
        stripePriceId: checkout.price_id,
        billingStatus: "checkout_started",
      },
    });
  } catch {
    throw errors.persistenceFailed(
      "Stripe returned a checkout session, but Agentry could not durably finalize its encrypted receipt.",
      "Retry this exact request with the same Idempotency-Key after the lease expires. Agentry will reuse the same Stripe keys and recover the same session; do not start a new checkout.",
      { command_id: reservation.lease.command.id, session_id: checkout.session_id },
    );
  }
  invalidateUserAuthCache(user.id);

  return c.json({
    ...publicResponse,
    checkout_url: checkout.checkout_url,
  });
});

router.post("/v1/billing/portal", requireApiKey(), async (c) => {
  requireStripeSecretConfigured(c.env);
  requireBillingSecretRecoveryConfigured(c.env);
  const user = c.get("user") as User;
  if (!user.stripeCustomerId) {
    throw new AgentryError({
      status: 409,
      code: "billing_customer_missing",
      message: "This account does not have a Stripe customer yet.",
      nextAction:
        "Call POST /v1/billing/checkout with {\"plan\":\"nerve\"}; after checkout starts, retry POST /v1/billing/portal.",
    });
  }
  const body = await readOptionalJsonObject(c);
  const returnUrl = readUrl(body.return_url, "return_url")
    ?? c.env.BILLING_PORTAL_RETURN_URL
    ?? PUBLIC_REPOSITORY_URL;
  const requestEvidence = {
    user_id: user.id,
    customer_id: user.stripeCustomerId,
    return_url: returnUrl,
  };
  const target = {
    user_id: user.id,
    customer_id: user.stripeCustomerId,
    return_url: await safeBillingUrlTarget(returnUrl),
  };
  const reservation = await reserveBillingMutation(c, {
    operation: "portal",
    request: requestEvidence,
    target,
  });
  if (reservation.state === "replay") return c.json(reservation.response);
  if (reservation.state === "failed") throw reservation.error;
  if (reservation.state === "busy") {
    const progress = billingMutationBusyBody(reservation);
    c.header("Retry-After", String(progress.retry_after_seconds));
    return c.json(progress, 202);
  }
  let session: Awaited<ReturnType<typeof createStripePortalSession>>;
  try {
    session = await createStripePortalSession(c.env, {
      customerId: user.stripeCustomerId,
      returnUrl,
    }, reservation.lease.target.stripeSessionIdempotencyKey);
    if (!session.id || !session.url) {
      throw new AgentryError({
        status: 502,
        code: "stripe_portal_url_missing",
        message: "Stripe returned a billing portal session without an id or URL.",
        nextAction:
          "Retry this exact request with the same Idempotency-Key so Stripe returns the same portal session.",
        details: { command_id: reservation.lease.command.id, outcome: "indeterminate" },
      });
    }
  } catch (error) {
    await recordBillingMutationFailure(
      c,
      reservation.lease,
      error,
      stripeFailureIsDefinite(error),
    );
    throw error;
  }
  const publicResponse = {
    command_id: reservation.lease.command.id,
    session_id: session.id,
    customer_id: user.stripeCustomerId,
    idempotent_replay: false,
    next_action:
      "Open url for the user to manage payment method, invoices, cancellation, and plan changes in Stripe's customer portal.",
  };
  try {
    await completeBillingMutation(c, reservation.lease, publicResponse, {
      secretResponse: { url: session.url },
    });
  } catch {
    throw errors.persistenceFailed(
      "Stripe returned a portal session, but Agentry could not durably finalize its encrypted receipt.",
      "Retry this exact request with the same Idempotency-Key after the lease expires. Agentry will recover the same portal session; do not create one with a new key.",
      { command_id: reservation.lease.command.id, session_id: session.id },
    );
  }
  return c.json({
    ...publicResponse,
    url: session.url,
  });
});

export default router;

type UserBillingUpdate = Partial<typeof users.$inferInsert>;

interface StripeEvent {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: unknown };
}

interface StripeEventResult {
  handled: boolean;
  applied: boolean;
  delivery_status: "applied" | "stale" | "ambiguous_order" | "account_deletion_fenced" | "unmatched" | "unhandled";
  idempotent_replay: boolean;
  user_id: string | null;
  plan: PlanId | null;
  billing_status: string | null;
  next_action: string;
}

interface PreparedStripeMutation {
  recognized: boolean;
  objectId: string | null;
  subscriptionId: string | null;
  match: { userId: string | null; customerId: string | null; subscriptionId: string | null };
  patch: UserBillingUpdate;
  plan: PlanId | null;
  billingStatus: string | null;
  reason: string;
}

async function handleStripeEvent(
  env: Env,
  event: StripeEvent,
  payloadHash: string,
): Promise<StripeEventResult> {
  const eventId = event.id as string;
  const eventType = event.type as string;
  const providerCreated = event.created as number;
  const db = getDb(env);
  const existing = (
    await db.select().from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.eventId, eventId)).limit(1)
  )[0];
  if (existing) {
    if (
      existing.payloadHash !== payloadHash ||
      existing.eventType !== eventType ||
      existing.providerCreated !== providerCreated
    ) {
      throw errors.conflict(
        "stripe_event_id_reused",
        "This Stripe event id was already received with different evidence.",
        "Reject the delivery and inspect Stripe webhook integrity. Never overwrite the original event receipt.",
        { event_id: eventId },
      );
    }
    return { ...parseStripeEventResult(existing.resultJson), idempotent_replay: true };
  }

  const prepared = prepareStripeMutation(env, eventType, event.data?.object);
  const result = await db.transaction(async (tx) => {
    const winner = (
      await tx.select().from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.eventId, eventId)).limit(1)
    )[0];
    if (winner) {
      if (
        winner.payloadHash !== payloadHash ||
        winner.eventType !== eventType ||
        winner.providerCreated !== providerCreated
      ) throw new Error("Stripe webhook replay evidence mismatch");
      return { ...parseStripeEventResult(winner.resultJson), idempotent_replay: true };
    }

    if (!prepared.recognized) {
      const unhandled: StripeEventResult = {
        handled: false,
        applied: false,
        delivery_status: "unhandled",
        idempotent_replay: false,
        user_id: null,
        plan: null,
        billing_status: prepared.billingStatus,
        next_action: `Webhook received, but no billing state changed: ${prepared.reason}.`,
      };
      await insertStripeWebhookReceipt(tx as unknown as ReturnType<typeof getDb>, {
        eventId,
        payloadHash,
        eventType,
        providerCreated,
        prepared,
        user: null,
        status: "unhandled",
        result: unhandled,
      });
      return unhandled;
    }

    const matchedUser = await findBillingUser(
      tx as unknown as ReturnType<typeof getDb>,
      prepared.match,
    );
    if (!matchedUser) {
      const unmatched: StripeEventResult = {
        handled: false,
        applied: false,
        delivery_status: "unmatched",
        idempotent_replay: false,
        user_id: null,
        plan: prepared.plan,
        billing_status: prepared.billingStatus,
        next_action:
          "Stripe event was durably recorded but could not be matched to an account. Ensure checkout/subscription metadata[user_id] is present and the customer id is bound before retrying provider reconciliation.",
      };
      await insertStripeWebhookReceipt(tx as unknown as ReturnType<typeof getDb>, {
        eventId,
        payloadHash,
        eventType,
        providerCreated,
        prepared,
        user: null,
        status: "unmatched",
        result: unmatched,
      });
      return unmatched;
    }

    const cursor = prepared.subscriptionId
      ? (
          await tx.select().from(billingSubscriptionCursors)
            .where(eq(billingSubscriptionCursors.subscriptionId, prepared.subscriptionId)).limit(1)
        )[0] ?? null
      : null;
    if (cursor && providerCreated < cursor.lastEventCreated) {
      const stale: StripeEventResult = {
        handled: true,
        applied: false,
        delivery_status: "stale",
        idempotent_replay: false,
        user_id: matchedUser.id,
        plan: planFor(matchedUser.plan).id,
        billing_status: matchedUser.billingStatus,
        next_action:
          "This older Stripe delivery was durably deduplicated and did not roll billing state backward. No retry is needed.",
      };
      await insertStripeWebhookReceipt(tx as unknown as ReturnType<typeof getDb>, {
        eventId,
        payloadHash,
        eventType,
        providerCreated,
        prepared,
        user: matchedUser,
        status: "stale",
        result: stale,
      });
      return stale;
    }
    if (cursor && providerCreated === cursor.lastEventCreated) {
      // Stripe event ids are opaque replay ids, not temporal sequence numbers.
      // Two different events in the same provider-created second therefore
      // have no safe automatic ordering. Preserve both receipts, retain the
      // already-applied state, and require a later provider snapshot/event.
      const ambiguous: StripeEventResult = {
        handled: true,
        applied: false,
        delivery_status: "ambiguous_order",
        idempotent_replay: false,
        user_id: matchedUser.id,
        plan: planFor(matchedUser.plan).id,
        billing_status: matchedUser.billingStatus,
        next_action:
          `Stripe delivered a different event for subscription ${prepared.subscriptionId} in the same created second as ${cursor.lastEventId}. Agentry did not guess their order. Inspect the current subscription in Stripe, then replay a newer signed subscription event (created > ${cursor.lastEventCreated}) before relying on local billing state or deleting the account.`,
      };
      await insertStripeWebhookReceipt(tx as unknown as ReturnType<typeof getDb>, {
        eventId,
        payloadHash,
        eventType,
        providerCreated,
        prepared,
        user: matchedUser,
        status: "ambiguous_order",
        result: ambiguous,
      });
      return ambiguous;
    }

    const fence = (
      await tx.select().from(accountDeletionFences)
        .where(eq(accountDeletionFences.userId, matchedUser.id)).limit(1)
    )[0] ?? null;
    let appliedUser: User | null = null;
    if (!fence) {
      appliedUser = (
        await tx.update(users).set(prepared.patch).where(and(
          eq(users.id, matchedUser.id),
          sql`NOT EXISTS (
            SELECT 1 FROM account_deletion_fences
             WHERE user_id = ${matchedUser.id}
          )`,
        )).returning()
      )[0] ?? null;
      if (!appliedUser) throw new Error("Stripe webhook user update lost deletion-fence predicate");
    }

    if (prepared.subscriptionId) {
      if (cursor) {
        await tx.update(billingSubscriptionCursors).set({
          userId: matchedUser.id,
          lastEventCreated: providerCreated,
          lastEventId: eventId,
          updatedAt: sql<number>`unixepoch()`,
        }).where(and(
          eq(billingSubscriptionCursors.subscriptionId, prepared.subscriptionId),
          eq(billingSubscriptionCursors.lastEventCreated, cursor.lastEventCreated),
          eq(billingSubscriptionCursors.lastEventId, cursor.lastEventId),
        ));
      } else {
        await tx.insert(billingSubscriptionCursors).values({
          subscriptionId: prepared.subscriptionId,
          userId: matchedUser.id,
          lastEventCreated: providerCreated,
          lastEventId: eventId,
          updatedAt: sql<number>`unixepoch()`,
        });
      }
    }

    const current = appliedUser ?? matchedUser;
    const deliveryStatus = fence ? "account_deletion_fenced" as const : "applied" as const;
    const applied: StripeEventResult = {
      handled: true,
      applied: !fence,
      delivery_status: deliveryStatus,
      idempotent_replay: false,
      user_id: matchedUser.id,
      plan: fence ? prepared.plan ?? planFor(matchedUser.plan).id : planFor(current.plan).id,
      billing_status: prepared.billingStatus,
      next_action: fence
        ? "Account deletion fenced the local user update. The durable webhook receipt is included in deletion billing revalidation; cancel or set cancel_at_period_end in Stripe if the recorded state can still charge, then retry deletion."
        : `${eventType} applied. User ${matchedUser.id} is on ${planFor(current.plan).name}.`,
    };
    await insertStripeWebhookReceipt(tx as unknown as ReturnType<typeof getDb>, {
      eventId,
      payloadHash,
      eventType,
      providerCreated,
      prepared,
      user: matchedUser,
      status: deliveryStatus,
      result: applied,
    });
    return applied;
  });
  if (result.user_id && result.applied) invalidateUserAuthCache(result.user_id);
  return result;
}

function prepareStripeMutation(env: Env, type: string, object: unknown): PreparedStripeMutation {
  if (type === "checkout.session.completed") return prepareCheckoutCompleted(env, object);
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    return prepareSubscriptionChanged(env, object, false);
  }
  if (type === "customer.subscription.deleted") return prepareSubscriptionChanged(env, object, true);
  return {
    recognized: false,
    objectId: null,
    subscriptionId: null,
    match: { userId: null, customerId: null, subscriptionId: null },
    patch: {},
    plan: null,
    billingStatus: null,
    reason: "event type is not part of the Agentry billing state machine",
  };
}

function prepareCheckoutCompleted(env: Env, object: unknown): PreparedStripeMutation {
  const session = asRecord(object);
  if (!session) return unrecognizedStripeMutation("checkout.session.completed object missing");
  const metadata = asRecord(session.metadata);
  const userId = stringValue(metadata?.user_id) ?? stringValue(session.client_reference_id);
  const customerId = stripeObjectId(session.customer);
  const subscriptionId = stripeObjectId(session.subscription);
  const plan = planMetadataFrom(metadata);

  const patch: UserBillingUpdate = {
    billingStatus: "checkout_completed",
    ...(customerId ? { stripeCustomerId: customerId } : {}),
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    ...(plan ? { plan } : {}),
    ...(plan ? { stripePriceId: stripePriceIdFor(env, plan) ?? undefined } : {}),
  };
  return {
    recognized: true,
    objectId: stringValue(session.id),
    subscriptionId,
    match: { userId, customerId, subscriptionId },
    patch,
    plan,
    billingStatus: "checkout_completed",
    reason: "checkout completed",
  };
}

function prepareSubscriptionChanged(
  env: Env,
  object: unknown,
  forceDeleted: boolean,
): PreparedStripeMutation {
  const subscription = asRecord(object);
  if (!subscription) return unrecognizedStripeMutation("subscription object missing");
  const metadata = asRecord(subscription.metadata);
  const subscriptionId = stringValue(subscription.id);
  const customerId = stripeObjectId(subscription.customer);
  const status = forceDeleted ? "canceled" : stringValue(subscription.status) ?? "unknown";
  const priceId = firstSubscriptionPriceId(subscription);
  const paidPlan = planForStripePriceId(env, priceId) ?? planMetadataFrom(metadata);
  const userId = stringValue(metadata?.user_id);

  let nextPlan: PlanId | undefined;
  if (forceDeleted || DOWNGRADE_STRIPE_STATUSES.has(status)) {
    nextPlan = "free";
  } else if (paidPlan && ACTIVE_STRIPE_STATUSES.has(status)) {
    nextPlan = paidPlan;
  }

  const patch: UserBillingUpdate = {
    billingStatus: status,
    ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    ...(customerId ? { stripeCustomerId: customerId } : {}),
    ...(priceId ? { stripePriceId: priceId } : {}),
    ...(numberValue(subscription.current_period_end) !== null
      ? { billingCurrentPeriodEnd: numberValue(subscription.current_period_end)! }
      : {}),
    billingCancelAtPeriodEnd: subscription.cancel_at_period_end === true ? 1 : 0,
    ...(nextPlan ? { plan: nextPlan } : {}),
  };
  return {
    recognized: true,
    objectId: subscriptionId,
    subscriptionId,
    match: { userId, customerId, subscriptionId },
    patch,
    plan: nextPlan ?? paidPlan ?? null,
    billingStatus: status,
    reason: `subscription ${status}`,
  };
}

async function findBillingUser(
  db: ReturnType<typeof getDb>,
  match: { userId: string | null; customerId: string | null; subscriptionId: string | null },
): Promise<User | null> {
  if (match.userId) {
    const row = (await db.select().from(users).where(eq(users.id, match.userId)).limit(1))[0];
    if (row) return row;
  }
  if (match.subscriptionId) {
    const row = (await db.select().from(users)
      .where(eq(users.stripeSubscriptionId, match.subscriptionId)).limit(1))[0];
    if (row) return row;
  }
  if (match.customerId) {
    const row = (await db.select().from(users)
      .where(eq(users.stripeCustomerId, match.customerId)).limit(1))[0];
    if (row) return row;
  }
  return null;
}

async function insertStripeWebhookReceipt(
  db: ReturnType<typeof getDb>,
  input: {
    eventId: string;
    payloadHash: string;
    eventType: string;
    providerCreated: number;
    prepared: PreparedStripeMutation;
    user: User | null;
    status: StripeEventResult["delivery_status"];
    result: StripeEventResult;
  },
): Promise<void> {
  await db.insert(billingWebhookEvents).values({
    eventId: input.eventId,
    payloadHash: input.payloadHash,
    eventType: input.eventType,
    providerCreated: input.providerCreated,
    objectId: input.prepared.objectId,
    subscriptionId: input.prepared.subscriptionId,
    userId: input.user?.id ?? input.prepared.match.userId,
    status: input.status,
    billingStatus: input.prepared.billingStatus,
    stripeCustomerId: stringValue(input.prepared.patch.stripeCustomerId),
    stripeSubscriptionId: stringValue(input.prepared.patch.stripeSubscriptionId),
    stripePriceId: stringValue(input.prepared.patch.stripePriceId),
    billingCurrentPeriodEnd: numberValue(input.prepared.patch.billingCurrentPeriodEnd),
    billingCancelAtPeriodEnd: numberValue(input.prepared.patch.billingCancelAtPeriodEnd),
    resultJson: canonicalJsonStringify(input.result),
    processedAt: sql<number>`unixepoch()`,
  });
}

function parseStripeEventResult(value: string): StripeEventResult {
  const parsed = JSON.parse(value) as StripeEventResult;
  if (!parsed || typeof parsed !== "object" || typeof parsed.next_action !== "string") {
    throw new Error("invalid Stripe webhook receipt result");
  }
  return parsed;
}

function unrecognizedStripeMutation(reason: string): PreparedStripeMutation {
  return {
    recognized: false,
    objectId: null,
    subscriptionId: null,
    match: { userId: null, customerId: null, subscriptionId: null },
    patch: {},
    plan: null,
    billingStatus: null,
    reason,
  };
}

function serializeBillingUser(user: User) {
  return {
    status: user.billingStatus,
    stripe_customer_id: user.stripeCustomerId,
    stripe_subscription_id: user.stripeSubscriptionId,
    stripe_price_id: user.stripePriceId,
    current_period_end: user.billingCurrentPeriodEnd,
    cancel_at_period_end: user.billingCancelAtPeriodEnd === 1,
  };
}

async function readOptionalJsonObject(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  const body = await readOptionalBoundedJson(c, 16_384);
  return asRecord(body) ?? {};
}

async function readBoundedWebhookBody(
  c: Context<AppBindings>,
  maxBytes: number,
): Promise<string> {
  const body = await readBoundedBytes(c, maxBytes, { allowEmpty: true });
  return body ? new TextDecoder().decode(body) : "";
}

function readUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw errors.invalidPayload({ reason: `${field} must be an http(s) URL` });
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    return url.toString();
  } catch {
    throw errors.invalidPayload({ reason: `${field} must be an http(s) URL` });
  }
}

async function safeBillingUrlTarget(value: string): Promise<{
  origin: string;
  url_hash: string;
}> {
  const url = new URL(value);
  return {
    origin: url.origin,
    url_hash: await sha256Hex(value),
  };
}

function firstSubscriptionPriceId(subscription: Record<string, unknown>): string | null {
  const items = asRecord(subscription.items);
  const data = Array.isArray(items?.data) ? items.data : [];
  const first = asRecord(data[0]);
  const price = asRecord(first?.price);
  return stringValue(price?.id);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}
