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
const respond = (
  body: string,
  contentType: string | null,
  extra: Record<string, string> = {},
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (body !== '') controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    {
      status: 200,
      headers: {
        ...(contentType === null ? {} : { 'content-type': contentType }),
        ...extra,
      },
    },
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
    // Grammar decisions: an empty parameter is allowed (`parameters = *( OWS ";"
    // OWS [ parameter ] )`), so a trailing or doubled `;` is accepted.
    'text/event-stream; charset=utf-8;',
    'text/event-stream;;',
    'text/event-stream; charset="utf-8"',
    // A comma inside a quoted parameter value is data, not a second media type.
    'text/event-stream; boundary="a,b"',
    'text/event-stream; x="quoted \\" pair"',
    'text/event-stream; x="escaped\\\ttab and \\ space"',
    'text/event-stream;\tcharset=utf-8',
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
    // A comma outside a quoted string: more than one media type.
    'text/event-stream; charset=utf-8, application/json',
    'text/event-stream, text/event-stream',
    'text/event-stream,',
    // Parameters the grammar does not admit.
    'text/event-stream; =x',
    'text/event-stream; charset',
    'text/event-stream; charset=',
    'text/event-stream; charset = utf-8',
    'text/event-stream; a="unterminated',
    // quoted-pair admits HTAB, SP, VCHAR and obs-text only: an escaped DEL or
    // control byte, or a backslash with nothing after it, is not in the grammar.
    'text/event-stream; a="x\\\x7f"',
    'text/event-stream; a="x\\\x01"',
    'text/event-stream; a="x\\',
    'text/event-stream; a="x"y',
    'text/event-stream x',
    'text/event-stream/',
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

describe('two content-type fields', () => {
  it('a real Headers object with two appended content-type fields is rejected', async () => {
    const headers = new Headers()
    headers.append('content-type', 'text/event-stream; charset=utf-8')
    headers.append('content-type', 'application/json')
    expect(headers.get('content-type')).toBe(
      'text/event-stream; charset=utf-8, application/json',
    )
    expect(isEventStreamMediaType(headers.get('content-type'))).toBe(false)
    const { adapter } = wiredAdapter(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(JSON.stringify(responseObject([]))))
              c.close()
            },
          }),
          { status: 200, headers },
        ),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
  })
})

describe('every frame is classified in one place: shape, framing, error, terminal', () => {
  const before = streamEvents(responseObject([]), { cutAfter: 2 })
  const after = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
    cutAfter: 5,
  })
  const named = (name: string, json: string) => `event: ${name}\ndata: ${json}\n\n`
  const dataOnly = (json: string) => `data: ${json}\n\n`
  const run = async (
    prefix: ReturnType<typeof streamEvents>,
    frame: string,
    headers: Record<string, string> = {},
  ) => {
    const { adapter } = wiredAdapter(() =>
      respond(`${sseBody(prefix)}${frame}`, 'text/event-stream', headers),
    )
    return (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
  }
  const malformedCases: Array<[string, string]> = [
    ['a named error frame with null', named('error', 'null')],
    ['a named error frame with 42', named('error', '42')],
    ['a named error frame with {}', named('error', '{}')],
    [
      'a data-only frame with an error field and no type',
      dataOnly('{"error":{"code":"rate_limit_exceeded","message":"m"}}'),
    ],
    [
      'an error frame whose payload type is something else',
      named('error', '{"type":"response.output_text.delta","delta":"x"}'),
    ],
    [
      'a non-error frame whose payload type is error',
      named('response.created', '{"type":"error","code":"rate_limit_exceeded"}'),
    ],
  ]

  it.each(malformedCases)(
    '%s, before output: malformed, retryable, not billed',
    async (_l, frame) => {
      const err = await run(before, frame)
      expect(err.kind).toBe('server')
      expect(err.message).toContain('stream body is malformed')
      expect(err.retryable).toBe(true)
      expect(err.mayHaveBilled).toBeUndefined()
    },
  )

  it.each(malformedCases)(
    '%s, after output: malformed, not retryable, mayHaveBilled',
    async (_l, frame) => {
      const err = await run(after, frame)
      expect(err.kind).toBe('server')
      expect(err.message).toContain('stream body is malformed')
      expect(err.retryable).toBe(false)
      expect(err.mayHaveBilled).toBe(true)
    },
  )

  const validError =
    '{"type":"error","sequence_number":9,"code":"rate_limit_exceeded","message":"slow down","param":null}'
  it.each([
    ['named', named('error', validError)],
    ['data-only', dataOnly(validError)],
  ])(
    'a valid %s error event is rate_limited, never retried, mayHaveBilled, before and after output',
    async (_l, frame) => {
      for (const prefix of [before, after]) {
        const err = await run(prefix, frame)
        expect(err.kind).toBe('rate_limited')
        expect(err.retryable).toBe(false)
        expect(err.mayHaveBilled).toBe(true)
        expect(err.message).toContain('slow down')
      }
    },
  )

  it('a valid named server_error event is retryable only before output', async () => {
    const body = '{"type":"error","code":"server_error","message":"m"}'
    expect((await run(before, named('error', body))).retryable).toBe(true)
    expect((await run(after, named('error', body))).retryable).toBe(false)
  })

  it('a valid error event keeps the response x-request-id', async () => {
    const err = await run(before, named('error', validError), {
      'x-request-id': 'req_named',
    })
    const sdkError = (err.cause as { cause?: { requestID?: string } }).cause
    expect(sdkError?.requestID).toBe('req_named')
  })

  it('[DONE] before a terminal event ends the stream early (retryable before output)', async () => {
    const err = await run(
      before,
      'data: [DONE]\n\n' +
        sseBody(streamEvents(responseObject([messageItem('msg_1', 'late')])).slice(2)),
    )
    expect(err.kind).toBe('server')
    expect(err.message).toContain('ended without a terminal event')
    expect(err.retryable).toBe(true)
  })

  it('[DONE] after output and before a terminal event is not retryable', async () => {
    const err = await run(after, 'data: [DONE]\n\n')
    expect(err.message).toContain('ended without a terminal event')
    expect(err.retryable).toBe(false)
  })

  it('[DONE] after the terminal event changes nothing', async () => {
    const { adapter } = wiredAdapter(() =>
      respond(`${okBody()}data: [DONE]\n\n`, 'text/event-stream'),
    )
    expect((await adapter.run(request(), CTX)).text).toBe('ok')
  })
})

describe('remaining branches of the input model', () => {
  /**
   * A body that delivers `prefix`, then fails as undici does when the socket drops
   * mid-body (`TypeError: terminated` caused by `UND_ERR_SOCKET`). Pull-based, so the
   * prefix is read before the failure (an errored stream discards queued chunks).
   */
  const failingBody = (prefix: string) => {
    let pulls = 0
    return new ReadableStream<Uint8Array>({
      pull(c) {
        pulls += 1
        if (pulls === 1 && prefix !== '') {
          c.enqueue(new TextEncoder().encode(prefix))
          return
        }
        c.error(
          Object.assign(new TypeError('terminated'), {
            cause: Object.assign(new Error('other side closed'), {
              code: 'UND_ERR_SOCKET',
            }),
          }),
        )
      },
    })
  }

  it('a non-2xx whose body cannot be read is the status error, its message the read failure', async () => {
    const { adapter } = wiredAdapter(
      () =>
        new Response(failingBody(''), { status: 503, headers: { 'retry-after': '3' } }),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.httpStatus).toBe(503)
    expect(err.retryable).toBe(true)
    expect(err.retryAfterMs).toBe(3000)
  })

  it('a body that fails before any output is a retryable transport failure', async () => {
    const created = sseBody(streamEvents(responseObject([]), { cutAfter: 1 }))
    const { adapter } = wiredAdapter(
      () =>
        new Response(failingBody(created), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(true)
    expect(err.usage).toBeUndefined()
  })

  it('a body that fails after output is a cut: not retryable, mayHaveBilled, estimate', async () => {
    const after = sseBody(
      streamEvents(responseObject([messageItem('msg_1', 'abc')]), { cutAfter: 5 }),
    )
    const { adapter } = wiredAdapter(
      () =>
        new Response(failingBody(after), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
    expect(err.usage?.details['usage_estimated']).toBe(1)
  })

  it('a terminal event without a response object is an early end', async () => {
    const body = `${sseBody(streamEvents(responseObject([]), { cutAfter: 2 }))}data: {"type":"response.completed","sequence_number":3}\n\n`
    const { adapter } = wiredAdapter(() => respond(body, 'text/event-stream'))
    const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('server')
    expect(err.message).toContain('ended without a terminal event')
  })

  it('a terminal response with no output array uses the completed items, with a warning', async () => {
    const events = streamEvents(responseObject([messageItem('msg_1', 'kept')]))
    const terminal = events[events.length - 1] as unknown as {
      response: Record<string, unknown>
    }
    const { output: _drop, ...withoutOutput } = terminal.response
    terminal.response = withoutOutput
    const { adapter } = wiredAdapter(() => respond(sseBody(events), 'text/event-stream'))
    const result = await adapter.run(request(), CTX)
    expect(result.text).toBe('kept')
    expect(
      result.warnings.some((w) => w.message.includes('carried no output array')),
    ).toBe(true)
  })
})
