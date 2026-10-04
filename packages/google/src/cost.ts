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

/** The sum of the `<prefix>_<modality>` lanes the response reported, or `undefined` when it listed none. */
function modalitySplitTotal(
  usage: Usage,
  prefix: 'input_' | 'cached_',
): number | undefined {
  let total: number | undefined
  for (const [key, value] of Object.entries(usage.details)) {
    if (key.startsWith(prefix) && Number.isFinite(value) && value >= 0) {
      total = (total ?? 0) + value
    }
  }
  return total
}

/** Why the audio share of a call's prompt cannot be pinned down from the response. */
export type PromptSplitGap =
  /** Audio was sent, but the response reports no audio tokens (an absent entry or `{ AUDIO, 0 }`). */
  | 'audio-unreported'
  /** Cached tokens exist and nothing in the response says how many are audio. */
  | 'cached-audio-unknown'
  /** The reported counts contradict each other (audio above the prompt, cached audio above the cache, ...). */
  | 'inconsistent'

/**
 * The prompt split into four lanes that always sum to `usage.inputTokens`: audio and
 * other (text, image, video) tokens, each uncached and cached. `gaps` lists every
 * reason the audio share is not fully known from the response; an empty list means
 * the lanes are exact.
 *
 * Rules, in order:
 * - An `AUDIO` entry of `promptTokensDetails` (`details.input_audio`) is the audio
 *   count of the whole prompt, the cached part included; an `AUDIO` entry of
 *   `cacheTokensDetails` (`details.cached_audio`) is the cached audio. A reported
 *   cached audio count is priced even when the prompt split is absent: cached audio is
 *   part of the prompt audio, so it raises the prompt audio to at least that count.
 * - A request that carried audio (`details.audio_input_requested`) and a response with
 *   no audio tokens leaves the uncached audio unknown (`audio-unreported`); audio
 *   always has tokens, so zero is the same missing information as an absent entry.
 * - Cached tokens with no cached audio count are known audio-free only when the prompt
 *   split proves the prompt holds no audio (a zero entry, or a listing without audio
 *   that covers every prompt token); otherwise `cached-audio-unknown`. A cache that
 *   lists no audio and covers every cached token arrives as `cached_audio: 0`.
 * - Counts that contradict each other are clamped into the lanes and reported as
 *   `inconsistent`.
 *
 * @internal
 */
export function promptLanes(usage: Usage): {
  audioUncached: number
  audioCached: number
  otherUncached: number
  otherCached: number
  gaps: readonly PromptSplitGap[]
} {
  const total = usage.inputTokens
  const cachedReported = usage.cachedInputTokens ?? 0
  const promptAudio = tokenDetail(usage, 'input_audio')
  const cachedAudio = tokenDetail(usage, 'cached_audio')
  const gaps: PromptSplitGap[] = []
  const gap = (reason: PromptSplitGap): void => {
    if (!gaps.includes(reason)) gaps.push(reason)
  }

  const cached = Math.min(cachedReported, total)
  if (cachedReported > total) gap('inconsistent')

  const audioCached = Math.min(cachedAudio ?? 0, cached)
  if ((cachedAudio ?? 0) > cached) gap('inconsistent')
  if (promptAudio !== undefined && promptAudio < audioCached) gap('inconsistent')

  const audioTotal = Math.min(Math.max(promptAudio ?? 0, audioCached), total)
  if ((promptAudio ?? 0) > total) gap('inconsistent')
  const audioUncached = Math.min(audioTotal - audioCached, total - cached)
  if (audioTotal - audioCached > total - cached) gap('inconsistent')

  if (usage.details['audio_input_requested'] === 1 && !((promptAudio ?? 0) > 0)) {
    gap('audio-unreported')
  }
  const promptSplit = modalitySplitTotal(usage, 'input_')
  const promptHoldsNoAudio =
    promptAudio === 0 ||
    (promptAudio === undefined && promptSplit !== undefined && promptSplit >= total)
  if (cached > 0 && cachedAudio === undefined && !promptHoldsNoAudio) {
    gap('cached-audio-unknown')
  }

  return {
    audioUncached,
    audioCached,
    otherUncached: total - cached - audioUncached,
    otherCached: cached - audioCached,
    gaps,
  }
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
 * the text/image/video rates through core. The four lanes ({@link promptLanes})
 * always sum to the prompt. Reported cached audio is priced even when the prompt
 * split is absent. The cost is `'estimated'` whenever the response leaves the
 * audio share unknown or contradicts itself ({@link PromptSplitGap}): audio was
 * sent but none reported, cached tokens whose audio share nothing rules out, or
 * counts that do not add up.
 *
 * **Missing usage.** `details.usage_missing` (the response had no
 * `usageMetadata`) is unpriced and `'estimated'`: the amount is unknown.
 *
 * **Grounding.**
 * - No `web_search_requested`: the call is token-priced and exact.
 * - Requested, count known to be zero: Search did not run; token-priced, exact.
 * - Requested, count unknown (`web_search_calls` absent): the fee cannot be
 *   known, so the `tools` lane stays 0 and the cost is `'estimated'`.
 * - Search ran (count >= 1): the fee is added to `tools` and the cost is
 *   `'estimated'`, because the free allowance is unknowable per call and
 *   the fee is charged in full.
 *
 * `microUsd` stays the sum of the four lanes.
 */
function priceCall(model: string, usage: Usage, tier: string | undefined): Cost {
  // The adapter marks a 200 that carried no `usageMetadata`: the tokens billed
  // are unknown, so no amount (and certainly not an exact zero) is reported.
  if (usage.details['usage_missing'] === 1) {
    return {
      microUsd: null,
      usd: null,
      pricingVersion,
      confidence: 'estimated',
      details: { input: 0, cached: 0, output: 0, tools: 0 },
      unpricedReason:
        'The response carried no usageMetadata, so the tokens billed are unknown.',
    }
  }
  const modelRates = resolveGeminiRates(model, tier)
  const audioRates = modelRates?.audio

  let cost: Cost
  if (audioRates === undefined) {
    cost = computeCost(model, usage, tier, resolveGeminiRates, pricingVersion)
  } else {
    const lanes = promptLanes(usage)
    const textUsage: Usage = {
      ...usage,
      inputTokens: lanes.otherUncached + lanes.otherCached,
      cachedInputTokens: lanes.otherCached,
    }
    const text = computeCost(model, textUsage, tier, resolveGeminiRates, pricingVersion)
    const audioUncachedCost = Math.round(
      (lanes.audioUncached * audioRates.inputPerM) / 1_000_000,
    )
    const audioCachedCost = Math.round(
      (lanes.audioCached * audioRates.cachedPerM) / 1_000_000,
    )
    const microUsd = (text.microUsd ?? 0) + audioUncachedCost + audioCachedCost
    cost = {
      ...text,
      microUsd,
      usd: microUsd / 1_000_000,
      // An audio share the response does not pin down can understate the amount.
      ...(lanes.gaps.length > 0 ? { confidence: 'estimated' as const } : {}),
      details: {
        ...text.details,
        input: text.details.input + audioUncachedCost,
        cached: text.details.cached + audioCachedCost,
      },
    }
  }

  if (cost.microUsd === null) return cost

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
