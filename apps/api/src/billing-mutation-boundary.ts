import type { Context } from "hono";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  accountDeletionFences,
  billingMutationSecrets,
  billingMutationTargets,
  billingWebhookEvents,
  mutationCommands,
  users,
  type User,
} from "@agentry/db/schema";
import {
  AgentryError,
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import type { AppBindings, Env } from "./env.js";
import { getDb, type AgentryDb } from "./db.js";
import {
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
  type MutationIdentity,
} from "./mutation-idempotency.js";
import {
  insertPreparedAuditExactly,
  prepareAuditEvent,
  type AuditInput,
  type AuditOperation,
} from "./audit.js";
import { decryptToken, encryptToken } from "./secret-encryption.js";

export const BILLING_MUTATION_LEASE_SECONDS = 30;
const BILLING_RESULT_SAMPLE_LIMIT = 20;
const NONTERMINAL_BILLING_STATUSES = ["intent", "in_progress", "indeterminate"] as const;
const SAFE_BILLING_STATUSES = new Set(["none", "customer_created", "canceled", "incomplete_expired"]);

export type BillingMutationOperation = "checkout" | "portal";
export type BillingMutationCommand = typeof mutationCommands.$inferSelect;
export type BillingMutationTarget = typeof billingMutationTargets.$inferSelect;

export interface BillingMutationLease {
  command: BillingMutationCommand;
  target: BillingMutationTarget;
  token: string;
  auditOperation: AuditOperation;
}

export type BillingMutationReservation =
  | { state: "acquired"; lease: BillingMutationLease }
  | { state: "replay"; command: BillingMutationCommand; response: Record<string, unknown> }
  | { state: "failed"; command: BillingMutationCommand; error: AgentryError }
  | {
      state: "busy";
      commandId: string;
      retryAfterSeconds: number;
      leaseExpiresAt: number | null;
      sameCommand: boolean;
    };

export interface BillingDeletionSnapshot {
  schema_version: "1";
  user_id: string;
  plan: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  billing_status: string;
  billing_current_period_end: number | null;
  billing_cancel_at_period_end: boolean;
  latest_provider_event: {
    event_id: string;
    event_type: string;
    provider_created: number;
    delivery_status: string;
  } | null;
  provider_order_ambiguity: {
    unresolved: boolean;
    event_ids: string[];
    provider_created: number | null;
    events_truncated: boolean;
  };
  mutation_counts: {
    total: number;
    nonterminal: number;
    checkout_succeeded: number;
    portal_succeeded: number;
    failed: number;
  };
  recent_results: Array<{
    command_id: string;
    operation: BillingMutationOperation;
    status: string;
    session_id: string | null;
    customer_id: string | null;
    created_at: number;
  }>;
  recent_results_truncated: boolean;
  safe_to_delete: boolean;
  blockers: string[];
  next_action: string;
  snapshot_hash: string;
}

export async function reserveBillingMutation(
  c: Context<AppBindings>,
  input: {
    operation: BillingMutationOperation;
    request: Record<string, unknown>;
    target: Record<string, unknown>;
  },
): Promise<BillingMutationReservation> {
  const user = c.get("user") as User;
  const action = input.operation === "checkout" ? "billing.checkout" : "billing.portal";
  const identity = await mutationIdentity(c, {
    action,
    projectId: null,
    request: input.request,
  });
  const targetJson = canonicalJsonStringify(input.target);
  const targetHash = await sha256Hex(targetJson);
  const stripeCustomerIdempotencyKey = input.operation === "checkout"
    ? await stripeIdempotencyKey(identity.id, "customer")
    : null;
  const stripeSessionIdempotencyKey = await stripeIdempotencyKey(
    identity.id,
    input.operation === "checkout" ? "checkout" : "portal",
  );
  const auditInput = billingAuditInput({
    userId: user.id,
    commandId: identity.id,
    operation: input.operation,
    target: input.target,
    targetHash,
    stripeCustomerIdempotencyKey,
    stripeSessionIdempotencyKey,
  });
  const preparedIntent = await prepareAuditEvent(c, auditInput, "intent");
  const auditOperation: AuditOperation = {
    operationId: preparedIntent.receipt.operationId,
    requestHash: preparedIntent.receipt.requestHash,
    input: auditInput,
  };
  const db = getDb(c.env);

  const reservation = await db.transaction(async (tx) => {
    let command = (
      await tx.select().from(mutationCommands)
        .where(eq(mutationCommands.id, identity.id)).limit(1)
    )[0] ?? null;
    if (command) verifyBillingCommand(command, identity);

    let target = command
      ? (
          await tx.select().from(billingMutationTargets)
            .where(eq(billingMutationTargets.commandId, command.id)).limit(1)
        )[0] ?? null
      : null;
    if (target) {
      verifyBillingTarget(target, {
        userId: user.id,
        operation: input.operation,
        targetHash,
        targetJson,
        stripeCustomerIdempotencyKey,
        stripeSessionIdempotencyKey,
      });
    }

    if (command?.status === "succeeded") {
      return {
        state: "replay" as const,
        command,
        response: mutationResponse<Record<string, unknown>>(command),
      };
    }
    if (command?.status === "failed") {
      return {
        state: "failed" as const,
        command,
        error: storedBillingError(command, true),
      };
    }

    const dbNow = await dbClock(tx as unknown as AgentryDb);
    if (
      command?.status === "in_progress" &&
      command.leaseToken &&
      command.leaseExpiresAt !== null &&
      command.leaseExpiresAt > dbNow
    ) {
      return {
        state: "busy" as const,
        commandId: command.id,
        retryAfterSeconds: Math.max(1, command.leaseExpiresAt - dbNow),
        leaseExpiresAt: command.leaseExpiresAt,
        sameCommand: true,
      };
    }

    const accountFence = (
      await tx.select().from(accountDeletionFences)
        .where(eq(accountDeletionFences.userId, user.id)).limit(1)
    )[0] ?? null;
    if (accountFence && input.operation === "checkout") {
      throw errors.conflict(
        "account_deletion_in_progress",
        "Account deletion has fenced new checkout and customer creation.",
        "Do not start another checkout. Resume the existing account deletion with its original Idempotency-Key. If billing must be cancelled first, use POST /v1/billing/portal with its own stable Idempotency-Key, then retry deletion after Stripe webhook state is canceled or cancel_at_period_end.",
        { command_id: accountFence.commandId, retryable: false },
      );
    }

    const other = (
      await tx.select({
        commandId: mutationCommands.id,
        leaseExpiresAt: mutationCommands.leaseExpiresAt,
      })
        .from(billingMutationTargets)
        .innerJoin(mutationCommands, eq(mutationCommands.id, billingMutationTargets.commandId))
        .where(and(
          eq(billingMutationTargets.userId, user.id),
          ne(billingMutationTargets.commandId, identity.id),
          inArray(mutationCommands.status, [...NONTERMINAL_BILLING_STATUSES]),
        ))
        .orderBy(desc(mutationCommands.createdAt))
        .limit(1)
    )[0] ?? null;
    if (other) {
      return {
        state: "busy" as const,
        commandId: other.commandId,
        retryAfterSeconds: other.leaseExpiresAt === null
          ? 1
          : Math.max(1, other.leaseExpiresAt - dbNow),
        leaseExpiresAt: other.leaseExpiresAt,
        sameCommand: false,
      };
    }

    if (!command) {
      const inserted = await tx.insert(mutationCommands).values({
        ...mutationCommandValues(identity, {
          resourceType: "billing_session",
          resourceId: user.id,
          response: { status: "intent", command_id: identity.id },
          createdAt: dbNow,
        }),
        status: "intent",
        targetCount: 1,
        processedCount: 0,
        updatedAt: dbNow,
      }).onConflictDoNothing().returning();
      command = inserted[0] ?? (
        await tx.select().from(mutationCommands)
          .where(eq(mutationCommands.id, identity.id)).limit(1)
      )[0] ?? null;
      if (!command) throw new Error("billing mutation intent insert lost");
      verifyBillingCommand(command, identity);

      const insertedTarget = await tx.insert(billingMutationTargets).values({
        commandId: identity.id,
        userId: user.id,
        operation: input.operation,
        targetHash,
        targetJson,
        stripeCustomerIdempotencyKey,
        stripeSessionIdempotencyKey,
        createdAt: dbNow,
      }).onConflictDoNothing().returning();
      target = insertedTarget[0] ?? (
        await tx.select().from(billingMutationTargets)
          .where(eq(billingMutationTargets.commandId, identity.id)).limit(1)
      )[0] ?? null;
      if (!target) throw new Error("billing mutation target insert lost");
      verifyBillingTarget(target, {
        userId: user.id,
        operation: input.operation,
        targetHash,
        targetJson,
        stripeCustomerIdempotencyKey,
        stripeSessionIdempotencyKey,
      });
      await insertPreparedAuditExactly(tx as unknown as AgentryDb, preparedIntent);
    }
    if (!target) throw new Error("billing mutation target missing");

    const token = `billinglease_${crypto.randomUUID()}`;
    const acquired = await tx.update(mutationCommands).set({
      status: "in_progress",
      leaseToken: token,
      leaseExpiresAt: sql<number>`unixepoch() + ${BILLING_MUTATION_LEASE_SECONDS}`,
      attemptCount: command.attemptCount + 1,
      version: command.version + 1,
      updatedAt: sql<number>`unixepoch()`,
    }).where(and(
      eq(mutationCommands.id, command.id),
      eq(mutationCommands.version, command.version),
      inArray(mutationCommands.status, ["intent", "in_progress", "indeterminate"]),
      or(
        isNull(mutationCommands.leaseToken),
        isNull(mutationCommands.leaseExpiresAt),
        lt(mutationCommands.leaseExpiresAt, sql<number>`unixepoch() + 1`),
      ),
      // Portal creation remains available behind an account-deletion fence as
      // the non-charging remediation path; checkout never does.
      input.operation === "portal"
        ? sql`1 = 1`
        : sql`NOT EXISTS (
            SELECT 1 FROM account_deletion_fences
             WHERE user_id = ${user.id}
          )`,
    )).returning();
    if (!acquired[0]) {
      const winner = (
        await tx.select().from(mutationCommands)
          .where(eq(mutationCommands.id, command.id)).limit(1)
      )[0];
      if (winner?.status === "succeeded") {
        return {
          state: "replay" as const,
          command: winner,
          response: mutationResponse<Record<string, unknown>>(winner),
        };
      }
      const now = await dbClock(tx as unknown as AgentryDb);
      return {
        state: "busy" as const,
        commandId: command.id,
        retryAfterSeconds: winner?.leaseExpiresAt === null || winner?.leaseExpiresAt === undefined
          ? 1
          : Math.max(1, winner.leaseExpiresAt - now),
        leaseExpiresAt: winner?.leaseExpiresAt ?? null,
        sameCommand: true,
      };
    }
    return {
      state: "acquired" as const,
      lease: {
        command: acquired[0],
        target,
        token,
        auditOperation,
      },
    };
  });
  if (reservation.state !== "replay") return reservation;
  return {
    ...reservation,
    response: await recoverBillingMutationResponse(c, reservation.command, reservation.response),
  };
}

export async function completeBillingMutation(
  c: Context<AppBindings>,
  lease: BillingMutationLease,
  response: Record<string, unknown>,
  input: {
    userPatch?: Partial<typeof users.$inferInsert>;
    secretResponse: Record<string, unknown>;
  },
): Promise<void> {
  const encrypted = await encryptToken(c.env, canonicalJsonStringify(input.secretResponse));
  const successAudit = await prepareAuditEvent(c, {
    ...lease.auditOperation.input,
    metadata: {
      ...(lease.auditOperation.input.metadata ?? {}),
      result: billingResultEvidence(response),
    },
  }, "succeeded", lease.auditOperation);
  const db = getDb(c.env);
  await db.transaction(async (tx) => {
    const fence = await tx.select({ commandId: accountDeletionFences.commandId })
      .from(accountDeletionFences)
      .where(eq(accountDeletionFences.userId, lease.target.userId)).limit(1);
    if (fence[0] && lease.target.operation === "checkout") {
      throw new Error("account deletion fence appeared before checkout completion");
    }
    if (input.userPatch) {
      const updatedUser = await tx.update(users).set(input.userPatch).where(and(
        eq(users.id, lease.target.userId),
        lease.target.operation === "portal"
          ? sql`1 = 1`
          : sql`NOT EXISTS (
              SELECT 1 FROM account_deletion_fences
               WHERE user_id = ${lease.target.userId}
            )`,
      )).returning({ id: users.id });
      if (updatedUser.length !== 1) throw new Error("billing user update lost authority");
    }
    await tx.insert(billingMutationSecrets).values({
      commandId: lease.command.id,
      responseEnc: encrypted.enc,
      responseIv: encrypted.iv,
      createdAt: sql<number>`unixepoch()`,
    }).onConflictDoNothing();
    const completed = await tx.update(mutationCommands).set({
      status: "succeeded",
      responseJson: canonicalJsonStringify(response),
      errorJson: null,
      processedCount: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      version: lease.command.version + 1,
      updatedAt: sql<number>`unixepoch()`,
    }).where(and(
      eq(mutationCommands.id, lease.command.id),
      eq(mutationCommands.version, lease.command.version),
      eq(mutationCommands.status, "in_progress"),
      eq(mutationCommands.leaseToken, lease.token),
    )).returning({ id: mutationCommands.id });
    if (completed.length !== 1) throw new Error("billing mutation lease lost");
    await insertPreparedAuditExactly(tx as unknown as AgentryDb, successAudit);
  });
}

export function requireBillingSecretRecoveryConfigured(env: Env): void {
  if (!env.AGENTRY_TOKEN_ENC_KEY) {
    throw errors.configurationMissing(
      "billing_secret_recovery_not_configured",
      "Stripe billing session recovery is not configured on this Agentry deployment.",
      "Set AGENTRY_TOKEN_ENC_KEY to a 32-byte base64url secret on the Agentry API Worker, redeploy, then retry with the same Idempotency-Key. Checkout and portal URLs are never stored plaintext.",
      { missing: ["AGENTRY_TOKEN_ENC_KEY"] },
    );
  }
}

export async function recordBillingMutationFailure(
  c: Context<AppBindings>,
  lease: BillingMutationLease,
  error: unknown,
  definite: boolean,
): Promise<void> {
  const stored = serializeBillingError(error);
  const phase = definite ? "failed" as const : "indeterminate" as const;
  const failureAudit = await prepareAuditEvent(c, {
    ...lease.auditOperation.input,
    metadata: {
      ...(lease.auditOperation.input.metadata ?? {}),
      failure: stored,
      outcome: definite ? "definite_rejection" : "indeterminate_safe_to_retry_same_provider_keys",
    },
  }, phase, lease.auditOperation);
  await getDb(c.env).transaction(async (tx) => {
    const completed = await tx.update(mutationCommands).set({
      status: definite ? "failed" : "indeterminate",
      responseJson: canonicalJsonStringify({
        status: definite ? "failed" : "indeterminate",
        command_id: lease.command.id,
      }),
      errorJson: canonicalJsonStringify(stored),
      processedCount: definite ? 1 : lease.command.processedCount,
      leaseToken: null,
      leaseExpiresAt: null,
      version: lease.command.version + 1,
      updatedAt: sql<number>`unixepoch()`,
    }).where(and(
      eq(mutationCommands.id, lease.command.id),
      eq(mutationCommands.version, lease.command.version),
      eq(mutationCommands.status, "in_progress"),
      eq(mutationCommands.leaseToken, lease.token),
    )).returning({ id: mutationCommands.id });
    if (completed.length !== 1) throw new Error("billing failure lease lost");
    await insertPreparedAuditExactly(tx as unknown as AgentryDb, failureAudit);
  });
}

export function billingMutationBusyBody(reservation: Extract<BillingMutationReservation, { state: "busy" }>) {
  return {
    status: "in_progress",
    command_id: reservation.commandId,
    lease_expires_at: reservation.leaseExpiresAt,
    retry_after_seconds: reservation.retryAfterSeconds,
    idempotent_replay: reservation.sameCommand,
    next_action: reservation.sameCommand
      ? `Another exact request owns this billing mutation. Retry with the same Idempotency-Key after ${reservation.retryAfterSeconds} seconds; Stripe will receive the same deterministic provider key.`
      : `Another billing mutation is active for this account. Retry this request with its same Idempotency-Key after ${reservation.retryAfterSeconds} seconds so customer/session creation remains serialized.`,
  };
}

export async function readBillingDeletionSnapshot(
  db: AgentryDb,
  userId: string,
): Promise<BillingDeletionSnapshot> {
  const user = (
    await db.select().from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  if (!user) throw errors.notFound("user");
  const rows = await db.select({
    commandId: mutationCommands.id,
    status: mutationCommands.status,
    responseJson: mutationCommands.responseJson,
    createdAt: mutationCommands.createdAt,
    operation: billingMutationTargets.operation,
  }).from(billingMutationTargets)
    .innerJoin(mutationCommands, eq(mutationCommands.id, billingMutationTargets.commandId))
    .where(eq(billingMutationTargets.userId, userId))
    .orderBy(desc(mutationCommands.createdAt), desc(mutationCommands.id));
  const latestProviderEvent = (
    await db.select().from(billingWebhookEvents).where(and(
      eq(billingWebhookEvents.userId, userId),
      inArray(billingWebhookEvents.status, ["applied", "account_deletion_fenced"]),
    )).orderBy(
      desc(billingWebhookEvents.providerCreated),
      desc(billingWebhookEvents.eventId),
    ).limit(1)
  )[0] ?? null;
  const ambiguousProviderEvents = await db.select({
    eventId: billingWebhookEvents.eventId,
    providerCreated: billingWebhookEvents.providerCreated,
  }).from(billingWebhookEvents).where(and(
    eq(billingWebhookEvents.userId, userId),
    eq(billingWebhookEvents.status, "ambiguous_order"),
  )).orderBy(
    desc(billingWebhookEvents.providerCreated),
    desc(billingWebhookEvents.processedAt),
  ).limit(BILLING_RESULT_SAMPLE_LIMIT + 1);
  const newestAmbiguousCreated = ambiguousProviderEvents[0]?.providerCreated ?? null;
  const unresolvedProviderOrder = newestAmbiguousCreated !== null &&
    newestAmbiguousCreated >= (latestProviderEvent?.providerCreated ?? -1);

  const nonterminal = rows.filter((row) =>
    NONTERMINAL_BILLING_STATUSES.includes(row.status as (typeof NONTERMINAL_BILLING_STATUSES)[number])
  );
  const succeededCheckout = rows.filter((row) => row.operation === "checkout" && row.status === "succeeded");
  const blockers: string[] = [];
  if (nonterminal.length > 0) blockers.push("billing_mutation_nonterminal");
  if (unresolvedProviderOrder) blockers.push("stripe_webhook_order_ambiguous");

  const effectiveBillingStatus = latestProviderEvent?.billingStatus ?? user.billingStatus;
  const effectiveCancelAtPeriodEnd = latestProviderEvent?.billingCancelAtPeriodEnd === null ||
      latestProviderEvent?.billingCancelAtPeriodEnd === undefined
    ? user.billingCancelAtPeriodEnd === 1
    : latestProviderEvent.billingCancelAtPeriodEnd === 1;
  const effectiveCustomerId = latestProviderEvent?.stripeCustomerId ?? user.stripeCustomerId;
  const effectiveSubscriptionId = latestProviderEvent?.stripeSubscriptionId ?? user.stripeSubscriptionId;
  const effectivePriceId = latestProviderEvent?.stripePriceId ?? user.stripePriceId;
  const effectivePeriodEnd = latestProviderEvent?.billingCurrentPeriodEnd ?? user.billingCurrentPeriodEnd;
  const statusSafe = SAFE_BILLING_STATUSES.has(effectiveBillingStatus);
  if (!statusSafe && !effectiveCancelAtPeriodEnd) {
    blockers.push("stripe_billing_can_continue");
  }

  const recentResults = rows.slice(0, BILLING_RESULT_SAMPLE_LIMIT).map((row) => {
    const result = parseObject(row.responseJson);
    return {
      command_id: row.commandId,
      operation: row.operation,
      status: row.status,
      session_id: stringOrNull(result?.session_id),
      customer_id: stringOrNull(result?.customer_id),
      created_at: row.createdAt,
    };
  });
  const withoutHash = {
    schema_version: "1" as const,
    user_id: user.id,
    plan: user.plan,
    stripe_customer_id: effectiveCustomerId,
    stripe_subscription_id: effectiveSubscriptionId,
    stripe_price_id: effectivePriceId,
    billing_status: effectiveBillingStatus,
    billing_current_period_end: effectivePeriodEnd,
    billing_cancel_at_period_end: effectiveCancelAtPeriodEnd,
    latest_provider_event: latestProviderEvent
      ? {
          event_id: latestProviderEvent.eventId,
          event_type: latestProviderEvent.eventType,
          provider_created: latestProviderEvent.providerCreated,
          delivery_status: latestProviderEvent.status,
        }
      : null,
    provider_order_ambiguity: {
      unresolved: unresolvedProviderOrder,
      event_ids: ambiguousProviderEvents.slice(0, BILLING_RESULT_SAMPLE_LIMIT)
        .map((row) => row.eventId),
      provider_created: newestAmbiguousCreated,
      events_truncated: ambiguousProviderEvents.length > BILLING_RESULT_SAMPLE_LIMIT,
    },
    mutation_counts: {
      total: rows.length,
      nonterminal: nonterminal.length,
      checkout_succeeded: succeededCheckout.length,
      portal_succeeded: rows.filter((row) => row.operation === "portal" && row.status === "succeeded").length,
      failed: rows.filter((row) => row.status === "failed").length,
    },
    recent_results: recentResults,
    recent_results_truncated: rows.length > BILLING_RESULT_SAMPLE_LIMIT,
    safe_to_delete: blockers.length === 0,
    blockers,
    next_action: blockers.includes("billing_mutation_nonterminal")
      ? "Retry the original billing request with its original Idempotency-Key until it returns a terminal result, then retry account deletion with the deletion key. Do not start another checkout."
      : blockers.includes("stripe_webhook_order_ambiguous")
        ? "Stripe sent opposing subscription evidence in the same created second, and event ids cannot order it. Inspect the current subscription in Stripe and replay a newer signed subscription event before retrying account deletion."
      : blockers.includes("stripe_billing_can_continue")
        ? "Call POST /v1/billing/portal with a stable Idempotency-Key, cancel the subscription or set cancel_at_period_end, wait for the signed Stripe webhook to update billing status, then retry account deletion with its original key."
        : "Billing is terminal or cancel_at_period_end, so account deletion may continue.",
  };
  return {
    ...withoutHash,
    snapshot_hash: await sha256Hex(canonicalJsonStringify(withoutHash)),
  };
}

export function billingDeletionBlockedError(snapshot: BillingDeletionSnapshot): AgentryError {
  return errors.conflict(
    "billing_cleanup_required",
    "Account deletion is blocked because Stripe billing may still create or continue charges.",
    snapshot.next_action,
    {
      billing: snapshot,
      retryable: false,
    },
  );
}

export async function assertNoNonterminalBillingMutations(
  db: AgentryDb,
  userId: string,
): Promise<void> {
  const rows = await db.select({ commandId: mutationCommands.id })
    .from(billingMutationTargets)
    .innerJoin(mutationCommands, eq(mutationCommands.id, billingMutationTargets.commandId))
    .where(and(
      eq(billingMutationTargets.userId, userId),
      inArray(mutationCommands.status, [...NONTERMINAL_BILLING_STATUSES]),
    )).limit(1);
  if (rows.length > 0) throw new Error("billing mutation remains nonterminal");
}

function billingAuditInput(input: {
  userId: string;
  commandId: string;
  operation: BillingMutationOperation;
  target: Record<string, unknown>;
  targetHash: string;
  stripeCustomerIdempotencyKey: string | null;
  stripeSessionIdempotencyKey: string;
}): AuditInput {
  return {
    userId: input.userId,
    projectId: null,
    action: input.operation === "checkout"
      ? "billing.checkout_session.created"
      : "billing.portal_session.created",
    resourceType: "billing_session",
    resourceId: input.commandId,
    summary: input.operation === "checkout"
      ? "Create an account-scoped Stripe Checkout session"
      : "Create an account-scoped Stripe billing portal session",
    metadata: {
      command_id: input.commandId,
      operation: input.operation,
      target_hash: input.targetHash,
      target: input.target,
      provider_idempotency: {
        customer: input.stripeCustomerIdempotencyKey,
        session: input.stripeSessionIdempotencyKey,
      },
      $agentry_external_mutation: {
        schema_version: "1",
        effect: "provider_mutation",
        retained_resource_on_success: true,
      },
    },
  };
}

function verifyBillingCommand(command: BillingMutationCommand, identity: MutationIdentity): void {
  if (
    command.actorUserId !== identity.actorUserId ||
    command.projectId !== null ||
    command.action !== identity.action ||
    command.idempotencyKeyHash !== identity.idempotencyKeyHash ||
    command.resourceType !== "billing_session" ||
    command.resourceId !== identity.actorUserId
  ) {
    throw errors.persistenceFailed(
      "The billing command resolved to a different authority scope.",
      "Stop and inspect command-store integrity; do not call Stripe or overwrite the receipt.",
      { command_id: command.id },
    );
  }
  if (command.requestHash !== identity.requestHash) {
    throw errors.conflict(
      "idempotency_key_reused",
      "This Idempotency-Key was already used with different billing evidence.",
      "Replay the exact original request or use a new stable Idempotency-Key for a different plan or return URL.",
      { command_id: command.id },
    );
  }
}

function verifyBillingTarget(
  target: BillingMutationTarget,
  expected: {
    userId: string;
    operation: BillingMutationOperation;
    targetHash: string;
    targetJson: string;
    stripeCustomerIdempotencyKey: string | null;
    stripeSessionIdempotencyKey: string;
  },
): void {
  if (
    target.userId !== expected.userId ||
    target.operation !== expected.operation ||
    target.targetHash !== expected.targetHash ||
    target.targetJson !== expected.targetJson ||
    target.stripeCustomerIdempotencyKey !== expected.stripeCustomerIdempotencyKey ||
    target.stripeSessionIdempotencyKey !== expected.stripeSessionIdempotencyKey
  ) {
    throw errors.persistenceFailed(
      "The immutable billing provider target does not match this command.",
      "Stop before calling Stripe and inspect the billing command/target rows; never merge conflicting targets.",
      { command_id: target.commandId },
    );
  }
}

function storedBillingError(command: BillingMutationCommand, replay: boolean): AgentryError {
  const stored = parseObject(command.errorJson);
  const status = numberOrNull(stored?.status) ?? 424;
  const code = stringOrNull(stored?.code) ?? "stripe_upstream_failed";
  const message = stringOrNull(stored?.message) ?? "The stored Stripe mutation failed.";
  const nextAction = stringOrNull(stored?.next_action)
    ?? "Fix the definite Stripe rejection, then use a new Idempotency-Key for a new billing mutation.";
  const details = parseObject(stored?.details) ?? {};
  return new AgentryError({
    status,
    code,
    message,
    nextAction,
    details: { ...details, command_id: command.id, idempotent_replay: replay },
  });
}

async function recoverBillingMutationResponse(
  c: Context<AppBindings>,
  command: BillingMutationCommand,
  publicResponse: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const secret = (
    await getDb(c.env).select().from(billingMutationSecrets)
      .where(eq(billingMutationSecrets.commandId, command.id)).limit(1)
  )[0];
  if (!secret) {
    throw errors.persistenceFailed(
      "The billing mutation succeeded, but its encrypted session URL is unavailable.",
      "Do not create a replacement with a new key. Inspect the Stripe session_id from details and restore the billing secret sidecar or use Stripe directly.",
      { command_id: command.id, session_id: stringOrNull(publicResponse.session_id) },
    );
  }
  let decrypted: Record<string, unknown>;
  try {
    decrypted = parseObject(await decryptToken(c.env, secret.responseEnc, secret.responseIv)) ?? {};
  } catch {
    throw errors.persistenceFailed(
      "The billing mutation succeeded, but its encrypted session URL could not be decrypted.",
      "Restore the exact AGENTRY_TOKEN_ENC_KEY that encrypted this response, redeploy, and retry with the same Idempotency-Key. Do not create a duplicate session.",
      { command_id: command.id, session_id: stringOrNull(publicResponse.session_id) },
    );
  }
  return { ...publicResponse, ...decrypted, idempotent_replay: true };
}

function serializeBillingError(error: unknown): Record<string, unknown> {
  if (error instanceof AgentryError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message.slice(0, 1_000),
      next_action: error.nextAction ?? null,
      details: error.details ?? {},
    };
  }
  return {
    status: 502,
    code: "stripe_upstream_failed",
    message: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    next_action: "Retry this exact billing request with the same Idempotency-Key after the stated backoff.",
    details: {},
  };
}

function billingResultEvidence(response: Record<string, unknown>): Record<string, unknown> {
  return {
    command_id: stringOrNull(response.command_id),
    session_id: stringOrNull(response.session_id),
    customer_id: stringOrNull(response.customer_id),
    plan: stringOrNull(response.plan),
    price_id: stringOrNull(response.price_id),
  };
}

async function stripeIdempotencyKey(commandId: string, phase: string): Promise<string> {
  const digest = await sha256Hex(`${commandId}:${phase}`);
  return `agentry_${phase}_${digest.slice(0, 48)}`;
}

async function dbClock(db: AgentryDb): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  return Number(result.rows[0]?.now_seconds ?? 0);
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
