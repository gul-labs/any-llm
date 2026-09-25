/**
 * @gullabs/claude-cli — model config schema + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'
import {
  CLAUDE_CLI_EFFORTS,
  CLAUDE_CLI_MODEL_IDS,
  ClaudeFable51ConfigSchema,
  ClaudeHaiku45ConfigSchema,
  ClaudeOpus55ConfigSchema,
  ClaudeSonnet5ConfigSchema,
  DELETED_CLAUDE_CLI_MODEL_IDS,
  claudeCliModelDescriptors,
  claudeCliRegistry,
} from './models.js'

const EXPECTED_MODEL_IDS = CLAUDE_CLI_MODEL_IDS

describe('config schema', () => {
  it('rejects an unknown key (strict object)', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({ temperature: 0.5 })
    expect(result.success).toBe(false)
  })

  it('rejects a bad effort value', () => {
    const result = ClaudeHaiku45ConfigSchema.safeParse({
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
    expect(id).toBeTruthy()
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

  it.each(DELETED_CLAUDE_CLI_MODEL_IDS)('resolve(%s) is undefined', (id) => {
    expect(claudeCliRegistry.resolve('claude-cli', id)).toBeUndefined()
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
