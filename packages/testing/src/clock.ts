/**
 * FakeClock — a deterministic Clock and Scheduler for use in tests.
 *
 * @module
 */

import type { Clock, Scheduler, TimerHandle } from '@gullabs/core'

/** How many promise turns {@link FakeClock.advanceAsync} lets run after a timer fires. */
const SETTLE_TURNS = 100

interface PendingTimer {
  dueAt: number
  callback: () => void
}

/**
 * A deterministic {@link Clock} and {@link Scheduler} whose time is fully
 * controlled by the caller. Pass it as both `clock` and `scheduler` of
 * `createClient` and every wait the engine owns (attempt timeout, call
 * deadline, sink waits), `retryMiddleware`'s back-off and `FakeAdapter`'s
 * delays run on it: no real time passes, so a test of a 30-second timeout takes
 * microseconds and cannot flake.
 *
 * ```ts
 * const clock = new FakeClock(1_000)
 * clock.now()        // 1000
 * clock.advance(500)
 * clock.now()        // 1500
 * clock.set(0)
 * clock.now()        // 0
 *
 * const client = createClient({ clock, scheduler: clock, adapters, modelRegistry })
 * const pending = client.generate(request, opts)
 * await clock.advanceAsync(30_000) // the call's timeout fires; promise turns settle
 * await expect(pending).rejects.toMatchObject({ kind: 'timeout' })
 * ```
 *
 * Timers fire in order of due time (ties in the order they were set), and while
 * a timer's callback runs `now()` is that timer's due time.
 */
export class FakeClock implements Clock, Scheduler {
  private _ms: number
  private _nextHandle = 1
  private readonly _timers = new Map<number, PendingTimer>()

  /**
   * @param startMs - Initial value returned by `now()`.  Defaults to `0`.
   */
  constructor(startMs: number = 0) {
    this._ms = startMs
  }

  /** Returns the current fake time in milliseconds. */
  now(): number {
    return this._ms
  }

  /** Timers set and not yet fired or cleared. */
  get pendingTimers(): number {
    return this._timers.size
  }

  /** Runs `callback` once the clock has advanced by `ms` (a negative `ms` counts as 0). */
  setTimeout(callback: () => void, ms: number): TimerHandle {
    const handle = this._nextHandle++
    this._timers.set(handle, { dueAt: this._ms + Math.max(ms, 0), callback })
    return handle
  }

  /** Cancels a pending timer; a fired, cleared or unknown handle is ignored. */
  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'number') this._timers.delete(handle)
  }

  /**
   * Advance the clock by `ms` milliseconds, firing every timer that falls due,
   * in order, synchronously. Promise continuations that a timer wakes run after
   * this returns; use {@link FakeClock.advanceAsync} to let them run between
   * timers.
   */
  advance(ms: number): void {
    const target = this._ms + ms
    for (;;) {
      const next = this._nextDue(target)
      if (next === undefined) break
      this._fire(next)
    }
    this._ms = target
  }

  /**
   * Like {@link FakeClock.advance}, but lets promise continuations run after
   * each timer fires (a bounded number of promise turns, no real waiting), so a
   * timer that a continuation schedules inside the window fires too. Await it.
   */
  async advanceAsync(ms: number): Promise<void> {
    const target = this._ms + ms
    await settle()
    for (;;) {
      const next = this._nextDue(target)
      if (next === undefined) break
      this._fire(next)
      await settle()
    }
    this._ms = target
    await settle()
  }

  /**
   * Jump the clock to an absolute millisecond value. A later time fires the
   * timers it passes, as `advance` does; an earlier time only moves the clock
   * back (pending timers keep their due times).
   */
  set(ms: number): void {
    if (ms > this._ms) {
      this.advance(ms - this._ms)
    } else {
      this._ms = ms
    }
  }

  private _nextDue(target: number): number | undefined {
    let best: number | undefined
    let bestDue = Infinity
    for (const [handle, timer] of this._timers) {
      if (timer.dueAt <= target && timer.dueAt < bestDue) {
        best = handle
        bestDue = timer.dueAt
      }
    }
    return best
  }

  private _fire(handle: number): void {
    const timer = this._timers.get(handle)
    if (timer === undefined) return
    this._timers.delete(handle)
    this._ms = Math.max(this._ms, timer.dueAt)
    timer.callback()
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < SETTLE_TURNS; i++) {
    await Promise.resolve()
  }
}
