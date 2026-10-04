/**
 * Model descriptor + registry for @gullabs/xai.
 *
 * Ships `grok-4.5`, `grok-4.6`, and `grok-4.7`. xAI aliases
 * (`grok-4.5-latest`, `grok-build-latest`) visible in `/v1/models` are
 * intentionally NOT registered (reject-don't-map). `grok-4.6` has no
 * aliases as of the 2026-08-12 `/v1/models` listing.
 *
 * @module
 */

import type { ModelDescriptor, ModelRegistry } from '@gullabs/core'
import {
  createModelRegistry,
  toConfigJsonSchema,
  toConfigKeys,
  zodToStandardSchema,
} from '@gullabs/core'

import { XAI_INPUT_MIME_TYPES, XAI_MODEL_LIMITS } from './model-limits.js'
import { Grok45ConfigSchema } from './model-config/grok-4-5.js'
import { Grok46ConfigSchema } from './model-config/grok-4-6.js'
import { Grok47ConfigSchema } from './model-config/grok-4-7.js'

export { Grok45ConfigSchema } from './model-config/grok-4-5.js'
export { Grok46ConfigSchema } from './model-config/grok-4-6.js'
export { Grok47ConfigSchema } from './model-config/grok-4-7.js'

export const grok45ModelDescriptor: ModelDescriptor = {
  model: 'grok-4.5',
  provider: 'xai',
  limits: XAI_MODEL_LIMITS['grok-4.5'],
  pricingFamily: 'grok-4.5',
  capabilities: {
    inputMimeTypes: XAI_INPUT_MIME_TYPES,
    reasoning: true,
    reasoningApi: 'level',
    admittedReasoningEfforts: ['low', 'medium', 'high'],
    structuredOutput: true,
    nativeStructuredOutput: true,
    sampling: 'tunable',
    caching: { explicit: false, minTokens: 0 },
    grounding: true,
    structuredOutputWithTools: true,
    functionCalling: true,
    serviceTiers: ['priority'],
  },
  configSchema: Grok45ConfigSchema,
  configKeys: toConfigKeys(Grok45ConfigSchema),
  configJsonSchema: toConfigJsonSchema(Grok45ConfigSchema),
  validateConfig: zodToStandardSchema(Grok45ConfigSchema),
}

export const grok46ModelDescriptor: ModelDescriptor = {
  model: 'grok-4.6',
  provider: 'xai',
  limits: XAI_MODEL_LIMITS['grok-4.6'],
  pricingFamily: 'grok-4.6',
  capabilities: {
    inputMimeTypes: XAI_INPUT_MIME_TYPES,
    reasoning: true,
    reasoningApi: 'level',
    admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    structuredOutput: true,
    nativeStructuredOutput: true,
    sampling: 'tunable',
    caching: { explicit: false, minTokens: 0 },
    grounding: true,
    structuredOutputWithTools: true,
    functionCalling: true,
    serviceTiers: ['priority'],
  },
  configSchema: Grok46ConfigSchema,
  configKeys: toConfigKeys(Grok46ConfigSchema),
  configJsonSchema: toConfigJsonSchema(Grok46ConfigSchema),
  validateConfig: zodToStandardSchema(Grok46ConfigSchema),
}

export const grok47ModelDescriptor: ModelDescriptor = {
  model: 'grok-4.7',
  provider: 'xai',
  limits: XAI_MODEL_LIMITS['grok-4.7'],
  pricingFamily: 'grok-4.7',
  capabilities: {
    inputMimeTypes: XAI_INPUT_MIME_TYPES,
    reasoning: true,
    reasoningApi: 'level',
    admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    structuredOutput: true,
    nativeStructuredOutput: true,
    sampling: 'tunable',
    caching: { explicit: false, minTokens: 0 },
    grounding: true,
    structuredOutputWithTools: true,
    functionCalling: true,
    continuation: 'state',
    providerState: true,
    serviceTiers: ['priority'],
  },
  configSchema: Grok47ConfigSchema,
  configKeys: toConfigKeys(Grok47ConfigSchema),
  configJsonSchema: toConfigJsonSchema(Grok47ConfigSchema),
  validateConfig: zodToStandardSchema(Grok47ConfigSchema),
}

/** Every model descriptor `@gullabs/xai` contributes. */
export const xaiModelDescriptors: ModelDescriptor[] = [
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  grok47ModelDescriptor,
]

export const xaiRegistry: ModelRegistry = createModelRegistry(xaiModelDescriptors)
