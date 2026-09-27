/**
 * Model descriptor registry for @gullabs/core.
 *
 * Centralises model/provider knowledge. Descriptors are keyed by the pair
 * (`provider`, `model`); unknown pairs fail fast at call time.
 *
 * Core owns only the generic registry machinery — zero provider knowledge.
 * Each provider package (e.g. `@gullabs/google`) builds and exports its own
 * descriptor arrays via {@link createModelRegistry}.
 *
 * @module
 */

import type * as z from 'zod'

import { LlmError } from './errors.js'
import type { StandardSchemaV1 } from './standard-schema.js'
import type { JsonValue, ReasoningEffort } from './types.js'

export interface ModelDescriptor {
  /**
   * Bare provider-native model identifier — used as the exact-match key and
   * as the prefix for longest-prefix matching (e.g. `"gemini-2.5-pro"` also
   * matches `"gemini-2.5-pro-001"`). Identity for a descriptor is the pair
   * (`provider`, `model`); the same bare `model` string may be registered
   * under multiple providers with different config schemas.
   */
  model: string
  /** Provider identifier (e.g. `"google"`). Must match the adapter's `id`. */
  provider: string
  /**
   * Key into the pricing table (e.g. `"gemini-2.5-pro"`).
   * When omitted, cost computation falls back to the pricing table's own
   * prefix-match logic.
   */
  pricingFamily?: string
  /** Capability flags for routing and adapter logic. */
  capabilities?: {
    reasoning?: boolean
    structuredOutput?: boolean
    nativeStructuredOutput?: boolean
    vision?: boolean
    audioInput?: boolean
    reasoningApi?: 'budget' | 'level'
    admittedReasoningEfforts?: ReadonlyArray<ReasoningEffort>
    sampling?: 'tunable' | 'fixed'
    caching?: { explicit: boolean; minTokens: number }
    grounding?: boolean
    /**
     * Structured output combined with provider built-in tools (Google:
     * `googleSearch`). Absent or false means the adapter must reject that
     * combination. The adapter reads this flag and carries no per-model list.
     */
    structuredOutputWithTools?: boolean
    functionCalling?: boolean
    /** Requires exact prior wire input/output for stateless conversation replay. */
    statelessReasoningReplay?: boolean
    serviceTiers?: readonly string[]
  }
  /** Zod runtime schema for the full per-model config contract. */
  configSchema: z.ZodType
  /** JSON Schema derived from {@link configSchema}. */
  configJsonSchema: JsonValue
  /** Standard Schema adapter derived from {@link configSchema}. */
  validateConfig: StandardSchemaV1
}

export interface ModelRegistry {
  resolve(provider: string, model: string): ModelDescriptor | undefined
  listDescriptors?(): readonly ModelDescriptor[]
}

function assertDescriptorSchemaArtifacts(descriptor: Partial<ModelDescriptor>): void {
  const missing: string[] = []
  if (descriptor.configSchema === undefined) missing.push('configSchema')
  if (descriptor.configJsonSchema === undefined) missing.push('configJsonSchema')
  if (descriptor.validateConfig === undefined) missing.push('validateConfig')

  if (missing.length > 0) {
    throw new LlmError(
      `Model descriptor for provider "${descriptor.provider ?? '<unknown>'}" model "${
        descriptor.model ?? '<unknown>'
      }" is missing required schema artifacts: ${missing.join(', ')}.`,
      {
        kind: 'bad_request',
        retryable: false,
      },
    )
  }
}

/** Composite key for the exact (provider, model) match map. */
function descriptorKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

export function createModelRegistry(descriptors: ModelDescriptor[]): ModelRegistry {
  const exactMap = new Map<string, ModelDescriptor>()
  // Grouped per-provider so longest-prefix matching never crosses providers.
  const byProvider = new Map<string, Map<string, ModelDescriptor>>()

  for (const descriptor of descriptors) {
    assertDescriptorSchemaArtifacts(descriptor)

    const key = descriptorKey(descriptor.provider, descriptor.model)
    if (exactMap.has(key)) {
      throw new LlmError(
        `Duplicate model descriptor for provider "${descriptor.provider}" model "${descriptor.model}"`,
        {
          kind: 'bad_request',
          retryable: false,
        },
      )
    }
    exactMap.set(key, descriptor)

    let providerMap = byProvider.get(descriptor.provider)
    if (providerMap === undefined) {
      providerMap = new Map<string, ModelDescriptor>()
      byProvider.set(descriptor.provider, providerMap)
    }
    providerMap.set(descriptor.model, descriptor)
  }

  return {
    resolve(provider: string, model: string): ModelDescriptor | undefined {
      const exact = exactMap.get(descriptorKey(provider, model))
      if (exact !== undefined) return exact

      const providerMap = byProvider.get(provider)
      if (providerMap === undefined) return undefined

      let best: ModelDescriptor | undefined
      let bestLen = 0
      for (const [candidateModel, descriptor] of providerMap) {
        if (model.startsWith(candidateModel) && candidateModel.length > bestLen) {
          best = descriptor
          bestLen = candidateModel.length
        }
      }
      return best
    },
    listDescriptors(): readonly ModelDescriptor[] {
      return descriptors.slice()
    },
  }
}
