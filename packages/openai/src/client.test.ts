/**
 * `requireApiKey` and `buildOpenAiClient`'s isolated transport: the real
 * `openai/error` and `openai/streaming` classes over a stubbed `fetch`
 * (ADR-019, ADR-047). Frames are documentation-derived (`test-sse.ts`).
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi, beforeAll } from 'vitest'
import { LlmError } from '@gullabs/core'

import { buildOpenAiClient, requireApiKey } from './client.js'
import {
  messageItem,
  responseObject,
  sseResponse,
  streamEvents,
  stubFetch,
} from './test-sse.js'

// Load the real SDK once up front, so the first test's budget is not spent on a
// cold import when the machine is busy.
beforeAll(async () => {
  await Promise.all([import('openai/streaming'), import('openai/error')])
}, 60_000)

describe('requireApiKey', () => {
  it('returns the key', () => {
    expect(requireApiKey({ apiKey: 'sk-doc' })).toBe('sk-doc')
  })

  it.each([
    ['a CLI session', { cliSession: true }],
    ['a missing key', {}],
    ['a blank key', { apiKey: '  ' }],
  ])('rejects %s as invalid_auth', (_label, auth) => {
    let thrown: unknown
    try {
      requireApiKey(auth as never)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
    expect((thrown as LlmError).provider).toBe('openai')
  })

  it('buildOpenAiClient rejects before the SDK is imported', async () => {
    await expect(buildOpenAiClient({ cliSession: true })).rejects.toMatchObject({
      kind: 'invalid_auth',
    })
  })
})

const AMBIENT: Record<string, string> = {
  OPENAI_API_KEY: 'sk-ambient-must-not-be-sent',
  OPENAI_BASE_URL: 'https://ambient.invalid/v1',
  OPENAI_ORG_ID: 'org-ambient',
  OPENAI_PROJECT_ID: 'proj-ambient',
  OPENAI_ADMIN_KEY: 'sk-admin-ambient',
  OPENAI_WEBHOOK_SECRET: 'whsec-ambient',
  OPENAI_LOG: 'debug',
}

describe('the ambient environment cannot reach a call', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it.each([
    [
      'a well-formed',
      'Authorization: Bearer sk-ambient-header\nX-Ambient: 1\nOpenAI-Organization: org-header',
    ],
    ['a malformed', 'Bad Header: value'],
  ])(
    'with every OPENAI_* variable set and %s OPENAI_CUSTOM_HEADERS, the call succeeds with exactly the caller’s headers, and process is untouched',
    async (_label, customHeaders) => {
      for (const [name, value] of Object.entries(AMBIENT)) vi.stubEnv(name, value)
      vi.stubEnv('OPENAI_CUSTOM_HEADERS', customHeaders)
      const processDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')
      const realProcess = globalThis.process
      const realEnv = process.env
      const writes = [
        vi.spyOn(console, 'debug').mockImplementation(() => undefined),
        vi.spyOn(console, 'info').mockImplementation(() => undefined),
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
      ]
      const stub = stubFetch(() =>
        sseResponse(streamEvents(responseObject([messageItem('msg_1', 'ok')]))),
      )
      const client = await buildOpenAiClient({ apiKey: 'sk-caller' }, stub.fetch)
      const response = await client.responses.create({
        model: 'gpt-6.2-sol',
        input: [],
        store: false,
      })

      expect(response.status).toBe('completed')
      expect(stub.calls).toHaveLength(1)
      const call = stub.calls[0]!
      expect(call.url).toBe('https://api.openai.com/v1/responses')
      expect(call.method).toBe('POST')
      expect(Object.fromEntries(call.headers.entries())).toEqual({
        authorization: 'Bearer sk-caller',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      })
      expect(call.body).toEqual({
        model: 'gpt-6.2-sol',
        input: [],
        store: false,
        stream: true,
      })
      for (const spy of writes) expect(spy).not.toHaveBeenCalled()
      expect(Object.getOwnPropertyDescriptor(globalThis, 'process')).toEqual(
        processDescriptor,
      )
      expect(globalThis.process).toBe(realProcess)
      expect(process.env).toBe(realEnv)
      expect(process.env['OPENAI_CUSTOM_HEADERS']).toBe(customHeaders)
    },
  )

  it('the raw SDK client constructor throws on a malformed OPENAI_CUSTOM_HEADERS (why no client is constructed)', async () => {
    vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Bad Header: value')
    const { default: OpenAI } = await import('openai')
    expect(() => new OpenAI({ apiKey: 'sk-caller', maxRetries: 0 })).toThrow(
      /valid HTTP token/,
    )
  })

  it('client.ts imports only openai/streaming and openai/error, and constructs no SDK client', () => {
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')
    const imports = [
      ...source.matchAll(/import\(\s*'(openai[^']*)'\s*\)|from\s+'(openai[^']*)'/g),
    ].map((m) => m[1] ?? m[2])
    expect([...new Set(imports)].sort()).toEqual(['openai/error', 'openai/streaming'])
    expect(source).not.toMatch(/new\s+OpenAI\b/)
  })
})

describe('transport failures classify as the SDK request path did', () => {
  const create = async (fetchImpl: typeof fetch, signal?: AbortSignal) => {
    const client = await buildOpenAiClient({ apiKey: 'sk-caller' }, fetchImpl)
    return client.responses
      .create(
        { model: 'gpt-6.2-sol', input: [], store: false },
        signal !== undefined ? { signal } : {},
      )
      .catch((e: unknown) => e)
  }

  it('a non-JSON error body becomes the status error with the text as its message', async () => {
    const { RateLimitError } = await import('openai/error')
    const err = (await create(
      stubFetch(
        () =>
          new Response('upstream overloaded', {
            status: 429,
            headers: { 'retry-after': '2' },
          }),
      ).fetch,
    )) as InstanceType<typeof RateLimitError>
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.status).toBe(429)
    expect(err.message).toBe('429 upstream overloaded')
    expect(err.headers.get('retry-after')).toBe('2')
  })

  it('a JSON error body is unwrapped to its error object, as makeStatusError does', async () => {
    const { AuthenticationError } = await import('openai/error')
    const err = (await create(
      stubFetch(
        () =>
          new Response(
            JSON.stringify({
              error: {
                message: 'bad key',
                type: 'invalid_request_error',
                code: 'invalid_api_key',
              },
            }),
            {
              status: 401,
              headers: { 'x-request-id': 'req_1' },
            },
          ),
      ).fetch,
    )) as InstanceType<typeof AuthenticationError>
    expect(err).toBeInstanceOf(AuthenticationError)
    expect(err.code).toBe('invalid_api_key')
    expect(err.requestID).toBe('req_1')
  })

  it('a fetch rejection becomes APIConnectionError, and a timed-out one APIConnectionTimeoutError', async () => {
    const { APIConnectionError, APIConnectionTimeoutError } = await import('openai/error')
    const reset = await create((() =>
      Promise.reject(new TypeError('fetch failed'))) as typeof fetch)
    expect(reset).toBeInstanceOf(APIConnectionError)
    expect(reset).not.toBeInstanceOf(APIConnectionTimeoutError)
    expect((reset as Error).cause).toBeInstanceOf(TypeError)
    const timedOut = await create((() =>
      Promise.reject(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('Connect Timeout Error'),
        }),
      )) as typeof fetch)
    expect(timedOut).toBeInstanceOf(APIConnectionTimeoutError)
  })

  it('a caller abort before headers is the abort, not a connection error', async () => {
    const controller = new AbortController()
    const err = await create(
      ((_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
          controller.abort(new Error('caller reason'))
        })) as typeof fetch,
      controller.signal,
    )
    expect((err as Error).name).toBe('AbortError')
    expect(((err as Error).cause as Error).message).toBe('caller reason')
  })

  it('the deadline covers the wait for headers', async () => {
    const err = await (async () => {
      const client = await buildOpenAiClient(
        { apiKey: 'sk-caller' },
        ((_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          })) as typeof fetch,
      )
      return client.responses
        .create({ model: 'gpt-6.2-sol', input: [], store: false }, { timeout: 20 })
        .catch((e: unknown) => e)
    })()
    expect((err as { failure?: { kind: string } }).failure?.kind).toBe('deadline')
  })
})
