/**
 * Google-specific provider options for `@gullabs/google`.
 *
 * Importing anything from this module (including this type-only re-export)
 * pulls in the `declare module '@gullabs/core'` augmentation below, which
 * adds the `google` key to `ProviderOptionsMap`. `packages/google/src/index.ts`
 * re-exports these types unconditionally so the augmentation always loads
 * when anything is imported from `@gullabs/google`.
 *
 * @module
 */

import type { GoogleCacheHandle } from './cache-store.js'
import type { GoogleSafetyCategory, GoogleSafetyThreshold } from './safety-settings.js'

export type GoogleSafetySetting = {
  /** A documented `HarmCategory`; see `safety-settings.ts` for the source. */
  category: GoogleSafetyCategory
  /** A documented `HarmBlockThreshold`. */
  threshold: GoogleSafetyThreshold
}

export type GoogleSearchTool = {
  googleSearch: Record<string, never>
}

/**
 * A cached-content reference: the resource name, or `{ cacheName, toolKinds }`
 * taken from a `GoogleCacheHandle` (`handle.toolKinds` records which tools the
 * cache holds). Pass those two fields, not the whole handle: the other fields
 * are typed `never` here and the schema is strict. The request sent to Google
 * carries only the name. A bare name says nothing about what the cache holds,
 * so a Search fee in the response is priced from the observed queries and the
 * cost is `estimated`; a handle whose `toolKinds` lists `googleSearch` marks the
 * call as a Search call up front.
 */
export type GoogleCachedContentRef =
  | string
  | (Pick<GoogleCacheHandle, 'cacheName' | 'toolKinds'> & {
      expiresAt?: never
      model?: never
      totalTokenCount?: never
    })

export type GoogleProviderOptions = {
  /** Google cached content: the resource name, or a handle that records the cache's tool kinds. Explicit-caching models only. */
  cachedContent?: GoogleCachedContentRef
  /** Allowlisted Google safety settings. */
  safetySettings?: GoogleSafetySetting[]
  /** Exact Google tool declarations admitted by the selected model schema. */
  tools?: GoogleSearchTool[]
  /** Allowlisted Google transport options. */
  httpOptions?: {
    /** Per-request Google transport timeout in milliseconds. */
    timeout?: number
  }
  /** Allow provider fallback from flex when flex was explicitly selected. */
  flexFallback?: boolean
  /**
   * Admit `googleSearch` together with `output.jsonSchema` on a model that does
   * not admit the pair by default. Opting in turns on {@link requireGrounding}
   * unless it is set to `false`, because Search can be skipped silently when a
   * response schema is attached. Requires both `googleSearch` and a schema.
   */
  allowSchemaWithSearch?: boolean
  /**
   * Fail the call unless the response proves Search ran: `groundingMetadata`
   * present with at least one `webSearchQueries` entry. The check judges only a
   * candidate that finished normally (`STOP`, or no finish reason). Without the
   * proof it throws a `server` error with reason `grounding_missing` and the
   * attempt's usage is recorded; the error is retryable when no response schema
   * is attached and not retryable when one is (the same request keeps missing).
   * A `MAX_TOKENS` or other abnormal finish with no proof is not judged: it
   * returns, with its own finish reason (`length`), and a filtered candidate
   * throws its `content_filter` error. Requires `googleSearch`. Defaults to
   * `true` when {@link allowSchemaWithSearch} is `true`, else `false`.
   */
  requireGrounding?: boolean
}

declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    google?: GoogleProviderOptions
  }
}
