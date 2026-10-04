# Ledger Guide

`@gullabs/drizzle` gives you the canonical per-attempt `llm_calls` table. Treat that table as the
source of truth for LLM facts that are universal across hosts: provider, model, usage, cost,
warnings, error classification, provider metadata, and the IDs the library owns.

If your application needs domain-specific anchors such as `reportId`, `workflowId`, `jobId`, or
artifact keys, keep those in a host-owned sidecar table keyed by `attemptId`. Do not fork the base
ledger shape unless you have a concrete reason to stop consuming the shared sink.

## What each field is for

| Field                  | Owner   | Use it for                                                                                                                                    |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `callId`               | library | Group all attempts belonging to one logical call.                                                                                             |
| `attemptId`            | library | Primary key for the attempt row and the foreign-key target for sidecars. Always minted by the library.                                        |
| `attemptNumber`        | library | Distinguish first attempt vs in-process retries.                                                                                              |
| `callSiteId`           | caller  | Prompt-family grouping and observability.                                                                                                     |
| `externalId`           | caller  | Correlation id for host-ledger queries; give every host retry of one operation the same value.                                                |
| `queueDelayMs`         | library | Time spent waiting in the configured rate limiter before provider dispatch; use alongside `latencyMs` when attributing spend/latency.         |
| `metadata`             | caller  | Small, stable, non-secret host anchors persisted verbatim.                                                                                    |
| `error_kind`           | library | Failure class (`rate_limited`, `timeout`, ...). Drives `status`; authoritative with `retryable`.                                              |
| `error_reason`         | library | Why, within the kind, from the closed `LlmErrorReason` set (`quota_window`, `transport_timeout`, ...). NULL when the error has none.          |
| `cost_micro_usd`       | library | What the library priced, in micro-USD. NULL when the call could not be priced (see `cost_unpriced_reason`) or has no cost.                    |
| `cost_confidence`      | library | `'exact'` or `'estimated'`: whether `cost_micro_usd` can be trusted as the bill (see below). NULL on rows written before record version 2.    |
| `cost_details`         | library | `{ input, cached, output, tools }` in micro-USD, summing to `cost_micro_usd`; `tools` is the tool-fee lane. NULL when unpriced.               |
| `cost_unpriced_reason` | library | Why `cost_micro_usd` is NULL: an unknown model, an unpriced tier, a missing tool counter, or `no_usage_reported` (see below). NULL otherwise. |

Rules that matter:

- A call whose final error did not come out of a provider attempt (a middleware refusal, a quota deferral,
  an exhausted retry budget) writes one zero-usage, unbilled row: `attempt_number` 0 when no attempt had
  run, otherwise the number of the refused attempt. `error_kind` and `error_reason` of such a row are the
  call's final outcome, so `error_reason = 'quota_window'` finds those calls too. A gap in a call's attempt
  numbers means a middleware refused that attempt before dispatch.
- Cost is stored with its confidence (record version 2, ADR-039). `cost_micro_usd` is the amount the library
  priced; `cost_confidence` says whether it is exact, `cost_details` splits it into `input`, `cached`,
  `output` and `tools` so tool fees can be separated from token spend in SQL, and `cost_unpriced_reason`
  says why a NULL amount is NULL. A row is `'estimated'` when the amount is knowingly approximate or
  incomplete: a call that ran web search (Google grounding is priced in the `tools` lane, Gemini 3 per
  query and Gemini 2.5 per grounded prompt, charged in full because the free allowance is unknowable per
  call, so the row can overstate; a row with `web_search_requested` and no `web_search_calls` has an
  unpriced fee and understates), an unpriced model or tier, a non-zero xAI tool counter with no rate, an
  audio prompt whose per-modality split the response did not report, or any call whose `totalTokens`
  exceeds `inputTokens + outputTokens`. `web_search_requested` (`1` on every attempt of a request that
  enabled web search, billed failures included; Google also sets it when a `cachedContent` handle lists
  `googleSearch`, and when a response carries grounding metadata the request did not declare, in which case
  the observed queries are priced and a warning says so) and `web_search_calls` (the observed number of searches;
  absent when the provider did not say, `0` when it said none ran) stay in `token_details`, which is
  otherwise token counts and, for xAI, `cost_in_usd_ticks` (the provider-reported cost of the response in
  1e-10 USD, so `cost_in_usd_ticks / 10000` is micro-USD): it is the only persisted trace of what xAI
  itself billed, and the way to reconcile an xAI row whose `cost_micro_usd` is NULL or `'estimated'`. Do
  not sum the values of `token_details`. `tool_use_prompt` (Gemini 2.5 Search-result tokens) is
  recorded and not priced. `usage_missing` (`1`) marks a Google 200 that carried no `usageMetadata`: the
  tokens are recorded as zero, `cost_micro_usd` is NULL and the confidence `estimated`. A failed attempt's
  row keeps the tier the attempt asked for in `service_tier` and the tier it was served at, when the error
  says, in `served_service_tier`. Rows written before record version 2 have NULL in all three cost columns: their
  confidence was never stored and cannot be recovered (`record_schema_version = 1`). Refusal rows (no
  attempt ran) have no cost.
- A dispatched attempt that failed **without reporting usage** (a timeout, an abort, a network failure, a
  stream cut before its usage arrived) may have been billed for an amount the library cannot know. Its row has
  no cost (`cost_micro_usd`, `cost_confidence` and `cost_details` are NULL) and `cost_unpriced_reason =
'no_usage_reported'`. A failure known to cost nothing (a failure that ended before dispatch, `bad_request`,
  `invalid_auth`, `rate_limited`, or an HTTP error answer that is not a timeout or abort) has no cost and no
  reason. So `cost_unpriced_reason = 'no_usage_reported'` finds the attempts that may have billed, and
  `cost_micro_usd IS NULL AND cost_unpriced_reason IS NULL` the ones that did not (a refusal row has no
  cost either). Those rows are the failed part of `callCost.unpricedAttempts` (which also counts an attempt
  whose usage the library has no price for, and carries that reason instead). A failure that did report usage
  is priced like a success.
- Money you can reconcile: the ledger writes `cost_micro_usd` per attempt, NULL when the attempt has no
  price (an unpriced model, or a failure that reported no usage). `LlmResult.callCost` is
  `{ microUsd, attempts, unpricedAttempts }` for one call in process: `microUsd` equals the SQL
  `SUM(cost_micro_usd)` over the call's rows (barring a dropped sink write, which is logged), and
  `unpricedAttempts` counts the attempts that were dispatched but have no priced usage, such as a timeout
  or an abort. The provider may have billed those, so when `unpricedAttempts > 0` both the SQL sum and
  `microUsd` are a **lower bound** (a call with two timeouts and a success has `unpricedAttempts: 2`). Find
  such calls in SQL with the rows whose `cost_unpriced_reason` is `no_usage_reported`.
  `callCost` is on `CallSuccessEvent`, `CallErrorEvent` and `LlmResult`; `Telemetry.onAttempt` reports each
  attempt as it happens.
- Provider-controlled text can carry what Postgres cannot store: U+0000 (rejected by `text` and `jsonb`) and an
  unpaired surrogate (rejected by `jsonb`). `buildRecord` removes U+0000 and replaces each unpaired surrogate
  with U+FFFD in every string and object key of the record, and adds a warning when it did, so the billed row is
  written instead of lost. The live result and the thrown error keep the original text.
- `reasoning_text` and `error_message` are provider-controlled and are capped at 16 KiB (UTF-8, marker
  included) when the record is built. A longer text ends in `…[truncated]` and the row carries a warning;
  the live result and the thrown error keep the full text. `error_message` is redacted before it is cut.

- `attemptId` is the durable row identity.
- Every attempt is a billed row with its own `attemptId`. The library never deduplicates provider calls; a host retry is a new call and new rows. Tie retries together with a shared `externalId`.
- `error_reason` is plain text with no CHECK constraint, so a reason added to core later needs no SQL. Match on the values in `LlmErrorReason`, and treat an unknown value as "some other reason".
- `metadata` is for low-cardinality JSON anchors, not secrets or large debug payloads.
- If a host field needs typed indexes or joins, put it in a sidecar table.

## When to use `metadata`, `externalId`, or a sidecar

Use `metadata` when:

- the value is useful for logs/telemetry and ad hoc inspection;
- JSON storage is acceptable;
- you do not need dedicated database constraints or hot-path indexes.

Use `externalId` when:

- there is one caller-owned id you frequently filter on;
- denormalized convenience matters more than modeling multiple typed columns.

Use a sidecar table when:

- you need multiple typed host columns;
- you need indexed joins into domain tables;
- retention, deletion, or access control differs from the shared ledger.

## Recommended sidecar pattern

Example host-owned table:

```ts
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { llmCalls } from '@gullabs/drizzle'

export const llmCallContext = pgTable('llm_call_context', {
  attemptId: text('attempt_id')
    .primaryKey()
    .references(() => llmCalls.attemptId, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull(),
  orgId: text('org_id'),
  workspaceId: text('workspace_id'),
  route: text('route'),
  workflowId: text('workflow_id'),
  reportId: text('report_id'),
  jobType: text('job_type'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
```

Write pattern:

1. call the library normally with `sink: drizzleUsageSink({ db })`;
2. use `result.attemptId` or `LlmError.attemptId` as the sidecar key;
3. persist your host row in the same request/activity flow.

`externalId` can mirror one of those host ids for convenience, but the typed join should still go
through the sidecar table. Retention and deletion ownership is entirely host-owned: no TTL or
`deleted_at` policy is defined in `llm_calls` today, so host code that implements those policies must
also decide whether and how to clean dependent sidecar rows.

## Creating and upgrading the table

`@gullabs/drizzle` ships plain SQL next to the Drizzle schema, in `sql/` inside the package:

- `sql/install.sql` creates the current `llm_calls` table, its indexes and its CHECK constraints, and the
  opt-in `llm_call_payloads` table, on a database that has neither.
- `sql/upgrades/NNNN-*.sql` moves an existing table forward. Apply every file you have not yet applied, in
  numeric order; the numbers are unique, so a numeric-prefix runner (golang-migrate, Flyway) accepts the
  directory. Each file is idempotent. `0001-add-error-reason.sql` takes the table published in 0.7.2 and adds
  `error_reason`. `0002-ledger-v2.sql` adds `cost_confidence`, `cost_details` and `cost_unpriced_reason`, the
  `created_at` and `(call_site_id, created_at)` indexes, partial indexes on `error_reason` and `auth_key_id`,
  widens `cost_micro_usd` to `BIGINT`, and adds CHECK constraints on `status` and `error_kind` (not on
  `error_reason`). The CHECKs are added `NOT VALID`, so they apply to new rows at once and never scan the table
  inside the upgrade. The file sets `lock_timeout` so a blocked statement fails rather than stalling sink
  writes, and every statement is idempotent on its own (re-run it after a failure). Two statements are not
  instant: the index builds (without `CONCURRENTLY` they take a SHARE lock, so writes wait: on a very large
  table create them first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` under the same names, outside a
  transaction) and the `INTEGER` to `BIGINT` change, which rewrites the table under an exclusive lock (run it
  in a quiet period; leaving the column `INTEGER` is safe until one attempt costs more than 2,147,483,647
  micro-USD, about $2,147). `0003-validate-checks.sql` is **optional** and can fail: it validates the existing
  rows against the CHECKs, and rows written by `@gullabs/core` 0.2.0 (`status` / `error_kind` =
  `parse_error`) block it until you fix them. It documents the query that finds them and a suggested
  `UPDATE`; the library does not rewrite your history. A runner that applies every file in the directory
  stops there on such a database: fix the rows, or skip that one file, and continue with
  `0004-llm-call-payloads.sql`, which adds the opt-in payload table.

**Skipping validation, and `UPDATE` on legacy rows.** Leaving the CHECKs `NOT VALID` is safe for inserts, but
Postgres enforces a `NOT VALID` CHECK on every row an `UPDATE` writes, so while they are not validated any
`UPDATE` that touches a legacy row (`parse_error` in `status` or `error_kind`) fails, whatever column it sets:

```text
ERROR:  new row for relation "llm_calls" violates check constraint "llm_calls_error_kind_check"
DETAIL:  Failing row contains (...)
```

(the constraint is `llm_calls_error_kind_check` or `llm_calls_status_check`, whichever the row breaks first). Your
own maintenance is affected, for example the tenant-deletion `UPDATE` below when one of the calls is a legacy
row. A `DELETE` is not. Run the cleanup `UPDATE` documented in `0003-validate-checks.sql` first (it files the
legacy rows under valid values and keeps the originals in `metadata`); after that every `UPDATE` works whether
or not you ever validate.

**drizzle-kit.** `schema.ts` is exported so your queries are typed and `drizzle-kit push` can check a
database against it, but the SQL files are the authority for an existing database. `drizzle-kit generate`
cannot emit `NOT VALID` CHECKs, `CREATE INDEX CONCURRENTLY` or a `lock_timeout`, so a migration it generates
from `schema.ts` scans and locks the table and fails on legacy rows. Do not generate migrations for these
tables; apply the shipped files.

**Tested `drizzle-orm` versions.** The peer range is `>=0.36 <1`; the test suite runs the version in the
package's dev dependencies (0.45.x). The 0.36 floor is not in CI; it was run by hand for this release (the whole suite on PGlite, node-postgres and
postgres-js, and `tsc`) and passed.

**Drivers.** The sink, the retention helpers and `assertLlmCallsSchema` are tested on node-postgres,
postgres-js and PGlite (the first two against a real server, see `drivers.integration.test.ts`). `neon-http`
is not tested; it has no transactions, so it cannot write payloads (a record with a payload fails and is
logged as `llm.call.sink.failed`), and a ledger-only sink on it is not tested either.

Run the upgrade SQL **before** you deploy the new sink, and do it on every release that ships one: all
`@gullabs/*` packages version in lockstep, so bumping core for an unrelated fix means bumping
`@gullabs/drizzle` too. The sink writes every column on every row, so a table that missed an upgrade makes
**every** insert fail, successes included. The engine swallows sink failures by design (a broken ledger must
not fail LLM calls), so each dropped row is only logged: level `error`, event `llm.call.sink.failed`, with
`callId`, `attemptId`, `attemptNumber`, `provider`, `model` and the redacted error. There is no
compatibility path for the old table shape. Both files assume the table is called `llm_calls`; substitute
your name if it differs.

Two ways to find out before rows are lost:

- Alert on the `llm.call.sink.failed` log event (it is stable). A sink that does not answer within
  `sinkTimeoutMs` (default 5 s) is abandoned and logged as `llm.call.sink.timeout` (same fields, plus
  `timeoutMs`); one still pending 100 ms after the caller aborted or the call deadline passed is
  abandoned and logged as `llm.call.sink.interrupted` (same fields, plus `graceMs`). The row may or
  may not be written later in either case, so alert on both events.
- Call `assertLlmCallsSchema(db)` from `@gullabs/drizzle`. It selects every column the schema names with
  `LIMIT 0`, writes nothing, and rejects with an error that points at `sql/upgrades/`. It also reads the
  catalog for a column that would make the insert fail: a `NOT NULL` column without a default that the sink
  does not write, or one the schema allows to be NULL. Tables made by `@gullabs/drizzle` 0.1.1 to 0.4.0 have
  `raw_usage NOT NULL`, which rejects every error, timeout and refusal row; no upgrade script covers those
  shapes. The error names the column and the fix, one line each, for example
  `ALTER TABLE llm_calls ALTER COLUMN "raw_usage" DROP NOT NULL` (or `SET DEFAULT` for a column you added).
  It needs no client, so run it from a deploy or CI step, a readiness endpoint, or at boot.
- The failure log carries the cause. A dropped ledger row logs `llm_calls insert failed for attempt <id>:` and
  the database's own message and SQLSTATE (`42703` for a missing column, `42P01` for a missing table,
  `23502` for a NOT NULL violation), with a pointer to `assertLlmCallsSchema` and `sql/upgrades/` for those.
  It never carries the SQL or the bound parameters: reasoning text, tool arguments and `metadata` do not reach
  the log.

## What each table holds

The ledger row is not text-free, and the opt-in payload table is not the only place customer text can land.
This is the whole list of text-bearing places and what governs each:

| Where                                                  | What it holds                                                                                                                                                          | Core secret patterns applied                                  | Governed by `payloads`, `include`, `storePayload`, the purge and delete helpers |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `llm_calls.reasoning_text`                             | The model's reasoning text, when the provider returns it (16 KiB cap)                                                                                                  | Yes                                                           | No                                                                              |
| `llm_calls.tool_calls`                                 | The tool calls the model made: id, name, arguments as JSON                                                                                                             | Yes: every string, and the value of a key named like a secret | No                                                                              |
| `llm_calls.error_message`                              | The error text of a failed attempt (provider error text, which can echo part of a request; 16 KiB cap)                                                                 | Yes                                                           | No                                                                              |
| `llm_calls.metadata`                                   | Your `CallMetadata` bag, verbatim                                                                                                                                      | No, never scanned                                             | No                                                                              |
| `llm_calls.citations`                                  | Source URL, title and source name of a grounded answer                                                                                                                 | No                                                            | No                                                                              |
| `llm_calls.provider_metadata`, `raw_usage`, `warnings` | Provider-reported JSON and engine diagnostics                                                                                                                          | No                                                            | No                                                                              |
| `llm_calls.generation_config`                          | The call's settings; `providerOptions` is scrubbed (the Google adapter admits only `httpOptions.timeout`, so no headers are ever in it)                                | Partly                                                        | No                                                                              |
| `llm_call_payloads.request`                            | The system prompt; every message part (text, tool-call arguments, tool-result values); media as type, size and SHA-256; file references; tools as name and schema hash | Yes, then your `redact`                                       | Yes                                                                             |
| `llm_call_payloads.response`                           | The raw model text, or the attempt's error message                                                                                                                     | Yes, then your `redact`                                       | Yes                                                                             |

`storePayload: false`, `include` and the off-by-default `payloads` setting govern `llm_call_payloads` only. The
`llm_calls` columns above are written on every attempt whatever they say (core's secret patterns, listed in the
README of `@gullabs/core`, run on the ones marked), and `purgeLlmCallPayloads` / `deleteLlmCallPayloads` do not
touch them. Personal data in them (a customer's name in a tool-call argument, an SSN the model repeated in its
reasoning) is yours to handle. A host that needs no text at all in `llm_calls` does not persist those columns:
wrap the sink and drop them before delegating.

```ts no-check
import { drizzleUsageSink } from '@gullabs/drizzle'
import type { UsageSink } from '@gullabs/core'

const inner = drizzleUsageSink({ db })
const sink: UsageSink = {
  acceptsPayloads: true, // the wrapper forwards ctx, so payloads still reach the payload table
  record: (r, ctx) => {
    // `_`-prefixed names are the columns this host does not persist
    const {
      reasoningText: _r,
      toolCalls: _t,
      errorMessage: _e,
      citations: _c,
      ...rest
    } = r
    return inner.record(rest, ctx)
  },
}
```

A tenant deletion that follows these docs has two parts: `deleteLlmCallPayloads(db, { callIds })` for the payload
rows, and your own `UPDATE llm_calls SET reasoning_text = NULL, tool_calls = NULL, error_message = NULL,
citations = NULL, metadata = '{}' WHERE call_id = ANY($1)` (or `DELETE`, which also cascades to the payload
rows) for the ledger columns. While the status CHECKs are `NOT VALID` that `UPDATE` fails on a legacy row (see
"Skipping validation" above): fix the legacy rows first.

## Prompt and response text (opt-in)

A client that sets `ClientConfig.payloads` hands the sink one payload per attempt that entered the adapter (`adapter.run` was called), and
`drizzleUsageSink({ db })` stores it in `llm_call_payloads`, keyed by `attempt_id` (FK to `llm_calls`, `ON DELETE
CASCADE`, index on `created_at`): `request` is `{ system?, messages, tools? }` with media parts as a media type,
size and SHA-256 (never bytes; a part over 20 MiB or not valid base64 is stored as a marker) and tools as name
and schema hash; `response` is `{ text?, errorMessage? }`. `sql/upgrades/0004-llm-call-payloads.sql` adds the
table to an existing database. "Entered the adapter" is exact: an attempt the adapter itself rejects before any
network call (a media type, schema keyword or stale signature state it refuses, `bad_request`) is still an
attempt. The engine books it with a zero-token row (no cost, no reason, a near-zero latency, counted in
`callCost.attempts` but not as unpriced, `Telemetry.onAttempt` fires) and stores a payload for it, though no
request was sent. An attempt refused before the adapter (a middleware, per-attempt config validation, routing,
the rate limiter) has no payload; a refusal outside any attempt is the `attempt_number` 0 row. When you count
dispatched requests from the ledger, exclude `bad_request` rows with zero tokens. A payload is written in the same transaction as the ledger row, in a nested
transaction (a savepoint, through Drizzle's `transaction()`): a payload failure never costs the ledger row, on
every supported driver. The transaction is also why a host rollback takes the ledger row too, when `db` is
your transaction handle or your `transaction` helper joins a transaction of yours. In that case the sink runs
its writes one at a time, each in a nested transaction of its own, so concurrent records all succeed and a
failing write never aborts your transaction; the commit or rollback stays yours. See the
[`@gullabs/drizzle` README](../packages/drizzle/README.md#payload-storage) and ADR-038.

Payloads can contain customer data. Retention and tenant deletion are the host's duty: schedule
`purgeLlmCallPayloads(db, { olderThan })` (batched, 5,000 rows per statement by default) and delete by call with
`deleteLlmCallPayloads(db, { callIds })` (no delete by `externalId`, which can repeat across tenants).

`llm_call_payloads` has no tenant column. Read it only through a join to `llm_calls`, and write any row-level
security on it as an `exists` over `llm_calls`, because a policy written against `llm_calls` does not cover it:

```sql
select c.attempt_number, c.status, p.request, p.response
from llm_calls c
join llm_call_payloads p using (attempt_id)
where c.call_id = $1
order by c.attempt_number;
```

Drizzle's query logger and Postgres statement logging (`log_statement`, `log_min_duration_statement`,
`auto_explain`) record bound parameters, which for the payload insert is the payload JSON. Leave them off for the
role that runs the sink, or accept that the log holds what the table holds.

## Atomic sidecar writes (transaction composition)

```ts no-check
function hostUsageSink(db: NodePgDatabase): UsageSink {
  return {
    async record(r: LlmCallRecord): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .insert(llmCalls)
          .values(mapRecord(r))
          .onConflictDoNothing({ target: llmCalls.attemptId })
        const ctx = r.metadata as { tenantId?: string; reportId?: string }
        if (ctx?.tenantId) {
          await tx
            .insert(llmCallContext)
            .values({
              attemptId: r.attemptId,
              tenantId: ctx.tenantId,
              reportId: ctx.reportId,
            })
            .onConflictDoNothing({ target: llmCallContext.attemptId })
        }
      })
    },
  }
}
```

The engine wraps `UsageSink.record()` in fail-open handling — see `recordToSink` in
`packages/core/src/engine.ts`. So if this composed transaction fails, both canonical and sidecar
writes roll back together and the LLM call still succeeds.

If a host needs richer typed joins and retention-oriented indexes, use a richer schema:

```ts no-check
export const llmCallContext = pgTable(
  'llm_call_context',
  {
    attemptId: text('attempt_id')
      .primaryKey()
      .references(() => llmCalls.attemptId, { onDelete: 'cascade' }),
    jobId: text('job_id').notNull(),
    workflowRunId: text('workflow_run_id'),
    documentId: text('document_id'),
    stepId: text('step_id'),
    inputObjectKey: text('input_object_key'),
    debugPayload: jsonb('debug_payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('llm_call_context_job_id_idx').on(table.jobId),
    index('llm_call_context_workflow_run_id_idx').on(table.workflowRunId),
    index('llm_call_context_document_id_idx').on(table.documentId),
  ],
)
```

`attemptId` as PK+FK gives you a strict 1:1 anchor, and `ON DELETE CASCADE` is the correct default once
host retention/deletion is implemented even though this repo’s canonical ledger is append-only today.

## Query examples (index-coverage note)

### Reading sums

`cost_micro_usd` is `BIGINT`. Drizzle reads the column itself as a JS number (`mode: 'number'`, safe to 2^53
micro-USD, about $9 billion), but a Postgres aggregate over it is not: `SUM(bigint)` is `numeric`, and
`count(*)` is `bigint`. node-postgres and postgres-js return `bigint` and `numeric` as **strings**. Cast in SQL
(`sum(cost_micro_usd)::float8`, exact below 2^53) or convert in code (`Number(row.spend)`, or
``sql<number>`sum(${llmCalls.costMicroUsd})`.mapWith(Number)`` in Drizzle). The library's own helpers do this:
`purgeLlmCallPayloads` selects `count(*)::int`.

Spend by day (index-backed on `created_at` for a time window):

```sql
select
  date_trunc('day', created_at) as day,
  sum(cost_micro_usd)::float8 as spend_micro_usd
from llm_calls
where cost_micro_usd is not null
  and created_at >= now() - interval '30 days'
group by 1
order by 1 desc;
```

Spend split by lane and confidence (tool fees against token spend, and how much of it is approximate):

```sql
select
  provider,
  cost_confidence,
  sum((cost_details ->> 'input')::bigint + (cost_details ->> 'cached')::bigint
      + (cost_details ->> 'output')::bigint) as token_micro_usd,
  sum((cost_details ->> 'tools')::bigint) as tool_micro_usd
from llm_calls
where cost_details is not null
group by 1, 2;
```

Calls the quota layer deferred, and spend per key. `error_reason` and `auth_key_id` each have a partial index
(only rows where the column is set), so a query on them can use an index instead of scanning the table. `model` has no index: a
per-model query over a long window scans the window (see the retries example):

```sql
select call_id, created_at from llm_calls where error_reason = 'quota_window' order by created_at desc;

select auth_key_id, sum(cost_micro_usd)::float8 as spend_micro_usd
from llm_calls
where auth_key_id is not null and created_at >= now() - interval '30 days'
group by 1;
```

Failures by call-site over a window (the `created_at` index bounds the scan; `(call_site_id, created_at)` serves one call site over a window):

```sql
select
  call_site_id,
  error_kind,
  count(*) as failures
from llm_calls
where status <> 'ok'
  and created_at >= now() - interval '7 days'
group by 1, 2
order by failures desc;
```

Retries by model (`callId` → `attemptId` is 1:many; `count(*) filter (...)` counts physical retry attempts, and `count(distinct call_id)` counts logical calls):

Every attempt of an in-process retry gets a freshly minted `attemptId`; `attempt_number` orders them
within the `call_id`. To count every attempt a host's own retries caused, group by `external_id`
instead of `call_id`.

```sql
select
  model,
  count(*) filter (where attempt_number > 1) as retry_attempts,
  count(distinct call_id) as logical_calls
from llm_calls
group by 1
order by retry_attempts desc;

```

This aggregation is full-table by design for most workloads; no dedicated call-site index is required to
collect per-model retry totals this way.

Grounded-call audit trail (today: **seq-scan**, no GIN index on `provider_metadata`):

```sql
select
  attempt_id,
  call_site_id,
  provider_metadata -> 'groundingMetadata' as grounding_metadata,
  provider_metadata -> 'promptFeedback' as prompt_feedback
from llm_calls
where provider_metadata ? 'groundingMetadata';

```

Add a GIN index on `provider_metadata` if this query becomes hot.

Host-domain join (index-backed):

```sql
select
  c.job_id,
  l.attempt_id,
  l.model,
  l.status,
  l.cost_micro_usd,
  l.queue_delay_ms
from llm_call_context c
join llm_calls l on l.attempt_id = c.attempt_id
where c.job_id = $1
order by l.created_at asc;
```

## Migration notes

If you are replacing a legacy wrapper that stuffed usage JSON into domain rows:

1. keep `llm_calls` canonical for universal LLM facts;
2. move typed domain anchors into a sidecar keyed by `attemptId`;
3. keep legacy response-shape adapters at the application edge, not in the library.

That keeps the shared ledger stable while letting each host evolve its own reporting model.
