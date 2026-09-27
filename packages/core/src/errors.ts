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
import type { Usage } from './types.js'

// ---------------------------------------------------------------------------
// Error kind
// ---------------------------------------------------------------------------

/**
 * Discriminant for every failure mode the library can surface.
 *
 * - `'invalid_auth'`    — 401, or 403 when no provider overlay reclassified;
 *   credentials wrong, missing, or the key lacks permission.
 * - `'rate_limited'`    — 429; back-off and retry.
 * - `'server'`          — 5xx or a candidate-less billed response without a
 *   safety block; retryable provider failure.
 * - `'timeout'`         — request exceeded `timeoutMs` or network timeout.
 * - `'aborted'`         — caller cancelled via `AbortSignal`.
 * - `'bad_request'`     — 400/422; the request itself is malformed.
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
  /** Structured validation failures, one entry per violation, when applicable. */
  readonly issues?: readonly LlmErrorIssue[]

  constructor(message: string, options: LlmErrorOptions) {
    super(message)
    this.name = 'LlmError'
    this.kind = options.kind
    this.retryable = options.retryable
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
   * Present only for `429` responses when `retryAfterMs` was passed in.
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
 * | 5xx         | `server`        | Yes       |
 * | other       | `unknown`       | No        |
 *
 * 403 is the *default* when no adapter overlay has spoken. Providers overload
 * 403 (permission vs content policy); adapters reclassify from a structured
 * body, never from free-form `Error.message`.
 *
 * @param status - The HTTP response status code.
 * @param retryAfterMs - When available (from a `Retry-After` header parsed by
 *   the adapter), this value is forwarded in the returned classification for
 *   `429` responses.
 */
export function classifyHttpStatus(
  status: number,
  retryAfterMs?: number,
): HttpClassification {
  if (status === 401 || status === 403) {
    return { kind: 'invalid_auth', retryable: false }
  }
  if (status === 408) {
    return { kind: 'timeout', retryable: true }
  }
  if (status === 429) {
    if (retryAfterMs !== undefined) {
      return { kind: 'rate_limited', retryable: true, retryAfterMs }
    }
    return { kind: 'rate_limited', retryable: true }
  }
  if (status === 400 || status === 422) {
    return { kind: 'bad_request', retryable: false }
  }
  if (status >= 500) {
    return { kind: 'server', retryable: true }
  }
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
// Plain-object error helpers (provider SDKs throw non-Error objects)
// ---------------------------------------------------------------------------

/**
 * Safely reads a numeric own-property from a `Record<string, unknown>` view of
 * an object.  Returns `undefined` if the property is absent or non-numeric.
 */
function numericProp(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === 'number' ? v : undefined
}

/**
 * Safely reads a numeric property one level deep (e.g. `obj.response.status`).
 * Returns `undefined` if either level is absent or non-numeric.
 */
function nestedNumericProp(
  obj: Record<string, unknown>,
  key1: string,
  key2: string,
): number | undefined {
  const nested = obj[key1]
  if (nested !== null && typeof nested === 'object') {
    return numericProp(nested as Record<string, unknown>, key2)
  }
  return undefined
}

/**
 * Extracts a suggested retry delay (milliseconds) from a plain-object error.
 *
 * Probe order:
 * 1. `obj.retryAfterMs` — already in milliseconds.
 * 2. `obj.retryAfter` as a positive number — treated as **seconds** → ms.
 * 3. `obj.headers['retry-after']` or `obj.headers['x-ratelimit-reset']` as a
 *    seconds string — converted to ms.  Supports both `Headers.get()` and
 *    plain string-valued objects.
 */
function extractRetryAfterMs(obj: Record<string, unknown>): number | undefined {
  // Direct retryAfterMs (already milliseconds).
  const directMs = numericProp(obj, 'retryAfterMs')
  if (directMs !== undefined) return directMs

  // retryAfter as a positive number (seconds → ms).
  const ra = obj['retryAfter']
  if (typeof ra === 'number' && ra > 0) return ra * 1000

  // Headers object — support both Headers-like (.get()) and plain objects.
  const headers = obj['headers']
  if (headers !== null && typeof headers === 'object') {
    const hObj = headers as Record<string, unknown>
    for (const key of ['retry-after', 'x-ratelimit-reset'] as const) {
      let raw: unknown
      if (typeof hObj['get'] === 'function') {
        // Standard `Headers` interface.
        raw = (hObj as { get(k: string): string | null }).get(key)
      } else {
        raw = hObj[key]
      }
      if (typeof raw === 'string') {
        const parsed = parseInt(raw, 10)
        if (!isNaN(parsed) && parsed > 0) return parsed * 1000
      }
    }
  }

  return undefined
}

/**
 * Extracts an HTTP status code from a plain-object error.
 *
 * Checked locations (first match wins):
 * - `obj.status`           (number)
 * - `obj.code`             (number — some SDKs use this)
 * - `obj.response.status`  (nested)
 * - `obj.error.status`     (nested)
 * - `obj.error.code`       (nested)
 */
function extractHttpStatus(obj: Record<string, unknown>): number | undefined {
  return (
    numericProp(obj, 'status') ??
    numericProp(obj, 'code') ??
    nestedNumericProp(obj, 'response', 'status') ??
    nestedNumericProp(obj, 'error', 'status') ??
    nestedNumericProp(obj, 'error', 'code')
  )
}

/**
 * Builds an `LlmError` from a plain-object error that carries a numeric HTTP
 * status code.  Routes the status through `classifyHttpStatus` and injects any
 * available retry-after delay.
 */
function classifyObjectError(
  obj: Record<string, unknown>,
  httpStatus: number,
  cause: unknown,
  messageOverride?: string,
): LlmError {
  const retryAfterMs = extractRetryAfterMs(obj)
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
 * Detection order:
 * 1. Already an `LlmError` → returned as-is.
 * 2. `Error.name === 'AbortError'` → `'aborted'` (not retryable).
 * 3. `Error.name === 'TimeoutError'` or message contains `'timeout'` /
 *    `'timed out'` (case-insensitive) → `'timeout'` (retryable).
 * 4. Any object (including `Error` subclasses) with a recognisable numeric
 *    `status`, `code`, or nested `response.status` / `error.status` /
 *    `error.code` → routed through {@link classifyHttpStatus}.  A
 *    `retryAfterMs` / `retryAfter` / header value is extracted when present.
 * 5. Anything else → `'unknown'` (not retryable).
 *
 * The original error is always attached as `cause`.
 *
 * @param e - Any thrown value (the engine catches `unknown`).
 */
export function classifyError(e: unknown): LlmError {
  // 1. Already classified — pass through unchanged.
  if (e instanceof LlmError) return e

  if (e instanceof Error) {
    // 2. AbortSignal cancellation.
    if (e.name === 'AbortError') {
      return new LlmError(e.message || 'Request aborted', {
        kind: 'aborted',
        retryable: false,
        cause: e,
      })
    }

    // 3. Timeout — named TimeoutError (Node.js fetch / AbortSignal.timeout) or
    //    message heuristic for SDK-level timeout errors.
    if (e.name === 'TimeoutError' || /timeout|timed?\s+out/i.test(e.message)) {
      return new LlmError(e.message || 'Request timed out', {
        kind: 'timeout',
        retryable: true,
        cause: e,
      })
    }

    // 4a. Error subclass with HTTP status metadata (e.g. provider SDK errors).
    const eAsObj = e as unknown as Record<string, unknown>
    const errHttpStatus = extractHttpStatus(eAsObj)
    if (errHttpStatus !== undefined) {
      return classifyObjectError(eAsObj, errHttpStatus, e, e.message || undefined)
    }

    // Fallthrough — unknown Error.
    return new LlmError(e.message || 'Unknown error', {
      kind: 'unknown',
      retryable: false,
      cause: e,
    })
  }

  // 4b. Plain-object throw (the primary provider SDK pattern: `throw { status: 429 }`).
  if (e !== null && typeof e === 'object') {
    const obj = e as Record<string, unknown>
    const httpStatus = extractHttpStatus(obj)
    if (httpStatus !== undefined) {
      return classifyObjectError(obj, httpStatus, e)
    }
  }

  // 5. Non-Error, non-object thrown value (string, number, null, etc.)
  //    or an object without any recognisable status key.
  const message = typeof e === 'string' ? e : 'Unknown error'
  return new LlmError(message, {
    kind: 'unknown',
    retryable: false,
    cause: e,
  })
}
