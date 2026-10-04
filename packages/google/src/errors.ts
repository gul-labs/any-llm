/**
 * classifyGoogleError — reclassify a raw thrown value into a typed
 * {@link LlmError} for @gullabs/google.
 *
 * Thin wrapper around `@gullabs/core`'s `classifyError`, which already routes
 * by HTTP status first, treats a transport failure (`fetch failed`, an errno on
 * the cause chain) as a retryable `server` error and maps 404/413 to
 * `bad_request`. This module adds the overlays Gemini's structured error body
 * supports (ADR-028 style: only the parsed body, never free text):
 *
 * - `RetryInfo.retryDelay` becomes `retryAfterMs` (the SDK's `ApiError` keeps no
 *   headers, so the body is the only place Google puts the delay).
 * - A `QuotaFailure` whose quota id contains `PerDay` is a daily quota: it
 *   cannot recover before the next day, so it is `rate_limited` with
 *   `retryable: false` and `reason: 'daily_quota'`.
 * - `ErrorInfo.reason` `API_KEY_INVALID` / `API_KEY_EXPIRED` is `invalid_auth`.
 *   Google sends the invalid-key case as HTTP 400, which would otherwise read
 *   as a caller bug (live capture, probe P6, 2026-10-03). `API_KEY_EXPIRED` is
 *   mapped from Google's documented reason set; an expired key could not be
 *   produced to capture it.
 * - A 403 whose body message is `CachedContent not found (or permission
 *   denied)` is a stale `cachedContent` reference: `bad_request` with
 *   `reason: 'cache_not_found'` (probe P6). Google sends no structured reason
 *   for it, so the body's `message` field is the only signal, and a genuine
 *   permission failure cannot be told apart.
 *
 * @module
 */

import { LlmError, classifyError, parseRetryAfter } from '@gullabs/core'

/** The structured body the SDK serializes into `ApiError.message`. */
export interface GoogleErrorBody {
  /** `error.status`, the gRPC status name (`RESOURCE_EXHAUSTED`, `UNAVAILABLE`, ...). */
  status?: string
  /** `error.message`. */
  message?: string
  /** `error.details`, as sent. */
  details: readonly Record<string, unknown>[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads the structured Gemini error body from a raw thrown `ApiError`, or from
 * an `LlmError` whose `cause` is one. `undefined` when the value carries no
 * parseable `{ error: {...} }` body (a transport failure, a plain `Error`).
 */
export function parseGoogleErrorBody(rawErr: unknown): GoogleErrorBody | undefined {
  const source = rawErr instanceof LlmError ? rawErr.cause : rawErr
  if (!(source instanceof Error)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(source.message)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed['error'])) return undefined
  const error = parsed['error']
  const details = Array.isArray(error['details']) ? error['details'].filter(isRecord) : []
  return {
    ...(typeof error['status'] === 'string' ? { status: error['status'] } : {}),
    ...(typeof error['message'] === 'string' ? { message: error['message'] } : {}),
    details,
  }
}

function detailOfType(body: GoogleErrorBody, type: string): Record<string, unknown>[] {
  return body.details.filter((d) => d['@type'] === `type.googleapis.com/${type}`)
}

/** `ErrorInfo.reason` values of the details, in order. */
function errorInfoReasons(body: GoogleErrorBody): string[] {
  return detailOfType(body, 'google.rpc.ErrorInfo').flatMap((d) =>
    typeof d['reason'] === 'string' ? [d['reason']] : [],
  )
}

/** True when a `QuotaFailure` violation's `quotaId` names a per-day quota. */
function isDailyQuota(body: GoogleErrorBody): boolean {
  return detailOfType(body, 'google.rpc.QuotaFailure').some(
    (failure) =>
      Array.isArray(failure['violations']) &&
      failure['violations'].some(
        (v) =>
          isRecord(v) &&
          typeof v['quotaId'] === 'string' &&
          v['quotaId'].includes('PerDay'),
      ),
  )
}

// A protobuf Duration in JSON: decimal seconds (at most 9 fractional digits)
// followed by `s`. Anything else (`"3"`, `"1h"`, `"6m0s"`) is not a Duration.
const PROTO_DURATION = /^\d+(?:\.\d{1,9})?s$/

/**
 * The text of a `RetryInfo.retryDelay`. The documented JSON form is the string
 * `"34s"`; an object `{ seconds, nanos }` (the proto field layout, which a
 * proxy or SDK may hand over unconverted) is rendered to the same text.
 * `undefined` for anything that is not a Duration.
 */
function durationText(delay: unknown): string | undefined {
  if (typeof delay === 'string') return PROTO_DURATION.test(delay) ? delay : undefined
  if (!isRecord(delay)) return undefined
  const { seconds, nanos } = delay
  const whole =
    typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0
      ? String(seconds)
      : typeof seconds === 'string' && /^\d+$/.test(seconds)
        ? seconds
        : seconds === undefined
          ? '0'
          : undefined
  const fraction =
    typeof nanos === 'number' && Number.isInteger(nanos) && nanos >= 0 && nanos < 1e9
      ? String(nanos).padStart(9, '0')
      : nanos === undefined
        ? '0'
        : undefined
  return whole !== undefined && fraction !== undefined
    ? `${whole}.${fraction}s`
    : undefined
}

/**
 * `RetryInfo.retryDelay` in milliseconds. It is a protobuf Duration written as
 * decimal seconds with an `s` suffix (`"34s"`, `"34.5s"`); a value that is not
 * a Duration is ignored, and core's `parseRetryAfter` applies the shared
 * rounding and cap. A zero delay is not a delay (`undefined`), so the caller's
 * own back-off applies.
 */
function retryDelayMs(body: GoogleErrorBody): number | undefined {
  for (const info of detailOfType(body, 'google.rpc.RetryInfo')) {
    const text = durationText(info['retryDelay'])
    if (text === undefined) continue
    const ms = parseRetryAfter({ 'retry-after': text }, Date.now())
    if (ms !== undefined) return ms
  }
  return undefined
}

const API_KEY_REASONS = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED'])
const STALE_CACHE_MESSAGE = 'CachedContent not found'

/** Optional extra fields threaded onto the returned {@link LlmError}. */
export interface ClassifyGoogleErrorExtra {
  /** Service tier actually attempted by the provider when known. */
  servedServiceTier?: string
  /**
   * Set by the adapter when its own client-side ceiling, or the SDK's transport
   * timer, ended the call (the caller and the engine's deadline had not
   * aborted): what happened, in words. The error is then a `timeout` that is not
   * retryable, `reason: 'transport_timeout'`.
   */
  transportTimeout?: string
}

/**
 * Classify a raw error thrown from a `@google/genai` client call into a
 * typed {@link LlmError} always tagged `provider: 'google'`.
 *
 * Delegates to `@gullabs/core`'s `classifyError` (an already-classified
 * `LlmError` passes through unchanged), applies the structured-body overlays
 * described in the module header, and rebuilds the result with
 * `provider: 'google'` forced on, so every error surfaced by this adapter is
 * tagged even one injected pre-classified.
 */
export function classifyGoogleError(
  rawErr: unknown,
  extra?: ClassifyGoogleErrorExtra,
): LlmError {
  const base = classifyError(rawErr)
  const body = parseGoogleErrorBody(rawErr)

  let kind = base.kind
  let retryable = base.retryable
  let reason = base.reason
  let retryAfterMs = base.retryAfterMs
  let message = base.message

  // A transport-level timeout (no HTTP answer) is not retried: the same limit
  // is reached again, and the provider may already have run, and billed, the
  // request. An HTTP 408 or 504 is an answer from Google and keeps core's rule.
  // An already-classified error is not second-guessed.
  if (extra?.transportTimeout !== undefined) {
    kind = 'timeout'
    retryable = false
    reason = 'transport_timeout'
    retryAfterMs = undefined
    message = extra.transportTimeout
  } else if (
    !(rawErr instanceof LlmError) &&
    base.kind === 'timeout' &&
    base.httpStatus === undefined
  ) {
    retryable = false
    reason = 'transport_timeout'
    retryAfterMs = undefined
  }

  if (body !== undefined && base.httpStatus !== undefined) {
    if (errorInfoReasons(body).some((r) => API_KEY_REASONS.has(r))) {
      kind = 'invalid_auth'
      retryable = false
    } else if (
      base.httpStatus === 403 &&
      body.message?.startsWith(STALE_CACHE_MESSAGE) === true
    ) {
      kind = 'bad_request'
      retryable = false
      reason = 'cache_not_found'
    } else if (base.httpStatus === 429) {
      if (isDailyQuota(body)) {
        kind = 'rate_limited'
        retryable = false
        reason = 'daily_quota'
        retryAfterMs = undefined
      } else {
        retryAfterMs = retryDelayMs(body) ?? retryAfterMs
      }
    }
  }

  return new LlmError(message, {
    kind,
    retryable,
    ...(reason !== undefined ? { reason } : {}),
    ...(base.httpStatus !== undefined ? { httpStatus: base.httpStatus } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    provider: 'google',
    cause: base.cause ?? rawErr,
    ...(extra?.servedServiceTier !== undefined
      ? { servedServiceTier: extra.servedServiceTier }
      : {}),
  })
}
