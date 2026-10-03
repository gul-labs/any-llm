/**
 * Malformed `messages` reach no adapter and no raw TypeError: `generate` checks
 * the shape of every message and part before reading it (the same check
 * `runStructured` applies to `history` and `attachments`).
 */
import { describe, expect, it } from 'vitest'
import { FakeAdapter, RecordingSink } from '@gullabs/testing'

import { createClient, createModelRegistry, LlmError } from './index.js'
import type { AdapterResult, LlmRequest } from './index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const OK: AdapterResult = {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  model: 'm',
  warnings: [],
}

function setup() {
  const adapter = new FakeAdapter('p', OK)
  const sink = new RecordingSink()
  const client = createClient({
    adapters: [adapter],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
    ]),
    sink,
  })
  return { adapter, sink, client }
}

describe('generate message shapes', () => {
  it.each([
    [[null], 'messages[0]'],
    [[{ role: 'user' }], 'messages[0].parts'],
    [[{ role: 'user', parts: 'hi' }], 'messages[0].parts'],
    [[{ role: 'robot', parts: [] }], 'messages[0].role'],
    [
      [{ role: 'user', parts: [{ kind: 'text', text: 'ok' }, null] }],
      'messages[0].parts[1]',
    ],
    [[{ role: 'user', parts: [{}] }], 'messages[0].parts[0].kind'],
    [[{ role: 'user', parts: [{ kind: 'zzz' }] }], 'messages[0].parts[0].kind'],
    ['hi', 'messages'],
    [undefined, 'messages'],
  ])('messages %j is bad_request naming %s, never dispatched', async (messages, path) => {
    const { adapter, client } = setup()
    const err = await client
      .generate({ provider: 'p', model: 'm', messages } as unknown as LlmRequest, {
        auth: { apiKey: 'k' },
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    expect((err as LlmError).issues?.[0]?.path).toBe(path)
    expect(adapter.calls).toHaveLength(0)
  })

  it('a well-formed request still dispatches', async () => {
    const { adapter, client } = setup()
    await client.generate(
      {
        provider: 'p',
        model: 'm',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'k' } },
    )
    expect(adapter.calls).toHaveLength(1)
  })
})
