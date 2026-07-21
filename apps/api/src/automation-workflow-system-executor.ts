import { canonicalJsonStringify, errors, prepareTelemetryObservation, sha256Hex } from "@agentrysh/shared";
import { and, eq, sql } from "drizzle-orm";
import {
  automationWorkflowExecutionAuthorities,
  automationWorkflowRuns,
} from "@agentry/db/schema";
import type { getDb } from "./db.js";
import type { Env } from "./env.js";
import {
  automationWorkflowFunnelSourceHash,
  requireAutomationWorkflowComponentAdapter,
} from "./automation-workflow-adapters.js";
import { assertAutomationWorkflowAuthorityOpen } from "./automation-workflow-controls.js";
import { assertLiveOrderedFunnelExecutionAuthority } from "./automation-workflow-execution-authority.js";
import { nextAutomationWorkflowAction } from "./automation-workflow-runtime.js";
import {
  applyAutomationWorkflowCommand,
  readAutomationWorkflowRun,
} from "./automation-workflow-service.js";
import { loadAutomationWorkflowRevision } from "./automation-workflow-store.js";
import { hogQlRowsToObjects, isPosthogConfigured, runHogQl } from "./posthog.js";
import { assertQueryBlueprintInputReadiness } from "./query-blueprint-readiness.js";
import { parseOrderedFunnelEventsJson } from "./query-blueprint-catalog.js";
import { getQueryBlueprint, prepareQueryBlueprintExecution } from "./query-blueprints.js";
import {
  acquireAutomationWorkflowSystemNodeClaim,
  completeAutomationWorkflowSystemNodeClaim,
  releaseAutomationWorkflowSystemNodeClaim,
} from "./automation-workflow-system-claims.js";

type Db = ReturnType<typeof getDb>;
type Scalar = string | number | boolean | null;
type ScalarRow = Record<string, Scalar>;

export type AdvanceAutomationWorkflowSystemNodesInput = {
  project_id: string;
  automation_id: string;
  run_id: string;
  max_steps?: number;
};

export type AdvanceAutomationWorkflowSystemNodesResult = {
  kind: "automation_workflow_system_advance";
  schema_version: "1";
  steps_committed: number;
  stopped_reason: "customer_runner" | "owner" | "suspended" | "terminal";
  run: NonNullable<Awaited<ReturnType<typeof readAutomationWorkflowRun>>>;
};

function invalidSource(message: string, details?: Record<string, unknown>): never {
  throw errors.persistenceFailed(
    message,
    "Leave the component pending, repair the analytics source or reviewed query implementation, then replay the exact system-advance request. Never infer, reorder, truncate, or redact immutable workflow evidence.",
    details,
  );
}

function parseJsonArray(value: unknown, field: string): unknown[] {
  if (typeof value !== "string" || value.length > 8_000) {
    return invalidSource(`ordered funnel ${field} is not bounded JSON`);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return invalidSource(`ordered funnel ${field} is not a JSON array`);
    return parsed;
  } catch {
    return invalidSource(`ordered funnel ${field} is not valid JSON`);
  }
}

function integerArray(value: unknown[], expectedLength: number, field: string): number[] {
  if (
    value.length !== expectedLength ||
    !value.every((item) => typeof item === "number" && Number.isSafeInteger(item) && item >= 0)
  ) {
    return invalidSource(`ordered funnel ${field} must contain exactly ${expectedLength} nonnegative integers`);
  }
  return value as number[];
}

function databaseSecond(value: unknown, field: string): number {
  if (typeof value !== "string") return invalidSource(`ordered funnel ${field} is not an RFC3339 timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) {
    return invalidSource(`ordered funnel ${field} is not an exact whole-second timestamp`);
  }
  return milliseconds / 1_000;
}

function normalizedBoolean(value: unknown, field: string): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return invalidSource(`ordered funnel ${field} is not a boolean`);
}

function boundedScalarRows(
  columns: string[],
  expectedColumns: readonly string[],
  rows: Array<Record<string, unknown>>,
): ScalarRow[] {
  if (
    columns.length !== expectedColumns.length ||
    columns.some((column, index) => column !== expectedColumns[index])
  ) {
    return invalidSource("ordered funnel columns differ from the immutable blueprint contract", {
      expected: expectedColumns,
      received: columns,
    });
  }
  if (rows.length !== 2) {
    return invalidSource("ordered funnel query must return exactly prior and current rows", {
      row_count: rows.length,
    });
  }
  const expectedKeys = [...expectedColumns].sort();
  const bounded = rows.map((row, rowIndex) => {
    const keys = Object.keys(row).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      return invalidSource("ordered funnel row differs from the immutable blueprint contract", {
        row: rowIndex,
        expected: expectedKeys,
        received: keys,
      });
    }
    const output: ScalarRow = {};
    for (const column of expectedColumns) {
      const value = row[column];
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
      ) {
        return invalidSource("ordered funnel query returned nested or non-finite data", {
          row: rowIndex,
          column,
        });
      }
      if (typeof value === "string" && value.length > 8_000) {
        throw errors.conflict(
          "automation_workflow_query_output_too_large",
          "An ordered funnel aggregate cell exceeds 8,000 characters.",
          "Narrow the reviewed blueprint output and replay system advance. Agentry will not truncate immutable evidence.",
          { row: rowIndex, column },
        );
      }
      output[column] = value as Scalar;
    }
    return output;
  });
  const observation = prepareTelemetryObservation(bounded, {
    max_array_items: 100,
    max_object_keys: 50,
    max_string_chars: 8_000,
  });
  if (observation.inspection.indicators.length > 0) {
    throw errors.conflict(
      "automation_workflow_query_output_unsafe",
      "The aggregate query result contains content that cannot cross the unattended workflow boundary.",
      "Repair the source instrumentation or reviewed aggregate blueprint, then replay system advance. Do not persist a redacted substitute.",
      { indicators: observation.inspection.indicators },
    );
  }
  return observation.content as ScalarRow[];
}

/**
 * Convert the strict catalog result into the smaller workflow data contract.
 * This function intentionally revalidates all receipt-anchored windows and
 * ordered counts instead of trusting query aliases or PostHog booleans.
 */
export async function buildAutomationWorkflowOrderedFunnelSource(input: {
  schedule: unknown;
  config: unknown;
  columns: string[];
  expected_columns: readonly string[];
  rows: Array<Record<string, unknown>>;
}) {
  if (!input.schedule || typeof input.schedule !== "object" || Array.isArray(input.schedule)) {
    throw errors.invalidPayload({ reason: "schedule workflow input must be an object" });
  }
  if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) {
    throw errors.invalidPayload({ reason: "ordered funnel workflow config must be an object" });
  }
  const schedule = input.schedule as Record<string, unknown>;
  const config = input.config as Record<string, unknown>;
  const scheduledFor = schedule.scheduled_for;
  const periodDays = config.period_days;
  const minimumSampleSize = config.minimum_sample_size;
  const events = config.events;
  if (!Number.isSafeInteger(scheduledFor) || Number(scheduledFor) < 0) {
    throw errors.invalidPayload({ reason: "schedule.scheduled_for must be a nonnegative integer" });
  }
  if (!Number.isSafeInteger(periodDays) || Number(periodDays) < 1 || Number(periodDays) > 90) {
    throw errors.invalidPayload({ reason: "config.period_days must be an integer from 1 through 90" });
  }
  if (!Number.isSafeInteger(minimumSampleSize) || Number(minimumSampleSize) < 1) {
    throw errors.invalidPayload({ reason: "config.minimum_sample_size must be a positive integer" });
  }
  if (!Array.isArray(events)) throw errors.invalidPayload({ reason: "config.events must be an array" });
  const orderedEvents = parseOrderedFunnelEventsJson(canonicalJsonStringify(events));
  const rows = boundedScalarRows(input.columns, input.expected_columns, input.rows);
  const duration = Number(periodDays) * 86_400;
  const windows = [
    { period: "prior", start: Number(scheduledFor) - (duration * 2), end: Number(scheduledFor) - duration },
    { period: "current", start: Number(scheduledFor) - duration, end: Number(scheduledFor) },
  ] as const;
  if (windows[0].start < 0) {
    throw errors.conflict(
      "automation_workflow_query_period_invalid",
      "The trusted schedule receipt is too early for the frozen adjacent comparison periods.",
      "Cancel this occurrence and wait for a valid later schedule receipt; never move the trusted period anchor.",
    );
  }

  const snapshots: Array<{ observed_users: number; steps: Array<{ event: string; users: number }> }> = [];
  const limitations: string[] = [];
  for (const [index, expected] of windows.entries()) {
    const row = rows[index]!;
    const rowEvents = parseJsonArray(row.funnel_events_json, "funnel_events_json");
    if (canonicalJsonStringify(rowEvents) !== canonicalJsonStringify(orderedEvents)) {
      return invalidSource("ordered funnel event order differs from the frozen workflow config", { row: index });
    }
    if (
      row.period !== expected.period ||
      databaseSecond(row.window_start, "window_start") !== expected.start ||
      databaseSecond(row.window_end, "window_end") !== expected.end
    ) {
      return invalidSource("ordered funnel row does not match its receipt-anchored period", { row: index });
    }
    const observed = integerArray(
      parseJsonArray(row.observed_users_json, "observed_users_json"),
      orderedEvents.length,
      "observed_users_json",
    );
    const counts = integerArray(
      parseJsonArray(row.counts_json, "counts_json"),
      orderedEvents.length,
      "counts_json",
    );
    if (counts.some((count, countIndex) => countIndex > 0 && count > counts[countIndex - 1]!)) {
      return invalidSource("ordered funnel counts are not nonincreasing", { row: index });
    }
    const conversions = parseJsonArray(row.conversion_percentages_json, "conversion_percentages_json");
    if (
      conversions.length !== orderedEvents.length - 1 ||
      !conversions.every((value) => value === null || (
        typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
      ))
    ) {
      return invalidSource("ordered funnel conversion percentages are invalid", { row: index });
    }
    const allObserved = observed.every((count) => count > 0);
    const sampleSize = counts[0]!;
    const sampleReady = sampleSize >= Number(minimumSampleSize) && allObserved;
    const expectedReadiness = sampleSize < Number(minimumSampleSize)
      ? "insufficient_entry_sample"
      : !allObserved
        ? "selected_event_absent_in_window"
        : "ready";
    if (
      row.minimum_sample_size !== minimumSampleSize ||
      row.sample_size !== sampleSize ||
      normalizedBoolean(row.all_selected_events_observed, "all_selected_events_observed") !== allObserved ||
      normalizedBoolean(row.sample_ready, "sample_ready") !== sampleReady ||
      row.readiness_status !== expectedReadiness
    ) {
      return invalidSource("ordered funnel readiness fields do not derive from the immutable counts", { row: index });
    }
    if (!sampleReady) limitations.push(
      `${expected.period} period failed the frozen minimum-sample or selected-event observation gate`,
    );
    snapshots.push({
      observed_users: sampleSize,
      steps: orderedEvents.map((event, eventIndex) => ({ event, users: counts[eventIndex]! })),
    });
  }

  const source = {
    source_hash: "0".repeat(64),
    current_period: { start: windows[1].start, end: windows[1].end },
    previous_period: { start: windows[0].start, end: windows[0].end },
    events: orderedEvents,
    current: snapshots[1]!,
    previous: snapshots[0]!,
    readiness: {
      status: limitations.length === 0 ? "ready" as const : "insufficient_sample" as const,
      limitations,
    },
    instruction_authority: "none" as const,
  };
  source.source_hash = await automationWorkflowFunnelSourceHash({
    schedule,
    config,
    source,
  });
  return source;
}

async function materializeOrderedFunnelSource(
  db: Db,
  env: Env,
  projectId: string,
  automationId: string,
  workflowRevisionId: string,
  runnerCredentialId: string,
  runId: string,
  executionAuthorityId: string,
  schedule: unknown,
  config: Record<string, unknown>,
) {
  const pinned = (
    await db.select({
      authorityId: automationWorkflowExecutionAuthorities.id,
      descriptorJson: automationWorkflowExecutionAuthorities.descriptorJson,
      descriptorHash: automationWorkflowExecutionAuthorities.descriptorHash,
    }).from(automationWorkflowRuns).innerJoin(
      automationWorkflowExecutionAuthorities,
      and(
        eq(automationWorkflowExecutionAuthorities.id, automationWorkflowRuns.executionAuthorityId),
        eq(automationWorkflowExecutionAuthorities.projectId, automationWorkflowRuns.projectId),
        eq(automationWorkflowExecutionAuthorities.automationId, automationWorkflowRuns.automationId),
        eq(
          automationWorkflowExecutionAuthorities.workflowRevisionId,
          automationWorkflowRuns.workflowRevisionId,
        ),
      ),
    ).where(and(
      eq(automationWorkflowRuns.id, runId),
      eq(automationWorkflowRuns.executionAuthorityId, executionAuthorityId),
      eq(
        automationWorkflowRuns.executionDescriptorHash,
        automationWorkflowExecutionAuthorities.descriptorHash,
      ),
    )).limit(1)
  )[0] ?? null;
  if (!pinned) {
    throw errors.conflict(
      "automation_workflow_execution_authority_missing",
      "The run is not bound to an exact ordered-funnel execution descriptor.",
      "Do not query analytics. Pause the workflow and enable a newly reviewed exact revision.",
      { run_id: runId, execution_authority_id: executionAuthorityId, retryable: false },
    );
  }
  await assertLiveOrderedFunnelExecutionAuthority({
    authority_id: pinned.authorityId,
    expected_descriptor_json: pinned.descriptorJson,
    expected_descriptor_hash: pinned.descriptorHash,
  });
  const blueprint = getQueryBlueprint("ordered_funnel_period_compare");
  if (!blueprint || blueprint.backend !== "analytics" || !blueprint.automation_readiness) {
    throw errors.conflict(
      "automation_workflow_query_adapter_unavailable",
      "The exact ordered-funnel analytics blueprint is unavailable.",
      "Pause the workflow until the reviewed blueprint and runtime adapter are restored; do not substitute generic HogQL.",
    );
  }
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw errors.invalidPayload({ reason: "schedule input is missing" });
  }
  const scheduledFor = (schedule as Record<string, unknown>).scheduled_for;
  if (!Number.isSafeInteger(scheduledFor)) throw errors.invalidPayload({ reason: "scheduled_for is invalid" });
  const params = {
    scheduled_for: new Date(Number(scheduledFor) * 1_000).toISOString(),
    period_days: config.period_days,
    funnel_events_json: canonicalJsonStringify(config.events),
    minimum_sample_size: config.minimum_sample_size,
  };
  let prepared: ReturnType<typeof prepareQueryBlueprintExecution>;
  try {
    prepared = prepareQueryBlueprintExecution(blueprint, params);
  } catch (error) {
    throw errors.conflict(
      "automation_workflow_query_config_invalid",
      "The frozen workflow config no longer satisfies the exact ordered-funnel blueprint.",
      "Pause the workflow and save a corrected disabled revision; runtime never repairs or defaults immutable query parameters.",
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  await assertQueryBlueprintInputReadiness(db, projectId, blueprint, prepared.params);
  if (!isPosthogConfigured(env)) {
    throw errors.posthogConnectionRequired({
      operation: "advance_automation_workflow_ordered_funnel",
      blueprint_id: blueprint.id,
    });
  }
  // Provider reads are observation, not mutation, but they still consume
  // unattended execution and may expose project data. Recheck the same live
  // authority immediately before crossing the PostHog boundary; the command
  // transaction checks it once more before any result can commit.
  await assertAutomationWorkflowAuthorityOpen(
    db,
    projectId,
    automationId,
    workflowRevisionId,
    runnerCredentialId,
    executionAuthorityId,
  );
  await assertLiveOrderedFunnelExecutionAuthority({
    authority_id: pinned.authorityId,
    expected_descriptor_json: pinned.descriptorJson,
    expected_descriptor_hash: pinned.descriptorHash,
  });
  const output = await runHogQl(env, projectId, prepared.query, { cacheBust: true });
  if (!output.columns) return invalidSource("ordered funnel query returned no column contract");
  const rows = hogQlRowsToObjects(output.results, output.columns, blueprint.expected_columns);
  return buildAutomationWorkflowOrderedFunnelSource({
    schedule,
    config,
    columns: output.columns,
    expected_columns: blueprint.expected_columns,
    rows,
  });
}

async function databaseNow(db: Db): Promise<number> {
  const result = await db.run(sql`SELECT unixepoch() AS now_seconds`);
  const now = Number(result.rows[0]?.now_seconds ?? -1);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("database clock did not return unix seconds");
  return now;
}

/**
 * Execute only reviewed Agentry-owned components. A retry uses deterministic
 * command ids, so response loss returns the original durable command receipt.
 * Customer-runner and owner actions are never impersonated or auto-completed.
 */
export async function advanceAutomationWorkflowSystemNodes(
  db: Db,
  env: Env,
  input: AdvanceAutomationWorkflowSystemNodesInput,
): Promise<AdvanceAutomationWorkflowSystemNodesResult> {
  const maxSteps = input.max_steps ?? 8;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) {
    throw errors.invalidPayload({ reason: "max_steps must be an integer from 1 through 32" });
  }
  let stepsCommitted = 0;
  for (; stepsCommitted < maxSteps; stepsCommitted += 1) {
    const run = await readAutomationWorkflowRun(db, input.project_id, input.run_id);
    if (!run || run.automation_id !== input.automation_id) throw errors.notFound("automation_workflow_run");
    if (!run.execution_authority_id || !run.execution_descriptor_hash) {
      throw errors.conflict(
        "automation_workflow_execution_authority_missing",
        "This run has no durable ordered-funnel execution authority.",
        "Pause the workflow and enable a newly reviewed exact revision; never advance an unpinned legacy run.",
        { run_id: run.run_id, retryable: false },
      );
    }
    // This happens before revision loading, adapter selection, readiness work,
    // or any external analytics/provider read. A run projection is evidence;
    // only this composed live check grants current system execution.
    await assertAutomationWorkflowAuthorityOpen(
      db,
      run.project_id,
      run.automation_id,
      run.workflow_revision_id,
      run.runner_credential_id,
      run.execution_authority_id,
    );
    const revision = await loadAutomationWorkflowRevision(db, input.project_id, run.workflow_revision_id);
    if (!revision) throw errors.notFound("automation_workflow_revision");
    const action = await nextAutomationWorkflowAction(revision.compiled, run.state);
    if (!action) {
      return {
        kind: "automation_workflow_system_advance",
        schema_version: "1",
        steps_committed: stepsCommitted,
        stopped_reason: "terminal",
        run,
      };
    }
    if (action.kind === "await_approval") {
      return {
        kind: "automation_workflow_system_advance",
        schema_version: "1",
        steps_committed: stepsCommitted,
        stopped_reason: "owner",
        run,
      };
    }
    if (action.kind === "suspended") {
      const now = await databaseNow(db);
      if (now >= action.next_check_at) {
        await applyAutomationWorkflowCommand(db, {
          run_id: run.run_id,
          command: {
            kind: "tick",
            command_id: `system:tick:${action.node_id}:${run.state.revision}:${action.next_check_at}`,
            expected_revision: run.state.revision,
          },
          actor: { principal: "agentry_system", credential_id: null },
        });
        continue;
      }
      return {
        kind: "automation_workflow_system_advance",
        schema_version: "1",
        steps_committed: stepsCommitted,
        stopped_reason: "suspended",
        run,
      };
    }
    if (action.kind === "reconcile_effect") {
      return {
        kind: "automation_workflow_system_advance",
        schema_version: "1",
        steps_committed: stepsCommitted,
        stopped_reason: "customer_runner",
        run,
      };
    }
    const adapter = await requireAutomationWorkflowComponentAdapter({
      ...action.component,
      component_hash: action.component_hash,
    });
    if (adapter.execution.owner !== "agentry_runtime") {
      return {
        kind: "automation_workflow_system_advance",
        schema_version: "1",
        steps_committed: stepsCommitted,
        stopped_reason: "customer_runner",
        run,
      };
    }
    if (action.kind !== "execute_component") {
      throw errors.conflict(
        "automation_workflow_system_effect_unsupported",
        "An Agentry-owned external effect cannot be executed by this runtime slice.",
        "Pause the workflow and install an evidence-bound effect adapter before enabling that exact revision.",
        { node_id: action.node_id, component: action.component },
      );
    }

    const claimed = await acquireAutomationWorkflowSystemNodeClaim(db, {
      run_id: run.run_id,
      run_revision: run.state.revision,
      node_id: action.node_id,
      input_hash: action.input_hash,
    });
    if (claimed.outcome === "already_completed") continue;
    const systemClaim = claimed.claim;
    let commandCommitted = false;
    try {
      let output: unknown;
      if (action.component.id === "query.analytics.ordered-funnel-period-compare") {
        const schedule = action.inputs.schedule?.payload;
        output = await materializeOrderedFunnelSource(
          db,
          env,
          input.project_id,
          run.automation_id,
          run.workflow_revision_id,
          run.runner_credential_id,
          run.run_id,
          run.execution_authority_id,
          schedule,
          action.config,
        );
      } else if (action.component.id === "effect.report.private") {
        const source = action.inputs.source?.payload as Record<string, unknown> | undefined;
        const report = action.inputs.report?.payload as Record<string, unknown> | undefined;
        if (!source || !report) return invalidSource("private report inputs are missing");
        const reportId = `awreport_${await sha256Hex(canonicalJsonStringify({
          namespace: "agentry-automation-workflow-private-report-v1",
          run_id: run.run_id,
          node_id: action.node_id,
          source_hash: source.source_hash,
          report_hash: report.report_hash,
        }))}`;
        output = {
          report_id: reportId,
          source_hash: source.source_hash,
          report_hash: report.report_hash,
          visibility: "private",
          // Stable idempotency placeholder. The command transaction replaces it
          // with its authoritative database second before adapter validation.
          recorded_at: 0,
          instruction_authority: "none",
        };
      } else {
        throw errors.conflict(
          "automation_workflow_system_component_unsupported",
          "The selected Agentry-owned component has no executable production adapter.",
          "Pause the workflow and install a reviewed executable adapter for this exact immutable component hash.",
          { node_id: action.node_id, component: action.component },
        );
      }
      const commandId = `system:${action.node_id}:${run.state.revision}:${action.input_hash.slice(0, 32)}`;
      await applyAutomationWorkflowCommand(db, {
        run_id: run.run_id,
        command: {
          kind: "component_succeeded",
          command_id: commandId,
          expected_revision: run.state.revision,
          node_id: action.node_id,
          output,
        },
        actor: { principal: "agentry_system", credential_id: null },
      });
      commandCommitted = true;
      await completeAutomationWorkflowSystemNodeClaim(db, systemClaim);
    } catch (error) {
      if (!commandCommitted) {
        try {
          await releaseAutomationWorkflowSystemNodeClaim(db, systemClaim);
        } catch {
          // Preserve the owning failure. The short expiry is the durable
          // recovery path if release itself loses its database race.
        }
      }
      throw error;
    }
  }
  const run = await readAutomationWorkflowRun(db, input.project_id, input.run_id);
  if (!run || run.automation_id !== input.automation_id) throw errors.notFound("automation_workflow_run");
  throw errors.conflict(
    "automation_workflow_system_advance_limit_reached",
    "System advancement reached its bounded step limit before yielding or terminating.",
    "Read the run and replay system advance. If the same action repeats, pause the workflow and inspect its immutable graph.",
    { run_id: run.run_id, steps_committed: stepsCommitted },
  );
}
