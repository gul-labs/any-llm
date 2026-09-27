/**
 * Regression tests for the attemptId reconcile contract.
 *
 * Asserts that `attemptId` on `LlmError` / `CallErrorEvent` is ONLY set when
 * a real attempt ran; it references the attempt that actually executed (and,
 * with a working sink, matches the persisted record's `attemptId` — the sink
 * is fail-open so the row may be absent if the write failed).
 *
 * Cases covered:
 *  (1) Middleware throws before calling next() — no attempt ran. Per D5
 *      (input-contracts plan, §0.4: "if a call got a callId, it leaves a
 *      ledger row"), this now writes ONE synthetic `attemptNumber: 0` record
 *      — the telemetry/`LlmError.attemptId` contract is UNCHANGED (still
 *      absent, since no real attempt ran).
 *  (2) Normal success — attemptId on result matches the persisted record's attemptId (when the sink write succeeds).
 *  (3) Retry-then-success — result.attemptId is the succeeding attempt.
 *  (4) Retries exhausted — LlmError.attemptId is the last real attempt's id.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import { retryMiddleware } from './retry.js'
import type {
  Middleware,
  ProviderAdapter,
  AdapterResult,
  Usage,
  CallStartEvent,
  CallSuccessEvent,
  CallErrorEvent,
  Telemetry,
} from './index.js'
import { FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makeTestPricingSource } from './test-pricing-source.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const GOOD_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  details: {},
  raw: null,
}

const PRICING = makeTestPricingSource(
  {
    'gemini-2.5-flash': {
      standard: { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
    },
  },
  'test-pricing-1',
)
const TEST_REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-flash', provider: 'google' }),
])
const TEST_AUTH = { apiKey: 'test-key' }
const MODEL = 'gemini-2.5-flash'
const MESSAGES = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hi' }] },
]

function makeSuccessResult(): AdapterResult {
  return { text: 'ok', usage: GOOD_USAGE, model: MODEL, warnings: [] }
}

// ---------------------------------------------------------------------------
// (1) Middleware throws BEFORE calling next() — no attempt ran
// ---------------------------------------------------------------------------

describe('attemptId reconcile — middleware throws before next()', () => {
  it('LlmError has callId but NO attemptId; CallErrorEvent has no attemptId; zero records written; onStart has no attemptId', async () => {
    const sink = new RecordingSink()
    const startEvents: CallStartEvent[] = []
    const errorEvents: CallErrorEvent[] = []

    const telemetry: Telemetry = {
      onStart(e) {
        startEvents.push(e)
      },
      onError(e) {
        errorEvents.push(e)
      },
    }

    // Middleware that throws WITHOUT calling next().
    const throwingMiddleware: Middleware = {
      id: 'pre-attempt-thrower',
      async intercept(_req, _ctx, _next): Promise<never> {
        throw new LlmError('middleware blew up before any attempt', {
          kind: 'bad_request',
          retryable: false,
        })
      },
    }

    const successAdapter: ProviderAdapter = {
      id: 'google',
      async run(): Promise<AdapterResult> {
        return makeSuccessResult()
      },
    }

    const client = createClient({
      adapters: [successAdapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      telemetry,
      middleware: [throwingMiddleware],
    })

    let caughtErr: unknown
    try {
      await client.generate(
        { provider: 'google', model: MODEL, messages: MESSAGES },
        { auth: TEST_AUTH },
      )
    } catch (e) {
      caughtErr = e
    }

    // The call must have thrown.
    expect(caughtErr).toBeInstanceOf(LlmError)
    const err = caughtErr as LlmError

    // callId is always set (the call started).
    expect(err.callId).toBeDefined()
    expect(typeof err.callId).toBe('string')

    // attemptId must be UNDEFINED — no real attempt ran (telemetry contract
    // unchanged by D5).
    expect(err.attemptId).toBeUndefined()

    // D5: exactly ONE synthetic pre-attempt record is written — "callId ⇒
    // ledger row" holds even though no real attempt ran. attemptNumber: 0
    // marks it as a pre-attempt refusal; it has no telemetry counterpart
    // (asserted below: onError still carries no attemptId).
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]!.attemptNumber).toBe(0)
    expect(sink.records[0]!.callId).toBe(err.callId)
    expect(sink.records[0]!.errorKind).toBe('bad_request')

    // onStart fired exactly once, and must NOT carry an attemptId.
    expect(startEvents).toHaveLength(1)
    expect('attemptId' in startEvents[0]!).toBe(false)

    // onError fired exactly once, and must NOT carry an attemptId.
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]!.attemptId).toBeUndefined()
    expect('attemptId' in errorEvents[0]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (2) Normal success — attemptId on result matches the persisted record
// ---------------------------------------------------------------------------

describe('attemptId reconcile — normal success', () => {
  it('result.attemptId matches the single persisted record', async () => {
    const sink = new RecordingSink()
    const successEvents: CallSuccessEvent[] = []
    const telemetry: Telemetry = {
      onSuccess(e) {
        successEvents.push(e)
      },
    }

    const adapter: ProviderAdapter = {
      id: 'google',
      async run(): Promise<AdapterResult> {
        return makeSuccessResult()
      },
    }

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      telemetry,
    })

    const result = await client.generate(
      { provider: 'google', model: MODEL, messages: MESSAGES },
      { auth: TEST_AUTH },
    )

    // Exactly one record.
    expect(sink.records).toHaveLength(1)

    // result.attemptId is always defined on success.
    expect(typeof result.attemptId).toBe('string')

    // It matches the persisted record's attemptId.
    expect(result.attemptId).toBe(sink.records[0]!.attemptId)

    // CallSuccessEvent.attemptId also matches.
    expect(successEvents).toHaveLength(1)
    expect(successEvents[0]!.attemptId).toBe(result.attemptId)
  })
})

// ---------------------------------------------------------------------------
// (3) Retry-then-success — result.attemptId is the SUCCEEDING attempt
// ---------------------------------------------------------------------------

describe('attemptId reconcile — retry-then-success', () => {
  it('result.attemptId is the succeeding attempt; first record is the error attempt', async () => {
    const sink = new RecordingSink()
    let callCount = 0

    const adapter: ProviderAdapter = {
      id: 'google',
      async run(): Promise<AdapterResult> {
        callCount++
        if (callCount === 1) {
          throw new LlmError('transient', { kind: 'server', retryable: true })
        }
        return makeSuccessResult()
      },
    }

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [retryMiddleware({ maxAttempts: 3 }, { sleep: async () => {} })],
    })

    const result = await client.generate(
      { provider: 'google', model: MODEL, messages: MESSAGES },
      { auth: TEST_AUTH },
    )

    // Two records: error attempt, then success attempt.
    expect(sink.records).toHaveLength(2)
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[1]!.status).toBe('ok')

    // result.attemptId is the SECOND attempt (the one that succeeded).
    expect(result.attemptId).toBe(sink.records[1]!.attemptId)

    // The two attempt IDs are distinct.
    expect(sink.records[0]!.attemptId).not.toBe(sink.records[1]!.attemptId)

    // callId is stable across retries.
    expect(sink.records[0]!.callId).toBe(sink.records[1]!.callId)
    expect(result.callId).toBe(sink.records[0]!.callId)
  })
})

// ---------------------------------------------------------------------------
// (4) Retries exhausted — LlmError.attemptId is the LAST real attempt's id
// ---------------------------------------------------------------------------

describe('attemptId reconcile — retries exhausted', () => {
  it('LlmError.attemptId matches the last persisted record; all records share callId', async () => {
    const sink = new RecordingSink()
    const errorEvents: CallErrorEvent[] = []
    const telemetry: Telemetry = {
      onError(e) {
        errorEvents.push(e)
      },
    }

    const adapter: ProviderAdapter = {
      id: 'google',
      async run(): Promise<AdapterResult> {
        throw new LlmError('server down', { kind: 'server', retryable: true })
      },
    }

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
      telemetry,
      middleware: [retryMiddleware({ maxAttempts: 3 }, { sleep: async () => {} })],
    })

    let caughtErr: unknown
    try {
      await client.generate(
        { provider: 'google', model: MODEL, messages: MESSAGES },
        { auth: TEST_AUTH },
      )
    } catch (e) {
      caughtErr = e
    }

    expect(caughtErr).toBeInstanceOf(LlmError)
    const err = caughtErr as LlmError

    // Three records (all failed, one per attempt).
    expect(sink.records).toHaveLength(3)
    for (const r of sink.records) {
      expect(r.status).toBe('api_error')
    }

    // callId is stable.
    const callId = sink.records[0]!.callId
    for (const r of sink.records) {
      expect(r.callId).toBe(callId)
    }

    // LlmError.attemptId matches the LAST attempt's record.
    expect(err.attemptId).toBeDefined()
    expect(err.attemptId).toBe(sink.records[2]!.attemptId)

    // CallErrorEvent.attemptId also matches the last attempt.
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]!.attemptId).toBe(sink.records[2]!.attemptId)
  })
})
