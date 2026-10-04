/**
 * Engine hardening: host callbacks that reject, hostile host input, shared
 * error objects, and the bookkeeping edges around them.
 *
 * - A host callback typed `=> void` may be `async`: its rejection must never
 *   become an unhandled rejection (a process crash on Node's default).
 * - `requireAuth` never echoes a credential into an error message.
 * - `buildRecord` is total over host JSON: a billed call always gets a row.
 * - An error object a host shares across calls is never re-stamped or thrown
 *   with another call's ids.
 * - A bad `signal` leaves no timer behind and still writes a refusal row.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { createClient, createModelRegistry, LlmError } from './index.js'
import type {
  AdapterCtx,
  AdapterResult,
  ClientConfig,
  LlmCallRecord,
  LlmRequest,
  Logger,
  Middleware,
  ProviderAdapter,
  RateLimiter,
  Release,
  Telemetry,
  TokenCountRequest,
  UsageSink,
} from './index.js'
import { retryMiddleware } from './retry.js'
import { spendPreflightMiddleware } from './spend-preflight.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const AUTH = { apiKey: 'test-key' }

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  model: 'm',
  warnings: [],
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    provider: 'p',
    model: 'm',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    ...overrides,
  }
}

const registry = (
  descriptor = makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
) => createModelRegistry([descriptor])

function build(
  extra: Partial<ClientConfig> = {},
  entries: Array<AdapterResult | Error> = [OK],
) {
  const sink = new RecordingSink()
  const adapter = new FakeAdapter('p', entries as AdapterResult[])
  const client = createClient({
    adapters: [adapter],
    modelRegistry: registry(),
    sink,
    ids: new FakeIds(),
    ...extra,
  })
  return { sink, adapter, client }
}

const warningMessages = (row: LlmCallRecord | undefined): string[] =>
  ((row?.warnings ?? []) as unknown as Array<{ message: string }>).map((w) => w.message)

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Runs `run`, waits a few real turns, and returns every unhandled rejection seen. */
async function unhandledDuring(run: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = []
  const on = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', on)
  try {
    await run().catch(() => {})
    await realSleep(30)
  } finally {
    process.off('unhandledRejection', on)
  }
  return seen
}

const rejects = (): Promise<never> => Promise.reject(new Error('boom'))
const asyncThrow = async (): Promise<never> => {
  await Promise.resolve()
  throw new Error('boom')
}

// ---------------------------------------------------------------------------
// P1-1: async host callbacks
// ---------------------------------------------------------------------------

describe('P1-1: a host callback that returns a rejecting promise is never an unhandled rejection', () => {
  const asyncTelemetry = (): Telemetry => ({
    onStart: asyncThrow,
    onAttempt: asyncThrow,
    onSuccess: asyncThrow,
    onError: asyncThrow,
  })
  const asyncLogger = (): Logger => ({
    info: asyncThrow as unknown as Logger['info'],
    warn: asyncThrow as unknown as Logger['warn'],
    error: asyncThrow as unknown as Logger['error'],
    debug: asyncThrow as unknown as Logger['debug'],
  })

  it('telemetry hooks on a successful call', async () => {
    const { client } = build({ telemetry: asyncTelemetry() })
    const seen = await unhandledDuring(() => client.generate(request(), { auth: AUTH }))
    expect(seen).toEqual([])
  })

  it('telemetry hooks on a failed call', async () => {
    const { client } = build({ telemetry: asyncTelemetry() }, [
      new LlmError('no', { kind: 'bad_request', retryable: false }),
    ])
    const seen = await unhandledDuring(() => client.generate(request(), { auth: AUTH }))
    expect(seen).toEqual([])
  })

  it('logger methods', async () => {
    const { client } = build({ logger: asyncLogger() }, [OK])
    const seen = await unhandledDuring(async () => {
      await client.generate(request(), { auth: AUTH })
      await client.generate(request({ model: 'nope' }), { auth: AUTH }).catch(() => {})
    })
    expect(seen).toEqual([])
  })

  it('a logger whose every method throws and rejects does not recurse and is quiet', async () => {
    let calls = 0
    const hostile: Logger = {
      info: () => {
        calls += 1
        return rejects() as unknown as void
      },
      warn: () => {
        calls += 1
        throw new Error('sync')
      },
      error: () => {
        calls += 1
        return rejects() as unknown as void
      },
      debug: () => {
        calls += 1
        return rejects() as unknown as void
      },
    }
    const { client } = build({ logger: hostile, telemetry: asyncTelemetry() })
    const seen = await unhandledDuring(() => client.generate(request(), { auth: AUTH }))
    expect(seen).toEqual([])
    // A bounded number of calls: no failure of the logger logs another failure forever.
    expect(calls).toBeLessThan(60)
  })

  it('logs one stable llm.hook.failed per failed hook, with the phase', async () => {
    const events: Array<{
      level: string
      event: string
      fields: Record<string, unknown>
    }> = []
    const at =
      (level: string) =>
      (fields: object, event: string): void => {
        events.push({ level, event, fields: fields as Record<string, unknown> })
      }
    const logger: Logger = {
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      debug: at('debug'),
    }
    const { client } = build({
      logger,
      telemetry: {
        onSuccess: asyncThrow,
        onAttempt() {
          throw new Error('sync boom')
        },
      },
    })
    await client.generate(request(), { auth: AUTH })
    await realSleep(10)
    const failed = events.filter((e) => e.event === 'llm.hook.failed')
    expect(failed.map((e) => e.fields['phase']).sort()).toEqual([
      'onAttempt',
      'onSuccess',
    ])
    expect(JSON.stringify(failed)).not.toContain('llm.telemetry.hook.failed')
  })

  it('onStart keeps its (rejecting) span for the other hooks and stays handled', async () => {
    const spans: unknown[] = []
    const { client } = build({
      telemetry: {
        onStart: asyncThrow,
        onSuccess(_e, span) {
          spans.push(span)
        },
      },
    })
    const seen = await unhandledDuring(() => client.generate(request(), { auth: AUTH }))
    expect(seen).toEqual([])
    expect(spans).toHaveLength(1)
    await expect(spans[0]).rejects.toThrow('boom')
  })

  it('Release on the success path, the failure path and the late path', async () => {
    const limiter: RateLimiter = {
      acquire: () => Promise.resolve(asyncThrow as unknown as Release),
    }
    const ok = build({ rateLimiter: limiter })
    const seenOk = await unhandledDuring(() =>
      ok.client.generate(request(), { auth: AUTH }),
    )
    expect(seenOk).toEqual([])

    const failing = build({ rateLimiter: limiter }, [
      new LlmError('no', { kind: 'bad_request', retryable: false }),
    ])
    const seenFail = await unhandledDuring(() =>
      failing.client.generate(request(), { auth: AUTH }),
    )
    expect(seenFail).toEqual([])

    const late: RateLimiter = {
      acquire: async () => {
        await realSleep(20)
        return asyncThrow as unknown as Release
      },
    }
    const timed = build({ rateLimiter: late })
    const seenLate = await unhandledDuring(() =>
      timed.client.generate(request({ config: { timeoutMs: 5 } }), { auth: AUTH }),
    )
    expect(seenLate).toEqual([])
  })

  it('sink.record that rejects, now or after the sink timeout', async () => {
    const now: UsageSink = { record: asyncThrow }
    const seenNow = await unhandledDuring(() =>
      build({ sink: now }).client.generate(request(), { auth: AUTH }),
    )
    expect(seenNow).toEqual([])

    const later: UsageSink = {
      record: async () => {
        await realSleep(30)
        throw new Error('late boom')
      },
    }
    const seenLater = await unhandledDuring(() =>
      build({ sink: later, sinkTimeoutMs: 5 }).client.generate(request(), { auth: AUTH }),
    )
    expect(seenLater).toEqual([])
  })

  it('payloads.include and payloads.redact that reject', async () => {
    const seen = await unhandledDuring(async () => {
      await build({ payloads: { include: asyncThrow as never } }).client.generate(
        request(),
        { auth: AUTH },
      )
      await build({ payloads: { redact: asyncThrow as never } }).client.generate(
        request(),
        { auth: AUTH },
      )
    })
    expect(seen).toEqual([])
  })

  it('spentSoFar and a config validator that reject', async () => {
    const spend = spendPreflightMiddleware({
      key: 'k',
      limitMicroUsd: 10,
      spentSoFar: asyncThrow,
    })
    const seen = await unhandledDuring(async () => {
      await build({ middleware: [spend] }).client.generate(request(), { auth: AUTH })
    })
    expect(seen).toEqual([])

    const descriptor = makePermissiveTestDescriptor({ model: 'm', provider: 'p' })
    const rejecting = {
      ...descriptor,
      validateConfig: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: () => rejects(),
        },
      },
    }
    const seenValidator = await unhandledDuring(() =>
      build({ modelRegistry: registry(rejecting as never) }).client.generate(request(), {
        auth: AUTH,
      }),
    )
    expect(seenValidator).toEqual([])
  })

  it('retry shouldRetry that returns a rejecting promise', async () => {
    const mw = retryMiddleware({ shouldRetry: asyncThrow as never })
    const { client } = build({ middleware: [mw] }, [
      new LlmError('s', { kind: 'server', retryable: true }),
    ])
    let error: unknown
    const seen = await unhandledDuring(async () => {
      error = await client.generate(request(), { auth: AUTH }).catch((e: unknown) => e)
    })
    expect(seen).toEqual([])
    expect(error).toMatchObject({ kind: 'bad_request', retryable: false })
    expect((error as LlmError).message).toContain('shouldRetry must return a boolean')
  })

  it('a scheduler whose clearTimeout throws does not break the call', async () => {
    const clock = new FakeClock()
    const { client } = build({
      clock,
      scheduler: {
        setTimeout: clock.setTimeout,
        clearTimeout: () => {
          throw new Error('clear boom')
        },
      },
    })
    await expect(
      client.generate(request({ config: { timeoutMs: 1000 } }), { auth: AUTH }),
    ).resolves.toMatchObject({ text: 'ok' })
  })
})

// ---------------------------------------------------------------------------
// P2-1: requireAuth never echoes the credential
// ---------------------------------------------------------------------------

describe('P2-1: a malformed auth is invalid_auth and never echoes the value', () => {
  const SECRET = 'AIzaSySECRETKEY1234567890'
  it.each([
    ['a string', SECRET],
    ['null', null],
    ['a number', 12345],
    ['an array', [SECRET]],
    ['an object with a non-string apiKey', { apiKey: 12345 }],
  ])('generate with %s', async (_label, auth) => {
    const { client, sink } = build()
    const err = (await client
      .generate(request(), { auth: auth as never })
      .catch((e: unknown) => e)) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('invalid_auth')
    expect(err.retryable).toBe(false)
    expect(err.message).not.toContain(SECRET)
    expect(String(err.cause ?? '')).not.toContain(SECRET)
    expect(sink.records).toHaveLength(0)
  })

  it('runStructured and countTokens reject a string auth the same way', async () => {
    const adapter: ProviderAdapter = {
      ...new FakeAdapter('p', [OK]),
      id: 'p',
      run: () => Promise.resolve(OK),
      countTokens: () =>
        Promise.resolve({ totalTokens: 1, accuracy: 'exact', raw: null }),
    }
    const client = createClient({ adapters: [adapter], modelRegistry: registry() })
    const site = {
      id: 's',
      provider: 'p',
      model: 'm',
      userTemplate: 'hi',
    }
    const a = (await client
      .runStructured(site as never, { auth: SECRET as never })
      .catch((e: unknown) => e)) as LlmError
    expect(a).toMatchObject({ kind: 'invalid_auth' })
    expect(a.message).not.toContain(SECRET)
    const b = (await client
      .countTokens(
        { provider: 'p', model: 'm', messages: request().messages } as TokenCountRequest,
        { auth: SECRET as never },
      )
      .catch((e: unknown) => e)) as LlmError
    expect(b).toMatchObject({ kind: 'invalid_auth' })
    expect(b.message).not.toContain(SECRET)
  })
})

// ---------------------------------------------------------------------------
// P2-2: buildRecord is total over host JSON
// ---------------------------------------------------------------------------

describe('P2-2: hostile metadata never costs a billed result its ledger row', () => {
  const circular = (): Record<string, never> => {
    const meta: Record<string, unknown> = { a: 1 }
    meta['self'] = meta
    return meta as never
  }
  const deep = (): Record<string, never> => {
    const root: Record<string, unknown> = {}
    let node = root
    for (let i = 0; i < 100_000; i += 1) {
      const next: Record<string, unknown> = {}
      node['n'] = next
      node = next
    }
    return root as never
  }
  const throwing = (): Record<string, never> => {
    const meta: Record<string, unknown> = { ok: 1 }
    Object.defineProperty(meta, 'bad', {
      enumerable: true,
      get() {
        throw new Error('getter boom')
      },
    })
    return meta as never
  }

  it.each([
    ['circular', circular],
    ['100000 levels deep', deep],
    ['a throwing getter', throwing],
  ])(
    'success with %s metadata still writes a row and returns the result',
    async (_l, make) => {
      const { client, sink, adapter } = build()
      const result = await client.generate(request({ metadata: make() }), { auth: AUTH })
      expect(result.text).toBe('ok')
      expect(adapter.calls).toHaveLength(1)
      expect(sink.records).toHaveLength(1)
      const row = sink.records[0] as LlmCallRecord
      expect(row.status).toBe('ok')
      expect(JSON.stringify(row.metadata).length).toBeGreaterThan(0)
      expect(warningMessages(row).some((m) => m.includes('metadata'))).toBe(true)
    },
  )

  it('a failure with circular metadata still writes its row and fires onError', async () => {
    const errors: string[] = []
    const { client, sink } = build(
      {
        telemetry: {
          onError(e) {
            errors.push(e.errorKind)
          },
        },
      },
      [new LlmError('no', { kind: 'bad_request', retryable: false })],
    )
    const err = (await client
      .generate(request({ metadata: circular() }), { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ kind: 'bad_request' })
    expect(sink.records).toHaveLength(1)
    expect(errors).toEqual(['bad_request'])
  })

  it('a refusal row (no attempt ran) with circular metadata is still written', async () => {
    const refuse: Middleware = {
      id: 'refuse',
      intercept: () =>
        Promise.reject(
          new LlmError('refused', { kind: 'rate_limited', retryable: false }),
        ),
    }
    const errors: string[] = []
    const { client, sink } = build({
      middleware: [refuse],
      telemetry: {
        onError(e) {
          errors.push(e.errorKind)
        },
      },
    })
    await expect(
      client.generate(request({ metadata: circular() }), { auth: AUTH }),
    ).rejects.toMatchObject({ kind: 'rate_limited' })
    expect(sink.records).toHaveLength(1)
    expect(errors).toEqual(['rate_limited'])
  })

  it('ordinary metadata is stored unchanged and without a metadata warning', async () => {
    const { client, sink } = build()
    const metadata = { tenant: 't1', nested: { n: [1, 2, { x: true }] } }
    await client.generate(request({ metadata }), { auth: AUTH })
    const row = sink.records[0] as LlmCallRecord
    expect(row.metadata).toEqual(metadata)
    expect(warningMessages(row).some((m) => m.includes('ledger record'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P2-3: shared error objects
// ---------------------------------------------------------------------------

describe('P2-3: a host error object shared across calls is never re-stamped', () => {
  it('a shared LlmError abort reason: each call throws its own copy with its own ids and writes its own refusal row', async () => {
    const reason = new LlmError('shutting down', { kind: 'aborted', retryable: false })
    const { client, sink } = build()
    const controller = new AbortController()
    controller.abort(reason)
    const first = (await client
      .generate(request(), { auth: AUTH, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError
    const second = (await client
      .generate(request(), { auth: AUTH, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError
    expect(reason.callId).toBeUndefined()
    expect(reason.attemptId).toBeUndefined()
    expect(first).not.toBe(reason)
    expect(second).not.toBe(reason)
    expect(second).not.toBe(first)
    expect(first).toMatchObject({ kind: 'aborted', message: 'shutting down' })
    expect(first.cause).toBe(reason)
    expect(second.callId).not.toBe(first.callId)
    expect(sink.records).toHaveLength(2)
    expect(sink.records.map((r) => r.callId)).toEqual([first.callId, second.callId])
  })

  it('a second call aborted with the same reason after a first that ran does not inherit the first call ids', async () => {
    const reason = new LlmError('shutting down', { kind: 'aborted', retryable: false })
    const { client, sink } = build({}, [OK, OK])
    const first = new AbortController()
    first.abort(reason)
    const a = (await client
      .generate(request(), { auth: AUTH, signal: first.signal })
      .catch((e: unknown) => e)) as LlmError
    // An unrelated call that runs to completion in between.
    await client.generate(request(), { auth: AUTH })
    const second = new AbortController()
    second.abort(reason)
    const b = (await client
      .generate(request(), { auth: AUTH, signal: second.signal })
      .catch((e: unknown) => e)) as LlmError
    expect(b.callId).not.toBe(a.callId)
    expect(b.attemptId).toBeUndefined()
    // Two refusal rows and one real row: nothing was skipped for a stale attempt id.
    expect(sink.records).toHaveLength(3)
    expect(sink.records.filter((r) => r.attemptNumber === 0)).toHaveLength(2)
  })

  it('an adapter that throws the same LlmError object every call: the second call throws its own ids', async () => {
    const shared = new LlmError('limit', { kind: 'bad_request', retryable: false })
    const { client, sink } = build({}, [shared, shared])
    const a = (await client
      .generate(request(), { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError
    const b = (await client
      .generate(request(), { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError
    expect(a.callId).toBe(sink.records[0]?.callId)
    expect(b.callId).toBe(sink.records[1]?.callId)
    expect(b.attemptId).toBe(sink.records[1]?.attemptId)
    expect(b.callId).not.toBe(a.callId)
  })
})

// ---------------------------------------------------------------------------
// P2-5: a bad signal arms nothing
// ---------------------------------------------------------------------------

describe('P2-5: an invalid signal is refused before any timer is armed', () => {
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'abort'],
  ])('timeoutMs set, signal %s', async (_label, signal) => {
    const clock = new FakeClock()
    const errors: string[] = []
    const { client, sink, adapter } = build({
      clock,
      scheduler: clock,
      telemetry: {
        onError(e) {
          errors.push(e.errorKind)
        },
      },
    })
    const err = (await client
      .generate(request({ config: { timeoutMs: 5000 } }), {
        auth: AUTH,
        signal: signal as never,
      })
      .catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect(err.issues?.[0]?.path).toBe('signal')
    expect(clock.pendingTimers).toBe(0)
    expect(adapter.calls).toHaveLength(0)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]?.errorKind).toBe('bad_request')
    expect(errors).toEqual(['bad_request'])
  })

  it('without timeoutMs the same bad signal takes the same path', async () => {
    const { client, sink } = build()
    await expect(
      client.generate(request(), { auth: AUTH, signal: {} as never }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(sink.records).toHaveLength(1)
  })

  it('countTokens refuses it too, with no timer left', async () => {
    const clock = new FakeClock()
    const adapter: ProviderAdapter = {
      id: 'p',
      run: () => Promise.resolve(OK),
      countTokens: () =>
        Promise.resolve({ totalTokens: 1, accuracy: 'exact', raw: null }),
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registry(),
      clock,
      scheduler: clock,
    })
    await expect(
      client.countTokens(
        { provider: 'p', model: 'm', messages: request().messages } as TokenCountRequest,
        { auth: AUTH, signal: {} as never, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(clock.pendingTimers).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P3s
// ---------------------------------------------------------------------------

describe('P3-1: a billed failure keeps its usage-clamp warnings on the row', () => {
  it('cachedInputTokens above inputTokens is clamped and the warning is on the row', async () => {
    const billed = new LlmError('billed', {
      kind: 'server',
      retryable: false,
      usage: {
        inputTokens: 5,
        outputTokens: 1,
        cachedInputTokens: 50,
        details: {},
        raw: null,
      },
    })
    const { client, sink } = build({}, [billed])
    await expect(client.generate(request(), { auth: AUTH })).rejects.toBeInstanceOf(
      LlmError,
    )
    const row = sink.records[0] as LlmCallRecord
    expect(row.cachedInputTokens).toBe(5)
    expect(warningMessages(row).length).toBeGreaterThan(0)
  })
})

describe('P3-2: the call id is the engine’s own, whatever a middleware passes down', () => {
  it('next(req, { ...ctx, callId }) cannot change the id on the result, row or attempt event', async () => {
    const swap: Middleware = {
      id: 'swap',
      intercept: (req, ctx, next) => next(req, { ...ctx, callId: 'other-call' }),
    }
    const attemptIds: string[] = []
    const { client, sink } = build({
      middleware: [swap],
      telemetry: {
        onAttempt(e) {
          attemptIds.push(e.callId)
        },
      },
    })
    const result = await client.generate(request(), { auth: AUTH })
    expect(result.callId).not.toBe('other-call')
    expect(sink.records[0]?.callId).toBe(result.callId)
    expect(attemptIds).toEqual([result.callId])
  })
})

describe('P3-3: payload building does not hang on a manual scheduler', () => {
  it('a 4 MB inline media part with a FakeClock scheduler finishes', async () => {
    const clock = new FakeClock()
    const bytes = Buffer.alloc(4 * 1024 * 1024, 5)
    const { client, sink } = build({ clock, scheduler: clock, payloads: {} })
    const done = client.generate(
      request({
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'inline-media',
                mimeType: 'video/mp4',
                data: bytes.toString('base64'),
              },
            ],
          },
        ],
      }),
      { auth: AUTH },
    )
    const winner = await Promise.race([
      done.then(() => 'done' as const),
      realSleep(8000).then(() => 'hung' as const),
    ])
    expect(winner).toBe('done')
    expect(sink.payloads.size).toBe(1)
  }, 15_000)
})

describe('P3-4: countTokens hands the adapter the scheduler', () => {
  it('AdapterCtx.scheduler is the client scheduler', async () => {
    const clock = new FakeClock()
    let seen: AdapterCtx | undefined
    const adapter: ProviderAdapter = {
      id: 'p',
      run: () => Promise.resolve(OK),
      countTokens: (_req, ctx) => {
        seen = ctx
        return Promise.resolve({ totalTokens: 1, accuracy: 'exact', raw: null })
      },
    }
    const client = createClient({
      adapters: [adapter],
      modelRegistry: registry(),
      clock,
      scheduler: clock,
    })
    await client.countTokens(
      { provider: 'p', model: 'm', messages: request().messages } as TokenCountRequest,
      { auth: AUTH },
    )
    expect(seen?.scheduler).toBe(clock)
  })
})

describe('P3-5: the shutdown advisory is kept for a call that produced a result', () => {
  it('a first call that fails after the advisory was chosen does not use it up', async () => {
    const descriptor = makePermissiveTestDescriptor({
      model: 'm',
      provider: 'p',
      shutdownDate: '2026-10-10',
    })
    const unclonable: AdapterResult = {
      ...OK,
      toolCalls: [{ toolCallId: 'c', toolName: 't', args: { f: () => 1 } as never }],
    }
    const clock = new FakeClock(Date.parse('2026-10-03T00:00:00Z'))
    const { client } = build(
      { modelRegistry: registry(descriptor), clock, scheduler: clock },
      [unclonable, OK, OK],
    )
    await expect(client.generate(request(), { auth: AUTH })).rejects.toBeInstanceOf(
      LlmError,
    )
    const second = await client.generate(request(), { auth: AUTH })
    expect(second.warnings.some((w) => w.type === 'shutdown')).toBe(true)
    const third = await client.generate(request(), { auth: AUTH })
    expect(third.warnings.some((w) => w.type === 'shutdown')).toBe(false)
  })
})

describe('P3-6: only a 4xx or 5xx status proves the provider answered with an error', () => {
  const unpriced = async (status: number): Promise<number | undefined> => {
    const err = new LlmError('x', {
      kind: 'server',
      retryable: false,
      httpStatus: status,
    })
    const { client } = build({}, [err])
    const out = (await client
      .generate(request(), { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError
    void out
    let callCost: number | undefined
    const { client: c2 } = build(
      {
        telemetry: {
          onError(e) {
            callCost = e.callCost?.unpricedAttempts
          },
        },
      },
      [err],
    )
    await c2.generate(request(), { auth: AUTH }).catch(() => {})
    return callCost
  }

  it('a 200 or 302 status on a failed attempt is counted unpriced', async () => {
    expect(await unpriced(200)).toBe(1)
    expect(await unpriced(302)).toBe(1)
  })

  it('a 503 is known free', async () => {
    expect(await unpriced(503)).toBe(0)
  })
})

describe('P3-7: the request is snapshotted at the top of the call', () => {
  it('top-level fields a host reassigns while the call validates do not reach the row', async () => {
    const descriptor = makePermissiveTestDescriptor({ model: 'm', provider: 'p' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = {
      ...descriptor,
      validateConfig: {
        '~standard': {
          version: 1 as const,
          vendor: 'test',
          validate: async (value: unknown) => {
            await gate
            return { value }
          },
        },
      },
    }
    const { client, sink } = build({ modelRegistry: registry(slow as never) })
    const req = request({ metadata: { v: 1 }, externalId: 'ext-1' })
    const pending = client.generate(req, { auth: AUTH })
    req.metadata = { v: 2 }
    req.externalId = 'ext-2'
    release()
    await pending
    expect(sink.records[0]?.metadata).toEqual({ v: 1 })
    expect(sink.records[0]?.externalId).toBe('ext-1')
  })
})
