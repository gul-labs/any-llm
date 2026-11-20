/**
 * Enumerated inputs for three transport rules: the `content-type` of a 200, the
 * shape of each decoded event payload, and the own-property fill of completed
 * items. Real `openai/error` and `openai/streaming` classes over a stubbed
 * `fetch`; frames are documentation-derived (`test-sse.ts`), not captures.
 *
 * @module
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'

import { isEventStreamMediaType } from './client.js'
import {
  functionCallItem,
  messageItem,
  responseObject,
  sseBody,
  sseResponse,
  streamEvents,
} from './test-sse.js'
import { CTX, request, wiredAdapter } from './test-helpers.js'

beforeAll(async () => {
  await Promise.all([import('openai/streaming'), import('openai/error')])
}, 60_000)

const okBody = () => sseBody(streamEvents(responseObject([messageItem('msg_1', 'ok')])))

/**
 * A 200 over `body` with exactly `contentType`. A stream body, because a string
 * body makes `Response` add `text/plain;charset=UTF-8` when no header is given,
 * which would hide the missing-header case.
 */
const respond = (body: string, contentType: string | null) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (body !== '') controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: contentType === null ? {} : { 'content-type': contentType } },
  )

describe('content-type of a 200: exactly text/event-stream', () => {
  // Media type (RFC 9110 §8.3.1): type "/" subtype *( OWS ";" OWS parameter ),
  // case-insensitive type and subtype. Content-Type holds ONE media type, so a
  // comma-joined list (what Headers.get returns for two fields) is rejected.
  const accepted = [
    'text/event-stream',
    'Text/Event-Stream',
    'TEXT/EVENT-STREAM',
    'text/event-stream; charset=utf-8',
    ' text/event-stream ;charset=utf-8',
    'text/event-stream;',
  ]
  const rejected: Array<string | null> = [
    null,
    '',
    ' ',
    'text/event-stream+json',
    'text/event-streamx',
    'text/event-stream2',
    'text/event',
    'event-stream',
    'application/json',
    'text/plain',
    'text/event-stream, application/json',
    'application/json; x=text/event-stream',
    'text /event-stream',
  ]

  it.each(accepted)('accepts %j (predicate and a real call)', async (contentType) => {
    expect(isEventStreamMediaType(contentType)).toBe(true)
    const { adapter } = wiredAdapter(() => respond(okBody(), contentType))
    expect((await adapter.run(request(), CTX)).text).toBe('ok')
  })

  it.each(rejected)(
    'rejects %j: a non-retryable server error that may have billed',
    async (contentType) => {
      expect(isEventStreamMediaType(contentType)).toBe(false)
      // A real event body: rejection must come from the header, not the body.
      const { adapter } = wiredAdapter(() => respond(okBody(), contentType))
      const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('server')
      expect(err.retryable).toBe(false)
      expect(err.mayHaveBilled).toBe(true)
      expect(err.message).toContain('not text/event-stream')
      // Headers trims a value, so " " arrives as an empty content-type.
      const sent = new Headers(
        contentType === null ? {} : { 'content-type': contentType },
      ).get('content-type')
      expect(err.message).toContain(
        sent === null ? 'no content-type' : `content-type ${JSON.stringify(sent)}`,
      )
    },
  )

  it('a bare JSON answer with no content-type is not a retryable early end', async () => {
    const { adapter } = wiredAdapter(() =>
      respond(JSON.stringify(responseObject([])), null),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.retryable).toBe(false)
    expect(err.message).not.toContain('ended without a terminal event')
  })

  it('a missing or empty body that IS text/event-stream stays a retryable early end', async () => {
    for (const body of [null, '']) {
      const { adapter } = wiredAdapter(
        () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      )
      const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
      expect(err.kind).toBe('server')
      expect(err.retryable).toBe(true)
      expect(err.message).toContain('ended without a terminal event')
    }
  })
})

describe('decoded event payloads: an object with a non-empty string type', () => {
  const payloads: Array<[string, string]> = [
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"x"'],
    ['true', 'true'],
    ['an array', '[]'],
    ['an object without type', '{}'],
    ['an empty type', '{"type":""}'],
    ['a numeric type', '{"type":7}'],
    ['a null type', '{"type":null}'],
    ['an object type', '{"type":{"x":1}}'],
    ['an inherited-only type', '{"__proto__":{"type":"response.completed"}}'],
  ]
  // Only lifecycle events precede the bad frame: no output.
  const before = streamEvents(responseObject([]), { cutAfter: 2 })
  // created, in_progress, output_item.added, content_part.added, output_text.delta.
  const after = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
    cutAfter: 5,
  })
  const frame = (events: ReturnType<typeof streamEvents>, json: string) =>
    respond(`${sseBody(events)}data: ${json}\n\n`, 'text/event-stream')

  it.each(payloads)(
    '%s before output: malformed, retryable, no usage (it did not count as output)',
    async (_label, json) => {
      const { adapter } = wiredAdapter(() => frame(before, json))
      const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('server')
      expect(err.message).toContain('stream body is malformed')
      expect(err.retryable).toBe(true)
      expect(err.mayHaveBilled).toBeUndefined()
      expect(err.usage).toBeUndefined()
    },
  )

  it.each(payloads)(
    '%s after an output delta: malformed, not retryable, mayHaveBilled, with the estimate',
    async (_label, json) => {
      const { adapter } = wiredAdapter(() => frame(after, json))
      const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
      expect(err.kind).toBe('server')
      expect(err.message).toContain('stream body is malformed')
      expect(err.retryable).toBe(false)
      expect(err.mayHaveBilled).toBe(true)
      expect(err.usage?.details['usage_estimated']).toBe(1)
    },
  )
})

describe('the fill copies own provider keys verbatim', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'a completed reasoning item with an own %s field round-trips it into the next request body',
    async (key) => {
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
      const doneJson = `{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"gAAAA-x",${JSON.stringify(
        key,
      )}:{"provider":"value"}}`
      const terminalJson = '{"type":"reasoning","id":"rs_1","summary":[]}'
      const call = functionCallItem('fc_1', 'call_1', 'weather', '{"city":"Oslo"}')
      const events = streamEvents(responseObject([call]))
      // Hand-written frames so JSON.parse creates `key` as an own data property.
      const head = sseBody(events.slice(0, 2))
      const callFrames = sseBody(events.slice(2, -1))
      const doneFrame = `data: {"type":"response.output_item.done","sequence_number":50,"output_index":1,"item":${doneJson}}\n\n`
      const terminalResponse = JSON.stringify({
        ...responseObject([call]),
        output: [],
      }).replace('"output":[]', `"output":[${terminalJson},${JSON.stringify(call)}]`)
      const terminal = `data: {"type":"response.completed","sequence_number":51,"response":${terminalResponse}}\n\n`
      const second = sseResponse(
        streamEvents(responseObject([messageItem('msg_2', 'done')])),
      )
      const { adapter, calls } = wiredAdapter(
        () => respond(head + callFrames + doneFrame + terminal, 'text/event-stream'),
        () => second,
      )
      const first = await adapter.run(request('gpt-6.2-sol', { tools }), CTX)
      expect(first.warnings.some((w) => w.message.includes(key))).toBe(true)
      await adapter.run(
        request('gpt-6.2-sol', {
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
                  result: 1,
                },
              ],
            },
          ],
        }),
        CTX,
      )
      const raw = calls[1]!.rawBody!
      // The completed item's own key and value reach the wire verbatim.
      expect(raw).toContain(`${JSON.stringify(key)}:{"provider":"value"}`)
      expect(raw).toContain('"encrypted_content":"gAAAA-x"')
    },
  )
})
