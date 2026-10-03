/**
 * The call deadline, the sink wait and abort handling, end to end through the
 * engine (R4a audit findings F2, F3, F4, F7, F8, F14, F15, F17).
 *
 * Every test drives fake timers; the engine's default clock is `Date.now`,
 * which the fake timers also move, so deadline arithmetic is exact.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import { retryMiddleware } from './retry.js'
import type {
  AdapterCtx,
  AdapterResult,
  LlmRequest,
  Logger,
  Middleware,
  ProviderAdapter,
  TokenCount,
  TokenCountRequest,
  UsageSink,
} from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
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

/** Follows a promise without awaiting it, so fake timers can be advanced. */
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

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const NEVER = (): Promise<never> => new Promise<never>(() => {})

function recordingLogger(): { logger: Logger; events: string[] } {
  const events: string[] = []
  const at =
    () =>
    (_fields: object, event: string): void => {
      events.push(event)
    }
  return { logger: { info: at(), warn: at(), error: at(), debug: at() }, events }
}

function sleepBefore(ms: number): Middleware {
  return {
    id: 'sleep-before',
    async intercept(req, ctx, next) {
      await sleep(ms)
      return next(req, ctx)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// F2: retry shares the engine's budget; synthetic deadline errors keep the cause
// ---------------------------------------------------------------------------

describe('retry anchors its budget at the start of the call', () => {
  it('a middleware before retry spends budget: the 503 surfaces, not a synthetic timeout', async () => {
    vi.useFakeTimers()
    const failure = new LlmError('overloaded', {
      kind: 'server',
      retryable: true,
      httpStatus: 503,
    })
    const adapter = new FakeAdapter('google', failure)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      sink,
      middleware: [
        sleepBefore(300),
        retryMiddleware({ maxAttempts: 3, baseDelayMs: 800 }, { random: () => 1 }),
      ],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(300)

    // 700 ms are left and a 250 ms window is reserved: an 800 ms back-off
    // cannot be slept. The attempt's own error comes out at once.
    const err = call.error as LlmError
    expect(call.settled).toBe(true)
    expect(err.kind).toBe('server')
    expect(err.httpStatus).toBe(503)
    expect(err.attemptId).toBeDefined()
    expect(adapter.calls).toHaveLength(1)
    expect(sink.records.map((r) => [r.attemptNumber, r.errorKind])).toEqual([
      [1, 'server'],
    ])
  })

  it('a 429 delay that does not fit what the call has left keeps retryAfterMs', async () => {
    vi.useFakeTimers()
    const limited = new LlmError('slow down', {
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 700,
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', limited)],
      modelRegistry: REGISTRY,
      sink,
      middleware: [sleepBefore(500), retryMiddleware({ maxAttempts: 3 })],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(500)

    const err = call.error as LlmError
    expect(err.kind).toBe('rate_limited')
    expect(err.retryAfterMs).toBe(700)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.attemptNumber).toBe(1)
  })

  it('a delay that fits is slept and the retry succeeds inside the budget', async () => {
    vi.useFakeTimers()
    const limited = new LlmError('slow down', {
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 400,
    })
    const adapter = new FakeAdapter('google', [limited, OK])
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      middleware: [
        sleepBefore(100),
        retryMiddleware({ maxAttempts: 3 }, { random: () => 0 }),
      ],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(100 + 400)

    expect(call.value?.text).toBe('ok')
    expect(adapter.calls).toHaveLength(2)
    // The second attempt's window is what the call has left: 1000 - 500.
    expect(adapter.calls[1]?.attemptTimeoutMs).toBe(500)
  })
})

describe('the deadline error carries the last attempt error', () => {
  /** Runs `next()`, then spends `afterMs` more without ever honouring the signal. */
  function slowCleanup(afterMs: number): Middleware {
    return {
      id: 'slow-cleanup',
      async intercept(req, ctx, next) {
        try {
          return await next(req, ctx)
        } catch (e) {
          await sleep(afterMs)
          throw e
        }
      },
    }
  }

  it('surfaces a retryable failure that carries a provider delay, with its own row', async () => {
    vi.useFakeTimers()
    const limited = new LlmError('slow down', {
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 700,
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', limited)],
      modelRegistry: REGISTRY,
      sink,
      middleware: [slowCleanup(10_000)],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1)

    const err = call.error as LlmError
    expect(err.kind).toBe('rate_limited')
    expect(err.retryAfterMs).toBe(700)
    expect(sink.records).toHaveLength(1)
  })

  it('otherwise a timeout whose cause is that failure', async () => {
    vi.useFakeTimers()
    const failure = new LlmError('overloaded', {
      kind: 'server',
      retryable: true,
      httpStatus: 503,
    })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', failure)],
      modelRegistry: REGISTRY,
      sink,
      middleware: [slowCleanup(10_000)],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(1_001)

    const err = call.error as LlmError
    expect(err.kind).toBe('timeout')
    expect(err.retryable).toBe(true)
    expect((err.cause as LlmError).kind).toBe('server')
    expect((err.cause as LlmError).httpStatus).toBe(503)
    // The attempt row and the one synthetic row for the call's final error.
    expect(sink.records.map((r) => [r.attemptNumber, r.errorKind])).toEqual([
      [1, 'server'],
      [2, 'timeout'],
    ])
  })

  it('a middleware that refuses to start an attempt after the deadline still names the last failure', async () => {
    vi.useFakeTimers()
    const failure = new LlmError('overloaded', {
      kind: 'server',
      retryable: true,
      httpStatus: 503,
    })
    let attempts = 0
    const reattempt: Middleware = {
      id: 'reattempt',
      async intercept(req, ctx, next) {
        try {
          return await next(req, ctx)
        } catch {
          await sleep(2_000)
          attempts++
          return next({ ...req, attemptNumber: 2 }, ctx)
        }
      },
    }
    const adapter = new FakeAdapter('google', failure)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      middleware: [reattempt],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(1_001)
    await vi.advanceTimersByTimeAsync(2_000)

    expect((call.error as LlmError).kind).toBe('timeout')
    expect(((call.error as LlmError).cause as LlmError).kind).toBe('server')
    // The orphaned continuation woke after the call ended and dispatched nothing.
    expect(attempts).toBe(1)
    expect(adapter.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// F3: the deadline survives being deferred while an attempt is in flight
// ---------------------------------------------------------------------------

describe('a middleware that hangs after a failed attempt cannot hold the call', () => {
  it('generate settles with a timeout at the deadline and aborts ctx.signal', async () => {
    vi.useFakeTimers()
    let seen: AbortSignal | undefined
    const hangsAfterFailure: Middleware = {
      id: 'hangs',
      async intercept(req, ctx, next) {
        seen = ctx.signal
        try {
          return await next(req, ctx)
        } catch {
          return NEVER()
        }
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 500 })],
      modelRegistry: REGISTRY,
      middleware: [hangsAfterFailure],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(100), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(5)

    expect(call.settled).toBe(true)
    expect((call.error as LlmError).kind).toBe('timeout')
    expect(seen?.aborted).toBe(true)
  })

  it('a well-behaved chain still gets the attempt error through unchanged', async () => {
    vi.useFakeTimers()
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 500 })],
      modelRegistry: REGISTRY,
      sink,
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(100), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(105)

    const err = call.error as LlmError
    expect(err.kind).toBe('timeout')
    expect(err.attemptId).toBeDefined()
    expect(sink.records).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// F4: a billed success is never turned into a timeout
// ---------------------------------------------------------------------------

describe('a slow middleware after next() keeps the billed result', () => {
  function slowAfter(ms: number): Middleware {
    return {
      id: 'slow-after',
      async intercept(req, ctx, next) {
        const result = await next(req, ctx)
        await sleep(ms)
        return result
      },
    }
  }

  it('returns the result with one success row when the post-next work crosses the deadline', async () => {
    vi.useFakeTimers()
    const sink = new RecordingSink()
    const { logger } = recordingLogger()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink,
      logger,
      middleware: [slowAfter(200)],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(100), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(101)

    expect(call.value?.text).toBe('ok')
    expect(sink.records.map((r) => r.status)).toEqual(['ok'])
    await vi.advanceTimersByTimeAsync(500)
    expect(sink.records).toHaveLength(1)
  })

  it('a middleware that hangs after next() cannot hold a billed result past the deadline', async () => {
    vi.useFakeTimers()
    const sink = new RecordingSink()
    const hangs: Middleware = {
      id: 'hangs-after',
      async intercept(req, ctx, next) {
        await next(req, ctx)
        return NEVER()
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink,
      middleware: [hangs],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(100), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(101)

    expect(call.value?.text).toBe('ok')
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.status).toBe('ok')
  })

  it('an attempt that finishes after the timer fired (sink write in flight) keeps its result', async () => {
    vi.useFakeTimers()
    const slowSink: UsageSink = {
      async record() {
        await sleep(150)
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: slowSink,
      sinkTimeoutMs: 5_000,
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(100), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(300)

    expect(call.value?.text).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// F7: a hung sink does not hold the abort or the deadline
// ---------------------------------------------------------------------------

describe('a hung sink does not delay an abort or the deadline', () => {
  const hung: UsageSink = { record: () => NEVER() }

  it('caller abort ends the call one grace period after the abort, not after sinkTimeoutMs', async () => {
    vi.useFakeTimers()
    const { logger, events } = recordingLogger()
    const controller = new AbortController()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 1_000 })],
      modelRegistry: REGISTRY,
      sink: hung,
      sinkTimeoutMs: 1_500,
      logger,
      ids: new FakeIds(),
    })

    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(50)
    controller.abort()
    await vi.advanceTimersByTimeAsync(99)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect((call.error as LlmError).kind).toBe('aborted')
    expect(events).toContain('llm.call.sink.interrupted')
    expect(events).not.toContain('llm.call.sink.timeout')
  })

  it('the deadline is not held either: a billed result returns at timeoutMs plus the grace', async () => {
    vi.useFakeTimers()
    const { logger, events } = recordingLogger()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: hung,
      sinkTimeoutMs: 5_000,
      logger,
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(1_099)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(call.value?.text).toBe('ok')
    expect(events).toContain('llm.call.sink.interrupted')
  })

  it('three failed attempts against a hung sink stay inside timeoutMs plus the grace', async () => {
    vi.useFakeTimers()
    const failure = new LlmError('overloaded', { kind: 'server', retryable: true })
    const client = createClient({
      adapters: [new FakeAdapter('google', failure)],
      modelRegistry: REGISTRY,
      sink: hung,
      sinkTimeoutMs: 5_000,
      middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(1_000), { auth: AUTH }))
    // Each failed attempt waits for the sink for 5 s; the deadline cuts that.
    await vi.advanceTimersByTimeAsync(1_000 + 100 + 10)

    expect(call.settled).toBe(true)
  })

  it('a healthy sink that needs a few ms after an abort still lands its row', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const rows: string[] = []
    const slowish: UsageSink = {
      async record(r) {
        await sleep(30)
        rows.push(r.status)
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 1_000 })],
      modelRegistry: REGISTRY,
      sink: slowish,
      ids: new FakeIds(),
    })

    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.advanceTimersByTimeAsync(40)

    expect((call.error as LlmError).kind).toBe('aborted')
    expect(rows).toEqual(['aborted'])
  })
})

// ---------------------------------------------------------------------------
// F8: timers above 2^31 - 1 ms are rejected
// ---------------------------------------------------------------------------

describe('timer values above 2^31 - 1 are bad_request', () => {
  const MAX = 2_147_483_647

  it('sinkTimeoutMs', () => {
    expect(() =>
      createClient({
        adapters: [new FakeAdapter('google', OK)],
        modelRegistry: REGISTRY,
        sinkTimeoutMs: MAX + 1,
      }),
    ).toThrow(expect.objectContaining({ kind: 'bad_request' }))
    expect(() =>
      createClient({
        adapters: [new FakeAdapter('google', OK)],
        modelRegistry: REGISTRY,
        sinkTimeoutMs: MAX,
      }),
    ).not.toThrow()
  })

  it.each([MAX + 1, 3e9, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'config.timeoutMs %s rejects before the call starts, with no row',
    async (timeoutMs) => {
      const adapter = new FakeAdapter('google', OK)
      const sink = new RecordingSink()
      const client = createClient({
        adapters: [adapter],
        modelRegistry: REGISTRY,
        sink,
        ids: new FakeIds(),
      })

      const err = (await client
        .generate(request(timeoutMs), { auth: AUTH })
        .catch((e: unknown) => e)) as LlmError

      expect(err.kind).toBe('bad_request')
      expect(err.issues?.[0]?.path).toBe('config.timeoutMs')
      expect(adapter.calls).toHaveLength(0)
      expect(sink.records).toHaveLength(0)
    },
  )

  it('config.timeoutMs of exactly 2^31 - 1 is accepted', async () => {
    vi.useFakeTimers()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      ids: new FakeIds(),
    })
    const call = observe(client.generate(request(MAX), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(0)
    expect(call.value?.text).toBe('ok')
  })

  it('countTokens timeoutMs', async () => {
    const adapter: ProviderAdapter = {
      id: 'google',
      run: () => Promise.resolve(OK),
      countTokens: (): Promise<TokenCount> =>
        Promise.resolve({ totalTokens: 1, accuracy: 'exact', raw: null }),
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      ids: new FakeIds(),
    })
    const req: TokenCountRequest = {
      provider: 'google',
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    }
    await expect(
      client.countTokens(req, { auth: AUTH, timeoutMs: MAX + 1 }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(
      client.countTokens(req, { auth: AUTH, timeoutMs: MAX }),
    ).resolves.toMatchObject({ totalTokens: 1 })
  })
})

// ---------------------------------------------------------------------------
// F14: a cooperative middleware that throws the abort reason
// ---------------------------------------------------------------------------

describe('a middleware that rejects with the signal reason is an abort', () => {
  class Cancelled extends Error {
    constructor() {
      super('workflow cancelled')
      this.name = 'Cancelled'
    }
  }

  it('generate: kind aborted, reason kept as cause', async () => {
    vi.useFakeTimers()
    const reason = new Cancelled()
    const controller = new AbortController()
    const waitsForAbort: Middleware = {
      id: 'waits',
      intercept: (_req, ctx) =>
        new Promise((_, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason))
        }),
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      middleware: [waitsForAbort],
      ids: new FakeIds(),
    })

    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(10)
    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(10)

    const err = call.error as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('aborted')
    expect(err.retryable).toBe(false)
    expect(err.cause).toBe(reason)
  })

  it('countTokens: an adapter that throws the reason is aborted too', async () => {
    const reason = new Cancelled()
    const controller = new AbortController()
    const adapter: ProviderAdapter = {
      id: 'google',
      run: () => Promise.resolve(OK),
      countTokens: (_req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount> =>
        new Promise((_, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason))
        }),
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      ids: new FakeIds(),
    })
    const call = client.countTokens(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: AUTH, signal: controller.signal },
    )
    controller.abort(reason)

    const err = (await call.catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('aborted')
    expect(err.cause).toBe(reason)
  })
})

// ---------------------------------------------------------------------------
// F15: an aborted signal never dispatches
// ---------------------------------------------------------------------------

describe('a signal that is already aborted does not dispatch', () => {
  it('generate rejects aborted, calls no adapter and leaves one refusal row', async () => {
    const adapter = new FakeAdapter('google', OK)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      sink,
      ids: new FakeIds(),
    })
    const reason = new Error('stop')
    const controller = new AbortController()
    controller.abort(reason)

    const err = (await client
      .generate(request(), { auth: AUTH, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError

    expect(err.kind).toBe('aborted')
    expect(err.cause).toBe(reason)
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records.map((r) => [r.attemptNumber, r.errorKind])).toEqual([
      [0, 'aborted'],
    ])
  })

  it('an abort that lands between attempts (the middleware ignores it) never dispatches the next attempt', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const adapter = new FakeAdapter('google', OK)
    const abortThenNext: Middleware = {
      id: 'abort-then-next',
      intercept(req, ctx, next) {
        controller.abort()
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      middleware: [abortThenNext],
      ids: new FakeIds(),
    })

    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect((call.error as LlmError).kind).toBe('aborted')
    expect(adapter.calls).toHaveLength(0)
  })

  it('countTokens rejects aborted without calling the adapter', async () => {
    let calls = 0
    const adapter: ProviderAdapter = {
      id: 'google',
      run: () => Promise.resolve(OK),
      countTokens: (): Promise<TokenCount> => {
        calls++
        return Promise.resolve({ totalTokens: 1, accuracy: 'exact', raw: null })
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      ids: new FakeIds(),
    })

    const err = (await client
      .countTokens(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: AUTH, signal: AbortSignal.abort() },
      )
      .catch((e: unknown) => e)) as LlmError

    expect(err.kind).toBe('aborted')
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// F17: the deadline follows the injected clock
// ---------------------------------------------------------------------------

describe('deadline arithmetic uses the injected clock', () => {
  it('time the clock says passed in middleware shrinks the attempt window', async () => {
    const clock = new FakeClock(1_000_000)
    const adapter = new FakeAdapter('google', OK)
    const spendsClockTime: Middleware = {
      id: 'spends',
      intercept(req, ctx, next) {
        clock.advance(400)
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      clock,
      middleware: [spendsClockTime],
      ids: new FakeIds(),
    })

    await client.generate(request(1_000), { auth: AUTH })

    expect(adapter.calls[0]?.attemptTimeoutMs).toBe(600)
  })

  it('ctx.deadlineAt is the call start plus timeoutMs on the clock, and absent without one', async () => {
    const clock = new FakeClock(5_000)
    const seen: Array<number | undefined> = []
    const reads: Middleware = {
      id: 'reads',
      intercept(req, ctx, next) {
        seen.push(ctx.deadlineAt)
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      clock,
      middleware: [reads],
      ids: new FakeIds(),
    })

    await client.generate(request(750), { auth: AUTH })
    await client.generate(request(), { auth: AUTH })

    expect(seen).toEqual([5_750, undefined])
  })

  it('a clock that has already passed the deadline refuses the attempt with a timeout', async () => {
    const clock = new FakeClock(0)
    const adapter = new FakeAdapter('google', OK)
    const sink = new RecordingSink()
    const jump: Middleware = {
      id: 'jump',
      intercept(req, ctx, next) {
        clock.advance(2_000)
        return next(req, ctx)
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      clock,
      sink,
      middleware: [jump],
      ids: new FakeIds(),
    })

    const err = (await client
      .generate(request(1_000), { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError

    expect(err.kind).toBe('timeout')
    expect(adapter.calls).toHaveLength(0)
  })
})
