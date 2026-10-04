/**
 * The error factories: shapes from real SDK classes and pinned bodies.
 *
 * The scenario bodies are copies of the provider packages' fixtures; the
 * fixture tests below fail if a copy drifts. The round trip through each
 * provider's classifier lives in the provider packages' own tests.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { constants as osConstants } from 'node:os'
import { createRequire } from 'node:module'
import type { ApiError } from '@google/genai'
import type { APIError } from 'openai'
import {
  LlmError,
  classifyError,
  createClient,
  createModelRegistry,
  retryMiddleware,
} from '@gullabs/core'
import type { AdapterResult } from '@gullabs/core'
import { FakeAdapter } from './fake-adapter.js'
import { fakeLlmResult } from './fake-llm-result.js'
import {
  GOOGLE_ERROR_CASES,
  XAI_ERROR_CASES,
  HttpStatusError,
  fakeBilledFailure,
  fakeHttpError,
  fakeNetworkError,
  fakeProviderError,
  fakeStreamFailure,
  type GoogleErrorScenario,
  type XaiErrorScenario,
} from './errors.js'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

// The factories load the SDKs' CommonJS builds (see errors.ts), so the classes to
// compare against are the CommonJS ones too.
const nodeRequire = createRequire(import.meta.url)
const { ApiError: ApiErrorClass } = nodeRequire('@google/genai') as {
  ApiError: abstract new (...args: never[]) => ApiError
}
const {
  APIError: APIErrorClass,
  RateLimitError,
  PermissionDeniedError,
} = nodeRequire('openai') as {
  APIError: abstract new (...args: never[]) => APIError
  RateLimitError: abstract new (...args: never[]) => APIError
  PermissionDeniedError: abstract new (...args: never[]) => APIError
}

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('fakeHttpError', () => {
  it('is an Error with the status and real Headers that classifyError reads', () => {
    const err = fakeHttpError(503)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HttpStatusError)
    expect(err.status).toBe(503)
    expect(err.headers).toBeInstanceOf(Headers)
    expect(classifyError(err)).toMatchObject({
      kind: 'server',
      retryable: true,
      httpStatus: 503,
    })
  })

  it('retryAfter becomes the Retry-After header and core turns it into retryAfterMs', () => {
    const classified = classifyError(fakeHttpError(429, { retryAfter: 7 }))
    expect(classified).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterMs: 7_000,
    })
    const date = new Date(Date.now() + 60_000).toUTCString()
    expect(
      classifyError(fakeHttpError(429, { retryAfter: date })).retryAfterMs,
    ).toBeGreaterThan(50_000)
  })

  it('takes extra headers, a body and a message', () => {
    const err = fakeHttpError(429, {
      headers: { 'x-ratelimit-reset-requests': '3' },
      body: { error: 'slow down' },
      message: 'custom',
    })
    expect(err.headers.get('x-ratelimit-reset-requests')).toBe('3')
    expect(err.error).toEqual({ error: 'slow down' })
    expect(err.message).toBe('custom')
    expect(classifyError(err).retryAfterMs).toBe(3_000)
  })

  it('classifies the usual statuses', () => {
    expect(classifyError(fakeHttpError(401))).toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
    expect(classifyError(fakeHttpError(400))).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
  })

  it('rejects a status that is not an HTTP status', () => {
    expect(() => fakeHttpError(99)).toThrow(TypeError)
    expect(() => fakeHttpError(600)).toThrow(TypeError)
    expect(() => fakeHttpError(4.5)).toThrow(TypeError)
  })
})

describe('fakeNetworkError', () => {
  it('is what Node fetch throws: TypeError fetch failed with the errno on the cause', () => {
    const err = fakeNetworkError()
    expect(err).toBeInstanceOf(TypeError)
    expect(err.message).toBe('fetch failed')
    expect(err.cause).toMatchObject({ code: 'ECONNRESET', syscall: 'read' })
  })

  it('core classifies it as a retryable server error, with no HTTP status', () => {
    expect(classifyError(fakeNetworkError())).toMatchObject({
      kind: 'server',
      retryable: true,
    })
    expect(classifyError(fakeNetworkError()).httpStatus).toBeUndefined()
  })

  it("an undici deadline code is a retryable 'timeout'", () => {
    for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']) {
      expect(classifyError(fakeNetworkError({ code }))).toMatchObject({
        kind: 'timeout',
        retryable: true,
      })
    }
  })

  it('names the syscall and the errno of the code, not one shape for all of them', () => {
    const refused = fakeNetworkError({ code: 'ECONNREFUSED' }).cause as {
      syscall?: string
      errno?: number
      message: string
    }
    expect(refused.syscall).toBe('connect')
    expect(refused.errno).toBe(-osConstants.errno.ECONNREFUSED)
    expect(refused.message).toBe('connect ECONNREFUSED')
    expect(fakeNetworkError({ code: 'ENOTFOUND' }).cause).toMatchObject({
      syscall: 'getaddrinfo',
    })
    // An undici deadline code has no errno or syscall.
    const undici = fakeNetworkError({ code: 'UND_ERR_BODY_TIMEOUT' }).cause as object
    expect(undici).not.toHaveProperty('errno')
    expect(undici).not.toHaveProperty('syscall')
  })

  it('other errnos are connection failures', () => {
    expect(classifyError(fakeNetworkError({ code: 'ECONNREFUSED' })).kind).toBe('server')
  })
})

describe('fakeBilledFailure', () => {
  it('is an LlmError that carries the usage the provider billed', () => {
    const err = fakeBilledFailure({ inputTokens: 120, outputTokens: 0 })
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(err.usage).toEqual({
      inputTokens: 120,
      outputTokens: 0,
      details: {},
      raw: null,
    })
  })

  it('options set the kind, retryability, provider and warnings; usage extras are kept', () => {
    const err = fakeBilledFailure(
      { inputTokens: 5, outputTokens: 1, cachedInputTokens: 2, details: { audio: 3 } },
      {
        kind: 'content_filter',
        message: 'blocked',
        provider: 'google',
        warnings: [{ type: 'other', message: 'cost omits grounding' }],
      },
    )
    expect(err).toMatchObject({
      kind: 'content_filter',
      retryable: false,
      message: 'blocked',
      provider: 'google',
    })
    expect(err.usage).toMatchObject({ cachedInputTokens: 2, details: { audio: 3 } })
    expect(err.warnings).toEqual([{ type: 'other', message: 'cost omits grounding' }])
  })

  it('the engine keeps the billed usage on the attempt’s ledger row', async () => {
    const adapter = new FakeAdapter(
      'google',
      fakeBilledFailure({ inputTokens: 120, outputTokens: 3 }, { retryable: false }),
    )
    const sink: import('@gullabs/core').LlmCallRecord[] = []
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
      sink: {
        record: (r) => {
          sink.push(r)
          return Promise.resolve()
        },
      },
    })
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'm',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'server' })
    expect(sink[0]).toMatchObject({
      status: 'api_error',
      inputTokens: 120,
      outputTokens: 3,
    })
  })
})

describe('fakeStreamFailure', () => {
  it('is an LlmError that may have billed, not retried, with no usage by default', () => {
    const err = fakeStreamFailure()
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({
      kind: 'server',
      retryable: false,
      mayHaveBilled: true,
      provider: 'xai',
    })
    expect(err.usage).toBeUndefined()
  })

  it('options set the kind, retryability, message, provider and usage', () => {
    const err = fakeStreamFailure({
      kind: 'rate_limited',
      message: 'cut',
      provider: 'other',
      usage: { inputTokens: 40, outputTokens: 7 },
    })
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      message: 'cut',
      provider: 'other',
      mayHaveBilled: true,
    })
    expect(err.usage).toEqual({
      inputTokens: 40,
      outputTokens: 7,
      details: {},
      raw: null,
    })
  })

  it('the engine books the attempt unpriced and does not retry, even for a rate_limited kind', async () => {
    const records: import('@gullabs/core').LlmCallRecord[] = []
    const adapter = new FakeAdapter('xai', [
      fakeStreamFailure({ kind: 'rate_limited' }),
      fakeLlmResult({ text: 'second' }),
    ])
    const client = createClient({
      adapters: [adapter],
      middleware: [retryMiddleware()],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'xai', model: 'm' }),
      ]),
      sink: {
        record: (r) => {
          records.push(r)
          return Promise.resolve()
        },
      },
    })
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'm',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'rate_limited', mayHaveBilled: true })
    expect(records).toHaveLength(1)
    expect(records[0]?.costMicroUsd ?? null).toBeNull()
  })
})

describe("fakeProviderError('google', ...)", () => {
  it('is the real @google/genai ApiError: the HTTP status and the JSON body as the message', () => {
    const err = fakeProviderError('google', 'per-minute-quota')
    expect(err).toBeInstanceOf(ApiErrorClass)
    expect(err.name).toBe('ApiError')
    expect((err as ApiError).status).toBe(429)
    expect(JSON.parse(err.message)).toEqual(GOOGLE_ERROR_CASES['per-minute-quota'].body)
  })

  it('core reads the status; the SDK error carries no headers', () => {
    expect(classifyError(fakeProviderError('google', 'capacity-503'))).toMatchObject({
      kind: 'server',
      retryable: true,
      httpStatus: 503,
    })
    expect(classifyError(fakeProviderError('google', 'bare-429'))).toMatchObject({
      kind: 'rate_limited',
      httpStatus: 429,
    })
  })

  it('every scenario builds an ApiError whose message is its body', () => {
    for (const scenario of Object.keys(GOOGLE_ERROR_CASES) as GoogleErrorScenario[]) {
      const err = fakeProviderError('google', scenario) as ApiError
      expect(err, scenario).toBeInstanceOf(ApiErrorClass)
      expect(err.status).toBe(GOOGLE_ERROR_CASES[scenario].status)
      expect(JSON.parse(err.message)).toEqual(GOOGLE_ERROR_CASES[scenario].body)
    }
  })

  it('the scenario bodies equal the google package’s pinned fixture', () => {
    const file = fixture(
      '../../google/src/__fixtures__/error-bodies-2026-10-03.json',
    ) as {
      captured: Record<string, { status: number; body: unknown }>
      docDerived: Record<string, { status: number; body: unknown }>
    }
    const names: Record<GoogleErrorScenario, [keyof typeof file, string]> = {
      'invalid-api-key': ['captured', 'invalidApiKey'],
      'empty-api-key': ['captured', 'emptyApiKey'],
      'stale-cached-content': ['captured', 'staleCachedContent'],
      'malformed-cache-name': ['captured', 'malformedCacheName'],
      'expired-api-key': ['docDerived', 'expiredApiKey'],
      'per-minute-quota': ['docDerived', 'perMinuteQuota'],
      'per-day-quota': ['docDerived', 'perDayQuota'],
      'capacity-503': ['docDerived', 'capacity503'],
      'retry-info-only': ['docDerived', 'retryInfoOnly'],
      'bare-429': ['docDerived', 'bare429'],
    }
    for (const [scenario, [group, key]] of Object.entries(names)) {
      const pinned = file[group][key]!
      const copy = GOOGLE_ERROR_CASES[scenario as GoogleErrorScenario]
      expect(copy, scenario).toEqual({ status: pinned.status, body: pinned.body })
    }
    expect(Object.keys(names).sort()).toEqual(Object.keys(GOOGLE_ERROR_CASES).sort())
  })

  it('refuses an unknown scenario and an unknown provider, listing what is known', () => {
    expect(() => fakeProviderError('google', 'nope' as GoogleErrorScenario)).toThrow(
      /unknown scenario 'nope'. Known: invalid-api-key/,
    )
    expect(() => fakeProviderError('openai' as 'google', 'bare-429')).toThrow(
      /provider must be 'google' or 'xai'/,
    )
  })
})

describe("fakeProviderError('xai', ...)", () => {
  it('is the real openai SDK status error built the way the SDK builds it from a response', () => {
    const err = fakeProviderError('xai', 'credits-exhausted-429')
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err).toBeInstanceOf(APIErrorClass)
    const api = err as APIError
    expect(api.status).toBe(429)
    expect(api.headers).toBeInstanceOf(Headers)
    // The SDK hoists the body's `error` field onto `.error`.
    expect(api.error).toBe(
      (XAI_ERROR_CASES['credits-exhausted-429'].body as { error: string }).error,
    )
    expect(err.message).toBe(`429 ${JSON.stringify(api.error)}`)
  })

  it('the 403 safety check is the SDK PermissionDeniedError', () => {
    const err = fakeProviderError('xai', 'safety-check')
    expect(err).toBeInstanceOf(PermissionDeniedError)
    expect((err as APIError).status).toBe(403)
    expect(classifyError(err)).toMatchObject({ kind: 'invalid_auth', httpStatus: 403 })
  })

  it('every scenario builds an openai APIError with its status', () => {
    for (const scenario of Object.keys(XAI_ERROR_CASES) as XaiErrorScenario[]) {
      const err = fakeProviderError('xai', scenario)
      expect(err, scenario).toBeInstanceOf(APIErrorClass)
      expect((err as APIError).status).toBe(XAI_ERROR_CASES[scenario].status)
    }
  })

  it('the scenario bodies equal the xai package’s pinned fixtures', () => {
    const taxonomy = fixture(
      '../../xai/src/__fixtures__/09-error-taxonomy.json',
    ) as Record<string, { status: number; body: unknown }>
    const safety = fixture('../../xai/src/__fixtures__/15-safety-check-403.json') as {
      safety_check_cyber: { status: number; error: string }
    }
    const docDerived = fixture(
      '../../xai/src/__fixtures__/doc-derived-error-shapes.json',
    ) as Record<string, { status: number; error: string }>

    expect(XAI_ERROR_CASES['nonexistent-model']).toEqual(taxonomy['nonexistent_model'])
    expect(XAI_ERROR_CASES['malformed-body']).toEqual(taxonomy['malformed_body'])
    expect(XAI_ERROR_CASES['invalid-api-key']).toEqual(taxonomy['invalid_api_key'])
    expect(XAI_ERROR_CASES['safety-check']).toEqual({
      status: safety.safety_check_cyber.status,
      body: { error: safety.safety_check_cyber.error },
    })
    for (const [scenario, key] of [
      ['credits-exhausted-429', 'creditsExhausted429'],
      ['credits-exhausted-403', 'creditsExhausted403'],
    ] as const) {
      expect(XAI_ERROR_CASES[scenario]).toEqual({
        status: docDerived[key]!.status,
        body: { error: docDerived[key]!.error },
      })
    }
  })

  it('refuses an unknown scenario', () => {
    expect(() => fakeProviderError('xai', 'nope' as XaiErrorScenario)).toThrow(
      /unknown scenario 'nope'/,
    )
  })
})

describe('the factories as FakeAdapter entries', () => {
  it('a FakeAdapter throws them as given and the engine classifies them', async () => {
    const ok: AdapterResult = {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm',
      warnings: [],
    }
    const adapter = new FakeAdapter('google', [
      fakeNetworkError(),
      fakeProviderError('google', 'per-day-quota'),
      ok,
    ])
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
    })
    const request = {
      provider: 'google',
      model: 'm',
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
      ],
    }
    const auth = { apiKey: 'k' }

    await expect(client.generate(request, { auth })).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
    })
    await expect(client.generate(request, { auth })).rejects.toMatchObject({
      kind: 'rate_limited',
      httpStatus: 429,
    })
    await expect(client.generate(request, { auth })).resolves.toMatchObject({
      model: 'm',
    })
  })
})
