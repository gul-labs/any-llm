import { sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { LlmError, redactSecrets } from '@gullabs/core'
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
  /**
   * A Drizzle Postgres database. It must have `transaction` (unless you pass
   * your own `transaction` helper): a record that carries a payload is written
   * in a transaction. A driver without transactions is refused at construction.
   */
  db: PostgresDb
  /**
   * Runs `fn` in a transaction and passes it the transaction handle. Give your
   * own helper when your database setup requires every transaction to go
   * through it (tenant or role context, statement timeouts, an instrumented
   * pool). When you pass one, every write goes through it (a record without a
   * payload too) and every statement runs on the handle `fn` receives,
   * including the savepoint around a payload.
   *
   * The helper must open a transaction of its own per call. It may hand `fn`
   * one shared handle (an ambient transaction): the sink then serializes its
   * writes on that handle, and a rollback of that transaction takes the ledger
   * rows with it.
   * @default a record without a payload is one INSERT on `db`; a record with a
   * payload runs in `db.transaction`
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
 * Serializes work per transaction handle. Statements of two writes that share
 * one handle (a host `transaction` helper that hands every call the same
 * ambient transaction) would interleave on its single connection, and a
 * `ROLLBACK TO SAVEPOINT` would undo the other write's rows. Keyed by handle, so
 * writes on separate handles never wait for each other.
 */
const handleQueues = new WeakMap<object, Promise<void>>()

async function serialized<T>(handle: object, work: () => Promise<T>): Promise<T> {
  const previous = handleQueues.get(handle) ?? Promise.resolve()
  let release: () => void = () => {}
  const turn = new Promise<void>((resolve) => {
    release = resolve
  })
  handleQueues.set(
    handle,
    previous.then(() => turn),
  )
  await previous
  try {
    return await work()
  } finally {
    release()
  }
}

/** Savepoint names are unique per write, so no two ever collide on one handle. */
let savepointSequence = 0

function badOptions(path: string, message: string): never {
  throw new LlmError(`drizzleUsageSink: ${path} ${message}`, {
    kind: 'bad_request',
    retryable: false,
    issues: [{ path, message }],
  })
}

/**
 * A {@link UsageSink} that writes each record to `llm_calls` and, when the
 * engine hands it a payload (`ClientConfig.payloads`, ADR-038), to
 * `llm_call_payloads`.
 *
 * A record without a payload is one `INSERT ... ON CONFLICT (attempt_id) DO
 * NOTHING` on `db` (idempotent on retry): no transaction, one round trip. A
 * record with a payload is written in one transaction:
 *
 * 1. insert the `llm_calls` row (`ON CONFLICT (attempt_id) DO NOTHING`);
 * 2. behind a uniquely named `SAVEPOINT`, insert the `llm_call_payloads` row
 *    keyed by the same `attempt_id`.
 *
 * A payload insert that fails is rolled back to the savepoint, logged as
 * `llm.call.payload.failed` (on the client's logger), and the transaction
 * commits: the ledger row survives a payload failure. A failing ledger insert
 * aborts the whole transaction, so no payload is left without its row, and
 * `record` rejects (the engine logs `llm.call.sink.failed`). The write is
 * bounded by the client's `sinkTimeoutMs`.
 *
 * A host `transaction` helper takes over every write (see
 * {@link DrizzleUsageSinkOptions.transaction}). When that helper joins an
 * ambient transaction, a rollback of that transaction takes the ledger rows
 * with it. A pooled connection holding an abandoned (timed-out) write stays in
 * its transaction until it finishes: set `idle_in_transaction_session_timeout`
 * and `statement_timeout` for the role that runs the sink.
 *
 * @throws LlmError `bad_request` when `db` has no `transaction` (and no
 *   `transaction` helper is given), so a driver without transactions fails at
 *   construction instead of on the first payload.
 */
export function drizzleUsageSink(options: DrizzleUsageSinkOptions): UsageSink {
  const given: unknown = options
  if (typeof given !== 'object' || given === null) {
    badOptions('options', 'must be an object ({ db, transaction? }).')
  }
  const { db } = options
  const dbValue: unknown = db
  if (
    typeof dbValue !== 'object' ||
    dbValue === null ||
    typeof (dbValue as { insert?: unknown }).insert !== 'function'
  ) {
    badOptions('db', 'must be a Drizzle Postgres database.')
  }
  if (
    options.transaction !== undefined &&
    typeof (options.transaction as unknown) !== 'function'
  ) {
    badOptions('transaction', 'must be a function.')
  }
  if (
    options.transaction === undefined &&
    typeof (db as { transaction?: unknown }).transaction !== 'function'
  ) {
    badOptions(
      'db',
      'has no transaction(). A record that carries a payload is written in a transaction, so ' +
        'use a driver with transactions (node-postgres, postgres-js, PGlite) or pass your own ' +
        '`transaction` helper.',
    )
  }
  const hostTransaction = options.transaction

  const insertLedger = async (handle: PostgresDb, row: Record<string, unknown>) => {
    // Pin the conflict target to the attemptId unique index so that deduplication
    // is explicit and does not rely on any driver-level heuristics.
    await handle
      .insert(llmCalls)
      .values(row as typeof llmCalls.$inferInsert)
      .onConflictDoNothing({ target: llmCalls.attemptId })
  }

  return {
    acceptsPayloads: true,
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

      if (payload === undefined) {
        // Ledger only: one INSERT, no transaction (a helper, if given, still runs it).
        if (hostTransaction === undefined) {
          await insertLedger(db, row)
          return
        }
        await hostTransaction((tx) => serialized(tx, () => insertLedger(tx, row)))
        return
      }

      const run =
        hostTransaction ?? (<T>(fn: (tx: PostgresDb) => Promise<T>) => db.transaction(fn))
      await run((tx) =>
        serialized(tx, async () => {
          await insertLedger(tx, row)
          const savepoint = `any_llm_payload_sp_${(savepointSequence += 1)}`
          await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`))
          try {
            await tx
              .insert(llmCallPayloads)
              .values({
                attemptId: r.attemptId,
                request: payload.request,
                response: payload.response,
                createdAt: new Date(r.createdAt),
              })
              .onConflictDoNothing({ target: llmCallPayloads.attemptId })
          } catch (payloadErr) {
            // Back to the savepoint: the transaction is usable again and the
            // ledger row commits. A failure here means the connection is gone;
            // it propagates and the transaction rolls back.
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`))
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`))
            ctx?.logger?.error(
              {
                callId: r.callId,
                attemptId: r.attemptId,
                error: payloadErrorText(payloadErr),
              },
              'llm.call.payload.failed',
            )
            return
          }
          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`))
        }),
      )
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
export async function assertLlmCallsSchema(db: SelectableDb): Promise<void> {
  try {
    await db.select().from(llmCalls).limit(0)
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
