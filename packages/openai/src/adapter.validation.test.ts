/**
 * Exact validation before dispatch: replayed state against the admitted wire
 * shapes, messages that map to nothing, image URL and base64 forms (in messages
 * and in state), and the strict-schema root, `required` and `const` rules.
 * Every rejection is `bad_request`, names the path, and dispatches nothing.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { JsonValue, ResolvedRequest } from '@gullabs/core'

import { openaiAdapter } from './adapter.js'
import type { OpenAiResponseCreateParams, OpenAiResponseShape } from './client.js'
import { CTX, request, userText } from './test-helpers.js'

function recordingClient() {
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
          })
        },
      },
    },
  }
}

async function rejects(req: ResolvedRequest, match: RegExp): Promise<void> {
  const { client, sent } = recordingClient()
  const err = (await openaiAdapter({ client })
    .run(req, CTX)
    .catch((e: unknown) => e)) as LlmError
  expect(err).toBeInstanceOf(LlmError)
  expect(err.kind).toBe('bad_request')
  expect(err.message).toMatch(match)
  expect(sent).toHaveLength(0)
}

async function accepts(req: ResolvedRequest): Promise<OpenAiResponseCreateParams> {
  const { client, sent } = recordingClient()
  await openaiAdapter({ client }).run(req, CTX)
  expect(sent).toHaveLength(1)
  return sent[0] as OpenAiResponseCreateParams
}

const user = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'q' }],
}
const message = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'a', annotations: [] }],
}
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [{ type: 'summary_text', text: 's' }],
  encrypted_content: 'enc',
  status: 'completed',
}
const call = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 't',
  arguments: '{}',
  status: 'completed',
}
const withState = (input: JsonValue[], messages = [userText('next')]) =>
  request('gpt-6.2-sol', {
    transientProviderState: { openai: { model: 'gpt-6.2-sol', input } },
    messages,
  })

describe('replay state: exact keys and value types', () => {
  it('accepts the shapes this release produces, the typed optional keys included', async () => {
    const sent = await accepts(
      withState([
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'sys' }],
        },
        user,
        { type: 'message', role: 'assistant', content: 'history' },
        { ...message, phase: 'final_answer' },
        { ...reasoning, content: [{ type: 'reasoning_text', text: 'r' }] },
        { ...call, caller: { type: 'direct' } },
        { type: 'function_call_output', call_id: 'call_1', output: '1' },
        {
          type: 'message',
          id: 'msg_2',
          role: 'assistant',
          status: 'incomplete',
          content: [
            { type: 'refusal', refusal: 'no' },
            { type: 'output_text', text: 'x', annotations: [], logprobs: [] },
          ],
        },
        { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: null },
      ]),
    )
    expect(sent.input).toHaveLength(10)
  })

  it.each([
    [
      'an extra key on a user message',
      { ...user, id: 'm' },
      /input\[1\]\.id is not a field/,
    ],
    [
      'a file_id on an input_image',
      {
        ...user,
        content: [
          {
            type: 'input_image',
            image_url: 'https://example.test/a.png',
            detail: 'auto',
            file_id: 'file_1',
          },
        ],
      },
      /input\[1\]\.content\[0\]\.file_id is not a field/,
    ],
    [
      'a prompt_cache_breakpoint on an input_text',
      {
        ...user,
        content: [
          {
            type: 'input_text',
            text: 'q',
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
      /input\[1\]\.content\[0\]\.prompt_cache_breakpoint is not a field/,
    ],
    [
      'detail other than auto',
      {
        ...user,
        content: [
          {
            type: 'input_image',
            image_url: 'https://example.test/a.png',
            detail: 'high',
          },
        ],
      },
      /detail must be "auto"/,
    ],
    [
      'a message with no id',
      { ...message, id: undefined },
      /input\[1\]\.id must be a non-empty string/,
    ],
    [
      'a bad message status',
      { ...message, status: 'done' },
      /input\[1\]\.status must be/,
    ],
    ['a bad phase', { ...message, phase: 'draft' }, /input\[1\]\.phase must be/],
    [
      'a non-empty annotations list (built-in tool citations)',
      {
        ...message,
        content: [
          {
            type: 'output_text',
            text: 'a',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://x.test',
                title: 't',
                start_index: 0,
                end_index: 1,
              },
            ],
          },
        ],
      },
      /annotations must be an empty array/,
    ],
    [
      'output_text without annotations',
      { ...message, content: [{ type: 'output_text', text: 'a' }] },
      /annotations is required/,
    ],
    [
      'non-empty logprobs',
      {
        ...message,
        content: [
          { type: 'output_text', text: 'a', annotations: [], logprobs: [{ token: 'a' }] },
        ],
      },
      /logprobs must be an empty array/,
    ],
    [
      'a reasoning summary part of another type',
      { ...reasoning, summary: [{ type: 'reasoning_text', text: 's' }] },
      /summary\[0\]\.type must be "summary_text"/,
    ],
    [
      'a non-string encrypted_content',
      { ...reasoning, encrypted_content: 5 },
      /encrypted_content must be a string or null/,
    ],
    [
      'an async function call',
      { ...call, async: true },
      /input\[1\]\.async is not admitted in replay state \(async function tools/,
    ],
    [
      'a namespaced function call',
      { ...call, namespace: 'ns' },
      /input\[1\]\.namespace is not admitted in replay state \(tool namespaces/,
    ],
    [
      'a programmatic caller',
      { ...call, caller: { type: 'program', caller_id: 'p' } },
      /caller\.type must be "direct"/,
    ],
    [
      'a caller of another type',
      { ...call, caller: { type: 'program' } },
      /caller\.type must be "direct"/,
    ],
    [
      'a function_call_output with an extra key',
      { type: 'function_call_output', call_id: 'c', output: '1', status: 'completed' },
      /input\[1\]\.status is not a field/,
    ],
    [
      'a non-string function output',
      { type: 'function_call_output', call_id: 'c', output: [] },
      /output must be a string/,
    ],
    [
      'assistant history with an extra key',
      { type: 'message', role: 'assistant', content: 'h', phase: 'final_answer' },
      /input\[1\]\.phase is not a field/,
    ],
  ])('rejects %s', async (_label, item, match) => {
    await rejects(withState([user, item as JsonValue]), match)
  })
})

describe('provider output items are replayed as returned', () => {
  // Keys the SDK 7.60.0 typings do not define, as a newer API could return them.
  const extended = [
    {
      ...message,
      extra: true,
      content: [{ type: 'output_text', text: 'a', annotations: [], parsed: {} }],
    },
    { ...reasoning, other: 1, summary: [{ type: 'summary_text', text: 's', id: 'x' }] },
    { ...call, parsed_arguments: {}, caller: { type: 'direct', note: 'n' } },
  ]

  it('accepts unknown keys on provider items and sends them unchanged', async () => {
    const sent = await accepts(withState([user, ...(extended as JsonValue[])]))
    expect(sent.input.slice(1, 4)).toEqual(extended)
  })

  it('round-trips an output item with an unknown key through the next request', async () => {
    const turn1Output = { ...message, id: 'msg_9', future_field: { x: 1 } }
    const client = {
      responses: {
        create: (): Promise<OpenAiResponseShape> =>
          Promise.resolve({
            id: 'resp_1',
            model: 'gpt-6.2-sol',
            status: 'completed',
            output: [turn1Output],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 0 },
            },
            service_tier: 'default',
          }),
      },
    }
    const first = await openaiAdapter({ client }).run(request('gpt-6.2-sol'), CTX)
    expect(first.warnings.some((w) => w.message.includes('rejected'))).toBe(false)
    const sent = await accepts(
      request('gpt-6.2-sol', {
        transientProviderState: first.transientProviderState!,
        messages: [userText('next')],
      }),
    )
    expect(sent.input[1]).toEqual(turn1Output)
  })
})

describe('values the typings allow that activate no deferred feature round-trip over two turns', () => {
  const roundTrip = async (item: Record<string, unknown>) => {
    const client = {
      responses: {
        create: (): Promise<OpenAiResponseShape> =>
          Promise.resolve({
            id: 'resp_1',
            model: 'gpt-6.2-sol',
            status: 'completed',
            output: [item as OpenAiResponseShape['output'][number]],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 0 },
            },
            service_tier: 'default',
          }),
      },
    }
    const first = await openaiAdapter({ client }).run(request('gpt-6.2-sol'), CTX)
    expect(first.warnings.some((w) => w.message.includes('rejected'))).toBe(false)
    const sent = await accepts(
      request('gpt-6.2-sol', {
        transientProviderState: first.transientProviderState!,
        messages: [userText('next')],
      }),
    )
    expect(sent.input[1]).toEqual(item)
  }

  it.each([
    ['caller: null', { ...call, caller: null }],
    ['caller: direct', { ...call, caller: { type: 'direct' } }],
    ['async: false', { ...call, async: false }],
    ['no caller, async or namespace', { ...call }],
    [
      'empty logprobs',
      {
        ...message,
        content: [{ type: 'output_text', text: 'a', annotations: [], logprobs: [] }],
      },
    ],
    ['empty annotations', { ...message }],
    ['phase: commentary', { ...message, phase: 'commentary' }],
    ['phase: final_answer', { ...message, phase: 'final_answer' }],
    ['phase: null', { ...message, phase: null }],
    ['message status incomplete', { ...message, status: 'incomplete' }],
    ['reasoning status in_progress', { ...reasoning, status: 'in_progress' }],
    ['reasoning status incomplete', { ...reasoning, status: 'incomplete' }],
    ['reasoning without status', { type: 'reasoning', id: 'rs_3', summary: [] }],
    ['encrypted_content: null', { ...reasoning, encrypted_content: null }],
    [
      'reasoning content parts',
      { ...reasoning, content: [{ type: 'reasoning_text', text: 'r' }] },
    ],
  ])('%s', async (_label, item) => {
    await roundTrip(item as Record<string, unknown>)
  })

  it('async that is not a boolean is refused', async () => {
    await rejects(withState([user, { ...call, async: 'yes' }]), /async must be a boolean/)
  })
})

describe('the deferred-feature value rules hold in state and at result time', () => {
  const deferred: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      'a citation annotation',
      {
        ...message,
        content: [
          {
            type: 'output_text',
            text: 'a',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://x.test',
                title: 't',
                start_index: 0,
                end_index: 1,
              },
            ],
          },
        ],
      },
      /annotations must be an empty array/,
    ],
    [
      'logprobs',
      {
        ...message,
        content: [
          { type: 'output_text', text: 'a', annotations: [], logprobs: [{ token: 'a' }] },
        ],
      },
      /logprobs must be an empty array/,
    ],
    [
      'a programmatic caller',
      { ...call, caller: { type: 'program', caller_id: 'p' } },
      /caller\.type must be "direct"/,
    ],
    ['an async call', { ...call, async: true }, /async is not admitted/],
    ['a namespaced call', { ...call, namespace: 'ns' }, /namespace is not admitted/],
  ]

  it.each(deferred)('rejects %s in state', async (_label, item, match) => {
    await rejects(withState([user, item as JsonValue]), match)
  })

  it.each(deferred)(
    'warns about %s when the response carries it',
    async (_label, item, match) => {
      const client = {
        responses: {
          create: (): Promise<OpenAiResponseShape> =>
            Promise.resolve({
              id: 'resp_1',
              model: 'gpt-6.2-sol',
              status: 'completed',
              output: [item as OpenAiResponseShape['output'][number]],
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens: 2,
                output_tokens_details: { reasoning_tokens: 0 },
              },
              service_tier: 'default',
            }),
        },
      }
      const result = await openaiAdapter({ client }).run(request('gpt-6.2-sol'), CTX)
      expect(
        result.warnings.some(
          (w) => match.test(w.message) && w.message.includes('rejected'),
        ),
      ).toBe(true)
    },
  )
})

describe('messages that map to no input item', () => {
  it('rejects a user message with no parts, without state', async () => {
    await rejects(
      request('gpt-6.2-sol', { messages: [{ role: 'user', parts: [] }] }),
      /messages\[0\]: the message maps to no input item/,
    )
  })

  it('rejects a user message with no parts beside state', async () => {
    await rejects(
      withState([user], [{ role: 'user', parts: [] }]),
      /messages\[0\]: the message maps to no input item/,
    )
  })

  it('rejects an empty message among real ones', async () => {
    await rejects(
      request('gpt-6.2-sol', { messages: [userText('a'), { role: 'user', parts: [] }] }),
      /messages\[1\]: the message maps to no input item/,
    )
  })

  it('rejects an assistant history message with no parts', async () => {
    await rejects(
      request('gpt-6.2-sol', {
        messages: [userText('a'), { role: 'assistant', parts: [] }],
      }),
      /messages\[1\]: the message maps to no input item/,
    )
  })

  it('rejects a request with no messages at all', async () => {
    await rejects(request('gpt-6.2-sol', { messages: [] }), /has no new message to send/)
  })
})

describe('image URL and base64 forms', () => {
  const uriMessage = (uri: string) =>
    request('gpt-6.2-sol', {
      messages: [
        { role: 'user', parts: [{ kind: 'file-uri', mimeType: 'image/png', uri }] },
      ],
    })
  const inlineMessage = (data: string) =>
    request('gpt-6.2-sol', {
      messages: [
        { role: 'user', parts: [{ kind: 'inline-media', mimeType: 'image/png', data }] },
      ],
    })
  const stateImage = (image_url: string) =>
    withState([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url, detail: 'auto' }],
      },
    ])

  const badUrls = [
    'https:example.test/image.png',
    'https:/example.test/image.png',
    'https:\\\\example.test\\image.png',
    'https://',
    'https:// example.test/a.png',
    'https://example.test/a b.png',
    'https://example.test/a.png\n',
    'ftp://example.test/a.png',
    'example.test/a.png',
  ]

  it.each(badUrls)('rejects the URL %j in a message', async (uri) => {
    await rejects(
      uriMessage(uri),
      /parts\[0\]\.uri must be a fully qualified http\(s\) image URL/,
    )
  })

  it.each(badUrls)('rejects the URL %j in state', async (uri) => {
    await rejects(
      stateImage(uri),
      /content\[0\]\.image_url must be a fully qualified http\(s\) URL/,
    )
  })

  it('forwards an accepted URL exactly as given', async () => {
    const uri = 'https://Example.test:8443/a.png?x=1#f'
    const sent = await accepts(uriMessage(uri))
    expect(JSON.stringify(sent.input)).toContain(JSON.stringify(uri))
  })

  const badBase64 = [
    'A',
    'AAA',
    'AAAAA',
    '',
    'AA=A',
    'A===',
    '=AAA',
    'AA AA',
    'AA-_',
    'AAAA\n',
  ]

  it.each(badBase64)('rejects the base64 %j in a message', async (data) => {
    await rejects(
      inlineMessage(data),
      /parts\[0\]\.data must be non-empty, padded standard base64/,
    )
  })

  it.each(badBase64)('rejects the base64 %j in a state data URL', async (data) => {
    await rejects(
      stateImage(`data:image/png;base64,${data}`),
      /content\[0\]\.image_url must be/,
    )
  })

  it.each(['AAAA', 'AAA=', 'AA==', 'iVBORw0KGgo='])(
    'accepts the base64 %j',
    async (data) => {
      await accepts(inlineMessage(data))
      await accepts(stateImage(`data:image/png;base64,${data}`))
    },
  )
})

describe('strict schema root, required and const', () => {
  const schema = (s: JsonValue) => request('gpt-6.2-sol', { outputJsonSchema: s })
  const closed = (
    properties: Record<string, JsonValue>,
    extra: Record<string, JsonValue> = {},
  ) => ({
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
    ...extra,
  })

  it('rejects a root with properties but no type', async () => {
    await rejects(
      schema({
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      }),
      /root of an OpenAI strict schema must be \{ type: "object" \}/,
    )
  })

  it('rejects a root typed ["object", "null"]', async () => {
    await rejects(
      schema({ ...closed({}), type: ['object', 'null'] }),
      /root of an OpenAI strict schema/,
    )
  })

  it('rejects a nested object schema without a type', async () => {
    await rejects(
      schema(
        closed({
          inner: {
            properties: { b: { type: 'string' } },
            required: ['b'],
            additionalProperties: false,
          },
        }),
      ),
      /properties\.inner: a schema with properties must declare type: "object"/,
    )
  })

  it('accepts a nested nullable object', async () => {
    await accepts(
      schema(
        closed({
          inner: { ...closed({ b: { type: 'string' } }), type: ['object', 'null'] },
        }),
      ),
    )
  })

  it('rejects required naming a key that is not a property', async () => {
    await rejects(
      schema({ ...closed({ a: { type: 'string' } }), required: ['a', 'b'] }),
      /\.required: .* \["b"\] is not a property or is repeated/,
    )
  })

  it('rejects a repeated required name', async () => {
    await rejects(
      schema({ ...closed({ a: { type: 'string' } }), required: ['a', 'a'] }),
      /\.required: .* \["a"\] is not a property or is repeated/,
    )
  })

  it('accepts const (the guide counts const values toward its size limit)', async () => {
    await accepts(schema(closed({ kind: { type: 'string', const: 'x' } })))
  })

  it('counts const string values toward the 120,000-character limit', async () => {
    const properties: Record<string, JsonValue> = {}
    for (let i = 0; i < 100; i += 1)
      properties[`p${i}`] = { type: 'string', const: 'x'.repeat(1_200) }
    await rejects(
      schema(closed(properties)),
      /characters across property names, definition names, enum values and const values/,
    )
  })

  it('rejects a single enum of 251 values over 15,000 characters, naming its path', async () => {
    const values = Array.from({ length: 251 }, (_, i) => `${'v'.repeat(60)}${i}`)
    await rejects(
      schema(closed({ a: { type: 'string', enum: values } })),
      /output\.jsonSchema\.properties\.a\.enum: 251 values totalling/,
    )
  })

  it('accepts a single enum of 251 values under 15,000 characters', async () => {
    const values = Array.from({ length: 251 }, (_, i) => `v${i}`)
    await accepts(schema(closed({ a: { type: 'string', enum: values } })))
  })

  it('accepts two 150-value enums totalling more than 15,000 characters (the cap is per enum)', async () => {
    const values = (tag: string) =>
      Array.from({ length: 150 }, (_, i) => `${tag}${'v'.repeat(60)}${i}`)
    // 300 values, about 18,600 characters across the two enums.
    await accepts(
      schema(
        closed({
          a: { type: 'string', enum: values('a') },
          b: { type: 'string', enum: values('b') },
        }),
      ),
    )
  })

  it('accepts 250 long enum values (the 15,000 cap applies above 250)', async () => {
    const values = Array.from({ length: 250 }, (_, i) => `${'v'.repeat(60)}${i}`)
    await accepts(schema(closed({ a: { type: 'string', enum: values } })))
  })
})
