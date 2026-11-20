/**
 * Package surface of `@gullabs/openai`: everything the README names is reachable
 * from the package root, and no test seam is.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import * as pkg from './index.js'

describe('@gullabs/openai package surface', () => {
  it('exports exactly the runtime values the README documents', () => {
    expect(Object.keys(pkg).sort()).toEqual(
      [
        'Gpt61TerraConfigSchema',
        'Gpt62AstraConfigSchema',
        'Gpt62SolConfigSchema',
        'Gpt6LunaConfigSchema',
        'OPENAI_BASE_URL',
        'OPENAI_DEFAULT_TIMEOUT_MS',
        'OPENAI_JSON_SCHEMA_PROFILE',
        'OPENAI_LONG_CONTEXT_THRESHOLD',
        'OPENAI_MAX_TIMEOUT_MS',
        'OPENAI_PRICING',
        'OPENAI_TIMEOUT_BUFFER_MS',
        'OPENAI_USAGE_DETAIL_KEYS',
        'classifyOpenAiError',
        'computeOpenAiCost',
        'gpt61TerraModelDescriptor',
        'gpt62AstraModelDescriptor',
        'gpt62SolModelDescriptor',
        'gpt6LunaModelDescriptor',
        'openaiAdapter',
        'openaiModelDescriptors',
        'openaiPricingSource',
        'openaiPricingVersion',
        'openaiProvider',
        'openaiRegistry',
      ].sort(),
    )
  })

  it('keeps the test seams and the SDK builder off the surface', () => {
    expect(pkg).not.toHaveProperty('openaiAdapterWithSeams')
    expect(pkg).not.toHaveProperty('buildOpenAiClient')
  })

  it('pins the constants', () => {
    expect(pkg.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(pkg.OPENAI_DEFAULT_TIMEOUT_MS).toBe(3_600_000)
    expect(pkg.OPENAI_TIMEOUT_BUFFER_MS).toBe(5_000)
    expect(pkg.OPENAI_MAX_TIMEOUT_MS).toBe(2_147_478_647)
    expect(pkg.openaiPricingVersion).toBe('openai-2026-11-20')
  })
})
