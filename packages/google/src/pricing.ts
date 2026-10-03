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
 * Flash-Lite charge a higher INPUT rate for audio tokens
 * than for text/image/video. v1 is text-only and uses the text/img/vid input
 * rate. Per-modality input pricing is a deferred seam (see DESIGN.md).
 *
 * Re-verified against https://ai.google.dev/gemini-api/docs/pricing on
 * 2026-09-25. Standard token rates for already-registered models were
 * unchanged from the 2026-08-12 snapshot; flex/batch cached rates were not.
 *
 * **Grounding with Google Search** is a tool lane, not a token rate; see
 * {@link GEMINI_GROUNDING_PRICING}. It was added from the same pricing page
 * on 2026-10-03; the token rates above were not re-read that day.
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
export const pricingVersion = 'gemini-2026-10-03' as const

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
 * Keys are exact priced model identifiers. Unlisted variants are unpriced.
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

  // Gemini 3.8 / 3.7 / 3.6 Flash intro rates (2026-09-25). Flex/batch cached
  // is half of the intro cached rate. Re-snapshot on 2027-01-01.
  'gemini-3.8-flash': tiers(
    { inputPerM: 750_000, cachedPerM: 75_000, outputPerM: 3_750_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
  ),
  'gemini-3.7-flash': tiers(
    { inputPerM: 750_000, cachedPerM: 75_000, outputPerM: 3_750_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
  ),
  'gemini-3.6-flash': tiers(
    { inputPerM: 750_000, cachedPerM: 75_000, outputPerM: 3_750_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
  ),

  // Gemini 3.5 Flash-Lite. Flex/batch cached is the published $0.02, not half of $0.03.
  'gemini-3.5-flash-lite': tiers(
    { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
    { inputPerM: 150_000, cachedPerM: 20_000, outputPerM: 1_250_000 },
    { inputPerM: 150_000, cachedPerM: 20_000, outputPerM: 1_250_000 },
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
 * How a model bills grounding with Google Search, in µUSD per unit.
 *
 * - `'query'`: Gemini 3 bills each search query the model performed. The unit
 *   count is `usage.details.web_search_calls`, counted as occurrences in
 *   `webSearchQueries` (a repeated query counts each time; whether Google bills
 *   a repeat is not established, so the count is the conservative one).
 * - `'prompt'`: Gemini 2.5 bills each prompt that was grounded, once however
 *   many queries it ran. A grounded prompt is one whose response reports at
 *   least one query.
 *
 * Transcribed from https://ai.google.dev/gemini-api/docs/pricing, grounding
 * with Google Search, read 2026-10-03 (Gemini 3: $14 per 1,000 queries;
 * Gemini 2.5: $35 per 1,000 grounded prompts). The page also publishes a daily
 * free allowance. It is shared across a project's calls, so no single call can
 * know whether it was free: every grounding fee is charged in full here, which
 * is why a call that ran Search is never reported as exact.
 *
 * Keys are exact priced model identifiers. Gemma has no token price in this
 * snapshot, so it has no grounding price either.
 */
export interface GeminiGroundingRate {
  readonly unit: 'query' | 'prompt'
  readonly microUsdPerUnit: number
}

const PER_QUERY: GeminiGroundingRate = Object.freeze({
  unit: 'query',
  microUsdPerUnit: 14_000,
})
const PER_GROUNDED_PROMPT: GeminiGroundingRate = Object.freeze({
  unit: 'prompt',
  microUsdPerUnit: 35_000,
})

export const GEMINI_GROUNDING_PRICING: Readonly<Record<string, GeminiGroundingRate>> =
  Object.freeze({
    'gemini-2.5-pro': PER_GROUNDED_PROMPT,
    'gemini-2.5-flash': PER_GROUNDED_PROMPT,
    'gemini-2.5-flash-lite': PER_GROUNDED_PROMPT,
    'gemini-3.1-flash-lite': PER_QUERY,
    'gemini-3.8-flash': PER_QUERY,
    'gemini-3.7-flash': PER_QUERY,
    'gemini-3.6-flash': PER_QUERY,
    'gemini-3.5-flash-lite': PER_QUERY,
    'gemini-3.1-pro-preview': PER_QUERY,
  })

/** The grounding rate for an exact priced model id, or `undefined`. */
export function resolveGeminiGroundingRate(
  model: string,
): GeminiGroundingRate | undefined {
  return Object.hasOwn(GEMINI_GROUNDING_PRICING, model)
    ? GEMINI_GROUNDING_PRICING[model]
    : undefined
}

/**
 * Concrete rates for `(model, tier)`. `undefined` tier is standard. A defined
 * tier this snapshot does not price returns `undefined`.
 */
function isPricedGeminiTier(tier: string): tier is GeminiPricedTier {
  return (GEMINI_PRICED_TIERS as readonly string[]).includes(tier)
}

function lookupGeminiTierRates(
  model: string,
  tier?: string,
): GeminiTierRates | undefined {
  const entry = Object.hasOwn(GEMINI_PRICING, model) ? GEMINI_PRICING[model] : undefined
  if (entry === undefined) return undefined
  // Only the three published tiers are priced. Inherited names such as
  // `constructor` and `toString` must not pass this check.
  if (tier !== undefined && !isPricedGeminiTier(tier)) return undefined
  return entry
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
