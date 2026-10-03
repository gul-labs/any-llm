/**
 * Advisory spend preflight for @gullabs/core.
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { EngineCtx, Middleware, ResolvedRequest } from './ports.js'

export interface SpendPreflightOptions {
  /** Middleware id. Default `'spend-preflight'`. Must be unique in the client. */
  id?: string
  /**
   * The ceiling, in micro-USD (a finite number >= 0, else `bad_request` at
   * construction). A call is refused when the spent total has reached it
   * (`spent >= limitMicroUsd`), so `0` refuses every call.
   */
  limitMicroUsd: number
  /**
   * The ledger scope this call spends against (a tenant, a project, a key).
   * A string for one fixed scope, or a function of the request for a client
   * that serves several. Passed to {@link SpendPreflightOptions.spentSoFar}.
   */
  key: string | ((req: ResolvedRequest, ctx: EngineCtx) => string)
  /**
   * The host's own total for `key`, in micro-USD, read from its ledger. The
   * library reads no ledger itself. Must resolve to a finite number >= 0;
   * anything else is `bad_request` (the middleware does not guess). An error it
   * throws fails the call with that error classified.
   */
  spentSoFar: (key: string, ctx: EngineCtx) => number | Promise<number>
}

/**
 * Refuses a call before dispatch when the host's ledger says `key` has already
 * spent its ceiling: `rate_limited`, `retryable: false`,
 * `reason: 'spend_ceiling'`, so the retry middleware does not sleep on it.
 *
 * **Advisory, not an enforced ceiling.** The read and the dispatch are not
 * atomic, so concurrent calls can each pass the check and overshoot; the call
 * that crosses the ceiling is allowed; and billed calls whose usage is unknown
 * (`microUsd: null`) are only counted if the host's `spentSoFar` counts them. A
 * ceiling that holds needs atomic reservation and reconciliation, which this is
 * not.
 *
 * **Placement.** It sets no `role` and works anywhere in the chain. Outside
 * `retryMiddleware` (first in the list) it runs once per logical call and a
 * refusal consumes no quota; inside, it re-reads `spentSoFar` before each
 * attempt, which lets a retry stop once the ceiling is reached mid-call.
 */
export function spendPreflightMiddleware(opts: SpendPreflightOptions): Middleware {
  if (
    typeof opts.limitMicroUsd !== 'number' ||
    !Number.isFinite(opts.limitMicroUsd) ||
    opts.limitMicroUsd < 0
  ) {
    throw new LlmError(
      `spendPreflightMiddleware: limitMicroUsd must be a finite number >= 0, got ${String(opts.limitMicroUsd)}.`,
      { kind: 'bad_request', retryable: false },
    )
  }
  const limit = opts.limitMicroUsd
  return {
    id: opts.id ?? 'spend-preflight',
    async intercept(req, ctx, next) {
      const key = typeof opts.key === 'function' ? opts.key(req, ctx) : opts.key
      if (typeof key !== 'string' || key.length === 0) {
        throw new LlmError('spendPreflightMiddleware: key must be a non-empty string.', {
          kind: 'bad_request',
          retryable: false,
        })
      }
      const spent = await opts.spentSoFar(key, ctx)
      if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0) {
        throw new LlmError(
          `spendPreflightMiddleware: spentSoFar("${key}") must resolve to a finite number >= 0 (micro-USD), got ${String(spent)}.`,
          { kind: 'bad_request', retryable: false },
        )
      }
      if (spent >= limit) {
        throw new LlmError(
          `Spend ceiling reached for "${key}": ${spent} of ${limit} micro-USD spent (advisory preflight).`,
          {
            kind: 'rate_limited',
            retryable: false,
            reason: 'spend_ceiling',
            provider: req.provider,
          },
        )
      }
      return next(req, ctx)
    },
  }
}
