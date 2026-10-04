/**
 * @gullabs/google — file and cache store edges: idempotent delete for a gone
 * resource, cache handles that record their tool kinds, cache TTL and expiry
 * parsing, and upload abort handling.
 *
 * The 403 `CachedContent not found` shape is a live capture; the Files API 403
 * "may not exist" shape is quoted from public reports and is not captured
 * (`reported` in `error-bodies-2026-10-03.json`, ADR-013). No network.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@gullabs/core'
import { GoogleCacheStore } from './cache-store.js'
import type { GeminiCachesClientLike } from './cache-store.js'
import { GoogleFileStore } from './file-store.js'
import type { GeminiFilesClientLike, GoogleFileHandle } from './file-store.js'
import { classifyGoogleError, isGoogleNotFoundError } from './errors.js'

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
  reported: Record<string, BodyFixture>
}

/** An SDK `ApiError` as the SDK throws it: status plus the JSON body as the message. */
function apiError({ status, body }: BodyFixture): Error {
  return Object.assign(new Error(JSON.stringify(body)), { status, name: 'ApiError' })
}

const auth = { apiKey: 'test-key' }
const NOW = 1_700_000_000_000
const fileHandle: GoogleFileHandle = {
  name: 'files/abc123',
  uri: 'https://example.com/files/abc123',
  mimeType: 'image/png',
}

describe('isGoogleNotFoundError', () => {
  it('an error with no status at all is matched by its message', () => {
    expect(isGoogleNotFoundError(new Error('The file was not found'))).toBe(true)
    expect(isGoogleNotFoundError(new Error('CachedContent not found'))).toBe(true)
    expect(isGoogleNotFoundError(new Error('connection reset'))).toBe(false)
  })

  it.each([
    ['a 404', { status: 404, message: 'x' }],
    ['NOT_FOUND', { status: 'NOT_FOUND' }],
    ['the Files API 403 "may not exist" shape (reported, not captured)', 'staleFile'],
    ['the cache 403 "CachedContent not found" shape (captured)', 'staleCachedContent'],
  ])('%s is not-found', (_name, value) => {
    const err =
      typeof value === 'string'
        ? apiError((fixtures.reported[value] ?? fixtures.captured[value])!)
        : value
    expect(isGoogleNotFoundError(err)).toBe(true)
  })

  it('an LlmError classified from the 403 shape still reads as not-found', () => {
    const classified = classifyGoogleError(apiError(fixtures.reported['staleFile']!))
    expect(isGoogleNotFoundError(classified)).toBe(true)
  })

  it.each([
    [
      'a 403 with another message',
      apiError({
        status: 403,
        body: { error: { code: 403, message: 'Permission denied', status: 'X' } },
      }),
    ],
    ['the empty-key 403', apiError(fixtures.captured['emptyApiKey']!)],
    ['a 500', { status: 500, message: 'not found upstream' }],
    [
      'a 500 whose message says "file not found"',
      { status: 500, message: 'file not found' },
    ],
    [
      'an HTTP 500 ApiError whose body says "file not found"',
      apiError({
        status: 500,
        body: { error: { code: 500, message: 'File not found', status: 'INTERNAL' } },
      }),
    ],
    [
      'a 503 whose message says "CachedContent not found"',
      { httpStatus: 503, message: 'CachedContent not found' },
    ],
    [
      'a gRPC status other than NOT_FOUND',
      { status: 'INTERNAL', message: 'file not found' },
    ],
    ['a string', 'files/gone'],
  ])('%s is not not-found', (_name, err) => {
    expect(isGoogleNotFoundError(err)).toBe(false)
  })

  // Every place core's status extraction reads is a KNOWN status: the message
  // alone never makes a failed delete "already gone".
  describe('a known HTTP status is never overruled by the message', () => {
    const message = 'file not found'
    const known500: [string, unknown][] = [
      ['statusCode 500', { statusCode: 500, message }],
      ["statusCode '500'", { statusCode: '500', message }],
      ["status '500'", { status: '500', message }],
      ["code '500'", { code: '500', message }],
      ['code 500', { code: 500, message }],
      ['httpStatus 500', { httpStatus: 500, message }],
      ["httpStatus '500'", { httpStatus: '500', message }],
      ['a nested cause with status 500', new Error(message, { cause: { status: 500 } })],
      [
        'a nested cause with statusCode 500',
        new Error(message, { cause: { statusCode: 500 } }),
      ],
      [
        'a cause two levels down',
        new Error(message, { cause: new Error('x', { cause: { status: '500' } }) }),
      ],
      ['response.status 500', { message, response: { status: 500 } }],
      ['response.statusCode 500', { message, response: { statusCode: 500 } }],
      ["response.status '500'", { message, response: { status: '500' } }],
      ['error.code 500', { message, error: { code: 500 } }],
      ['error.statusCode 500', { message, error: { statusCode: 500 } }],
      [
        'an LlmError classified from a statusCode 500',
        classifyGoogleError({ statusCode: 500, message }),
      ],
    ]
    it.each(known500)('%s is not not-found', (_name, err) => {
      expect(isGoogleNotFoundError(err)).toBe(false)
    })

    it.each([
      ['statusCode 404', { statusCode: 404, message: 'x' }],
      ["statusCode '404'", { statusCode: '404', message: 'x' }],
      ["code '404'", { code: '404', message: 'x' }],
      ["httpStatus '404'", { httpStatus: '404', message: 'x' }],
      ['a nested cause with status 404', new Error('x', { cause: { status: 404 } })],
      ['response.statusCode 404', { message: 'x', response: { statusCode: 404 } }],
      [
        'statusCode 403 whose message says "may not exist"',
        { statusCode: 403, message: 'it may not exist' },
      ],
    ])('%s is not-found', (_name, err) => {
      expect(isGoogleNotFoundError(err)).toBe(true)
    })

    it('statusCode 403 with an unrelated message is not not-found', () => {
      expect(
        isGoogleNotFoundError({ statusCode: 403, message: 'Permission denied' }),
      ).toBe(false)
    })

    describe('a delete that fails with such a status', () => {
      it.each(known500)(
        'GoogleFileStore, %s: failClosed throws and the callback fires',
        async (_name, failure) => {
          const client: GeminiFilesClientLike = {
            upload: vi.fn(),
            get: vi.fn(),
            delete: vi.fn().mockRejectedValue(failure),
          }
          const closed = new GoogleFileStore({ auth, client })
          await expect(
            closed.delete(fileHandle, { failClosed: true }),
          ).rejects.toBeInstanceOf(LlmError)
          const onDeleteError = vi.fn()
          const open = new GoogleFileStore({ auth, client, onDeleteError })
          await open.delete(fileHandle)
          expect(onDeleteError).toHaveBeenCalledTimes(1)
        },
      )

      it.each(known500)(
        'GoogleCacheStore, %s: the callback fires',
        async (_name, failure) => {
          const client: GeminiCachesClientLike = {
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn().mockRejectedValue(failure),
          }
          const onDeleteError = vi.fn()
          const store = new GoogleCacheStore({ auth, client, onDeleteError })
          await store.delete({
            cacheName: 'cachedContents/gone',
            model: 'gemini-2.5-flash',
            expiresAt: new Date(NOW),
          })
          expect(onDeleteError).toHaveBeenCalledTimes(1)
        },
      )
    })
  })
})

describe('GoogleFileStore.delete of a file Google no longer has', () => {
  const gone = (): Error => apiError(fixtures.reported['staleFile']!)

  it('failClosed: the Files API 403 "may not exist" is success, not a throw', async () => {
    const onDeleteError = vi.fn()
    const client: GeminiFilesClientLike = {
      upload: vi.fn(),
      get: vi.fn(),
      delete: vi.fn().mockRejectedValue(gone()),
    }
    const store = new GoogleFileStore({ auth, client, onDeleteError })
    await expect(store.delete(fileHandle, { failClosed: true })).resolves.toBeUndefined()
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('fail-open: it does not reach onDeleteError either', async () => {
    const onDeleteError = vi.fn()
    const client: GeminiFilesClientLike = {
      upload: vi.fn(),
      get: vi.fn(),
      delete: vi.fn().mockRejectedValue(gone()),
    }
    const store = new GoogleFileStore({ auth, client, onDeleteError })
    await store.delete(fileHandle)
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('a 500 whose message says "file not found" is a failed delete: failClosed throws, the callback fires', async () => {
    const failure = apiError({
      status: 500,
      body: { error: { code: 500, message: 'File not found', status: 'INTERNAL' } },
    })
    const client: GeminiFilesClientLike = {
      upload: vi.fn(),
      get: vi.fn(),
      delete: vi.fn().mockRejectedValue(failure),
    }
    const closed = new GoogleFileStore({ auth, client })
    await expect(closed.delete(fileHandle, { failClosed: true })).rejects.toBeInstanceOf(
      LlmError,
    )
    const onDeleteError = vi.fn()
    const open = new GoogleFileStore({ auth, client, onDeleteError })
    await open.delete(fileHandle)
    expect(onDeleteError).toHaveBeenCalledTimes(1)
  })

  it('a 403 with an unrelated message is still a failure', async () => {
    const client: GeminiFilesClientLike = {
      upload: vi.fn(),
      get: vi.fn(),
      delete: vi.fn().mockRejectedValue(apiError(fixtures.captured['emptyApiKey']!)),
    }
    const store = new GoogleFileStore({ auth, client })
    await expect(store.delete(fileHandle, { failClosed: true })).rejects.toBeInstanceOf(
      LlmError,
    )
  })
})

describe('GoogleCacheStore.delete of a cache Google no longer has', () => {
  const cacheClient = (rejection: unknown): GeminiCachesClientLike => ({
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn().mockRejectedValue(rejection),
  })
  const handle = {
    cacheName: 'cachedContents/gone',
    model: 'gemini-2.5-flash',
    expiresAt: new Date(NOW),
  }

  it.each([
    [
      'the captured 403 CachedContent not found',
      apiError(fixtures.captured['staleCachedContent']!),
    ],
    ['a 404', { status: 404, message: 'cachedContents/gone not found' }],
  ])('%s is success and is not reported', async (_name, rejection) => {
    const onDeleteError = vi.fn()
    const store = new GoogleCacheStore({
      auth,
      client: cacheClient(rejection),
      onDeleteError,
    })
    await expect(store.delete(handle)).resolves.toBeUndefined()
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('any other failure still reaches onDeleteError', async () => {
    const onDeleteError = vi.fn()
    const store = new GoogleCacheStore({
      auth,
      client: cacheClient({ status: 500 }),
      onDeleteError,
    })
    await store.delete(handle)
    expect(onDeleteError).toHaveBeenCalledTimes(1)
  })
})

describe('GoogleCacheStore handle edges', () => {
  function makeClient(
    create: Partial<Awaited<ReturnType<GeminiCachesClientLike['create']>>> = {},
  ) {
    const client: GeminiCachesClientLike = {
      create: vi.fn().mockResolvedValue({
        name: 'cachedContents/abc',
        model: 'gemini-2.5-flash',
        expireTime: new Date(NOW + 3_600_000).toISOString(),
        ...create,
      }),
      update: vi.fn().mockResolvedValue({
        name: 'cachedContents/abc',
        expireTime: new Date(NOW + 7_200_000).toISOString(),
      }),
      delete: vi.fn().mockResolvedValue(undefined),
    }
    return client
  }

  it('records the kinds of the tools it was created with', async () => {
    const store = new GoogleCacheStore({ auth, client: makeClient(), now: () => NOW })
    const withSearch = await store.create({
      model: 'gemini-2.5-flash',
      ttlSeconds: 3600,
      tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'f' }] }],
    })
    expect(withSearch.toolKinds).toEqual(['googleSearch', 'functionDeclarations'])
    const without = await store.create({ model: 'gemini-2.5-flash', ttlSeconds: 3600 })
    expect(without.toolKinds).toEqual([])
  })

  it('getOrCreate and a TTL refresh keep the kinds', async () => {
    const store = new GoogleCacheStore({ auth, client: makeClient(), now: () => NOW })
    const handle = await store.getOrCreate(
      { model: 'gemini-2.5-flash', stableKey: 'k' },
      () => Promise.resolve({ ttlSeconds: 3600, tools: [{ googleSearch: {} }] }),
    )
    expect(handle.toolKinds).toEqual(['googleSearch'])
    const refreshed = await store.refreshIfExpiringSoon(handle, {
      thresholdSeconds: 7200,
    })
    expect(refreshed.expiresAt.getTime()).toBe(NOW + 7_200_000)
    expect(refreshed.toolKinds).toEqual(['googleSearch'])
  })

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'ttlSeconds %s is bad_request before any call',
    async (ttlSeconds) => {
      const client = makeClient()
      const store = new GoogleCacheStore({ auth, client, now: () => NOW })
      await expect(
        store.create({ model: 'gemini-2.5-flash', ttlSeconds }),
      ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
      expect(client.create).not.toHaveBeenCalled()
    },
  )

  it('an unparseable expireTime falls back to now + ttl, so the cache is live and reused', async () => {
    const client = makeClient({ expireTime: 'not a date' })
    const store = new GoogleCacheStore({ auth, client, now: () => NOW })
    const factory = () => Promise.resolve({ ttlSeconds: 3600 })
    const key = { model: 'gemini-2.5-flash', stableKey: 'k' }
    const first = await store.getOrCreate(key, factory)
    expect(Number.isNaN(first.expiresAt.getTime())).toBe(false)
    expect(first.expiresAt.getTime()).toBe(NOW + 3_600_000)
    const second = await store.getOrCreate(key, factory)
    expect(second).toBe(first)
    expect(client.create).toHaveBeenCalledTimes(1)
  })

  it('an expired entry is evicted from the in-process map when its key is asked for again', async () => {
    let now = NOW
    const client = makeClient()
    vi.mocked(client.create)
      .mockResolvedValueOnce({
        name: 'cachedContents/abc',
        expireTime: new Date(NOW + 3_600_000).toISOString(),
      })
      .mockRejectedValueOnce({ status: 500 })
    const store = new GoogleCacheStore({ auth, client, now: () => now })
    const factory = () => Promise.resolve({ ttlSeconds: 3600 })
    const key = { model: 'gemini-2.5-flash', stableKey: 'k' }
    await store.getOrCreate(key, factory)
    const entries = (store as unknown as { entries: Map<string, unknown> }).entries
    expect(entries.size).toBe(1)
    now += 4_000_000
    // The re-create fails, so only the eviction can have emptied the map.
    await expect(store.getOrCreate(key, factory)).rejects.toBeInstanceOf(LlmError)
    expect(entries.size).toBe(0)
  })
})

describe('GoogleFileStore.upload abort handling', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    unhandled.length = 0
  })

  it('a poll deadline that passes before the first wait leaves no unhandled rejection when the signal aborts later', async () => {
    process.on('unhandledRejection', onUnhandled)
    const controller = new AbortController()
    const client: GeminiFilesClientLike = {
      upload: vi.fn().mockResolvedValue({
        name: 'files/p',
        uri: 'https://example.com/files/p',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn(),
      delete: vi.fn(),
    }
    const store = new GoogleFileStore({
      auth,
      client,
      poll: { timeoutMs: 0 },
      sleep: () => Promise.resolve(),
    })
    await expect(
      store.upload(new Uint8Array([1]), 'image/png', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'server', retryable: false })
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(unhandled).toEqual([])
  })

  it('the abort listener is removed when the upload succeeds', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const states = ['PROCESSING', 'ACTIVE']
    const client: GeminiFilesClientLike = {
      upload: vi.fn().mockResolvedValue({
        name: 'files/p',
        uri: 'https://example.com/files/p',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockImplementation(() =>
        Promise.resolve({
          name: 'files/p',
          uri: 'https://example.com/files/p',
          mimeType: 'image/png',
          state: states.shift() ?? 'ACTIVE',
        }),
      ),
      delete: vi.fn(),
    }
    const store = new GoogleFileStore({ auth, client, sleep: () => Promise.resolve() })
    await store.upload(new Uint8Array([1]), 'image/png', { signal: controller.signal })
    const pollListeners = add.mock.calls.filter(([type]) => type === 'abort')
    expect(pollListeners.length).toBeGreaterThan(0)
    for (const [, listener] of pollListeners) {
      expect(remove).toHaveBeenCalledWith('abort', listener)
    }
  })
})
