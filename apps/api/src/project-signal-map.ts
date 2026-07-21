import { eq } from "drizzle-orm";
import { projectSignalMaps } from "@agentry/db/schema";
import type { getDb } from "./db.js";

const CREATE_PROJECT_SIGNAL_MAPS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS project_signal_maps (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  plan_id text REFERENCES project_install_plans(id) ON DELETE RESTRICT,
  plan_revision integer,
  signal_map_etag text,
  repo_snapshot_json text,
  approval_kind text,
  approved_by text REFERENCES users(id) ON DELETE RESTRICT,
  contract_version text NOT NULL,
  framework text NOT NULL,
  surface text NOT NULL,
  signal_types_json text NOT NULL DEFAULT '[]',
  shapes_json text NOT NULL DEFAULT '[]',
  has_revenue integer NOT NULL DEFAULT 0,
  is_b2b integer NOT NULL DEFAULT 0,
  is_two_sided integer NOT NULL DEFAULT 0,
  mode text,
  approved_events_json text NOT NULL DEFAULT '[]',
  approved_event_properties_json text NOT NULL DEFAULT '{}',
  provider_satisfied_events_json text NOT NULL DEFAULT '[]',
  discovery_map_json text NOT NULL DEFAULT '{}',
  event_buckets_json text NOT NULL DEFAULT '[]',
  happy_path_funnel_json text NOT NULL DEFAULT '[]',
  failure_surface_map_json text NOT NULL DEFAULT '[]',
  planned_wiring_map_json text NOT NULL DEFAULT '[]',
  questions_to_answer_json text NOT NULL DEFAULT '[]',
  post_setup_blueprint_json text NOT NULL DEFAULT '{}',
  recipe_decisions_json text NOT NULL DEFAULT '[]',
  approval_notes_json text NOT NULL DEFAULT '[]',
  approved_plan_hash text NOT NULL,
  approved_at integer NOT NULL,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
)`;

const CREATE_PROJECT_SIGNAL_MAPS_APPROVED_AT_IDX_SQL =
  "CREATE INDEX IF NOT EXISTS project_signal_maps_approved_at_idx ON project_signal_maps (approved_at)";
const CREATE_PROJECT_SIGNAL_MAPS_UPDATED_AT_IDX_SQL =
  "CREATE INDEX IF NOT EXISTS project_signal_maps_updated_at_idx ON project_signal_maps (updated_at)";

const SIGNAL_MAP_SCHEMA_PATCHES = [
  "ALTER TABLE project_signal_maps ADD COLUMN plan_id text REFERENCES project_install_plans(id) ON DELETE RESTRICT",
  "ALTER TABLE project_signal_maps ADD COLUMN plan_revision integer",
  "ALTER TABLE project_signal_maps ADD COLUMN signal_map_etag text",
  "ALTER TABLE project_signal_maps ADD COLUMN repo_snapshot_json text",
  "ALTER TABLE project_signal_maps ADD COLUMN approval_kind text",
  "ALTER TABLE project_signal_maps ADD COLUMN approved_by text REFERENCES users(id) ON DELETE RESTRICT",
  "ALTER TABLE project_signal_maps ADD COLUMN contract_version text NOT NULL DEFAULT ''",
  "ALTER TABLE project_signal_maps ADD COLUMN framework text NOT NULL DEFAULT ''",
  "ALTER TABLE project_signal_maps ADD COLUMN surface text NOT NULL DEFAULT ''",
  "ALTER TABLE project_signal_maps ADD COLUMN signal_types_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN shapes_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN has_revenue integer NOT NULL DEFAULT 0",
  "ALTER TABLE project_signal_maps ADD COLUMN is_b2b integer NOT NULL DEFAULT 0",
  "ALTER TABLE project_signal_maps ADD COLUMN is_two_sided integer NOT NULL DEFAULT 0",
  "ALTER TABLE project_signal_maps ADD COLUMN mode text",
  "ALTER TABLE project_signal_maps ADD COLUMN approved_events_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN approved_event_properties_json text NOT NULL DEFAULT '{}'",
  "ALTER TABLE project_signal_maps ADD COLUMN provider_satisfied_events_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN discovery_map_json text NOT NULL DEFAULT '{}'",
  "ALTER TABLE project_signal_maps ADD COLUMN event_buckets_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN happy_path_funnel_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN failure_surface_map_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN planned_wiring_map_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN questions_to_answer_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN post_setup_blueprint_json text NOT NULL DEFAULT '{}'",
  "ALTER TABLE project_signal_maps ADD COLUMN recipe_decisions_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN approval_notes_json text NOT NULL DEFAULT '[]'",
  "ALTER TABLE project_signal_maps ADD COLUMN approved_plan_hash text NOT NULL DEFAULT ''",
  "ALTER TABLE project_signal_maps ADD COLUMN approved_at integer NOT NULL DEFAULT 0",
  "ALTER TABLE project_signal_maps ADD COLUMN created_at integer NOT NULL DEFAULT 0",
  "ALTER TABLE project_signal_maps ADD COLUMN updated_at integer NOT NULL DEFAULT 0",
] as const;

const signalMapSchemaReady = new Set<string>();
const signalMapSchemaInFlight = new Map<string, Promise<void>>();

export function parseJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export async function ensureSignalMapDiscoveryColumn(
  db: ReturnType<typeof getDb>,
  opts: { cache_key?: string; force?: boolean } = {},
) {
  const cacheKey = opts.cache_key;
  if (cacheKey && !opts.force && signalMapSchemaReady.has(cacheKey)) return;
  if (cacheKey && !opts.force) {
    const inFlight = signalMapSchemaInFlight.get(cacheKey);
    if (inFlight) return inFlight;
  }

  const ensure = async () => {
    if (cacheKey && opts.force) signalMapSchemaReady.delete(cacheKey);
    await db.$client.execute(CREATE_PROJECT_SIGNAL_MAPS_TABLE_SQL);
    await db.$client.execute(CREATE_PROJECT_SIGNAL_MAPS_APPROVED_AT_IDX_SQL);
    await db.$client.execute(CREATE_PROJECT_SIGNAL_MAPS_UPDATED_AT_IDX_SQL);
    for (const sql of SIGNAL_MAP_SCHEMA_PATCHES) {
      try {
        await db.$client.execute(sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          message.includes("duplicate column name") ||
          message.includes("already exists") ||
          message.includes("no such table")
        ) {
          continue;
        }
        throw err;
      }
    }
    if (cacheKey) signalMapSchemaReady.add(cacheKey);
  };

  if (!cacheKey) {
    await ensure();
    return;
  }

  const promise = ensure().finally(() => {
    signalMapSchemaInFlight.delete(cacheKey);
  });
  signalMapSchemaInFlight.set(cacheKey, promise);
  await promise;
}

export function serializeSignalMapRow(row: typeof projectSignalMaps.$inferSelect) {
  const discoveryMap = parseJsonObject(row.discoveryMapJson);
  const postSetupBlueprint = parseJsonObject(row.postSetupBlueprintJson);
  const repoSnapshot = parseJsonObject(row.repoSnapshotJson);
  return {
    artifact: "signal_map" as const,
    project_id: row.projectId,
    plan_id: row.planId,
    plan_revision: row.planRevision,
    etag: row.signalMapEtag,
    signal_map_etag: row.signalMapEtag,
    repo_snapshot: Object.keys(repoSnapshot).length > 0 ? repoSnapshot : null,
    version: row.contractVersion,
    contract_version: row.contractVersion,
    framework: row.framework,
    surface: row.surface,
    signal_types: parseJsonArray(row.signalTypesJson).map(String),
    shapes: parseJsonArray(row.shapesJson).map(String),
    has_revenue: row.hasRevenue === 1,
    is_b2b: row.isB2b === 1,
    is_two_sided: row.isTwoSided === 1,
    mode: row.mode,
    approved_events: parseJsonArray(row.approvedEventsJson).map(String),
    approved_event_properties: parseJsonObject(row.approvedEventPropertiesJson),
    provider_satisfied_events: parseJsonArray(row.providerSatisfiedEventsJson),
    discovery_map: Object.keys(discoveryMap).length > 0 ? discoveryMap : null,
    event_buckets: parseJsonArray(row.eventBucketsJson),
    happy_path_funnel: parseJsonArray(row.happyPathFunnelJson),
    failure_surface_map: parseJsonArray(row.failureSurfaceMapJson),
    planned_wiring_map: parseJsonArray(row.plannedWiringMapJson),
    questions_to_answer: parseJsonArray(row.questionsToAnswerJson),
    post_setup_blueprint: Object.keys(postSetupBlueprint).length > 0 ? postSetupBlueprint : null,
    answer_contracts: parseJsonArray(row.recipeDecisionsJson),
    approval_attestation: row.approvalKind
      ? {
          kind: row.approvalKind,
          source: "owner_api_request" as const,
          statement:
            "I attest that the project owner received and approved this exact install plan scope. This owner attestation is not independent proof that a human interaction occurred.",
          independently_human_verified: false as const,
          notes: [] as never[],
          attested_by: row.approvedBy,
          attested_at: row.approvedAt,
        }
      : null,
    approved_plan_hash: row.approvedPlanHash,
    approved_at: row.approvedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function isRecoverableSignalMapSchemaError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    const message = (
      typeof current === "string"
        ? current
        : current instanceof Error
          ? current.message
          : ""
    ).toLowerCase();
    if (
      message.includes("no such table") ||
      message.includes("no such column") ||
      message.includes("has no column named")
    ) {
      return true;
    }
    if (typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export async function loadSerializedSignalMap(
  db: ReturnType<typeof getDb>,
  projectId: string,
  opts: { skip_ensure?: boolean; schema_cache_key?: string } = {},
) {
  let rows: Array<typeof projectSignalMaps.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(projectSignalMaps)
      .where(eq(projectSignalMaps.projectId, projectId))
      .limit(1);
  } catch (err) {
    if (!isRecoverableSignalMapSchemaError(err)) throw err;
    await ensureSignalMapDiscoveryColumn(db, {
      cache_key: opts.schema_cache_key,
      force: true,
    });
    rows = await db
      .select()
      .from(projectSignalMaps)
      .where(eq(projectSignalMaps.projectId, projectId))
      .limit(1);
  }
  const row = rows[0];
  return row ? serializeSignalMapRow(row) : null;
}
