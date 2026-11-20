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
  Gpt61TerraConfigSchema,
  Gpt62AstraConfigSchema,
  Gpt62SolConfigSchema,
  Gpt6LunaConfigSchema,
  codexCliModelDescriptors,
  codexCliRegistry,
} from './models.js'

describe('codex-cli config schemas', () => {
  it('rejects unknown keys (strict object)', () => {
    const result = Gpt62SolConfigSchema.safeParse({ notARealKey: true })
    expect(result.success).toBe(false)
  })

  it('rejects a bad reasoning effort', () => {
    const result = Gpt62SolConfigSchema.safeParse({
      reasoning: { effort: 'ultra-mega' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects ultra (CLI delegation switch, not a reasoning level)', () => {
    const result = Gpt62SolConfigSchema.safeParse({ reasoning: { effort: 'ultra' } })
    expect(result.success).toBe(false)
  })

  it('rejects reasoning.effort "none" (not admitted by codex-cli, unlike core)', () => {
    const result = Gpt62SolConfigSchema.safeParse({ reasoning: { effort: 'none' } })
    expect(result.success).toBe(false)
  })

  it('accepts each admitted reasoning effort', () => {
    for (const effort of CODEX_CLI_REASONING_EFFORTS) {
      const result = Gpt62SolConfigSchema.safeParse({ reasoning: { effort } })
      expect(result.success).toBe(true)
    }
  })

  it('accepts a valid timeoutMs', () => {
    const result = Gpt62SolConfigSchema.safeParse({ timeoutMs: 60_000 })
    expect(result.success).toBe(true)
  })

  it('rejects a timeoutMs above the 30-minute cap', () => {
    const result = Gpt62SolConfigSchema.safeParse({ timeoutMs: 1_800_001 })
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
      const result = Gpt62SolConfigSchema.safeParse({ [key]: 1 })
      expect(result.success).toBe(false)
    }
  })

  it('accepts an empty config object', () => {
    const result = Gpt62SolConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

describe('deleted codex-cli model ids', () => {
  it.each([
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
  ])('resolve(%s) is undefined', (id) => {
    expect(codexCliRegistry.resolve('codex-cli', id)).toBeUndefined()
  })

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
    const descriptor = codexCliRegistry.resolve('codex-cli', 'gpt-6.2-sol')
    expect(descriptor).toBeDefined()
    const result = await descriptor?.validateConfig['~standard'].validate({
      reasoning: { effort: 'high' },
    })
    expect(result?.issues).toBeUndefined()
  })

  it('validateConfig["~standard"].validate rejects a bad config', async () => {
    const descriptor = codexCliRegistry.resolve('codex-cli', 'gpt-6.2-sol')
    expect(descriptor).toBeDefined()
    const result = await descriptor?.validateConfig['~standard'].validate({
      temperature: 0.5,
    })
    expect(result?.issues).toBeDefined()
    expect(result?.issues?.length).toBeGreaterThan(0)
  })
})

describe('codex-cli limits and media', () => {
  it('registers the four ids in this order', () => {
    expect([...CODEX_CLI_MODEL_IDS]).toEqual([
      'gpt-6.2-sol',
      'gpt-6.2-astra',
      'gpt-6.1-terra',
      'gpt-6-luna',
    ])
  })

  it('exports one config schema per registered model', () => {
    for (const [id, schema] of [
      ['gpt-6.2-sol', Gpt62SolConfigSchema],
      ['gpt-6.2-astra', Gpt62AstraConfigSchema],
      ['gpt-6.1-terra', Gpt61TerraConfigSchema],
      ['gpt-6-luna', Gpt6LunaConfigSchema],
    ] as const) {
      expect(codexCliRegistry.resolve('codex-cli', id)?.configSchema).toBe(schema)
    }
  })

  // Context window: what Codex CLI runs each model with by default (the catalog
  // bundled with Codex CLI 0.171.0), not the API's 1,050,000. Output: the API model
  // pages' 128,000 (read 2026-11-20).
  it.each([
    ['gpt-6.2-sol', 500_000],
    ['gpt-6.2-astra', 272_000],
    ['gpt-6.1-terra', 500_000],
    ['gpt-6-luna', 272_000],
  ])(
    '%s runs under a %i-token window with 128,000 output, and admits no media',
    (id, window) => {
      const d = codexCliRegistry.resolve('codex-cli', id)
      expect(d?.limits).toEqual({ contextWindow: window, maxOutputTokens: 128_000 })
      expect(d?.capabilities?.inputMimeTypes).toEqual([])
    },
  )
})

describe('codex-cli configKeys', () => {
  it('lists reasoning and timeoutMs on every model', () => {
    for (const d of codexCliModelDescriptors) {
      expect(d.configKeys).toEqual(['reasoning', 'timeoutMs'])
    }
  })
})
