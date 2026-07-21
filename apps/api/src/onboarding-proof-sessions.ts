import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { errors, sha256Hex, uuidv7 } from "@agentrysh/shared";
import {
  onboardingProofSessions,
  projectCredentials,
} from "@agentry/db/schema";
import type { getDb } from "./db.js";
import { ONBOARDING_V3_RUNTIME_PROOF_PROPERTY } from "./onboarding-v3-contract.js";

const STRONG_ETAG = /^"[a-f0-9]{64}"$/;

export const ONBOARDING_CI_PROOF_HEADER = "X-Agentry-Onboarding-Proof";
export const ONBOARDING_PROOF_SESSION_DEFAULT_TTL_SECONDS = 4 * 60 * 60;
export const ONBOARDING_PROOF_SESSION_MIN_TTL_SECONDS = 5 * 60;
export const ONBOARDING_PROOF_SESSION_MAX_TTL_SECONDS = 4 * 60 * 60;

export const CreateOnboardingProofSessionSchema = z.object({
  project_id: z.string().trim().min(1).max(200),
  onboarding_id: z.string().trim().min(1).max(200),
  approved_state_etag: z.string().regex(STRONG_ETAG),
  ci_credential_id: z.string().trim().min(1).max(200),
  expires_in_seconds: z.number().int()
    .min(ONBOARDING_PROOF_SESSION_MIN_TTL_SECONDS)
    .max(ONBOARDING_PROOF_SESSION_MAX_TTL_SECONDS)
    .default(ONBOARDING_PROOF_SESSION_DEFAULT_TTL_SECONDS),
}).strict();

const SessionLookupSchema = z.object({
  project_id: z.string().trim().min(1).max(200),
  session_id: z.string().trim().min(1).max(200),
}).strict();

const SessionRevocationSchema = SessionLookupSchema.extend({
  reason: z.string().trim().min(1).max(500),
}).strict();

export type CreateOnboardingProofSessionInput = z.input<typeof CreateOnboardingProofSessionSchema>;
export type OnboardingProofSessionStatus = "active" | "completed" | "revoked" | "expired";

export interface SafeOnboardingProofCredential {
  credential_id: string;
  kind: "ci_deploy";
  name: string;
  prefix: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

export interface SafeOnboardingProofSession {
  session_id: string;
  project_id: string;
  onboarding_id: string;
  approved_state_etag: string;
  status: OnboardingProofSessionStatus;
  started_at: number;
  expires_at: number;
  terminal_at: number | null;
  terminal_reason: string | null;
  updated_at: number;
  runtime_marker_hash: string;
  ci_deploy: SafeOnboardingProofCredential;
}

export interface IssuedOnboardingRuntimeProofMarker {
  property_name: typeof ONBOARDING_V3_RUNTIME_PROOF_PROPERTY;
  value: string;
  expires_at: number;
}

export interface IssuedOnboardingCiProofMarker {
  header_name: typeof ONBOARDING_CI_PROOF_HEADER;
  value: string;
  expires_at: number;
}

export interface IssuedOnboardingProofSession {
  session: SafeOnboardingProofSession;
  markers: {
    runtime: IssuedOnboardingRuntimeProofMarker;
    ci: IssuedOnboardingCiProofMarker;
  };
}

type Db = ReturnType<typeof getDb>;
export type OnboardingProofSessionTransaction = Db;
type SessionRow = typeof onboardingProofSessions.$inferSelect;
type CredentialRow = typeof projectCredentials.$inferSelect;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function randomMarker(purpose: "runtime" | "ci"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `agentry_proof_${purpose}_${token}`;
}

function safeCredential(row: CredentialRow): SafeOnboardingProofCredential {
  if (row.kind !== "ci_deploy") {
    throw errors.persistenceFailed(
      "An onboarding proof session references the wrong credential kind.",
      "Restart proof with a project-bound CI-deploy credential.",
      { credential_id: row.id, credential_kind: row.kind },
    );
  }
  return {
    credential_id: row.id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    created_at: row.createdAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
  };
}

async function ciCredential(db: Db, session: SessionRow): Promise<CredentialRow> {
  const ci = (await db.select().from(projectCredentials).where(eq(
    projectCredentials.id,
    session.ciCredentialId,
  )).limit(1))[0];
  if (!ci || ci.projectId !== session.projectId || ci.kind !== "ci_deploy") {
    throw errors.persistenceFailed(
      "An onboarding proof session has an invalid durable CI credential binding.",
      "Restart proof with an active CI-deploy credential belonging to this project.",
      { session_id: session.id },
    );
  }
  return ci;
}

async function safeSession(db: Db, row: SessionRow): Promise<SafeOnboardingProofSession> {
  const ci = await ciCredential(db, row);
  return {
    session_id: row.id,
    project_id: row.projectId,
    onboarding_id: row.onboardingId,
    approved_state_etag: row.approvedStateEtag,
    status: row.status,
    started_at: row.startedAt,
    expires_at: row.expiresAt,
    terminal_at: row.terminalAt,
    terminal_reason: row.terminalReason,
    updated_at: row.updatedAt,
    runtime_marker_hash: row.runtimeMarkerHash,
    ci_deploy: safeCredential(ci),
  };
}

async function sessionRow(db: Db, projectId: string, sessionId: string): Promise<SessionRow | null> {
  return (await db.select().from(onboardingProofSessions).where(and(
    eq(onboardingProofSessions.projectId, projectId),
    eq(onboardingProofSessions.id, sessionId),
  )).limit(1))[0] ?? null;
}

async function bindingsAreActive(db: Db, row: SessionRow, at: number): Promise<boolean> {
  const ci = await ciCredential(db, row);
  return ci.revokedAt === null && ci.expiresAt > at;
}

async function finish(
  db: Db,
  row: SessionRow,
  status: Exclude<OnboardingProofSessionStatus, "active">,
  reason: string,
  at: number,
): Promise<SafeOnboardingProofSession> {
  const terminalAt = status === "expired"
    ? Math.max(at, row.expiresAt)
    : Math.max(row.startedAt, Math.min(at, row.expiresAt - 1));
  const updated = await db.update(onboardingProofSessions).set({
    status,
    terminalAt,
    terminalReason: reason,
    updatedAt: terminalAt,
  }).where(and(
    eq(onboardingProofSessions.id, row.id),
    eq(onboardingProofSessions.projectId, row.projectId),
    eq(onboardingProofSessions.status, "active"),
  )).returning();
  const winner = updated[0] ?? await sessionRow(db, row.projectId, row.id);
  if (!winner) throw errors.notFound("onboarding proof session");
  return safeSession(db, winner);
}

async function loadCurrent(db: Db, row: SessionRow, at: number): Promise<SafeOnboardingProofSession> {
  if (row.status !== "active") return safeSession(db, row);
  if (row.expiresAt <= at) return finish(db, row, "expired", "session_expired", at);
  if (!await bindingsAreActive(db, row, at)) {
    return finish(db, row, "revoked", "durable_binding_unavailable", at);
  }
  return safeSession(db, row);
}

async function validateBindings(
  db: Db,
  input: z.output<typeof CreateOnboardingProofSessionSchema>,
  startedAt: number,
): Promise<void> {
  const expiresAt = startedAt + input.expires_in_seconds;
  const ci = (await db.select().from(projectCredentials).where(eq(
    projectCredentials.id,
    input.ci_credential_id,
  )).limit(1))[0];
  if (
    !ci || ci.projectId !== input.project_id || ci.kind !== "ci_deploy" ||
    ci.revokedAt !== null || ci.expiresAt < expiresAt
  ) {
    throw errors.conflict(
      "onboarding_proof_ci_binding_unavailable",
      "The selected CI credential is unavailable for the complete proof window.",
      "Use an active project-bound AGENTRY_CI_API_KEY and restart proof.",
      { ci_credential_id: input.ci_credential_id },
    );
  }
}

async function createInDb(
  db: Db,
  input: z.output<typeof CreateOnboardingProofSessionSchema>,
): Promise<IssuedOnboardingProofSession> {
  const startedAt = nowSeconds();
  await validateBindings(db, input, startedAt);
  const activeRows = await db.select().from(onboardingProofSessions).where(and(
    eq(onboardingProofSessions.projectId, input.project_id),
    eq(onboardingProofSessions.onboardingId, input.onboarding_id),
    eq(onboardingProofSessions.status, "active"),
  ));
  for (const row of activeRows) {
    const current = await loadCurrent(db, row, startedAt);
    if (current.status === "active") {
      throw errors.conflict(
        "onboarding_proof_session_active",
        "This onboarding already has an active proof session.",
        "Use its markers, or restart proof to revoke it and issue a new marker pair.",
        { session_id: row.id, expires_at: row.expiresAt },
      );
    }
  }
  const runtimeMarker = randomMarker("runtime");
  const ciMarker = randomMarker("ci");
  const [runtimeMarkerHash, ciMarkerHash] = await Promise.all([
    sha256Hex(runtimeMarker),
    sha256Hex(ciMarker),
  ]);
  const inserted = await db.insert(onboardingProofSessions).values({
    id: uuidv7(),
    projectId: input.project_id,
    onboardingId: input.onboarding_id,
    approvedStateEtag: input.approved_state_etag,
    ciCredentialId: input.ci_credential_id,
    runtimeMarkerHash,
    ciMarkerHash,
    status: "active",
    startedAt,
    expiresAt: startedAt + input.expires_in_seconds,
    terminalAt: null,
    terminalReason: null,
    updatedAt: startedAt,
  }).returning();
  const session = await safeSession(db, inserted[0]!);
  return {
    session,
    markers: {
      runtime: {
        property_name: ONBOARDING_V3_RUNTIME_PROOF_PROPERTY,
        value: runtimeMarker,
        expires_at: session.expires_at,
      },
      ci: {
        header_name: ONBOARDING_CI_PROOF_HEADER,
        value: ciMarker,
        expires_at: session.expires_at,
      },
    },
  };
}

/** Raw markers are returned by this call once and are never persisted. */
export async function createOnboardingProofSession(
  db: Db,
  rawInput: CreateOnboardingProofSessionInput,
): Promise<IssuedOnboardingProofSession> {
  const input = CreateOnboardingProofSessionSchema.parse(rawInput);
  return db.transaction((tx) => createInDb(tx as unknown as Db, input));
}

export async function loadOnboardingProofSession(
  db: Db,
  projectId: string,
  sessionId: string,
): Promise<SafeOnboardingProofSession | null> {
  const input = SessionLookupSchema.parse({ project_id: projectId, session_id: sessionId });
  return db.transaction(async (tx) => {
    const transactionalDb = tx as unknown as Db;
    const row = await sessionRow(transactionalDb, input.project_id, input.session_id);
    return row ? loadCurrent(transactionalDb, row, nowSeconds()) : null;
  });
}

export async function completeOnboardingProofSession(
  db: Db,
  rawInput: { project_id: string; session_id: string },
): Promise<SafeOnboardingProofSession> {
  return db.transaction((tx) =>
    completeOnboardingProofSessionInTransaction(tx as unknown as Db, rawInput));
}

export async function completeOnboardingProofSessionInTransaction(
  db: OnboardingProofSessionTransaction,
  rawInput: { project_id: string; session_id: string },
): Promise<SafeOnboardingProofSession> {
  const input = SessionLookupSchema.parse(rawInput);
  const row = await sessionRow(db, input.project_id, input.session_id);
  if (!row) throw errors.notFound("onboarding proof session");
  if (row.status === "completed") return safeSession(db, row);
  if (row.status !== "active") throw terminalError(row);
  const at = nowSeconds();
  const current = await loadCurrent(db, row, at);
  if (current.status !== "active") return current;
  return finish(db, row, "completed", "proof_completed", at);
}

export async function revokeOnboardingProofSession(
  db: Db,
  rawInput: { project_id: string; session_id: string; reason: string },
): Promise<SafeOnboardingProofSession> {
  return db.transaction((tx) =>
    revokeOnboardingProofSessionInTransaction(tx as unknown as Db, rawInput));
}

export async function revokeOnboardingProofSessionInTransaction(
  db: OnboardingProofSessionTransaction,
  rawInput: { project_id: string; session_id: string; reason: string },
): Promise<SafeOnboardingProofSession> {
  const input = SessionRevocationSchema.parse(rawInput);
  const row = await sessionRow(db, input.project_id, input.session_id);
  if (!row) throw errors.notFound("onboarding proof session");
  if (row.status === "revoked" && row.terminalReason === input.reason) return safeSession(db, row);
  if (row.status !== "active") throw terminalError(row);
  const at = nowSeconds();
  if (row.expiresAt <= at) return finish(db, row, "expired", "session_expired", at);
  return finish(db, row, "revoked", input.reason, at);
}

export async function restartOnboardingProofSession(
  db: Db,
  rawInput: CreateOnboardingProofSessionInput,
  reason = "proof_restarted",
): Promise<IssuedOnboardingProofSession> {
  return db.transaction((tx) =>
    restartOnboardingProofSessionInTransaction(
      tx as unknown as Db,
      rawInput,
      reason,
    ));
}

export async function restartOnboardingProofSessionInTransaction(
  db: OnboardingProofSessionTransaction,
  rawInput: CreateOnboardingProofSessionInput,
  reason = "proof_restarted",
): Promise<IssuedOnboardingProofSession> {
  const input = CreateOnboardingProofSessionSchema.parse(rawInput);
  const parsedReason = z.string().trim().min(1).max(500).parse(reason);
  const active = await db.select().from(onboardingProofSessions).where(and(
    eq(onboardingProofSessions.projectId, input.project_id),
    eq(onboardingProofSessions.onboardingId, input.onboarding_id),
    eq(onboardingProofSessions.status, "active"),
  ));
  const at = nowSeconds();
  for (const row of active) {
    await finish(
      db,
      row,
      row.expiresAt <= at ? "expired" : "revoked",
      row.expiresAt <= at ? "session_expired" : parsedReason,
      at,
    );
  }
  return createInDb(db, input);
}

function terminalError(row: Pick<SessionRow, "id" | "status">) {
  return errors.conflict(
    row.status === "expired" ? "onboarding_proof_session_expired" : "onboarding_proof_session_terminal",
    `The onboarding proof session is ${row.status}.`,
    "Restart proof to issue a fresh short-lived marker pair.",
    { session_id: row.id, status: row.status },
  );
}
