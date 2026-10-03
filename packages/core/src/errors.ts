/**
 * Typed errors for @gullabs/core.
 *
 * Every throw from the engine is an {@link LlmError}.  Adapters classify raw
 * SDK errors into an LlmError; the engine surfaces them to callers.  Side-effect
 * failures (sink, telemetry) are logged but never rethrown.
 *
 * @module
 */

import type { StandardSchemaV1 } from './standard-schema.js'
import type { Usage, Warning } from './types.js'

// ---------------------------------------------------------------------------
// Error kind
// ---------------------------------------------------------------------------

/**
 * Discriminant for every failure mode the library can surface.
 *
 * - `'invalid_auth'`    — 401, or 403 when no provider overlay reclassified;
 *   credentials wrong, missing, or the key lacks permission.
 * - `'rate_limited'`    — 429; back-off and retry.
 * - `'server'`          — 5xx, a transport failure with no HTTP response (a
 *   refused or reset connection), or a candidate-less billed response without
 *   a safety block; retryable provider failure.
 * - `'timeout'`         — request exceeded `timeoutMs` or network timeout.
 * - `'aborted'`         — caller cancelled via `AbortSignal`.
 * - `'bad_request'`     — 400/404/413/422; the request itself is malformed,
 *   names something that does not exist, or is too large.
 * - `'content_filter'`  — provider refused the call for safety / acceptable-use
 *   / moderation. Google output blocks are a 200-path throw; xAI input
 *   blocks are the 403 overlay. Unrecorded 200 incomplete reasons are not
 *   classified here.
 * - `'unknown'`         — uncategorised; inspect `cause` for details.
 */
export type LlmErrorKind =
  | 'invalid_auth'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'bad_request'
  | 'content_filter'
  | 'unknown'

/**
 * Closed vocabulary of machine-readable error reasons. `kind` and `retryable`
 * stay authoritative; `reason` only says why within a kind.
 *
 * The union is closed on purpose so adapters cannot invent reasons: adding a
 * member is a core release. Hosts should keep a `default` branch when they
 * switch on it.
 *
 * - `'transport_timeout'`      — a transport-level timeout (a header timer, a
 *   body timer or the client's own deadline; it can fire before or after
 *   response headers).
 * - `'quota_window'`           — a local quota window is exhausted for longer
 *   than the caller is willing to wait.
 * - `'daily_quota'`            — a provider daily quota is exhausted.
 * - `'credits_exhausted'`      — the provider account is out of credits.
 * - `'spend_ceiling'`          — a spend ceiling was reached.
 * - `'grounding_missing'`      — grounding was required but did not run.
 * - `'search_budget_exceeded'` — a search budget was exceeded.
 * - `'cache_not_found'`        — a referenced provider cache entry is gone.
 */
export type LlmErrorReason =
  | 'transport_timeout'
  | 'quota_window'
  | 'daily_quota'
  | 'credits_exhausted'
  | 'spend_ceiling'
  | 'grounding_missing'
  | 'search_budget_exceeded'
  | 'cache_not_found'

// ---------------------------------------------------------------------------
// LlmError
// ---------------------------------------------------------------------------

/**
 * A single structured validation failure, normalized from a StandardSchema
 * issue (or synthesized directly by a non-schema validator such as strict
 * template interpolation).
 *
 * Plain JSON data — safe for ledgers and postmortems. `PropertyKey` symbol
 * path segments are stringified before landing here.
 */
export interface LlmErrorIssue {
  /** Dotted path to the offending field, e.g. `'context.photographer'`. Root-level issues use `''`. */
  path: string
  /** Human-readable description of the violation. */
  message: string
}

/**
 * Options accepted by the {@link LlmError} constructor.
 */
export interface LlmErrorOptions {
  /** Error category — drives retry logic and record `status`. */
  kind: LlmErrorKind
  /** Whether the caller may safely retry this error. */
  retryable: boolean
  /** Why the error happened, within its `kind`, from the closed {@link LlmErrorReason} set. */
  reason?: LlmErrorReason
  /** HTTP status code, when the error originated from an HTTP response. */
  httpStatus?: number
  /**
   * How long (in ms) the caller should wait before retrying.
   * Derived from the provider's `Retry-After` header when available.
   */
  retryAfterMs?: number
  /** Adapter / provider identifier (e.g. `"google"`). */
  provider?: string
  /** The underlying error that caused this one. */
  cause?: unknown
  /** Library call ID at the time of the error. */
  callId?: string
  /** Library attempt ID at the time of the error. */
  attemptId?: string
  /** Service tier actually attempted by the provider when known. */
  servedServiceTier?: string
  /** Provider-reported usage for a billed response that failed after HTTP success. */
  usage?: Usage
  /**
   * Notes the adapter attaches to a failed attempt that carries `usage` (for
   * example "the cost omits grounding fees"). The engine writes them to that
   * attempt's record, as the success path does for `AdapterResult.warnings`.
   */
  warnings?: readonly Warning[]
  /**
   * Structured validation failures, one entry per violation. Populated by
   * every caller-fault validation path — model-config validation, strict
   * template interpolation, callsite `inputSchema`, request `inputContract`.
   */
  issues?: readonly LlmErrorIssue[]
}

/**
 * The single error class thrown by the engine and adapters.
 *
 * All rejections from `generate()` / `runStructured()` are `LlmError`.
 * Callers can narrow by `kind` to decide whether to retry, surface to the
 * user, or log.
 *
 * @example
 * ```ts
 * try {
 *   const result = await generate(request)
 * } catch (e) {
 *   if (e instanceof LlmError && e.retryable) scheduleRetry(e.retryAfterMs)
 *   else throw e
 * }
 * ```
 */
export class LlmError extends Error {
  /** Error category. */
  readonly kind: LlmErrorKind
  /** Whether the caller may safely retry. */
  readonly retryable: boolean
  /** Machine-readable reason within `kind`, when one applies. */
  readonly reason?: LlmErrorReason
  /** HTTP status code, if applicable. */
  readonly httpStatus?: number
  /** Suggested retry delay in milliseconds. */
  readonly retryAfterMs?: number
  /** Provider identifier, if known. */
  readonly provider?: string
  /**
   * Underlying cause.
   * Overrides the standard `Error.cause` to accept `unknown` (not just `Error`).
   */
  override readonly cause?: unknown
  /** The call ID from the engine at the time of failure. */
  readonly callId?: string
  /** The attempt ID from the engine at the time of failure. */
  readonly attemptId?: string
  /** Service tier actually attempted by the provider when known. */
  readonly servedServiceTier?: string
  /** Provider-reported usage for a billed response that failed after HTTP success. */
  readonly usage?: Usage
  /** Adapter notes for a failed attempt that carries `usage`; persisted on its record. */
  readonly warnings?: readonly Warning[]
  /** Structured validation failures, one entry per violation, when applicable. */
  readonly issues?: readonly LlmErrorIssue[]

  constructor(message: string, options: LlmErrorOptions) {
    super(message)
    this.name = 'LlmError'
    this.kind = options.kind
    this.retryable = options.retryable
    if (options.reason !== undefined) {
      this.reason = options.reason
    }
    // With exactOptionalPropertyTypes we must not assign `undefined` to optional
    // properties — only conditionally include them.
    if (options.httpStatus !== undefined) {
      this.httpStatus = options.httpStatus
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs
    }
    if (options.provider !== undefined) {
      this.provider = options.provider
    }
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
    if (options.callId !== undefined) {
      this.callId = options.callId
    }
    if (options.attemptId !== undefined) {
      this.attemptId = options.attemptId
    }
    if (options.servedServiceTier !== undefined) {
      this.servedServiceTier = options.servedServiceTier
    }
    if (options.usage !== undefined) {
      this.usage = options.usage
    }
    if (options.warnings !== undefined) {
      this.warnings = options.warnings
    }
    if (options.issues !== undefined) {
      this.issues = options.issues
    }

    // Maintain a proper prototype chain in transpiled ES5 environments.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// HTTP status classifier
// ---------------------------------------------------------------------------

/**
 * The result of classifying an HTTP status code.
 */
export interface HttpClassification {
  /** The error kind that corresponds to this HTTP status. */
  kind: LlmErrorKind
  /** Whether the caller may retry after receiving this status. */
  retryable: boolean
  /**
   * Suggested retry delay in milliseconds.
   * Present for every retryable status (`408`, `429`, `5xx`) when
   * `retryAfterMs` was passed in, so a `503` with `Retry-After` is honoured
   * like a `429`.
   */
  retryAfterMs?: number
}

/**
 * Maps an HTTP response status code to a typed error classification.
 *
 * | Status      | Kind            | Retryable |
 * |-------------|-----------------|-----------|
 * | 401         | `invalid_auth`  | No        |
 * | 403         | `invalid_auth`  | No        |
 * | 408         | `timeout`       | Yes       |
 * | 429         | `rate_limited`  | Yes       |
 * | 400, 422    | `bad_request`   | No        |
 * | 404, 413    | `bad_request`   | No        |
 * | 5xx         | `server`        | Yes       |
 * | 409, other  | `unknown`       | No        |
 *
 * 404 (an unknown model or resource) and 413 (a payload the provider refuses)
 * are the caller's request, so retrying the same call cannot help. 409 is a
 * conflict whose meaning differs per provider, so it stays `unknown`.
 *
 * 403 is the *default* when no adapter overlay has spoken. Providers overload
 * 403 (permission vs content policy); adapters reclassify from a structured
 * body, never from free-form `Error.message`.
 *
 * @param status - The HTTP response status code.
 * @param retryAfterMs - When available (from a `Retry-After` header parsed by
 *   the adapter), this value is forwarded in the returned classification for
 *   every retryable status (`408`, `429`, `5xx`).
 */
export function classifyHttpStatus(
  status: number,
  retryAfterMs?: number,
): HttpClassification {
  const withDelay = (
    kind: LlmErrorKind,
  ): { kind: LlmErrorKind; retryable: true; retryAfterMs?: number } => ({
    kind,
    retryable: true,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  })
  if (status === 401 || status === 403) {
    return { kind: 'invalid_auth', retryable: false }
  }
  if (status === 408) return withDelay('timeout')
  if (status === 429) return withDelay('rate_limited')
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { kind: 'bad_request', retryable: false }
  }
  if (status >= 500) return withDelay('server')
  return { kind: 'unknown', retryable: false }
}

// ---------------------------------------------------------------------------
// StandardSchema issue normalization
// ---------------------------------------------------------------------------

/**
 * A StandardSchema issue normalized once, retaining its STRUCTURED path
 * segments alongside the flattened dotted `path`.
 *
 * The structured `segments` array is the single source both derived
 * representations render from: the dotted {@link LlmErrorIssue.path} carried
 * on `LlmError.issues`, and any message-string formatter (e.g. the engine's
 * config-validation rendering, which keeps `[0]` bracket notation for array
 * indices). Because both come from the same segments, they cannot drift.
 *
 * Symbol keys are stringified via `Symbol#toString()` at normalization time —
 * everything downstream is plain JSON, safe for ledgers and postmortems.
 */
export interface NormalizedSchemaIssue extends LlmErrorIssue {
  /** Structured path segments; numbers preserve array-index identity. Empty for a root-level issue. */
  segments: readonly (string | number)[]
}

/**
 * Normalizes a single StandardSchema issue path into structured segments.
 *
 * Accepts both bare `PropertyKey` segments and `{ key: PropertyKey }`
 * wrapper segments (the two forms permitted by `StandardSchemaV1.Issue.path`).
 */
function normalizeIssueSegments(
  path: StandardSchemaV1.Issue['path'] | undefined,
): (string | number)[] {
  if (path === undefined || path.length === 0) return []
  return path.map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment
    if (typeof key === 'number') return key
    return typeof key === 'symbol' ? key.toString() : key
  })
}

/**
 * Normalizes StandardSchema validation issues into the shared
 * {@link NormalizedSchemaIssue} shape used by every caller-fault validation
 * error in the engine (model-config validation, strict template
 * interpolation, callsite `inputSchema`, request `inputContract`).
 *
 * This is the single source consulted whenever a `bad_request` message
 * string and its accompanying `issues` array are built from the same
 * `StandardSchemaV1.FailureResult` — message formatters render from
 * `segments`, the error payload derives via {@link toErrorIssues}, so the
 * two representations cannot drift apart.
 */
export function normalizeSchemaIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): NormalizedSchemaIssue[] {
  return issues.map((issue) => {
    const segments = normalizeIssueSegments(issue.path)
    return {
      segments,
      path: segments.map(String).join('.'),
      message: issue.message,
    }
  })
}

/**
 * Projects normalized issues down to the plain {@link LlmErrorIssue} payload
 * carried on `LlmError.issues` — the `segments` working data is stripped so
 * the error surface stays the minimal `{ path, message }` JSON contract.
 */
export function toErrorIssues(
  issues: ReadonlyArray<NormalizedSchemaIssue>,
): LlmErrorIssue[] {
  return issues.map(({ path, message }) => ({ path, message }))
}

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

/**
 * The largest delay {@link parseRetryAfter} returns: 24 hours. A provider
 * value above it is reported as 24 hours, so a hostile or broken header cannot
 * hand a host an absurd schedule time.
 */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Response headers {@link parseRetryAfter} reads: a `Headers`-like object
 * (anything with `get(name)`) or a plain record, whose keys are matched
 * case-insensitively. A record value may be a string, a number or an array
 * (every element is read).
 */
export type RetryAfterHeaders =
  { get(name: string): string | null } | Readonly<Record<string, unknown>>

const DECIMAL_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/
// Go-style durations as OpenAI sends them (`6m0s`, `1h2m3.5s`, `250ms`).
const DURATION =
  /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/
// Every HTTP-date format carries a clock time; this keeps `Date.parse` from
// accepting loose text such as "retry 5".
const HTTP_DATE_CLOCK = /\d{1,2}:\d{2}:\d{2}/
// The asctime format has no zone, and HTTP dates are always GMT; `Date.parse`
// would read it as local time.
const HTTP_DATE_ZONE = /(?:GMT|UTC|UT|Z|[+-]\d{4})\s*$/i

/**
 * Every value of a header, in order. A `Headers` object (or any `get`) merges
 * duplicates into one comma-joined string; a plain record may hold an array.
 * Comma-joined values are split, except an HTTP-date, whose weekday carries a
 * comma of its own.
 */
function readHeaderValues(headers: RetryAfterHeaders, name: string): string[] {
  const raw: unknown[] = []
  const getter = (headers as { get?: unknown }).get
  if (typeof getter === 'function') {
    raw.push((getter as (this: unknown, n: string) => unknown).call(headers, name))
  } else {
    const record = headers as Readonly<Record<string, unknown>>
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() !== name) continue
      const value = record[key]
      if (Array.isArray(value)) raw.push(...(value as unknown[]))
      else raw.push(value)
    }
  }
  const values: string[] = []
  for (const item of raw) {
    const text =
      typeof item === 'string' ? item : typeof item === 'number' ? String(item) : ''
    if (text.length === 0) continue
    if (HTTP_DATE_CLOCK.test(text)) values.push(text)
    else values.push(...text.split(','))
  }
  return values
}

function parseDuration(value: string): number | undefined {
  const match = DURATION.exec(value)
  if (match === null) return undefined
  const [h, m, sec, ms] = match.slice(1) as Array<string | undefined>
  if (h === undefined && m === undefined && sec === undefined && ms === undefined) {
    return undefined
  }
  const part = (g: string | undefined): number => (g === undefined ? 0 : Number(g))
  return part(h) * 3_600_000 + part(m) * 60_000 + part(sec) * 1000 + part(ms)
}

/**
 * A positive delay rounded up (never undercutting the provider), capped. A
 * value too large for a number is a very long delay, so it is the cap too.
 */
function finishDelay(ms: number): number | undefined {
  if (Number.isNaN(ms) || ms <= 0) return undefined
  return Math.min(Math.ceil(ms), MAX_RETRY_AFTER_MS)
}

function parseRetryAfterHeader(value: string, now: number): number | undefined {
  const v = value.trim()
  if (DECIMAL_NUMBER.test(v)) return finishDelay(Number(v) * 1000)
  const duration = parseDuration(v)
  if (duration !== undefined) return finishDelay(duration)
  if (HTTP_DATE_CLOCK.test(v)) {
    const at = Date.parse(HTTP_DATE_ZONE.test(v) ? v : `${v} GMT`)
    if (!Number.isNaN(at)) return finishDelay(at - now)
  }
  return undefined
}

/**
 * A reset header: delta-seconds, a duration such as `6m0s`, a Unix timestamp
 * in seconds (above 1e9) or in milliseconds (above 1e12).
 */
function parseResetHeader(value: string, now: number): number | undefined {
  const v = value.trim()
  if (DECIMAL_NUMBER.test(v)) {
    const n = Number(v)
    if (n > 1e12) return finishDelay(n - now)
    return finishDelay(n > 1e9 ? n * 1000 - now : n * 1000)
  }
  const duration = parseDuration(v)
  return duration === undefined ? undefined : finishDelay(duration)
}

/**
 * Each rate-limit window a response may describe: its reset header and the
 * header that says how much of it is left, when the provider sends one.
 * OpenAI-style APIs send one pair per limit (`-requests`, `-tokens`) and the
 * limit that was hit is the one whose remaining count is 0.
 */
const RESET_WINDOWS = [
  ['x-ratelimit-reset-requests', 'x-ratelimit-remaining-requests'],
  ['x-ratelimit-reset-tokens', 'x-ratelimit-remaining-tokens'],
  ['x-ratelimit-reset', 'x-ratelimit-remaining'],
  ['ratelimit-reset', 'ratelimit-remaining'],
] as const

/** The largest value of `values`, or `undefined` when it is empty. */
function largest(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values)
}

/** The smallest value of `values`, or `undefined` when it is empty. */
function smallest(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values)
}

/**
 * The delay the reset headers imply. These headers say when each limit resets
 * to full, whether or not that limit caused the refusal, so they are not one
 * delay:
 *
 * - When a window reports `remaining` of 0, those are the exhausted limits and
 *   the caller needs all of them back: the longest of their resets.
 * - Otherwise the limit that was hit cannot be told apart, and the earliest
 *   reset is the earliest moment any limit frees up: the shortest of all the
 *   resets. A longer window that is not exhausted never extends the wait.
 */
function resetDelay(headers: RetryAfterHeaders, now: number): number | undefined {
  const exhausted: number[] = []
  const all: number[] = []
  for (const [resetName, remainingName] of RESET_WINDOWS) {
    const delays = readHeaderValues(headers, resetName).flatMap((raw) => {
      const delay = parseResetHeader(raw, now)
      return delay === undefined ? [] : [delay]
    })
    if (delays.length === 0) continue
    all.push(...delays)
    const remaining = readHeaderValues(headers, remainingName).map((raw) => raw.trim())
    if (remaining.some((raw) => DECIMAL_NUMBER.test(raw) && Number(raw) <= 0)) {
      exhausted.push(...delays)
    }
  }
  return largest(exhausted) ?? smallest(all)
}

/**
 * Reads how long a provider asks the caller to wait from response headers, in
 * milliseconds, or `undefined` when no header carries a usable delay.
 *
 * Precedence: `retry-after-ms`, then `retry-after`, then the rate-limit reset
 * headers (`x-ratelimit-reset`, `x-ratelimit-reset-requests`,
 * `x-ratelimit-reset-tokens`, `ratelimit-reset`). Accepted forms:
 *
 * - `retry-after-ms`: milliseconds, decimals allowed.
 * - `retry-after`: delta-seconds (decimals allowed), an HTTP-date, or a
 *   duration such as `6m0s`.
 * - reset headers: delta-seconds, a duration such as `6m0s`, a Unix timestamp
 *   in seconds (above 1e9) or in milliseconds (above 1e12).
 *
 * Several values of one header (an array, or duplicates a `Headers` object
 * joined with commas) give the longest of them for `retry-after-ms` and
 * `retry-after`: a retry before any stated delay would be refused.
 *
 * The reset headers describe every limit the provider tracks, not only the one
 * that refused the request. When a window's matching `-remaining` header is 0
 * the delay is the longest reset among the exhausted windows. When none is
 * identifiable it is the shortest reset of all of them, so a distant window
 * that was never hit (OpenAI sends `x-ratelimit-reset-requests: 6m0s` beside
 * `x-ratelimit-reset-tokens: 1s`) does not turn a short wait into a stop. The
 * result is the earliest time a retry can succeed, never a time it is sure to.
 *
 * A value that is not a positive delay is ignored (zero, a date in the past,
 * text), so the caller falls back to its own back-off. Results round up and
 * are capped at 24 hours. HTTP-dates and epoch resets are measured against
 * `now`, so clock skew between the host and the provider shifts them.
 *
 * @param headers - The response headers.
 * @param now     - The current time in ms since the epoch; it resolves
 *   HTTP-dates and epoch resets. Pass `Date.now()`.
 */
export function parseRetryAfter(
  headers: RetryAfterHeaders,
  now: number,
): number | undefined {
  const ms = largest(
    readHeaderValues(headers, 'retry-after-ms').flatMap((raw) => {
      const v = raw.trim()
      const parsed = DECIMAL_NUMBER.test(v) ? finishDelay(Number(v)) : undefined
      return parsed === undefined ? [] : [parsed]
    }),
  )
  if (ms !== undefined) return ms
  const retryAfter = largest(
    readHeaderValues(headers, 'retry-after').flatMap((raw) => {
      const parsed = parseRetryAfterHeader(raw, now)
      return parsed === undefined ? [] : [parsed]
    }),
  )
  if (retryAfter !== undefined) return retryAfter
  return resetDelay(headers, now)
}

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

// Connection-level failures: nothing was answered, or the connection was cut.
// undici's programming errors (`UND_ERR_INVALID_ARG`, `UND_ERR_NOT_SUPPORTED`,
// a closed or destroyed client) are deliberately not listed: retrying them
// cannot succeed.
const TRANSPORT_CODE =
  /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|UND_ERR_RES_CONTENT_LENGTH_MISMATCH)$/
// undici's own deadlines (connect, headers, body). They are timeouts, not
// severed connections, and are retryable like any other timeout.
const UNDICI_TIMEOUT_CODE = /^UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT$/
// The whole message must be one of these, so free text that merely mentions
// one of them ("no connection error handler", "fetch failed: file not found")
// is not a transport failure. Node formats a syscall failure as
// `<syscall> <ERRNO> <address>`.
const TRANSPORT_MESSAGE =
  /^(?:fetch failed|connection error\.?|socket hang up|(?:connect|read|write|send|getaddrinfo) (?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)(?: \S.*)?)$/i

/**
 * `value` followed by its `.cause` chain (bounded to 8 nodes, cycle-safe).
 * Non-object values yield an empty chain.
 */
export function causeChain(value: unknown): object[] {
  const chain: object[] = []
  let current = value
  while (
    current !== null &&
    typeof current === 'object' &&
    !chain.includes(current) &&
    chain.length < 8
  ) {
    chain.push(current)
    current = (current as { cause?: unknown }).cause
  }
  return chain
}

/**
 * True when `e` is, or wraps through its `.cause` chain, a transport-level
 * failure: the request never produced an HTTP response, or the connection was
 * severed mid-flight. Matches an errno or undici `code` of `ECONNRESET`,
 * `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `ENOTFOUND`,
 * `ENETUNREACH`, `EHOSTUNREACH`, `UND_ERR_CONNECT_TIMEOUT`,
 * `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `UND_ERR_SOCKET` or
 * `UND_ERR_RES_CONTENT_LENGTH_MISMATCH`, and an error whose whole message is
 * `fetch failed`, `connection error` or `socket hang up`, or a Node syscall
 * failure such as `connect ECONNREFUSED 127.0.0.1:443` (undici's
 * `TypeError: fetch failed` carries the errno error as `cause`).
 *
 * Adapters call this to widen their own classification; {@link classifyError}
 * calls it to make a transport failure a retryable `server` error.
 */
export function isTransportError(e: unknown): boolean {
  for (const node of causeChain(e)) {
    const { code, message } = node as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && TRANSPORT_CODE.test(code)) return true
    if (typeof message === 'string' && TRANSPORT_MESSAGE.test(message.trim())) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Plain-object error helpers (provider SDKs throw non-Error objects)
// ---------------------------------------------------------------------------

/** True for a number that can be an HTTP status. */
function isHttpStatus(n: number): boolean {
  return Number.isInteger(n) && n >= 100 && n <= 599
}

/**
 * Reads an HTTP status from a value: a number, or a three-digit numeric string
 * (gaxios sets `code` to the string status). A number outside 100-599, such as
 * an errno or a gRPC code, is not a status.
 */
function statusValue(v: unknown): number | undefined {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && /^\d{3}$/.test(v.trim())
        ? Number(v)
        : undefined
  return n !== undefined && isHttpStatus(n) ? n : undefined
}

/** One level down: `obj[key]` when it is an object, else `undefined`. */
function child(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = obj[key]
  return nested !== null && typeof nested === 'object'
    ? (nested as Record<string, unknown>)
    : undefined
}

/**
 * Extracts a suggested retry delay (milliseconds) from a plain-object error.
 *
 * Probe order:
 * 1. `obj.retryAfterMs` — already in milliseconds.
 * 2. `obj.retryAfter` as a positive number — treated as **seconds** → ms.
 * 3. `obj.headers`, then `obj.response.headers` (axios, ky), read by
 *    {@link parseRetryAfter}. Supports both `Headers.get()` and plain
 *    objects.
 *
 * Every value is positive and capped at 24 hours.
 */
function extractRetryAfterMs(
  obj: Record<string, unknown>,
  now: number,
): number | undefined {
  const directMs = obj['retryAfterMs']
  if (typeof directMs === 'number') {
    const delay = finishDelay(directMs)
    if (delay !== undefined) return delay
  }

  const ra = obj['retryAfter']
  if (typeof ra === 'number') {
    const delay = finishDelay(ra * 1000)
    if (delay !== undefined) return delay
  }

  for (const headers of [obj['headers'], child(obj, 'response')?.['headers']]) {
    if (headers !== null && typeof headers === 'object') {
      const delay = parseRetryAfter(headers as RetryAfterHeaders, now)
      if (delay !== undefined) return delay
    }
  }

  return undefined
}

/**
 * Extracts an HTTP status code from a plain-object error.
 *
 * Checked locations (first valid status wins):
 * - `obj.status`, `obj.statusCode` (AI SDK, got, AWS)
 * - `obj.code`             (number, or a numeric string such as `'429'`)
 * - `obj.response.status`, `obj.response.statusCode` (nested)
 * - `obj.error.status`, `obj.error.statusCode`, `obj.error.code` (nested)
 */
function extractHttpStatus(obj: Record<string, unknown>): number | undefined {
  const response = child(obj, 'response')
  const error = child(obj, 'error')
  const candidates = [
    obj['status'],
    obj['statusCode'],
    obj['code'],
    response?.['status'],
    response?.['statusCode'],
    error?.['status'],
    error?.['statusCode'],
    error?.['code'],
  ]
  for (const candidate of candidates) {
    const status = statusValue(candidate)
    if (status !== undefined) return status
  }
  return undefined
}

/**
 * Builds an `LlmError` from a plain-object error that carries an HTTP status
 * code.  Routes the status through `classifyHttpStatus` and injects any
 * available retry-after delay.
 */
function classifyObjectError(
  obj: Record<string, unknown>,
  httpStatus: number,
  cause: unknown,
  messageOverride?: string,
): LlmError {
  const retryAfterMs = extractRetryAfterMs(obj, Date.now())
  const cls = classifyHttpStatus(httpStatus, retryAfterMs)
  return new LlmError(messageOverride ?? `HTTP ${httpStatus}`, {
    kind: cls.kind,
    retryable: cls.retryable,
    httpStatus,
    ...(cls.retryAfterMs !== undefined ? { retryAfterMs: cls.retryAfterMs } : {}),
    cause,
  })
}

// ---------------------------------------------------------------------------
// Generic error classifier
// ---------------------------------------------------------------------------

/**
 * Classifies an arbitrary thrown value into a typed {@link LlmError}.
 *
 * Detection order, structured evidence first and message text last:
 * 1. Already an `LlmError` → returned as-is.
 * 2. `Error.name === 'AbortError'` → `'aborted'` (not retryable).
 * 3. Any object (including `Error` subclasses), or an object on its `.cause`
 *    chain, with a recognisable HTTP `status`, `statusCode`, `code` (a number
 *    or a three-digit numeric string), or nested `response.status` /
 *    `error.status` / `error.code` (100-599) → routed through
 *    {@link classifyHttpStatus}. A `retryAfterMs` / `retryAfter` / header delay
 *    (`headers` or `response.headers`) is extracted when present.
 * 4. `Error.name === 'TimeoutError'` → `'timeout'` (retryable).
 * 5. A transport failure ({@link isTransportError}: a connection errno on the
 *    `cause` chain, `fetch failed`, `connection error`) → `'server'`
 *    (retryable); an undici deadline (`UND_ERR_*_TIMEOUT`) → `'timeout'`
 *    (retryable).
 * 6. An `Error` whose message contains `'timeout'` / `'timed out'`
 *    (case-insensitive) → `'timeout'` (retryable). This is the last, weakest
 *    signal, so it never overrides a status or an errno.
 * 7. Anything else → `'unknown'` (not retryable).
 *
 * The original error is always attached as `cause`.
 *
 * @param e - Any thrown value (the engine catches `unknown`).
 */
export function classifyError(e: unknown): LlmError {
  // 1. Already classified — pass through unchanged.
  if (e instanceof LlmError) return e

  const errorMessage = e instanceof Error ? e.message : undefined

  // 2. AbortSignal cancellation.
  if (e instanceof Error && e.name === 'AbortError') {
    return new LlmError(e.message || 'Request aborted', {
      kind: 'aborted',
      retryable: false,
      cause: e,
    })
  }

  // 3. Structured HTTP status (the primary provider SDK pattern, whether an
  //    `Error` subclass or a plain `throw { status: 429 }`). The error is read
  //    first, then each `.cause` down the chain: an SDK that wraps the HTTP
  //    error keeps its status one level down.
  for (const node of causeChain(e)) {
    const obj = node as Record<string, unknown>
    const httpStatus = extractHttpStatus(obj)
    if (httpStatus !== undefined) {
      return classifyObjectError(
        obj,
        httpStatus,
        e,
        errorMessage !== undefined && errorMessage.length > 0 ? errorMessage : undefined,
      )
    }
  }

  // 4. Timeout named by the runtime (Node fetch / AbortSignal.timeout).
  if (e instanceof Error && e.name === 'TimeoutError') {
    return new LlmError(e.message || 'Request timed out', {
      kind: 'timeout',
      retryable: true,
      cause: e,
    })
  }

  // 5. Transport failure: no HTTP response was produced. undici's own
  //    deadlines (`UND_ERR_*_TIMEOUT`) are timeouts, any other failure is a
  //    severed or refused connection.
  if (isTransportError(e)) {
    const undiciTimeout = causeChain(e).some((node) => {
      const code = (node as { code?: unknown }).code
      return typeof code === 'string' && UNDICI_TIMEOUT_CODE.test(code)
    })
    const rawMessage = (e as { message?: unknown } | null)?.message
    return new LlmError(
      typeof rawMessage === 'string' && rawMessage.length > 0
        ? rawMessage
        : 'Transport error',
      { kind: undiciTimeout ? 'timeout' : 'server', retryable: true, cause: e },
    )
  }

  // 6. Message heuristic for SDK-level timeout errors — last on purpose.
  if (e instanceof Error && /timeout|timed?\s+out/i.test(e.message)) {
    return new LlmError(e.message || 'Request timed out', {
      kind: 'timeout',
      retryable: true,
      cause: e,
    })
  }

  // 7. Everything else.
  if (e instanceof Error) {
    return new LlmError(e.message || 'Unknown error', {
      kind: 'unknown',
      retryable: false,
      cause: e,
    })
  }
  return new LlmError(typeof e === 'string' ? e : 'Unknown error', {
    kind: 'unknown',
    retryable: false,
    cause: e,
  })
}
