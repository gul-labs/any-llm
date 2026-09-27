/**
 * xAI-specific provider options for `@gullabs/xai`.
 *
 * Importing anything from this module (including this type-only re-export)
 * pulls in the `declare module '@gullabs/core'` augmentation below, which
 * adds the `xai` key to `ProviderOptionsMap`. `packages/xai/src/index.ts`
 * re-exports these types unconditionally so the augmentation always loads
 * when anything is imported from `@gullabs/xai`.
 *
 * @module
 */

export type XaiWebSearchTool = {
  type: 'web_search'
  allowedDomains?: string[]
  excludedDomains?: string[]
  enableImageUnderstanding?: boolean
  enableImageSearch?: boolean
}

export type XaiXSearchTool = {
  type: 'x_search'
  allowedXHandles?: string[]
  excludedXHandles?: string[]
  fromDate?: string
  toDate?: string
  enableImageUnderstanding?: boolean
  enableVideoUnderstanding?: boolean
}

export type XaiProviderOptions = {
  /** xAI conversation-routing cache key — maps to Responses API `prompt_cache_key`. */
  promptCacheKey?: string
  /** Server-side Live Search tools (`web_search`, `x_search`). */
  tools?: Array<XaiWebSearchTool | XaiXSearchTool>
  /** xAI-only; Gemini has no parallel-tool knob. */
  parallelToolCalls?: boolean
}

declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    xai?: XaiProviderOptions
  }
}
