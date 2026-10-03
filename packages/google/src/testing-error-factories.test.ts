/**
 * `fakeProviderError('google', scenario)` from `@gullabs/testing` through this
 * package's own classifier: the factory's errors are the SDK shapes the adapter
 * sees, so a host test using them exercises the real classification.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { fakeNetworkError, fakeProviderError } from '@gullabs/testing'
import { classifyGoogleError, parseGoogleErrorBody } from './errors.js'

describe('fakeProviderError("google", ...) classifies as the adapter classifies it', () => {
  it('an invalid or expired API key is invalid_auth, despite the HTTP 400', () => {
    for (const scenario of ['invalid-api-key', 'expired-api-key'] as const) {
      expect(classifyGoogleError(fakeProviderError('google', scenario))).toMatchObject({
        kind: 'invalid_auth',
        retryable: false,
        provider: 'google',
      })
    }
  })

  it('a per-minute quota is retryable with the body’s retry delay', () => {
    expect(
      classifyGoogleError(fakeProviderError('google', 'per-minute-quota')),
    ).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 34_000 })
    expect(
      classifyGoogleError(fakeProviderError('google', 'retry-info-only')),
    ).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterMs: 34_000 })
  })

  it('a per-day quota is not retryable and says so', () => {
    const err = classifyGoogleError(fakeProviderError('google', 'per-day-quota'))
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      reason: 'daily_quota',
    })
    expect(err.retryAfterMs).toBeUndefined()
  })

  it('a bare 429 is the ordinary rate limit; a 503 is a retryable server error', () => {
    expect(classifyGoogleError(fakeProviderError('google', 'bare-429'))).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    })
    expect(
      classifyGoogleError(fakeProviderError('google', 'capacity-503')),
    ).toMatchObject({ kind: 'server', retryable: true, httpStatus: 503 })
  })

  it('a stale cachedContent reference is bad_request with reason cache_not_found', () => {
    expect(
      classifyGoogleError(fakeProviderError('google', 'stale-cached-content')),
    ).toMatchObject({ kind: 'bad_request', reason: 'cache_not_found' })
  })

  it('the SDK error’s message is the structured body this package parses', () => {
    const body = parseGoogleErrorBody(fakeProviderError('google', 'per-minute-quota'))
    expect(body?.status).toBe('RESOURCE_EXHAUSTED')
    expect(body?.details).toHaveLength(2)
  })

  it('fakeNetworkError is a retryable server error, as the adapter treats a transport failure', () => {
    expect(classifyGoogleError(fakeNetworkError())).toMatchObject({
      kind: 'server',
      retryable: true,
    })
  })
})
