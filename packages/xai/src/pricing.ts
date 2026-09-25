/**
 * xAI pricing snapshot + cost computation for @gullabs/xai.
 *
 * All rates are in **micro-USD per million tokens** (µUSD/M), matching
 * `@gullabs/core`'s `ModelRates` convention exactly: `cost_µUSD = N *
 * ratePerM / 1_000_000`.
 *
 * Token arithmetic goes through core's `computeCost`. The xAI lookup resolves
 * the concrete per-tier rates (including the `priority` multiplier) before
 * that call, so core never sees an xAI tier name. Tool lanes stay here:
 * `computeCost` prices tokens only. `PricingSource` is provider-scoped by
 * contract (see `packages/core/src/ports.ts`).
 *
 * **Long-context tier.** grok-4.5 / grok-4.6 charge a premium when the GROSS
 * input token count exceeds 200,000 (`long_context_threshold` in xAI's
 * `/v1/models` listing). Selected by `inputTokens` (incl. cached), not by
 * billable input — mirrors core's `selectRates` convention exactly (strictly
 * greater than 200,000).
 *
 * **Service tiers.** grok-4.5 has none. grok-4.6 admits `'priority'`
 * (echo live-verified 2026-08-12). The 2× multiplier is confirmed by
 * fixture `12-grok-4-6-xhigh-priority.json` (`cost_in_usd_ticks` equals
 * exactly 2× standard list). `'default'` (the value xAI echoes when no
 * priority is served) and `undefined` (no tier requested) price at the
 * standard list. Any other defined tier is unpriced (reject-don't-map).
 *
 * **Conversion factor.** xAI's `/v1/models` raw `*_token_price` fields are
 * in hundred-thousandths of a dollar per token (i.e. divide the raw integer
 * by 10,000 to get USD per million tokens): e.g. `grok-4.6`'s raw
 * `prompt_text_token_price: 20000` ÷ 10,000 = $2.00/M.
 *
 * Verified against `/v1/models` on 2026-08-12. Prior snapshot
 * `xai-2026-07-09` priced grok-4.5 cached input at $0.50 / $1.00; the live
 * listing now reports $0.30 / $0.60.
 *
 * @module
 */

import { computeCost } from '@gullabs/core'
import type { Cost, CostRatesLookup, PricingSource, Usage } from '@gullabs/core'

/** Identifies this pricing snapshot — bump the date when rates change. */
export const xaiPricingVersion = 'xai-2026-08-24' as const

/**
 * Live-pinned 2026-08-24 per-invocation tool rates (µUSD per call).
 * Source: `usage.server_side_tool_usage_details` on /v1/responses.
 * $5 / 1,000 web or X searches. Attachment search is not priced until live-pinned.
 */
export const XAI_TOOL_RATE_MICRO_USD = {
  web_search_calls: 5_000,
  x_search_calls: 5_000,
} as const

const XAI_TOOL_COUNTER_KEYS = ['web_search_calls', 'x_search_calls'] as const

/**
 * Per-model rate entry (all values in µUSD per million tokens).
 *
 * `gt200k` (when present) applies when GROSS input tokens > 200,000.
 */
export interface XaiModelRates {
  /** µUSD per million input tokens (billable = gross − cached). */
  inputPerM: number
  /** µUSD per million cache-read tokens. */
  cachedPerM: number
  /** µUSD per million output tokens (reasoning tokens are folded in). */
  outputPerM: number
  /** Optional high-tier rates for long-context (GROSS input > 200k). */
  gt200k?: {
    inputPerM: number
    cachedPerM: number
    outputPerM: number
  }
  /**
   * Multiplier for Responses `service_tier: "priority"`. Absent = this
   * model does not admit priority (unpriced). Uncached standard-list 2×
   * is confirmed by fixture `12-grok-4-6-xhigh-priority.json` ticks;
   * cached and `gt200k` legs follow the official 2×-after-cache-discount
   * docs rule (that fixture has cached=0 and input < 200k).
   */
  priorityFactor?: number
}

/**
 * Frozen xAI pricing snapshot (per-1M in µUSD).
 *
 * Keys are EXACT canonical model identifiers — no prefix or alias matching.
 * xAI aliases (e.g. `grok-4.5-latest`, `grok-build-latest`) are deliberately
 * NOT registered/priced (reject-don't-map): callers must use the canonical
 * id; anything else resolves to the unpriced path.
 */
export const XAI_PRICING: Readonly<Record<string, XaiModelRates>> = Object.freeze({
  // ── grok-4.5 ──  $2.00/$6.00 (≤200k), $4.00/$12.00 (>200k); cached $0.30/$0.60
  'grok-4.5': {
    inputPerM: 2_000_000,
    cachedPerM: 300_000,
    outputPerM: 6_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 600_000,
      outputPerM: 12_000_000,
    },
  },
  // ── grok-4.6 ──  $2.00/$6.00 (≤200k), $4.00/$12.00 (>200k); cached $0.50/$1.00
  'grok-4.6': {
    inputPerM: 2_000_000,
    cachedPerM: 500_000,
    outputPerM: 6_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 1_000_000,
      outputPerM: 12_000_000,
    },
    // Confirmed 2026-08-12 by fixture 12 cost_in_usd_ticks (2× list).
    priorityFactor: 2,
  },
})

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up rates for a model — EXACT match only.
 *
 * Deliberately no prefix matching (unlike core's Gemini lookup): xAI aliases
 * such as `grok-4.5-latest` would otherwise prefix-match `grok-4.5` and
 * silently reintroduce the alias behavior the model registry rejects. An id
 * that is not an exact `XAI_PRICING` key is unpriced.
 */
function lookupRates(model: string): XaiModelRates | undefined {
  return XAI_PRICING[model]
}

/**
 * Resolve concrete token rates for `(model, tier)`.
 *
 * `undefined` and `'default'` are the standard list. `'priority'` returns
 * those rates scaled by `priorityFactor` when the model admits it. Any other
 * defined tier, or `'priority'` on a model without `priorityFactor`, is
 * unpriced (reject-don't-map) — the lookup returns `undefined` and
 * `computeCost` records the unpriced cost.
 */
const lookupConcreteRates: CostRatesLookup = (model, tier) => {
  const rates = lookupRates(model)
  if (rates === undefined) return undefined
  if (tier === undefined || tier === 'default') return rates
  if (tier === 'priority' && rates.priorityFactor !== undefined) {
    return scaleRates(rates, rates.priorityFactor)
  }
  return undefined
}

function scaleRates(rates: XaiModelRates, factor: number): XaiModelRates {
  const scaled: XaiModelRates = {
    inputPerM: rates.inputPerM * factor,
    cachedPerM: rates.cachedPerM * factor,
    outputPerM: rates.outputPerM * factor,
  }
  if (rates.gt200k !== undefined) {
    scaled.gt200k = {
      inputPerM: rates.gt200k.inputPerM * factor,
      cachedPerM: rates.gt200k.cachedPerM * factor,
      outputPerM: rates.gt200k.outputPerM * factor,
    }
  }
  return scaled
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the cost of an xAI LLM call given a model name and usage data.
 *
 * Pure function — no side effects, always returns a well-formed {@link Cost}.
 *
 * **Algorithm:**
 * 1. `lookupConcreteRates` resolves the model and tier. `undefined` or
 *    `'default'` is the standard list. `'priority'` returns rates scaled by
 *    `priorityFactor` when the model admits it. An unknown model, any other
 *    defined tier, or `'priority'` on a model without `priorityFactor` is
 *    unpriced (reject-don't-map) — `computeCost` returns `microUsd: null`.
 * 2. Core selects base vs. `>200k` long-context rates from GROSS `inputTokens`.
 * 4. Billable input = `inputTokens − (cachedInputTokens ?? 0)`, clamped to 0.
 * 5. Round each component (input, cached, output) independently to the
 *    nearest integer micro-USD.
 * 6. `microUsd` is the sum of the four components — guarantees
 *    `details.input + details.cached + details.output + details.tools === microUsd`.
 * 7. Tool lanes: live-pinned counters `web_search_calls`, `x_search_calls`.
 *    Missing expected counters → `tools: 0`, `estimated`. File-ref sets
 *    `attachment_search_unpinned` → `estimated` (attachment not priced).
 *    `'exact'` requires no unpinned attachment and counters present or no
 *    server tools requested.
 */
export function computeXaiCost(model: string, usage: Usage, tier?: string): Cost {
  const tokenCost = computeCost(
    model,
    usage,
    tier,
    lookupConcreteRates,
    xaiPricingVersion,
  )
  if (tokenCost.microUsd === null) return tokenCost

  const inputCost = tokenCost.details.input
  const cachedCost = tokenCost.details.cached
  const outputCost = tokenCost.details.output

  const serverToolsRequested = usage.details['server_tools_requested'] === 1
  const missingRequestedCounters =
    usage.details['server_tools_missing'] === 1 ||
    (serverToolsRequested &&
      usage.details['attachment_search_unpinned'] !== 1 &&
      !XAI_TOOL_COUNTER_KEYS.some((key) => key in usage.details))
  const attachmentUnpinned = usage.details['attachment_search_unpinned'] === 1

  const toolsCost = missingRequestedCounters
    ? 0
    : XAI_TOOL_COUNTER_KEYS.reduce((sum, key) => {
        const count = usage.details[key]
        if (typeof count !== 'number' || count <= 0) return sum
        return sum + Math.round(count * XAI_TOOL_RATE_MICRO_USD[key])
      }, 0)

  const microUsd = inputCost + cachedCost + outputCost + toolsCost

  return {
    microUsd,
    usd: microUsd / 1_000_000,
    pricingVersion: xaiPricingVersion,
    confidence: missingRequestedCounters || attachmentUnpinned ? 'estimated' : 'exact',
    details: {
      input: inputCost,
      cached: cachedCost,
      output: outputCost,
      tools: toolsCost,
    },
  }
}

/**
 * Factory that returns the **xai-scoped** {@link PricingSource} port
 * implementation backed by {@link XAI_PRICING}.
 *
 * @example
 * ```ts
 * import { xaiPricingSource } from '@gullabs/xai'
 *
 * const pricing = xaiPricingSource()
 * const cost = pricing.price('grok-4.6', usage)
 * ```
 */
export function xaiPricingSource(): PricingSource {
  return {
    version: xaiPricingVersion,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeXaiCost(model, usage, tier)
    },
    hasModel(model: string): boolean {
      return lookupRates(model) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(XAI_PRICING)
    },
  }
}
