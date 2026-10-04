/**
 * Cost computation for @gullabs/core.
 *
 * This module provides `computeCost` — a **pure function** with zero
 * provider/tier vocabulary. Core has no pricing tables and no tier names
 * (`flex`/`standard` are Google's, not core's): every provider
 * package owns its own rates table and supplies a lookup that already
 * resolved the concrete per-tier {@link ModelRates}. This is the seam that
 * lets a new provider ship pricing with zero core changes — see
 * `@gullabs/google`'s `pricing.ts`/`cost.ts` for the Gemini-specific rates
 * table and `geminiPricingSource` factory built on top of this function.
 *
 * **GROSS token convention** (enforced here, not by callers):
 * - `cachedInputTokens` is a *subset* of `inputTokens` — the cached portion
 *   already counted inside `inputTokens`.
 * - `thinkingTokens` is a *subset* of `outputTokens` — the thinking portion
 *   already counted inside `outputTokens`.
 *
 * **Double-counting is prevented** by computing:
 * ```
 * billableInput = inputTokens − (cachedInputTokens ?? 0)   // net non-cached
 * ```
 * and billing `cachedInputTokens` at the (discounted) cached rate.
 * `thinkingTokens` requires no adjustment — it is already inside
 * `outputTokens` and is billed at the standard output rate.
 *
 * **Sum invariant** is guaranteed by construction:
 * Each component (input, cached, output, tools) is rounded independently to
 * an integer micro-USD value.  `microUsd` is then defined as their sum, so
 * `details.input + details.cached + details.output + details.tools === microUsd`
 * is always true — there is no residual rounding error. Core's
 * {@link computeCost} prices tokens only and always sets `tools: 0`;
 * provider sources that price tool invocations add that lane themselves.
 *
 * @module
 */

import type { Cost, Usage, Warning } from './types.js'
import type { ModelRates } from './pricing.js'

/**
 * A caller-supplied rates lookup: given a bare model identifier and an
 * optional service tier, resolves the applicable concrete {@link ModelRates},
 * or `undefined` if the model or tier is unpriced.
 *
 * The lookup owns tier resolution. `tier === undefined` means "no tier
 * specified" and must resolve to that provider's standard rates. A *defined*
 * tier the provider does not price is `undefined` (reject-don't-map) — core
 * never multiplies a standard snapshot by a factor, because some providers
 * publish a cached rate that is not a flat fraction of standard.
 *
 * Provider packages own the actual lookup against their own rates table: an
 * exact match on the descriptor's pricing key, never a prefix (ADR-033). Core calls this once
 * on the priced path. On the unpriced path with a defined tier it calls
 * again with `undefined` so an unknown model is not reported as an unknown
 * tier.
 */
export interface CostRatesLookup {
  (model: string, tier: string | undefined): ModelRates | undefined
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Select the applicable rate set for a model given the GROSS input token count.
 *
 * When a model has a `gt200k` tier, that tier's rates apply when
 * `grossInputTokens` is **strictly greater than** 200,000.
 *
 * This predicate operates purely on the generic {@link ModelRates} shape
 * (which core already owns), so it stays in core rather than moving with the
 * provider-specific rates table + lookup walk. Providers whose long-context
 * boundary is `>=` (xAI) select the band first, then pass only its flat rates
 * to this function through `computeCost`.
 */
function selectRates(
  rates: ModelRates,
  grossInputTokens: number,
): { inputPerM: number; cachedPerM: number; outputPerM: number } {
  if (rates.gt200k !== undefined && grossInputTokens > 200_000) {
    return rates.gt200k
  }
  return {
    inputPerM: rates.inputPerM,
    cachedPerM: rates.cachedPerM,
    outputPerM: rates.outputPerM,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the cost of an LLM call given a model name and usage data.
 *
 * This is a **pure function** — it has no side effects and always returns a
 * well-formed {@link Cost} value.
 *
 * **Seam:** `rates` is supplied by the caller (a provider package's
 * `PricingSource` factory) and already returns concrete per-tier rates.
 * Core has zero provider/tier vocabulary and applies no multiplier.
 *
 * **Algorithm:**
 * 1. Resolve rates via `rates(model, tier)`; if `undefined`, return an
 *    `estimated` Cost with `microUsd: null`, zero-filled details, and an
 *    `unpricedReason`. A defined tier that the lookup does not price names
 *    the tier; an unknown model names the model.
 * 2. Determine which rate tier applies (base vs. `>200k` long-context).
 * 3. Compute billable input: `inputTokens − (cachedInputTokens ?? 0)`, clamped
 *    to `0` if cached > input (defensive; the GROSS invariant should prevent
 *    this, but we protect against malformed adapter output).
 * 4. Round each component to the nearest integer micro-USD **independently**.
 * 5. Define `microUsd` as the sum of the three components — this guarantees
 *    `details.input + details.cached + details.output + details.tools === microUsd`
 *    exactly. Token-only sources (this function) set `tools: 0`.
 *
 * @param model - Model identifier string used for routing (e.g. `"gemini-2.5-pro"`).
 * @param usage - GROSS token usage for the call.
 * @param tier - Opaque, provider-defined service tier string (e.g. `'flex'`,
 *   `'standard'`). `undefined` means "no tier specified"; the
 *   lookup resolves that to the provider's standard rates. A *defined* tier
 *   the lookup does not price is never mapped to `standard` (reject-don't-map).
 * @param rates - Caller-supplied rates lookup (see {@link CostRatesLookup}).
 * @param pricingVersion - Caller-supplied pricing snapshot identifier, echoed
 *   verbatim onto the returned {@link Cost}.
 * @returns A frozen {@link Cost} value.
 */
export function computeCost(
  model: string,
  usage: Usage,
  tier: string | undefined,
  rates: CostRatesLookup,
  pricingVersion: string,
): Cost {
  const modelRates = rates(model, tier)

  if (modelRates === undefined) {
    // Name the tier only after a standard-tier probe prices this model.
    // An unknown model fails that probe even when the caller passed a tier.
    const standardRates = tier !== undefined ? rates(model, undefined) : undefined
    const unpricedReason =
      standardRates !== undefined
        ? `Unpriced service tier "${tier}" for model "${model}"; no concrete rate is available.`
        : `Unknown model "${model}"; no pricing entry found.`
    return {
      microUsd: null,
      usd: null,
      pricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0, tools: 0 },
      unpricedReason,
    }
  }

  // Select rate tier based on GROSS input token count (long-context premium).
  const base = selectRates(modelRates, usage.inputTokens)

  const cached = usage.cachedInputTokens ?? 0

  // Billable (non-cached) input: gross minus cached, clamped to zero.
  // The GROSS convention means cached ≤ input, but we defend against
  // malformed adapter output without throwing.
  const billableInput = Math.max(0, usage.inputTokens - cached)

  // Round each component independently to integer micro-USD.
  // Rates are µUSD per million tokens, so: tokens * ratePerM / 1_000_000.
  const inputCost = Math.round((billableInput * base.inputPerM) / 1_000_000)
  const cachedCost = Math.round((cached * base.cachedPerM) / 1_000_000)
  const outputCost = Math.round((usage.outputTokens * base.outputPerM) / 1_000_000)

  // Sum defines microUsd — guarantees sum(details) === microUsd by construction.
  const microUsd = inputCost + cachedCost + outputCost

  return {
    microUsd,
    usd: microUsd / 1_000_000,
    pricingVersion,
    confidence: 'exact',
    details: {
      input: inputCost,
      cached: cachedCost,
      output: outputCost,
      tools: 0,
    },
  }
}

/**
 * Compares the library's priced total with the total the provider reported
 * (`Cost.providerReported`) and returns a warning when they drift apart.
 *
 * Only totals are compared: a provider reports no lanes. Each lane is rounded to
 * whole micro-USD independently, so it can carry up to 0.5 µUSD of rounding even
 * when it rounded to 0, and the provider's figure is converted with the same
 * rounding. A lane can carry rounding when it has a non-zero amount or the usage
 * has tokens for it (billable input, cached input, output); the tolerance is 1 µUSD
 * for each such lane, minimum 1. A larger gap means the snapshot's rates are stale
 * or a billed lane is not priced. `undefined` when there is nothing to compare
 * (unpriced, or the provider reported no total) or the totals agree within that
 * tolerance.
 *
 * @internal
 */
export function providerCostDriftWarning(cost: Cost, usage: Usage): Warning | undefined {
  if (cost.microUsd === null || cost.providerReported === undefined) return undefined
  const cached = usage.cachedInputTokens ?? 0
  const lanes =
    Number(cost.details.input !== 0 || usage.inputTokens - cached > 0) +
    Number(cost.details.cached !== 0 || cached > 0) +
    Number(cost.details.output !== 0 || usage.outputTokens > 0) +
    Number(cost.details.tools !== 0)
  const tolerance = Math.max(1, lanes)
  const difference = cost.providerReported.microUsd - cost.microUsd
  if (Math.abs(difference) <= tolerance) return undefined
  return {
    type: 'other',
    message:
      `cost drift: the provider reported ${cost.providerReported.microUsd} µUSD but pricing snapshot ` +
      `${cost.pricingVersion} computed ${cost.microUsd} µUSD (difference ${difference}, tolerance ${tolerance} ` +
      `for ${lanes} lane${lanes === 1 ? '' : 's'} that can carry rounding); the snapshot's rates may be stale or a billed lane is not priced.`,
  }
}
