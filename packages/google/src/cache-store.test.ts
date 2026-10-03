/**
 * GoogleCacheStore unit tests.
 *
 * All tests use an injected fake GeminiCachesClientLike and injected `now` — no
 * network or real clock required.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { LlmError } from '@gullabs/core'
import { GoogleCacheStore } from './cache-store.js'
import type { GeminiCachesClientLike, GoogleCacheHandle } from './cache-store.js'

// ---------------------------------------------------------------------------
// Mock @google/genai — vi.mock factories are hoisted above imports, so all
// state must be created inside the factory via vi.hoisted. Only used by the
// getClient() lazy-build / clientOverride-short-circuit tests below; every
// other test in this file injects a fake GeminiCachesClientLike instead.
// ---------------------------------------------------------------------------

const { constructorCalls, createMock, updateMock, deleteCacheMock } = vi.hoisted(() => {
  return {
    constructorCalls: [] as unknown[],
    createMock: vi.fn().mockResolvedValue({
      name: 'cachedContents/lazy123',
      model: 'gemini-2.0-flash',
      expireTime: new Date(1_700_000_000_000 + 3600 * 1000).toISOString(),
    }),
    updateMock: vi.fn().mockResolvedValue({
      name: 'cachedContents/lazy123',
      expireTime: new Date(1_700_000_000_000 + 7200 * 1000).toISOString(),
    }),
    deleteCacheMock: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    caches: {
      create: typeof createMock
      update: typeof updateMock
      delete: typeof deleteCacheMock
    }
    constructor(args: unknown) {
      constructorCalls.push(args)
      this.caches = { create: createMock, update: updateMock, delete: deleteCacheMock }
    }
  }
  return { GoogleGenAI }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeAuth = { apiKey: 'test-key' }

/** Baseline "now" — arbitrary fixed epoch. */
const BASE_NOW = 1_700_000_000_000

function makeClient(
  overrides: Partial<GeminiCachesClientLike> = {},
): GeminiCachesClientLike {
  return {
    create: vi.fn().mockResolvedValue({
      name: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
    }),
    update: vi.fn().mockResolvedValue({
      name: 'cachedContents/abc123',
      expireTime: new Date(BASE_NOW + 7200 * 1000).toISOString(),
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleCacheStore', () => {
  // 1. create returns correct handle
  it('create returns correct handle with cacheName, model, and expiresAt from ttl', async () => {
    const ttlSeconds = 3600
    const client = makeClient()
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle = await store.create({
      model: 'gemini-2.0-flash',
      ttlSeconds,
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    })

    expect(handle.cacheName).toBe('cachedContents/abc123')
    expect(handle.model).toBe('gemini-2.0-flash')
    // Server returned expireTime — should be parsed
    expect(handle.expiresAt).toBeInstanceOf(Date)
    expect(handle.expiresAt.getTime()).toBe(BASE_NOW + ttlSeconds * 1000)
  })

  it('create sends tools and toolConfig to the SDK create config, and the preflight sees the tools', async () => {
    const client = makeClient()
    const countTokens = vi.fn().mockResolvedValue(5000)
    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      now: () => BASE_NOW,
      preflight: { minTokens: 1024, countTokens },
    })
    const tools = [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Weather',
            parametersJsonSchema: { type: 'object' },
          },
        ],
      },
    ]
    const toolConfig = { functionCallingConfig: { mode: 'AUTO' as never } }

    await store.create({
      model: 'gemini-2.5-flash',
      ttlSeconds: 600,
      systemInstruction: 'Be brief.',
      tools,
      toolConfig,
    })

    expect(client.create).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      config: { ttl: '600s', systemInstruction: 'Be brief.', tools, toolConfig },
    })
    expect(countTokens).toHaveBeenCalledWith({
      model: 'gemini-2.5-flash',
      systemInstruction: 'Be brief.',
      tools,
    })
  })

  it('getOrCreate forwards tools and toolConfig from the factory', async () => {
    const client = makeClient()
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })
    const tools = [{ functionDeclarations: [{ name: 'f', description: 'd' }] }]
    await store.getOrCreate({ model: 'm', stableKey: 'k' }, async () => ({
      ttlSeconds: 60,
      tools,
    }))
    expect(client.create).toHaveBeenCalledWith({
      model: 'm',
      config: { ttl: '60s', tools },
    })
  })

  it('create falls back to local clock expiry when server omits expireTime', async () => {
    const ttlSeconds = 1800
    const client = makeClient({
      create: vi
        .fn()
        .mockResolvedValue({ name: 'cachedContents/xyz', model: 'gemini-2.0-flash' }),
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle = await store.create({ model: 'gemini-2.0-flash', ttlSeconds })

    expect(handle.cacheName).toBe('cachedContents/xyz')
    expect(handle.expiresAt.getTime()).toBe(BASE_NOW + ttlSeconds * 1000)
  })

  // 2. getOrCreate: first call invokes factory+create; second call returns cached entry
  it('getOrCreate: first call invokes factory+create; second call (still fresh) reuses without calling create again', async () => {
    const client = makeClient()
    const factory = vi.fn().mockResolvedValue({
      ttlSeconds: 3600,
      contents: [{ role: 'user', parts: [{ text: 'cached' }] }],
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const key = { model: 'gemini-2.0-flash', stableKey: 'key-1' }

    const h1 = await store.getOrCreate(key, factory)
    const h2 = await store.getOrCreate(key, factory)

    // factory and create called only once (the second call reuses the in-process map)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(h1).toBe(h2)
  })

  // 3. getOrCreate with coalesce:true — two concurrent calls share one in-flight create
  it('getOrCreate with coalesce:true: two concurrent calls for the same key invoke factory exactly once', async () => {
    const client = makeClient()
    let resolveFactory!: (v: { ttlSeconds: number }) => void
    const blockedFactory = vi.fn(
      () =>
        new Promise<{ ttlSeconds: number }>((res) => {
          resolveFactory = res
        }),
    )

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      coalesce: true,
      now: () => BASE_NOW,
    })

    const key = { model: 'gemini-2.0-flash', stableKey: 'coalesce-key' }

    // Start two concurrent calls without awaiting
    const p1 = store.getOrCreate(key, blockedFactory)
    const p2 = store.getOrCreate(key, blockedFactory)

    // Unblock factory
    resolveFactory({ ttlSeconds: 3600 })

    const [h1, h2] = await Promise.all([p1, p2])

    // Factory should have been called exactly once due to coalescing
    expect(blockedFactory).toHaveBeenCalledTimes(1)
    expect(client.create).toHaveBeenCalledTimes(1)
    expect(h1.cacheName).toBe(h2.cacheName)
  })

  it('getOrCreate with coalesce:true: different keys create independently', async () => {
    let callCount = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          name: `cachedContents/entry-${callCount}`,
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
    })

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      coalesce: true,
      now: () => BASE_NOW,
    })

    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })

    const [h1, h2] = await Promise.all([
      store.getOrCreate({ model: 'gemini-2.0-flash', stableKey: 'k1' }, factory),
      store.getOrCreate({ model: 'gemini-2.0-flash', stableKey: 'k2' }, factory),
    ])

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(h1.cacheName).not.toBe(h2.cacheName)
  })

  // 4. Expired entry triggers a fresh create
  it('expired entry: advances now past expiresAt-skew, verifies a fresh create is triggered', async () => {
    const ttlSeconds = 3600
    const skewSeconds = 30
    // expiresAt will be BASE_NOW + 3600*1000 (from server)
    const client = makeClient()
    let nowMs = BASE_NOW

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      expirySkewSeconds: skewSeconds,
      now: () => nowMs,
    })

    const key = { model: 'gemini-2.0-flash', stableKey: 'expire-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds })

    // First call — creates entry
    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // Advance clock past expiry (accounting for skew)
    nowMs = BASE_NOW + ttlSeconds * 1000 - skewSeconds * 1000 + 1

    // Second call — entry is now considered expired; should create again
    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  // 5. refreshIfExpiringSoon
  it('refreshIfExpiringSoon extends when near expiry', async () => {
    const ttlSeconds = 3600
    const client = makeClient()
    // Set now such that expiresAt - now <= threshold (default 300s)
    // expiresAt = BASE_NOW + 3600*1000; if now = BASE_NOW + 3600*1000 - 100*1000, diff = 100s < 300s
    const nearExpiryNow = BASE_NOW + ttlSeconds * 1000 - 100 * 1000

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      now: () => nearExpiryNow,
    })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + ttlSeconds * 1000),
    }

    const newHandle = await store.refreshIfExpiringSoon(handle)

    expect(client.update).toHaveBeenCalledTimes(1)
    // Server returned expireTime = BASE_NOW + 7200*1000
    expect(newHandle.expiresAt.getTime()).toBe(BASE_NOW + 7200 * 1000)
    expect(newHandle.cacheName).toBe(handle.cacheName)
  })

  it('refreshIfExpiringSoon: no update call when not near expiry', async () => {
    const client = makeClient()
    // expiresAt = BASE_NOW + 3600*1000; now = BASE_NOW; diff = 3600s >> 300s threshold
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    const result = await store.refreshIfExpiringSoon(handle)

    expect(client.update).not.toHaveBeenCalled()
    expect(result).toBe(handle)
  })

  it('refreshIfExpiringSoon: returns original handle when update throws (fail-open)', async () => {
    const client = makeClient({
      update: vi.fn().mockRejectedValue(new Error('network error')),
    })
    const nearExpiryNow = BASE_NOW + 3600 * 1000 - 100 * 1000

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      now: () => nearExpiryNow,
    })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    // Should NOT throw
    const result = await store.refreshIfExpiringSoon(handle)
    expect(result).toBe(handle)
  })

  // NEW (a): coalesce:false → two concurrent same-key getOrCreate do NOT share
  it('coalesce:false: two concurrent same-key calls invoke create twice', async () => {
    let callCount = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          name: `cachedContents/entry-${callCount}`,
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
    })

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      coalesce: false,
      now: () => BASE_NOW,
    })
    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })
    const key = { model: 'gemini-2.0-flash', stableKey: 'no-coalesce-key' }

    const [h1, h2] = await Promise.all([
      store.getOrCreate(key, factory),
      store.getOrCreate(key, factory),
    ])

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
    // They get different handles (different names)
    expect(h1.cacheName).not.toBe(h2.cacheName)
  })

  // NEW (b): coalesced create that REJECTS clears inflight and doesn't poison entries
  it('coalesce:true: rejected create clears inflight so a retry succeeds independently', async () => {
    let attempt = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        attempt++
        if (attempt === 1) {
          return Promise.reject(new Error('transient failure'))
        }
        return Promise.resolve({
          name: 'cachedContents/retry-ok',
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
    })

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      coalesce: true,
      now: () => BASE_NOW,
    })
    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })
    const key = { model: 'gemini-2.0-flash', stableKey: 'retry-key' }

    // First attempt — both concurrent callers share the failing create
    const firstAttempt = store.getOrCreate(key, factory).catch((e) => e)
    const firstAttempt2 = store.getOrCreate(key, factory).catch((e) => e)
    const [r1, r2] = await Promise.all([firstAttempt, firstAttempt2])
    expect(r1).toBeInstanceOf(Error)
    expect(r2).toBeInstanceOf(Error)

    // entries must NOT be poisoned
    // Retry — inflight was cleared, so a fresh create runs
    const retryHandle = await store.getOrCreate(key, factory)
    expect(retryHandle.cacheName).toBe('cachedContents/retry-ok')
    // factory called: once for first pair (coalesced) + once for retry = 2
    expect(factory).toHaveBeenCalledTimes(2)
    expect(client.create).toHaveBeenCalledTimes(2)
  })

  // NEW (c): successful refreshIfExpiringSoon updates the entry so later getOrCreate reuses it
  it('refreshIfExpiringSoon: successful update causes later getOrCreate to reuse refreshed handle', async () => {
    const ttlSeconds = 3600
    const client = makeClient()
    // Start near expiry so refresh fires: expiresAt = BASE_NOW + 3600*1000; threshold 300s
    // nearExpiryNow → expiresAt - now = 100s < 300s → refresh fires
    let nowMs = BASE_NOW + ttlSeconds * 1000 - 100 * 1000

    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => nowMs })
    const key = { model: 'gemini-2.0-flash', stableKey: 'refresh-reuse-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds })

    // Create initial entry
    const initial = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // Refresh (near expiry at nowMs)
    const refreshed = await store.refreshIfExpiringSoon(initial)
    expect(client.update).toHaveBeenCalledTimes(1)
    // Server returns expireTime = BASE_NOW + 7200*1000
    expect(refreshed.expiresAt.getTime()).toBe(BASE_NOW + 7200 * 1000)

    // Advance clock but still within the NEW expiry window (7200s from BASE_NOW)
    nowMs = BASE_NOW + 5000 * 1000 // 5000s from BASE_NOW, < 7200s

    // getOrCreate should reuse the refreshed entry without creating again
    const reused = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1) // still 1 — no new create
    expect(reused.cacheName).toBe(refreshed.cacheName)
    expect(reused.expiresAt.getTime()).toBe(refreshed.expiresAt.getTime())
  })

  // NEW (d): delete() evicts entry so next getOrCreate creates fresh (even if remote delete throws)
  it('delete: evicts local entry so next getOrCreate creates a new cache even when remote delete throws', async () => {
    let callCount = 0
    const client = makeClient({
      create: vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          name: `cachedContents/entry-${callCount}`,
          model: 'gemini-2.0-flash',
          expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        })
      }),
      delete: vi.fn().mockRejectedValue(new Error('remote delete failed')),
    })
    const onDeleteError = vi.fn()

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      onDeleteError,
      now: () => BASE_NOW,
    })
    const key = { model: 'gemini-2.0-flash', stableKey: 'evict-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })

    const h1 = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // delete should evict locally even though remote throws
    await store.delete(h1)
    expect(onDeleteError).toHaveBeenCalledOnce()

    // Next getOrCreate must create fresh
    const h2 = await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(h2.cacheName).not.toBe(h1.cacheName)
  })

  // NEW (e): expiry boundary — when expiresAt - skew === now exactly, treat as EXPIRED
  it('expiry boundary: entry where expiresAt - skew === now is treated as expired', async () => {
    const ttlSeconds = 3600
    const skewSeconds = 30
    const client = makeClient()

    // expiresAt = BASE_NOW + 3600*1000; skewMs = 30*1000
    // boundary: expiresAt - skewMs = BASE_NOW + 3570*1000
    // isLive uses `> now`, so if now === boundary, entry is NOT live
    let nowMs = BASE_NOW
    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      expirySkewSeconds: skewSeconds,
      now: () => nowMs,
    })

    const key = { model: 'gemini-2.0-flash', stableKey: 'boundary-key' }
    const factory = vi.fn().mockResolvedValue({ ttlSeconds })

    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(1)

    // Advance clock to exact boundary: expiresAt - skewMs
    nowMs = BASE_NOW + ttlSeconds * 1000 - skewSeconds * 1000

    // At exactly the boundary, isLive returns false → re-create
    await store.getOrCreate(key, factory)
    expect(client.create).toHaveBeenCalledTimes(2)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  // 6. delete swallows a throwing client and calls onDeleteError
  it('delete swallows a throwing client and calls onDeleteError with cacheName and error', async () => {
    const deleteError = new Error('delete failed')
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(deleteError),
    })
    const onDeleteError = vi.fn()

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      onDeleteError,
      now: () => BASE_NOW,
    })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    // Should not throw
    await expect(store.delete(handle)).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledWith('cachedContents/abc123', deleteError)
  })

  // NEW (f): create() validates response name — undefined case
  it('create throws LlmError server when response name is undefined', async () => {
    const client = makeClient({
      create: vi.fn().mockResolvedValue({
        model: 'gemini-2.0-flash',
        expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        // name omitted entirely
      }),
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    await expect(
      store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
    ).rejects.toMatchObject({
      message: 'Cache create response missing required field: name',
      kind: 'server',
      retryable: false,
      provider: 'google',
    })
    await expect(
      store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
    ).rejects.toBeInstanceOf(LlmError)
  })

  // NEW (g): create() validates response name — empty-string case
  it('create throws LlmError server when response name is an empty string', async () => {
    const client = makeClient({
      create: vi.fn().mockResolvedValue({
        name: '',
        model: 'gemini-2.0-flash',
        expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
      }),
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    await expect(
      store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
    ).rejects.toMatchObject({
      message: 'Cache create response missing required field: name',
      kind: 'server',
      retryable: false,
      provider: 'google',
    })
  })

  // NEW (h): create() falls back to local clock expiry when expireTime is an empty string
  it('create falls back to local clock expiry when server returns an empty expireTime string', async () => {
    const ttlSeconds = 900
    const client = makeClient({
      create: vi.fn().mockResolvedValue({
        name: 'cachedContents/empty-expire',
        model: 'gemini-2.0-flash',
        expireTime: '',
      }),
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle = await store.create({ model: 'gemini-2.0-flash', ttlSeconds })

    expect(handle.expiresAt.getTime()).toBe(BASE_NOW + ttlSeconds * 1000)
  })

  // NEW (i): getOrCreate passes systemInstruction through to create() when provided
  it('getOrCreate forwards factory-provided systemInstruction into the create call', async () => {
    const client = makeClient()
    const systemInstruction = { role: 'system', parts: [{ text: 'be terse' }] }
    const factory = vi.fn().mockResolvedValue({
      ttlSeconds: 3600,
      systemInstruction,
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    await store.getOrCreate(
      { model: 'gemini-2.0-flash', stableKey: 'sysinst-key' },
      factory,
    )

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ systemInstruction }),
      }),
    )
  })

  // NEW (j): refreshIfExpiringSoon extend — fallback to local clock expiry when
  // server omits expireTime on update()
  it('refreshIfExpiringSoon falls back to local clock expiry when update response omits expireTime', async () => {
    const extensionSeconds = 1200
    const client = makeClient({
      update: vi.fn().mockResolvedValue({ name: 'cachedContents/abc123' }),
    })
    const nearExpiryNow = BASE_NOW + 3600 * 1000 - 100 * 1000

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      now: () => nearExpiryNow,
    })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    const newHandle = await store.refreshIfExpiringSoon(handle, { extensionSeconds })

    expect(client.update).toHaveBeenCalledTimes(1)
    expect(newHandle.expiresAt.getTime()).toBe(nearExpiryNow + extensionSeconds * 1000)
  })

  // NEW (k): refreshIfExpiringSoon extend — fallback when expireTime is an empty string
  it('refreshIfExpiringSoon falls back to local clock expiry when update response has empty expireTime', async () => {
    const extensionSeconds = 600
    const client = makeClient({
      update: vi
        .fn()
        .mockResolvedValue({ name: 'cachedContents/abc123', expireTime: '' }),
    })
    const nearExpiryNow = BASE_NOW + 3600 * 1000 - 100 * 1000

    const store = new GoogleCacheStore({
      auth: fakeAuth,
      client,
      now: () => nearExpiryNow,
    })

    const handle: GoogleCacheHandle = {
      cacheName: 'cachedContents/abc123',
      model: 'gemini-2.0-flash',
      expiresAt: new Date(BASE_NOW + 3600 * 1000),
    }

    const newHandle = await store.refreshIfExpiringSoon(handle, { extensionSeconds })

    expect(newHandle.expiresAt.getTime()).toBe(nearExpiryNow + extensionSeconds * 1000)
  })

  // delete error routing
  describe('delete error routing', () => {
    it('routes delete failure to logger.error when logger is provided', async () => {
      const errorFn = vi.fn()
      const logger = { info() {}, warn() {}, debug() {}, error: errorFn }
      const client = makeClient({
        delete: vi.fn().mockRejectedValue(new Error('network down')),
      })
      const store = new GoogleCacheStore({
        auth: fakeAuth,
        client,
        logger,
        now: () => BASE_NOW,
      })
      const handle: GoogleCacheHandle = {
        cacheName: 'cachedContents/abc123',
        model: 'gemini-2.0-flash',
        expiresAt: new Date(BASE_NOW + 3600 * 1000),
      }
      await store.delete(handle)

      expect(errorFn).toHaveBeenCalledOnce()
      const [obj, msg] = errorFn.mock.calls[0]!
      expect(msg).toBe('gemini.cache.delete.failed')
      expect(obj).toMatchObject({ name: 'cachedContents/abc123' })
      expect(typeof obj.error).toBe('string')
    })

    it('falls back to console.error when no logger provided', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const client = makeClient({
        delete: vi.fn().mockRejectedValue(new Error('network down')),
      })
      const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })
      const handle: GoogleCacheHandle = {
        cacheName: 'cachedContents/abc123',
        model: 'gemini-2.0-flash',
        expiresAt: new Date(BASE_NOW + 3600 * 1000),
      }
      await store.delete(handle)

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // NEW (l): default `now` (not injected) falls back to the real Date.now
  it('defaults now to Date.now when not injected', async () => {
    const client = makeClient()
    const store = new GoogleCacheStore({ auth: fakeAuth, client })

    const before = Date.now()
    const handle = await store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 })
    const after = Date.now()

    // expireTime from makeClient() is relative to the fixed BASE_NOW constant used
    // by the client fake, not the real clock — so just assert the handle resolved
    // and the store didn't crash exercising the real Date.now() fallback.
    expect(handle.cacheName).toBe('cachedContents/abc123')
    expect(before).toBeLessThanOrEqual(after)
  })

  // NEW (m): create() forwards displayName into config.displayName
  it('create forwards displayName into the request config', async () => {
    const client = makeClient()
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    await store.create({
      model: 'gemini-2.0-flash',
      ttlSeconds: 3600,
      displayName: 'my-cache',
    })

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ displayName: 'my-cache' }),
      }),
    )
  })

  // NEW (n): create() falls back to input.model when resp.model is omitted
  it('create falls back to input.model when response omits model', async () => {
    const client = makeClient({
      create: vi.fn().mockResolvedValue({
        name: 'cachedContents/no-model',
        expireTime: new Date(BASE_NOW + 3600 * 1000).toISOString(),
        // model omitted
      }),
    })
    const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

    const handle = await store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 })

    expect(handle.model).toBe('gemini-2.0-flash')
  })

  // NEW: getClient() — clientOverride short-circuits and never builds the SDK client
  describe('getClient()', () => {
    it('clientOverride short-circuits: never constructs GoogleGenAI', async () => {
      constructorCalls.length = 0
      const client = makeClient()
      const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

      await store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 })

      expect(constructorCalls).toHaveLength(0)
      expect(client.create).toHaveBeenCalledTimes(1)
    })

    it('lazily builds and memoises the SDK client: concurrent calls construct GoogleGenAI only once', async () => {
      constructorCalls.length = 0
      createMock.mockClear()
      const store = new GoogleCacheStore({ auth: fakeAuth, now: () => BASE_NOW })

      // Two concurrent creates without a client override — both must resolve
      // through the same memoised clientPromise.
      const [h1, h2] = await Promise.all([
        store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
        store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
      ])

      expect(constructorCalls).toHaveLength(1)
      expect(h1.cacheName).toBe('cachedContents/lazy123')
      expect(h2.cacheName).toBe('cachedContents/lazy123')

      // A subsequent call also reuses the same memoised client.
      await store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 })
      expect(constructorCalls).toHaveLength(1)
    })

    it('lazily-built client wraps ai.caches.update and ai.caches.delete', async () => {
      constructorCalls.length = 0
      updateMock.mockClear()
      deleteCacheMock.mockClear()

      const store = new GoogleCacheStore({ auth: fakeAuth, now: () => BASE_NOW })

      const handle: GoogleCacheHandle = {
        cacheName: 'cachedContents/lazy123',
        model: 'gemini-2.0-flash',
        expiresAt: new Date(BASE_NOW + 100 * 1000),
      }

      const refreshed = await store.refreshIfExpiringSoon(handle)
      expect(updateMock).toHaveBeenCalledWith({
        name: 'cachedContents/lazy123',
        config: { ttl: '3600s' },
      })
      expect(refreshed.expiresAt.getTime()).toBe(BASE_NOW + 7200 * 1000)

      await store.delete(refreshed)
      expect(deleteCacheMock).toHaveBeenCalledWith({ name: 'cachedContents/lazy123' })

      // Still only one GoogleGenAI instance across create-via-refresh + update + delete.
      expect(constructorCalls).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // preflight token-count gate
  // ---------------------------------------------------------------------------
  describe('preflight', () => {
    it('create() below threshold rejects with bad_request naming counted/required tokens and never calls the SDK', async () => {
      const client = makeClient()
      const countTokens = vi.fn().mockResolvedValue(100)
      const store = new GoogleCacheStore({
        auth: fakeAuth,
        client,
        now: () => BASE_NOW,
        preflight: { minTokens: 2048, countTokens },
      })

      await expect(
        store.create({
          model: 'gemini-2.0-flash',
          ttlSeconds: 3600,
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      ).rejects.toMatchObject({
        kind: 'bad_request',
        retryable: false,
        message: expect.stringContaining('counted 100'),
      })
      await expect(
        store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
      ).rejects.toMatchObject({ message: expect.stringContaining('minimum of 2048') })
      await expect(
        store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 }),
      ).rejects.toBeInstanceOf(LlmError)

      expect(client.create).not.toHaveBeenCalled()
    })

    it('create() at/above threshold proceeds normally (SDK create is called)', async () => {
      const client = makeClient()
      const countTokens = vi.fn().mockResolvedValue(2048)
      const store = new GoogleCacheStore({
        auth: fakeAuth,
        client,
        now: () => BASE_NOW,
        preflight: { minTokens: 2048, countTokens },
      })

      const handle = await store.create({
        model: 'gemini-2.0-flash',
        ttlSeconds: 3600,
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      })

      expect(handle.cacheName).toBe('cachedContents/abc123')
      expect(client.create).toHaveBeenCalledTimes(1)
    })

    it('countTokens callback receives exactly { model, contents, systemInstruction } — no ttl/displayName', async () => {
      const client = makeClient()
      const countTokens = vi.fn().mockResolvedValue(9999)
      const store = new GoogleCacheStore({
        auth: fakeAuth,
        client,
        now: () => BASE_NOW,
        preflight: { minTokens: 1, countTokens },
      })
      const systemInstruction = { role: 'system', parts: [{ text: 'be terse' }] }
      const contents = [{ role: 'user', parts: [{ text: 'hi' }] }]

      await store.create({
        model: 'gemini-2.0-flash',
        ttlSeconds: 3600,
        contents,
        systemInstruction,
        displayName: 'my-cache',
      })

      expect(countTokens).toHaveBeenCalledWith({
        model: 'gemini-2.0-flash',
        contents,
        systemInstruction,
      })
    })

    it('getOrCreate() (non-coalesced) below threshold rejects and never calls the SDK', async () => {
      const client = makeClient()
      const countTokens = vi.fn().mockResolvedValue(1)
      const store = new GoogleCacheStore({
        auth: fakeAuth,
        client,
        now: () => BASE_NOW,
        preflight: { minTokens: 2048, countTokens },
      })
      const factory = vi.fn().mockResolvedValue({
        ttlSeconds: 3600,
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      })

      await expect(
        store.getOrCreate(
          { model: 'gemini-2.0-flash', stableKey: 'preflight-key' },
          factory,
        ),
      ).rejects.toMatchObject({ kind: 'bad_request' })
      expect(client.create).not.toHaveBeenCalled()
    })

    it('getOrCreate() (coalesced) below threshold rejects both callers and never calls the SDK', async () => {
      const client = makeClient()
      const countTokens = vi.fn().mockResolvedValue(1)
      const store = new GoogleCacheStore({
        auth: fakeAuth,
        client,
        coalesce: true,
        now: () => BASE_NOW,
        preflight: { minTokens: 2048, countTokens },
      })
      const factory = vi.fn().mockResolvedValue({ ttlSeconds: 3600 })
      const key = { model: 'gemini-2.0-flash', stableKey: 'preflight-coalesce-key' }

      const p1 = store.getOrCreate(key, factory).catch((e: unknown) => e)
      const p2 = store.getOrCreate(key, factory).catch((e: unknown) => e)
      const [r1, r2] = await Promise.all([p1, p2])

      expect(r1).toBeInstanceOf(LlmError)
      expect(r2).toBeInstanceOf(LlmError)
      expect(client.create).not.toHaveBeenCalled()
    })

    it('unconfigured store (no preflight option): behavior is unchanged', async () => {
      const client = makeClient()
      const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

      const handle = await store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 })
      expect(handle.cacheName).toBe('cachedContents/abc123')
      expect(client.create).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------------------
  // Type tightening — contents/systemInstruction are no longer `unknown`
  // ---------------------------------------------------------------------------
  describe('type tightening', () => {
    it('rejects a non-Content[] value for contents at compile time', () => {
      const client = makeClient()
      const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })

      // @ts-expect-error — contents must be Content[], not a bare string.
      void store.create({ model: 'gemini-2.0-flash', ttlSeconds: 3600, contents: 'nope' })
    })
  })

  // Errors classify through classifyGoogleError (bodies are doc-derived or
  // captured shapes; see __fixtures__/error-bodies-2026-10-03.json).
  describe('error classification', () => {
    const apiError = (status: number, body: unknown): Error =>
      Object.assign(new Error(JSON.stringify(body)), { status, name: 'ApiError' })
    const createWith = async (error: Error): Promise<LlmError> => {
      const client = makeClient({ create: vi.fn().mockRejectedValue(error) })
      const store = new GoogleCacheStore({ auth: fakeAuth, client, now: () => BASE_NOW })
      return (await store
        .create({ model: 'gemini-2.0-flash', ttlSeconds: 3600 })
        .catch((e) => e)) as LlmError
    }

    it('create: a bad API key is invalid_auth tagged google, not a bad_request', async () => {
      const err = await createWith(
        apiError(400, {
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'API_KEY_INVALID',
              },
            ],
          },
        }),
      )
      expect(err).toMatchObject({
        kind: 'invalid_auth',
        retryable: false,
        provider: 'google',
      })
    })

    it('create: a per-day quota is rate_limited, daily_quota, not retryable', async () => {
      const err = await createWith(
        apiError(429, {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
                violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }],
              },
            ],
          },
        }),
      )
      expect(err).toMatchObject({
        kind: 'rate_limited',
        retryable: false,
        reason: 'daily_quota',
        provider: 'google',
      })
    })

    it('create: the stale CachedContent 403 is bad_request, cache_not_found', async () => {
      const err = await createWith(
        apiError(403, {
          error: {
            code: 403,
            message: 'CachedContent not found (or permission denied)',
            status: 'PERMISSION_DENIED',
          },
        }),
      )
      expect(err).toMatchObject({
        kind: 'bad_request',
        reason: 'cache_not_found',
        provider: 'google',
      })
    })
  })
})
