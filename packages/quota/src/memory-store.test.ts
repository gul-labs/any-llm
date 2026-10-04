/**
 * `inMemoryQuotaStore({ clock })`: the same windows and check-and-consume
 * rule as the Upstash store, on a `FakeClock`.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { FakeClock } from '@gullabs/testing'
import { inMemoryQuotaStore } from './memory-store.js'
import type { QuotaStoreCheckInput } from './index.js'

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0) // 05:00 PDT on Oct 3
const LA = { timeZone: 'America/Los_Angeles' }

function setup(start = T0) {
  const clock = new FakeClock(start)
  const store = inMemoryQuotaStore({ clock })
  const check = (input: Omit<QuotaStoreCheckInput, 'nowMs'>) =>
    store.checkAndConsume({ ...input, nowMs: clock.now() })
  return { clock, store, check }
}

describe('request windows', () => {
  it('admits up to rpm in a minute, then refuses, and the next minute starts empty', async () => {
    const { clock, check } = setup()

    const first = await check({ scope: 's', rpm: 2 })
    const second = await check({ scope: 's', rpm: 2 })
    const third = await check({ scope: 's', rpm: 2 })

    expect(first.rpm).toEqual({ allowed: true, remaining: 1, used: 1 })
    expect(second.rpm).toEqual({ allowed: true, remaining: 0, used: 2 })
    expect(third.rpm).toMatchObject({ allowed: false, used: 2, retryAfterMs: 60_000 })

    clock.advance(60_000)
    expect((await check({ scope: 's', rpm: 2 })).rpm).toMatchObject({
      allowed: true,
      used: 1,
    })
  })

  it('scopes are independent', async () => {
    const { check } = setup()
    await check({ scope: 'a', rpm: 1 })
    expect((await check({ scope: 'b', rpm: 1 })).rpm?.allowed).toBe(true)
    expect((await check({ scope: 'a', rpm: 1 })).rpm?.allowed).toBe(false)
  })

  it('a denied call consumes nothing from any window, including one still under its limit', async () => {
    const { check } = setup()
    await check({ scope: 's', rpm: 1, rpd: 10 })

    const denied = await check({ scope: 's', rpm: 1, rpd: 10 })
    expect(denied.rpm).toMatchObject({ allowed: false, used: 1 })
    expect(denied.rpd).toMatchObject({ allowed: true, used: 1, remaining: 9 })

    // The day counter still stands at 1: the refused call did not add to it.
    const later = await check({ scope: 's', rpd: 10 })
    expect(later.rpd).toMatchObject({ used: 2 })
  })

  it('concurrent callers at the limit admit exactly the capacity', async () => {
    const { check } = setup()
    const results = await Promise.all(
      Array.from({ length: 20 }, () => check({ scope: 's', rpm: 7 })),
    )
    expect(results.filter((r) => r.rpm?.allowed === true)).toHaveLength(7)
  })

  it('no configured window means nothing to check', async () => {
    const { check } = setup()
    expect(await check({ scope: 's' })).toEqual({})
  })
})

describe('the per-day window and its boundary', () => {
  it('without a boundary the day is the UTC day: it rolls over at 00:00Z', async () => {
    const { clock, check } = setup(Date.UTC(2026, 9, 3, 23, 59, 0))
    expect((await check({ scope: 's', rpd: 1 })).rpd?.allowed).toBe(true)
    const refused = await check({ scope: 's', rpd: 1 })
    expect(refused.rpd).toMatchObject({ allowed: false, retryAfterMs: 60_000 })

    clock.advance(60_000)
    expect((await check({ scope: 's', rpd: 1 })).rpd?.allowed).toBe(true)
  })

  it('with a Pacific boundary the day rolls over at 07:00Z in summer, not at 00:00Z', async () => {
    const { clock, check } = setup(Date.UTC(2026, 9, 3, 6, 59, 0)) // 23:59 PDT Oct 2
    expect((await check({ scope: 's', rpd: 1, dayBoundary: LA })).rpd?.allowed).toBe(true)
    const refused = await check({ scope: 's', rpd: 1, dayBoundary: LA })
    expect(refused.rpd).toMatchObject({ allowed: false, retryAfterMs: 60_000 })

    clock.advance(60_000) // 07:00Z = midnight PDT
    expect((await check({ scope: 's', rpd: 1, dayBoundary: LA })).rpd?.allowed).toBe(true)
  })

  it('the UTC midnight does not reset a Pacific day', async () => {
    const { clock, check } = setup(Date.UTC(2026, 9, 3, 23, 30, 0)) // 16:30 PDT Oct 3
    await check({ scope: 's', rpd: 1, dayBoundary: LA })
    clock.advance(60 * 60_000) // 00:30Z Oct 4 = 17:30 PDT, same Pacific day
    expect((await check({ scope: 's', rpd: 1, dayBoundary: LA })).rpd?.allowed).toBe(
      false,
    )
  })

  it('retryAfterMs is the time left in the Pacific day, across a DST change', async () => {
    // 2026-03-08 is the 23-hour day: from 10:00Z (03:00 PDT) there are 21 hours left.
    const { check } = setup(Date.UTC(2026, 2, 8, 10, 0, 0))
    await check({ scope: 's', rpd: 1, dayBoundary: LA })
    const refused = await check({ scope: 's', rpd: 1, dayBoundary: LA })
    expect(refused.rpd?.retryAfterMs).toBe(21 * 3_600_000)
  })

  it('a counter expires with its window: the store forgets it when the clock passes the TTL', async () => {
    const { clock, store, check } = setup(Date.UTC(2026, 9, 3, 12, 0, 0))
    await check({ scope: 's', rpd: 5, dayBoundary: LA })
    clock.advance(30 * 3_600_000)
    // Reaching back with the old window's nowMs finds no counter: it expired.
    const result = await store.checkAndConsume({
      scope: 's',
      nowMs: Date.UTC(2026, 9, 3, 12, 0, 0),
      rpd: 5,
      dayBoundary: LA,
    })
    expect(result.rpd).toMatchObject({ used: 1 })
  })
})

describe('the token window', () => {
  it('reserves the estimate and refuses a call that would cross tpm', async () => {
    const { check } = setup()

    const first = await check({ scope: 's', tpm: 1_000, tokens: 600 })
    const second = await check({ scope: 's', tpm: 1_000, tokens: 600 })

    expect(first.tpm).toEqual({ allowed: true, remaining: 400, used: 600 })
    expect(second.tpm).toMatchObject({ allowed: false, used: 600, retryAfterMs: 60_000 })
    // A smaller call still fits in what is left.
    expect((await check({ scope: 's', tpm: 1_000, tokens: 400 })).tpm).toMatchObject({
      allowed: true,
      used: 1_000,
    })
    // And now the window is full, even for a 1-token call.
    expect((await check({ scope: 's', tpm: 1_000, tokens: 1 })).tpm?.allowed).toBe(false)
  })

  it('an estimate of 0 is refused only once the window is full', async () => {
    const { check } = setup()
    await check({ scope: 's', tpm: 100, tokens: 100 })
    expect((await check({ scope: 's', tpm: 100 })).tpm?.allowed).toBe(false)
  })

  it('one call larger than the whole window passes into an empty window, then blocks the rest', async () => {
    const { clock, check } = setup()

    const huge = await check({ scope: 's', tpm: 1_000, tokens: 5_000 })
    expect(huge.tpm).toMatchObject({ allowed: true, used: 5_000, remaining: 0 })
    expect((await check({ scope: 's', tpm: 1_000, tokens: 10 })).tpm?.allowed).toBe(false)

    clock.advance(60_000)
    expect((await check({ scope: 's', tpm: 1_000, tokens: 10 })).tpm?.allowed).toBe(true)
  })

  it('a refusal by the token window consumes no request either', async () => {
    const { check } = setup()
    await check({ scope: 's', rpm: 5, tpm: 100, tokens: 90 })
    const denied = await check({ scope: 's', rpm: 5, tpm: 100, tokens: 50 })
    expect(denied.tpm?.allowed).toBe(false)
    expect(denied.rpm).toMatchObject({ allowed: true, used: 1 })
  })

  it('adjustTokens corrects the reservation with real usage, up or down, never below 0', async () => {
    const { store, clock, check } = setup()
    await check({ scope: 's', tpm: 1_000, tokens: 600 })

    await store.adjustTokens({ scope: 's', nowMs: clock.now(), tokens: -500 })
    expect((await check({ scope: 's', tpm: 1_000, tokens: 0 })).tpm).toMatchObject({
      used: 100,
    })

    await store.adjustTokens({ scope: 's', nowMs: clock.now(), tokens: 850 })
    expect((await check({ scope: 's', tpm: 1_000, tokens: 0 })).tpm).toMatchObject({
      used: 950,
    })

    await store.adjustTokens({ scope: 's', nowMs: clock.now(), tokens: -10_000 })
    expect((await check({ scope: 's', tpm: 1_000, tokens: 0 })).tpm).toMatchObject({
      used: 0,
    })
  })

  it('adjustTokens leaves a window that has ended alone', async () => {
    const { store, clock, check } = setup()
    const reservedAt = clock.now()
    await check({ scope: 's', tpm: 1_000, tokens: 600 })
    clock.advance(120_000)

    await store.adjustTokens({ scope: 's', nowMs: reservedAt, tokens: 400 })

    // The old window is gone, so no counter was created for it; the current one is empty.
    expect((await check({ scope: 's', tpm: 1_000, tokens: 0 })).tpm).toMatchObject({
      used: 0,
    })
  })
})
