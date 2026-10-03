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
