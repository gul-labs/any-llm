/* eslint-disable @typescript-eslint/require-await -- Promise-shaped API; body is sync in-memory */
/**
 * FakeGoogleCacheStore — in-memory stand-in for `@gullabs/google` `GoogleCacheStore`.
 *
 * Structural (no static import of `@gullabs/google`). Mirrors the real store's
 * surface (`create`, `getOrCreate`, `refreshIfExpiringSoon`, `delete`), its
 * process-scoped reuse, its expiry skew, its fail-open refresh and delete, its
 * opt-in `preflight` token gate and `coalesce`, and scripted create failures
 * (`failCreate`).
 *
 * @module
 */

import { classifyError, LlmError } from '@gullabs/core'

import { classifyAs } from './provider-errors.js'

/** Mirrors `GoogleCacheHandle`. */
export interface FakeGoogleCacheHandle {
  /** Resource name, e.g. `cachedContents/fake-1`. */
  cacheName: string
  expiresAt: Date
  /** Caches are model-bound. */
  model: string
  /** Tokens the cache holds, when the store was given a `tokenCount`. */
  totalTokenCount?: number
  /** The kinds of tool the cache was created with (the keys of each tool object); empty when none. */
  toolKinds?: readonly string[]
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
  /** When true, concurrent `getOrCreate` calls for one key share one create, as the real store's `coalesce`. */
  coalesce?: boolean
  /**
   * The real store's opt-in token gate, run before every create: a count below
   * `minTokens` is `bad_request` (not retryable) and nothing is created. Gemini
   * 3.x caches need at least 2048 tokens, which is what a host sets here.
   */
  preflight?: {
    minTokens: number
    countTokens: (input: FakeGoogleCacheCreateInput) => Promise<number>
  }
  /**
   * Create failures, one per create in order (after the preflight): the first
   * create throws the first error, and so on; once the list is spent creates
   * succeed. Each is classified as the real store classifies an SDK failure
   * (`classifyGoogleError` from `@gullabs/google`). A failed create stores
   * nothing and does not count in `created`.
   */
  failCreate?: Error | readonly Error[]
}

/** The distinct keys (with a value) of a list of opaque tool objects. */
function toolKindsOf(tools: readonly unknown[] | undefined): string[] {
  const kinds = new Set<string>()
  for (const tool of tools ?? []) {
    if (typeof tool !== 'object' || tool === null) continue
    for (const [kind, value] of Object.entries(tool)) {
      if (value !== undefined) kinds.add(kind)
    }
  }
  return [...kinds]
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
  private readonly inflight = new Map<string, Promise<FakeGoogleCacheHandle>>()
  private readonly coalesce: boolean
  private readonly preflight: FakeGoogleCacheStoreOptions['preflight']
  private readonly failCreate: Error[]
  private seq = 0

  constructor(opts: FakeGoogleCacheStoreOptions = {}) {
    this.coalesce = opts.coalesce === true
    this.preflight = opts.preflight
    this.failCreate =
      opts.failCreate === undefined
        ? []
        : Array.isArray(opts.failCreate)
          ? [...(opts.failCreate as readonly Error[])]
          : [opts.failCreate as Error]
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
    if (this.preflight !== undefined) {
      const counted = await this.preflight.countTokens(input)
      if (counted < this.preflight.minTokens) {
        throw new LlmError(
          `FakeGoogleCacheStore preflight: counted ${counted} token(s), below the configured minimum of ${this.preflight.minTokens} for model "${input.model}".`,
          { kind: 'bad_request', retryable: false },
        )
      }
    }
    const scripted = this.failCreate.shift()
    if (scripted !== undefined) {
      throw classifyError(await classifyAs('google', scripted))
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
      toolKinds: toolKindsOf(input.tools),
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
    if (this.coalesce) {
      const inFlight = this.inflight.get(mapKey)
      if (inFlight !== undefined) return inFlight
    }
    const doCreate = async (): Promise<FakeGoogleCacheHandle> => {
      const made = await factory()
      const handle = await this.create({ ...made, model: key.model })
      this.entries.set(mapKey, { handle, ttlSeconds: made.ttlSeconds })
      return handle
    }
    if (this.coalesce) {
      const promise = doCreate().finally(() => {
        this.inflight.delete(mapKey)
      })
      this.inflight.set(mapKey, promise)
      return promise
    }
    return doCreate()
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
    // A cache that is already gone is success, as in the real store (a 404, or
    // the 403 "CachedContent not found" Google sends for an expired one).
    this.caches.delete(handle.cacheName)
  }

  private isLive(handle: FakeGoogleCacheHandle): boolean {
    return handle.expiresAt.getTime() - this.skewMs > this.now()
  }
}
