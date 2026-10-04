/**
 * `fakeProviderError('google', scenario)` from `@gullabs/testing` through this
 * package's own classifier: the factory's errors are the SDK shapes the adapter
 * sees, so a host test using them exercises the real classification.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient, type LlmError } from '@gullabs/core'
import {
  FakeAdapter,
  FakeClock,
  fakeNetworkError,
  fakeProviderError,
  makeFakeGemini,
  type GoogleErrorScenario,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { classifyGoogleError } from './errors.js'
import { defaultGeminiRegistry } from './models.js'

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

  it('fakeNetworkError is a retryable server error, as the adapter treats a transport failure', () => {
    expect(classifyGoogleError(fakeNetworkError())).toMatchObject({
      kind: 'server',
      retryable: true,
    })
  })
})

describe('a FakeAdapter and the real adapter end a provider scenario the same way', () => {
  const AUTH = { apiKey: 'test-key' }
  const request = {
    provider: 'google',
    model: 'gemini-3.6-flash',
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
  const scenarios: GoogleErrorScenario[] = [
    'invalid-api-key',
    'empty-api-key',
    'stale-cached-content',
    'malformed-cache-name',
    'expired-api-key',
    'per-minute-quota',
    'per-day-quota',
    'capacity-503',
    'retry-info-only',
    'bare-429',
  ]

  async function failureOf(adapter: Parameters<typeof createClient>[0]['adapters']) {
    const clock = new FakeClock()
    const client = createClient({
      adapters: adapter,
      modelRegistry: defaultGeminiRegistry,
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
        geminiAdapter({
          client: makeFakeGemini(() => {
            throw fakeProviderError('google', scenario)
          }),
        }),
      ])
      const fake = await failureOf([
        new FakeAdapter('google', [fakeProviderError('google', scenario)]),
      ])
      for (const field of FIELDS) {
        expect(fake[field], `${scenario}.${field}`).toEqual(real[field])
      }
    },
  )
})
