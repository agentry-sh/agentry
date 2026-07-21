import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  onboardingProofSessions,
  projectCredentials,
  projects,
  users,
} from "@agentry/db/schema";
import { sha256Hex } from "@agentrysh/shared";
import {
  completeOnboardingProofSession,
  completeOnboardingProofSessionInTransaction,
  createOnboardingProofSession,
  loadOnboardingProofSession,
  restartOnboardingProofSession,
  restartOnboardingProofSessionInTransaction,
  revokeOnboardingProofSession,
} from "../src/onboarding-proof-sessions.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const OWNER_ID = "proof-owner";
const PROJECT_ID = "proof-project";
const ONBOARDING_ID = "proof-onboarding";
const CI_ID = "proof-ci";
const APPROVED_ETAG = `"${"7".repeat(64)}"`;

let env: TestEnv;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
});

afterEach(() => {
  vi.useRealTimers();
  disposeTestEnv(env);
});

async function seed() {
  const db = getDbForUrl(env.TURSO_DATABASE_URL);
  const now = Math.floor(Date.now() / 1_000);
  await db.insert(users).values({ id: OWNER_ID, email: "proof@example.test" });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Proof project",
  });
  await db.insert(projectCredentials).values({
      id: CI_ID,
      projectId: PROJECT_ID,
      kind: "ci_deploy",
      name: "CI deploy",
      prefix: "agentry_ci_proof",
      tokenHash: "b".repeat(64),
      createdBy: OWNER_ID,
      createdAt: now,
      expiresAt: now + 86_400,
  });
  return db;
}

function input() {
  return {
    project_id: PROJECT_ID,
    onboarding_id: ONBOARDING_ID,
    approved_state_etag: APPROVED_ETAG,
    ci_credential_id: CI_ID,
    expires_in_seconds: 900,
  };
}

describe("lean onboarding proof sessions", () => {
  it("returns distinct raw markers once and persists only their hashes", async () => {
    const db = await seed();
    const issued = await createOnboardingProofSession(db, input());

    expect(issued.markers.runtime.value).toMatch(/^agentry_proof_runtime_/);
    expect(issued.markers.ci.value).toMatch(/^agentry_proof_ci_/);
    expect(issued.markers.runtime.value).not.toBe(issued.markers.ci.value);
    expect(issued.markers.runtime.property_name).toBe("agentry_onboarding_proof");
    expect(issued.markers.ci.header_name).toBe("X-Agentry-Onboarding-Proof");
    expect(issued.session.approved_state_etag).toBe(APPROVED_ETAG);
    expect(issued.session.ci_deploy.credential_id).toBe(CI_ID);

    const [row] = await db.select().from(onboardingProofSessions);
    expect(row?.runtimeMarkerHash).toBe(await sha256Hex(issued.markers.runtime.value));
    expect(row?.ciMarkerHash).toBe(await sha256Hex(issued.markers.ci.value));
    expect(JSON.stringify(row)).not.toContain(issued.markers.runtime.value);
    expect(JSON.stringify(row)).not.toContain(issued.markers.ci.value);

    const loaded = await loadOnboardingProofSession(db, PROJECT_ID, issued.session.session_id);
    expect(loaded?.status).toBe("active");
    expect(JSON.stringify(loaded)).not.toContain(issued.markers.runtime.value);
    expect(JSON.stringify(loaded)).not.toContain(issued.markers.ci.value);
  });

  it("rejects too-short CI credential bindings", async () => {
    const db = await seed();
    const now = Math.floor(Date.now() / 1_000);
    await db.update(projectCredentials).set({ expiresAt: now + 600 })
      .where(eq(projectCredentials.id, CI_ID));
    await expect(createOnboardingProofSession(db, input()))
      .rejects.toMatchObject({ code: "onboarding_proof_ci_binding_unavailable" });
    expect(await db.select().from(onboardingProofSessions)).toHaveLength(0);
  });

  it("requires explicit restart instead of silently replacing active markers", async () => {
    const db = await seed();
    const first = await createOnboardingProofSession(db, input());
    await expect(createOnboardingProofSession(db, input()))
      .rejects.toMatchObject({ code: "onboarding_proof_session_active" });

    const second = await restartOnboardingProofSession(db, input());
    expect(second.session.session_id).not.toBe(first.session.session_id);
    expect(second.markers.runtime.value).not.toBe(first.markers.runtime.value);
    expect(second.markers.ci.value).not.toBe(first.markers.ci.value);
    const rows = await db.select().from(onboardingProofSessions);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.session.session_id)).toMatchObject({
      status: "revoked",
      terminalReason: "proof_restarted",
    });
    expect(rows.find((row) => row.id === second.session.session_id)?.status).toBe("active");
  });

  it("rolls a restarted marker pair back with a losing enclosing state transition", async () => {
    const db = await seed();
    const first = await createOnboardingProofSession(db, input());

    await expect(db.transaction(async (tx) => {
      await restartOnboardingProofSessionInTransaction(
        tx as unknown as typeof db,
        input(),
      );
      throw new Error("simulated state CAS loss");
    })).rejects.toThrow("simulated state CAS loss");

    const rows = await db.select().from(onboardingProofSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.session.session_id,
      status: "active",
      terminalReason: null,
    });
  });

  it("completes atomically and leaves durable credentials operational", async () => {
    const db = await seed();
    const issued = await createOnboardingProofSession(db, input());
    await expect(db.transaction(async (tx) => {
      await completeOnboardingProofSessionInTransaction(tx as unknown as typeof db, {
        project_id: PROJECT_ID,
        session_id: issued.session.session_id,
      });
      throw new Error("rollback completion");
    })).rejects.toThrow("rollback completion");
    expect((await loadOnboardingProofSession(db, PROJECT_ID, issued.session.session_id))?.status)
      .toBe("active");

    const completed = await completeOnboardingProofSession(db, {
      project_id: PROJECT_ID,
      session_id: issued.session.session_id,
    });
    expect(completed).toMatchObject({ status: "completed", terminal_reason: "proof_completed" });
    expect(await completeOnboardingProofSession(db, {
      project_id: PROJECT_ID,
      session_id: issued.session.session_id,
    })).toEqual(completed);
    const credentials = await db.select().from(projectCredentials);
    expect(credentials.every((row) => row.revokedAt === null)).toBe(true);
  });

  it("revokes marker authority without revoking telemetry credentials", async () => {
    const db = await seed();
    const issued = await createOnboardingProofSession(db, input());
    const revoked = await revokeOnboardingProofSession(db, {
      project_id: PROJECT_ID,
      session_id: issued.session.session_id,
      reason: "operator_cancelled",
    });
    expect(revoked).toMatchObject({ status: "revoked", terminal_reason: "operator_cancelled" });
    expect(await revokeOnboardingProofSession(db, {
      project_id: PROJECT_ID,
      session_id: issued.session.session_id,
      reason: "operator_cancelled",
    })).toEqual(revoked);
    expect((await db.select().from(projectCredentials)).every((row) => row.revokedAt === null)).toBe(true);
  });

  it("expires on load and closes proof if a durable binding is revoked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
    const db = await seed();
    const expiring = await createOnboardingProofSession(db, {
      ...input(),
      expires_in_seconds: 300,
    });
    vi.advanceTimersByTime(301_000);
    expect(await loadOnboardingProofSession(db, PROJECT_ID, expiring.session.session_id))
      .toMatchObject({ status: "expired", terminal_reason: "session_expired" });

    const restarted = await restartOnboardingProofSession(db, input());
    await db.update(projectCredentials).set({
      revokedAt: Math.floor(Date.now() / 1_000),
      revokeReason: "rotated",
    }).where(eq(projectCredentials.id, CI_ID));
    expect(await loadOnboardingProofSession(db, PROJECT_ID, restarted.session.session_id))
      .toMatchObject({ status: "revoked", terminal_reason: "durable_binding_unavailable" });
  });

  it("cascades sessions with their project", async () => {
    const db = await seed();
    await createOnboardingProofSession(db, input());
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
    expect(await db.select().from(onboardingProofSessions)).toHaveLength(0);
    expect(await db.select().from(projectCredentials)).toHaveLength(0);
  });
});
