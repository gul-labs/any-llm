/**
 * Pricing snapshot `openai-2026-11-20`. Every usage object here is SYNTHETIC: it
 * proves the arithmetic against the documented rates (pricing page and
 * prompt-caching guide, read 2026-11-20), not what OpenAI bills.
 *
 * Amounts are µUSD: tokens × (µUSD per 1M tokens) / 1,000,000.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { Cost, Usage } from '@gullabs/core'

import {
  OPENAI_LONG_CONTEXT_THRESHOLD,
  computeOpenAiCost,
  openaiPricingSource,
  openaiPricingVersion,
} from './pricing.js'

function usage(
  input: number,
  output: number,
  extra: {
    cached?: number
    writes?: number
    w30?: number
    w12?: number
    details?: Record<string, number>
  } = {},
): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: extra.cached ?? 0,
    details: {
      input,
      output,
      cached: extra.cached ?? 0,
      cache_write: extra.writes ?? 0,
      ...(extra.w30 !== undefined ? { cache_write_30m: extra.w30 } : {}),
      ...(extra.w12 !== undefined ? { cache_write_12h: extra.w12 } : {}),
      ...extra.details,
    },
    raw: {},
  }
}

function expectSum(cost: Cost): void {
  const { input, cached, output, tools } = cost.details
  expect(input + cached + output + tools).toBe(cost.microUsd)
}

/** 200,000 input of which 100,000 are cache reads, 100,000 output: short band. */
const SHORT = usage(200_000, 100_000, { cached: 100_000 })

describe('standard rates per model', () => {
  it.each([
    // [model, $ per 1M input, cached, output] as µUSD per 1M tokens
    ['gpt-6.2-astra', 8_000_000, 400_000, 40_000_000],
    ['gpt-6.2-sol', 2_000_000, 100_000, 10_000_000],
    ['gpt-6.1-terra', 1_000_000, 50_000, 5_000_000],
    ['gpt-6-luna', 100_000, 10_000, 500_000],
  ] as const)('%s', (model, inputRate, cachedRate, outputRate) => {
    const cost = computeOpenAiCost(model, SHORT, 'default')
    // 100,000 tokens in each lane: a tenth of each per-1M rate.
    expect(cost.details).toEqual({
      input: inputRate / 10,
      cached: cachedRate / 10,
      output: outputRate / 10,
      tools: 0,
    })
    expect(cost.confidence).toBe('exact')
    expect(cost.pricingVersion).toBe(openaiPricingVersion)
    expectSum(cost)
  })
})

describe('served tiers', () => {
  it('fast and priority both select the Fast table (2x every lane, cached included)', () => {
    for (const tier of ['fast', 'priority']) {
      const cost = computeOpenAiCost('gpt-6.2-astra', SHORT, tier)
      expect(cost.details).toEqual({
        input: 1_600_000,
        cached: 80_000,
        output: 8_000_000,
        tools: 0,
      })
    }
  })

  it('flex is 50% of every lane on Terra and Luna', () => {
    expect(computeOpenAiCost('gpt-6.1-terra', SHORT, 'flex').details).toEqual({
      input: 50_000,
      cached: 2_500,
      output: 250_000,
      tools: 0,
    })
    expect(computeOpenAiCost('gpt-6-luna', SHORT, 'flex').details).toEqual({
      input: 5_000,
      cached: 500,
      output: 25_000,
      tools: 0,
    })
  })

  it('flex on a GPT-6.2 model has no table and is unpriced', () => {
    const cost = computeOpenAiCost('gpt-6.2-sol', SHORT, 'flex')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('"flex"')
  })

  it('an unknown echoed tier is unpriced, never mapped to standard', () => {
    for (const tier of ['scale', 'auto', 'ultrafast', 'standard']) {
      const cost = computeOpenAiCost('gpt-6.2-sol', SHORT, tier)
      expect(cost.microUsd).toBeNull()
      expect(cost.unpricedReason).toContain(`"${tier}"`)
    }
  })

  it('a missing echo is unpriced before the tier argument is looked at', () => {
    const missing = usage(1_000, 1_000, { details: { service_tier_missing: 1 } })
    for (const tier of [undefined, 'fast', 'default']) {
      const cost = computeOpenAiCost('gpt-6.2-sol', missing, tier)
      expect(cost.microUsd).toBeNull()
      expect(cost.unpricedReason).toContain('did not echo service_tier')
    }
  })

  it('an unknown model is unpriced', () => {
    const cost = computeOpenAiCost('gpt-6.1-sol', SHORT, 'default')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('Unknown model')
  })
})

describe('long-context band (> 272,000 gross input tokens)', () => {
  it('272,000 is short and 272,001 is long', () => {
    expect(OPENAI_LONG_CONTEXT_THRESHOLD).toBe(272_000)
    const short = computeOpenAiCost('gpt-6.2-sol', usage(272_000, 0), 'default')
    const long = computeOpenAiCost('gpt-6.2-sol', usage(272_001, 0), 'default')
    expect(short.details.input).toBe(544_000) // 272,000 × $2/M
    expect(long.details.input).toBe(1_088_004) // 272,001 × $4/M
    expect(short.confidence).toBe('exact')
    expect(long.confidence).toBe('exact')
  })

  it('applies 2x input and cache and 1.5x output to the whole request', () => {
    const cost = computeOpenAiCost(
      'gpt-6.2-astra',
      usage(400_000, 100_000, { cached: 100_000 }),
      'default',
    )
    expect(cost.details).toEqual({
      input: 4_800_000, // 300,000 × $16/M
      cached: 80_000, // 100,000 × $0.80/M
      output: 6_000_000, // 100,000 × $60/M
      tools: 0,
    })
  })

  it('long Fast is 2x the long band', () => {
    const cost = computeOpenAiCost('gpt-6.2-astra', usage(300_000, 0), 'fast')
    expect(cost.details.input).toBe(9_600_000) // 300,000 × $32/M
  })

  it('is estimated when the cached reads alone put the call over the threshold', () => {
    const cost = computeOpenAiCost(
      'gpt-6.2-sol',
      usage(272_010, 0, { cached: 20 }),
      'default',
    )
    expect(cost.details.input).toBe(1_087_960) // 271,990 × $4/M: long, by gross input
    expect(cost.confidence).toBe('estimated')
    const clear = computeOpenAiCost(
      'gpt-6.2-sol',
      usage(300_000, 0, { cached: 20 }),
      'default',
    )
    expect(clear.confidence).toBe('exact')
  })
})

describe('cache write lanes', () => {
  it('prices 30-minute (1.25x) and 12-hour (2.5x) writes inside the input lane, reconciled without double counting', () => {
    // 100,000 input = 60,000 ordinary + 10,000 reads + 30,000 writes
    // (20,000 at 30 minutes, 10,000 at 12 hours).
    const cost = computeOpenAiCost(
      'gpt-6.2-sol',
      usage(100_000, 0, { cached: 10_000, writes: 30_000, w30: 20_000, w12: 10_000 }),
      'default',
    )
    // ordinary 60,000 × $2/M = 120,000; 30m 20,000 × $2.50/M = 50,000;
    // 12h 10,000 × $5/M = 50,000
    expect(cost.details.input).toBe(220_000)
    // reads 10,000 × $0.10/M, never also billed as input
    expect(cost.details.cached).toBe(1_000)
    expect(cost.microUsd).toBe(221_000)
    // the ordinary-input subtraction is inferred from the guide, so estimated
    expect(cost.confidence).toBe('estimated')
    expectSum(cost)
  })

  it('writes without a TTL split are priced at the 30-minute default and estimated', () => {
    const cost = computeOpenAiCost(
      'gpt-6.1-terra',
      usage(100_000, 0, { writes: 40_000 }),
      'default',
    )
    // ordinary 60,000 × $1/M + 40,000 × $1.25/M
    expect(cost.details.input).toBe(110_000)
    expect(cost.confidence).toBe('estimated')
  })

  it('a Fast call scales the write rates too', () => {
    const cost = computeOpenAiCost(
      'gpt-6-luna',
      usage(100_000, 0, { writes: 100_000, w30: 0, w12: 100_000 }),
      'fast',
    )
    expect(cost.details.input).toBe(50_000) // 100,000 × $0.25/M × 2
  })

  it('reads plus writes above the input is unpriced', () => {
    const cost = computeOpenAiCost(
      'gpt-6.2-sol',
      usage(100, 0, { cached: 60, writes: 50 }),
      'default',
    )
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('does not reconcile')
  })

  it('a TTL split that does not sum to the writes is unpriced', () => {
    const cost = computeOpenAiCost(
      'gpt-6.2-sol',
      usage(1_000, 0, { writes: 300, w30: 100, w12: 100 }),
      'default',
    )
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('TTL split')
  })

  it('usage missing its cache lanes is unpriced', () => {
    const cost = computeOpenAiCost(
      'gpt-6.2-sol',
      usage(1_000, 0, { details: { usage_incomplete: 1 } }),
      'default',
    )
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain('cached_tokens or cache_write_tokens')
  })
})

describe('openaiPricingSource', () => {
  it('knows the four models and marks estimated usage estimated', () => {
    const source = openaiPricingSource()
    expect(source.version).toBe('openai-2026-11-20')
    expect([...source.listModels()]).toEqual([
      'gpt-6.2-astra',
      'gpt-6.2-sol',
      'gpt-6.1-terra',
      'gpt-6-luna',
    ])
    expect(source.hasModel('gpt-6-luna')).toBe(true)
    expect(source.hasModel('gpt-6-luna-2026')).toBe(false)
    const cost = source.price(
      'gpt-6-luna',
      usage(10, 10, { details: { usage_estimated: 1 } }),
      'default',
    )
    expect(cost.confidence).toBe('estimated')
  })
})
