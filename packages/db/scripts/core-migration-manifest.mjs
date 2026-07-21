// Product-database migrations are an append-only release artifact.
//
// Rules:
// - Never reorder, remove, or edit an entry after it has shipped.
// - Never edit a shipped migration script. Add a new script and append it here.
// - The coordinator records a SHA-256 of each script and rejects drift.

export const CORE_MIGRATIONS = Object.freeze([
  {
    id: "20260510_01_deploy_extras",
    script: "scripts/migrate-add-deploy-extras.ts",
  },
  {
    id: "20260513_01_sourcemap_index",
    script: "scripts/migrate-add-sourcemaps.ts",
  },
  {
    id: "20260515_01_legacy_audit_log",
    script: "scripts/migrate-add-audit-log.ts",
  },
  {
    id: "20260515_02_plan_and_usage_snapshots",
    script: "scripts/migrate-add-plan-and-snapshots.ts",
  },
  {
    id: "20260515_03_public_keys",
    script: "scripts/migrate-add-public-keys.ts",
  },
  {
    id: "20260518_01_multi_provider_auth",
    script: "scripts/migrate-add-multi-provider-auth.ts",
  },
  {
    id: "20260602_01_feedback_fingerprint",
    script: "scripts/migrate-add-feedback-fingerprint.ts",
  },
  {
    id: "20260610_01_billing_columns",
    script: "scripts/migrate-add-billing-columns.ts",
  },
  {
    id: "20260610_02_project_secrets",
    script: "scripts/migrate-add-project-secrets.ts",
  },
  {
    id: "20260704_01_webhook_secret_recovery",
    script: "scripts/migrate-add-webhook-secret-columns.ts",
  },
  {
    id: "20260710_01_durable_audit_log",
    script: "scripts/migrate-durable-audit-log.ts",
  },
  {
    id: "20260710_02_automation_foundations",
    script: "scripts/migrate-add-automation-foundations.ts",
  },
  {
    id: "20260710_03_signal_provenance",
    script: "scripts/migrate-add-signal-provenance.ts",
  },
  {
    id: "20260710_04_automation_orchestration",
    script: "scripts/migrate-add-automation-orchestration.ts",
  },
  {
    id: "20260710_05_mutation_commands",
    script: "scripts/migrate-add-mutation-commands.ts",
  },
  {
    id: "20260710_06_billing_safety",
    script: "scripts/migrate-add-billing-safety.ts",
  },
  {
    id: "20260710_07_sourcemap_commands",
    script: "scripts/migrate-add-sourcemap-commands.ts",
  },
  {
    id: "20260710_08_posthog_binding_guards",
    script: "scripts/migrate-add-posthog-binding-guards.ts",
    postCheck: "posthog_org_attested",
  },
  {
    // Foundation convergence is deliberately a separate ledger entry. It
    // installs connected guards that only become possible after provenance
    // and orchestration tables exist.
    id: "20260710_09_automation_foundation_convergence",
    script: "scripts/migrate-add-automation-foundations.ts",
  },
  {
    // Forward repair for binding-guard releases that could attest host/org
    // while leaving the distinct PostHog project-resource identity NULL.
    id: "20260710_10_posthog_binding_resource_identity",
    script: "scripts/migrate-add-posthog-binding-resource-identities.ts",
    postCheck: "posthog_binding_identity_attested",
  },
  {
    id: "20260710_11_install_plan_revisions",
    script: "scripts/migrate-add-install-plan-revisions.ts",
  },
  {
    id: "20260710_12_lean_onboarding",
    script: "scripts/migrate-simplify-onboarding.ts",
  },
  {
    id: "20260712_01_automation_scheduler_cursors",
    script: "scripts/migrate-add-automation-scheduler-cursors.ts",
  },
  {
    id: "20260713_01_automation_workflow_runtime",
    script: "scripts/migrate-add-automation-workflow-runtime.ts",
    schemaProjection: "scripts/schema-extensions/20260713_01_automation_workflow_runtime.mjs",
  },
  {
    id: "20260715_01_posthog_error_tracking",
    script: "scripts/migrate-add-posthog-error-tracking.ts",
    schemaProjection: "scripts/schema-extensions/20260715_01_posthog_error_tracking.mjs",
  },
  {
    id: "20260715_02_posthog_oauth_connections",
    script: "scripts/migrate-add-posthog-oauth-connections.ts",
    schemaProjection: "scripts/schema-extensions/20260715_02_posthog_oauth_connections.mjs",
  },
  {
    id: "20260715_03_onboarding_posthog_proof",
    script: "scripts/migrate-onboarding-posthog-proof.ts",
    schemaProjection: "scripts/schema-extensions/20260715_03_onboarding_posthog_proof.mjs",
  },
  {
    id: "20260715_04_hosted_ingest_storage_removal",
    script: "scripts/migrate-remove-hosted-ingest-storage.ts",
    schemaProjection: "scripts/schema-extensions/20260715_04_hosted_ingest_storage_removal.mjs",
    postCheck: "hosted_ingest_storage_removed",
  },
  {
    id: "20260720_01_read_only_schema_hard_cut",
    script: "scripts/migrate-read-only-schema-hard-cut.ts",
    schemaProjection: "scripts/schema-extensions/20260720_01_read_only_schema_hard_cut.mjs",
    postCheck: "read_only_schema_hard_cut",
  },
  {
    id: "20260721_01_automation_workflow_runtime_hard_cut",
    script: "scripts/migrate-automation-workflow-runtime-hard-cut.ts",
    schemaProjection:
      "scripts/schema-extensions/20260721_01_automation_workflow_runtime_hard_cut.mjs",
  },
]);

// The generated empty bootstrap is the exact schema after this migration.
// Its coordinator records this historical prefix without executing the old
// scripts. Reviewed legacy databases still execute every unapplied entry.
export const CORE_EMPTY_BOOTSTRAP_FOLDED_THROUGH =
  "20260721_01_automation_workflow_runtime_hard_cut";
