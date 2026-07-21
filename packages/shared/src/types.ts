// Cross-package type contracts. KEEP STABLE — three packages depend on this.

import type { TelemetryInspection } from "./telemetry-boundary.js";

export interface StackFrame {
  filename?: string | null;
  function?: string | null;
  lineno?: number | null;
  colno?: number | null;
  in_app?: boolean | null;
  context_line?: string | null;
}

export type CaseStatus = "active" | "resolved" | "suppressed";

export interface TelemetryEmitter {
  trust_level: "customer_posthog" | "trusted_ci" | "agentry_system" | null;
  credential_kind: string | null;
  credential_id: string | null;
}

export interface CaseObservationSummary {
  emitter: TelemetryEmitter;
  evidence: {
    error_type: string;
    message: string;
  };
  inspection: TelemetryInspection;
}

export interface CaseSummary {
  id: string;
  project_id: string;
  fingerprint: string;
  status: CaseStatus;
  revision: number;
  event_count: number;
  first_seen_at: number;
  last_seen_at: number;
  last_deploy_sha: string | null;
  latest_observation: CaseObservationSummary;
  annotations: {
    classification: "authenticated_annotation";
    instruction_authority: "none";
    evidence: { agent_summary: string | null; pr_url: string | null };
    inspection: TelemetryInspection;
  };
}

export interface CaseDetail extends CaseSummary {
  observations: Array<{
    id: string;
    received_at: number;
    deploy_sha: string | null;
    environment: string | null;
    emitter: TelemetryEmitter;
    evidence: {
      message: string;
      stack: StackFrame[];
      breadcrumbs: unknown;
      request: unknown;
      tags: unknown;
      extra: unknown;
    };
    inspection: TelemetryInspection;
  }>;
  annotations: CaseSummary["annotations"] & {
    evidence: CaseSummary["annotations"]["evidence"];
  };
  project_context: {
    classification: "authenticated_configuration";
    instruction_authority: "none";
    evidence: { local_path: string | null };
    inspection: TelemetryInspection;
  };
  control: {
    source: "agentry_system";
    caller_kind: "automation_runner" | "owner";
    allowed_operations: string[];
    next_actions: string[];
  };
}

export interface AgentryConfig {
  server_url: string;
  api_key: string | null;
  default_project_id: string | null;
  projects: Record<string, AgentryProjectConfig>;
}

export type AgentryOnboardingStatus = "needs_install" | "blocked" | "verified";
export type AgentryOnboardingPhase =
  | "project_created"
  | "install_planned"
  | "plan_confirmed"
  | "installing"
  | "verifying"
  | "verified";
export type AgentryInstallSurface = "client" | "server" | "direct-http";

export interface AgentryOnboardingGateFailure {
  code: string;
  message: string;
  fix?: string;
}

export interface AgentryOnboardingErrorSurface {
  id: string;
  title: string;
  surface: AgentryInstallSurface;
  required_when: "always" | "when_repo_patterns_match";
  step_ids: string[];
  detect_literals: string[];
  wire_literals: string[];
  verify_strategy?: "literal_presence" | "detect_file_has_wire";
}

export interface AgentryOnboardingFunnelStage {
  id: string;
  title: string;
  goal: string;
  related_events?: string[];
}

export interface AgentryOnboardingEventBucket {
  bucket: string;
  purpose?: string;
  required_events: string[];
  missing_events: string[];
}

export interface AgentryOnboardingFailureSurface {
  id: string;
  title: string;
  why: string;
  related_stage_ids?: string[];
  related_events?: string[];
  source_error_surface_ids?: string[];
}

export interface AgentryQuestionToAnswer {
  question: string;
  why?: string;
  category?: string;
  source_contract_id?: string;
  source_contract_title?: string;
  covered_by_events?: string[];
}

export interface AgentryPostSetupAutomation {
  id: string;
  title: string;
  trigger: "weekly" | "on_deploy" | "on_new_case" | "on_demand" | string;
  purpose: string;
  uses?: string[];
  prompt_seed?: string;
}

export interface AgentryActivationDefinition {
  metric: "activation";
  event: string | null;
  label: string;
  source:
    | "explicit_event"
    | "derived_from_domain_event"
    | "fallback_signup_event"
    | "needs_user_confirmation"
    | string;
  reason: string;
  supporting_events?: string[];
  required_properties?: string[];
  dashboard_guidance?: string;
}

export interface AgentryQuestionReadinessPlan {
  default_strategy?: string;
  canonical_reads?: string[];
  classification?: string[];
  publish_or_build_ui_only_when?: string;
  [key: string]: unknown;
}

export interface AgentryOptionalUiPlan {
  suggested_route?: string;
  default?: "do_not_build" | string;
  route_first?: boolean;
  panels?: string[];
  guidance?: string;
  [key: string]: unknown;
}

export interface AgentryPostSetupBlueprint {
  artifact?: "post_setup_blueprint";
  target_route: string;
  target_name?: string;
  route_guidance?: string;
  source_context?: string[];
  customization_rules?: string[];
  activation_definition?: AgentryActivationDefinition;
  deployment_env_plan?: Record<string, unknown>;
  automations?: AgentryPostSetupAutomation[];
  question_readiness_plan?: AgentryQuestionReadinessPlan;
  optional_ui_plan?: AgentryOptionalUiPlan;
  completion_gate?: Record<string, unknown>;
  next_action?: string;
}

export interface AgentryDiscoveryMap {
  product_summary: string;
  product_category: string;
  metric_lens: string;
  primary_outcome: string;
  existing_live_events?: string[];
  key_entities: string[];
  key_user_journeys: string[];
  ui_surfaces: string[];
  api_surfaces: string[];
  async_surfaces: string[];
  admin_surfaces: string[];
  external_dependencies: string[];
  monetization_surfaces: string[];
  risky_failure_paths: string[];
  notes?: string[];
}

export interface AgentryAutomationContract {
  artifact: "automation_contract";
  project_id?: string;
  approved_plan_hash?: string | null;
  summary: string;
  automations: Array<Record<string, unknown>>;
  notes?: string[];
  created_at?: number | null;
  updated_at?: number | null;
}

export type AgentryAnswerContractState =
  | "applicable"
  | "skipped"
  | "not_applicable"
  | "needs_mapping"
  | "deferred";

export interface AgentryAnswerContract {
  id: string;
  state: AgentryAnswerContractState;
  reason?: string;
  substituted_events?: Record<string, string>;
  user_confirmed?: boolean;
}

export type AgentryAnswerContractDecisionState = AgentryAnswerContractState;
export type AgentryAnswerContractDecision = AgentryAnswerContract;

export interface AgentryPlannedWiringMapItem {
  signal: string;
  kind?: "event" | "error" | "deploy" | string;
  target_files?: string[];
  target_surface?: string;
  trigger?: string;
  key_properties?: string[];
  notes?: string[];
}

export interface AgentryProviderSatisfiedEvent {
  event: string;
  source_event?: string;
  provider?: string;
  status?: "provider_stream_preserved" | string;
  guidance?: string;
}

export interface AgentryOnboardingInstallContract {
  version: string;
  framework: string;
  surface: AgentryInstallSurface;
  signal_types?: string[];
  shapes?: string[];
  has_revenue?: boolean;
  is_b2b?: boolean;
  is_two_sided?: boolean;
  mode?:
    | "fresh_install"
    | "extend_existing"
    | "repair_existing"
    | "verify_only";
  required_events?: string[];
  readiness_events?: string[];
  required_event_properties?: Record<string, string[]>;
  provider_satisfied_events?: AgentryProviderSatisfiedEvent[];
  missing_events?: string[];
  missing_event_properties?: string[];
  approved_events?: string[];
  approved_event_properties?: Record<string, string[]>;
  answer_contracts?: AgentryAnswerContract[];
  approval_step_id?: string;
  verify_step_id?: string;
  planner_tool?: string;
  verify_tool?: string;
  error_surfaces?: AgentryOnboardingErrorSurface[];
  discovery_map?: AgentryDiscoveryMap | null;
  happy_path_funnel?: AgentryOnboardingFunnelStage[];
  event_buckets?: AgentryOnboardingEventBucket[];
  failure_surface_map?: AgentryOnboardingFailureSurface[];
  planned_wiring_map?: AgentryPlannedWiringMapItem[];
  questions_for_user?: string[];
  questions_to_answer?: AgentryQuestionToAnswer[];
  post_setup_blueprint?: AgentryPostSetupBlueprint | null;
  approval_status?: "draft" | "approved";
  approved_at?: number | null;
  approved_plan_hash?: string | null;
  approval_notes?: string[];
  updated_at?: number | null;
}

export interface AgentrySignalMap extends AgentryOnboardingInstallContract {
  artifact: "signal_map";
  project_id?: string;
  contract_version?: string;
  created_at?: number | null;
  updated_at?: number | null;
}

export interface AgentryOnboardingState {
  status: AgentryOnboardingStatus;
  phase: AgentryOnboardingPhase;
  last_verify_ok?: boolean | null;
  last_verify_at?: number | null;
  verified_at?: number | null;
  gate_failures?: AgentryOnboardingGateFailure[];
  readiness_gaps?: AgentryOnboardingGateFailure[];
  real_event_count?: number;
  answer_contract_answerable_count?: number;
  answer_contract_applicable_count?: number;
  shapes?: string[];
  draft_plan?: AgentryOnboardingInstallContract | null;
  contract?: AgentryOnboardingInstallContract | null;
}

export interface AgentryProjectConfig {
  id: string;
  name: string;
  local_path: string | null;
  default_branch: string;
  onboarding?: AgentryOnboardingState;
  analytics_ready?: boolean;
  posthog_project_id?: number | null;
  posthog_connection_status?: "detached" | "selection_required" | "active" | "reauth_required";
}
