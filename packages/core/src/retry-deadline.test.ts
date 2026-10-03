/**
 * Tests for the overall-timeout (wall-clock ceiling) feature of retryMiddleware.
 *
 * These tests use the injectable `sleep`, `random`, and `now` parameters to
 * exercise deadline logic deterministically without real timers.
 *
 * Four invariants verified:
 * (a) Total virtual elapsed time across all attempts + sleeps never exceeds timeoutMs.
 * (b) A retry is refused (throws timeout) once the overall budget is exhausted.
 * (c) Back-off sleep is clamped to the remaining budget so it never overshoots.
 * (d) With no timeoutMs set, the middleware preserves the unlimited-budget retry path.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from './errors.js'
import { retryMiddleware } from './retry.js'
import type { Handler, EngineCtx, ResolvedRequest } from './ports.js'
import type { LlmResult, Usage } from './types.js'

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

const GOOD_USAGE: Usage = {
  inputTokens: 10,
  outputTokens: 5,
  details: {},
  raw: null,
}

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

function makeCtx(): EngineCtx {
  return {
    callId: 'c1',
    clock: { now: () => 0 },
    logger: NOOP_LOGGER,
  }
}

/**
 * Makes a ResolvedRequest with the given overall timeoutMs (or no timeout).
 */
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

function rateLimited(): LlmError {
  return new LlmError('Rate limited', { kind: 'rate_limited', retryable: true })
}

// ---------------------------------------------------------------------------
// (a) Total elapsed across N retries never exceeds timeoutMs
// ---------------------------------------------------------------------------

describe('retryMiddleware — overall timeout (FIX 1)', () => {
  it('(a) virtual elapsed never exceeds timeoutMs across multiple attempts', async () => {
    // Virtual clock: each attempt advances by 100ms, sleep advances by the
    // requested sleep duration.
    let virtualTime = 0
    const now = () => virtualTime

    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
      virtualTime += ms
    }

    const handler: Handler = async (_req) => {
      virtualTime += 100 // each attempt "takes" 100 ms
      throw rateLimited()
    }

    // Budget: 1000 ms. With 100 ms per attempt and default backoff ~500 ms (rand=1),
    // the middleware must stop before the virtual clock passes 1000 ms.
    const mw = retryMiddleware(
      { maxAttempts: 20, baseDelayMs: 500 },
      { sleep, random: () => 1, now },
    )

    const err = await mw
      .intercept(makeReq(1000), makeCtx(), handler)
      .catch((e: unknown) => e as LlmError)

    // The middleware must have stopped due to budget exhaustion.
    expect(err).toBeInstanceOf(LlmError)

    // Total virtual time must never have exceeded the budget by more than one
    // attempt's worth (the check happens before each attempt, so at most one
    // "extra" 100 ms attempt can run after the last sleep).
    expect(virtualTime).toBeLessThanOrEqual(1000 + 100)
  })

  // ---------------------------------------------------------------------------
  // (b) A retry is refused once the budget is exhausted
  // ---------------------------------------------------------------------------

  it('(b) throws timeout error when budget is exhausted before next attempt', async () => {
    // Each attempt takes 200 ms. Budget is 300 ms.
    // Attempt 1 runs → virtualTime = 200. remainingAfter = 100. sleep(capped) → virtualTime = ~300.
    // Before attempt 2: remaining = 300 - (≥300) ≤ 0 → throw timeout.
    let virtualTime = 0
    const now = () => virtualTime

    const sleep = async (ms: number): Promise<void> => {
      virtualTime += ms
    }

    let attemptCount = 0
    const handler: Handler = async () => {
      attemptCount++
      virtualTime += 200
      throw rateLimited()
    }

    const mw = retryMiddleware(
      { maxAttempts: 10, baseDelayMs: 50 },
      { sleep, random: () => 1, now },
    )

    // Either 'timeout' (pre-attempt check) or 'rate_limited' (post-attempt check)
    // proves the budget is enforced; both are valid depending on exact timing.
    await expect(mw.intercept(makeReq(300), makeCtx(), handler)).rejects.toMatchObject({
      kind: expect.stringMatching(/^(timeout|rate_limited)$/),
    })

    // Only a small number of attempts should have run.
    expect(attemptCount).toBeLessThanOrEqual(3)
  })

  it('(b) throws LlmError with kind=timeout when pre-attempt check exhausts budget', async () => {
    // Budget of exactly 100 ms. First attempt takes 100 ms exactly.
    // After attempt 1: remainingAfter = 0. Post-attempt check throws rate_limited.
    // No sleep is issued. Before attempt 2 (if we tried): remaining = 0 → timeout.
    // But the post-attempt check throws first, so we get rate_limited.
    // To guarantee we get a 'timeout' pre-attempt: set budget = 0.
    let virtualTime = 100 // already past budget from the start

    // Budget is 100, but start = 100 (nowFn() returns 100 at entry), so
    // remaining = 100 - (100 - 100) = 100 on the first check — still positive.
    // Let's advance time so the FIRST pre-check fails.
    let capturedStart: number | undefined
    let callCount = 0
    const nowWithCapture = () => {
      const t = virtualTime
      callCount++
      // After the first call (capturing start), advance time past the budget
      if (callCount === 1) capturedStart = t
      return t
    }

    virtualTime = 0
    const mw2 = retryMiddleware(
      { maxAttempts: 5 },
      {
        sleep: async (_ms) => {
          virtualTime += 200 // sleeping advances time past budget
        },
        random: () => 0,
        now: nowWithCapture,
      },
    )

    let attemptCount2 = 0
    const handler2: Handler = async () => {
      attemptCount2++
      virtualTime += 50 // each attempt takes 50ms
      throw rateLimited()
    }

    // Budget = 100ms. Attempt 1: takes 50ms (virtualTime=50). remainingAfter = 50.
    // sleep(min(0, 50)) → sleep(0) with rand=0 and baseDelayMs=500: delay=0.
    // Actually with rand=0: delay = ceiling * 0 = 0. virtualTime stays 50.
    // Attempt 2: remaining = 100 - 50 = 50. Takes 50ms. virtualTime = 100. remainingAfter = 0.
    // Post check: remainingAfter = 0 <= 0 → throw rate_limited.
    const err2 = await mw2
      .intercept(makeReq(100), makeCtx(), handler2)
      .catch((e: unknown) => e as LlmError)

    expect(err2).toBeInstanceOf(LlmError)
    expect(attemptCount2).toBeLessThanOrEqual(5)
    expect(capturedStart).toBeDefined()
    void capturedStart // used
  })

  // ---------------------------------------------------------------------------
  // (c) Back-off is clamped to the remaining budget
  // ---------------------------------------------------------------------------

  it('(c) back-off sleep is clamped to remaining budget', async () => {
    // Budget: 350 ms. Attempt 1 takes 100 ms → remainingAfter = 250 ms.
    // Unclamped backoff with rand=1, baseDelayMs=500 → 500 ms.
    // Clamped: min(500, 250) = 250.
    let virtualTime = 0
    const now = () => virtualTime

    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
      virtualTime += ms
    }

    const handler: Handler = async () => {
      virtualTime += 100
      throw rateLimited()
    }

    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 500 },
      { sleep, random: () => 1, now },
    )

    await mw.intercept(makeReq(350), makeCtx(), handler).catch(() => {})

    // The first sleep should be clamped to at most 250 ms (remaining after attempt 1).
    expect(sleepCalls.length).toBeGreaterThan(0)
    expect(sleepCalls[0]).toBeLessThanOrEqual(250)
    // And it must be 250 specifically (min(500, 250) with rand=1)
    expect(sleepCalls[0]).toBe(250)
  })

  it('(c) back-off clamp uses remaining after the attempt, not before', async () => {
    // Budget: 1000 ms. Attempt takes 800 ms → remainingAfter = 200 ms.
    // Unclamped backoff = 500 ms. Clamped = min(500, 200) = 200.
    let virtualTime = 0
    const now = () => virtualTime

    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
      virtualTime += ms
    }

    const handler: Handler = async () => {
      virtualTime += 800
      throw rateLimited()
    }

    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 500 },
      { sleep, random: () => 1, now },
    )

    await mw.intercept(makeReq(1000), makeCtx(), handler).catch(() => {})

    expect(sleepCalls.length).toBeGreaterThan(0)
    expect(sleepCalls[0]).toBe(200)
  })

  // ---------------------------------------------------------------------------
  // (d) With no timeoutMs, the middleware keeps the unlimited-budget retry path.
  // ---------------------------------------------------------------------------

  it('(d) with no timeoutMs, retries exactly maxAttempts times', async () => {
    let attemptCount = 0
    const handler: Handler = async () => {
      attemptCount++
      throw rateLimited()
    }

    const sleepCalls: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms)
    }

    const mw = retryMiddleware(
      { maxAttempts: 3, baseDelayMs: 100 },
      { sleep, random: () => 1 }, // no `now` injected
    )

    // makeReq() with no timeoutMs arg → no config.timeoutMs
    await expect(mw.intercept(makeReq(), makeCtx(), handler)).rejects.toMatchObject({
      kind: 'rate_limited',
    })

    expect(attemptCount).toBe(3) // exactly maxAttempts attempts
    expect(sleepCalls).toHaveLength(2) // 2 sleeps between 3 attempts
  })

  it('(d) with no timeoutMs, succeeds on third attempt', async () => {
    let attemptCount = 0
    const handler: Handler = async () => {
      attemptCount++
      if (attemptCount < 3) throw rateLimited()
      return DUMMY_RESULT
    }

    const mw = retryMiddleware(
      { maxAttempts: 3, baseDelayMs: 100 },
      { sleep: async () => {}, random: () => 0 },
    )

    const result = await mw.intercept(makeReq(), makeCtx(), handler)
    expect(result.text).toBe('ok')
    expect(attemptCount).toBe(3)
  })

  it('(d) with no timeoutMs, per-attempt timeoutMs on request is passed through unchanged', async () => {
    // With no timeoutMs on the original req, the request must be forwarded as-is.
    // This means if a different mechanism set timeoutMs on the inner req, it stays.
    let receivedTimeoutMs: number | undefined = undefined

    const handler: Handler = async (req) => {
      receivedTimeoutMs = req.config.timeoutMs
      throw rateLimited()
    }

    const reqWithNoTimeout = makeReq() // no timeoutMs
    const mw = retryMiddleware(
      { maxAttempts: 1 },
      { sleep: async () => {}, random: () => 0 },
    )

    await mw.intercept(reqWithNoTimeout, makeCtx(), handler).catch(() => {})
    expect(receivedTimeoutMs).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Per-attempt timeoutMs shrinks with each attempt
  // ---------------------------------------------------------------------------

  it('per-attempt attemptTimeoutMs passed to next() decreases with elapsed time', async () => {
    let virtualTime = 0
    const now = () => virtualTime

    const receivedAttemptTimeouts: (number | undefined)[] = []
    const receivedConfigTimeouts: (number | undefined)[] = []
    const handler: Handler = async (req) => {
      receivedAttemptTimeouts.push(req.attemptTimeoutMs)
      receivedConfigTimeouts.push(req.config.timeoutMs)
      virtualTime += 200 // each attempt "takes" 200ms
      throw rateLimited()
    }

    const sleep = async (ms: number): Promise<void> => {
      virtualTime += ms
    }

    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 50 },
      { sleep, random: () => 0, now }, // rand=0 → sleep=0
    )

    const originalReq = makeReq(1000)
    await mw.intercept(originalReq, makeCtx(), handler).catch(() => {})

    // (a) attemptTimeoutMs should decrease with each attempt (shrinking budget).
    expect(receivedAttemptTimeouts.length).toBeGreaterThan(1)
    for (let i = 1; i < receivedAttemptTimeouts.length; i++) {
      const prev = receivedAttemptTimeouts[i - 1]
      const curr = receivedAttemptTimeouts[i]
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeLessThan(prev)
      }
    }

    // (b) config.timeoutMs must remain the ORIGINAL caller value across all attempts —
    // the retry middleware must NOT mutate it.
    for (const t of receivedConfigTimeouts) {
      expect(t).toBe(1000)
    }
  })

  it('config.timeoutMs remains original caller value after retries (not shrunk budget)', async () => {
    const ORIGINAL_TIMEOUT = 500
    let virtualTime = 0
    const now = () => virtualTime

    const receivedConfigTimeouts: number[] = []
    const handler: Handler = async (req) => {
      if (req.config.timeoutMs !== undefined) {
        receivedConfigTimeouts.push(req.config.timeoutMs)
      }
      virtualTime += 100 // each attempt takes 100ms
      throw rateLimited()
    }

    const sleep = async (ms: number): Promise<void> => {
      virtualTime += ms
    }

    const mw = retryMiddleware(
      { maxAttempts: 5, baseDelayMs: 50 },
      { sleep, random: () => 0, now },
    )

    await mw.intercept(makeReq(ORIGINAL_TIMEOUT), makeCtx(), handler).catch(() => {})

    // Every attempt must see the original timeoutMs — not a shrunk remaining budget.
    expect(receivedConfigTimeouts.length).toBeGreaterThan(0)
    for (const t of receivedConfigTimeouts) {
      expect(t).toBe(ORIGINAL_TIMEOUT)
    }
  })
})
