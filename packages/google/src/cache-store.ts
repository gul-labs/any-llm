/**
 * GoogleCacheStore — thin wrapper over the Gemini Context Cache API.
 *
 * Manages create / get-or-create / refresh / delete lifecycle for cached
 * contents.  In-memory cache entries are PROCESS-SCOPED; they are not shared
 * across processes, workers, or restarts.
 *
 * Injectable client and `now` function keep tests free of network and clock.
 *
 * @module
 */

import type { AuthMaterial, Logger } from '@gullabs/core'
import type { Content, Tool, ToolConfig } from '@google/genai'

import { requireApiKey } from './client.js'
import { classifyGoogleError } from './errors.js'
import { LlmError, redactSecrets } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A handle to a cached content resource in the Gemini Context Cache API.
 *
 * Pass `cacheName` as `providerOptions.google.cachedContent` in LlmRequest.
 */
export interface GoogleCacheHandle {
  /** Resource name, e.g. "cachedContents/xyz". */
  cacheName: string
  /**
   * Local view of when the cache expires (server-authoritative; computed from
   * ttl or parsed from the server response `expireTime`).
   */
  expiresAt: Date
  /** Caches are model-bound; never use a handle with a different model. */
  model: string
}

/** Key used to look up or create an entry in the in-process cache map. */
export interface CacheKey {
  model: string
  /** Caller-chosen stable identifier, e.g. a hash of the cached content. */
  stableKey: string
}

/**
 * Minimal structural interface for the Gemini Caches client surface we use.
 * Satisfied by the real `ai.caches` object or a test fake.
 */
export interface GeminiCachesClientLike {
  create(params: {
    model: string
    config: {
      contents?: Content[]
      systemInstruction?: Content | string
      tools?: Tool[]
      toolConfig?: ToolConfig
      ttl?: string
      displayName?: string
    }
  }): Promise<{ name?: string; model?: string; expireTime?: string }>

  update(params: {
    name: string
    config: { ttl?: string; expireTime?: string }
  }): Promise<{ name?: string; expireTime?: string }>

  delete(params: { name: string }): Promise<unknown>
}

export interface GoogleCacheStoreOptions {
  auth: AuthMaterial
  /** Injectable client for tests; skips SDK import when provided. */
  client?: GeminiCachesClientLike
  /**
   * When true, concurrent `getOrCreate` calls for the same key share one
   * in-flight create.  Default false.
   */
  coalesce?: boolean
  /**
   * Subtracted from the local expiry so we stop using a cache slightly before
   * the server evicts it.  Default 30 s.
   */
  expirySkewSeconds?: number
  /** Called on delete failures instead of rethrowing. */
  onDeleteError?: (cacheName: string, err: unknown) => void
  /** Optional structured logger. When provided, routes delete failures to logger.error. */
  logger?: Logger
  /** Injectable clock for deterministic tests.  Default: `Date.now`. */
  now?: () => number
  /**
   * Opt-in pre-flight token-count gate applied before every cache create
   * (both `create()` directly and the `getOrCreate()` path it delegates to,
   * including the coalesced path — enforced once, inside `create()`, so
   * there is no separate "in-flight" gap to close).
   */
  preflight?: {
    /** Minimum token count required before a cache create is allowed to proceed. */
    minTokens: number
    /**
     * Counts tokens for the exact token-bearing payload of the impending
     * create — `model` + `contents` + `systemInstruction` + `tools` only.
     * `toolConfig`, `ttl` and `displayName` are excluded: they carry no tokens
     * and are irrelevant to the pre-flight check.
     *
     * This callback receives genai-native `Content[]`/`Content|string` — it
     * does NOT receive the library's `Message[]` shape and there is no
     * automatic conversion between the two (explicit seam, by design). Hosts
     * using genai-native content directly can wire this to a raw
     * `client.models.countTokens` call; hosts building from the library's
     * `Message[]` should call `@gullabs/core`'s `client.countTokens` rather
     * than expecting this callback to convert for them.
     */
    countTokens: (payload: {
      model: string
      contents?: Content[]
      systemInstruction?: Content | string
      tools?: Tool[]
    }) => Promise<number>
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_SKEW_SECONDS = 30
const DEFAULT_EXTENSION_SECONDS = 3600

async function buildCachesClient(auth: AuthMaterial): Promise<GeminiCachesClientLike> {
  const { GoogleGenAI } = await import('@google/genai')

  const ai = new GoogleGenAI({ apiKey: requireApiKey(auth) })

  return {
    async create(params) {
      const result = await (
        ai.caches.create as (p: unknown) => Promise<{
          name?: string
          model?: string
          expireTime?: string
        }>
      )(params)
      return result
    },

    async update(params) {
      const result = await (
        ai.caches.update as (p: unknown) => Promise<{
          name?: string
          expireTime?: string
        }>
      )(params)
      return result
    },

    async delete(params) {
      await (ai.caches.delete as (p: unknown) => Promise<unknown>)(params)
    },
  }
}

// ---------------------------------------------------------------------------
// GoogleCacheStore
// ---------------------------------------------------------------------------

interface EntryRecord {
  handle: GoogleCacheHandle
  /** Original ttlSeconds used to create this entry; used as extension default. */
  ttlSeconds: number
}

/**
 * Process-scoped helper for the Gemini Context Cache API.
 *
 * NOTE: `getOrCreate` reuse is PROCESS-SCOPED only.  Entries survive only for
 * the lifetime of this `GoogleCacheStore` instance.  Across restarts, new
 * caches will be created (and old ones will be server-evicted after their TTL).
 *
 * **Auth snapshot note:** this store captures the `AuthMaterial` at construction
 * time and memoizes a single SDK client from it (`clientPromise`).  This is
 * correct and sufficient for static API keys.  If refreshable credentials
 * (short-lived OAuth/STS tokens) are added in the future, this memoization is
 * the seam that will need rework: the cached client would hold stale credentials
 * for the lifetime of a long-lived store instance.  At that point, the store
 * will need to either rebuild the client on each operation or accept a
 * credential-resolver callback rather than a plain `AuthMaterial` value.
 * See ADR-020 in DECISIONS.md.
 */
export class GoogleCacheStore {
  private readonly auth: AuthMaterial
  private readonly clientOverride: GeminiCachesClientLike | undefined
  private readonly coalesce: boolean
  private readonly skewMs: number
  private readonly onDeleteError: (cacheName: string, err: unknown) => void
  private readonly logger: Logger | undefined
  private readonly now: () => number
  private readonly preflight: GoogleCacheStoreOptions['preflight']

  /** Memoised client promise — built at most once per store instance. */
  private clientPromise: Promise<GeminiCachesClientLike> | undefined

  /** In-process cache of live handles, keyed by `${model}:${stableKey}`. */
  private readonly entries: Map<string, EntryRecord> = new Map()

  /** In-flight create promises when coalescing is enabled. */
  private readonly inflight: Map<string, Promise<GoogleCacheHandle>> = new Map()

  constructor(opts: GoogleCacheStoreOptions) {
    this.auth = opts.auth
    this.clientOverride = opts.client
    this.coalesce = opts.coalesce ?? false
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.logger = opts.logger
    this.onDeleteError =
      opts.onDeleteError ??
      ((cacheName, err) => {
        if (this.logger !== undefined) {
          this.logger.error(
            { name: cacheName, error: redactSecrets(classifyGoogleError(err).message) },
            'gemini.cache.delete.failed',
          )
        } else {
          console.error(
            `[GoogleCacheStore] delete failed for "${cacheName}":`,
            redactSecrets(classifyGoogleError(err).message),
          )
        }
      })
    this.now = opts.now ?? (() => Date.now())
    this.preflight = opts.preflight
  }

  private getClient(): Promise<GeminiCachesClientLike> {
    if (this.clientOverride !== undefined) return Promise.resolve(this.clientOverride)
    if (this.clientPromise === undefined) {
      this.clientPromise = buildCachesClient(this.auth)
    }
    return this.clientPromise
  }

  private isLive(handle: GoogleCacheHandle): boolean {
    return handle.expiresAt.getTime() - this.skewMs > this.now()
  }

  /**
   * Create a new cached content resource.
   *
   * The `expiresAt` on the returned handle is computed from the server's
   * `expireTime` when available, with a local-clock fallback of
   * `now + ttlSeconds * 1000`.
   */
  async create(input: {
    model: string
    ttlSeconds: number
    contents?: Content[]
    systemInstruction?: Content | string
    /**
     * Tool declarations to store in the cache. Gemini rejects a request that
     * sends `tools` or `toolConfig` together with `cachedContent`, so a cache
     * used by a tool-calling call must hold them (the adapter rejects the
     * combination before dispatch).
     */
    tools?: Tool[]
    toolConfig?: ToolConfig
    displayName?: string
  }): Promise<GoogleCacheHandle> {
    if (this.preflight !== undefined) {
      const counted = await this.preflight.countTokens({
        model: input.model,
        ...(input.contents !== undefined ? { contents: input.contents } : {}),
        ...(input.systemInstruction !== undefined
          ? { systemInstruction: input.systemInstruction }
          : {}),
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
      })
      if (counted < this.preflight.minTokens) {
        throw new LlmError(
          `GoogleCacheStore preflight: counted ${counted} token(s), below the configured ` +
            `minimum of ${this.preflight.minTokens} for model "${input.model}".`,
          { kind: 'bad_request', retryable: false },
        )
      }
    }

    const client = await this.getClient()

    const config: {
      ttl: string
      contents?: Content[]
      systemInstruction?: Content | string
      tools?: Tool[]
      toolConfig?: ToolConfig
      displayName?: string
    } = { ttl: `${input.ttlSeconds}s` }

    if (input.contents !== undefined) config.contents = input.contents
    if (input.systemInstruction !== undefined)
      config.systemInstruction = input.systemInstruction
    if (input.tools !== undefined) config.tools = input.tools
    if (input.toolConfig !== undefined) config.toolConfig = input.toolConfig
    if (input.displayName !== undefined) config.displayName = input.displayName

    let resp: { name?: string; model?: string; expireTime?: string }
    try {
      resp = await client.create({ model: input.model, config })
    } catch (e) {
      throw classifyGoogleError(e)
    }

    if (resp.name === undefined || resp.name.length === 0) {
      // Provider fault, not caller fault: the SDK call succeeded but the
      // payload is malformed — classify as a server error. NOT retryable:
      // create() is side-effecting and not idempotent — the provider may have
      // already created the cached content even though the payload carries no
      // name, so there is no handle to clean up and an automatic retry could
      // orphan/duplicate provider-side resources.
      throw new LlmError('Cache create response missing required field: name', {
        kind: 'server',
        retryable: false,
        provider: 'google',
      })
    }

    const fallbackExpiry = new Date(this.now() + input.ttlSeconds * 1000)
    const expiresAt =
      resp.expireTime !== undefined && resp.expireTime.length > 0
        ? new Date(resp.expireTime)
        : fallbackExpiry

    return {
      cacheName: resp.name,
      model: resp.model ?? input.model,
      expiresAt,
    }
  }

  /**
   * Return a live cached-content handle, creating one if none exists or the
   * cached entry has expired (accounting for skew).
   *
   * Reuse is PROCESS-SCOPED only — this store instance's in-memory map.
   *
   * When `coalesce` is enabled, concurrent calls for the same key share one
   * in-flight create.
   */
  async getOrCreate(
    key: CacheKey,
    factory: () => Promise<{
      ttlSeconds: number
      contents?: Content[]
      systemInstruction?: Content | string
      tools?: Tool[]
      toolConfig?: ToolConfig
    }>,
  ): Promise<GoogleCacheHandle> {
    const mapKey = `${key.model}:${key.stableKey}`

    // Return existing live entry if available.
    const existing = this.entries.get(mapKey)
    if (existing !== undefined && this.isLive(existing.handle)) {
      return existing.handle
    }

    // If coalescing, piggyback on an in-flight create for this key.
    if (this.coalesce) {
      const inFlight = this.inflight.get(mapKey)
      if (inFlight !== undefined) {
        return inFlight
      }
    }

    const doCreate = async (): Promise<GoogleCacheHandle> => {
      const factoryResult = await factory()
      const handle = await this.create({
        model: key.model,
        ttlSeconds: factoryResult.ttlSeconds,
        ...(factoryResult.contents !== undefined
          ? { contents: factoryResult.contents }
          : {}),
        ...(factoryResult.systemInstruction !== undefined
          ? { systemInstruction: factoryResult.systemInstruction }
          : {}),
        ...(factoryResult.tools !== undefined ? { tools: factoryResult.tools } : {}),
        ...(factoryResult.toolConfig !== undefined
          ? { toolConfig: factoryResult.toolConfig }
          : {}),
      })
      this.entries.set(mapKey, { handle, ttlSeconds: factoryResult.ttlSeconds })
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

  /**
   * Extend the cache TTL if it will expire within `thresholdSeconds`.
   *
   * Fail-open: if the update call throws, the original handle is returned
   * unchanged.  This method NEVER throws.
   *
   * @param handle - Handle to potentially refresh.
   * @param opts.thresholdSeconds - Extend if expiry is within this many seconds.
   *   Default 300.
   * @param opts.extensionSeconds - New TTL to set.  Default: original TTL from
   *   entries map, or 3600 s when the handle was not created via `getOrCreate`.
   */
  async refreshIfExpiringSoon(
    handle: GoogleCacheHandle,
    opts?: { thresholdSeconds?: number; extensionSeconds?: number },
  ): Promise<GoogleCacheHandle> {
    const thresholdMs = (opts?.thresholdSeconds ?? 300) * 1000

    if (handle.expiresAt.getTime() - this.now() > thresholdMs) {
      // Not near expiry — return unchanged.
      return handle
    }

    // Find the original ttl from the entries map for this handle.
    let extensionSeconds = opts?.extensionSeconds
    if (extensionSeconds === undefined) {
      for (const entry of this.entries.values()) {
        if (entry.handle.cacheName === handle.cacheName) {
          extensionSeconds = entry.ttlSeconds
          break
        }
      }
      extensionSeconds = extensionSeconds ?? DEFAULT_EXTENSION_SECONDS
    }

    try {
      const client = await this.getClient()
      const resp = await client.update({
        name: handle.cacheName,
        config: { ttl: `${extensionSeconds}s` },
      })

      const fallbackExpiry = new Date(this.now() + extensionSeconds * 1000)
      const newExpiresAt =
        resp.expireTime !== undefined && resp.expireTime.length > 0
          ? new Date(resp.expireTime)
          : fallbackExpiry

      const newHandle: GoogleCacheHandle = {
        cacheName: handle.cacheName,
        model: handle.model,
        expiresAt: newExpiresAt,
      }

      // Update the entries map entry if this handle is tracked.
      for (const [k, entry] of this.entries.entries()) {
        if (entry.handle.cacheName === handle.cacheName) {
          this.entries.set(k, { handle: newHandle, ttlSeconds: extensionSeconds })
          break
        }
      }

      return newHandle
    } catch {
      // Fail-open: return original handle unchanged.
      return handle
    }
  }

  /**
   * Delete a cached content resource.
   *
   * Errors are forwarded to `onDeleteError` and NOT rethrown.
   * The handle is removed from the in-process entries map regardless.
   */
  async delete(handle: GoogleCacheHandle): Promise<void> {
    // Always remove from local map, even if delete fails.
    for (const [k, entry] of this.entries.entries()) {
      if (entry.handle.cacheName === handle.cacheName) {
        this.entries.delete(k)
        break
      }
    }

    try {
      const client = await this.getClient()
      await client.delete({ name: handle.cacheName })
    } catch (err) {
      this.onDeleteError(handle.cacheName, err)
    }
  }
}
