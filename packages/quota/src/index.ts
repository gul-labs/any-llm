import { LlmError, type Middleware, type RateLimiter, type Release } from '@gullabs/core'

export type QuotaDeferReason = 'rpm_exhausted' | 'rpd_exhausted'
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
  rpm?: number
  rpd?: number
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
  signal?: AbortSignal
}

export interface QuotaStoreCheckResult {
  rpm?: QuotaStoreWindowResult
  rpd?: QuotaStoreWindowResult
}

export interface QuotaStore {
  /**
   * Check every configured window and consume one unit from each **only if all
   * of them are under their limits**. A denied call leaves every counter
   * unchanged. The check and the consumption must be atomic: concurrent callers
   * at the limit admit exactly the remaining capacity.
   */
  checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult>
}

export interface CheckProviderQuotaOptions {
  provider: string
  model: string
  /** Declared aliases of `model`, passed through to {@link QuotaPolicyInput.aliases}. */
  aliases?: readonly string[]
  policy: ProviderQuotaPolicy
  store: QuotaStore
  nowMs?: number
  signal?: AbortSignal
}

export interface EnforceProviderQuotaOptions extends CheckProviderQuotaOptions {
  onEvent?: QuotaEventHandler
  /**
   * Longest `retryAfterMs` a deferral may carry and still be thrown as a
   * retryable `rate_limited` error. A longer deferral is thrown as
   * `rate_limited`, `retryable: false`, `reason: 'quota_window'`. Unset means
   * no cap. When set it must be a finite number >= 0, else `bad_request`.
   */
  maxDeferMs?: number
}

export interface ProviderQuotaMiddlewareOptions {
  id?: string
  policy: ProviderQuotaPolicy
  store: QuotaStore
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

export interface GeminiQuotaLimits {
  rpm?: number
  rpd?: number
}

export interface GeminiQuotaPolicyOptions {
  provider?: string
  models: Record<string, GeminiQuotaLimits>
  defaultLimits?: GeminiQuotaLimits
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
}

interface ResolvedQuotaRule {
  configured: boolean
  scope: string
  rpm?: number
  rpd?: number
}

const NOOP_RELEASE: Release = () => {}

const DEFAULT_MAX_DEFER_MS = 60_000

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

export function quotaPolicyForGemini(
  opts: GeminiQuotaPolicyOptions,
): ProviderQuotaPolicy {
  const provider = opts.provider ?? 'google'

  return {
    getRule(input: QuotaPolicyInput): ProviderQuotaRule | undefined {
      if (input.provider !== provider) return undefined

      if (
        opts.models[input.model] === undefined &&
        (input.aliases ?? []).some((alias) => opts.models[alias] !== undefined)
      ) {
        throw new LlmError(
          `Quota limits for "${input.model}" are keyed by one of its aliases; limits are looked up by the canonical model id "${input.model}", so the alias key would never match. Key the limits by "${input.model}".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      const limits = opts.models[input.model] ?? opts.defaultLimits
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

      return rule
    },
  }
}

export async function checkProviderQuota(
  opts: CheckProviderQuotaOptions,
): Promise<QuotaDecision> {
  const nowMs = opts.nowMs ?? Date.now()
  const resolved = resolveQuotaRule(opts.policy, opts.provider, opts.model, opts.aliases)
  return evaluateQuotaDecision(resolved, opts.store, nowMs, opts.signal)
}

export async function enforceProviderQuota(
  opts: EnforceProviderQuotaOptions,
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now()
  const maxDeferMs = validateMaxDeferMs(opts.maxDeferMs)
  const resolved = resolveQuotaRule(opts.policy, opts.provider, opts.model, opts.aliases)

  try {
    const decision = await evaluateQuotaDecision(resolved, opts.store, nowMs, opts.signal)

    switch (decision.kind) {
      case 'allow':
        emitEvent(opts.onEvent, {
          type: 'allow',
          provider: opts.provider,
          model: opts.model,
          scope: resolved.scope,
          decision,
        })
        return

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
  } catch (error) {
    if (error instanceof LlmError && error.kind === 'rate_limited') {
      throw error
    }

    emitEvent(opts.onEvent, {
      type: 'backend_error',
      provider: opts.provider,
      model: opts.model,
      scope: resolved.scope,
      error,
    })
    throw error
  }
}

export function providerQuotaMiddleware(
  opts: ProviderQuotaMiddlewareOptions,
): Middleware {
  const maxDeferMs = validateMaxDeferMs(opts.maxDeferMs) ?? DEFAULT_MAX_DEFER_MS
  return {
    id: opts.id ?? 'provider-quota',
    // Not configurable: `createClient` reads `role` (never `id`) to reject a
    // client that places quota outside retry.
    role: 'quota',
    async intercept(req, ctx, next) {
      const enforceOptions: EnforceProviderQuotaOptions = {
        provider: req.provider,
        // The canonical id, so a declared alias is limited like its model. The
        // engine pins `modelDescriptor` at every middleware boundary.
        model: req.modelDescriptor?.model ?? req.model,
        policy: opts.policy,
        store: opts.store,
        nowMs: opts.now?.() ?? ctx.clock.now(),
        maxDeferMs,
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

      await enforceProviderQuota(enforceOptions)

      return next(req, ctx)
    },
  }
}

export function providerQuotaRateLimiter(
  opts: ProviderQuotaRateLimiterOptions,
): RateLimiter {
  const maxDeferMs = validateMaxDeferMs(opts.maxDeferMs) ?? DEFAULT_MAX_DEFER_MS
  return {
    async acquire(key: string, signal?: AbortSignal): Promise<Release> {
      const { provider, model } = parseRateLimiterKey(key)

      const enforceOptions: EnforceProviderQuotaOptions = {
        provider,
        model,
        policy: opts.policy,
        store: opts.store,
        nowMs: opts.now?.() ?? Date.now(),
        maxDeferMs,
      }

      if (opts.onEvent !== undefined) {
        enforceOptions.onEvent = opts.onEvent
      }
      if (signal !== undefined) {
        enforceOptions.signal = signal
      }

      await enforceProviderQuota(enforceOptions)

      return NOOP_RELEASE
    },
  }
}

/**
 * Atomic check-and-consume for N windows (N = #KEYS).
 *
 * KEYS[i]      window counter key
 * ARGV[2i-1]   window limit
 * ARGV[2i]     counter TTL in ms (time until the window rolls over)
 *
 * Reads every counter first. Only when ALL are under their limits does it
 * increment them all, so a denied call consumes nothing. Returns
 * `{ ok, count_1 … count_N }`: counts after the increment when `ok` is 1,
 * current counts (untouched) when `ok` is 0.
 */
const CHECK_AND_CONSUME_LUA = `
local n = #KEYS
local counts = {}
local ok = 1
for i = 1, n do
  local v = redis.call('GET', KEYS[i])
  counts[i] = v and tonumber(v) or 0
  if counts[i] >= tonumber(ARGV[2 * i - 1]) then
    ok = 0
  end
end
if ok == 1 then
  for i = 1, n do
    counts[i] = redis.call('INCR', KEYS[i])
    redis.call('PEXPIRE', KEYS[i], ARGV[2 * i])
  end
end
local out = { ok }
for i = 1, n do
  out[i + 1] = counts[i]
end
return out
`

export function upstashQuotaStore(opts: UpstashQuotaStoreOptions): QuotaStore {
  const prefix = opts.prefix ?? 'gullabs:quota'
  const invoke = opts.invoke ?? buildUpstashInvoker(opts)

  return {
    async checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult> {
      const windows: Array<{
        kind: 'rpm' | 'rpd'
        key: string
        limit: number
        retryAfterMs: number
      }> = []

      if (input.rpm !== undefined && input.rpm > 0) {
        windows.push({
          kind: 'rpm',
          key: bucketKey(prefix, input.scope, 'rpm', input.nowMs),
          limit: input.rpm,
          retryAfterMs: timeUntilNextMinute(input.nowMs),
        })
      }

      if (input.rpd !== undefined && input.rpd > 0) {
        windows.push({
          kind: 'rpd',
          key: bucketKey(prefix, input.scope, 'rpd', input.nowMs),
          limit: input.rpd,
          retryAfterMs: timeUntilNextUtcDay(input.nowMs),
        })
      }

      if (windows.length === 0) {
        return {}
      }

      const command: UpstashPipelineCommand = [
        'EVAL',
        CHECK_AND_CONSUME_LUA,
        windows.length,
        ...windows.map((w) => w.key),
        ...windows.flatMap((w) => [w.limit, w.retryAfterMs]),
      ]
      const rawResults = await invoke([command], input.signal)
      const reply = arrayPipelineResult(rawResults[0], windows.length + 1)
      const consumed = reply[0] === 1
      const decision: QuotaStoreCheckResult = {}

      for (const [i, window] of windows.entries()) {
        const count = reply[i + 1] ?? 0
        const result: QuotaStoreWindowResult = {
          // On a denial only the windows that are themselves at their limit are
          // "not allowed"; the others were under their limit but not consumed.
          allowed: consumed || count < window.limit,
          remaining: Math.max(window.limit - count, 0),
          used: count,
        }

        if (!result.allowed) {
          result.retryAfterMs = window.retryAfterMs
        }

        if (window.kind === 'rpm') {
          decision.rpm = result
        } else {
          decision.rpd = result
        }
      }

      return decision
    },
  }
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

  if (rule?.rpm !== undefined) {
    const rpm = validateConfiguredLimit('rpm', rule.rpm)
    if (rpm !== undefined) {
      resolved.rpm = rpm
    }
  }
  if (rule?.rpd !== undefined) {
    const rpd = validateConfiguredLimit('rpd', rule.rpd)
    if (rpd !== undefined) {
      resolved.rpd = rpd
    }
  }

  return resolved
}

async function evaluateQuotaDecision(
  resolved: ResolvedQuotaRule,
  store: QuotaStore,
  nowMs: number,
  signal?: AbortSignal,
): Promise<QuotaDecision> {
  if (!resolved.configured) {
    return { kind: 'allow' }
  }

  if (resolved.rpd === 0) {
    return {
      kind: 'deny',
      scope: resolved.scope,
      reason: 'provider_disabled',
    }
  }

  const rpm = normalizeConfiguredLimit(resolved.rpm)
  const rpd = normalizeConfiguredLimit(resolved.rpd)
  if (rpm === undefined && rpd === undefined) {
    return { kind: 'allow' }
  }

  const storeInput: QuotaStoreCheckInput = {
    scope: resolved.scope,
    nowMs,
  }
  if (rpm !== undefined) {
    storeInput.rpm = rpm
  }
  if (rpd !== undefined) {
    storeInput.rpd = rpd
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
      kind: 'defer',
      scope: resolved.scope,
      reason: 'rpd_exhausted',
      retryAfterMs: normalizeRetryAfter(
        storeDecision.rpd.retryAfterMs,
        timeUntilNextUtcDay(nowMs),
      ),
    }
  }

  if (
    rpm !== undefined &&
    storeDecision.rpm !== undefined &&
    !storeDecision.rpm.allowed
  ) {
    return {
      kind: 'defer',
      scope: resolved.scope,
      reason: 'rpm_exhausted',
      retryAfterMs: normalizeRetryAfter(
        storeDecision.rpm.retryAfterMs,
        timeUntilNextMinute(nowMs),
      ),
    }
  }

  return { kind: 'allow' }
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

  try {
    onEvent(event)
  } catch {
    // User-supplied event handlers must not alter quota enforcement behavior.
  }
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

function normalizeConfiguredLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (limit <= 0) return undefined
  return limit
}

function validateConfiguredLimit(
  name: 'rpm' | 'rpd',
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new LlmError(
      `Invalid provider quota rule: "${name}" must be a non-negative integer, got ${value}`,
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

function bucketKey(
  prefix: string,
  scope: string,
  window: 'rpm' | 'rpd',
  nowMs: number,
): string {
  if (window === 'rpm') {
    return `${prefix}:${window}:${scope}:${minuteBucket(nowMs)}`
  }
  return `${prefix}:${window}:${scope}:${utcDayBucket(nowMs)}`
}

function minuteBucket(nowMs: number): string {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${y}${m}${day}${hh}${mm}`
}

function utcDayBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function timeUntilNextMinute(nowMs: number): number {
  const nextMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000
  // Integer: `PEXPIRE` rejects a fractional TTL after `INCR` already ran.
  return Math.max(Math.ceil(nextMinute - nowMs), 1)
}

function timeUntilNextUtcDay(nowMs: number): number {
  const d = new Date(nowMs)
  const nextDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(Math.ceil(nextDay - nowMs), 1)
}
