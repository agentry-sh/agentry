# LaunchFlow

LaunchFlow is a small B2B onboarding app for founder-led teams. A new customer
signs up, lands in a workspace, connects Slack, creates the first automation,
and then chooses a paid plan. The business question for the owner is whether
new teams reach an activated workspace quickly enough to justify paid
conversion work.

## Local development

```bash
npm run dev
```

The server listens on `PORT` and returns health at `/health`.

The successful CI deploy is owned by `.github/workflows/deploy.yml`, which runs:

```bash
npm run deploy
```

That package command builds the current `src/` tree, copies the build
into `out/local-deploy/current/`, and writes a completed deployment receipt to
`out/local-deploy/deployment.json`. Local runs mirror the CI step without
calling an external provider.

## Main flows

- `POST /auth/signup` creates the first user and workspace.
- `GET /api/dashboard` returns the current workspace for an API key.
- `POST /api/integrations/slack/connect` stores the Slack connection.
- `POST /api/automations` creates the first automation.
- `POST /api/billing/checkout` starts a checkout session.
- `POST /api/stripe/webhook` records subscription and payment webhook results.

Sending `{"code":"fail"}` to the Slack connection route exercises a handled
outbound-provider failure through the running app and returns HTTP 502.

Run `npm test` to exercise the main product, handled-error, build, and deploy
paths without external services.
