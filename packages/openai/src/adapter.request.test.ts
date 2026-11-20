/**
 * Pre-dispatch rejections and input mapping, against an injected structural
 * client that records what it is sent. Every rejection is `bad_request` before
 * any dispatch (reject, don't map) and names the offending path.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { JsonValue, ResolvedRequest } from '@gullabs/core'

import { openaiAdapter } from './adapter.js'
import type { OpenAiResponseCreateParams, OpenAiResponseShape } from './client.js'
import { CTX, request, userText } from './test-helpers.js'

function recordingClient(response?: Partial<OpenAiResponseShape>) {
  const sent: OpenAiResponseCreateParams[] = []
  return {
    sent,
    client: {
      responses: {
        create(params: OpenAiResponseCreateParams): Promise<OpenAiResponseShape> {
          sent.push(params)
          return Promise.resolve({
            id: 'resp_1',
            model: params.model,
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'ok', annotations: [] }],
              },
            ],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 12,
            },
            service_tier: 'default',
            ...response,
          })
        },
      },
    },
  }
}

async function rejects(req: ResolvedRequest, match: string | RegExp): Promise<void> {
  const { client, sent } = recordingClient()
  const err = (await openaiAdapter({ client })
    .run(req, CTX)
    .catch((e: unknown) => e)) as LlmError
  expect(err).toBeInstanceOf(LlmError)
  expect(err.kind).toBe('bad_request')
  expect(err.retryable).toBe(false)
  expect(err.message).toMatch(match)
  expect(sent).toHaveLength(0)
}

const obj = (properties: Record<string, JsonValue>): JsonValue => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

describe('input parts', () => {
  it('rejects file-ref parts (file ids are deferred)', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        messages: [{ role: 'user', parts: [{ kind: 'file-ref', fileId: 'file_1' }] }],
      }),
      /messages\[0\]\.parts\[0\]: file-ref/,
    )
  })

  it.each(['application/pdf', 'image/jpg', 'image/heic', 'audio/wav'])(
    'rejects inline media of type %s',
    async (mimeType) => {
      await rejects(
        request('gpt-6.2-sol', {
          messages: [
            { role: 'user', parts: [{ kind: 'inline-media', mimeType, data: 'AAAA' }] },
          ],
        }),
        /not admitted|media type/i,
      )
    },
  )

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])(
    'accepts inline %s',
    async (mimeType) => {
      const { client, sent } = recordingClient()
      await openaiAdapter({ client }).run(
        request('gpt-6.2-sol', {
          messages: [
            { role: 'user', parts: [{ kind: 'inline-media', mimeType, data: 'AAAA' }] },
          ],
        }),
        CTX,
      )
      expect(sent).toHaveLength(1)
    },
  )

  it.each([
    'gs://bucket/a.png',
    'file:///tmp/a.png',
    'data:image/png;base64,AAAA',
    'not a url',
  ])(
    'rejects a file-uri image that is not a fully qualified http(s) URL: %s',
    async (uri) => {
      await rejects(
        request('gpt-6.2-sol', {
          messages: [
            { role: 'user', parts: [{ kind: 'file-uri', mimeType: 'image/png', uri }] },
          ],
        }),
        /messages\[0\]\.parts\[0\]\.uri must be a fully qualified http\(s\) image URL/,
      )
    },
  )

  it('rejects a media resolution hint', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'inline-media',
                mimeType: 'image/png',
                data: 'AAAA',
                mediaResolution: 'high',
              },
            ],
          },
        ],
      }),
      /messages\[0\]\.parts\[0\]\.mediaResolution/,
    )
  })

  it('rejects base64 that is not padded standard base64', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AA AA\n' }],
          },
        ],
      }),
      /parts\[0\]\.data must be non-empty, padded standard base64/,
    )
  })

  it('rejects more than 1,500 images per request', async () => {
    const parts = Array.from({ length: 1_501 }, () => ({
      kind: 'file-uri' as const,
      mimeType: 'image/png',
      uri: 'https://example.com/a.png',
    }))
    await rejects(
      request('gpt-6.2-sol', { messages: [{ role: 'user', parts }] }),
      /1501 images; OpenAI documents at most 1500/,
    )
  })

  it('maps a prior assistant text message as history', async () => {
    const { client, sent } = recordingClient()
    await openaiAdapter({ client }).run(
      request('gpt-6.2-sol', {
        messages: [
          userText('hi'),
          { role: 'assistant', parts: [{ kind: 'text', text: 'hello' }] },
          userText('again'),
        ],
      }),
      CTX,
    )
    expect(sent[0]!.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', content: 'hello' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] },
    ])
  })

  it('rejects function-call history without state', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        messages: [
          userText('q'),
          {
            role: 'assistant',
            parts: [{ kind: 'tool-call', toolCallId: 'c', toolName: 't', args: {} }],
          },
        ],
      }),
      /messages\[1\]\.parts\[0\]: function-call history .* requires transientProviderState/,
    )
    await rejects(
      request('gpt-6.2-sol', {
        messages: [
          {
            role: 'user',
            parts: [{ kind: 'tool-result', toolCallId: 'c', toolName: 't', result: 1 }],
          },
        ],
      }),
      /messages\[0\]\.parts\[0\]: a tool result .* requires transientProviderState/,
    )
  })
})

describe('config', () => {
  it.each([
    ['temperature', { temperature: 0.5 }],
    ['topP', { topP: 0.5 }],
    ['topK', { topK: 5 }],
    ['stopSequences', { stopSequences: ['x'] }],
  ])('rejects %s (no sampling keys)', async (key, config) => {
    await rejects(request('gpt-6.1-terra', { config }), new RegExp(`config\\.${key}`))
  })

  it('rejects providerOptions (no lane in this release)', async () => {
    await rejects(
      request('gpt-6.1-terra', { config: { providerOptions: {} } }),
      /config\.providerOptions/,
    )
  })

  it.each([
    ['gpt-6.2-astra', 'high'],
    ['gpt-6.2-sol', 'none'],
    ['gpt-6.2-sol', 'max'],
  ] as const)('rejects %s effort %s against the descriptor', async (model, effort) => {
    await rejects(
      request(model, { config: { reasoning: { effort } } }),
      /reasoning\.effort/,
    )
  })

  it('rejects budgetTokens and includeThoughts', async () => {
    await rejects(
      request('gpt-6-luna', { config: { reasoning: { budgetTokens: 100 } } }),
      /reasoning\.budgetTokens/,
    )
    await rejects(
      request('gpt-6-luna', { config: { reasoning: { includeThoughts: true } } }),
      /reasoning\.includeThoughts/,
    )
  })

  it.each([
    ['gpt-6.2-sol', 'flex'],
    ['gpt-6.1-terra', 'priority'],
    ['gpt-6-luna', 'ultrafast'],
    ['gpt-6-luna', 'default'],
  ])('rejects %s serviceTier %s', async (model, serviceTier) => {
    await rejects(request(model, { config: { serviceTier } }), /serviceTier/)
  })

  it('rejects a request without a registered descriptor', async () => {
    const { modelDescriptor: _omit, ...bare } = request('gpt-6.2-sol')
    await rejects(bare, /registered OpenAI model descriptor/)
  })

  it('rejects structured output together with function tools', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        outputJsonSchema: obj({ a: { type: 'string' } }),
        tools: [{ name: 't', description: 'd', inputJsonSchema: obj({}) }],
      }),
      /Structured output together with function tools/,
    )
  })
})

describe('strict schemas (output and tool parameters)', () => {
  const rejectsSchema = (schema: JsonValue, match: RegExp) =>
    rejects(request('gpt-6.2-sol', { outputJsonSchema: schema }), match)

  it('requires additionalProperties: false on every object, with the path', async () => {
    await rejectsSchema(
      {
        type: 'object',
        properties: { inner: { type: 'object', properties: {}, required: [] } },
        required: ['inner'],
        additionalProperties: false,
      },
      /output\.jsonSchema\.properties\.inner: every object .* additionalProperties: false/,
    )
  })

  it('requires every property to be required, with the path', async () => {
    await rejectsSchema(
      {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      },
      /output\.jsonSchema\.required: .* missing \["b"\]/,
    )
  })

  it('requires an object root that is not anyOf', async () => {
    await rejectsSchema({ type: 'string' }, /root of an OpenAI strict schema must be/)
    await rejectsSchema(
      { anyOf: [obj({}), obj({ a: { type: 'string' } })] },
      /root of an OpenAI strict schema/,
    )
  })

  it.each([
    ['oneOf', { a: { oneOf: [{ type: 'string' }, { type: 'number' }] } }],
    ['allOf', { a: { allOf: [{ type: 'string' }] } }],
    ['minLength', { a: { type: 'string', minLength: 1 } }],
    [
      'uniqueItems',
      { a: { type: 'array', items: { type: 'string' }, uniqueItems: true } },
    ],
  ] as const)(
    'rejects the unsupported keyword %s with its path',
    async (keyword, properties) => {
      await rejectsSchema(
        obj(properties as Record<string, JsonValue>),
        new RegExp(keyword),
      )
    },
  )

  it('rejects an unlisted format', async () => {
    await rejectsSchema(obj({ a: { type: 'string', format: 'uri' } }), /format/)
  })

  it('rejects more than 10 levels of nesting', async () => {
    let schema: JsonValue = obj({ leaf: { type: 'string' } })
    for (let i = 0; i < 10; i += 1) schema = obj({ n: schema })
    await rejectsSchema(schema, /at most 10 levels of nesting/)
  })

  it('accepts exactly 10 levels of nesting', async () => {
    let schema: JsonValue = obj({ leaf: { type: 'string' } })
    for (let i = 0; i < 8; i += 1) schema = obj({ n: schema })
    const { client, sent } = recordingClient()
    await openaiAdapter({ client }).run(
      request('gpt-6.2-sol', { outputJsonSchema: schema }),
      CTX,
    )
    expect(sent).toHaveLength(1)
  })

  it('rejects more than 1,000 enum values', async () => {
    const values = Array.from({ length: 1_001 }, (_, i) => `v${i}`)
    await rejectsSchema(obj({ a: { type: 'string', enum: values } }), /1001 enum values/)
  })

  it('rejects more than 5,000 object properties', async () => {
    const properties: Record<string, JsonValue> = {}
    for (let i = 0; i < 5_001; i += 1) properties[`p${i}`] = { type: 'boolean' }
    await rejectsSchema(obj(properties), /5001 object properties/)
  })

  it('rejects more than 120,000 characters of names and enum values', async () => {
    const values = Array.from({ length: 900 }, (_, i) => `${'x'.repeat(140)}${i}`)
    await rejectsSchema(obj({ a: { type: 'string', enum: values } }), /characters across/)
  })

  it('accepts recursion through $defs (documented as supported)', async () => {
    const schema = {
      type: 'object',
      properties: { node: { $ref: '#/$defs/node' } },
      required: ['node'],
      additionalProperties: false,
      $defs: {
        node: {
          type: 'object',
          properties: { children: { type: 'array', items: { $ref: '#/$defs/node' } } },
          required: ['children'],
          additionalProperties: false,
        },
      },
    }
    const { client, sent } = recordingClient()
    await openaiAdapter({ client }).run(
      request('gpt-6.2-sol', { outputJsonSchema: schema }),
      CTX,
    )
    expect(sent).toHaveLength(1)
  })

  it('checks tool parameters with the tool path', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        tools: [
          { name: 'ok', description: 'd', inputJsonSchema: obj({}) },
          {
            name: 'bad',
            description: 'd',
            inputJsonSchema: { type: 'object', properties: { a: { type: 'string' } } },
          },
        ],
      }),
      /tools\[1\]\.inputJsonSchema/,
    )
  })

  it('rejects a schema title that cannot be the format name', async () => {
    await rejectsSchema(
      { ...(obj({}) as Record<string, JsonValue>), title: 'has spaces' },
      /output\.jsonSchema\.title "has spaces"/,
    )
  })
})

describe('replay state', () => {
  const state = (input: JsonValue[], model = 'gpt-6.2-sol'): JsonValue => ({
    openai: { model, input },
  })
  const user = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'q' }],
  }

  it.each([
    ['another provider', { xai: { model: 'gpt-6.2-sol', input: [user] } }],
    ['another model', state([user], 'gpt-6-luna')],
    ['an empty input', state([])],
    ['an extra key', { openai: { model: 'gpt-6.2-sol', input: [user], extra: 1 } }],
  ])('rejects state for %s', async (_label, transientProviderState) => {
    await rejects(
      request('gpt-6.2-sol', { transientProviderState }),
      /transientProviderState must be/,
    )
  })

  it.each([
    [
      'a built-in tool call item',
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    ],
    ['a compaction item', { type: 'compaction', id: 'c_1' }],
    [
      'a file input part',
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', file_id: 'file_1' }],
      },
    ],
    [
      'an image of an undocumented type',
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/bmp;base64,AA', detail: 'auto' },
        ],
      },
    ],
    ['a system role', { type: 'message', role: 'system', content: [] }],
  ])('rejects state that carries %s, naming the item', async (_label, item) => {
    await rejects(
      request('gpt-6.2-sol', {
        transientProviderState: state([user, item as JsonValue]),
      }),
      /transientProviderState\.openai\.input\[1\]/,
    )
  })

  it('rejects assistant messages beside state, and state without new messages', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        transientProviderState: state([user]),
        messages: [{ role: 'assistant', parts: [{ kind: 'text', text: 'x' }] }],
      }),
      /cannot contain assistant history/,
    )
    await rejects(
      request('gpt-6.2-sol', { transientProviderState: state([user]), messages: [] }),
      /requires new messages/,
    )
  })

  it('rejects a tool result that answers no call, or answers one twice', async () => {
    const call = { type: 'function_call', call_id: 'call_1', name: 't', arguments: '{}' }
    const result = { type: 'function_call_output', call_id: 'call_1', output: '1' }
    const toolResult = (id: string) => ({
      role: 'user' as const,
      parts: [{ kind: 'tool-result' as const, toolCallId: id, toolName: 't', result: 1 }],
    })
    await rejects(
      request('gpt-6.2-sol', {
        transientProviderState: state([user, call]),
        messages: [toolResult('call_2')],
      }),
      /must answer an unanswered function call/,
    )
    await rejects(
      request('gpt-6.2-sol', {
        transientProviderState: state([user, call, result]),
        messages: [toolResult('call_1')],
      }),
      /must answer an unanswered function call/,
    )
  })

  it('rejects a system that differs from the replayed developer message', async () => {
    const developer = {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'sys' }],
    }
    await rejects(
      request('gpt-6.2-sol', {
        system: 'other',
        transientProviderState: state([developer, user]),
        messages: [userText('next')],
      }),
      /system must equal the developer message/,
    )
    const { client, sent } = recordingClient()
    await openaiAdapter({ client }).run(
      request('gpt-6.2-sol', {
        system: 'sys',
        transientProviderState: state([developer, user]),
        messages: [userText('next')],
      }),
      CTX,
    )
    expect(sent[0]!.input).toHaveLength(3)
  })
})
