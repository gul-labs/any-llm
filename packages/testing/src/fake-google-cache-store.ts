/* eslint-disable @typescript-eslint/require-await -- Promise-shaped API; body is sync in-memory */
/**
 * FakeGoogleCacheStore — in-memory stand-in for `@gullabs/google` `GoogleCacheStore`.
 *
 * Structural (no import of `@gullabs/google`). Mirrors the real store's surface
 * (`create`, `getOrCreate`, `refreshIfExpiringSoon`, `delete`), its
 * process-scoped reuse, its expiry skew and its fail-open refresh and delete.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'

/** Mirrors `GoogleCacheHandle`. */
export interface FakeGoogleCacheHandle {
  /** Resource name, e.g. `cachedContents/fake-1`. */
  cacheName: string
  expiresAt: Date
  /** Caches are model-bound. */
  model: string
  /** Tokens the cache holds, when the store was given a `tokenCount`. */
  totalTokenCount?: number
}

/** Mirrors `CacheKey`. */
export interface FakeGoogleCacheKey {
  model: string
  stableKey: string
}

/** What the real store's `create` takes; contents and tools are opaque here. */
export interface FakeGoogleCacheCreateInput {
  model: string
  ttlSeconds: number
  contents?: readonly unknown[]
  systemInstruction?: unknown
  tools?: readonly unknown[]
  toolConfig?: unknown
  displayName?: string
}

export interface FakeGoogleCacheStoreOptions {
  /** Injectable clock (ms). Default `Date.now`. Pass `() => clock.now()` for a FakeClock. */
  now?: () => number
  /** Subtracted from the expiry when deciding a cache is still live. Default 30 s, as the real store. */
  expirySkewSeconds?: number
  /** Tokens each created cache reports as `totalTokenCount`; a function sees the create input. */
  tokenCount?: number | ((input: FakeGoogleCacheCreateInput) => number)
  /** Called on a swallowed delete failure. Default: ignore. */
  onDeleteError?: (cacheName: string, err: unknown) => void
}

const DEFAULT_SKEW_SECONDS = 30
const DEFAULT_EXTENSION_SECONDS = 3600

/**
 * An in-memory Gemini cache store. `created` counts the creates, so a test can
 * assert that `getOrCreate` reused a live cache and re-created an expired one.
 *
 * ```ts
 * const caches = new FakeGoogleCacheStore({ now: () => clock.now() })
 * const a = await caches.getOrCreate(key, async () => ({ ttlSeconds: 600 }))
 * const b = await caches.getOrCreate(key, async () => ({ ttlSeconds: 600 }))
 * expect(b).toBe(a)
 * expect(caches.created).toBe(1)
 * ```
 */
export class FakeGoogleCacheStore {
  /** Creates made so far. */
  created = 0

  private readonly caches = new Map<string, FakeGoogleCacheHandle>()
  private readonly entries = new Map<
    string,
    { handle: FakeGoogleCacheHandle; ttlSeconds: number }
  >()
  private readonly now: () => number
  private readonly skewMs: number
  private readonly tokenCount: FakeGoogleCacheStoreOptions['tokenCount']
  private readonly onDeleteError: (cacheName: string, err: unknown) => void
  private seq = 0

  constructor(opts: FakeGoogleCacheStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.tokenCount = opts.tokenCount
    this.onDeleteError =
      opts.onDeleteError ??
      (() => {
        /* fail-open default */
      })
  }

  /** Caches the "provider" currently holds (created and not deleted). */
  get size(): number {
    return this.caches.size
  }

  async create(input: FakeGoogleCacheCreateInput): Promise<FakeGoogleCacheHandle> {
    if (
      typeof input.model !== 'string' ||
      input.model === '' ||
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds <= 0
    ) {
      throw new LlmError(
        'FakeGoogleCacheStore.create needs a model and a positive integer ttlSeconds.',
        { kind: 'bad_request', retryable: false, provider: 'google' },
      )
    }
    this.seq += 1
    this.created += 1
    const tokens =
      typeof this.tokenCount === 'function' ? this.tokenCount(input) : this.tokenCount
    const handle: FakeGoogleCacheHandle = {
      cacheName: `cachedContents/fake-${this.seq}`,
      model: input.model,
      expiresAt: new Date(this.now() + input.ttlSeconds * 1000),
      ...(tokens !== undefined ? { totalTokenCount: tokens } : {}),
    }
    this.caches.set(handle.cacheName, handle)
    return { ...handle }
  }

  async getOrCreate(
    key: FakeGoogleCacheKey,
    factory: () => Promise<Omit<FakeGoogleCacheCreateInput, 'model'>>,
  ): Promise<FakeGoogleCacheHandle> {
    const mapKey = `${key.model}:${key.stableKey}`
    const existing = this.entries.get(mapKey)
    if (existing !== undefined && this.isLive(existing.handle)) {
      return existing.handle
    }
    const made = await factory()
    const handle = await this.create({ ...made, model: key.model })
    this.entries.set(mapKey, { handle, ttlSeconds: made.ttlSeconds })
    return handle
  }

  async refreshIfExpiringSoon(
    handle: FakeGoogleCacheHandle,
    opts?: { thresholdSeconds?: number; extensionSeconds?: number },
  ): Promise<FakeGoogleCacheHandle> {
    const thresholdMs = (opts?.thresholdSeconds ?? 300) * 1000
    if (handle.expiresAt.getTime() - this.now() > thresholdMs) return handle
    if (!this.caches.has(handle.cacheName)) return handle // fail-open: the update failed
    let extensionSeconds = opts?.extensionSeconds
    if (extensionSeconds === undefined) {
      for (const entry of this.entries.values()) {
        if (entry.handle.cacheName === handle.cacheName) {
          extensionSeconds = entry.ttlSeconds
          break
        }
      }
      extensionSeconds ??= DEFAULT_EXTENSION_SECONDS
    }
    const refreshed: FakeGoogleCacheHandle = {
      ...handle,
      expiresAt: new Date(this.now() + extensionSeconds * 1000),
    }
    this.caches.set(refreshed.cacheName, refreshed)
    for (const [k, entry] of this.entries) {
      if (entry.handle.cacheName === handle.cacheName) {
        this.entries.set(k, { handle: refreshed, ttlSeconds: extensionSeconds })
        break
      }
    }
    return refreshed
  }

  async delete(handle: Pick<FakeGoogleCacheHandle, 'cacheName'>): Promise<void> {
    for (const [k, entry] of this.entries) {
      if (entry.handle.cacheName === handle.cacheName) {
        this.entries.delete(k)
        break
      }
    }
    if (!this.caches.delete(handle.cacheName)) {
      this.onDeleteError(
        handle.cacheName,
        new LlmError('simulated delete failure: cache not found', {
          kind: 'bad_request',
          retryable: false,
          httpStatus: 404,
          provider: 'google',
        }),
      )
    }
  }

  private isLive(handle: FakeGoogleCacheHandle): boolean {
    return handle.expiresAt.getTime() - this.skewMs > this.now()
  }
}
