/**
 * Tests for retry.ts — computeBackoffMs, retryMiddleware, and the engine
 * integration path with empty middleware.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from './errors.js'
import { computeBackoffMs, retryMiddleware } from './retry.js'
import { createClient, createModelRegistry } from './index.js'
import type { Handler, EngineCtx, ResolvedRequest } from './ports.js'
import type { LlmResult, Usage } from './types.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import {
  makePermissiveTestDescriptor,
  makeTestDescriptor,
} from './test-model-descriptor.js'
import { makeTestPricingSource } from './test-pricing-source.js'

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

const NOOP_CLOCK = { now: () => 0 }

const GOOD_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  details: {},
  raw: null,
}

const DUMMY_RESULT: LlmResult = {
  callId: 'test-call-id',
  attemptId: 'test-attempt-id',
  usage: GOOD_USAGE,
  model: 'gemini-2.5-pro',
  latencyMs: 0,
  warnings: [],
  text: 'ok',
}

function makeCtx(signal?: AbortSignal): EngineCtx {
  return {
    callId: 'c1',
    clock: NOOP_CLOCK,
    logger: NOOP_LOGGER,
    ...(signal !== undefined ? { signal } : {}),
  }
}

function makeReq(): ResolvedRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    config: {},
  }
}

function rateLimited(retryAfterMs?: number): LlmError {
  return new LlmError('Rate limited', {
    kind: 'rate_limited',
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

function badRequest(): LlmError {
  return new LlmError('Bad request', { kind: 'bad_request', retryable: false })
}

function abortedError(): LlmError {
  return new LlmError('Aborted', { kind: 'aborted', retryable: false })
}

// No-op sleep for synchronous unit tests (skips actual waiting)
const NO_SLEEP = async (_ms: number, _signal?: AbortSignal): Promise<void> => {}

// ---------------------------------------------------------------------------
// 1. computeBackoffMs
// ---------------------------------------------------------------------------

describe('computeBackoffMs', () => {
  const policy = { baseDelayMs: 500, maxDelayMs: 30_000 }

  it('exponential growth: attempt-1 ≤ attempt-2 ≤ attempt-3 (with rand=1)', () => {
    const d1 = computeBackoffMs(1, policy, undefined, () => 1)
    const d2 = computeBackoffMs(2, policy, undefined, () => 1)
    const d3 = computeBackoffMs(3, policy, undefined, () => 1)
    expect(d1).toBe(500) // 500 * 2^0 * 1
    expect(d2).toBe(1_000) // 500 * 2^1 * 1
    expect(d3).toBe(2_000) // 500 * 2^2 * 1
  })

  it('caps at maxDelayMs when exponential exceeds it', () => {
    const d = computeBackoffMs(10, policy, undefined, () => 1)
    expect(d).toBe(30_000) // 500 * 2^9 = 256_000 → capped at 30_000
  })

  it('full jitter: result is within [0, ceiling]', () => {
    const d0 = computeBackoffMs(1, policy, undefined, () => 0)
    const d05 = computeBackoffMs(1, policy, undefined, () => 0.5)
    const d1 = computeBackoffMs(1, policy, undefined, () => 1)
    expect(d0).toBe(0)
    expect(d05).toBe(250)
    expect(d1).toBe(500)
  })

  it('retryAfterMs is honored and returned as-is when below maxDelayMs', () => {
    const d = computeBackoffMs(1, policy, 2_000, () => 0.5)
    expect(d).toBe(2_000) // retryAfterMs wins over exponential
  })

  it('retryAfterMs is capped at maxDelayMs', () => {
    const d = computeBackoffMs(1, policy, 99_999, () => 0.5)
    expect(d).toBe(30_000)
  })

  it('rand is NOT applied when retryAfterMs is present', () => {
    // With retryAfterMs: rand() should have no effect
    const d0 = computeBackoffMs(1, policy, 1_000, () => 0)
    const d1 = computeBackoffMs(1, policy, 1_000, () => 1)
    expect(d0).toBe(1_000)
    expect(d1).toBe(1_000)
  })

  it('attempt=1 produces baseDelayMs as the ceiling (with rand=1)', () => {
    const d = computeBackoffMs(
      1,
      { baseDelayMs: 200, maxDelayMs: 5_000 },
      undefined,
      () => 1,
    )
    expect(d).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 2. retryMiddleware — behavior
// ---------------------------------------------------------------------------

describe('retryMiddleware', () => {
  it('retries rate_limited error then succeeds on second attempt', async () => {
    let calls = 0
    const handler: Handler = async () => {
      calls++
      if (calls === 1) throw rateLimited()
      return DUMMY_RESULT
    }

    const mw = retryMiddleware({ maxAttempts: 3 }, { sleep: NO_SLEEP, random: () => 1 })
    const result = await mw.intercept(makeReq(), makeCtx(), handler)

    expect(calls).toBe(2)
    expect(result.text).toBe('ok')
  })

  it('stops after maxAttempts and throws the last error', async () => {
    let calls = 0
    const handler: Handler = async () => {
      calls++
      throw rateLimited()
    }

    const mw = retryMiddleware({ maxAttempts: 3 }, { sleep: NO_SLEEP, random: () => 0 })

    await expect(mw.intercept(makeReq(), makeCtx(), handler)).rejects.toMatchObject({
      kind: 'rate_limited',
    })

    expect(calls).toBe(3) // maxAttempts=3 → 3 total calls
  })

  it('does NOT retry bad_request (retryable=false)', async () => {
    let calls = 0
    const handler: Handler = async () => {
      calls++
      throw badRequest()
    }

    const mw = retryMiddleware({ maxAttempts: 3 }, { sleep: NO_SLEEP, random: () => 1 })

    await expect(mw.intercept(makeReq(), makeCtx(), handler)).rejects.toMatchObject({
      kind: 'bad_request',
    })

    expect(calls).toBe(1) // no retry
  })

  it('does NOT retry aborted, even with a permissive shouldRetry', async () => {
    let calls = 0
    const handler: Handler = async () => {
      calls++
      throw abortedError()
    }

    const mw = retryMiddleware(
      { maxAttempts: 3, shouldRetry: () => true }, // permissive policy
      { sleep: NO_SLEEP, random: () => 1 },
    )

    await expect(mw.intercept(makeReq(), makeCtx(), handler)).rejects.toMatchObject({
      kind: 'aborted',
    })

    expect(calls).toBe(1) // abort is always terminal
  })

  it('honors retryAfterMs in the back-off computation', async () => {
    const sleepCalls: number[] = []
    const customSleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }

    let calls = 0
    const handler: Handler = async () => {
      calls++
      if (calls === 1) throw rateLimited(5_000) // retryAfterMs=5000
      return DUMMY_RESULT
    }

    const mw = retryMiddleware(
      { maxAttempts: 2 },
      { sleep: customSleep, random: () => 0.5 },
    )
    await mw.intercept(makeReq(), makeCtx(), handler)

    expect(sleepCalls).toHaveLength(1)
    expect(sleepCalls[0]).toBe(5_000) // retryAfterMs honored, rand not applied
  })

  it('retryAfterMs is capped at maxDelayMs', async () => {
    const sleepCalls: number[] = []
    const customSleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }

    let calls = 0
    const handler: Handler = async () => {
      calls++
      if (calls === 1) throw rateLimited(99_999) // huge retryAfterMs
      return DUMMY_RESULT
    }

    const mw = retryMiddleware(
      { maxAttempts: 2, maxDelayMs: 10_000 },
      { sleep: customSleep, random: () => 0 },
    )
    await mw.intercept(makeReq(), makeCtx(), handler)

    expect(sleepCalls[0]).toBe(10_000) // capped at maxDelayMs
  })

  it('custom shouldRetry: stops retrying when predicate returns false', async () => {
    let calls = 0
    const handler: Handler = async () => {
      calls++
      throw rateLimited() // retryable=true but custom policy rejects
    }

    const mw = retryMiddleware(
      { maxAttempts: 5, shouldRetry: () => false },
      { sleep: NO_SLEEP, random: () => 1 },
    )

    await expect(mw.intercept(makeReq(), makeCtx(), handler)).rejects.toThrow()
    expect(calls).toBe(1) // stopped immediately
  })

  it('abort during backoff rejects with aborted LlmError', async () => {
    const ctrl = new AbortController()

    let calls = 0
    const handler: Handler = async () => {
      calls++
      throw rateLimited()
    }

    // Use a sleep that waits 100ms; we abort after 30ms
    const mw = retryMiddleware(
      { maxAttempts: 3, baseDelayMs: 100 },
      { random: () => 1 }, // no custom sleep → uses abortableSleep
    )

    setTimeout(() => ctrl.abort(), 30)

    await expect(
      mw.intercept(makeReq(), makeCtx(ctrl.signal), handler),
    ).rejects.toMatchObject({ kind: 'aborted' })

    expect(calls).toBe(1) // only one attempt was made before abort
  }, 2_000)

  it('does not pin servedServiceTier onto a descriptor with no supported service tiers', async () => {
    const seenTiers: Array<string | undefined> = []
    const req: ResolvedRequest = {
      ...makeReq(),
      model: 'gemma-4-31b-it',
      modelDescriptor: makeTestDescriptor({
        model: 'gemma-4-31b-it',
        provider: 'google',
      }),
    }

    let calls = 0
    const handler: Handler = async (attemptReq) => {
      calls++
      seenTiers.push(attemptReq.config.serviceTier)
      if (calls === 1) {
        throw new LlmError('Rate limited', {
          kind: 'rate_limited',
          retryable: true,
          servedServiceTier: 'standard',
        })
      }
      return DUMMY_RESULT
    }

    const mw = retryMiddleware({ maxAttempts: 2 }, { sleep: NO_SLEEP, random: () => 0 })
    await mw.intercept(req, makeCtx(), handler)

    expect(seenTiers).toEqual([undefined, undefined])
  })

  it('does not pin an unsupported servedServiceTier onto the next retry attempt', async () => {
    const seenTiers: Array<string | undefined> = []
    const req: ResolvedRequest = {
      ...makeReq(),
      modelDescriptor: makeTestDescriptor({
        model: 'google-standard-only-model',
        provider: 'google',
        capabilities: { serviceTiers: ['standard'] },
      }),
    }

    let calls = 0
    const handler: Handler = async (attemptReq) => {
      calls++
      seenTiers.push(attemptReq.config.serviceTier)
      if (calls === 1) {
        throw new LlmError('Rate limited', {
          kind: 'rate_limited',
          retryable: true,
          servedServiceTier: 'flex',
        })
      }
      return DUMMY_RESULT
    }

    const mw = retryMiddleware({ maxAttempts: 2 }, { sleep: NO_SLEEP, random: () => 0 })
    await mw.intercept(req, makeCtx(), handler)

    expect(seenTiers).toEqual([undefined, undefined])
  })

  it('pins a served service tier from a non-Google descriptor vocabulary', async () => {
    const seenTiers: Array<string | undefined> = []
    const req: ResolvedRequest = {
      ...makeReq(),
      modelDescriptor: makeTestDescriptor({
        model: 'priority-tiered-model',
        provider: 'google',
        capabilities: { serviceTiers: ['priority', 'default'] },
      }),
    }

    let calls = 0
    const handler: Handler = async (attemptReq) => {
      calls++
      seenTiers.push(attemptReq.config.serviceTier)
      if (calls === 1) {
        throw new LlmError('Rate limited', {
          kind: 'rate_limited',
          retryable: true,
          servedServiceTier: 'priority',
        })
      }
      return DUMMY_RESULT
    }

    const mw = retryMiddleware({ maxAttempts: 2 }, { sleep: NO_SLEEP, random: () => 0 })
    await mw.intercept(req, makeCtx(), handler)

    expect(seenTiers).toEqual([undefined, 'priority'])
  })
})

// ---------------------------------------------------------------------------
// 3. Engine integration: empty middleware path is unchanged
// ---------------------------------------------------------------------------

describe('engine + middleware — integration', () => {
  const PRICING = makeTestPricingSource(
    {
      'gemini-2.5-pro': {
        standard: {
          inputPerM: 1_250_000,
          cachedPerM: 125_000,
          outputPerM: 10_000_000,
        },
      },
    },
    'test-pricing-1',
  )
  const TEST_REGISTRY = createModelRegistry([
    makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
  ])
  const TEST_AUTH = { apiKey: 'test-key' }

  function makeSuccessResult() {
    return {
      text: 'Hello!',
      usage: { inputTokens: 100, outputTokens: 20, details: {}, raw: null },
      model: 'gemini-2.5-pro',
      modelVersion: 'gemini-2.5-pro-001',
      finishReason: 'stop' as const,
      responseId: 'resp-1',
      warnings: [],
    }
  }

  it('empty middleware: one attempt, same callId+attemptId record', async () => {
    const adapter = new FakeAdapter('google', makeSuccessResult())
    const sink = new RecordingSink()
    const ids = new FakeIds()
    const clock = new FakeClock(1_000)

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock,
      ids,
      // no middleware
    })

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.text).toBe('Hello!')
    expect(sink.records).toHaveLength(1)
    const rec = sink.last()!
    expect(rec.callId).toBe('call_1')
    expect(rec.attemptId).toBe('attempt_1')
    expect(rec.status).toBe('ok')
  })

  it('duplicate middleware id throws bad_request at createClient', () => {
    const mwA = retryMiddleware({ maxAttempts: 2 }, { sleep: NO_SLEEP })
    // Create a second middleware with the same id='retry'
    const mwB = retryMiddleware({ maxAttempts: 3 }, { sleep: NO_SLEEP })

    expect(() =>
      createClient({
        adapters: [new FakeAdapter('google', makeSuccessResult())],
        pricingSources: { google: PRICING },
        modelRegistry: TEST_REGISTRY,
        middleware: [mwA, mwB], // both have id='retry'
      }),
    ).toThrow(LlmError)
  })

  it('retry middleware: N attempts → N records, same callId, distinct attemptIds', async () => {
    const adapter = new FakeAdapter('google', [
      { status: 429 }, // attempt 1 → rate_limited
      makeSuccessResult(), // attempt 2 → ok
    ])
    const sink = new RecordingSink()
    const ids = new FakeIds()

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids,
      middleware: [
        retryMiddleware({ maxAttempts: 2 }, { sleep: NO_SLEEP, random: () => 0 }),
      ],
    })

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    // Two records: one error attempt, one ok attempt
    expect(sink.records).toHaveLength(2)

    // Same callId across both records
    expect(sink.records[0]!.callId).toBe('call_1')
    expect(sink.records[1]!.callId).toBe('call_1')

    // Distinct attemptIds
    expect(sink.records[0]!.attemptId).toBe('attempt_1')
    expect(sink.records[1]!.attemptId).toBe('attempt_2')

    // First record is the failed attempt, second is the success
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[0]!.errorKind).toBe('rate_limited')
    expect(sink.records[1]!.status).toBe('ok')
  })

  it('retry exhausted: all N attempts sinked, final error thrown', async () => {
    const adapter = new FakeAdapter('google', { status: 429 })
    const sink = new RecordingSink()
    const ids = new FakeIds()

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock: new FakeClock(),
      ids,
      middleware: [
        retryMiddleware({ maxAttempts: 3 }, { sleep: NO_SLEEP, random: () => 0 }),
      ],
    })

    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'rate_limited' })

    // 3 records (one per attempt), all with the same callId
    expect(sink.records).toHaveLength(3)
    for (const rec of sink.records) {
      expect(rec.callId).toBe('call_1')
      expect(rec.status).toBe('api_error')
      expect(rec.errorKind).toBe('rate_limited')
    }
    // Distinct attemptIds
    expect(sink.records[0]!.attemptId).toBe('attempt_1')
    expect(sink.records[1]!.attemptId).toBe('attempt_2')
    expect(sink.records[2]!.attemptId).toBe('attempt_3')
  })

  it('telemetry.onStart fires ONCE even with 3 retry attempts', async () => {
    const starts: object[] = []
    const successes: object[] = []

    const adapter = new FakeAdapter('google', [
      { status: 429 },
      { status: 429 },
      makeSuccessResult(),
    ])

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      telemetry: {
        onStart: (e) => {
          starts.push(e)
          return 'span'
        },
        onSuccess: (e, span) => {
          successes.push({ ...e, span })
        },
      },
      middleware: [
        retryMiddleware({ maxAttempts: 3 }, { sleep: NO_SLEEP, random: () => 0 }),
      ],
    })

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(starts).toHaveLength(1) // ONE onStart per logical call
    expect(successes).toHaveLength(1) // ONE onSuccess after chain settles
    expect((successes[0]! as { span: unknown }).span).toBe('span')
  })
})
