/**
 * Package-surface importability tests for @gullabs/any-llm.
 *
 * Proves that the batteries-included package exposes the plugin-composition
 * client path: core engine + `composeProviders` exports, and the Gemini
 * provider plugin exports (adapter, model descriptors, pricing source — all
 * now homed in `@gullabs/google`, re-exported here via the barrel).
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { version as pkgVersion } from '../package.json'
import {
  ANY_LLM_VERSION,
  createClient,
  composeProviders,
  googleProvider,
  geminiAdapter,
  geminiPricingSource,
  geminiModelDescriptors,
  gemmaModelDescriptors,
  defaultGeminiRegistry,
  GEMINI_PRICED_TIERS,
  resolveGeminiRates,
} from './index.js'

describe('@gullabs/any-llm package surface', () => {
  it('exports the core client factory and provider-composition helper', () => {
    expect(typeof createClient).toBe('function')
    expect(typeof composeProviders).toBe('function')
  })

  it('exports the Gemini provider plugin factory and its constituent parts', () => {
    expect(typeof googleProvider).toBe('function')
    expect(typeof geminiAdapter).toBe('function')
    expect(typeof geminiPricingSource).toBe('function')
    expect(Array.isArray(geminiModelDescriptors)).toBe(true)
    expect(Array.isArray(gemmaModelDescriptors)).toBe(true)
    expect(typeof defaultGeminiRegistry.resolve).toBe('function')
    expect(GEMINI_PRICED_TIERS).toEqual(['standard', 'flex', 'batch'])
    expect(resolveGeminiRates('gemini-2.5-pro', 'standard')?.inputPerM).toBe(1_250_000)
  })

  it('ANY_LLM_VERSION matches package.json version', () => {
    expect(ANY_LLM_VERSION).toBe(pkgVersion)
  })
})
