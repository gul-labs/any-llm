/**
 * @gullabs/google — Gemini provider adapter over @google/genai.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { googleProvider } from '@gullabs/google'
 *
 * const client = createClient({
 *   ...composeProviders([googleProvider()]),
 * })
 *
 * const result = await client.generate(
 *   { provider: 'google', model: 'gemini-2.5-pro', messages: [...] },
 *   { auth: { apiKey: process.env.GEMINI_API_KEY! } },
 * )
 * ```
 *
 * @module
 */

export type {
  GoogleCachedContentRef,
  GoogleSafetySetting,
  GoogleSearchTool,
  GoogleProviderOptions,
} from './types.js'
export { geminiAdapter } from './adapter.js'
export { classifyGoogleError } from './errors.js'
export type { ClassifyGoogleErrorExtra } from './errors.js'
export type { GeminiAdapterOptions } from './adapter.js'
export { googleProvider } from './provider.js'
export {
  geminiModelDescriptors,
  gemmaModelDescriptors,
  defaultGeminiRegistry,
} from './models.js'
export { geminiPricingSource } from './cost.js'
export {
  GEMINI_PRICING,
  GEMINI_PRICED_TIERS,
  GEMINI_GROUNDING_PRICING,
  pricingVersion,
  resolveGeminiRates,
} from './pricing.js'
export type { GeminiGroundingRate, GeminiPricedTier, GeminiTierRates } from './pricing.js'
export type {
  GeminiClientLike,
  GeminiCountTokensParams,
  GeminiCountTokensResponseShape,
} from './client.js'
export {
  buildGoogleClient,
  requireApiKey,
  FLEX_DEFAULT_TIMEOUT_MS,
  STANDARD_DEFAULT_TIMEOUT_MS,
  TRANSPORT_TIMEOUT_BUFFER_MS,
} from './client.js'
export { isGeminiCapacityError } from './flex-fallback.js'
export { GEMINI_INPUT_MIME_TYPES } from './model-limits.js'
export type {
  GoogleFileHandle,
  GoogleFileStoreOptions,
  GeminiFilesClientLike,
  FileDeleteOptions,
} from './file-store.js'
export { GoogleFileStore } from './file-store.js'
export type {
  GoogleCacheHandle,
  CacheKey,
  GoogleCacheStoreOptions,
  GeminiCachesClientLike,
} from './cache-store.js'
export { GoogleCacheStore } from './cache-store.js'
export { dropMessagesFromSignatureState } from './thought-signatures.js'
export type {
  GoogleSignatureEntry,
  GoogleSignatureState,
  GoogleSignedKind,
} from './thought-signatures.js'
export { geminiContentToMessages } from './content-to-messages.js'
export type {
  GeminiContentToMessagesInput,
  GeminiContentToMessagesResult,
} from './content-to-messages.js'
