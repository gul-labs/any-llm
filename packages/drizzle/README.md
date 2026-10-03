# @gullabs/drizzle

Reference Postgres schema and `UsageSink` implementation for any-llm using Drizzle ORM. Provides the `llm_calls` table definition and a ready-to-use sink that persists `LlmCallRecord` objects to your database.

## Install

```bash
pnpm add @gullabs/drizzle @gullabs/core @gullabs/google drizzle-orm
```

**Peer dependency:** `drizzle-orm >=0.36.0`

## Key exports

| Export                         | What it is                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `llmCalls`                     | Drizzle `pgTable('llm_calls', ...)` — the reference schema                                                    |
| `drizzleUsageSink(db, table?)` | Returns a `UsageSink` that writes records via `INSERT ... ON CONFLICT DO NOTHING` (idempotent on `attemptId`) |
| `InsertableDb`                 | Type of the `db` argument accepted by `drizzleUsageSink`                                                      |
| `assertLlmCallsSchema(db)`     | Checks, without writing, that the table has every column the sink writes; rejects pointing at `sql/upgrades/` |

## Quick example

```ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { llmCalls, drizzleUsageSink } from '@gullabs/drizzle'
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import pg from 'pg'

const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }))

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink(db, llmCalls),
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

| File                                     | Use                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `sql/install.sql`                        | Fresh install of the current `llm_calls` table and its indexes.                    |
| `sql/upgrades/0001-add-error-reason.sql` | Adds the `error_reason` column to a table created by 0.7.2 or earlier. Idempotent. |

Apply every upgrade you have not run yet, in order, **before** deploying the new sink, on every release that
ships one (the packages version in lockstep, so a core bump for an unrelated fix is a drizzle bump too). The
sink writes every column on every row, so a table that missed an upgrade makes every insert fail, successes
included. The engine swallows sink failures, so the rows are dropped and only logged (see below). There is no
compatibility path for the old shape. The files assume the table is named `llm_calls`.

To find out before rows are lost, call `assertLlmCallsSchema(db)` from a deploy or CI step, a readiness
endpoint, or at boot: it selects every column with `LIMIT 0` and rejects with a message that points at
`sql/upgrades/`.

`error_reason` is plain text with no CHECK constraint: new reasons arrive as core releases (see ADR-036)
and never need SQL.

## Sink fail-open guarantee

The engine swallows all sink errors — a broken database write never fails the LLM call. Every failure is logged via the engine's `Logger` at level `error` with the stable event name `llm.call.sink.failed` and the fields `callId`, `attemptId`, `attemptNumber`, `provider`, `model` and `error`. Alert on that event: a dropped row is otherwise invisible.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/ledger.md`](../../docs/ledger.md) — canonical `llm_calls` guidance, sidecar-table pattern, and query examples
- [`@gullabs/core` README](../core/README.md) — `LlmCallRecord`, `UsageSink`, and the engine's logging/observability seams
