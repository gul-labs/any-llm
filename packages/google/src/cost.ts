/**
 * Gemini pricing source for @gullabs/google.
 *
 * Provides `geminiPricingSource` — a factory returning a `PricingSource` port
 * implementation backed by the frozen Gemini pricing snapshot ({@link
 * GEMINI_PRICING}). Uses exact priced model identifiers,
 * resolves the concrete per-tier rates, and delegates the token arithmetic to
 * `@gullabs/core`'s `computeCost` (audio input and grounding are priced here). Core itself carries zero Gemini pricing
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

/** A non-negative whole token count from `usage.details`, or `undefined`. */
function tokenDetail(usage: Usage, key: string): number | undefined {
  const value = usage.details[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/**
 * Price one call: the input split by modality, the token lanes through core,
 * then the grounding fee on the `tools` lane from the normalised search facts in
 * `usage.details`.
 *
 * **Audio input.** A model whose rates carry `audio` bills the audio tokens of
 * the prompt (`details.input_audio`, from `promptTokensDetails`) at the audio
 * rates, and of those the cached ones (`details.cached_audio`, from
 * `cacheTokensDetails`) at the cached audio rate; every other token is priced at
 * the text/image/video rates through core. The audio amounts are added to the
 * `input` and `cached` lanes. The cost is `'estimated'` when audio was sent
 * (`details.audio_input_requested`) but the response reports no audio tokens, or
 * when cached tokens exist beside audio with no cached split: the audio share is
 * then unknown.
 *
 * **Grounding.**
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
  const modelRates = resolveGeminiRates(model, tier)
  const audioRates = modelRates?.audio

  // Audio tokens, clamped so the text remainder is never negative.
  const audioInput =
    audioRates === undefined
      ? 0
      : Math.min(tokenDetail(usage, 'input_audio') ?? 0, usage.inputTokens)
  const cachedTotal = usage.cachedInputTokens ?? 0
  const audioCached =
    audioInput === 0
      ? 0
      : Math.min(tokenDetail(usage, 'cached_audio') ?? 0, audioInput, cachedTotal)

  let cost: Cost
  if (audioRates === undefined || audioInput === 0) {
    cost = computeCost(model, usage, tier, resolveGeminiRates, pricingVersion)
  } else {
    const textUsage: Usage = {
      ...usage,
      inputTokens: usage.inputTokens - audioInput,
      cachedInputTokens: cachedTotal - audioCached,
    }
    const text = computeCost(model, textUsage, tier, resolveGeminiRates, pricingVersion)
    const audioUncachedCost = Math.round(
      ((audioInput - audioCached) * audioRates.inputPerM) / 1_000_000,
    )
    const audioCachedCost = Math.round((audioCached * audioRates.cachedPerM) / 1_000_000)
    const microUsd = (text.microUsd ?? 0) + audioUncachedCost + audioCachedCost
    cost = {
      ...text,
      microUsd,
      usd: microUsd / 1_000_000,
      details: {
        ...text.details,
        input: text.details.input + audioUncachedCost,
        cached: text.details.cached + audioCachedCost,
      },
    }
  }

  if (cost.microUsd === null) return cost

  // The audio share of the prompt is unknown, so the amount can understate.
  const audioSentUnreported =
    audioRates !== undefined &&
    usage.details['audio_input_requested'] === 1 &&
    tokenDetail(usage, 'input_audio') === undefined
  const cachedSplitUnknown =
    audioInput > 0 && cachedTotal > 0 && tokenDetail(usage, 'cached_audio') === undefined
  if (audioSentUnreported || cachedSplitUnknown)
    cost = { ...cost, confidence: 'estimated' }

  if (usage.details['web_search_requested'] !== 1) return cost

  const calls = usage.details['web_search_calls']
  if (calls === 0) return cost

  const rate = resolveGeminiGroundingRate(model)
  const tools =
    rate === undefined || calls === undefined
      ? 0
      : rate.unit === 'query'
        ? Math.round(calls * rate.microUsdPerUnit)
        : rate.microUsdPerUnit
  const microUsd = (cost.microUsd as number) + tools
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
