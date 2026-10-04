/**
 * An in-process {@link QuotaStore}: the same windows and the same
 * check-and-consume rule as the Upstash store, in a `Map`.
 *
 * @module
 */

import type { Clock } from '@gullabs/core'
import type {
  QuotaStore,
  QuotaStoreAdjustInput,
  QuotaStoreCheckInput,
  QuotaStoreCheckResult,
} from './index.js'
import { isOverLimit, planWindows, tokenWindowKey, windowResults } from './windows.js'

export interface InMemoryQuotaStoreOptions {
  /**
   * The store's time source for counter expiry, like a Redis server's own
   * clock: a counter is gone once `clock.now()` reaches its expiry. The window
   * a call falls in is still named by the `nowMs` the caller passes. Pass the
   * client's `FakeClock` so one `advance` rolls the windows over. Defaults to
   * the system clock.
   */
  clock?: Clock
  /** Key prefix. Default `gullabs:quota`. */
  prefix?: string
}

interface Counter {
  count: number
  expiresAt: number
}

/**
 * A single-process store for tests and single-node hosts. Counters live in
 * memory and are lost on restart; several processes each count alone, so use
 * `upstashQuotaStore` (or your own shared store) when more than one process
 * sends traffic to the same provider quota.
 *
 * @example
 * ```ts
 * const clock = new FakeClock(Date.UTC(2026, 9, 3, 12))
 * const store = inMemoryQuotaStore({ clock })
 * ```
 */
export function inMemoryQuotaStore(opts: InMemoryQuotaStoreOptions = {}): QuotaStore {
  const prefix = opts.prefix ?? 'gullabs:quota'
  const clock: Clock = opts.clock ?? { now: () => Date.now() }
  const counters = new Map<string, Counter>()

  function read(key: string): number {
    const counter = counters.get(key)
    if (counter === undefined) return 0
    if (clock.now() >= counter.expiresAt) {
      counters.delete(key)
      return 0
    }
    return counter.count
  }

  function sweep(): void {
    const now = clock.now()
    for (const [key, counter] of counters) {
      if (now >= counter.expiresAt) counters.delete(key)
    }
  }

  return {
    checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult> {
      // Every step is synchronous, so the check and the consumption cannot
      // interleave with another caller's.
      sweep()
      const windows = planWindows(prefix, input)
      if (windows.length === 0) return Promise.resolve({})
      const counts = windows.map((w) => read(w.key))
      const consumed = windows.every(
        (w, i) => !isOverLimit(counts[i] ?? 0, w.limit, w.cost),
      )
      if (consumed) {
        const now = clock.now()
        for (const [i, w] of windows.entries()) {
          const count = (counts[i] ?? 0) + w.cost
          counts[i] = count
          counters.set(w.key, { count, expiresAt: now + w.ttlMs })
        }
      }
      return Promise.resolve(
        windowResults(windows, consumed ? 'consumed' : 'denied', counts),
      )
    },

    adjustTokens(input: QuotaStoreAdjustInput): Promise<void> {
      sweep()
      const counter = counters.get(tokenWindowKey(prefix, input.scope, input.nowMs))
      // The window the reservation was made in is gone: nothing to reconcile.
      if (counter !== undefined) {
        counter.count = Math.max(counter.count + input.tokens, 0)
      }
      return Promise.resolve()
    },
  }
}
