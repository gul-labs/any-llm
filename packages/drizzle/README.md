# @gullabs/drizzle

Reference Postgres schema and `UsageSink` implementation for any-llm using Drizzle ORM. Provides the `llm_calls` table definition and a ready-to-use sink that persists `LlmCallRecord` objects to your database.

## Install

```bash
pnpm add @gullabs/drizzle @gullabs/core @gullabs/google drizzle-orm
```

**Peer dependency:** `drizzle-orm >=0.36 <1`

## Key exports

| Export                                                | What it is                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llmCalls`                                            | Drizzle `pgTable('llm_calls', ...)` — the reference schema                                                                                                 |
| `llmCallPayloads`                                     | Drizzle `pgTable('llm_call_payloads', ...)` — opt-in prompt and response text, keyed by `attempt_id`                                                       |
| `drizzleUsageSink({ db, transaction? })`              | Returns a `UsageSink`: one `INSERT ... ON CONFLICT DO NOTHING` per record (idempotent on `attemptId`); a record with a payload is written in a transaction |
| `PostgresDb`, `DrizzleUsageSinkOptions`               | Types of the `db` handle (a Drizzle Postgres database) and of the sink options                                                                             |
| `assertLlmCallsSchema(db)`                            | Checks, without writing, that the table has every column the sink writes and no NOT NULL column that would block an insert; rejects naming the fix         |
| `assertLlmCallPayloadsSchema(db)`                     | The same check for `llm_call_payloads`; rejects pointing at `0004-llm-call-payloads.sql`                                                                   |
| `purgeLlmCallPayloads(db, { olderThan, batchSize? })` | Deletes payloads written before a cutoff in batches (5,000 rows by default); returns the count                                                             |
| `deleteLlmCallPayloads(db, { callIds })`              | Deletes the payloads of the given calls; returns the count                                                                                                 |

## Quick example

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { drizzleUsageSink } from '@gullabs/drizzle'
import { createClient, composeProviders, defineCallSite } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'

// Pass a configured `pg.Pool` instead for pool sizing and timeouts.
const db = drizzle(process.env.DATABASE_URL!)

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink({ db }),
})

const myCallSite = defineCallSite({
  id: 'summarise',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  userTemplate: 'Summarise: {{text}}',
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

The `llm_calls` table mirrors `LlmCallRecord` from `@gullabs/core`: typed columns for the hot fields (`inputTokens`, `outputTokens`, `thinkingTokens`, `latencyMs`, `queueDelayMs`, `costMicroUsd`, etc.) and `jsonb` columns for forward-compatible lanes (`tokenDetails`, `rawUsage`, `providerMetadata`, `warnings`, `generationConfig`, `metadata`). Use the Drizzle schema for typed queries, or implement `UsageSink` yourself to write to any store. **Do not
`drizzle-kit generate` migrations for these tables.** `schema.ts` is exported so your queries are typed and
`drizzle-kit push` can check a database against it, but the SQL in `sql/` is the authority: drizzle-kit cannot
emit `NOT VALID` CHECKs, `CREATE INDEX CONCURRENTLY` or a `lock_timeout`, so a generated migration scans and
locks an existing table and fails on legacy rows. Create the tables with `sql/install.sql`; move an existing
database forward with the files in `sql/upgrades/`.

## SQL: create and upgrade the table

The package ships plain SQL in `sql/` (resolvable as `@gullabs/drizzle/sql/install.sql` and so on):

| File                                      | Use                                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `sql/install.sql`                         | Fresh install of the current `llm_calls` and `llm_call_payloads` tables and their indexes.                                                      |
| `sql/upgrades/0001-add-error-reason.sql`  | Adds the `error_reason` column to a table created by 0.7.2 or earlier. Idempotent.                                                              |
| `sql/upgrades/0002-ledger-v2.sql`         | Adds the cost columns, the indexes, `cost_micro_usd` as BIGINT and the `status` / `error_kind` CHECKs (NOT VALID). Idempotent per statement.    |
| `sql/upgrades/0003-validate-checks.sql`   | Optional. Validates those CHECKs against existing rows, after you clean legacy rows; can fail on them (see below).                              |
| `sql/upgrades/0004-llm-call-payloads.sql` | Adds the `llm_call_payloads` table, in one transaction. Refuses to run over a table of that name whose columns, types or keys differ from ours. |

Apply every upgrade you have not run yet, in numeric order (the prefixes are unique), **before** deploying the new sink, on every release that
ships one (the packages version in lockstep, so a core bump for an unrelated fix is a drizzle bump too). The
sink writes every column on every row, so a table that missed an upgrade makes every insert fail, successes
included. The engine swallows sink failures, so the rows are dropped and only logged (see below). There is no
compatibility path for the old shape. The files assume the table is named `llm_calls`. A runner that applies
every file in the directory stops at `0003-validate-checks.sql` on a database with legacy rows: fix them (below)
or skip that one file, then continue with `0004`. Tables made by `@gullabs/drizzle` 0.1.1 to 0.4.0 had
`raw_usage NOT NULL`; no upgrade covers them, and `assertLlmCallsSchema` names the column with its one-line
fix (`ALTER TABLE llm_calls ALTER COLUMN "raw_usage" DROP NOT NULL`).

To find out before rows are lost, call `assertLlmCallsSchema(db)` from a deploy or CI step, a readiness
endpoint, or at boot: it selects every column with `LIMIT 0`, reads the catalog for a NOT NULL column without a
default that the sink does not write (or writes as NULL), and rejects with a message that points at
`sql/upgrades/` or names the column and the fix.

`error_reason` is plain text with no CHECK constraint: new reasons arrive as core releases (see ADR-036)
and never need SQL. `status` and `error_kind` are closed vocabularies and carry CHECKs; a new member of
either ships with SQL. The table stores `cost_confidence`, `cost_details` and `cost_unpriced_reason` beside
`cost_micro_usd` (ADR-039; a BIGINT, read back by Drizzle as a JS number, while a SQL `SUM()` over it is a
`numeric` that the Postgres drivers return as a string: cast it, see [`docs/ledger.md`](../../docs/ledger.md#reading-sums)), and caps `reasoning_text` and `error_message` at 16 KiB.

### Running `0002-ledger-v2.sql` safely

- **Run it with `psql -v ON_ERROR_STOP=1 -f`.** The file sets `lock_timeout = '3s'` first, so a statement
  that cannot get its table lock fails instead of queueing behind a long query and blocking every sink
  insert (the sink gives up after `sinkTimeoutMs` and drops the row). Every statement is idempotent on its
  own: after a failure, re-run the whole file. This holds whether the file runs in one transaction or one
  statement at a time.
- **The CHECKs are added `NOT VALID`.** They reject bad `status` / `error_kind` values on every new or
  updated row immediately, without scanning the table. Rows written earlier are not checked until you run
  `0003-validate-checks.sql` (`VALIDATE CONSTRAINT`, which lets writes continue).
- **Legacy rows can block validation.** `@gullabs/core` 0.2.0 wrote `status = 'parse_error'` and
  `error_kind = 'parse_error'`; no other release wrote a value outside the vocabularies. The validate file
  documents the query that finds such rows and one reasonable `UPDATE` (it keeps the original values in
  `metadata`). The library never rewrites your history for you: run the `UPDATE` you choose, then the validate
  file. If you skip validation the constraints stay `NOT VALID`, which is safe for inserts, but Postgres checks
  a `NOT VALID` CHECK on every row an `UPDATE` writes: any `UPDATE` of a legacy row (your own tenant-deletion
  `UPDATE`, say) fails with `new row for relation "llm_calls" violates check constraint
"llm_calls_error_kind_check"` (or `..._status_check`) until you run that cleanup `UPDATE`. A `DELETE` is
  not affected.
- **`cost_micro_usd` becomes BIGINT.** One attempt above 2,147,483,647 micro-USD (about $2,147) would overflow
  the old INTEGER and drop its row. INTEGER to BIGINT rewrites the table under an exclusive lock, so run the
  file in a quiet period on a large table, or comment that last statement out: the sink works either way.
- **Index builds lock writes.** The four `CREATE INDEX` statements (including the partial indexes on
  `error_reason` and `auth_key_id`) take a SHARE lock while they build. On a
  large table create them first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` under the same names (the
  statements are in the file's header); the file then skips them. `CONCURRENTLY` cannot run inside a
  transaction block, so run it from a psql session or a migration step that does not wrap in a transaction. A
  failed concurrent build leaves an `INVALID` index that `IF NOT EXISTS` would accept: drop it and build
  again (the header has the query that finds it).

### Tested `drizzle-orm` versions and drivers

The peer range is `>=0.36 <1`. The test suite runs the version in the package's dev dependencies (0.45.x); the
0.36 floor is not in CI: it was run by hand for this release (the whole suite on PGlite, node-postgres and postgres-js, and `tsc`) and passed. The `check()` helper in the table's extra-config array and `getTableConfig` are the
surface the schema relies on. Report a break on an older version as a bug.

Drivers: the sink, `purgeLlmCallPayloads`, `deleteLlmCallPayloads` and both schema checks are tested on
node-postgres, postgres-js and PGlite (`src/drivers.integration.test.ts`; the first two against a real server
when `ANY_LLM_TEST_POSTGRES_URL` is set). That URL must name a throwaway Postgres on the local machine: the suites create and drop a database and write rows, so a URL whose effective target is not loopback (`127.0.0.0/8`, `::1`, `localhost` or a unix socket path; a `host` or `hostaddr` query parameter, a `service` parameter, `PGHOST` and `PGHOSTADDR` count) is refused before any driver connects, with no override. `neon-http` is **not tested**: it has no transactions, so it cannot
write payloads (a record with a payload fails and is logged as `llm.call.sink.failed`), and a ledger-only sink on
it is not tested either.

## Payload storage

By default the library stores no full prompt and no full response text. A host that has to debug or audit
calls opts in on the client:

```ts
import { composeProviders, createClient } from '@gullabs/core'
import { drizzleUsageSink } from '@gullabs/drizzle'
import { googleProvider } from '@gullabs/google'
import type { PostgresDb } from '@gullabs/drizzle'

declare const db: PostgresDb
declare function scrub<T>(payload: T): T

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink({ db }),
  payloads: { redact: (payload) => scrub(payload) },
})
```

With `payloads` set, each attempt that entered the adapter (including one the adapter rejected before any network call: a request that was never sent still has its payload) writes one `llm_call_payloads` row next to its
`llm_calls` row (see [`@gullabs/core`](../core/README.md#payload-storage-opt-in) for what is captured, the
bound-redact-cap order and the patterns, and ADR-038). Skip a call with `storePayload: false` on `generate` or
`runStructured`. Run `sql/upgrades/0004-llm-call-payloads.sql` (or install from `sql/install.sql`) first; call
`assertLlmCallPayloadsSchema(db)` at deploy or boot to check.

**What is in `llm_calls` whatever you set.** `payloads`, `include` and `storePayload` govern the payload table
only. The ledger row is written for every attempt and holds text of its own:

| Where                                                  | What it holds                                                                                                                                                          | Core secret patterns                                          | Governed by `payloads` / `include` / `storePayload` / purge and delete |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `llm_calls.reasoning_text`                             | The model's reasoning text, when the provider returns it (16 KiB cap)                                                                                                  | Yes                                                           | No                                                                     |
| `llm_calls.tool_calls`                                 | The tool calls the model made: id, name, arguments as JSON                                                                                                             | Yes: every string, and the value of a key named like a secret | No                                                                     |
| `llm_calls.error_message`                              | The error text of a failed attempt (provider error text, which can echo part of a request; 16 KiB cap)                                                                 | Yes                                                           | No                                                                     |
| `llm_calls.metadata`                                   | Your `CallMetadata` bag, verbatim                                                                                                                                      | No, never scanned                                             | No                                                                     |
| `llm_calls.citations`                                  | Source URL, title and source name of a grounded answer                                                                                                                 | No                                                            | No                                                                     |
| `llm_calls.provider_metadata`, `raw_usage`, `warnings` | Provider-reported JSON and engine diagnostics                                                                                                                          | No                                                            | No                                                                     |
| `llm_calls.generation_config`                          | The call's settings; `providerOptions` is scrubbed (the Google adapter admits only `httpOptions.timeout`, so no headers are ever in it)                                | Partly                                                        | No                                                                     |
| `llm_call_payloads.request`                            | The system prompt; every message part (text, tool-call arguments, tool-result values); media as type, size and SHA-256; file references; tools as name and schema hash | Yes, then your `redact`                                       | Yes                                                                    |
| `llm_call_payloads.response`                           | The raw model text, or the attempt's error message                                                                                                                     | Yes, then your `redact`                                       | Yes                                                                    |

A host that needs no text in the ledger does not persist those columns: wrap the sink and drop them before
delegating (an example is in [`docs/ledger.md`](../../docs/ledger.md#what-each-table-holds)). A tenant deletion
is `deleteLlmCallPayloads` for the payload rows plus your own `UPDATE` or `DELETE` on `llm_calls` for the ledger
columns; `purgeLlmCallPayloads` and `deleteLlmCallPayloads` never touch `llm_calls`.

**The write.** `drizzleUsageSink({ db, transaction? })` takes a Drizzle Postgres database.

- A record **without a payload** is one `INSERT ... ON CONFLICT DO NOTHING` on `db`: no transaction, one round
  trip. This is the path every record takes unless `payloads` is configured. It is the only path a driver
  without transactions could run, but no such driver is tested (see "Tested drivers"; `neon-http` throws on
  `transaction()`, so a payload write on it fails and is logged as `llm.call.sink.failed`).
- A record **with a payload** is written in one transaction: the `llm_calls` row, then the payload row in a
  nested transaction (Drizzle's `transaction()`, a `SAVEPOINT`). If the payload insert fails only the nested
  transaction is rolled back; it is logged as `llm.call.payload.failed` and the outer transaction commits:
  **the ledger row survives a payload failure, on node-postgres, postgres-js and PGlite alike**. If the ledger
  insert fails, nothing is written (no orphan payload) and the engine logs `llm.call.sink.failed` with the
  database's message and SQLSTATE, never the SQL or the bound parameters.
- A `db` with no `transaction()` (and no `transaction` helper) is `bad_request` at `drizzleUsageSink(...)`, not a
  failure on the first payload. There is no fallback.
- The whole write, and the building of the payload, is bounded by `sinkTimeoutMs` and never fails the LLM call.
  Set `idle_in_transaction_session_timeout` and `statement_timeout` for the role that runs the sink: a write the
  engine stopped waiting for keeps its pooled connection until the database finishes or gives up on it.

If your database standard routes every transaction through your own helper (tenant or role context, statement
timeouts), pass it as `transaction`; it then takes over every write (a record without a payload too) and every
statement runs on the handle it gives the sink:

```ts
import { drizzleUsageSink } from '@gullabs/drizzle'
import type { PostgresDb } from '@gullabs/drizzle'

declare const db: PostgresDb
declare function withTenantTransaction<T>(fn: (tx: PostgresDb) => Promise<T>): Promise<T>

drizzleUsageSink({ db, transaction: (fn) => withTenantTransaction(fn) })
```

The helper must open a transaction of its own per call. If it hands every call the same ambient transaction, the
sink serializes its writes on that handle (one at a time, each in a nested transaction of its own), so
concurrent records all keep their payloads; but the ledger rows now belong to that transaction: **when the host
transaction rolls back, the ledger rows and payloads roll back with it.** Do not use an ambient transaction for
a call whose bill must survive its failure.

The same holds when `db` itself is a transaction handle (`db.transaction(async (tx) => drizzleUsageSink({ db:
tx }))`): every write, with or without a payload, runs one at a time in a nested transaction, so concurrent
records all succeed and a failing write undoes only itself and never aborts your transaction. **You own that
transaction**: its commit or rollback decides whether the sink's rows survive, and the sink must not be used
after it ends.

**Payloads can contain customer data, and retention is yours.** The library never deletes them. Schedule
`purgeLlmCallPayloads(db, { olderThan })` (a daily job with your retention window; it deletes in batches of
`batchSize`, default 5,000, and returns the total) and, for tenant or subject deletion,
`deleteLlmCallPayloads(db, { callIds })`. Deletion takes `callIds` only: `externalId` is yours, not unique, and can
repeat across tenants, so there is no delete by `externalId`. Resolve a tenant's calls through your own scoping
(for example a tenant id in `metadata`), select their `call_id`s, and pass them. Deleting a payload never
touches the `llm_calls` row; deleting an `llm_calls` row deletes its payload (`ON DELETE CASCADE`).

`llm_call_payloads` has no tenant column. Read it only through a join to `llm_calls`, and write row-level
security on it as an `exists` over `llm_calls`: a policy written against `llm_calls` does not cover it. Drizzle's
query logger and Postgres statement logging record bound parameters, which for a payload insert is the payload
JSON: keep them off for the sink's role.

If you already have a table named `llm_call_payloads`, rename it (with its index and foreign key) before applying
the SQL: the upgrade compares the existing table's columns, types, nullability, default, primary key and foreign
key with the table it would create, and stops with an error unless they match exactly. It runs in one
transaction with a transaction-local `lock_timeout`, so a failed run leaves nothing behind.

## Sink fail-open guarantee

The engine swallows all sink errors — a broken database write never fails the LLM call. Every failure is logged via the engine's `Logger` at level `error` with the stable event name `llm.call.sink.failed` and the fields `callId`, `attemptId`, `attemptNumber`, `provider`, `model` and `error`. Alert on that event: a dropped row is otherwise invisible. For this sink `error` is the database's own message and SQLSTATE (and, for a missing column or table, a pointer to `assertLlmCallsSchema` and `sql/upgrades/`), never the SQL or the bound parameters, so reasoning text, tool arguments and `metadata` stay out of the log.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/ledger.md`](../../docs/ledger.md) — canonical `llm_calls` guidance, sidecar-table pattern, and query examples
- [`@gullabs/core` README](../core/README.md) — `LlmCallRecord`, `UsageSink`, and the engine's logging/observability seams
