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
import { toConfigJsonSchema, zodToStandardSchema } from '@gullabs/core'

const GEMINI_25_PRO_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_LEVEL_PRO_PREVIEW_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_38_37_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
] as const satisfies ReadonlyArray<ReasoningEffort>
const GEMINI_25_FLASH_REASONING_EFFORTS = [
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
    pricingFamily: 'gemini-2.5-pro',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_25_PRO_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25ProConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini25ProConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25ProConfigSchema),
  },
  {
    model: 'gemini-2.5-flash',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25FlashConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini25FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25FlashConfigSchema),
  },
  {
    model: 'gemini-2.5-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-2.5-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'budget',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'tunable',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini25FlashLiteConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini25FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini25FlashLiteConfigSchema),
  },
  {
    model: 'gemini-3.1-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-3.1-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini31FlashLiteConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini31FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini31FlashLiteConfigSchema),
  },
  {
    model: 'gemini-3.1-pro-preview',
    provider: 'google',
    pricingFamily: 'gemini-3.1-pro-preview',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_LEVEL_PRO_PREVIEW_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini31ProPreviewConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini31ProPreviewConfigSchema),
    validateConfig: zodToStandardSchema(Gemini31ProPreviewConfigSchema),
  },
  {
    model: 'gemini-3.8-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.8-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_38_37_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      structuredOutputWithTools: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini38FlashConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini38FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini38FlashConfigSchema),
  },
  {
    model: 'gemini-3.7-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.7-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_38_37_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini37FlashConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini37FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini37FlashConfigSchema),
  },
  {
    model: 'gemini-3.6-flash',
    provider: 'google',
    pricingFamily: 'gemini-3.6-flash',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'fixed',
      caching: { explicit: true, minTokens: 4096 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini36FlashConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini36FlashConfigSchema),
    validateConfig: zodToStandardSchema(Gemini36FlashConfigSchema),
  },
  {
    model: 'gemini-3.5-flash-lite',
    provider: 'google',
    pricingFamily: 'gemini-3.5-flash-lite',
    capabilities: {
      reasoning: true,
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMINI_25_FLASH_REASONING_EFFORTS,
      sampling: 'fixed',
      // P-G5 did not capture a cache-create minimum. Leave the shipped
      // Flash-Lite floor until a probe pins 2048 vs 4096.
      caching: { explicit: true, minTokens: 2048 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['flex', 'standard'],
    },
    configSchema: Gemini35FlashLiteConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemini35FlashLiteConfigSchema),
    validateConfig: zodToStandardSchema(Gemini35FlashLiteConfigSchema),
  },
]

export const gemmaModelDescriptors: ModelDescriptor[] = [
  {
    model: 'gemma-4-31b-it',
    provider: 'google',
    capabilities: {
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMMA_REASONING_EFFORTS,
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      vision: true,
      sampling: 'tunable',
    },
    configSchema: Gemma431bItConfigSchema,
    configJsonSchema: toConfigJsonSchema(Gemma431bItConfigSchema),
    validateConfig: zodToStandardSchema(Gemma431bItConfigSchema),
  },
  {
    model: 'gemma-4-26b-a4b-it',
    provider: 'google',
    capabilities: {
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: GEMMA_REASONING_EFFORTS,
      structuredOutput: true,
      nativeStructuredOutput: true,
      grounding: true,
      vision: true,
      sampling: 'tunable',
    },
    configSchema: Gemma426bA4bItConfigSchema,
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
