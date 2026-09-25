/**
 * Gemini pricing snapshot for @gullabs/google.
 *
 * All rates are in **micro-USD per million tokens** (µUSD/M).
 * To get the cost for N tokens: `cost_µUSD = N * ratePerM / 1_000_000`.
 *
 * **Service tiers.** Each model stores concrete `standard`, `flex`, and
 * `batch` rates transcribed from Google's pricing page. Flex and batch are
 * not a flat 50% of standard: on several models the cached lane stays at the
 * standard cached rate (or a published rate that is not half). A tier that
 * is not one of those three is unpriced (reject-don't-map). `priority` is
 * intentionally absent — it needs downgrade accounting and is a backlog item.
 *
 * **Long-context tier.** Gemini Pro models charge a premium when the GROSS
 * input token count exceeds 200,000. Selected by `inputTokens` (incl. cached),
 * not by billable input. Core's selector uses `> 200_000`.
 *
 * **Thinking tokens.** Already inside `outputTokens` (GROSS convention) and
 * billed at the output rate — no separate thinking lane.
 *
 * **Modality caveat (v1 = text).** Gemini 2.5 Flash / Flash-Lite / 3.1
 * Flash-Lite / 3 Flash Preview charge a higher INPUT rate for audio tokens
 * than for text/image/video. v1 is text-only and uses the text/img/vid input
 * rate. Per-modality input pricing is a deferred seam (see DESIGN.md).
 *
 * Re-verified against https://ai.google.dev/gemini-api/docs/pricing on
 * 2026-09-25. Standard token rates for already-registered models were
 * unchanged from the 2026-08-12 snapshot; flex/batch cached rates were not.
 *
 * @module
 */

import type { ModelRates } from '@gullabs/core'

/**
 * Identifies this pricing snapshot — bump the date when rates change.
 *
 * This is a snapshot date tied to Gemini's own pricing page, not a generic
 * core concept — it lives here (not `@gullabs/core`) alongside the rates it
 * dates.
 */
export const pricingVersion = 'gemini-2026-09-25' as const

/** Tiers this snapshot prices. Anything else is unpriced. */
export const GEMINI_PRICED_TIERS = ['standard', 'flex', 'batch'] as const

export type GeminiPricedTier = (typeof GEMINI_PRICED_TIERS)[number]

/** Concrete per-tier rates for one model. */
export interface GeminiTierRates {
  standard: ModelRates
  flex: ModelRates
  batch: ModelRates
}

function tiers(
  standard: ModelRates,
  flex: ModelRates,
  batch: ModelRates,
): GeminiTierRates {
  return Object.freeze({ standard, flex, batch })
}

/**
 * Frozen Gemini pricing snapshot (per-1M in µUSD), keyed by model id, then
 * by priced tier. Every number is transcribed from the pricing page.
 *
 * Keys are model-string prefixes / exact identifiers used in routing. The
 * cost engine matches exact first, then longest-prefix (see `resolveGeminiRates`).
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (re-verified 2026-09-25).
 */
export const GEMINI_PRICING: Readonly<Record<string, GeminiTierRates>> = Object.freeze({
  // Gemini 2.5 Pro. Flex/batch cached equals standard on both context bands.
  'gemini-2.5-pro': tiers(
    {
      inputPerM: 1_250_000,
      cachedPerM: 125_000,
      outputPerM: 10_000_000,
      gt200k: { inputPerM: 2_500_000, cachedPerM: 250_000, outputPerM: 15_000_000 },
    },
    {
      inputPerM: 625_000,
      cachedPerM: 125_000,
      outputPerM: 5_000_000,
      gt200k: { inputPerM: 1_250_000, cachedPerM: 250_000, outputPerM: 7_500_000 },
    },
    {
      inputPerM: 625_000,
      cachedPerM: 125_000,
      outputPerM: 5_000_000,
      gt200k: { inputPerM: 1_250_000, cachedPerM: 250_000, outputPerM: 7_500_000 },
    },
  ),

  // Gemini 2.5 Flash. Flex/batch cached stays $0.03.
  'gemini-2.5-flash': tiers(
    { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
    { inputPerM: 150_000, cachedPerM: 30_000, outputPerM: 1_250_000 },
    { inputPerM: 150_000, cachedPerM: 30_000, outputPerM: 1_250_000 },
  ),

  // Gemini 2.5 Flash-Lite. Flex/batch cached stays $0.01.
  'gemini-2.5-flash-lite': tiers(
    { inputPerM: 100_000, cachedPerM: 10_000, outputPerM: 400_000 },
    { inputPerM: 50_000, cachedPerM: 10_000, outputPerM: 200_000 },
    { inputPerM: 50_000, cachedPerM: 10_000, outputPerM: 200_000 },
  ),

  // Gemini 3.1 Flash-Lite. Flex/batch cached is the published $0.0125.
  'gemini-3.1-flash-lite': tiers(
    { inputPerM: 250_000, cachedPerM: 25_000, outputPerM: 1_500_000 },
    { inputPerM: 125_000, cachedPerM: 12_500, outputPerM: 750_000 },
    { inputPerM: 125_000, cachedPerM: 12_500, outputPerM: 750_000 },
  ),

  // Gemini 3.1 Pro Preview. Flex/batch cached equals standard on both bands.
  'gemini-3.1-pro-preview': tiers(
    {
      inputPerM: 2_000_000,
      cachedPerM: 200_000,
      outputPerM: 12_000_000,
      gt200k: { inputPerM: 4_000_000, cachedPerM: 400_000, outputPerM: 18_000_000 },
    },
    {
      inputPerM: 1_000_000,
      cachedPerM: 200_000,
      outputPerM: 6_000_000,
      gt200k: { inputPerM: 2_000_000, cachedPerM: 400_000, outputPerM: 9_000_000 },
    },
    {
      inputPerM: 1_000_000,
      cachedPerM: 200_000,
      outputPerM: 6_000_000,
      gt200k: { inputPerM: 2_000_000, cachedPerM: 400_000, outputPerM: 9_000_000 },
    },
  ),
})

/**
 * Standard-tier rates for a model id, or `undefined` when the id is not in
 * the snapshot. Longest-prefix match, same walk as the cost lookup.
 */
export function geminiStandardRates(model: string): ModelRates | undefined {
  return lookupGeminiTierRates(model)?.standard
}

/**
 * Concrete rates for `(model, tier)`. `undefined` tier is standard. A defined
 * tier this snapshot does not price returns `undefined`.
 */
export function lookupGeminiTierRates(
  model: string,
  tier?: string,
): GeminiTierRates | undefined {
  const exact = GEMINI_PRICING[model]
  if (exact !== undefined) return tier === undefined || tier in exact ? exact : undefined

  let bestKey = ''
  let best: GeminiTierRates | undefined
  for (const key of Object.keys(GEMINI_PRICING)) {
    if (model.startsWith(key) && key.length > bestKey.length) {
      bestKey = key
      best = GEMINI_PRICING[key]
    }
  }
  if (best === undefined) return undefined
  if (tier !== undefined && !(tier in best)) return undefined
  return best
}

/** Resolve the concrete {@link ModelRates} `computeCost` should apply. */
export function resolveGeminiRates(
  model: string,
  tier: string | undefined,
): ModelRates | undefined {
  const entry = lookupGeminiTierRates(model, tier)
  if (entry === undefined) return undefined
  const key = tier ?? 'standard'
  return entry[key as GeminiPricedTier]
}
