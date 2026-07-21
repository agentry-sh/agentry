import { and, eq } from "drizzle-orm";
import { identities, users } from "@agentry/db/schema";
import { uuidv7 } from "@agentrysh/shared";
import type { Env } from "./env.js";
import { getDb } from "./db.js";

export type PosthogOidcIdentity = {
  issuer: string;
  subject: string;
  email: string | null;
  email_verified: boolean | null;
};

export async function resolveExistingPosthogUser(
  env: Env,
  identity: PosthogOidcIdentity,
): Promise<{ userId: string; identityId: string } | null> {
  const db = getDb(env);
  const existing = await findIdentity(db, identity);
  if (!existing) return null;
  return { userId: existing.userId, identityId: existing.id };
}

export async function refreshPosthogIdentityMetadata(
  env: Env,
  identityId: string,
  userId: string,
  identity: PosthogOidcIdentity,
): Promise<void> {
  await refreshIdentityMetadata(getDb(env), identityId, userId, identity);
}

/**
 * Resolve the durable Agentry human principal from the only canonical login
 * key: the validated PostHog OIDC (issuer, subject). Email is display/billing
 * metadata and a selected PostHog environment is a data grant; neither may be
 * used to merge accounts.
 */
export async function resolveOrCreatePosthogUser(
  env: Env,
  identity: PosthogOidcIdentity,
): Promise<{ userId: string; isNew: boolean }> {
  const db = getDb(env);
  const existing = await findIdentity(db, identity);
  if (existing) {
    await refreshIdentityMetadata(db, existing.id, existing.userId, identity);
    return { userId: existing.userId, isNew: false };
  }

  const now = Math.floor(Date.now() / 1_000);
  const userId = uuidv7();
  try {
    await db.transaction(async (tx) => {
      const winner = await findIdentity(tx, identity);
      if (winner) {
        await refreshIdentityMetadata(tx, winner.id, winner.userId, identity);
        return;
      }
      await tx.insert(users).values({
        id: userId,
        email: identity.email_verified === true ? identity.email : null,
        createdAt: now,
      });
      await tx.insert(identities).values({
        id: uuidv7(),
        userId,
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
        emailVerified: identity.email_verified === null
          ? null
          : identity.email_verified ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (error) {
    // Two independent PostHog authorizations for the same human can
    // race. The unique issuer+subject index selects one winner and the losing
    // transaction is fully rolled back, including its provisional users row.
    const winner = await findIdentity(db, identity);
    if (!winner) throw error;
    await refreshIdentityMetadata(db, winner.id, winner.userId, identity);
    return { userId: winner.userId, isNew: false };
  }

  const created = await findIdentity(db, identity);
  if (!created) throw new Error("PostHog OIDC identity transaction did not persist.");
  return { userId: created.userId, isNew: created.userId === userId };
}

type IdentityStore = Pick<ReturnType<typeof getDb>, "select" | "update">;

async function findIdentity(
  db: IdentityStore,
  identity: Pick<PosthogOidcIdentity, "issuer" | "subject">,
) {
  return (
    await db.select({ id: identities.id, userId: identities.userId })
      .from(identities)
      .where(and(
        eq(identities.issuer, identity.issuer),
        eq(identities.subject, identity.subject),
      ))
      .limit(1)
  )[0] ?? null;
}

async function refreshIdentityMetadata(
  db: IdentityStore,
  identityId: string,
  userId: string,
  identity: PosthogOidcIdentity,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await db.update(identities).set({
    email: identity.email,
    emailVerified: identity.email_verified === null
      ? null
      : identity.email_verified ? 1 : 0,
    updatedAt: now,
  }).where(eq(identities.id, identityId));
  if (identity.email_verified === true && identity.email) {
    await db.update(users).set({ email: identity.email }).where(eq(users.id, userId));
  }
}
