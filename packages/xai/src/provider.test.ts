/**
 * Tests for {@link xaiProvider}.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, composeProviders } from '@gullabs/core'

import { xaiProvider } from './provider.js'

describe('xaiProvider', () => {
  it('returns a plugin whose adapter id is "xai"', () => {
    const plugin = xaiProvider()

    expect(plugin.adapter.id).toBe('xai')
  })

  it('returns model descriptors all scoped to provider "xai", including grok-4.5', () => {
    const plugin = xaiProvider()

    expect(plugin.modelDescriptors.length).toBeGreaterThan(0)
    for (const descriptor of plugin.modelDescriptors) {
      expect(descriptor.provider).toBe('xai')
    }
    expect(plugin.modelDescriptors.map((d) => d.model)).toEqual([
      'grok-4.5',
      'grok-4.6',
      'grok-4.7',
    ])
  })

  it('has a pricingSource that knows every registered Grok model', () => {
    const plugin = xaiProvider()

    expect(plugin.pricingSource).toBeDefined()
    expect(plugin.pricingSource?.hasModel('grok-4.5')).toBe(true)
    expect(plugin.pricingSource?.hasModel('grok-4.6')).toBe(true)
    expect(plugin.pricingSource?.hasModel('grok-4.7')).toBe(true)
  })

  it('constructs a working client via composeProviders and resolves every Grok model', () => {
    const composed = composeProviders([xaiProvider()])
    expect(() => createClient({ ...composed })).not.toThrow()
    expect(composed.modelRegistry?.resolve('xai', 'grok-4.5')).toBeDefined()
    expect(composed.modelRegistry?.resolve('xai', 'grok-4.6')).toBeDefined()
    expect(composed.modelRegistry?.resolve('xai', 'grok-4.7')).toBeDefined()
  })
})
