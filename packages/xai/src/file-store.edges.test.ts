/**
 * XaiFileStore and `countTokens` edges: the response headers survive into the
 * error, a call has a deadline, a file id is one URL path segment, a 2xx body
 * that is not JSON is a typed error.
 *
 * All tests inject a fake `fetch` — no network.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { AdapterCtx } from '@gullabs/core'
import { xaiAdapter, xaiAdapterWithSeams } from './adapter.js'
import { XaiFileStore, XAI_FILES_DEFAULT_TIMEOUT_MS } from './file-store.js'

const auth = { apiKey: 'test-xai-key' }
const CTX: AdapterCtx = {
  auth,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function fetchOf(handler: Handler): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      urls.push(url)
      return Promise.resolve(handler(url, init ?? {}))
    }) as unknown as typeof fetch,
  }
}

/** A fetch that never answers but rejects when its signal aborts. */
const hung: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason as Error)
    })
  })

const rateLimited = (): Response =>
  new Response(JSON.stringify({ error: 'slow down' }), {
    status: 429,
    headers: { 'retry-after': '7', 'x-request-id': 'req_42' },
  })

const countReq = {
  provider: 'xai',
  model: 'grok-4.5',
  messages: [
    { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'Hello' }] },
  ],
}

describe('countTokens keeps the response headers and has a deadline', () => {
  it('a 429 carries Retry-After as retryAfterMs and the request id in the message', async () => {
    const adapter = xaiAdapterWithSeams(undefined, { fetch: fetchOf(rateLimited).fetch })
    const err = await adapter.countTokens!(countReq, CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 7_000,
      httpStatus: 429,
    })
    expect((err as LlmError).message).toContain('req_42')
  })

  it('a hung call ends at countTokensTimeoutMs as a retryable timeout', async () => {
    const adapter = xaiAdapterWithSeams(
      { countTokensTimeoutMs: 40 },
      { fetch: fetchOf(hung).fetch },
    )
    const started = Date.now()
    const err = await adapter.countTokens!(countReq, CTX).catch((e: unknown) => e)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(err).toMatchObject({ kind: 'timeout', retryable: true, provider: 'xai' })
    expect((err as LlmError).message).toContain('40ms')
  })

  it('a caller abort is still aborted, not a timeout', async () => {
    const adapter = xaiAdapterWithSeams(undefined, { fetch: fetchOf(hung).fetch })
    const controller = new AbortController()
    const pending = adapter.countTokens!(countReq, { ...CTX, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    const err = await pending.catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'aborted' })
  })

  it('a 200 whose body is not JSON is a typed server error', async () => {
    const adapter = xaiAdapterWithSeams(undefined, {
      fetch: fetchOf(() => new Response('<html>gateway</html>', { status: 200 })).fetch,
    })
    const err = await adapter.countTokens!(countReq, CTX).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'server' })
  })

  it('rejects a countTokensTimeoutMs that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => xaiAdapter({ countTokensTimeoutMs: bad })).toThrow(
        /countTokensTimeoutMs/,
      )
    }
  })
})

describe('XaiFileStore headers, deadline and ids', () => {
  it('a 429 carries Retry-After as retryAfterMs and the request id in the message', async () => {
    const store = new XaiFileStore({ auth, fetch: fetchOf(rateLimited).fetch })
    const err = await store.get('file_a').catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 7_000 })
    expect((err as LlmError).message).toContain('req_42')
    const upload = await store
      .upload({ data: new Uint8Array(1), filename: 'a.txt' })
      .catch((e: unknown) => e)
    expect(upload).toMatchObject({ retryAfterMs: 7_000 })
  })

  it('a failed-closed delete keeps the headers too', async () => {
    const store = new XaiFileStore({ auth, fetch: fetchOf(rateLimited).fetch })
    const err = await store
      .delete('file_a', { failClosed: true })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ retryAfterMs: 7_000 })
  })

  it('every call ends at the store timeout as a retryable timeout; the default is 60 s', async () => {
    expect(XAI_FILES_DEFAULT_TIMEOUT_MS).toBe(60_000)
    const store = new XaiFileStore({ auth, fetch: fetchOf(hung).fetch, timeoutMs: 30 })
    for (const call of [
      () => store.get('f'),
      () => store.list(),
      () => store.getContent('f'),
      () => store.upload({ data: new Uint8Array(1), filename: 'a.txt' }),
      () => store.delete('f', { failClosed: true }),
    ]) {
      const err = await call().catch((e: unknown) => e)
      expect(err).toMatchObject({ kind: 'timeout', retryable: true, provider: 'xai' })
    }
  })

  it('a deadline that ends the read of a non-2xx body is the timeout, not the HTTP status', async () => {
    // Headers arrive with a 500; the body never finishes and errors when aborted.
    const stalledBody: Handler = (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener('abort', () => {
              controller.error(init.signal?.reason)
            })
          },
        }),
        { status: 500 },
      )
    const store = new XaiFileStore({
      auth,
      fetch: fetchOf(stalledBody).fetch,
      timeoutMs: 30,
    })
    for (const call of [
      () => store.get('f'),
      () => store.list(),
      () => store.getContent('f'),
      () => store.upload({ data: new Uint8Array(1), filename: 'a.txt' }),
      () => store.delete('f', { failClosed: true }),
    ]) {
      const err = await call().catch((e: unknown) => e)
      expect(err).toMatchObject({ kind: 'timeout', retryable: true, provider: 'xai' })
      expect((err as LlmError).httpStatus).toBeUndefined()
    }

    // A caller abort during the same read is `aborted`.
    const patient = new XaiFileStore({ auth, fetch: fetchOf(stalledBody).fetch })
    const controller = new AbortController()
    const pending = patient.get('f', controller.signal)
    setTimeout(() => controller.abort(), 20)
    expect(await pending.catch((e: unknown) => e)).toMatchObject({ kind: 'aborted' })
  })

  it('a fail-open delete that times out reports it to onDeleteError', async () => {
    const seen: unknown[] = []
    const store = new XaiFileStore({
      auth,
      fetch: fetchOf(hung).fetch,
      timeoutMs: 30,
      onDeleteError: (_id, e) => seen.push(e),
    })
    await store.delete('f')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'timeout' })
  })

  it('a caller abort is still aborted, not a timeout', async () => {
    const store = new XaiFileStore({ auth, fetch: fetchOf(hung).fetch })
    const controller = new AbortController()
    const pending = store.get('f', controller.signal)
    setTimeout(() => controller.abort(), 20)
    expect(await pending.catch((e: unknown) => e)).toMatchObject({ kind: 'aborted' })
  })

  it('rejects a timeoutMs that is not a positive integer', () => {
    for (const bad of [0, 1.5, -5]) {
      expect(() => new XaiFileStore({ auth, timeoutMs: bad })).toThrow(/timeoutMs/)
    }
  })

  it('an id is one path segment: / ? # are encoded and . / .. are refused', async () => {
    const { fetch, urls } = fetchOf(() => new Response('{"id":"x"}', { status: 200 }))
    const store = new XaiFileStore({ auth, fetch, baseUrl: 'https://files.test/v1' })
    await store.get('a/b?c#d')
    await store.getContent('a/../b')
    await store.delete('x y')
    expect(urls).toEqual([
      'https://files.test/v1/files/a%2Fb%3Fc%23d',
      'https://files.test/v1/files/a%2F..%2Fb/content',
      'https://files.test/v1/files/x%20y',
    ])
    for (const id of ['..', '.']) {
      await expect(store.get(id)).rejects.toMatchObject({ kind: 'bad_request' })
      await expect(store.getContent(id)).rejects.toMatchObject({ kind: 'bad_request' })
      await expect(store.delete(id)).rejects.toMatchObject({ kind: 'bad_request' })
    }
    expect(urls).toHaveLength(3)
  })

  it('a 2xx body that is not JSON is a typed server error for get and list', async () => {
    const store = new XaiFileStore({
      auth,
      fetch: fetchOf(() => new Response('<html>', { status: 200 })).fetch,
    })
    for (const call of [() => store.get('f'), () => store.list()]) {
      const err = await call().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmError)
      expect(err).toMatchObject({ kind: 'server', retryable: false })
    }
  })
})
