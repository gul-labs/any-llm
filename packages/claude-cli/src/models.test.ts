/**
 * @gullabs/claude-cli — model config schema + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'
import {
  CLAUDE_CLI_EFFORTS,
  ClaudeFable52ConfigSchema,
  ClaudeHaiku55ConfigSchema,
  ClaudeOpus55ConfigSchema,
  ClaudeSonnet55ConfigSchema,
  claudeCliModelDescriptors,
  claudeCliRegistry,
} from './models.js'

const EXPECTED_MODEL_IDS = [
  'claude-fable-5-2',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
] as const

const REMOVED_MODEL_IDS = [
  'claude-fable-5-1',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

describe('config schema', () => {
  it('rejects an unknown key (strict object)', () => {
    const result = ClaudeHaiku55ConfigSchema.safeParse({ temperature: 0.5 })
    expect(result.success).toBe(false)
  })

  it('rejects a bad effort value', () => {
    const result = ClaudeSonnet55ConfigSchema.safeParse({
      reasoning: { effort: 'extreme' },
    })
    expect(result.success).toBe(false)
  })

  it.each([
    ['claude-fable-5-2', ClaudeFable52ConfigSchema],
    ['claude-opus-5-5', ClaudeOpus55ConfigSchema],
    ['claude-sonnet-5-5', ClaudeSonnet55ConfigSchema],
    ['claude-haiku-5-5', ClaudeHaiku55ConfigSchema],
  ] as const)(
    '%s accepts low through max and rejects none and ultracode',
    (id, schema) => {
      const descriptor = claudeCliRegistry.resolve('claude-cli', id)
      expect(descriptor?.configSchema).toBe(schema)
      expect(descriptor?.capabilities?.reasoningApi).toBe('level')
      expect(descriptor?.capabilities?.admittedReasoningEfforts).toEqual(
        CLAUDE_CLI_EFFORTS,
      )
      expect([...CLAUDE_CLI_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      for (const effort of CLAUDE_CLI_EFFORTS) {
        expect(schema.safeParse({ reasoning: { effort } }).success).toBe(true)
      }
      expect(schema.safeParse({ reasoning: { effort: 'none' } }).success).toBe(false)
      // `ultracode` is a Claude Code workflow switch, not a model level.
      expect(schema.safeParse({ reasoning: { effort: 'ultracode' } }).success).toBe(false)
    },
  )

  it('accepts an empty config', () => {
    const result = ClaudeHaiku55ConfigSchema.safeParse({})
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

  it('registers the four ids in this order', () => {
    expect(claudeCliModelDescriptors.map((d) => d.model)).toEqual([
      'claude-fable-5-2',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ])
  })

  it.each([...REMOVED_MODEL_IDS, 'claude-fable-5', 'claude-opus-4-8'])(
    'resolve(%s) is undefined',
    (id) => {
      expect(claudeCliRegistry.resolve('claude-cli', id)).toBeUndefined()
    },
  )

  it('validateConfig accepts a valid config via the Standard Schema surface', () => {
    const descriptor = claudeCliRegistry.resolve('claude-cli', 'claude-sonnet-5-5')
    const result = descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'medium' },
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeUndefined()
    }
  })

  it('validateConfig rejects an invalid config via the Standard Schema surface', () => {
    const descriptor = claudeCliRegistry.resolve('claude-cli', 'claude-haiku-5-5')
    const result = descriptor?.validateConfig['~standard'].validate({
      temperature: 0.7,
    })
    expect(result).toBeDefined()
    if (result !== undefined && !(result instanceof Promise)) {
      expect(result.issues).toBeDefined()
    }
  })
})

describe('claude-cli limits and media', () => {
  // The documented API figures (Anthropic models overview, read 2026-11-20), not a
  // value the CLI has been captured reporting for these ids.
  it('states the documented 1M context and 128K output for every model, and admits no media', () => {
    for (const d of claudeCliModelDescriptors) {
      expect(d.limits, d.model).toEqual({
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
      })
      expect(d.capabilities?.inputMimeTypes).toEqual([])
    }
  })
})

describe('claude-cli configKeys', () => {
  it('lists the keys every schema names and none has maxOutputTokens', () => {
    for (const d of claudeCliModelDescriptors) {
      expect(d.configKeys).toEqual(['reasoning', 'timeoutMs'])
    }
  })
})
