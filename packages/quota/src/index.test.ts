import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  LlmError,
  type EngineCtx,
  type Handler,
  type ResolvedRequest,
} from '@gullabs/core'
import { FakeClock } from '@gullabs/testing'
import {
  checkProviderQuota,
  enforceProviderQuota,
  providerQuotaMiddleware,
  quotaPolicy,
  quotaPolicyForGemini,
  type QuotaEvent,
  type QuotaStore,
  type QuotaStoreCheckInput,
  type QuotaStoreCheckResult,
} from './index.js'

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

function makeCtx(nowMs: number): EngineCtx {
  return {
    callId: 'c1',
    clock: { now: () => nowMs },
    scheduler: new FakeClock(),
    logger: NOOP_LOGGER,
  }
}

function makeReq(provider: string, model: string): ResolvedRequest {
  return {
    provider,
    model,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    config: { serviceTier: 'flex' },
  }
}

function makeStore(result: QuotaStoreCheckResult): QuotaStore {
  return {
    adjustTokens: async () => {},
    checkAndConsume: vi.fn(async (_input: QuotaStoreCheckInput) => result),
  }
}

describe('@gullabs/quota', () => {
  it('checkProviderQuota returns deny for rpd=0 without retryAfterMs', async () => {
    const store: QuotaStore = {
      adjustTokens: async () => {},
      checkAndConsume: vi.fn(async () => {
        throw new Error('store should not be called for provider-disabled models')
      }),
    }

    const decision = await checkProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-pro',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-pro': { rpd: 0 },
        },
      }),
      store,
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    })

    expect(decision).toEqual({
      kind: 'deny',
      scope: 'google:gemini-2.5-pro',
      reason: 'provider_disabled',
    })
    expect('retryAfterMs' in decision).toBe(false)
    expect(store.checkAndConsume).not.toHaveBeenCalled()
  })

  it('enforceProviderQuota emits a deny event and throws a non-retryable rate_limited error', async () => {
    const events: QuotaEvent[] = []
    const error = await enforceProviderQuota({
      onStoreError: 'fail-closed',
      provider: 'google',
      model: 'gemini-2.5-pro',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-pro': { rpd: 0 },
        },
      }),
      store: makeStore({}),
      onEvent: (event) => events.push(event),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
    })
    expect('retryAfterMs' in (error as LlmError)).toBe(false)
    expect((error as LlmError).message).toContain('Provider quota disabled')

    expect(events).toEqual([
      {
        type: 'deny',
        provider: 'google',
        model: 'gemini-2.5-pro',
        scope: 'google:gemini-2.5-pro',
        decision: {
          kind: 'deny',
          scope: 'google:gemini-2.5-pro',
          reason: 'provider_disabled',
        },
      },
    ])
  })

  it('rpm exhaustion defers with retryable=true and retryAfterMs', async () => {
    const events: QuotaEvent[] = []
    const error = await enforceProviderQuota({
      onStoreError: 'fail-closed',
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
        },
      }),
      store: makeStore({
        rpm: { allowed: false, retryAfterMs: 1_500 },
        rpd: { allowed: true },
      }),
      onEvent: (event) => events.push(event),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 1_500,
    })
    expect(events).toEqual([
      {
        type: 'defer',
        provider: 'google',
        model: 'gemini-2.5-flash',
        scope: 'google:gemini-2.5-flash',
        decision: {
          kind: 'defer',
          scope: 'google:gemini-2.5-flash',
          reason: 'rpm_exhausted',
          retryAfterMs: 1_500,
        },
      },
    ])
  })

  it('rpd exhaustion defers with retryable=true and retryAfterMs', async () => {
    const error = await enforceProviderQuota({
      onStoreError: 'fail-closed',
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
        },
      }),
      store: makeStore({
        rpm: { allowed: true },
        rpd: { allowed: false, retryAfterMs: 12_000 },
      }),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 12_000,
    })
  })

  it('message helpers keep exhaustive switch guards for defer and deny reasons', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    expect(source).toContain('function messageForDefer')
    expect(source).toContain('function messageForDeny')
    expect(source.match(/const exhaustive: never = reason/g)).toHaveLength(1)
    expect(source).toContain('satisfies Record<QuotaDenyReason')
  })

  it('enforceProviderQuota keeps an exhaustive switch guard on decision.kind', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')

    expect(source).toContain('function enforceProviderQuota')
    expect(source.match(/const exhaustive: never = decision/g)).toHaveLength(1)
  })

  it('checkProviderQuota returns allow for a request within configured limits', async () => {
    const store = makeStore({
      rpm: { allowed: true },
      rpd: { allowed: true },
    })

    const decision = await checkProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
        },
      }),
      store,
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    })

    expect(decision).toEqual({ kind: 'allow' })
  })

  it('enforceProviderQuota resolves and emits an allow event within configured limits', async () => {
    const events: QuotaEvent[] = []
    const store = makeStore({
      rpm: { allowed: true },
      rpd: { allowed: true },
    })

    await expect(
      enforceProviderQuota({
        onStoreError: 'fail-closed',
        provider: 'google',
        model: 'gemini-2.5-flash',
        policy: quotaPolicyForGemini({
          models: {
            'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
          },
        }),
        store,
        onEvent: (event) => events.push(event),
        nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
      }),
    ).resolves.toBeDefined()

    expect(events).toEqual([
      {
        type: 'allow',
        provider: 'google',
        model: 'gemini-2.5-flash',
        scope: 'google:gemini-2.5-flash',
        decision: { kind: 'allow' },
      },
    ])
  })

  it('rejects a caller-supplied rpd of NaN synchronously', async () => {
    const store = makeStore({})

    const error = await checkProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-flash',
      // A host's own policy: `quotaPolicy` refuses this value when it is built.
      policy: { getRule: () => ({ rpd: Number.NaN }) },
      store,
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    expect((error as LlmError).message).toMatch(/rpd/)

    expect(store.checkAndConsume).not.toHaveBeenCalled()
  })

  it('rejects a caller-supplied negative rpm', async () => {
    const store = makeStore({})

    const error = await enforceProviderQuota({
      onStoreError: 'fail-closed',
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: { getRule: () => ({ rpm: -5 }) },
      store,
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    expect((error as LlmError).message).toMatch(/rpm/)

    expect(store.checkAndConsume).not.toHaveBeenCalled()
  })

  it('still allows rpd=0 (provider_disabled) without throwing on validation', async () => {
    const decision = await checkProviderQuota({
      provider: 'google',
      model: 'gemini-2.5-pro',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-pro': { rpd: 0 },
        },
      }),
      store: makeStore({}),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    })

    expect(decision).toEqual({
      kind: 'deny',
      scope: 'google:gemini-2.5-pro',
      reason: 'provider_disabled',
    })
  })

  it('a backend store failure is a quota_store_unavailable rejection and emits backend_error', async () => {
    const backendError = new Error('upstash unreachable')
    const store: QuotaStore = {
      adjustTokens: async () => {},
      checkAndConsume: vi.fn(async () => {
        throw backendError
      }),
    }
    const events: QuotaEvent[] = []

    const error = await enforceProviderQuota({
      onStoreError: 'fail-closed',
      provider: 'google',
      model: 'gemini-2.5-flash',
      policy: quotaPolicyForGemini({
        models: {
          'gemini-2.5-flash': { rpm: 60, rpd: 2_000 },
        },
      }),
      store,
      onEvent: (event) => events.push(event),
      nowMs: Date.UTC(2026, 5, 30, 12, 0, 0),
    }).catch((err: unknown) => err)

    expect(error).toMatchObject({
      kind: 'server',
      retryable: false,
      reason: 'quota_store_unavailable',
      cause: backendError,
    })
    expect(events).toEqual([
      {
        type: 'backend_error',
        provider: 'google',
        model: 'gemini-2.5-flash',
        scope: 'google:gemini-2.5-flash',
        error: backendError,
      },
    ])
  })

  it('providerQuotaMiddleware propagates a bad_request LlmError for a misconfigured rpm, unmodified, before touching the store', async () => {
    const store: QuotaStore = {
      adjustTokens: async () => {},
      checkAndConsume: vi.fn(async () => {
        throw new Error('store should not be called for a misconfigured quota rule')
      }),
    }
    const next: Handler = vi.fn(async () => {
      throw new Error('next should not be called when quota config validation fails')
    })

    const middleware = providerQuotaMiddleware({
      onStoreError: 'fail-closed',
      policy: { getRule: () => ({ rpm: -5 }) },
      store,
      now: () => Date.UTC(2026, 5, 30, 12, 0, 0),
    })

    const error = await middleware
      .intercept(
        makeReq('google', 'gemini-2.5-flash'),
        makeCtx(Date.UTC(2026, 5, 30, 12, 0, 0)),
        next,
      )
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    expect((error as LlmError).message).toMatch(/rpm/)

    expect(store.checkAndConsume).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })
})

describe('quotaPolicy looks models up by own property', () => {
  it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'a model named %s gets the defaults, not an inherited value',
    (model) => {
      const policy = quotaPolicy({
        provider: 'google',
        models: { listed: { rpm: 50 } },
        defaults: { rpm: 1 },
      })
      const input = { provider: 'google', model }
      expect(policy.getRule(input)).toMatchObject({ rpm: 1 })
      expect(policy.getRule({ ...input, aliases: ['toString'] })).toMatchObject({
        rpm: 1,
      })
      expect(policy.getRule({ provider: 'google', model: 'listed' })).toMatchObject({
        rpm: 50,
      })
    },
  )

  it('without defaults such a model is unlimited, and an own entry of that name still applies', () => {
    const none = quotaPolicy({ provider: 'google', models: { listed: { rpm: 50 } } })
    expect(none.getRule({ provider: 'google', model: 'constructor' })).toBeUndefined()
    const own = quotaPolicy({
      provider: 'google',
      models: { constructor: { rpm: 7 } },
      defaults: { rpm: 1 },
    })
    expect(own.getRule({ provider: 'google', model: 'constructor' })).toMatchObject({
      rpm: 7,
    })
  })
})
