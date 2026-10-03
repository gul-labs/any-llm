# Ledger Guide

`@gullabs/drizzle` gives you the canonical per-attempt `llm_calls` table. Treat that table as the
source of truth for LLM facts that are universal across hosts: provider, model, usage, cost,
warnings, error classification, provider metadata, and the IDs the library owns.

If your application needs domain-specific anchors such as `reportId`, `workflowId`, `jobId`, or
artifact keys, keep those in a host-owned sidecar table keyed by `attemptId`. Do not fork the base
ledger shape unless you have a concrete reason to stop consuming the shared sink.

## What each field is for

| Field           | Owner   | Use it for                                                                                                                            |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `callId`        | library | Group all attempts belonging to one logical call.                                                                                     |
| `attemptId`     | library | Primary key for the attempt row and the foreign-key target for sidecars. Always minted by the library.                                |
| `attemptNumber` | library | Distinguish first attempt vs in-process retries.                                                                                      |
| `callSiteId`    | caller  | Prompt-family grouping and observability.                                                                                             |
| `externalId`    | caller  | Correlation id for host-ledger queries; give every host retry of one operation the same value.                                        |
| `queueDelayMs`  | library | Time spent waiting in the configured rate limiter before provider dispatch; use alongside `latencyMs` when attributing spend/latency. |
| `metadata`      | caller  | Small, stable, non-secret host anchors persisted verbatim.                                                                            |
| `error_kind`    | library | Failure class (`rate_limited`, `timeout`, ...). Drives `status`; authoritative with `retryable`.                                      |
| `error_reason`  | library | Why, within the kind, from the closed `LlmErrorReason` set (`quota_window`, `transport_timeout`, ...). NULL when the error has none.  |

Rules that matter:

- A call whose final error did not come out of a provider attempt (a middleware refusal, a quota deferral,
  an exhausted retry budget) writes one zero-usage, unbilled row: `attempt_number` 0 when no attempt had
  run, otherwise the number of the refused attempt. `error_kind` and `error_reason` of such a row are the
  call's final outcome, so `error_reason = 'quota_window'` finds those calls too. A gap in a call's attempt
  numbers means a middleware refused that attempt before dispatch.
- Cost confidence is **not** a column today. `cost_micro_usd` is the amount the library priced, and it
  does not persist whether that amount is exact. Calls that ran web search are the knowingly approximate
  ones, and two normalised facts in `token_details` mark them on every provider that reports them:
  `web_search_requested` (`1` on every attempt of a request that enabled web search, failures that were
  billed included) and `web_search_calls` (the observed number of searches; absent when the provider did
  not say, `0` when it said none ran). Google grounding is priced in `cost_micro_usd` (Gemini 3 per
  query, Gemini 2.5 per grounded prompt, charged in full because the free allowance is unknowable per
  call), so such a row is an estimate that can overstate; a row with `web_search_requested` and no
  `web_search_calls` has an unpriced fee and understates. `tool_use_prompt` (Gemini 2.5 Search-result
  tokens) is recorded and not priced. A warning in `warnings` says why when the count is unknown. These
  keys live in `token_details`, which is otherwise token counts, so do not sum its values. The result's
  `cost.confidence` is `'estimated'` for these calls (and for any call whose `totalTokens` exceeds
  `inputTokens + outputTokens`) but is not stored. A later release (plan R7.1) adds a persisted
  `cost_confidence` column; until then use the markers above.

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

1. call the library normally with `sink: drizzleUsageSink(db, llmCalls)`;
2. use `result.attemptId` or `LlmError.attemptId` as the sidecar key;
3. persist your host row in the same request/activity flow.

`externalId` can mirror one of those host ids for convenience, but the typed join should still go
through the sidecar table. Retention and deletion ownership is entirely host-owned: no TTL or
`deleted_at` policy is defined in `llm_calls` today, so host code that implements those policies must
also decide whether and how to clean dependent sidecar rows.

## Creating and upgrading the table

`@gullabs/drizzle` ships plain SQL next to the Drizzle schema, in `sql/` inside the package:

- `sql/install.sql` creates the current `llm_calls` table and its indexes on a database that has none.
- `sql/upgrades/NNNN-*.sql` moves an existing table forward. Apply every file you have not yet applied, in
  order. Each is idempotent. `0001-add-error-reason.sql` takes the table published in 0.7.2 and adds
  `error_reason`.

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
  `LIMIT 0`, writes nothing, and rejects with an error that points at `sql/upgrades/`. It needs no client,
  so run it from a deploy or CI step, a readiness endpoint, or at boot.

## Atomic sidecar writes (transaction composition)

```ts
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

```ts
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

Spend by day (today: **seq-scan**, no `created_at` index):

```sql
select
  date_trunc('day', created_at) as day,
  sum(cost_micro_usd) as spend_micro_usd
from llm_calls
where cost_micro_usd is not null
group by 1
order by 1 desc;
```

Failures by call-site (today: **seq-scan**, `call_site_id` has no index):

```sql
select
  call_site_id,
  error_kind,
  count(*) as failures
from llm_calls
where status <> 'ok'
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
