/**
 * OpenAI pricing snapshot `openai-2026-11-20` + cost computation for
 * `@gullabs/openai`.
 *
 * Rates are micro-USD per million tokens (µUSD/M), core's `ModelRates`
 * convention. Source: https://developers.openai.com/api/docs/pricing and the
 * prompt-caching guide https://developers.openai.com/api/docs/guides/prompt-caching,
 * both read 2026-11-20. Documented, not live-verified: no OpenAI call was made,
 * and the tests' usage objects are synthetic (they prove the arithmetic only).
 *
 * **Served tier.** The tier is the one the response echoes (`service_tier`),
 * never the requested one: `default` is the standard table, `flex` the Flex
 * table (50% of every lane; Terra and Luna only), `fast` or `priority` the Fast
 * table (2x every lane, cached and cache writes included; "Priority processing
 * was renamed Fast mode on July 30, 2026"). Any other echoed value is an
 * unpriced tier. A response that echoes no tier carries
 * `usage.details.service_tier_missing = 1` and is unpriced before the tier
 * argument is looked at: core prices the requested tier when the adapter
 * reports none, and that would be a guess.
 *
 * **Long context.** "Short context: ≤272K input tokens. Long context: >272K
 * input tokens"; above it "2x input and cache rates and 1.5x output for the
 * full request". The band is chosen by the gross `input_tokens` (272,000 is
 * short, 272,001 is long). The page does not say whether cached tokens count
 * toward the threshold, so a call whose band would change without them is
 * `estimated`.
 *
 * **Cache lanes.** `cached_tokens` are cache reads at the listed cached rate
 * ("billed cache reads. Excludes tokens charged as writes"). `cache_write_tokens`
 * are writes at 1.25x input (30-minute TTL, the default) or 2.5x input (12-hour
 * TTL), split by `cache_write_tokens_details`. Writes are priced inside the
 * `input` lane; ordinary input is `input_tokens − cached_tokens −
 * cache_write_tokens`. That subtraction is an inference from the guide's
 * sentence, not a documented formula, so any call with writes is `estimated`.
 * Writes without a TTL split are priced at the 30-minute default and are
 * `estimated`. Usage whose lanes do not reconcile (reads plus writes above the
 * input, a TTL split that does not sum to the writes) or that lacks a lane is
 * unpriced.
 *
 * **Not modelled.** Regional processing (data residency, +10% for models
 * released on or after 2026-03-05) and FedRAMP (+10%) surcharges; Batch and
 * background windows (no path in this release); ultrafast (not admitted).
 *
 * @module
 */

import { computeCost } from '@gullabs/core'
import type { Cost, CostRatesLookup, PricingSource, Usage } from '@gullabs/core'

/** Identifies this pricing snapshot; bump the date when rates change. */
export const openaiPricingVersion = 'openai-2026-11-20' as const

/** Inclusive upper bound of the short-context band, in gross input tokens. */
export const OPENAI_LONG_CONTEXT_THRESHOLD = 272_000

/**
 * `usage.details` keys the adapter writes and this pricing source reads.
 *
 * - `serviceTierMissing`: 1 when the response echoed no `service_tier`.
 * - `usageIncomplete`: 1 when `input_tokens_details.cached_tokens` or
 *   `cache_write_tokens` is missing or not a number.
 * - `cacheWrite`, `cacheWrite30m`, `cacheWrite12h`: write tokens and their TTL
 *   split as reported.
 * - `usageEstimated`: 1 on usage the adapter ESTIMATED for a stream that failed
 *   after output began (ADR-040 Amendment A).
 */
export const OPENAI_USAGE_DETAIL_KEYS = Object.freeze({
  serviceTierMissing: 'service_tier_missing',
  usageIncomplete: 'usage_incomplete',
  cacheWrite: 'cache_write',
  cacheWrite30m: 'cache_write_30m',
  cacheWrite12h: 'cache_write_12h',
  usageEstimated: 'usage_estimated',
} as const)

/** One band's rates in µUSD per million tokens. */
export interface OpenAiBandRates {
  inputPerM: number
  cachedPerM: number
  /** 30-minute cache write: 1.25x input. */
  write30mPerM: number
  /** 12-hour cache write: 2.5x input. */
  write12hPerM: number
  outputPerM: number
}

/** Standard rates of one model, both bands, and the tiers it is priced for. */
export interface OpenAiModelRates {
  short: OpenAiBandRates
  long: OpenAiBandRates
  /** Tiers with a published table besides standard. */
  tiers: readonly ('flex' | 'fast')[]
}

const band = (
  inputPerM: number,
  cachedPerM: number,
  outputPerM: number,
): OpenAiBandRates =>
  Object.freeze({
    inputPerM,
    cachedPerM,
    write30mPerM: inputPerM * 1.25,
    write12hPerM: inputPerM * 2.5,
    outputPerM,
  })

/**
 * The snapshot, per 1M tokens (pricing page, read 2026-11-20). Long-context
 * rates are 2x input, cached and writes and 1.5x output of the short band.
 */
export const OPENAI_PRICING: Readonly<Record<string, OpenAiModelRates>> = Object.freeze({
  // gpt-6.2-astra: $8.00 / $0.40 cached / $40.00; long $16.00 / $0.80 / $60.00. Fast only.
  'gpt-6.2-astra': Object.freeze({
    short: band(8_000_000, 400_000, 40_000_000),
    long: band(16_000_000, 800_000, 60_000_000),
    tiers: Object.freeze(['fast'] as const),
  }),
  // gpt-6.2-sol: $2.00 / $0.10 / $10.00; long $4.00 / $0.20 / $15.00. Fast only.
  'gpt-6.2-sol': Object.freeze({
    short: band(2_000_000, 100_000, 10_000_000),
    long: band(4_000_000, 200_000, 15_000_000),
    tiers: Object.freeze(['fast'] as const),
  }),
  // gpt-6.1-terra: $1.00 / $0.05 / $5.00; long $2.00 / $0.10 / $7.50. Flex and Fast.
  'gpt-6.1-terra': Object.freeze({
    short: band(1_000_000, 50_000, 5_000_000),
    long: band(2_000_000, 100_000, 7_500_000),
    tiers: Object.freeze(['flex', 'fast'] as const),
  }),
  // gpt-6-luna: $0.10 / $0.01 / $0.50; long $0.20 / $0.02 / $0.75. Flex and Fast.
  'gpt-6-luna': Object.freeze({
    short: band(100_000, 10_000, 500_000),
    long: band(200_000, 20_000, 750_000),
    tiers: Object.freeze(['flex', 'fast'] as const),
  }),
})

/** Multiplier of each priced tier over the standard table. */
const TIER_FACTOR = { flex: 0.5, fast: 2 } as const

function lookupRates(model: string): OpenAiModelRates | undefined {
  return Object.hasOwn(OPENAI_PRICING, model) ? OPENAI_PRICING[model] : undefined
}

/**
 * The table an echoed tier selects: `undefined` (no tier reported to a direct
 * caller) and `default` are standard, `flex` is Flex, `fast` and `priority` are
 * Fast. Anything else, or a tier the model has no table for, is `undefined`.
 */
function tierFactor(
  rates: OpenAiModelRates,
  tier: string | undefined,
): number | undefined {
  if (tier === undefined || tier === 'default') return 1
  if (tier === 'flex') return rates.tiers.includes('flex') ? TIER_FACTOR.flex : undefined
  if (tier === 'fast' || tier === 'priority') {
    return rates.tiers.includes('fast') ? TIER_FACTOR.fast : undefined
  }
  return undefined
}

function scale(rates: OpenAiBandRates, factor: number): OpenAiBandRates {
  return {
    inputPerM: rates.inputPerM * factor,
    cachedPerM: rates.cachedPerM * factor,
    write30mPerM: rates.write30mPerM * factor,
    write12hPerM: rates.write12hPerM * factor,
    outputPerM: rates.outputPerM * factor,
  }
}

/** Concrete standard-band rates for core's unpriced-path naming (tier and model). */
const coreLookup: CostRatesLookup = (model, tier) => {
  const rates = lookupRates(model)
  if (rates === undefined) return undefined
  const factor = tierFactor(rates, tier)
  if (factor === undefined) return undefined
  const short = scale(rates.short, factor)
  return {
    inputPerM: short.inputPerM,
    cachedPerM: short.cachedPerM,
    outputPerM: short.outputPerM,
  }
}

function unpriced(reason: string): Cost {
  return {
    microUsd: null,
    usd: null,
    pricingVersion: openaiPricingVersion,
    confidence: 'estimated',
    details: { input: 0, cached: 0, output: 0, tools: 0 },
    unpricedReason: reason,
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Compute the cost of an OpenAI call from its usage and served tier.
 *
 * 1. A response without a tier echo, or usage without its cache lanes, is
 *    unpriced (before the tier is looked at).
 * 2. The model and tier select a table; an unknown model or tier is unpriced
 *    (core names which).
 * 3. The band follows the gross input; `estimated` when the cached reads alone
 *    decide it.
 * 4. Reads, writes and ordinary input must reconcile, or the call is unpriced.
 * 5. Cached and output lanes and the ordinary-input part of the `input` lane go
 *    through core's `computeCost` with the resolved band; the write cost is
 *    added to the `input` lane (each part rounded to whole µUSD), so the lanes
 *    sum to `microUsd`.
 */
export function computeOpenAiCost(model: string, usage: Usage, tier?: string): Cost {
  const keys = OPENAI_USAGE_DETAIL_KEYS
  if (usage.details[keys.serviceTierMissing] === 1) {
    return unpriced(
      'The OpenAI response did not echo service_tier; the served tier, and so the rate, is unknown.',
    )
  }
  if (usage.details[keys.usageIncomplete] === 1) {
    return unpriced(
      'The OpenAI usage is missing input_tokens_details.cached_tokens or cache_write_tokens; the input lanes cannot be priced.',
    )
  }
  const rates = lookupRates(model)
  const factor = rates !== undefined ? tierFactor(rates, tier) : undefined
  if (rates === undefined || factor === undefined) {
    return computeCost(model, usage, tier, coreLookup, openaiPricingVersion)
  }

  const input = usage.inputTokens
  const reads = usage.cachedInputTokens ?? 0
  const writes = usage.details[keys.cacheWrite] ?? 0
  const write30 = usage.details[keys.cacheWrite30m]
  const write12 = usage.details[keys.cacheWrite12h]
  if (![input, reads, writes, usage.outputTokens].every(isCount)) {
    return unpriced('The OpenAI usage carries a token count that is not a whole number.')
  }
  if (reads + writes > input) {
    return unpriced(
      `The OpenAI usage does not reconcile: cached reads (${reads}) plus cache writes (${writes}) exceed input_tokens (${input}).`,
    )
  }
  const split = write30 !== undefined || write12 !== undefined
  if (split && (!isCount(write30 ?? 0) || !isCount(write12 ?? 0))) {
    return unpriced('The OpenAI cache-write TTL split is not a whole number.')
  }
  if (split && (write30 ?? 0) + (write12 ?? 0) !== writes) {
    return unpriced(
      `The OpenAI usage does not reconcile: the cache-write TTL split (${write30 ?? 0} + ${
        write12 ?? 0
      }) differs from cache_write_tokens (${writes}).`,
    )
  }

  const long = input > OPENAI_LONG_CONTEXT_THRESHOLD
  const bandMovedByReads = long && input - reads <= OPENAI_LONG_CONTEXT_THRESHOLD
  const resolved = scale(long ? rates.long : rates.short, factor)

  const ordinary = input - reads - writes
  const tokenCost = computeCost(
    model,
    { ...usage, inputTokens: ordinary + reads, cachedInputTokens: reads },
    undefined,
    () => ({
      inputPerM: resolved.inputPerM,
      cachedPerM: resolved.cachedPerM,
      outputPerM: resolved.outputPerM,
    }),
    openaiPricingVersion,
  )
  const ttl30 = split ? (write30 ?? 0) : writes
  const ttl12 = split ? (write12 ?? 0) : 0
  const writeCost =
    Math.round((ttl30 * resolved.write30mPerM) / 1_000_000) +
    Math.round((ttl12 * resolved.write12hPerM) / 1_000_000)

  const inputCost = tokenCost.details.input + writeCost
  const cachedCost = tokenCost.details.cached
  const outputCost = tokenCost.details.output
  const microUsd = inputCost + cachedCost + outputCost
  const estimated =
    bandMovedByReads || writes > 0 || usage.details[keys.usageEstimated] === 1
  return {
    microUsd,
    usd: microUsd / 1_000_000,
    pricingVersion: openaiPricingVersion,
    confidence: estimated ? 'estimated' : 'exact',
    details: { input: inputCost, cached: cachedCost, output: outputCost, tools: 0 },
  }
}

/**
 * The **openai-scoped** {@link PricingSource} backed by {@link OPENAI_PRICING}.
 */
export function openaiPricingSource(): PricingSource {
  return {
    version: openaiPricingVersion,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeOpenAiCost(model, usage, tier)
    },
    hasModel(model: string): boolean {
      return lookupRates(model) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(OPENAI_PRICING)
    },
  }
}
