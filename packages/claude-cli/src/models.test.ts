/**
 * @gullabs/claude-cli — model config schema + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'
import {
  CLAUDE_CLI_EFFORTS,
  ClaudeFable51ConfigSchema,
  ClaudeHaiku45ConfigSchema,
  ClaudeOpus55ConfigSchema,
  ClaudeSonnet5ConfigSchema,
  claudeCliModelDescriptors,
  claudeCliRegistry,
} from './models.js'

const EXPECTED_MODEL_IDS = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

describe('config schema', () => {
  it('rejects an unknown key (strict object)', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({ temperature: 0.5 })
    expect(result.success).toBe(false)
  })

  it('rejects a bad effort value', () => {
    const result = ClaudeSonnet5ConfigSchema.safeParse({
      reasoning: { effort: 'extreme' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a reasoning key on Haiku 4.5', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({
      reasoning: { effort: 'high' },
    })
    expect(result.success).toBe(false)
  })

  it.each([
    ['claude-fable-5-1', ClaudeFable51ConfigSchema],
    ['claude-opus-5-5', ClaudeOpus55ConfigSchema],
    ['claude-sonnet-5', ClaudeSonnet5ConfigSchema],
  ] as const)('%s accepts low through max and rejects none', (id, schema) => {
    const descriptor = claudeCliRegistry.resolve('claude-cli', id)
    expect(descriptor?.configSchema).toBe(schema)
    expect(descriptor?.capabilities?.admittedReasoningEfforts).toEqual(CLAUDE_CLI_EFFORTS)
    for (const effort of CLAUDE_CLI_EFFORTS) {
      expect(schema.safeParse({ reasoning: { effort } }).success).toBe(true)
    }
    expect(schema.safeParse({ reasoning: { effort: 'none' } }).success).toBe(false)
  })

  it('accepts an empty config', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('registry', () => {
  const ids = EXPECTED_MODEL_IDS

  it('has exactly 4 descriptors', () => {
    expect(claudeCliModelDescriptors).toHaveLength(4)
  })

  it('publishes schema artifacts for every model and keeps the pinned model-id list', () => {
    assertRegistryInvariants({
      descriptors: claudeCliModelDescriptors,
      expectedModelIds: EXPECTED_MODEL_IDS,
    })
  })

  it.each(ids)('resolves descriptor for %s', (id) => {
    const descriptor = claudeCliRegistry.resolve('claude-cli', id)
    expect(descriptor).toBeDefined()
    expect(descriptor?.model).toBe(id)
    expect(descriptor?.provider).toBe('claude-cli')
  })

  it.each(['claude-fable-5', 'claude-opus-4-8'])('resolve(%s) is undefined', (id) => {
    expect(claudeCliRegistry.resolve('claude-cli', id)).toBeUndefined()
  })

  it('does not advertise a reasoning control for Haiku 4.5', () => {
    const descriptor = claudeCliRegistry.resolve(
      'claude-cli',
      'claude-haiku-4-5-20251001',
    )
    expect(descriptor?.capabilities?.reasoningApi).toBeUndefined()
    expect(descriptor?.capabilities?.admittedReasoningEfforts).toEqual([])
    expect(
      descriptor?.configSchema.safeParse({ reasoning: { effort: 'high' } }).success,
    ).toBe(false)
  })

  it('validateConfig accepts a valid config via the Standard Schema surface', () => {
    const descriptor = claudeCliRegistry.resolve('claude-cli', 'claude-sonnet-5')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'medium' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('validateConfig rejects an invalid config via the Standard Schema surface', () => {
    const descriptor = claudeCliRegistry.resolve(
      'claude-cli',
      'claude-haiku-4-5-20251001',
    )
    const result = descriptor?.validateConfig['~standard'].validate({
      temperature: 0.7,
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeDefined()
    }
  })
})

describe('claude-cli limits and media (docs read 2026-10-03)', () => {
  it('states each model context window and maximum output, and admits no media', () => {
    const byModel = Object.fromEntries(
      claudeCliModelDescriptors.map((d) => [d.model, d.limits]),
    )
    expect(byModel).toEqual({
      'claude-fable-5-1': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-opus-5-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-sonnet-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      'claude-haiku-4-5-20251001': { contextWindow: 200_000, maxOutputTokens: 64_000 },
    })
    for (const d of claudeCliModelDescriptors) {
      expect(d.capabilities?.inputMimeTypes).toEqual([])
    }
  })
})

describe('claude-cli configKeys (R5)', () => {
  it('lists only the keys each schema names: Haiku has no reasoning, none has maxOutputTokens', () => {
    for (const d of claudeCliModelDescriptors) {
      const haiku = d.model === 'claude-haiku-4-5-20251001'
      expect(d.configKeys).toEqual(haiku ? ['timeoutMs'] : ['reasoning', 'timeoutMs'])
    }
  })
})
