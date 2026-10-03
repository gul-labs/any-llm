import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

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
 * Consumers upgrading from a version where `raw_usage` was `NOT NULL` must
 * run: `ALTER TABLE llm_calls ALTER COLUMN raw_usage DROP NOT NULL;`
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
  ],
)
