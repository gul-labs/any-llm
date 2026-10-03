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

import {
  GEMINI_PRICING,
  pricingVersion,
  resolveGeminiGroundingRate,
  resolveGeminiRates,
} from './pricing.js'

/**
 * Price one call: the token lanes through core, then the grounding fee on the
 * `tools` lane from the normalised search facts in `usage.details`.
 *
 * - No `web_search_requested`: the call is token-priced and exact.
 * - Requested, count known to be zero: Search did not run; token-priced, exact.
 * - Requested, count unknown (`web_search_calls` absent): the fee cannot be
 *   known, so the `tools` lane stays 0 and the cost is `'estimated'`.
 * - Search ran (count >= 1): the fee is added to `tools` and the cost is
 *   `'estimated'`, because the daily free allowance is unknowable per call and
 *   the fee is charged in full.
 *
 * `microUsd` stays the sum of the four lanes.
 */
function priceCall(model: string, usage: Usage, tier: string | undefined): Cost {
  const cost = computeCost(model, usage, tier, resolveGeminiRates, pricingVersion)
  if (cost.microUsd === null || usage.details['web_search_requested'] !== 1) return cost

  const calls = usage.details['web_search_calls']
  if (calls === 0) return cost

  const rate = resolveGeminiGroundingRate(model)
  const tools =
    rate === undefined || calls === undefined
      ? 0
      : rate.unit === 'query'
        ? Math.round(calls * rate.microUsdPerUnit)
        : rate.microUsdPerUnit
  const microUsd = cost.microUsd + tools
  return {
    ...cost,
    microUsd,
    usd: microUsd / 1_000_000,
    confidence: 'estimated',
    details: { ...cost.details, tools },
  }
}

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
      return priceCall(model, usage, tier)
    },
    hasModel(model: string): boolean {
      return resolveGeminiRates(model, undefined) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(GEMINI_PRICING)
    },
  }
}
