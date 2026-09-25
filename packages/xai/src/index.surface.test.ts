/**
 * Package-surface importability tests for @gullabs/xai.
 *
 * Proves that the full package surface (client factory, auth helper,
 * adapter, model descriptor/registry, pricing, and the `xaiProvider` plugin
 * factory) is reachable from the package root index — catching export/
 * re-export mismatches at test time rather than at consumer build time.
 * Mirrors `packages/google/src/index.surface.test.ts`.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  buildXaiClient,
  requireApiKey,
  xaiAdapter,
  classifyXaiError,
  Grok45ConfigSchema,
  Grok46ConfigSchema,
  grok45ModelDescriptor,
  grok46ModelDescriptor,
  xaiModelDescriptors,
  xaiRegistry,
  XAI_PRICING,
  XAI_TOOL_RATE_MICRO_USD,
  xaiPricingVersion,
  computeXaiCost,
  xaiPricingSource,
  xaiProvider,
  XaiFileStore,
  XAI_FILE_TTL_MIN_SECONDS,
  XAI_FILE_TTL_MAX_SECONDS,
  XAI_FILE_MAX_BYTES,
  XAI_FILES_DEFAULT_BASE_URL,
} from './index.js'

describe('@gullabs/xai package surface: commit 1', () => {
  it('buildXaiClient is a function reachable from the package root', () => {
    expect(typeof buildXaiClient).toBe('function')
  })

  it('requireApiKey is a function reachable from the package root', () => {
    expect(typeof requireApiKey).toBe('function')
  })
})

describe('@gullabs/xai package surface: commit 2', () => {
  it('xaiAdapter is a function reachable from the package root', () => {
    expect(typeof xaiAdapter).toBe('function')
  })

  it('classifyXaiError is a function reachable from the package root', () => {
    expect(typeof classifyXaiError).toBe('function')
  })
})

describe('@gullabs/xai package surface: commit 3', () => {
  it('Grok45ConfigSchema is reachable and parses an empty config', () => {
    expect(Grok45ConfigSchema.safeParse({}).success).toBe(true)
  })

  it('grok45ModelDescriptor is reachable and scoped to xai/grok-4.5', () => {
    expect(grok45ModelDescriptor.provider).toBe('xai')
    expect(grok45ModelDescriptor.model).toBe('grok-4.5')
  })

  it('xaiModelDescriptors is reachable and pinned to grok-4.5 then grok-4.6', () => {
    expect(xaiModelDescriptors.map((d) => d.model)).toEqual([
      'grok-4.5',
      'grok-4.6',
      'grok-4.7',
    ])
  })

  it('xaiRegistry is reachable and resolves grok-4.5 and grok-4.6', () => {
    expect(xaiRegistry.resolve('xai', 'grok-4.5')).toBeDefined()
    expect(xaiRegistry.resolve('xai', 'grok-4.6')).toBeDefined()
  })

  it('Grok46ConfigSchema and grok46ModelDescriptor are reachable', () => {
    expect(Grok46ConfigSchema.safeParse({}).success).toBe(true)
    expect(grok46ModelDescriptor.provider).toBe('xai')
    expect(grok46ModelDescriptor.model).toBe('grok-4.6')
  })

  it('XAI_PRICING, xaiPricingVersion, computeXaiCost, xaiPricingSource are reachable', () => {
    expect(XAI_PRICING['grok-4.5']).toBeDefined()
    expect(XAI_PRICING['grok-4.6']).toBeDefined()
    expect(XAI_TOOL_RATE_MICRO_USD.web_search_calls).toBe(5_000)
    expect(typeof xaiPricingVersion).toBe('string')
    expect(typeof computeXaiCost).toBe('function')
    expect(typeof xaiPricingSource).toBe('function')
  })

  it('xaiProvider is a function reachable from the package root', () => {
    expect(typeof xaiProvider).toBe('function')
  })
})

describe('@gullabs/xai package surface: files store', () => {
  it('XaiFileStore and TTL/size constants are reachable from the package root', () => {
    expect(typeof XaiFileStore).toBe('function')
    expect(XAI_FILE_TTL_MIN_SECONDS).toBe(3_600)
    expect(XAI_FILE_TTL_MAX_SECONDS).toBe(2_592_000)
    expect(XAI_FILE_MAX_BYTES).toBe(48 * 1024 * 1024)
    expect(XAI_FILES_DEFAULT_BASE_URL).toBe('https://api.x.ai/v1')
  })
})
