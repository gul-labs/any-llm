/**
 * Model descriptor registry for @gullabs/google.
 *
 * Centralises Gemini/Gemma model knowledge: reasoning-effort vocabularies,
 * capability flags, and the built-in descriptor arrays. `@gullabs/core` owns
 * only the generic registry machinery (`ModelDescriptor`, `ModelRegistry`,
 * `createModelRegistry`) — this module supplies the Gemini-specific data.
 *
 * @module
 */

import type { ModelDescriptor, ModelRegistry, ReasoningEffort } from '@gullabs/core'
import { createModelRegistry } from '@gullabs/core'

import {
  Gemma426bA4bItConfigSchema,
  Gemma431bItConfigSchema,
  Gemini25FlashLiteConfigSchema,
  Gemini31FlashLiteConfigSchema,
  Gemini31ProPreviewConfigSchema,
  Gemini35FlashLiteConfigSchema,
  Gemini36FlashConfigSchema,
  Gemini38FlashConfigSchema,
  Gemini4ArgonConfigSchema,
  Gemini4CarbonConfigSchema,
  Gemini4HydrogenConfigSchema,
  Gemini4NeonConfigSchema,
} from './model-config/index.js'
import {
  GEMINI_INPUT_MIME_TYPES,
  GEMMA_INPUT_MIME_TYPES,
  GOOGLE_MODEL_LIMITS,
} from './model-limits.js'
import { toConfigJsonSchema, toConfigKeys, zodToStandardSchema } from '@gullabs/core'

const GEMINI_STANDARD_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_LEVEL_WITH_NONE_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_4_XHIGH_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMMA_REASONING_EFFORTS = [
  'none',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>

export const geminiModelDescriptors: ModelDescriptor[] = [
  {
    model: 'gemini-2.5-flash-lite',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-2.5-flash-lite'],
    pricingFamily: 'gemini-2.5-flash-lite',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_LEVEL_WITH_NONE_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25FlashLiteConfigSchema,
    configKeys: toConfigKeys(Gemini25FlashLiteConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini25FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25FlashLiteConfigSchema),
  },
  {
    model: 'gemini-3.1-flash-lite',
    provider: 'google',
    // Google's deprecations page (https://ai.google.dev/gemini-api/docs/deprecations,
    // "Page last updated" 2026-10-01, read 2026-10-03) lists a May 7, 2027
    // shutdown, replacement gemini-3.5-flash-lite.
    shutdownDate: '2027-05-07',
    limits: GOOGLE_MODEL_LIMITS['gemini-3.1-flash-lite'],
    pricingFamily: 'gemini-3.1-flash-lite',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_WITH_NONE_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 1024 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: false,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini31FlashLiteConfigSchema,
    configKeys: toConfigKeys(Gemini31FlashLiteConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini31FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini31FlashLiteConfigSchema),
  },
  {
    model: 'gemini-3.1-pro-preview',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-3.1-pro-preview'],
    pricingFamily: 'gemini-3.1-pro-preview',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_STANDARD_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 1024 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: false,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini31ProPreviewConfigSchema,
    configKeys: toConfigKeys(Gemini31ProPreviewConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini31ProPreviewConfigSchema),
    validateConfig: zodToStandardSchema(Gemini31ProPreviewConfigSchema),
  },
  {
    model: 'gemini-3.8-flash',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-3.8-flash'],
    pricingFamily: 'gemini-3.8-flash',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_STANDARD_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 1024 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: false,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini38FlashConfigSchema,
    configKeys: toConfigKeys(Gemini38FlashConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini38FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini38FlashConfigSchema),
  },
  {
    model: 'gemini-3.6-flash',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-3.6-flash'],
    pricingFamily: 'gemini-3.6-flash',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_WITH_NONE_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 1024 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: false,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini36FlashConfigSchema,
    configKeys: toConfigKeys(Gemini36FlashConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini36FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini36FlashConfigSchema),
  },
  {
    model: 'gemini-3.5-flash-lite',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-3.5-flash-lite'],
    pricingFamily: 'gemini-3.5-flash-lite',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_WITH_NONE_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 1024 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: false,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini35FlashLiteConfigSchema,
    configKeys: toConfigKeys(Gemini35FlashLiteConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini35FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini35FlashLiteConfigSchema),
  },
  // Gemini 4 (GA; documented, not live-verified: the model pages under
  // https://aistudio.google.com/docs/models, read 2026-11-20). Level reasoning
  // only; explicit caching is not supported ("returns an error"), and the implicit
  // cache minimum is 4,096 tokens; `structuredOutputWithTools` is absent because
  // nothing measured Search beside a response schema; Search with flex, the final
  // model turn, the default level and the 20-minute deadline are request rules
  // (request-rules.ts).
  {
    model: 'gemini-4-carbon',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-4-carbon'],
    pricingFamily: 'gemini-4-carbon',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_STANDARD_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: false, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini4CarbonConfigSchema,
    configKeys: toConfigKeys(Gemini4CarbonConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini4CarbonConfigSchema),
    validateConfig: zodToStandardSchema(Gemini4CarbonConfigSchema),
  },
  {
    model: 'gemini-4-argon',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-4-argon'],
    pricingFamily: 'gemini-4-argon',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_STANDARD_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: false, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini4ArgonConfigSchema,
    configKeys: toConfigKeys(Gemini4ArgonConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini4ArgonConfigSchema),
    validateConfig: zodToStandardSchema(Gemini4ArgonConfigSchema),
  },
  {
    model: 'gemini-4-neon',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-4-neon'],
    pricingFamily: 'gemini-4-neon',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_4_XHIGH_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: false, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini4NeonConfigSchema,
    configKeys: toConfigKeys(Gemini4NeonConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini4NeonConfigSchema),
    validateConfig: zodToStandardSchema(Gemini4NeonConfigSchema),
  },
  {
    model: 'gemini-4-hydrogen',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-4-hydrogen'],
    pricingFamily: 'gemini-4-hydrogen',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_4_XHIGH_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: false, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      continuation: 'history',
      providerState: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini4HydrogenConfigSchema,
    configKeys: toConfigKeys(Gemini4HydrogenConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini4HydrogenConfigSchema),
    validateConfig: zodToStandardSchema(Gemini4HydrogenConfigSchema),
  },
]

// Google's pricing page marks grounding "Not available" for Gemma 4 (read
// 2026-10), while `grounding: true` below rests on a live capture, so it is
// the capture, not the page, that this flag follows (ADR-013).
// `grounding: true` on both Gemma descriptors rests on a live capture (ADR-013):
// `__fixtures__/gemma-grounding-2026-10-03.json` (a derived summary of six calls, not the
// raw responses), three Search prompts per model. `groundingMetadata` came back on all 5
// completed calls; the sixth ended at `MAX_TOKENS` with an empty answer (thinking used the
// 800-token cap), which neither shows nor rules out grounding.
export const gemmaModelDescriptors: ModelDescriptor[] = [
  {
    model: 'gemma-4-31b-it',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemma-4-31b-it'],
    capabilities: {
      inputMimeTypes: GEMMA_INPUT_MIME_TYPES,
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMMA_REASONING_EFFORTS,
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      sampling: 'tunable',
    },
    configSchema: Gemma431bItConfigSchema,
    configKeys: toConfigKeys(Gemma431bItConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemma431bItConfigSchema),
    validateConfig: zodToStandardSchema(Gemma431bItConfigSchema),
  },
  {
    model: 'gemma-4-26b-a4b-it',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemma-4-26b-a4b-it'],
    capabilities: {
      inputMimeTypes: GEMMA_INPUT_MIME_TYPES,
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMMA_REASONING_EFFORTS,
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      sampling: 'tunable',
    },
    configSchema: Gemma426bA4bItConfigSchema,
    configKeys: toConfigKeys(Gemma426bA4bItConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemma426bA4bItConfigSchema),
    validateConfig: zodToStandardSchema(Gemma426bA4bItConfigSchema),
  },
]

/**
 * Pre-built registry of all built-in Gemini + Gemma descriptors.
 *
 * Most callers should prefer {@link googleProvider} (which bundles this same
 * descriptor set via `composeProviders`); this export remains for callers
 * that need a bare `ModelRegistry` without going through the plugin seam.
 */
export const defaultGeminiRegistry: ModelRegistry = createModelRegistry([
  ...geminiModelDescriptors,
  ...gemmaModelDescriptors,
])
