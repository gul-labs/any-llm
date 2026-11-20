/**
 * @gullabs/openai — OpenAI provider adapter for any-llm (Responses API).
 *
 * Adapter (request/response mapping, error classification, usage accounting),
 * model descriptors with strict per-model config schemas, pricing and the
 * `openaiProvider` plugin factory. This release has no `providerOptions` lane,
 * so it adds no key to `ProviderOptionsMap`.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { openaiProvider } from '@gullabs/openai'
 *
 * const client = createClient({ ...composeProviders([openaiProvider()]) })
 *
 * const result = await client.generate(
 *   { provider: 'openai', model: 'gpt-6.2-sol', messages: [...] },
 *   { auth: { apiKey: process.env.OPENAI_API_KEY! } },
 * )
 * ```
 *
 * @module
 */

export type {
  OpenAiClientLike,
  OpenAiInputTextPart,
  OpenAiInputImagePart,
  OpenAiInputContentPart,
  OpenAiInputMessage,
  OpenAiAssistantInputMessage,
  OpenAiFunctionCallInputItem,
  OpenAiFunctionCallOutputInputItem,
  OpenAiRequestInputItem,
  OpenAiReplayState,
  OpenAiTextFormat,
  OpenAiFunctionTool,
  OpenAiResponseCreateParams,
  OpenAiOutputItem,
  OpenAiUsageShape,
  OpenAiResponseShape,
  OpenAiResponseMeta,
  OpenAiRequestOptions,
} from './client.js'
export {
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_TIMEOUT_MS,
  OPENAI_TIMEOUT_BUFFER_MS,
  OPENAI_MAX_TIMEOUT_MS,
} from './client.js'
export { openaiAdapter, classifyOpenAiError } from './adapter.js'
export type { OpenAiAdapterOptions } from './adapter.js'
export {
  Gpt62AstraConfigSchema,
  Gpt62SolConfigSchema,
  Gpt61TerraConfigSchema,
  Gpt6LunaConfigSchema,
  gpt62AstraModelDescriptor,
  gpt62SolModelDescriptor,
  gpt61TerraModelDescriptor,
  gpt6LunaModelDescriptor,
  openaiModelDescriptors,
  openaiRegistry,
} from './models.js'
export { OPENAI_JSON_SCHEMA_PROFILE } from './json-schema.js'
export {
  OPENAI_PRICING,
  OPENAI_LONG_CONTEXT_THRESHOLD,
  OPENAI_USAGE_DETAIL_KEYS,
  openaiPricingVersion,
  computeOpenAiCost,
  openaiPricingSource,
} from './pricing.js'
export type { OpenAiModelRates, OpenAiBandRates } from './pricing.js'
export { openaiProvider } from './provider.js'
