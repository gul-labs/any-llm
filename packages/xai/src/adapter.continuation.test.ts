/**
 * LlmResult.message and the two continuation rules on xAI (ADR-029 addendum):
 * grok-4.5/4.6 continue by history, grok-4.7 by provider state. State is scoped
 * under `xai` and bound to the model string the host sent.
 */
import { describe, expect, it } from 'vitest'
import {
  composeProviders,
  createClient,
  createModelRegistry,
  LlmError,
} from '@gullabs/core'
import type { JsonValue, LlmResult, Message, ToolDefinition } from '@gullabs/core'
import { makeFakeXai, runToolLoop } from '@gullabs/testing'
import type { XaiResponseLike } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { grok47ModelDescriptor, xaiModelDescriptors } from './models.js'
import { xaiProvider } from './provider.js'

type XaiState = { xai: { model: string; input: unknown[] } }
const AUTH = { apiKey: 'test-key' }
const USER: Message = { role: 'user', parts: [{ kind: 'text', text: 'Weather?' }] }
const TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get weather.',
    inputJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
]

function response(model: string, output: unknown[]): XaiResponseLike {
  return {
    id: 'resp',
    model,
    status: 'completed',
    output: output as XaiResponseLike['output'],
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}
const message = (text: string) => ({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
})
const fnCall = (callId: string, name: string, args: object) => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
})
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' }

describe('xAI result.message', () => {
  it('keeps provider order, takes the last message item as the text, and omits reasoning', async () => {
    const fake = makeFakeXai(
      response('grok-4.5', [
        reasoning,
        message('first draft'),
        fnCall('c1', 'get_weather', { city: 'Paris' }),
        message('final words'),
        fnCall('c2', 'get_weather', { city: 'Tokyo' }),
      ]),
    )
    const client = createClient({
      ...composeProviders([xaiProvider({ client: fake })]),
    })
    const result = await client.generate(
      { provider: 'xai', model: 'grok-4.5', messages: [USER], tools: TOOLS },
      { auth: AUTH },
    )
    expect(result.message).toEqual({
      role: 'assistant',
      parts: [
        {
          kind: 'tool-call',
          toolCallId: 'c1',
          toolName: 'get_weather',
          args: { city: 'Paris' },
        },
        { kind: 'text', text: 'final words' },
        {
          kind: 'tool-call',
          toolCallId: 'c2',
          toolName: 'get_weather',
          args: { city: 'Tokyo' },
        },
      ],
    })
    expect(result.text).toBe('final words')
    expect(result.toolCalls?.map((c) => c.toolCallId)).toEqual(['c1', 'c2'])
    expect(result.continuation).toBe('history')
    expect(result.transientProviderState).toBeUndefined()
  })

  it('is a text-only message for a plain answer and empty when there is nothing representable', async () => {
    const fake = makeFakeXai([
      response('grok-4.5', [message('hello')]),
      response('grok-4.5', [reasoning]),
    ])
    const client = createClient({ ...composeProviders([xaiProvider({ client: fake })]) })
    const req = { provider: 'xai', model: 'grok-4.5', messages: [USER] }
    expect((await client.generate(req, { auth: AUTH })).message).toEqual({
      role: 'assistant',
      parts: [{ kind: 'text', text: 'hello' }],
    })
    expect((await client.generate(req, { auth: AUTH })).message).toEqual({
      role: 'assistant',
      parts: [],
    })
  })
})

describe('grok-4.5 continues by history', () => {
  it('runToolLoop appends result.message, resends the full history, and sends no state', async () => {
    const fake = makeFakeXai([
      response('grok-4.5', [fnCall('c1', 'get_weather', { city: 'Paris' })]),
      response('grok-4.5', [message('18C and clear.')]),
    ])
    const client = createClient({ ...composeProviders([xaiProvider({ client: fake })]) })
    const outcome = await runToolLoop(
      client,
      { provider: 'xai', model: 'grok-4.5', messages: [USER], tools: TOOLS },
      { get_weather: () => ({ tempC: 18 }) },
      { auth: AUTH },
    )
    expect(outcome.result.text).toBe('18C and clear.')
    expect(outcome.turns.map((t) => t.continuation)).toEqual(['history', 'history'])
    const second = fake.calls[1] as { input: unknown[] }
    expect(second.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Weather?' }] },
      {
        type: 'function_call',
        call_id: 'c1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      },
      { type: 'function_call_output', call_id: 'c1', output: '{"tempC":18}' },
    ])
  })

  it('rejects state: grok-4.5 does not declare providerState', async () => {
    const fake = makeFakeXai(response('grok-4.5', [message('x')]))
    const client = createClient({ ...composeProviders([xaiProvider({ client: fake })]) })
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [USER],
          transientProviderState: {
            xai: { model: 'grok-4.5', input: [{ role: 'user' }] },
          },
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('grok-4.7 continues by state', () => {
  it('runToolLoop sends only the new tool results plus the state, and never replays result.message', async () => {
    const fake = makeFakeXai([
      response('grok-4.7', [reasoning, fnCall('c1', 'get_weather', { city: 'Paris' })]),
      response('grok-4.7', [message('18C and clear.')]),
    ])
    const client = createClient({ ...composeProviders([xaiProvider({ client: fake })]) })
    const outcome = await runToolLoop(
      client,
      { provider: 'xai', model: 'grok-4.7', messages: [USER], tools: TOOLS },
      { get_weather: () => ({ tempC: 18 }) },
      { auth: AUTH },
    )
    expect(outcome.turns.map((t) => t.continuation)).toEqual(['state', 'state'])
    // result.message is still returned for display and storage.
    expect(outcome.turns[0]?.message.parts[0]).toMatchObject({ kind: 'tool-call' })
    const first = fake.calls[0] as { input: unknown[] }
    const second = fake.calls[1] as { input: unknown[] }
    // The second request is the first request's wire input, the model's output
    // items (including the encrypted reasoning item), and only the new result.
    expect(second.input).toEqual([
      ...first.input,
      reasoning,
      fnCall('c1', 'get_weather', { city: 'Paris' }),
      { type: 'function_call_output', call_id: 'c1', output: '{"tempC":18}' },
    ])
    const state = outcome.turns[0]?.transientProviderState as {
      xai: { model: string; input: unknown[] }
    }
    expect(Object.keys(state)).toEqual(['xai'])
    expect(state.xai.model).toBe('grok-4.7')
  })

  async function firstTurn(): Promise<{
    result: LlmResult
    client: ReturnType<typeof createClient>
  }> {
    const fake = makeFakeXai([
      response('grok-4.7', [reasoning, fnCall('c1', 'get_weather', { city: 'Paris' })]),
      response('grok-4.7', [message('ok')]),
    ])
    const client = createClient({ ...composeProviders([xaiProvider({ client: fake })]) })
    const result = await client.generate(
      { provider: 'xai', model: 'grok-4.7', messages: [USER], tools: TOOLS },
      { auth: AUTH },
    )
    return { result, client }
  }
  const toolResult: Message = {
    role: 'user',
    parts: [
      { kind: 'tool-result', toolCallId: 'c1', toolName: 'get_weather', result: 1 },
    ],
  }

  it('rejects the history rule: assistant messages alongside state', async () => {
    const { result, client } = await firstTurn()
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.7',
          tools: TOOLS,
          messages: [USER, result.message, toolResult],
          ...(result.transientProviderState !== undefined
            ? { transientProviderState: result.transientProviderState }
            : {}),
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('rejects the history rule: tool-call history without state', async () => {
    const { result, client } = await firstTurn()
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.7',
          tools: TOOLS,
          messages: [USER, result.message, toolResult],
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })

  // Each bad state is the real first-turn state with exactly one property
  // altered, sent with a tool result that pairs with the state's own function
  // call, so the only thing wrong with the request is the property under test.
  // The control proves that request is otherwise accepted.
  const WRONG = /unexpected key\(s\)|bound to the requested model/

  it('control: the untouched first-turn state is accepted with its tool result', async () => {
    const { result, client } = await firstTurn()
    const second = await client.generate(
      {
        provider: 'xai',
        model: 'grok-4.7',
        tools: TOOLS,
        messages: [toolResult],
        transientProviderState: result.transientProviderState as JsonValue,
      },
      { auth: AUTH },
    )
    expect(second.text).toBe('ok')
  })

  it.each<[string, (state: XaiState) => unknown, RegExp]>([
    [
      'another provider (google)',
      () => ({ google: { signatures: [] } }),
      /unexpected key\(s\) \[google\]/,
    ],
    [
      'the unscoped { model, input } shape',
      (state) => state.xai,
      /unexpected key\(s\) \[model, input\]/,
    ],
    [
      'an extra key beside xai',
      (state) => ({ ...state, x: 1 }),
      /unexpected key\(s\) \[xai, x\]/,
    ],
    [
      'a state bound to another model',
      (state) => ({ xai: { ...state.xai, model: 'grok-4.6' } }),
      /bound to the requested model "grok-4.7"/,
    ],
    [
      'an empty input',
      (state) => ({ xai: { ...state.xai, input: [] } }),
      /bound to the requested model/,
    ],
    [
      'no model',
      (state) => ({ xai: { input: state.xai.input } }),
      /bound to the requested model/,
    ],
  ])('rejects state from %s before dispatch', async (_label, alter, pattern) => {
    const fake = makeFakeXai([
      response('grok-4.7', [reasoning, fnCall('c1', 'get_weather', { city: 'Paris' })]),
      response('grok-4.7', [message('unused')]),
    ])
    const client = createClient({ ...composeProviders([xaiProvider({ client: fake })]) })
    const first = await client.generate(
      { provider: 'xai', model: 'grok-4.7', messages: [USER], tools: TOOLS },
      { auth: AUTH },
    )
    const state = first.transientProviderState as XaiState
    expect(Object.keys(state)).toEqual(['xai'])
    const dispatched = fake.calls.length
    const error: unknown = await client
      .generate(
        {
          provider: 'xai',
          model: 'grok-4.7',
          tools: TOOLS,
          messages: [toolResult],
          transientProviderState: alter(structuredClone(state)) as JsonValue,
        },
        { auth: AUTH },
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'bad_request' })
    expect((error as LlmError).message).toMatch(pattern)
    expect((error as LlmError).message).toMatch(WRONG)
    expect(fake.calls).toHaveLength(dispatched)
  })

  it('a declared alias stays an alias: the state is bound to the string the host sent', async () => {
    const alias = 'grok-4.7-latest'
    const fake = makeFakeXai([
      response('grok-4.7-2026-10-01', [fnCall('c1', 'get_weather', { city: 'Paris' })]),
      response('grok-4.7-2026-10-02', [message('ok')]),
    ])
    const client = createClient({
      adapters: [xaiAdapter({ client: fake })],
      modelRegistry: createModelRegistry([
        ...xaiModelDescriptors.filter((d) => d.model !== 'grok-4.7'),
        { ...grok47ModelDescriptor, aliases: [alias] },
      ]),
    })
    const first = await client.generate(
      { provider: 'xai', model: alias, messages: [USER], tools: TOOLS },
      { auth: AUTH },
    )
    // The provider returned another id; the state is bound to what the host sent.
    expect(first.model).toBe('grok-4.7-2026-10-01')
    expect((first.transientProviderState as { xai: { model: string } }).xai.model).toBe(
      alias,
    )
    const second = await client.generate(
      {
        provider: 'xai',
        model: alias,
        tools: TOOLS,
        messages: [toolResult],
        ...(first.transientProviderState !== undefined
          ? { transientProviderState: first.transientProviderState }
          : {}),
      },
      { auth: AUTH },
    )
    expect(second.text).toBe('ok')
    expect((fake.calls[0] as { model: string }).model).toBe(alias)
    expect((fake.calls[1] as { model: string }).model).toBe(alias)
    // The canonical id is a different string, so the same state is refused there.
    await expect(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.7',
          tools: TOOLS,
          messages: [toolResult],
          ...(first.transientProviderState !== undefined
            ? { transientProviderState: first.transientProviderState }
            : {}),
        },
        { auth: AUTH },
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})
