/**
 * Request mapping and streaming through the REAL `openai` SDK on a stubbed
 * `fetch`. The SSE frames are documentation-derived (see `test-sse.ts`), not
 * captures; the usage numbers are synthetic and prove the mapping only.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'

import {
  errorResponse,
  functionCallItem,
  hangingSseResponse,
  messageItem,
  reasoningItem,
  responseObject,
  sseResponse,
  streamEvents,
  usage,
} from './test-sse.js'
import { CTX, request, userText, wiredAdapter } from './test-helpers.js'

const ok =
  (output = [messageItem('msg_1', 'hi there')], options = {}) =>
  () =>
    sseResponse(streamEvents(responseObject(output, options)), {
      'x-request-id': 'req_doc_1',
    })

describe('request contract (real SDK, stubbed fetch)', () => {
  it('posts one streamed request to the pinned endpoint with store:false and the system as a leading developer message', async () => {
    const { adapter, calls } = wiredAdapter(ok())
    const result = await adapter.run(
      request('gpt-6.2-sol', {
        system: 'be brief',
        config: {
          reasoning: { effort: 'low' },
          maxOutputTokens: 500,
          serviceTier: 'fast',
        },
      }),
      CTX,
    )
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://api.openai.com/v1/responses')
    expect(call.method).toBe('POST')
    expect(call.headers.get('authorization')).toBe('Bearer sk-test-doc-derived')
    expect(call.body).toEqual({
      model: 'gpt-6.2-sol',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'be brief' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
      store: false,
      max_output_tokens: 500,
      service_tier: 'fast',
      reasoning: { effort: 'low' },
      stream: true,
    })
    expect(call.body).not.toHaveProperty('instructions')
    expect(call.body).not.toHaveProperty('parallel_tool_calls')
    expect(result.text).toBe('hi there')
    expect(result.finishReason).toBe('stop')
    expect(result.providerMetadata).toEqual({ openai: { requestId: 'req_doc_1' } })
  })

  it('maps images to input_image with detail auto (data URL and http URL)', async () => {
    const { adapter, calls } = wiredAdapter(ok())
    await adapter.run(
      request('gpt-6-luna', {
        messages: [
          {
            role: 'user',
            parts: [
              { kind: 'text', text: 'what is this' },
              { kind: 'inline-media', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
              {
                kind: 'file-uri',
                mimeType: 'image/webp',
                uri: 'https://example.com/a.webp',
              },
            ],
          },
        ],
      }),
      CTX,
    )
    expect((calls[0]!.body!['input'] as unknown[])[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'what is this' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,iVBORw0KGgo=',
          detail: 'auto',
        },
        { type: 'input_image', image_url: 'https://example.com/a.webp', detail: 'auto' },
      ],
    })
  })

  it('sends strict structured output as text.format and parses the answer', async () => {
    const schema = {
      title: 'Answer',
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
      additionalProperties: false,
    }
    const { adapter, calls } = wiredAdapter(ok([messageItem('msg_1', '{"n":3}')]))
    const result = await adapter.run(
      request('gpt-6.1-terra', { outputJsonSchema: schema }),
      CTX,
    )
    expect(calls[0]!.body!['text']).toEqual({
      format: { type: 'json_schema', name: 'Answer', schema, strict: true },
    })
    expect(result.rawStructured).toEqual({ n: 3 })
  })

  it('sends strict function tools and a named tool_choice, never parallel_tool_calls', async () => {
    const parameters = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    }
    const { adapter, calls } = wiredAdapter(ok())
    await adapter.run(
      request('gpt-6.2-astra', {
        tools: [
          {
            name: 'weather',
            description: 'Weather for a city',
            inputJsonSchema: parameters,
          },
        ],
        toolChoice: { name: 'weather' },
      }),
      CTX,
    )
    expect(calls[0]!.body!['tools']).toEqual([
      {
        type: 'function',
        name: 'weather',
        description: 'Weather for a city',
        parameters,
        strict: true,
      },
    ])
    expect(calls[0]!.body!['tool_choice']).toEqual({ type: 'function', name: 'weather' })
    expect(calls[0]!.body).not.toHaveProperty('parallel_tool_calls')
  })

  it('omits reasoning.context (the model default)', async () => {
    const { adapter, calls } = wiredAdapter(ok())
    await adapter.run(
      request('gpt-6-luna', { config: { reasoning: { effort: 'max' } } }),
      CTX,
    )
    expect(calls[0]!.body!['reasoning']).toEqual({ effort: 'max' })
  })
})

describe('two-turn function calling replays every output item in order (ADR-029)', () => {
  it('turn 2 sends turn 1 input, the provider output (encrypted reasoning included) and the tool result', async () => {
    const turn1Output = [
      reasoningItem('rs_1', 'gAAAA-encrypted-doc-derived'),
      functionCallItem('fc_1', 'call_1', 'weather', '{"city":"Oslo"}'),
    ]
    const { adapter, calls } = wiredAdapter(
      ok(turn1Output),
      ok([messageItem('msg_2', 'It is cold.')]),
    )
    const tools = [
      {
        name: 'weather',
        description: 'Weather',
        inputJsonSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    ]
    const first = await adapter.run(
      request('gpt-6.2-sol', { system: 'sys', messages: [userText('weather?')], tools }),
      CTX,
    )
    expect(first.finishReason).toBe('tool_calls')
    expect(first.toolCalls).toEqual([
      { toolCallId: 'call_1', toolName: 'weather', args: { city: 'Oslo' } },
    ])
    const second = await adapter.run(
      request('gpt-6.2-sol', {
        system: 'sys',
        tools,
        transientProviderState: first.transientProviderState!,
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: 'call_1',
                toolName: 'weather',
                result: { t: -3 },
              },
            ],
          },
        ],
      }),
      CTX,
    )
    expect(calls[1]!.body!['input']).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'sys' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'weather?' }],
      },
      ...turn1Output,
      { type: 'function_call_output', call_id: 'call_1', output: '{"t":-3}' },
    ])
    expect(second.text).toBe('It is cold.')
  })
})

describe('streaming failures (real SDK)', () => {
  it('an early clean EOF without a terminal event is a server error, not the snapshot', async () => {
    const events = streamEvents(responseObject([messageItem('msg_1', 'partial')]), {
      omitTerminal: true,
    })
    const { adapter } = wiredAdapter(() => sseResponse(events))
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
    expect(err.usage?.details['usage_estimated']).toBe(1)
  })

  it('an early EOF before any output event is retryable and carries no usage', async () => {
    const events = streamEvents(responseObject([]), { cutAfter: 2 })
    const { adapter } = wiredAdapter(() => sseResponse(events))
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(true)
    expect(err.usage).toBeUndefined()
  })

  it('maxRetries is 0: a 429 and a 500 each make exactly one fetch', async () => {
    for (const status of [429, 500]) {
      const { adapter, calls } = wiredAdapter(() =>
        errorResponse(status, {
          message: 'doc-derived',
          type: 'server_error',
          code: null,
        }),
      )
      const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
      expect(calls).toHaveLength(1)
      expect(err.httpStatus).toBe(status)
      expect(err.retryable).toBe(true)
    }
  })

  it('honours Retry-After on a rate-limit 429', async () => {
    const { adapter } = wiredAdapter(() =>
      errorResponse(
        429,
        {
          message: 'Rate limit reached for requests',
          type: 'requests',
          code: 'rate_limit_exceeded',
        },
        { 'retry-after': '7' },
      ),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('rate_limited')
    expect(err.retryable).toBe(true)
    expect(err.retryAfterMs).toBe(7000)
  })

  it.each([
    'credit_balance_exhausted',
    'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
  ])('a 429 with billing code %s is not retryable (credits_exhausted)', async (code) => {
    const { adapter } = wiredAdapter(() =>
      errorResponse(
        429,
        { message: 'doc-derived', type: 'insufficient_quota', code },
        { 'retry-after': '1' },
      ),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('rate_limited')
    expect(err.retryable).toBe(false)
    expect(err.reason).toBe('credits_exhausted')
  })

  it.each([
    [401, 'invalid_auth'],
    [403, 'invalid_auth'],
    [404, 'bad_request'],
    [503, 'server'],
  ] as const)('HTTP %i classifies as %s', async (status, kind) => {
    const { adapter } = wiredAdapter(() =>
      errorResponse(status, { message: 'doc-derived', type: 'x', code: null }),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe(kind)
    expect(err.provider).toBe('openai')
  })

  it('the client deadline ends a stream that stays open after output began', async () => {
    const events = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
      cutAfter: 5,
    })
    const { adapter } = wiredAdapter((call) => hangingSseResponse(events, call.signal))
    const err = (await adapter
      .run(request('gpt-6.2-sol', { config: { timeoutMs: 1 } }), CTX)
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('timeout')
    expect(err.reason).toBe('transport_timeout')
    expect(err.retryable).toBe(false)
    expect(err.usage?.details['usage_estimated']).toBe(1)
  }, 10_000)

  it('a caller abort mid-stream is re-thrown as aborted with the estimate', async () => {
    const controller = new AbortController()
    const events = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
      cutAfter: 5,
    })
    const { adapter } = wiredAdapter((call) => {
      setTimeout(() => controller.abort(), 20)
      return hangingSseResponse(events, call.signal)
    })
    const err = (await adapter
      .run(request(), { ...CTX, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('aborted')
    expect(err.retryable).toBe(false)
    expect(err.usage?.details['usage_estimated']).toBe(1)
  })

  it('a caller abort before output is a plain aborted error without usage', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter } = wiredAdapter((call) => hangingSseResponse([], call.signal))
    const err = (await adapter
      .run(request(), { ...CTX, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('aborted')
    expect(err.usage).toBeUndefined()
  })

  it('an engine deadline reason (LlmError) keeps its kind', async () => {
    const controller = new AbortController()
    const reason = new LlmError('deadline', { kind: 'timeout', retryable: true })
    const events = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
      cutAfter: 5,
    })
    const { adapter } = wiredAdapter((call) => {
      setTimeout(() => controller.abort(reason), 20)
      return hangingSseResponse(events, call.signal)
    })
    const err = (await adapter
      .run(request(), { ...CTX, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('timeout')
    expect(err.cause).toBe(reason)
  })

  it('a mid-stream error event is mayHaveBilled and classified by its code', async () => {
    const events = [
      ...streamEvents(responseObject([messageItem('msg_1', 'abc')]), { cutAfter: 5 }),
      {
        type: 'error',
        sequence_number: 99,
        code: 'server_error',
        message: 'doc-derived',
        param: null,
      },
    ]
    const { adapter } = wiredAdapter(() => sseResponse(events))
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
  })

  it('response.failed keeps the terminal usage and served tier and is not retried after output', async () => {
    const failed = responseObject([messageItem('msg_1', 'abc')], {
      status: 'failed',
      error: { code: 'server_error', message: 'doc-derived' },
      usage: usage(100, 20),
      serviceTier: 'fast',
    })
    const { adapter } = wiredAdapter(() =>
      sseResponse(streamEvents(failed, { terminal: 'response.failed' })),
    )
    const err = (await adapter
      .run(request('gpt-6.2-sol', { config: { serviceTier: 'fast' } }), CTX)
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
    expect(err.usage?.inputTokens).toBe(100)
    expect(err.servedServiceTier).toBe('fast')
  })

  it('response.incomplete with max_output_tokens is finishReason length and drops cut calls', async () => {
    const incomplete = responseObject(
      [functionCallItem('fc_1', 'call_1', 'weather', '{"city":"Os')],
      { status: 'incomplete', incompleteReason: 'max_output_tokens' },
    )
    const { adapter } = wiredAdapter(() =>
      sseResponse(streamEvents(incomplete, { terminal: 'response.incomplete' })),
    )
    const result = await adapter.run(request(), CTX)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.message.parts).toEqual([])
    expect(
      result.warnings.some((w) => w.message.includes('dropped 1 function call')),
    ).toBe(true)
  })

  it('a refusal part is content_filter with a warning and no text', async () => {
    const refused = responseObject([
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
      },
    ])
    const { adapter } = wiredAdapter(() => sseResponse(streamEvents(refused)))
    const result = await adapter.run(request(), CTX)
    expect(result.finishReason).toBe('content_filter')
    expect(result.text).toBeUndefined()
    expect(result.warnings.some((w) => w.message.includes('refused'))).toBe(true)
  })
})
