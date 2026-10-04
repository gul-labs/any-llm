/**
 * The one guard every host-supplied callback that must not affect a call goes
 * through: telemetry hooks, logger methods, a limiter's `Release`, a
 * quota event handler, a scheduler's `clearTimeout`.
 *
 * A host writes `async onError(e) { await sentry.flush() }` as naturally as a
 * plain function, and TypeScript accepts it for a `=> void` member. A guard
 * that only catches a synchronous throw leaves that promise's rejection
 * unobserved, and on Node's default (`--unhandled-rejections=throw`) it ends
 * the process after a call that was already billed.
 *
 * @module
 */

import type { Logger } from './ports.js'
import { redactSecrets } from './redact.js'

/**
 * True when `value` is a Promise or any other thenable. Never throws: an object
 * whose `then` cannot be read (a throwing getter or proxy trap) counts as a
 * thenable, because `Promise.resolve` on it turns that throw into a rejection the
 * caller can absorb, where a throw from here would escape it.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false
  }
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return true
  }
}

/** `String(error)` that cannot throw (an error whose `toString` throws), secrets redacted. */
export function describeHostFailure(error: unknown): string {
  try {
    return redactSecrets(String(error))
  } catch {
    return '[unprintable error]'
  }
}

/**
 * Calls a host callback and absorbs every way it can fail.
 *
 * - A synchronous throw is passed to `onFailure`; the result is `undefined`.
 * - A returned thenable gets a rejection handler that passes the rejection to
 *   `onFailure`; the thenable itself is returned unchanged (telemetry's
 *   `onStart` hands it on as the span).
 * - `onFailure` is itself called inside a `try`, so it cannot become an
 *   unhandled rejection or mask the call either.
 *
 * Nothing here awaits the callback: a slow hook never slows a call.
 */
export function guardHostCall<R>(
  call: () => R,
  onFailure: (error: unknown) => unknown,
): R | undefined {
  const report = (error: unknown): void => {
    try {
      const reported: unknown = onFailure(error)
      if (isThenable(reported)) void Promise.resolve(reported).then(undefined, () => {})
    } catch {
      // The reporter failed too; there is nobody left to tell.
    }
  }
  let result: R
  try {
    result = call()
  } catch (error) {
    report(error)
    return undefined
  }
  if (isThenable(result)) {
    // `Promise.resolve` also covers a thenable whose `then` getter throws.
    void Promise.resolve(result).then(undefined, report)
  }
  return result
}

/**
 * Wraps a {@link Logger} so a host logger that throws, or returns a promise
 * that rejects, can never break or mask an LLM call. A failure is reported
 * once, at `debug`, as `llm.hook.failed` with `phase: 'logger.<method>'`; the
 * report itself is guarded silently, so a logger that always fails cannot
 * recurse.
 */
export function makeSafeLogger(logger: Logger): Logger {
  // The methods are typed `=> void`, but a host's may return a promise; the guard
  // needs that value, so it is read as `unknown`.
  const host = logger as unknown as Record<
    keyof Logger,
    (o: object, m: string) => unknown
  >
  let reporting = false
  const call = (method: keyof Logger, o: object, m: string): void => {
    guardHostCall(
      () => host[method](o, m),
      (error) => {
        if (reporting) return
        reporting = true
        try {
          guardHostCall(
            () =>
              host.debug(
                { phase: `logger.${method}`, error: describeHostFailure(error) },
                'llm.hook.failed',
              ),
            () => {},
          )
        } finally {
          reporting = false
        }
      },
    )
  }
  return {
    info: (o, m) => {
      call('info', o, m)
    },
    warn: (o, m) => {
      call('warn', o, m)
    },
    error: (o, m) => {
      call('error', o, m)
    },
    debug: (o, m) => {
      call('debug', o, m)
    },
  }
}
