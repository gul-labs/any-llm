/**
 * Tests for computeCost — the generic, provider-agnostic cost engine in
 * @gullabs/core.
 *
 * Core has zero pricing tables of its own: every test here supplies a small
 * synthetic rates table + tier-factor map as explicit parameters, proving the
 * seam is genuinely provider-neutral. Gemini-specific pricing assertions
 * (real published rates, `geminiPricingSource`) live in
 * `packages/google/src/pricing.test.ts`.
 *
 * Covers:
 * - The double-counting scenario (billable input = gross − cached).
 * - Long-context tier boundary at exactly 200k (base rate applies).
 * - cached === input (billable input = 0).
 * - cached > input (defensive clamp; no negative cost).
 * - Zero tokens everywhere.
 * - Unknown model → microUsd null + confidence estimated.
 * - Unknown (but defined) tier → unpriced, never mapped to standard.
 * - Flat (non-tiered) model pricing.
 * - Property: sum(details) === microUsd for arbitrary usages on a known model.
 */

import { describe, it, expect } from 'vitest'
import { computeCost } from './cost.js'
import type { CostRatesLookup } from './cost.js'
import type { ModelRates } from './pricing.js'
import type { Usage } from './types.js'

// ---------------------------------------------------------------------------
// Synthetic fixtures — deliberately NOT real provider pricing data.
// ---------------------------------------------------------------------------

/** Concrete per-tier multipliers the synthetic lookup applies. Flex and batch
 * halve every lane, including cached — a provider that publishes a different
 * cached rate supplies that rate from its own lookup instead. */
const TEST_TIER_RATES: Readonly<Record<string, ModelRates>> = Object.freeze({
  standard: { inputPerM: 1, cachedPerM: 1, outputPerM: 1 },
  flex: { inputPerM: 0.5, cachedPerM: 0.5, outputPerM: 0.5 },
  batch: { inputPerM: 0.5, cachedPerM: 0.5, outputPerM: 0.5 },
})

const TEST_PRICING_VERSION = 'test-pricing-2026-01-01'

const TEST_RATES: Readonly<Record<string, ModelRates>> = Object.freeze({
  'acme-large': {
    inputPerM: 1_250_000,
    cachedPerM: 125_000,
    outputPerM: 10_000_000,
    gt200k: {
      inputPerM: 2_500_000,
      cachedPerM: 250_000,
      outputPerM: 15_000_000,
    },
  },
  'acme-flat': {
    inputPerM: 300_000,
    cachedPerM: 30_000,
    outputPerM: 2_500_000,
  },
})

function scaleRates(rates: ModelRates, factor: ModelRates): ModelRates {
  const scaled: ModelRates = {
    inputPerM: rates.inputPerM * factor.inputPerM,
    cachedPerM: rates.cachedPerM * factor.cachedPerM,
    outputPerM: rates.outputPerM * factor.outputPerM,
  }
  if (rates.gt200k !== undefined) {
    scaled.gt200k = {
      inputPerM: rates.gt200k.inputPerM * factor.inputPerM,
      cachedPerM: rates.gt200k.cachedPerM * factor.cachedPerM,
      outputPerM: rates.gt200k.outputPerM * factor.outputPerM,
    }
  }
  return scaled
}

/** Exact-then-longest-prefix lookup. `undefined` and `'standard'` return the
 * table as stored; a known discount tier returns concrete scaled rates; any
 * other defined tier is unpriced. */
const lookupTestRates: CostRatesLookup = (
  model: string,
  tier: string | undefined,
): ModelRates | undefined => {
  const key = tier ?? 'standard'
  const factor = TEST_TIER_RATES[key]
  if (factor === undefined) return undefined

  const exact = TEST_RATES[model]
  const base =
    exact ??
    (() => {
      let bestKey = ''
      let bestRates: ModelRates | undefined
      for (const rateKey of Object.keys(TEST_RATES)) {
        if (model.startsWith(rateKey) && rateKey.length > bestKey.length) {
          bestKey = rateKey
          bestRates = TEST_RATES[rateKey]
        }
      }
      return bestRates
    })()
  if (base === undefined) return undefined
  return key === 'standard' ? base : scaleRates(base, factor)
}

/** computeCost, pre-bound to the synthetic rates/version above. */
function cost(model: string, usage: Usage, tier?: string) {
  return computeCost(model, usage, tier, lookupTestRates, TEST_PRICING_VERSION)
}

/** Build a minimal Usage with the open details map and raw blob. */
function makeUsage(fields: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  thinkingTokens?: number
  totalTokens?: number
}): Usage {
  return {
    ...fields,
    details: {},
    raw: null,
  }
}

/**
 * Reference computation used inside tests.
 * Mirrors the computeCost algorithm so assertions remain tightly coupled to the spec.
 */
function expectedComponents(
  inputPerM: number,
  cachedPerM: number,
  outputPerM: number,
  billableInput: number,
  cached: number,
  outputTokens: number,
): { inputCost: number; cachedCost: number; outputCost: number; microUsd: number } {
  const inputCost = Math.round((billableInput * inputPerM) / 1_000_000)
  const cachedCost = Math.round((cached * cachedPerM) / 1_000_000)
  const outputCost = Math.round((outputTokens * outputPerM) / 1_000_000)
  return {
    inputCost,
    cachedCost,
    outputCost,
    microUsd: inputCost + cachedCost + outputCost,
  }
}

// ---------------------------------------------------------------------------
// Double-counting scenario
// ---------------------------------------------------------------------------

describe('computeCost — double-counting scenario', () => {
  it('usage {input:250k, cached:100k, output:5k, thinking:2k} on a >200k-tiered model', () => {
    const usage = makeUsage({
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      outputTokens: 5_000,
      thinkingTokens: 2_000,
    })

    const result = cost('acme-large', usage)

    const gt200k = TEST_RATES['acme-large']!.gt200k!
    const billableInput = 150_000
    const cached = 100_000
    const outputTokens = 5_000

    const expected = expectedComponents(
      gt200k.inputPerM,
      gt200k.cachedPerM,
      gt200k.outputPerM,
      billableInput,
      cached,
      outputTokens,
    )

    expect(result.microUsd).not.toBeNull()
    expect(result.microUsd).toBe(expected.microUsd)
    expect(result.details.input).toBe(expected.inputCost)
    expect(result.details.cached).toBe(expected.cachedCost)
    expect(result.details.output).toBe(expected.outputCost)

    // thinkingTokens adds zero incremental cost — it's inside outputTokens already.
    const noThinkingUsage = makeUsage({
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      outputTokens: 5_000,
    })
    const costNoThinking = cost('acme-large', noThinkingUsage)
    expect(result.microUsd).toBe(costNoThinking.microUsd)
    expect(result.details).toEqual(costNoThinking.details)

    // Sum invariant.
    expect(
      result.details.input +
        result.details.cached +
        result.details.output +
        result.details.tools,
    ).toBe(result.microUsd)

    expect(result.confidence).toBe('exact')
    expect(result.pricingVersion).toBe(TEST_PRICING_VERSION)
  })
})

// ---------------------------------------------------------------------------
// Tier boundary
// ---------------------------------------------------------------------------

describe('computeCost — tier boundary', () => {
  it('GROSS input exactly at 200k uses base rate (not >200k)', () => {
    const usage = makeUsage({ inputTokens: 200_000, outputTokens: 1_000 })
    const result = cost('acme-large', usage)

    const rates = TEST_RATES['acme-large']!
    const expected = expectedComponents(
      rates.inputPerM,
      rates.cachedPerM,
      rates.outputPerM,
      200_000,
      0,
      1_000,
    )
    expect(result.microUsd).toBe(expected.microUsd)
  })

  it('GROSS input one token above 200k triggers >200k tier', () => {
    const usage = makeUsage({ inputTokens: 200_001, outputTokens: 1_000 })
    const result = cost('acme-large', usage)

    const rates = TEST_RATES['acme-large']!
    const expected = expectedComponents(
      rates.gt200k!.inputPerM,
      rates.gt200k!.cachedPerM,
      rates.gt200k!.outputPerM,
      200_001,
      0,
      1_000,
    )
    expect(result.microUsd).toBe(expected.microUsd)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('computeCost — edge cases', () => {
  it('cached === input → zero billable input, only cached + output cost', () => {
    const usage = makeUsage({
      inputTokens: 50_000,
      cachedInputTokens: 50_000,
      outputTokens: 2_000,
    })
    const result = cost('acme-flat', usage)

    expect(result.microUsd).not.toBeNull()
    expect(result.details.input).toBe(0)
    expect(
      result.details.input +
        result.details.cached +
        result.details.output +
        result.details.tools,
    ).toBe(result.microUsd)
  })

  it('cached > input → clamps to zero billable input (no negative cost)', () => {
    const usage = makeUsage({
      inputTokens: 1_000,
      cachedInputTokens: 5_000,
      outputTokens: 500,
    })
    const result = cost('acme-flat', usage)

    expect(result.microUsd).not.toBeNull()
    expect(result.details.input).toBeGreaterThanOrEqual(0)
  })

  it('zero tokens everywhere → microUsd = 0', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0 })
    const result = cost('acme-flat', usage)

    expect(result.microUsd).toBe(0)
    expect(result.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
  })

  it('unknown model → microUsd null, confidence estimated, details zero', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const result = cost('some-future-model-xyz', usage)

    expect(result.microUsd).toBeNull()
    expect(result.confidence).toBe('estimated')
    expect(result.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
    expect(result.pricingVersion).toBe(TEST_PRICING_VERSION)
    expect(result.unpricedReason).toContain('some-future-model-xyz')
  })

  it('flat (non-tiered) model', () => {
    const usage = makeUsage({
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 50_000,
    })
    const result = cost('acme-flat', usage)

    const rates = TEST_RATES['acme-flat']!
    expect(rates.gt200k).toBeUndefined()

    const expected = expectedComponents(
      rates.inputPerM,
      rates.cachedPerM,
      rates.outputPerM,
      800_000,
      200_000,
      50_000,
    )
    expect(result.microUsd).toBe(expected.microUsd)
    expect(result.confidence).toBe('exact')
  })

  it('unknown model with a defined tier names the model, not the tier', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const result = cost('some-future-model-xyz', usage, 'standard')

    expect(result.microUsd).toBeNull()
    expect(result.unpricedReason).toContain('some-future-model-xyz')
    expect(result.unpricedReason).not.toContain('Unknown service tier')
  })

  it('names the model when the standard-tier probe fails, and the tier when it prices', () => {
    const usage = makeUsage({ inputTokens: 1_000, outputTokens: 100 })
    const seen: Array<[string, string | undefined]> = []
    const lookup: CostRatesLookup = (model, tier) => {
      seen.push([model, tier])
      if (model === 'priced-model' && (tier === undefined || tier === 'standard')) {
        return { inputPerM: 1, cachedPerM: 1, outputPerM: 1 }
      }
      return undefined
    }

    const unknown = computeCost(
      'gemma-4-31b-it',
      usage,
      'standard',
      lookup,
      TEST_PRICING_VERSION,
    )
    const unknownTier = computeCost(
      'priced-model',
      usage,
      'enterprise-super-tier',
      lookup,
      TEST_PRICING_VERSION,
    )

    expect(unknown.microUsd).toBeNull()
    expect(unknown.unpricedReason).toBe(
      'Unknown model "gemma-4-31b-it"; no pricing entry found.',
    )
    expect(unknownTier.microUsd).toBeNull()
    expect(unknownTier.unpricedReason).toBe(
      'Unknown service tier "enterprise-super-tier" for model "priced-model"; refusing to guess a pricing multiplier.',
    )
    expect(seen).toEqual([
      ['gemma-4-31b-it', 'standard'],
      ['gemma-4-31b-it', undefined],
      ['priced-model', 'enterprise-super-tier'],
      ['priced-model', undefined],
    ])
  })

  it('unknown (but defined) service tier → unpriced, never silently mapped to standard', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const result = cost('acme-large', usage, 'enterprise-super-tier')

    expect(result.microUsd).toBeNull()
    expect(result.usd).toBeNull()
    expect(result.confidence).toBe('estimated')
    expect(result.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
    expect(result.unpricedReason).toContain('enterprise-super-tier')
  })

  it('undefined tier defaults to standard (factor 1) — not a mapping', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const costUndefined = cost('acme-large', usage)
    const costStandard = cost('acme-large', usage, 'standard')

    expect(costUndefined.microUsd).not.toBeNull()
    expect(costUndefined.microUsd).toBe(costStandard.microUsd)
    expect(costUndefined.confidence).toBe('exact')
    expect(costUndefined.unpricedReason).toBeUndefined()
  })

  it('known tiers (standard/flex/batch) all price; flex/batch apply the concrete tier rates', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })

    for (const tier of Object.keys(TEST_TIER_RATES)) {
      const result = cost('acme-large', usage, tier)
      expect(result.microUsd).not.toBeNull()
      expect(result.confidence).toBe('exact')
    }

    const standard = cost('acme-large', usage, 'standard')
    const flex = cost('acme-large', usage, 'flex')
    const batch = cost('acme-large', usage, 'batch')
    expect(flex.microUsd).toBe(Math.round((standard.microUsd as number) * 0.5))
    expect(batch.microUsd).toBe(flex.microUsd)
  })

  it('prefix match: acme-large-001 → matched to acme-large rates', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const costFull = cost('acme-large', usage)
    const costVersioned = cost('acme-large-001', usage)

    expect(costVersioned.microUsd).toBe(costFull.microUsd)
    expect(costVersioned.confidence).toBe('exact')
  })

  it('rates lookup is invoked exactly once per computeCost call', () => {
    let calls = 0
    const countingLookup: CostRatesLookup = (model, tier) => {
      calls++
      expect(tier).toBeUndefined()
      return TEST_RATES[model]
    }
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    computeCost('acme-flat', usage, undefined, countingLookup, TEST_PRICING_VERSION)

    expect(calls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Property: sum(details) === microUsd for randomised usages
// ---------------------------------------------------------------------------

describe('property — sum(details) === microUsd', () => {
  const KNOWN_MODELS = ['acme-large', 'acme-flat'] as const

  // Deterministic pseudo-random number generator (LCG) so tests are
  // reproducible without importing a random library.
  function lcg(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = Math.imul(1664525, s) + 1013904223
      return (s >>> 0) / 0x100000000
    }
  }

  it('holds for 200 randomised usages across known models', () => {
    const rand = lcg(0xdeadbeef)
    const failures: string[] = []

    for (let i = 0; i < 200; i++) {
      const model = KNOWN_MODELS[i % KNOWN_MODELS.length]!
      const inputTokens = Math.floor(rand() * 500_000)
      const maxCached = Math.min(inputTokens, Math.floor(rand() * inputTokens))
      const cachedInputTokens = Math.floor(rand() * maxCached)
      const outputTokens = Math.floor(rand() * 100_000)
      const thinkingTokens = Math.floor(rand() * outputTokens)

      const usage = makeUsage({
        inputTokens,
        outputTokens,
        ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
        ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
      })

      const result = cost(model, usage)

      if (result.microUsd === null) {
        continue
      }

      const sum =
        result.details.input +
        result.details.cached +
        result.details.output +
        result.details.tools
      if (sum !== result.microUsd) {
        failures.push(
          `i=${i} model=${model} input=${inputTokens} cached=${cachedInputTokens} output=${outputTokens}` +
            ` → sum=${sum} !== microUsd=${result.microUsd}`,
        )
      }
    }

    expect(failures).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// usd convenience field
// ---------------------------------------------------------------------------

describe('Cost.usd — derived convenience field', () => {
  it('usd === microUsd / 1e6 for a priced call (round-trip within 1 µUSD)', () => {
    const usage = makeUsage({ inputTokens: 100_000, outputTokens: 5_000 })
    const result = cost('acme-flat', usage)

    expect(result.microUsd).not.toBeNull()
    expect(result.usd).not.toBeNull()
    expect(Math.round(result.usd! * 1_000_000)).toBe(result.microUsd)
  })

  it('usd === null when model is unpriced (microUsd null)', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const result = cost('some-future-model-xyz', usage)

    expect(result.microUsd).toBeNull()
    expect(result.usd).toBeNull()
  })

  it('usd is exact division without rounding (microUsd / 1_000_000)', () => {
    const usage = makeUsage({ inputTokens: 1_000, outputTokens: 333 })
    const result = cost('acme-flat', usage)

    if (result.microUsd !== null) {
      expect(result.usd).toBe(result.microUsd / 1_000_000)
    }
  })
})
