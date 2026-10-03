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

Apply every upgrade you have not run yet, in order, **before** deploying the new sink. An insert that names
a column the table lacks fails, and the engine swallows sink failures (they are logged), so ledger rows
would silently go missing. The files assume the table is named `llm_calls`.

`error_reason` is plain text with no CHECK constraint: new reasons arrive as core releases (see ADR-036)
and never need SQL.

## Sink fail-open guarantee

The engine swallows all sink errors — a broken database write never fails the LLM call. Errors are logged via the engine's `Logger` at level `error` with event name `llm.call.sink.failed`.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/ledger.md`](../../docs/ledger.md) — canonical `llm_calls` guidance, sidecar-table pattern, and query examples
- [`@gullabs/core` README](../core/README.md) — `LlmCallRecord`, `UsageSink`, and the engine's logging/observability seams
