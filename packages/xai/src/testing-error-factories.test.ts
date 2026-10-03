/**
 * `fakeProviderError('xai', scenario)` from `@gullabs/testing` through this
 * package's own classifier: the factory's errors are the `openai` SDK shapes the
 * adapter sees.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { fakeHttpError, fakeNetworkError, fakeProviderError } from '@gullabs/testing'
import { classifyXaiError } from './adapter.js'

describe('fakeProviderError("xai", ...) classifies as the adapter classifies it', () => {
  it('a rejected API key is invalid_auth despite the HTTP 400', () => {
    expect(classifyXaiError(fakeProviderError('xai', 'invalid-api-key'))).toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
      provider: 'xai',
    })
  })

  it('a safety-check refusal is content_filter, with the body text as the message', () => {
    const err = classifyXaiError(fakeProviderError('xai', 'safety-check'))
    expect(err).toMatchObject({ kind: 'content_filter', retryable: false })
    expect(err.message).toBe(
      'Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER',
    )
  })

  it('exhausted credits are a non-retryable rate_limited, on a 429 or a 403, without the team id', () => {
    for (const scenario of ['credits-exhausted-429', 'credits-exhausted-403'] as const) {
      const err = classifyXaiError(fakeProviderError('xai', scenario))
      expect(err, scenario).toMatchObject({
        kind: 'rate_limited',
        retryable: false,
        reason: 'credits_exhausted',
      })
      expect(err.message).not.toContain('00000000-0000-0000-0000-000000000000')
    }
  })

  it('a missing model and a malformed body are bad_request', () => {
    for (const scenario of ['nonexistent-model', 'malformed-body'] as const) {
      expect(classifyXaiError(fakeProviderError('xai', scenario))).toMatchObject({
        kind: 'bad_request',
        retryable: false,
      })
    }
  })

  it('fakeHttpError carries Retry-After as the SDK’s status errors do', () => {
    expect(classifyXaiError(fakeHttpError(429, { retryAfter: 4 }))).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 4_000,
    })
  })

  it('fakeNetworkError is a retryable server error', () => {
    expect(classifyXaiError(fakeNetworkError())).toMatchObject({
      kind: 'server',
      retryable: true,
    })
  })
})
