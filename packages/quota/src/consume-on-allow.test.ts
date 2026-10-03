/**
 * Consume-on-allow, deferral cap and middleware role tests for @gullabs/quota.
 *
 * The Upstash store sends ONE Lua `EVAL` per check. These tests run it against
 * a small in-memory emulation of Redis' EVAL semantics (the script body is
 * validated separately against a real Lua interpreter during development);
 * atomicity of the script itself is Redis' guarantee, so the emulator executes
 * each EVAL as a single uninterrupted step, like Redis does.
 */

import { describe, expect, it } from 'vitest'
import {
  createClient,
  createModelRegistry,
  LlmError,
  retryMiddleware,
  type AdapterResult,
} from '@gullabs/core'
import { FakeAdapter, FakeClock, FakeIds } from '@gullabs/testing'
import {
  enforceProviderQuota,
  providerQuotaMiddleware,
  quotaPolicyForGemini,
  upstashQuotaStore,
  type QuotaStore,
  type UpstashPipelineCommand,
} from './index.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

const NOW = Date.UTC(2026, 5, 30, 12, 0, 30)

/** In-memory Redis counters + a faithful JS port of the EVAL script's logic. */
function makeRedisEmulator() {
  const counters = new Map<string, number>()
  const commands: UpstashPipelineCommand[] = []

  async function invoke(cmds: readonly UpstashPipelineCommand[]) {
    await Promise.resolve() // yield: callers interleave, each EVAL stays atomic
    return cmds.map((cmd) => {
      commands.push(cmd)
      const [name, , numKeys, ...rest] = cmd
      if (name !== 'EVAL') throw new Error(`unexpected command ${String(name)}`)
      const n = Number(numKeys)
      const keys = rest.slice(0, n).map(String)
      const argv = rest.slice(n).map(Number)
      const counts = keys.map((k) => counters.get(k) ?? 0)
      const ok = counts.every((c, i) => c < argv[2 * i]!)
      if (ok) {
        keys.forEach((k, i) => {
          counters.set(k, counts[i]! + 1)
          counts[i] = counts[i]! + 1
        })
      }
      return { result: [ok ? 1 : 0, ...counts] }
    })
  }

  return { counters, commands, invoke }
}

const CHECK = { scope: 'google:m', nowMs: NOW }

describe('upstashQuotaStore consume-on-allow', () => {
  it('sends exactly one EVAL with keys, limits and TTLs, and no INCR/PEXPIRE', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    await store.checkAndConsume({ ...CHECK, rpm: 2, rpd: 5 })

    expect(redis.commands).toHaveLength(1)
    const [name, script, numKeys, ...rest] = redis.commands[0]!
    expect(name).toBe('EVAL')
    expect(String(script)).toContain("redis.call('INCR'")
    expect(numKeys).toBe(2)
    expect(rest).toHaveLength(2 + 4)
    expect(String(rest[0])).toContain(':rpm:google:m:')
    expect(String(rest[1])).toContain(':rpd:google:m:')
    // limit, ttl for rpm (30 s left in the minute), then rpd
    expect(rest.slice(2)).toEqual([2, 30_000, 5, 12 * 3_600_000 - 30_000])
  })

  it('allows under the limit and reports used and remaining', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    const result = await store.checkAndConsume({ ...CHECK, rpm: 2, rpd: 5 })

    expect(result.rpm).toEqual({ allowed: true, remaining: 1, used: 1 })
    expect(result.rpd).toEqual({ allowed: true, remaining: 4, used: 1 })
  })

  it('a denied call leaves both counters unchanged, including the window that was still under its limit', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    await store.checkAndConsume({ ...CHECK, rpm: 2, rpd: 100 })
    await store.checkAndConsume({ ...CHECK, rpm: 2, rpd: 100 })
    const before = new Map(redis.counters)

    const denied = await store.checkAndConsume({ ...CHECK, rpm: 2, rpd: 100 })

    expect(denied.rpm).toMatchObject({ allowed: false, remaining: 0, used: 2 })
    expect(denied.rpm?.retryAfterMs).toBe(30_000)
    expect(denied.rpd).toMatchObject({ allowed: true, remaining: 98, used: 2 })
    expect(redis.counters).toEqual(before)

    // And the reverse: the day window is the one that denies.
    const redis2 = makeRedisEmulator()
    const store2 = upstashQuotaStore({ invoke: redis2.invoke })
    await store2.checkAndConsume({ ...CHECK, rpm: 100, rpd: 1 })
    const before2 = new Map(redis2.counters)
    const denied2 = await store2.checkAndConsume({ ...CHECK, rpm: 100, rpd: 1 })
    expect(denied2.rpd).toMatchObject({ allowed: false, used: 1 })
    expect(denied2.rpm).toMatchObject({ allowed: true, used: 1 })
    expect(redis2.counters).toEqual(before2)
  })

  it('concurrent callers at the limit admit exactly N', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.checkAndConsume({ ...CHECK, rpm: 5, rpd: 1000 }),
      ),
    )

    const admitted = results.filter((r) => r.rpm?.allowed === true).length
    expect(admitted).toBe(5)
    const rpmKey = [...redis.counters.keys()].find((k) => k.includes(':rpm:'))!
    expect(redis.counters.get(rpmKey)).toBe(5)
  })

  it('a single configured window sends one key; no configured window sends nothing', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    const onlyRpd = await store.checkAndConsume({ ...CHECK, rpd: 3 })
    expect(onlyRpd.rpm).toBeUndefined()
    expect(onlyRpd.rpd).toMatchObject({ allowed: true, used: 1 })
    expect(redis.commands[0]![2]).toBe(1)

    expect(await store.checkAndConsume(CHECK)).toEqual({})
    expect(redis.commands).toHaveLength(1)
  })

  it('rejects a malformed EVAL reply instead of guessing', async () => {
    const store = upstashQuotaStore({ invoke: async () => [{ result: [1] }] })
    await expect(store.checkAndConsume({ ...CHECK, rpm: 2 })).rejects.toThrow(
      /Unexpected Upstash pipeline result/,
    )
    const errStore = upstashQuotaStore({
      invoke: async () => [{ error: 'ERR Error running script' }],
    })
    await expect(errStore.checkAndConsume({ ...CHECK, rpm: 2 })).rejects.toThrow(
      /Unexpected Upstash pipeline result/,
    )
  })

  it('end to end with the policy: denial does not consume quota', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })
    const policy = quotaPolicyForGemini({ models: { m: { rpm: 1 } } })
    const enforce = () =>
      enforceProviderQuota({ provider: 'google', model: 'm', policy, store, nowMs: NOW })

    await enforce()
    await expect(enforce()).rejects.toMatchObject({ kind: 'rate_limited' })
    await expect(enforce()).rejects.toMatchObject({ kind: 'rate_limited' })

    const rpmKey = [...redis.counters.keys()][0]!
    expect(redis.counters.get(rpmKey)).toBe(1)
  })
})

describe('maxDeferMs', () => {
  function deferringStore(retryAfterMs: number, window: 'rpm' | 'rpd'): QuotaStore {
    return {
      checkAndConsume: async () => ({
        [window]: { allowed: false, retryAfterMs, remaining: 0, used: 1 },
      }),
    }
  }
  const policy = quotaPolicyForGemini({ models: { m: { rpm: 1, rpd: 1 } } })
  const ctx = {
    callId: 'c',
    clock: { now: () => NOW },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const req = {
    provider: 'google',
    model: 'm',
    messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] }],
    config: {},
  }
  const next = async () => {
    throw new Error('next must not run on a deferral')
  }

  it('a deferral longer than the default 30 s cap is rate_limited, not retryable, reason quota_window', async () => {
    const mw = providerQuotaMiddleware({
      policy,
      store: deferringStore(12 * 3_600_000, 'rpd'),
    })
    const err = (await mw.intercept(req, ctx, next).catch((e: unknown) => e)) as LlmError

    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'quota_window',
      retryAfterMs: 12 * 3_600_000,
    })
  })

  it('a deferral within the cap stays retryable with retryAfterMs and no reason', async () => {
    const mw = providerQuotaMiddleware({
      policy,
      store: deferringStore(30_000, 'rpm'),
    })
    const err = (await mw.intercept(req, ctx, next).catch((e: unknown) => e)) as LlmError

    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 30_000,
    })
    expect(err.reason).toBeUndefined()
  })

  it('honors a custom maxDeferMs', async () => {
    const mw = providerQuotaMiddleware({
      policy,
      store: deferringStore(10_000, 'rpm'),
      maxDeferMs: 5_000,
    })
    const err = (await mw.intercept(req, ctx, next).catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ retryable: false, reason: 'quota_window' })

    const permissive = providerQuotaMiddleware({
      policy,
      store: deferringStore(12 * 3_600_000, 'rpd'),
      maxDeferMs: Number.POSITIVE_INFINITY,
    })
    const err2 = (await permissive
      .intercept(req, ctx, next)
      .catch((e: unknown) => e)) as LlmError
    expect(err2).toMatchObject({ retryable: true })
  })

  it('enforceProviderQuota without maxDeferMs applies no cap', async () => {
    const err = (await enforceProviderQuota({
      provider: 'google',
      model: 'm',
      policy,
      store: deferringStore(12 * 3_600_000, 'rpd'),
      nowMs: NOW,
    }).catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ retryable: true })
  })

  it('the retry middleware does not sleep through a capped deferral', async () => {
    const adapter = new FakeAdapter('google', {
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm',
      warnings: [],
    } satisfies AdapterResult)
    let slept = 0
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
      clock: new FakeClock(),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 3, baseDelayMs: 0 },
          {
            sleep: async () => {
              slept++
            },
            random: () => 0,
            now: () => 0,
          },
        ),
        providerQuotaMiddleware({ policy, store: deferringStore(12 * 3_600_000, 'rpd') }),
      ],
    })

    await expect(
      client.generate(
        { provider: 'google', model: 'm', messages: req.messages },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ reason: 'quota_window', retryable: false })
    expect(slept).toBe(0)
    expect(adapter.calls).toHaveLength(0)
  })
})

describe('providerQuotaMiddleware and model aliases', () => {
  it('limits a declared alias under its canonical model id', async () => {
    const seen: string[] = []
    const store: QuotaStore = {
      checkAndConsume: async (input) => {
        seen.push(input.scope)
        return { rpm: { allowed: true, remaining: 1, used: 1 } }
      },
    }
    const mw = providerQuotaMiddleware({
      policy: quotaPolicyForGemini({ models: { m: { rpm: 5 } } }),
      store,
    })
    await mw.intercept(
      {
        provider: 'google',
        model: 'm-001',
        modelDescriptor: makePermissiveTestDescriptor({
          provider: 'google',
          model: 'm',
          aliases: ['m-001'],
        }),
        messages: [],
        config: {},
      },
      {
        callId: 'c',
        clock: { now: () => NOW },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
      async () => ({}) as never,
    )
    expect(seen).toEqual(['google:m'])
  })
})

describe('providerQuotaMiddleware role and placement', () => {
  const policy = quotaPolicyForGemini({ models: { m: { rpm: 100 } } })
  const registry = createModelRegistry([
    makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
  ])
  const okResult: AdapterResult = {
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    model: 'm',
    warnings: [],
  }

  it('sets role "quota" and ignores a custom id for identification', () => {
    const store = upstashQuotaStore({ invoke: makeRedisEmulator().invoke })
    expect(providerQuotaMiddleware({ policy, store }).role).toBe('quota')
    expect(providerQuotaMiddleware({ policy, store, id: 'my-retry' }).role).toBe('quota')
  })

  it('createClient rejects [quota, retry] even when both carry custom ids', () => {
    const store = upstashQuotaStore({ invoke: makeRedisEmulator().invoke })
    const build = () =>
      createClient({
        adapters: [new FakeAdapter('google', okResult)],
        modelRegistry: registry,
        middleware: [
          providerQuotaMiddleware({ policy, store, id: 'billing-guard' }),
          { ...retryMiddleware({ maxAttempts: 2 }), id: 'resilience' },
        ],
      })
    expect(build).toThrow(LlmError)
    expect(build).toThrow(/place quota inside retry/)
  })

  it('with [retry, quota] three attempts consume three quota units', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })
    const flaky = new FakeAdapter('google', [
      new LlmError('t', { kind: 'server', retryable: true }),
      new LlmError('t', { kind: 'server', retryable: true }),
      okResult,
    ])
    const client = createClient({
      adapters: [flaky],
      modelRegistry: registry,
      clock: new FakeClock(NOW),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 3, baseDelayMs: 0 },
          { sleep: async () => {}, random: () => 0, now: () => 0 },
        ),
        providerQuotaMiddleware({ policy, store }),
      ],
    })

    await client.generate(
      {
        provider: 'google',
        model: 'm',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'k' } },
    )

    expect(flaky.calls).toHaveLength(3)
    const rpmKey = [...redis.counters.keys()][0]!
    expect(redis.counters.get(rpmKey)).toBe(3)
  })
})
