/**
 * @gullabs/xai — Grok45ConfigSchema unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { Grok45ConfigSchema } from './grok-4-5.js'

describe('Grok45ConfigSchema', () => {
  it('rejects an unknown top-level key', () => {
    const result = Grok45ConfigSchema.safeParse({ topK: 5 })
    expect(result.success).toBe(false)
  })

  it('rejects stopSequences', () => {
    const result = Grok45ConfigSchema.safeParse({ stopSequences: ['STOP'] })
    expect(result.success).toBe(false)
  })

  it('rejects presencePenalty', () => {
    const result = Grok45ConfigSchema.safeParse({ presencePenalty: 0.5 })
    expect(result.success).toBe(false)
  })

  it('admits live-verified priority', () => {
    expect(Grok45ConfigSchema.safeParse({ serviceTier: 'priority' }).success).toBe(true)
  })

  it.each(['flex', 'fast', 'standard'] as const)(
    'rejects serviceTier=%s',
    (serviceTier) => {
      const result = Grok45ConfigSchema.safeParse({ serviceTier })
      expect(result.success).toBe(false)
    },
  )

  it('rejects reasoning.budgetTokens', () => {
    const result = Grok45ConfigSchema.safeParse({
      reasoning: { budgetTokens: 1000 },
    })
    expect(result.success).toBe(false)
  })

  it.each(['none', 'xhigh'])('rejects reasoning.effort=%s', (effort) => {
    const result = Grok45ConfigSchema.safeParse({ reasoning: { effort } })
    expect(result.success).toBe(false)
  })

  it.each(['low', 'medium', 'high'] as const)('accepts reasoning.effort=%s', (effort) => {
    const result = Grok45ConfigSchema.safeParse({ reasoning: { effort } })
    expect(result.success).toBe(true)
  })

  it('accepts an empty config', () => {
    const result = Grok45ConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts a huge maxOutputTokens with no rejection', () => {
    const result = Grok45ConfigSchema.safeParse({ maxOutputTokens: 100_000_000 })
    expect(result.success).toBe(true)
  })

  it('rejects a non-positive maxOutputTokens', () => {
    const result = Grok45ConfigSchema.safeParse({ maxOutputTokens: 0 })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer maxOutputTokens', () => {
    const result = Grok45ConfigSchema.safeParse({ maxOutputTokens: 12.5 })
    expect(result.success).toBe(false)
  })

  it('accepts providerOptions.xai.promptCacheKey', () => {
    const result = Grok45ConfigSchema.safeParse({
      providerOptions: { xai: { promptCacheKey: 'my-key' } },
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown key under providerOptions.xai', () => {
    const result = Grok45ConfigSchema.safeParse({
      providerOptions: { xai: { bogus: true } },
    })
    expect(result.success).toBe(false)
  })

  it('rejects temperature/topP of the wrong type', () => {
    const result = Grok45ConfigSchema.safeParse({ temperature: 'hot' })
    expect(result.success).toBe(false)
  })

  it('accepts temperature and topP', () => {
    const result = Grok45ConfigSchema.safeParse({ temperature: 0.7, topP: 0.9 })
    expect(result.success).toBe(true)
  })

  it('accepts timeoutMs', () => {
    const result = Grok45ConfigSchema.safeParse({ timeoutMs: 30_000 })
    expect(result.success).toBe(true)
  })
})
