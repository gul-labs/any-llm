/**
 * Middleware seam tests for @gullabs/core.
 *
 * (a) Multi-middleware ordering: verifies the onion model (outermost-first
 *     request, innermost-first response) and that runAttempt runs exactly once
 *     for a non-retried call.
 *
 * (b) Retry + rate-limiter integration: asserts the limiter slot is acquired
 *     and released for each attempt, no slot leaks across retries, exactly two
 *     attempt records with a stable callId and distinct attemptIds, and the
 *     final result succeeds.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createClient,
  createModelRegistry,
  LlmError,
  inMemoryRateLimiter,
} from './index.js'
import { retryMiddleware } from './retry.js'
import type {
  Middleware,
  ProviderAdapter,
  AdapterResult,
  Usage,
  RateLimiter,
  Release,
} from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
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

function makeSuccessResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    text: 'ok',
    usage: GOOD_USAGE,
    model: 'gemini-2.5-flash',
    warnings: [],
    ...overrides,
  }
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

// ---------------------------------------------------------------------------
// (a) Multi-middleware ordering
// ---------------------------------------------------------------------------

describe('engine — middleware ordering (onion model)', () => {
  it('outermost-first request, innermost-first response; runAttempt runs once for non-retried call', async () => {
    const order: string[] = []

    const mw1: Middleware = {
      id: 'mw1',
      async intercept(req, ctx, next) {
        order.push('mw1:before')
        const result = await next(req, ctx)
        order.push('mw1:after')
        return result
      },
    }

    const mw2: Middleware = {
      id: 'mw2',
      async intercept(req, ctx, next) {
        order.push('mw2:before')
        const result = await next(req, ctx)
        order.push('mw2:after')
        return result
      },
    }

    const mw3: Middleware = {
      id: 'mw3',
      async intercept(req, ctx, next) {
        order.push('mw3:before')
        const result = await next(req, ctx)
        order.push('mw3:after')
        return result
      },
    }

    // Count how many times the innermost adapter actually runs.
    let innerCallCount = 0
    const capturingAdapter = new FakeAdapter('google', makeSuccessResult())
    const origRun = capturingAdapter.run.bind(capturingAdapter)
    vi.spyOn(capturingAdapter, 'run').mockImplementation(async (req, ctx) => {
      innerCallCount++
      return origRun(req, ctx)
    })

    const client = createClient({
      adapters: [capturingAdapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [mw1, mw2, mw3],
    })

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    // Outermost-first request, innermost-first response (onion model).
    expect(order).toEqual([
      'mw1:before',
      'mw2:before',
      'mw3:before',
      'mw3:after',
      'mw2:after',
      'mw1:after',
    ])

    // runAttempt (the innermost handler) ran exactly once for a non-retried call.
    expect(innerCallCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// (b) Retry + rate-limiter integration
// ---------------------------------------------------------------------------

describe('engine — retry + rate-limiter integration', () => {
  it('limiter slot acquired+released per attempt; no slot leak; stable callId, distinct attemptIds; final result succeeds', async () => {
    // Adapter fails once with rate_limited, then succeeds.
    let adapterCallCount = 0
    const adapter: ProviderAdapter = {
      id: 'google',
      async run(_req, _ctx): Promise<AdapterResult> {
        adapterCallCount++
        if (adapterCallCount === 1) {
          throw new LlmError('upstream rate limited', {
            kind: 'rate_limited',
            retryable: true,
          })
        }
        return makeSuccessResult()
      },
    }

    // Wrap inMemoryRateLimiter with a spy that tracks acquire/release counts.
    const inner = inMemoryRateLimiter({ maxConcurrency: 1 })
    let acquireCount = 0
    let releaseCount = 0
    const spyLimiter: RateLimiter = {
      async acquire(key: string, signal?: AbortSignal): Promise<Release> {
        acquireCount++
        const release = await inner.acquire(key, signal)
        return (): void => {
          releaseCount++
          release()
        }
      },
    }

    const sink = new RecordingSink()
    const ids = new FakeIds()

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock: new FakeClock(),
      ids,
      sink,
      rateLimiter: spyLimiter,
      middleware: [
        retryMiddleware(
          { maxAttempts: 3 },
          // Inject zero-delay sleep so the test is instant.
          { sleep: async () => {} },
        ),
      ],
    })

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    // Final result is a success.
    expect(result.text).toBe('ok')

    // Adapter was called twice (fail on 1st, succeed on 2nd).
    expect(adapterCallCount).toBe(2)

    // Limiter slot was acquired and released once per attempt — no leak.
    expect(acquireCount).toBe(2)
    expect(releaseCount).toBe(2)

    // Limiter ends with full capacity (the slot was released after each attempt).
    // Verify by acquiring immediately (should resolve without blocking).
    let canAcquireAfter = false
    await inner.acquire('google:gemini-2.5-flash').then((r) => {
      canAcquireAfter = true
      r()
    })
    expect(canAcquireAfter).toBe(true)

    // Exactly two records: one error (attempt 1) and one ok (attempt 2).
    expect(sink.records).toHaveLength(2)

    // Stable callId across retries.
    const callId = sink.records[0]!.callId
    expect(sink.records[1]!.callId).toBe(callId)

    // Distinct attemptIds.
    const attemptId0 = sink.records[0]!.attemptId
    const attemptId1 = sink.records[1]!.attemptId
    expect(attemptId0).not.toBe(attemptId1)

    // First record is the error attempt.
    expect(sink.records[0]!.status).toBe('api_error')
    expect(sink.records[0]!.errorKind).toBe('rate_limited')

    // Second record is the success.
    expect(sink.records[1]!.status).toBe('ok')
  })
})
