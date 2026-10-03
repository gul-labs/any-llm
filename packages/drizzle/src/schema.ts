import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import type { LlmCallRecord, LlmErrorKind } from '@gullabs/core'

/**
 * The closed `status` and `error_kind` vocabularies the table CHECKs admit.
 * Both are exhaustive over the core unions (the `Missing*` types below fail to
 * compile when core adds a member), so a new value is a core change that
 * ships with SQL. `error_reason` is deliberately not constrained.
 */
const STATUS_VALUES = [
  'ok',
  'api_error',
  'timeout',
  'aborted',
  'content_filter',
] as const satisfies readonly LlmCallRecord['status'][]

const ERROR_KIND_VALUES = [
  'invalid_auth',
  'rate_limited',
  'server',
  'timeout',
  'aborted',
  'bad_request',
  'content_filter',
  'unknown',
] as const satisfies readonly LlmErrorKind[]

type MissingStatus = Exclude<LlmCallRecord['status'], (typeof STATUS_VALUES)[number]>
type MissingErrorKind = Exclude<LlmErrorKind, (typeof ERROR_KIND_VALUES)[number]>
const _exhaustive: [MissingStatus, MissingErrorKind] extends [never, never]
  ? true
  : never = true
void _exhaustive

function sqlList(values: readonly string[]) {
  return sql.raw(values.map((v) => `'${v}'`).join(', '))
}

/**
 * `llm_calls` — the append-only ledger table for `@gullabs/core`'s
 * `LlmCallRecord`. One row per attempt (including `attemptNumber: 0`
 * pre-attempt refusals, ADR-025) and one synthetic-or-real row per
 * `callId ⇒ ledger row` invariant (§0.4).
 *
 * JSONB-lane nullability invariants (verified against every engine record
 * path — success, per-attempt error, and the ADR-025 `attemptNumber: 0`
 * synthetic pre-attempt record — in `packages/core/src/engine.ts` and
 * `packages/core/src/record.ts`):
 *
 * - `token_details` — ALWAYS populated (`{}` at minimum via `EMPTY_USAGE.details`).
 *   Never null on any code path; `.notNull()` is correct.
 * - `raw_usage` — NULLABLE. `EMPTY_USAGE.raw = null` on the error and
 *   never-dispatched paths (no provider usage payload exists to persist —
 *   persisting `{}` would fabricate a payload the provider never returned).
 *   `.notNull()` was a defect: it rejected every error/refusal row at the
 *   sink boundary, which — combined with sinks being fail-open (ADR-002) —
 *   made those rows silently vanish instead of erroring loudly. Fixed here.
 * - `generation_config` — ALWAYS populated (`resolvedConfig`, computed
 *   before dispatch is attempted). Never null on any code path;
 *   `.notNull()` is correct.
 * - `metadata` — ALWAYS populated (`metadata ?? {}`, host-supplied or
 *   defaulted). Never null on any code path; `.notNull()` is correct.
 *
 * To create or upgrade the table, use the SQL in `sql/` (`install.sql`,
 * `upgrades/NNNN-*.sql`); it is the source of truth for existing databases.
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    recordSchemaVersion: integer('record_schema_version').notNull(),
    callId: text('call_id').notNull(),
    attemptId: text('attempt_id').primaryKey(),
    callSiteId: text('call_site_id'),
    externalId: text('external_id'),
    authKeyId: text('auth_key_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    modelVersion: text('model_version'),
    responseId: text('response_id'),
    serviceTier: text('service_tier'),
    servedServiceTier: text('served_service_tier'),
    status: text('status').notNull(),
    finishReason: text('finish_reason'),
    outputParsed: boolean('output_parsed'),
    latencyMs: integer('latency_ms'),
    queueDelayMs: integer('queue_delay_ms'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cachedInputTokens: integer('cached_input_tokens'),
    thinkingTokens: integer('thinking_tokens'),
    totalTokens: integer('total_tokens'),
    costMicroUsd: integer('cost_micro_usd'),
    pricingVersion: text('pricing_version'),
    // Cost v2 (ADR-039). NULL on rows written before record version 2, on
    // refusal rows and when the provider had no pricing source.
    costConfidence: text('cost_confidence'),
    // `{ input, cached, output, tools }` in micro-USD; NULL when unpriced.
    costDetails: jsonb('cost_details'),
    // Why `cost_micro_usd` is NULL (unknown model or tier, missing tool counter).
    costUnpricedReason: text('cost_unpriced_reason'),
    tokenDetails: jsonb('token_details').notNull(),
    // Nullable: null means no provider usage payload existed for this row
    // (error, timeout, aborted, content_filter, or an ADR-025 attemptNumber:0
    // pre-attempt refusal — none of these ever reached a provider response to
    // report usage from). See the table-level doc comment above for the full
    // per-lane invariant audit.
    rawUsage: jsonb('raw_usage'),
    providerMetadata: jsonb('provider_metadata'),
    citations: jsonb('citations'),
    toolCalls: jsonb('tool_calls'),
    toolNames: jsonb('tool_names'),
    toolCount: integer('tool_count'),
    warnings: jsonb('warnings'),
    generationConfig: jsonb('generation_config').notNull(),
    reasoningText: text('reasoning_text'),
    errorKind: text('error_kind'),
    // Typed `LlmError.reason`. Text with NO CHECK constraint: the vocabulary is
    // a closed TypeScript union that grows in core releases, and a new member
    // must never need SQL.
    errorReason: text('error_reason'),
    errorMessage: text('error_message'),
    attemptNumber: integer('attempt_number').notNull(),
    metadata: jsonb('metadata').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('llm_calls_call_id_idx').on(table.callId),
    index('llm_calls_external_id_idx').on(table.externalId),
    index('llm_calls_created_at_idx').on(table.createdAt),
    index('llm_calls_call_site_created_at_idx').on(table.callSiteId, table.createdAt),
    check('llm_calls_status_check', sql`${table.status} IN (${sqlList(STATUS_VALUES)})`),
    check(
      'llm_calls_error_kind_check',
      sql`${table.errorKind} IN (${sqlList(ERROR_KIND_VALUES)})`,
    ),
  ],
)
