import type { LlmCallRecord, UsageSink } from '@gullabs/core'
import { llmCalls } from './schema.js'

/**
 * Minimal structural interface for a Drizzle (or Drizzle-compatible) database
 * client that `drizzleUsageSink` depends on.
 *
 * The `onConflictDoNothing` call is pinned to a `{ target }` argument so that
 * the dedupe is always anchored to the `attemptId` unique index rather than
 * relying on a full-table inferred default.
 *
 * Using `unknown` for `target` keeps this interface mockable without importing
 * drizzle-orm column types.
 */
export interface InsertableDb {
  insert(table: unknown): {
    values(v: Record<string, unknown>): {
      onConflictDoNothing(opts: { target: unknown }): Promise<unknown>
    }
  }
}

export function drizzleUsageSink(db: InsertableDb, table = llmCalls): UsageSink {
  return {
    async record(r: LlmCallRecord): Promise<void> {
      const row: Record<string, unknown> = {
        recordSchemaVersion: r.recordSchemaVersion,
        callId: r.callId,
        attemptId: r.attemptId,
        callSiteId: r.callSiteId,
        externalId: r.externalId,
        authKeyId: r.authKeyId,
        provider: r.provider,
        model: r.model,
        modelVersion: r.modelVersion,
        responseId: r.responseId,
        serviceTier: r.serviceTier,
        servedServiceTier: r.servedServiceTier,
        status: r.status,
        finishReason: r.finishReason,
        outputParsed: r.outputParsed,
        latencyMs: r.latencyMs,
        queueDelayMs: r.queueDelayMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cachedInputTokens: r.cachedInputTokens,
        thinkingTokens: r.thinkingTokens,
        totalTokens: r.totalTokens,
        costMicroUsd: r.costMicroUsd,
        pricingVersion: r.pricingVersion,
        tokenDetails: r.tokenDetails,
        rawUsage: r.rawUsage,
        providerMetadata: r.providerMetadata,
        citations: r.citations,
        toolCalls: r.toolCalls,
        toolNames: r.toolNames,
        toolCount: r.toolCount,
        warnings: r.warnings,
        generationConfig: r.generationConfig,
        reasoningText: r.reasoningText,
        errorKind: r.errorKind,
        errorReason: r.errorReason,
        errorMessage: r.errorMessage,
        attemptNumber: r.attemptNumber,
        metadata: r.metadata,
        createdAt: new Date(r.createdAt),
      }

      // Pin the conflict target to the attemptId unique index so that deduplication
      // is explicit and does not rely on any driver-level heuristics.
      await db.insert(table).values(row).onConflictDoNothing({ target: table.attemptId })
    },
  }
}

/**
 * Minimal structural interface for the `db` argument of {@link assertLlmCallsSchema}.
 */
export interface SelectableDb {
  select(): {
    from(table: unknown): {
      limit(n: number): PromiseLike<unknown>
    }
  }
}

/**
 * Checks that the `llm_calls` table has every column this version of the sink
 * writes, without writing anything: it selects every column the Drizzle schema
 * names with `LIMIT 0`.
 *
 * Why it exists: the sink writes every column on every row, so a table that
 * missed an upgrade (`sql/upgrades/`) makes every insert fail, successes
 * included. The engine swallows sink failures by design (ADR-002), so those
 * rows would otherwise vanish quietly; each failure is logged at `error` with
 * the event `llm.call.sink.failed`. This function is the explicit, opt-in way
 * to find out before that happens. It needs no running client, so call it
 * wherever it fits: a deploy or CI step, a readiness endpoint, or once at
 * boot. It rejects with an `Error` whose `cause` is the driver error.
 *
 * @throws Error when the select fails (a missing column, a missing table, or an
 *   unreachable database); the message points at `sql/upgrades/`.
 */
export async function assertLlmCallsSchema(
  db: SelectableDb,
  table = llmCalls,
): Promise<void> {
  try {
    await db.select().from(table).limit(0)
  } catch (cause) {
    throw new Error(
      'llm_calls could not be read with every column @gullabs/drizzle writes. ' +
        'The table may be missing columns from a release you have not migrated to: apply every ' +
        'script in @gullabs/drizzle/sql/upgrades/ in order (or sql/install.sql on a fresh database) ' +
        `before deploying this version. Driver error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}
