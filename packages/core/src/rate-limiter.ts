/**
 * inMemoryRateLimiter — an in-process concurrency-capped RateLimiter.
 *
 * Suitable for single-node deployments and tests.  Does NOT use `Date.now()`
 * or `setTimeout` — concurrency control only, fully deterministic.
 *
 * @module
 */

import type { RateLimiter, Release } from './ports.js'

/**
 * Options for {@link inMemoryRateLimiter}.
 */
export interface InMemoryRateLimiterOptions {
  /**
   * Maximum number of concurrent in-flight calls allowed per key.
   * Defaults to `Infinity` (no limit; useful as a spy without restriction).
   */
  maxConcurrency?: number
}

/**
 * Creates an in-memory {@link RateLimiter} that enforces a per-key
 * concurrency cap.
 *
 * When `maxConcurrency` slots are already taken for a given key, subsequent
 * `acquire` calls wait (queue) until a prior caller invokes its {@link Release}.
 * Abort signals are respected — a queued waiter rejects immediately when the
 * signal fires.
 *
 * ```ts
 * const limiter = inMemoryRateLimiter({ maxConcurrency: 2 })
 *
 * const release1 = await limiter.acquire('google:gemini-3.8-flash')
 * const release2 = await limiter.acquire('google:gemini-3.8-flash')
 * // Third call blocks until release1() or release2() is called.
 * const p3 = limiter.acquire('google:gemini-3.8-flash')
 * release1()        // resolves p3
 * const release3 = await p3
 * release2()
 * release3()
 * ```
 *
 * @param opts - See {@link InMemoryRateLimiterOptions}.
 */
export function inMemoryRateLimiter(opts?: InMemoryRateLimiterOptions): RateLimiter {
  const maxConcurrency = opts?.maxConcurrency ?? Infinity

  // Per-key state: current concurrency count + queue of pending resolvers.
  const state = new Map<string, { active: number; queue: Array<() => void> }>()

  function getState(key: string): { active: number; queue: Array<() => void> } {
    let s = state.get(key)
    if (s === undefined) {
      s = { active: 0, queue: [] }
      state.set(key, s)
    }
    return s
  }

  function tryDequeue(key: string): void {
    const s = getState(key)
    if (s.active < maxConcurrency && s.queue.length > 0) {
      const next = s.queue.shift()
      if (next !== undefined) {
        s.active++
        next()
      }
    }
  }

  return {
    acquire(key: string, signal?: AbortSignal): Promise<Release> {
      return new Promise<Release>((resolve, reject) => {
        // Reject immediately if the signal is already aborted.
        if (signal?.aborted === true) {
          const reason: unknown = signal.reason
          reject(
            reason instanceof Error
              ? reason
              : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
          )
          return
        }

        const s = getState(key)

        // Build the Release for this slot.
        const makeRelease = (): Release => {
          let called = false
          return () => {
            if (called) return
            called = true
            s.active--
            tryDequeue(key)
          }
        }

        // Slot is available — claim it immediately.
        if (s.active < maxConcurrency) {
          s.active++
          resolve(makeRelease())
          return
        }

        // No slot available — queue a waiter.
        let abortCleanup: (() => void) | undefined

        const waiter = (): void => {
          // Remove the abort listener before resolving.
          abortCleanup?.()
          abortCleanup = undefined
          resolve(makeRelease())
        }

        s.queue.push(waiter)

        if (signal !== undefined) {
          const abortHandler = (): void => {
            // Remove from the queue so we don't double-resolve.
            const idx = s.queue.indexOf(waiter)
            if (idx !== -1) {
              s.queue.splice(idx, 1)
            }
            abortCleanup = undefined
            const reason: unknown = signal.reason
            reject(
              reason instanceof Error
                ? reason
                : Object.assign(new Error('Aborted'), { name: 'AbortError' }),
            )
          }
          signal.addEventListener('abort', abortHandler, { once: true })
          abortCleanup = () => {
            signal.removeEventListener('abort', abortHandler)
          }
        }
      })
    },
  }
}
