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
 * How this snapshot treats each server-tool usage counter xAI reports in
 * `usage.server_side_tool_usage_details` (names live-captured in fixtures 17-33).
 *
 * - `priced`: billed by a lane of {@link computeXaiCost}.
 * - `superseded`: no fee of its own (`x_search_calls` is replaced by the per-item
 *   `x_posts_fetched` / `x_users_fetched`).
 * - `fee_unpriced`: xAI charges per use and this snapshot has no rate, so a
 *   non-zero count makes the call `'estimated'`: code execution $5/1k calls
 *   (`code_interpreter_calls`), collections search $2.50/1k (`file_search_calls`),
 *   file attachments $5/1k (`document_search_calls`, whose counter name is not
 *   pinned: P-X2), image generation at Imagine API rates.
 * - `token_only`: xAI lists the tool as token-priced with no invocation fee, so
 *   the tokens already priced are the whole cost. `mcp_calls` (Remote MCP Tools)
 *   is the only token-only counter whose name has been captured. Image
 *   understanding and X video understanding are token-only too ("you will not be
 *   charged for the tool invocation itself but will be charged for the image
 *   tokens used"; web-search image search is billed as web search, so it is
 *   `web_search_calls`), but the page names no counter for them and none has been
 *   captured, so none is listed.
 *
 * Source: https://docs.x.ai/developers/pricing ("Tools pricing"), re-read
 * 2026-10-03 (the page carries no date). A counter that is not in this table and
 * is non-zero is unknown: it keeps the call `'estimated'` like `fee_unpriced`
 * does, but the adapter's warning does not claim it understates (see
 * {@link classifyUnpricedXaiToolCounters}).
 */
export const XAI_SERVER_TOOL_COUNTERS: Readonly<
  Record<string, 'priced' | 'superseded' | 'fee_unpriced' | 'token_only'>
> = Object.freeze({
  web_search_calls: 'priced',
  x_posts_fetched: 'priced',
  x_users_fetched: 'priced',
  x_search_calls: 'superseded',
  code_interpreter_calls: 'fee_unpriced',
  file_search_calls: 'fee_unpriced',
  document_search_calls: 'fee_unpriced',
  image_generation_calls: 'fee_unpriced',
  mcp_calls: 'token_only',
})

/**
 * The non-zero server-tool counters this snapshot cannot price, split by why:
 * `feeUnpriced` are the counters {@link XAI_SERVER_TOOL_COUNTERS} lists as
 * `fee_unpriced` (xAI charges per use, this snapshot has no rate), `unknown` are
 * counters the table does not know at all (xAI may bill them or may not). A call
 * that reports either is priced `'estimated'`, and the adapter warns.
 *
 * Candidates are the members of `usage.raw.server_side_tool_usage_details` (the
 * object xAI reports tool counters in; `usage.details` flattens it together with
 * unrelated numeric usage fields, so it cannot tell a counter from, say,
 * `num_sources_used`) plus the table's own names found in `usage.details`.
 */
export function classifyUnpricedXaiToolCounters(usage: Usage): {
  feeUnpriced: string[]
  unknown: string[]
} {
  const candidates = new Map<string, unknown>()
  const raw = usage.raw
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const nested = (raw as Record<string, unknown>)['server_side_tool_usage_details']
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      for (const [key, value] of Object.entries(nested)) candidates.set(key, value)
    }
  }
  for (const [key, value] of Object.entries(usage.details)) {
    if (Object.hasOwn(XAI_SERVER_TOOL_COUNTERS, key) && !candidates.has(key)) {
      candidates.set(key, value)
    }
  }
  const feeUnpriced: string[] = []
  const unknown: string[] = []
  for (const [key, value] of candidates) {
    if (typeof value !== 'number' || !(value > 0)) continue
    if (!Object.hasOwn(XAI_SERVER_TOOL_COUNTERS, key)) unknown.push(key)
    else if (XAI_SERVER_TOOL_COUNTERS[key] === 'fee_unpriced') feeUnpriced.push(key)
  }
  return { feeUnpriced, unknown }
}

/**
 * Names of the non-zero server-tool counters this snapshot cannot price (both
 * groups of {@link classifyUnpricedXaiToolCounters}); any makes the call
 * `'estimated'`.
 */
export function unpricedXaiToolCounters(usage: Usage): string[] {
  const { feeUnpriced, unknown } = classifyUnpricedXaiToolCounters(usage)
  return [...feeUnpriced, ...unknown]
}

/**
 * `usage.details` marker the adapter sets on usage it ESTIMATED for a stream that
 * failed after output began (ADR-040 Amendment A). Such a call is priced
 * `'estimated'`: the tokens are a lower bound, never the provider's count.
 */
export const XAI_ESTIMATED_USAGE_KEY = 'usage_estimated'

/** 1 tick = 1e-10 USD, so 10,000 ticks are 1 µUSD. */
const TICKS_PER_MICRO_USD = 10_000

/**
 * The call total xAI reported (`usage.cost_in_usd_ticks`) in whole µUSD, rounded
 * like every lane of {@link computeXaiCost}; `undefined` when absent or not a
 * finite non-negative number.
 */
function providerReportedCost(usage: Usage): Cost['providerReported'] {
  const ticks = usage.details['cost_in_usd_ticks']
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) return undefined
  return { microUsd: Math.round(ticks / TICKS_PER_MICRO_USD) }
}

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
   * is confirmed by fixture `12-grok-4-6-xhigh-priority.json` ticks; the
   * cached leg (2× its standard rate) by fixture `35-priority-warm-cache.json`
   * (warm-cache priority calls on all three models). The `gt200k` leg follows
   * the official 2×-after-cache-discount docs rule: no priority capture reaches
   * 200k input tokens.
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
 * 7. `cost_in_usd_ticks` (1 tick = 1e-10 USD) is converted to µUSD with the same
 *    rounding and reported as `Cost.providerReported`; `microUsd` stays this
 *    snapshot's price. The engine warns when the two totals drift.
 * 8. A non-zero server-tool counter that xAI bills per use (or that is unknown)
 *    and this snapshot has no rate for ({@link unpricedXaiToolCounters}, driven
 *    by {@link XAI_SERVER_TOOL_COUNTERS}) makes the call `'estimated'`. Token-only
 *    tools (`mcp_calls`) do not.
 * 9. Tool lanes: `web_search_calls` per call; x_search is
 *    `x_posts_fetched` × $5/1k + `x_users_fetched` × $10/1k. A missing
 *    item counter leaves the call unpriced; the provider's billed ticks remain
 *    in `usage.details` and, as `Cost.providerReported`, on the returned cost.
 *    File-ref still sets `attachment_search_unpinned` and the call is
 *    estimated — the counter name is not pinned (P-X2).
 */
export function computeXaiCost(model: string, usage: Usage, tier?: string): Cost {
  const cost = priceXaiCall(model, usage, tier)
  const providerReported = providerReportedCost(usage)
  return providerReported === undefined ? cost : { ...cost, providerReported }
}

function priceXaiCall(model: string, usage: Usage, tier?: string): Cost {
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
    // `microUsd` stays null: the snapshot cannot price this call. The total xAI
    // billed rides on `Cost.providerReported` (added by `computeXaiCost`).
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
  const unpricedCounters = unpricedXaiToolCounters(usage)

  return {
    microUsd,
    usd: microUsd / 1_000_000,
    pricingVersion: xaiPricingVersion,
    confidence:
      missingWebCounter ||
      attachmentUnpinned ||
      unpricedCounters.length > 0 ||
      usage.details[XAI_ESTIMATED_USAGE_KEY] === 1
        ? 'estimated'
        : 'exact',
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
