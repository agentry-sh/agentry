// Canonical hard cut after the PostHog OAuth and hosted-ingest removal
// migrations. Fresh bootstraps already contain this shape; reviewed legacy
// databases execute these statements to discard replaceable pre-cut state and
// install the read-only control-plane authority guards.

export const READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS = Object.freeze([
  `DROP TRIGGER IF EXISTS api_keys_private_kind_insert_guard`,
  `CREATE TRIGGER api_keys_private_kind_insert_guard
    BEFORE INSERT ON api_keys
    WHEN NEW.kind IS NOT 'private'
      OR NEW.prefix NOT LIKE 'agentry_sk_%'
    BEGIN
      SELECT RAISE(ABORT, 'api key must be a private Agentry owner/member credential');
    END`,
  `DROP TRIGGER IF EXISTS api_keys_private_kind_update_guard`,
  `CREATE TRIGGER api_keys_private_kind_update_guard
    BEFORE UPDATE OF kind, prefix ON api_keys
    WHEN NEW.kind IS NOT 'private'
      OR NEW.prefix NOT LIKE 'agentry_sk_%'
    BEGIN
      SELECT RAISE(ABORT, 'api key must be a private Agentry owner/member credential');
    END`,
  `DROP TRIGGER IF EXISTS project_credentials_required_fields_insert_guard`,
  `CREATE TRIGGER project_credentials_required_fields_insert_guard
    BEFORE INSERT ON project_credentials
    WHEN NEW.id IS NULL OR trim(NEW.id) = ''
      OR NEW.project_id IS NULL OR trim(NEW.project_id) = ''
      OR NEW.kind NOT IN ('ci_deploy', 'automation_runner')
      OR NEW.name IS NULL OR trim(NEW.name) = ''
      OR NEW.prefix IS NULL OR trim(NEW.prefix) = ''
      OR NEW.token_hash IS NULL OR trim(NEW.token_hash) = ''
      OR (NEW.kind = 'ci_deploy' AND (
        NEW.prefix NOT LIKE 'agentry_ci_%' OR NEW.automation_id IS NOT NULL))
      OR (NEW.kind = 'automation_runner' AND (
        NEW.prefix NOT LIKE 'agentry_runner_%'
        OR NEW.automation_id IS NULL OR trim(NEW.automation_id) = ''))
      OR NEW.created_at IS NULL OR NEW.expires_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'project credential requires complete scoped CI or runner authority fields');
    END`,
  `DROP TRIGGER IF EXISTS project_credentials_required_fields_update_guard`,
  `CREATE TRIGGER project_credentials_required_fields_update_guard
    BEFORE UPDATE OF id, project_id, kind, name, prefix, token_hash, automation_id, created_at, expires_at
    ON project_credentials
    WHEN NEW.id IS NULL OR trim(NEW.id) = ''
      OR NEW.project_id IS NULL OR trim(NEW.project_id) = ''
      OR NEW.kind NOT IN ('ci_deploy', 'automation_runner')
      OR NEW.name IS NULL OR trim(NEW.name) = ''
      OR NEW.prefix IS NULL OR trim(NEW.prefix) = ''
      OR NEW.token_hash IS NULL OR trim(NEW.token_hash) = ''
      OR (NEW.kind = 'ci_deploy' AND (
        NEW.prefix NOT LIKE 'agentry_ci_%' OR NEW.automation_id IS NOT NULL))
      OR (NEW.kind = 'automation_runner' AND (
        NEW.prefix NOT LIKE 'agentry_runner_%'
        OR NEW.automation_id IS NULL OR trim(NEW.automation_id) = ''))
      OR NEW.created_at IS NULL OR NEW.expires_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'project credential requires complete scoped CI or runner authority fields');
    END`,
  `DROP TRIGGER IF EXISTS automation_runs_deploy_binding_update_guard`,
  `CREATE TRIGGER automation_runs_deploy_binding_update_guard
    BEFORE UPDATE OF project_id, commit_sha, deploy_sha, pr_proof_hash, pr_proof_credential_id
    ON automation_runs
    WHEN EXISTS (
      SELECT 1 FROM deploys deploy
       WHERE deploy.automation_run_id = OLD.id
    ) AND (
      NEW.project_id IS NOT OLD.project_id
      OR NEW.commit_sha IS NOT OLD.commit_sha
      OR NEW.deploy_sha IS NOT OLD.deploy_sha
      OR NEW.pr_proof_hash IS NOT OLD.pr_proof_hash
      OR NEW.pr_proof_credential_id IS NOT OLD.pr_proof_credential_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'automation run deploy proof is immutable after binding');
    END`,
  `DROP TRIGGER IF EXISTS automation_runs_deploy_binding_delete_cleanup`,
  `CREATE TRIGGER automation_runs_deploy_binding_delete_cleanup
    BEFORE DELETE ON automation_runs
    BEGIN
      UPDATE deploys
         SET automation_run_id = NULL,
             source_commit_sha = NULL
       WHERE automation_run_id = OLD.id;
    END`,
  `DROP TRIGGER IF EXISTS deploys_automation_binding_insert_guard`,
  `CREATE TRIGGER deploys_automation_binding_insert_guard
    BEFORE INSERT ON deploys
    WHEN (NEW.automation_run_id IS NULL) IS NOT (NEW.source_commit_sha IS NULL)
      OR (
        NEW.automation_run_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM automation_runs run
           WHERE run.id = NEW.automation_run_id
             AND run.project_id IS NEW.project_id
             AND run.commit_sha IS NEW.source_commit_sha
             AND run.deploy_sha IS NEW.sha
             AND run.pr_proof_hash IS NOT NULL
             AND trim(run.pr_proof_hash) <> ''
             AND run.pr_proof_credential_id IS NOT NULL
             AND NEW.trust_level IS 'trusted_ci'
             AND NEW.credential_kind IS 'ci_deploy'
             AND EXISTS (
               SELECT 1 FROM project_credentials deploy_credential
                WHERE deploy_credential.id = NEW.credential_id
                  AND deploy_credential.project_id = NEW.project_id
                  AND deploy_credential.kind = 'ci_deploy'
                  AND deploy_credential.token_hash NOT LIKE 'legacy-disabled:%'
             )
             AND EXISTS (
               SELECT 1 FROM project_credentials proof_credential
                WHERE proof_credential.id = run.pr_proof_credential_id
                  AND proof_credential.project_id = run.project_id
                  AND proof_credential.kind = 'ci_deploy'
                  AND proof_credential.token_hash NOT LIKE 'legacy-disabled:%'
             )
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'deploy automation binding must match exact trusted CI run proof');
    END`,
  `DROP TRIGGER IF EXISTS deploys_automation_binding_update_guard`,
  `CREATE TRIGGER deploys_automation_binding_update_guard
    BEFORE UPDATE OF automation_run_id, source_commit_sha ON deploys
    WHEN NOT (
      NEW.automation_run_id IS OLD.automation_run_id
      AND NEW.source_commit_sha IS OLD.source_commit_sha
    ) AND NOT (
      NEW.automation_run_id IS NULL
      AND NEW.source_commit_sha IS NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'deploy automation binding is immutable');
    END`,
  `DROP TRIGGER IF EXISTS deploys_provenance_insert_guard`,
  `CREATE TRIGGER deploys_provenance_insert_guard
    BEFORE INSERT ON deploys
    WHEN NEW.trust_level IS NOT 'trusted_ci'
      OR NEW.credential_kind IS NOT 'ci_deploy'
      OR NEW.credential_id IS NULL
      OR NOT EXISTS (
        SELECT 1
          FROM project_credentials credential
         WHERE credential.id = NEW.credential_id
           AND credential.project_id = NEW.project_id
           AND credential.kind = 'ci_deploy'
           AND credential.revoked_at IS NULL
           AND credential.expires_at > unixepoch()
      )
    BEGIN
      SELECT RAISE(ABORT, 'deploy provenance must match an exact active scoped CI credential');
    END`,
  `DROP TRIGGER IF EXISTS deploys_provenance_update_guard`,
  `CREATE TRIGGER deploys_provenance_update_guard
    BEFORE UPDATE OF project_id, trust_level, credential_kind, credential_id ON deploys
    WHEN NEW.project_id IS NOT OLD.project_id
      OR NEW.trust_level IS NOT OLD.trust_level
      OR NEW.credential_kind IS NOT OLD.credential_kind
      OR NEW.credential_id IS NOT OLD.credential_id
    BEGIN
      SELECT RAISE(ABORT, 'trusted CI deploy provenance is immutable');
    END`,
]);

export const READ_ONLY_SCHEMA_HARD_CUT_SCHEMA_EXTENSION = Object.freeze({
  id: "20260720_01_read_only_schema_hard_cut",
  schemaProjection:
    "scripts/schema-extensions/20260720_01_read_only_schema_hard_cut.mjs",
  statements: READ_ONLY_SCHEMA_HARD_CUT_TRIGGER_STATEMENTS,
  tables: Object.freeze(["api_keys", "cases", "deploys", "project_credentials"]),
});
