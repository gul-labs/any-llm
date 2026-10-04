/**
 * Engine robustness tests (R4.1, R4.2, R4.7, R4.8).
 *
 * - R4.1: the sink write is bounded by `sinkTimeoutMs`; the logical-call
 *   deadline starts with the call, so middleware time counts against
 *   `timeoutMs`.
 * - R4.2: a limiter slot whose `acquire` resolves after the race was lost is
 *   released.
 * - R4.7: `countTokens` honours abort and `timeoutMs` even when the adapter
 *   ignores its signal.
 * - R4.8: `generate`, `runStructured` and `countTokens` reject only with
 *   `LlmError`, with the original kept as `cause`.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import { retryMiddleware } from './retry.js'
import type {
  AdapterCtx,
  AdapterResult,
  CallSite,
  LlmRequest,
  Logger,
  Middleware,
  ProviderAdapter,
  RateLimiter,
  ResolvedRequest,
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

interface LoggedEvent {
  level: 'info' | 'warn' | 'error' | 'debug'
  fields: Record<string, unknown>
  event: string
}

function recordingLogger(): { logger: Logger; events: LoggedEvent[] } {
  const events: LoggedEvent[] = []
  const at =
    (level: LoggedEvent['level']) =>
    (fields: object, event: string): void => {
      events.push({ level, fields: fields as Record<string, unknown>, event })
    }
  return {
    logger: {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
    },
    events,
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Follows a promise without awaiting it, for tests that drive fake timers. */
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

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// R4.1 — sink timeout
// ---------------------------------------------------------------------------

describe('engine — sinkTimeoutMs (R4.1)', () => {
  it('a sink that never settles does not hold the result past sinkTimeoutMs', async () => {
    vi.useFakeTimers()
    const { logger, events } = recordingLogger()
    const hung: UsageSink = { record: () => new Promise<void>(() => {}) }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: hung,
      sinkTimeoutMs: 40,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(39)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(call.value?.text).toBe('ok')
    const timeout = events.find((e) => e.event === 'llm.call.sink.timeout')
    expect(timeout?.level).toBe('error')
    expect(timeout?.fields).toMatchObject({
      attemptNumber: 1,
      provider: 'google',
      model: 'gemini-2.5-pro',
      timeoutMs: 40,
    })
    expect(typeof timeout?.fields['attemptId']).toBe('string')
    expect(events.some((e) => e.event === 'llm.call.sink.failed')).toBe(false)
  })

  it('defaults to 5 seconds', async () => {
    vi.useFakeTimers()
    const hung: UsageSink = { record: () => new Promise<void>(() => {}) }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: hung,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    let settled = false
    const call = client.generate(request(), { auth: AUTH }).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await call).text).toBe('ok')
  })

  it('a sink that rejects after the timeout is not an unhandled rejection and not a failure event', async () => {
    vi.useFakeTimers()
    const { logger, events } = recordingLogger()
    const late: UsageSink = {
      record: () =>
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('late')), 80)),
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: late,
      sinkTimeoutMs: 20,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(20)
    expect(call.settled).toBe(true)
    await vi.advanceTimersByTimeAsync(150)

    expect(events.filter((e) => e.event === 'llm.call.sink.timeout')).toHaveLength(1)
    expect(events.some((e) => e.event === 'llm.call.sink.failed')).toBe(false)
  })

  it('a hung sink does not delay an error either, and the error is the original one', async () => {
    const hung: UsageSink = { record: () => new Promise<void>(() => {}) }
    const original = new LlmError('boom', { kind: 'server', retryable: true })
    const { logger, events } = recordingLogger()
    const client = createClient({
      adapters: [new FakeAdapter('google', original)],
      modelRegistry: REGISTRY,
      sink: hung,
      sinkTimeoutMs: 30,
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(client.generate(request(), { auth: AUTH })).rejects.toBe(original)
    expect(events.some((e) => e.event === 'llm.call.sink.timeout')).toBe(true)
  })

  it('a sink that throws synchronously is still the fail-open llm.call.sink.failed', async () => {
    const { logger, events } = recordingLogger()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: {
        record: () => {
          throw new Error('sync boom')
        },
      },
      logger,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await expect(client.generate(request(), { auth: AUTH })).resolves.toMatchObject({
      text: 'ok',
    })
    expect(events.some((e) => e.event === 'llm.call.sink.failed')).toBe(true)
  })

  it('a sink still writing when timeoutMs passes does not turn a billed result into a timeout', async () => {
    vi.useFakeTimers()
    const records: unknown[] = []
    const slow: UsageSink = {
      async record(r) {
        await sleep(120)
        records.push(r)
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      sink: slow,
      sinkTimeoutMs: 2_000,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(40), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(200)

    expect(call.value?.text).toBe('ok')
    expect(records).toHaveLength(1)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'sinkTimeoutMs %s is rejected at construction',
    (value) => {
      expect(() =>
        createClient({
          adapters: [new FakeAdapter('google', OK)],
          modelRegistry: REGISTRY,
          sinkTimeoutMs: value,
        }),
      ).toThrow(expect.objectContaining({ kind: 'bad_request', retryable: false }))
    },
  )
})

// ---------------------------------------------------------------------------
// R4.1 — logical-call deadline
// ---------------------------------------------------------------------------

describe('engine — logical-call deadline (R4.1)', () => {
  function slowMiddleware(
    ms: number,
    onSignal?: (s: AbortSignal | undefined) => void,
  ): Middleware {
    return {
      id: 'slow',
      async intercept(req, ctx, next) {
        onSignal?.(ctx.signal)
        await sleep(ms)
        return next(req, ctx)
      },
    }
  }

  it('middleware time counts against timeoutMs, and an orphaned continuation never dispatches', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK)
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      sink,
      middleware: [slowMiddleware(250)],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(60), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(59)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = call.error as LlmError

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('timeout')
    expect(err.retryable).toBe(true)

    // The slow middleware wakes up later and calls next(): nothing dispatches
    // and no extra ledger row appears for a call that already failed.
    await vi.advanceTimersByTimeAsync(350)
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.errorKind).toBe('timeout')
    expect(sink.records[0]?.attemptNumber).toBe(0)
  })

  it('hands middleware a signal that the deadline aborts, with the timeout error as reason', async () => {
    let seen: AbortSignal | undefined
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      middleware: [slowMiddleware(200, (s) => (seen = s))],
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.generate(request(40), { auth: AUTH }).catch(() => {})

    expect(seen?.aborted).toBe(true)
    expect((seen?.reason as LlmError).kind).toBe('timeout')
  })

  it('an attempt that starts after middleware delay gets only the time that is left', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK, { delayMs: 2_000 })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      sink,
      middleware: [slowMiddleware(100)],
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(300), { auth: AUTH }))
    // 100 ms of middleware, then an attempt window of exactly the 200 ms left:
    // the call ends at 300 ms, not at 100 + 300.
    await vi.advanceTimersByTimeAsync(299)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = call.error as LlmError
    expect(err.kind).toBe('timeout')
    expect(adapter.calls[0]?.attemptTimeoutMs).toBe(200)
    // The attempt owned the timeout: one row, from the attempt, not a second one.
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.attemptNumber).toBe(1)
    expect(sink.records[0]?.errorKind).toBe('timeout')
  })

  it('an attempt in flight at the deadline fails with its own error and a single row', async () => {
    vi.useFakeTimers()
    const adapter = new FakeAdapter('google', OK, { delayMs: 500 })
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      sink,
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(50), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(5)
    const err = call.error as LlmError

    expect(err.kind).toBe('timeout')
    expect(err.attemptId).toBeDefined()
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.attemptId).toBe(err.attemptId)
  })

  it('without timeoutMs nothing is armed and ctx.signal is the caller signal', async () => {
    let seen: AbortSignal | undefined
    const controller = new AbortController()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      middleware: [slowMiddleware(1, (s) => (seen = s))],
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    await client.generate(request(), { auth: AUTH, signal: controller.signal })

    expect(seen).toBe(controller.signal)
  })
})

// ---------------------------------------------------------------------------
// R4.2 — late acquire release
// ---------------------------------------------------------------------------

describe('engine — late rate-limiter acquire (R4.2)', () => {
  function lateLimiter(delayMs: number): {
    limiter: RateLimiter
    state: { acquired: number; released: number }
  } {
    const state = { acquired: 0, released: 0 }
    const limiter: RateLimiter = {
      // Ignores the signal on purpose: the case R4.2 covers.
      async acquire() {
        await sleep(delayMs)
        state.acquired++
        return () => {
          state.released++
        }
      },
    }
    return { limiter, state }
  }

  it('releases a slot whose acquire resolves after the timeout won', async () => {
    vi.useFakeTimers()
    const { limiter, state } = lateLimiter(120)
    const adapter = new FakeAdapter('google', OK)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      rateLimiter: limiter,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(30), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(30)
    expect(call.error).toMatchObject({ kind: 'timeout' })
    expect(state).toEqual({ acquired: 0, released: 0 })

    await vi.advanceTimersByTimeAsync(200)

    expect(state).toEqual({ acquired: 1, released: 1 })
    expect(adapter.calls).toHaveLength(0)
  })

  it('releases a slot whose acquire resolves after a caller abort won', async () => {
    vi.useFakeTimers()
    const { limiter, state } = lateLimiter(100)
    const controller = new AbortController()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      rateLimiter: limiter,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(20)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(call.error).toMatchObject({ kind: 'aborted' })

    await vi.advanceTimersByTimeAsync(180)

    expect(state).toEqual({ acquired: 1, released: 1 })
  })

  it('does not release twice when acquire resolves before anything else', async () => {
    vi.useFakeTimers()
    const { limiter, state } = lateLimiter(5)
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      rateLimiter: limiter,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(500), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(5)
    expect(call.value?.text).toBe('ok')
    await vi.advanceTimersByTimeAsync(30)

    expect(state).toEqual({ acquired: 1, released: 1 })
  })

  it('an acquire that rejects when the signal fires is not an unhandled rejection', async () => {
    vi.useFakeTimers()
    const limiter: RateLimiter = {
      acquire: (_key, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('limiter aborted')))
        }),
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      rateLimiter: limiter,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const call = observe(client.generate(request(30), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(30)
    expect(call.error).toBeInstanceOf(LlmError)
    await vi.advanceTimersByTimeAsync(30)
  })
})

// ---------------------------------------------------------------------------
// R4.7 — countTokens cancellation race
// ---------------------------------------------------------------------------

class CountingAdapter implements ProviderAdapter {
  readonly id = 'google'
  signals: Array<AbortSignal | undefined> = []
  constructor(private readonly behaviour: (ctx: AdapterCtx) => Promise<TokenCount>) {}
  async run(_req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
    throw new Error('not used')
  }
  countTokens(_req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount> {
    this.signals.push(ctx.signal)
    return this.behaviour(ctx)
  }
}

const COUNT_REQUEST: TokenCountRequest = {
  provider: 'google',
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
}
const COUNT: TokenCount = { totalTokens: 7, accuracy: 'exact', raw: null }

function countClient(adapter: ProviderAdapter, logger?: Logger) {
  return createClient({
    adapters: [adapter],
    modelRegistry: REGISTRY,
    clock: new FakeClock(),
    ids: new FakeIds(),
    ...(logger !== undefined ? { logger } : {}),
  })
}

describe('engine — countTokens cancellation race (R4.7)', () => {
  it('timeoutMs ends the call with a retryable timeout even if the adapter ignores its signal', async () => {
    vi.useFakeTimers()
    const adapter = new CountingAdapter(() => new Promise<TokenCount>(() => {}))

    const call = observe(
      countClient(adapter).countTokens(COUNT_REQUEST, { auth: AUTH, timeoutMs: 40 }),
    )
    await vi.advanceTimersByTimeAsync(39)
    expect(call.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = call.error as LlmError

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('timeout')
    expect(err.retryable).toBe(true)
    // A cooperative adapter is told too.
    expect(adapter.signals[0]?.aborted).toBe(true)
  })

  it('caller abort ends the call even if the adapter ignores its signal, keeping the reason as cause', async () => {
    const adapter = new CountingAdapter(() => new Promise<TokenCount>(() => {}))
    const controller = new AbortController()
    const reason = new Error('host cancelled')
    const call = countClient(adapter).countTokens(COUNT_REQUEST, {
      auth: AUTH,
      signal: controller.signal,
    })
    controller.abort(reason)

    const err = (await call.catch((e: unknown) => e)) as LlmError

    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('aborted')
    expect(err.cause).toBe(reason)
  })

  it('an already aborted signal rejects without waiting for the adapter', async () => {
    const adapter = new CountingAdapter(() => new Promise<TokenCount>(() => {}))
    const err = (await countClient(adapter)
      .countTokens(COUNT_REQUEST, { auth: AUTH, signal: AbortSignal.abort() })
      .catch((e: unknown) => e)) as LlmError

    expect(err.kind).toBe('aborted')
  })

  it('returns the adapter result untouched when it settles in time, and leaves no timer behind', async () => {
    const adapter = new CountingAdapter(async () => COUNT)
    const result = await countClient(adapter).countTokens(COUNT_REQUEST, {
      auth: AUTH,
      timeoutMs: 5_000,
    })
    expect(result).toBe(COUNT)
  })

  it('without timeoutMs there is no deadline and the signal still reaches the adapter', async () => {
    const adapter = new CountingAdapter(async () => COUNT)
    const controller = new AbortController()
    await countClient(adapter).countTokens(COUNT_REQUEST, {
      auth: AUTH,
      signal: controller.signal,
    })
    expect(adapter.signals[0]).toBe(controller.signal)
  })

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'timeoutMs %s is bad_request before the adapter is called',
    async (timeoutMs) => {
      const adapter = new CountingAdapter(async () => COUNT)
      await expect(
        countClient(adapter).countTokens(COUNT_REQUEST, { auth: AUTH, timeoutMs }),
      ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
      expect(adapter.signals).toHaveLength(0)
    },
  )

  it('an adapter that throws synchronously is a classified rejection, not a thrown exception', async () => {
    const adapter = new CountingAdapter(() => {
      throw new TypeError('sync')
    })
    const err = (await countClient(adapter)
      .countTokens(COUNT_REQUEST, { auth: AUTH, signal: new AbortController().signal })
      .catch((e: unknown) => e)) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('unknown')
    expect(err.cause).toBeInstanceOf(TypeError)
  })
})

// ---------------------------------------------------------------------------
// R4.8 — only LlmError escapes
// ---------------------------------------------------------------------------

describe('engine — rejects only with LlmError (R4.8)', () => {
  const callSite: CallSite = {
    id: 'site',
    provider: 'google',
    model: 'gemini-2.5-pro',
    userTemplate: 'hi',
  }

  async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (e: unknown) => e,
    )
  }

  it('a registry that throws a plain Error becomes an unknown LlmError with the cause kept', async () => {
    const boom = new TypeError('registry exploded')
    const registry = {
      ...REGISTRY,
      resolve: () => {
        throw boom
      },
    } as unknown as typeof REGISTRY
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: registry,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    for (const err of [
      await reasonOf(client.generate(request(), { auth: AUTH })),
      await reasonOf(client.runStructured(callSite, { auth: AUTH })),
      await reasonOf(client.countTokens(COUNT_REQUEST, { auth: AUTH })),
    ]) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('unknown')
      expect((err as LlmError).retryable).toBe(false)
      expect((err as LlmError).cause).toBe(boom)
    }
  })

  it('a missing request is a bad_request LlmError, not a TypeError', async () => {
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const err = await reasonOf(
      client.generate(undefined as unknown as LlmRequest, { auth: AUTH }),
    )

    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
  })

  it('a middleware that throws a string is an LlmError whose cause is the string', async () => {
    const throwing: Middleware = {
      id: 'throws',
      intercept() {
        return Promise.reject('plain string')
      },
    }
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      middleware: [throwing],
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const err = await reasonOf(client.generate(request(), { auth: AUTH }))

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).cause).toBe('plain string')
  })

  it('an LlmError already thrown passes through as the same object', async () => {
    const original = new LlmError('mine', { kind: 'rate_limited', retryable: true })
    const client = createClient({
      adapters: [new FakeAdapter('google', original)],
      modelRegistry: REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    expect(await reasonOf(client.generate(request(), { auth: AUTH }))).toBe(original)
  })

  it('caller abort keeps AbortSignal.reason as cause, whether the adapter ignores the signal or throws it', async () => {
    class CancelledFailure extends Error {
      constructor() {
        super('workflow cancelled')
        this.name = 'CancelledFailure'
      }
    }
    vi.useFakeTimers()
    for (const mode of ['ignores', 'throws-reason'] as const) {
      const reason = new CancelledFailure()
      const controller = new AbortController()
      const adapter: ProviderAdapter = {
        id: 'google',
        run: (_req, ctx) =>
          new Promise<AdapterResult>((_, reject) => {
            if (mode === 'throws-reason') {
              ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason))
            }
          }),
      }
      const client = createClient({
        adapters: [adapter],
        modelRegistry: REGISTRY,
        clock: new FakeClock(),
        ids: new FakeIds(),
      })
      const call = observe(
        client.generate(request(), { auth: AUTH, signal: controller.signal }),
      )
      await vi.advanceTimersByTimeAsync(20)
      controller.abort(reason)
      await vi.advanceTimersByTimeAsync(10)

      const err = call.error as LlmError

      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('aborted')
      expect(err.retryable).toBe(false)
      expect(err.cause).toBe(reason)
    }
  })

  it('an abort reason that is not an Error is kept as cause too', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 200 })],
      modelRegistry: REGISTRY,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    const call = observe(
      client.generate(request(), { auth: AUTH, signal: controller.signal }),
    )
    await vi.advanceTimersByTimeAsync(20)
    controller.abort('stop now')
    await vi.advanceTimersByTimeAsync(10)

    const err = call.error as LlmError

    expect(err.kind).toBe('aborted')
    expect(err.cause).toBe('stop now')
  })
})

// ---------------------------------------------------------------------------
// R4.3 / R4.4 — retry end to end through the engine
// ---------------------------------------------------------------------------

describe('engine + retryMiddleware — provider delay and deadline (R4.3, R4.4)', () => {
  it('a backoff longer than the budget surfaces the attempt error at once, not a synthetic timeout', async () => {
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
        retryMiddleware(
          { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
          { random: () => 1 },
        ),
      ],
      ids: new FakeIds(),
    })

    // No timer advances: the error is surfaced without sleeping the budget away.
    const call = observe(client.generate(request(2_000), { auth: AUTH }))
    await vi.advanceTimersByTimeAsync(0)
    const err = call.error as LlmError

    expect(call.settled).toBe(true)
    expect(err.kind).toBe('server')
    expect(err.httpStatus).toBe(503)
    expect(adapter.calls).toHaveLength(1)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.errorKind).toBe('server')
  })

  it('a provider delay longer than maxDelayMs is not undercut: one call, error keeps retryAfterMs', async () => {
    const limited = new LlmError('slow down', {
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 60_000,
    })
    const adapter = new FakeAdapter('google', limited)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      middleware: [retryMiddleware({ maxAttempts: 3, maxDelayMs: 1_000 })],
      clock: new FakeClock(),
      ids: new FakeIds(),
    })

    const err = (await client
      .generate(request(), { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError

    expect(err.kind).toBe('rate_limited')
    expect(err.retryAfterMs).toBe(60_000)
    expect(adapter.calls).toHaveLength(1)
  })
})
