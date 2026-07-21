import {
  canonicalJsonStringify,
  sha256Hex,
  validateAutomationWorkflow,
  type AutomationWorkflowDefinition,
  type AutomationWorkflowJsonValue,
  type AutomationWorkflowNode,
  type AutomationWorkflowValidationIssue,
} from "@agentrysh/shared";
import {
  automationWorkflowComponentKey,
  getAutomationWorkflowComponent,
  serializeAutomationWorkflowComponent,
  type AutomationWorkflowComponentManifest,
  type AutomationWorkflowPrincipal,
  type AutomationWorkflowRequirement,
} from "./automation-workflow-components.js";

export type AutomationWorkflowCompileIssue = {
  code:
    | AutomationWorkflowValidationIssue["code"]
    | "unknown_component"
    | "component_kind_mismatch"
    | "component_config_invalid"
    | "component_input_missing"
    | "component_input_unexpected"
    | "component_input_contract_mismatch"
    | "input_source_has_no_contract"
    | "reference_source_has_no_output"
    | "reference_bypass"
    | "reference_output_unavailable"
    | "condition_path_unknown"
    | "condition_type_mismatch"
    | "approval_required"
    | "approval_not_supported"
    | "approval_subject_mismatch"
    | "approval_flow_invalid"
    | "approval_denial_bypass"
    | "approval_bypass"
    | "approval_unused"
    | "runner_repository_required"
    | "agent_cost_limit_required"
    | "external_effect_budget_exceeded"
    | "workspace_budget_exceeded"
    | "elapsed_budget_exceeded"
    | "requirement_conflict";
  path: Array<string | number>;
  message: string;
  next_action: string;
};

export type AutomationWorkflowCompileResult =
  | {
      success: true;
      data: CompiledAutomationWorkflow;
    }
  | {
      success: false;
      issues: AutomationWorkflowCompileIssue[];
    };

export type CompiledAutomationWorkflow = Awaited<ReturnType<typeof buildCompiledWorkflow>>;

type ComponentNode = Extract<
  AutomationWorkflowNode,
  { kind: "trigger" | "query" | "agent_task" | "effect" | "wait" | "verify" }
>;

type ResolvedNode = {
  node: ComponentNode;
  node_index: number;
  manifest: AutomationWorkflowComponentManifest;
  config: Record<string, AutomationWorkflowJsonValue>;
};

type RequirementWithSources = AutomationWorkflowRequirement & {
  required_by_node_ids: string[];
};

const COMMON_REQUIREMENTS: readonly RequirementWithSources[] = [
  {
    id: "runner_credential_bound",
    kind: "credential",
    requirement: "One automation-runner credential is bound to this exact workflow.",
    next_action: "Save the disabled workflow candidate, then create its one-automation runner credential.",
    required_by_node_ids: ["$workflow"],
  },
  {
    id: "workflow_runtime_adapter_available",
    kind: "runtime",
    requirement: "A runtime adapter implements every selected immutable component version and workflow invariant.",
    next_action: "Keep this candidate disabled until persistence and execution adapters for workflow schema v3 are implemented and proved.",
    required_by_node_ids: ["$workflow"],
  },
] as const;

function isComponentNode(node: AutomationWorkflowNode): node is ComponentNode {
  return ["trigger", "query", "agent_task", "effect", "wait", "verify"].includes(node.kind);
}

function namedTargets(node: AutomationWorkflowNode): Array<{ exit: string; target: string }> {
  switch (node.kind) {
    case "trigger":
    case "query":
    case "agent_task":
    case "effect":
      return [
        { exit: "next", target: node.next },
        { exit: "on_error", target: node.on_error },
      ];
    case "condition":
      return [
        { exit: "on_true", target: node.on_true },
        { exit: "on_false", target: node.on_false },
        { exit: "on_error", target: node.on_error },
      ];
    case "approval":
      return [
        { exit: "on_approved", target: node.on_approved },
        { exit: "on_rejected", target: node.on_rejected },
        { exit: "on_expired", target: node.on_expired },
      ];
    case "wait":
      return [
        { exit: "on_ready", target: node.on_ready },
        { exit: "on_timeout", target: node.on_timeout },
        { exit: "on_error", target: node.on_error },
      ];
    case "verify":
      return [
        { exit: "on_pass", target: node.on_pass },
        { exit: "on_fail", target: node.on_fail },
        { exit: "on_timeout", target: node.on_timeout },
        { exit: "on_error", target: node.on_error },
      ];
    case "terminal":
      return [];
  }
}

function targets(node: AutomationWorkflowNode): string[] {
  return namedTargets(node).map((edge) => edge.target);
}

function issue(
  code: AutomationWorkflowCompileIssue["code"],
  path: Array<string | number>,
  message: string,
  nextAction: string,
): AutomationWorkflowCompileIssue {
  return { code, path, message, next_action: nextAction };
}

function valueType(value: string | number | boolean | null) {
  if (value === null) return "null" as const;
  return typeof value;
}

function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

function isReachableWithout(
  workflow: AutomationWorkflowDefinition,
  targetId: string,
  blockedId: string,
): boolean {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const pending = [workflow.entry];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === blockedId || visited.has(current)) continue;
    if (current === targetId) return true;
    visited.add(current);
    const node = nodeById.get(current);
    if (node) pending.push(...targets(node));
  }
  return false;
}

function isReachableFrom(
  workflow: AutomationWorkflowDefinition,
  startId: string,
  targetId: string,
): boolean {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const visited = new Set<string>();
  const pending = [startId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = nodeById.get(current);
    if (node) pending.push(...targets(node));
  }
  return false;
}

function resolveNodes(
  workflow: AutomationWorkflowDefinition,
  issues: AutomationWorkflowCompileIssue[],
): Map<string, ResolvedNode> {
  const resolved = new Map<string, ResolvedNode>();
  workflow.nodes.forEach((node, nodeIndex) => {
    if (!isComponentNode(node)) return;
    const manifest = getAutomationWorkflowComponent(node.component);
    if (!manifest) {
      issues.push(issue(
        "unknown_component",
        ["nodes", nodeIndex, "component"],
        `component ${automationWorkflowComponentKey(node.component)} is not installed`,
        "Select an exact component id and immutable version from the component catalog.",
      ));
      return;
    }
    if (manifest.serializable.kind !== node.kind) {
      issues.push(issue(
        "component_kind_mismatch",
        ["nodes", nodeIndex, "component"],
        `component ${automationWorkflowComponentKey(node.component)} is ${manifest.serializable.kind}, not ${node.kind}`,
        `Place this component in a ${manifest.serializable.kind} node or choose a ${node.kind} component.`,
      ));
      return;
    }
    const parsedConfig = manifest.config_schema.safeParse(node.config);
    if (!parsedConfig.success) {
      for (const configIssue of parsedConfig.error.issues) {
        issues.push(issue(
          "component_config_invalid",
          ["nodes", nodeIndex, "config", ...configIssue.path],
          configIssue.message,
          `Provide config accepted by ${automationWorkflowComponentKey(node.component)}.`,
        ));
      }
      return;
    }
    resolved.set(node.id, {
      node,
      node_index: nodeIndex,
      manifest,
      config: parsedConfig.data as Record<string, AutomationWorkflowJsonValue>,
    });
  });
  return resolved;
}

function validateComponentInputs(
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
) {
  for (const entry of resolved.values()) {
    const { node, node_index: nodeIndex, manifest } = entry;
    const ports = manifest.serializable.input_ports;
    if (node.kind === "trigger") {
      const requiredCount = Object.values(ports).filter((port) => port.required).length;
      if (requiredCount > 0) {
        issues.push(issue(
          "component_input_missing",
          ["nodes", nodeIndex, "component"],
          `trigger component declares ${requiredCount} required input ports`,
          "Use a trigger component with no upstream inputs.",
        ));
      }
      continue;
    }

    for (const [portName, port] of Object.entries(ports)) {
      if (port.required && !node.inputs[portName]) {
        issues.push(issue(
          "component_input_missing",
          ["nodes", nodeIndex, "inputs", portName],
          `required input port ${portName} (${port.contract}) is missing`,
          `Connect an earlier ${port.contract} output to inputs.${portName}.`,
        ));
      }
    }
    for (const [inputName, ref] of Object.entries(node.inputs)) {
      const port = ports[inputName];
      if (!port) {
        issues.push(issue(
          "component_input_unexpected",
          ["nodes", nodeIndex, "inputs", inputName],
          `component ${automationWorkflowComponentKey(node.component)} has no input port named ${inputName}`,
          "Remove the input or connect it to an exact named port from the component manifest.",
        ));
        continue;
      }
      const sourceContract = resolved.get(ref.node_id)?.manifest.serializable.output_contract ?? null;
      if (!sourceContract) {
        issues.push(issue(
          "input_source_has_no_contract",
          ["nodes", nodeIndex, "inputs", inputName],
          `input ${inputName} references node ${ref.node_id}, which has no resolved component output contract`,
          "Reference an earlier component node whose immutable output contract matches this input.",
        ));
      } else if (sourceContract !== port.contract) {
        issues.push(issue(
          "component_input_contract_mismatch",
          ["nodes", nodeIndex, "inputs", inputName],
          `input port ${inputName} requires ${port.contract} but ${ref.node_id} produces ${sourceContract}`,
          `Connect a ${port.contract} output to inputs.${inputName}.`,
        ));
      }
    }
  }
}

function validateConditions(
  workflow: AutomationWorkflowDefinition,
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
) {
  workflow.nodes.forEach((node, nodeIndex) => {
    if (node.kind !== "condition") return;
    const source = resolved.get(node.predicate.value.node_id);
    if (!source) {
      issues.push(issue(
        "input_source_has_no_contract",
        ["nodes", nodeIndex, "predicate", "value"],
        `condition source ${node.predicate.value.node_id} has no resolved component output contract`,
        "Point the condition at a typed value path exposed by an earlier component.",
      ));
      return;
    }
    const output = source.manifest.serializable.output_value_paths.find((candidate) =>
      pathKey(candidate.path) === pathKey(node.predicate.value.path)
    );
    if (!output) {
      issues.push(issue(
        "condition_path_unknown",
        ["nodes", nodeIndex, "predicate", "value", "path"],
        `${automationWorkflowComponentKey(source.node.component)} does not expose ${node.predicate.value.path.join(".") || "the output root"} as a condition value`,
        "Choose one of the component's typed output_value_paths.",
      ));
      return;
    }
    const expectedType = valueType(node.predicate.expected);
    if (expectedType !== output.type) {
      issues.push(issue(
        "condition_type_mismatch",
        ["nodes", nodeIndex, "predicate", "expected"],
        `condition compares ${output.type} output to ${expectedType}`,
        `Use a ${output.type} expected value for ${node.predicate.value.path.join(".")}.`,
      ));
    }
    if (node.predicate.operator === "contains" && output.type !== "string") {
      issues.push(issue(
        "condition_type_mismatch",
        ["nodes", nodeIndex, "predicate", "operator"],
        "contains is supported only for typed string outputs",
        "Choose a string output path or a comparison operator compatible with the output type.",
      ));
    }
  });
}

function validateReferenceDominance(
  workflow: AutomationWorkflowDefinition,
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
) {
  workflow.nodes.forEach((node, nodeIndex) => {
    const references: Array<{
      source_node_id: string;
      path: Array<string | number>;
    }> = [];
    if (node.kind === "condition") {
      references.push({
        source_node_id: node.predicate.value.node_id,
        path: ["nodes", nodeIndex, "predicate", "value", "node_id"],
      });
    } else if (node.kind === "approval") {
      references.push({
        source_node_id: node.subject.node_id,
        path: ["nodes", nodeIndex, "subject", "node_id"],
      });
    } else if (node.kind === "terminal") {
      if (node.terminal.outcome === "complete") {
        references.push({
          source_node_id: node.terminal.result.node_id,
          path: ["nodes", nodeIndex, "terminal", "result", "node_id"],
        });
      }
    } else if (node.kind !== "trigger") {
      for (const [inputName, ref] of Object.entries(node.inputs)) {
        references.push({
          source_node_id: ref.node_id,
          path: ["nodes", nodeIndex, "inputs", inputName, "node_id"],
        });
      }
    }

    for (const reference of references) {
      const source = resolved.get(reference.source_node_id);
      if (!source) {
        issues.push(issue(
          "reference_source_has_no_output",
          reference.path,
          `referenced node ${reference.source_node_id} has no resolved typed component output`,
          "Reference an output-producing component node from the same workflow run.",
        ));
        continue;
      }
      if (isReachableWithout(workflow, node.id, reference.source_node_id)) {
        issues.push(issue(
          "reference_bypass",
          reference.path,
          `node ${node.id} is reachable without producing referenced output ${reference.source_node_id}`,
          "Route every path to the consumer through the referenced producer so run-local data is always available.",
        ));
      }
      const availableExits = new Set<string>(source.manifest.serializable.output_available_on);
      for (const edge of namedTargets(source.node)) {
        if (
          !availableExits.has(edge.exit) &&
          isReachableFrom(workflow, edge.target, node.id)
        ) {
          issues.push(issue(
            "reference_output_unavailable",
            reference.path,
            `node ${node.id} can consume ${reference.source_node_id} after its non-output ${edge.exit} exit`,
            `Route ${source.node.id}.${edge.exit} away from consumers of ${source.manifest.serializable.output_contract}.`,
          ));
        }
      }
    }
  });
}

function validateApprovals(
  workflow: AutomationWorkflowDefinition,
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
) {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const usedApprovals = new Set<string>();
  for (const entry of resolved.values()) {
    const { node, node_index: nodeIndex, manifest } = entry;
    if (node.kind !== "effect") continue;
    if (!node.approval_node_id) {
      if (manifest.serializable.authority.approval_floor === "per_run") {
        issues.push(issue(
          "approval_required",
          ["nodes", nodeIndex, "approval_node_id"],
          `${automationWorkflowComponentKey(node.component)} requires one approval for every run`,
          "Insert an approval node over the exact effect subject and bind approval_node_id.",
        ));
      }
      continue;
    }
    if (manifest.serializable.authority.approval_floor !== "per_run") {
      issues.push(issue(
        "approval_not_supported",
        ["nodes", nodeIndex, "approval_node_id"],
        `${automationWorkflowComponentKey(node.component)} does not declare an approval contract or approver role`,
        "Remove the approval binding or select a component version whose approval_floor is per_run.",
      ));
      continue;
    }
    usedApprovals.add(node.approval_node_id);
    const approval = nodeById.get(node.approval_node_id);
    if (!approval || approval.kind !== "approval") continue;
    const subjectPort = manifest.serializable.authority.approval_subject_port;
    const subjectInput = subjectPort ? node.inputs[subjectPort] : undefined;
    if (!subjectInput || subjectInput.node_id !== approval.subject.node_id) {
      issues.push(issue(
        "approval_subject_mismatch",
        ["nodes", nodeIndex, "approval_node_id"],
        `approval ${approval.id} does not authorize the ${subjectPort ?? "declared"} subject input of effect ${node.id}`,
        "Make the approval subject reference the exact output connected to the component's immutable approval_subject_port.",
      ));
    }
    if (approval.on_approved !== node.id) {
      issues.push(issue(
        "approval_flow_invalid",
        ["nodes", workflow.nodes.indexOf(approval), "on_approved"],
        `approval ${approval.id} must transition directly to effect ${node.id}`,
        "Set on_approved to the exact effect node; rejected and expired branches must remain non-effect paths.",
      ));
    }
    if (
      isReachableFrom(workflow, approval.on_rejected, node.id) ||
      isReachableFrom(workflow, approval.on_expired, node.id)
    ) {
      issues.push(issue(
        "approval_denial_bypass",
        ["nodes", workflow.nodes.indexOf(approval)],
        `a rejected or expired decision from approval ${approval.id} can still reach effect ${node.id}`,
        "Route rejected and expired branches only to non-effect recovery or escalation terminals.",
      ));
    }
    if (isReachableWithout(workflow, node.id, approval.id)) {
      issues.push(issue(
        "approval_bypass",
        ["nodes", nodeIndex],
        `effect ${node.id} is reachable without passing approval ${approval.id}`,
        "Remove every bypass so the approval node dominates the effect on all entry paths.",
      ));
    }
  }

  workflow.nodes.forEach((node, nodeIndex) => {
    if (node.kind === "approval" && !usedApprovals.has(node.id)) {
      issues.push(issue(
        "approval_unused",
        ["nodes", nodeIndex],
        `approval ${node.id} is not bound to an effect`,
        "Bind it through an effect approval_node_id or remove the unused approval node.",
      ));
    }
  });
}

function validateRunnerBinding(
  workflow: AutomationWorkflowDefinition,
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
) {
  const requiresRepository = [...resolved.values()].some(({ manifest }) =>
    manifest.serializable.side_effect.kind === "customer_runner_workspace" ||
    manifest.serializable.id === "effect.github.draft-pr"
  );
  if (requiresRepository && (!workflow.runner.repository || !workflow.runner.default_branch)) {
    issues.push(issue(
      "runner_repository_required",
      ["runner"],
      "the selected code-changing components require an exact HTTPS repository and default branch",
      "Bind runner.repository and runner.default_branch before compiling this workflow.",
    ));
  }
  const requiresAgentBudget = [...resolved.values()].some(({ node }) =>
    node.kind === "agent_task"
  );
  if (requiresAgentBudget && workflow.limits.max_cost_usd_per_run === undefined) {
    issues.push(issue(
      "agent_cost_limit_required",
      ["limits", "max_cost_usd_per_run"],
      "agent_task nodes require one aggregate per-run cost ceiling",
      "Set limits.max_cost_usd_per_run before compiling an unattended agent workflow.",
    ));
  }
}

function validateAggregateBudgets(
  workflow: AutomationWorkflowDefinition,
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
) {
  const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const memo = new Map<string, number>();
  const maximumFrom = (nodeId: string): number => {
    const cached = memo.get(nodeId);
    if (cached !== undefined) return cached;
    const node = nodeById.get(nodeId);
    if (!node) return 0;
    const own = resolved.get(nodeId)?.manifest.serializable.side_effect.kind === "external_provider"
      ? 1
      : 0;
    const downstream = targets(node).map(maximumFrom);
    const total = own + (downstream.length === 0 ? 0 : Math.max(...downstream));
    memo.set(nodeId, total);
    return total;
  };
  const requiredPerRun = maximumFrom(workflow.entry);
  if (requiredPerRun > workflow.limits.max_external_effects_per_run) {
    issues.push(issue(
      "external_effect_budget_exceeded",
      ["limits", "max_external_effects_per_run"],
      `a workflow path can execute ${requiredPerRun} external effects but the aggregate per-run limit is ${workflow.limits.max_external_effects_per_run}`,
      "Raise the explicit aggregate limit or remove external effect nodes from the same execution path.",
    ));
  }
  if (requiredPerRun > workflow.limits.max_external_effects_per_day) {
    issues.push(issue(
      "external_effect_budget_exceeded",
      ["limits", "max_external_effects_per_day"],
      `one workflow path can require ${requiredPerRun} external effects but the aggregate daily limit is ${workflow.limits.max_external_effects_per_day}`,
      "Set a daily aggregate limit that can complete one allowed path, or remove external effects.",
    ));
  }

  const maximumWorkspaceValue = (
    field: "max_files_changed_config_field" | "max_changed_lines_config_field",
  ) => {
    const workspaceMemo = new Map<string, number>();
    const maximumWorkspaceFrom = (nodeId: string): number => {
      const cached = workspaceMemo.get(nodeId);
      if (cached !== undefined) return cached;
      const node = nodeById.get(nodeId);
      if (!node) return 0;
      const component = resolved.get(nodeId);
      const policy = component?.manifest.serializable.side_effect.workspace_policy;
      const configValue = policy ? component?.config[policy[field]] : 0;
      const own = typeof configValue === "number" && Number.isFinite(configValue)
        ? configValue
        : 0;
      const downstream = targets(node).map(maximumWorkspaceFrom);
      const total = own + (downstream.length === 0 ? 0 : Math.max(...downstream));
      workspaceMemo.set(nodeId, total);
      return total;
    };
    return maximumWorkspaceFrom(workflow.entry);
  };
  const requiredFiles = maximumWorkspaceValue("max_files_changed_config_field");
  if (requiredFiles > workflow.limits.max_files_changed_per_run) {
    issues.push(issue(
      "workspace_budget_exceeded",
      ["limits", "max_files_changed_per_run"],
      `a workflow path grants up to ${requiredFiles} changed files but the aggregate per-run limit is ${workflow.limits.max_files_changed_per_run}`,
      "Raise the explicit aggregate workspace limit or reduce node-local file grants on that path.",
    ));
  }
  const requiredLines = maximumWorkspaceValue("max_changed_lines_config_field");
  if (requiredLines > workflow.limits.max_changed_lines_per_run) {
    issues.push(issue(
      "workspace_budget_exceeded",
      ["limits", "max_changed_lines_per_run"],
      `a workflow path grants up to ${requiredLines} changed lines but the aggregate per-run limit is ${workflow.limits.max_changed_lines_per_run}`,
      "Raise the explicit aggregate workspace limit or reduce node-local line grants on that path.",
    ));
  }

  const suspensionMemo = new Map<string, number>();
  const maximumSuspensionFrom = (nodeId: string): number => {
    const cached = suspensionMemo.get(nodeId);
    if (cached !== undefined) return cached;
    const node = nodeById.get(nodeId);
    if (!node) return 0;
    let own = node.kind === "approval" ? node.expires_after_seconds : 0;
    const component = resolved.get(nodeId);
    const timing = component?.manifest.serializable.timing;
    if (timing?.mode === "durable_wait" && timing.max_wait_seconds_config_field) {
      const configured = component?.config[timing.max_wait_seconds_config_field];
      if (typeof configured === "number" && Number.isFinite(configured)) own += configured;
    }
    const downstream = targets(node).map(maximumSuspensionFrom);
    const total = own + (downstream.length === 0 ? 0 : Math.max(...downstream));
    suspensionMemo.set(nodeId, total);
    return total;
  };
  const requiredSuspension = maximumSuspensionFrom(workflow.entry);
  const requiredElapsed = workflow.limits.max_active_runtime_seconds + requiredSuspension;
  if (requiredElapsed > workflow.limits.max_elapsed_seconds) {
    issues.push(issue(
      "elapsed_budget_exceeded",
      ["limits", "max_elapsed_seconds"],
      `active runtime plus configured approval/wait windows can require ${requiredElapsed} seconds but max_elapsed_seconds is ${workflow.limits.max_elapsed_seconds}`,
      "Raise the explicit elapsed deadline or shorten approval, deploy-wait, and verification windows on the longest path.",
    ));
  }
}

function collectRequirements(
  resolved: Map<string, ResolvedNode>,
  issues: AutomationWorkflowCompileIssue[],
): RequirementWithSources[] {
  const collected = new Map<string, RequirementWithSources>();
  const add = (requirement: AutomationWorkflowRequirement, nodeId: string) => {
    const prior = collected.get(requirement.id);
    if (!prior) {
      collected.set(requirement.id, {
        ...requirement,
        required_by_node_ids: [nodeId],
      });
      return;
    }
    if (
      prior.kind !== requirement.kind ||
      prior.requirement !== requirement.requirement ||
      prior.next_action !== requirement.next_action
    ) {
      issues.push(issue(
        "requirement_conflict",
        ["nodes", resolved.get(nodeId)?.node_index ?? 0, "component"],
        `requirement ${requirement.id} has conflicting definitions`,
        "Give distinct immutable requirement ids to requirements with different semantics.",
      ));
      return;
    }
    prior.required_by_node_ids = [...new Set([...prior.required_by_node_ids, nodeId])].sort();
  };
  for (const requirement of COMMON_REQUIREMENTS) {
    add(requirement, "$workflow");
  }
  for (const { node, manifest, config } of resolved.values()) {
    for (const requirement of manifest.requirements(config)) {
      add(requirement, node.id);
    }
  }
  return [...collected.values()]
    .map((requirement) => ({
      ...requirement,
      required_by_node_ids: [...new Set(requirement.required_by_node_ids)].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function compileAutomationWorkflow(
  input: unknown,
): Promise<AutomationWorkflowCompileResult> {
  const structural = validateAutomationWorkflow(input);
  if (!structural.success) {
    return {
      success: false,
      issues: structural.issues.map((structuralIssue) => issue(
        structuralIssue.code,
        structuralIssue.path,
        structuralIssue.message,
        "Fix the workflow graph or structured field, then compile the disabled candidate again.",
      )),
    };
  }

  const workflow = structural.data;
  const issues: AutomationWorkflowCompileIssue[] = [];
  const resolved = resolveNodes(workflow, issues);
  validateComponentInputs(resolved, issues);
  validateConditions(workflow, resolved, issues);
  validateReferenceDominance(workflow, resolved, issues);
  validateApprovals(workflow, resolved, issues);
  validateRunnerBinding(workflow, resolved, issues);
  validateAggregateBudgets(workflow, resolved, issues);
  const requirements = collectRequirements(resolved, issues);
  if (issues.length > 0) return { success: false, issues };

  const normalizedWorkflow: AutomationWorkflowDefinition = {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      const component = resolved.get(node.id);
      return component ? { ...node, config: component.config } : node;
    }) as AutomationWorkflowDefinition["nodes"],
  };
  return {
    success: true,
    data: await buildCompiledWorkflow(normalizedWorkflow, resolved, requirements),
  };
}

async function buildCompiledWorkflow(
  workflow: AutomationWorkflowDefinition,
  resolved: Map<string, ResolvedNode>,
  requirements: RequirementWithSources[],
) {
  const uniqueComponents = new Map<string, AutomationWorkflowComponentManifest>();
  for (const { manifest } of resolved.values()) {
    uniqueComponents.set(automationWorkflowComponentKey(manifest.serializable), manifest);
  }
  const serializedComponents = await Promise.all(
    [...uniqueComponents.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, manifest]) => serializeAutomationWorkflowComponent(manifest)),
  );
  const serializedByKey = new Map(serializedComponents.map((component) => [
    automationWorkflowComponentKey(component),
    component,
  ]));
  const principalRequirements = [...resolved.values()].map(({ node, manifest }) => ({
    node_id: node.id,
    component: node.component,
    roles: manifest.serializable.principal_roles,
  }));
  const requiredPrincipals = [...new Set(principalRequirements.flatMap(({ roles }) => [
    roles.executor,
    ...roles.callers,
    ...(roles.approver ? [roles.approver] : []),
    ...roles.evidence_sources,
  ]))].sort() as AutomationWorkflowPrincipal[];
  const declaredSideEffects = [...resolved.values()]
    .filter(({ manifest }) => manifest.serializable.side_effect.kind !== "none")
    .map(({ node, manifest }) => ({
      node_id: node.id,
      component: node.component,
      ...manifest.serializable.side_effect,
      authority: manifest.serializable.authority,
    }));
  const forbiddenEffects = [...new Set(
    [...resolved.values()].flatMap(({ manifest }) => manifest.serializable.side_effect.forbidden),
  )].sort();
  const runtimeInvariants = [...new Set([
    "every node transition is appended to the immutable run event ledger",
    "every component input is loaded from an earlier output in the same workflow run",
    "every input and output validates against its frozen immutable payload schema hash and assurance floor",
    "aggregate external-effect budgets are checked before every provider action",
    "aggregate workspace file and changed-line budgets are checked across the whole run",
    "active compute time and suspended wall-clock time are metered separately under one elapsed deadline",
    "external provider effects reserve one input-, component-, and target-bound intent before the call; adapters must use provider idempotency or reconciliation before retry",
    "telemetry and analytics values are typed data with no instruction authority",
    "one consumed server trigger receipt creates at most one workflow run",
    "limits and the project kill switch are checked before every node attempt and effect",
    ...[...resolved.values()].flatMap(({ manifest }) => manifest.serializable.lineage.runtime_preconditions),
  ])].sort();
  const workflowHash = await sha256Hex(canonicalJsonStringify(workflow));
  const canonicalOutput = {
    kind: "automation_workflow_compile" as const,
    schema_version: "3" as const,
    workflow,
    workflow_hash: workflowHash,
    candidate: {
      enabled: false as const,
      workflow,
      workflow_hash: workflowHash,
    },
    resolved_components: serializedComponents,
    resolved_nodes: [...resolved.values()].map(({ node, manifest }) => ({
      node_id: node.id,
      component: node.component,
      component_hash: serializedByKey.get(automationWorkflowComponentKey(manifest.serializable))!.component_hash,
      input_ports: serializedByKey.get(automationWorkflowComponentKey(manifest.serializable))!.input_ports,
      output_contract: manifest.serializable.output_contract,
      output_contract_schema_hash: serializedByKey.get(automationWorkflowComponentKey(manifest.serializable))!.output_contract_schema_hash,
      output_minimum_assurance: serializedByKey.get(automationWorkflowComponentKey(manifest.serializable))!.output_minimum_assurance,
    })),
    requirements,
    principals: {
      required: requiredPrincipals,
      by_node: principalRequirements,
    },
    policy: {
      data_boundary: {
        telemetry_is_untrusted_data: true as const,
        never_follow_telemetry_instructions: true as const,
        never_execute_telemetry_commands: true as const,
        allow_external_urls_from_telemetry: false as const,
      },
      runtime_invariants: runtimeInvariants,
      aggregate_external_effect_limits: {
        max_per_run: workflow.limits.max_external_effects_per_run,
        max_per_day: workflow.limits.max_external_effects_per_day,
      },
      aggregate_workspace_limits: {
        max_files_changed_per_run: workflow.limits.max_files_changed_per_run,
        max_changed_lines_per_run: workflow.limits.max_changed_lines_per_run,
      },
      time_limits: {
        max_active_runtime_seconds: workflow.limits.max_active_runtime_seconds,
        max_elapsed_seconds: workflow.limits.max_elapsed_seconds,
      },
      declared_side_effects: declaredSideEffects,
      forbidden_effects: forbiddenEffects,
    },
    readiness: {
      ready_for_owner_review: true as const,
      ready_to_enable: false as const,
      reason: "workflow v3 compiles and has a durable runtime core, but production component adapters and lifecycle gates are not proved" as const,
    },
    compile_side_effects: {
      database_writes: false as const,
      workflow_saved: false as const,
      workflow_enabled: false as const,
      credential_minted: false as const,
      scheduler_registered: false as const,
      provider_action_started: false as const,
      report_published_or_sent: false as const,
    },
    next_action: "Review and save this disabled deterministic candidate. Keep enablement closed until every selected production adapter and lifecycle gate is proved." as const,
  };
  return {
    ...canonicalOutput,
    compile_hash: await sha256Hex(canonicalJsonStringify(canonicalOutput)),
  };
}
