import { getTableColumns, sql } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { LlmError, redactSecrets } from '@gullabs/core'
import type { LlmCallRecord, UsageSink, UsageSinkContext } from '@gullabs/core'
import { llmCallPayloads, llmCalls } from './schema.js'

/**
 * A Drizzle Postgres database or transaction handle (node-postgres, postgres-js,
 * PGlite, ...). A transaction handle is itself a `PgDatabase`, with a nested
 * `transaction` that the Postgres drivers run as `SAVEPOINT` / `RELEASE` (or
 * `ROLLBACK TO`). The sink accepts a transaction handle as `db`: it then runs
 * every write one at a time, each in a nested transaction of its own, so a
 * failing write undoes only itself and never aborts your transaction. You own
 * that transaction: its commit or rollback decides whether the sink's rows
 * survive.
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
   * including the nested transaction around a payload.
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
 * Longest slice of a database error the sink logs. A Drizzle query error
 * message carries the statement and every bound parameter (for a payload, or a
 * ledger row, customer text); the driver error under it does not.
 */
const ERROR_LOG_CHARS = 300

/** The driver error under a Drizzle query error, when there is one. */
function rootCause(error: unknown): unknown {
  return error instanceof Error && error.cause instanceof Error ? error.cause : error
}

/**
 * The driver message of a failed statement, without the statement and its
 * parameters: what Drizzle's query error wraps, or the error itself when the
 * driver threw it raw (Drizzle before 0.44 does). A query error with no driver
 * error under it is reduced to a fixed text, because its own message embeds the
 * parameters.
 */
function errorText(error: unknown): string {
  const root = rootCause(error)
  // A raw driver error (Drizzle before 0.44) has a clean message; Drizzle's own
  // `Failed query: <sql> params: <values>` message does not.
  if (
    root === error &&
    error instanceof Error &&
    error.message.startsWith('Failed query:')
  ) {
    return 'query failed'
  }
  return redactSecrets(root instanceof Error ? root.message : String(root)).slice(
    0,
    ERROR_LOG_CHARS,
  )
}

/** The SQLSTATE of a driver error (`pg`, postgres-js and PGlite all set `code`). */
function sqlState(error: unknown): string | undefined {
  const code = (rootCause(error) as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}

/** True for a Drizzle transaction handle (a `PgTransaction` has `rollback`). */
function isTransactionHandle(handle: unknown): boolean {
  return typeof (handle as { rollback?: unknown } | null)?.rollback === 'function'
}

/**
 * Serializes work per transaction handle. Statements of two writes that share
 * one handle (a transaction handle passed as `db`, or a host `transaction`
 * helper that hands every call the same ambient transaction) would interleave on
 * its single connection: Drizzle names a nested savepoint by nesting level, so
 * two overlapping nested transactions cross their `SAVEPOINT` / `RELEASE`
 * statements and abort the transaction, and a rollback to a savepoint would undo
 * the other write's rows. Keyed by handle, so writes on separate handles never
 * wait for each other.
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
 * 2. in a nested transaction (a `SAVEPOINT`), insert the `llm_call_payloads` row
 *    keyed by the same `attempt_id`.
 *
 * A payload insert that fails undoes only its nested transaction, is logged as
 * `llm.call.payload.failed` (on the client's logger), and the outer transaction
 * commits: the ledger row survives a payload failure, on every Drizzle Postgres
 * driver. A failing ledger insert aborts the whole transaction, so no payload is
 * left without its row, and `record` rejects (the engine logs
 * `llm.call.sink.failed`) with an error whose message is the database's own
 * (SQLSTATE and text), never the SQL or the bound parameters. The write is
 * bounded by the client's `sinkTimeoutMs`.
 *
 * When `db` is itself a transaction handle, or a host `transaction` helper
 * hands every call one ambient transaction, the sink runs its writes on that
 * handle one at a time, each in a nested transaction of its own: concurrent
 * records all succeed, and a failing write undoes only itself and never aborts
 * the host's transaction. The host owns that transaction: when it rolls back,
 * the ledger rows and payloads roll back with it, and the sink writes nothing
 * after it ends. A host `transaction` helper takes over every write (see
 * {@link DrizzleUsageSinkOptions.transaction}). A pooled connection holding an
 * abandoned (timed-out) write stays in its transaction until it finishes: set
 * `idle_in_transaction_session_timeout` and `statement_timeout` for the role
 * that runs the sink.
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
    try {
      // Pin the conflict target to the attemptId unique index so that deduplication
      // is explicit and does not rely on any driver-level heuristics.
      await handle
        .insert(llmCalls)
        .values(row as typeof llmCalls.$inferInsert)
        .onConflictDoNothing({ target: llmCalls.attemptId })
    } catch (error) {
      // Drizzle's query error carries the statement and every bound parameter
      // (reasoning text, tool arguments, metadata): the engine logs what we throw.
      // Rethrow the driver's message and SQLSTATE only, with no `cause` (the
      // Drizzle error, and the driver's `detail`, hold the row's values).
      const state = sqlState(error)
      const hint =
        state === '42703' || state === '42P01' || state === '23502'
          ? ' Check the table with assertLlmCallsSchema(db) and apply sql/upgrades/ (docs/ledger.md).'
          : ''
      throw new Error(
        `llm_calls insert failed for attempt ${String(row['attemptId'])}: ${errorText(error)}${
          state !== undefined ? ` (SQLSTATE ${state})` : ''
        }.${hint}`,
      )
    }
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

      // Ledger insert, then (when there is a payload) the payload insert in a
      // nested transaction. `tx` is a transaction: the ledger insert aborts it,
      // a payload failure undoes only its savepoint.
      const write = async (tx: PostgresDb): Promise<void> => {
        await insertLedger(tx, row)
        if (payload === undefined) return
        try {
          await tx.transaction(async (nested) => {
            await nested
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
          // The nested transaction is rolled back: `tx` is usable and the ledger
          // row commits. A failure of the rollback itself means the connection is
          // gone; the next statement (or the commit) then fails and propagates.
          ctx?.logger?.error(
            {
              callId: r.callId,
              attemptId: r.attemptId,
              error: errorText(payloadErr),
            },
            'llm.call.payload.failed',
          )
        }
      }

      // A handle that is already a transaction (the host's, ambient or passed as
      // `db`) is shared with other writes and with the host's own statements: run
      // this write in a nested transaction of its own, one at a time.
      const isolated = (handle: PostgresDb): Promise<void> =>
        isTransactionHandle(handle) ? handle.transaction(write) : write(handle)

      if (hostTransaction !== undefined) {
        await hostTransaction((tx) => serialized(tx, () => isolated(tx)))
        return
      }
      if (isTransactionHandle(db)) {
        await serialized(db, () => isolated(db))
        return
      }
      if (payload === undefined) {
        // Ledger only: one INSERT, no transaction.
        await insertLedger(db, row)
        return
      }
      await db.transaction(write)
    },
  }
}

/** Rows of a statement result, whichever shape the driver returns. */
export function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>
  return ((result as { rows?: unknown }).rows ?? []) as Array<Record<string, unknown>>
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Columns of the `llm_calls` table that would make the sink's INSERT fail:
 *
 * - a column of this schema that the schema allows to be NULL and the table
 *   makes NOT NULL, whatever its database default: the sink writes it as NULL on
 *   some rows (`raw_usage` on an error or refusal row), and an explicit NULL
 *   does not take the default; and
 * - a column that is not in this schema at all (the sink writes nothing to it)
 *   and is NOT NULL with no default (and not identity or generated).
 *
 * A column the schema marks NOT NULL is always written with a value, so it can
 * be NOT NULL in the table with any default.
 */
async function insertBlockers(db: PostgresDb): Promise<string[]> {
  const known = new Map(
    Object.values(getTableColumns(llmCalls)).map((c) => [c.name, c.notNull] as const),
  )
  const result = await db.execute(sql`
    SELECT a.attname::text AS name,
           (a.atthasdef OR a.attidentity <> '' OR a.attgenerated <> '') AS filled
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = to_regclass('llm_calls')
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND a.attnotnull
     ORDER BY a.attnum`)
  const blockers: string[] = []
  for (const row of resultRows(result)) {
    const name = String(row['name'])
    const schemaNotNull = known.get(name)
    if (schemaNotNull === undefined) {
      // Not written by the sink: only a default (or identity) lets an INSERT succeed.
      if (row['filled'] !== true) blockers.push(name)
    } else if (!schemaNotNull) {
      blockers.push(name)
    }
  }
  return blockers
}

/**
 * Checks that the `llm_calls` table can take every row this version of the sink
 * writes, without writing anything:
 *
 * 1. it selects every column the Drizzle schema names with `LIMIT 0` (a missing
 *    column or table fails); and
 * 2. it reads the catalog for columns that would make the INSERT fail: a NOT NULL
 *    column without a default that the sink does not write, or a NOT NULL column,
 *    default or not, that the schema allows to be NULL and the sink writes as NULL
 *    on some rows (a table created by `@gullabs/drizzle` 0.1.1 to 0.4.0 has
 *    `raw_usage NOT NULL`, which rejects every error row; a default does not
 *    help, since the sink writes NULL explicitly). The error names the
 *    column and the one-line fix; there is no upgrade script for such old shapes.
 *
 * Why it exists: the sink writes every column on every row, so a table that
 * missed an upgrade (`sql/upgrades/`) makes every insert fail, successes
 * included. The engine swallows sink failures by design (ADR-002), so those
 * rows would otherwise vanish quietly; each failure is logged at `error` with
 * the event `llm.call.sink.failed`. This function is the explicit, opt-in way
 * to find out before that happens. It needs no running client, so call it
 * wherever it fits: a deploy or CI step, a readiness endpoint, or once at
 * boot. The first failure rejects with an `Error` whose `cause` is the driver
 * error.
 *
 * @throws Error when the select fails (a missing column, a missing table, or an
 *   unreachable database; the message points at `sql/upgrades/`), or when the
 *   table has a column that blocks the INSERT.
 */
export async function assertLlmCallsSchema(db: PostgresDb): Promise<void> {
  try {
    await db.select().from(llmCalls).limit(0)
  } catch (cause) {
    throw new Error(
      'llm_calls could not be read with every column @gullabs/drizzle writes. ' +
        'The table may be missing columns from a release you have not migrated to: apply every ' +
        'script in @gullabs/drizzle/sql/upgrades/ in order (or sql/install.sql on a fresh database) ' +
        'before deploying this version; 0003-validate-checks.sql is optional and can fail on ' +
        'legacy rows, so skip it or clean the rows first. ' +
        `Driver error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
  let blockers: string[]
  try {
    blockers = await insertBlockers(db)
  } catch (cause) {
    throw new Error(
      `llm_calls could not be inspected in the catalog. Driver error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
  if (blockers.length > 0) {
    const fixes = blockers
      .map(
        (name) => `ALTER TABLE llm_calls ALTER COLUMN ${quoteIdent(name)} DROP NOT NULL`,
      )
      .join('; ')
    throw new Error(
      `llm_calls has NOT NULL columns that @gullabs/drizzle does not write and that have no ` +
        `default, or that it writes as NULL on some rows (a default does not apply to an ` +
        `explicit NULL): ${blockers.map(quoteIdent).join(', ')}. Every insert (or every ` +
        `error row) would fail. Fix: ${fixes}.`,
    )
  }
}
