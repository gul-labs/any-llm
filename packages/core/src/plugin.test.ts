/**
 * Tests for {@link composeProviders}.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { FakeAdapter } from '@gullabs/testing'

import { composeProviders } from './plugin.js'
import type { ProviderPlugin } from './plugin.js'
import { createClient } from './engine.js'
import { LlmError } from './errors.js'
import { makeTestDescriptor } from './test-model-descriptor.js'
import type { PricingSource } from './ports.js'
import type { Usage, Cost } from './types.js'

const TEST_AUTH = { apiKey: 'test-key' }

function makeFakePricingSource(): PricingSource {
  return {
    version: 'test-1',
    price(_model: string, _usage: Usage, _tier?: string): Cost {
      return {
        microUsd: 0,
        usd: 0,
        pricingVersion: 'test-1',
        confidence: 'exact',
        details: { input: 0, cached: 0, output: 0, tools: 0 },
      }
    },
    hasModel(): boolean {
      return true
    },
    listModels(): readonly string[] {
      return []
    },
  }
}

describe('composeProviders', () => {
  it('composes adapters in input order and merges descriptors from both plugins', () => {
    const adapterA = new FakeAdapter('fake-a', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'from a' }] },
      text: 'from a',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'model-a',
      warnings: [],
    })
    const adapterB = new FakeAdapter('fake-b', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'from b' }] },
      text: 'from b',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'model-b',
      warnings: [],
    })
    const descriptorA = makeTestDescriptor({ model: 'model-a', provider: 'fake-a' })
    const descriptorB = makeTestDescriptor({ model: 'model-b', provider: 'fake-b' })

    const pluginA: ProviderPlugin = { adapter: adapterA, modelDescriptors: [descriptorA] }
    const pluginB: ProviderPlugin = { adapter: adapterB, modelDescriptors: [descriptorB] }

    const composed = composeProviders([pluginA, pluginB])

    expect(composed.adapters).toEqual([adapterA, adapterB])
    expect(composed.modelRegistry!.resolve('fake-a', 'model-a')).toBe(descriptorA)
    expect(composed.modelRegistry!.resolve('fake-b', 'model-b')).toBe(descriptorB)
  })

  it('keys pricingSources by adapter id, omitting the key for unpriced plugins', () => {
    const pricedAdapter = new FakeAdapter('priced', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'priced-model',
      warnings: [],
    })
    const unpricedAdapter = new FakeAdapter('unpriced', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'unpriced-model',
      warnings: [],
    })
    const pricingSource = makeFakePricingSource()

    const pricedPlugin: ProviderPlugin = {
      adapter: pricedAdapter,
      modelDescriptors: [
        makeTestDescriptor({ model: 'priced-model', provider: 'priced' }),
      ],
      pricingSource,
    }
    const unpricedPlugin: ProviderPlugin = {
      adapter: unpricedAdapter,
      modelDescriptors: [
        makeTestDescriptor({ model: 'unpriced-model', provider: 'unpriced' }),
      ],
    }

    const composed = composeProviders([pricedPlugin, unpricedPlugin])

    const pricingSources = composed.pricingSources ?? {}
    expect(Object.keys(pricingSources)).toEqual(['priced'])
    expect(Object.prototype.hasOwnProperty.call(pricingSources, 'unpriced')).toBe(false)
  })

  it('throws an LlmError(bad_request) on duplicate plugin adapter ids', () => {
    const adapter1 = new FakeAdapter('dup', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'a' }] },
      text: 'a',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm1',
      warnings: [],
    })
    const adapter2 = new FakeAdapter('dup', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'b' }] },
      text: 'b',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm2',
      warnings: [],
    })

    const plugin1: ProviderPlugin = {
      adapter: adapter1,
      modelDescriptors: [makeTestDescriptor({ model: 'm1', provider: 'dup' })],
    }
    const plugin2: ProviderPlugin = {
      adapter: adapter2,
      modelDescriptors: [makeTestDescriptor({ model: 'm2', provider: 'dup' })],
    }

    expect(() => composeProviders([plugin1, plugin2])).toThrow(LlmError)

    let caught: unknown
    try {
      composeProviders([plugin1, plugin2])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).kind).toBe('bad_request')
  })

  it("throws an LlmError(bad_request) when a plugin contributes a descriptor for another plugin's provider", () => {
    const xaiAdapter = new FakeAdapter('xai', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'a' }] },
      text: 'a',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'grok',
      warnings: [],
    })
    const googleAdapter = new FakeAdapter('google', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'b' }] },
      text: 'b',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'gemini',
      warnings: [],
    })

    const buggyXaiPlugin: ProviderPlugin = {
      adapter: xaiAdapter,
      modelDescriptors: [makeTestDescriptor({ model: 'grok', provider: 'google' })],
    }
    const googlePlugin: ProviderPlugin = {
      adapter: googleAdapter,
      modelDescriptors: [makeTestDescriptor({ model: 'gemini', provider: 'google' })],
    }

    expect(() => composeProviders([buggyXaiPlugin, googlePlugin])).toThrow(LlmError)

    let caught: unknown
    try {
      composeProviders([buggyXaiPlugin, googlePlugin])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).kind).toBe('bad_request')
    expect((caught as LlmError).message).toContain('xai')
    expect((caught as LlmError).message).toContain('google')
  })

  it("throws an LlmError(bad_request) when a single plugin's descriptor provider does not match its own adapter id", () => {
    const soloAdapter = new FakeAdapter('solo', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'a' }] },
      text: 'a',
      usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
      model: 'm1',
      warnings: [],
    })

    const soloPlugin: ProviderPlugin = {
      adapter: soloAdapter,
      modelDescriptors: [makeTestDescriptor({ model: 'm1', provider: 'other' })],
    }

    expect(() => composeProviders([soloPlugin])).toThrow(LlmError)

    let caught: unknown
    try {
      composeProviders([soloPlugin])
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).kind).toBe('bad_request')
  })

  it('composes an empty array without throwing', () => {
    const composed = composeProviders([])

    expect(composed.adapters).toEqual([])
    expect(composed.pricingSources).toEqual({})
    expect(composed.modelRegistry!.resolve('anything', 'anything')).toBeUndefined()
  })

  it('spreads into createClient and round-trips a generate() call', async () => {
    const adapter = new FakeAdapter('fake', {
      message: { role: 'assistant', parts: [{ kind: 'text', text: 'hello' }] },
      text: 'hello',
      usage: { inputTokens: 5, outputTokens: 5, details: {}, raw: null },
      model: 'fake-model',
      warnings: [],
    })
    const descriptor = makeTestDescriptor({ model: 'fake-model', provider: 'fake' })

    const client = createClient({
      ...composeProviders([{ adapter, modelDescriptors: [descriptor] }]),
    })

    const result = await client.generate(
      {
        provider: 'fake',
        model: 'fake-model',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hi' }] }],
      },
      { auth: TEST_AUTH },
    )

    expect(result.text).toBe('hello')
    expect(result.model).toBe('fake-model')
  })
})
