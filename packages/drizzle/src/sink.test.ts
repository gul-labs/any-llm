import { describe, expect, it } from 'vitest'
import { drizzleUsageSink, llmCalls, type InsertableDb } from './index.js'
import type { JsonValue, LlmCallRecord } from '@gullabs/core'

type InsertCall = {
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

function makeDb(spy: InsertCall[]): InsertableDb {
  return {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          return {
            async onConflictDoNothing({ target }: { target: unknown }) {
              spy.push({
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
  }
}

describe('drizzleUsageSink', () => {
  it('writes the cost v2 fields (ADR-039) to their columns', async () => {
    const calls: InsertCall[] = []
    await drizzleUsageSink(makeDb(calls)).record(
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
    const sink = drizzleUsageSink(db)
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
    const sink = drizzleUsageSink(db)

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
    const sink = drizzleUsageSink(makeDb(calls))

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
    const sink = drizzleUsageSink(db)

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
    const sink = drizzleUsageSink(db)

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
    const sink = drizzleUsageSink(db)
    // makeRecord()'s defaults omit authKeyId — mirrors buildRecord's
    // conditional-spread convention (absent, not present-as-undefined).
    const record = makeRecord()

    await sink.record(record)

    expect(calls[0]?.values['authKeyId']).toBeUndefined()
  })
})
