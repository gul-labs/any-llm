/**
 * `fakeProviderError('xai', scenario)` from `@gullabs/testing` through this
 * package's own classifier: the factory's errors are the `openai` SDK shapes the
 * adapter sees.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient, type LlmError } from '@gullabs/core'
import {
  FakeAdapter,
  FakeClock,
  fakeHttpError,
  fakeNetworkError,
  fakeProviderError,
  makeFakeXai,
  type XaiErrorScenario,
} from '@gullabs/testing'
import { classifyXaiError, xaiAdapter } from './adapter.js'
import { xaiRegistry } from './models.js'

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

describe('a FakeAdapter and the real adapter end a provider scenario the same way', () => {
  const AUTH = { apiKey: 'test-key' }
  const request = {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] }],
  }
  const FIELDS = [
    'kind',
    'retryable',
    'reason',
    'httpStatus',
    'retryAfterMs',
    'provider',
    'message',
  ] as const
  const scenarios: XaiErrorScenario[] = [
    'nonexistent-model',
    'malformed-body',
    'invalid-api-key',
    'safety-check',
    'credits-exhausted-429',
    'credits-exhausted-403',
  ]

  async function failureOf(adapter: Parameters<typeof createClient>[0]['adapters']) {
    const clock = new FakeClock()
    const client = createClient({
      adapters: adapter,
      modelRegistry: xaiRegistry,
      clock,
      scheduler: clock,
    })
    return (await client
      .generate(request, { auth: AUTH })
      .catch((e: unknown) => e)) as LlmError
  }

  it.each(scenarios)(
    '%s: through the real adapter (SDK-level fake) equals through FakeAdapter',
    async (scenario) => {
      const real = await failureOf([
        xaiAdapter({
          client: makeFakeXai(() => {
            throw fakeProviderError('xai', scenario)
          }),
        }),
      ])
      const fake = await failureOf([
        new FakeAdapter('xai', [fakeProviderError('xai', scenario)]),
      ])
      for (const field of FIELDS) {
        expect(fake[field], `${scenario}.${field}`).toEqual(real[field])
      }
    },
  )

  it('response headers on the error reach the classifier (a 429 with Retry-After)', async () => {
    const withHeaders = () =>
      fakeProviderError('xai', 'credits-exhausted-429', {
        headers: { 'retry-after': '7', 'x-request-id': 'req_1' },
      })
    expect(
      (withHeaders() as unknown as { headers: Headers }).headers.get('retry-after'),
    ).toBe('7')
    const err = await failureOf([new FakeAdapter('xai', [withHeaders()])])
    expect(err).toMatchObject({ kind: 'rate_limited' })
  })
})
