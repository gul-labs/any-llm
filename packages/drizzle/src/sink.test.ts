import { describe, expect, it } from 'vitest'
import { drizzleUsageSink, llmCallPayloads, llmCalls, type PostgresDb } from './index.js'
import type { JsonValue, LlmCallPayload, LlmCallRecord, Logger } from '@gullabs/core'

type InsertCall = {
  /** Which handle ran the insert: the database itself or a transaction handle. */
  handle: 'db' | 'tx'
  table: unknown
  values: Record<string, unknown>
  conflictTarget: unknown
  conflictIgnored: boolean
}

function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    recordSchemaVersion: 2,
    callId: 'call_1',
    attemptId: 'attempt_1',
    attemptNumber: 1,
    callSiteId: 'site_1',
    provider: 'google',
    model: 'gemini-2.5-pro',
    modelVersion: 'gemini-2.5-pro-001',
    responseId: 'resp_123',
    serviceTier: 'flex',
    status: 'ok',
    finishReason: 'stop',
    latencyMs: 321,
    queueDelayMs: 45,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 10,
    thinkingTokens: 4,
    totalTokens: 120,
    costMicroUsd: 456,
    pricingVersion: 'gemini-2026-06-27',
    tokenDetails: { input: 100, output: 20 } satisfies JsonValue,
    rawUsage: { promptTokenCount: 100 } satisfies JsonValue,
    providerMetadata: { safetyRatings: [] } satisfies JsonValue,
    warnings: [{ type: 'other', message: 'warn' }] satisfies JsonValue,
    generationConfig: { temperature: 0.2 } satisfies JsonValue,
    reasoningText: 'thought summary',
    errorKind: 'server',
    errorMessage: 'boom',
    metadata: { tenantId: 'tenant_1' } satisfies JsonValue,
    createdAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  }
}

interface MockOptions {
  /** Throw from the insert into this table (by object identity). */
  failInsertInto?: unknown
  /** The error that insert throws (default: a Drizzle-shaped error over a driver error). */
  failWith?: Error
  /** What happened, in order: begin, commit, rollback and the nested transactions. */
  log?: string[]
  /** Await this long inside every insert, so concurrent writes can interleave. */
  insertDelayMs?: number
  /** The highest number of nested transactions open at once on one handle. */
  stats?: { maxOpenNested: number }
}

/**
 * A structural stand-in for a Drizzle Postgres database. `db.insert` is the
 * direct (no transaction) path; `db.transaction` hands the callback a transaction
 * handle (it has `rollback`, like Drizzle's `PgTransaction`) whose inserts are
 * recorded as `tx` and whose own `transaction` is a nested transaction
 * (`savepoint` / `release`, or `rollback to savepoint` when the callback throws).
 */
function makeDb(spy: InsertCall[], options: MockOptions = {}): PostgresDb {
  const log = options.log ?? []
  const stats = options.stats ?? { maxOpenNested: 0 }
  let openNested = 0
  const handle = (kind: 'db' | 'tx') => ({
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            async onConflictDoNothing({ target }: { target: unknown }) {
              if (options.insertDelayMs !== undefined) {
                await new Promise((resolve) => setTimeout(resolve, options.insertDelayMs))
              }
              if (table === options.failInsertInto) {
                throw (
                  options.failWith ??
                  new Error('insert failed', { cause: new Error('driver: boom') })
                )
              }
              spy.push({
                handle: kind,
                table,
                values,
                conflictTarget: target,
                conflictIgnored: true,
              })
              return undefined
            },
          }
        },
      }
    },
    ...(kind === 'tx'
      ? {
          rollback() {
            throw new Error('rollback')
          },
          async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
            log.push('savepoint')
            openNested += 1
            stats.maxOpenNested = Math.max(stats.maxOpenNested, openNested)
            try {
              const result = await fn(handle('tx'))
              log.push('release')
              return result
            } catch (error) {
              log.push('rollback to savepoint')
              throw error
            } finally {
              openNested -= 1
            }
          },
        }
      : {}),
  })
  return {
    ...handle('db'),
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      log.push('begin')
      try {
        const result = await fn(handle('tx'))
        log.push('commit')
        return result
      } catch (error) {
        log.push('rollback')
        throw error
      }
    },
  } as unknown as PostgresDb
}

describe('drizzleUsageSink', () => {
  it('writes the cost v2 fields (ADR-039) to their columns', async () => {
    const calls: InsertCall[] = []
    await drizzleUsageSink({ db: makeDb(calls) }).record(
      makeRecord({
        costConfidence: 'estimated',
        costDetails: { input: 300, cached: 40, output: 100, tools: 16 },
        costUnpricedReason: 'why',
      }),
    )
    expect(calls[0]?.values).toMatchObject({
      recordSchemaVersion: 2,
      costConfidence: 'estimated',
      costDetails: { input: 300, cached: 40, output: 100, tools: 16 },
      costUnpricedReason: 'why',
    })
  })

  it('maps every record field and dedupes retries with onConflictDoNothing', async () => {
    const calls: InsertCall[] = []
    const db = makeDb(calls)
    const sink = drizzleUsageSink({ db })
    const record = makeRecord({ authKeyId: 'gemini-paid' })

    await sink.record(record)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.table).toBe(llmCalls)
    expect(calls[0]?.conflictIgnored).toBe(true)
    // Conflict target must be pinned to the attemptId column (unique index).
    expect(calls[0]?.conflictTarget).toBe(llmCalls.attemptId)
    expect(calls[0]?.values).toEqual({
      recordSchemaVersion: 2,
      callId: 'call_1',
      attemptId: 'attempt_1',
      callSiteId: 'site_1',
      authKeyId: 'gemini-paid',
      provider: 'google',
      model: 'gemini-2.5-pro',
      modelVersion: 'gemini-2.5-pro-001',
      responseId: 'resp_123',
      serviceTier: 'flex',
      status: 'ok',
      finishReason: 'stop',
      latencyMs: 321,
      queueDelayMs: 45,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 10,
      thinkingTokens: 4,
      totalTokens: 120,
      costMicroUsd: 456,
      pricingVersion: 'gemini-2026-06-27',
      tokenDetails: { input: 100, output: 20 },
      rawUsage: { promptTokenCount: 100 },
      providerMetadata: { safetyRatings: [] },
      citations: undefined,
      toolCalls: undefined,
      toolNames: undefined,
      toolCount: undefined,
      warnings: [{ type: 'other', message: 'warn' }],
      generationConfig: { temperature: 0.2 },
      reasoningText: 'thought summary',
      errorKind: 'server',
      errorMessage: 'boom',
      attemptNumber: 1,
      metadata: { tenantId: 'tenant_1' },
      createdAt: new Date('2026-06-27T00:00:00.000Z'),
    })
  })

  it('persists api_error postmortem fields', async () => {
    const calls: InsertCall[] = []
    const db = makeDb(calls)
    const sink = drizzleUsageSink({ db })

    await sink.record(
      makeRecord({
        status: 'api_error',
        errorKind: 'invalid_auth',
        errorMessage: 'upstream 503',
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.values).toMatchObject({
      status: 'api_error',
      errorKind: 'invalid_auth',
      errorMessage: 'upstream 503',
    })
  })

  it('maps errorReason through to the insert values', async () => {
    const calls: InsertCall[] = []
    const sink = drizzleUsageSink({ db: makeDb(calls) })

    await sink.record(
      makeRecord({
        status: 'api_error',
        errorKind: 'rate_limited',
        errorReason: 'daily_quota',
      }),
    )

    expect(calls[0]?.values).toMatchObject({
      errorKind: 'rate_limited',
      errorReason: 'daily_quota',
    })
  })

  it('maps rawUsage null through to the insert values (EMPTY_USAGE sentinel, error path)', async () => {
    const calls: InsertCall[] = []
    const db = makeDb(calls)
    const sink = drizzleUsageSink({ db })

    await sink.record(
      makeRecord({
        status: 'api_error',
        errorKind: 'server',
        errorMessage: 'upstream 503',
        tokenDetails: {} satisfies JsonValue,
        rawUsage: null,
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.values['rawUsage']).toBeNull()
    expect(calls[0]?.values['tokenDetails']).toEqual({})
  })

  it('maps rawUsage null for an ADR-025 attemptNumber:0 pre-attempt refusal record', async () => {
    const calls: InsertCall[] = []
    const db = makeDb(calls)
    const sink = drizzleUsageSink({ db })

    await sink.record(
      makeRecord({
        attemptNumber: 0,
        status: 'api_error',
        errorKind: 'bad_request',
        errorMessage: 'inputContract is required when requireInputContract is enabled.',
        tokenDetails: {} satisfies JsonValue,
        rawUsage: null,
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.values['attemptNumber']).toBe(0)
    expect(calls[0]?.values['rawUsage']).toBeNull()
  })

  it('writes authKeyId as undefined (no column value) when absent from the record', async () => {
    const calls: InsertCall[] = []
    const db = makeDb(calls)
    const sink = drizzleUsageSink({ db })
    // makeRecord()'s defaults omit authKeyId — mirrors buildRecord's
    // conditional-spread convention (absent, not present-as-undefined).
    const record = makeRecord()

    await sink.record(record)

    expect(calls[0]?.values['authKeyId']).toBeUndefined()
  })
})

const PAYLOAD: LlmCallPayload = {
  request: {
    system: 'be brief',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
  },
  response: { text: 'hi' },
}

function recordingLogger(): { logger: Logger; errors: Array<[unknown, string]> } {
  const errors: Array<[unknown, string]> = []
  return {
    errors,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error: (fields, message) => void errors.push([fields, message]),
    },
  }
}

describe('drizzleUsageSink payloads (ADR-038)', () => {
  it('writes the ledger row on the transaction, then the payload in a nested transaction', async () => {
    const calls: InsertCall[] = []
    const log: string[] = []
    await drizzleUsageSink({ db: makeDb(calls, { log }) }).record(makeRecord(), {
      payload: PAYLOAD,
    })
    expect(log).toEqual(['begin', 'savepoint', 'release', 'commit'])
    expect(calls.map((c) => [c.handle, c.table])).toEqual([
      ['tx', llmCalls],
      ['tx', llmCallPayloads],
    ])
    expect(calls[1]?.conflictTarget).toBe(llmCallPayloads.attemptId)
    expect(calls[1]?.values).toEqual({
      attemptId: 'attempt_1',
      request: PAYLOAD.request,
      response: PAYLOAD.response,
      createdAt: new Date('2026-06-27T00:00:00.000Z'),
    })
  })

  it('a record with no payload is one INSERT on db: no transaction, no nested transaction', async () => {
    const calls: InsertCall[] = []
    const log: string[] = []
    await drizzleUsageSink({ db: makeDb(calls, { log }) }).record(makeRecord())
    expect(log).toEqual([])
    expect(calls.map((c) => [c.handle, c.table])).toEqual([['db', llmCalls]])
  })

  it('the host transaction helper takes over every write, a record without a payload too', async () => {
    const dbCalls: InsertCall[] = []
    const dbLog: string[] = []
    const hostCalls: InsertCall[] = []
    const hostLog: string[] = []
    const hostDb = makeDb(hostCalls, { log: hostLog })
    const sink = drizzleUsageSink({
      db: makeDb(dbCalls, { log: dbLog }),
      transaction: (fn) => hostDb.transaction(fn),
    })
    await sink.record(makeRecord(), { payload: PAYLOAD })
    await sink.record(makeRecord({ attemptId: 'attempt_2' }))
    expect(dbLog).toEqual([])
    expect(dbCalls).toEqual([])
    expect(hostLog.filter((l) => l === 'begin' || l === 'commit')).toEqual([
      'begin',
      'commit',
      'begin',
      'commit',
    ])
    expect(hostCalls.map((c) => [c.handle, c.table])).toEqual([
      ['tx', llmCalls],
      ['tx', llmCallPayloads],
      ['tx', llmCalls],
    ])
  })

  it('a failing payload insert rolls back its nested transaction, is logged as llm.call.payload.failed with the driver error, and record() resolves', async () => {
    const calls: InsertCall[] = []
    const { logger, errors } = recordingLogger()
    const log: string[] = []
    await expect(
      drizzleUsageSink({
        db: makeDb(calls, { failInsertInto: llmCallPayloads, log }),
      }).record(makeRecord(), { payload: PAYLOAD, logger }),
    ).resolves.toBeUndefined()
    // The ledger row was written and the outer transaction committed.
    expect(calls.map((c) => c.table)).toEqual([llmCalls])
    expect(log).toEqual(['begin', 'savepoint', 'rollback to savepoint', 'commit'])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.[1]).toBe('llm.call.payload.failed')
    expect(errors[0]?.[0]).toMatchObject({
      callId: 'call_1',
      attemptId: 'attempt_1',
      error: 'driver: boom',
    })
  })

  it('a failing ledger insert rejects record() and never attempts the payload', async () => {
    const calls: InsertCall[] = []
    const log: string[] = []
    await expect(
      drizzleUsageSink({ db: makeDb(calls, { failInsertInto: llmCalls, log }) }).record(
        makeRecord(),
        { payload: PAYLOAD },
      ),
    ).rejects.toThrow('driver: boom')
    expect(calls).toEqual([])
    expect(log).toEqual(['begin', 'rollback'])
  })

  it('declares acceptsPayloads, so the engine hands it payloads', () => {
    expect(drizzleUsageSink({ db: makeDb([]) }).acceptsPayloads).toBe(true)
  })
})

/** What Drizzle >= 0.44 throws for a failed statement: the SQL and every parameter in the message. */
function drizzleQueryError(rootMessage: string, code: string, secret: string): Error {
  return Object.assign(
    new Error(
      `Failed query: insert into "llm_calls" (...) values ($1) params: ${secret}`,
      {
        cause: Object.assign(new Error(rootMessage), { code }),
      },
    ),
    { query: 'insert into "llm_calls" (...) values ($1)', params: [secret] },
  )
}

describe('drizzleUsageSink: a failed ledger insert never carries the row', () => {
  it('rejects with the driver message and SQLSTATE, not the SQL or its parameters, and has no cause', async () => {
    const secret = 'CUSTOMER REASONING sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
    const error = await drizzleUsageSink({
      db: makeDb([], {
        failInsertInto: llmCalls,
        failWith: drizzleQueryError(
          'column "error_reason" does not exist',
          '42703',
          secret,
        ),
      }),
    })
      .record(makeRecord({ reasoningText: secret, metadata: { tenant: secret } }))
      .catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('column "error_reason" does not exist')
    expect(String(error)).toContain('SQLSTATE 42703')
    expect(String(error)).toContain('attempt_1')
    expect(String(error)).toMatch(/assertLlmCallsSchema/)
    expect(String(error)).not.toMatch(/CUSTOMER|params|Failed query|sk-ant/)
    expect((error as Error).cause).toBeUndefined()
    expect(JSON.stringify(Object.entries(error as Error))).not.toContain('CUSTOMER')
  })

  it('reduces a query error with no driver error under it to a fixed text', async () => {
    const bare = Object.assign(new Error('Failed query: ... params: SECRET'), {
      query: 'insert',
      params: ['SECRET'],
    })
    const error = await drizzleUsageSink({
      db: makeDb([], { failInsertInto: llmCalls, failWith: bare }),
    })
      .record(makeRecord())
      .catch((e: unknown) => e as Error)
    expect(String(error)).toContain('query failed')
    expect(String(error)).not.toContain('SECRET')
  })

  it('keeps a raw driver error (Drizzle before it wrapped them) as it is, capped and redacted', async () => {
    const raw = Object.assign(
      new Error(`invalid input syntax for type integer: "12.5" ${'x'.repeat(1000)}`),
      { code: '22P02' },
    )
    const error = await drizzleUsageSink({
      db: makeDb([], { failInsertInto: llmCalls, failWith: raw }),
    })
      .record(makeRecord())
      .catch((e: unknown) => e as Error)
    expect(String(error)).toContain('invalid input syntax for type integer')
    expect(String(error)).toContain('SQLSTATE 22P02')
    expect(String(error).length).toBeLessThan(600)
  })

  it('the payload failure log is capped and carries no parameters either', async () => {
    const { logger, errors } = recordingLogger()
    await drizzleUsageSink({
      db: makeDb([], {
        failInsertInto: llmCallPayloads,
        failWith: drizzleQueryError(
          'relation "llm_call_payloads" does not exist',
          '42P01',
          'SECRET',
        ),
      }),
    }).record(makeRecord(), { payload: PAYLOAD, logger })
    expect(JSON.stringify(errors)).not.toContain('SECRET')
    expect(errors[0]?.[0]).toMatchObject({
      error: 'relation "llm_call_payloads" does not exist',
    })
  })
})

describe('drizzleUsageSink on a transaction handle', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `attempt_${i}`)

  it('db as a transaction handle: concurrent records run one at a time, each in a nested transaction, so none crosses another', async () => {
    const calls: InsertCall[] = []
    const stats = { maxOpenNested: 0 }
    const log: string[] = []
    const hostDb = makeDb(calls, { insertDelayMs: 1, stats, log })
    // The host's transaction: the handle `hostDb.transaction` gives its callback.
    await hostDb.transaction(async (tx) => {
      const sink = drizzleUsageSink({ db: tx as PostgresDb })
      await Promise.all(
        ids.map((id) => sink.record(makeRecord({ attemptId: id }), { payload: PAYLOAD })),
      )
    })
    // Six records, each: ledger + payload.
    expect(calls).toHaveLength(12)
    // Never two nested transactions open at once on the shared handle.
    expect(stats.maxOpenNested).toBe(2) // the write's own, with the payload's inside it
    // Strictly sequential: begin, then six (savepoint savepoint release release), commit.
    expect(log.slice(0, 2)).toEqual(['begin', 'savepoint'])
    expect(log.filter((l) => l === 'savepoint')).toHaveLength(12)
    expect(log.filter((l) => l.startsWith('rollback'))).toEqual([])
  })

  it('a ledger-only record on a transaction handle is also a nested transaction, so a failing insert cannot abort the host', async () => {
    const calls: InsertCall[] = []
    const log: string[] = []
    const dbHandle = makeDb(calls, { log, failInsertInto: llmCalls })
    await dbHandle.transaction(async (tx) => {
      await expect(
        drizzleUsageSink({ db: tx as PostgresDb }).record(makeRecord()),
      ).rejects.toThrow('driver: boom')
    })
    // The failure rolled back to the savepoint and the host transaction committed.
    expect(log).toEqual(['begin', 'savepoint', 'rollback to savepoint', 'commit'])
  })

  it('a helper that hands every call one ambient transaction serializes the writes', async () => {
    const calls: InsertCall[] = []
    const stats = { maxOpenNested: 0 }
    const log: string[] = []
    const hostDb = makeDb(calls, { insertDelayMs: 1, stats, log })
    await hostDb.transaction(async (ambient) => {
      const sink = drizzleUsageSink({
        db: hostDb,
        transaction: (fn) => fn(ambient as PostgresDb),
      })
      await Promise.all(
        ids.map((id) => sink.record(makeRecord({ attemptId: id }), { payload: PAYLOAD })),
      )
    })
    expect(calls).toHaveLength(12)
    expect(stats.maxOpenNested).toBe(2)
  })
})

describe('drizzleUsageSink construction', () => {
  it('a db without transaction() is bad_request at construction, with the plain explanation', () => {
    const insertOnly = { insert: () => ({}) } as unknown as PostgresDb
    expect(() => drizzleUsageSink({ db: insertOnly })).toThrow(
      expect.objectContaining({ kind: 'bad_request' }) as Error,
    )
    expect(() => drizzleUsageSink({ db: insertOnly })).toThrow(/no transaction\(\)/)
  })

  it('a db without transaction() is accepted when the host passes its own transaction helper', () => {
    const insertOnly = { insert: () => ({}) } as unknown as PostgresDb
    expect(() =>
      drizzleUsageSink({ db: insertOnly, transaction: (fn) => fn(insertOnly) }),
    ).not.toThrow()
  })

  it.each([
    ['no options', undefined],
    ['no db', {}],
    ['a db that is not a database', { db: {} }],
    ['a transaction that is not a function', { db: makeDb([]), transaction: 1 }],
  ])('%s is bad_request', (_name, options) => {
    expect(() =>
      drizzleUsageSink(options as unknown as Parameters<typeof drizzleUsageSink>[0]),
    ).toThrow(expect.objectContaining({ kind: 'bad_request' }) as Error)
  })
})
