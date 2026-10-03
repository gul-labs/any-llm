/**
 * LlmResult.message, LlmResult.continuation and model-bound continuation state
 * at the engine level (ADR-029 addendum): the ordered assistant message on every
 * provider, the descriptor's continuation rule repeated on every result, and
 * the engine never rewriting the host's model string.
 */
import { describe, expect, it } from 'vitest'
import { FakeAdapter } from '@gullabs/testing'
import { createClient, createModelRegistry, LlmError } from './index.js'
import type { AdapterResult, Message, ModelDescriptor, Usage } from './index.js'
import { makePermissiveTestDescriptor } from './test-model-descriptor.js'

const USAGE: Usage = { inputTokens: 1, outputTokens: 1, details: {}, raw: null }
const AUTH = { apiKey: 'k' }
const USER: Message = { role: 'user', parts: [{ kind: 'text', text: 'hi' }] }

function adapterResult(overrides: Partial<AdapterResult> = {}): AdapterResult {
  return { usage: USAGE, model: 'm', warnings: [], ...overrides }
}

function makeClient(
  descriptor: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'model' | 'provider'>,
  entries: AdapterResult | AdapterResult[],
) {
  const adapter = new FakeAdapter(descriptor.provider, entries)
  const client = createClient({
    adapters: [adapter],
    modelRegistry: createModelRegistry([makePermissiveTestDescriptor(descriptor)]),
  })
  return { adapter, client }
}

describe('LlmResult.message', () => {
  it('is built as [text, ...tool calls] when the adapter does not supply one', async () => {
    const { client } = makeClient(
      { model: 'm', provider: 'p' },
      adapterResult({
        text: 'checking',
        toolCalls: [{ toolCallId: 'c1', toolName: 'get', args: { a: 1 } }],
        finishReason: 'tool_calls',
      }),
    )
    const result = await client.generate(
      { provider: 'p', model: 'm', messages: [USER] },
      { auth: AUTH },
    )
    expect(result.message).toEqual({
      role: 'assistant',
      parts: [
        { kind: 'text', text: 'checking' },
        { kind: 'tool-call', toolCallId: 'c1', toolName: 'get', args: { a: 1 } },
      ],
    })
    expect(result.text).toBe('checking')
    expect(result.toolCalls).toEqual([
      { toolCallId: 'c1', toolName: 'get', args: { a: 1 } },
    ])
  })

  it('is an empty assistant message when the model produced nothing representable', async () => {
    const { client } = makeClient({ model: 'm', provider: 'p' }, adapterResult())
    const result = await client.generate(
      { provider: 'p', model: 'm', messages: [USER] },
      { auth: AUTH },
    )
    expect(result.message).toEqual({ role: 'assistant', parts: [] })
  })

  it('passes an adapter-supplied interleaved message through unchanged', async () => {
    const message: Message = {
      role: 'assistant',
      parts: [
        { kind: 'tool-call', toolCallId: 'c1', toolName: 'a', args: {} },
        { kind: 'text', text: 'between' },
        { kind: 'tool-call', toolCallId: 'c2', toolName: 'b', args: { x: 1 } },
        { kind: 'text', text: 'after' },
      ],
    }
    const { client } = makeClient(
      { model: 'm', provider: 'p' },
      adapterResult({
        message,
        text: 'betweenafter',
        toolCalls: [
          { toolCallId: 'c1', toolName: 'a', args: {} },
          { toolCallId: 'c2', toolName: 'b', args: { x: 1 } },
        ],
      }),
    )
    const result = await client.generate(
      { provider: 'p', model: 'm', messages: [USER] },
      { auth: AUTH },
    )
    expect(result.message).toEqual(message)
  })
})

describe('LlmResult.continuation', () => {
  it("is 'history' when the descriptor declares nothing", async () => {
    const { client } = makeClient({ model: 'm', provider: 'p' }, adapterResult())
    const result = await client.generate(
      { provider: 'p', model: 'm', messages: [USER] },
      { auth: AUTH },
    )
    expect(result.continuation).toBe('history')
  })

  it("repeats the descriptor's 'state' rule on the result", async () => {
    const { client } = makeClient(
      {
        model: 'm',
        provider: 'p',
        capabilities: { continuation: 'state', providerState: true },
      },
      adapterResult({ transientProviderState: { p: { n: 1 } } }),
    )
    const result = await client.generate(
      { provider: 'p', model: 'm', messages: [USER] },
      { auth: AUTH },
    )
    expect(result.continuation).toBe('state')
    expect(result.transientProviderState).toEqual({ p: { n: 1 } })
  })

  it("rejects a descriptor that declares continuation 'state' without providerState", () => {
    expect(() =>
      createModelRegistry([
        makePermissiveTestDescriptor({
          model: 'm',
          provider: 'p',
          capabilities: { continuation: 'state' },
        }),
      ]),
    ).toThrow(LlmError)
  })
})

describe('transientProviderState admission', () => {
  it('is rejected before dispatch for a model without providerState', async () => {
    const { adapter, client } = makeClient({ model: 'm', provider: 'p' }, adapterResult())
    await expect(
      client.generate(
        {
          provider: 'p',
          model: 'm',
          messages: [USER],
          transientProviderState: { p: {} },
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
  })

  it("is forwarded for providerState: true with continuation 'history'", async () => {
    const { adapter, client } = makeClient(
      {
        model: 'm',
        provider: 'p',
        capabilities: { continuation: 'history', providerState: true },
      },
      adapterResult(),
    )
    await client.generate(
      { provider: 'p', model: 'm', messages: [USER], transientProviderState: { p: 1 } },
      { auth: AUTH },
    )
    expect(adapter.calls[0]?.transientProviderState).toEqual({ p: 1 })
  })
})

describe("the host's model string is never rewritten", () => {
  it('lets the next turn go out with the string the host sent when the provider returns another id', async () => {
    const { adapter, client } = makeClient(
      {
        model: 'canonical',
        aliases: ['alias-latest'],
        provider: 'p',
        capabilities: { continuation: 'history', providerState: true },
      },
      [
        adapterResult({
          model: 'canonical-2026-10-01',
          toolCalls: [{ toolCallId: 'c1', toolName: 'get', args: {} }],
          transientProviderState: { p: { boundTo: 'alias-latest' } },
        }),
        adapterResult({ model: 'canonical-2026-10-02', text: 'done' }),
      ],
    )
    const first = await client.generate(
      { provider: 'p', model: 'alias-latest', messages: [USER] },
      { auth: AUTH },
    )
    expect(first.model).toBe('canonical-2026-10-01')
    const second = await client.generate(
      {
        provider: 'p',
        model: 'alias-latest',
        messages: [
          USER,
          first.message,
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'c1',
                toolName: 'get',
                result: { ok: 1 },
              },
            ],
          },
        ],
        ...(first.transientProviderState !== undefined
          ? { transientProviderState: first.transientProviderState }
          : {}),
      },
      { auth: AUTH },
    )
    expect(second.text).toBe('done')
    // Both turns reached the adapter under the alias, never the canonical id or
    // the id the provider returned.
    expect(adapter.calls.map((c) => c.model)).toEqual(['alias-latest', 'alias-latest'])
    expect(adapter.calls[1]?.transientProviderState).toEqual({
      p: { boundTo: 'alias-latest' },
    })
  })
})

describe("tool-result pairing follows the descriptor's continuation rule", () => {
  const orphanResult: Message = {
    role: 'user',
    parts: [
      { kind: 'tool-result', toolCallId: 'only-in-state', toolName: 'get', result: 1 },
    ],
  }

  it("with 'state', the prior calls live in the state, so the adapter checks pairing", async () => {
    const { adapter, client } = makeClient(
      {
        model: 'm',
        provider: 'p',
        capabilities: { continuation: 'state', providerState: true },
      },
      adapterResult(),
    )
    await client.generate(
      {
        provider: 'p',
        model: 'm',
        messages: [orphanResult],
        transientProviderState: { p: {} },
      },
      { auth: AUTH },
    )
    expect(adapter.calls).toHaveLength(1)
  })

  it("with 'history', the engine still requires a prior tool-call in the messages", async () => {
    const { adapter, client } = makeClient(
      {
        model: 'm',
        provider: 'p',
        capabilities: { continuation: 'history', providerState: true },
      },
      adapterResult(),
    )
    await expect(
      client.generate(
        {
          provider: 'p',
          model: 'm',
          messages: [orphanResult],
          transientProviderState: { p: {} },
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(adapter.calls).toHaveLength(0)
  })
})
