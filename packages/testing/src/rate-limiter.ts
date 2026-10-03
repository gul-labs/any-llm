export { inMemoryRateLimiter, type InMemoryRateLimiterOptions } from '@gullabs/core'
import type { RateLimiter, Release, Scheduler, TimerHandle } from '@gullabs/core'
import { PLATFORM_SCHEDULER } from './platform-scheduler.js'

export interface ScriptedRateLimiterOptions {
  /** Fixed delay (ms) the limiter waits before resolving `acquire`. */
  delayMs: number
  /**
   * Optional deterministic test clock hook. When supplied, `acquire` advances
   * this clock by `delayMs` and resolves on the next microtask instead of
   * sleeping in wall-clock time.
   */
  clock?: { advance(ms: number): void }
  /**
   * Timer source for the wait when `clock` is not given. Pass a `FakeClock` to
   * make the wait follow fake time. Default: platform timers.
   */
  scheduler?: Scheduler
}

/**
 * A RateLimiter test double with an injectable wait, for asserting
 * `queueDelayMs` without live provider traffic or a hand-rolled fake.
 */
export function scriptedRateLimiter(opts: ScriptedRateLimiterOptions): RateLimiter {
  return {
    acquire(_key: string, signal?: AbortSignal): Promise<Release> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }

        const scheduler = opts.scheduler ?? PLATFORM_SCHEDULER
        let timer: TimerHandle | undefined
        const onAbort = (): void => {
          cleanup()
          reject(new DOMException('Aborted', 'AbortError'))
        }
        const cleanup = (): void => {
          if (timer !== undefined) {
            scheduler.clearTimeout(timer)
            timer = undefined
          }
          signal?.removeEventListener('abort', onAbort)
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        if (opts.clock !== undefined) {
          opts.clock.advance(opts.delayMs)
          queueMicrotask(() => {
            cleanup()
            resolve(() => {})
          })
          return
        }

        timer = scheduler.setTimeout(() => {
          cleanup()
          resolve(() => {})
        }, opts.delayMs)
      })
    },
  }
}
