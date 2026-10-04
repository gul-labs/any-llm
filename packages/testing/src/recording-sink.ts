/**
 * RecordingSink — an in-memory UsageSink for use in tests.
 *
 * @module
 */

import type {
  UsageSink,
  UsageSinkContext,
  LlmCallPayload,
  LlmCallRecord,
} from '@gullabs/core'

/**
 * Options for {@link RecordingSink}.
 */
export interface RecordingSinkOptions {
  /**
   * When set, `record()` will throw instead of storing the record.
   *
   * - `true` — throws a generic `Error`.
   * - An `Error` instance — throws that exact error.
   *
   * Use this to verify the engine's fail-open behaviour (a broken sink must
   * never fail the LLM call).
   */
  failOnRecord?: boolean | Error
  /**
   * `'attemptId'` makes `record()` idempotent on `attemptId`, as the Drizzle
   * ledger is (`onConflictDoNothing`): a record whose `attemptId` was already
   * stored is dropped and counted in {@link RecordingSink.duplicates}. The payload
   * is de-duplicated on its own, as the ledger's payload table is: a repeat's
   * payload is kept when no payload is held for that `attemptId` yet (the record
   * before it came without one) and ignored when one is. Without
   * it every record is kept, so a test cannot see a double write the real
   * ledger would absorb, or tell a retry that reuses an id from one that does
   * not.
   */
  dedupeOn?: 'attemptId'
}

/**
 * An in-memory {@link UsageSink} that accumulates every record it receives.
 *
 * ```ts
 * const sink = new RecordingSink()
 * // … run the engine …
 * expect(sink.records).toHaveLength(1)
 * expect(sink.last()?.status).toBe('ok')
 * ```
 */
export class RecordingSink implements UsageSink {
  /** A `RecordingSink` keeps the payloads it is handed (see {@link RecordingSink.payloads}). */
  readonly acceptsPayloads = true

  /** Every record received by this sink, in insertion order. */
  readonly records: LlmCallRecord[] = []

  /**
   * Records dropped because `dedupeOn: 'attemptId'` already held that
   * `attemptId`. Always empty without `dedupeOn`.
   */
  readonly duplicates: LlmCallRecord[] = []

  /**
   * The payload that came with each stored record, keyed by `attemptId`. An
   * attempt that was handed no payload (storage off, `include` said no, the
   * call opted out) has no entry. With `dedupeOn`, the first payload for an
   * `attemptId` wins.
   */
  readonly payloads = new Map<string, LlmCallPayload>()

  private readonly _failOnRecord: boolean | Error
  private readonly _dedupeOn: 'attemptId' | undefined
  private readonly _seen = new Set<string>()

  constructor(opts: RecordingSinkOptions = {}) {
    this._failOnRecord = opts.failOnRecord ?? false
    this._dedupeOn = opts.dedupeOn
  }

  record(r: LlmCallRecord, ctx?: UsageSinkContext): Promise<void> {
    if (this._failOnRecord !== false) {
      if (this._failOnRecord instanceof Error) {
        return Promise.reject(this._failOnRecord)
      }
      return Promise.reject(new Error('RecordingSink: configured to fail on record'))
    }
    if (this._dedupeOn === 'attemptId') {
      if (this._seen.has(r.attemptId)) {
        this.duplicates.push(r)
        // The ledger's payload row has its own conflict rule: the first payload wins.
        if (ctx?.payload !== undefined && !this.payloads.has(r.attemptId)) {
          this.payloads.set(r.attemptId, ctx.payload)
        }
        return Promise.resolve()
      }
      this._seen.add(r.attemptId)
    }
    this.records.push(r)
    if (ctx?.payload !== undefined) this.payloads.set(r.attemptId, ctx.payload)
    return Promise.resolve()
  }

  /**
   * Returns the most recently recorded `LlmCallRecord`, or `undefined` if
   * nothing has been recorded yet.
   */
  last(): LlmCallRecord | undefined {
    return this.records[this.records.length - 1]
  }
}
