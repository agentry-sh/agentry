# NoteSpark

NoteSpark is a dependency-free B2C notes app. A visitor signs up, creates a
note, shares it, and can start paid checkout. The key product question is which
acquisition sources produce users who create and share a first note before
starting checkout.

The product analytics pipeline in `src/analytics.js` records `page_view`,
`signup_completed`, `note_created`, `note_shared`, `checkout_started`, and
`sms_failed` to an in-memory event ledger.

## Local development

```bash
npm run dev
```

The server listens on `PORT` and returns health at `/health`.

## Product and failure paths

- `POST /auth/signup` creates a consumer account and session.
- `POST /api/notes` creates a first note.
- `POST /api/notes/:note_id/share` shares by email or SMS.
- `POST /api/billing/checkout` starts a local paid checkout.
- `GET /debug/analytics` returns the in-memory product-event ledger.
- An SMS share to a phone ending in `0000` exercises a handled provider timeout
  and returns HTTP 502 after the product analytics pipeline records `sms_failed`.

## CI deployment completion

`.github/workflows/deploy.yml` owns the successful CI deploy and runs:

```bash
npm run deploy
```

The package command builds the current `src/` tree, copies the output
to `out/local-deploy/current/`, and writes a completed receipt at
`out/local-deploy/deployment.json`. Local runs mirror the CI step without
calling an external service.

Run `npm test` to exercise the main product, handled-error, build, and deploy
paths.
