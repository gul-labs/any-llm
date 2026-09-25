/**
 * Model descriptor + registry for @gullabs/xai.
 *
 * Ships two canonical models: `grok-4.5` and `grok-4.6`. xAI aliases
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
  zodToStandardSchema,
} from '@gullabs/core'

import { Grok45ConfigSchema } from './model-config/grok-4-5.js'
import { Grok46ConfigSchema } from './model-config/grok-4-6.js'

export { Grok45ConfigSchema } from './model-config/grok-4-5.js'
export { Grok46ConfigSchema } from './model-config/grok-4-6.js'

export const grok45ModelDescriptor: ModelDescriptor = {
  model: 'grok-4.5',
  provider: 'xai',
  pricingFamily: 'grok-4.5',
  capabilities: {
    reasoning: true,
    reasoningApi: 'level',
    admittedReasoningEfforts: ['low', 'medium', 'high'],
    structuredOutput: true,
    nativeStructuredOutput: true,
    vision: true,
    audioInput: false,
    sampling: 'tunable',
    caching: { explicit: false, minTokens: 0 },
    grounding: true,
    functionCalling: true,
    serviceTiers: ['priority'],
  },
  configSchema: Grok45ConfigSchema,
  configJsonSchema: toConfigJsonSchema(Grok45ConfigSchema),
  validateConfig: zodToStandardSchema(Grok45ConfigSchema),
}

export const grok46ModelDescriptor: ModelDescriptor = {
  model: 'grok-4.6',
  provider: 'xai',
  pricingFamily: 'grok-4.6',
  capabilities: {
    reasoning: true,
    reasoningApi: 'level',
    admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    structuredOutput: true,
    nativeStructuredOutput: true,
    vision: true,
    audioInput: false,
    sampling: 'tunable',
    caching: { explicit: false, minTokens: 0 },
    grounding: true,
    functionCalling: true,
    serviceTiers: ['priority'],
  },
  configSchema: Grok46ConfigSchema,
  configJsonSchema: toConfigJsonSchema(Grok46ConfigSchema),
  validateConfig: zodToStandardSchema(Grok46ConfigSchema),
}

/** Every model descriptor `@gullabs/xai` contributes. */
export const xaiModelDescriptors: ModelDescriptor[] = [
  grok45ModelDescriptor,
  grok46ModelDescriptor,
]

export const xaiRegistry: ModelRegistry = createModelRegistry(xaiModelDescriptors)
