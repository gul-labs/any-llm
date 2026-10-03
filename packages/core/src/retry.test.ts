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
import type { AdapterResult, Handler, EngineCtx, ResolvedRequest } from './ports.js'
import type { LlmResult, Usage } from './types.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeHttpError,
} from '@gullabs/testing'
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
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  continuation: 'history',
}

/**
 * A context as the engine builds it: `deadlineAt` is when the logical call ends
 * on `now`'s scale (the engine sets it from `config.timeoutMs` at call start).
 */
function makeCtx(
  signal?: AbortSignal,
  deadline?: { now: () => number; deadlineAt: number },
): EngineCtx {
  return {
    callId: 'c1',
    clock: { now: deadline?.now ?? (() => 0) },
    scheduler: new FakeClock(),
    logger: NOOP_LOGGER,
    ...(signal !== undefined ? { signal } : {}),
    ...(deadline !== undefined ? { deadlineAt: deadline.deadlineAt } : {}),
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

  it('retryAfterMs is a floor: the delay is the provider delay with random=0', () => {
    expect(computeBackoffMs(1, policy, 2_000, () => 0)).toBe(2_000)
  })

  it('retryAfterMs is never clamped: the caller decides whether to wait that long', () => {
    expect(computeBackoffMs(1, policy, 99_999, () => 0)).toBe(99_999)
  })

  it('adds jitter on top of a provider delay: at most 10 % of it, at most 1 s', () => {
    // 10 % of 2 s = 200 ms
    expect(computeBackoffMs(1, policy, 2_000, () => 1)).toBe(2_200)
    expect(computeBackoffMs(1, policy, 2_000, () => 0.5)).toBe(2_100)
    // 10 % of 60 s would be 6 s; capped at 1 s
    expect(computeBackoffMs(1, policy, 60_000, () => 1)).toBe(61_000)
    // The jitter never lowers the provider delay.
    for (const r of [0, 0.25, 0.5, 0.999]) {
      expect(computeBackoffMs(1, policy, 1_000, () => r)).toBeGreaterThanOrEqual(1_000)
    }
  })

  it.each([NaN, 0, -5, -Infinity, Infinity])(
    'a retryAfterMs of %s is not a delay: exponential back-off applies',
    (bad) => {
      expect(computeBackoffMs(2, policy, bad, () => 1)).toBe(1_000)
      expect(computeBackoffMs(1, policy, bad, () => 0)).toBe(0)
    },
  )

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
    // The provider's 5 s is the floor; jitter adds 0.5 * min(1000, 500).
    expect(sleepCalls[0]).toBe(5_250)
  })

  it('a provider delay longer than maxDelayMs stops the retry and rethrows the error with retryAfterMs intact', async () => {
    const sleepCalls: number[] = []
    const customSleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }

    let calls = 0
    const original = rateLimited(99_999)
    const handler: Handler = async () => {
      calls++
      throw original
    }

    const mw = retryMiddleware(
      { maxAttempts: 4, maxDelayMs: 10_000 },
      { sleep: customSleep, random: () => 0 },
    )
    const err = await mw.intercept(makeReq(), makeCtx(), handler).catch((e: unknown) => e)

    expect(err).toBe(original)
    expect((err as LlmError).retryAfterMs).toBe(99_999)
    expect(calls).toBe(1)
    expect(sleepCalls).toEqual([])
  })

  it('a provider delay equal to maxDelayMs is waited out in full', async () => {
    const sleepCalls: number[] = []
    let calls = 0
    const handler: Handler = async () => {
      calls++
      if (calls === 1) throw rateLimited(10_000)
      return DUMMY_RESULT
    }
    const mw = retryMiddleware(
      { maxAttempts: 2, maxDelayMs: 10_000 },
      {
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
        random: () => 0,
      },
    )

    await mw.intercept(makeReq(), makeCtx(), handler)

    expect(sleepCalls).toEqual([10_000])
  })

  it('a provider delay that leaves no usable window before the deadline rethrows the error with retryAfterMs intact', async () => {
    let virtualTime = 0
    const sleepCalls: number[] = []
    const original = rateLimited(8_000)
    const handler: Handler = async () => {
      virtualTime += 100
      throw original
    }
    const mw = retryMiddleware(
      { maxAttempts: 3, maxDelayMs: 30_000 },
      {
        sleep: async (ms) => {
          sleepCalls.push(ms)
          virtualTime += ms
        },
      },
    )

    const err = await mw
      .intercept(
        makeReq(),
        makeCtx(undefined, { now: () => virtualTime, deadlineAt: 5_000 }),
        handler,
      )
      .catch((e: unknown) => e)

    expect(err).toBe(original)
    expect((err as LlmError).retryAfterMs).toBe(8_000)
    expect(sleepCalls).toEqual([])
  })

  it('no policy ever retries before the provider delay', async () => {
    // Deterministic sweep over delay, cap, deadline, jitter and custom
    // `shouldRetry`: every sleep is at least the delay the failed attempt
    // asked for, and a delay that cannot be honoured ends the call instead.
    const delays = [1, 250, 1_000, 5_000, 9_999, 10_000, 10_001, 60_000]
    const caps = [500, 10_000, 30_000]
    const deadlines = [undefined, 2_000, 12_000, 120_000]
    const rands = [0, 0.5, 1]
    for (const retryAfterMs of delays) {
      for (const maxDelayMs of caps) {
        for (const timeoutMs of deadlines) {
          for (const r of rands) {
            for (const shouldRetry of [undefined, () => true]) {
              let virtualTime = 0
              const sleeps: number[] = []
              const handler: Handler = async () => {
                virtualTime += 10
                throw rateLimited(retryAfterMs)
              }
              const mw = retryMiddleware(
                {
                  maxAttempts: 4,
                  baseDelayMs: 100,
                  maxDelayMs,
                  ...(shouldRetry !== undefined ? { shouldRetry } : {}),
                },
                {
                  sleep: async (ms) => {
                    sleeps.push(ms)
                    virtualTime += ms
                  },
                  random: () => r,
                },
              )
              const err = await mw
                .intercept(
                  makeReq(),
                  makeCtx(
                    undefined,
                    timeoutMs === undefined
                      ? undefined
                      : { now: () => virtualTime, deadlineAt: timeoutMs },
                  ),
                  handler,
                )
                .catch((e: unknown) => e as LlmError)

              for (const slept of sleeps) {
                expect(slept).toBeGreaterThanOrEqual(retryAfterMs)
              }
              expect(err).toBeInstanceOf(LlmError)
              // However the call ended, the host still sees the provider's delay.
              expect((err as LlmError).retryAfterMs).toBe(retryAfterMs)
            }
          }
        }
      }
    }
  })

  it.each([NaN, 0, -5])(
    'a retryAfterMs of %s on the error is not slept as an immediate retry: exponential back-off applies',
    async (bad) => {
      const sleepCalls: number[] = []
      let calls = 0
      const handler: Handler = async () => {
        calls++
        if (calls === 1) throw rateLimited(bad)
        return DUMMY_RESULT
      }
      const mw = retryMiddleware(
        { maxAttempts: 2, baseDelayMs: 500 },
        {
          sleep: async (ms) => {
            sleepCalls.push(ms)
          },
          random: () => 1,
        },
      )

      await mw.intercept(makeReq(), makeCtx(), handler)

      expect(sleepCalls).toEqual([500])
    },
  )

  it('a NaN provider delay is not a usable delay and does not stop the retry', async () => {
    const original = rateLimited(Number.NaN)
    let calls = 0
    const mw = retryMiddleware(
      { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 },
      { sleep: NO_SLEEP, random: () => 0 },
    )
    await mw
      .intercept(makeReq(), makeCtx(), async () => {
        calls++
        throw original
      })
      .catch(() => {})
    // NaN > maxDelayMs is false, but NaN must not be mistaken for a usable delay.
    expect(calls).toBe(3)
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

  function makeSuccessResult(): AdapterResult {
    return {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'Hello!' }] },
      text: 'Hello!',
      usage: { inputTokens: 100, outputTokens: 20, details: {}, raw: null },
      model: 'gemini-2.5-pro',
      modelVersion: 'gemini-2.5-pro-001',
      finishReason: 'stop',
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
      fakeHttpError(429), // attempt 1 → rate_limited
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
    const adapter = new FakeAdapter('google', fakeHttpError(429))
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
      fakeHttpError(429),
      fakeHttpError(429),
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

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

describe('retryMiddleware policy validation', () => {
  const MAX = 2_147_483_647

  it.each([NaN, 0, -1, 1.5, Infinity, '3' as unknown as number])(
    'maxAttempts %s is bad_request at construction',
    (maxAttempts) => {
      expect(() => retryMiddleware({ maxAttempts })).toThrow(
        expect.objectContaining({
          kind: 'bad_request',
          retryable: false,
          issues: [expect.objectContaining({ path: 'maxAttempts' })],
        }),
      )
    },
  )

  it.each(['baseDelayMs', 'maxDelayMs'] as const)(
    '%s must be a finite number from 0 to 2^31 - 1',
    (key) => {
      for (const bad of [NaN, -1, Infinity, MAX + 1]) {
        expect(() => retryMiddleware({ [key]: bad })).toThrow(
          expect.objectContaining({
            kind: 'bad_request',
            issues: [expect.objectContaining({ path: key })],
          }),
        )
      }
      expect(() => retryMiddleware({ [key]: 0 })).not.toThrow()
      expect(() => retryMiddleware({ [key]: MAX })).not.toThrow()
    },
  )

  it('maxAttempts 1 is valid and never retries', async () => {
    let calls = 0
    const mw = retryMiddleware({ maxAttempts: 1 }, { sleep: NO_SLEEP })
    await mw
      .intercept(makeReq(), makeCtx(), async () => {
        calls++
        throw rateLimited()
      })
      .catch(() => {})
    expect(calls).toBe(1)
  })

  it('the default maxDelayMs is 60 s: a 60 s provider delay is slept, 60.001 s is not', async () => {
    const run = async (retryAfterMs: number): Promise<number[]> => {
      const sleeps: number[] = []
      let calls = 0
      const mw = retryMiddleware(
        { maxAttempts: 2 },
        {
          sleep: async (ms) => {
            sleeps.push(ms)
          },
          random: () => 0,
        },
      )
      await mw
        .intercept(makeReq(), makeCtx(), async () => {
          calls++
          if (calls === 1) throw rateLimited(retryAfterMs)
          return DUMMY_RESULT
        })
        .catch(() => {})
      return sleeps
    }
    expect(await run(60_000)).toEqual([60_000])
    expect(await run(60_001)).toEqual([])
  })
})
