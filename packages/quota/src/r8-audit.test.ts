/**
 * R8 audit fixes: a store outage is one non-retryable `quota_store_unavailable`
 * error, reconciliation never delays or masks a result, and the smaller
 * contract gaps (validation at construction, `rpm`/`tpm` of 0, canonical time
 * zones, the warning's event name, the bounded call's cleanup).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  createClient,
  createModelRegistry,
  LlmError,
  retryMiddleware,
  type AdapterResult,
  type EngineCtx,
  type LlmRequest,
  type ResolvedRequest,
  type Usage,
} from '@gullabs/core'
import { FakeAdapter, FakeClock, RecordingLogger, RecordingSink } from '@gullabs/testing'
import {
  enforceProviderQuota,
  inMemoryQuotaStore,
  providerQuotaMiddleware,
  providerQuotaRateLimiter,
  quotaPolicy,
  quotaPolicyForGemini,
  quotaPolicyForXai,
  upstashQuotaStore,
  type QuotaEvent,
  type QuotaStore,
} from './index.js'
import { makeRedisEmulator } from './redis-emulator.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0)

function usage(inputTokens: number): Usage {
  return { inputTokens, outputTokens: 1, details: {}, raw: null }
}

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: usage(5),
  model: 'm',
  warnings: [],
}

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
])

function request(text = 'hi'): LlmRequest {
  return {
    provider: 'google',
    model: 'm',
    messages: [{ role: 'user', parts: [{ kind: 'text', text }] }],
  }
}

function resolved(text = 'hi'): ResolvedRequest {
  return { ...request(text), config: {} }
}

function ctxOf(clock: FakeClock, logger = new RecordingLogger()): EngineCtx {
  return { callId: 'c1', clock, scheduler: clock, logger }
}

/** Lets promise continuations run, with no timer involved. */
const turns = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('a fail-closed store outage is a quota-store failure, not a provider failure', () => {
  const policy = quotaPolicy({ provider: 'google', models: { m: { rpm: 5 } } })

  function outage(error: unknown): { store: QuotaStore; checks: () => number } {
    let checks = 0
    return {
      checks: () => checks,
      store: {
        checkAndConsume: () => {
          checks += 1
          return Promise.reject(error)
        },
        adjustTokens: () => Promise.resolve(),
      },
    }
  }

  async function failingCall(error: unknown) {
    const clock = new FakeClock(T0)
    const sink = new RecordingSink()
    const adapter = new FakeAdapter('google', OK)
    const { store, checks } = outage(error)
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      sink,
      middleware: [
        retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 }, { random: () => 0 }),
        providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' }),
      ],
    })
    const settled = client.generate(request(), { auth: { apiKey: 'k' } }).then(
      () => undefined,
      (e: unknown) => e as LlmError,
    )
    await clock.advanceAsync(10_000)
    return { error: await settled, adapter, sink, checks }
  }

  it('a store timeout is kind server, reason quota_store_unavailable, not retryable, one store call', async () => {
    const { error, adapter, checks } = await failingCall(
      new Error('Upstash quota call timed out after 2000ms'),
    )

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'server',
      retryable: false,
      reason: 'quota_store_unavailable',
    })
    expect(error?.message).toMatch(/Quota store unavailable/)
    expect((error?.cause as Error).message).toBe(
      'Upstash quota call timed out after 2000ms',
    )
    expect(checks()).toBe(1)
    expect(adapter.calls).toHaveLength(0)
  })

  it('a store HTTP failure and a transport failure end the same way', async () => {
    for (const raw of [
      new Error('Upstash quota pipeline failed with HTTP 503'),
      new TypeError('fetch failed'),
      new LlmError('store says slow down', { kind: 'rate_limited', retryable: true }),
    ]) {
      const { error, checks } = await failingCall(raw)
      expect(error).toMatchObject({
        kind: 'server',
        retryable: false,
        reason: 'quota_store_unavailable',
      })
      expect(checks()).toBe(1)
    }
  })

  it('writes one refusal row that says server / quota_store_unavailable, never a provider timeout', async () => {
    const { sink } = await failingCall(
      new Error('Upstash quota call timed out after 2000ms'),
    )

    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toMatchObject({
      status: 'api_error',
      errorKind: 'server',
      errorReason: 'quota_store_unavailable',
    })
  })

  it('emits backend_error once per failed store call, also when the store throws an LlmError', async () => {
    const events: QuotaEvent[] = []
    await expect(
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store: outage(new LlmError('x', { kind: 'rate_limited', retryable: true })).store,
        onStoreError: 'fail-closed',
        nowMs: T0,
        onEvent: (e) => events.push(e),
      }),
    ).rejects.toMatchObject({ reason: 'quota_store_unavailable' })
    expect(events.map((e) => e.type)).toEqual(['backend_error'])
  })

  it('the rate-limiter path fails the same way (fail-closed), and fail-open still goes through', async () => {
    const closed = providerQuotaRateLimiter({
      policy,
      store: outage(new Error('down')).store,
      onStoreError: 'fail-closed',
      now: () => T0,
    })
    await expect(closed.acquire('google:m')).rejects.toMatchObject({
      kind: 'server',
      retryable: false,
      reason: 'quota_store_unavailable',
    })
    const open = providerQuotaRateLimiter({
      policy,
      store: outage(new Error('down')).store,
      onStoreError: 'fail-open',
      now: () => T0,
    })
    await expect(open.acquire('google:m')).resolves.toBeTypeOf('function')
  })

  it('a caller abort that interrupts the store call is still the abort, not a store failure', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('Aborted', 'AbortError')
    const store: QuotaStore = {
      checkAndConsume: () => {
        controller.abort()
        return Promise.reject(abortError)
      },
      adjustTokens: () => Promise.resolve(),
    }
    await expect(
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store,
        onStoreError: 'fail-closed',
        nowMs: T0,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError)
  })

  it('upstashQuotaStore: a timeout on the scheduler surfaces as quota_store_unavailable through the middleware', async () => {
    const clock = new FakeClock(T0)
    const store = upstashQuotaStore({
      invoke: () => new Promise<never>(() => {}),
      scheduler: clock,
    })
    const mw = providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' })
    const settled = mw
      .intercept(resolved(), ctxOf(clock), () => Promise.resolve({} as never))
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    await clock.advanceAsync(2_000)
    expect(await settled).toMatchObject({
      kind: 'server',
      reason: 'quota_store_unavailable',
    })
  })
})

describe('reconciliation never delays or masks the call', () => {
  const policy = quotaPolicy({ provider: 'google', models: { m: { tpm: 10_000 } } })

  function hangingAdjust(): QuotaStore & { adjusts: number } {
    const base = inMemoryQuotaStore()
    const store = {
      ...base,
      adjusts: 0,
      adjustTokens: () => {
        store.adjusts += 1
        return new Promise<void>(() => {})
      },
    }
    return store
  }

  it('returns the provider result without waiting for adjustTokens', async () => {
    const store = hangingAdjust()
    const mw = providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' })
    const clock = new FakeClock(T0)
    const out = await mw.intercept(resolved('x'.repeat(400)), ctxOf(clock), () =>
      Promise.resolve({ usage: usage(7) } as never),
    )
    expect(out).toMatchObject({ usage: { inputTokens: 7 } })
    await turns()
    expect(store.adjusts).toBe(1)
  })

  it('rethrows the original error without waiting for adjustTokens', async () => {
    const store = hangingAdjust()
    const mw = providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' })
    const boom = new LlmError('billed', {
      kind: 'server',
      retryable: false,
      usage: usage(7),
    })
    await expect(
      mw.intercept(resolved('x'.repeat(400)), ctxOf(new FakeClock(T0)), () =>
        Promise.reject(boom),
      ),
    ).rejects.toBe(boom)
  })

  it('a failing adjustTokens is a backend_error event and a logged warning, and the result is untouched', async () => {
    const events: QuotaEvent[] = []
    const logger = new RecordingLogger()
    const store: QuotaStore = {
      ...inMemoryQuotaStore(),
      adjustTokens: () => Promise.reject(new Error('store down')),
    }
    const mw = providerQuotaMiddleware({
      policy,
      store,
      onStoreError: 'fail-closed',
      onEvent: (e) => events.push(e),
    })
    const out = await mw.intercept(
      resolved('x'.repeat(400)),
      ctxOf(new FakeClock(T0), logger),
      () => Promise.resolve({ usage: usage(7) } as never),
    )
    await turns()

    expect(out).toMatchObject({ usage: { inputTokens: 7 } })
    expect(events.at(-1)).toMatchObject({ type: 'backend_error', scope: 'google:m' })
    expect(logger.find('llm.quota.reconcile_failed')).toMatchObject({
      level: 'warn',
      fields: { callId: 'c1', provider: 'google', scope: 'google:m' },
    })
  })

  it('a rate-limiter Release corrects the reservation once, however often it is called', async () => {
    const adjusts: number[] = []
    const store: QuotaStore = {
      ...inMemoryQuotaStore(),
      adjustTokens: (input) => {
        adjusts.push(input.tokens)
        return Promise.resolve()
      },
    }
    const limiter = providerQuotaRateLimiter({
      policy,
      store,
      onStoreError: 'fail-closed',
      now: () => T0,
    })
    const release = await limiter.acquire('google:m', undefined, {
      estimatedInputTokens: 800,
    })
    release(usage(100))
    release(usage(100))
    release(usage(5))
    await turns()
    expect(adjusts).toEqual([-700])
  })
})

describe('configuration is validated when the middleware is built', () => {
  const policy = quotaPolicy({ provider: 'google', models: { m: { rpm: 5 } } })

  it('a store without onStoreError is bad_request at construction, not on the first call', () => {
    const build = () =>
      providerQuotaMiddleware({ policy, store: inMemoryQuotaStore() } as never)
    expect(build).toThrow(LlmError)
    expect(build).toThrow(/onStoreError/)
    expect(() =>
      providerQuotaMiddleware({
        policy,
        store: inMemoryQuotaStore(),
        onStoreError: 'open' as never,
      }),
    ).toThrow(/onStoreError/)
  })

  it('the rate limiter validates onStoreError at construction too', () => {
    expect(() =>
      providerQuotaRateLimiter({ policy, store: inMemoryQuotaStore() } as never),
    ).toThrow(/onStoreError/)
  })
})

describe('a limit of 0 means the provider is disabled, for every window', () => {
  const run = (rule: { rpm?: number; rpd?: number; tpm?: number }, store?: QuotaStore) =>
    enforceProviderQuota({
      provider: 'google',
      model: 'm',
      policy: { getRule: () => rule },
      nowMs: T0,
      ...(store !== undefined ? { store, onStoreError: 'fail-closed' as const } : {}),
    })

  it.each([{ rpm: 0 }, { rpd: 0 }, { tpm: 0 }])(
    '%j denies with provider_disabled, with or without a store',
    async (rule) => {
      for (const store of [undefined, inMemoryQuotaStore()]) {
        const err = (await run(rule, store).catch((e: unknown) => e)) as LlmError
        expect(err).toMatchObject({ kind: 'rate_limited', retryable: false })
        expect(err.message).toMatch(/Provider quota disabled/)
      }
    },
  )

  it.each([
    { rpm: -1 },
    { rpm: 1.5 },
    { rpd: -1 },
    { tpm: -1 },
    { tpm: 1.5 },
    { tpm: Number.NaN },
  ])('%j is bad_request', async (rule) => {
    await expect(run(rule, inMemoryQuotaStore())).rejects.toMatchObject({
      kind: 'bad_request',
    })
  })

  it('policy builders reject an unknown option or limit key instead of dropping it', () => {
    expect(() =>
      quotaPolicyForGemini({ models: {}, defaultLimits: { rpm: 1 } } as never),
    ).toThrow(/defaultLimits/)
    expect(() =>
      quotaPolicyForXai({ models: { m: { rpd: 5 } } } as never).getRule({
        provider: 'xai',
        model: 'm',
      }),
    ).toThrow(/rpd/)
    expect(() =>
      quotaPolicy({ provider: 'google', models: { m: { rpmm: 5 } } } as never),
    ).toThrow(/rpmm/)
    expect(() =>
      quotaPolicy({ provider: 'google', models: {}, tz: 'UTC' } as never),
    ).toThrow(LlmError)
  })
})

describe('the day counter is keyed by the canonical time zone', () => {
  it('aliases of one zone, and UTC spelled any way, share one counter', async () => {
    const store = inMemoryQuotaStore()
    const take = (timeZone: string | undefined) =>
      store.checkAndConsume({
        scope: 's',
        nowMs: T0,
        rpd: 2,
        ...(timeZone !== undefined ? { dayBoundary: { timeZone } } : {}),
      })

    expect((await take('America/Los_Angeles')).rpd).toMatchObject({ used: 1 })
    expect((await take('US/Pacific')).rpd).toMatchObject({ used: 2 })
    expect((await take('America/Los_Angeles')).rpd).toMatchObject({ allowed: false })

    expect((await take(undefined)).rpd).toMatchObject({ used: 1 })
    expect((await take('UTC')).rpd).toMatchObject({ used: 2 })
    expect((await take('Etc/UTC')).rpd).toMatchObject({ allowed: false })
  })
})

describe('the skipped-windows warning is a stable event name with context fields', () => {
  it('uses the bare event name as the message and warns once per scope', async () => {
    const policy = quotaPolicy({
      provider: 'google',
      models: { a: { rpm: 1 }, b: { rpm: 1 } },
    })
    const mw = providerQuotaMiddleware({ policy })
    const clock = new FakeClock(T0)
    const logger = new RecordingLogger()
    const next = () => Promise.resolve({ usage: usage(1) } as never)
    for (const model of ['a', 'a', 'b']) {
      await mw.intercept({ ...resolved(), model }, ctxOf(clock, logger), next)
    }

    const warnings = logger.findAll('llm.quota.windows_skipped')
    expect(warnings).toHaveLength(2)
    expect(warnings.map((w) => (w.fields as { scope: string }).scope)).toEqual([
      'google:a',
      'google:b',
    ])
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      fields: { callId: 'c1', provider: 'google', model: 'a', scope: 'google:a' },
    })
  })
})

describe('the bounded store call cleans up after itself', () => {
  const input = { scope: 's', nowMs: T0, rpm: 5 }

  it('an invoke that throws synchronously leaves no timer and no listener behind', async () => {
    const clock = new FakeClock()
    const controller = new AbortController()
    const store = upstashQuotaStore({
      invoke: () => {
        throw new Error('boom')
      },
      scheduler: clock,
    })
    await expect(
      store.checkAndConsume({ ...input, signal: controller.signal }),
    ).rejects.toThrow('boom')
    expect(clock.pendingTimers).toBe(0)
  })

  it('a non-OK response has its body released, and is a plain failure', async () => {
    let cancelled = false
    const body = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    const fakeFetch = (() =>
      Promise.resolve(new Response(body, { status: 503 }))) as unknown as typeof fetch
    const store = upstashQuotaStore({
      url: 'https://redis.example.test',
      token: 't',
      fetch: fakeFetch,
      scheduler: new FakeClock(),
    })
    await expect(store.checkAndConsume(input)).rejects.toThrow(/HTTP 503/)
    await turns()
    expect(cancelled).toBe(true)
  })

  it('still answers a healthy call', async () => {
    const store = upstashQuotaStore({
      invoke: makeRedisEmulator().invoke,
      scheduler: new FakeClock(),
    })
    expect((await store.checkAndConsume(input)).rpm).toMatchObject({ allowed: true })
  })
})
