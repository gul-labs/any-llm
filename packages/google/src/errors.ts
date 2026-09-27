/**
 * classifyGoogleError — reclassify a raw thrown value into a typed
 * {@link LlmError} for @gullabs/google.
 *
 * Thin wrapper around `@gullabs/core`'s `classifyError`: applies the shared
 * HTTP-status/timeout/abort classification, tags `provider: 'google'`, and
 * widens the retryable bucket to cover connection-level transport failures
 * that never produced an HTTP response for `classifyError` to route by
 * status.
 *
 * `@google/genai`'s underlying `fetch` (undici, in Node) throws a plain
 * `TypeError: fetch failed` for DNS failures, connection refusals, and
 * severed sockets — wrapping the underlying errno error as `.cause`.
 * `classifyError` has no HTTP status to classify these by, so they
 * previously fell through to `kind: 'unknown', retryable: false`, which
 * Temporal treats as non-retryable and uses to kill the host run outright
 * instead of retrying a transient network blip (live-observed 2026-07-10).
 *
 * These are reclassified `kind: 'server', retryable: true` — the same
 * "provider fault, not caller fault, safe to retry" bucket already used
 * elsewhere in this adapter for provider-side failures with no HTTP status
 * (see the malformed-`countTokens`-response case in `adapter.ts`).
 *
 * @module
 */

import { LlmError, classifyError } from '@gullabs/core'

/**
 * Message/errno signatures of a transport-level failure: the request never
 * reached Google's servers (or the connection was severed mid-flight), so
 * there is no HTTP response for `classifyHttpStatus` to route by status.
 * Covers undici's own default message (`"fetch failed"`) plus the
 * Node/undici errno codes that surface when the underlying socket fails
 * before a response arrives.
 */
const GOOGLE_TRANSPORT_ERROR_PATTERN =
  /fetch failed|connection error|econnreset|econnrefused|etimedout|eai_again|epipe|socket hang up/i

/** True iff `err.message` or `err.code` matches a known transport-failure signature. */
function matchesGoogleTransportSignature(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (GOOGLE_TRANSPORT_ERROR_PATTERN.test(err.message)) return true
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && GOOGLE_TRANSPORT_ERROR_PATTERN.test(code)
}

/**
 * True iff `rawErr` is (or wraps) a transport-level connection failure.
 *
 * Detection order:
 * 1. `rawErr.message` / `rawErr.code` matches a known transport-failure
 *    signature.
 * 2. A wrapped `rawErr.cause` matches the same — undici's `fetch failed`
 *    `TypeError` attaches the underlying socket/DNS errno error as
 *    `.cause`.
 */
function isGoogleTransportError(rawErr: unknown): boolean {
  if (matchesGoogleTransportSignature(rawErr)) return true
  if (rawErr instanceof Error) {
    const cause = (rawErr as { cause?: unknown }).cause
    if (matchesGoogleTransportSignature(cause)) return true
  }
  return false
}

/** The SDK serializes structured Gemini API errors into ApiError.message. */
function isGoogleModelNotFound(rawErr: unknown): boolean {
  if (!(rawErr instanceof Error)) return false
  if ((rawErr as Error & { status?: unknown }).status !== 404) return false
  try {
    const parsed = JSON.parse(rawErr.message) as {
      error?: { code?: unknown; status?: unknown }
    }
    return parsed.error?.code === 404 && parsed.error.status === 'NOT_FOUND'
  } catch {
    return false
  }
}

/** Optional extra fields threaded onto the returned {@link LlmError}. */
export interface ClassifyGoogleErrorExtra {
  /** Service tier actually attempted by the provider when known. */
  servedServiceTier?: string
}

/**
 * Classify a raw error thrown from a `@google/genai` client call into a
 * typed {@link LlmError} always tagged `provider: 'google'`.
 *
 * Delegates to `@gullabs/core`'s `classifyError` for HTTP-status/timeout/
 * abort classification (an already-classified `LlmError` passes through
 * `classifyError` unchanged, per its own contract), then rebuilds the
 * result with `provider: 'google'` forced on — every error surfaced by this
 * adapter is tagged, even one injected pre-classified (e.g. by a test
 * double) without a provider of its own. It also reclassifies the
 * `kind: 'unknown'` fallback as `kind: 'server', retryable: true` when the
 * raw error matches a known transport-failure signature (see
 * {@link isGoogleTransportError}). A connection that never reached Google is
 * not the caller's fault and is safe to retry; it must never be surfaced as
 * the non-retryable `unknown` kind.
 */
export function classifyGoogleError(
  rawErr: unknown,
  extra?: ClassifyGoogleErrorExtra,
): LlmError {
  const base = classifyError(rawErr)
  const reclassifyAsTransport = base.kind === 'unknown' && isGoogleTransportError(rawErr)
  const reclassifyAsBadRequest = base.kind === 'unknown' && isGoogleModelNotFound(rawErr)

  return new LlmError(base.message, {
    kind: reclassifyAsTransport
      ? 'server'
      : reclassifyAsBadRequest
        ? 'bad_request'
        : base.kind,
    retryable: reclassifyAsTransport ? true : base.retryable,
    ...(base.httpStatus !== undefined ? { httpStatus: base.httpStatus } : {}),
    ...(base.retryAfterMs !== undefined ? { retryAfterMs: base.retryAfterMs } : {}),
    provider: 'google',
    cause: base.cause ?? rawErr,
    ...(extra?.servedServiceTier !== undefined
      ? { servedServiceTier: extra.servedServiceTier }
      : {}),
  })
}
