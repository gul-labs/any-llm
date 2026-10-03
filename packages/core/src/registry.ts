/**
 * Model descriptor registry for @gullabs/core.
 *
 * Centralises model/provider knowledge. Descriptors are keyed by the pair
 * (`provider`, `model`) with exact matching plus declared aliases; unknown pairs
 * fail fast at call time.
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
   * Canonical provider-native model identifier. Resolution is exact: a request
   * resolves to this descriptor only when its model string equals `model` or
   * one of {@link ModelDescriptor.aliases}. There is no prefix matching, so an
   * unregistered sibling (e.g. `"gemini-2.5-flash-image"` next to
   * `"gemini-2.5-flash"`) is never priced or validated as this model. Identity
   * for a descriptor is the pair (`provider`, `model`); the same bare `model`
   * string may be registered under multiple providers with different config
   * schemas.
   */
  model: string
  /**
   * Additional model strings that the provider serves as this same model
   * (real version suffixes such as a dated snapshot id). A request may name the
   * model by its canonical id or by any alias; the request string is forwarded
   * to the provider unchanged and the call is priced under this descriptor.
   * An alias must be unique within the provider and must not equal any
   * descriptor's canonical `model`.
   */
  aliases?: readonly string[]
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
    /**
     * How the next turn of a tool loop is sent (repeated on every
     * `LlmResult.continuation`). Absent means `'history'`.
     *
     * - `'history'`: the host appends `result.message` to its history and sends
     *   the full history (plus `result.transientProviderState` when the model
     *   declares {@link providerState}).
     * - `'state'`: `result.transientProviderState` holds the provider's own
     *   output; the next request sends only the new messages plus the state.
     *   Requires {@link providerState}.
     */
    continuation?: 'history' | 'state'
    /**
     * The model returns and accepts `transientProviderState`. The engine rejects
     * state on a model that does not declare it. Provider-scoped and bound to the
     * requested model string; each adapter defines the shape.
     */
    providerState?: boolean
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

function assertContinuationCapabilities(descriptor: ModelDescriptor): void {
  if (
    descriptor.capabilities?.continuation === 'state' &&
    descriptor.capabilities.providerState !== true
  ) {
    throw new LlmError(
      `Model descriptor for provider "${descriptor.provider}" model "${descriptor.model}" declares continuation "state" without providerState: true.`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

/** Composite key for the exact (provider, model) match map. */
function descriptorKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Adapter-side guard: the descriptor the engine resolved for this call must
 * belong to this adapter's provider and to the model the request names.
 *
 * `descriptor.provider` must equal both `req.provider` and `adapterProvider`,
 * and `req.model` must be the descriptor's canonical id or one of its declared
 * {@link ModelDescriptor.aliases}. The request string is never rewritten: the
 * adapter forwards `req.model` to the provider exactly as the host sent it.
 * Throws `LlmError('bad_request')` otherwise.
 */
export function assertModelMatchesDescriptor(
  req: { readonly provider: string; readonly model: string },
  descriptor: ModelDescriptor | undefined,
  adapterProvider: string,
): asserts descriptor is ModelDescriptor {
  if (
    descriptor === undefined ||
    descriptor.provider !== adapterProvider ||
    descriptor.provider !== req.provider ||
    (descriptor.model !== req.model && !(descriptor.aliases ?? []).includes(req.model))
  ) {
    throw new LlmError(
      `No matching ${adapterProvider} model descriptor for "${req.model}"` +
        (descriptor === undefined
          ? '.'
          : ` (descriptor is provider "${descriptor.provider}" model "${descriptor.model}").`),
      { kind: 'bad_request', retryable: false },
    )
  }
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = curr
  }
  return prev[b.length] ?? 0
}

/**
 * Builds the `bad_request` message for a (provider, model) pair the registry
 * does not know, naming the closest registered ids (canonical ids and
 * aliases) of the same provider when the registry can list them.
 *
 * @internal
 */
export function unknownModelMessage(
  registry: ModelRegistry,
  provider: string,
  model: string,
): string {
  const base = `No registered model for provider "${provider}" model "${model}".`
  const candidates: string[] = []
  for (const d of registry.listDescriptors?.() ?? []) {
    if (d.provider !== provider) continue
    candidates.push(d.model, ...(d.aliases ?? []))
  }
  if (candidates.length === 0) return base
  const closest = candidates
    .map((id) => ({ id, distance: levenshtein(model, id) }))
    .sort((x, y) => x.distance - y.distance || x.id.localeCompare(y.id))
    .slice(0, 3)
    .map((c) => `"${c.id}"`)
  return `${base} Model ids are matched exactly; closest registered ids: ${closest.join(', ')}.`
}

export function createModelRegistry(descriptors: ModelDescriptor[]): ModelRegistry {
  // Exact (provider, model-or-alias) -> descriptor. No prefix matching.
  const exactMap = new Map<string, ModelDescriptor>()

  for (const descriptor of descriptors) {
    assertDescriptorSchemaArtifacts(descriptor)
    assertContinuationCapabilities(descriptor)

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
  }

  // Aliases are registered after every canonical id so an alias can never
  // shadow, or be shadowed by, a canonical id regardless of descriptor order.
  for (const descriptor of descriptors) {
    for (const alias of descriptor.aliases ?? []) {
      if (typeof alias !== 'string' || alias.length === 0) {
        throw new LlmError(
          `Model descriptor for provider "${descriptor.provider}" model "${descriptor.model}" declares an empty or non-string alias.`,
          { kind: 'bad_request', retryable: false },
        )
      }
      const key = descriptorKey(descriptor.provider, alias)
      if (exactMap.has(key)) {
        throw new LlmError(
          `Model alias "${alias}" of provider "${descriptor.provider}" model "${descriptor.model}" collides with an existing model id or alias.`,
          { kind: 'bad_request', retryable: false },
        )
      }
      exactMap.set(key, descriptor)
    }
  }

  return {
    resolve(provider: string, model: string): ModelDescriptor | undefined {
      return exactMap.get(descriptorKey(provider, model))
    },
    listDescriptors(): readonly ModelDescriptor[] {
      return descriptors.slice()
    },
  }
}
