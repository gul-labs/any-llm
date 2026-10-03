# @gullabs/drizzle

Reference Postgres schema and `UsageSink` implementation for any-llm using Drizzle ORM. Provides the `llm_calls` table definition and a ready-to-use sink that persists `LlmCallRecord` objects to your database.

## Install

```bash
pnpm add @gullabs/drizzle @gullabs/core @gullabs/google drizzle-orm
```

**Peer dependency:** `drizzle-orm >=0.36 <1`

## Key exports

| Export                                    | What it is                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `llmCalls`                                | Drizzle `pgTable('llm_calls', ...)` — the reference schema                                                                                             |
| `llmCallPayloads`                         | Drizzle `pgTable('llm_call_payloads', ...)` — opt-in prompt and response text, keyed by `attempt_id`                                                   |
| `drizzleUsageSink({ db, transaction? })`  | Returns a `UsageSink` that writes each record in one transaction via `INSERT ... ON CONFLICT DO NOTHING` (idempotent on `attemptId`), plus its payload |
| `PostgresDb`, `DrizzleUsageSinkOptions`   | Types of the `db` handle (a Drizzle Postgres database) and of the sink options                                                                         |
| `assertLlmCallsSchema(db)`                | Checks, without writing, that the table has every column the sink writes; rejects pointing at `sql/upgrades/`                                          |
| `assertLlmCallPayloadsSchema(db)`         | The same check for `llm_call_payloads`; rejects pointing at `0003-llm-call-payloads.sql`                                                               |
| `purgeLlmCallPayloads(db, { olderThan })` | Deletes payloads written before a cutoff; returns the count                                                                                            |
| `deleteLlmCallPayloads(db, { callIds })`  | Deletes the payloads of the given calls; returns the count                                                                                             |

## Quick example

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzleUsageSink } from '@gullabs/drizzle'
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import pg from 'pg'

const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }))

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink({ db }),
})

// Auth is required per call — pass it at call time, never at client construction.
const result = await client.runStructured(
  myCallSite,
  { text: 'hello' },
  {
    auth: { apiKey: process.env.GEMINI_API_KEY! },
  },
)
```

## Schema

The `llm_calls` table mirrors `LlmCallRecord` from `@gullabs/core`: typed columns for the hot fields (`inputTokens`, `outputTokens`, `thinkingTokens`, `latencyMs`, `queueDelayMs`, `costMicroUsd`, etc.) and `jsonb` columns for forward-compatible lanes (`tokenDetails`, `rawUsage`, `providerMetadata`, `warnings`, `generationConfig`, `metadata`). Use the Drizzle schema directly, or implement `UsageSink` yourself to write to any store.

## SQL: create and upgrade the table

The package ships plain SQL in `sql/` (resolvable as `@gullabs/drizzle/sql/install.sql` and so on):

| File                                      | Use                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sql/install.sql`                         | Fresh install of the current `llm_calls` and `llm_call_payloads` tables and their indexes.                                    |
| `sql/upgrades/0001-add-error-reason.sql`  | Adds the `error_reason` column to a table created by 0.7.2 or earlier. Idempotent.                                            |
| `sql/upgrades/0002-ledger-v2.sql`         | Adds the cost columns, the `created_at` indexes and the `status` / `error_kind` CHECKs (NOT VALID). Idempotent per statement. |
| `sql/upgrades/0002-validate-checks.sql`   | Validates those CHECKs against existing rows, after you clean legacy rows. Run separately.                                    |
| `sql/upgrades/0003-llm-call-payloads.sql` | Adds the `llm_call_payloads` table. Idempotent per statement; refuses to run over a table of that name that is not ours.      |

Apply every upgrade you have not run yet, in order, **before** deploying the new sink, on every release that
ships one (the packages version in lockstep, so a core bump for an unrelated fix is a drizzle bump too). The
sink writes every column on every row, so a table that missed an upgrade makes every insert fail, successes
included. The engine swallows sink failures, so the rows are dropped and only logged (see below). There is no
compatibility path for the old shape. The files assume the table is named `llm_calls`.

To find out before rows are lost, call `assertLlmCallsSchema(db)` from a deploy or CI step, a readiness
endpoint, or at boot: it selects every column with `LIMIT 0` and rejects with a message that points at
`sql/upgrades/`.

`error_reason` is plain text with no CHECK constraint: new reasons arrive as core releases (see ADR-036)
and never need SQL. `status` and `error_kind` are closed vocabularies and carry CHECKs; a new member of
either ships with SQL. The table stores `cost_confidence`, `cost_details` and `cost_unpriced_reason` beside
`cost_micro_usd` (ADR-039), and caps `reasoning_text` and `error_message` at 16 KiB.

### Running `0002-ledger-v2.sql` safely

- **Run it with `psql -v ON_ERROR_STOP=1 -f`.** The file sets `lock_timeout = '3s'` first, so a statement
  that cannot get its table lock fails instead of queueing behind a long query and blocking every sink
  insert (the sink gives up after `sinkTimeoutMs` and drops the row). Every statement is idempotent on its
  own: after a failure, re-run the whole file. This holds whether the file runs in one transaction or one
  statement at a time.
- **The CHECKs are added `NOT VALID`.** They reject bad `status` / `error_kind` values on every new or
  updated row immediately, without scanning the table. Rows written earlier are not checked until you run
  `0002-validate-checks.sql` (`VALIDATE CONSTRAINT`, which lets writes continue).
- **Legacy rows can block validation.** `@gullabs/core` 0.2.0 wrote `status = 'parse_error'` and
  `error_kind = 'parse_error'`; no other release wrote a value outside the vocabularies. The validate file
  documents the query that finds such rows and one reasonable `UPDATE` (it keeps the original values in
  `metadata`). The library never rewrites your history for you: run the `UPDATE` you choose, then the validate
  file. If you skip validation the constraints stay `NOT VALID`, which is safe.
- **Index builds lock writes.** The two `CREATE INDEX` statements take a SHARE lock while they build. On a
  large table create them first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` under the same names (the
  statements are in the file's header); the file then skips them. `CONCURRENTLY` cannot run inside a
  transaction block, so run it from a psql session or a migration step that does not wrap in a transaction. A
  failed concurrent build leaves an `INVALID` index that `IF NOT EXISTS` would accept: drop it and build
  again (the header has the query that finds it).

### Tested `drizzle-orm` versions

The peer range is `>=0.36 <1`. The test suite installs and runs only the version in the package's dev
dependencies (0.45.x); the 0.36 floor is declared, not tested. The `check()` helper in the table's extra-config
array and `getTableConfig` are the surface the schema relies on. Report a break on an older version as a bug.

## Payload storage

By default the library stores no prompt and no response text. A host that has to debug or audit calls opts in
on the client:

```ts
const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink({ db }),
  payloads: { redact: (payload) => scrub(payload) },
})
```

With `payloads` set, each attempt that reached the provider writes one `llm_call_payloads` row next to its
`llm_calls` row (see [`@gullabs/core`](../core/README.md#payload-storage-opt-in) for what is captured and the
redact-then-cap order, and ADR-038). Skip a call with `storePayload: false` on `generate` or `runStructured`.
Run `sql/upgrades/0003-llm-call-payloads.sql` (or install from `sql/install.sql`) first; call
`assertLlmCallPayloadsSchema(db)` at deploy or boot to check.

**The write.** `drizzleUsageSink({ db, transaction? })` takes a Drizzle Postgres database that has `transaction`.
Each record is written in one transaction: the `llm_calls` row first, then, in a nested transaction (a
`SAVEPOINT`), the payload row. If the payload insert fails it is rolled back to the savepoint, logged as
`llm.call.payload.failed`, and the transaction commits: **the ledger row always survives a payload failure**. If
the ledger insert fails, nothing is written (no orphan payload) and the engine logs `llm.call.sink.failed`. The
whole write is bounded by `sinkTimeoutMs` and never fails the LLM call.

If your database standard routes every transaction through your own helper (tenant or role context, statement
timeouts), pass it as `transaction`; every statement then runs on the handle it gives the sink:

```ts
drizzleUsageSink({ db, transaction: (fn) => withTenantTransaction(fn) })
```

**Payloads can contain customer data, and retention is yours.** The library never deletes them. Schedule
`purgeLlmCallPayloads(db, { olderThan })` (a daily job with your retention window) and, for tenant or subject
deletion, `deleteLlmCallPayloads(db, { callIds })`. Deletion takes `callIds` only: `externalId` is yours, not
unique, and can repeat across tenants, so there is no delete by `externalId`. Resolve a tenant's calls through
your own scoping (for example a tenant id in `metadata`), select their `call_id`s, and pass them. Deleting a
payload never touches the `llm_calls` row; deleting an `llm_calls` row deletes its payload (`ON DELETE CASCADE`).

If you already have a table named `llm_call_payloads`, rename it (with its index and foreign key) before applying
the SQL; the upgrade stops with an error rather than write into a table of another shape.

## Sink fail-open guarantee

The engine swallows all sink errors — a broken database write never fails the LLM call. Every failure is logged via the engine's `Logger` at level `error` with the stable event name `llm.call.sink.failed` and the fields `callId`, `attemptId`, `attemptNumber`, `provider`, `model` and `error`. Alert on that event: a dropped row is otherwise invisible.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/ledger.md`](../../docs/ledger.md) — canonical `llm_calls` guidance, sidecar-table pattern, and query examples
- [`@gullabs/core` README](../core/README.md) — `LlmCallRecord`, `UsageSink`, and the engine's logging/observability seams
