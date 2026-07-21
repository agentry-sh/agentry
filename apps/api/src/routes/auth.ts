import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  canonicalJsonStringify,
  constantTimeEqual,
  errors,
  mintApiKey,
  sha256Hex,
  uuidv7,
} from "@agentrysh/shared";
import {
  apiKeys,
  auditLog,
  accountDeletionFences,
  identities,
  mutationCommands,
  posthogOauthAttempts,
  projects,
  projectDeletionFences,
  users,
} from "@agentry/db/schema";
import { getDb } from "../db.js";
import {
  invalidateApiKeyAuthCache,
  authenticatePrivateApiKey,
  invalidateProjectAccessCache,
  invalidateUserAuthCache,
  requireApiKey,
} from "../middleware.js";
import { prepareAuditEvent } from "../audit.js";
import {
  loadMutationCommand,
  mutationCommandValues,
  mutationIdentity,
  mutationResponse,
} from "../mutation-idempotency.js";
import type { AppBindings, Env } from "../env.js";
import {
  acquireDeletionCommandLease,
  loadDeletionCommandById,
  releaseDeletionCommandLease,
  type DurableDeletionCommand,
  type DurableDeletionLease,
} from "../durable-deletion.js";
import {
  externalMutationManifest,
  webhookDeliveryDrainState,
} from "../external-mutation-boundary.js";
import {
  automationDeletionManifest,
  deleteAutomationWorkflowStateForProjects,
  type AutomationDeletionManifest,
} from "../automation-deletion-boundary.js";
import {
  assertNoNonterminalBillingMutations,
  billingDeletionBlockedError,
  readBillingDeletionSnapshot,
  type BillingDeletionSnapshot,
} from "../billing-mutation-boundary.js";
import { readBoundedJson } from "../bounded-json.js";
import { PUBLIC_INSTALL_DOC_URL } from "../public-links.js";
import {
  beginPosthogBootstrap,
  expirePosthogOauthAttempt,
  hashPosthogHandoffTicket,
  posthogHandoffVerifierChallenge,
} from "../posthog-connection.js";

const router = new Hono<AppBindings>();
const ACCOUNT_DELETE_CONFIRMATION = "DELETE_AGENTRY_ACCOUNT";

const POSTHOG_AUTH_POLL_INTERVAL_SECONDS = 5;
const POSTHOG_AUTH_CLAIM_WINDOW_SECONDS = 30 * 60;

function normalizeDistributionSurface(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized) ? normalized : null;
}

async function enforceAuthRateLimit(
  c: Context<AppBindings>,
  binding: "AUTH_START_RATE_LIMITER" | "AUTH_POLL_RATE_LIMITER",
): Promise<void> {
  const limiter = c.env[binding];
  if (!limiter) {
    if (c.env.AGENTRY_ENVIRONMENT === "production") {
      throw errors.configurationMissing(
        "auth_rate_limiter_missing",
        "PostHog authorization is unavailable because its abuse-control binding is missing.",
        `Configure ${binding} and redeploy before retrying.`,
      );
    }
    return;
  }
  const address = c.req.header("cf-connecting-ip")?.trim() || "unavailable";
  let result: { success: boolean };
  try {
    result = await limiter.limit({ key: await sha256Hex(address) });
  } catch {
    throw errors.configurationMissing(
      "auth_rate_limiter_unavailable",
      "PostHog authorization abuse control is temporarily unavailable.",
      "Retry after the rate-limiter binding is healthy.",
    );
  }
  if (!result.success) {
    c.header("Retry-After", "60");
    throw errors.rateLimited();
  }
}

// One browser checkpoint proves both the human's PostHog OIDC subject and a
// read-only grant to exactly one customer-owned PostHog environment.
router.post("/posthog", async (c) => {
  await enforceAuthRateLimit(c, "AUTH_START_RATE_LIMITER");
  const body = await readBoundedJson(c, 4_096) as Record<string, unknown>;
  const region = body?.region;
  if (region !== "us" && region !== "eu") {
    throw errors.invalidPayload({ reason: "region must be: us or eu" });
  }
  const clientName = typeof body.client_name === "string"
    ? body.client_name.trim().slice(0, 64) || null
    : null;
  const distributionSurface = normalizeDistributionSurface(body.distribution_surface);
  const handoffRedirectUri = typeof body.handoff_redirect_uri === "string"
    ? body.handoff_redirect_uri
    : "";
  const handoffChallenge = typeof body.handoff_challenge === "string"
    ? body.handoff_challenge
    : "";
  return c.json(await beginPosthogBootstrap({
    env: c.env,
    request_origin: new URL(c.req.url).origin,
    region,
    client_name: clientName,
    distribution_surface: distributionSurface,
    handoff_redirect_uri: handoffRedirectUri,
    handoff_challenge: handoffChallenge,
  }));
});

router.post("/posthog/poll", async (c) => {
  await enforceAuthRateLimit(c, "AUTH_POLL_RATE_LIMITER");
  const body = await readBoundedJson(c, 4_096);
  const pollToken = body && typeof body === "object"
    && typeof (body as { poll_token?: unknown }).poll_token === "string"
      ? (body as { poll_token: string }).poll_token.trim()
      : null;
  const handoffTicket = body && typeof body === "object"
    && typeof (body as { handoff_ticket?: unknown }).handoff_ticket === "string"
      ? (body as { handoff_ticket: string }).handoff_ticket.trim()
      : null;
  const handoffVerifier = body && typeof body === "object"
    && typeof (body as { handoff_verifier?: unknown }).handoff_verifier === "string"
      ? (body as { handoff_verifier: string }).handoff_verifier.trim()
      : null;
  if (!pollToken?.startsWith("agentry_poll_")) {
    throw errors.invalidPayload({ reason: "poll_token is required" });
  }

  const db = getDb(c.env);
  const pollTokenHash = await sha256Hex(pollToken);
  const attempt = (
    await db.select().from(posthogOauthAttempts).where(and(
      eq(posthogOauthAttempts.mode, "bootstrap"),
      eq(posthogOauthAttempts.pollTokenHash, pollTokenHash),
    )).limit(1)
  )[0];
  if (!attempt) return expiredPosthogPoll(c);

  const now = Math.floor(Date.now() / 1_000);
  if (attempt.expiresAt <= now || attempt.status === "expired") {
    if (attempt.status === "pending" || attempt.status === "exchanging" || attempt.status === "authorized") {
      await expirePosthogOauthAttempt(c.env, attempt, now);
    }
    return expiredPosthogPoll(c);
  }
  if (attempt.pollConsumedAt !== null || attempt.status === "claimed") {
    return expiredPosthogPoll(c);
  }
  if (attempt.status === "failed") {
    return c.json({
      status: "failed",
      error_code: attempt.errorCode ?? "posthog_authorization_failed",
      next_action: "Start a new authorization with POST /v1/auth/posthog.",
    }, 400);
  }
  if (attempt.status === "pending" || attempt.status === "exchanging") {
    const reserved = await db.update(posthogOauthAttempts).set({
      lastPolledAt: now,
      updatedAt: now,
    }).where(and(
      eq(posthogOauthAttempts.id, attempt.id),
      eq(posthogOauthAttempts.status, attempt.status),
      isNull(posthogOauthAttempts.pollConsumedAt),
      sql`(${posthogOauthAttempts.lastPolledAt} IS NULL OR ${posthogOauthAttempts.lastPolledAt} <= ${now - POSTHOG_AUTH_POLL_INTERVAL_SECONDS})`,
    )).returning({ id: posthogOauthAttempts.id });
    if (!reserved[0]) return slowPosthogPoll(c);
    return c.json({
      status: "pending",
      interval: POSTHOG_AUTH_POLL_INTERVAL_SECONDS,
      next_action: "Complete PostHog consent, then poll again after `interval` seconds.",
    });
  }
  if (
    attempt.status !== "authorized" ||
    !attempt.userId ||
    !attempt.pendingAccessTokenExpiresAt ||
    !attempt.handoffCodeHash ||
    !attempt.handoffExpiresAt ||
    !attempt.handoffRedirectUri ||
    !attempt.handoffChallenge
  ) {
    return expiredPosthogPoll(c);
  }
  const submittedHandoffHash = handoffTicket?.startsWith("agentry_handoff_")
    ? await hashPosthogHandoffTicket(attempt.id, handoffTicket)
    : null;
  const submittedHandoffChallenge = handoffVerifier
    ? await posthogHandoffVerifierChallenge(handoffVerifier)
    : null;
  if (
    !submittedHandoffHash ||
    !submittedHandoffChallenge ||
    !attempt.handoffChallenge ||
    !constantTimeEqual(submittedHandoffHash, attempt.handoffCodeHash) ||
    !constantTimeEqual(submittedHandoffChallenge, attempt.handoffChallenge)
  ) {
    throw errors.invalidPayload({
      reason: "the localhost handoff ticket or verifier is invalid",
    });
  }
  const authorizationExpiresAt = Math.min(
    now + POSTHOG_AUTH_CLAIM_WINDOW_SECONDS,
    attempt.pendingAccessTokenExpiresAt - 60,
  );
  if (authorizationExpiresAt <= now) return expiredPosthogPoll(c);

  const user = (
    await db.select().from(users).where(eq(users.id, attempt.userId)).limit(1)
  )[0];
  if (!user) throw errors.catalogInconsistent("authorized OIDC user not found");
  const minted = await mintApiKey();
  const keyId = uuidv7();
  const consumed = await db.transaction(async (tx) => {
    const rows = await tx.update(posthogOauthAttempts).set({
      pollConsumedAt: now,
      lastPolledAt: now,
      handoffCodeHash: null,
      handoffExpiresAt: null,
      handoffFailureCount: 0,
      expiresAt: authorizationExpiresAt,
      updatedAt: now,
      version: sql`${posthogOauthAttempts.version} + 1`,
    }).where(and(
      eq(posthogOauthAttempts.id, attempt.id),
      eq(posthogOauthAttempts.status, "authorized"),
      isNull(posthogOauthAttempts.pollConsumedAt),
      eq(posthogOauthAttempts.handoffCodeHash, submittedHandoffHash),
      sql`${posthogOauthAttempts.handoffExpiresAt} > ${now}`,
      sql`${posthogOauthAttempts.handoffFailureCount} < 5`,
      sql`${posthogOauthAttempts.expiresAt} > ${now}`,
      sql`${posthogOauthAttempts.pendingAccessTokenExpiresAt} > ${now + 60}`,
    )).returning({ id: posthogOauthAttempts.id });
    if (!rows[0]) return false;
    await tx.insert(apiKeys).values({
      id: keyId,
      userId: attempt.userId!,
      kind: "private",
      prefix: minted.prefix,
      keyHash: minted.hash,
      name: "posthog-oidc",
      createdAt: now,
    });
    return true;
  });
  if (!consumed) {
    const current = (
      await db.select().from(posthogOauthAttempts)
        .where(eq(posthogOauthAttempts.id, attempt.id)).limit(1)
    )[0];
    if (current?.status === "authorized" && current.pollConsumedAt === null) {
      throw errors.conflict(
        "posthog_handoff_raced",
        "The localhost handoff raced another completion attempt.",
        "Restart PostHog sign-in from the initiating CLI.",
      );
    }
    return expiredPosthogPoll(c);
  }

  return c.json({
    status: "ok",
    api_key: minted.raw,
    prefix: minted.prefix,
    authorization_id: attempt.id,
    authorization_expires_at: authorizationExpiresAt,
    user: { id: user.id, email: user.email },
    next_action:
      "Store the agentry_sk_ credential outside the repository. Create or select the Agentry project, then claim authorization_id with POST /v1/projects/:id/posthog-connection.",
  });
});

function expiredPosthogPoll(c: Context<AppBindings>) {
  return c.json({
    status: "expired",
    next_action: "Start a new authorization with POST /v1/auth/posthog.",
  }, 400);
}

function slowPosthogPoll(c: Context<AppBindings>) {
  return c.json({
    status: "slow_down",
    interval: POSTHOG_AUTH_POLL_INTERVAL_SECONDS,
    next_action: `Wait at least ${POSTHOG_AUTH_POLL_INTERVAL_SECONDS} seconds before polling again.`,
  });
}

// ---------------------------------------------------------------------------
// Test login (gated). Used by local e2e + dogfood scripts ONLY.
// Production secret store must NOT set ENABLE_TEST_LOGIN.
// ---------------------------------------------------------------------------
router.post("/_test/login", async (c) => {
  if (
    c.env.AGENTRY_ENVIRONMENT === "production" ||
    c.env.ENABLE_TEST_LOGIN !== "true"
  ) {
    throw errors.notFound("route");
  }
  const body = await readBoundedJson(c, 8_192);
  const email =
    body && typeof body === "object"
    && typeof (body as { email?: unknown }).email === "string"
      ? (body as { email: string }).email
      : null;
  if (!email) throw errors.invalidPayload({ reason: "email is required" });
  const subject = await sha256Hex(email.trim().toLowerCase());
  const db = getDb(c.env);
  const issuer = "https://test.posthog.invalid";
  const existingIdentity = (
    await db.select({ userId: identities.userId })
      .from(identities)
      .where(and(eq(identities.issuer, issuer), eq(identities.subject, subject)))
      .limit(1)
  )[0];
  const userId = existingIdentity?.userId ?? uuidv7();
  if (!existingIdentity) {
    const now = Math.floor(Date.now() / 1_000);
    // This local-only test backdoor deliberately avoids the production
    // provider transaction helper so in-memory libSQL unit tests need not
    // emulate interactive transactions. Production can never reach this path.
    await db.insert(users).values({ id: userId, email, createdAt: now });
    await db.insert(identities).values({
      id: uuidv7(),
      userId,
      issuer,
      subject,
      email,
      emailVerified: 1,
      createdAt: now,
      updatedAt: now,
    });
  }
  return await mintKeyResponse(c, userId, "test-posthog-oidc");
});

// ---------------------------------------------------------------------------
// Owner-key lifecycle. Rotation is staged: the replacement is committed while
// the current key remains valid, so losing the one-time response never locks
// the owner out. Raw owner keys remain hash-only and are never escrowed.
// ---------------------------------------------------------------------------
router.get("/keys", requireApiKey(), async (c) => {
  const user = c.get("user");
  const current = c.get("apiKey");
  const rows = await getDb(c.env)
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, user.id), eq(apiKeys.kind, "private")))
    .orderBy(desc(apiKeys.createdAt));
  return c.json({
    keys: rows.map((row) => ({
      id: row.id,
      prefix: row.prefix,
      name: row.name,
      created_at: row.createdAt,
      last_used_at: row.lastUsedAt,
      revoked_at: row.revokedAt,
      active: row.revokedAt === null,
      current: row.id === current.id,
    })),
    next_action:
      "After a staged rotation, authenticate with the replacement key, verify it, then explicitly revoke the old non-current key. Raw values are never recoverable.",
  });
});

router.post("/keys/rotate", requireApiKey(), async (c) => {
  const user = c.get("user");
  const currentApiKey = c.get("apiKey");
  const db = getDb(c.env);
  const identity = await mutationIdentity(c, {
    action: "owner_key.rotate",
    projectId: null,
    request: {},
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) return ownerKeyRotationReplay(c, existing);

  const minted = await mintApiKey();
  const replacementId = uuidv7();
  const createdAt = Math.floor(Date.now() / 1000);
  const keyWrite = db.insert(apiKeys).values({
    id: replacementId,
    userId: user.id,
    prefix: minted.prefix,
    keyHash: minted.hash,
    name: "rotated",
    createdAt,
  });
  const durableResponse = {
    replacement_key_id: replacementId,
    replacement_prefix: minted.prefix,
    previous_key_id: currentApiKey.id,
    previous_key_active: true,
    user_id: user.id,
  };
  const commandWrite = db.insert(mutationCommands).values(
    mutationCommandValues(identity, {
      resourceType: "owner_key",
      resourceId: replacementId,
      response: durableResponse,
      createdAt,
    }),
  );
  const audit = await prepareAuditEvent(c, {
    userId: user.id,
    action: "owner_key.created",
    resourceType: "owner_key",
    resourceId: replacementId,
    summary: "Created a staged replacement owner key",
    metadata: {
      command_id: identity.id,
      previous_key_id: currentApiKey.id,
      previous_key_remains_active: true,
    },
  });
  try {
    await db.batch([
      keyWrite,
      commandWrite,
      db.insert(auditLog).values(audit.values),
    ] as const);
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner) return ownerKeyRotationReplay(c, winner);
    throw error;
  }

  return c.json({
    api_key: minted.raw,
    key_id: replacementId,
    prefix: minted.prefix,
    user_id: user.id,
    previous_key_id: currentApiKey.id,
    previous_key_active: true,
    idempotent_replay: false,
    next_action:
      `Store and verify this replacement api_key first. The previous key remains active. Then authenticate with replacement key ${replacementId} and POST /v1/auth/keys/${currentApiKey.id}/revoke with a new stable Idempotency-Key and a reason.`,
  });
});

router.post("/keys/:key_id/revoke", requireApiKey(), async (c) => {
  const user = c.get("user");
  const currentApiKey = c.get("apiKey");
  const keyId = c.req.param("key_id");
  const body = await readBoundedJson(c, 8_192);
  const reason = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { reason?: unknown }).reason === "string"
    ? (body as { reason: string }).reason.trim().slice(0, 500)
    : "";
  if (!reason) throw errors.invalidPayload({ reason: "a non-empty revoke reason is required" });
  if (keyId === currentApiKey.id) {
    throw errors.conflict(
      "cannot_revoke_current_owner_key",
      "The key authenticating this request cannot revoke itself.",
      "Authenticate with the verified replacement key, then revoke the old non-current key.",
      { key_id: keyId },
    );
  }
  const identity = await mutationIdentity(c, {
    action: "owner_key.revoke",
    projectId: null,
    request: { key_id: keyId, reason },
  });
  const existing = await loadMutationCommand(c, identity);
  if (existing) {
    return c.json({
      ...mutationResponse<Record<string, unknown>>(existing),
      idempotent_replay: true,
    });
  }

  const db = getDb(c.env);
  const target = (
    await db
      .select()
      .from(apiKeys)
      .where(and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.userId, user.id),
        eq(apiKeys.kind, "private"),
      ))
      .limit(1)
  )[0];
  if (!target) throw errors.notFound("owner_key");
  if (target.revokedAt !== null) {
    const observedAt = Math.floor(Date.now() / 1000);
    const durableResponse = {
      key_id: target.id,
      prefix: target.prefix,
      revoked_at: target.revokedAt,
      already_revoked: true,
      next_action: "This owner key is already revoked; no further action is required.",
    };
    const audit = await prepareAuditEvent(c, {
      userId: user.id,
      action: "owner_key.revoked",
      resourceType: "owner_key",
      resourceId: target.id,
      summary: "Confirmed a superseded owner key was already revoked",
      metadata: {
        command_id: identity.id,
        reason,
        no_op: true,
        original_revoked_at: target.revokedAt,
      },
    });
    try {
      await db.batch([
        db.insert(mutationCommands).values(mutationCommandValues(identity, {
          resourceType: "owner_key",
          resourceId: target.id,
          response: durableResponse,
          createdAt: observedAt,
        })),
        db.insert(auditLog).values(audit.values),
      ] as const);
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (winner) {
        return c.json({
          ...mutationResponse<Record<string, unknown>>(winner),
          idempotent_replay: true,
        });
      }
      throw error;
    }
    return c.json({ ...durableResponse, idempotent_replay: false });
  }
  const active = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(
      eq(apiKeys.userId, user.id),
      eq(apiKeys.kind, "private"),
      isNull(apiKeys.revokedAt),
    ));
  if (active.length <= 1) {
    throw errors.conflict(
      "last_owner_key_required",
      "The only active owner key cannot be revoked.",
      "Create and verify a staged replacement first, then revoke this non-current key.",
      { key_id: target.id },
    );
  }

  const revokedAt = Math.floor(Date.now() / 1000);
  const durableResponse = {
    key_id: target.id,
    prefix: target.prefix,
    revoked_at: revokedAt,
    next_action: "Remove the revoked owner key from local credential stores and unattended environments.",
  };
  const revokeWrite = db
    .update(apiKeys)
    .set({ revokedAt })
    .where(and(
      eq(apiKeys.id, target.id),
      eq(apiKeys.userId, user.id),
      isNull(apiKeys.revokedAt),
      sql`EXISTS (
        SELECT 1 FROM api_keys AS survivor
        WHERE survivor.user_id = ${user.id}
          AND survivor.kind = 'private'
          AND survivor.revoked_at IS NULL
          AND survivor.id <> ${target.id}
      )`,
    ));
  const commandValues = mutationCommandValues(identity, {
    resourceType: "owner_key",
    resourceId: target.id,
    response: durableResponse,
    createdAt: revokedAt,
  });
  const guardedCommandWrite = db.insert(mutationCommands).values({
    ...commandValues,
    action: sql<string>`CASE WHEN changes() = 1 THEN ${commandValues.action} ELSE NULL END`,
  });
  const audit = await prepareAuditEvent(c, {
    userId: user.id,
    action: "owner_key.revoked",
    resourceType: "owner_key",
    resourceId: target.id,
    summary: "Revoked a superseded owner key",
    metadata: { command_id: identity.id, reason },
  });
  try {
    await db.batch([
      revokeWrite,
      guardedCommandWrite,
      db.insert(auditLog).values(audit.values),
    ] as const);
  } catch (error) {
    const winner = await loadMutationCommand(c, identity);
    if (winner) {
      return c.json({
        ...mutationResponse<Record<string, unknown>>(winner),
        idempotent_replay: true,
      });
    }
    throw errors.conflict(
      "owner_key_revoke_conflict",
      "The owner key changed before revocation could commit.",
      "List owner keys and retry only if this non-current key is still active.",
      { key_id: target.id, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  invalidateApiKeyAuthCache(target.keyHash);
  return c.json({ ...durableResponse, idempotent_replay: false });
});

async function ownerKeyRotationReplay(
  c: Context<AppBindings>,
  command: typeof mutationCommands.$inferSelect,
): Promise<never> {
  const response = mutationResponse<{
    replacement_key_id: string;
    replacement_prefix: string;
    previous_key_id: string;
    user_id: string;
  }>(command);
  const previous = (
    await getDb(c.env)
      .select({ revokedAt: apiKeys.revokedAt })
      .from(apiKeys)
      .where(and(
        eq(apiKeys.id, response.previous_key_id),
        eq(apiKeys.userId, response.user_id),
      ))
      .limit(1)
  )[0];
  throw errors.conflict(
    "owner_key_secret_not_recoverable",
    "This rotation already created a replacement owner key, whose raw value is intentionally not recoverable.",
    previous?.revokedAt === null
      ? "The previous owner key remains active. List keys, revoke the unusable replacement, then rotate again with a new Idempotency-Key."
      : "Authenticate with another active owner key, list keys, revoke the unusable replacement if needed, then rotate again with a new Idempotency-Key.",
    {
      command_id: command.id,
      replacement_key_id: response.replacement_key_id,
      replacement_prefix: response.replacement_prefix,
      previous_key_id: response.previous_key_id,
      previous_key_active: previous?.revokedAt === null,
      idempotent_replay: true,
    },
  );
}

// ---------------------------------------------------------------------------
// Self-delete — wipe the Agentry account and its Agentry-owned metadata.
// Used for: GDPR-ish data removal, dogfood resets, account churn.
//
// Cascade behavior (per schema): deleting the users row also drops identities,
// apiKeys, projects (and everything project-scoped — cases, deploys,
// alerts, webhooks, agent runs, and PostHog OAuth connections),
// publicQueryPublications and auditLog rows.
//
// What SURVIVES: customer-owned PostHog projects and data, feedback rows
// (intentional — feedback.userId is `set null` on cascade so the queue stays
// auditable), the one hash-bound deletion receipt, and immutable audit
// tombstones. OAuth/provider revocation is an explicit connection operation;
// account deletion only removes Agentry's local connection metadata.
//
// Auth: requires the user's own api_key + an explicit confirm string in the
// body to prevent accidental loss.
// ---------------------------------------------------------------------------
router.post("/self_delete", async (c) => {
  const body = await readBoundedJson(c, 4_096);
  const confirm =
    body && typeof body === "object"
    && typeof (body as { confirm?: unknown }).confirm === "string"
      ? (body as { confirm: string }).confirm
      : "";
  if (confirm !== ACCOUNT_DELETE_CONFIRMATION) {
    throw errors.invalidPayload({
      reason:
        "This permanently deletes the Agentry account and its Agentry-owned project and connection metadata. Customer-owned PostHog projects and data are never deleted. " +
        `To acknowledge that boundary, pass { confirm: '${ACCOUNT_DELETE_CONFIRMATION}' } in the body.`,
      confirmation: ACCOUNT_DELETE_CONFIRMATION,
      deletes: ["Agentry account", "Agentry projects", "Agentry-owned connection metadata"],
      retains: ["customer-owned PostHog projects and data", "bounded deletion receipt", "immutable audit tombstones"],
    });
  }

  const db = getDb(c.env);
  let authenticatingKeyHash: string;
  try {
    authenticatingKeyHash = (await authenticatePrivateApiKey(c)).keyHash;
  } catch (authError) {
    const recovered = await recoverAccountDeletionReceipt(c, confirm);
    if (recovered) return recovered;
    throw authError;
  }
  const user = c.get("user");
  const identity = await mutationIdentity(c, {
    action: "account.self_delete",
    projectId: null,
    request: { confirm },
  });
  let command = await loadMutationCommand(c, identity);
  if (command?.status === "succeeded") {
    return c.json({ ...mutationResponse<Record<string, unknown>>(command), idempotent_replay: true });
  }

  let userProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.userId, user.id));
  let userIdentities = await db
    .select({ id: identities.id })
    .from(identities)
    .where(eq(identities.userId, user.id));
  let userKeys = await db
    .select({ id: apiKeys.id, keyHash: apiKeys.keyHash })
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.id));

  if (!command) {
    const targetCount = 0;
    const progress = accountDeletionProgress({
      commandId: identity.id,
      userId: user.id,
      projects: userProjects.length,
      identities: userIdentities.length,
      apiKeys: userKeys.length,
      targetCount,
      processedCount: 0,
      remaining: targetCount,
      pageDeleted: 0,
      pageAlreadyMissing: 0,
      pageFailed: 0,
    });
    const intentAudit = await prepareAuditEvent(
      c,
      accountDeletionAuditInput(user.id, identity.id),
      "intent",
    );
    try {
      await db.transaction(async (tx) => {
        // This read and both account/project fence inserts share the same
        // serialized write transaction as the deletion intent. A checkout
        // reservation can win before this point (and make the snapshot block),
        // or this fence can win (and make checkout admission fail), never both.
        const billingSnapshot = await readBillingDeletionSnapshot(
          tx as unknown as ReturnType<typeof getDb>,
          user.id,
        );
        if (!billingSnapshot.safe_to_delete) {
          throw billingDeletionBlockedError(billingSnapshot);
        }
        await tx.insert(mutationCommands).values({
          ...mutationCommandValues(identity, {
            resourceType: "account_deletion_receipt",
            resourceId: `credential_hash:${authenticatingKeyHash}`,
            response: progress,
          }),
          status: "intent",
          targetCount,
          processedCount: 0,
          createdAt: sql`unixepoch()`,
          updatedAt: sql`unixepoch()`,
        });
        if (userProjects.length > 0) {
          await tx.insert(projectDeletionFences).values(userProjects.map((project) => ({
            projectId: project.id,
            commandId: identity.id,
            reason: "account_delete" as const,
            actor: `user:${user.id}`,
          })));
        }
        await tx.insert(accountDeletionFences).values({
          userId: user.id,
          commandId: identity.id,
          createdAt: sql`unixepoch()`,
        });
        await tx.insert(auditLog).values(intentAudit.values);
      });
    } catch (error) {
      const winner = await loadMutationCommand(c, identity);
      if (!winner) {
        const accountFence = (
          await db.select().from(accountDeletionFences)
            .where(eq(accountDeletionFences.userId, user.id)).limit(1)
        )[0];
        if (accountFence) {
          throw errors.conflict(
            "account_cleanup_in_progress",
            "This account is already fenced by a different durable deletion command.",
            "Resume that deletion with its original Idempotency-Key; do not start checkout or another deletion command.",
            { user_id: user.id, command_id: accountFence.commandId },
          );
        }
        const conflict = userProjects.length > 0
          ? (
              await db.select().from(projectDeletionFences)
                .where(inArray(projectDeletionFences.projectId, userProjects.map((row) => row.id)))
                .limit(1)
            )[0]
          : null;
        if (conflict) {
          throw errors.conflict(
            "account_project_cleanup_in_progress",
            "A project is already fenced by a different durable deletion command.",
            "Resume that command with its original Idempotency-Key, then retry account deletion with this key.",
            { project_id: conflict.projectId, command_id: conflict.commandId },
          );
        }
        throw error;
      }
      command = winner;
    }
    command ??= await loadMutationCommand(c, identity);
    if (!command) {
      throw errors.persistenceFailed(
        "Account deletion intent did not commit.",
        "Retry the same request with the same Idempotency-Key after database health is restored.",
        { command_id: identity.id },
      );
    }
  }

  await ensureAccountDeletionFence(db, command.id, user.id);

  // Projects can be created while a long-running account cleanup is pending.
  // Fence every currently owned project on every retry; finalization verifies
  // the complete current project set inside its transaction.
  await ensureAccountProjectFences(db, command.id, user.id, userProjects.map((row) => row.id));
  const lease = await acquireDeletionCommandLease(db, command);
  if (!lease) {
    const winner = await loadDeletionCommandById(db, command.id);
    if (winner?.status === "succeeded") {
      return c.json({ ...mutationResponse<Record<string, unknown>>(winner), idempotent_replay: true });
    }
    const busy = accountDeletionBusyResponse(user.id, winner ?? command);
    c.header("Retry-After", String(busy.retry_after_seconds));
    return c.json(busy, 202);
  }

  const projectIds = userProjects.map((project) => project.id);
  const targetCount = 0;
  const processedCount = 0;
  const pageDeleted = 0;
  const pageAlreadyMissing = 0;
  const pageFailed = 0;

  const externalOperations = await externalMutationManifest(db, projectIds);
  if (externalOperations.counts.active > 0) {
    const progress = {
      ...accountDeletionProgress({
        commandId: command.id,
        userId: user.id,
        projects: userProjects.length,
        identities: userIdentities.length,
        apiKeys: userKeys.length,
        targetCount,
        processedCount,
        remaining: 0,
        pageDeleted,
        pageAlreadyMissing,
        pageFailed: 0,
        blocker: "external_provider_mutation_active",
      }),
      external_operations: externalOperations,
      active_until: externalOperations.active_until,
      retry_after_seconds: externalOperations.retry_after_seconds,
    };
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: {
        code: "external_provider_mutation_active",
        active_until: externalOperations.active_until,
        retry_after_seconds: externalOperations.retry_after_seconds,
      },
    });
    c.header("Retry-After", String(externalOperations.retry_after_seconds));
    return c.json(progress, 202);
  }

  const webhookDrain = await webhookDeliveryDrainState(db, projectIds);
  if (!webhookDrain.drained) {
    const progress = {
      ...accountDeletionProgress({
        commandId: command.id,
        userId: user.id,
        projects: userProjects.length,
        identities: userIdentities.length,
        apiKeys: userKeys.length,
        targetCount,
        processedCount,
        remaining: 0,
        pageDeleted,
        pageAlreadyMissing,
        pageFailed: 0,
        blocker: "external_webhook_drain_active",
      }),
      webhook_delivery_drain: webhookDrain,
      active_until: webhookDrain.active_until,
      retry_after_seconds: webhookDrain.retry_after_seconds,
    };
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: {
        code: "external_webhook_drain_active",
        active_until: webhookDrain.active_until,
        retry_after_seconds: webhookDrain.retry_after_seconds,
      },
    });
    c.header("Retry-After", String(webhookDrain.retry_after_seconds));
    return c.json(progress, 202);
  }

  // Re-read only after the account fence is installed and every pre-fence
  // provider/webhook boundary has settled. Signed Stripe deliveries that lost
  // the fence race are preserved in billing_webhook_events and overlaid here,
  // so a checkout/subscription cannot disappear from the deletion receipt.
  const billingSnapshot = await readBillingDeletionSnapshot(db, user.id);
  if (!billingSnapshot.safe_to_delete) {
    const progress = {
      ...accountDeletionProgress({
        commandId: command.id,
        userId: user.id,
        projects: userProjects.length,
        identities: userIdentities.length,
        apiKeys: userKeys.length,
        targetCount,
        processedCount,
        remaining: 0,
        pageDeleted,
        pageAlreadyMissing,
        pageFailed: 0,
        blocker: "billing_cleanup_required",
      }),
      billing: billingSnapshot,
      retry_after_seconds: 1,
      next_action: billingSnapshot.next_action,
    };
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: {
        code: "billing_cleanup_required",
        billing_snapshot_hash: billingSnapshot.snapshot_hash,
        blockers: billingSnapshot.blockers,
      },
    });
    return c.json(progress, 409);
  }

  const genericFollowUpRequired =
    externalOperations.counts.retained_external_state > 0 ||
    externalOperations.counts.external_state_unknown > 0;

  // Re-read final cascade counts before the atomic local delete. The terminal
  // command becomes a hash-bound, authority-free recovery tombstone, so a lost
  // response can return this manifest without restoring the deleted account.
  [userProjects, userIdentities, userKeys] = await Promise.all([
    db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.userId, user.id)),
    db.select({ id: identities.id }).from(identities).where(eq(identities.userId, user.id)),
    db.select({ id: apiKeys.id, keyHash: apiKeys.keyHash }).from(apiKeys).where(eq(apiKeys.userId, user.id)),
  ]);
  const automationManifest = await automationDeletionManifest(
    db,
    userProjects.map((row) => row.id),
  );
  const response = {
    status: "deleted",
    command_id: command.id,
    user_id: user.id,
    cascaded: {
      projects: userProjects.length,
      identities: userIdentities.length,
      api_keys: userKeys.length,
    },
    cleanup: {
      customer_posthog_data_affected: false,
      webhook_delivery_drain: webhookDrain,
      automation_deletion_manifest: automationManifest,
      billing: billingSnapshot,
      external_operations: externalOperations,
    },
    idempotent_replay: false,
    note:
      "The Agentry account, projects, and Agentry-owned connection metadata were deleted. Customer-owned PostHog projects and data are untouched. Feedback, audit tombstones, and this hash-bound receipt are retained.",
    next_action:
      genericFollowUpRequired || webhookDrain.external_follow_up.required || automationManifest.external_follow_up.required
        ? "The account credential is revoked, but an exact retry with the same old credential, confirmation, and Idempotency-Key can recover only this terminal manifest. Customer-owned PostHog data is untouched. Reconcile the explicitly listed webhook, scheduler, repository, or other external-operation entries, then remove ~/.agentry/credentials.json and obsolete Agentry credentials."
        : "The account credential is revoked, but an exact retry of this endpoint with the same old credential, confirmation, and Idempotency-Key can recover only this terminal manifest. Remove ~/.agentry/credentials.json and AGENTRY_* vars, then run `agentry login` for a fresh PostHog sign-in.",
  };
  const accountAuditInput = accountDeletionAuditInput(user.id, command.id);
  const intentAudit = await prepareAuditEvent(c, accountAuditInput, "intent");
  const completedAudit = await prepareAuditEvent(c, {
    ...accountAuditInput,
    summary: "Deleted Agentry account data and local connection metadata",
    metadata: {
      ...accountAuditInput.metadata,
      deleted_project_count: userProjects.length,
      deleted_project_ids_sample: userProjects.map((row) => row.id).sort().slice(0, 20),
      deleted_project_ids_truncated: userProjects.length > 20,
      customer_posthog_data_affected: false,
      external_operation_counts: externalOperations.counts,
      webhook_known_delivered_after_fence_count:
        webhookDrain.known_delivered_after_fence_count,
      webhook_unknown_outcome_count: webhookDrain.unknown_outcome_count,
      automation_deletion_counts: automationManifest.counts,
      billing_snapshot_hash: billingSnapshot.snapshot_hash,
      billing_status: billingSnapshot.billing_status,
      billing_cancel_at_period_end: billingSnapshot.billing_cancel_at_period_end,
    },
  }, "succeeded", {
    operationId: intentAudit.receipt.operationId,
    requestHash: intentAudit.receipt.requestHash,
    input: accountAuditInput,
  });
  try {
    await finalizeAccountDeletion(
      db,
      lease,
      user.id,
      userProjects.map((row) => row.id),
      response,
      automationManifest,
      billingSnapshot,
      completedAudit.values,
    );
  } catch {
    const progress = accountDeletionProgress({
      commandId: command.id,
      userId: user.id,
      projects: userProjects.length,
      identities: userIdentities.length,
      apiKeys: userKeys.length,
      targetCount,
      processedCount,
      remaining: 0,
      pageDeleted,
      pageAlreadyMissing,
      pageFailed: 0,
      blocker: "local_finalize_incomplete",
    });
    await releaseDeletionCommandLease(db, lease, {
      targetCount,
      processedCount,
      response: progress,
      error: { code: "local_finalize_incomplete" },
    }).catch(() => null);
    c.header("Retry-After", String(progress.retry_after_seconds));
    return c.json(progress, 202);
  }

  for (const project of userProjects) {
    invalidateProjectAccessCache(project.id);
  }
  for (const key of userKeys) invalidateApiKeyAuthCache(key.keyHash);
  invalidateUserAuthCache(user.id);

  return c.json(response);
});

async function recoverAccountDeletionReceipt(
  c: Context<AppBindings>,
  confirm: string,
): Promise<Response | null> {
  const auth = c.req.header("authorization") ?? c.req.header("Authorization");
  const rawCredential = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const idempotencyKey = c.req.header("idempotency-key")?.trim();
  if (
    !rawCredential ||
    !idempotencyKey ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 500
  ) return null;

  const credentialHash = await sha256Hex(rawCredential);
  const candidates = await getDb(c.env).select().from(mutationCommands).where(and(
    eq(mutationCommands.action, "account.self_delete"),
    eq(mutationCommands.status, "succeeded"),
    eq(mutationCommands.resourceType, "account_deletion_receipt"),
    eq(mutationCommands.resourceId, `credential_hash:${credentialHash}`),
  )).limit(4);
  for (const candidate of candidates) {
    const scope = {
      schema_version: "1",
      actor_user_id: candidate.actorUserId,
      project_id: null,
      action: "account.self_delete",
      idempotency_key: idempotencyKey,
    };
    const idempotencyKeyHash = await sha256Hex(canonicalJsonStringify(scope));
    const requestHash = await sha256Hex(canonicalJsonStringify({
      ...scope,
      request: { confirm },
    }));
    if (
      !constantTimeEqual(candidate.idempotencyKeyHash, idempotencyKeyHash) ||
      !constantTimeEqual(candidate.requestHash, requestHash)
    ) continue;
    return c.json({
      ...mutationResponse<Record<string, unknown>>(candidate),
      idempotent_replay: true,
      receipt_recovery: {
        authority: "terminal_manifest_only",
        account_authority_restored: false,
        project_authority_restored: false,
        raw_credential_recoverable: false,
        next_action:
          "Use only the retained cleanup manifest to reconcile explicitly listed external scheduler, repository, webhook, or billing state. Customer-owned PostHog data was untouched, and this tombstone cannot read, recreate, or mutate the deleted account or projects.",
      },
    });
  }
  return null;
}

function accountDeletionAuditInput(
  userId: string,
  commandId: string,
): import("../audit.js").AuditInput {
  return {
    userId,
    projectId: null,
    action: "account.deleted",
    resourceType: "account",
    resourceId: userId,
    summary: "Delete Agentry account data and local connection metadata",
    metadata: {
      command_id: commandId,
      confirmation: ACCOUNT_DELETE_CONFIRMATION,
      customer_posthog_data_affected: false,
    },
  };
}

function accountDeletionProgress(input: {
  commandId: string;
  userId: string;
  projects: number;
  identities: number;
  apiKeys: number;
  targetCount: number;
  processedCount: number;
  remaining: number;
  pageDeleted: number;
  pageAlreadyMissing: number;
  pageFailed: number;
  blocker?: string;
}) {
  return {
    status: "in_progress",
    command_id: input.commandId,
    user_id: input.userId,
    cascaded: {
      projects: input.projects,
      identities: input.identities,
      api_keys: input.apiKeys,
    },
    cleanup: {
      targeted_operations: input.targetCount,
      processed_operations: input.processedCount,
      remaining_operations: input.remaining,
      page: {
        deleted: input.pageDeleted,
        already_missing: input.pageAlreadyMissing,
        failed: input.pageFailed,
      },
      blocker: input.blocker ?? null,
    },
    retry_after_seconds: 1,
    idempotent_replay: false,
    next_action: input.blocker === "external_provider_mutation_active"
          ? "A provider mutation reserved durable intent before account deletion fenced its project and may still be in flight. Retry this exact request with the same Idempotency-Key after retry_after_seconds; do not call the provider or start another deletion command."
        : input.blocker === "external_webhook_drain_active"
          ? "A webhook POST passed its final authority check before account deletion fenced the project. Retry this exact request with the same Idempotency-Key after retry_after_seconds; the bounded request is aborted by then and no new delivery can start."
        : input.blocker === "billing_cleanup_required"
          ? "Stripe billing can still create or continue charges. Use the billing.next_action in this response, then retry this exact deletion request with the same Idempotency-Key."
        : "Retry this exact request with the same Idempotency-Key to resume bounded cleanup. Preserve the credential until a terminal 200 revokes it.",
  };
}

function accountDeletionBusyResponse(userId: string, command: DurableDeletionCommand) {
  const leaseExpiresAt = command.leaseExpiresAt;
  const retryAfterSeconds = leaseExpiresAt === null
    ? 1
    : Math.max(1, leaseExpiresAt - Math.floor(Date.now() / 1_000));
  return {
    ...accountDeletionProgress({
      commandId: command.id,
      userId,
      projects: 0,
      identities: 0,
      apiKeys: 0,
      targetCount: command.targetCount,
      processedCount: command.processedCount,
      remaining: Math.max(0, command.targetCount - command.processedCount),
      pageDeleted: 0,
      pageAlreadyMissing: 0,
      pageFailed: 0,
      blocker: "command_lease_busy",
    }),
    lease_expires_at: leaseExpiresAt,
    retry_after_seconds: retryAfterSeconds,
    next_action:
      `Another exact request owns this account-deletion lease. Retry with the same Idempotency-Key after ${retryAfterSeconds} seconds, or sooner only after a terminal response. Preserve this credential and do not start a second deletion command.`,
  };
}

async function ensureAccountProjectFences(
  db: ReturnType<typeof getDb>,
  commandId: string,
  userId: string,
  projectIds: string[],
): Promise<void> {
  for (const projectId of projectIds) {
    await db.insert(projectDeletionFences).values({
      projectId,
      commandId,
      reason: "account_delete",
      actor: `user:${userId}`,
    }).onConflictDoNothing();
    const fence = (
      await db.select().from(projectDeletionFences)
        .where(eq(projectDeletionFences.projectId, projectId)).limit(1)
    )[0];
    if (!fence || fence.commandId !== commandId) {
      throw errors.conflict(
        "account_project_cleanup_in_progress",
        "A project is fenced by a different durable deletion command.",
        "Resume that command before retrying account deletion with this Idempotency-Key.",
        { project_id: projectId, command_id: fence?.commandId ?? null },
      );
    }
  }
}

async function ensureAccountDeletionFence(
  db: ReturnType<typeof getDb>,
  commandId: string,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = (
      await tx.select().from(accountDeletionFences)
        .where(eq(accountDeletionFences.userId, userId)).limit(1)
    )[0];
    if (existing) return;
    const snapshot = await readBillingDeletionSnapshot(
      tx as unknown as ReturnType<typeof getDb>,
      userId,
    );
    if (!snapshot.safe_to_delete) throw billingDeletionBlockedError(snapshot);
    await tx.insert(accountDeletionFences).values({ userId, commandId });
  });
  const fence = (
    await db.select().from(accountDeletionFences)
      .where(eq(accountDeletionFences.userId, userId)).limit(1)
  )[0];
  if (!fence || fence.commandId !== commandId) {
    throw errors.conflict(
      "account_cleanup_in_progress",
      "This account is fenced by a different durable deletion command.",
      "Resume that account deletion with its original Idempotency-Key. Do not start checkout or a second deletion command.",
      { user_id: userId, command_id: fence?.commandId ?? null },
    );
  }
}

async function finalizeAccountDeletion(
  db: ReturnType<typeof getDb>,
  lease: DurableDeletionLease,
  userId: string,
  expectedProjectIds: string[],
  response: Record<string, unknown>,
  expectedAutomationManifest: AutomationDeletionManifest,
  expectedBillingSnapshot: BillingDeletionSnapshot,
  completedAudit: typeof auditLog.$inferInsert,
): Promise<void> {
  await db.transaction(async (tx) => {
    const currentCommand = (
      await tx.select().from(mutationCommands).where(and(
        eq(mutationCommands.id, lease.command.id),
        eq(mutationCommands.version, lease.command.version),
        eq(mutationCommands.leaseToken, lease.token),
        ne(mutationCommands.status, "succeeded"),
      )).limit(1)
    )[0];
    if (!currentCommand) throw new Error("account deletion command lease lost");

    const accountFence = (
      await tx.select().from(accountDeletionFences).where(and(
        eq(accountDeletionFences.userId, userId),
        eq(accountDeletionFences.commandId, lease.command.id),
      )).limit(1)
    )[0];
    if (!accountFence) throw new Error("account billing/deletion fence missing");
    await assertNoNonterminalBillingMutations(
      tx as unknown as ReturnType<typeof getDb>,
      userId,
    );
    const currentBillingSnapshot = await readBillingDeletionSnapshot(
      tx as unknown as ReturnType<typeof getDb>,
      userId,
    );
    if (!currentBillingSnapshot.safe_to_delete) {
      throw new Error("Stripe billing became unsafe before account cascade");
    }
    if (
      billingDeletionEvidence(currentBillingSnapshot) !==
      billingDeletionEvidence(expectedBillingSnapshot)
    ) throw new Error("billing deletion snapshot changed before cascade");

    const currentProjects = await tx.select({ id: projects.id }).from(projects)
      .where(eq(projects.userId, userId));
    const currentIds = currentProjects.map((row) => row.id).sort();
    if (currentIds.join("\u0000") !== [...expectedProjectIds].sort().join("\u0000")) {
      throw new Error("account project set changed");
    }
    if (currentIds.length > 0) {
      const fences = await tx.select().from(projectDeletionFences)
        .where(inArray(projectDeletionFences.projectId, currentIds));
      if (
        fences.length !== currentIds.length ||
        fences.some((row) => row.commandId !== lease.command.id)
      ) throw new Error("account project fence missing");
      const externalOperations = await externalMutationManifest(
        tx as unknown as ReturnType<typeof getDb>,
        currentIds,
      );
      if (externalOperations.counts.active > 0) {
        throw new Error("generic provider operation remains active");
      }
      const webhookDrain = await webhookDeliveryDrainState(
        tx as unknown as ReturnType<typeof getDb>,
        currentIds,
      );
      if (!webhookDrain.drained) throw new Error("external webhook drain remains active");
      const currentAutomationManifest = await automationDeletionManifest(
        tx as unknown as ReturnType<typeof getDb>,
        currentIds,
      );
      if (
        automationDeletionEvidence(currentAutomationManifest) !==
        automationDeletionEvidence(expectedAutomationManifest)
      ) throw new Error("automation deletion manifest changed before cascade");
      await deleteAutomationWorkflowStateForProjects(
        tx as unknown as ReturnType<typeof getDb>,
        currentIds,
      );
      await tx.delete(projectDeletionFences)
        .where(inArray(projectDeletionFences.projectId, currentIds));
    }

    // These scope columns intentionally have no FK. Remove all actor- and
    // project-scoped receipts only after every external object is terminal,
    // except the exact hash-bound account-deletion tombstone used to recover a
    // lost terminal response without restoring account authority.
    await tx.delete(mutationCommands).where(and(
      ne(mutationCommands.id, lease.command.id),
      or(
        eq(mutationCommands.actorUserId, userId),
        ...(currentIds.length > 0 ? [inArray(mutationCommands.projectId, currentIds)] : []),
      ),
    ));
    const completed = await tx.update(mutationCommands).set({
      status: "succeeded",
      responseJson: canonicalJsonStringify(response),
      errorJson: null,
      targetCount: lease.command.targetCount,
      processedCount: lease.command.targetCount,
      leaseToken: null,
      leaseExpiresAt: null,
      version: lease.command.version + 1,
      updatedAt: sql`unixepoch()`,
    }).where(and(
      eq(mutationCommands.id, lease.command.id),
      eq(mutationCommands.version, lease.command.version),
      eq(mutationCommands.leaseToken, lease.token),
      eq(mutationCommands.status, "in_progress"),
    )).returning({ id: mutationCommands.id });
    if (completed.length !== 1) throw new Error("account deletion receipt CAS lost");
    await tx.insert(auditLog).values(completedAudit);
    const deleted = await tx.delete(users).where(eq(users.id, userId))
      .returning({ id: users.id });
    if (deleted.length !== 1) throw new Error("account delete CAS lost");
  });
}

function automationDeletionEvidence(manifest: AutomationDeletionManifest): string {
  return canonicalJsonStringify({
    project_ids: manifest.project_ids,
    counts: manifest.counts,
    samples: manifest.samples,
    samples_truncated: manifest.samples_truncated,
    external_follow_up: manifest.external_follow_up,
  });
}

function billingDeletionEvidence(snapshot: BillingDeletionSnapshot): string {
  return canonicalJsonStringify(snapshot);
}

export default router;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mintKeyResponse(
  c: Context<AppBindings>,
  userId: string,
  name = "posthog-oidc",
) {
  const db = getDb(c.env);
  const nowSec = Math.floor(Date.now() / 1000);

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw errors.catalogInconsistent(
      "authorized user not found",
      { user_id: userId },
    );
  }

  const minted = await mintApiKey();
  await db.insert(apiKeys).values({
    id: uuidv7(),
    userId,
    kind: "private",
    prefix: minted.prefix,
    keyHash: minted.hash,
    name,
    createdAt: nowSec,
  });

  return c.json({
    status: "ok",
    api_key: minted.raw,
    user_id: userId,
    prefix: minted.prefix,
    user: {
      id: userId,
      username: user.githubUsername,
      email: user.email,
      avatar_url: user.avatarUrl,
    },
    next_action:
      "Store your api_key (agentry_sk_…) only in ~/.agentry/credentials.json with mode 0600 — keep it secret; it is not shown again. " +
      `For a first installation, call POST /v1/projects to create the project for this repository, retain its response in private temporary storage until plan approval, and continue the numbered guide at ${PUBLIC_INSTALL_DOC_URL}. ` +
      "Exact onboarding shapes are at /v1/openapi.json?flow=onboarding.",
  });
}
