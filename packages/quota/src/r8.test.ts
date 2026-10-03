/**
 * R8.1: `tpm`, `dayBoundary`, the Gemini and xAI presets over `quotaPolicy`,
 * the middleware without a store, the explicit store-failure policy, and the
 * hint and usage the rate limiter receives.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  createClient,
  createModelRegistry,
  estimateInputTokens,
  LlmError,
  retryMiddleware,
  type AdapterResult,
  type EngineCtx,
  type LlmRequest,
  type ResolvedRequest,
  type Usage,
} from '@gullabs/core'
import {
  FakeAdapter,
  FakeClock,
  RecordingLogger,
  fakeBilledFailure,
  fakeHttpError,
} from '@gullabs/testing'
import {
  enforceProviderQuota,
  inMemoryQuotaStore,
  providerQuotaMiddleware,
  providerQuotaRateLimiter,
  quotaPolicy,
  quotaPolicyForGemini,
  quotaPolicyForXai,
  type QuotaEvent,
  type QuotaStore,
} from './index.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0)

function usage(inputTokens: number): Usage {
  return { inputTokens, outputTokens: 1, details: {}, raw: null }
}

function result(inputTokens: number): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
    text: 'ok',
    usage: usage(inputTokens),
    model: 'm',
    warnings: [],
  }
}

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
])

function request(text: string): LlmRequest {
  return {
    provider: 'google',
    model: 'm',
    messages: [{ role: 'user', parts: [{ kind: 'text', text }] }],
  }
}

function resolved(text: string): ResolvedRequest {
  return { ...request(text), config: {} }
}

function ctxOf(clock: FakeClock, logger = new RecordingLogger()): EngineCtx {
  return { callId: 'c1', clock, scheduler: clock, logger }
}

describe('the policies', () => {
  const at = { provider: 'google', model: 'm' }

  it('quotaPolicyForGemini rolls the day over at midnight Pacific by default', () => {
    const rule = quotaPolicyForGemini({
      models: { m: { rpd: 100, tpm: 1_000 } },
    }).getRule(at)
    expect(rule).toEqual({
      scope: 'google:m',
      rpd: 100,
      tpm: 1_000,
      dayBoundary: { timeZone: 'America/Los_Angeles' },
    })
  })

  it('quotaPolicy has no day boundary unless given one (the UTC day)', () => {
    const policy = quotaPolicy({ provider: 'google', models: { m: { rpd: 5 } } })
    expect(policy.getRule(at)).toEqual({ scope: 'google:m', rpd: 5 })
    const pacific = quotaPolicy({
      provider: 'google',
      models: { m: { rpd: 5 } },
      dayBoundary: { timeZone: 'Asia/Tokyo' },
    })
    expect(pacific.getRule(at)?.dayBoundary).toEqual({ timeZone: 'Asia/Tokyo' })
  })

  it('quotaPolicy falls back to defaults for an unlisted model and ignores other providers', () => {
    const policy = quotaPolicy({
      provider: 'google',
      models: { m: { rpm: 1 } },
      defaults: { rpm: 9 },
    })
    expect(policy.getRule({ provider: 'google', model: 'other' })?.rpm).toBe(9)
    expect(policy.getRule({ provider: 'xai', model: 'm' })).toBeUndefined()
    expect(
      quotaPolicy({ provider: 'google', models: {} }).getRule({
        provider: 'google',
        model: 'm',
      }),
    ).toBeUndefined()
  })

  it('quotaPolicy refuses a table keyed by an alias, naming the canonical id', () => {
    const policy = quotaPolicy({ provider: 'google', models: { 'm-latest': { rpm: 1 } } })
    expect(() => policy.getRule({ ...at, aliases: ['m-latest'] })).toThrow(
      /keyed by one of its aliases/,
    )
  })

  it('rejects a time zone the runtime does not know when the policy is built', () => {
    expect(() =>
      quotaPolicy({
        provider: 'google',
        models: {},
        dayBoundary: { timeZone: 'Nowhere/Land' },
      }),
    ).toThrow(LlmError)
  })

  it('quotaPolicyForXai is provider xai, takes the host numbers, and has no day window', () => {
    const policy = quotaPolicyForXai({
      models: { 'grok-4.5': { rpm: 600, tpm: 2_000_000 } },
      defaults: { rpm: 60 },
    })
    expect(policy.getRule({ provider: 'xai', model: 'grok-4.5' })).toEqual({
      scope: 'xai:grok-4.5',
      rpm: 600,
      tpm: 2_000_000,
    })
    expect(policy.getRule({ provider: 'xai', model: 'grok-x' })?.rpm).toBe(60)
    expect(policy.getRule({ provider: 'google', model: 'grok-4.5' })).toBeUndefined()
  })

  it('a rule with tpm that is not a positive integer is bad_request when it is used', async () => {
    for (const tpm of [0, -1, 1.5, Number.NaN]) {
      await expect(
        enforceProviderQuota({
          provider: 'google',
          model: 'm',
          policy: { getRule: () => ({ tpm }) },
          store: inMemoryQuotaStore(),
          onStoreError: 'fail-closed',
          nowMs: T0,
        }),
      ).rejects.toMatchObject({ kind: 'bad_request' })
    }
  })

  it('a rule with a bad dayBoundary is bad_request when it is used', async () => {
    await expect(
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy: {
          getRule: () => ({ rpd: 1, dayBoundary: { timeZone: 'Nowhere/Land' } }),
        },
        store: inMemoryQuotaStore(),
        onStoreError: 'fail-closed',
        nowMs: T0,
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('tokens per minute', () => {
  const policy = quotaPolicy({ provider: 'google', models: { m: { tpm: 1_000 } } })

  it('defers with tpm_exhausted when the estimate does not fit, and emits the event', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const events: QuotaEvent[] = []
    const enforce = (tokens: number) =>
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store,
        onStoreError: 'fail-closed',
        nowMs: clock.now(),
        estimatedInputTokens: tokens,
        onEvent: (e) => events.push(e),
      })

    await enforce(700)
    const err = (await enforce(700).catch((e: unknown) => e)) as LlmError

    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 60_000,
    })
    expect(err.message).toMatch(/input tokens per minute exhausted/)
    expect(events.map((e) => e.type)).toEqual(['allow', 'defer'])
    expect(events[1]).toMatchObject({
      decision: { reason: 'tpm_exhausted', scope: 'google:m' },
    })
  })

  it('reconcile corrects the reservation with the real usage, freeing what was over-reserved', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const enforce = (tokens: number) =>
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store,
        onStoreError: 'fail-closed',
        nowMs: clock.now(),
        estimatedInputTokens: tokens,
      })

    const admission = await enforce(900)
    await expect(enforce(500)).rejects.toMatchObject({ kind: 'rate_limited' })

    await admission.reconcile(usage(300)) // the call really used 300
    await expect(enforce(500)).resolves.toBeDefined() // 300 + 500 fits
  })

  it('reconcile adds what was under-reserved, and does nothing without usage', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const enforce = (tokens: number) =>
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store,
        onStoreError: 'fail-closed',
        nowMs: clock.now(),
        estimatedInputTokens: tokens,
      })

    const admission = await enforce(100)
    await admission.reconcile(undefined)
    await expect(enforce(850)).resolves.toBeDefined() // 100 + 850 = 950 fits

    await admission.reconcile(usage(300)) // 200 more than reserved: 1150 counted
    await expect(enforce(1)).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('a store failure while reconciling is an event, never an error', async () => {
    const events: QuotaEvent[] = []
    const store: QuotaStore = {
      ...inMemoryQuotaStore(),
      adjustTokens: () => Promise.reject(new Error('store down')),
    }
    const admission = await enforceProviderQuota({
      provider: 'google',
      model: 'm',
      policy,
      store,
      onStoreError: 'fail-closed',
      nowMs: T0,
      estimatedInputTokens: 10,
      onEvent: (e) => events.push(e),
    })

    await expect(admission.reconcile(usage(500))).resolves.toBeUndefined()
    expect(events.at(-1)).toMatchObject({ type: 'backend_error' })
  })

  it('without a tpm rule nothing is reserved and reconcile is a no-op', async () => {
    const admission = await enforceProviderQuota({
      provider: 'google',
      model: 'm',
      policy: quotaPolicy({ provider: 'google', models: { m: { rpm: 5 } } }),
      store: {
        ...inMemoryQuotaStore(),
        adjustTokens: () => Promise.reject(new Error('must not be called')),
      },
      onStoreError: 'fail-closed',
      nowMs: T0,
      estimatedInputTokens: 10,
    })
    await expect(admission.reconcile(usage(500))).resolves.toBeUndefined()
  })
})

describe('providerQuotaMiddleware with tokens, through the client', () => {
  it('reserves the request estimate per attempt and reconciles with the usage on success', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const text = 'x'.repeat(400) // an estimate of 100 tokens
    expect(estimateInputTokens(resolved(text))).toBe(100)
    const policy = quotaPolicy({ provider: 'google', models: { m: { tpm: 1_000 } } })
    const client = createClient({
      adapters: [new FakeAdapter('google', result(40))],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      middleware: [
        providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' }),
      ],
    })

    await client.generate(request(text), { auth: { apiKey: 'k' } })

    // 100 reserved, 40 real: 60 freed.
    const probe = await store.checkAndConsume({
      scope: 'google:m',
      nowMs: clock.now(),
      tpm: 1_000,
      tokens: 0,
    })
    expect(probe.tpm).toMatchObject({ used: 40 })
  })

  it('a billed failure reconciles with its usage; a failure with none keeps the reservation', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const text = 'x'.repeat(400)
    const policy = quotaPolicy({ provider: 'google', models: { m: { tpm: 10_000 } } })
    const client = createClient({
      adapters: [
        new FakeAdapter('google', [
          fakeBilledFailure({ inputTokens: 30, outputTokens: 0 }, { retryable: false }),
          fakeHttpError(500),
        ]),
      ],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      middleware: [
        providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' }),
      ],
    })
    const used = async () =>
      (
        await store.checkAndConsume({
          scope: 'google:m',
          nowMs: clock.now(),
          tpm: 10_000,
          tokens: 0,
        })
      ).tpm?.used

    await expect(
      client.generate(request(text), { auth: { apiKey: 'k' } }),
    ).rejects.toBeInstanceOf(LlmError)
    expect(await used()).toBe(30) // reserved 100, billed 30

    await expect(
      client.generate(request(text), { auth: { apiKey: 'k' } }),
    ).rejects.toBeInstanceOf(LlmError)
    expect(await used()).toBe(130) // the second reservation of 100 stays
  })

  it('with retry outside, a tpm deferral is slept out on the scheduler and the call goes through', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const policy = quotaPolicy({ provider: 'google', models: { m: { tpm: 150 } } })
    const text = 'x'.repeat(400) // 100 tokens: the second call does not fit this minute
    const adapter = new FakeAdapter('google', result(100))
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      middleware: [
        retryMiddleware({ maxAttempts: 3 }, { random: () => 0 }),
        providerQuotaMiddleware({ policy, store, onStoreError: 'fail-closed' }),
      ],
    })

    await client.generate(request(text), { auth: { apiKey: 'k' } })
    const second = client.generate(request(text), { auth: { apiKey: 'k' } })
    const settled = second.then(
      () => 'done',
      (e: unknown) => e,
    )
    await clock.advanceAsync(0)
    expect(adapter.calls).toHaveLength(1) // deferred, not dispatched

    await clock.advanceAsync(60_000) // the retry waits out the minute (retryAfter + jitter 0)
    await clock.advanceAsync(6_000)

    await expect(settled).resolves.toBe('done')
    expect(adapter.calls).toHaveLength(2)
  })
})

describe('providerQuotaMiddleware without a store', () => {
  const policy = quotaPolicy({
    provider: 'google',
    models: { off: { rpd: 0 }, limited: { rpm: 1, rpd: 5, tpm: 100 } },
  })
  const never = () => Promise.reject(new Error('next must not run'))

  it('rpd: 0 still denies with provider_disabled and a deny event', async () => {
    const events: QuotaEvent[] = []
    const mw = providerQuotaMiddleware({ policy, onEvent: (e) => events.push(e) })
    const clock = new FakeClock(T0)

    const err = (await mw
      .intercept({ ...resolved('hi'), model: 'off' }, ctxOf(clock), never)
      .catch((e: unknown) => e)) as LlmError

    expect(err).toMatchObject({ kind: 'rate_limited', retryable: false })
    expect(err.message).toMatch(/Provider quota disabled for "google:off"/)
    expect(events).toEqual([
      {
        type: 'deny',
        provider: 'google',
        model: 'off',
        scope: 'google:off',
        decision: { kind: 'deny', scope: 'google:off', reason: 'provider_disabled' },
      },
    ])
  })

  it('skips the windows, lets the call through, and warns once per middleware', async () => {
    const mw = providerQuotaMiddleware({ policy })
    const clock = new FakeClock(T0)
    const logger = new RecordingLogger()
    let nexts = 0
    const next = () => {
      nexts += 1
      return Promise.resolve({ usage: usage(1) } as never)
    }

    for (let i = 0; i < 3; i++) {
      await mw.intercept(
        { ...resolved('hi'), model: 'limited' },
        ctxOf(clock, logger),
        next,
      )
    }

    expect(nexts).toBe(3)
    const warnings = logger.findAll(
      'llm.quota.windows_skipped: providerQuotaMiddleware has no store, so rpm, rpd and tpm windows are not checked (rpd: 0 still denies)',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      fields: { provider: 'google', scope: 'google:limited' },
    })
  })

  it('a model with no rule, or a rule with no windows, does not warn', async () => {
    const mw = providerQuotaMiddleware({
      policy: quotaPolicy({ provider: 'google', models: { bare: {} } }),
    })
    const clock = new FakeClock(T0)
    const logger = new RecordingLogger()
    const next = () => Promise.resolve({ usage: usage(1) } as never)

    await mw.intercept({ ...resolved('hi'), model: 'bare' }, ctxOf(clock, logger), next)
    await mw.intercept(
      { ...resolved('hi'), model: 'unlisted' },
      ctxOf(clock, logger),
      next,
    )

    expect(logger.entries).toHaveLength(0)
  })

  it('the client runs end to end with no store', async () => {
    const adapter = new FakeAdapter('google', result(5))
    const client = createClient({
      adapters: [adapter],
      modelRegistry: REGISTRY,
      middleware: [
        providerQuotaMiddleware({
          policy: quotaPolicy({ provider: 'google', models: { m: { rpm: 1 } } }),
        }),
      ],
    })
    await client.generate(request('a'), { auth: { apiKey: 'k' } })
    await client.generate(request('b'), { auth: { apiKey: 'k' } })
    expect(adapter.calls).toHaveLength(2)
  })
})

describe('the store failure policy is explicit', () => {
  const policy = quotaPolicy({ provider: 'google', models: { m: { rpm: 1 } } })
  const down: QuotaStore = {
    checkAndConsume: () => Promise.reject(new Error('store down')),
    adjustTokens: () => Promise.resolve(),
  }

  it("'fail-closed' rethrows the store error and emits backend_error", async () => {
    const events: QuotaEvent[] = []
    await expect(
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store: down,
        onStoreError: 'fail-closed',
        nowMs: T0,
        onEvent: (e) => events.push(e),
      }),
    ).rejects.toThrow('store down')
    expect(events.map((e) => e.type)).toEqual(['backend_error'])
  })

  it("'fail-open' lets the call through, with no reservation, and still emits backend_error", async () => {
    const events: QuotaEvent[] = []
    const admission = await enforceProviderQuota({
      provider: 'google',
      model: 'm',
      policy,
      store: down,
      onStoreError: 'fail-open',
      nowMs: T0,
      onEvent: (e) => events.push(e),
    })
    expect(events.map((e) => e.type)).toEqual(['backend_error'])
    await expect(admission.reconcile(usage(10))).resolves.toBeUndefined()
  })

  it("'fail-open' never swallows a caller abort that interrupted the store call", async () => {
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
        onStoreError: 'fail-open',
        nowMs: T0,
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError)
  })

  it('a deferral is not a store failure: it is thrown under fail-open too', async () => {
    const store = inMemoryQuotaStore()
    const run = () =>
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy,
        store,
        onStoreError: 'fail-open',
        nowMs: T0,
      })
    await run()
    await expect(run()).rejects.toMatchObject({ kind: 'rate_limited' })
  })

  it('a missing or unknown onStoreError is bad_request: there is no default', async () => {
    for (const mode of [undefined, 'open', 'closed', true]) {
      await expect(
        enforceProviderQuota({
          provider: 'google',
          model: 'm',
          policy,
          store: inMemoryQuotaStore(),
          onStoreError: mode as never,
          nowMs: T0,
        }),
      ).rejects.toMatchObject({ kind: 'bad_request' })
    }
  })

  it('the middleware carries the choice into every call', async () => {
    const clock = new FakeClock(T0)
    const open = providerQuotaMiddleware({
      policy,
      store: down,
      onStoreError: 'fail-open',
    })
    const closed = providerQuotaMiddleware({
      policy,
      store: down,
      onStoreError: 'fail-closed',
    })
    const next = () => Promise.resolve({ usage: usage(1) } as never)

    await expect(
      open.intercept(resolved('hi'), ctxOf(clock), next),
    ).resolves.toBeDefined()
    await expect(closed.intercept(resolved('hi'), ctxOf(clock), next)).rejects.toThrow(
      'store down',
    )
  })
})

describe('providerQuotaRateLimiter with tokens', () => {
  it('reserves hint.estimatedInputTokens and Release(usage) corrects it', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const limiter = providerQuotaRateLimiter({
      policy: quotaPolicy({ provider: 'google', models: { m: { tpm: 1_000 } } }),
      store,
      onStoreError: 'fail-closed',
      now: () => clock.now(),
    })

    const release = await limiter.acquire('google:m', undefined, {
      estimatedInputTokens: 800,
    })
    await expect(
      limiter.acquire('google:m', undefined, { estimatedInputTokens: 800 }),
    ).rejects.toMatchObject({ kind: 'rate_limited' })

    release(usage(100))
    // Release does not wait for the store: let its promise turns run.
    await clock.advanceAsync(0)

    await expect(
      limiter.acquire('google:m', undefined, { estimatedInputTokens: 800 }),
    ).resolves.toBeTypeOf('function')
  })

  it('works without a hint (no tokens reserved) and Release() with no usage is a no-op', async () => {
    const limiter = providerQuotaRateLimiter({
      policy: quotaPolicy({ provider: 'google', models: { m: { tpm: 100 } } }),
      store: inMemoryQuotaStore(),
      onStoreError: 'fail-closed',
      now: () => T0,
    })
    const release = await limiter.acquire('google:m')
    expect(() => release()).not.toThrow()
  })

  it('the client feeds it: estimate in, real usage out', async () => {
    const clock = new FakeClock(T0)
    const store = inMemoryQuotaStore({ clock })
    const client = createClient({
      adapters: [new FakeAdapter('google', result(20))],
      modelRegistry: REGISTRY,
      clock,
      scheduler: clock,
      rateLimiter: providerQuotaRateLimiter({
        policy: quotaPolicy({ provider: 'google', models: { m: { tpm: 1_000 } } }),
        store,
        onStoreError: 'fail-closed',
        now: () => clock.now(),
      }),
    })

    await client.generate(request('x'.repeat(400)), { auth: { apiKey: 'k' } }) // estimate 100
    await clock.advanceAsync(0)

    const probe = await store.checkAndConsume({
      scope: 'google:m',
      nowMs: clock.now(),
      tpm: 1_000,
      tokens: 0,
    })
    expect(probe.tpm).toMatchObject({ used: 20 })
  })
})

describe('fail-open and an error the store itself classifies', () => {
  it('a store that throws an LlmError is still a store failure under fail-open', async () => {
    const store: QuotaStore = {
      checkAndConsume: () =>
        Promise.reject(new LlmError('upstash 503', { kind: 'server', retryable: true })),
      adjustTokens: () => Promise.resolve(),
    }
    const events: QuotaEvent[] = []
    await expect(
      enforceProviderQuota({
        provider: 'google',
        model: 'm',
        policy: quotaPolicy({ provider: 'google', models: { m: { rpm: 1 } } }),
        store,
        onStoreError: 'fail-open',
        nowMs: T0,
        onEvent: (e) => events.push(e),
      }),
    ).resolves.toBeDefined()
    expect(events.map((e) => e.type)).toEqual(['backend_error'])
  })
})
