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
  Gemini25FlashConfigSchema,
  Gemini25FlashLiteConfigSchema,
  Gemini25ProConfigSchema,
  Gemini31FlashLiteConfigSchema,
  Gemini31ProPreviewConfigSchema,
  Gemini35FlashLiteConfigSchema,
  Gemini36FlashConfigSchema,
  Gemini37FlashConfigSchema,
  Gemini38FlashConfigSchema,
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
const GEMMA_REASONING_EFFORTS = [
  'none',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>

export const geminiModelDescriptors: ModelDescriptor[] = [
  {
    model: 'gemini-2.5-pro',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-2.5-pro'],
    pricingFamily: 'gemini-2.5-pro',
    capabilities: {
      inputMimeTypes: GEMINI_INPUT_MIME_TYPES,
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_STANDARD_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25ProConfigSchema,
    configKeys: toConfigKeys(Gemini25ProConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini25ProConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25ProConfigSchema),
  },
  {
    model: 'gemini-2.5-flash',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-2.5-flash'],
    pricingFamily: 'gemini-2.5-flash',
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
    configSchema: Gemini25FlashConfigSchema,
    configKeys: toConfigKeys(Gemini25FlashConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini25FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25FlashConfigSchema),
  },
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
    model: 'gemini-3.7-flash',
    provider: 'google',
    limits: GOOGLE_MODEL_LIMITS['gemini-3.7-flash'],
    pricingFamily: 'gemini-3.7-flash',
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
    configSchema: Gemini37FlashConfigSchema,
    configKeys: toConfigKeys(Gemini37FlashConfigSchema),
    configJsonSchema: toConfigJsonSchema(Gemini37FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini37FlashConfigSchema),
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
]

// `grounding: true` on both Gemma descriptors rests on a live capture (ADR-013):
// `__fixtures__/gemma-grounding-2026-10-03.json`, three Search prompts per model.
// `groundingMetadata` came back on 5 of 6 calls; the one miss was `MAX_TOKENS` with
// an empty answer (thinking used the 800-token cap), not an absent feature.
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
