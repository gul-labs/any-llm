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

export type GoogleSafetySetting = {
  category: string
  threshold: string
}

export type GoogleSearchTool = {
  googleSearch: Record<string, never>
}

export type GoogleProviderOptions = {
  /** Google cached content resource name. */
  cachedContent?: string
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
   * present with at least one `webSearchQueries` entry. A response without that
   * proof throws a retryable `server` error with reason `grounding_missing`,
   * and the attempt's usage is recorded. Requires `googleSearch`. Defaults to
   * `true` when {@link allowSchemaWithSearch} is `true`, else `false`.
   */
  requireGrounding?: boolean
}

declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    google?: GoogleProviderOptions
  }
}
