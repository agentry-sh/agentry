// Suggested next-step prompts the agent offers the user after install completes.
//
// Premise: the project's current onboarding state is verified and its
// detailed scoped proof receipt matches the active saved signal map.
// Three signal types are flowing. Now what? Instead of leaving them on a blank prompt, agentry hands
// the agent a curated list of "things the user might want to do next," each with
// a starter prompt template and the HTTP routes or query blueprints that back it.
//
// State-aware: a suggestion only appears if the prerequisites are met (e.g.
// "Answer a product question from verified analytics signals" requires an
// active PostHog OAuth connection plus observed events).

export interface NextStep {
  id: string;
  title: string;
  /** Starter request the agent adapts against the saved signal map and live data. */
  prompt_template: string;
  /** Short blurb shown alongside the title in the UI/prompt. */
  description: string;
  /** HTTP routes / query blueprints the agent will use to fulfill this prompt. */
  uses: string[];
  /** Roughly how long the agent will take to produce the answer. */
  estimated_seconds: number;
  /**
   * Predicate keys that must all be true for this suggestion to appear.
   * Evaluated by the API against project state before returning.
   */
  requires: NextStepRequirement[];
  /**
   * Marks suggestions that aren't fully implemented yet. The agent should still
   * surface these, but flag them as "coming soon" so the user knows.
   */
  status?: "available" | "preview" | "coming_soon";
}

export type NextStepRequirement =
  | "always"
  | "analytics_configured"   // customer PostHog OAuth connection is active
  | "has_events"              // at least one matching PostHog event observed
  | "has_cases"               // at least one error case
  | "has_deploys"             // at least one deploy recorded
  | "install_verified"        // current onboarding state/receipt is verified
  | "answer_ready"            // verified baseline funnel signals can answer a product question
  | "analytics_scope"         // approved signal map includes analytics
  | "errors_scope"            // approved signal map includes errors
  | "deploys_scope";          // approved signal map includes deploys

export type NextStepSignalType = "errors" | "analytics" | "deploys";

export const DEFAULT_NEXT_STEP_SIGNAL_TYPES: NextStepSignalType[] = ["errors", "analytics", "deploys"];

export const NEXT_STEPS: NextStep[] = [
  {
    id: "go_live_deployment_checklist",
    title: "Go live: verify direct PostHog and scoped control credentials",
    description:
      "Keep application telemetry customer-owned while placing only CI and runner credentials in their exact control-plane boundaries.",
    prompt_template:
      "Run the Agentry go-live checklist for this repo. Read the saved signal map first so the work stays " +
      "inside the approved signal scope. Read the local .env/.env.local/.env.production and provider configuration " +
      "to prove that official PostHog SDKs send application analytics and exceptions directly to the connected customer project, " +
      "that official PostHog release tooling uploads source maps directly, and that AGENTRY_CI_API_KEY is used only for deploy attribution. " +
      "Find any exact AGENTRY_RUNNER_API_KEY used by an explicitly enabled saved automation. " +
      "Keep AGENTRY_PRIVATE_API_KEY in the human operator's credential store; never copy it to an app host, routine CI job, or scheduler. " +
      "Detect the deployment host from the repo (Vercel, Netlify, Render, " +
      "Railway, Fly, Docker/Kubernetes, GitHub Actions, or another provider). If you can write environment " +
      "variables with the available host CLI or config, do it for production and staging; otherwise ask me to " +
      "paste each variable into the matching host, CI, or scheduler secret settings. If the user chooses go-live now and you can complete " +
      "the host work from this session, redeploy, trigger only the real flows needed by the approved signal scope, and " +
      "start a fresh onboarding run and complete its scoped real proof only if the deployed source changed; otherwise return the exact host/CI handoff.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "local .env / .env.local / .env.production",
      "deployment host env/secrets UI or CLI",
      "GET /v1/projects/:project_id/onboarding",
    ],
    estimated_seconds: 90,
    requires: ["install_verified"],
  },
  {
    id: "answer_product_question",
    title: "Answer a product question from verified analytics signals",
    description:
      "Use the saved signal map, current verified onboarding receipt, event metadata, live events, query blueprints, and custom HogQL when needed to answer " +
      "the highest-impact product question before adding custom app code; dashboard, route, report, or public-query output belongs only after the user asks and that question is Ready.",
    prompt_template:
      "Answer the highest-impact Agentry analytics question this project can support for the last 14 days. First read the saved signal map, " +
      "current onboarding state, event names, event-property keys for the approved events, cases, and deploys; status=verified and its durable receipt are the canonical proof. " +
      "The priority is the approved business question, funnel, events/properties, and honest readiness gaps; a route or dashboard is only one possible output. " +
      "Use the saved signal map and verified receipt as the source of truth. " +
      "Return one concise answer with evidence first, then list the next missing event/property or product flow if the answer is not ready. " +
      "Do not build a dashboard or persistent route unless the user asks for one after the specific question is Ready. Do not build or suggest a report, public query, or custom interface unless the user asks for that output after the specific question is Ready. Prove the needed events/properties before choosing query blueprints for deterministic reads or custom HogQL when the question needs it; keep owner reads server-only. Do not add AGENTRY_PRIVATE_API_KEY to client/public code. " +
      "When running `funnel_3_step`, set `step1`, `step2`, and `step3` from the saved signal map's milestones in the source-backed journey order; do not use the blueprint's default signup steps unless those exact events are approved for this project. " +
      "If current live traffic does not support the question, stop querying and return an honest empty state naming the missing event/property and product flow to trigger. Synthetic rows never count. " +
      "Use at least 45 seconds for any server-side custom HogQL timeout.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "GET /v1/projects/:project_id/cases",
      "GET /v1/projects/:project_id/deploys",
      "POST /v1/projects/:project_id/query-blueprints/active_users_daily/run",
      "POST /v1/projects/:project_id/query-blueprints/top_events_30d/run",
      "POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run with params from signal-map milestones",
      "POST /v1/projects/:project_id/query-blueprints/weekly_retention/run",
    ],
    estimated_seconds: 30,
    requires: ["analytics_scope", "analytics_configured", "has_events", "answer_ready"],
  },
  {
    id: "review_primary_funnel_readiness",
    title: "Review the primary funnel and readiness gaps",
    description:
      "Classify the approved funnel, segmentation options, and missing telemetry before answering product questions or building UI.",
    prompt_template:
      "Review the approved primary funnel and readiness gaps. Read the saved signal map, current verified onboarding receipt, " +
      "event names, cases, and deploys; status=verified and its durable receipt are the canonical proof. " +
      "Return a written readiness handoff only. Do not create a route, dashboard, public query, or custom interface from this suggestion. " +
      "For the primary funnel and each saved question, classify answerability as Ready, Needs more data, or Needs instrumentation. " +
      "Name the exact event/property evidence from the signal map, verified receipt, event names, and event-property keys. " +
      "If the question is not supported by current live data, do not run product metrics as a final answer; name the product flow to trigger or instrumentation to wire, then complete a fresh onboarding proof after the source change. " +
      "If a future follow-up needs UI, tell the user the approved signals support an optional report or internal view only after the specific question is Ready and only when they ask for that surface.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "GET /v1/projects/:project_id/cases",
      "GET /v1/projects/:project_id/deploys",
    ],
    estimated_seconds: 45,
    requires: ["analytics_scope", "analytics_configured", "install_verified"],
  },
  {
    id: "review_current_error_cases",
    title: "Review current error cases",
    description:
      "Show top open errors, errors per hour, and, when deploys are in scope, anything that broke after the latest deploy. For each top error, suggest a fix.",
    prompt_template:
      "Review the current error cases from the saved signal map. Show the 10 most frequent active cases " +
      "and errors per hour for the last 24h. If deploys are also in the approved signal scope, include cases that " +
      "started after the latest deploy. For each of the top 3 cases, fetch the case detail and propose a fix.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "POST /v1/projects/:project_id/query-blueprints/active_cases_top/run",
      "POST /v1/projects/:project_id/query-blueprints/errors_by_hour_24h/run",
      "POST /v1/projects/:project_id/query-blueprints/errors_after_last_deploy/run when deploys are in signal scope",
      "GET /v1/cases/:case_id",
    ],
    estimated_seconds: 60,
    requires: ["errors_scope", "has_cases"],
  },
  {
    id: "deploy_health_check",
    title: "Deploy health check",
    description:
      "How often we ship + did the last deploy break anything?",
    prompt_template:
      "Run a deploy health check from the saved signal map. Show recent deploys and deploy frequency for the " +
      "last 30 days. If errors are also in the approved signal scope and cases exist, list any cases that started " +
      "after the most recent deploy and open the relevant case for diagnosis. If this is deploy-only, do not add " +
      "analytics, reports, dashboards, public queries, or custom analytics query work; just prove deploy attribution is current and useful.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/deploys",
      "POST /v1/projects/:project_id/query-blueprints/deploy_frequency_30d/run",
      "POST /v1/projects/:project_id/query-blueprints/errors_after_last_deploy/run when errors are in signal scope",
      "GET /v1/cases/:case_id when errors are in signal scope",
    ],
    estimated_seconds: 45,
    requires: ["deploys_scope", "has_deploys"],
  },
  {
    id: "investigate_top_error",
    title: "Investigate my biggest current bug",
    description:
      "Pick the most-frequent open error, fetch its full context, and walk through a fix.",
    prompt_template:
      "Find my most-frequent active case (highest event_count), fetch its detail, and propose a fix in the relevant file. " +
      "If deploys are in the approved signal scope, cross-reference recent deploys to look for a regression. " +
      "If you can produce a confident patch, write it; otherwise summarize what's needed.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "POST /v1/projects/:project_id/query-blueprints/active_cases_top/run",
      "GET /v1/cases/:case_id",
      "(local file edits)",
    ],
    estimated_seconds: 90,
    requires: ["errors_scope", "has_cases"],
  },
  {
    id: "review_signup_funnel",
    title: "Review the primary funnel for drop-offs",
    description:
      "Compute drop-off % at each step and call out the biggest leak.",
    prompt_template:
      "Read my saved signal map and live event names, identify the app's primary signup or activation funnel, " +
      "then call event-property keys for the mapped funnel events and classify the funnel as Ready, Needs data, or Needs instrumentation from the verified onboarding receipt and event-property keys before computing anything. " +
      "If Ready, compute drop-off percentages for the last 30 days. Identify the biggest drop and suggest 2-3 " +
      "hypotheses for why users abandon at that mapped step. Do not build or suggest a dashboard, report, route, or public query unless the user asks for that output after this funnel question is Ready.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "POST /v1/projects/:project_id/query-blueprints/funnel_3_step/run with params from signal-map milestones",
    ],
    estimated_seconds: 30,
    requires: ["analytics_scope", "analytics_configured", "has_events", "answer_ready"],
  },
  {
    id: "compare_versions",
    title: "Compare metrics across deploys",
    description:
      "Did the most recent deploy improve or regress conversions?",
    prompt_template:
      "Read my saved signal map and live event names, pick the relevant conversion pair for this app, " +
      "then call event-property keys for the selected conversion events and classify the comparison as Ready, Needs data, or Needs instrumentation from the verified onboarding receipt and event-property keys before querying. " +
      "If Ready, compare conversion rate for the 7 days before vs after the most recent deploy. Show the numbers " +
      "and tell me whether the deploy moved the needle. Do not build or suggest a dashboard, report, route, or public query unless the user asks for that output after this comparison is Ready.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "POST /v1/projects/:project_id/query-blueprints/conversion_rate/run",
      "GET /v1/projects/:project_id/deploys",
      "POST /v1/projects/:project_id/analytics/query",
    ],
    estimated_seconds: 45,
    requires: ["analytics_scope", "deploys_scope", "analytics_configured", "has_events", "has_deploys", "answer_ready"],
  },
  {
    id: "weekly_review",
    title: "Generate this week's review post",
    description:
      "A question-first weekly summary covering only the approved product, error, and deploy signals that are Ready, " +
      "with Slack or standup formatting only when the user asks for that output.",
    prompt_template:
      "Generate this week's review from the saved signal map and current verified onboarding receipt. First read event names and event-property keys for any approved events used in funnel or segment claims. Include DAU trend, " +
      "top events, and notable funnel changes only when analytics is in scope, the specific question is Ready, and real events exist. Include top open " +
      "errors only when errors are in scope and cases exist. Include deploys shipped only when deploys are in scope " +
      "and deploy data exists. Treat this prompt as a written-answer request; do not create a dashboard, route, public query, persistent report, or custom interface unless the user separately asks for that surface after the specific question is Ready. Format as a Slack-friendly markdown post with bullet points and a one-sentence headline summary at the top.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "POST /v1/projects/:project_id/query-blueprints/active_users_daily/run",
      "POST /v1/projects/:project_id/query-blueprints/top_events_30d/run",
      "POST /v1/projects/:project_id/query-blueprints/active_cases_top/run when errors are in signal scope",
      "GET /v1/projects/:project_id/deploys when deploys are in signal scope",
    ],
    estimated_seconds: 90,
    requires: ["analytics_scope", "has_events", "answer_ready"],
  },
  {
    id: "build_custom_interface",
    title: "Create a custom report or internal interface",
    description:
      "After the user asks for a specific output, use the verified signal map to create the exact report, admin view, or workflow " +
      "surface they want, backed by Agentry publications only when the selected question is Ready and browser/shareable output is needed.",
    prompt_template:
      "Create a custom Agentry-powered report, brief, automation plan, or internal interface for this repo. First read the saved " +
      "signal map, current verified onboarding receipt, event names, event-property keys for the approved events, and current event/case/deploy data, then classify the specific requested question as Ready, Needs more data, or Needs instrumentation before proposing 2-3 options " +
      "that fit the instrumentation. If the user wants a persistent browser/shareable view and the selected question is Ready, prefer a publication-backed design: mint public-query URLs " +
      "with POST /v1/projects/:project_id/public-queries and embed/fetch those read-only returned URLs from the browser. " +
      "Only use POST /v1/projects/:project_id/analytics/query from a server-only admin route when the user asked for that route, the specific question is Ready, and a publication " +
      "cannot express the view, and give those server-side requests at least a 45 second timeout. " +
      "For dashboard loads, batch the fixed calls for the visible view in parallel and flatten related metrics " +
      "into grouped queries so the UI does not wait on a serial analytics waterfall. " +
      "Whatever option you propose must include a `Top 5 questions that move the needle` section grounded in this repo's saved signal map and live data. " +
      "If you defer useful charts or workflows, preserve them under `Questions you can ask Agentry` with the exact prompt and missing signal needed. " +
      "Never expose AGENTRY_PRIVATE_API_KEY in client code or require it only to render analytics. " +
      "If no requested question is Ready, do not build the report/interface yet; name the event/property or product flow to wire or trigger first. If I pick one Ready option, implement it in the app.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "POST /v1/projects/:project_id/public-queries",
      "GET /v1/public/q/:publication_id",
      "POST /v1/projects/:project_id/analytics/query",
      "GET /v1/projects/:project_id/cases",
      "GET /v1/projects/:project_id/deploys",
      "(local UI/code edits)",
    ],
    estimated_seconds: 120,
    requires: ["analytics_scope", "answer_ready"],
  },
  {
    id: "ask_custom_question",
    title: "Ask a custom product, ops, or debugging question",
    description:
      "Start open-ended: have the agent inspect what Agentry can answer now, then ask " +
      "anything specific that is not covered by the canned suggestions.",
    prompt_template:
      "Use my Agentry signal map, current verified onboarding receipt, current events, event/property metadata, cases, deploys, and query blueprints " +
      "to tell me what questions you can answer now. For product metrics, prove the needed events/properties first with event-property keys for the relevant approved events, then use a matching query blueprint or custom HogQL when the question needs it; use public-query " +
      "publications only after the exact question is Ready and I ask for shareable/browser output. Do not suggest a dashboard, report, route, or public query before that point. Then answer this custom question: " +
      "<replace with my question>. If you implement any server-side custom HogQL call with " +
      "POST /v1/projects/:project_id/analytics/query, set the request timeout to at least 45 seconds. Do not add " +
      "a 1-15s fallback timeout around raw Agentry analytics queries; use publications, caching, or a smaller query instead.",
    uses: [
      "GET /v1/projects/:project_id/signal-map",
      "GET /v1/projects/:project_id/onboarding",
      "GET /v1/projects/:project_id/event-names",
      "GET /v1/projects/:project_id/event-property-keys?events=a,b,c",
      "GET /v1/projects/:project_id/cases",
      "GET /v1/projects/:project_id/deploys",
      "GET /v1/query-blueprints",
      "POST /v1/projects/:project_id/query-blueprints/:blueprint_id/run",
      "POST /v1/projects/:project_id/analytics/query",
    ],
    estimated_seconds: 45,
    requires: ["analytics_scope", "install_verified"],
  },
  {
    id: "auto_fix_on_error",
    title: "Set up automated fix-on-error",
    description:
      "Render the immutable error-to-draft-pr playbook for owner review, least-privilege runner setup, and bounded draft-PR automation.",
    prompt_template:
      "Render error-to-draft-pr@2.0.0 for this project. Keep the returned candidate disabled, show every server-observed and caller-confirmed readiness gate, then ask the owner to save and explicitly enable it. Create one AGENTRY_RUNNER_API_KEY bound only to the exact automation_id. The runner may prepare one bounded draft PR and escalate; it may never merge, deploy, roll back, attest CI proof, or broaden scope. Use server-issued trigger receipts, claims, action grants, trusted CI-only PR/deploy proof, real traffic, and recurrence verification. Select exactly one executable handoff matching runner.provider: Codex CLI or Claude Code via a customer scheduler, GitHub Actions, or custom. Treat the ChatGPT Scheduled tasks preview in Scheduled as blocked advisory only because no per-task runner-secret injection contract is documented. Include exact stop/revoke actions.",
    uses: [
      "GET /v1/automation-playbooks/error-to-draft-pr?version=2.0.0",
      "POST /v1/projects/:project_id/automation-playbooks/error-to-draft-pr/render",
      "PUT /v1/projects/:project_id/automation-contract",
      "POST /v1/projects/:project_id/credentials",
      "POST /v1/projects/:project_id/automation-contract/enable",
      "GET /v1/projects/:project_id/automation-control",
    ],
    estimated_seconds: 120,
    requires: ["errors_scope", "has_cases"],
    status: "available",
  },
];

export function normalizeNextStepSignalTypes(value: unknown): NextStepSignalType[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const normalized = raw
    .map((item) => String(item).trim().toLowerCase())
    .map((item) => {
      if (item === "log" || item === "logs" || item === "error" || item === "errors") return "errors";
      if (item === "analytics" || item === "event" || item === "events") return "analytics";
      if (item === "deploy" || item === "deploys" || item === "deployment") return "deploys";
      return "";
    })
    .filter((item): item is NextStepSignalType => Boolean(item));
  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique : [...DEFAULT_NEXT_STEP_SIGNAL_TYPES];
}

export function selectApplicableNextSteps(state: {
  analytics_configured: boolean;
  has_events: boolean;
  has_cases: boolean;
  has_deploys: boolean;
  install_verified: boolean;
  answer_ready?: boolean;
  analytics_scope?: boolean;
  errors_scope?: boolean;
  deploys_scope?: boolean;
}): NextStep[] {
  if (!state.install_verified) return [];
  return NEXT_STEPS.filter((s) =>
    s.requires.every((req) => {
      if (req === "always") return true;
      return Boolean(state[req as keyof typeof state]);
    }),
  );
}
