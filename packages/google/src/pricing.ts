/**
 * Gemini pricing snapshot for @gullabs/google.
 *
 * All rates are in **micro-USD per million tokens** (µUSD/M).
 * To get the cost for N tokens: `cost_µUSD = N * ratePerM / 1_000_000`.
 *
 * **Service tiers.** Each model stores concrete `standard` and `flex` rates
 * transcribed from Google's pricing page. Flex is not a flat 50% of standard: on
 * several models the cached lane stays at the standard cached rate (or a
 * published rate that is not half). A tier that is not one of those two is
 * unpriced (reject-don't-map). `priority` is intentionally absent: it needs
 * downgrade accounting and is a backlog item. The Batch API has no path in this
 * library (no schema admits a batch tier), so its rates are not carried.
 *
 * **Long-context tier.** Gemini Pro models charge a premium when the GROSS
 * input token count exceeds 200,000. Selected by `inputTokens` (incl. cached),
 * not by billable input. Core's selector uses `> 200_000`.
 *
 * **Thinking tokens.** Already inside `outputTokens` (GROSS convention) and
 * billed at the output rate — no separate thinking lane.
 *
 * **Audio input.** Gemini 2.5 Flash, 2.5 Flash-Lite and 3.1 Flash-Lite charge
 * more for audio input than for text, image and video tokens ({@link GeminiRates.audio}).
 * The adapter records the prompt's per-modality token counts
 * (`usageMetadata.promptTokensDetails` and `cacheTokensDetails`) as
 * `usage.details.input_<modality>` / `cached_<modality>`, and the pricing source
 * bills the audio tokens at the audio rates and the rest at the text rate. Every
 * other model is billed one input rate for all modalities on the page. Models with
 * an audio rate have no `gt200k` band, so the long-context band never needs the
 * audio split.
 *
 * Re-verified against https://ai.google.dev/gemini-api/docs/pricing on
 * 2026-09-25. Standard token rates for already-registered models were
 * unchanged from the 2026-08-12 snapshot; flex cached rates were not. The audio
 * input and cached-audio rates (standard and flex) were read from the same page
 * on 2026-10-03; the page showed "Last Updated 2026-10-01 UTC".
 *
 * **Grounding with Google Search** is a tool lane, not a token rate; see
 * {@link GEMINI_GROUNDING_PRICING}. It was added from the same pricing page
 * on 2026-10-03. {@link pricingVersion} is `gemini-2026-10-03` because the
 * snapshot gained the grounding lane and the audio lane that day (a grounded or
 * audio call prices differently under it). The 2026-10-03 read of the page also
 * matched the standard text and cached rates of the models it listed (and the
 * flex text and cached rates of the three audio models); only the models the page
 * summary did not list keep their 2026-09-25 verification.
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
export const GEMINI_PRICED_TIERS = ['standard', 'flex'] as const

export type GeminiPricedTier = (typeof GEMINI_PRICED_TIERS)[number]

/** Audio input rates for a model that prices audio apart from text (µUSD per million tokens). */
export interface GeminiAudioRates {
  /** Non-cached audio input tokens. */
  inputPerM: number
  /** Cached audio input tokens. */
  cachedPerM: number
}

/** {@link ModelRates} plus the audio input rates, for models that publish them. */
export interface GeminiRates extends ModelRates {
  /**
   * Present only on a model whose pricing page lists a separate audio input
   * price. Priced on the audio tokens `promptTokensDetails` reports; every other
   * input token uses the text/image/video rates above.
   */
  audio?: GeminiAudioRates
}

/** Concrete per-tier rates for one model. */
export interface GeminiTierRates {
  standard: GeminiRates
  flex: GeminiRates
}

function tiers(standard: GeminiRates, flex: GeminiRates): GeminiTierRates {
  return Object.freeze({ standard, flex })
}

/**
 * Frozen Gemini pricing snapshot (per-1M in µUSD), keyed by model id, then
 * by priced tier. Every number is transcribed from the pricing page.
 *
 * Keys are exact priced model identifiers. Unlisted variants are unpriced.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (re-verified 2026-09-25;
 * the audio input and cached-audio rates read 2026-10-03, page last updated
 * 2026-10-01).
 */
export const GEMINI_PRICING: Readonly<Record<string, GeminiTierRates>> = Object.freeze({
  // Gemini 2.5 Pro. Flex cached equals standard on both context bands. No separate audio price.
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
  ),

  // Gemini 2.5 Flash. Flex cached stays $0.03. Audio: $1.00 / cached $0.10 standard,
  // $0.50 / cached $0.10 flex.
  'gemini-2.5-flash': tiers(
    {
      inputPerM: 300_000,
      cachedPerM: 30_000,
      outputPerM: 2_500_000,
      audio: { inputPerM: 1_000_000, cachedPerM: 100_000 },
    },
    {
      inputPerM: 150_000,
      cachedPerM: 30_000,
      outputPerM: 1_250_000,
      audio: { inputPerM: 500_000, cachedPerM: 100_000 },
    },
  ),

  // Gemini 2.5 Flash-Lite. Flex cached stays $0.01. Audio: $0.30 / cached $0.03
  // standard, $0.15 / cached $0.03 flex.
  'gemini-2.5-flash-lite': tiers(
    {
      inputPerM: 100_000,
      cachedPerM: 10_000,
      outputPerM: 400_000,
      audio: { inputPerM: 300_000, cachedPerM: 30_000 },
    },
    {
      inputPerM: 50_000,
      cachedPerM: 10_000,
      outputPerM: 200_000,
      audio: { inputPerM: 150_000, cachedPerM: 30_000 },
    },
  ),

  // Gemini 3.1 Flash-Lite. Flex cached is the published $0.0125. Audio: $0.50 /
  // cached $0.05 standard, $0.25 / cached $0.025 flex.
  'gemini-3.1-flash-lite': tiers(
    {
      inputPerM: 250_000,
      cachedPerM: 25_000,
      outputPerM: 1_500_000,
      audio: { inputPerM: 500_000, cachedPerM: 50_000 },
    },
    {
      inputPerM: 125_000,
      cachedPerM: 12_500,
      outputPerM: 750_000,
      audio: { inputPerM: 250_000, cachedPerM: 25_000 },
    },
  ),

  // Gemini 3.8 / 3.7 / 3.6 Flash intro rates (2026-09-25), one rate for all
  // modalities. Flex cached is half of the intro cached rate. Re-snapshot on 2027-01-01.
  'gemini-3.8-flash': tiers(
    { inputPerM: 750_000, cachedPerM: 75_000, outputPerM: 3_750_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
  ),
  'gemini-3.7-flash': tiers(
    { inputPerM: 750_000, cachedPerM: 75_000, outputPerM: 3_750_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
  ),
  'gemini-3.6-flash': tiers(
    { inputPerM: 750_000, cachedPerM: 75_000, outputPerM: 3_750_000 },
    { inputPerM: 375_000, cachedPerM: 37_500, outputPerM: 1_875_000 },
  ),

  // Gemini 3.5 Flash-Lite, one rate for all modalities (audio included). Flex
  // cached is the published $0.02, not half of $0.03.
  'gemini-3.5-flash-lite': tiers(
    { inputPerM: 300_000, cachedPerM: 30_000, outputPerM: 2_500_000 },
    { inputPerM: 150_000, cachedPerM: 20_000, outputPerM: 1_250_000 },
  ),

  // Gemini 3.1 Pro Preview. Flex cached equals standard on both bands. No separate audio price.
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

/** Resolve the concrete {@link GeminiRates} for `(model, tier)`. */
export function resolveGeminiRates(
  model: string,
  tier: string | undefined,
): GeminiRates | undefined {
  const entry = lookupGeminiTierRates(model, tier)
  if (entry === undefined) return undefined
  const key = tier ?? 'standard'
  return entry[key as GeminiPricedTier]
}
