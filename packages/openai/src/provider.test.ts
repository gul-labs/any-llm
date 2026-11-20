/**
 * {@link openaiProvider} composes with core.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { composeProviders, createClient } from '@gullabs/core'

import { openaiProvider } from './provider.js'

describe('openaiProvider', () => {
  it('bundles the adapter, the four descriptors and the pricing source', () => {
    const plugin = openaiProvider()
    expect(plugin.adapter.id).toBe('openai')
    expect(plugin.modelDescriptors.map((d) => d.model)).toEqual([
      'gpt-6.2-astra',
      'gpt-6.2-sol',
      'gpt-6.1-terra',
      'gpt-6-luna',
    ])
    for (const d of plugin.modelDescriptors) {
      expect(plugin.pricingSource?.hasModel(d.model)).toBe(true)
    }
  })

  it('builds a client through composeProviders', () => {
    const composed = composeProviders([openaiProvider()])
    expect(() => createClient({ ...composed })).not.toThrow()
    expect(composed.modelRegistry.resolve('openai', 'gpt-6.2-sol')).toBeDefined()
  })
})
