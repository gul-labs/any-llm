/**
 * Tests for {@link googleProvider}.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, composeProviders } from '@gullabs/core'

import { googleProvider } from './provider.js'

describe('googleProvider', () => {
  it('returns a plugin whose adapter id is "google"', () => {
    const plugin = googleProvider()

    expect(plugin.adapter.id).toBe('google')
  })

  it('returns model descriptors all scoped to provider "google", including known gemini/gemma ids', () => {
    const plugin = googleProvider()

    expect(plugin.modelDescriptors.length).toBeGreaterThan(0)
    for (const descriptor of plugin.modelDescriptors) {
      expect(descriptor.provider).toBe('google')
    }

    const ids = plugin.modelDescriptors.map((d) => d.model)
    expect(ids).toContain('gemini-3.8-flash')
    expect(ids).toContain('gemma-4-31b-it')
  })

  it('returns a pricingSource that covers descriptor pricing keys', () => {
    const plugin = googleProvider()

    expect(plugin.pricingSource).toBeDefined()
    for (const descriptor of plugin.modelDescriptors) {
      if (descriptor.pricingFamily === undefined) continue
      expect(plugin.pricingSource?.hasModel(descriptor.pricingFamily)).toBe(true)
    }
    expect(plugin.pricingSource?.hasModel('gemini-3.8-flash')).toBe(true)
  })

  it('constructs a working client via composeProviders', () => {
    expect(() => createClient({ ...composeProviders([googleProvider()]) })).not.toThrow()
  })
})
