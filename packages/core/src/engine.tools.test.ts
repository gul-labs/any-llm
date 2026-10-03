/**
 * Engine function-calling seam validation.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { createClient, createModelRegistry, LlmError } from './index.js'
import { FakeAdapter, FakeClock, FakeIds, RecordingSink } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const TOOL = {
  name: 'get_temperature',
  description: 'Get temperature',
  inputJsonSchema: { type: 'object', properties: { location: { type: 'string' } } },
}

function makeClient() {
  return createClient({
    adapters: [
      new FakeAdapter('google', {
        message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
        text: 'ok',
        model: 'gemini-2.5-pro',
        usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
        warnings: [],
      }),
    ],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
    ]),
    clock: new FakeClock(),
    ids: new FakeIds(),
  })
}

describe('engine function-calling validation', () => {
  it('rejects an empty tool name and non-object schema', async () => {
    const client = makeClient()
    try {
      await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          tools: [{ name: '', description: 'd', inputJsonSchema: 'nope' }],
        },
        { auth: { apiKey: 'k' } },
      )
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).issues?.length).toBeGreaterThan(0)
    }
  })

  it('rejects toolChoice without tools', async () => {
    const client = makeClient()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          toolChoice: 'auto',
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects duplicate tool names and missing description', async () => {
    const client = makeClient()
    try {
      await client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          tools: [
            { ...TOOL },
            { name: 'get_temperature', description: '', inputJsonSchema: {} },
          ],
        },
        { auth: { apiKey: 'k' } },
      )
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).issues?.some((i) => i.path.includes('description'))).toBe(
        true,
      )
    }
  })

  it('rejects tool-call on user and unpaired tool-result', async () => {
    const client = makeClient()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'tool-result',
                  toolCallId: 'missing',
                  toolName: 'get_temperature',
                  result: {},
                },
              ],
            },
          ],
          tools: [TOOL],
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects tools combined with structured output', async () => {
    const client = makeClient()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          tools: [TOOL],
          output: { jsonSchema: { type: 'object' } },
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects named toolChoice that is not a member of tools', async () => {
    const client = makeClient()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          tools: [TOOL],
          toolChoice: { name: 'nope' },
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects a tool-result on an assistant message', async () => {
    const client = makeClient()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [
            {
              role: 'assistant',
              parts: [
                {
                  kind: 'tool-result',
                  toolCallId: 'c1',
                  toolName: 'get_temperature',
                  result: {},
                },
              ],
            },
          ],
          tools: [TOOL],
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects a tool-call on a user message', async () => {
    const client = makeClient()
    await expect(
      client.generate(
        {
          provider: 'google',
          model: 'gemini-2.5-pro',
          messages: [
            {
              role: 'user',
              parts: [
                {
                  kind: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'get_temperature',
                  args: {},
                },
              ],
            },
          ],
          tools: [TOOL],
        },
        { auth: { apiKey: 'k' } },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('accepts a paired tool-call then tool-result replay', async () => {
    const client = makeClient()
    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'temp?' }] },
          {
            role: 'assistant',
            parts: [
              {
                kind: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'get_temperature',
                args: { location: 'SF' },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'call-1',
                toolName: 'get_temperature',
                result: { temperature: 59 },
              },
            ],
          },
        ],
        tools: [TOOL],
      },
      { auth: { apiKey: 'k' } },
    )
    expect(result.text).toBe('ok')
  })

  it('persists requested tool names and count on the success record', async () => {
    const sink = new RecordingSink()
    const client = createClient({
      adapters: [
        new FakeAdapter('google', {
          message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
          text: 'ok',
          model: 'gemini-2.5-pro',
          usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
          warnings: [],
        }),
      ],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'gemini-2.5-pro', provider: 'google' }),
      ]),
      sink,
      clock: new FakeClock(),
      ids: new FakeIds(),
    })
    await client.generate(
      {
        provider: 'google',
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        tools: [TOOL],
      },
      { auth: { apiKey: 'k' } },
    )
    expect(sink.last()?.toolNames).toEqual(['get_temperature'])
    expect(sink.last()?.toolCount).toBe(1)
    expect(sink.last()?.toolCalls).toBeUndefined()
  })
})
