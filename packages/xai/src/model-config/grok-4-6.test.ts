/**
 * @gullabs/xai — Grok46ConfigSchema unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { Grok46ConfigSchema } from './grok-4-6.js'

describe('Grok46ConfigSchema', () => {
  it('rejects an unknown top-level key', () => {
    const result = Grok46ConfigSchema.safeParse({ topK: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects stopSequences', () => {
    const result = Grok46ConfigSchema.safeParse({ stopSequences: ['STOP'] })
    expect(result.success).toBe(false)
  })

  it('rejects presencePenalty', () => {
    const result = Grok46ConfigSchema.safeParse({ presencePenalty: 0.5 })
    expect(result.success).toBe(false)
  })

  it.each(['flex', 'standard', 'batch', 'default'])(
    'rejects serviceTier=%s',
    (serviceTier) => {
      const result = Grok46ConfigSchema.safeParse({ serviceTier })
      expect(result.success).toBe(false)
    },
  )

  it('accepts serviceTier=priority', () => {
    const result = Grok46ConfigSchema.safeParse({ serviceTier: 'priority' })
    expect(result.success).toBe(true)
  })

  it('rejects reasoning.budgetTokens', () => {
    const result = Grok46ConfigSchema.safeParse({
      reasoning: { budgetTokens: 1000 },
    })
    expect(result.success).toBe(false)
  })

  it('rejects reasoning.effort=none', () => {
    const result = Grok46ConfigSchema.safeParse({ reasoning: { effort: 'none' } })
    expect(result.success).toBe(false)
  })

  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'accepts reasoning.effort=%s',
    (effort) => {
      const result = Grok46ConfigSchema.safeParse({ reasoning: { effort } })
      expect(result.success).toBe(true)
    },
  )

  it('accepts an empty config', () => {
    const result = Grok46ConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('caps maxOutputTokens at the context window, the only documented bound', () => {
    expect(Grok46ConfigSchema.safeParse({ maxOutputTokens: 500_000 }).success).toBe(true)
    expect(Grok46ConfigSchema.safeParse({ maxOutputTokens: 500_001 }).success).toBe(false)
  })

  it('rejects a non-positive maxOutputTokens', () => {
    const result = Grok46ConfigSchema.safeParse({ maxOutputTokens: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer maxOutputTokens', () => {
    const result = Grok46ConfigSchema.safeParse({ maxOutputTokens: 12.5 })
    expect(result.success).toBe(false)
  })

  it('accepts providerOptions.xai.promptCacheKey', () => {
    const result = Grok46ConfigSchema.safeParse({
      providerOptions: { xai: { promptCacheKey: 'my-key' } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown key under providerOptions.xai', () => {
    const result = Grok46ConfigSchema.safeParse({
      providerOptions: { xai: { bogus: true } },
    })
    expect(result.success).toBe(false)
  })

  it('rejects temperature/topP of the wrong type', () => {
    const result = Grok46ConfigSchema.safeParse({ temperature: 'hot' })
    expect(result.success).toBe(false)
  })

  it('accepts temperature and topP', () => {
    const result = Grok46ConfigSchema.safeParse({ temperature: 0.7, topP: 0.9 })
    expect(result.success).toBe(true)
  })

  it('accepts timeoutMs', () => {
    const result = Grok46ConfigSchema.safeParse({ timeoutMs: 30_000 })
    expect(result.success).toBe(true)
  })
})
