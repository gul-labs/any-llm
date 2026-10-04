/**
 * Package-surface importability tests for @gullabs/testing.
 *
 * Proves that `assertRegistryInvariants` is reachable from the package root
 * index — catching export/re-export mismatches at test time rather than at
 * consumer build time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { assertRegistryInvariants } from './index.js'
// FakeXaiFileStore asserted below

describe('@gullabs/testing package surface: assertRegistryInvariants', () => {
  it('is a function reachable from the package root', () => {
    expect(typeof assertRegistryInvariants).toBe('function')
  })
})

describe('@gullabs/testing package surface: FakeXaiFileStore', () => {
  it('FakeXaiFileStore is a constructor reachable from the package root', async () => {
    const { FakeXaiFileStore } = await import('./index.js')
    expect(typeof FakeXaiFileStore).toBe('function')
  })
})

describe('@gullabs/testing package surface: runToolLoop', () => {
  it('runToolLoop is a function reachable from the package root', async () => {
    const { runToolLoop } = await import('./index.js')
    expect(typeof runToolLoop).toBe('function')
  })
})

describe('@gullabs/testing package surface: scripted-error and clock helpers', () => {
  it('every one of these helpers is reachable from the package root', async () => {
    const api = await import('./index.js')
    for (const name of [
      'FakeClock',
      'FakeClient',
      'FakeAdapter',
      'FakeGoogleFileStore',
      'FakeGoogleCacheStore',
      'FakeCliRunner',
      'RecordingSink',
      'RecordingTelemetry',
      'RecordingLogger',
      'fakeLlmResult',
      'fakeHttpError',
      'fakeNetworkError',
      'fakeBilledFailure',
      'fakeStreamFailure',
      'fakeProviderError',
    ] as const) {
      expect(typeof api[name], name).toBe('function')
    }
  })
})
