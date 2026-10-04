import { describe, it, expect } from 'vitest'
import { FakeClock } from './clock.js'

describe('FakeClock', () => {
  it('starts at the provided ms value', () => {
    const clock = new FakeClock(1_000)
    expect(clock.now()).toBe(1_000)
  })

  it('defaults to 0 when no start value is given', () => {
    const clock = new FakeClock()
    expect(clock.now()).toBe(0)
  })

  it('advance() increments the current time', () => {
    const clock = new FakeClock(1_000)
    clock.advance(500)
    expect(clock.now()).toBe(1_500)
    clock.advance(200)
    expect(clock.now()).toBe(1_700)
  })

  it('set() jumps to an absolute time', () => {
    const clock = new FakeClock(9_999)
    clock.set(0)
    expect(clock.now()).toBe(0)
    clock.set(42_000)
    expect(clock.now()).toBe(42_000)
  })

  it('advance() then set() is deterministic', () => {
    const clock = new FakeClock(0)
    clock.advance(100)
    clock.advance(200)
    expect(clock.now()).toBe(300)
    clock.set(50)
    expect(clock.now()).toBe(50)
    clock.advance(10)
    expect(clock.now()).toBe(60)
  })

  it('satisfies the Clock interface structurally', () => {
    // Compile-time check: FakeClock is assignable to Clock.
    const clock: import('@gullabs/core').Clock = new FakeClock(0)
    expect(typeof clock.now()).toBe('number')
  })

  it('satisfies the Scheduler interface structurally', () => {
    const scheduler: import('@gullabs/core').Scheduler = new FakeClock(0)
    expect(typeof scheduler.setTimeout).toBe('function')
  })
})

describe('FakeClock as a Scheduler', () => {
  it('fires a timer when the clock reaches it, not before', () => {
    const clock = new FakeClock(1_000)
    const fired: number[] = []
    clock.setTimeout(() => fired.push(clock.now()), 500)

    clock.advance(499)
    expect(fired).toEqual([])
    expect(clock.pendingTimers).toBe(1)

    clock.advance(1)
    expect(fired).toEqual([1_500])
    expect(clock.pendingTimers).toBe(0)
  })

  it('while a callback runs, now() is that timer’s due time, even in one big advance', () => {
    const clock = new FakeClock(0)
    const seen: string[] = []
    clock.setTimeout(() => seen.push(`b@${clock.now()}`), 200)
    clock.setTimeout(() => seen.push(`a@${clock.now()}`), 100)

    clock.advance(1_000)

    expect(seen).toEqual(['a@100', 'b@200'])
    expect(clock.now()).toBe(1_000)
  })

  it('fires timers due at the same time in the order they were set', () => {
    const clock = new FakeClock()
    const order: string[] = []
    clock.setTimeout(() => order.push('first'), 50)
    clock.setTimeout(() => order.push('second'), 50)
    clock.advance(50)
    expect(order).toEqual(['first', 'second'])
  })

  it('a timer set by a callback inside the window fires in the same advance', () => {
    const clock = new FakeClock()
    const order: string[] = []
    clock.setTimeout(() => {
      order.push('outer')
      clock.setTimeout(() => order.push('inner'), 30)
    }, 100)

    clock.advance(130)

    expect(order).toEqual(['outer', 'inner'])
  })

  it('clearTimeout cancels a pending timer; a fired, cleared or foreign handle is ignored', () => {
    const clock = new FakeClock()
    let fired = 0
    const handle = clock.setTimeout(() => fired++, 10)
    clock.clearTimeout(handle)
    clock.clearTimeout(handle)
    clock.clearTimeout(undefined as never)
    clock.clearTimeout('not a handle' as never)
    clock.advance(10)
    expect(fired).toBe(0)

    const done = clock.setTimeout(() => fired++, 5)
    clock.advance(5)
    clock.clearTimeout(done)
    expect(fired).toBe(1)
  })

  it('a zero or negative delay is due at the current time', () => {
    const clock = new FakeClock(100)
    let fired = 0
    clock.setTimeout(() => fired++, 0)
    clock.setTimeout(() => fired++, -50)
    clock.advance(0)
    expect(fired).toBe(2)
  })

  it('set() forward fires the timers it passes; backward only moves the clock', () => {
    const clock = new FakeClock(0)
    let fired = 0
    clock.setTimeout(() => fired++, 100)

    clock.set(150)
    expect(fired).toBe(1)
    expect(clock.now()).toBe(150)

    clock.setTimeout(() => fired++, 100) // due at 250
    clock.set(10)
    expect(clock.now()).toBe(10)
    expect(fired).toBe(1)
    expect(clock.pendingTimers).toBe(1)
  })

  it('advanceAsync lets promise continuations run between timers, so a chained timer fires too', async () => {
    const clock = new FakeClock()
    const order: string[] = []
    const chain = new Promise<void>((resolve) => {
      clock.setTimeout(resolve, 100)
    })
      .then(() => {
        order.push('first')
        return new Promise<void>((resolve) => {
          clock.setTimeout(resolve, 100)
        })
      })
      .then(() => {
        order.push('second')
      })

    await clock.advanceAsync(200)
    await chain

    expect(order).toEqual(['first', 'second'])
    expect(clock.now()).toBe(200)
  })

  it('advance() leaves continuations for later: they run after it returns', async () => {
    const clock = new FakeClock()
    const order: string[] = []
    const p = new Promise<void>((resolve) => {
      clock.setTimeout(resolve, 10)
    }).then(() => order.push('continuation'))

    clock.advance(10)
    order.push('after advance')
    await p

    expect(order).toEqual(['after advance', 'continuation'])
  })
})
