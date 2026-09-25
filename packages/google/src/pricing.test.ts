/**
 * Tests for the Gemini pricing snapshot + geminiPricingSource in @gullabs/google.
 *
 * Covers:
 * - The codex-mandated 250k/100k/5k/2k scenario (no double-counting).
 * - Long-context tier boundary at exactly 200k (base rate applies).
 * - cached === input (billable input = 0).
 * - cached > input (defensive clamp; no negative cost).
 * - Zero tokens everywhere.
 * - Unknown model → microUsd null + confidence estimated.
 * - Flat (non-tiered) model pricing.
 * - Property: sum(details) === microUsd for arbitrary usages on a known model.
 */

import { describe, it, expect } from 'vitest'
import type { Usage } from '@gullabs/core'
import { geminiPricingSource } from './cost.js'
import {
  pricingVersion,
  GEMINI_PRICING,
  GEMINI_PRICED_TIERS,
  resolveGeminiRates,
} from './pricing.js'

const PRICING = geminiPricingSource()

/** computeCost, pre-bound to the Gemini rates + tier-factor + version for this test file. */
function computeCost(model: string, usage: Usage, tier?: string) {
  return PRICING.price(model, usage, tier)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: expected per-component micro-USD
// ---------------------------------------------------------------------------

/**
 * Reference computation used inside tests.
 * Mirrors the cost.ts algorithm so assertions remain tightly coupled to the spec.
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
// The codex-mandated high-risk test
// ---------------------------------------------------------------------------

describe('computeCost — codex-mandated double-counting scenario', () => {
  it('usage {input:250k, cached:100k, output:5k, thinking:2k} on gemini-2.5-pro', () => {
    // GIVEN
    const usage = makeUsage({
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      outputTokens: 5_000,
      thinkingTokens: 2_000,
    })

    // WHEN
    const cost = computeCost('gemini-2.5-pro', usage)

    // Assert: gross input (250k) > 200k → >200k tier MUST be chosen.
    // We verify by using the gt200k rates from the snapshot.
    const proRates = GEMINI_PRICING['gemini-2.5-pro']!.standard
    expect(proRates).toBeDefined()
    expect(proRates.gt200k).toBeDefined()
    const gt200k = proRates.gt200k!

    // Billable input = 250k − 100k = 150k (not 250k, not 100k alone).
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

    // microUsd must be a number (not null).
    expect(cost.microUsd).not.toBeNull()
    expect(typeof cost.microUsd).toBe('number')

    // Assert tier: cost.microUsd must equal the >200k-tier calculation.
    expect(cost.microUsd).toBe(expected.microUsd)

    // Assert each component individually.
    expect(cost.details.input).toBe(expected.inputCost) // 150k billed at >200k input rate
    expect(cost.details.cached).toBe(expected.cachedCost) // 100k at cached rate
    expect(cost.details.output).toBe(expected.outputCost) // 5k billed once at output rate

    // Assert: thinkingTokens (2k) adds ZERO incremental cost.
    // Verify: same result with thinkingTokens stripped out.
    const noThinkingUsage = makeUsage({
      inputTokens: 250_000,
      cachedInputTokens: 100_000,
      outputTokens: 5_000, // same outputTokens; thinkingTokens is just metadata
    })
    const costNoThinking = computeCost('gemini-2.5-pro', noThinkingUsage)
    expect(cost.microUsd).toBe(costNoThinking.microUsd)
    expect(cost.details).toEqual(costNoThinking.details)

    // Assert sum invariant — the critical constraint.
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )

    // Confirm >200k rates produce a higher cost than base rates would.
    const baseExpected = expectedComponents(
      proRates.inputPerM,
      proRates.cachedPerM,
      proRates.outputPerM,
      billableInput,
      cached,
      outputTokens,
    )
    expect(cost.microUsd as number).toBeGreaterThan(baseExpected.microUsd)

    // Confidence and version.
    expect(cost.confidence).toBe('exact')
    expect(cost.pricingVersion).toBe(pricingVersion)
  })
})

// ---------------------------------------------------------------------------
// Tier boundary
// ---------------------------------------------------------------------------

describe('computeCost — tier boundary', () => {
  it('GROSS input exactly at 200k uses base rate (not >200k)', () => {
    const usage = makeUsage({ inputTokens: 200_000, outputTokens: 1_000 })
    const cost = computeCost('gemini-2.5-pro', usage)

    const proRates = GEMINI_PRICING['gemini-2.5-pro']!.standard
    const expected = expectedComponents(
      proRates.inputPerM,
      proRates.cachedPerM,
      proRates.outputPerM,
      200_000,
      0,
      1_000,
    )
    expect(cost.microUsd).toBe(expected.microUsd)
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
  })

  it('GROSS input one token above 200k triggers >200k tier', () => {
    const usage = makeUsage({ inputTokens: 200_001, outputTokens: 1_000 })
    const cost = computeCost('gemini-2.5-pro', usage)

    const proRates = GEMINI_PRICING['gemini-2.5-pro']!.standard
    const expected = expectedComponents(
      proRates.gt200k!.inputPerM,
      proRates.gt200k!.cachedPerM,
      proRates.gt200k!.outputPerM,
      200_001,
      0,
      1_000,
    )
    expect(cost.microUsd).toBe(expected.microUsd)
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
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
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).not.toBeNull()
    expect(cost.details.input).toBe(0) // 0 billable input tokens
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
  })

  it('cached > input → clamps to zero billable input (no negative cost)', () => {
    // Defensive: violates GROSS invariant but must not throw or produce negative cost.
    const usage = makeUsage({
      inputTokens: 1_000,
      cachedInputTokens: 5_000, // more than input — invalid but handled defensively
      outputTokens: 500,
    })
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).not.toBeNull()
    expect(cost.details.input).toBeGreaterThanOrEqual(0) // never negative
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
  })

  it('zero tokens everywhere → microUsd = 0', () => {
    const usage = makeUsage({ inputTokens: 0, outputTokens: 0 })
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).toBe(0)
    expect(cost.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
  })

  it('unknown model → microUsd null, confidence estimated, details zero', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('some-future-model-xyz', usage)

    expect(cost.microUsd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
    expect(cost.pricingVersion).toBe(pricingVersion)
  })

  it('Gemma 4 models remain unpriced until exact Google token rates are added', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('gemma-4-31b-it', usage, 'standard')

    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
  })

  it('flat (non-tiered) model: gemini-2.5-flash-lite', () => {
    const usage = makeUsage({
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 50_000,
    })
    const cost = computeCost('gemini-2.5-flash-lite', usage)

    const liteRates = GEMINI_PRICING['gemini-2.5-flash-lite']!.standard
    // No gt200k tier exists on flash-lite.
    expect(liteRates.gt200k).toBeUndefined()

    const expected = expectedComponents(
      liteRates.inputPerM,
      liteRates.cachedPerM,
      liteRates.outputPerM,
      800_000, // 1_000_000 − 200_000
      200_000,
      50_000,
    )

    expect(cost.microUsd).toBe(expected.microUsd)
    expect(cost.confidence).toBe('exact')
    expect(cost.details.input + cost.details.cached + cost.details.output).toBe(
      cost.microUsd,
    )
  })

  it('inherited object keys are not priced tiers', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    for (const tier of ['constructor', 'toString']) {
      const cost = PRICING.price('gemini-2.5-pro', usage, tier)
      expect(cost.microUsd).toBeNull()
      expect(cost.confidence).toBe('estimated')
      expect(cost.unpricedReason).toContain(tier)
    }
  })

  it('unknown (but defined) service tier → unpriced, never silently mapped to standard', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('gemini-2.5-pro', usage, 'enterprise-super-tier')

    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.details).toEqual({ input: 0, cached: 0, output: 0, tools: 0 })
    expect(cost.pricingVersion).toBe(pricingVersion)
    // Warning-naming contract: unpricedReason must name the offending tier.
    expect(cost.unpricedReason).toContain('enterprise-super-tier')
  })

  it('undefined tier defaults to standard (factor 1) — not a mapping', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const costUndefined = computeCost('gemini-2.5-pro', usage)
    const costStandard = computeCost('gemini-2.5-pro', usage, 'standard')

    expect(costUndefined.microUsd).not.toBeNull()
    expect(costUndefined.microUsd).toBe(costStandard.microUsd)
    expect(costUndefined.confidence).toBe('exact')
    expect(costUndefined.unpricedReason).toBeUndefined()
  })

  it('known tiers (standard/flex/batch) price exactly as before', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })

    for (const tier of GEMINI_PRICED_TIERS) {
      const cost = computeCost('gemini-2.5-pro', usage, tier)
      expect(cost.microUsd).not.toBeNull()
      expect(cost.confidence).toBe('exact')
      expect(cost.unpricedReason).toBeUndefined()
    }

    // Uncached flex/batch input+output are half of standard. Cached tokens on
    // this model are not discounted, so a cached call is not a flat half.
    const standard = computeCost('gemini-2.5-pro', usage, 'standard')
    const flex = computeCost('gemini-2.5-pro', usage, 'flex')
    const batch = computeCost('gemini-2.5-pro', usage, 'batch')
    expect(flex.microUsd).toBe(Math.round((standard.microUsd as number) * 0.5))
    expect(batch.microUsd).toBe(flex.microUsd)
  })

  it('unknown model still reports an unpricedReason naming the model', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('some-future-model-xyz', usage)

    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('some-future-model-xyz')
  })

  it('prefix match: gemini-2.5-pro-001 → matched to gemini-2.5-pro rates', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const costFull = computeCost('gemini-2.5-pro', usage)
    const costVersioned = computeCost('gemini-2.5-pro-001', usage)

    expect(costVersioned.microUsd).toBe(costFull.microUsd)
    expect(costVersioned.confidence).toBe('exact')
  })
})

// ---------------------------------------------------------------------------
// geminiPricingSource() port implementation
// ---------------------------------------------------------------------------

describe('geminiPricingSource', () => {
  it('implements PricingSource: version matches pricingVersion', () => {
    const src = geminiPricingSource()
    expect(src.version).toBe(pricingVersion)
  })

  it('price() delegates to computeCost correctly', () => {
    const src = geminiPricingSource()
    const usage = makeUsage({ inputTokens: 100_000, outputTokens: 5_000 })
    const direct = computeCost('gemini-2.5-flash', usage)
    const viaSrc = src.price('gemini-2.5-flash', usage)

    expect(viaSrc).toEqual(direct)
  })

  it('price() handles unknown model consistently with computeCost', () => {
    const src = geminiPricingSource()
    const usage = makeUsage({ inputTokens: 1_000, outputTokens: 100 })
    const cost = src.price('totally-unknown-model', usage, 'flex')

    expect(cost.microUsd).toBeNull()
    expect(cost.confidence).toBe('estimated')
  })

  it('hasModel uses the same exact and prefix matching as price()', () => {
    const src = geminiPricingSource()

    expect(src.hasModel('gemini-2.5-pro')).toBe(true)
    expect(src.hasModel('gemini-2.5-pro-001')).toBe(true)
    expect(src.hasModel('gemma-4-31b-it')).toBe(false)
  })

  it('listModels returns the exact pricing-table keys', () => {
    const src = geminiPricingSource()

    expect(src.listModels()).toEqual(Object.keys(GEMINI_PRICING))
  })
})

// ---------------------------------------------------------------------------
// Property: sum(details) === microUsd for randomised usages
// ---------------------------------------------------------------------------

describe('per-tier golden table — published flex/batch cached rates', () => {
  /**
   * Published µUSD/M from https://ai.google.dev/gemini-api/docs/pricing
   * (2026-09-25). Cached rates that equal standard must not be halved.
   */
  const PUBLISHED: ReadonlyArray<{
    model: string
    tier: 'standard' | 'flex' | 'batch'
    context: 'le200k' | 'gt200k'
    inputPerM: number
    cachedPerM: number
    outputPerM: number
  }> = [
    // gemini-2.5-pro
    {
      model: 'gemini-2.5-pro',
      tier: 'standard',
      context: 'le200k',
      inputPerM: 1_250_000,
      cachedPerM: 125_000,
      outputPerM: 10_000_000,
    },
    {
      model: 'gemini-2.5-pro',
      tier: 'standard',
      context: 'gt200k',
      inputPerM: 2_500_000,
      cachedPerM: 250_000,
      outputPerM: 15_000_000,
    },
    {
      model: 'gemini-2.5-pro',
      tier: 'flex',
      context: 'le200k',
      inputPerM: 625_000,
      cachedPerM: 125_000,
      outputPerM: 5_000_000,
    },
    {
      model: 'gemini-2.5-pro',
      tier: 'flex',
      context: 'gt200k',
      inputPerM: 1_250_000,
      cachedPerM: 250_000,
      outputPerM: 7_500_000,
    },
    {
      model: 'gemini-2.5-pro',
      tier: 'batch',
      context: 'le200k',
      inputPerM: 625_000,
      cachedPerM: 125_000,
      outputPerM: 5_000_000,
    },
    {
      model: 'gemini-2.5-pro',
      tier: 'batch',
      context: 'gt200k',
      inputPerM: 1_250_000,
      cachedPerM: 250_000,
      outputPerM: 7_500_000,
    },
    // gemini-2.5-flash — cached stays $0.03 on flex/batch
    {
      model: 'gemini-2.5-flash',
      tier: 'standard',
      context: 'le200k',
      inputPerM: 300_000,
      cachedPerM: 30_000,
      outputPerM: 2_500_000,
    },
    {
      model: 'gemini-2.5-flash',
      tier: 'flex',
      context: 'le200k',
      inputPerM: 150_000,
      cachedPerM: 30_000,
      outputPerM: 1_250_000,
    },
    {
      model: 'gemini-2.5-flash',
      tier: 'batch',
      context: 'le200k',
      inputPerM: 150_000,
      cachedPerM: 30_000,
      outputPerM: 1_250_000,
    },
    // gemini-2.5-flash-lite — cached stays $0.01
    {
      model: 'gemini-2.5-flash-lite',
      tier: 'standard',
      context: 'le200k',
      inputPerM: 100_000,
      cachedPerM: 10_000,
      outputPerM: 400_000,
    },
    {
      model: 'gemini-2.5-flash-lite',
      tier: 'flex',
      context: 'le200k',
      inputPerM: 50_000,
      cachedPerM: 10_000,
      outputPerM: 200_000,
    },
    {
      model: 'gemini-2.5-flash-lite',
      tier: 'batch',
      context: 'le200k',
      inputPerM: 50_000,
      cachedPerM: 10_000,
      outputPerM: 200_000,
    },
    // gemini-3.1-pro-preview — cached stays at standard on both context bands
    {
      model: 'gemini-3.1-pro-preview',
      tier: 'standard',
      context: 'le200k',
      inputPerM: 2_000_000,
      cachedPerM: 200_000,
      outputPerM: 12_000_000,
    },
    {
      model: 'gemini-3.1-pro-preview',
      tier: 'standard',
      context: 'gt200k',
      inputPerM: 4_000_000,
      cachedPerM: 400_000,
      outputPerM: 18_000_000,
    },
    {
      model: 'gemini-3.1-pro-preview',
      tier: 'flex',
      context: 'le200k',
      inputPerM: 1_000_000,
      cachedPerM: 200_000,
      outputPerM: 6_000_000,
    },
    {
      model: 'gemini-3.1-pro-preview',
      tier: 'flex',
      context: 'gt200k',
      inputPerM: 2_000_000,
      cachedPerM: 400_000,
      outputPerM: 9_000_000,
    },
    {
      model: 'gemini-3.1-pro-preview',
      tier: 'batch',
      context: 'le200k',
      inputPerM: 1_000_000,
      cachedPerM: 200_000,
      outputPerM: 6_000_000,
    },
    {
      model: 'gemini-3.1-pro-preview',
      tier: 'batch',
      context: 'gt200k',
      inputPerM: 2_000_000,
      cachedPerM: 400_000,
      outputPerM: 9_000_000,
    },
    // gemini-3.1-flash-lite — flex/batch cached is exactly half
    {
      model: 'gemini-3.1-flash-lite',
      tier: 'standard',
      context: 'le200k',
      inputPerM: 250_000,
      cachedPerM: 25_000,
      outputPerM: 1_500_000,
    },
    {
      model: 'gemini-3.1-flash-lite',
      tier: 'flex',
      context: 'le200k',
      inputPerM: 125_000,
      cachedPerM: 12_500,
      outputPerM: 750_000,
    },
    {
      model: 'gemini-3.1-flash-lite',
      tier: 'batch',
      context: 'le200k',
      inputPerM: 125_000,
      cachedPerM: 12_500,
      outputPerM: 750_000,
    },
  ]

  it('prices 1M cached tokens at the published cached rate for every model × tier × context band', () => {
    for (const row of PUBLISHED) {
      const inputTokens = row.context === 'gt200k' ? 200_001 : 100_000
      const usage = makeUsage({
        inputTokens,
        cachedInputTokens: inputTokens,
        outputTokens: 0,
      })
      const cost = computeCost(row.model, usage, row.tier)
      const expectedCached = Math.round((inputTokens * row.cachedPerM) / 1_000_000)
      expect(cost.microUsd, `${row.model} ${row.tier} ${row.context}`).toBe(
        expectedCached,
      )
      expect(
        cost.details.cached,
        `${row.model} ${row.tier} ${row.context} cached lane`,
      ).toBe(expectedCached)
      expect(cost.details.input).toBe(0)
      expect(cost.confidence).toBe('exact')

      const resolved = resolveGeminiRates(row.model, row.tier)
      expect(resolved, `${row.model} ${row.tier}`).toBeDefined()
      const band = row.context === 'gt200k' ? resolved!.gt200k! : resolved!
      expect(band.inputPerM).toBe(row.inputPerM)
      expect(band.cachedPerM).toBe(row.cachedPerM)
      expect(band.outputPerM).toBe(row.outputPerM)
    }
  })

  it('does not halve flex cached tokens on the five models whose page keeps the standard cached rate', () => {
    const models = [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3.1-pro-preview',
    ]
    const usage = makeUsage({
      inputTokens: 10_000,
      cachedInputTokens: 10_000,
      outputTokens: 0,
    })
    for (const model of models) {
      const standard = computeCost(model, usage, 'standard')
      const flex = computeCost(model, usage, 'flex')
      const batch = computeCost(model, usage, 'batch')
      expect(flex.details.cached, model).toBe(standard.details.cached)
      expect(batch.details.cached, model).toBe(standard.details.cached)
      expect(flex.details.cached).toBeGreaterThan(0)
    }
  })
})

describe('property — sum(details) === microUsd', () => {
  const KNOWN_MODELS = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ] as const

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

      const cost = computeCost(model, usage)

      if (cost.microUsd === null) {
        // Unknown model shouldn't appear here, but skip gracefully.
        continue
      }

      const sum = cost.details.input + cost.details.cached + cost.details.output
      if (sum !== cost.microUsd) {
        failures.push(
          `i=${i} model=${model} input=${inputTokens} cached=${cachedInputTokens} output=${outputTokens}` +
            ` → sum=${sum} !== microUsd=${cost.microUsd}`,
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
    const cost = computeCost('gemini-2.5-flash', usage)

    expect(cost.microUsd).not.toBeNull()
    expect(cost.usd).not.toBeNull()
    // Round-trip: converting usd back to µUSD must equal the canonical value.
    expect(Math.round(cost.usd! * 1_000_000)).toBe(cost.microUsd)
  })

  it('usd === null when model is unpriced (microUsd null)', () => {
    const usage = makeUsage({ inputTokens: 10_000, outputTokens: 500 })
    const cost = computeCost('some-future-model-xyz', usage)

    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
  })

  it('usd is exact division without rounding (microUsd / 1_000_000)', () => {
    // Use a model and token count that produces a non-round microUsd.
    const usage = makeUsage({ inputTokens: 1_000, outputTokens: 333 })
    const cost = computeCost('gemini-2.5-flash', usage)

    if (cost.microUsd !== null) {
      expect(cost.usd).toBe(cost.microUsd / 1_000_000)
    }
  })
})
