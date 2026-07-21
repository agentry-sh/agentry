import { createClient } from "@libsql/client";
import {
  automationWorkflowHeadEtag,
  automationWorkflowProjectControlEtag,
} from "@agentrysh/shared";

import {
  READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS,
} from "./schema-extensions/20260720_01_read_only_schema_hard_cut.mjs";

async function tableExists(client: ReturnType<typeof createClient>, table: string) {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length === 1;
}

async function columns(client: ReturnType<typeof createClient>, table: string) {
  const result = await client.execute(`PRAGMA table_info(\"${table.replaceAll('"', '""')}\")`);
  return new Set(result.rows.map((row) => String(row.name)));
}

const POSTHOG_OIDC_HARD_CUT_REASON = "posthog_oidc_hard_cut";

async function closePrecutAuthority(
  client: ReturnType<typeof createClient>,
  now: number,
) {
  if (await tableExists(client, "posthog_oauth_attempts")) {
    await client.execute("DELETE FROM posthog_oauth_attempts");
  }
  if (await tableExists(client, "posthog_connections")) {
    await client.execute("DELETE FROM posthog_connections");
  }
  if (await tableExists(client, "automation_contracts")) {
    await client.execute({
      sql: `UPDATE automation_contracts
               SET enabled = 0, paused_at = ?, pause_reason = ?, updated_at = ?
             WHERE enabled <> 0 OR paused_at IS NULL OR pause_reason IS NOT ?`,
      args: [now, POSTHOG_OIDC_HARD_CUT_REASON, now, POSTHOG_OIDC_HARD_CUT_REASON],
    });
  }
  if (await tableExists(client, "automation_trigger_receipts")) {
    await client.execute({
      sql: `UPDATE automation_trigger_receipts
               SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
             WHERE status = 'ready'`,
      args: [now, POSTHOG_OIDC_HARD_CUT_REASON],
    });
  }
  if (await tableExists(client, "automation_action_grants")) {
    await client.execute(
      "UPDATE automation_action_grants SET status = 'cancelled' WHERE status = 'issued'",
    );
  }

  if (await tableExists(client, "automation_workflow_project_controls")) {
    const controls = await client.execute({
      sql: `SELECT project_id, revision, etag
              FROM automation_workflow_project_controls
             WHERE paused_at IS NULL OR pause_reason IS NOT ?`,
      args: [POSTHOG_OIDC_HARD_CUT_REASON],
    });
    for (const row of controls.rows) {
      const projectId = String(row.project_id);
      const revision = Number(row.revision) + 1;
      const etag = await automationWorkflowProjectControlEtag({
        project_id: projectId,
        revision,
        paused_at: now,
        pause_reason: POSTHOG_OIDC_HARD_CUT_REASON,
        updated_at: now,
      });
      const changed = await client.execute({
        sql: `UPDATE automation_workflow_project_controls
                 SET revision = ?, etag = ?, paused_at = ?, pause_reason = ?, updated_at = ?
               WHERE project_id = ? AND revision = ? AND etag = ?`,
        args: [
          revision,
          etag,
          now,
          POSTHOG_OIDC_HARD_CUT_REASON,
          now,
          projectId,
          Number(row.revision),
          String(row.etag),
        ],
      });
      if (changed.rowsAffected !== 1) {
        throw new Error(`workflow project control changed during hard cut: ${projectId}`);
      }
    }
  }

  if (await tableExists(client, "automation_workflows")) {
    const workflowColumns = await columns(client, "automation_workflows");
    const hasExecutionAuthority = workflowColumns.has("active_execution_authority_id");
    const workflows = await client.execute({
      sql: `SELECT head.project_id, head.automation_id,
                   head.current_revision_id, head.current_revision, head.etag,
                   revision.workflow_hash, revision.compile_hash
              FROM automation_workflows head
              JOIN automation_workflow_revisions revision
                ON revision.id = head.current_revision_id
             WHERE head.enabled <> 0
                OR head.active_revision_id IS NOT NULL
                ${hasExecutionAuthority
                  ? "OR head.active_execution_authority_id IS NOT NULL"
                  : ""}
                OR head.paused_at IS NULL
                OR head.pause_reason IS NOT ?`,
      args: [POSTHOG_OIDC_HARD_CUT_REASON],
    });
    for (const row of workflows.rows) {
      const projectId = String(row.project_id);
      const automationId = String(row.automation_id);
      const etag = await automationWorkflowHeadEtag({
        project_id: projectId,
        automation_id: automationId,
        current_revision_id: String(row.current_revision_id),
        current_revision: Number(row.current_revision),
        workflow_hash: String(row.workflow_hash),
        compile_hash: String(row.compile_hash),
        enabled: false,
        active_revision_id: null,
        active_execution_authority_id: null,
        paused_at: now,
        pause_reason: POSTHOG_OIDC_HARD_CUT_REASON,
        updated_at: now,
      });
      const changed = await client.execute({
        sql: `UPDATE automation_workflows
                 SET enabled = 0, active_revision_id = NULL,
                     ${hasExecutionAuthority ? "active_execution_authority_id = NULL," : ""}
                     etag = ?, paused_at = ?, pause_reason = ?, updated_at = ?
               WHERE project_id = ? AND automation_id = ? AND etag = ?`,
        args: [
          etag,
          now,
          POSTHOG_OIDC_HARD_CUT_REASON,
          now,
          projectId,
          automationId,
          String(row.etag),
        ],
      });
      if (changed.rowsAffected !== 1) {
        throw new Error(`workflow head changed during hard cut: ${projectId}/${automationId}`);
      }
    }
  }
  if (await tableExists(client, "automation_workflow_trigger_receipts")) {
    await client.execute({
      sql: `UPDATE automation_workflow_trigger_receipts
               SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?
             WHERE status = 'ready'`,
      args: [now, POSTHOG_OIDC_HARD_CUT_REASON, now],
    });
  }
  if (await tableExists(client, "project_credentials")) {
    await client.execute({
      sql: `UPDATE project_credentials
               SET revoked_at = ?, revoke_reason = ?
             WHERE kind = 'automation_runner' AND revoked_at IS NULL`,
      args: [now, POSTHOG_OIDC_HARD_CUT_REASON],
    });
  }
  if (await tableExists(client, "api_keys")) {
    await client.execute("DELETE FROM api_keys");
  }

  if (await tableExists(client, "device_codes")) {
    await client.execute("DROP TABLE device_codes");
  }
  // Every pre-cut identity and owner key was deliberately invalidated above,
  // so rebuild the empty identity table to the exact canonical OIDC shape. A
  // conditional keep would preserve SQLite's legacy nullable TEXT PRIMARY KEY
  // and make the production schema differ from a fresh bootstrap.
  if (await tableExists(client, "identities")) {
    await client.execute("DROP TABLE identities");
  }
  await client.execute(`CREATE TABLE \`identities\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`user_id\` text NOT NULL,
	\`issuer\` text NOT NULL,
	\`subject\` text NOT NULL,
	\`email\` text,
	\`email_verified\` integer,
	\`created_at\` integer DEFAULT (unixepoch()) NOT NULL,
	\`updated_at\` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT \`identities_oidc_identity_check\` CHECK(length(\`issuer\`) BETWEEN 8 AND 2048
      AND \`issuer\` LIKE 'https://%'
      AND length(\`subject\`) BETWEEN 1 AND 512
      AND (\`email_verified\` IS NULL OR \`email_verified\` IN (0, 1))
      AND \`updated_at\` >= \`created_at\`),
	FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`);
  await client.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS identities_oidc_subject_idx ON identities (issuer, subject)",
  );
  await client.execute(
    "CREATE INDEX IF NOT EXISTS identities_user_idx ON identities (user_id)",
  );
}

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL not set");

  const client = createClient({ url, authToken });
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await closePrecutAuthority(client, Math.floor(Date.now() / 1_000));

    // Resume the only multi-statement rebuild window before touching tables
    // whose cascade triggers query deploys.
    if (!await tableExists(client, "deploys") && await tableExists(client, "deploys_next")) {
      await client.execute("DROP TRIGGER IF EXISTS automation_runs_deploy_binding_update_guard");
      await client.execute("DROP TRIGGER IF EXISTS automation_runs_deploy_binding_delete_cleanup");
      await client.execute("ALTER TABLE deploys_next RENAME TO deploys");
      await client.execute(
        "CREATE INDEX IF NOT EXISTS deploys_proj_time_idx ON deploys (project_id, received_at)",
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS deploys_automation_run_idx ON deploys (automation_run_id, received_at)",
      );
      await client.execute(
        `CREATE INDEX IF NOT EXISTS deploys_onboarding_proof_idx
          ON deploys (project_id, onboarding_proof_session_id, credential_id, received_at)`,
      );
    }

    // Raw pre-cut projections and agent-run archives are replaceable. Clearing
    // them lets PostHog repopulate the thin current projection without
    // manufacturing provenance for historical Agentry-ingest rows.
    if (await tableExists(client, "cases")) {
      await client.execute("DELETE FROM cases");
    }
    if (await tableExists(client, "agent_runs")) {
      await client.execute("DROP TABLE agent_runs");
    }

    if (await tableExists(client, "project_credentials")) {
      const invalidCredential =
        "SELECT id FROM project_credentials WHERE kind NOT IN ('ci_deploy', 'automation_runner')";
      if (await tableExists(client, "automation_runs")) {
        await client.execute(
          `UPDATE automation_runs SET runner_credential_id = NULL
            WHERE runner_credential_id IN (${invalidCredential})`,
        );
        await client.execute(
          `UPDATE automation_runs SET pr_proof_credential_id = NULL
            WHERE pr_proof_credential_id IN (${invalidCredential})`,
        );
      }
      if (await tableExists(client, "automation_action_grants")) {
        await client.execute(
          `UPDATE automation_action_grants SET credential_id = NULL
            WHERE credential_id IN (${invalidCredential})`,
        );
      }
      if (await tableExists(client, "onboarding_proof_sessions")) {
        await client.execute(
          `DELETE FROM onboarding_proof_sessions
            WHERE ci_credential_id IN (${invalidCredential})`,
        );
      }
      if (await tableExists(client, "deploys")) {
        await client.execute(
          `DELETE FROM deploys
            WHERE trust_level <> 'trusted_ci'
               OR credential_kind <> 'ci_deploy'
               OR credential_id IS NULL
               OR credential_id IN (${invalidCredential})`,
        );
      }
      await client.execute(
        "DELETE FROM project_credentials WHERE kind NOT IN ('ci_deploy', 'automation_runner')",
      );
    }

    // Remove the impossible PostHog-OAuth -> CI/runner foreign-key alias and
    // make every surviving case a bounded, source-attributed PostHog row.
    if (await tableExists(client, "cases")) {
      const names = await columns(client, "cases");
      if (
        names.has("last_credential_id") ||
        !names.has("provider_issue_id") ||
        !names.has("provider_event_classification")
      ) {
        await client.execute("PRAGMA foreign_keys = OFF");
        await client.execute("DROP TABLE cases");
        await client.execute(`CREATE TABLE cases (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          provider_issue_id text NOT NULL,
          provider_snapshot_hash text NOT NULL,
          provider_projected_at integer NOT NULL,
          last_provider_event_id text,
          provider_event_classification text NOT NULL DEFAULT 'unclassified',
          fingerprint text NOT NULL,
          error_type text NOT NULL,
          message text NOT NULL,
          status text NOT NULL DEFAULT 'active',
          event_count integer NOT NULL DEFAULT 0,
          first_seen_at integer NOT NULL DEFAULT (unixepoch()),
          last_seen_at integer NOT NULL DEFAULT (unixepoch()),
          last_deploy_sha text,
          last_environment text,
          agent_summary text,
          pr_url text,
          last_trust_level text NOT NULL DEFAULT 'customer_posthog',
          last_credential_kind text NOT NULL DEFAULT 'posthog_oauth',
          revision integer NOT NULL DEFAULT 1,
          CONSTRAINT cases_provider_projection_check CHECK (
            status IN ('active', 'resolved', 'suppressed')
            AND length(provider_snapshot_hash) = 64
            AND provider_snapshot_hash NOT GLOB '*[^a-f0-9]*'
            AND provider_projected_at > 0
            AND event_count >= 0
            AND first_seen_at >= 0
            AND last_seen_at >= first_seen_at
            AND provider_event_classification IN (
              'unclassified', 'customer_exception', 'onboarding_proof_exception'
            )
            AND last_trust_level = 'customer_posthog'
            AND last_credential_kind = 'posthog_oauth'
            AND revision >= 1
          )
        )`);
        await client.execute(
          "CREATE UNIQUE INDEX cases_provider_issue_idx ON cases (project_id, provider_issue_id)",
        );
        await client.execute(
          "CREATE UNIQUE INDEX cases_proj_fp_idx ON cases (project_id, fingerprint)",
        );
        await client.execute(
          `CREATE INDEX cases_proj_status_idx
            ON cases (project_id, provider_event_classification, status, last_seen_at)`,
        );
        await client.execute("PRAGMA foreign_keys = ON");
      }
    }

    // A deploy without credential-bound CI provenance is not retained as a
    // weaker compatibility row. Rebuild once to remove nullable/defaulted
    // legacy authority fields while preserving exact trusted receipts.
    if (!await tableExists(client, "deploys") && await tableExists(client, "deploys_next")) {
      await client.execute("DROP TRIGGER IF EXISTS automation_runs_deploy_binding_update_guard");
      await client.execute("DROP TRIGGER IF EXISTS automation_runs_deploy_binding_delete_cleanup");
      await client.execute("ALTER TABLE deploys_next RENAME TO deploys");
      await client.execute(
        "CREATE INDEX IF NOT EXISTS deploys_proj_time_idx ON deploys (project_id, received_at)",
      );
      await client.execute(
        "CREATE INDEX IF NOT EXISTS deploys_automation_run_idx ON deploys (automation_run_id, received_at)",
      );
      await client.execute(
        `CREATE INDEX IF NOT EXISTS deploys_onboarding_proof_idx
          ON deploys (project_id, onboarding_proof_session_id, credential_id, received_at)`,
      );
    }
    if (await tableExists(client, "deploys")) {
      if (await tableExists(client, "deploys_next")) {
        await client.execute("DROP TABLE deploys_next");
      }
      const deployColumns = await columns(client, "deploys");
      const credentialColumn = (
        await client.execute("PRAGMA table_info(deploys)")
      ).rows.find((row) => String(row.name) === "credential_id");
      const needsRebuild =
        !deployColumns.has("credential_id") ||
        Number(credentialColumn?.notnull ?? 0) !== 1;
      if (needsRebuild) {
        await client.execute("DROP TRIGGER IF EXISTS automation_runs_deploy_binding_update_guard");
        await client.execute("DROP TRIGGER IF EXISTS automation_runs_deploy_binding_delete_cleanup");
        await client.execute("PRAGMA foreign_keys = OFF");
        await client.execute(`CREATE TABLE deploys_next (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          sha text NOT NULL,
          branch text,
          environment text,
          message text,
          url text,
          actor text,
          automation_run_id text REFERENCES automation_runs(id) ON DELETE SET NULL,
          source_commit_sha text,
          extra_json text,
          trust_level text NOT NULL,
          credential_kind text NOT NULL,
          credential_id text NOT NULL REFERENCES project_credentials(id) ON DELETE RESTRICT,
          onboarding_proof_session_id text REFERENCES onboarding_proof_sessions(id) ON DELETE SET NULL,
          onboarding_proof_credential_id text,
          received_at integer NOT NULL DEFAULT (unixepoch())
        )`);
        await client.execute(`INSERT INTO deploys_next (
          id, project_id, sha, branch, environment, message, url, actor,
          automation_run_id, source_commit_sha, extra_json, trust_level,
          credential_kind, credential_id, onboarding_proof_session_id,
          onboarding_proof_credential_id, received_at
        ) SELECT
          id, project_id, sha, branch, environment, message, url, actor,
          automation_run_id, source_commit_sha, extra_json, trust_level,
          credential_kind, credential_id, onboarding_proof_session_id,
          onboarding_proof_credential_id, received_at
        FROM deploys
        WHERE trust_level = 'trusted_ci'
          AND credential_kind = 'ci_deploy'
          AND credential_id IS NOT NULL`);
        await client.execute("DROP TABLE deploys");
        await client.execute("ALTER TABLE deploys_next RENAME TO deploys");
        await client.execute(
          "CREATE INDEX deploys_proj_time_idx ON deploys (project_id, received_at)",
        );
        await client.execute(
          "CREATE INDEX deploys_automation_run_idx ON deploys (automation_run_id, received_at)",
        );
        await client.execute(
          `CREATE INDEX deploys_onboarding_proof_idx
            ON deploys (project_id, onboarding_proof_session_id, credential_id, received_at)`,
        );
        await client.execute("PRAGMA foreign_keys = ON");
      }
    }

    for (const statement of READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS) {
      await client.execute(statement);
    }

    const foreignKeys = await client.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length > 0) {
      throw new Error(
        `read-only schema hard cut left ${foreignKeys.rows.length} foreign-key violation(s)`,
      );
    }
    console.log(JSON.stringify({
      migration: "read_only_schema_hard_cut",
      case_authority: "customer_posthog_projection",
      deploy_authority: "trusted_ci_only",
      credential_kinds: ["private", "ci_deploy", "automation_runner"],
    }));
  } finally {
    client.close();
  }
}

await main();
