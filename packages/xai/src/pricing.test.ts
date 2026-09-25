/**
 * Tests for xai pricing computation (`computeXaiCost` / `xaiPricingSource`).
 *
 * Covers standard-tier cost math, the >200k gt200k boundary, cached-token
 * math, an unpriced/unknown-model path, and `hasModel`/`listModels`.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import type { Usage } from '@gullabs/core'
import {
  computeXaiCost,
  selectXaiRates,
  xaiPricingSource,
  xaiPricingVersion,
  XAI_PRICING,
} from './pricing.js'

/** xAI `/v1/models` raw price → µUSD/M (raw / 10_000 = USD/M; × 1e6 = µUSD/M). */
function rawToMicroPerM(raw: number): number {
  return (raw / 10_000) * 1_000_000
}

const v1Models = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/14-v1-models-pricing.json', import.meta.url)),
    'utf8',
  ),
) as {
  models: Record<
    string,
    {
      prompt_text_token_price: number
      cached_prompt_text_token_price: number
      completion_text_token_price: number
      prompt_text_token_price_long_context: number
      cached_prompt_text_token_price_long_context: number
      completion_text_token_price_long_context: number
    }
  >
}

const grok46PriorityFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./__fixtures__/12-grok-4-6-xhigh-priority.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  body: {
    usage: {
      input_tokens: number
      input_tokens_details?: { cached_tokens?: number }
      output_tokens: number
      cost_in_usd_ticks: number
    }
  }
}

function makeUsage(fields: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
}): Usage {
  return {
    ...fields,
    details: {},
    raw: null,
  }
}

describe('computeXaiCost — standard tier', () => {
  it('computes exact µUSD for a small usage sample (grok-4.5)', () => {
    // input: 1000 tokens, 200 cached, output: 500 tokens
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const cost = computeXaiCost('grok-4.5', usage)

    // billableInput = 1000 - 200 = 800
    // inputCost = round(800 * 2_000_000 / 1_000_000) = 1600
    // cachedCost = round(200 * 300_000 / 1_000_000) = 60
    // outputCost = round(500 * 6_000_000 / 1_000_000) = 3000
    expect(cost.confidence).toBe('exact')
    expect(cost.pricingVersion).toBe(xaiPricingVersion)
    expect(cost.details).toEqual({ input: 1600, cached: 60, output: 3000, tools: 0 })
    expect(cost.microUsd).toBe(1600 + 60 + 3000)
    expect(cost.usd).toBe((1600 + 60 + 3000) / 1_000_000)
  })

  it('sum invariant: details.input + details.cached + details.output === microUsd', () => {
    const usage = makeUsage({
      inputTokens: 12345,
      outputTokens: 678,
      cachedInputTokens: 111,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(
      cost.details.input + cost.details.cached + cost.details.output + cost.details.tools,
    ).toBe(cost.microUsd)
  })
})

describe('selectXaiRates — >=200k boundary', () => {
  const rates = XAI_PRICING['grok-4.5']!

  it('returns the base band at 199_999 and gt200k at 200_000 and 200_001', () => {
    expect(selectXaiRates(rates, 199_999)).toEqual({
      inputPerM: rates.inputPerM,
      cachedPerM: rates.cachedPerM,
      outputPerM: rates.outputPerM,
    })
    expect(selectXaiRates(rates, 200_000)).toBe(rates.gt200k)
    expect(selectXaiRates(rates, 200_001)).toBe(rates.gt200k)
  })
})

describe('computeXaiCost — >=200k gt200k boundary', () => {
  it('applies standard rates at 199,999 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 199_999,
      outputTokens: 0,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.input).toBe(Math.round((199_999 * 2_000_000) / 1_000_000))
  })

  it('applies gt200k rates at exactly 200,000 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 200_000,
      outputTokens: 100,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.input).toBe(Math.round((200_000 * 4_000_000) / 1_000_000))
  })

  it('applies gt200k rates at 200,001 gross input tokens', () => {
    const usage = makeUsage({
      inputTokens: 200_001,
      outputTokens: 100,
      cachedInputTokens: 0,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // gt200k inputPerM = 4_000_000 -> inputCost = round(200001 * 4_000_000 / 1e6) = 800_004
    expect(cost.details.input).toBe(800_004)
  })
})

describe('computeXaiCost — cached-token math', () => {
  it('bills cached tokens at cachedPerM and non-cached billable input at inputPerM', () => {
    // Below the 200k long-context threshold, so standard rates apply.
    const usage = makeUsage({
      inputTokens: 150_000,
      outputTokens: 0,
      cachedInputTokens: 150_000,
    })
    const cost = computeXaiCost('grok-4.5', usage)
    // billableInput = 0, cachedCost = round(150_000 * 300_000 / 1e6) = 45_000
    expect(cost.details.input).toBe(0)
    expect(cost.details.cached).toBe(45_000)
    expect(cost.details.output).toBe(0)
  })

  it('prices grok-4.6 cached tokens at the 4.6 cachedPerM ($0.50)', () => {
    const usage = makeUsage({
      inputTokens: 150_000,
      outputTokens: 0,
      cachedInputTokens: 150_000,
    })
    const cost = computeXaiCost('grok-4.6', usage)
    // cachedCost = round(150_000 * 500_000 / 1e6) = 75_000
    expect(cost.details.input).toBe(0)
    expect(cost.details.cached).toBe(75_000)
    expect(cost.details.output).toBe(0)
  })
})

describe('computeXaiCost — unpriced paths', () => {
  it('returns microUsd: null for an unknown model', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-99', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/grok-99/)
  })

  it('returns microUsd: null when an unrecognized tier is supplied', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-4.5', usage, 'flex')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/flex/)
  })

  it('prices grok-4.5 priority and rejects fast', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const priority = computeXaiCost('grok-4.5', usage, 'priority')
    const standard = computeXaiCost('grok-4.5', usage)
    expect(priority.microUsd).toBe((standard.microUsd ?? 0) * 2)
    const fast = computeXaiCost('grok-4.5', usage, 'fast')
    expect(fast.microUsd).toBeNull()
    expect(fast.unpricedReason).toMatch(/fast/)
  })

  it('prices grok-4.6 priority at 2× the standard list', () => {
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const standard = computeXaiCost('grok-4.6', usage)
    const priority = computeXaiCost('grok-4.6', usage, 'priority')
    expect(standard.microUsd).not.toBeNull()
    expect(standard.confidence).toBe('exact')
    expect(priority.microUsd).toBe((standard.microUsd as number) * 2)
    expect(priority.confidence).toBe('exact')
    expect(priority.details.input).toBe(standard.details.input * 2)
    expect(priority.details.cached).toBe(standard.details.cached * 2)
    expect(priority.details.output).toBe(standard.details.output * 2)
  })

  it('prices grok-4.6 served tier default at the standard list (exact)', () => {
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const standard = computeXaiCost('grok-4.6', usage)
    const servedDefault = computeXaiCost('grok-4.6', usage, 'default')
    expect(servedDefault).toEqual(standard)
    expect(servedDefault.confidence).toBe('exact')
  })

  it('prices grok-4.5 served tier default at the standard list (exact)', () => {
    const usage = makeUsage({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    })
    const standard = computeXaiCost('grok-4.5', usage)
    const servedDefault = computeXaiCost('grok-4.5', usage, 'default')
    expect(servedDefault).toEqual(standard)
    expect(servedDefault.confidence).toBe('exact')
  })

  it('does NOT prefix-match aliases — grok-4.5-latest is unpriced', () => {
    // Alias ids are deliberately not registered/priced (reject-don't-map);
    // exact-match-only lookup prevents `grok-4.5-latest` from silently
    // pricing as `grok-4.5`.
    const usage = makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000 })
    const cost = computeXaiCost('grok-4.5-latest', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.usd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/grok-4\.5-latest/)
  })

  it('does NOT prefix-match grok-build-latest either', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 50 })
    const cost = computeXaiCost('grok-build-latest', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/grok-build-latest/)
  })
})

describe('XAI_PRICING vs live /v1/models fixture', () => {
  it.each(['grok-4.5', 'grok-4.6'] as const)(
    'pins %s rates to captured /v1/models raw fields',
    (model) => {
      const raw = v1Models.models[model]
      const rates = XAI_PRICING[model]
      if (raw === undefined || rates === undefined) {
        throw new Error(`missing pricing fixture or rates for ${model}`)
      }
      expect(rates.inputPerM).toBe(rawToMicroPerM(raw.prompt_text_token_price))
      expect(rates.cachedPerM).toBe(rawToMicroPerM(raw.cached_prompt_text_token_price))
      expect(rates.outputPerM).toBe(rawToMicroPerM(raw.completion_text_token_price))
      expect(rates.gt200k?.inputPerM).toBe(
        rawToMicroPerM(raw.prompt_text_token_price_long_context),
      )
      expect(rates.gt200k?.cachedPerM).toBe(
        rawToMicroPerM(raw.cached_prompt_text_token_price_long_context),
      )
      expect(rates.gt200k?.outputPerM).toBe(
        rawToMicroPerM(raw.completion_text_token_price_long_context),
      )
    },
  )
})

describe('computeXaiCost vs live cost_in_usd_ticks', () => {
  it('reconciles grok-4.6 priority fixture ticks at 2× the standard list', () => {
    const usage = grok46PriorityFixture.body.usage
    const cost = computeXaiCost(
      'grok-4.6',
      makeUsage({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      }),
      'priority',
    )
    // 1 tick = 1e-10 USD; Cost.usd is USD. Fixture 12: 82_960_000 ticks.
    expect(cost.usd).toBe(usage.cost_in_usd_ticks * 1e-10)
    expect(cost.confidence).toBe('exact')
  })
})

describe('xaiPricingSource', () => {
  it('prices grok-4.7 at the 4.6 list, including the 200k boundary and priority', () => {
    const below = computeXaiCost(
      'grok-4.7',
      makeUsage({ inputTokens: 199_999, outputTokens: 0 }),
    )
    const at = computeXaiCost(
      'grok-4.7',
      makeUsage({ inputTokens: 200_000, outputTokens: 0 }),
    )
    expect(below.microUsd).toBe(Math.round((199_999 * 2_000_000) / 1_000_000))
    expect(at.microUsd).toBe(Math.round((200_000 * 4_000_000) / 1_000_000))
    const cached = computeXaiCost(
      'grok-4.7',
      makeUsage({ inputTokens: 1_000, cachedInputTokens: 1_000, outputTokens: 0 }),
    )
    expect(cached.details.cached).toBe(Math.round((1_000 * 500_000) / 1_000_000))
    const priority = computeXaiCost(
      'grok-4.7',
      makeUsage({ inputTokens: 1_000, outputTokens: 1_000 }),
      'priority',
    )
    const standard = computeXaiCost(
      'grok-4.7',
      makeUsage({ inputTokens: 1_000, outputTokens: 1_000 }),
    )
    expect(priority.microUsd).toBe((standard.microUsd as number) * 2)
  })

  it('hasModel is true for grok-4.5 / grok-4.6 and false for an unknown model', () => {
    const source = xaiPricingSource()
    expect(source.hasModel('grok-4.5')).toBe(true)
    expect(source.hasModel('grok-4.6')).toBe(true)
    expect(source.hasModel('grok-99')).toBe(false)
  })

  it('hasModel is exact-match only — aliases are not recognized', () => {
    const source = xaiPricingSource()
    expect(source.hasModel('grok-4.5-latest')).toBe(false)
    expect(source.hasModel('grok-build-latest')).toBe(false)
  })

  it('listModels returns the XAI_PRICING keys', () => {
    const source = xaiPricingSource()
    expect(source.listModels()).toEqual(Object.keys(XAI_PRICING))
  })

  it('version matches xaiPricingVersion', () => {
    expect(xaiPricingSource().version).toBe(xaiPricingVersion)
  })

  it('price() delegates to computeXaiCost', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 500 })
    const cost = xaiPricingSource().price('grok-4.5', usage)
    expect(cost.confidence).toBe('exact')
  })
})

describe('computeXaiCost — tool lanes (live-pinned 2026-08-24)', () => {
  it('prices web_search_calls at $5/1k and x_search by fetched items', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: {
        web_search_calls: 2,
        x_posts_fetched: 44,
        x_users_fetched: 3,
      },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    // $5/1k = 5_000 µUSD per unit. 2 web calls + 44 posts + 3 profiles.
    expect(cost.details.tools).toBe(2 * 5_000 + 44 * 5_000 + 3 * 10_000)
    expect(cost.confidence).toBe('exact')
    expect(
      cost.details.input + cost.details.cached + cost.details.output + cost.details.tools,
    ).toBe(cost.microUsd)
  })

  it('gt200k token rates still apply independently of tool lanes', () => {
    const usage: Usage = {
      inputTokens: 200_001,
      outputTokens: 0,
      details: { web_search_calls: 1 },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.input).toBe(800_004)
    expect(cost.details.tools).toBe(5_000)
  })

  it('server_tools_requested without counters → tools 0, estimated', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: { server_tools_requested: 1 },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('estimated')
    expect(cost.details.input).toBeGreaterThan(0)
  })

  it('no server tools requested → exact, tools 0', () => {
    const usage = makeUsage({ inputTokens: 1000, outputTokens: 0 })
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('exact')
  })

  it('server_tools_missing unprices the call even if another counter is present', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: {
        server_tools_requested: 1,
        server_tools_missing: 1,
        x_posts_fetched: 2,
        x_users_fetched: 0,
      },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.microUsd).toBeNull()
    expect(cost.confidence).toBe('estimated')
    expect(cost.unpricedReason).toMatch(/missing/i)
  })

  it.each([{ x_posts_fetched: 4 }, { x_users_fetched: 1 }, {}])(
    'x_search with a missing item counter unprices the call (%j)',
    (counters) => {
      const usage: Usage = {
        inputTokens: 1000,
        outputTokens: 0,
        details: {
          server_tools_requested: 1,
          x_search_requested: 1,
          ...counters,
        },
        raw: null,
      }
      const cost = computeXaiCost('grok-4.5', usage)
      expect(cost.microUsd).toBeNull()
      expect(cost.unpricedReason).toMatch(/x_posts_fetched|x_users_fetched/)
    },
  )

  it('x_search with both item counters at zero is exact and adds no tool cost', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: {
        server_tools_requested: 1,
        x_search_requested: 1,
        x_posts_fetched: 0,
        x_users_fetched: 0,
      },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.microUsd).not.toBeNull()
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('exact')
  })

  it('grok-4.5 priority is 2× on input, cached, and gt200k', () => {
    const below = makeUsage({
      inputTokens: 100_000,
      cachedInputTokens: 40_000,
      outputTokens: 1_000,
    })
    const standard = computeXaiCost('grok-4.5', below)
    const priority = computeXaiCost('grok-4.5', below, 'priority')
    expect(priority.details.input).toBe((standard.details.input ?? 0) * 2)
    expect(priority.details.cached).toBe((standard.details.cached ?? 0) * 2)
    expect(priority.details.output).toBe((standard.details.output ?? 0) * 2)

    const atBoundary = makeUsage({ inputTokens: 200_000, outputTokens: 0 })
    const boundary = computeXaiCost('grok-4.5', atBoundary, 'priority')
    expect(boundary.details.input).toBe(Math.round((200_000 * 8_000_000) / 1_000_000))
  })

  it('grok-4.5 rejects fast as a priced tier', () => {
    const usage = makeUsage({ inputTokens: 100, outputTokens: 10 })
    const cost = computeXaiCost('grok-4.5', usage, 'fast')
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toMatch(/fast/)
  })

  it('file-ref attachment_search_unpinned → estimated even with web counters', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: {
        server_tools_requested: 1,
        attachment_search_unpinned: 1,
        web_search_calls: 1,
      },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(5_000)
    expect(cost.confidence).toBe('estimated')
  })

  it('file-ref only (unpinned, no web/X counters) → estimated tools 0', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: {
        server_tools_requested: 1,
        attachment_search_unpinned: 1,
      },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(0)
    expect(cost.confidence).toBe('estimated')
  })

  it('server_tools_requested with counters present → exact and priced', () => {
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 0,
      details: { server_tools_requested: 1, web_search_calls: 1 },
      raw: null,
    }
    const cost = computeXaiCost('grok-4.5', usage)
    expect(cost.details.tools).toBe(5_000)
    expect(cost.confidence).toBe('exact')
  })
})
