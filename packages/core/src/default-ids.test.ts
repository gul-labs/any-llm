/**
 * The default id generator needs `globalThis.crypto.randomUUID()`. A runtime
 * without it (a browser page served over plain http, some embedded runtimes)
 * is a configuration error at `createClient`, not a `TypeError` on the first call.
 *
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import { FakeAdapter, FakeIds } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
])
const adapter = () =>
  new FakeAdapter('google', {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    model: 'gemini-2.5-pro',
    warnings: [],
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the default id generator', () => {
  it('createClient rejects a runtime with no crypto.randomUUID, and says to inject ids', () => {
    for (const crypto of [undefined, {}, { randomUUID: 'not a function' }]) {
      vi.stubGlobal('crypto', crypto)
      let thrown: unknown
      try {
        createClient({ adapters: [adapter()], modelRegistry: REGISTRY })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(LlmError)
      expect(thrown).toMatchObject({ kind: 'bad_request', retryable: false })
      expect((thrown as LlmError).message).toContain('ClientConfig.ids')
      expect((thrown as LlmError).issues?.[0]?.path).toBe('ids')
    }
  })

  it('an injected id generator needs no crypto at all', async () => {
    vi.stubGlobal('crypto', undefined)
    const client = createClient({
      adapters: [adapter()],
      modelRegistry: REGISTRY,
      ids: new FakeIds(),
    })
    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'k' } },
    )
    expect(result.text).toBe('ok')
  })
})
