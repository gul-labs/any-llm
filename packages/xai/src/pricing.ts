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
 * **Long-context tier.** grok-4.5 / grok-4.6 / grok-4.7 charge a premium when the GROSS
 * input token count is at or above 200,000. xAI's current pricing page
 * (https://docs.x.ai/developers/pricing) explicitly labels the band
 * "Long context ≥ 200k tokens"; the live listing returns 200000. Selected by
 * `inputTokens` (incl. cached), not by billable input. Core's selector is
 * strictly greater than 200,000; this module owns the `>=` predicate.
 *
 * **Service tiers.** grok-4.5, grok-4.6, and grok-4.7 admit `'priority'` at 2×
 * on every token type, cached included. The 4.5 tier was live-verified
 * 2026-09-25; the 4.6 tier is pinned by fixture 12. `'fast'` is an alias and
 * is not admitted. `'default'` (the value
 * xAI echoes when no priority is served) and `undefined` (no tier requested)
 * price at the standard list. Any other defined tier is unpriced
 * (reject-don't-map).
 *
 * **Conversion factor.** xAI's `/v1/models` raw `*_token_price` fields are
 * in hundred-thousandths of a dollar per token — cents per 100M tokens
 * (divide the raw integer by 10,000 to get USD per million tokens): e.g.
 * `grok-4.6`'s raw `prompt_text_token_price: 20000` ÷ 10,000 = $2.00/M.
 *
 * Grok 4.5/4.6 rates were verified against `/v1/models` on 2026-08-12.
 * Grok 4.7 rates are published in xAI's 2026-09-21 release notes:
 * https://docs.x.ai/developers/release-notes. Prior snapshot
 * `xai-2026-07-09` priced grok-4.5 cached input at $0.50 / $1.00; the live
 * listing now reports $0.30 / $0.60.
 *
 * @module
 */

import { computeCost } from '@gullabs/core'
import type { Cost, CostRatesLookup, PricingSource, Usage } from '@gullabs/core'

/** Identifies this pricing snapshot — bump the date when rates change. */
export const xaiPricingVersion = 'xai-2026-09-25' as const

/**
 * Tool rates in µUSD per unit.
 *
 * - `web_search_calls`: $5 / 1,000 calls (per invocation).
 * - `x_posts_fetched`: $5 / 1,000 posts (per item, since 2026-09-21).
 * - `x_users_fetched`: $10 / 1,000 profiles (per item, since 2026-09-21).
 *
 * The per-call `x_search_calls` rate is gone. Attachment search stays
 * unpriced until a live probe pins the counter name (P-X2); a file-ref call
 * is estimated, not billed at an invented counter.
 */
export const XAI_TOOL_RATE_MICRO_USD = {
  web_search_calls: 5_000,
  x_posts_fetched: 5_000,
  x_users_fetched: 10_000,
} as const

const XAI_TOOL_COUNTER_KEYS = [
  'web_search_calls',
  'x_posts_fetched',
  'x_users_fetched',
] as const

/** Counters needed for a computed x_search tool fee. */
export const X_SEARCH_ITEM_COUNTERS = ['x_posts_fetched', 'x_users_fetched'] as const

const LONG_CONTEXT_THRESHOLD = 200_000

/**
 * Per-model rate entry (all values in µUSD per million tokens).
 *
 * `gt200k` (when present) applies when GROSS input tokens >= 200,000.
 */
export interface XaiModelRates {
  /** µUSD per million input tokens (billable = gross − cached). */
  inputPerM: number
  /** µUSD per million cache-read tokens. */
  cachedPerM: number
  /** µUSD per million output tokens (reasoning tokens are folded in). */
  outputPerM: number
  /** Optional high-tier rates for long-context (GROSS input >= 200_000). */
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
  // ── grok-4.5 ──  $2.00/$6.00 (<200k), $4.00/$12.00 (>=200k); cached $0.30/$0.60
  'grok-4.5': {
    inputPerM: 2_000_000,
    cachedPerM: 300_000,
    outputPerM: 6_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 600_000,
      outputPerM: 12_000_000,
    },
    priorityFactor: 2,
  },
  // ── grok-4.6 ──  $2.00/$6.00 (<200k), $4.00/$12.00 (>=200k); cached $0.50/$1.00
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
  // ── grok-4.7 ──  $2.00/$0.50/$6.00 (<200k), $4.00/$1.00/$12.00 (≥200k); priority 2×
  'grok-4.7': {
    inputPerM: 2_000_000,
    cachedPerM: 500_000,
    outputPerM: 6_000_000,
    gt200k: {
      inputPerM: 4_000_000,
      cachedPerM: 1_000_000,
      outputPerM: 12_000_000,
    },
    priorityFactor: 2,
  },
})

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up rates for a model — EXACT match only.
 *
 * Deliberately no prefix matching: xAI aliases
 * such as `grok-4.5-latest` would otherwise prefix-match `grok-4.5` and
 * silently reintroduce the alias behavior the model registry rejects. An id
 * that is not an exact `XAI_PRICING` key is unpriced.
 */
function lookupRates(model: string): XaiModelRates | undefined {
  return Object.hasOwn(XAI_PRICING, model) ? XAI_PRICING[model] : undefined
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

/**
 * Select base vs long-context rates. xAI's threshold is inclusive: 200,000
 * gross input tokens already pays the long-context list.
 */
export function selectXaiRates(
  rates: XaiModelRates,
  grossInputTokens: number,
): { inputPerM: number; cachedPerM: number; outputPerM: number } {
  if (rates.gt200k !== undefined && grossInputTokens >= LONG_CONTEXT_THRESHOLD) {
    return rates.gt200k
  }
  return {
    inputPerM: rates.inputPerM,
    cachedPerM: rates.cachedPerM,
    outputPerM: rates.outputPerM,
  }
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
 * 2. `selectXaiRates` applies long-context rates when GROSS input is
 *    `>= 200_000` (xAI's inclusive threshold; core's selector stays `>`).
 * 4. Billable input = `inputTokens − (cachedInputTokens ?? 0)`, clamped to 0.
 * 5. Round each component (input, cached, output) independently to the
 *    nearest integer micro-USD.
 * 6. `microUsd` is the sum of the four components — guarantees
 *    `details.input + details.cached + details.output + details.tools === microUsd`.
 * 7. Tool lanes: `web_search_calls` per call; x_search is
 *    `x_posts_fetched` × $5/1k + `x_users_fetched` × $10/1k. A missing
 *    item counter leaves the call unpriced; the provider's billed ticks remain
 *    in `usage.details` for reconciliation outside this rate snapshot.
 *    File-ref still sets `attachment_search_unpinned` and the call is
 *    estimated — the counter name is not pinned (P-X2).
 */
export function computeXaiCost(model: string, usage: Usage, tier?: string): Cost {
  const listed = lookupConcreteRates(model, tier)
  if (listed === undefined) {
    return computeCost(model, usage, tier, lookupConcreteRates, xaiPricingVersion)
  }
  const band = selectXaiRates(listed, usage.inputTokens)
  const bandLookup: CostRatesLookup = () => ({
    inputPerM: band.inputPerM,
    cachedPerM: band.cachedPerM,
    outputPerM: band.outputPerM,
  })
  const tokenCost = computeCost(model, usage, undefined, bandLookup, xaiPricingVersion)

  const inputCost = tokenCost.details.input
  const cachedCost = tokenCost.details.cached
  const outputCost = tokenCost.details.output

  const serverToolsRequested = usage.details['server_tools_requested'] === 1
  const xSearchRequested = usage.details['x_search_requested'] === 1
  const missingXSearchCounter =
    xSearchRequested &&
    X_SEARCH_ITEM_COUNTERS.some((key) => typeof usage.details[key] !== 'number')
  if (missingXSearchCounter || usage.details['server_tools_missing'] === 1) {
    // A live billed total is retained on Usage for reconciliation. It is not
    // a cost derived from this frozen rate snapshot, so do not put it in Cost.
    return {
      microUsd: null,
      usd: null,
      pricingVersion: xaiPricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0, tools: 0 },
      unpricedReason: missingXSearchCounter
        ? 'x_search usage is missing x_posts_fetched or x_users_fetched; refusing to bill a per-call estimate.'
        : 'Server tool usage is missing a required counter; refusing to guess a tool cost.',
    }
  }

  const attachmentUnpinned = usage.details['attachment_search_unpinned'] === 1
  const missingWebCounter =
    serverToolsRequested &&
    !xSearchRequested &&
    !attachmentUnpinned &&
    !XAI_TOOL_COUNTER_KEYS.some((key) => key in usage.details)

  const toolsCost = missingWebCounter
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
    confidence: missingWebCounter || attachmentUnpinned ? 'estimated' : 'exact',
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
