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
import { isThenable } from './host-guard.js'
import { MAX_TIMER_MS } from './timer.js'
import type { Middleware, Handler, EngineCtx, Scheduler, TimerHandle } from './ports.js'
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
// Constants
// ---------------------------------------------------------------------------

/**
 * Default `maxDelayMs`: 60 s. It equals `@gullabs/quota`'s default `maxDeferMs`,
 * so a per-minute quota deferral (at most 60 s) is slept on and retried.
 */
const DEFAULT_MAX_DELAY_MS = 60_000

/**
 * The least budget a retry attempt may start with. A window shorter than this
 * cannot complete a provider request, only add a billed row and replace the
 * real error with a timeout, so the middleware stops and rethrows instead.
 */
const MIN_ATTEMPT_WINDOW_MS = 250

/**
 * Most the middleware adds on top of a provider delay: 10 % of it, at most 1 s.
 * The provider's delay is a floor, so spreading the retries of workers that
 * were limited together can only add to it.
 */
const PROVIDER_DELAY_JITTER_FRACTION = 0.1
const PROVIDER_DELAY_JITTER_MAX_MS = 1000

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link retryMiddleware}.
 */
export interface RetryPolicy {
  /**
   * Maximum number of total attempts (including the first). A positive integer,
   * else `bad_request` when the middleware is created.
   * With `maxAttempts: 3`, the first call + up to 2 retries will be tried.
   * @default 3
   */
  maxAttempts?: number
  /**
   * Base delay in milliseconds for exponential back-off.
   * Actual delay = `min(maxDelayMs, baseDelayMs * 2^(attempt-1)) * rand()`.
   * A finite number from 0 to 2147483647, else `bad_request` when the
   * middleware is created.
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
   * would be refused again and billed again. A finite number from 0 to
   * 2147483647, else `bad_request` when the middleware is created.
   *
   * The default equals `@gullabs/quota`'s default `maxDeferMs`, so a
   * per-minute quota deferral (at most 60 s) is slept on and retried; a longer
   * one ends the retry with the deferral error.
   * @default 60_000
   */
  maxDelayMs?: number
  /**
   * Predicate that decides whether to retry a specific error.
   * Called with the `LlmError` and the 1-based attempt number that just failed.
   * Must return a boolean synchronously: a returned promise is refused with
   * `bad_request` (it would be truthy for every error).
   * @default `(err) => err.retryable === true`
   */
  shouldRetry?(this: void, err: LlmError, attempt: number): boolean
}

// ---------------------------------------------------------------------------
// Pure back-off computation (exported for deterministic unit tests)
// ---------------------------------------------------------------------------

/**
 * A provider delay the middleware can act on: a positive finite number. A
 * `NaN`, zero or negative `retryAfterMs` is not a delay (a `setTimeout` would
 * fire it after 1 ms, an immediate retry with no back-off), so it counts as
 * absent and the exponential back-off applies.
 */
function usableDelay(ms: number | undefined): number | undefined {
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/**
 * Computes the delay in milliseconds before the next retry attempt.
 *
 * Two modes:
 * - **retryAfterMs present** (a positive finite number): the provider's delay
 *   plus a small additive jitter, `retryAfterMs + rand() * min(1000,
 *   retryAfterMs / 10)`. The provider's delay is a floor, so it is never
 *   shortened or clamped; the middleware decides whether to wait that long or
 *   give up.
 * - **no usable retryAfterMs**: exponential back-off with FULL JITTER.
 *   `delay = rand() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))`
 *   where `attempt` is the 1-based number of the attempt that just failed.
 *
 * @param attempt      - 1-based attempt number that just failed.
 * @param policy       - Resolved `baseDelayMs` and `maxDelayMs`.
 * @param retryAfterMs - Provider-supplied hint (ms). `undefined`, `NaN`, zero
 *                       and negative values → use exponential.
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
  const hint = usableDelay(retryAfterMs)
  if (hint !== undefined) {
    return (
      hint +
      rand() *
        Math.min(PROVIDER_DELAY_JITTER_MAX_MS, hint * PROVIDER_DELAY_JITTER_FRACTION)
    )
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
 * Returns a promise that resolves after `ms` milliseconds on `scheduler`, or rejects with an
 * `LlmError('aborted')` if `signal` fires first.
 *
 * Cleans up all listeners and timers on both resolution and rejection, so no
 * leaks occur even when `ms` is very large.
 */
function abortableSleep(
  ms: number,
  signal: AbortSignal | undefined,
  scheduler: Scheduler,
): Promise<void> {
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

    let timer: TimerHandle | undefined
    let abortHandler: (() => void) | undefined

    const cleanup = (): void => {
      if (timer !== undefined) {
        scheduler.clearTimeout(timer)
        timer = undefined
      }
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortHandler)
        abortHandler = undefined
      }
    }

    timer = scheduler.setTimeout(() => {
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

/** Throws `bad_request` naming `path` unless `ok`. */
function assertPolicy(ok: boolean, path: string, rule: string, value: unknown): void {
  if (ok) return
  throw new LlmError(`retryMiddleware: ${path} ${rule}, got ${String(value)}.`, {
    kind: 'bad_request',
    retryable: false,
    issues: [{ path, message: `${rule}.` }],
  })
}

function isTimerDelay(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_MS
}

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
 * **Provider delays are honoured.** When the failed attempt carries a usable
 * `retryAfterMs` (positive and finite), the middleware sleeps that long plus a
 * small additive jitter (at most 10 %, and at most 1 s: the delay is a floor),
 * or stops and rethrows the attempt's own error (with `retryAfterMs` intact)
 * when the delay is longer than `maxDelayMs` or does not leave a usable
 * window before the deadline. It never retries before the provider's delay,
 * whatever `shouldRetry` says, because that retry is refused again and billed
 * again. There is no option to clamp.
 *
 * **Deadline (`timeoutMs`).** `config.timeoutMs` is the budget of the whole
 * logical call. The engine starts it when the call starts and puts the end of
 * it on `ctx.deadlineAt` (on `ctx.clock`), so middleware time before this one
 * counts, and this middleware shares the engine's budget instead of keeping
 * its own. The engine also cuts each attempt's window to what is left. When the
 * budget is spent the middleware rethrows the failed attempt's own error, never
 * a synthetic one:
 * 1. A back-off that would leave a window shorter than 250 ms for the next
 *    attempt is not slept: the attempt's error is rethrown at once.
 * 2. A new attempt is not started with less than 250 ms left.
 *
 * Each invocation of `next()` produces a separate `attemptId` in the sink
 * (because `runAttempt` generates a fresh ID on every call).
 *
 * @param policy - Override any subset of the default retry policy. Invalid
 *   numbers are `bad_request` here, not an unbounded loop later.
 * @param opts   - Injectable `sleep` and `random` for deterministic tests.
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
    /**
     * Replaces the sleep (default: an abortable wait on `ctx.scheduler`, so
     * `FakeClock` drives it). A test that only needs to see the delays can
     * record them here; one that needs time to pass advances the clock.
     */
    sleep?(this: void, ms: number, signal?: AbortSignal): Promise<void>
    /** Injected RNG for deterministic back-off tests (default: `Math.random`). */
    random?(this: void): number
  },
): Middleware {
  const maxAttempts = policy?.maxAttempts ?? 3
  const baseDelayMs = policy?.baseDelayMs ?? 500
  const maxDelayMs = policy?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  assertPolicy(
    Number.isInteger(maxAttempts) && maxAttempts >= 1,
    'maxAttempts',
    'must be a positive integer',
    maxAttempts,
  )
  assertPolicy(
    isTimerDelay(baseDelayMs),
    'baseDelayMs',
    `must be a finite number from 0 to ${MAX_TIMER_MS}`,
    baseDelayMs,
  )
  assertPolicy(
    isTimerDelay(maxDelayMs),
    'maxDelayMs',
    `must be a finite number from 0 to ${MAX_TIMER_MS}`,
    maxDelayMs,
  )
  const shouldRetryFn =
    policy?.shouldRetry ?? ((err: LlmError): boolean => err.retryable === true)
  const sleepOverride = opts?.sleep
  const rand = opts?.random ?? ((): number => Math.random())

  return {
    id: 'retry',
    role: 'retry',

    async intercept(
      req: ResolvedRequest,
      ctx: EngineCtx,
      next: Handler,
    ): Promise<LlmResult> {
      let attempt = 0
      let pinnedServiceTier: string | undefined
      let lastErr: LlmError | undefined

      /** Ends the retry with the attempt's own error, and says why. */
      const stop = (err: LlmError, fields: object): never => {
        ctx.logger.debug(
          {
            callId: ctx.callId,
            attemptNumber: attempt,
            errorKind: err.kind,
            ...fields,
          },
          'llm.call.retry.stopped',
        )
        throw err
      }

      for (;;) {
        attempt++

        // Build the request for this attempt. Always stamp attemptNumber so
        // the engine can record/log which attempt this is.
        const currentReq: ResolvedRequest = {
          ...req,
          attemptNumber: attempt,
          ...(pinnedServiceTier !== undefined
            ? { config: { ...req.config, serviceTier: pinnedServiceTier } }
            : {}),
        }

        // A retry needs a window worth dispatching into. (The first attempt
        // always goes: if the deadline already passed, the engine refuses it.)
        if (attempt > 1 && lastErr !== undefined && ctx.deadlineAt !== undefined) {
          const remainingMs = ctx.deadlineAt - ctx.clock.now()
          if (remainingMs < MIN_ATTEMPT_WINDOW_MS) {
            stop(lastErr, {
              reason: 'attempt window too short',
              remainingMs: Math.max(remainingMs, 0),
              minWindowMs: MIN_ATTEMPT_WINDOW_MS,
            })
          }
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
          const verdict = shouldRetryFn(err, attempt) as boolean | PromiseLike<unknown>
          if (isThenable(verdict)) {
            // A promise is truthy, so it would retry every error; and a rejecting
            // one would be an unhandled rejection. Refuse it, with the error that
            // was being judged as the cause.
            void Promise.resolve(verdict).then(undefined, () => {})
            throw new LlmError(
              'retryMiddleware: shouldRetry must return a boolean synchronously; it returned a promise.',
              { kind: 'bad_request', retryable: false, cause: err },
            )
          }
          if (!verdict) throw err

          // ── Provider delay, then deadline check ───────────────────────────
          // A provider delay is never undercut: a wait longer than `maxDelayMs`
          // ends the retry with the error (and its `retryAfterMs`) intact.
          const providerDelayMs = usableDelay(err.retryAfterMs)
          if (providerDelayMs !== undefined && providerDelayMs > maxDelayMs) {
            stop(err, {
              reason: 'provider delay above maxDelayMs',
              retryAfterMs: providerDelayMs,
              maxDelayMs,
            })
          }
          const delayMs = computeBackoffMs(
            attempt,
            { baseDelayMs, maxDelayMs },
            providerDelayMs,
            rand,
          )
          let sleepMs = delayMs
          if (ctx.deadlineAt !== undefined) {
            // What may be slept and still leave the next attempt a usable
            // window. The delay itself (the provider's, or the computed
            // back-off) must fit; only the jitter on top of a provider delay
            // is trimmed to fit.
            const sleepableMs = ctx.deadlineAt - ctx.clock.now() - MIN_ATTEMPT_WINDOW_MS
            if ((providerDelayMs ?? delayMs) > sleepableMs) {
              stop(err, {
                reason: 'delay does not leave a usable window before the deadline',
                delayMs: providerDelayMs ?? delayMs,
                remainingMs: Math.max(ctx.deadlineAt - ctx.clock.now(), 0),
                minWindowMs: MIN_ATTEMPT_WINDOW_MS,
              })
            }
            sleepMs = Math.min(delayMs, sleepableMs)
          }

          // A3: Emit debug log at the retry decision point so operators can see
          // which attempt failed, how long we back off, and the error kind.
          ctx.logger.debug(
            {
              callId: ctx.callId,
              attemptNumber: attempt,
              delayMs: sleepMs,
              errorKind: err.kind,
              retryable: err.retryable,
            },
            'llm.call.retry',
          )

          await (sleepOverride !== undefined
            ? sleepOverride(sleepMs, ctx.signal)
            : abortableSleep(sleepMs, ctx.signal, ctx.scheduler))
        }
      }
    },
  }
}
