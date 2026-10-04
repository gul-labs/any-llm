/**
 * @gullabs/google — classifyGoogleError unit tests.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import { classifyGoogleError } from './errors.js'
import { isGeminiCapacityError } from './flex-fallback.js'

interface BodyFixture {
  status: number
  body: unknown
}
const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/error-bodies-2026-10-03.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  captured: Record<string, BodyFixture>
  docDerived: Record<string, BodyFixture>
}

/** An SDK `ApiError` as the SDK throws it: status plus the JSON body as the message. */
function apiError({ status, body }: BodyFixture): Error {
  return Object.assign(new Error(JSON.stringify(body)), { status, name: 'ApiError' })
}

describe('classifyGoogleError', () => {
  it('preserves kind/retryable of an already-classified LlmError, tagging provider: google', () => {
    const original = new LlmError('boom', { kind: 'timeout', retryable: true })
    const result = classifyGoogleError(original)
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('google')
  })

  it('still routes a real HTTP status through classifyHttpStatus (500 → server, retryable)', () => {
    const result = classifyGoogleError({ status: 500 })
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('google')
  })

  it('still routes 401 → invalid_auth, not retryable', () => {
    const result = classifyGoogleError({ status: 401 })
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
  })

  it('classifies a structured Gemini NOT_FOUND model-access response as bad_request', () => {
    const err = new Error(
      JSON.stringify({
        error: {
          code: 404,
          status: 'NOT_FOUND',
          message: 'This model is no longer available to new users.',
        },
      }),
    ) as Error & { status: number }
    err.status = 404
    const result = classifyGoogleError(err)
    expect(result).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      httpStatus: 404,
      provider: 'google',
    })
  })

  it('classifies undici "fetch failed" TypeError as retryable server, not unknown', () => {
    const result = classifyGoogleError(new TypeError('fetch failed'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('google')
  })

  it('detects a transport failure wrapped as .cause (undici fetch-failed shape)', () => {
    const causeErr = new Error('connect ECONNREFUSED 127.0.0.1:443') as Error & {
      code: string
    }
    causeErr.code = 'ECONNREFUSED'
    const fetchFailed = new TypeError('fetch failed') as TypeError & { cause?: unknown }
    fetchFailed.cause = causeErr
    const result = classifyGoogleError(fetchFailed)
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'])(
    'classifies a Node errno %s (on .code) as retryable server',
    (code) => {
      const err = new Error(`read ${code}`) as Error & { code: string }
      err.code = code
      const result = classifyGoogleError(err)
      expect(result.kind).toBe('server')
      expect(result.retryable).toBe(true)
    },
  )

  it('classifies "socket hang up" as retryable server', () => {
    const result = classifyGoogleError(new Error('socket hang up'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it('threads servedServiceTier through when provided', () => {
    const result = classifyGoogleError(new TypeError('fetch failed'), {
      servedServiceTier: 'standard',
    })
    expect(result.servedServiceTier).toBe('standard')
  })

  it('does not reclassify an unrelated unknown error as retryable', () => {
    const result = classifyGoogleError(new Error('something totally unrelated broke'))
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })
})

describe('classifyGoogleError: structured-body overlays', () => {
  it('a wrong API key (live capture: 400, ErrorInfo.reason API_KEY_INVALID) is invalid_auth', () => {
    const err = classifyGoogleError(apiError(fixtures.captured['invalidApiKey']!))
    expect(err).toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
      httpStatus: 400,
      provider: 'google',
    })
  })

  it('an expired API key (doc-derived reason API_KEY_EXPIRED) is invalid_auth', () => {
    const err = classifyGoogleError(apiError(fixtures.docDerived['expiredApiKey']!))
    expect(err).toMatchObject({ kind: 'invalid_auth', retryable: false, httpStatus: 400 })
  })

  it('an empty key (live capture: bare 403, no reason) keeps the core default invalid_auth', () => {
    const err = classifyGoogleError(apiError(fixtures.captured['emptyApiKey']!))
    expect(err).toMatchObject({ kind: 'invalid_auth', httpStatus: 403 })
    expect(err.reason).toBeUndefined()
  })

  it('a stale cachedContent (live capture: 403, no structured reason) is bad_request cache_not_found', () => {
    const err = classifyGoogleError(apiError(fixtures.captured['staleCachedContent']!))
    expect(err).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      reason: 'cache_not_found',
      httpStatus: 403,
      provider: 'google',
    })
  })

  it('a malformed cache name (live capture: 400) stays a plain bad_request', () => {
    const err = classifyGoogleError(apiError(fixtures.captured['malformedCacheName']!))
    expect(err).toMatchObject({ kind: 'bad_request', httpStatus: 400 })
    expect(err.reason).toBeUndefined()
  })

  it('other 403 bodies are not mistaken for a stale cache', () => {
    const err = classifyGoogleError(
      apiError({
        status: 403,
        body: {
          error: { code: 403, message: 'Permission denied', status: 'PERMISSION_DENIED' },
        },
      }),
    )
    expect(err).toMatchObject({ kind: 'invalid_auth' })
    expect(err.reason).toBeUndefined()
  })

  it('a per-minute 429 carries RetryInfo.retryDelay as retryAfterMs and stays retryable', () => {
    const err = classifyGoogleError(apiError(fixtures.docDerived['perMinuteQuota']!))
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 34_000,
      httpStatus: 429,
    })
    expect(err.reason).toBeUndefined()
  })

  it('reads a fractional retryDelay and rounds up', () => {
    const err = classifyGoogleError(
      apiError({
        status: 429,
        body: {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'x',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.RetryInfo',
                retryDelay: '1.5003s',
              },
            ],
          },
        },
      }),
    )
    expect(err.retryAfterMs).toBe(1501)
  })

  it('a per-day QuotaFailure is rate_limited, not retryable, reason daily_quota, no retry delay', () => {
    const err = classifyGoogleError(apiError(fixtures.docDerived['perDayQuota']!))
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'daily_quota',
      httpStatus: 429,
    })
    expect(err.retryAfterMs).toBeUndefined()
  })

  it('a 429 without a parseable body is the plain retryable rate limit', () => {
    const err = classifyGoogleError({ status: 429, message: 'PerDay is in this text' })
    expect(err).toMatchObject({ kind: 'rate_limited', retryable: true })
    expect(err.reason).toBeUndefined()
    expect(err.retryAfterMs).toBeUndefined()
  })

  it('flex capacity is HTTP 503 only: no 429 shape (quota, RetryInfo only, bare) is capacity', () => {
    const capacity = (name: string): boolean =>
      isGeminiCapacityError(classifyGoogleError(apiError(fixtures.docDerived[name]!)))
    expect(capacity('capacity503')).toBe(true)
    expect(capacity('perMinuteQuota')).toBe(false)
    expect(capacity('perDayQuota')).toBe(false)
    expect(capacity('retryInfoOnly')).toBe(false)
    expect(capacity('bare429')).toBe(false)
  })

  it('a 429 with RetryInfo and no QuotaFailure keeps the provider delay and stays retryable', () => {
    const err = classifyGoogleError(apiError(fixtures.docDerived['retryInfoOnly']!))
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 34_000,
    })
    expect(err.reason).toBeUndefined()
  })

  describe('retryDelay edge cases', () => {
    const delayOf = (retryDelay: unknown): number | undefined =>
      classifyGoogleError(
        apiError({
          status: 429,
          body: {
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              details: [
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
              ],
            },
          },
        }),
      ).retryAfterMs

    it('reads an object Duration { seconds, nanos } as the same delay', () => {
      expect(delayOf({ seconds: 34 })).toBe(34_000)
      expect(delayOf({ seconds: '34', nanos: 500_000_000 })).toBe(34_500)
      expect(delayOf({ nanos: 250_000_000 })).toBe(250)
    })

    it('reads the nanosecond-precision string the API emits', () => {
      expect(delayOf('0.847655010s')).toBe(848)
    })

    it('a zero delay is not a delay, so the default back-off applies', () => {
      expect(delayOf('0s')).toBeUndefined()
      expect(delayOf({ seconds: 0, nanos: 0 })).toBeUndefined()
    })

    it.each([['3'], ['1h'], ['6m0s'], ['-5s'], ['5 s'], [''], [34], [null]])(
      'ignores %j, which is not a protobuf Duration',
      (value) => {
        expect(delayOf(value)).toBeUndefined()
      },
    )

    it('ignores a malformed object Duration', () => {
      expect(delayOf({ seconds: -1 })).toBeUndefined()
      expect(delayOf({ seconds: 1.5 })).toBeUndefined()
      expect(delayOf({ seconds: 1, nanos: 1e9 })).toBeUndefined()
      expect(delayOf({ seconds: 'x' })).toBeUndefined()
    })

    it('caps a very long delay at the shared 24 hours', () => {
      expect(delayOf('864010s')).toBe(86_400_000)
    })
  })

  it('a transport failure is classified by core (no local matcher): fetch failed with an errno cause', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const err = classifyGoogleError(new TypeError('fetch failed', { cause }))
    expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'google' })
  })
})
