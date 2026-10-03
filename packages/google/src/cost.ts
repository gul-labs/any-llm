/**
 * Gemini pricing source for @gullabs/google.
 *
 * Provides `geminiPricingSource` — a factory returning a `PricingSource` port
 * implementation backed by the frozen Gemini pricing snapshot ({@link
 * GEMINI_PRICING}). Uses exact priced model identifiers,
 * resolves the concrete per-tier rates, and delegates the arithmetic to
 * `@gullabs/core`'s `computeCost`. Core itself carries zero Gemini pricing
 * knowledge and applies no tier multiplier.
 *
 * @module
 */

import { computeCost } from '@gullabs/core'
import type { Cost, PricingSource, Usage } from '@gullabs/core'

import { GEMINI_PRICING, pricingVersion, resolveGeminiRates } from './pricing.js'

/**
 * Synthetic `usage.details` key the adapter sets to `1` when the request sent
 * `googleSearch`. It is adapter-owned, not a provider payload field. The pricing
 * source cannot see the request and does not yet price grounding fees, so it
 * reads this key to report such a cost as `'estimated'`, never `'exact'`.
 */
export const GOOGLE_SEARCH_REQUESTED_DETAIL = 'google_search_requested'

/**
 * Factory that returns the **google-scoped** {@link PricingSource} port
 * implementation backed by the built-in Gemini pricing snapshot.
 *
 * `PricingSource` is provider-scoped by contract — this source only knows
 * bare Gemini/Gemma model keys. Compose it into `ClientConfig.pricingSources`
 * under the `'google'` key (or bundle it via {@link googleProvider}); do not
 * use it for other providers.
 *
 * The returned object is stateless and can be shared across calls.
 *
 * @example
 * ```ts
 * import { geminiPricingSource } from '@gullabs/google'
 *
 * const pricing = geminiPricingSource()
 * const cost = pricing.price('gemini-2.5-pro', usage, 'flex')
 * ```
 */
export function geminiPricingSource(): PricingSource {
  return {
    version: pricingVersion,
    price(model: string, usage: Usage, tier?: string): Cost {
      const cost = computeCost(model, usage, tier, resolveGeminiRates, pricingVersion)
      return usage.details[GOOGLE_SEARCH_REQUESTED_DETAIL] === 1 &&
        cost.confidence === 'exact'
        ? { ...cost, confidence: 'estimated' }
        : cost
    },
    hasModel(model: string): boolean {
      return resolveGeminiRates(model, undefined) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(GEMINI_PRICING)
    },
  }
}
