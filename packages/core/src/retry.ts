/**
 * First-party retry middleware for @gullabs/core.
 *
 * `retryMiddleware` wraps the call chain and re-invokes the next handler
 * (typically `runAttempt`) on retryable failures, with configurable
 * exponential back-off and full jitter.
 *
 * Each invocation of `next()` produces a FRESH `attemptId` and sinks exactly
 * one record — the retry is transparent to the engine's record-per-attempt
 * guarantee.
 *
 * @module
 */

import { LlmError, classifyError } from './errors.js'
import type { Middleware, Handler, EngineCtx } from './ports.js'
import type { ResolvedRequest } from './ports.js'
import type { LlmResult } from './types.js'

function revalidatePinnedServiceTier(
  req: ResolvedRequest,
  tier: string | undefined,
): string | undefined {
  if (tier === undefined) {
    return undefined
  }

  const supported = req.modelDescriptor?.capabilities?.serviceTiers
  return supported?.includes(tier) === true ? tier : undefined
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link retryMiddleware}.
 */
export interface RetryPolicy {
  /**
   * Maximum number of total attempts (including the first).
   * With `maxAttempts: 3`, the first call + up to 2 retries will be tried.
   * @default 3
   */
  maxAttempts?: number
  /**
   * Base delay in milliseconds for exponential back-off.
   * Actual delay = `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * rand()`.
   * @default 500
   */
  baseDelayMs?: number
  /**
   * Hard cap on the computed back-off delay in milliseconds.
   *
   * It never shortens a provider delay: when the provider asks for a wait
   * (`LlmError.retryAfterMs`) longer than this, the middleware stops retrying
   * and rethrows that error with `retryAfterMs` intact, so a host that can
   * schedule work later reschedules it. A retry before the provider's delay
   * would be refused again and billed again.
   * @default 30_000
   */
  maxDelayMs?: number
  /**
   * Predicate that decides whether to retry a specific error.
   * Called with the `LlmError` and the 1-based attempt number that just failed.
   * @default `(err) => err.retryable === true`
   */
  shouldRetry?(this: void, err: LlmError, attempt: number): boolean
}

// ---------------------------------------------------------------------------
// Pure back-off computation (exported for deterministic unit tests)
// ---------------------------------------------------------------------------

/**
 * Computes the delay in milliseconds before the next retry attempt.
 *
 * Two modes:
 * - **retryAfterMs present**: the provider's delay, unchanged. It is never
 *   clamped; the middleware decides whether to wait that long or give up.
 * - **no retryAfterMs**: exponential back-off with FULL JITTER.
 *   `delay = rand() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))`
 *   where `attempt` is the 1-based number of the attempt that just failed.
 *
 * @param attempt      - 1-based attempt number that just failed.
 * @param policy       - Resolved `baseDelayMs` and `maxDelayMs`.
 * @param retryAfterMs - Provider-supplied hint (ms). `undefined` → use exponential.
 * @param rand         - RNG in [0, 1). Inject `Math.random` in production;
 *                       a deterministic function in tests.
 * @returns Computed delay in milliseconds.
 */
export function computeBackoffMs(
  attempt: number,
  policy: Required<Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'>>,
  retryAfterMs: number | undefined,
  rand: () => number,
): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs
  }
  // Exponential back-off ceiling, capped at maxDelayMs.
  const ceiling = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, attempt - 1),
  )
  // Full jitter: uniform in [0, ceiling).
  return ceiling * rand()
}

// ---------------------------------------------------------------------------
// Abortable sleep (internal)
// ---------------------------------------------------------------------------

/**
 * Returns a promise that resolves after `ms` milliseconds, or rejects with an
 * `LlmError('aborted')` if `signal` fires first.
 *
 * Cleans up all listeners and timers on both resolution and rejection, so no
 * leaks occur even when `ms` is very large.
 */
function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        new LlmError('Request aborted during retry delay', {
          kind: 'aborted',
          retryable: false,
          ...(signal.reason !== undefined ? { cause: signal.reason as unknown } : {}),
        }),
      )
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortHandler)
        abortHandler = undefined
      }
    }

    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)

    if (signal !== undefined) {
      abortHandler = (): void => {
        cleanup()
        reject(
          new LlmError('Request aborted during retry delay', {
            kind: 'aborted',
            retryable: false,
            ...(signal.reason !== undefined ? { cause: signal.reason as unknown } : {}),
          }),
        )
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Creates a {@link Middleware} that retries on retryable errors with
 * exponential back-off and full jitter.
 *
 * Retry semantics:
 * - Retries when `shouldRetry(err, attempt)` returns `true` (default:
 *   `err.retryable === true`) AND the total attempt count is below
 *   `maxAttempts`.
 * - **Never** retries when `err.kind === 'aborted'` — even if a custom
 *   `shouldRetry` policy would say yes.  Abort is terminal.
 * - The back-off delay is abortable by `ctx.signal`: if the caller aborts
 *   during a sleep, the promise rejects promptly with `LlmError('aborted')`.
 *
 * **Provider delays are honoured.** When the failed attempt carries
 * `retryAfterMs`, the middleware sleeps exactly that long, or stops and
 * rethrows the attempt's own error (with `retryAfterMs` intact) when the delay
 * is longer than `maxDelayMs` or longer than the remaining deadline. It never
 * retries before the provider's delay, whatever `shouldRetry` says, because
 * that retry is refused again and billed again. There is no option to clamp.
 *
 * **Overall wall-clock deadline (timeoutMs):**
 * When `req.config.timeoutMs` is set, it is treated as the OVERALL budget for
 * the entire logical call (all attempts + back-off sleep combined).  The
 * middleware enforces this by:
 * 1. Refusing to start a new attempt when the remaining budget is ≤ 0
 *    (a `timeout` error whose `cause` is the last attempt's error).
 * 2. Passing the remaining budget as the per-attempt `config.timeoutMs` so
 *    each attempt's internal timeout shrinks with elapsed time.
 * 3. Rethrowing the attempt's own error at once, without sleeping, when the
 *    back-off is not shorter than the remaining budget: sleeping the budget
 *    away would only replace the real failure with a synthetic timeout.
 *
 * Each invocation of `next()` produces a separate `attemptId` in the sink
 * (because `runAttempt` generates a fresh ID on every call).
 *
 * @param policy - Override any subset of the default retry policy.
 * @param opts   - Injectable `sleep`, `random`, and `now` for deterministic tests.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   // ...
 *   middleware: [retryMiddleware({ maxAttempts: 3 })],
 * })
 * ```
 */
export function retryMiddleware(
  policy?: RetryPolicy,
  opts?: {
    /** Injected sleep function for testing (default: `abortableSleep`). */
    sleep?(this: void, ms: number, signal?: AbortSignal): Promise<void>
    /** Injected RNG for deterministic back-off tests (default: `Math.random`). */
    random?(this: void): number
    /**
     * Injected clock for deterministic deadline tests (default: `Date.now`).
     * Returns elapsed milliseconds since the Unix epoch.
     */
    now?(this: void): number
  },
): Middleware {
  const maxAttempts = policy?.maxAttempts ?? 3
  const baseDelayMs = policy?.baseDelayMs ?? 500
  const maxDelayMs = policy?.maxDelayMs ?? 30_000
  const shouldRetryFn =
    policy?.shouldRetry ?? ((err: LlmError): boolean => err.retryable === true)
  const sleepFn = opts?.sleep ?? abortableSleep
  const rand = opts?.random ?? ((): number => Math.random())
  const nowFn = opts?.now ?? ((): number => Date.now())

  return {
    id: 'retry',
    role: 'retry',

    async intercept(
      req: ResolvedRequest,
      ctx: EngineCtx,
      next: Handler,
    ): Promise<LlmResult> {
      // Capture the overall budget (if set) and the wall-clock start time once,
      // before any attempt runs.  When timeoutMs is undefined, all deadline logic
      // is skipped and behavior is identical to the pre-deadline implementation.
      const timeoutMs = req.config.timeoutMs
      const start = nowFn()
      let attempt = 0
      let pinnedServiceTier: string | undefined
      let lastErr: LlmError | undefined

      for (;;) {
        attempt++

        // ── Pre-attempt budget check ─────────────────────────────────────────
        // Build a (possibly shrunk) request for this attempt.  Always stamp
        // attemptNumber so the engine can record/log which attempt this is.
        // When no overall timeout is set only attemptNumber is added.
        let currentReq: ResolvedRequest = {
          ...req,
          attemptNumber: attempt,
          ...(pinnedServiceTier !== undefined
            ? { config: { ...req.config, serviceTier: pinnedServiceTier } }
            : {}),
        }
        if (timeoutMs !== undefined) {
          const remaining = timeoutMs - (nowFn() - start)
          if (remaining <= 0) {
            // `timeout` is retryable everywhere (the engine's own timeout, a 408,
            // this one): a host may make a new call. This middleware stops
            // because the budget is spent, not because a retry could not help.
            throw new LlmError(
              `Overall timeout budget of ${timeoutMs}ms exhausted before attempt ${attempt}`,
              {
                kind: 'timeout',
                retryable: true,
                ...(lastErr !== undefined ? { cause: lastErr } : {}),
              },
            )
          }
          // Pass the shrinking remaining budget as the per-attempt timeout so
          // the engine's per-attempt AbortSignal respects the overall ceiling.
          // Uses attemptTimeoutMs (not config.timeoutMs) so the caller's original
          // timeoutMs is never mutated and thus never mis-recorded in the audit record.
          currentReq = { ...currentReq, attemptTimeoutMs: remaining }
        }

        try {
          const result = await next(currentReq, ctx)
          pinnedServiceTier = revalidatePinnedServiceTier(req, result.servedServiceTier)
          return result
        } catch (rawErr) {
          const err = classifyError(rawErr)
          lastErr = err
          pinnedServiceTier = revalidatePinnedServiceTier(req, err.servedServiceTier)

          // Abort is always terminal — never retry.
          if (err.kind === 'aborted') throw err

          // Out of attempts — propagate the last error.
          if (attempt >= maxAttempts) throw err

          // Policy veto — propagate without sleeping.
          if (!shouldRetryFn(err, attempt)) throw err

          // ── Provider delay, then post-attempt budget check ────────────────
          // A provider delay is never undercut: a wait longer than `maxDelayMs`
          // ends the retry with the error (and its `retryAfterMs`) intact.
          if (err.retryAfterMs !== undefined && err.retryAfterMs > maxDelayMs) {
            ctx.logger.debug(
              {
                callId: ctx.callId,
                attemptNumber: attempt,
                retryAfterMs: err.retryAfterMs,
                maxDelayMs,
                errorKind: err.kind,
              },
              'llm.call.retry.stopped',
            )
            throw err
          }
          const delayMs = computeBackoffMs(
            attempt,
            { baseDelayMs, maxDelayMs },
            err.retryAfterMs,
            rand,
          )
          if (timeoutMs !== undefined) {
            const remainingAfter = timeoutMs - (nowFn() - start)
            // A wait that uses up the budget leaves no time for the next
            // attempt. Surface this attempt's own error now instead of
            // sleeping and replacing it with a synthetic timeout.
            if (remainingAfter <= 0 || delayMs >= remainingAfter) {
              ctx.logger.debug(
                {
                  callId: ctx.callId,
                  attemptNumber: attempt,
                  delayMs,
                  remainingMs: Math.max(remainingAfter, 0),
                  errorKind: err.kind,
                },
                'llm.call.retry.stopped',
              )
              throw err
            }
          }

          // A3: Emit debug log at the retry decision point so operators can see
          // which attempt failed, how long we back off, and the error kind.
          ctx.logger.debug(
            {
              callId: ctx.callId,
              attemptNumber: attempt,
              delayMs,
              errorKind: err.kind,
              retryable: err.retryable,
            },
            'llm.call.retry',
          )

          await sleepFn(delayMs, ctx.signal)
        }
      }
    },
  }
}
