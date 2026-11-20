import { describe, expect, it } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'

import {
  defaultGeminiRegistry,
  gemmaModelDescriptors,
  geminiModelDescriptors,
} from './models.js'
import { geminiPricingSource } from './cost.js'
import { computeCost } from '@gullabs/core'
import {
  GEMINI_GROUNDING_PRICING,
  GEMINI_PRICING,
  resolveGeminiRates,
  pricingVersion,
} from './pricing.js'
import { GOOGLE_MODEL_LIMITS } from './model-limits.js'
import * as modelConfigs from './model-config/index.js'

const EXPECTED_GEMINI_MODEL_IDS = [
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-4-carbon',
  'gemini-4-argon',
  'gemini-4-neon',
  'gemini-4-hydrogen',
] as const
const EXPECTED_GEMMA_MODEL_IDS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'] as const
const EXPECTED_BUILT_IN_MODEL_IDS = [
  ...EXPECTED_GEMINI_MODEL_IDS,
  ...EXPECTED_GEMMA_MODEL_IDS,
] as const
const ADAPTER_FIXTURE_MODEL_IDS = EXPECTED_BUILT_IN_MODEL_IDS
const NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS = EXPECTED_BUILT_IN_MODEL_IDS
const EXPLICIT_UNPRICED_MODEL_IDS = new Set<string>(EXPECTED_GEMMA_MODEL_IDS)

describe('built-in descriptors', () => {
  it('keeps the expected built-in model ids registered', () => {
    expect(geminiModelDescriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_GEMINI_MODEL_IDS,
    )

    expect(gemmaModelDescriptors.map((descriptor) => descriptor.model)).toEqual(
      EXPECTED_GEMMA_MODEL_IDS,
    )
  })

  it('fails model onboarding unless schema, fixtures, and pricing decisions are explicit', () => {
    assertRegistryInvariants({
      descriptors: [...geminiModelDescriptors, ...gemmaModelDescriptors],
      expectedModelIds: EXPECTED_BUILT_IN_MODEL_IDS,
      pricingSource: geminiPricingSource(),
      explicitlyUnpriced: EXPLICIT_UNPRICED_MODEL_IDS,
      adapterFixtureModelIds: ADAPTER_FIXTURE_MODEL_IDS,
      negativeContractFixtureModelIds: NEGATIVE_CONTRACT_FIXTURE_MODEL_IDS,
    })
  })

  it('enforces the stricter documented reasoning effort sets', () => {
    expect(
      geminiModelDescriptors.find(
        (descriptor) => descriptor.model === 'gemini-3.1-pro-preview',
      )?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high'])

    expect(
      gemmaModelDescriptors.find((descriptor) => descriptor.model === 'gemma-4-31b-it')
        ?.capabilities?.admittedReasoningEfforts,
    ).toEqual(['none', 'high'])
  })

  it('default registry resolves known models scoped to google and does not register deleted aliases', () => {
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.1-pro-preview')?.capabilities
        ?.caching?.minTokens,
    ).toBe(1024)
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.1-pro-preview')?.capabilities
        ?.structuredOutputWithTools,
    ).toBe(false)
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.8-flash')?.capabilities
        ?.structuredOutputWithTools,
    ).toBe(false)
    for (const model of [
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ]) {
      expect(
        defaultGeminiRegistry.resolve('google', model)?.capabilities
          ?.structuredOutputWithTools,
      ).toBe(false)
    }
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.8-flash')?.capabilities?.caching
        ?.minTokens,
    ).toBe(1024)
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.5-flash-lite')?.capabilities
        ?.caching?.minTokens,
    ).toBe(1024)
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.8-flash')?.capabilities
        ?.admittedReasoningEfforts,
    ).toEqual(['low', 'medium', 'high'])
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-3.6-flash')?.capabilities
        ?.admittedReasoningEfforts,
    ).toEqual(['none', 'low', 'medium', 'high'])
    expect(
      defaultGeminiRegistry.resolve('google', 'gemini-2.5-flash-lite')?.capabilities
        ?.structuredOutputWithTools,
    ).toBeUndefined()
    expect(defaultGeminiRegistry.resolve('google', 'gemma-4-31b-it')?.provider).toBe(
      'google',
    )
    expect(
      defaultGeminiRegistry.resolve('google', 'google/gemma-4-31b-it'),
    ).toBeUndefined()
    // Same bare model resolved under a foreign provider must miss entirely.
    expect(defaultGeminiRegistry.resolve('anthropic', 'gemini-3.8-flash')).toBeUndefined()
  })

  // Removed 2026-11-20 (ADR-048): 3.7 Flash is deprecated and routed to 3.8 Flash,
  // and 2.5 Pro / 2.5 Flash are served by other models at other rates from
  // 2026-12-01. No alias: the id is gone.
  it.each([
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-3.7-flash',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ] as const)('deleted id %s does not resolve and is unpriced', (model) => {
    expect(defaultGeminiRegistry.resolve('google', model)).toBeUndefined()
    expect(geminiModelDescriptors.some((descriptor) => descriptor.model === model)).toBe(
      false,
    )
    const cost = computeCost(
      model,
      { inputTokens: 1_000, outputTokens: 100, details: {}, raw: null },
      'standard',
      resolveGeminiRates,
      pricingVersion,
    )
    expect(cost.microUsd).toBeNull()
    expect(cost.unpricedReason).toContain(model)
    expect(geminiPricingSource().hasModel(model)).toBe(false)
    expect(geminiPricingSource().listModels()).not.toContain(model)
    expect(Object.hasOwn(GEMINI_PRICING, model)).toBe(false)
    expect(Object.hasOwn(GEMINI_GROUNDING_PRICING, model)).toBe(false)
    expect(Object.hasOwn(GOOGLE_MODEL_LIMITS, model)).toBe(false)
  })

  it('no config schema is exported for a removed model', () => {
    expect(
      Object.keys(modelConfigs).filter((name) =>
        /^Gemini(25Pro|25Flash|37Flash)ConfigSchema$/.test(name),
      ),
    ).toEqual([])
  })
})
