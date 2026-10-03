import { describe, expect, it } from 'vitest'
import { drizzleUsageSink, llmCallPayloads, llmCalls, type PostgresDb } from './index.js'
import type { JsonValue, LlmCallPayload, LlmCallRecord, Logger } from '@gullabs/core'

type InsertCall = {
  /** Which transaction handle ran the insert: the outer one or the savepoint. */
  handle: 'tx' | 'savepoint'
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
  /** Count of transactions opened (outer and nested). */
  log?: string[]
}

/**
 * A structural stand-in for a Drizzle Postgres database: `transaction` hands the
 * callback a transaction handle whose own `transaction` is the savepoint, and
 * every insert is recorded with the handle that ran it.
 */
function makeDb(spy: InsertCall[], options: MockOptions = {}): PostgresDb {
  const log = options.log ?? []
  const handle = (kind: 'tx' | 'savepoint') => ({
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            async onConflictDoNothing({ target }: { target: unknown }) {
              if (table === options.failInsertInto) {
                throw new Error('insert failed', { cause: new Error('driver: boom') })
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
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      log.push('savepoint')
      return fn(handle('savepoint'))
    },
  })
  return {
    async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      log.push('begin')
      const result = await fn(handle('tx'))
      log.push('commit')
      return result
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
  it('writes the ledger row on the transaction, then the payload on a nested transaction (savepoint)', async () => {
    const calls: InsertCall[] = []
    const log: string[] = []
    await drizzleUsageSink({ db: makeDb(calls, { log }) }).record(makeRecord(), {
      payload: PAYLOAD,
    })
    expect(log).toEqual(['begin', 'savepoint', 'commit'])
    expect(calls.map((c) => [c.handle, c.table])).toEqual([
      ['tx', llmCalls],
      ['savepoint', llmCallPayloads],
    ])
    expect(calls[1]?.conflictTarget).toBe(llmCallPayloads.attemptId)
    expect(calls[1]?.values).toEqual({
      attemptId: 'attempt_1',
      request: PAYLOAD.request,
      response: PAYLOAD.response,
      createdAt: new Date('2026-06-27T00:00:00.000Z'),
    })
  })

  it('a record with no payload opens no savepoint and writes no payload row', async () => {
    const calls: InsertCall[] = []
    const log: string[] = []
    await drizzleUsageSink({ db: makeDb(calls, { log }) }).record(makeRecord())
    expect(log).toEqual(['begin', 'commit'])
    expect(calls.map((c) => c.table)).toEqual([llmCalls])
  })

  it('the host transaction helper is used when given: db.transaction is not, and every statement runs on the helper handle', async () => {
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
    expect(hostLog).toEqual(['begin', 'savepoint', 'commit', 'begin', 'commit'])
    expect(hostCalls.map((c) => [c.handle, c.table])).toEqual([
      ['tx', llmCalls],
      ['savepoint', llmCallPayloads],
      ['tx', llmCalls],
    ])
  })

  it('a failing payload insert is logged as llm.call.payload.failed with the driver error, and record() resolves', async () => {
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
    expect(log).toEqual(['begin', 'savepoint', 'commit'])
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
    ).rejects.toThrow('insert failed')
    expect(calls).toEqual([])
    expect(log).toEqual(['begin'])
  })
})
