/**
 * `ClientConfig.scheduler` (R8.2): the engine's timeout, deadline and sink
 * waits, `retryMiddleware`'s back-off and `FakeAdapter`'s delay all run on one
 * injected scheduler. Every test advances a `FakeClock`; no real timer is
 * created or waited on.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient, createModelRegistry, retryMiddleware } from './index.js'
import type { AdapterResult, LlmRequest, ProviderAdapter, UsageSink } from './index.js'
import {
  FakeAdapter,
  FakeClock,
  FakeIds,
  RecordingLogger,
  RecordingSink,
  fakeHttpError,
} from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
])
const AUTH = { apiKey: 'test-key' }

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  model: 'gemini-2.5-pro',
  warnings: [],
}

function request(timeoutMs?: number): LlmRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    ...(timeoutMs !== undefined ? { config: { timeoutMs } } : {}),
  }
}

/** Follows a promise without awaiting it, so the clock can be advanced. */
function observe<T>(promise: Promise<T>): {
  settled: boolean
  value?: T
  error?: unknown
} {
  const o: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  void promise.then(
    (v) => {
      o.settled = true
      o.value = v
    },
    (e: unknown) => {
      o.settled = true
      o.error = e
    },
  )
  return o
}

describe('engine timers on ClientConfig.scheduler', () => {
  it('a provider slower than timeoutMs times out when the fake clock passes it', async () => {
    const clock = new FakeClock(1_000)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 60_000 })],
      modelRegistry: REGISTRY,
      sink,
      ids: new FakeIds(),
      clock,
      scheduler: clock,
    })
    const call = observe(client.generate(request(30_000), { auth: AUTH }))

    await clock.advanceAsync(29_999)
    expect(call.settled).toBe(false)
    await clock.advanceAsync(1)

    expect(call.settled).toBe(true)
    expect(call.error).toMatchObject({ kind: 'timeout', retryable: true })
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({ status: 'timeout', errorKind: 'timeout' })
    // The attempt timer and the call deadline are done. What remains is the
    // adapter's own delay: FakeAdapter does not honour the abort signal.
    expect(clock.pendingTimers).toBe(1)
    await clock.advanceAsync(30_000)
    expect(clock.pendingTimers).toBe(0)
  })

  it('a fast provider returns without the clock moving, and leaves no timer behind', async () => {
    const clock = new FakeClock()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
    })

    const result = await client.generate(request(30_000), { auth: AUTH })

    expect(result.text).toBe('ok')
    expect(clock.pendingTimers).toBe(0)
  })

  it('countTokens timeoutMs runs on the scheduler too', async () => {
    const clock = new FakeClock()
    const hang: ProviderAdapter = {
      id: 'google',
      run: () => Promise.reject(new Error('unused')),
      countTokens: () => new Promise(() => {}),
    }
    const client = createClient({
      adapters: [hang],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
    })
    const count = observe(
      client.countTokens(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: AUTH, timeoutMs: 2_000 },
      ),
    )

    await clock.advanceAsync(1_999)
    expect(count.settled).toBe(false)
    await clock.advanceAsync(1)
    expect(count.error).toMatchObject({ kind: 'timeout' })
    expect(clock.pendingTimers).toBe(0)
  })

  it('a hung sink is abandoned at sinkTimeoutMs on the scheduler', async () => {
    const clock = new FakeClock()
    const logger = new RecordingLogger()
    const hungSink: UsageSink = { record: () => new Promise<void>(() => {}) }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: hungSink,
      sinkTimeoutMs: 5_000,
      logger,
      clock,
      scheduler: clock,
    })
    const call = observe(client.generate(request(), { auth: AUTH }))

    await clock.advanceAsync(4_999)
    expect(call.settled).toBe(false)
    await clock.advanceAsync(1)

    expect(call.settled).toBe(true)
    expect(call.value).toMatchObject({ text: 'ok' })
    expect(logger.messages('error')).toContain('llm.call.sink.timeout')
  })
})

describe('retryMiddleware sleeps on ctx.scheduler', () => {
  it('waits the back-off on the fake clock, then retries', async () => {
    const clock = new FakeClock()
    const adapter = new FakeAdapter('google', [fakeHttpError(503), OK])
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      middleware: [retryMiddleware({ baseDelayMs: 1_000 }, { random: () => 0.999 })],
    })
    const call = observe(client.generate(request(), { auth: AUTH }))

    await clock.advanceAsync(0)
    expect(adapter.calls).toHaveLength(1)
    // random() = 0.999 over a 1000 ms ceiling: about 999 ms of back-off.
    await clock.advanceAsync(998)
    expect(adapter.calls).toHaveLength(1)
    expect(call.settled).toBe(false)
    await clock.advanceAsync(2)

    expect(adapter.calls).toHaveLength(2)
    expect(call.settled).toBe(true)
    expect(call.value).toMatchObject({ text: 'ok' })
  })

  it('a provider retry-after is waited out on the clock, and the deadline is not passed', async () => {
    const clock = new FakeClock()
    const adapter = new FakeAdapter('google', [fakeHttpError(429, { retryAfter: 2 }), OK])
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      middleware: [retryMiddleware({ baseDelayMs: 10 }, { random: () => 0 })],
    })
    const call = observe(client.generate(request(10_000), { auth: AUTH }))

    await clock.advanceAsync(1_999)
    expect(adapter.calls).toHaveLength(1)
    await clock.advanceAsync(1)
    expect(adapter.calls).toHaveLength(2)
    expect(call.value).toMatchObject({ text: 'ok' })
    expect(clock.pendingTimers).toBe(0)
  })

  it('an abort during the back-off ends it without advancing the clock', async () => {
    const clock = new FakeClock()
    const controller = new AbortController()
    const client = createClient({
      adapters: [new FakeAdapter('google', [fakeHttpError(503), OK])],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      middleware: [retryMiddleware({ baseDelayMs: 60_000 }, { random: () => 1 })],
    })
    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await clock.advanceAsync(0)
    expect(clock.pendingTimers).toBe(1)

    controller.abort()
    await clock.advanceAsync(0)

    expect(call.error).toMatchObject({ kind: 'aborted' })
    expect(clock.pendingTimers).toBe(0)
  })
})
