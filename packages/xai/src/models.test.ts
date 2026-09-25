/**
 * @gullabs/xai — model descriptor + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'
import {
  Grok45ConfigSchema,
  Grok46ConfigSchema,
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  xaiModelDescriptors,
  xaiRegistry,
} from './models.js'
import { xaiPricingSource } from './pricing.js'

const EXPECTED_XAI_MODEL_IDS = ['grok-4.5', 'grok-4.6'] as const

describe('grok45ModelDescriptor', () => {
  it('is keyed by provider "xai" and model "grok-4.5"', () => {
    expect(grok45ModelDescriptor.provider).toBe('xai')
    expect(grok45ModelDescriptor.model).toBe('grok-4.5')
    expect(grok45ModelDescriptor.pricingFamily).toBe('grok-4.5')
  })

  it('capabilities match what the adapter actually enforces', () => {
    expect(grok45ModelDescriptor.capabilities).toMatchObject({
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: ['low', 'medium', 'high'],
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      audioInput: false,
      sampling: 'tunable',
      caching: { explicit: false, minTokens: 0 },
      grounding: true,
      functionCalling: true,
    })
    expect(grok45ModelDescriptor.capabilities?.serviceTiers).toEqual(['priority'])
  })

  it('configJsonSchema is structurally derived from Grok45ConfigSchema', () => {
    expect(grok45ModelDescriptor.configJsonSchema).toBeDefined()
    const jsonSchema = grok45ModelDescriptor.configJsonSchema as {
      properties?: Record<string, unknown>
    }
    expect(jsonSchema.properties).toBeDefined()
    expect(Object.keys(jsonSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'temperature',
        'topP',
        'maxOutputTokens',
        'reasoning',
        'serviceTier',
        'timeoutMs',
        'providerOptions',
      ]),
    )
  })

  it('uses the same schema instance as Grok45ConfigSchema', () => {
    expect(grok45ModelDescriptor.configSchema).toBe(Grok45ConfigSchema)
  })
})

describe('grok46ModelDescriptor', () => {
  it('is keyed by provider "xai" and model "grok-4.6"', () => {
    expect(grok46ModelDescriptor.provider).toBe('xai')
    expect(grok46ModelDescriptor.model).toBe('grok-4.6')
    expect(grok46ModelDescriptor.pricingFamily).toBe('grok-4.6')
  })

  it('capabilities match what the adapter actually enforces', () => {
    expect(grok46ModelDescriptor.capabilities).toMatchObject({
      reasoning: true,
      reasoningApi: 'level',
      admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      structuredOutput: true,
      nativeStructuredOutput: true,
      vision: true,
      audioInput: false,
      sampling: 'tunable',
      caching: { explicit: false, minTokens: 0 },
      grounding: true,
      functionCalling: true,
      serviceTiers: ['priority'],
    })
  })

  it('configJsonSchema is structurally derived from Grok46ConfigSchema', () => {
    expect(grok46ModelDescriptor.configJsonSchema).toBeDefined()
    const jsonSchema = grok46ModelDescriptor.configJsonSchema as {
      properties?: Record<string, unknown>
    }
    expect(jsonSchema.properties).toBeDefined()
    expect(Object.keys(jsonSchema.properties ?? {})).toEqual(
      expect.arrayContaining([
        'temperature',
        'topP',
        'maxOutputTokens',
        'reasoning',
        'serviceTier',
        'timeoutMs',
        'providerOptions',
      ]),
    )
  })

  it('uses the same schema instance as Grok46ConfigSchema', () => {
    expect(grok46ModelDescriptor.configSchema).toBe(Grok46ConfigSchema)
  })
})

describe('xaiModelDescriptors', () => {
  it('fails model onboarding unless schema, fixtures, and pricing decisions are explicit', () => {
    assertRegistryInvariants({
      descriptors: xaiModelDescriptors,
      expectedModelIds: EXPECTED_XAI_MODEL_IDS,
      pricingSource: xaiPricingSource(),
      adapterFixtureModelIds: ['grok-4.5', 'grok-4.6'],
      negativeContractFixtureModelIds: ['grok-4.5', 'grok-4.6'],
    })
  })
})

describe('xaiRegistry', () => {
  it('resolves (xai, grok-4.5) and (xai, grok-4.6)', () => {
    const grok45 = xaiRegistry.resolve('xai', 'grok-4.5')
    expect(grok45).toBeDefined()
    expect(grok45?.model).toBe('grok-4.5')
    expect(grok45?.provider).toBe('xai')
    const grok46 = xaiRegistry.resolve('xai', 'grok-4.6')
    expect(grok46).toBeDefined()
    expect(grok46?.model).toBe('grok-4.6')
    expect(grok46?.provider).toBe('xai')
  })

  it('returns undefined for an unregistered model', () => {
    expect(xaiRegistry.resolve('xai', 'grok-99')).toBeUndefined()
  })

  it('validateConfig accepts a valid config via the Standard Schema surface', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.5')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'high' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('validateConfig accepts grok-4.5 medium (live-verified 2026-08-24)', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.5')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'medium' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('admittedReasoningEfforts matches the grok-4.5 schema enum', () => {
    const effort = Grok45ConfigSchema.shape.reasoning.unwrap().shape.effort
    expect([...grok45ModelDescriptor.capabilities!.admittedReasoningEfforts!]).toEqual([
      ...effort.options,
    ])
  })

  it('validateConfig accepts grok-4.6 xhigh and priority', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.6')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'xhigh' },
      serviceTier: 'priority',
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('validateConfig rejects grok-4.6 effort none', () => {
    const descriptor = xaiRegistry.resolve('xai', 'grok-4.6')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'none' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeDefined()
    }
  })
})
