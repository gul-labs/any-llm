/**
 * What the adapter makes of a terminal response whose items are not a plain
 * answer: a function call that was cut or ended an abnormal response, a message
 * part that carries no `text`, reasoning summaries in several parts.
 *
 * SYNTHETIC (ADR-013): the event sequences are the OpenAI Responses grammar
 * (`synthesizeStreamEvents`), and the `refusal` part is that grammar's
 * `ResponseOutputRefusal` (`{ type: 'refusal', refusal }`); xAI has not been
 * captured refusing or cutting a function call.
 */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { makeFakeXai } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { grok47ModelDescriptor } from './models.js'
import { sseResponse, synthesizeStreamEvents } from './test-sse.js'

type Plain = Record<string, unknown>

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

const usage = { input_tokens: 100, output_tokens: 40 }

const tools = [
  {
    name: 'get',
    description: 'get a thing',
    inputJsonSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
      additionalProperties: false,
    },
  },
]

function req(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.7',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: grok47ModelDescriptor,
    tools,
    ...overrides,
  }
}

function response(extra: Plain): never {
  return {
    id: 'resp_1',
    model: 'grok-4.7',
    status: 'completed',
    usage,
    output: [],
    ...extra,
  } as never
}

const functionCall = (extra: Plain = {}): Plain => ({
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'get',
  arguments: '{"location":"Paris"}',
  status: 'completed',
  ...extra,
})

const messageItem = (content: Plain[]): Plain => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content,
})

const run = (res: never, r: ResolvedRequest = req()) =>
  xaiAdapter({ client: makeFakeXai(res) }).run(r, CTX)

describe('a function call that did not complete is not a tool call', () => {
  it('drops a call cut by max_output_tokens: finishReason length, no tool call, a warning', async () => {
    const result = await run(
      response({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [functionCall({ status: 'incomplete', arguments: '{"location":"Par' })],
      }),
    )
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.message.parts).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.message).toContain('"get"')
    expect(result.warnings[0]?.message).toContain('incomplete')
    expect(result.warnings[0]?.message).toContain('"length"')
  })

  it('drops every call of a non-completed response, even a finished one, and keeps the text', async () => {
    const result = await run(
      response({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          functionCall(),
          messageItem([{ type: 'output_text', text: 'partial answer' }]),
        ],
      }),
    )
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.text).toBe('partial answer')
    expect(result.message.parts).toEqual([{ kind: 'text', text: 'partial answer' }])
  })

  it('maps an incomplete response with another reason to "other" and still drops the call', async () => {
    const result = await run(
      response({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        output: [functionCall()],
      }),
    )
    expect(result.finishReason).toBe('other')
    expect(result.toolCalls).toBeUndefined()
    expect(result.warnings[0]?.message).toContain('"other"')
  })

  it('drops a call whose own status is not completed beside a completed response', async () => {
    const result = await run(
      response({ output: [functionCall({ status: 'in_progress' })] }),
    )
    expect(result.toolCalls).toBeUndefined()
    expect(result.finishReason).toBe('stop')
    expect(result.warnings[0]?.message).toContain('"get"')
  })

  it('keeps the complete call of a completed response as before', async () => {
    const result = await run(response({ output: [functionCall()] }))
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call_1', toolName: 'get', args: { location: 'Paris' } },
    ])
    expect(result.warnings).toEqual([])
  })

  it('does not replay a dropped call in the next turn state', async () => {
    const result = await run(
      response({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [], status: 'completed' },
          functionCall({ status: 'incomplete', arguments: '{"loc' }),
        ],
      }),
    )
    const state = result.transientProviderState as {
      xai: { input: Array<{ type?: string }> }
    }
    expect(state.xai.input.map((item) => item.type)).toEqual([undefined, 'reasoning'])
  })

  it('throws a typed non-retryable server error carrying the usage for a completed call with unparseable arguments', async () => {
    const err = await run(
      response({ output: [functionCall({ arguments: 'not-json' })] }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'xai' })
    expect((err as LlmError).message).toContain('"get"')
    expect((err as LlmError).usage).toMatchObject({ inputTokens: 100, outputTokens: 40 })
  })

  it('through the real SDK stream: a response.incomplete with a half-built call is length', async () => {
    const final = {
      id: 'resp_1',
      model: 'grok-4.7',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage,
      output: [functionCall({ status: 'incomplete', arguments: '{"location":"Par' })],
    }
    const events = synthesizeStreamEvents(final, {
      terminal: 'response.incomplete',
      omitDone: true,
    })
    const adapter = xaiAdapter({
      transport: { fetch: (() => Promise.resolve(sseResponse(events))) as typeof fetch },
    })
    const result = await adapter.run(req(), CTX)
    expect(result.finishReason).toBe('length')
    expect(result.toolCalls).toBeUndefined()
    expect(result.warnings.some((w) => w.message.includes('"get"'))).toBe(true)
  })
})

describe('a message content part without text', () => {
  it('a refusal part is text-less, finishReason content_filter, with a warning and the usage', async () => {
    const result = await run(
      response({
        output: [messageItem([{ type: 'refusal', refusal: 'I cannot help with that.' }])],
      }),
      req({ tools: [] }),
    )
    expect(result.text).toBeUndefined()
    expect(result.message.parts).toEqual([])
    expect(result.finishReason).toBe('content_filter')
    expect(result.usage.inputTokens).toBe(100)
    expect(result.warnings.map((w) => w.message).join('\n')).toContain(
      'I cannot help with that.',
    )
  })

  it('keeps the text beside a refusal part and still reports content_filter', async () => {
    const result = await run(
      response({
        output: [
          messageItem([
            { type: 'output_text', text: 'Partly: ' },
            { type: 'refusal', refusal: 'no' },
            { type: 'output_text', text: 'done.' },
          ]),
        ],
      }),
      req({ tools: [] }),
    )
    expect(result.text).toBe('Partly: done.')
    expect(result.finishReason).toBe('content_filter')
  })

  it('ignores a part of an unknown type with a warning naming the type', async () => {
    const result = await run(
      response({
        output: [
          messageItem([
            { type: 'audio_transcript', transcript: 'x' },
            { type: 'output_text', text: 'hello' },
          ]),
        ],
      }),
      req({ tools: [] }),
    )
    expect(result.text).toBe('hello')
    expect(result.finishReason).toBe('stop')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.message).toContain('"audio_transcript"')
  })

  it('does not lose an answer whose annotations sit after a text-less part', async () => {
    const url = 'https://example.com/a'
    const marker = `[[1]](${url})`
    const text = `Fact ${marker}`
    const result = await run(
      response({
        output: [
          messageItem([
            { type: 'refusal', refusal: 'r' },
            {
              type: 'output_text',
              text,
              annotations: [
                {
                  type: 'url_citation',
                  url,
                  title: '1',
                  start_index: 5,
                  end_index: 5 + marker.length,
                },
              ],
            },
          ]),
        ],
      }),
      req({ tools: [] }),
    )
    expect(result.text).toBe(text)
    expect(result.citations?.[0]).toMatchObject({
      url,
      cited: true,
      textRange: { start: 5, end: 5 + marker.length },
    })
  })
})

describe('reasoning summary parts', () => {
  it('are separated by a blank line within and across reasoning items', async () => {
    const result = await run(
      response({
        output: [
          {
            type: 'reasoning',
            id: 'rs_1',
            status: 'completed',
            summary: [
              { type: 'summary_text', text: 'First step done.' },
              { type: 'summary_text', text: 'Next step.' },
            ],
          },
          {
            type: 'reasoning',
            id: 'rs_2',
            status: 'completed',
            summary: [{ type: 'summary_text', text: 'Last.' }],
          },
          messageItem([{ type: 'output_text', text: 'ok' }]),
        ],
      }),
      req({ tools: [] }),
    )
    expect(result.reasoningText).toBe('First step done.\n\nNext step.\n\nLast.')
  })
})
