# Find connection-pool / timeout patterns in errors

Surface DB connection exhaustion, statement timeouts, and deadlock retries. Find the
original slow query starving everything else.

<details data-agentry-workflow-metadata>
<summary>Workflow metadata</summary>

```yaml
title: Find connection-pool / timeout patterns in errors
description: >-
  Surface DB connection exhaustion, statement timeouts, and deadlock retries.
  Find the original slow query starving everything else.
category: debugging
tags:
  - errors
  - database
  - infra
  - scaling
  - oncall
prompt: >-
  Are there any database-related error patterns trending up? Look for connection
  timeouts, pool exhaustion, deadlock retries.
difficulty: advanced
time_to_value: 2 minutes
prereqs:
  - >-
    Errors flowing in with DB-driver messages (pg, mysql2, drizzle, prisma —
    they all surface clearly)
  - 'Ideally: query identifier or route tagged on the error'
applies_to:
  - universal
required_events:
  - $exception
required_event_properties:
  $exception:
    - fingerprint
    - query_id
    - route
    - pool_name
negative_fit:
  - >-
    Do not use until the example events are mapped to observed project signals,
    the required signals are source-verified, and live PostHog reads
    prove the required data is present.
ask_if_missing:
  - >-
    Which observed events map to $exception? Are the required signals
    source-verified, and do live PostHog event/property reads show real traffic for
    them?
  - >-
    Which live properties provide $exception.fingerprint, $exception.query_id,
    $exception.route, $exception.pool_name, and which stable user or account
    identifier joins the signals?
related:
  - rate-limit-spikes
  - time-of-day-patterns
  - dependency-upgrade-regression
updatedAt: 2026-07-10T00:00:00.000Z
publishedAt: 2026-05-16T00:00:00.000Z
```

</details>

## Why this matters

Pool exhaustion fans out. One slow query holds a connection for 30 seconds; the next 50 requests queue waiting; the queue times out; 50 unrelated endpoints throw "could not acquire connection from pool" simultaneously. Your error tracker shows 50 different fingerprints all in the same minute — none of which is the actual cause.

The actual cause is one slow query in one endpoint, often new and innocent-looking. Finding it is forensic work that takes engineers an hour because they have to:

1. Notice the burst of pool errors
2. Find the slow-query log (different system)
3. Correlate timestamps (often clock-skew issues)
4. Identify the offending query

Agentry collapses this. The agent groups all the pool/timeout/deadlock-shaped messages and looks for the **earliest, slowest, and most-concentrated** trigger query — the root cause, not the symptom.

## What you get

- A grouped count of DB error patterns: `pool_exhausted`, `statement_timeout`, `deadlock`, `lock_wait_timeout`
- The query / route most likely **causing** the cascade (longest-held lock or slowest in the spike window)
- A timeline showing the cascade origin vs the downstream symptom errors

## Walk through it

**You:**
> Are there any database-related error patterns trending up? Look for connection timeouts, pool exhaustion, deadlock retries.

**Agent:**
> Let me grep for DB error fingerprints in the last 24h.

```text
Endpoint: GET /v1/projects/:project_id/cases
Exact shape: /v1/openapi.json?path=%2Fv1%2Fprojects%2F%7Bproject_id%7D%2Fcases&method=get
Use query parameters, not a JSON body.
Query/filter concept:
  status: "open",
  since: "24h",
  message_matches: "pool|timeout|deadlock|lock_wait|connection refused",
  limit: 20
```
```text
{
  "cases": [
    { "id": "c_8e21", "message": "could not acquire connection from pool (timeout 5000ms)",
      "event_count": 412, "users_affected": 88, "first_seen_at": 1747350400 },
    { "id": "c_1c92", "message": "statement_timeout: query exceeded 30000ms",
      "event_count": 14, "users_affected": 4, "first_seen_at": 1747349200 },
    { "id": "c_4a01", "message": "deadlock detected: process X waits for ShareLock on Y",
      "event_count": 8, "users_affected": 3, "first_seen_at": 1747350100 }
  ]
}
```

**Agent:**
> Three DB-shaped fingerprints in the last hour. Note the timing — `statement_timeout` (`c_1c92`) appeared 20 minutes BEFORE the pool exhaustion (`c_8e21`). That's the cause. Let me get its query.

```text
Endpoint: GET /v1/cases/:case_id
Exact shape: /v1/openapi.json?path=%2Fv1%2Fcases%2F%7Bcase_id%7D&method=get
Use query parameters, not a JSON body.
```
```text
{
  "id": "c_1c92",
  "error_type": "QueryError",
  "message": "statement_timeout: query exceeded 30000ms",
  "stack_top": "src/api/admin/reports.ts:88",
  "tags": {
    "query_id": "admin_monthly_report",
    "route": "GET /api/admin/reports/monthly"
  }
}
```

**Agent:**
> Confirmed cause. `admin_monthly_report` — a GET on `/api/admin/reports/monthly` — has been hitting the 30s statement timeout. Each call holds a pool connection for the full 30 seconds. Your pool is probably size 10. After 10 admins click "view monthly report" the pool is full, and every subsequent request from anywhere in the app fails with `c_8e21`.
>
> The 412 pool-exhaustion errors hitting 88 users are all collateral damage — actual users trying to use the app while admin queries hog connections.
>
> Two-part fix:
> 1. **Today:** isolate admin queries to a separate read replica or smaller pool
> 2. **This week:** optimize `admin_monthly_report` — it's probably scanning a year of events without proper indexing
>
> Want me to inspect the source-backed query path for
> `admin_monthly_report` and run a bounded read-only PostHog query for that
> route and query ID? PostHog events can show timing and frequency; the actual
> SQL must come from the repository or database observability, not analytics.

## The output

```
Database cascade analysis (24h)

ROOT CAUSE (earliest, query-level)
   c_1c92  statement_timeout: query exceeded 30000ms
           src/api/admin/reports.ts:88  (route: GET /api/admin/reports/monthly)
           14 events / 4 admin users — started 1747349200 (1h ago)

CASCADE (downstream collateral)
   c_8e21  could not acquire connection from pool (timeout 5000ms)
           412 events / 88 USERS  — started 20min after c_1c92
           ↗ All paths in the app — random endpoint sample:
              /api/projects/list, /api/auth/me, /api/integrations/slack/status

   c_4a01  deadlock detected: process X waits for ShareLock on Y
           8 events / 3 users — concurrent with the cascade

Recommended actions:
   [now]    Add ?statement_timeout=5s to admin pool connection string
   [this w] Move admin/reporting queries to a read replica (separate pool)
   [next]   Add btree index on events(account_id, timestamp DESC)
            (will let admin_monthly_report finish in <1s)
```

## Setting it up

This workflow gets sharper when DB exceptions captured by the application's
official PostHog SDK carry a logical `query_id`, normalized route, and `db_pool`.
Use a logical name such as `admin_monthly_report`, never full SQL or bound
parameters.

If you're on Postgres, also set `application_name` and `statement_timeout` per logical pool, and the pg driver's error messages will carry them. The agent reads them out of the message verbatim.

For deeper visibility, capture a bounded periodic `db_pool_stats` event through
the existing official PostHog server SDK with `pool`, `in_use`, `waiting`, and
`max`. Run `agentry onboard` to review sampling and cardinality before adding
that signal.

## Variations

- *"Show me the longest-running queries by route in the last 24h, regardless of whether they errored."*
- *"Are deadlocks correlated with any specific deploy? List deploys followed within 1h by deadlock spikes."*
- *"What's the p99 wait-time for a connection in our primary pool? Trend it weekly."*
- *"On demand, show any pool that exceeded 80% utilization for at least five minutes and identify the affected routes."*
