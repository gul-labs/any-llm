/**
 * Tests for how retryMiddleware shares the engine's call deadline.
 *
 * The engine puts the end of the logical call's budget on `ctx.deadlineAt`
 * (on `ctx.clock`'s scale). These tests drive the middleware with a virtual
 * clock and an injected `sleep`, so every timing assertion is exact.
 *
 * Invariants verified:
 * (a) The middleware anchors its budget at the engine's deadline, not at the
 *     time it was entered, so middleware time before it counts.
 * (b) It never sleeps into a window shorter than the minimum attempt window,
 *     and never starts an attempt in one: it rethrows the failed attempt's own
 *     error (same object, `retryAfterMs` and `cause` intact), never a
 *     synthetic timeout.
 * (c) A provider delay is a floor: jitter on top of it is trimmed to fit, the
 *     delay itself is never shortened.
 * (d) With no deadline the retry path is unbounded by time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { FakeClock } from '@gullabs/testing'
import { LlmError } from './errors.js'
import { retryMiddleware } from './retry.js'
import type { Handler, EngineCtx, ResolvedRequest } from './ports.js'
import type { LlmResult, Usage } from './types.js'

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

const GOOD_USAGE: Usage = { inputTokens: 10, outputTokens: 5, details: {}, raw: null }

const DUMMY_RESULT: LlmResult = {
  callId: 'c1',
  attemptId: 'a1',
  usage: GOOD_USAGE,
  model: 'gemini-2.5-pro',
  latencyMs: 0,
  warnings: [],
  text: 'ok',
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  continuation: 'history',
}

/** The minimum attempt window the middleware enforces (retry.ts). */
const MIN_WINDOW = 250

/** A virtual clock whose time only moves when a handler or a sleep says so. */
function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

function makeCtx(clock: { now: () => number }, deadlineAt?: number): EngineCtx {
  return {
    callId: 'c1',
    clock,
    scheduler: new FakeClock(),
    logger: NOOP_LOGGER,
    ...(deadlineAt !== undefined ? { deadlineAt } : {}),
  }
}

function makeReq(timeoutMs?: number): ResolvedRequest {
  return {
    provider: 'google',
    model: 'gemini-2.5-pro',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    config: {
      serviceTier: 'flex',
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  }
}

function rateLimited(retryAfterMs?: number): LlmError {
  return new LlmError('Rate limited', {
    kind: 'rate_limited',
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
}

/** Records every sleep and advances the virtual clock by it. */
function makeSleep(clock: { advance: (ms: number) => void }): {
  calls: number[]
  sleep: (ms: number) => Promise<void>
} {
  const calls: number[] = []
  return {
    calls,
    sleep: async (ms) => {
      calls.push(ms)
      clock.advance(ms)
    },
  }
}

describe('retryMiddleware: the engine deadline', () => {
  it('(a) total virtual time never exceeds the deadline across many attempts', async () => {
    const clock = makeClock()
    const { calls, sleep } = makeSleep(clock)
    const original = rateLimited()
    const handler: Handler = async () => {
      clock.advance(100)
      throw original
    }
    const mw = retryMiddleware(
      { maxAttempts: 20, baseDelayMs: 500 },
      { sleep, random: () => 1 },
    )

    const err = await mw
      .intercept(makeReq(1000), makeCtx(clock, 1000), handler)
      .catch((e: unknown) => e)

    // t=100 attempt 1; sleep 500 (fits: 1000-100-250 = 650); t=700 attempt 2;
    // the next 1000 ms back-off leaves no window (1000-700-250 = 50): stop.
    expect(calls).toEqual([500])
    expect(clock.now()).toBe(700)
    expect(err).toBe(original)
  })

  it('(a) anchors at the engine deadline: time spent before the middleware counts', async () => {
    // A middleware ahead of retry used 600 ms of a 1000 ms call. The clock is
    // already at 600 when retry is entered; its own entry time would say 1000
    // ms remain, the engine says 400.
    const clock = makeClock(600)
    const { calls, sleep } = makeSleep(clock)
    const original = rateLimited()
    const handler: Handler = async () => {
      clock.advance(100)
      throw original
    }
    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 500 },
      { sleep, random: () => 1 },
    )

    const err = await mw
      .intercept(makeReq(1000), makeCtx(clock, 1000), handler)
      .catch((e: unknown) => e)

    // t=700 after attempt 1; sleeping 500 would leave 1000-1200 < 250: stop.
    expect(calls).toEqual([])
    expect(err).toBe(original)
  })

  it('(a) a provider delay that fits a budget measured from its own entry but not the engine budget is not slept', async () => {
    const clock = makeClock(500)
    const { calls, sleep } = makeSleep(clock)
    const original = rateLimited(700)
    const handler: Handler = async () => {
      throw original
    }
    const mw = retryMiddleware({ maxAttempts: 3 }, { sleep, random: () => 0 })

    const err = await mw
      .intercept(makeReq(1000), makeCtx(clock, 1000), handler)
      .catch((e: unknown) => e)

    // 700 ms fits in a fresh 1000 ms but 500 ms of the call is gone: 500 left.
    expect(calls).toEqual([])
    expect(err).toBe(original)
    expect((err as LlmError).retryAfterMs).toBe(700)
  })

  it('(b) a back-off that leaves less than the minimum window rethrows the attempt error at once', async () => {
    const clock = makeClock()
    const { calls, sleep } = makeSleep(clock)
    const original = rateLimited()
    const handler: Handler = async () => {
      clock.advance(100)
      throw original
    }
    // After attempt 1: 350 ms left; a 500 ms back-off cannot fit.
    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 500 },
      { sleep, random: () => 1 },
    )

    const err = await mw
      .intercept(makeReq(450), makeCtx(clock, 450), handler)
      .catch((e: unknown) => e)

    expect(err).toBe(original)
    expect(calls).toEqual([])
    expect(clock.now()).toBe(100)
  })

  it('(b) the boundary: a delay that leaves exactly the minimum window is slept, one more ms is not', async () => {
    for (const [delay, sleeps] of [
      [500, [500]],
      [501, []],
    ] as const) {
      const clock = makeClock()
      const { calls, sleep } = makeSleep(clock)
      const handler: Handler = async () => {
        throw rateLimited(delay)
      }
      const mw = retryMiddleware({ maxAttempts: 2 }, { sleep, random: () => 0 })
      // Attempt 1 fails at t=0; a window of exactly MIN_WINDOW must remain.
      await mw
        .intercept(makeReq(), makeCtx(clock, 500 + MIN_WINDOW), handler)
        .catch(() => {})
      expect(calls).toEqual(sleeps)
    }
  })

  it('(b) no attempt starts in a window shorter than the minimum: the previous error is rethrown', async () => {
    // The sleep overshoots (a timer that fires late): 200 ms are left.
    const clock = makeClock()
    const original = rateLimited()
    let attempts = 0
    const handler: Handler = async () => {
      attempts++
      clock.advance(10)
      throw original
    }
    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 100 },
      {
        sleep: async () => {
          clock.advance(900)
        },
        random: () => 0.5,
      },
    )

    const err = await mw
      .intercept(makeReq(1100), makeCtx(clock, 1100), handler)
      .catch((e: unknown) => e)

    expect(attempts).toBe(1)
    expect(err).toBe(original)
    expect((err as LlmError).kind).toBe('rate_limited')
  })

  it('(b) a window of 9 ms after three failed attempts is not dispatched into', async () => {
    const clock = makeClock()
    const original = rateLimited()
    let attempts = 0
    const handler: Handler = async () => {
      attempts++
      clock.advance(60)
      throw original
    }
    const mw = retryMiddleware(
      { maxAttempts: 10, baseDelayMs: 0 },
      { sleep: async () => {}, random: () => 0 },
    )

    const err = await mw
      .intercept(makeReq(200), makeCtx(clock, 200), handler)
      .catch((e: unknown) => e)

    // 200 ms budget, each attempt 60 ms: after attempt 1, 140 left (< 250).
    expect(attempts).toBe(1)
    expect(err).toBe(original)
  })

  it("(b) the rethrown error is the attempt's own, with cause and retryAfterMs intact", async () => {
    const clock = makeClock()
    const cause = new Error('upstream detail')
    const original = new LlmError('Overloaded', {
      kind: 'server',
      retryable: true,
      httpStatus: 503,
      retryAfterMs: 20_000,
      cause,
    })
    const mw = retryMiddleware(
      { maxAttempts: 3 },
      { sleep: async () => {}, random: () => 0 },
    )

    const err = await mw
      .intercept(makeReq(5_000), makeCtx(clock, 5_000), async () => {
        throw original
      })
      .catch((e: unknown) => e)

    expect(err).toBe(original)
    expect((err as LlmError).cause).toBe(cause)
    expect((err as LlmError).retryAfterMs).toBe(20_000)
  })

  it('(c) jitter on a provider delay is trimmed to the sleepable time; the delay itself is not', async () => {
    const clock = makeClock()
    const { calls, sleep } = makeSleep(clock)
    let n = 0
    const handler: Handler = async () => {
      n++
      if (n === 1) throw rateLimited(1_000)
      return DUMMY_RESULT
    }
    // random=1 would add 100 ms (10 % of 1 s). Only 50 ms of slack remain.
    const mw = retryMiddleware({ maxAttempts: 2 }, { sleep, random: () => 1 })

    await mw.intercept(makeReq(), makeCtx(clock, 1_000 + MIN_WINDOW + 50), handler)

    expect(calls).toEqual([1_050])
  })

  it('(c) a back-off that fits sleeps its full length', async () => {
    const clock = makeClock()
    const { calls, sleep } = makeSleep(clock)
    const handler: Handler = async () => {
      clock.advance(100)
      throw rateLimited()
    }
    const mw = retryMiddleware(
      { maxAttempts: 3, baseDelayMs: 500 },
      { sleep, random: () => 0.2 },
    )

    await mw.intercept(makeReq(), makeCtx(clock, 1000), handler).catch(() => {})

    expect(calls[0]).toBe(100)
  })

  it('(d) with no deadline, retries exactly maxAttempts times', async () => {
    let attempts = 0
    const sleepCalls: number[] = []
    const handler: Handler = async () => {
      attempts++
      throw rateLimited()
    }
    const clock = makeClock()
    const mw = retryMiddleware(
      { maxAttempts: 3, baseDelayMs: 100 },
      {
        sleep: async (ms) => {
          sleepCalls.push(ms)
        },
        random: () => 1,
      },
    )

    await expect(mw.intercept(makeReq(), makeCtx(clock), handler)).rejects.toMatchObject({
      kind: 'rate_limited',
    })

    expect(attempts).toBe(3)
    expect(sleepCalls).toHaveLength(2)
  })

  it('(d) with no deadline a huge provider delay up to maxDelayMs is slept in full', async () => {
    const clock = makeClock()
    const { calls, sleep } = makeSleep(clock)
    let n = 0
    const mw = retryMiddleware({ maxAttempts: 2 }, { sleep, random: () => 0 })
    await mw.intercept(makeReq(), makeCtx(clock), async () => {
      n++
      if (n === 1) throw rateLimited(59_000)
      return DUMMY_RESULT
    })
    expect(calls).toEqual([59_000])
  })

  it('leaves config.timeoutMs as the caller set it on every attempt', async () => {
    const clock = makeClock()
    const seen: Array<number | undefined> = []
    const handler: Handler = async (req) => {
      seen.push(req.config.timeoutMs)
      clock.advance(100)
      throw rateLimited()
    }
    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 0 },
      { sleep: async () => {}, random: () => 0 },
    )

    await mw.intercept(makeReq(1000), makeCtx(clock, 1000), handler).catch(() => {})

    expect(seen.length).toBeGreaterThan(1)
    for (const t of seen) expect(t).toBe(1000)
  })
})
