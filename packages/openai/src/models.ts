/**
 * Model descriptors + registry for `@gullabs/openai`.
 *
 * Ships `gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra` and `gpt-6-luna`, in
 * that order. Every fact is documented, not live-verified (read 2026-11-20 from
 * https://developers.openai.com/api/docs/models and the model pages). No dated
 * snapshot id is published for these models, so no alias is declared.
 *
 * All four continue with `'state'` (ADR-029): calls send `store: false`, so the
 * next turn replays the provider's own output items (encrypted reasoning
 * included) from `transientProviderState` and sends only the new messages.
 *
 * @module
 */

import type { ModelDescriptor, ModelRegistry, ReasoningEffort } from '@gullabs/core'
import {
  createModelRegistry,
  toConfigJsonSchema,
  toConfigKeys,
  zodToStandardSchema,
} from '@gullabs/core'
import type { z } from 'zod'

import { OPENAI_INPUT_MIME_TYPES, OPENAI_MODEL_LIMITS } from './model-limits.js'
import type { OpenAiModelId } from './model-limits.js'
import { Gpt62AstraConfigSchema } from './model-config/gpt-6-2-astra.js'
import { Gpt62SolConfigSchema } from './model-config/gpt-6-2-sol.js'
import { Gpt61TerraConfigSchema } from './model-config/gpt-6-1-terra.js'
import { Gpt6LunaConfigSchema } from './model-config/gpt-6-luna.js'

export { Gpt62AstraConfigSchema } from './model-config/gpt-6-2-astra.js'
export { Gpt62SolConfigSchema } from './model-config/gpt-6-2-sol.js'
export { Gpt61TerraConfigSchema } from './model-config/gpt-6-1-terra.js'
export { Gpt6LunaConfigSchema } from './model-config/gpt-6-luna.js'

function descriptor(
  model: OpenAiModelId,
  configSchema: z.ZodType,
  admittedReasoningEfforts: ReadonlyArray<ReasoningEffort>,
  serviceTiers: readonly string[],
): ModelDescriptor {
  return {
    model,
    provider: 'openai',
    limits: OPENAI_MODEL_LIMITS[model],
    pricingFamily: model,
    capabilities: {
      inputMimeTypes: OPENAI_INPUT_MIME_TYPES,
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts,
      structuredOutput: true,
      nativeStructuredOutput: true,
      sampling: 'fixed',
      // Implicit prompt caching, "1,024 visible input tokens" minimum for GPT-5.6
      // and later (prompt-caching guide, read 2026-11-20). No explicit cache API
      // is exposed in this release.
      caching: { explicit: false, minTokens: 1_024 },
      grounding: false,
      structuredOutputWithTools: false,
      functionCalling: true,
      continuation: 'state',
      providerState: true,
      serviceTiers,
    },
    configSchema,
    configKeys: toConfigKeys(configSchema),
    configJsonSchema: toConfigJsonSchema(configSchema),
    validateConfig: zodToStandardSchema(configSchema),
  }
}

const GPT_6_2_EFFORTS: ReadonlyArray<ReasoningEffort> = Object.freeze(['low', 'medium'])
const GPT_6_FULL_EFFORTS: ReadonlyArray<ReasoningEffort> = Object.freeze([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export const gpt62AstraModelDescriptor: ModelDescriptor = descriptor(
  'gpt-6.2-astra',
  Gpt62AstraConfigSchema,
  GPT_6_2_EFFORTS,
  Object.freeze(['fast']),
)

export const gpt62SolModelDescriptor: ModelDescriptor = descriptor(
  'gpt-6.2-sol',
  Gpt62SolConfigSchema,
  GPT_6_2_EFFORTS,
  Object.freeze(['fast']),
)

export const gpt61TerraModelDescriptor: ModelDescriptor = descriptor(
  'gpt-6.1-terra',
  Gpt61TerraConfigSchema,
  GPT_6_FULL_EFFORTS,
  Object.freeze(['flex', 'fast']),
)

export const gpt6LunaModelDescriptor: ModelDescriptor = descriptor(
  'gpt-6-luna',
  Gpt6LunaConfigSchema,
  GPT_6_FULL_EFFORTS,
  Object.freeze(['flex', 'fast']),
)

/** Every model descriptor `@gullabs/openai` contributes, in registry order. */
export const openaiModelDescriptors: ModelDescriptor[] = [
  gpt62AstraModelDescriptor,
  gpt62SolModelDescriptor,
  gpt61TerraModelDescriptor,
  gpt6LunaModelDescriptor,
]

export const openaiRegistry: ModelRegistry = createModelRegistry(openaiModelDescriptors)
