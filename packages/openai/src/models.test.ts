/**
 * Model descriptors, registry invariants and the four strict config schemas
 * (documented, not live-verified; read 2026-11-20).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'
import type { z } from 'zod'

import {
  Gpt61TerraConfigSchema,
  Gpt62AstraConfigSchema,
  Gpt62SolConfigSchema,
  Gpt6LunaConfigSchema,
  openaiModelDescriptors,
  openaiRegistry,
} from './models.js'
import { openaiPricingSource } from './pricing.js'

const EXPECTED = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna'] as const

describe('registry', () => {
  it('holds the four models in order, every one priced and schema-derived', () => {
    assertRegistryInvariants({
      descriptors: openaiModelDescriptors,
      expectedModelIds: EXPECTED,
      pricingSource: openaiPricingSource(),
    })
  })

  it('every descriptor states the documented limits and the first-slice capabilities', () => {
    for (const d of openaiModelDescriptors) {
      expect(d.provider).toBe('openai')
      expect(d.pricingFamily).toBe(d.model)
      expect(d.aliases).toBeUndefined()
      expect(d.limits).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 128_000 })
      expect(d.capabilities).toMatchObject({
        inputMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        reasoning: true,
        reasoningApi: 'level',
        structuredOutput: true,
        nativeStructuredOutput: true,
        sampling: 'fixed',
        grounding: false,
        structuredOutputWithTools: false,
        functionCalling: true,
        continuation: 'state',
        providerState: true,
      })
    }
  })

  it.each([
    ['gpt-6.2-astra', ['low', 'medium'], ['fast']],
    ['gpt-6.2-sol', ['low', 'medium'], ['fast']],
    [
      'gpt-6.1-terra',
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['flex', 'fast'],
    ],
    ['gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], ['flex', 'fast']],
  ])(
    '%s admits efforts %j and tiers %j, the same as its schema',
    (model, efforts, tiers) => {
      const d = openaiRegistry.resolve('openai', model)!
      expect(d.capabilities?.admittedReasoningEfforts).toEqual(efforts)
      expect(d.capabilities?.serviceTiers).toEqual(tiers)
      const schema = d.configSchema as z.ZodObject<{
        reasoning: z.ZodOptional<z.ZodObject<{ effort: z.ZodEnum }>>
      }>
      expect(schema.shape.reasoning.unwrap().shape.effort.options).toEqual(efforts)
      expect(d.configKeys).toEqual([
        'maxOutputTokens',
        'reasoning',
        'serviceTier',
        'timeoutMs',
      ])
    },
  )

  it('resolves no alias or sibling id', () => {
    for (const id of [
      'gpt-6.2',
      'gpt-6.2-astra-law',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
    ]) {
      expect(openaiRegistry.resolve('openai', id)).toBeUndefined()
    }
  })
})

const ok = (schema: z.ZodType, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true)
const no = (schema: z.ZodType, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(false)

const COMMON_REJECTED_KEYS = [
  { temperature: 1 },
  { topP: 0.5 },
  { topK: 5 },
  { stopSequences: ['x'] },
  { providerOptions: {} },
  { providerOptions: { openai: {} } },
  { reasoning: { budgetTokens: 100 } },
  { reasoning: { includeThoughts: true } },
  { reasoning: { effort: 'low', context: 'all_turns' } },
  { reasoning: { effort: 'low', mode: 'pro' } },
  { reasoning: { effort: 'low', summary: 'auto' } },
  { maxOutputTokens: 128_001 },
  { maxOutputTokens: 0 },
  { maxOutputTokens: 1.5 },
  { timeoutMs: 0 },
  { timeoutMs: 2_147_478_648 },
  { verbosity: 'low' },
  { promptCacheKey: 'k' },
  { background: true },
]

describe.each([
  ['gpt-6.2-astra', Gpt62AstraConfigSchema],
  ['gpt-6.2-sol', Gpt62SolConfigSchema],
] as const)('%s config schema', (_model, schema) => {
  it('accepts an empty config and the admitted values', () => {
    ok(schema, {})
    ok(schema, { reasoning: { effort: 'low' } })
    ok(schema, { reasoning: { effort: 'medium' } })
    ok(schema, { serviceTier: 'fast' })
    ok(schema, { maxOutputTokens: 128_000, timeoutMs: 2_147_478_647 })
  })

  it.each(['none', 'minimal', 'high', 'xhigh', 'max'])('rejects effort %s', (effort) => {
    no(schema, { reasoning: { effort } })
  })

  it.each(['flex', 'ultrafast', 'priority', 'default', 'auto', 'scale', 'standard'])(
    'rejects serviceTier %s',
    (serviceTier) => {
      no(schema, { serviceTier })
    },
  )

  it.each(COMMON_REJECTED_KEYS)('rejects %j', (value) => {
    no(schema, value)
  })
})

describe.each([
  ['gpt-6.1-terra', Gpt61TerraConfigSchema],
  ['gpt-6-luna', Gpt6LunaConfigSchema],
] as const)('%s config schema', (_model, schema) => {
  it('accepts an empty config and the admitted values', () => {
    ok(schema, {})
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      ok(schema, { reasoning: { effort } })
    }
    ok(schema, { serviceTier: 'flex' })
    ok(schema, { serviceTier: 'fast' })
    ok(schema, { maxOutputTokens: 128_000 })
  })

  it.each(['minimal', 'ultra', 'auto'])('rejects effort %s', (effort) => {
    no(schema, { reasoning: { effort } })
  })

  it.each(['ultrafast', 'priority', 'default', 'auto', 'scale', 'standard', 'batch'])(
    'rejects serviceTier %s',
    (serviceTier) => {
      no(schema, { serviceTier })
    },
  )

  it.each(COMMON_REJECTED_KEYS)('rejects %j', (value) => {
    no(schema, value)
  })
})
