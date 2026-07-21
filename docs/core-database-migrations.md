# Core database migration architecture

This is the public contributor guide for Agentry's Turso/libSQL product schema.
It explains the reviewable migration model and local validation gates. It is
not a production credential, data-repair, or release runbook.

## Design goals

Agentry uses forward-only, append-only migrations so a release can prove which
schema changes ran and whether the live schema still matches the reviewed
source. A generated schema push is not a production migration mechanism.

The core rules are:

- Never edit, remove, or reorder a migration that has shipped.
- Never edit a shipped migration script. Add a new script and append a new
  manifest entry.
- Keep the empty-database baseline immutable. It is only for a genuinely empty
  database and does not replace the migration ledger.
- Make every step safe to retry after a lost process or response.
- Stop at the first failed step and keep the durable ledger as an exact prefix
  of the source manifest.
- Verify the resulting schema, constraints, indexes, triggers, and migration
  hashes instead of treating a completed ledger as sufficient evidence.
- Use the database clock and fenced lease in the coordinator; do not build a
  second migration lock in application code.

## Source map

| Path | Responsibility |
| --- | --- |
| `packages/db/src/schema.ts` | Canonical Drizzle model exported to the product |
| `packages/db/drizzle/0000_core_baseline.sql` | Immutable create-only baseline for an empty database |
| `packages/db/scripts/core-migration-manifest.mjs` | Ordered append-only migration catalog |
| `packages/db/scripts/core-migration-lifecycle.mjs` | Lease, execution, ledger, resume, and verification coordinator |
| `packages/db/scripts/migrate-*.ts` | One forward migration per manifest entry |
| `packages/db/scripts/schema-extensions/` | Explicit projections for schema that Drizzle cannot represent completely |
| `packages/db/scripts/check-*.mjs` | Focused fixtures and lifecycle regression tests |

`db:migrate:core` is the only coordinator for an existing product database.
Individual migration files are manifest steps and test inputs, not standalone
release commands. `db:verify:core` is read-only and checks the ledger plus the
canonical runtime schema. `db:deploy` is only an alias for the coordinator; it
does not run `drizzle-kit push`.

## Adding a migration

1. Update the canonical schema and any exported types used by the API.
2. Add one forward migration with a stable, date-prefixed id and a narrowly
   stated outcome.
3. Make the migration deterministic and retry-safe. Inspect existing rows
   before changing them and fail closed when a legacy value cannot be mapped
   without guessing.
4. Append the entry to `CORE_MIGRATIONS`. Never insert it before a shipped
   entry.
5. Add or update a focused fixture that proves both the legacy starting shape
   and the exact final shape.
6. Extend the canonical verifier when the migration adds a table, column,
   index, foreign key, trigger, or invariant it does not already inspect.
7. Run the complete chained lifecycle suite, not only the new focused test.

When a feature spans tables, triggers, and application behavior, prefer one
coherent migration whose post-check proves the usable invariant. Split work
only when an intermediate state is deliberately deployable and independently
verifiable.

## Migration safety

SQLite and libSQL require explicit care around schema changes:

- Use transactions where the operation supports them, and design every
  non-transactional boundary for a safe retry.
- Create replacement tables with explicit columns and constraints; never rely
  on `SELECT *` ordering during a rebuild.
- Preserve foreign-key behavior, indexes, triggers, defaults, and nullability
  intentionally.
- Backfill from source-proven values. If identity or ownership cannot be
  established, stop and require a separately reviewed repair rather than
  inventing data.
- Treat provider ids, project ids, hashes, and credential fingerprints as
  distinct domains even when their storage types happen to match.
- Hash or compare sensitive material only where the migration contract
  requires it. Migration fixtures must contain synthetic values, never copied
  production records.
- Keep the application compatible with the exact schema state that can exist
  before and after its reviewed release boundary.

Migrations must not make network requests, provision external resources, read
developer home-directory files, or depend on an operator's ambient shell state.
External identity evidence or a data-repair decision belongs to a separate,
reviewed operational process outside the public repository.

## Local validation

From the repository root, run:

```sh
npm -w @agentry/db run typecheck
npm -w @agentry/db run db:test:core-migrations
npm run test:release-wrapper
```

The chained migration suite creates disposable local fixtures. It must prove:

- an empty database can use the immutable baseline;
- every supported legacy fixture converges through the complete manifest;
- a second run is a no-op;
- script or manifest hash drift is rejected;
- a non-prefix, missing receipt, stale lease, or unexpected schema shape fails
  closed; and
- verification leaves no migration lock and reports the expected schema
  fingerprint.

Run API typechecking and affected API tests whenever a schema change alters a
query, response, authorization boundary, or runtime invariant.

## Production boundary

Production releases use the reviewed wrapper in `scripts/deploy-agentry.mjs`.
The wrapper binds a clean `main` commit to migration, verification, API health,
and deploy attribution; migration-required releases also use the API's bounded
maintenance state before writers are changed. The source and wrapper tests are
public so engineers can review that control flow.

Production URLs, tokens, database exports, provider identity snapshots,
repair fixtures, maintenance receipts, and secret-file locations are not part
of this guide and must not be committed. Maintainers keep the operational
procedure and incident-specific evidence in their protected release system.

## Review checklist

- [ ] The new manifest entry is appended and every older entry is byte-for-byte unchanged.
- [ ] The migration is deterministic, retry-safe, and free of network or ambient-secret dependencies.
- [ ] Canonical schema exports and runtime queries agree with the final shape.
- [ ] Constraints, indexes, triggers, defaults, and foreign keys are preserved or deliberately changed.
- [ ] Legacy ambiguity fails closed instead of guessing identity or data.
- [ ] Focused fixtures and the complete migration lifecycle suite pass.
- [ ] No credential, production row, dump, provider export, or repair artifact is in the diff.
