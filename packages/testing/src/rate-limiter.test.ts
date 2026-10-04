import { describe, it, expect } from 'vitest'
import { inMemoryRateLimiter, scriptedRateLimiter } from './rate-limiter.js'
import { FakeClock } from './clock.js'

describe('inMemoryRateLimiter', () => {
  it('resolves immediately when under the concurrency cap', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 2 })
    const r1 = await limiter.acquire('google:gemini-2.5-pro')
    const r2 = await limiter.acquire('google:gemini-2.5-pro')
    // Both resolved without waiting.
    expect(typeof r1).toBe('function')
    expect(typeof r2).toBe('function')
    r1()
    r2()
  })

  it('resolves immediately with no cap (Infinity default)', async () => {
    const limiter = inMemoryRateLimiter()
    const releases = await Promise.all([
      limiter.acquire('k'),
      limiter.acquire('k'),
      limiter.acquire('k'),
    ])
    for (const r of releases) r()
  })

  it('blocks a second acquire until the first releases (cap=1)', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('google:gemini-2.5-pro')

    let secondResolved = false
    const p2 = limiter.acquire('google:gemini-2.5-pro').then((r) => {
      secondResolved = true
      return r
    })

    // At this point the second acquire is queued but not resolved.
    // We need to yield to the microtask queue.
    await Promise.resolve()
    expect(secondResolved).toBe(false)

    // Releasing slot 1 should unblock slot 2.
    release1()
    const release2 = await p2
    expect(secondResolved).toBe(true)
    release2()
  })

  it('release frees the slot and the next waiter resolves', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 2 })

    const r1 = await limiter.acquire('key')
    const r2 = await limiter.acquire('key')

    // Queue two more waiters.
    let r3Resolved = false
    let r4Resolved = false
    const p3 = limiter.acquire('key').then((r) => {
      r3Resolved = true
      return r
    })
    const p4 = limiter.acquire('key').then((r) => {
      r4Resolved = true
      return r
    })

    await Promise.resolve()
    expect(r3Resolved).toBe(false)
    expect(r4Resolved).toBe(false)

    // Release one slot → r3 should resolve.
    r1()
    const r3 = await p3
    expect(r3Resolved).toBe(true)
    expect(r4Resolved).toBe(false)

    // Release another slot → r4 should resolve.
    r2()
    const r4 = await p4
    expect(r4Resolved).toBe(true)

    r3()
    r4()
  })

  it('keys are independent — cap is per key', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })

    const r1 = await limiter.acquire('provider:model-a')
    // Different key — should resolve immediately even if model-a is saturated.
    const r2 = await limiter.acquire('provider:model-b')

    expect(typeof r1).toBe('function')
    expect(typeof r2).toBe('function')
    r1()
    r2()
  })

  it('abort signal rejects an already-aborted acquire immediately', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    // Saturate the slot.
    const release = await limiter.acquire('key')

    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(limiter.acquire('key', controller.signal)).rejects.toThrow()

    release()
  })

  it('abort signal rejects a queued waiter when signal fires', async () => {
    const limiter = inMemoryRateLimiter({ maxConcurrency: 1 })
    const release1 = await limiter.acquire('key')

    const controller = new AbortController()
    const p = limiter.acquire('key', controller.signal)

    // Abort while it is queued.
    controller.abort(new Error('user cancelled'))

    await expect(p).rejects.toThrow('user cancelled')

    // Releasing the original slot should be fine — queue is now empty.
    release1()
  })

  it('satisfies the RateLimiter interface structurally', () => {
    const limiter: import('@gullabs/core').RateLimiter = inMemoryRateLimiter()
    expect(typeof limiter.acquire).toBe('function')
  })
})

describe('scriptedRateLimiter', () => {
  it('advances an injected FakeClock by delayMs before resolving', async () => {
    const clock = new FakeClock(1_000)
    const limiter = scriptedRateLimiter({ delayMs: 250, clock })

    const release = await limiter.acquire('google:gemini-2.5-pro')

    expect(clock.now()).toBe(1_250)
    expect(typeof release).toBe('function')
    release()
  })

  it('rejects when aborted before the scripted delay resolves', async () => {
    const limiter = scriptedRateLimiter({ delayMs: 10 })
    const controller = new AbortController()
    const acquire = limiter.acquire('google:gemini-2.5-pro', controller.signal)

    controller.abort()

    await expect(acquire).rejects.toThrow()
  })

  it('rejects an already-aborted signal without advancing the clock', async () => {
    const clock = new FakeClock(1_000)
    const limiter = scriptedRateLimiter({ delayMs: 250, clock })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(limiter.acquire('key', controller.signal)).rejects.toThrow()

    // The clock must stay put — an already-aborted signal short-circuits
    // before the scripted delay is ever applied.
    expect(clock.now()).toBe(1_000)
  })
})

describe('scriptedRateLimiter on a scheduler', () => {
  it('waits delayMs on the injected scheduler, so a FakeClock releases it without real time', async () => {
    const clock = new FakeClock()
    const limiter = scriptedRateLimiter({ delayMs: 2_000, scheduler: clock })
    let resolved = false
    const pending = limiter.acquire('k').then((release) => {
      resolved = true
      return release
    })

    await clock.advanceAsync(1_999)
    expect(resolved).toBe(false)
    await clock.advanceAsync(1)
    expect(resolved).toBe(true)
    expect(typeof (await pending)).toBe('function')
    expect(clock.pendingTimers).toBe(0)
  })

  it('an abort during the wait rejects and clears the timer', async () => {
    const clock = new FakeClock()
    const limiter = scriptedRateLimiter({ delayMs: 2_000, scheduler: clock })
    const controller = new AbortController()
    const pending = limiter.acquire('k', controller.signal)
    const outcome = pending.then(
      () => 'resolved',
      (e: unknown) => e,
    )

    controller.abort()

    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
    expect(clock.pendingTimers).toBe(0)
  })
})
