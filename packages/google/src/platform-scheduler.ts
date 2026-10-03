import type { Scheduler } from '@gullabs/core'

/**
 * The platform's timers, for code called outside the engine (no `ctx.scheduler`)
 * and for a store built without a scheduler.
 */
export const PLATFORM_SCHEDULER: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}
