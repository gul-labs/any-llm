/**
 * `RateLimiter.acquire(key, signal, hint)` and `Release(usage)` (R8.1): the
 * engine hands the limiter an input-token estimate before dispatch and the
 * attempt's real usage when it releases.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { createClient, createModelRegistry, estimateInputTokens } from './index.js'
import type {
  AdapterResult,
  LlmRequest,
  RateLimitHint,
  RateLimiter,
  Usage,
} from './index.js'
import {
  FakeAdapter,
  FakeClock,
  fakeBilledFailure,
  fakeHttpError,
} from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const REGISTRY = createModelRegistry([
  makePermissiveTestDescriptor({ model: 'm', provider: 'google' }),
])
const AUTH = { apiKey: 'test-key' }

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 123, outputTokens: 4, details: {}, raw: null },
  model: 'm',
  warnings: [],
}

function request(text: string): LlmRequest {
  return {
    provider: 'google',
    model: 'm',
    system: 'be brief',
    messages: [{ role: 'user', parts: [{ kind: 'text', text }] }],
  }
}

interface Spy {
  limiter: RateLimiter
  hints: Array<RateLimitHint | undefined>
  releases: Array<Usage | undefined>
}

function spy(): Spy {
  const s: Spy = {
    hints: [],
    releases: [],
    limiter: {
      acquire(_key, _signal, hint) {
        s.hints.push(hint)
        return Promise.resolve((usage?: Usage) => {
          s.releases.push(usage)
        })
      },
    },
  }
  return s
}

describe('the engine feeds the rate limiter', () => {
  it('hands acquire an input-token estimate of the request', async () => {
    const s = spy()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      rateLimiter: s.limiter,
    })

    await client.generate(request('x'.repeat(100)), { auth: AUTH })

    // 'be brief' (8) + 100 chars of user text = 108 chars, 4 per token, rounded up.
    expect(s.hints).toEqual([{ estimatedInputTokens: 27 }])
  })

  it('releases with the attempt usage on success', async () => {
    const s = spy()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK)],
      modelRegistry: REGISTRY,
      rateLimiter: s.limiter,
    })

    await client.generate(request('hi'), { auth: AUTH })

    expect(s.releases).toHaveLength(1)
    expect(s.releases[0]).toMatchObject({ inputTokens: 123, outputTokens: 4 })
  })

  it('releases with the billed usage of a billed failure, and with none for a failure that reported none', async () => {
    const s = spy()
    const client = createClient({
      adapters: [
        new FakeAdapter('google', [
          fakeBilledFailure({ inputTokens: 77, outputTokens: 0 }),
          fakeHttpError(500),
        ]),
      ],
      modelRegistry: REGISTRY,
      rateLimiter: s.limiter,
    })

    await expect(client.generate(request('hi'), { auth: AUTH })).rejects.toMatchObject({
      kind: 'server',
    })
    await expect(client.generate(request('hi'), { auth: AUTH })).rejects.toMatchObject({
      httpStatus: 500,
    })

    expect(s.releases).toHaveLength(2)
    expect(s.releases[0]).toMatchObject({ inputTokens: 77 })
    expect(s.releases[1]).toBeUndefined()
  })

  it('releases with no usage when the call times out', async () => {
    const s = spy()
    const clock = new FakeClock()
    const client = createClient({
      adapters: [new FakeAdapter('google', OK, { delayMs: 10_000 })],
      modelRegistry: REGISTRY,
      rateLimiter: s.limiter,
      clock,
      scheduler: clock,
    })
    const call = client.generate(
      { ...request('hi'), config: { timeoutMs: 1_000 } },
      { auth: AUTH },
    )
    const settled = call.then(
      () => 'ok',
      (e: unknown) => e,
    )

    await clock.advanceAsync(1_000)

    await expect(settled).resolves.toMatchObject({ kind: 'timeout' })
    expect(s.releases).toEqual([undefined])
  })
})

describe('estimateInputTokens', () => {
  it('counts system, text, tool calls, tool results and tool declarations, 4 characters a token', () => {
    const tokens = estimateInputTokens({
      system: 'abcd', // 4
      messages: [
        { role: 'user', parts: [{ kind: 'text', text: 'abcdefgh' }] }, // 8
        {
          role: 'assistant',
          parts: [
            { kind: 'tool-call', toolCallId: '1', toolName: 'ab', args: { q: 1 } },
            // 'ab' (2) + '{"q":1}' (7) = 9
          ],
        },
        {
          role: 'user',
          parts: [
            { kind: 'tool-result', toolCallId: '1', toolName: 'ab', result: 'x' },
            // 'ab' (2) + '"x"' (3) = 5
          ],
        },
      ],
      tools: [{ name: 'ab', description: 'cd', inputJsonSchema: {} }], // 2 + 2 + 2 = 6
    })

    expect(tokens).toBe(Math.ceil((4 + 8 + 9 + 5 + 6) / 4))
  })

  it('does not count media or file parts: it is a floor for a request that carries them', () => {
    const base = estimateInputTokens({
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'abcd' }] }],
    })
    const withMedia = estimateInputTokens({
      messages: [
        {
          role: 'user',
          parts: [
            { kind: 'text', text: 'abcd' },
            { kind: 'inline-media', mimeType: 'image/png', data: 'AAAA'.repeat(1000) },
            { kind: 'file-uri', uri: 'https://example.com/a.png', mimeType: 'image/png' },
            { kind: 'file-ref', fileId: 'file_1' },
          ],
        },
      ],
    })

    expect(withMedia).toBe(base)
    expect(base).toBe(1)
  })

  it('counts 0 for a value it cannot serialize instead of throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const tokens = estimateInputTokens({
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              kind: 'tool-call',
              toolCallId: '1',
              toolName: 'abcd',
              args: cyclic as never,
            },
            {
              kind: 'tool-call',
              toolCallId: '2',
              toolName: 'abcd',
              args: undefined as never,
            },
            {
              kind: 'tool-result',
              toolCallId: '2',
              toolName: 'abcd',
              result: 1n as never,
            },
          ],
        },
      ],
    })
    // Only the three tool names (4 characters each) are counted.
    expect(tokens).toBe(3)
  })

  it('is 0 for an empty request', () => {
    expect(estimateInputTokens({ messages: [] })).toBe(0)
  })
})
