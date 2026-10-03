/**
 * Unit tests for `requireApiKey` and the auth-rejection path of
 * `buildXaiClient`.
 *
 * `buildXaiClient`'s transport and timeout behaviour is tested against the real
 * `openai` SDK with a stubbed `fetch`, so nothing touches the network.
 * `requireApiKey` is called before the dynamic `import('openai')` inside
 * `buildXaiClient`, so the auth-rejection path can be tested without ever
 * touching the SDK.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import { classifyXaiError } from './adapter.js'
import { buildXaiClient, requireApiKey } from './client.js'
import type { XaiResponseCreateParams, XaiTransport } from './client.js'

describe('requireApiKey', () => {
  it('returns the key on valid ApiKeyAuth', () => {
    expect(requireApiKey({ apiKey: 'xai-secret' })).toBe('xai-secret')
  })

  it('rejects CliSessionAuth', () => {
    let thrown: unknown
    try {
      requireApiKey({ cliSession: true })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
    expect((thrown as LlmError).provider).toBe('xai')
    expect((thrown as LlmError).retryable).toBe(false)
  })

  it('rejects a missing apiKey', () => {
    let thrown: unknown
    try {
      requireApiKey({} as unknown as { apiKey: string })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
  })

  it('rejects an empty-string apiKey', () => {
    let thrown: unknown
    try {
      requireApiKey({ apiKey: '   ' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(LlmError)
    expect((thrown as LlmError).kind).toBe('invalid_auth')
  })
})

describe('buildXaiClient — auth rejection (no network / SDK import)', () => {
  it('rejects CliSessionAuth before importing the openai SDK', async () => {
    await expect(buildXaiClient({ cliSession: true })).rejects.toMatchObject({
      kind: 'invalid_auth',
      provider: 'xai',
    })
  })

  it('rejects a missing apiKey before importing the openai SDK', async () => {
    await expect(
      buildXaiClient({} as unknown as { apiKey: string }),
    ).rejects.toMatchObject({
      kind: 'invalid_auth',
      provider: 'xai',
    })
  })
})

// ---------------------------------------------------------------------------
// Real SDK + stubbed fetch: the SDK deadline and the transport deadline are
// two different timers and are tested separately (ADR-032).
// ---------------------------------------------------------------------------

const PARAMS: XaiResponseCreateParams = { model: 'grok-4.5', input: [], store: false }
const AUTH = { apiKey: 'xai-test' }
const OK_BODY = JSON.stringify({
  id: 'resp_1',
  model: 'grok-4.5',
  status: 'completed',
  output: [],
  usage: { input_tokens: 1, output_tokens: 1 },
})

function jsonResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function asTransport(
  stub: (input: unknown, init: Record<string, unknown>) => Promise<Response>,
  fetchOptions?: object,
): XaiTransport {
  return {
    fetch: stub as unknown as typeof fetch,
    ...(fetchOptions !== undefined
      ? { fetchOptions: fetchOptions as XaiTransport['fetchOptions'] & object }
      : {}),
  }
}

/** Rejects like undici does when the request signal aborts. */
function neverUntilAborted(
  _input: unknown,
  init: Record<string, unknown>,
): Promise<Response> {
  const signal = init['signal'] as AbortSignal
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError')),
    )
  })
}

describe('buildXaiClient — transport (real SDK, stubbed fetch)', () => {
  it('sends through the host fetch and passes fetchOptions to every call', async () => {
    const dispatcher = { sentinel: 'agent' }
    const seen: Array<{ url: string; init: Record<string, unknown> }> = []
    const client = await buildXaiClient(
      AUTH,
      asTransport(
        (url, init) => {
          seen.push({ url: String(url), init })
          return Promise.resolve(jsonResponse(OK_BODY))
        },
        { dispatcher },
      ),
    )
    await client.responses.create(PARAMS)
    await client.responses.create(PARAMS)
    expect(seen).toHaveLength(2)
    expect(seen.map((c) => c.url)).toEqual([
      'https://api.x.ai/v1/responses',
      'https://api.x.ai/v1/responses',
    ])
    expect(seen.every((c) => c.init['dispatcher'] === dispatcher)).toBe(true)
  })

  it('works without a transport argument (auth still validated first)', async () => {
    await expect(buildXaiClient({ cliSession: true })).rejects.toMatchObject({
      kind: 'invalid_auth',
    })
  })
})

describe('buildXaiClient — SDK deadline (real SDK, stubbed fetch)', () => {
  it('fires at the per-request timeout and is a non-retryable transport timeout', async () => {
    const client = await buildXaiClient(AUTH, asTransport(neverUntilAborted))
    const started = Date.now()
    const err: unknown = await client.responses.create(PARAMS, { timeout: 40 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    const elapsed = Date.now() - started

    expect((err as Error).constructor.name).toBe('APIConnectionTimeoutError')
    expect(elapsed).toBeGreaterThanOrEqual(30)
    expect(elapsed).toBeLessThan(5_000)

    const classified = classifyXaiError(err)
    expect(classified).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
    })
    expect(classified.message).toContain('SDK deadline')
  })

  it('does not fire when the response arrives inside the per-request timeout', async () => {
    const client = await buildXaiClient(
      AUTH,
      asTransport(
        () =>
          new Promise((resolve) => setTimeout(() => resolve(jsonResponse(OK_BODY)), 60)),
      ),
    )
    await expect(
      client.responses.create(PARAMS, { timeout: 5_000 }),
    ).resolves.toMatchObject({
      id: 'resp_1',
    })
  })

  it('a caller abort is an abort, not a timeout', async () => {
    const client = await buildXaiClient(AUTH, asTransport(neverUntilAborted))
    const controller = new AbortController()
    const pending = client.responses
      .create(PARAMS, { signal: controller.signal, timeout: 5_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    controller.abort()
    const classified = classifyXaiError(await pending)
    expect(classified.reason).toBeUndefined()
    expect(classified.kind).not.toBe('timeout')
  })
})

describe('buildXaiClient — transport deadline (real SDK, stubbed fetch)', () => {
  it('headers timer: undici HeadersTimeoutError is a non-retryable transport timeout', async () => {
    const headers = Object.assign(new Error('Headers Timeout Error'), {
      name: 'HeadersTimeoutError',
      code: 'UND_ERR_HEADERS_TIMEOUT',
    })
    const client = await buildXaiClient(
      AUTH,
      asTransport(() =>
        Promise.reject(new TypeError('fetch failed', { cause: headers })),
      ),
    )
    const err: unknown = await client.responses
      .create(PARAMS, { timeout: 3_600_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )

    // The SDK itself reports the undici header timer.
    expect((err as Error).message).toContain('waiting for response headers')

    const classified = classifyXaiError(err)
    expect(classified).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
    })
    expect(classified.message).toContain('transport headers timer')
  })

  it('body timer: undici BodyTimeoutError while reading is a non-retryable transport timeout', async () => {
    const bodyErr = Object.assign(new Error('Body Timeout Error'), {
      name: 'BodyTimeoutError',
      code: 'UND_ERR_BODY_TIMEOUT',
    })
    const client = await buildXaiClient(
      AUTH,
      asTransport(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(new TypeError('terminated', { cause: bodyErr }))
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    )
    const err: unknown = await client.responses
      .create(PARAMS, { timeout: 3_600_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    const classified = classifyXaiError(err)
    expect(classified).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
    expect(classified.message).toContain('transport body timer')
  })

  it('connect timer: a connect timeout stays retryable because nothing was sent', async () => {
    const connect = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    })
    const client = await buildXaiClient(
      AUTH,
      asTransport(() =>
        Promise.reject(new TypeError('fetch failed', { cause: connect })),
      ),
    )
    const err: unknown = await client.responses
      .create(PARAMS, { timeout: 3_600_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    const classified = classifyXaiError(err)
    expect(classified.kind).toBe('timeout')
    expect(classified.retryable).toBe(true)
    expect(classified.reason).toBeUndefined()
  })
})
