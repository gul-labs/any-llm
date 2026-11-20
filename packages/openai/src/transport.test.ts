/**
 * Edges of the isolated transport that the SDK's request path used to cover:
 * redirects, both framings of an `error` event, inherited-key event types, the
 * `null` fill rule, and 200 responses that are not a usable stream. Real
 * `openai/error` and `openai/streaming` classes over a stubbed `fetch`; frames
 * are documentation-derived (`test-sse.ts`), not captures.
 *
 * @module
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'

import { buildOpenAiClient } from './client.js'
import {
  messageItem,
  reasoningItem,
  responseObject,
  sseBody,
  sseResponse,
  streamEvents,
  stubFetch,
} from './test-sse.js'
import type { SseEvent } from './test-sse.js'
import { CTX, request, wiredAdapter } from './test-helpers.js'

beforeAll(async () => {
  await Promise.all([import('openai/streaming'), import('openai/error')])
}, 60_000)

const run = async (responder: () => Response | Promise<Response>) => {
  const { adapter, calls } = wiredAdapter(responder)
  const err = (await adapter.run(request(), CTX).catch((e: unknown) => e)) as LlmError
  return { err, calls }
}

const raw = (body: string, contentType = 'text/event-stream') =>
  new Response(body, { status: 200, headers: { 'content-type': contentType } })

describe('redirects are never followed', () => {
  it.each([307, 308, 301, 302] as const)(
    'a %i is one fetch, asked with redirect: manual, and a non-retryable error naming it',
    async (status) => {
      const { err, calls } = await run(() =>
        Response.redirect('https://elsewhere.invalid/v1/responses', status),
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]!.redirect).toBe('manual')
      expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses')
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('server')
      expect(err.retryable).toBe(false)
      expect(err.httpStatus).toBe(status)
      expect(err.message).toContain(
        `redirect (HTTP ${status} to https://elsewhere.invalid/v1/responses)`,
      )
    },
  )
})

describe('an error event is an error in both framings', () => {
  const before = streamEvents(responseObject([]), { cutAfter: 2 })
  const after = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
    cutAfter: 5,
  })
  const payload = (code: string) => ({
    type: 'error',
    sequence_number: 99,
    code,
    message: 'doc-derived',
    param: null,
  })
  const named = (events: SseEvent[], code: string) =>
    raw(sseBody([...events, payload(code)]))
  const dataOnly = (events: SseEvent[], code: string) =>
    raw(`${sseBody(events)}data: ${JSON.stringify(payload(code))}\n\n`)

  it.each([
    ['named', named],
    ['data-only', dataOnly],
  ] as const)(
    '%s server_error before output: retryable server, mayHaveBilled',
    async (_l, frame) => {
      const { err } = await run(() => frame(before, 'server_error'))
      expect(err.kind).toBe('server')
      expect(err.retryable).toBe(true)
      expect(err.mayHaveBilled).toBe(true)
      expect(err.message).toContain('code "server_error"')
    },
  )

  it.each([
    ['named', named],
    ['data-only', dataOnly],
  ] as const)(
    '%s rate_limit_exceeded before output: rate_limited, never retried, mayHaveBilled',
    async (_l, frame) => {
      const { err } = await run(() => frame(before, 'rate_limit_exceeded'))
      expect(err.kind).toBe('rate_limited')
      expect(err.retryable).toBe(false)
      expect(err.mayHaveBilled).toBe(true)
    },
  )

  it.each([
    ['named', named],
    ['data-only', dataOnly],
  ] as const)(
    '%s server_error after output: not retryable, mayHaveBilled, with the estimate',
    async (_l, frame) => {
      const { err } = await run(() => frame(after, 'server_error'))
      expect(err.kind).toBe('server')
      expect(err.retryable).toBe(false)
      expect(err.mayHaveBilled).toBe(true)
      expect(err.usage?.details['usage_estimated']).toBe(1)
    },
  )

  it('a data-only error with a nested error object keeps its code and message', async () => {
    const body = `${sseBody(before)}data: ${JSON.stringify({ type: 'error', error: { code: 'server_error', message: 'nested' } })}\n\n`
    const { err } = await run(() => raw(body))
    expect(err.message).toContain('code "server_error"')
    expect(err.message).toContain('nested')
  })
})

describe('event types are matched as own keys only', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'a stream whose only other event is type %j with a response ends as ended_early',
    async (type) => {
      const created = streamEvents(responseObject([]), { cutAfter: 1 })
      const body = `${sseBody(created)}data: ${JSON.stringify({ type, sequence_number: 1, response: responseObject([messageItem('msg_1', 'x')]) })}\n\n`
      const { err } = await run(() => raw(body))
      expect(err).toBeInstanceOf(LlmError)
      expect(err.kind).toBe('server')
      expect(err.message).toContain('ended without a terminal event')
    },
  )
})

describe('the fill rule treats a terminal null as an omission', () => {
  const reconcile = async (
    completedValue: unknown,
    terminalItem: Record<string, unknown>,
  ) => {
    const done = { ...reasoningItem('rs_1', 'unused'), encrypted_content: completedValue }
    const events = streamEvents(responseObject([done]))
    const terminal = events[events.length - 1] as unknown as {
      response: { output: unknown[] }
    }
    terminal.response = { ...terminal.response, output: [terminalItem] }
    const client = await buildOpenAiClient(
      { apiKey: 'sk-doc' },
      stubFetch(() => sseResponse(events)).fetch,
    )
    const response = await client.responses.create({
      model: 'gpt-6.2-sol',
      input: [],
      store: false,
    })
    return response.output[0] as Record<string, unknown>
  }
  const base = { type: 'reasoning', id: 'rs_1', summary: [] }

  it('terminal lacks the key: the completed ciphertext is used', async () => {
    expect((await reconcile('gAAAA-done', base))['encrypted_content']).toBe('gAAAA-done')
  })

  it('terminal carries null: the completed ciphertext is used', async () => {
    expect(
      (await reconcile('gAAAA-done', { ...base, encrypted_content: null }))[
        'encrypted_content'
      ],
    ).toBe('gAAAA-done')
  })

  it('terminal carries a value: the terminal value wins', async () => {
    expect(
      (await reconcile('gAAAA-done', { ...base, encrypted_content: 'gAAAA-terminal' }))[
        'encrypted_content'
      ],
    ).toBe('gAAAA-terminal')
  })

  it('both null: it stays null', async () => {
    const item = await reconcile(null, { ...base, encrypted_content: null })
    expect(Object.hasOwn(item, 'encrypted_content')).toBe(true)
    expect(item['encrypted_content']).toBeNull()
  })
})

describe('a 200 that is not a usable stream', () => {
  it('a JSON content-type is a non-retryable server error that may have billed', async () => {
    const { err } = await run(() =>
      raw(JSON.stringify(responseObject([])), 'application/json'),
    )
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
    expect(err.message).toContain('content-type "application/json"')
  })

  it('a content-type with parameters is accepted', async () => {
    const { adapter } = wiredAdapter(
      () =>
        new Response(
          sseBody(streamEvents(responseObject([messageItem('msg_1', 'ok')]))),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          },
        ),
    )
    expect((await adapter.run(request(), CTX)).text).toBe('ok')
  })

  it('a missing body is a retryable early end', async () => {
    const { err } = await run(
      () =>
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('ended without a terminal event')
  })

  it('an empty body is a retryable early end', async () => {
    const { err } = await run(() => raw(''))
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(true)
  })

  it('a truncated frame before output is a retryable malformed body', async () => {
    const created = streamEvents(responseObject([]), { cutAfter: 1 })
    const { err } = await run(() =>
      raw(`${sseBody(created)}data: {"type":"response.in_pro\n\n`),
    )
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(true)
    expect(err.message).toContain('not valid event JSON')
  })

  it('a truncated frame after output is not retryable and may have billed', async () => {
    const after = streamEvents(responseObject([messageItem('msg_1', 'abc')]), {
      cutAfter: 5,
    })
    const { err } = await run(() =>
      raw(`${sseBody(after)}data: {"type":"response.output_te\n\n`),
    )
    expect(err.kind).toBe('server')
    expect(err.retryable).toBe(false)
    expect(err.mayHaveBilled).toBe(true)
  })

  it('invalid UTF-8 inside a text delta is decoded with replacement characters, not an error', async () => {
    const events = streamEvents(responseObject([messageItem('msg_1', 'ok')]))
    const encoder = new TextEncoder()
    const parts = sseBody(events).split('"delta":"ok"')
    const bytes = new Uint8Array([
      ...encoder.encode(parts[0]),
      ...encoder.encode('"delta":"o'),
      0xff,
      ...encoder.encode('k"'),
      ...encoder.encode(parts.slice(1).join('"delta":"ok"')),
    ])
    const { adapter } = wiredAdapter(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    const result = await adapter.run(request(), CTX)
    expect(result.text).toBe('ok')
  })
})

describe('abort between headers and the first byte', () => {
  it('is the abort, with no usage', async () => {
    const controller = new AbortController()
    const { adapter } = wiredAdapter((call) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          call.signal?.addEventListener('abort', () => {
            stream.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        },
      })
      setTimeout(() => controller.abort(), 20)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const err = (await adapter
      .run(request(), { ...CTX, signal: controller.signal })
      .catch((e: unknown) => e)) as LlmError
    expect(err.kind).toBe('aborted')
    expect(err.usage).toBeUndefined()
  })
})

describe('the request id reaches errors', () => {
  it('an error event carries the response x-request-id on its SDK cause', async () => {
    const before = streamEvents(responseObject([]), { cutAfter: 2 })
    const body = `${sseBody(before)}data: ${JSON.stringify({ type: 'error', code: 'server_error', message: 'm' })}\n\n`
    const { err } = await run(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_err' },
        }),
    )
    const sdkError = (err.cause as { cause?: { requestID?: string } }).cause
    expect(sdkError?.requestID).toBe('req_err')
  })
})
