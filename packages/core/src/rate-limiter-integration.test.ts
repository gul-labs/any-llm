/**
 * Engine integration tests for RateLimiter port.
 *
 * Uses a spy/fake limiter (not the in-memory one) to verify the engine's
 * acquire/release contract without importing @gullabs/testing.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import type { ProviderAdapter, RateLimiter, Release } from './index.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingSink,
  scriptedRateLimiter,
  fakeHttpError,
} from '@gullabs/testing'
import type { AdapterResult, Usage } from './index.js'
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
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
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
// Spy limiter factory
// ---------------------------------------------------------------------------

interface SpyLimiter extends RateLimiter {
  acquireCalls: Array<{ key: string; signal: AbortSignal | undefined }>
  releaseCalls: number
  /** When set, acquire rejects with this error instead of resolving. */
  rejectWith?: unknown
}

function makeSpyLimiter(): SpyLimiter {
  const spy: SpyLimiter = {
    acquireCalls: [],
    releaseCalls: 0,
    async acquire(key: string, signal?: AbortSignal): Promise<Release> {
      spy.acquireCalls.push({ key, signal })
      if (spy.rejectWith !== undefined) {
        throw spy.rejectWith
      }
      return (): void => {
        spy.releaseCalls++
      }
    },
  }
  return spy
}

function makeClientWithSpy(spy: SpyLimiter) {
  const clock = new FakeClock(1_000)
  const ids = new FakeIds()
  const adapter = new FakeAdapter('google', makeSuccessResult())
  const client = createClient({
    adapters: [adapter],
    pricingSources: { google: PRICING },
    modelRegistry: TEST_REGISTRY,
    clock,
    ids,
    rateLimiter: spy,
  })
  return { client, adapter }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('engine — rateLimiter integration', () => {
  it('(a) calls acquire with key "<provider>:<model>" before the adapter runs', async () => {
    const spy = makeSpyLimiter()
    const { client, adapter } = makeClientWithSpy(spy)

    // Verify acquire is called before adapter by checking ordering via interleaved tracking.
    let acquireCalledBeforeAdapter = false
    const originalAcquire = spy.acquire.bind(spy)
    spy.acquire = async (key, signal) => {
      // At the moment acquire is called, the adapter has 0 calls.
      acquireCalledBeforeAdapter = adapter.calls.length === 0
      return originalAcquire(key, signal)
    }

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(acquireCalledBeforeAdapter).toBe(true)
    expect(spy.acquireCalls).toHaveLength(1)
    expect(spy.acquireCalls[0]!.key).toBe('google:gemini-2.5-flash')
  })

  it('(b) calls Release on the success path', async () => {
    const spy = makeSpyLimiter()
    const { client } = makeClientWithSpy(spy)

    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(spy.releaseCalls).toBe(1)
  })

  it('(c) calls Release on the error path (adapter throws)', async () => {
    const spy = makeSpyLimiter()
    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', fakeHttpError(500))
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock,
      ids,
      rateLimiter: spy,
    })

    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toBeInstanceOf(LlmError)

    // Release must still have been called despite the adapter error.
    expect(spy.releaseCalls).toBe(1)
  })

  it('records queueDelayMs separately from provider-dispatch latency on success', async () => {
    const clock = new FakeClock(1_000)
    const sink = new RecordingSink()
    const debugEvents: Array<{ payload: object; message: string }> = []
    const adapter: ProviderAdapter = {
      id: 'google',
      async run() {
        clock.advance(40)
        return makeSuccessResult()
      },
    }

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock,
      ids: new FakeIds(),
      rateLimiter: scriptedRateLimiter({ delayMs: 250, clock }),
      logger: {
        info() {},
        warn() {},
        error() {},
        debug(payload, message) {
          debugEvents.push({ payload, message })
        },
      },
    })

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.queueDelayMs).toBe(250)
    expect(result.latencyMs).toBe(40)
    expect(sink.last()!.queueDelayMs).toBe(250)
    expect(sink.last()!.latencyMs).toBe(40)
    expect(debugEvents).toContainEqual({
      payload: expect.objectContaining({ queueDelayMs: 250 }),
      message: 'llm.call.attempt.dispatch',
    })
  })

  it('records queueDelayMs separately from provider-dispatch latency on adapter error', async () => {
    const clock = new FakeClock(1_000)
    const sink = new RecordingSink()
    const adapter: ProviderAdapter = {
      id: 'google',
      async run() {
        clock.advance(30)
        throw new LlmError('upstream failed', { kind: 'server', retryable: true })
      },
    }

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock,
      ids: new FakeIds(),
      rateLimiter: scriptedRateLimiter({ delayMs: 250, clock }),
    })

    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'server' })

    expect(sink.last()!.queueDelayMs).toBe(250)
    expect(sink.last()!.latencyMs).toBe(30)
  })

  it('records zero queueDelayMs for the default no-op limiter', async () => {
    const clock = new FakeClock(1_000)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', makeSuccessResult())],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock,
      ids: new FakeIds(),
    })

    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.queueDelayMs).toBe(0)
    expect(sink.last()!.queueDelayMs).toBe(0)
  })

  it('records latencyMs=0 (not queueDelayMs) when acquire rejects before dispatch', async () => {
    // Regression test: a failure that happens while still queued on
    // rateLimiter.acquire() — i.e. BEFORE adapter.run() is ever invoked —
    // must not report latencyMs as a duplicate of queueDelayMs. Provider-
    // dispatch never started, so latencyMs must be exactly 0.
    const clock = new FakeClock(1_000)
    const sink = new RecordingSink()
    const adapter = new FakeAdapter('google', makeSuccessResult())
    const rejectingLimiter: RateLimiter = {
      async acquire(_key: string, _signal?: AbortSignal): Promise<Release> {
        // Simulate time spent queued before the limiter refuses the call.
        clock.advance(250)
        throw new LlmError('rate limiter refused', {
          kind: 'rate_limited',
          retryable: true,
        })
      },
    }

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      sink,
      clock,
      ids: new FakeIds(),
      rateLimiter: rejectingLimiter,
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('rate_limited')
    // Adapter must never have been called — failure happened before dispatch.
    expect(adapter.calls).toHaveLength(0)

    const record = sink.last()!
    expect(record.queueDelayMs).toBeGreaterThan(0)
    expect(record.queueDelayMs).toBe(250)
    expect(record.latencyMs).toBe(0)
  })

  it('(d) if acquire rejects, the call fails and the adapter is never invoked', async () => {
    const spy = makeSpyLimiter()
    spy.rejectWith = new LlmError('rate limiter refused', {
      kind: 'rate_limited',
      retryable: true,
    })

    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', makeSuccessResult())
    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock,
      ids,
      rateLimiter: spy,
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('rate_limited')
    // Adapter must never have been called.
    expect(adapter.calls).toHaveLength(0)
    // Release must never have been called (acquire never resolved).
    expect(spy.releaseCalls).toBe(0)
  })

  it('(e) timeout during blocked acquire → kind=timeout (not aborted)', async () => {
    // A rate limiter whose acquire() never resolves until the signal aborts.
    // This simulates acquire blocking indefinitely while waiting for a slot.
    const blockingLimiter: RateLimiter = {
      acquire(_key: string, signal?: AbortSignal): Promise<Release> {
        return new Promise<Release>((_resolve, reject) => {
          if (signal === undefined) return
          if (signal.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
            )
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              )
            },
            { once: true },
          )
        })
      },
    }

    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', makeSuccessResult())

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock,
      ids,
      rateLimiter: blockingLimiter,
    })

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          config: { timeoutMs: 20 },
        },
        { auth: TEST_AUTH },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('timeout')
  }, 2_000)

  it('(f) caller-abort during blocked acquire → kind=aborted', async () => {
    // Same blocking limiter as (e).
    const blockingLimiter: RateLimiter = {
      acquire(_key: string, signal?: AbortSignal): Promise<Release> {
        return new Promise<Release>((_resolve, reject) => {
          if (signal === undefined) return
          if (signal.aborted) {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
            )
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
              )
            },
            { once: true },
          )
        })
      },
    }

    const clock = new FakeClock(1_000)
    const ids = new FakeIds()
    const adapter = new FakeAdapter('google', makeSuccessResult())

    const client = createClient({
      adapters: [adapter],
      pricingSources: { google: PRICING },
      modelRegistry: TEST_REGISTRY,
      clock,
      ids,
      rateLimiter: blockingLimiter,
    })

    const ac = new AbortController()
    // Abort shortly after the call starts (blocking in acquire).
    setTimeout(() => ac.abort(), 20)

    const err = await client
      .generate(
        {
          provider: 'google',
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: TEST_AUTH, signal: ac.signal },
      )
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
  }, 2_000)
})
