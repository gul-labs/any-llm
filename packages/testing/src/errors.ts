/**
 * Error factories: the shapes real SDKs and transports throw, so a test of
 * retry, classification or billing sees what production sees.
 *
 * `fakeProviderError` builds its errors from the real SDK error classes
 * (`ApiError` from `@google/genai`, `APIError` from `openai`) and the error
 * bodies pinned in the provider packages' fixtures. Both SDKs are optional peer
 * dependencies of this package, loaded only when a scenario for that provider
 * is built.
 *
 * @module
 */

import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { LlmError, type Usage, type Warning } from '@gullabs/core'
import { markProviderError } from './provider-errors.js'

// ---------------------------------------------------------------------------
// fakeHttpError
// ---------------------------------------------------------------------------

/** What {@link fakeHttpError} throws: an `Error` with `status` and real `Headers`. */
export class HttpStatusError extends Error {
  readonly status: number
  readonly headers: Headers
  /** The parsed response body, when one was given. */
  readonly error?: unknown

  constructor(status: number, message: string, headers: Headers, error?: unknown) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
    this.headers = headers
    if (error !== undefined) this.error = error
  }
}

export interface FakeHttpErrorOptions {
  /**
   * The `Retry-After` header: delta-seconds as a number or string, or an
   * HTTP-date string. Core turns it into `LlmError.retryAfterMs`.
   */
  retryAfter?: number | string
  /** Further response headers (for example `x-ratelimit-reset-requests`). */
  headers?: Record<string, string>
  /** The parsed response body, kept on `error`. */
  body?: unknown
  /** The error message. Default `HTTP <status>`. */
  message?: string
}

/**
 * An HTTP failure as an SDK status error carries it: an `Error` with `status`
 * and a real `Headers` object (the shape the `openai` SDK's status errors have
 * and `classifyError` reads). It builds no provider-specific body: use
 * {@link fakeProviderError} for a provider's own error shapes.
 *
 * @example
 * ```ts
 * new FakeAdapter('google', [fakeHttpError(429, { retryAfter: 2 }), okResult])
 * ```
 */
export function fakeHttpError(
  status: number,
  opts: FakeHttpErrorOptions = {},
): HttpStatusError {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError(
      `fakeHttpError: status must be an integer from 100 to 599, got ${String(status)}.`,
    )
  }
  const headers = new Headers(opts.headers)
  if (opts.retryAfter !== undefined) {
    headers.set('retry-after', String(opts.retryAfter))
  }
  return new HttpStatusError(status, opts.message ?? `HTTP ${status}`, headers, opts.body)
}

// ---------------------------------------------------------------------------
// fakeNetworkError
// ---------------------------------------------------------------------------

export interface FakeNetworkErrorOptions {
  /**
   * The errno `code` on the cause. Default `'ECONNRESET'`. Use
   * `'UND_ERR_CONNECT_TIMEOUT'`, `'UND_ERR_HEADERS_TIMEOUT'` or
   * `'UND_ERR_BODY_TIMEOUT'` for undici's own deadlines.
   */
  code?: string
}

/**
 * A transport failure as Node's `fetch` throws it: `TypeError: fetch failed`
 * whose `cause` is the connection error carrying an errno `code`. No HTTP
 * response was produced, so core classifies it `server` and retryable (an
 * undici deadline code, `timeout`).
 */
export function fakeNetworkError(opts: FakeNetworkErrorOptions = {}): TypeError {
  const code = opts.code ?? 'ECONNRESET'
  const syscall = NETWORK_SYSCALLS[code]
  const errno = osConstants.errno[code as keyof typeof osConstants.errno] as
    number | undefined
  const cause = Object.assign(
    new Error(syscall === undefined ? code : `${syscall} ${code}`),
    {
      code,
      // Node reports the errno negated, and the syscall that failed.
      ...(errno !== undefined ? { errno: -errno } : {}),
      ...(syscall !== undefined ? { syscall } : {}),
    },
  )
  return new TypeError('fetch failed', { cause })
}

/** The syscall Node names for each errno code a connection can fail with. */
const NETWORK_SYSCALLS: Readonly<Record<string, string>> = {
  ECONNRESET: 'read',
  ECONNREFUSED: 'connect',
  ETIMEDOUT: 'connect',
  EHOSTUNREACH: 'connect',
  ENETUNREACH: 'connect',
  EPIPE: 'write',
  ENOTFOUND: 'getaddrinfo',
  EAI_AGAIN: 'getaddrinfo',
}

// ---------------------------------------------------------------------------
// fakeBilledFailure
// ---------------------------------------------------------------------------

export interface FakeBilledFailureOptions {
  /** Default `'server'`. */
  kind?: 'server' | 'content_filter' | 'unknown'
  /** Default `true` for `server`, `false` otherwise. */
  retryable?: boolean
  /** Default `'fake: the provider answered 200 and billed the call, with no usable output'`. */
  message?: string
  provider?: string
  /** Notes persisted on the attempt's record, as an adapter attaches them. */
  warnings?: readonly Warning[]
}

/**
 * A billed failure: the provider answered HTTP 200 and billed the call, but the
 * response had no usable output, so the adapter throws an `LlmError` that
 * carries the `usage` it was billed for (the engine keeps that attempt's usage
 * and cost on its ledger row even though the call fails).
 *
 * @param usage - At least `inputTokens` and `outputTokens`; the rest defaults.
 */
export function fakeBilledFailure(
  usage: Pick<Usage, 'inputTokens' | 'outputTokens'> & Partial<Usage>,
  opts: FakeBilledFailureOptions = {},
): LlmError {
  const kind = opts.kind ?? 'server'
  return new LlmError(
    opts.message ??
      'fake: the provider answered 200 and billed the call, with no usable output',
    {
      kind,
      retryable: opts.retryable ?? kind === 'server',
      ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      usage: { details: {}, raw: null, ...usage },
      ...(opts.warnings !== undefined ? { warnings: opts.warnings } : {}),
    },
  )
}

// ---------------------------------------------------------------------------
// fakeStreamFailure
// ---------------------------------------------------------------------------

export interface FakeStreamFailureOptions {
  /**
   * The kind the adapter gives the failure. Default `'server'`. An `error` event
   * inside a stream can carry any provider code, so `rate_limited`, `bad_request`
   * and `invalid_auth` are allowed: they are the kinds a provider does not bill
   * when it refuses a request, and `mayHaveBilled` is what says this one may have.
   */
  kind?: 'server' | 'rate_limited' | 'bad_request' | 'invalid_auth' | 'unknown'
  /** Default `false`: a retry repeats what the call already generated. */
  retryable?: boolean
  /** Default `'fake: the provider reported an error inside an open stream'`. */
  message?: string
  /** Default `'xai'`. */
  provider?: string
  /**
   * The usage the failure reports: the terminal usage the stream carried, or the
   * adapter's estimate of what it received. Absent by default, as when the stream
   * died before any output.
   */
  usage?: Pick<Usage, 'inputTokens' | 'outputTokens'> & Partial<Usage>
}

/**
 * The `LlmError` an adapter throws for an error event inside an open stream: the
 * provider had accepted the request and started work, so `mayHaveBilled` is set
 * and the engine books the attempt as unpriced (never as a known-free `0`), and by
 * default it is not retried. Script it with `FakeAdapter` to test a host's
 * handling of "the call failed after it started": the ledger row, the retry
 * count, a spend ceiling.
 *
 * @example
 * ```ts
 * new FakeAdapter('xai', [fakeStreamFailure({ kind: 'rate_limited' })])
 * ```
 */
export function fakeStreamFailure(opts: FakeStreamFailureOptions = {}): LlmError {
  return new LlmError(
    opts.message ?? 'fake: the provider reported an error inside an open stream',
    {
      kind: opts.kind ?? 'server',
      retryable: opts.retryable ?? false,
      mayHaveBilled: true,
      provider: opts.provider ?? 'xai',
      ...(opts.usage !== undefined
        ? { usage: { details: {}, raw: null, ...opts.usage } }
        : {}),
    },
  )
}

// ---------------------------------------------------------------------------
// fakeProviderError
// ---------------------------------------------------------------------------

/**
 * Gemini error scenarios. Bodies are pinned in
 * `packages/google/src/__fixtures__/error-bodies-2026-10-03.json`.
 *
 * Captured from the live API (probe P6, 2026-10-03): `invalid-api-key`,
 * `empty-api-key`, `stale-cached-content`, `malformed-cache-name`.
 *
 * Doc-derived, NOT captures (ADR-013): `expired-api-key`, `per-minute-quota`,
 * `per-day-quota`, `capacity-503`, `retry-info-only`, `bare-429`. No Gemini 429
 * body was ever captured, so whether a real 429 carries these details is
 * unverified.
 */
export type GoogleErrorScenario =
  | 'invalid-api-key'
  | 'empty-api-key'
  | 'stale-cached-content'
  | 'malformed-cache-name'
  | 'expired-api-key'
  | 'per-minute-quota'
  | 'per-day-quota'
  | 'capacity-503'
  | 'retry-info-only'
  | 'bare-429'

/**
 * xAI error scenarios. Bodies are pinned in
 * `packages/xai/src/__fixtures__/`.
 *
 * Captured from the live API (`09-error-taxonomy.json`): `nonexistent-model`,
 * `malformed-body`, `invalid-api-key`.
 *
 * Reported shape, not an in-repo capture (`15-safety-check-403.json`, from a
 * public issue report): `safety-check`.
 *
 * Doc-derived, NOT captures (ADR-013, `doc-derived-error-shapes.json`):
 * `credits-exhausted-429`, `credits-exhausted-403`.
 */
export type XaiErrorScenario =
  | 'nonexistent-model'
  | 'malformed-body'
  | 'invalid-api-key'
  | 'safety-check'
  | 'credits-exhausted-429'
  | 'credits-exhausted-403'

/** Options of `fakeProviderError('xai', ...)`. */
export interface FakeXaiProviderErrorOptions {
  /** The response headers, for example `{ 'retry-after': '2', 'x-request-id': 'req_1' }`. */
  headers?: Record<string, string>
}

interface GoogleBodyCase {
  status: number
  body: Record<string, unknown>
}

interface XaiBodyCase {
  status: number
  body: unknown
}

const GOOGLE_DETAIL = 'type.googleapis.com/google.rpc'

/** Pinned Gemini bodies, verbatim from the google package's error-body fixture. */
export const GOOGLE_ERROR_CASES: Readonly<Record<GoogleErrorScenario, GoogleBodyCase>> = {
  'invalid-api-key': {
    status: 400,
    body: {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': `${GOOGLE_DETAIL}.ErrorInfo`,
            reason: 'API_KEY_INVALID',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
          {
            '@type': `${GOOGLE_DETAIL}.LocalizedMessage`,
            locale: 'en-US',
            message: 'API key not valid. Please pass a valid API key.',
          },
        ],
      },
    },
  },
  'empty-api-key': {
    status: 403,
    body: {
      error: {
        code: 403,
        message:
          "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.",
        status: 'PERMISSION_DENIED',
      },
    },
  },
  'stale-cached-content': {
    status: 403,
    body: {
      error: {
        code: 403,
        message: 'CachedContent not found (or permission denied)',
        status: 'PERMISSION_DENIED',
      },
    },
  },
  'malformed-cache-name': {
    status: 400,
    body: {
      error: {
        code: 400,
        message: 'Could not parse the CachedContent name',
        status: 'INVALID_ARGUMENT',
      },
    },
  },
  'expired-api-key': {
    status: 400,
    body: {
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': `${GOOGLE_DETAIL}.ErrorInfo`,
            reason: 'API_KEY_EXPIRED',
            domain: 'googleapis.com',
            metadata: { service: 'generativelanguage.googleapis.com' },
          },
        ],
      },
    },
  },
  'per-minute-quota': {
    status: 429,
    body: {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': `${GOOGLE_DETAIL}.QuotaFailure`,
            violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }],
          },
          { '@type': `${GOOGLE_DETAIL}.RetryInfo`, retryDelay: '34s' },
        ],
      },
    },
  },
  'per-day-quota': {
    status: 429,
    body: {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': `${GOOGLE_DETAIL}.QuotaFailure`,
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }],
          },
          { '@type': `${GOOGLE_DETAIL}.RetryInfo`, retryDelay: '34s' },
        ],
      },
    },
  },
  'capacity-503': {
    status: 503,
    body: {
      error: {
        code: 503,
        message: 'The system is currently at capacity.',
        status: 'UNAVAILABLE',
      },
    },
  },
  'retry-info-only': {
    status: 429,
    body: {
      error: {
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': `${GOOGLE_DETAIL}.RetryInfo`, retryDelay: '34s' }],
      },
    },
  },
  'bare-429': {
    status: 429,
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } },
  },
}

const CREDITS_EXHAUSTED_MESSAGE =
  'Your team 00000000-0000-0000-0000-000000000000 has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.'

/** Pinned xAI bodies, verbatim from the xai package's error fixtures. */
export const XAI_ERROR_CASES: Readonly<Record<XaiErrorScenario, XaiBodyCase>> = {
  'nonexistent-model': {
    status: 400,
    body: { code: 'invalid-argument', error: 'Model not found: grok-99' },
  },
  'malformed-body': {
    status: 422,
    body: {
      error:
        'Failed to deserialize the JSON body into the target type: data did not match any variant of untagged enum ModelInput',
    },
  },
  'invalid-api-key': {
    status: 400,
    body: {
      code: 'invalid-argument',
      error:
        'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
    },
  },
  'safety-check': {
    status: 403,
    body: {
      error: 'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
    },
  },
  'credits-exhausted-429': {
    status: 429,
    body: { error: CREDITS_EXHAUSTED_MESSAGE },
  },
  'credits-exhausted-403': {
    status: 403,
    body: { error: CREDITS_EXHAUSTED_MESSAGE },
  },
}

// `tsup` shims `import.meta.url` in the CommonJS build, so one form serves both.
const nodeRequire = createRequire(import.meta.url)

function loadSdk<T>(id: string, forWhat: string): T {
  try {
    return nodeRequire(id) as T
  } catch (cause) {
    throw new Error(
      `${forWhat} builds its error from the real "${id}" SDK class: install "${id}" (an optional peer dependency of @gullabs/testing).`,
      { cause },
    )
  }
}

/**
 * A provider error built from the real SDK class and a pinned error body.
 *
 * - `'google'`: `ApiError` from `@google/genai`, with the JSON body as its
 *   message and the HTTP status, as the SDK throws it.
 * - `'xai'`: the `openai` SDK's `APIError.generate(status, body, undefined,
 *   headers)` result (`RateLimitError`, `PermissionDeniedError`, ...), which is
 *   how the SDK builds a status error from a response. `opts.headers` are the
 *   response headers (`retry-after`, `x-request-id`, rate-limit headers, which
 *   the xAI classifier reads); default none. The Gemini SDK's error carries no
 *   headers, so `opts` is an xAI option.
 *
 * The SDK class is loaded with `require`, so it is the SDK's CommonJS build.
 * A host whose own code imports the SDK as ESM gets a different copy of the
 * class, and `instanceof` against that copy is false (the usual dual-package
 * hazard). The shape (class name, `status`, `headers`, `error`, message) is the
 * same, and it is what the provider classifiers and `classifyError` read.
 *
 * What it becomes depends on what throws it, because the real thing differs
 * the same way:
 *
 * - From `makeFakeGemini` / `makeFakeXai` or a fake store's SDK client, it is the
 *   raw SDK error, and the real adapter or store (which you are testing) runs
 *   `classifyGoogleError` / `classifyXaiError` on it.
 * - From a `FakeAdapter`, a `SignalAwareFakeAdapter` or a `FakeClient` entry, the
 *   fake stands in for the whole adapter, so it applies that same real
 *   classifier (from `@gullabs/google` / `@gullabs/xai`, optional peer
 *   dependencies of this package) before throwing: a per-day quota arrives as
 *   `rate_limited` / `daily_quota`, not retryable; exhausted xAI credits as
 *   `credits_exhausted`; a bad Gemini key as `invalid_auth`; and the error is an
 *   `LlmError`, as the real adapter's is.
 *
 * Which scenarios are live captures and which are doc-derived is on
 * {@link GoogleErrorScenario} and {@link XaiErrorScenario}.
 *
 * @example
 * ```ts
 * new FakeAdapter('google', [fakeProviderError('google', 'per-minute-quota'), okResult])
 * ```
 */
export function fakeProviderError(
  provider: 'google',
  scenario: GoogleErrorScenario,
): Error
export function fakeProviderError(
  provider: 'xai',
  scenario: XaiErrorScenario,
  opts?: FakeXaiProviderErrorOptions,
): Error
export function fakeProviderError(
  provider: 'google' | 'xai',
  scenario: GoogleErrorScenario | XaiErrorScenario,
  opts?: FakeXaiProviderErrorOptions,
): Error {
  if (provider === 'google') {
    if (opts !== undefined) {
      throw new TypeError(
        "fakeProviderError('google', ...) takes no options: the Gemini SDK's error carries no headers.",
      )
    }
    const found = (GOOGLE_ERROR_CASES as Record<string, GoogleBodyCase | undefined>)[
      scenario
    ]
    if (found === undefined) throw unknownScenario(provider, scenario, GOOGLE_ERROR_CASES)
    const { ApiError } = loadSdk<{
      ApiError: new (info: { message: string; status: number }) => Error
    }>('@google/genai', "fakeProviderError('google', ...)")
    return markProviderError(
      new ApiError({ message: JSON.stringify(found.body), status: found.status }),
      'google',
    )
  }
  if ((provider as string) === 'xai') {
    const found = (XAI_ERROR_CASES as Record<string, XaiBodyCase | undefined>)[scenario]
    if (found === undefined) throw unknownScenario(provider, scenario, XAI_ERROR_CASES)
    const { APIError } = loadSdk<{
      APIError: {
        generate(
          status: number,
          error: unknown,
          message: string | undefined,
          headers: Headers,
        ): Error
      }
    }>('openai', "fakeProviderError('xai', ...)")
    return markProviderError(
      APIError.generate(found.status, found.body, undefined, new Headers(opts?.headers)),
      'xai',
    )
  }
  throw new TypeError(
    `fakeProviderError: provider must be 'google' or 'xai', got ${String(provider)}.`,
  )
}

function unknownScenario(
  provider: string,
  scenario: string,
  known: Record<string, unknown>,
): TypeError {
  return new TypeError(
    `fakeProviderError('${provider}'): unknown scenario '${scenario}'. Known: ${Object.keys(known).join(', ')}.`,
  )
}
