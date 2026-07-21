#!/usr/bin/env node
// Keep workflow markdown aligned with the API agents actually have.
// Workflow examples may be illustrative, but any executable-looking
// query-blueprint/public-query example must use a real query blueprint id.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKFLOWS_DIR,
  listWorkflowFiles,
  parseWorkflowMarkdown,
  workflowRelativePath,
} from "./lib/workflow-files.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const queryBlueprintTs = readFileSync(join(repoRoot, "apps/api/src/query-blueprint-catalog.ts"), "utf8");
const queryBlueprintIds = new Set(
  [...queryBlueprintTs.matchAll(/id:\s*["']([^"']+)["']/g)].map((match) => match[1]),
);

const workflowFiles = listWorkflowFiles();
const workflowSlugs = new Set(workflowFiles.map((file) => basename(file, ".md")));
const errors = [];
const featuredSlugs = [];
const automationTemplateRefs = [];
const REQUIRED_AUTOMATION_TEMPLATE_REFS = new Set([
  "error-to-draft-pr@2.0.0",
  "weekly-funnel-review@2.0.0",
]);
const ON_DEMAND_SECTIONS = [
  "Why this matters",
  "What you get",
  "Walk through it",
  "The output",
  "Setting it up",
  "Variations",
];

for (const path of workflowFiles) {
  const file = basename(path);
  const text = readFileSync(path, "utf8");
  const parsed = parseWorkflowMarkdown(text);
  const metadata = parsed.data;
  const label = workflowRelativePath(path);
  const executionMode = String(metadata.execution_mode ?? "on_demand");
  const body = parsed.content;

  const negativeFit = Array.isArray(metadata.negative_fit) ? metadata.negative_fit : [];
  const askIfMissing = Array.isArray(metadata.ask_if_missing) ? metadata.ask_if_missing : [];
  if (negativeFit.length === 0) {
    errors.push(`${label}: negative_fit must contain at least one explicit recommendation boundary`);
  }
  if (askIfMissing.length === 0) {
    errors.push(`${label}: ask_if_missing must contain at least one adaptation question`);
  }

  if (metadata.featured === true) {
    featuredSlugs.push(basename(file, ".md"));
  }

  if (executionMode === "automation_template") {
    const id = metadata.automation_playbook_id;
    const version = metadata.automation_playbook_version;
    if (id && version) {
      const ref = `${id}@${version}`;
      automationTemplateRefs.push(ref);
      if (!text.includes(`/v1/automation-playbooks/${id}`)) {
        errors.push(`${label}: automation-template prose must start from /v1/automation-playbooks/${id}`);
      }
      const versionedTemplateRefs = [
        ...text.matchAll(new RegExp(`/v1/automation-playbooks/${id}\\?version=([0-9]+\\.[0-9]+\\.[0-9]+)`, "g")),
      ].map((match) => match[1]);
      if (!versionedTemplateRefs.includes(version)) {
        errors.push(
          `${label}: automation-template prose must fetch ${id}?version=${version}`,
        );
      }
      const staleVersions = [...new Set(versionedTemplateRefs.filter((candidate) => candidate !== version))];
      if (staleVersions.length > 0) {
        errors.push(
          `${label}: automation-template prose references stale ${id} version(s): ${staleVersions.join(", ")}`,
        );
      }
      if (!/\bdisabled\b/i.test(body)) {
        errors.push(`${label}: automation-template prose must explain that rendering/saving leaves the candidate disabled`);
      }
    }
  }

  const wordCount = body.match(/\b[\w$][\w'-]*\b/g)?.length ?? 0;
  if (wordCount < 175) {
    errors.push(`${label}: body is too thin for training material (${wordCount} words; minimum 175)`);
  }

  if (executionMode === "on_demand") {
    const missingSections = ON_DEMAND_SECTIONS.filter((heading) => !body.includes(`## ${heading}`));
    if (missingSections.length > 0) {
      errors.push(`${label}: on_demand example is missing sections: ${missingSections.join(", ")}`);
    }
  }

  const legacyTools = [...text.matchAll(/\bagentry_[a-z_]+\b/g)]
    .map((match) => match[0])
    .filter((name) => ![
      "agentry_pk",
      "agentry_sk",
      "agentry_server",
      "agentry_ci",
      "agentry_runner",
    ].some((prefix) => name.startsWith(prefix)));
  if (legacyTools.length > 0) {
    errors.push(`${label}: replace legacy fake tool names: ${[...new Set(legacyTools)].join(", ")}`);
  }

  if (/```tool(?:-result)?\b/.test(text)) {
    errors.push(`${label}: replace deprecated tool/tool-result code fences with text/http/json examples`);
  }

  const retiredOnboardingPatterns = [
    [/\/v1\/install\/(?:contract|plan)\b/i, "retired install contract/plan route"],
    [/\/implementation-report\b/i, "retired implementation-report route"],
    [/\/install\/verify\b/i, "retired install-verify route"],
    [/\/verify-report\b/i, "retired verify-report route"],
    [/\bverify[_ -]report\b/i, "retired verify-report readiness concept"],
  ];
  for (const [pattern, description] of retiredOnboardingPatterns) {
    if (pattern.test(text)) {
      errors.push(
        `${label}: remove ${description}; use the saved signal map, current GET onboarding state with status verified, and live event/property checks`,
      );
    }
  }

  const retiredPosthogProxyPatterns = [
    [/\/v1\/projects\/:project_id\/cohorts(?:\b|\/)/i, "retired cohort proxy route"],
    [/\/v1\/projects\/:project_id\/session-replays(?:\b|\/)/i, "retired session-replay proxy route"],
    [/\/v1\/projects\/:project_id\/users\/:distinct_id\/summary(?:\b|\/)/i, "retired identity-summary proxy route"],
    [/\/v1\/projects\/:project_id\/ab-tests(?:\b|\/)/i, "retired experiment proxy route"],
    [/\/v1\/projects\/:project_id\/posthog\/(?:provision|provisioning|session-replay)(?:\b|\/)/i, "retired PostHog provisioning/configuration proxy route"],
  ];
  for (const [pattern, description] of retiredPosthogProxyPatterns) {
    if (pattern.test(text)) {
      errors.push(
        `${label}: remove ${description}; use bounded read-only analytics/case APIs and leave provider-owned state in PostHog`,
      );
    }
  }

  if (/PATCH\s+\/v1\/cases\/:case_id[\s\S]{0,700}["']status["']\s*:/i.test(text)) {
    errors.push(
      `${label}: case PATCH is annotation-only; change issue lifecycle directly in PostHog and then refresh the Agentry case projection`,
    );
  }

  if (/\b(?:AGENTRY_PUBLIC_API_KEY|AGENTRY_SERVER_API_KEY|agentry_pk_[A-Za-z0-9._-]*|agentry_server_[A-Za-z0-9._-]*)\b/.test(text)) {
    errors.push(
      `${label}: remove retired Agentry telemetry credentials; applications use their existing customer-owned PostHog SDK configuration`,
    );
  }

  if (/event-names[\s\S]{0,1000}["']events["']\s*:\s*\[/i.test(body)) {
    errors.push(`${label}: event-names examples must use analytics_events, server_emitted, and wildcards—not events`);
  }

  if (/Blueprint:\s*funnel_3_step[\s\S]{0,1400}["']steps["']\s*:/i.test(body)) {
    errors.push(`${label}: funnel_3_step returns rows with step1_count, step2_count, and step3_count—not steps`);
  }

  const unsupportedClaimPatterns = [
    [/industry\s+(?:median|baseline|typical)/i, "remove unsupported industry benchmark claims"],
    [/expect\s+~?\d+(?:\s*-\s*\d+)?%\+?\s+response rate/i, "remove unsupported response-rate forecasts"],
    [/\bprobably convert\b/i, "remove unsupported conversion predictions"],
    [/\blights-out automation\b/i, "replace unsafe unattended-automation positioning"],
    [/\bzero infrastructure\b/i, "remove capability-overclaim positioning"],
  ];
  for (const [pattern, message] of unsupportedClaimPatterns) {
    if (pattern.test(body)) errors.push(`${label}: ${message}`);
  }

  const legacyRecipeIds = [...text.matchAll(/recipe_id\s*[:=]\s*["']([^"']+)["']/g)].map((match) => match[1]);
  if (legacyRecipeIds.length > 0) {
    errors.push(`${label}: public-query examples must use blueprint_id, not recipe_id (${[...new Set(legacyRecipeIds)].join(", ")})`);
  }

  const blueprintIds = [...text.matchAll(/blueprint_id\s*[:=]\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const pathBlueprintIds = [...text.matchAll(/query-blueprints\/([^/\s"'`{}]+)\/run/g)]
    .map((match) => match[1])
    .filter((id) => id !== ":blueprint_id");
  const invalidBlueprintIds = [...new Set([...blueprintIds, ...pathBlueprintIds].filter((id) => !queryBlueprintIds.has(id)))];
  if (blueprintIds.includes("raw_hogql")) {
    errors.push(
      `${label}: replace raw_hogql pseudo-publication examples with POST /v1/projects/:project_id/analytics/query or a real query blueprint_id`,
    );
  }
  if (invalidBlueprintIds.length > 0) {
    errors.push(
      `${label}: blueprint_id must be a real query blueprint (${invalidBlueprintIds.join(", ")})`,
    );
  }

  if (/POST\s+\/v1\/projects\/:project_id\/analytics\/query[\s\S]{0,800}\bhogql\s*:/.test(text)) {
    errors.push(
      `${label}: analytics/query examples must use the real request field "query", not stale "hogql"`,
    );
  }

  const executableRequestOpeners = [
    ...text.matchAll(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+\/v1\/[^\n]*\{/gm),
  ].map((match) => match[0].trim());
  const inlineRequestBodies = [
    ...text.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+\/v1\/[^\n`{]*\{/g),
  ].map((match) => match[0].trim());
  const requestBodyLeaks = [...new Set([...executableRequestOpeners, ...inlineRequestBodies])];
  if (requestBodyLeaks.length > 0) {
    errors.push(
      `${label}: public workflows must use endpoint sketches/OpenAPI links, not executable-looking request bodies (${requestBodyLeaks.slice(0, 3).join("; ")})`,
    );
  }

  if (/^\s*project_id\s*:\s*["']default["']\s*,?\s*$/m.test(text)) {
    errors.push(
      `${label}: do not duplicate project_id inside example request bodies; keep it as the path parameter`,
    );
  }

  if (/api\.agentry\.sh\/v1\/public\/q\/pub[A-Za-z0-9_]+/.test(text)) {
    errors.push(
      `${label}: do not invent public-query URLs; use the returned public_url placeholder instead`,
    );
  }

  if (/"id"\s*:\s*"pub_[A-Za-z0-9_]+"/.test(text)) {
    errors.push(
      `${label}: do not invent publication ids in public-query response examples`,
    );
  }

  if (/(?:Public|Live) dashboard:\s*(?:\n\s*)?PUBLIC_URL_FROM_AGENTRY/i.test(text)) {
    errors.push(
      `${label}: do not show placeholder public URLs as dashboards; say to use the returned public_url after publishing a real query blueprint`,
    );
  }

  for (const slug of Array.isArray(metadata.related) ? metadata.related : []) {
    if (!workflowSlugs.has(slug)) {
      errors.push(`${label}: related workflow "${slug}" does not exist`);
    }
  }
}

if (featuredSlugs.length > 6) {
  errors.push(`workflow catalog: at most 6 canonical examples may be featured (found ${featuredSlugs.length}: ${featuredSlugs.join(", ")})`);
}

const actualAutomationRefs = new Set(automationTemplateRefs);
for (const requiredRef of REQUIRED_AUTOMATION_TEMPLATE_REFS) {
  if (!actualAutomationRefs.has(requiredRef)) {
      errors.push(`workflow catalog: missing repository page for automation template ${requiredRef}`);
  }
}
for (const actualRef of actualAutomationRefs) {
  if (!REQUIRED_AUTOMATION_TEMPLATE_REFS.has(actualRef)) {
    errors.push(`workflow catalog: repository automation template ${actualRef} is not in the canonical template set`);
  }
}
if (actualAutomationRefs.size !== automationTemplateRefs.length) {
  errors.push("workflow catalog: automation template ids/versions must map to exactly one repository page each");
}

if (!existsSync(WORKFLOWS_DIR)) {
  errors.push(`workflows directory missing: ${WORKFLOWS_DIR}`);
}

if (errors.length > 0) {
  console.error(`lint-workflow-references: ${errors.length} problem(s)`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`lint-workflow-references: ${workflowFiles.length} workflow docs checked`);
