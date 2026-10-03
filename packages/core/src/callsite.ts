/**
 * Call-site definition for @gullabs/core.
 *
 * A {@link CallSite} is a reusable, named prompt template with an associated
 * model and optional JSON Schema for structured output.  It is the unit of
 * observability: every call made through a call site records a `callSiteId`
 * so usage can be grouped by prompt template in dashboards and audits.
 *
 * @module
 */

import type { GenConfig, JsonValue } from './types.js'
import type { StandardSchemaV1 } from './standard-schema.js'

// ---------------------------------------------------------------------------
// CallSite type
// ---------------------------------------------------------------------------

/**
 * A reusable prompt template that bundles model, JSON Schema, and gen-config.
 *
 * @example
 * ```ts
 * const summarise = defineCallSite({
 *   id: 'summarise-article',
 *   provider: 'google',
 *   model: 'gemini-2.5-pro',
 *   system: 'You are a concise summariser.',
 *   userTemplate: 'Summarise this article in 3 sentences:\n\n{{article}}',
 *   config: { temperature: 0.3 },
 * })
 * ```
 */
export interface CallSite {
  /**
   * Stable identifier for this call site.
   * Persisted as `callSiteId` on every record for grouping/attribution.
   */
  id: string
  /**
   * Provider identifier — must match a configured adapter's `id`.
   * Routing is by (`provider`, `model`); no derivation from `model`.
   */
  provider: string
  /**
   * Model to use for this call site.
   * A plain string — change it here to reroute the entire call site.
   */
  model: string
  /**
   * Optional JSON Schema forwarded to the provider as a structured-output
   * generation hint. The library does not validate the result.
   */
  jsonSchema?: JsonValue
  /**
   * System instruction template.
   * Supports `{{var}}` interpolation (non-recursive — var values are never
   * re-scanned for further placeholders). Strict: every `{{var}}` referenced
   * here or in `userTemplate` must have a string-typed value in the `vars`
   * passed to `runStructured`, or the call is refused before any request is
   * built (`bad_request`, not retryable). No escape syntax for literal
   * `{{...}}` text.
   */
  system?: string
  /**
   * User message template.
   * Supports `{{var}}` interpolation (non-recursive — var values are never
   * re-scanned for further placeholders). Strict: every `{{var}}` referenced
   * here or in `system` must have a string-typed value in the `vars` passed
   * to `runStructured`, or the call is refused before any request is built
   * (`bad_request`, not retryable). No escape syntax for literal `{{...}}`
   * text.
   */
  userTemplate?: string
  /**
   * Optional StandardSchema validator for the `vars` passed to
   * `runStructured`. When present, `vars` is validated against it before
   * strict template interpolation runs — a missing/invalid business field
   * then surfaces as the schema's own error rather than a downstream
   * unresolved-placeholder violation. Validation failures throw
   * `LlmError('bad_request')` with structured `issues`. Async validators are
   * supported. This is independent of `LlmRequest.inputContract` (the
   * `generate()` path) — `runStructured` never auto-populates one from the
   * other.
   */
  inputSchema?: StandardSchemaV1
  /**
   * Generation config defaults for this call site.
   * Merged over library-level defaults; per-call `opts.config` wins over this.
   */
  config?: GenConfig
}

// ---------------------------------------------------------------------------
// defineCallSite
// ---------------------------------------------------------------------------

/**
 * Defines a call site — a reusable prompt template bound to a model.
 *
 * This is a pure identity function: it returns the options object unchanged but
 * typed as a {@link CallSite}.
 *
 * @param opts - Call site definition.
 * @returns The same object, typed as {@link CallSite}.
 *
 * @example
 * ```ts
 * import { defineCallSite } from '@gullabs/core'
 * const classify = defineCallSite({
 *   id: 'classify-sentiment',
 *   provider: 'google',
 *   model: 'gemini-2.5-flash',
 *   jsonSchema: {
 *     type: 'object',
 *     properties: { sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] } },
 *     required: ['sentiment'],
 *   },
 *   userTemplate: 'Classify the sentiment of: {{text}}',
 * })
 * ```
 */
export function defineCallSite(opts: CallSite): CallSite {
  return opts
}
