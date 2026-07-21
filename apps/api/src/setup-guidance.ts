function frameworkEntry(input: {
  framework: string;
  posthogSdkRule: string;
  posthogSourceMapRule: string;
  deployShaEnv: string;
}) {
  return {
    framework: input.framework,
    posthog_telemetry_rule: input.posthogSdkRule,
    posthog_source_map_rule: input.posthogSourceMapRule,
    agentry_ci_deploy_env: "AGENTRY_CI_API_KEY",
    agentry_ci_deploy_rule:
      "Trusted CI/provider post-success only, for Agentry deploy evidence and provider-observed PR proof. It is not a PostHog credential.",
    automation_runner_env: "AGENTRY_RUNNER_API_KEY",
    automation_runner_rule:
      "One secret per saved automation_id in the detected customer scheduler; never use the owner key as a scheduler credential.",
    owner_api_env: "AGENTRY_PRIVATE_API_KEY",
    owner_api_rule:
      "Interactive human/coding-agent use only. Never expose it to the app runtime, browser, routine CI, or an unattended scheduler.",
    deploy_sha_env: input.deployShaEnv,
  };
}

export function buildFrameworkEnvMatrix() {
  return [
    frameworkEntry({
      framework: "next",
      posthogSdkRule:
        "Preserve the existing official posthog-js/PostHog Node setup. Browser and server SDK credentials go directly to PostHog and never through Agentry.",
      posthogSourceMapRule:
        "Upload source maps directly with the official PostHog CLI after the production build.",
      deployShaEnv: "VERCEL_GIT_COMMIT_SHA",
    }),
    frameworkEntry({
      framework: "vite_react",
      posthogSdkRule:
        "Preserve the existing official posthog-js setup and its intentional VITE_ public PostHog project token.",
      posthogSourceMapRule:
        "Upload Vite build source maps directly with the official PostHog CLI.",
      deployShaEnv: "GITHUB_SHA",
    }),
    frameworkEntry({
      framework: "create_react_app",
      posthogSdkRule:
        "Preserve the existing official posthog-js setup and its intentional REACT_APP_ public PostHog project token.",
      posthogSourceMapRule:
        "Upload CRA build source maps directly with the official PostHog CLI.",
      deployShaEnv: "GITHUB_SHA",
    }),
    frameworkEntry({
      framework: "remix",
      posthogSdkRule:
        "Preserve the customer's existing official PostHog browser and server SDK boundaries; do not serialize server credentials to the client.",
      posthogSourceMapRule:
        "Upload browser/server build source maps directly with the official PostHog CLI.",
      deployShaEnv: "GITHUB_SHA",
    }),
    frameworkEntry({
      framework: "node_express",
      posthogSdkRule:
        "Use the customer's official PostHog server SDK directly for server-side analytics and exceptions.",
      posthogSourceMapRule:
        "Upload build source maps directly with the official PostHog CLI when the runtime requires symbolication.",
      deployShaEnv: "GITHUB_SHA",
    }),
    frameworkEntry({
      framework: "rails_django_laravel_go_rust_dotnet_java",
      posthogSdkRule:
        "Use the customer's official PostHog integration directly; Agentry issues no application telemetry credential.",
      posthogSourceMapRule:
        "Use official PostHog release tooling directly where source maps apply.",
      deployShaEnv: "GITHUB_SHA or provider-native commit SHA",
    }),
  ];
}

function hostEntry(input: {
  host: string;
  posthog: string;
  ci: string;
  runner: string;
  owner: string;
  sha: string;
}) {
  return {
    host: input.host,
    posthog_credential_placement: input.posthog,
    agentry_ci_key_placement: input.ci,
    automation_runner_key_placement: input.runner,
    owner_key_placement: input.owner,
    commit_sha_env: input.sha,
    rule:
      "Application telemetry and source maps go directly to PostHog. Agentry CI and runner credentials remain scoped to their separate control-plane boundaries.",
  };
}

export function buildHostEnvMatrix() {
  return [
    hostEntry({
      host: "vercel",
      posthog: "Keep existing PostHog SDK variables in the exact browser/server Vercel environments that consume them.",
      ci: "AGENTRY_CI_API_KEY in a deploy-success hook or GitHub Actions secret.",
      runner: "AGENTRY_RUNNER_API_KEY in the detected scheduler's secret store.",
      owner: "Do not place AGENTRY_PRIVATE_API_KEY in the deployed Vercel app.",
      sha: "VERCEL_GIT_COMMIT_SHA",
    }),
    hostEntry({
      host: "netlify",
      posthog: "Keep existing PostHog SDK variables in Netlify build/function scopes according to the official SDK boundary.",
      ci: "AGENTRY_CI_API_KEY in deploy-success automation or CI secrets.",
      runner: "AGENTRY_RUNNER_API_KEY in the detected external scheduler.",
      owner: "Do not place AGENTRY_PRIVATE_API_KEY in public build env.",
      sha: "COMMIT_REF",
    }),
    hostEntry({
      host: "render",
      posthog: "Keep customer PostHog SDK credentials in the Render service that sends telemetry directly.",
      ci: "AGENTRY_CI_API_KEY in a deploy hook or CI secret after success.",
      runner: "AGENTRY_RUNNER_API_KEY in the detected scheduler secret store.",
      owner: "Keep AGENTRY_PRIVATE_API_KEY in interactive tooling only.",
      sha: "RENDER_GIT_COMMIT",
    }),
    hostEntry({
      host: "railway",
      posthog: "Keep customer PostHog SDK credentials in the Railway service that sends telemetry directly.",
      ci: "AGENTRY_CI_API_KEY in deployment-success automation.",
      runner: "AGENTRY_RUNNER_API_KEY in the detected scheduler secret store.",
      owner: "Never place AGENTRY_PRIVATE_API_KEY in Railway service variables or jobs.",
      sha: "RAILWAY_GIT_COMMIT_SHA",
    }),
    hostEntry({
      host: "fly",
      posthog: "Use Fly secrets or intentional public build config for the customer's existing official PostHog SDK only.",
      ci: "AGENTRY_CI_API_KEY in the CI job after fly deploy succeeds.",
      runner: "AGENTRY_RUNNER_API_KEY in the detected scheduler secret store.",
      owner: "Keep AGENTRY_PRIVATE_API_KEY in interactive tooling only.",
      sha: "GITHUB_SHA or AGENTRY_DEPLOY_SHA",
    }),
    hostEntry({
      host: "github_actions",
      posthog: "Use customer-owned PostHog credentials only for official PostHog CLI release/source-map steps.",
      ci: "AGENTRY_CI_API_KEY for Agentry deploy evidence and PR proof only.",
      runner: "Use an exact AGENTRY_RUNNER_API_KEY only when this workflow is the detected automation runner.",
      owner: "Never use AGENTRY_PRIVATE_API_KEY for routine deploy or scheduled-run jobs.",
      sha: "GITHUB_SHA",
    }),
    hostEntry({
      host: "docker_kubernetes",
      posthog: "Mount customer-owned PostHog SDK credentials only into the workload that sends telemetry directly.",
      ci: "AGENTRY_CI_API_KEY in the rollout-success CI/CD job.",
      runner: "AGENTRY_RUNNER_API_KEY in the exact automation workload Secret.",
      owner: "Keep AGENTRY_PRIVATE_API_KEY outside ordinary app/CI workloads.",
      sha: "AGENTRY_DEPLOY_SHA",
    }),
  ];
}

export function buildEnvPreflightChecks(projectId?: string) {
  return {
    fail_if_found: [
      "NEXT_PUBLIC_AGENTRY_PRIVATE_API_KEY",
      "VITE_AGENTRY_PRIVATE_API_KEY",
      "REACT_APP_AGENTRY_PRIVATE_API_KEY",
      "PUBLIC_AGENTRY_PRIVATE_API_KEY",
      "NEXT_PUBLIC_AGENTRY_CI_API_KEY",
      "VITE_AGENTRY_CI_API_KEY",
      "NEXT_PUBLIC_AGENTRY_RUNNER_API_KEY",
      "VITE_AGENTRY_RUNNER_API_KEY",
    ],
    warn_if_found: [
      "retired AGENTRY_PUBLIC_API_KEY or AGENTRY_SERVER_API_KEY",
      "AGENTRY_PRIVATE_API_KEY present in app runtime, routine CI, or a scheduler",
      "one AGENTRY_RUNNER_API_KEY reused across multiple automation_id values",
      "deploy evidence emitted from app startup, middleware, request handlers, browser code, or cron routes",
      "PostHog OAuth token copied into a repository, prompt, application, CI, or runner",
    ],
    required_for_posthog_telemetry: [
      "the customer's existing official PostHog SDK sends analytics and exceptions directly to PostHog Cloud",
    ],
    required_for_posthog_source_maps: [
      "customer-owned PostHog CLI credentials in the direct release/source-map job",
    ],
    required_for_deploys: [
      "AGENTRY_CI_API_KEY in CI/provider deploy-success automation",
      "commit SHA from provider env or AGENTRY_DEPLOY_SHA",
      "stable Idempotency-Key",
    ],
    required_for_automation: [
      "one AGENTRY_RUNNER_API_KEY bound to the exact automation_id after explicit approval",
    ],
    verify_actions: [
      projectId
        ? `Read GET /v1/projects/${projectId}/setup and follow its current PostHog/CI/runner checkpoints.`
        : "Read GET /v1/projects/:project_id/setup and follow its current PostHog/CI/runner checkpoints.",
      "Compare the source-backed signal map with bounded PostHog history, then trigger only the real flow needed for source verification.",
      "Use /v1/openapi.json?flow=automation before enabling any scheduler.",
    ],
    suggested_grep:
      "rg -n \"AGENTRY_(PUBLIC|SERVER|PRIVATE|CI|RUNNER)_API_KEY|POSTHOG|posthog|/v1/(deploys|automation-runs)\" .env* src app pages server api .github netlify.toml vercel.json Dockerfile 2>/dev/null",
  };
}
