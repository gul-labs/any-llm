/**
 * @gullabs/xai — xAI Grok provider adapter for any-llm (Responses API).
 *
 * Client + provider-options augmentation + adapter (request/response
 * mapping, error classification, usage accounting) + model descriptor +
 * pricing + `xaiProvider` plugin factory.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { xaiProvider } from '@gullabs/xai'
 *
 * const client = createClient({
 *   ...composeProviders([xaiProvider()]),
 * })
 *
 * const result = await client.generate(
 *   { provider: 'xai', model: 'grok-4.6', messages: [...] },
 *   { auth: { apiKey: process.env.XAI_API_KEY! } },
 * )
 * ```
 *
 * @module
 */

export type { XaiProviderOptions, XaiWebSearchTool, XaiXSearchTool } from './types.js'
export type {
  XaiClientLike,
  XaiInputTextPart,
  XaiInputImagePart,
  XaiInputFilePart,
  XaiInputContentPart,
  XaiInputItem,
  XaiRequestInputItem,
  XaiReplayState,
  XaiTextFormat,
  XaiResponseCreateParams,
  XaiReasoningSummaryPart,
  XaiReasoningOutputItem,
  XaiOutputTextPart,
  XaiMessageOutputItem,
  XaiOutputItem,
  XaiUsageShape,
  XaiResponseShape,
  XaiRequestOptions,
  XaiResponseMeta,
  XaiTransport,
} from './client.js'
export {
  buildXaiClient,
  requireApiKey,
  XAI_DEFAULT_TIMEOUT_MS,
  XAI_TIMEOUT_BUFFER_MS,
} from './client.js'
export { xaiAdapter, classifyXaiError } from './adapter.js'
export type { XaiAdapterOptions, XaiSdkDeadline } from './adapter.js'
export {
  XaiFileStore,
  XAI_FILE_TTL_MIN_SECONDS,
  XAI_FILE_TTL_MAX_SECONDS,
  XAI_FILE_MAX_BYTES,
  XAI_FILES_DEFAULT_BASE_URL,
} from './file-store.js'
export type {
  XaiFileHandle,
  XaiFileUploadInput,
  XaiFileListOptions,
  XaiFileListResult,
  XaiFileStoreOptions,
  FileDeleteOptions,
} from './file-store.js'
export {
  Grok45ConfigSchema,
  Grok46ConfigSchema,
  Grok47ConfigSchema,
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  grok47ModelDescriptor,
  xaiModelDescriptors,
  xaiRegistry,
} from './models.js'
export {
  XAI_PRICING,
  XAI_TOOL_RATE_MICRO_USD,
  xaiPricingVersion,
  computeXaiCost,
  xaiPricingSource,
} from './pricing.js'
export type { XaiModelRates } from './pricing.js'
export { xaiProvider } from './provider.js'
