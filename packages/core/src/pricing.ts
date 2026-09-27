/**
 * Generic pricing shapes for @gullabs/core.
 *
 * Core owns zero provider pricing data — every provider package supplies its
 * own rates table (see `@gullabs/google`'s `pricing.ts` for the Gemini
 * snapshot) and passes it into {@link computeCost} (cost.ts) as an explicit
 * parameter. This module keeps only the generic `ModelRates` shape that
 * `computeCost` and the `PricingSource` port are typed against.
 *
 * @module
 */

/**
 * Concrete rate entry for one model and service tier (µUSD per million tokens).
 *
 * The provider that owns the table selects the long-context boundary.
 * Core's `computeCost` uses `> 200,000`; xAI selects its own `>= 200,000` band
 * before calling core.
 */
export interface ModelRates {
  /** µUSD per million input tokens (text/img/vid; billable = gross − cached). */
  inputPerM: number
  /** µUSD per million cache-read tokens. */
  cachedPerM: number
  /** µUSD per million output tokens (thinking is folded in). */
  outputPerM: number
  /** Optional provider-owned long-context rates. */
  gt200k?: {
    inputPerM: number
    cachedPerM: number
    outputPerM: number
  }
}
