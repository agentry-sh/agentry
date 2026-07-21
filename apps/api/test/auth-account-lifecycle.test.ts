import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiKeys,
  auditLog,
  mutationCommands,
  posthogConnections,
  projects,
  users,
} from "@agentry/db/schema";
import {
  createTestProjectCredential,
  getDbForUrl,
  makeTestEnv,
  type TestEnv,
} from "./setup.js";

vi.mock("../src/db.js", async () => {
  const { getDbForUrl } = await import("./setup.js");
  return {
    getDb: (env: { TURSO_DATABASE_URL: string }) =>
      getDbForUrl(env.TURSO_DATABASE_URL),
  };
});

const { createApp } = await import("../src/index.js");

let env: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  env = await makeTestEnv({ fileDb: true });
  app = createApp();
});

async function call(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return app.fetch(
    new Request(`http://test${path}`, {
      method: init?.method ?? "GET",
      headers,
      body,
    }),
    env,
  );
}

describe("auth account lifecycle preflight", () => {
  it("creates a fresh account, mints keys, rotates the key, creates a project, and self-deletes", async () => {
    const login = await call("/v1/auth/_test/login", {
      method: "POST",
      json: {
        email: "hosted-lifecycle+beta-soak-account-lifecycle@agentry.test",
      },
    });
    expect(login.status).toBe(200);
    const pollJson = (await login.json()) as {
      api_key: string;
      user_id: string;
    };
    expect(pollJson.api_key).toMatch(/^agentry_sk_/);
    expect(pollJson).not.toHaveProperty("public_api_key");
    expect(pollJson.user_id).toBeTruthy();

    const me = await call("/v1/me", {
      headers: { authorization: `Bearer ${pollJson.api_key}` },
    });
    expect(me.status).toBe(200);

    const rotate = await call("/v1/auth/keys/rotate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${pollJson.api_key}`,
        "idempotency-key": "account-lifecycle-owner-key-rotate",
      },
    });
    expect(rotate.status).toBe(200);
    const rotateJson = (await rotate.json()) as {
      api_key: string;
      user_id: string;
      previous_key_id: string;
    };
    expect(rotateJson.api_key).toMatch(/^agentry_sk_/);
    expect(rotateJson.api_key).not.toBe(pollJson.api_key);
    expect(rotateJson.user_id).toBe(pollJson.user_id);

    const oldKeyProjects = await call("/v1/projects", {
      headers: { authorization: `Bearer ${pollJson.api_key}` },
    });
    expect(oldKeyProjects.status).toBe(200);

    const newKeyProjects = await call("/v1/projects", {
      headers: { authorization: `Bearer ${rotateJson.api_key}` },
    });
    expect(newKeyProjects.status).toBe(200);

    const revokeOld = await call(`/v1/auth/keys/${rotateJson.previous_key_id}/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotateJson.api_key}`,
        "idempotency-key": "account-lifecycle-owner-key-revoke-old",
      },
      json: { reason: "Replacement verified by lifecycle test." },
    });
    expect(revokeOld.status).toBe(200);
    expect((await call("/v1/projects", {
      headers: { authorization: `Bearer ${pollJson.api_key}` },
    })).status).toBe(401);

    const project = await call("/v1/projects", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotateJson.api_key}`,
        "idempotency-key": "account-lifecycle-project-create",
      },
      json: {
        name: "beta soak account lifecycle project",
        repo_url: "https://example.com/agentry/account-lifecycle",
      },
    });
    expect(project.status).toBe(200);
    const projectJson = (await project.json()) as Record<string, unknown> & { id: string };
    expect(projectJson.id).toBeTruthy();
    expect(projectJson).not.toHaveProperty("public_api_key");
    expect(projectJson).not.toHaveProperty("analytics");
    expect(String(projectJson.next_action)).toContain("PostHog OAuth");
    const connectedAt = Math.floor(Date.now() / 1000);
    await getDbForUrl(env.TURSO_DATABASE_URL).insert(posthogConnections).values({
      id: crypto.randomUUID(),
      projectId: projectJson.id,
      authorizedByUserId: pollJson.user_id,
      oauthClientId: "https://api.agentry.sh/v1/integrations/posthog/oauth/client",
      status: "active",
      accessTokenCiphertext: "encrypted-access-token",
      accessTokenIv: "access-iv",
      refreshTokenCiphertext: "encrypted-refresh-token",
      refreshTokenIv: "refresh-iv",
      accessTokenExpiresAt: connectedAt + 3_600,
      grantedScopesJson: JSON.stringify([
        "project:read",
        "query:read",
        "event_definition:read",
        "property_definition:read",
        "error_tracking:read",
        "session_recording:read",
        "feature_flag:read",
        "survey:read",
        "experiment:read",
      ]),
      posthogHost: "https://us.posthog.com",
      posthogRegion: "us",
      posthogOrganizationId: "org_customer",
      posthogEnvironmentId: 5252,
      capabilitySnapshotJson: JSON.stringify({
        version: "posthog-cloud-read-v2",
        checked_at: connectedAt,
        project_read: true,
        query_read: true,
        error_tracking_read: true,
        event_definitions_read: true,
        property_definitions_read: true,
        session_recordings_read: true,
        feature_flags_read: true,
        surveys_read: true,
        experiments_read: true,
        issues: [],
      }),
      capabilitiesObservedAt: connectedAt,
      authorizedAt: connectedAt,
      lastVerifiedAt: connectedAt,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    });
    await createTestProjectCredential(
      env,
      projectJson.id,
      "automation_runner",
      "external_schedule",
    );

    const wrongConfirm = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: { authorization: `Bearer ${rotateJson.api_key}` },
      json: { confirm: "NOPE" },
    });
    expect(wrongConfirm.status).toBe(400);
    expect(await wrongConfirm.json()).toMatchObject({
      error: {
        details: {
          confirmation: "DELETE_AGENTRY_ACCOUNT",
          retains: expect.arrayContaining(["customer-owned PostHog projects and data"]),
        },
      },
    });

    const deleted = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotateJson.api_key}`,
        "idempotency-key": "account-lifecycle-self-delete",
      },
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(deleted.status).toBe(200);
    const deletedJson = (await deleted.json()) as {
      status: string;
      command_id: string;
      user_id: string;
      cascaded: { projects: number; api_keys: number };
      cleanup: {
        customer_posthog_data_affected: boolean;
        automation_deletion_manifest: {
          counts: { active_runner_credentials: number };
          external_follow_up: {
            required: boolean;
            provider_state_reversible_by_agentry: boolean;
            actions: string[];
          };
        };
      };
    };
    expect(deletedJson.status).toBe("deleted");
    expect(deletedJson.user_id).toBe(pollJson.user_id);
    expect(deletedJson.cascaded.projects).toBe(1);
    expect(deletedJson.cascaded.api_keys).toBeGreaterThanOrEqual(2);
    expect(deletedJson.cleanup.customer_posthog_data_affected).toBe(false);
    expect(deletedJson.cleanup).not.toHaveProperty("posthog_operations");
    expect(deletedJson.cleanup).not.toHaveProperty("posthog_external_follow_up");
    expect(deletedJson.cleanup).not.toHaveProperty("external_provider_follow_up");
    expect(deletedJson.cleanup.automation_deletion_manifest).toMatchObject({
      counts: { active_runner_credentials: 1 },
      external_follow_up: {
        required: true,
        provider_state_reversible_by_agentry: false,
      },
    });
    expect(deletedJson.cleanup.automation_deletion_manifest.external_follow_up.actions.join(" "))
      .toContain("customer scheduler invoking Codex CLI or Claude Code");

    // Simulate loss of the terminal response. The revoked old credential plus
    // exact confirmation/idempotency evidence can recover only the immutable
    // cleanup manifest; it does not restore account or project authority.
    const recovered = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotateJson.api_key}`,
        "idempotency-key": "account-lifecycle-self-delete",
      },
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      status: "deleted",
      command_id: deletedJson.command_id,
      idempotent_replay: true,
      receipt_recovery: {
        authority: "terminal_manifest_only",
        account_authority_restored: false,
        project_authority_restored: false,
      },
      cleanup: {
        automation_deletion_manifest: deletedJson.cleanup.automation_deletion_manifest,
      },
    });

    const changedEvidence = await call("/v1/auth/self_delete", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotateJson.api_key}`,
        "idempotency-key": "account-lifecycle-other-delete",
      },
      json: { confirm: "DELETE_AGENTRY_ACCOUNT" },
    });
    expect(changedEvidence.status).toBe(401);

    const deletedKeyProjects = await call("/v1/projects", {
      headers: { authorization: `Bearer ${rotateJson.api_key}` },
    });
    expect(deletedKeyProjects.status).toBe(401);

    const db = getDbForUrl(env.TURSO_DATABASE_URL);
    const [userRows, projectRows, keyRows, connectionRows, deletionReceipts, deletionAudits] = await Promise.all([
      db.select().from(users),
      db.select().from(projects),
      db.select().from(apiKeys),
      db.select().from(posthogConnections),
      db.select().from(mutationCommands),
      db.select().from(auditLog),
    ]);
    expect(userRows).toHaveLength(0);
    expect(projectRows).toHaveLength(0);
    expect(keyRows).toHaveLength(0);
    expect(connectionRows).toHaveLength(0);
    expect(deletionReceipts).toHaveLength(1);
    expect(deletionReceipts[0]).toMatchObject({
      action: "account.self_delete",
      status: "succeeded",
      resourceType: "account_deletion_receipt",
    });
    expect(deletionAudits.filter((row) => row.action === "account.deleted").map(
      (row) => row.phase,
    ).sort()).toEqual(["intent", "succeeded"]);
    expect(deletionAudits.find(
      (row) => row.action === "account.deleted" && row.phase === "succeeded",
    )?.metadataJson).toContain('"customer_posthog_data_affected":false');
  });
});
