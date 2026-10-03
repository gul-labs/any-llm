/**
 * Consume-on-allow, deferral cap and middleware role tests for @gullabs/quota.
 *
 * The Upstash store sends ONE Lua `EVAL` per check. These tests run it against
 * a small in-memory emulation of Redis' EVAL semantics (the script body is
 * validated separately against a real Lua interpreter during development);
 * atomicity of the script itself is Redis' guarantee, so the emulator executes
 * each EVAL as a single uninterrupted step, like Redis does.
 */

import { spawnSync } from 'node:child_process'
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
  providerQuotaRateLimiter,
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

  it('a fractional clock sends integer TTLs and integer retryAfterMs', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    const result = await store.checkAndConsume({
      scope: 'google:m',
      nowMs: NOW + 0.5,
      rpm: 1,
      rpd: 5,
    })
    const denied = await store.checkAndConsume({
      scope: 'google:m',
      nowMs: NOW + 0.5,
      rpm: 1,
      rpd: 5,
    })

    const [, , , , , ...ttls] = redis.commands[0]!
    expect([ttls[1], ttls[3]].every((t) => Number.isInteger(t))).toBe(true)
    expect(result.rpm?.allowed).toBe(true)
    expect(Number.isInteger(denied.rpm?.retryAfterMs)).toBe(true)
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

  it('a deferral longer than the default 60 s cap is rate_limited, not retryable, reason quota_window', async () => {
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
      store: deferringStore(60_000, 'rpm'),
    })
    const err = (await mw.intercept(req, ctx, next).catch((e: unknown) => e)) as LlmError

    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 60_000,
    })
    expect(err.reason).toBeUndefined()
  })

  it.each([30_001, 45_000, 59_999])(
    'a %i ms deferral (more than 30 s, within the default cap) stays retryable',
    async (retryAfterMs) => {
      const mw = providerQuotaMiddleware({
        policy,
        store: deferringStore(retryAfterMs, 'rpm'),
      })
      const err = (await mw
        .intercept(req, ctx, next)
        .catch((e: unknown) => e)) as LlmError
      expect(err).toMatchObject({ retryable: true, retryAfterMs })
      expect(err.reason).toBeUndefined()
    },
  )

  it('a deferral just over 60 s fails with reason quota_window', async () => {
    const mw = providerQuotaMiddleware({ policy, store: deferringStore(60_001, 'rpm') })
    const err = (await mw.intercept(req, ctx, next).catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ retryable: false, reason: 'quota_window' })
  })

  it('real rpm windows 10 s and 50 s into the minute defer retryably (the whole range of a per-minute wait)', async () => {
    for (const second of [10, 50]) {
      const at = Date.UTC(2026, 5, 30, 12, 0, second)
      const redis = makeRedisEmulator()
      const store = upstashQuotaStore({ invoke: redis.invoke })
      const mw = providerQuotaMiddleware({
        policy: quotaPolicyForGemini({ models: { m: { rpm: 1 } } }),
        store,
        now: () => at,
      })
      await mw.intercept(req, ctx, async () => ({}) as never)
      const err = (await mw
        .intercept(req, ctx, next)
        .catch((e: unknown) => e)) as LlmError
      expect(err).toMatchObject({
        kind: 'rate_limited',
        retryable: true,
        retryAfterMs: (60 - second) * 1000,
      })
      expect(err.reason).toBeUndefined()
    }
  })

  it('with [retry, quota] a 50 s rpm deferral is slept through and the call completes', async () => {
    const at = Date.UTC(2026, 5, 30, 12, 0, 10)
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })
    const adapter = new FakeAdapter('google', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm',
      warnings: [],
    } satisfies AdapterResult)
    // A second caller has already used this minute's only unit.
    await store.checkAndConsume({ scope: 'google:m', nowMs: at, rpm: 1 })
    let clockNow = at
    const sleeps: number[] = []
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
      clock: new FakeClock(at),
      ids: new FakeIds(),
      middleware: [
        retryMiddleware(
          { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 60_000 },
          {
            sleep: async (ms) => {
              sleeps.push(ms)
              clockNow += ms
            },
            random: () => 1,
            now: () => 0,
          },
        ),
        providerQuotaMiddleware({
          policy: quotaPolicyForGemini({ models: { m: { rpm: 1 } } }),
          store,
          now: () => clockNow,
        }),
      ],
    })

    await expect(
      client.generate(
        { provider: 'google', model: 'm', messages: req.messages },
        { auth: { apiKey: 'k' } },
      ),
    ).resolves.toMatchObject({ text: 'ok' })
    expect(sleeps).toEqual([50_000])
    expect(adapter.calls).toHaveLength(1)
  })

  it('the rate-limiter path honours the same cap', async () => {
    const limiter = providerQuotaRateLimiter({
      policy,
      store: deferringStore(12 * 3_600_000, 'rpd'),
      now: () => NOW,
    })
    await expect(limiter.acquire('google:m')).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'quota_window',
    })

    const perMinute = providerQuotaRateLimiter({
      policy,
      store: deferringStore(45_000, 'rpm'),
      now: () => NOW,
    })
    await expect(perMinute.acquire('google:m')).rejects.toMatchObject({
      retryable: true,
      retryAfterMs: 45_000,
    })

    const custom = providerQuotaRateLimiter({
      policy,
      store: deferringStore(10_000, 'rpm'),
      now: () => NOW,
      maxDeferMs: 5_000,
    })
    await expect(custom.acquire('google:m')).rejects.toMatchObject({
      retryable: false,
      reason: 'quota_window',
    })
  })

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, '5000' as unknown as number])(
    'maxDeferMs %s is rejected with bad_request',
    async (bad) => {
      const store = deferringStore(1, 'rpm')
      expect(() => providerQuotaMiddleware({ policy, store, maxDeferMs: bad })).toThrow(
        LlmError,
      )
      expect(() => providerQuotaRateLimiter({ policy, store, maxDeferMs: bad })).toThrow(
        /maxDeferMs/,
      )
      await expect(
        enforceProviderQuota({
          provider: 'google',
          model: 'm',
          policy,
          store,
          nowMs: NOW,
          maxDeferMs: bad,
        }),
      ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    },
  )

  it('maxDeferMs 0 is valid and makes every deferral non-retryable', async () => {
    const mw = providerQuotaMiddleware({
      policy,
      store: deferringStore(1, 'rpm'),
      maxDeferMs: 0,
    })
    const err = (await mw.intercept(req, ctx, next).catch((e: unknown) => e)) as LlmError
    expect(err).toMatchObject({ retryable: false, reason: 'quota_window' })
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
      maxDeferMs: Number.MAX_SAFE_INTEGER,
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
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
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

describe('quota limits are keyed by the canonical model id', () => {
  it('refuses a limits table keyed by a declared alias instead of silently not limiting', () => {
    const policy = quotaPolicyForGemini({ models: { 'm-001': { rpm: 5 } } })
    expect(() =>
      policy.getRule({ provider: 'google', model: 'm', aliases: ['m-001'] }),
    ).toThrow(/keyed by one of its aliases/)
    expect(() =>
      policy.getRule({ provider: 'google', model: 'm', aliases: ['m-001'] }),
    ).toThrow(LlmError)
    // No aliases known (rate-limiter path) or no alias key: unchanged.
    expect(policy.getRule({ provider: 'google', model: 'm' })).toBeUndefined()
    expect(
      quotaPolicyForGemini({ models: { m: { rpm: 5 }, 'm-001': { rpm: 1 } } }).getRule({
        provider: 'google',
        model: 'm',
        aliases: ['m-001'],
      }),
    ).toMatchObject({ rpm: 5 })
  })

  it('the middleware surfaces it as bad_request on the first call', async () => {
    const mw = providerQuotaMiddleware({
      policy: quotaPolicyForGemini({ models: { 'm-001': { rpm: 5 } } }),
      store: { checkAndConsume: async () => ({}) },
    })
    await expect(
      mw.intercept(
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
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('an outer middleware that swaps modelDescriptor cannot change the scope quota counts under', async () => {
    const seen: string[] = []
    const store: QuotaStore = {
      checkAndConsume: async (input) => {
        seen.push(input.scope)
        return { rpm: { allowed: true, remaining: 1, used: 1 } }
      },
    }
    const other = makePermissiveTestDescriptor({ provider: 'google', model: 'other' })
    const client = createClient({
      adapters: [
        new FakeAdapter('google', {
          message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
          text: 'ok',
          usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
          model: 'm',
          warnings: [],
        }),
      ],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
        other,
      ]),
      clock: new FakeClock(NOW),
      ids: new FakeIds(),
      middleware: [
        {
          id: 'swapper',
          async intercept(r, c, n) {
            return n({ ...r, modelDescriptor: other }, c)
          },
        },
        providerQuotaMiddleware({
          policy: quotaPolicyForGemini({
            models: { m: { rpm: 5 }, other: { rpm: 5 } },
          }),
          store,
        }),
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
    expect(seen).toEqual(['google:m'])
  })
})

/**
 * The shipped Lua, run by a real Lua interpreter against a Redis shim. Opt-in:
 * skipped when no `lua` binary is on PATH (CI installs none; run locally with
 * `brew install lua`). The shim mirrors the Redis behaviours the script relies
 * on, including `PEXPIRE` refusing a non-integer TTL.
 */
const LUA = spawnSync('lua', ['-v'])
const hasLua = LUA.status === 0

function runLua(
  script: string,
  keys: string[],
  argv: Array<string | number>,
  state: Record<string, number>,
): number[] {
  const driver = `
local script, nkeys = ...
local state = {}
for k, v in string.gmatch(os.getenv('QUOTA_STATE') or '', '([^=;]+)=([^;]+)') do state[k] = tonumber(v) end
KEYS = {}
ARGV = {}
for k in string.gmatch(os.getenv('QUOTA_KEYS'), '[^|]+') do KEYS[#KEYS + 1] = k end
for a in string.gmatch(os.getenv('QUOTA_ARGV'), '[^|]+') do ARGV[#ARGV + 1] = a end
redis = {}
function redis.call(cmd, key, arg)
  if cmd == 'GET' then
    local v = state[key]
    if v == nil then return false end
    return tostring(v)
  elseif cmd == 'INCR' then
    state[key] = (state[key] or 0) + 1
    return state[key]
  elseif cmd == 'PEXPIRE' then
    if not string.find(tostring(arg), '^%-?%d+$') then
      error('ERR value is not an integer or out of range')
    end
    return 1
  end
  error('unexpected command ' .. cmd)
end
local fn = assert(load(script))
local out = fn()
local parts = {}
for i, v in ipairs(out) do parts[i] = tostring(math.tointeger(v) or v) end
local st = {}
for k, v in pairs(state) do st[#st + 1] = k .. '=' .. tostring(math.tointeger(v) or v) end
io.write(table.concat(parts, ',') .. '\\n' .. table.concat(st, ';'))
`
  const stateText = Object.entries(state)
    .map(([k, v]) => `${k}=${v}`)
    .join(';')
  const proc = spawnSync('lua', ['-', script, String(keys.length)], {
    input: driver,
    env: {
      ...process.env,
      QUOTA_STATE: stateText,
      QUOTA_KEYS: keys.join('|'),
      QUOTA_ARGV: argv.join('|'),
    },
    encoding: 'utf8',
  })
  if (proc.status !== 0) throw new Error(proc.stderr || 'lua failed')
  const [reply = '', nextState = ''] = proc.stdout.split('\n')
  for (const k of Object.keys(state)) delete state[k]
  for (const pair of nextState.split(';').filter(Boolean)) {
    const [k, v] = pair.split('=')
    state[k!] = Number(v)
  }
  return reply.split(',').map(Number)
}

describe.skipIf(!hasLua)('the shipped Lua script, on a real interpreter', () => {
  async function script(): Promise<string> {
    const cmds: UpstashPipelineCommand[] = []
    await upstashQuotaStore({
      invoke: async (c) => {
        cmds.push(...c)
        return [{ result: [1, 1] }]
      },
    }).checkAndConsume({ scope: 's', nowMs: NOW, rpm: 1 })
    return String(cmds[0]![1])
  }

  it('admits exactly N sequential callers and a denied call consumes nothing', async () => {
    const lua = await script()
    const state: Record<string, number> = {}
    const results = Array.from({ length: 5 }, () =>
      runLua(lua, ['rpm-key', 'rpd-key'], [3, 30_000, 100, 3_600_000], state),
    )
    expect(results.map((r) => r[0])).toEqual([1, 1, 1, 0, 0])
    expect(state).toEqual({ 'rpm-key': 3, 'rpd-key': 3 })
    expect(results[3]).toEqual([0, 3, 3])
  })

  it('a denial on one window leaves the other counter untouched', async () => {
    const lua = await script()
    const state: Record<string, number> = { 'rpm-key': 0, 'rpd-key': 1 }
    const reply = runLua(lua, ['rpm-key', 'rpd-key'], [10, 30_000, 1, 3_600_000], state)
    expect(reply).toEqual([0, 0, 1])
    expect(state).toEqual({ 'rpm-key': 0, 'rpd-key': 1 })
  })

  it('refuses a fractional TTL like Redis does, which is why the store sends integers', async () => {
    const lua = await script()
    expect(() => runLua(lua, ['k'], [3, 1234.5], {})).toThrow(/not an integer/)
    const redis = makeRedisEmulator()
    await upstashQuotaStore({ invoke: redis.invoke }).checkAndConsume({
      scope: 's',
      nowMs: NOW + 0.5,
      rpm: 3,
    })
    const [, , , key, limit, ttl] = redis.commands[0]!
    const state: Record<string, number> = {}
    expect(runLua(lua, [String(key)], [Number(limit), Number(ttl)], state)[0]).toBe(1)
  })
})

describe('providerQuotaMiddleware role and placement', () => {
  const policy = quotaPolicyForGemini({ models: { m: { rpm: 100 } } })
  const registry = createModelRegistry([
    makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
  ])
  const okResult: AdapterResult = {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
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
