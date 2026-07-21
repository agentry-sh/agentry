import {
  canonicalJsonStringify,
  errors,
  sha256Hex,
} from "@agentrysh/shared";
import {
  getQueryBlueprint,
  prepareQueryBlueprintExecution,
  type QueryBlueprint,
} from "./query-blueprints.js";

export const ORDERED_FUNNEL_EXECUTION_DESCRIPTOR_KIND =
  "ordered_funnel_period_compare" as const;
export const ORDERED_FUNNEL_EXECUTION_SEMANTICS_VERSION = 1 as const;
export const ORDERED_FUNNEL_QUERY_BUILDER_EXECUTION_VERSION = 1 as const;
export const ORDERED_FUNNEL_MATERIALIZER_EXECUTION_VERSION = 1 as const;

// Review this semantic manifest with every SQL-builder or source-materializer
// change. Its hash is pinned in each enable receipt in addition to generated
// 2-step and 20-step query probes, so implementation rollouts cannot silently
// reinterpret an already-running revision.
const ORDERED_FUNNEL_MATERIALIZER_SEMANTICS = Object.freeze({
  namespace: "agentry-ordered-funnel-materializer-semantics-v1",
  exact_rows: ["prior", "current"],
  windows: "adjacent_half_open_receipt_anchored",
  event_order: "canonical_frozen_config_exact",
  observed_and_counts: "nonnegative_integer_arrays_exact_event_length",
  funnel_counts: "nonincreasing",
  conversions: "finite_null_or_0_through_100_exact_step_gap_length",
  readiness: "derived_from_entry_sample_and_every_selected_event_observed",
  output: "bounded_aggregate_safe_telemetry_observation_no_redaction",
  instruction_authority: "none",
});

export type OrderedFunnelExecutionDescriptor = Readonly<{
  schema_version: "1";
  kind: typeof ORDERED_FUNNEL_EXECUTION_DESCRIPTOR_KIND;
  execution_semantics_version: typeof ORDERED_FUNNEL_EXECUTION_SEMANTICS_VERSION;
  query_builder_execution_version: typeof ORDERED_FUNNEL_QUERY_BUILDER_EXECUTION_VERSION;
  materializer_execution_version: typeof ORDERED_FUNNEL_MATERIALIZER_EXECUTION_VERSION;
  materializer_semantics_hash: string;
  blueprint: Readonly<Record<string, unknown>>;
  prepared_query_probes: ReadonlyArray<Readonly<{
    ordered_event_count: 2 | 20;
    query_hash: string;
  }>>;
}>;

export type OrderedFunnelExecutionAuthority = Readonly<{
  descriptor_kind: typeof ORDERED_FUNNEL_EXECUTION_DESCRIPTOR_KIND;
  descriptor: OrderedFunnelExecutionDescriptor;
  descriptor_json: string;
  descriptor_hash: string;
}>;

export function orderedFunnelBlueprintCompatible(
  blueprint: QueryBlueprint | null,
): blueprint is QueryBlueprint {
  if (!blueprint) return false;
  const readiness = blueprint.automation_readiness;
  return blueprint.id === "ordered_funnel_period_compare" &&
    blueprint.backend === "analytics" &&
    blueprint.strict_params === true &&
    blueprint.required_event_list_param === "funnel_events_json" &&
    blueprint.query_builder === "ordered_funnel_period_compare" &&
    blueprint.params.map((param) => param.name).join("\u0000") ===
      "scheduled_for\u0000period_days\u0000funnel_events_json\u0000minimum_sample_size" &&
    blueprint.publication_safety.status === "private_automation" &&
    blueprint.publication_safety.public_access === "denied" &&
    blueprint.publication_safety.output_granularity === "aggregate" &&
    blueprint.publication_safety.identifier_columns.length === 0 &&
    blueprint.publication_safety.accepts_arbitrary_segment_property === false &&
    readiness?.kind === "all_rows_boolean" &&
    readiness.column === "sample_ready" &&
    readiness.expected_rows === 2 &&
    readiness.row_identity.column === "period" &&
    readiness.row_identity.values.join("\u0000") === "prior\u0000current" &&
    blueprint.expected_columns.includes("sample_ready") &&
    blueprint.expected_columns.includes("readiness_status");
}

function exactBlueprintDescriptor(blueprint: QueryBlueprint): Record<string, unknown> {
  return {
    id: blueprint.id,
    backend: blueprint.backend,
    query: blueprint.query,
    strict_params: blueprint.strict_params ?? false,
    required_event_list_param: blueprint.required_event_list_param ?? null,
    required_event_params: blueprint.required_event_params ?? null,
    query_builder: blueprint.query_builder ?? null,
    automation_readiness: blueprint.automation_readiness ?? null,
    automation_verification: blueprint.automation_verification ?? null,
    params: blueprint.params,
    expected_columns: blueprint.expected_columns,
    publication_safety: blueprint.publication_safety,
  };
}

const PROBE_COUNTS = [2, 20] as const;

async function buildDescriptor(
  blueprint: QueryBlueprint,
): Promise<OrderedFunnelExecutionDescriptor> {
  const preparedQueryProbes = await Promise.all(PROBE_COUNTS.map(async (orderedEventCount) => {
    const prepared = prepareQueryBlueprintExecution(blueprint, {
      scheduled_for: "2030-01-15T12:00:00.000Z",
      period_days: 7,
      funnel_events_json: canonicalJsonStringify(
        Array.from({ length: orderedEventCount }, (_, index) => `agentry_probe_${index + 1}`),
      ),
      minimum_sample_size: 42,
    });
    return {
      ordered_event_count: orderedEventCount,
      query_hash: await sha256Hex(prepared.query),
    };
  }));
  return {
    schema_version: "1",
    kind: ORDERED_FUNNEL_EXECUTION_DESCRIPTOR_KIND,
    execution_semantics_version: ORDERED_FUNNEL_EXECUTION_SEMANTICS_VERSION,
    query_builder_execution_version: ORDERED_FUNNEL_QUERY_BUILDER_EXECUTION_VERSION,
    materializer_execution_version: ORDERED_FUNNEL_MATERIALIZER_EXECUTION_VERSION,
    materializer_semantics_hash: await sha256Hex(
      canonicalJsonStringify(ORDERED_FUNNEL_MATERIALIZER_SEMANTICS),
    ),
    blueprint: exactBlueprintDescriptor(blueprint),
    prepared_query_probes: preparedQueryProbes,
  };
}

/** Resolve the only query execution contract enabled in the first slice. */
export async function loadLiveOrderedFunnelExecutionAuthority(): Promise<
  OrderedFunnelExecutionAuthority | null
> {
  const blueprint = getQueryBlueprint("ordered_funnel_period_compare");
  if (!orderedFunnelBlueprintCompatible(blueprint)) return null;
  let descriptor: OrderedFunnelExecutionDescriptor;
  try {
    descriptor = await buildDescriptor(blueprint);
  } catch {
    return null;
  }
  const descriptorJson = canonicalJsonStringify(descriptor);
  return {
    descriptor_kind: ORDERED_FUNNEL_EXECUTION_DESCRIPTOR_KIND,
    descriptor,
    descriptor_json: descriptorJson,
    descriptor_hash: await sha256Hex(descriptorJson),
  };
}

/**
 * Recompute catalog + bounded builder probes immediately before analytics I/O.
 * A code/catalog rollout cannot silently reinterpret an already-enabled run.
 */
export async function assertLiveOrderedFunnelExecutionAuthority(input: {
  authority_id: string | null;
  expected_descriptor_json: string | null;
  expected_descriptor_hash: string | null;
}): Promise<OrderedFunnelExecutionAuthority> {
  if (
    !input.authority_id ||
    !input.expected_descriptor_json ||
    !input.expected_descriptor_hash
  ) {
    throw errors.conflict(
      "automation_workflow_execution_authority_missing",
      "This run has no durable ordered-funnel execution authority.",
      "Pause the workflow. Save, review, and enable a new exact revision; never advance a legacy run that lacks the pinned query descriptor.",
      { authority_id: input.authority_id, retryable: false },
    );
  }
  const live = await loadLiveOrderedFunnelExecutionAuthority();
  if (
    !live ||
    live.descriptor_hash !== input.expected_descriptor_hash ||
    live.descriptor_json !== input.expected_descriptor_json
  ) {
    throw errors.conflict(
      "automation_workflow_execution_descriptor_drift",
      "The live ordered-funnel implementation differs from the exact descriptor reviewed at enablement.",
      "Do not query analytics for this run. Pause the workflow, inspect the implementation change, then save and explicitly enable a new reviewed revision.",
      {
        authority_id: input.authority_id,
        expected_descriptor_hash: input.expected_descriptor_hash,
        live_descriptor_hash: live?.descriptor_hash ?? null,
        retryable: false,
      },
    );
  }
  return live;
}
