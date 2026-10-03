import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { redactSecrets } from '@gullabs/core'
import type { LlmCallRecord, UsageSink, UsageSinkContext } from '@gullabs/core'
import { llmCallPayloads, llmCalls } from './schema.js'

/**
 * A Drizzle Postgres database or transaction handle (node-postgres, postgres-js,
 * PGlite, ...). A transaction handle is itself a `PgDatabase`, with a nested
 * `transaction` that the Postgres drivers run as `SAVEPOINT` / `ROLLBACK TO
 * SAVEPOINT`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the sink touches only insert/delete/transaction, never a schema or a driver result
export type PostgresDb = PgDatabase<PgQueryResultHKT, any, any>

/** Options for {@link drizzleUsageSink}. */
export interface DrizzleUsageSinkOptions {
  /** A Drizzle Postgres database. It must have `transaction`. */
  db: PostgresDb
  /**
   * Runs `fn` in a transaction and passes it the transaction handle. Give your
   * own helper when your database setup requires every transaction to go
   * through it (tenant or role context, statement timeouts, an instrumented
   * pool). Every statement the sink writes runs on the handle `fn` receives,
   * including the nested `tx.transaction` savepoint for a payload.
   * @default (fn) => db.transaction(fn)
   */
  transaction?: <T>(fn: (tx: PostgresDb) => Promise<T>) => Promise<T>
}

/**
 * Longest slice of a payload-insert error the sink logs. A Drizzle query error
 * message carries the statement and its parameters, which for a payload are
 * customer text; the driver error under it does not.
 */
const PAYLOAD_ERROR_LOG_CHARS = 300

function payloadErrorText(error: unknown): string {
  const root =
    error instanceof Error && error.cause instanceof Error ? error.cause : error
  return redactSecrets(root instanceof Error ? root.message : String(root)).slice(
    0,
    PAYLOAD_ERROR_LOG_CHARS,
  )
}

/**
 * A {@link UsageSink} that writes each record to `llm_calls` and, when the
 * engine hands it a payload (`ClientConfig.payloads`, ADR-038), to
 * `llm_call_payloads`, in one transaction:
 *
 * 1. insert the `llm_calls` row (`ON CONFLICT (attempt_id) DO NOTHING`, so a
 *    retried write is idempotent);
 * 2. in a nested transaction (a `SAVEPOINT`), insert the `llm_call_payloads`
 *    row keyed by the same `attempt_id`.
 *
 * A payload insert that fails is rolled back to the savepoint, logged as
 * `llm.call.payload.failed` (on the client's logger), and the transaction
 * commits: the ledger row always survives a payload failure. A failing ledger
 * insert aborts the whole transaction, so no payload is left without its row,
 * and `record` rejects (the engine logs `llm.call.sink.failed`). The write is
 * bounded by the client's `sinkTimeoutMs`.
 *
 * The write always runs through `transaction` (default `db.transaction`), also
 * when there is no payload.
 */
export function drizzleUsageSink(options: DrizzleUsageSinkOptions): UsageSink {
  const { db } = options
  const transaction =
    options.transaction ?? (<T>(fn: (tx: PostgresDb) => Promise<T>) => db.transaction(fn))
  return {
    async record(r: LlmCallRecord, ctx?: UsageSinkContext): Promise<void> {
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
        costConfidence: r.costConfidence,
        costDetails: r.costDetails,
        costUnpricedReason: r.costUnpricedReason,
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

      const payload = ctx?.payload
      await transaction(async (tx) => {
        // Pin the conflict target to the attemptId unique index so that deduplication
        // is explicit and does not rely on any driver-level heuristics.
        await tx
          .insert(llmCalls)
          .values(row as typeof llmCalls.$inferInsert)
          .onConflictDoNothing({ target: llmCalls.attemptId })
        if (payload === undefined) return
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint
              .insert(llmCallPayloads)
              .values({
                attemptId: r.attemptId,
                request: payload.request,
                response: payload.response,
                createdAt: new Date(r.createdAt),
              })
              .onConflictDoNothing({ target: llmCallPayloads.attemptId })
          })
        } catch (payloadErr) {
          // The nested transaction rolled back to its savepoint before throwing,
          // so the transaction is still usable and the ledger row commits.
          ctx?.logger?.error(
            {
              callId: r.callId,
              attemptId: r.attemptId,
              error: payloadErrorText(payloadErr),
            },
            'llm.call.payload.failed',
          )
        }
      })
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
