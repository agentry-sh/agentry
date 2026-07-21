import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import { sha256Hex } from "./crypto.js";

export const AUTOMATION_WORKFLOW_SCHEMA_VERSION = "3" as const;
export const AUTOMATION_WORKFLOW_MAX_NODES = 100 as const;
export const AUTOMATION_WORKFLOW_MAX_CONFIG_DEPTH = 20 as const;
export const AUTOMATION_WORKFLOW_MAX_CONFIG_VALUES = 2_000 as const;
export const AUTOMATION_WORKFLOW_MAX_CONFIG_CONTAINER_ITEMS = 100 as const;
export const AUTOMATION_WORKFLOW_MAX_CONFIG_STRING_CHARS = 100_000 as const;

export async function automationWorkflowHeadEtag(input: {
  project_id: string;
  automation_id: string;
  current_revision_id: string;
  current_revision: number;
  workflow_hash: string;
  compile_hash: string;
  enabled: boolean;
  active_revision_id: string | null;
  active_execution_authority_id?: string | null;
  paused_at: number | null;
  pause_reason: string | null;
  updated_at: number;
}): Promise<string> {
  return `"${await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-head-etag-v2",
    ...input,
    active_execution_authority_id: input.active_execution_authority_id ?? null,
  }))}"`;
}

export async function automationWorkflowProjectControlEtag(input: {
  project_id: string;
  revision: number;
  paused_at: number | null;
  pause_reason: string | null;
  updated_at: number;
}): Promise<string> {
  return `"${await sha256Hex(canonicalJsonStringify({
    namespace: "agentry-automation-workflow-project-control-etag-v1",
    ...input,
  }))}"`;
}

const workflowId = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);
const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,99}$/);
const boundedText = (max: number) => z.string().trim().min(1).max(max);
export const AutomationWorkflowRepositoryUrlSchema = z.string().url().max(500).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      parsed.search === "" &&
      parsed.hash === "" &&
      parsed.pathname !== "/";
  } catch {
    return false;
  }
}, "must be an absolute HTTPS repository URL without credentials, query parameters, fragments, or an empty path");

export const AutomationWorkflowGitBranchSchema = z.string().trim().min(1).max(200)
  .refine((value) =>
    !value.startsWith("-") &&
    value !== "HEAD" &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[\u0000-\u0020\u007f]/u.test(value) &&
    !["~", "^", ":", "?", "*", "[", "\\"].some((character) => value.includes(character)) &&
    value.split("/").every((component) =>
      !component.startsWith(".") && !component.endsWith(".lock")
    ),
  "must be a conservative Git branch ref without option prefixes, control characters, spaces, or Git-reserved sequences");

export type AutomationWorkflowJsonValue =
  | string
  | number
  | boolean
  | null
  | AutomationWorkflowJsonValue[]
  | { [key: string]: AutomationWorkflowJsonValue };

export const AutomationWorkflowComponentRefSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(200),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
}).strict();

export const AutomationWorkflowOutputRefSchema = z.object({
  node_id: nodeId,
}).strict();

export const AutomationWorkflowValueRefSchema = z.object({
  node_id: nodeId,
  path: z.array(boundedText(100)).max(20).default([]),
}).strict();

const nodeInputs = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
  AutomationWorkflowOutputRefSchema,
).superRefine((value, ctx) => {
  const count = Object.keys(value).length;
  if (count < 1 || count > 20) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inputs must contain between 1 and 20 named references",
    });
  }
});

type ConfigInspectionIssue = {
  path: Array<string | number>;
  message: string;
};

function inspectJsonConfig(root: Record<string, unknown>): ConfigInspectionIssue[] {
  const issues: ConfigInspectionIssue[] = [];
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; path: Array<string | number>; depth: number }> = [
    { value: root, path: [], depth: 0 },
  ];
  let inspectedValues = 0;
  let stringChars = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    inspectedValues += 1;
    if (inspectedValues > AUTOMATION_WORKFLOW_MAX_CONFIG_VALUES) {
      issues.push({
        path: current.path,
        message: `config supports at most ${AUTOMATION_WORKFLOW_MAX_CONFIG_VALUES} nested values`,
      });
      break;
    }
    if (current.depth > AUTOMATION_WORKFLOW_MAX_CONFIG_DEPTH) {
      issues.push({
        path: current.path,
        message: `config nesting depth cannot exceed ${AUTOMATION_WORKFLOW_MAX_CONFIG_DEPTH}`,
      });
      continue;
    }
    const value = current.value;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        issues.push({ path: current.path, message: "config numbers must be finite" });
      }
      continue;
    }
    if (typeof value === "string") {
      stringChars += value.length;
      if (stringChars > AUTOMATION_WORKFLOW_MAX_CONFIG_STRING_CHARS) {
        issues.push({
          path: current.path,
          message: `config strings support at most ${AUTOMATION_WORKFLOW_MAX_CONFIG_STRING_CHARS} total characters`,
        });
        break;
      }
      continue;
    }
    if (typeof value !== "object") {
      issues.push({
        path: current.path,
        message: "config values must be JSON strings, finite numbers, booleans, null, arrays, or plain objects",
      });
      continue;
    }
    if (seen.has(value)) {
      issues.push({ path: current.path, message: "config must not contain cyclic references" });
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > AUTOMATION_WORKFLOW_MAX_CONFIG_CONTAINER_ITEMS) {
        issues.push({
          path: current.path,
          message: `config arrays support at most ${AUTOMATION_WORKFLOW_MAX_CONFIG_CONTAINER_ITEMS} items`,
        });
        continue;
      }
      value.forEach((nested, index) => stack.push({
        value: nested,
        path: [...current.path, index],
        depth: current.depth + 1,
      }));
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push({ path: current.path, message: "config objects must be plain JSON objects" });
      continue;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > AUTOMATION_WORKFLOW_MAX_CONFIG_CONTAINER_ITEMS) {
      issues.push({
        path: current.path,
        message: `config objects support at most ${AUTOMATION_WORKFLOW_MAX_CONFIG_CONTAINER_ITEMS} fields`,
      });
      continue;
    }
    for (const [key, nested] of entries) {
      if (key.length > 200) {
        issues.push({ path: [...current.path, key], message: "config field names support at most 200 characters" });
        continue;
      }
      stack.push({
        value: nested,
        path: [...current.path, key],
        depth: current.depth + 1,
      });
    }
  }
  return issues;
}

const componentConfig = z.record(z.unknown()).superRefine((value, ctx) => {
  for (const configIssue of inspectJsonConfig(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: configIssue.path,
      message: configIssue.message,
    });
  }
}) as z.ZodType<Record<string, AutomationWorkflowJsonValue>>;

const componentNode = {
  id: nodeId,
  label: boundedText(200).optional(),
  component: AutomationWorkflowComponentRefSchema,
  config: componentConfig,
};

const linearComponentNode = {
  ...componentNode,
  inputs: nodeInputs,
  next: nodeId,
  on_error: nodeId,
};

const TriggerNodeSchema = z.object({
  ...componentNode,
  kind: z.literal("trigger"),
  next: nodeId,
  on_error: nodeId,
}).strict();

const QueryNodeSchema = z.object({
  ...linearComponentNode,
  kind: z.literal("query"),
}).strict();

const AgentTaskNodeSchema = z.object({
  ...linearComponentNode,
  kind: z.literal("agent_task"),
}).strict();

const EffectNodeSchema = z.object({
  ...linearComponentNode,
  kind: z.literal("effect"),
  approval_node_id: nodeId.optional(),
}).strict();

const WaitNodeSchema = z.object({
  ...componentNode,
  kind: z.literal("wait"),
  inputs: nodeInputs,
  on_ready: nodeId,
  on_timeout: nodeId,
  on_error: nodeId,
}).strict();

const VerifyNodeSchema = z.object({
  ...componentNode,
  kind: z.literal("verify"),
  inputs: nodeInputs,
  on_pass: nodeId,
  on_fail: nodeId,
  on_timeout: nodeId,
  on_error: nodeId,
}).strict();

const ConditionNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("condition"),
  label: boundedText(200).optional(),
  predicate: z.object({
    value: AutomationWorkflowValueRefSchema,
    operator: z.enum(["eq", "not_eq", "gt", "gte", "lt", "lte", "contains"]),
    expected: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  }).strict(),
  on_true: nodeId,
  on_false: nodeId,
  on_error: nodeId,
}).strict();

const ApprovalNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("approval"),
  label: boundedText(200).optional(),
  subject: AutomationWorkflowOutputRefSchema,
  expires_after_seconds: z.number().int().min(300).max(2_592_000),
  on_approved: nodeId,
  on_rejected: nodeId,
  on_expired: nodeId,
}).strict();

const TerminalNodeSchema = z.object({
  id: nodeId,
  kind: z.literal("terminal"),
  label: boundedText(200).optional(),
  terminal: z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("complete"),
      result: AutomationWorkflowOutputRefSchema,
    }).strict(),
    z.object({
      outcome: z.literal("escalate"),
      destination: boundedText(500),
      instructions: boundedText(2_000),
    }).strict(),
  ]),
}).strict();

export const AutomationWorkflowNodeSchema = z.discriminatedUnion("kind", [
  TriggerNodeSchema,
  QueryNodeSchema,
  ConditionNodeSchema,
  AgentTaskNodeSchema,
  ApprovalNodeSchema,
  EffectNodeSchema,
  WaitNodeSchema,
  VerifyNodeSchema,
  TerminalNodeSchema,
]);

export const AutomationWorkflowRunnerSchema = z.object({
  provider: z.enum(["codex", "claude_code", "github_actions", "custom"]),
  repository_provider: z.enum(["github", "gitlab", "bitbucket", "custom"]).optional(),
  repository: AutomationWorkflowRepositoryUrlSchema.optional(),
  default_branch: AutomationWorkflowGitBranchSchema.optional(),
  environment: boundedText(100).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.repository === undefined) !== (value.default_branch === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.repository === undefined ? "repository" : "default_branch"],
      message: "repository and default_branch must be provided together",
    });
  }
  if ((value.repository === undefined) !== (value.repository_provider === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.repository === undefined ? "repository" : "repository_provider"],
      message: "repository_provider must be provided exactly when repository is provided",
    });
  }
  if (value.repository && value.repository_provider && value.repository_provider !== "custom") {
    const expectedHosts = {
      github: "github.com",
      gitlab: "gitlab.com",
      bitbucket: "bitbucket.org",
    } as const;
    const actualHost = new URL(value.repository).hostname.toLowerCase();
    if (actualHost !== expectedHosts[value.repository_provider]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository"],
        message: `repository_provider ${value.repository_provider} requires host ${expectedHosts[value.repository_provider]}; use custom for an intentional enterprise host`,
      });
    }
  }
});

export const AutomationWorkflowLimitsSchema = z.object({
  max_runs_per_day: z.number().int().min(1).max(1_000),
  max_attempts_per_trigger: z.number().int().min(1).max(20),
  max_turns_per_run: z.number().int().min(1).max(500),
  max_active_runtime_seconds: z.number().int().min(60).max(86_400),
  max_elapsed_seconds: z.number().int().min(60).max(10_000_000),
  max_cost_usd_per_run: z.number().positive().max(10_000).optional(),
  retry_backoff_seconds: z.number().int().min(60).max(86_400),
  max_external_effects_per_run: z.number().int().min(0).max(100),
  max_external_effects_per_day: z.number().int().min(0).max(1_000),
  max_files_changed_per_run: z.number().int().min(0).max(100),
  max_changed_lines_per_run: z.number().int().min(0).max(10_000),
}).strict().superRefine((value, ctx) => {
  if (value.max_elapsed_seconds < value.max_active_runtime_seconds) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_elapsed_seconds"],
      message: "max_elapsed_seconds must be at least max_active_runtime_seconds",
    });
  }
});

export const AutomationWorkflowDefinitionSchema = z.object({
  schema_version: z.literal(AUTOMATION_WORKFLOW_SCHEMA_VERSION),
  id: workflowId,
  name: boundedText(200),
  description: boundedText(2_000).optional(),
  runner: AutomationWorkflowRunnerSchema,
  limits: AutomationWorkflowLimitsSchema,
  entry: nodeId,
  nodes: z.array(AutomationWorkflowNodeSchema).min(2).max(AUTOMATION_WORKFLOW_MAX_NODES),
}).strict();

export type AutomationWorkflowComponentRef = z.infer<typeof AutomationWorkflowComponentRefSchema>;
export type AutomationWorkflowOutputRef = z.infer<typeof AutomationWorkflowOutputRefSchema>;
export type AutomationWorkflowValueRef = z.infer<typeof AutomationWorkflowValueRefSchema>;
export type AutomationWorkflowNode = z.infer<typeof AutomationWorkflowNodeSchema>;
export type AutomationWorkflowDefinition = z.infer<typeof AutomationWorkflowDefinitionSchema>;

export type AutomationWorkflowValidationIssue = {
  code:
    | "schema_invalid"
    | "duplicate_node_id"
    | "entry_not_found"
    | "entry_not_trigger"
    | "trigger_count_invalid"
    | "target_not_found"
    | "edge_not_forward"
    | "reference_not_found"
    | "reference_not_prior"
    | "approval_reference_invalid"
    | "condition_operand_invalid"
    | "node_unreachable"
    | "path_not_terminal"
    | "complete_terminal_missing";
  path: Array<string | number>;
  message: string;
};

export type AutomationWorkflowValidationResult =
  | { success: true; data: AutomationWorkflowDefinition }
  | { success: false; issues: AutomationWorkflowValidationIssue[] };

type LocatedTarget = { target: string; field: string };
type LocatedReference = { ref: AutomationWorkflowOutputRef; path: Array<string | number> };

function transitionTargets(node: AutomationWorkflowNode): LocatedTarget[] {
  switch (node.kind) {
    case "trigger":
    case "query":
    case "agent_task":
    case "effect":
      return [
        { target: node.next, field: "next" },
        { target: node.on_error, field: "on_error" },
      ];
    case "condition":
      return [
        { target: node.on_true, field: "on_true" },
        { target: node.on_false, field: "on_false" },
        { target: node.on_error, field: "on_error" },
      ];
    case "approval":
      return [
        { target: node.on_approved, field: "on_approved" },
        { target: node.on_rejected, field: "on_rejected" },
        { target: node.on_expired, field: "on_expired" },
      ];
    case "wait":
      return [
        { target: node.on_ready, field: "on_ready" },
        { target: node.on_timeout, field: "on_timeout" },
        { target: node.on_error, field: "on_error" },
      ];
    case "verify":
      return [
        { target: node.on_pass, field: "on_pass" },
        { target: node.on_fail, field: "on_fail" },
        { target: node.on_timeout, field: "on_timeout" },
        { target: node.on_error, field: "on_error" },
      ];
    case "terminal":
      return [];
  }
}

function nodeReferences(node: AutomationWorkflowNode, nodeIndex: number): LocatedReference[] {
  if (node.kind === "trigger") return [];
  if (node.kind === "condition") {
    return [{
      ref: { node_id: node.predicate.value.node_id },
      path: ["nodes", nodeIndex, "predicate", "value", "node_id"],
    }];
  }
  if (node.kind === "approval") {
    return [{ ref: node.subject, path: ["nodes", nodeIndex, "subject", "node_id"] }];
  }
  if (node.kind === "terminal") {
    return node.terminal.outcome === "complete"
      ? [{ ref: node.terminal.result, path: ["nodes", nodeIndex, "terminal", "result", "node_id"] }]
      : [];
  }
  return Object.entries(node.inputs).map(([name, ref]) => ({
    ref,
    path: ["nodes", nodeIndex, "inputs", name, "node_id"],
  }));
}

export function validateAutomationWorkflow(input: unknown): AutomationWorkflowValidationResult {
  const parsed = AutomationWorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid" as const,
        path: issue.path,
        message: issue.message,
      })),
    };
  }

  const workflow = parsed.data;
  const issues: AutomationWorkflowValidationIssue[] = [];
  const nodeById = new Map<string, { node: AutomationWorkflowNode; index: number }>();

  workflow.nodes.forEach((node, index) => {
    const prior = nodeById.get(node.id);
    if (prior) {
      issues.push({
        code: "duplicate_node_id",
        path: ["nodes", index, "id"],
        message: `node id ${node.id} duplicates nodes[${prior.index}]`,
      });
      return;
    }
    nodeById.set(node.id, { node, index });
  });

  const entry = nodeById.get(workflow.entry);
  if (!entry) {
    issues.push({
      code: "entry_not_found",
      path: ["entry"],
      message: `entry node ${workflow.entry} does not exist`,
    });
  } else if (entry.node.kind !== "trigger") {
    issues.push({
      code: "entry_not_trigger",
      path: ["entry"],
      message: "entry must identify the workflow trigger node",
    });
  }

  const triggers = workflow.nodes.filter((node) => node.kind === "trigger");
  if (triggers.length !== 1) {
    issues.push({
      code: "trigger_count_invalid",
      path: ["nodes"],
      message: `workflow must contain exactly one trigger; found ${triggers.length}`,
    });
  }

  workflow.nodes.forEach((node, index) => {
    for (const edge of transitionTargets(node)) {
      const target = nodeById.get(edge.target);
      if (!target) {
        issues.push({
          code: "target_not_found",
          path: ["nodes", index, edge.field],
          message: `target node ${edge.target} does not exist`,
        });
      } else if (target.index <= index) {
        issues.push({
          code: "edge_not_forward",
          path: ["nodes", index, edge.field],
          message: `target ${edge.target} must appear after ${node.id}`,
        });
      }
    }

    for (const located of nodeReferences(node, index)) {
      const source = nodeById.get(located.ref.node_id);
      if (!source) {
        issues.push({
          code: "reference_not_found",
          path: located.path,
          message: `referenced node ${located.ref.node_id} does not exist`,
        });
      } else if (source.index >= index) {
        issues.push({
          code: "reference_not_prior",
          path: located.path,
          message: `referenced node ${located.ref.node_id} must appear before ${node.id}`,
        });
      }
    }

    if (node.kind === "effect" && node.approval_node_id) {
      const approval = nodeById.get(node.approval_node_id);
      if (!approval || approval.node.kind !== "approval" || approval.index >= index) {
        issues.push({
          code: "approval_reference_invalid",
          path: ["nodes", index, "approval_node_id"],
          message: "approval_node_id must reference an earlier approval node",
        });
      }
    }

    if (
      node.kind === "condition" &&
      ["gt", "gte", "lt", "lte"].includes(node.predicate.operator) &&
      typeof node.predicate.expected !== "number"
    ) {
      issues.push({
        code: "condition_operand_invalid",
        path: ["nodes", index, "predicate", "expected"],
        message: `${node.predicate.operator} requires a numeric expected value`,
      });
    }
  });

  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    const located = nodeById.get(id);
    if (!located) return;
    reachable.add(id);
    transitionTargets(located.node).forEach((edge) => visit(edge.target));
  };
  visit(workflow.entry);

  workflow.nodes.forEach((node, index) => {
    if (!reachable.has(node.id)) {
      issues.push({
        code: "node_unreachable",
        path: ["nodes", index],
        message: `node ${node.id} is not reachable from entry ${workflow.entry}`,
      });
    }
  });

  const terminalMemo = new Map<string, boolean>();
  const terminalVisiting = new Set<string>();
  const everyPathTerminates = (id: string): boolean => {
    const cached = terminalMemo.get(id);
    if (cached !== undefined) return cached;
    if (terminalVisiting.has(id)) return false;
    const located = nodeById.get(id);
    if (!located) return false;
    if (located.node.kind === "terminal") {
      terminalMemo.set(id, true);
      return true;
    }
    terminalVisiting.add(id);
    const targets = transitionTargets(located.node);
    const terminates = targets.length > 0 && targets.every((edge) => everyPathTerminates(edge.target));
    terminalVisiting.delete(id);
    terminalMemo.set(id, terminates);
    return terminates;
  };

  if (entry && !everyPathTerminates(workflow.entry)) {
    issues.push({
      code: "path_not_terminal",
      path: ["entry"],
      message: "every reachable branch must end at a terminal node",
    });
  }

  if (!workflow.nodes.some((node) =>
    node.kind === "terminal" && node.terminal.outcome === "complete"
  )) {
    issues.push({
      code: "complete_terminal_missing",
      path: ["nodes"],
      message: "workflow must contain at least one complete terminal",
    });
  }

  return issues.length === 0
    ? { success: true, data: workflow }
    : { success: false, issues };
}
