import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboardingStates, projects, users } from "@agentry/db/schema";
import {
  approveOnboardingV3State,
  createOrReplacePlannedOnboardingV3State,
  loadOnboardingV3State,
  onboardingV3PlanSha256,
  onboardingV3StateEtag,
  recordVerifiedOnboardingV3State,
  startProvingOnboardingV3State,
} from "../src/onboarding-v3-state-store.js";
import {
  disposeTestEnv,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

const BASE = 1_900_000_000;
const OWNER_ID = "onboarding-v3-owner";
const PROJECT_ID = "onboarding-v3-project";

type Db = ReturnType<typeof getDbForUrl>;
let env: TestEnv;
let db: Db;

beforeEach(async () => {
  env = await makeTestEnv();
  db = getDbForUrl(env.TURSO_DATABASE_URL);
  await db.insert(users).values({ id: OWNER_ID, email: "v3@example.test" });
  await db.insert(projects).values({
    id: PROJECT_ID,
    userId: OWNER_ID,
    name: "Onboarding v3",
  });
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS onboarding_states (
      project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      onboarding_id text NOT NULL UNIQUE,
      revision integer NOT NULL,
      status text NOT NULL,
      etag text NOT NULL UNIQUE,
      plan_sha256 text NOT NULL,
      plan_json text NOT NULL,
      implementation_source_snapshot_json text,
      proof_session_json text,
      receipt_json text,
      created_by text NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);
});

afterEach(() => disposeTestEnv(env));

function snapshot(seed: string) {
  return {
    git_head_sha: seed.repeat(40),
    source_fingerprint_sha256: seed.repeat(64),
    source_fingerprint_algorithm: "agentry-source-tree-sha256-v1" as const,
  };
}

function plan(seed = "1") {
  return {
    business_question: `Which workspaces reach durable value? ${seed}`,
    plan_markdown: `Value flow ${seed}: create a workspace and persist its first useful result.`,
    source_snapshot: snapshot(seed),
    historical_evidence: {
      status: "historically_observed" as const,
      source: "posthog_cloud" as const,
      posthog_project_id: 42,
      observed_at: BASE,
      window: { from: BASE - 86_400, to: BASE - 1 },
      query_receipt_sha256: "9".repeat(64),
      observations: [{
        kind: "analytics" as const,
        event: "workspace_created",
        observed_properties: ["workspace_id"],
        row_count: 7,
      }],
    },
    milestones: [{
      event: "workspace_created",
      meaning: "A customer has persisted a usable workspace.",
      posthog_boundary: "server_posthog" as const,
      properties: ["workspace_id"],
      targets: [{ file: "src/workspaces.ts", anchor: "return workspace" }],
    }],
    failures: [{
      marker: "workspace_create_rejected",
      meaning: "Validation or persistence blocked workspace creation.",
      posthog_boundary: "server_posthog" as const,
      context: ["operation"],
      safe_live_proof: true,
      targets: [{ file: "src/workspaces.ts", anchor: "throw createError" }],
    }],
    deploy: {
      environment: "production",
      sha_source: "git_head" as const,
      targets: [{ file: ".github/workflows/deploy.yml", anchor: "deploy" }],
    },
  };
}

function openProofSession() {
  return {
    proof_session_id: "proof-session-v3",
    status: "open" as const,
    started_at: BASE + 2,
    expires_at: BASE + 3_602,
  };
}

function receipt(finalSnapshot = snapshot("2")) {
  return {
    evidence_status: "source_verified" as const,
    source_verified_at: BASE + 3,
    analytics: [{
      event: "workspace_created",
      posthog_boundary: "server_posthog" as const,
      required_properties: ["workspace_id"],
      observed_properties: ["workspace_id", "browser"],
      row_count: 1,
    }],
    error: {
      marker: "workspace_create_rejected",
      posthog_boundary: "server_posthog" as const,
      required_context: ["operation"],
      observed_context: ["operation"],
      row_count: 1,
    },
    deploy: {
      environment: "production",
      source_snapshot: finalSnapshot,
      row_count: 1,
    },
  };
}

async function create() {
  return createOrReplacePlannedOnboardingV3State(db, {
    project_id: PROJECT_ID,
    created_by: OWNER_ID,
    plan: plan(),
    observed_at: BASE,
  });
}

describe("lean onboarding state persistence", () => {
  it("persists exactly planned -> approved -> proving -> verified", async () => {
    const created = await create();
    expect(created.idempotent_replay).toBe(false);
    expect(created.state).toMatchObject({
      status: "planned",
      revision: 1,
      next_action: {
        id: "review_exact_plan",
        operation: {
          method: "POST",
          path: `/v1/projects/${PROJECT_ID}/onboarding/review`,
        },
      },
    });
    expect(Object.keys(created.state).slice(0, 4)).toEqual([
      "status",
      "installation_complete",
      "evidence_status",
      "etag",
    ]);
    expect(created.state.evidence_status).toEqual({
      historical: "historically_observed",
      source: "pending",
    });

    const approved = await approveOnboardingV3State(db, {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: created.state.etag,
      plan_sha256: created.state.plan_sha256,
      observed_at: BASE + 1,
    });
    expect(approved.state).toMatchObject({
      status: "approved",
      revision: 2,
      next_action: {
        id: "instrument_and_start_proof",
        operation: { path: `/v1/projects/${PROJECT_ID}/onboarding/proof` },
      },
    });

    const implementationSnapshot = snapshot("2");
    const proving = await startProvingOnboardingV3State(db, {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: approved.state.etag,
      implementation_source_snapshot: implementationSnapshot,
      proof_session: openProofSession(),
      observed_at: BASE + 2,
    });
    expect(proving.state).toMatchObject({
      status: "proving",
      revision: 3,
      next_action: {
        id: "exercise_and_verify",
        operation: { path: `/v1/projects/${PROJECT_ID}/onboarding/verify` },
      },
    });

    const verified = await recordVerifiedOnboardingV3State(db, {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: proving.state.etag,
      receipt: receipt(implementationSnapshot),
      observed_at: BASE + 3,
    });
    expect(verified.state).toMatchObject({
      status: "verified",
      revision: 4,
      installation_complete: true,
      evidence_status: {
        historical: "historically_observed",
        source: "source_verified",
      },
      receipt: { evidence_status: "source_verified" },
      proof_session: { status: "satisfied" },
    });
    expect(await loadOnboardingV3State(db, PROJECT_ID)).toEqual(verified.state);
  });

  it("replays exact writes without creating revisions", async () => {
    const created = await create();
    const createReplay = await create();
    expect(createReplay).toEqual({ state: created.state, idempotent_replay: true });

    const approvalInput = {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: created.state.etag,
      plan_sha256: created.state.plan_sha256,
      observed_at: BASE + 1,
    };
    const approved = await approveOnboardingV3State(db, approvalInput);
    expect((await approveOnboardingV3State(db, approvalInput)).idempotent_replay).toBe(true);

    const proofInput = {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: approved.state.etag,
      implementation_source_snapshot: snapshot("2"),
      proof_session: openProofSession(),
      observed_at: BASE + 2,
    };
    const proving = await startProvingOnboardingV3State(db, proofInput);
    expect((await startProvingOnboardingV3State(db, proofInput)).idempotent_replay).toBe(true);

    const verifyInput = {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: proving.state.etag,
      receipt: receipt(snapshot("2")),
      observed_at: BASE + 3,
    };
    const verified = await recordVerifiedOnboardingV3State(db, verifyInput);
    expect((await recordVerifiedOnboardingV3State(db, verifyInput))).toEqual({
      state: verified.state,
      idempotent_replay: true,
    });
  });

  it("replaces the current plan from any stage with exact ETag CAS", async () => {
    const created = await create();
    await expect(createOrReplacePlannedOnboardingV3State(db, {
      project_id: PROJECT_ID,
      created_by: OWNER_ID,
      plan: plan("2"),
    })).rejects.toMatchObject({ status: 428, code: "precondition_required" });
    await expect(createOrReplacePlannedOnboardingV3State(db, {
      project_id: PROJECT_ID,
      created_by: OWNER_ID,
      plan: plan("2"),
      expected_etag: '"stale"',
    })).rejects.toMatchObject({ status: 412, code: "precondition_failed" });

    const replaced = await createOrReplacePlannedOnboardingV3State(db, {
      project_id: PROJECT_ID,
      created_by: OWNER_ID,
      plan: plan("2"),
      expected_etag: created.state.etag,
      observed_at: BASE + 1,
    });
    expect(replaced.state).toMatchObject({ status: "planned", revision: 2 });
    expect(replaced.state.onboarding_id).not.toBe(created.state.onboarding_id);
    expect((await createOrReplacePlannedOnboardingV3State(db, {
      project_id: PROJECT_ID,
      created_by: OWNER_ID,
      plan: plan("2"),
    })).idempotent_replay).toBe(true);

    const approved = await approveOnboardingV3State(db, {
      project_id: PROJECT_ID,
      onboarding_id: replaced.state.onboarding_id,
      expected_etag: replaced.state.etag,
      plan_sha256: replaced.state.plan_sha256,
      observed_at: BASE + 2,
    });
    const restarted = await createOrReplacePlannedOnboardingV3State(db, {
      project_id: PROJECT_ID,
      created_by: OWNER_ID,
      plan: plan("3"),
      expected_etag: approved.state.etag,
      observed_at: BASE + 3,
    });
    expect(restarted.state).toMatchObject({ status: "planned", revision: 4 });
    expect(restarted.state.onboarding_id).not.toBe(approved.state.onboarding_id);
  });

  it("requires the exact current plan hash and ETag for approval", async () => {
    const created = await create();
    await expect(approveOnboardingV3State(db, {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: created.state.etag,
      plan_sha256: "f".repeat(64),
    })).rejects.toMatchObject({ status: 409, code: "onboarding_plan_hash_mismatch" });
    await expect(approveOnboardingV3State(db, {
      project_id: PROJECT_ID,
      onboarding_id: created.state.onboarding_id,
      expected_etag: '"stale"',
      plan_sha256: created.state.plan_sha256,
    })).rejects.toMatchObject({ status: 412, code: "precondition_failed" });
  });

  it("uses canonical plan hashes and rejects corrupt persisted hashes", async () => {
    const left = plan();
    const right = JSON.parse(JSON.stringify(left));
    expect(await onboardingV3PlanSha256(left)).toBe(await onboardingV3PlanSha256(right));
    await create();
    await db.update(onboardingStates).set({ planSha256: "f".repeat(64) });
    await expect(loadOnboardingV3State(db, PROJECT_ID)).rejects.toMatchObject({
      status: 500,
      code: "persistence_failed",
    });
  });

  it("keeps the CAS ETag independent of derived next-action copy", async () => {
    const base = {
      status: "planned",
      installation_complete: false,
      next_action: { instruction: "first wording" },
      revision: 1,
    };
    expect(await onboardingV3StateEtag(base)).toBe(await onboardingV3StateEtag({
      ...base,
      next_action: { instruction: "improved wording" },
    }));
  });
});
