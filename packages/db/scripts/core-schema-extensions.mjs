// Historical schema projections retained for reviewed legacy upgrades and
// manifest drift checks. The canonical empty baseline already folds through
// CORE_EMPTY_BOOTSTRAP_FOLDED_THROUGH in the migration manifest.

import { AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_EXTENSION } from "./schema-extensions/20260713_01_automation_workflow_runtime.mjs";
import { POSTHOG_ERROR_TRACKING_SCHEMA_EXTENSION } from "./schema-extensions/20260715_01_posthog_error_tracking.mjs";
import { POSTHOG_OAUTH_CONNECTION_SCHEMA_EXTENSION } from "./schema-extensions/20260715_02_posthog_oauth_connections.mjs";
import { ONBOARDING_POSTHOG_PROOF_SCHEMA_EXTENSION } from "./schema-extensions/20260715_03_onboarding_posthog_proof.mjs";
import { HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_EXTENSION } from "./schema-extensions/20260715_04_hosted_ingest_storage_removal.mjs";
import { READ_ONLY_SCHEMA_HARD_CUT_SCHEMA_EXTENSION } from "./schema-extensions/20260720_01_read_only_schema_hard_cut.mjs";
import { AUTOMATION_WORKFLOW_RUNTIME_HARD_CUT_SCHEMA_EXTENSION } from "./schema-extensions/20260721_01_automation_workflow_runtime_hard_cut.mjs";

export const CORE_SCHEMA_EXTENSIONS = Object.freeze([
  AUTOMATION_WORKFLOW_RUNTIME_SCHEMA_EXTENSION,
  POSTHOG_ERROR_TRACKING_SCHEMA_EXTENSION,
  POSTHOG_OAUTH_CONNECTION_SCHEMA_EXTENSION,
  ONBOARDING_POSTHOG_PROOF_SCHEMA_EXTENSION,
  HOSTED_INGEST_STORAGE_REMOVAL_SCHEMA_EXTENSION,
  READ_ONLY_SCHEMA_HARD_CUT_SCHEMA_EXTENSION,
  AUTOMATION_WORKFLOW_RUNTIME_HARD_CUT_SCHEMA_EXTENSION,
]);

export function assertCoreSchemaExtensionManifest(manifest) {
  const expected = manifest
    .filter((entry) => entry.schemaProjection)
    .map((entry) => ({ id: entry.id, schemaProjection: entry.schemaProjection }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const actual = CORE_SCHEMA_EXTENSIONS
    .map((extension) => ({ id: extension.id, schemaProjection: extension.schemaProjection }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `core schema extension manifest drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
