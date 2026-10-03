/**
 * The Upstash store in R8.1: the per-day window in a time zone (key and TTL,
 * DST-safe), token windows and their reconciliation, and the bounded REST call.
 * Timers run on a `FakeClock`; no real time passes.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import { FakeClock } from '@gullabs/testing'
import { upstashQuotaStore, type UpstashPipelineInvoker } from './index.js'
import { makeRedisEmulator } from './redis-emulator.js'

const LA = { timeZone: 'America/Los_Angeles' }
const HOUR = 3_600_000

describe('per-day window with a day boundary', () => {
  it('names the key by the Pacific date, and the TTL is the time to Pacific midnight', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    // 2026-10-03T12:00Z is 05:00 PDT: 19 hours to midnight.
    await store.checkAndConsume({
      scope: 'google:m',
      nowMs: Date.UTC(2026, 9, 3, 12, 0, 0),
      rpd: 5,
      dayBoundary: LA,
    })

    const [, , , key, limit, ttl, cost] = redis.commands[0]!
    expect(String(key)).toBe('gullabs:quota:rpd:google:m:America/Los_Angeles@2026-10-03')
    expect([limit, ttl, cost]).toEqual([5, 19 * HOUR, 1])
  })

  it('without a boundary the key and the TTL are the UTC day', async () => {
    const redis = makeRedisEmulator()
    await upstashQuotaStore({ invoke: redis.invoke }).checkAndConsume({
      scope: 's',
      nowMs: Date.UTC(2026, 9, 3, 12, 0, 0),
      rpd: 5,
    })
    const [, , , key, , ttl] = redis.commands[0]!
    expect(String(key)).toBe('gullabs:quota:rpd:s:2026-10-03')
    expect(ttl).toBe(12 * HOUR)
  })

  it('the TTL follows the 23-hour spring-forward day and the 25-hour fall-back day', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    await store.checkAndConsume({
      scope: 's',
      nowMs: Date.UTC(2026, 2, 8, 8, 0, 0), // PST midnight, start of a 23 h day
      rpd: 5,
      dayBoundary: LA,
    })
    await store.checkAndConsume({
      scope: 's',
      nowMs: Date.UTC(2026, 10, 1, 7, 0, 0), // PDT midnight, start of a 25 h day
      rpd: 5,
      dayBoundary: LA,
    })

    expect(redis.commands[0]![5]).toBe(23 * HOUR)
    expect(redis.commands[1]![5]).toBe(25 * HOUR)
  })

  it('two instants either side of Pacific midnight use two counters; UTC midnight does not split one', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 3, h, m, 0)

    await store.checkAndConsume({ scope: 's', nowMs: at(6, 59), rpd: 1, dayBoundary: LA })
    const sameDay = await store.checkAndConsume({
      scope: 's',
      nowMs: at(6, 59) + 30_000,
      rpd: 1,
      dayBoundary: LA,
    })
    const nextDay = await store.checkAndConsume({
      scope: 's',
      nowMs: at(7, 0),
      rpd: 1,
      dayBoundary: LA,
    })

    expect(sameDay.rpd).toMatchObject({ allowed: false })
    expect(nextDay.rpd).toMatchObject({ allowed: true, used: 1 })
    expect([...redis.counters.keys()].filter((k) => k.includes(':rpd:'))).toHaveLength(2)
  })

  it('a denied day window reports the time left in the Pacific day', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })
    const nowMs = Date.UTC(2026, 9, 3, 12, 0, 0)
    await store.checkAndConsume({ scope: 's', nowMs, rpd: 1, dayBoundary: LA })

    const denied = await store.checkAndConsume({
      scope: 's',
      nowMs,
      rpd: 1,
      dayBoundary: LA,
    })

    expect(denied.rpd).toMatchObject({ allowed: false, retryAfterMs: 19 * HOUR })
  })
})

describe('token windows', () => {
  const nowMs = Date.UTC(2026, 9, 3, 12, 0, 30)

  it('sends the estimate as the cost of the tpm window, with a minute TTL', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    const result = await store.checkAndConsume({
      scope: 's',
      nowMs,
      tpm: 1_000,
      tokens: 250,
    })

    const [, , numKeys, key, limit, ttl, cost] = redis.commands[0]!
    expect(numKeys).toBe(1)
    expect(String(key)).toContain(':tpm:s:')
    expect([limit, ttl, cost]).toEqual([1_000, 30_000, 250])
    expect(result.tpm).toEqual({ allowed: true, remaining: 750, used: 250 })
  })

  it('refuses a call that would cross tpm, consuming nothing; an oversize call enters an empty window', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    await store.checkAndConsume({ scope: 's', nowMs, rpm: 5, tpm: 1_000, tokens: 800 })
    const before = new Map(redis.counters)
    const denied = await store.checkAndConsume({
      scope: 's',
      nowMs,
      rpm: 5,
      tpm: 1_000,
      tokens: 300,
    })
    expect(denied.tpm).toMatchObject({ allowed: false, retryAfterMs: 30_000 })
    expect(denied.rpm).toMatchObject({ allowed: true, used: 1 })
    expect(redis.counters).toEqual(before)

    const fresh = makeRedisEmulator()
    const huge = await upstashQuotaStore({ invoke: fresh.invoke }).checkAndConsume({
      scope: 's',
      nowMs,
      tpm: 1_000,
      tokens: 5_000,
    })
    expect(huge.tpm).toMatchObject({ allowed: true, used: 5_000 })
  })

  it('adjustTokens sends one EVAL on the acquire minute’s tpm key and takes a signed delta', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })
    await store.checkAndConsume({ scope: 's', nowMs, tpm: 1_000, tokens: 600 })

    await store.adjustTokens({ scope: 's', nowMs, tokens: -450 })

    const adjust = redis.commands[1]!
    expect(adjust[0]).toBe('EVAL')
    expect(adjust[2]).toBe(1)
    expect(String(adjust[3])).toContain(':tpm:s:')
    expect(adjust[4]).toBe(-450)
    expect([...redis.counters.values()]).toEqual([150])
  })

  it('adjustTokens on a window that has ended creates nothing and does not fail', async () => {
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke })

    await expect(
      store.adjustTokens({ scope: 's', nowMs, tokens: 400 }),
    ).resolves.toBeUndefined()
    expect(redis.counters.size).toBe(0)
  })

  it('adjustTokens rejects a malformed reply instead of guessing', async () => {
    const store = upstashQuotaStore({
      invoke: async () => [{ error: 'ERR Error running script' }],
    })
    await expect(store.adjustTokens({ scope: 's', nowMs, tokens: 1 })).rejects.toThrow(
      /Unexpected Upstash pipeline result/,
    )
  })
})

describe('each store call is bounded', () => {
  const input = { scope: 's', nowMs: Date.UTC(2026, 9, 3, 12, 0, 0), rpm: 5 }

  /** An invoker that never answers, and says whether its signal fired. */
  function hung(): { invoke: UpstashPipelineInvoker; signals: AbortSignal[] } {
    const signals: AbortSignal[] = []
    return {
      signals,
      invoke: (_commands, signal) => {
        if (signal !== undefined) signals.push(signal)
        return new Promise<never>(() => {})
      },
    }
  }

  function observe<T>(promise: Promise<T>) {
    const o: { settled: boolean; error?: unknown; value?: T } = { settled: false }
    void promise.then(
      (value) => {
        o.settled = true
        o.value = value
      },
      (error: unknown) => {
        o.settled = true
        o.error = error
      },
    )
    return o
  }

  it('times out after 2 s by default, aborting the call it passed on', async () => {
    const clock = new FakeClock()
    const h = hung()
    const store = upstashQuotaStore({ invoke: h.invoke, scheduler: clock })
    const call = observe(store.checkAndConsume(input))

    await clock.advanceAsync(1_999)
    expect(call.settled).toBe(false)
    await clock.advanceAsync(1)

    expect(call.settled).toBe(true)
    expect(call.error).toBeInstanceOf(Error)
    expect((call.error as Error).message).toBe(
      'Upstash quota call timed out after 2000ms',
    )
    expect(h.signals).toHaveLength(1)
    expect(h.signals[0]!.aborted).toBe(true)
    expect(clock.pendingTimers).toBe(0)
  })

  it('honours timeoutMs', async () => {
    const clock = new FakeClock()
    const store = upstashQuotaStore({
      invoke: hung().invoke,
      timeoutMs: 250,
      scheduler: clock,
    })
    const call = observe(store.adjustTokens({ scope: 's', nowMs: 0, tokens: 1 }))

    await clock.advanceAsync(249)
    expect(call.settled).toBe(false)
    await clock.advanceAsync(1)
    expect((call.error as Error).message).toBe('Upstash quota call timed out after 250ms')
  })

  it("passes the caller's signal on: aborting it aborts the call and ends the wait", async () => {
    const clock = new FakeClock()
    const h = hung()
    const store = upstashQuotaStore({ invoke: h.invoke, scheduler: clock })
    const controller = new AbortController()
    const call = observe(store.checkAndConsume({ ...input, signal: controller.signal }))
    await clock.advanceAsync(10)

    controller.abort(new Error('caller gave up'))
    await clock.advanceAsync(0)

    expect(call.settled).toBe(true)
    expect((call.error as Error).message).toBe('caller gave up')
    expect(h.signals[0]!.aborted).toBe(true)
    expect(clock.pendingTimers).toBe(0)
  })

  it('a signal that is already aborted never reaches the store', async () => {
    const clock = new FakeClock()
    const h = hung()
    const store = upstashQuotaStore({ invoke: h.invoke, scheduler: clock })
    const controller = new AbortController()
    controller.abort()

    await expect(
      store.checkAndConsume({ ...input, signal: controller.signal }),
    ).rejects.toBeDefined()
    expect(h.signals).toHaveLength(0)
    expect(clock.pendingTimers).toBe(0)
  })

  it('a prompt answer clears the timer and is returned unchanged', async () => {
    const clock = new FakeClock()
    const redis = makeRedisEmulator()
    const store = upstashQuotaStore({ invoke: redis.invoke, scheduler: clock })

    const result = await store.checkAndConsume(input)

    expect(result.rpm).toMatchObject({ allowed: true })
    expect(clock.pendingTimers).toBe(0)
  })

  it('an error the store raises passes through as it is', async () => {
    const clock = new FakeClock()
    const store = upstashQuotaStore({
      invoke: () => Promise.reject(new Error('HTTP 500')),
      scheduler: clock,
    })
    await expect(store.checkAndConsume(input)).rejects.toThrow('HTTP 500')
    expect(clock.pendingTimers).toBe(0)
  })

  it('the built-in fetch transport receives the bounded signal', async () => {
    const clock = new FakeClock()
    const seen: Array<AbortSignal | null | undefined> = []
    const fakeFetch = ((_url: string, init?: RequestInit) => {
      seen.push(init?.signal)
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const store = upstashQuotaStore({
      url: 'https://redis.example.test',
      token: 'test-token',
      fetch: fakeFetch,
      scheduler: clock,
      timeoutMs: 500,
    })
    const call = observe(store.checkAndConsume(input))

    await clock.advanceAsync(500)

    expect(call.settled).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses timeoutMs %s with bad_request',
    (timeoutMs) => {
      const build = () => upstashQuotaStore({ invoke: hung().invoke, timeoutMs })
      expect(build).toThrow(LlmError)
      expect(build).toThrow(/timeoutMs must be a finite number greater than 0/)
    },
  )
})
