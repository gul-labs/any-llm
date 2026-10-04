import {
  estimateInputTokens,
  guardHostCall,
  LlmError,
  redactSecrets,
  type Middleware,
  type RateLimiter,
  type Release,
  type Scheduler,
  type Usage,
} from '@gullabs/core'
import {
  assertDayBoundary,
  msUntilDayEnds,
  msUntilNextMinute,
  planWindows,
  tokenWindowKey,
  windowResults,
  type DayBoundary,
} from './windows.js'

export { inMemoryQuotaStore } from './memory-store.js'
export type { InMemoryQuotaStoreOptions } from './memory-store.js'
export type { DayBoundary } from './windows.js'

export type QuotaDeferReason = 'rpm_exhausted' | 'rpd_exhausted' | 'tpm_exhausted'
export type QuotaDenyReason = 'provider_disabled'

export type QuotaDecision =
  | { kind: 'allow' }
  | { kind: 'defer'; retryAfterMs: number; scope: string; reason: QuotaDeferReason }
  | { kind: 'deny'; scope: string; reason: QuotaDenyReason }

export type QuotaEvent =
  | {
      type: 'allow'
      provider: string
      model: string
      scope: string
      decision: Extract<QuotaDecision, { kind: 'allow' }>
    }
  | {
      type: 'defer'
      provider: string
      model: string
      scope: string
      decision: Extract<QuotaDecision, { kind: 'defer' }>
    }
  | {
      type: 'deny'
      provider: string
      model: string
      scope: string
      decision: Extract<QuotaDecision, { kind: 'deny' }>
    }
  | {
      type: 'backend_error'
      provider: string
      model: string
      scope: string
      error: unknown
    }

export type QuotaEventHandler = (event: QuotaEvent) => void

export interface QuotaPolicyInput {
  provider: string
  /** The canonical model id (a declared alias is resolved to it by the middleware). */
  model: string
  /**
   * The model's declared aliases, when the caller knows them (the middleware
   * does; the rate-limiter path does not). `quotaPolicyForGemini` uses it to
   * refuse a limits table keyed by an alias, which would never match.
   */
  aliases?: readonly string[]
}

export interface ProviderQuotaRule {
  scope?: string
  /**
   * Requests per minute (the UTC calendar minute): a non-negative integer. `0`
   * disables the provider for this scope, as `0` does for every window.
   */
  rpm?: number
  /**
   * Requests per day: a non-negative integer. `0` disables the provider for
   * this scope: every call is denied with `provider_disabled`, with or without
   * a store. The day is the UTC day unless {@link ProviderQuotaRule.dayBoundary}
   * says otherwise.
   */
  rpd?: number
  /**
   * Input tokens per minute (the UTC calendar minute): a non-negative integer.
   * `0` disables the provider for this scope. A call reserves its estimated
   * input tokens (`hint.estimatedInputTokens`, `estimateInputTokens` for the
   * middleware) and the real usage corrects the reservation after the call.
   */
  tpm?: number
  /** Where the `rpd` window rolls over. Default: UTC midnight. */
  dayBoundary?: DayBoundary
}

export interface ProviderQuotaPolicy {
  getRule(input: QuotaPolicyInput): ProviderQuotaRule | undefined
}

export interface QuotaStoreWindowResult {
  allowed: boolean
  retryAfterMs?: number
  remaining?: number
  used?: number
}

export interface QuotaStoreCheckInput {
  scope: string
  nowMs: number
  rpm?: number
  rpd?: number
  /** Input tokens per minute. */
  tpm?: number
  /**
   * Tokens this call reserves against `tpm` (a non-negative number; absent
   * means 0). Ignored when `tpm` is absent.
   */
  tokens?: number
  /** Where the `rpd` window rolls over. Absent means the UTC day. */
  dayBoundary?: DayBoundary
  signal?: AbortSignal
}

export interface QuotaStoreCheckResult {
  rpm?: QuotaStoreWindowResult
  rpd?: QuotaStoreWindowResult
  tpm?: QuotaStoreWindowResult
}

export interface QuotaStoreAdjustInput {
  scope: string
  /** The `nowMs` of the check being corrected: it names the window. */
  nowMs: number
  /**
   * Added to that minute's `tpm` counter: the real input tokens minus the
   * reservation. An integer, negative when the estimate was too high. The
   * counter never goes below 0, and a window that has already ended is left
   * alone.
   */
  tokens: number
  signal?: AbortSignal
}

export interface QuotaStore {
  /**
   * Check every configured window and consume from each **only if all of them
   * are under their limits**: one unit from `rpm` and `rpd`, `tokens` from
   * `tpm`. A denied call leaves every counter unchanged. The check and the
   * consumption must be atomic: concurrent callers at the limit admit exactly
   * the remaining capacity.
   *
   * A call that would cross `tpm` is denied, except into an empty window: one
   * call larger than the whole window is let through when nothing else is
   * counted, so it is not deferred forever.
   */
  checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult>
  /**
   * Corrects a `tpm` reservation with the call's real usage. Called at most
   * once per admitted call that reserved tokens, after the call, without the
   * call waiting for it: the middleware and the rate limiter start it and move
   * on, so it is at-most-once (a process that ends first loses it, and the
   * reservation then stays, which only over-counts until the minute ends). The
   * store bounds its own call (`upstashQuotaStore` does, with `timeoutMs`). A
   * store that enforces no `tpm` may do nothing.
   */
  adjustTokens(input: QuotaStoreAdjustInput): Promise<void>
}

/**
 * What to do when the store itself fails (a timeout, an HTTP error, a malformed
 * reply). There is no default: the choice is a policy of the host.
 *
 * - `'fail-closed'`: the call fails with an `LlmError` of `kind: 'server'`,
 *   `reason: 'quota_store_unavailable'`, `retryable: false` (the store's own
 *   error is its `cause`), so no call can exceed a quota the store could not
 *   confirm. It is not retried: a retry would repeat the failure against a
 *   store that is already struggling. The call never reached the provider, and
 *   its ledger row says so.
 * - `'fail-open'`: the call goes ahead unchecked, so a store outage does not
 *   stop traffic.
 *
 * Either way a `backend_error` event is emitted. A caller abort or a deadline
 * that interrupts the store call is never fail-open: that call is over.
 */
export type QuotaStoreErrorMode = 'fail-open' | 'fail-closed'

/**
 * Store wiring for the middleware and {@link enforceProviderQuota}. Without a
 * `store`, rules still evaluate (`rpd: 0` denies) but window checks are skipped.
 */
export type QuotaStoreOptions =
  | { store: QuotaStore; onStoreError: QuotaStoreErrorMode }
  | { store?: undefined; onStoreError?: undefined }

export interface CheckProviderQuotaOptions {
  provider: string
  model: string
  /** Declared aliases of `model`, passed through to {@link QuotaPolicyInput.aliases}. */
  aliases?: readonly string[]
  policy: ProviderQuotaPolicy
  store: QuotaStore
  nowMs?: number
  /** Estimated input tokens the call reserves against `tpm`. Absent means 0. */
  estimatedInputTokens?: number
  signal?: AbortSignal
}

export type EnforceProviderQuotaOptions = Omit<CheckProviderQuotaOptions, 'store'> &
  QuotaStoreOptions & {
    onEvent?: QuotaEventHandler
    /**
     * Called for a call whose rule has windows the missing `store` could not
     * check; the middleware turns it into its once-per-scope warning.
     */
    onWindowChecksSkipped?: (scope: string) => void
    /**
     * Called when correcting the `tpm` reservation fails (after the
     * `backend_error` event); the middleware logs it. It must not throw.
     */
    onReconcileError?: (scope: string, error: unknown) => void
    /**
     * Longest `retryAfterMs` a deferral may carry and still be thrown as a
     * retryable `rate_limited` error. A longer deferral is thrown as
     * `rate_limited`, `retryable: false`, `reason: 'quota_window'`. Unset means
     * no cap. When set it must be a finite number >= 0, else `bad_request`.
     */
    maxDeferMs?: number
  }

export type ProviderQuotaMiddlewareOptions = QuotaStoreOptions & {
  id?: string
  policy: ProviderQuotaPolicy
  onEvent?: QuotaEventHandler
  now?: () => number
  /**
   * Longest quota deferral, in milliseconds, the middleware will surface as a
   * retryable `rate_limited` error. A deferral that would wait longer (a
   * per-day window, say) fails with `rate_limited`, `retryable: false`,
   * `reason: 'quota_window'`, so the retry middleware does not sleep through
   * it. Default 60 000: the cap exists to stop multi-hour windows (a per-day
   * limit) being slept on, so every per-minute deferral (at most 60 s) stays
   * retryable. Must be a finite number >= 0, else `bad_request` at
   * construction. Every deferral that stays retryable consumes one of the retry
   * middleware's `maxAttempts`. The retry middleware sleeps exactly the
   * deferral (plus a little jitter) when it is at most its own `maxDelayMs`,
   * whose default is this default (60 000), and when it leaves a usable window
   * before `timeoutMs`; a deferral beyond either ends the retry with the
   * deferral error and its `retryAfterMs`, never waking early to be deferred
   * again. Keep the retry `maxDelayMs` at or above this value for every
   * retryable deferral to be waited out.
   */
  maxDeferMs?: number
}

export interface ProviderQuotaRateLimiterOptions {
  policy: ProviderQuotaPolicy
  store: QuotaStore
  /** What to do when the store fails; see {@link QuotaStoreErrorMode}. No default. */
  onStoreError: QuotaStoreErrorMode
  onEvent?: QuotaEventHandler
  now?: () => number
  /**
   * Same cap and default as {@link ProviderQuotaMiddlewareOptions.maxDeferMs}:
   * a deferral longer than this fails with `rate_limited`, `retryable: false`,
   * `reason: 'quota_window'` instead of making the retry middleware sleep
   * through it.
   */
  maxDeferMs?: number
}

/** The limits of one model (or the defaults) for {@link quotaPolicy}. */
export interface QuotaLimits {
  rpm?: number
  rpd?: number
  tpm?: number
}

export interface QuotaPolicyOptions {
  /** The provider id the policy applies to; other providers are not limited. */
  provider: string
  /** Limits by canonical model id. A key that is a declared alias is refused. */
  models: Record<string, QuotaLimits>
  /** Limits for a model of `provider` that `models` does not list. Absent means unlimited. */
  defaults?: QuotaLimits
  /** Where the `rpd` window rolls over. Default: UTC midnight. */
  dayBoundary?: DayBoundary
  scope?: (input: QuotaPolicyInput) => string
}

/** Gemini limits per model: requests per minute, requests per day, input tokens per minute. */
export type GeminiQuotaLimits = QuotaLimits

export interface GeminiQuotaPolicyOptions {
  /** Default `'google'`. */
  provider?: string
  models: Record<string, GeminiQuotaLimits>
  defaults?: GeminiQuotaLimits
  scope?: (input: QuotaPolicyInput) => string
}

/**
 * xAI limits per model. xAI states limits as requests per second and tokens
 * per minute, per team and per tier, and documents no daily limit, so there is
 * no `rpd` here; the per-second figure is `rpm / 60`.
 */
export interface XaiQuotaLimits {
  rpm?: number
  tpm?: number
}

export interface XaiQuotaPolicyOptions {
  /** Default `'xai'`. */
  provider?: string
  models: Record<string, XaiQuotaLimits>
  defaults?: XaiQuotaLimits
  scope?: (input: QuotaPolicyInput) => string
}

export type UpstashPipelineCommand = readonly [string, ...Array<string | number>]
export type UpstashPipelineInvoker = (
  commands: readonly UpstashPipelineCommand[],
  signal?: AbortSignal,
) => Promise<readonly unknown[]>

export interface UpstashQuotaStoreOptions {
  prefix?: string
  invoke?: UpstashPipelineInvoker
  url?: string
  token?: string
  fetch?: typeof globalThis.fetch
  /**
   * Longest each store call (one REST round trip) may take, in milliseconds: a
   * finite number greater than 0 and at most 2147483647, else `bad_request`.
   * A call still pending then is aborted (its signal fires) and fails with a
   * timeout error, so a slow store cannot hold a call past its own
   * `config.timeoutMs`: the engine starts the attempt timer only after the
   * middleware returns. The caller's signal also aborts the call. Applies to a
   * custom `invoke` as well.
   * @default 2000
   */
  timeoutMs?: number
  /** Timer source for `timeoutMs`; pass the client's `FakeClock` in tests. Default: platform timers. */
  scheduler?: Scheduler
}

interface ResolvedQuotaRule {
  configured: boolean
  scope: string
  rpm?: number
  rpd?: number
  tpm?: number
  dayBoundary?: DayBoundary
}

/** What an admitted call may later correct: the tokens it reserved against `tpm`. */
export interface QuotaAdmission {
  /**
   * Corrects the call's `tpm` reservation with its real usage. Does nothing
   * when the call reserved nothing or `usage` is absent, and corrects at most
   * once however often it is called. Never throws: a store failure is emitted
   * as a `backend_error` event.
   */
  reconcile(usage?: Usage): Promise<void>
}

const NO_ADMISSION: QuotaAdmission = { reconcile: () => Promise.resolve() }

const DEFAULT_MAX_DEFER_MS = 60_000

const GEMINI_DAY_BOUNDARY: DayBoundary = { timeZone: 'America/Los_Angeles' }

const DEFAULT_UPSTASH_TIMEOUT_MS = 2000

/** The longest `setTimeout` delay Node honours (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647

function validateStoreErrorMode(value: unknown): void {
  if (value !== 'fail-open' && value !== 'fail-closed') {
    throw new LlmError(
      `Invalid quota option "onStoreError": must be 'fail-open' or 'fail-closed' (there is no default), got ${String(value)}`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

function validateMaxDeferMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LlmError(
      `Invalid quota option "maxDeferMs": must be a finite number >= 0, got ${String(value)}`,
      { kind: 'bad_request', retryable: false },
    )
  }
  return value
}

/**
 * Builds a {@link ProviderQuotaPolicy} for one provider from per-model limits.
 * Limits are looked up by the canonical model id (the middleware resolves an
 * alias to it first); a `models` table keyed by an alias throws `bad_request`
 * instead of silently never matching.
 *
 * @example
 * ```ts
 * const policy = quotaPolicy({
 *   provider: 'google',
 *   models: { 'gemini-2.5-pro': { rpm: 150, tpm: 2_000_000 } },
 *   defaults: { rpm: 10 },
 * })
 * ```
 */
export function quotaPolicy(opts: QuotaPolicyOptions): ProviderQuotaPolicy {
  assertKnownKeys(
    opts,
    ['provider', 'models', 'defaults', 'dayBoundary', 'scope'],
    'quotaPolicy',
  )
  assertKnownLimitKeys(opts, ['rpm', 'rpd', 'tpm'], 'quotaPolicy')
  const dayBoundary =
    opts.dayBoundary === undefined
      ? undefined
      : assertDayBoundary(opts.dayBoundary, 'dayBoundary')

  return {
    getRule(input: QuotaPolicyInput): ProviderQuotaRule | undefined {
      if (input.provider !== opts.provider) return undefined

      if (
        opts.models[input.model] === undefined &&
        (input.aliases ?? []).some((alias) => opts.models[alias] !== undefined)
      ) {
        throw new LlmError(
          `Quota limits for "${input.model}" are keyed by one of its aliases; limits are looked up by the canonical model id "${input.model}", so the alias key would never match. Key the limits by "${input.model}".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      const limits = opts.models[input.model] ?? opts.defaults
      if (limits === undefined) return undefined

      const rule: ProviderQuotaRule = {
        scope: opts.scope?.(input) ?? defaultScope(input.provider, input.model),
      }

      if (limits.rpm !== undefined) {
        rule.rpm = limits.rpm
      }
      if (limits.rpd !== undefined) {
        rule.rpd = limits.rpd
      }
      if (limits.tpm !== undefined) {
        rule.tpm = limits.tpm
      }
      if (dayBoundary !== undefined) {
        rule.dayBoundary = dayBoundary
      }

      return rule
    },
  }
}

/**
 * The Gemini preset over {@link quotaPolicy}: provider `google`, and the
 * per-day window rolls over at midnight in `America/Los_Angeles`.
 *
 * Source for the time zone: Google's rate-limits page,
 * https://ai.google.dev/gemini-api/docs/rate-limits, re-read on 2026-10-03.
 * It states that requests-per-day (RPD) quotas reset at midnight Pacific
 * time, and that limits apply per project, not per API key (so use one scope
 * per project). It names three dimensions: RPM, TPM (input tokens) and RPD. The
 * page gives no per-model numbers (they depend on the project's tier and are
 * shown in AI Studio), so the limits are the host's own. Pacific time observes
 * daylight saving, so the day is 23, 24 or 25 hours long twice a year; the
 * boundary follows the zone's rules.
 */
export function quotaPolicyForGemini(
  opts: GeminiQuotaPolicyOptions,
): ProviderQuotaPolicy {
  assertKnownKeys(
    opts,
    ['provider', 'models', 'defaults', 'scope'],
    'quotaPolicyForGemini',
  )
  return quotaPolicy({
    provider: opts.provider ?? 'google',
    models: opts.models,
    ...(opts.defaults !== undefined ? { defaults: opts.defaults } : {}),
    dayBoundary: GEMINI_DAY_BOUNDARY,
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  })
}

/**
 * The xAI preset over {@link quotaPolicy}: provider `xai`, requests per minute
 * and tokens per minute, no day window.
 *
 * It carries no numbers. xAI's rate-limits page,
 * https://docs.x.ai/developers/rate-limits, re-read on 2026-10-03, publishes
 * numeric limits per tier and model, but a team's tier follows
 * its cumulative spend since 2026-01-01 and moves automatically, so any
 * number baked in here would be wrong for most teams. Read your team's limits
 * on the Models page of the xAI Console and pass them in. The page states
 * requests per second and tokens per minute (the per-second figure is the
 * per-minute request budget divided by 60) and no daily limit, so this preset
 * has no `rpd` and no day boundary.
 */
export function quotaPolicyForXai(opts: XaiQuotaPolicyOptions): ProviderQuotaPolicy {
  assertKnownKeys(opts, ['provider', 'models', 'defaults', 'scope'], 'quotaPolicyForXai')
  assertKnownLimitKeys(opts, ['rpm', 'tpm'], 'quotaPolicyForXai')
  return quotaPolicy({
    provider: opts.provider ?? 'xai',
    models: opts.models,
    ...(opts.defaults !== undefined ? { defaults: opts.defaults } : {}),
    ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
  })
}

/** Throws `bad_request` for a key of `value` that is not in `allowed`: a misspelt option is never dropped. */
function assertKnownKeys(
  value: unknown,
  allowed: readonly string[],
  where: string,
): void {
  if (typeof value !== 'object' || value === null) return
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new LlmError(
        `${where}: unknown option "${key}". Known: ${allowed.join(', ')}.`,
        { kind: 'bad_request', retryable: false },
      )
    }
  }
}

/** Every limits object of a policy (`defaults` and each `models` entry) may carry only `allowed` keys. */
function assertKnownLimitKeys(
  opts: { models?: unknown; defaults?: unknown },
  allowed: readonly string[],
  where: string,
): void {
  assertKnownKeys(opts.defaults, allowed, `${where}: defaults`)
  if (typeof opts.models === 'object' && opts.models !== null) {
    for (const [model, limits] of Object.entries(opts.models)) {
      assertKnownKeys(limits, allowed, `${where}: models["${model}"]`)
    }
  }
}

export async function checkProviderQuota(
  opts: CheckProviderQuotaOptions,
): Promise<QuotaDecision> {
  const nowMs = opts.nowMs ?? Date.now()
  const resolved = resolveQuotaRule(opts.policy, opts.provider, opts.model, opts.aliases)
  const evaluation = await evaluateQuotaDecision(
    resolved,
    opts.store,
    nowMs,
    opts.estimatedInputTokens,
    opts.signal,
  )
  return evaluation.decision
}

/**
 * Checks (and, on allow, consumes) the call's quota; throws `rate_limited` on a
 * deferral or a denial. Resolves to a {@link QuotaAdmission} the caller uses to
 * correct a `tpm` reservation with the call's real usage.
 *
 * A store failure follows `onStoreError`: `'fail-closed'` throws an `LlmError`
 * (`kind: 'server'`, `reason: 'quota_store_unavailable'`, not retryable, the
 * store's error as `cause`), `'fail-open'` lets the call through with no
 * reservation. Both emit `backend_error`. A caller abort that interrupts the
 * store call is rethrown as it is. Without a `store`, window checks are skipped
 * (see {@link ProviderQuotaMiddlewareOptions}).
 */
export async function enforceProviderQuota(
  opts: EnforceProviderQuotaOptions,
): Promise<QuotaAdmission> {
  const nowMs = opts.nowMs ?? Date.now()
  const maxDeferMs = validateMaxDeferMs(opts.maxDeferMs)
  const resolved = resolveQuotaRule(opts.policy, opts.provider, opts.model, opts.aliases)
  if (opts.store !== undefined) {
    validateStoreErrorMode(opts.onStoreError)
  }

  let evaluation: QuotaEvaluation
  try {
    evaluation = await evaluateQuotaDecision(
      resolved,
      opts.store,
      nowMs,
      opts.estimatedInputTokens,
      opts.signal,
      opts.onWindowChecksSkipped,
    )
  } catch (storeError) {
    // Anything the store did wrong, whatever it threw (even an `LlmError`: a
    // store's own `rate_limited` is not this library's quota decision).
    if (opts.store === undefined) throw storeError
    emitEvent(opts.onEvent, {
      type: 'backend_error',
      provider: opts.provider,
      model: opts.model,
      scope: resolved.scope,
      error: storeError,
    })
    if (opts.signal?.aborted === true) throw storeError
    if (opts.onStoreError === 'fail-open') return NO_ADMISSION
    throw storeUnavailableError(storeError)
  }
  const decision = evaluation.decision

  switch (decision.kind) {
    case 'allow':
      emitEvent(opts.onEvent, {
        type: 'allow',
        provider: opts.provider,
        model: opts.model,
        scope: resolved.scope,
        decision,
      })
      return admissionFor(opts, resolved, nowMs, evaluation.reservedTokens)

    case 'defer':
      emitEvent(opts.onEvent, {
        type: 'defer',
        provider: opts.provider,
        model: opts.model,
        scope: resolved.scope,
        decision,
      })
      throw new LlmError(
        messageForDefer(decision.reason, decision.scope, decision.retryAfterMs),
        maxDeferMs !== undefined && decision.retryAfterMs > maxDeferMs
          ? {
              kind: 'rate_limited',
              retryable: false,
              reason: 'quota_window',
              retryAfterMs: decision.retryAfterMs,
            }
          : {
              kind: 'rate_limited',
              retryable: true,
              retryAfterMs: decision.retryAfterMs,
            },
      )

    case 'deny':
      emitEvent(opts.onEvent, {
        type: 'deny',
        provider: opts.provider,
        model: opts.model,
        scope: resolved.scope,
        decision,
      })
      {
        const error = new LlmError(messageForDeny(decision.reason, decision.scope), {
          kind: 'rate_limited',
          retryable: false,
        })
        // LlmError declares `retryAfterMs` as a class field, so with
        // useDefineForClassFields (implied by tsconfig's ES2022 target) every
        // instance gets an own `retryAfterMs` property initialized to
        // `undefined` — even though it's never passed in `options` here. This
        // delete keeps `'retryAfterMs' in error` false for non-retryable
        // deny errors, matching the `defer` case where it's genuinely absent.
        delete (error as { retryAfterMs?: number }).retryAfterMs
        throw error
      }

    default: {
      const exhaustive: never = decision
      return exhaustive
    }
  }
}

/**
 * The one error a `'fail-closed'` store outage becomes: a timeout, an HTTP
 * failure, a transport failure and a malformed reply all end the same way, so
 * a host can tell "the quota store is down" from a provider failure.
 */
function storeUnavailableError(cause: unknown): LlmError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new LlmError(
    `Quota store unavailable (onStoreError: 'fail-closed'): ${detail}. The call was refused before it reached the provider.`,
    { kind: 'server', retryable: false, reason: 'quota_store_unavailable', cause },
  )
}

function admissionFor(
  opts: EnforceProviderQuotaOptions,
  resolved: ResolvedQuotaRule,
  nowMs: number,
  reservedTokens: number | undefined,
): QuotaAdmission {
  const store = opts.store
  if (store === undefined || reservedTokens === undefined) return NO_ADMISSION
  let reconciled = false
  return {
    async reconcile(usage?: Usage): Promise<void> {
      if (usage === undefined || reconciled) return
      reconciled = true
      const actual = Math.max(Math.round(usage.inputTokens), 0)
      const delta = actual - reservedTokens
      if (delta === 0) return
      try {
        await store.adjustTokens({ scope: resolved.scope, nowMs, tokens: delta })
      } catch (error) {
        emitEvent(opts.onEvent, {
          type: 'backend_error',
          provider: opts.provider,
          model: opts.model,
          scope: resolved.scope,
          error,
        })
        // A logging hook must not turn a reconciliation failure into a throw, and
        // an `async` one must not become an unhandled rejection.
        guardHostCall(
          () => opts.onReconcileError?.(resolved.scope, error),
          () => {},
        )
      }
    },
  }
}

/**
 * Quota as a middleware. It must sit inside `retryMiddleware` (the engine
 * refuses the other order): every retry attempt is checked and consumes quota.
 *
 * Tokens: when the rule has `tpm`, each attempt reserves
 * `estimateInputTokens(req)` and, once the attempt ends with usage (a result,
 * or a billed failure that carries it), the real input tokens correct the
 * reservation. An attempt that ends with no usage keeps its reservation. The
 * correction is started when the attempt ends and never awaited: it cannot
 * delay the result, cannot mask the attempt's error, and is at-most-once (see
 * {@link QuotaStore.adjustTokens}). A failure is a `backend_error` event and an
 * `llm.quota.reconcile_failed` warning.
 *
 * **Without a `store`** the rules still evaluate: any limit of `0` denies the
 * call with `provider_disabled` and a `deny` event. Windows (`rpm`, `rpd`,
 * `tpm`) cannot be checked and are skipped, with one `warn` log
 * (`llm.quota.windows_skipped`) per middleware instance and scope.
 *
 * `onStoreError` is validated here, at construction.
 */
export function providerQuotaMiddleware(
  opts: ProviderQuotaMiddlewareOptions,
): Middleware {
  const maxDeferMs = validateMaxDeferMs(opts.maxDeferMs) ?? DEFAULT_MAX_DEFER_MS
  if (opts.store !== undefined) validateStoreErrorMode(opts.onStoreError)
  const storeOptions: QuotaStoreOptions =
    opts.store === undefined ? {} : { store: opts.store, onStoreError: opts.onStoreError }
  const warnedScopes = new Set<string>()
  return {
    id: opts.id ?? 'provider-quota',
    // Not configurable: `createClient` reads `role` (never `id`) to reject a
    // client that places quota outside retry.
    role: 'quota',
    async intercept(req, ctx, next) {
      const model = req.modelDescriptor?.model ?? req.model
      const enforceOptions: EnforceProviderQuotaOptions = {
        provider: req.provider,
        // The canonical id, so a declared alias is limited like its model. The
        // engine pins `modelDescriptor` at every middleware boundary.
        model,
        policy: opts.policy,
        ...storeOptions,
        nowMs: opts.now?.() ?? ctx.clock.now(),
        estimatedInputTokens: estimateInputTokens(req),
        maxDeferMs,
        onWindowChecksSkipped: (scope) => {
          if (warnedScopes.has(scope)) return
          warnedScopes.add(scope)
          ctx.logger.warn(
            {
              callId: ctx.callId,
              provider: req.provider,
              model,
              scope,
              detail:
                'providerQuotaMiddleware has no store, so rpm, rpd and tpm windows are not checked (a limit of 0 still denies)',
            },
            'llm.quota.windows_skipped',
          )
        },
        onReconcileError: (scope, error) => {
          ctx.logger.warn(
            {
              callId: ctx.callId,
              provider: req.provider,
              model,
              scope,
              error: redactSecrets(
                error instanceof Error ? error.message : String(error),
              ),
            },
            'llm.quota.reconcile_failed',
          )
        },
      }
      const aliases = req.modelDescriptor?.aliases
      if (aliases !== undefined) {
        enforceOptions.aliases = aliases
      }

      if (opts.onEvent !== undefined) {
        enforceOptions.onEvent = opts.onEvent
      }
      if (ctx.signal !== undefined) {
        enforceOptions.signal = ctx.signal
      }

      const admission = await enforceProviderQuota(enforceOptions)

      let result
      try {
        result = await next(req, ctx)
      } catch (error) {
        // A billed failure carries its usage; any other failure keeps the
        // reservation (the provider may have counted the request).
        void admission.reconcile(error instanceof LlmError ? error.usage : undefined)
        throw error
      }
      void admission.reconcile(result.usage)
      return result
    },
  }
}

/**
 * Quota as the client's `rateLimiter`. The engine passes
 * `hint.estimatedInputTokens` (see `estimateInputTokens`) to `acquire` and the
 * attempt's usage to the returned `Release`, which corrects the `tpm`
 * reservation without waiting for the store, at most once however often the
 * `Release` is called. `onStoreError` is validated here, at construction.
 */
export function providerQuotaRateLimiter(
  opts: ProviderQuotaRateLimiterOptions,
): RateLimiter {
  const maxDeferMs = validateMaxDeferMs(opts.maxDeferMs) ?? DEFAULT_MAX_DEFER_MS
  validateStoreErrorMode(opts.onStoreError)
  return {
    async acquire(
      key: string,
      signal?: AbortSignal,
      hint?: { estimatedInputTokens?: number },
    ): Promise<Release> {
      const { provider, model } = parseRateLimiterKey(key)

      const enforceOptions: EnforceProviderQuotaOptions = {
        provider,
        model,
        policy: opts.policy,
        store: opts.store,
        onStoreError: opts.onStoreError,
        nowMs: opts.now?.() ?? Date.now(),
        maxDeferMs,
      }

      if (hint?.estimatedInputTokens !== undefined) {
        enforceOptions.estimatedInputTokens = hint.estimatedInputTokens
      }
      if (opts.onEvent !== undefined) {
        enforceOptions.onEvent = opts.onEvent
      }
      if (signal !== undefined) {
        enforceOptions.signal = signal
      }

      const admission = await enforceProviderQuota(enforceOptions)

      return (usage?: Usage): void => {
        void admission.reconcile(usage)
      }
    },
  }
}

/**
 * Atomic check-and-consume for N windows (N = #KEYS).
 *
 * KEYS[i]        window counter key
 * ARGV[3i-2]     window limit
 * ARGV[3i-1]     counter TTL in ms (time until the window rolls over)
 * ARGV[3i]       what this call adds (1 for a request window, the token
 *                estimate for a token window)
 *
 * Reads every counter first. A call is refused by a window when the counter is
 * at its limit, or when adding the cost would cross it and the counter is not
 * empty (one call larger than the whole window passes into an empty counter).
 * Only when no window refuses does it add to all of them, so a denied call
 * consumes nothing. Returns `{ ok, count_1 … count_N }`: counts after the
 * increment when `ok` is 1, current counts (untouched) when `ok` is 0.
 */
const CHECK_AND_CONSUME_LUA = `
local n = #KEYS
local counts = {}
local ok = 1
for i = 1, n do
  local limit = tonumber(ARGV[3 * i - 2])
  local cost = tonumber(ARGV[3 * i])
  local v = redis.call('GET', KEYS[i])
  counts[i] = v and tonumber(v) or 0
  if counts[i] >= limit or (counts[i] > 0 and counts[i] + cost > limit) then
    ok = 0
  end
end
if ok == 1 then
  for i = 1, n do
    counts[i] = redis.call('INCRBY', KEYS[i], ARGV[3 * i])
    redis.call('PEXPIRE', KEYS[i], ARGV[3 * i - 1])
  end
end
local out = { ok }
for i = 1, n do
  out[i + 1] = counts[i]
end
return out
`

/**
 * Corrects one token counter. KEYS[1] is the counter, ARGV[1] the signed
 * integer to add. A counter that is gone (its window ended) is left alone, and
 * the counter never ends below 0. The TTL set when the window was consumed is
 * kept.
 */
const ADJUST_TOKENS_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then
  return 0
end
local n = redis.call('INCRBY', KEYS[1], ARGV[1])
if n < 0 then
  redis.call('INCRBY', KEYS[1], -n)
  n = 0
end
return n
`

export function upstashQuotaStore(opts: UpstashQuotaStoreOptions): QuotaStore {
  const prefix = opts.prefix ?? 'gullabs:quota'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_UPSTASH_TIMEOUT_MS
  assertStoreTimeout(timeoutMs)
  const rawInvoke = opts.invoke ?? buildUpstashInvoker(opts)
  const scheduler = opts.scheduler ?? PLATFORM_SCHEDULER
  const invoke: UpstashPipelineInvoker = (commands, signal) =>
    boundedInvoke(rawInvoke, commands, signal, timeoutMs, scheduler)

  return {
    async checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult> {
      const windows = planWindows(prefix, input)

      if (windows.length === 0) {
        return {}
      }

      const command: UpstashPipelineCommand = [
        'EVAL',
        CHECK_AND_CONSUME_LUA,
        windows.length,
        ...windows.map((w) => w.key),
        ...windows.flatMap((w) => [w.limit, w.ttlMs, w.cost]),
      ]
      const rawResults = await invoke([command], input.signal)
      const reply = arrayPipelineResult(rawResults[0], windows.length + 1)
      return windowResults(windows, reply[0] === 1, reply.slice(1))
    },

    async adjustTokens(input: QuotaStoreAdjustInput): Promise<void> {
      const command: UpstashPipelineCommand = [
        'EVAL',
        ADJUST_TOKENS_LUA,
        1,
        tokenWindowKey(prefix, input.scope, input.nowMs),
        input.tokens,
      ]
      const rawResults = await invoke([command], input.signal)
      arrayPipelineResult([unwrapPipelineResult(rawResults[0])], 1)
    },
  }
}

const PLATFORM_SCHEDULER: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

function assertStoreTimeout(value: unknown): void {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new LlmError(
      `upstashQuotaStore: timeoutMs must be a finite number greater than 0 and at most ${MAX_TIMER_MS}, got ${String(value)}.`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

/**
 * One store call, bounded: the timer and the caller's signal both abort the
 * signal handed to `invoke`, and the race settles at the first of them even
 * when `invoke` ignores its signal.
 */
function boundedInvoke(
  invoke: UpstashPipelineInvoker,
  commands: readonly UpstashPipelineCommand[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  scheduler: Scheduler,
): Promise<readonly unknown[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal))
      return
    }
    let settled = false
    const controller = new AbortController()
    const onCallerAbort = (): void => {
      if (signal === undefined) return
      settle(() => {
        reject(abortError(signal))
      })
      controller.abort(signal.reason)
    }
    const timer = scheduler.setTimeout(() => {
      const error = new Error(`Upstash quota call timed out after ${timeoutMs}ms`)
      settle(() => {
        reject(error)
      })
      controller.abort(error)
    }, timeoutMs)
    function settle(finish: () => void): void {
      if (settled) return
      settled = true
      scheduler.clearTimeout(timer)
      signal?.removeEventListener('abort', onCallerAbort)
      finish()
    }
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    // An `invoke` that throws before it returns a promise must still release the
    // timer and the listener.
    let pending: Promise<readonly unknown[]>
    try {
      pending = invoke(commands, controller.signal)
    } catch (error) {
      settle(() => {
        reject(asError(error))
      })
      return
    }
    pending.then(
      (value) => {
        settle(() => {
          resolve(value)
        })
      },
      (error: unknown) => {
        settle(() => {
          reject(asError(error))
        })
      },
    )
  })
}

/** The caller's abort reason when it is an `Error`, else an `AbortError`. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError')
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value), { cause: value })
}

function resolveQuotaRule(
  policy: ProviderQuotaPolicy,
  provider: string,
  model: string,
  aliases?: readonly string[],
): ResolvedQuotaRule {
  const rule = policy.getRule({
    provider,
    model,
    ...(aliases !== undefined ? { aliases } : {}),
  })
  const scope = rule?.scope ?? defaultScope(provider, model)
  const resolved: ResolvedQuotaRule = {
    configured: rule !== undefined,
    scope,
  }

  for (const name of ['rpm', 'rpd', 'tpm'] as const) {
    const limit = validateConfiguredLimit(name, rule?.[name])
    if (limit !== undefined) {
      resolved[name] = limit
    }
  }
  if (rule?.dayBoundary !== undefined) {
    resolved.dayBoundary = assertDayBoundary(rule.dayBoundary, 'dayBoundary')
  }

  return resolved
}

interface QuotaEvaluation {
  decision: QuotaDecision
  /** The tokens reserved against `tpm`, when the call consumed from a `tpm` window. */
  reservedTokens?: number
}

async function evaluateQuotaDecision(
  resolved: ResolvedQuotaRule,
  store: QuotaStore | undefined,
  nowMs: number,
  estimatedInputTokens: number | undefined,
  signal?: AbortSignal,
  onWindowChecksSkipped?: (scope: string) => void,
): Promise<QuotaEvaluation> {
  if (!resolved.configured) {
    return { decision: { kind: 'allow' } }
  }

  // A limit of 0, in any window, disables the provider for this scope.
  if (resolved.rpm === 0 || resolved.rpd === 0 || resolved.tpm === 0) {
    return {
      decision: {
        kind: 'deny',
        scope: resolved.scope,
        reason: 'provider_disabled',
      },
    }
  }

  const { rpm, rpd, tpm } = resolved
  if (rpm === undefined && rpd === undefined && tpm === undefined) {
    return { decision: { kind: 'allow' } }
  }

  if (store === undefined) {
    if (onWindowChecksSkipped !== undefined) {
      // Typed `=> void`, but the host's may be `async`: the guard reads the result.
      const skipped: (scope: string) => unknown = onWindowChecksSkipped
      guardHostCall(
        () => skipped(resolved.scope),
        () => {},
      )
    }
    return { decision: { kind: 'allow' } }
  }

  const tokens =
    tpm === undefined ? undefined : Math.max(Math.ceil(estimatedInputTokens ?? 0), 0)
  const storeInput: QuotaStoreCheckInput = {
    scope: resolved.scope,
    nowMs,
  }
  if (rpm !== undefined) {
    storeInput.rpm = rpm
  }
  if (rpd !== undefined) {
    storeInput.rpd = rpd
    if (resolved.dayBoundary !== undefined) {
      storeInput.dayBoundary = resolved.dayBoundary
    }
  }
  if (tpm !== undefined && tokens !== undefined) {
    storeInput.tpm = tpm
    storeInput.tokens = tokens
  }
  if (signal !== undefined) {
    storeInput.signal = signal
  }

  const storeDecision = await store.checkAndConsume(storeInput)

  if (
    rpd !== undefined &&
    storeDecision.rpd !== undefined &&
    !storeDecision.rpd.allowed
  ) {
    return {
      decision: {
        kind: 'defer',
        scope: resolved.scope,
        reason: 'rpd_exhausted',
        retryAfterMs: normalizeRetryAfter(
          storeDecision.rpd.retryAfterMs,
          msUntilDayEnds(nowMs, resolved.dayBoundary),
        ),
      },
    }
  }

  if (
    rpm !== undefined &&
    storeDecision.rpm !== undefined &&
    !storeDecision.rpm.allowed
  ) {
    return {
      decision: {
        kind: 'defer',
        scope: resolved.scope,
        reason: 'rpm_exhausted',
        retryAfterMs: normalizeRetryAfter(
          storeDecision.rpm.retryAfterMs,
          msUntilNextMinute(nowMs),
        ),
      },
    }
  }

  if (
    tpm !== undefined &&
    storeDecision.tpm !== undefined &&
    !storeDecision.tpm.allowed
  ) {
    return {
      decision: {
        kind: 'defer',
        scope: resolved.scope,
        reason: 'tpm_exhausted',
        retryAfterMs: normalizeRetryAfter(
          storeDecision.tpm.retryAfterMs,
          msUntilNextMinute(nowMs),
        ),
      },
    }
  }

  return {
    decision: { kind: 'allow' },
    ...(tokens !== undefined && storeDecision.tpm !== undefined
      ? { reservedTokens: tokens }
      : {}),
  }
}

function messageForDefer(
  reason: QuotaDeferReason,
  scope: string,
  retryAfterMs: number,
): string {
  switch (reason) {
    case 'rpm_exhausted':
      return `Provider quota exhausted for "${scope}": requests per minute exhausted. Retry after ${retryAfterMs}ms.`
    case 'rpd_exhausted':
      return `Provider quota exhausted for "${scope}": requests per day exhausted. Retry after ${retryAfterMs}ms.`
    case 'tpm_exhausted':
      return `Provider quota exhausted for "${scope}": input tokens per minute exhausted. Retry after ${retryAfterMs}ms.`
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

function messageForDeny(reason: QuotaDenyReason, scope: string): string {
  const messages = {
    provider_disabled: (s: string) => `Provider quota disabled for "${s}".`,
  } satisfies Record<QuotaDenyReason, (scope: string) => string>

  return messages[reason](scope)
}

function emitEvent(onEvent: QuotaEventHandler | undefined, event: QuotaEvent): void {
  if (onEvent === undefined) return

  // User-supplied event handlers must not alter quota enforcement behavior: a
  // throw and the rejection of a returned promise are both absorbed.
  const handler: (event: QuotaEvent) => unknown = onEvent
  guardHostCall(
    () => handler(event),
    () => {},
  )
}

function parseRateLimiterKey(key: string): { provider: string; model: string } {
  const firstColon = key.indexOf(':')
  if (firstColon <= 0 || firstColon === key.length - 1) {
    throw new Error(`Invalid provider quota key "${key}"`)
  }

  return {
    provider: key.slice(0, firstColon),
    model: key.slice(firstColon + 1),
  }
}

function buildUpstashInvoker(opts: UpstashQuotaStoreOptions): UpstashPipelineInvoker {
  if (opts.url === undefined || opts.token === undefined) {
    throw new Error(
      'upstashQuotaStore requires either opts.invoke or both opts.url and opts.token',
    )
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch

  const endpoint = `${opts.url.replace(/\/+$/, '')}/pipeline`

  return async function invoke(
    commands: readonly UpstashPipelineCommand[],
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    }
    if (signal !== undefined) {
      requestInit.signal = signal
    }

    const response = await fetchImpl(endpoint, requestInit)

    if (!response.ok) {
      // Release the connection: an unread body keeps it open.
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Upstash quota pipeline failed with HTTP ${response.status}`)
    }

    return (await response.json()) as readonly unknown[]
  }
}

function arrayPipelineResult(value: unknown, length: number): readonly number[] {
  const unwrapped = unwrapPipelineResult(value)
  if (
    Array.isArray(unwrapped) &&
    unwrapped.length === length &&
    unwrapped.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return unwrapped as number[]
  }

  throw new Error(`Unexpected Upstash pipeline result: ${JSON.stringify(value)}`)
}

function unwrapPipelineResult(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'result' in value) {
    return value.result
  }
  return value
}

function defaultScope(provider: string, model: string): string {
  return `${provider}:${model}`
}

function validateConfiguredLimit(
  name: 'rpm' | 'rpd' | 'tpm',
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new LlmError(
      `Invalid provider quota rule: "${name}" must be a non-negative integer, got ${String(value)}`,
      { kind: 'bad_request', retryable: false },
    )
  }
  return value
}

function normalizeRetryAfter(
  retryAfterMs: number | undefined,
  fallbackMs: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs
  }
  return fallbackMs
}
