/**
 * @gullabs/codex-cli model config schema + registry tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from '@gullabs/testing'
import {
  CODEX_CLI_MODEL_IDS,
  CODEX_CLI_REASONING_EFFORTS,
  Gpt6SolConfigSchema,
  codexCliModelDescriptors,
  codexCliRegistry,
} from './models.js'

describe('codex-cli config schemas', () => {
  it('rejects unknown keys (strict object)', () => {
    const result = Gpt6SolConfigSchema.safeParse({ notARealKey: true })
    expect(result.success).toBe(false)
  })

  it('rejects a bad reasoning effort', () => {
    const result = Gpt6SolConfigSchema.safeParse({
      reasoning: { effort: 'ultra-mega' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects ultra (CLI delegation switch, not a reasoning level)', () => {
    const result = Gpt6SolConfigSchema.safeParse({ reasoning: { effort: 'ultra' } })
    expect(result.success).toBe(false)
  })

  it('rejects reasoning.effort "none" (not admitted by codex-cli, unlike core)', () => {
    const result = Gpt6SolConfigSchema.safeParse({ reasoning: { effort: 'none' } })
    expect(result.success).toBe(false)
  })

  it('accepts each admitted reasoning effort', () => {
    for (const effort of CODEX_CLI_REASONING_EFFORTS) {
      const result = Gpt6SolConfigSchema.safeParse({ reasoning: { effort } })
      expect(result.success).toBe(true)
    }
  })

  it('accepts a valid timeoutMs', () => {
    const result = Gpt6SolConfigSchema.safeParse({ timeoutMs: 60_000 })
    expect(result.success).toBe(true)
  })

  it('rejects a timeoutMs above the 30-minute cap', () => {
    const result = Gpt6SolConfigSchema.safeParse({ timeoutMs: 1_800_001 })
    expect(result.success).toBe(false)
  })

  it('rejects temperature/topP/topK/maxOutputTokens/stopSequences on every model', () => {
    for (const key of [
      'temperature',
      'topP',
      'topK',
      'maxOutputTokens',
      'stopSequences',
    ]) {
      const result = Gpt6SolConfigSchema.safeParse({ [key]: 1 })
      expect(result.success).toBe(false)
    }
  })

  it('accepts an empty config object', () => {
    const result = Gpt6SolConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('deleted codex-cli model ids', () => {
  it.each(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'])(
    'resolve(%s) is undefined',
    (id) => {
      expect(codexCliRegistry.resolve('codex-cli', id)).toBeUndefined()
    },
  )

  it('registers no gpt-5 id', () => {
    for (const descriptor of codexCliModelDescriptors) {
      expect(descriptor.model.startsWith('gpt-5')).toBe(false)
    }
  })
})

describe('codexCliRegistry', () => {
  it('publishes schema artifacts for every model and keeps the pinned model-id list', () => {
    assertRegistryInvariants({
      descriptors: codexCliModelDescriptors,
      expectedModelIds: CODEX_CLI_MODEL_IDS,
    })
  })

  it('resolves every supported model id without throwing at construction', () => {
    for (const id of CODEX_CLI_MODEL_IDS) {
      const descriptor = codexCliRegistry.resolve('codex-cli', id)
      expect(descriptor).toBeDefined()
      expect(descriptor?.provider).toBe('codex-cli')
      expect(descriptor?.capabilities?.admittedReasoningEfforts).toEqual(
        CODEX_CLI_REASONING_EFFORTS,
      )
    }
  })

  it('validateConfig["~standard"].validate accepts a good config', async () => {
    const descriptor = codexCliRegistry.resolve('codex-cli', 'gpt-6-sol')
    expect(descriptor).toBeDefined()
    const result = await descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'high' },
    })
    expect(result?.issues).toBeUndefined()
  })

  it('validateConfig["~standard"].validate rejects a bad config', async () => {
    const descriptor = codexCliRegistry.resolve('codex-cli', 'gpt-6-sol')
    expect(descriptor).toBeDefined()
    const result = await descriptor?.validateConfig['~standard'].validate({
      temperature: 0.5,
    })
    expect(result?.issues).toBeDefined()
    expect(result?.issues?.length).toBeGreaterThan(0)
  })
})

describe('codex-cli limits and media (docs read 2026-10-03)', () => {
  it('states the 1,050,000-token window and 128,000 output, and admits no media', () => {
    for (const d of codexCliModelDescriptors) {
      expect(d.limits).toEqual({ contextWindow: 1_050_000, maxOutputTokens: 128_000 })
      expect(d.capabilities?.inputMimeTypes).toEqual([])
    }
  })
})
