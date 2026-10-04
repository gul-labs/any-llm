/**
 * How a streamed xAI call that fails after output began is classified and
 * costed: a terminal `response.failed`, an abort or deadline mid-stream, the
 * replayed-state share of the estimate, hostile stream indices, a non-stream 200.
 *
 * Through the REAL `openai` SDK with a stubbed `fetch` and the real engine.
 * SYNTHETIC (ADR-013): event sequences are the OpenAI Responses streaming
 * grammar (`synthesizeStreamEvents`); no failed or error event has been
 * captured from xAI, and the `response.failed` shape (`error.code`) is the
 * documented OpenAI one.
 */
import { describe, expect, it } from 'vitest'
import { LlmError, createClient, retryMiddleware } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { RecordingSink, RecordingTelemetry } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { buildXaiClient } from './client.js'
import { grok47ModelDescriptor, xaiRegistry } from './models.js'
import { xaiPricingSource } from './pricing.js'
import { readSseFrames } from './sse.js'
import { XaiStreamError, XaiStreamReducer } from './stream.js'
import { sseBody, sseResponse, synthesizeStreamEvents } from './test-sse.js'
import type { SseEvent } from './test-sse.js'

type Plain = Record<string, unknown>
type Stub = (input: unknown, init: Record<string, unknown>) => Promise<Response>

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

const MESSAGES = [
  { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
]

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(LlmError)
  return err as LlmError
}

function req47(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.7',
    messages: MESSAGES,
    config: {},
    modelDescriptor: grok47ModelDescriptor,
    ...overrides,
  }
}

/** An engine over the real SDK and `stub`, with the documented retry middleware. */
function engine(stub: Stub) {
  const calls = { n: 0 }
  const telemetry = new RecordingTelemetry()
  const client = createClient({
    adapters: [
      xaiAdapter({
        transport: {
          fetch: ((url: unknown, init: Record<string, unknown>) => {
            calls.n++
            return stub(url, init)
          }) as unknown as typeof fetch,
        },
      }),
    ],
    modelRegistry: xaiRegistry,
    pricingSources: { xai: xaiPricingSource() },
    sink: new RecordingSink(),
    telemetry,
    middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })],
  })
  const generate = (config: Plain = {}, signal?: AbortSignal) =>
    failure(
      client.generate(
        { provider: 'xai', model: 'grok-4.5', messages: MESSAGES, config },
        { auth: { apiKey: 'test-key' }, ...(signal !== undefined ? { signal } : {}) },
      ),
    )
  return { calls, telemetry, generate }
}

// ---------------------------------------------------------------------------
// P2-1: a terminal response.failed obeys the policy of an error event
// ---------------------------------------------------------------------------

const snapshot = { id: 'resp_1', model: 'grok-4.5', status: 'in_progress', output: [] }

/** created, in_progress, an output item opened, then a terminal `response.failed`. */
function failedStream(opts: {
  code: string | undefined
  usage?: Plain
  withOutput?: boolean
}): SseEvent[] {
  const events: SseEvent[] = [
    { type: 'response.created', response: snapshot },
    { type: 'response.in_progress', response: snapshot },
  ]
  if (opts.withOutput !== false) {
    events.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', summary: [], status: 'in_progress' },
    })
  }
  events.push({
    type: 'response.failed',
    response: {
      ...snapshot,
      status: 'failed',
      error: opts.code !== undefined ? { code: opts.code, message: 'it failed' } : null,
      usage: opts.usage ?? null,
    },
  })
  return events
}

const respond =
  (events: SseEvent[]): Stub =>
  () =>
    Promise.resolve(sseResponse(events))

describe('a terminal response.failed after output began (P2-1)', () => {
  it.each([
    { code: 'server_error', kind: 'server' },
    { code: 'rate_limit_exceeded', kind: 'rate_limited' },
    { code: 'invalid_prompt', kind: 'bad_request' },
  ])(
    '$code with no usage is not retried and is booked unpriced, not known-free',
    async ({ code, kind }) => {
      const { calls, telemetry, generate } = engine(respond(failedStream({ code })))
      const err = await generate()
      expect(calls.n).toBe(1)
      expect(err).toMatchObject({ kind, retryable: false, provider: 'xai' })
      expect(err.mayHaveBilled).toBe(true)
      expect(telemetry.errors[0]?.callCost).toEqual({
        microUsd: 0,
        attempts: 1,
        unpricedAttempts: 1,
      })
    },
  )

  it('a server_error that carries usage is booked once, from that usage', async () => {
    const { calls, telemetry, generate } = engine(
      respond(
        failedStream({
          code: 'server_error',
          usage: { input_tokens: 1000, output_tokens: 50_000 },
        }),
      ),
    )
    const err = await generate()
    expect(calls.n).toBe(1)
    expect(err.retryable).toBe(false)
    expect(telemetry.errors[0]?.callCost).toMatchObject({
      attempts: 1,
      unpricedAttempts: 0,
    })
    expect(telemetry.errors[0]?.callCost?.microUsd).toBeGreaterThan(0)
  })

  it('a failure before any output event keeps its retryable code', async () => {
    const { calls, generate } = engine(
      respond(failedStream({ code: 'server_error', withOutput: false })),
    )
    const err = await generate()
    expect(calls.n).toBe(3)
    expect(err).toMatchObject({ kind: 'server', retryable: true })
  })

  it('a failed response is never known-free even before output (the run had started)', async () => {
    const { telemetry, generate } = engine(
      respond(failedStream({ code: 'invalid_prompt', withOutput: false })),
    )
    await generate()
    expect(telemetry.errors[0]?.callCost?.unpricedAttempts).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// P2-2 / P2-3: abort and deadline keep the estimate; the estimate counts replayed state
// ---------------------------------------------------------------------------

const BIG_TEXT = 'a'.repeat(40_000)

/** Events of an answer whose text arrived in full, with no terminal event. */
const bigPartial = (): SseEvent[] =>
  synthesizeStreamEvents(
    {
      id: 'resp_1',
      model: 'grok-4.5',
      status: 'completed',
      usage: null,
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: BIG_TEXT }],
        },
      ],
    },
    { omitTerminal: true },
  )

/** Sends `events`, then stays quiet and open; does NOT react to the abort itself. */
function stuckBody(events: SseEvent[]): Stub {
  return () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseBody(events)))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
}

describe('an engine deadline or caller abort mid-stream keeps the estimate (P2-2)', () => {
  it("the engine's deadline after 40,000 characters books an estimated, priced attempt", async () => {
    const { calls, telemetry, generate } = engine(stuckBody(bigPartial()))
    const err = await generate({ timeoutMs: 150 })
    expect(calls.n).toBe(1)
    expect(err.kind).toBe('timeout')
    const attempt = telemetry.attempts[0]
    expect(attempt?.usage.outputTokens).toBe(10_000)
    expect(attempt?.usage.details['usage_estimated']).toBe(1)
    expect(attempt?.cost?.confidence).toBe('estimated')
    expect(telemetry.errors[0]?.callCost).toMatchObject({
      attempts: 1,
      unpricedAttempts: 0,
    })
    expect(telemetry.errors[0]?.callCost?.microUsd).toBeGreaterThan(0)
  })

  it('a caller abort after output is an aborted error carrying the estimate', async () => {
    const controller = new AbortController()
    const pending = failure(
      xaiAdapter({
        transport: { fetch: stuckBody(bigPartial()) as unknown as typeof fetch },
      }).run(req47(), { ...CTX, signal: controller.signal }),
    )
    setTimeout(() => controller.abort(), 80)
    const err = await pending
    expect(err).toMatchObject({ kind: 'aborted', retryable: false, provider: 'xai' })
    expect(err.usage?.outputTokens).toBe(10_000)
    expect(err.usage?.details['usage_estimated']).toBe(1)
  })

  it('through the engine a caller abort books the attempt estimated and priced', async () => {
    const controller = new AbortController()
    const { telemetry, generate } = engine(stuckBody(bigPartial()))
    const pending = generate({}, controller.signal)
    setTimeout(() => controller.abort(), 80)
    const err = await pending
    expect(err.kind).toBe('aborted')
    expect(telemetry.attempts[0]?.cost?.confidence).toBe('estimated')
    expect(telemetry.errors[0]?.callCost).toMatchObject({
      attempts: 1,
      unpricedAttempts: 0,
    })
  })

  it('an abort before any output stays unpriced: no usage', async () => {
    const controller = new AbortController()
    const opened = bigPartial().filter(
      (e) => e.type === 'response.created' || e.type === 'response.in_progress',
    )
    const pending = failure(
      xaiAdapter({
        transport: { fetch: stuckBody(opened) as unknown as typeof fetch },
      }).run(req47(), { ...CTX, signal: controller.signal }),
    )
    setTimeout(() => controller.abort(), 60)
    const err = await pending
    expect(err.kind).toBe('aborted')
    expect(err.usage).toBeUndefined()
  })
})

describe('the failure estimate counts the replayed state history (P2-3)', () => {
  const state = {
    xai: {
      model: 'grok-4.7',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(20_000) }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [],
          encrypted_content: 'e'.repeat(4_000),
        },
      ],
    },
  }

  it('a cut stream after a 20k-character state replay is priced from the whole wire input', async () => {
    const err = await failure(
      xaiAdapter({
        transport: {
          fetch: ((_u: unknown, _i: unknown) =>
            Promise.resolve(
              sseResponse(
                synthesizeStreamEvents(
                  {
                    id: 'r',
                    model: 'grok-4.7',
                    status: 'completed',
                    usage: null,
                    output: [
                      {
                        id: 'm',
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'abcdefgh' }],
                      },
                    ],
                  },
                  { omitTerminal: true },
                ),
              ),
            )) as unknown as typeof fetch,
        },
      }).run(
        req47({
          transientProviderState: state as never,
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'and now?' }] }],
        }),
        CTX,
      ),
    )
    expect(err.usage?.details['usage_estimated']).toBe(1)
    expect(err.usage?.inputTokens).toBeGreaterThanOrEqual(6_000)
  })

  it('an inline image data URL is not counted as text', async () => {
    const image = {
      kind: 'inline-media' as const,
      mimeType: 'image/png',
      data: 'QUFB'.repeat(100_000),
    }
    const err = await failure(
      xaiAdapter({
        transport: {
          fetch: (() =>
            Promise.resolve(
              sseResponse(
                synthesizeStreamEvents(
                  {
                    id: 'r',
                    model: 'grok-4.5',
                    status: 'completed',
                    usage: null,
                    output: [
                      {
                        id: 'm',
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'abcdefgh' }],
                      },
                    ],
                  },
                  { omitTerminal: true },
                ),
              ),
            )) as unknown as typeof fetch,
        },
      }).run(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [image] }],
          config: {},
        },
        CTX,
      ),
    )
    expect(err.usage?.inputTokens).toBeLessThan(1_000)
  })
})

// ---------------------------------------------------------------------------
// P3-1 / P3-2 / P3-3 / P3-7
// ---------------------------------------------------------------------------

describe('a typed error event with a nested error object (P3-1)', () => {
  it('keeps its code and message, like the same body without a type', () => {
    const typed = new XaiStreamReducer()
    const typeless = new XaiStreamReducer()
    const nested = { error: { code: 'server_error', message: 'boom' } }
    const read = (reducer: XaiStreamReducer, body: Plain) => {
      try {
        reducer.pushFrame({ event: undefined, data: JSON.stringify(body) })
      } catch (e) {
        return e as Error & { failure: unknown }
      }
      throw new Error('expected a stream error')
    }
    const a = read(typed, { type: 'error', ...nested })
    const b = read(typeless, nested)
    expect(a.failure).toEqual({
      kind: 'error_event',
      code: 'server_error',
      message: 'boom',
    })
    expect(a.failure).toEqual(b.failure)
  })
})

describe('the SSE reader is linear in the bytes read (P3-2)', () => {
  it('one 20 MiB event in 16 KiB chunks takes well under 500 ms', async () => {
    const CHUNK = 16 * 1024
    const chunks = 20 * 64
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i === 0) {
          const first = new Uint8Array(CHUNK).fill(97)
          first.set(new TextEncoder().encode('data: '))
          controller.enqueue(first)
        } else if (i < chunks) {
          controller.enqueue(new Uint8Array(CHUNK).fill(97))
        } else if (i === chunks) {
          controller.enqueue(new TextEncoder().encode('\n\n'))
        } else {
          controller.close()
        }
        i++
      },
    })
    const started = performance.now()
    const frames: number[] = []
    for await (const frame of readSseFrames(body)) frames.push(frame.data.length)
    const elapsed = performance.now() - started
    expect(frames).toEqual([CHUNK * chunks - 6])
    expect(elapsed).toBeLessThan(500)
  })

  it('still splits correctly when a CRLF straddles a chunk boundary', async () => {
    const enc = new TextEncoder()
    const parts = ['data: a\r', '\ndata: b\r\n\r', '\nevent: x\ndata: c\n\n']
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts[i++]
        if (part === undefined) controller.close()
        else controller.enqueue(enc.encode(part))
      },
    })
    const frames: Array<{ event: string | undefined; data: string }> = []
    for await (const frame of readSseFrames(body)) frames.push(frame)
    expect(frames).toEqual([
      { event: undefined, data: 'a\nb' },
      { event: 'x', data: 'c' },
    ])
  })
})

describe('an absurd stream index is a typed server error, not a stall (P3-3)', () => {
  const opened = (): SseEvent[] => [
    { type: 'response.created', response: snapshot },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
    },
  ]
  it.each([
    ['content_index', 'response.output_text.delta'],
    ['summary_index', 'response.reasoning_summary_text.delta'],
    ['annotation_index', 'response.output_text.annotation.added'],
    ['output_index', 'response.output_item.added'],
  ])('%s of 4,000,000,000 on %s', async (field, type) => {
    const hostile: SseEvent = {
      type,
      output_index: 0,
      item: { id: 'x', type: 'message', content: [] },
      annotation: { type: 'url_citation', url: 'https://example.com' },
      delta: 'x',
      [field]: 4_000_000_000,
    }
    const started = performance.now()
    const err = await failure(
      xaiAdapter({
        transport: {
          fetch: (() =>
            Promise.resolve(
              sseResponse([...opened(), hostile, { type: 'response.output_text.done' }]),
            )) as unknown as typeof fetch,
        },
      }).run(req47(), CTX),
    )
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'xai' })
    expect(err.message).toContain(field)
  })

  it('a fractional or negative index on a delta is skipped and noted', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'm', type: 'message', content: [] },
    })
    reducer.push({
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: -1,
      delta: 'x',
    })
    reducer.push({
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0.5,
      delta: 'x',
    })
    reducer.push({
      type: 'response.completed',
      response: { id: 'r', status: 'completed', output: [], usage: null },
    })
    const { notes } = reducer.result()
    expect(notes.join('\n')).toContain('content_index is not a non-negative integer')
  })
})

describe('a 200 that is not an event stream (P3-7)', () => {
  it('quotes a bounded, secret-redacted snippet of the body in the cause', async () => {
    const html = `<html>Bad gateway Authorization: Bearer sk-live-abcdef0123456789 ${'x'.repeat(5_000)}</html>`
    const client = await buildXaiClient(
      { apiKey: 'k' },
      {
        fetch: (() =>
          Promise.resolve(
            new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
          )) as unknown as typeof fetch,
      },
    )
    const err = (await client.responses
      .create({ model: 'm', input: [], store: false })
      .catch((e: unknown) => e)) as Error & { cause?: { bodySnippet?: string } }
    const snippet = err.cause?.bodySnippet
    expect(snippet).toBeDefined()
    expect((snippet as string).length).toBeLessThanOrEqual(500)
    expect(snippet).toContain('Bad gateway')
    expect(snippet).not.toContain('sk-live-abcdef0123456789')
  })

  it('reaches the typed error through the adapter', async () => {
    const err = await failure(
      xaiAdapter({
        transport: {
          fetch: (() =>
            Promise.resolve(
              new Response('<html>nope</html>', {
                status: 200,
                headers: { 'content-type': 'text/html' },
              }),
            )) as unknown as typeof fetch,
        },
      }).run(req47(), CTX),
    )
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
    const chain = [err.cause, (err.cause as Error | undefined)?.cause]
    expect(JSON.stringify(chain)).toContain('nope')
  })
})

describe('the client deadline message quotes the configured timeout (P3-7)', () => {
  it('says "client deadline" with the caller timeoutMs, not the buffered value', async () => {
    // The client's own timer is armed at timeoutMs + 5 s; the message names timeoutMs.
    const client = {
      responses: {
        create: () =>
          Promise.reject(new XaiStreamError({ kind: 'deadline', timeoutMs: 5_001 })),
      },
    }
    const err = await failure(
      xaiAdapter({ client }).run(req47({ config: { timeoutMs: 1 } }), CTX),
    )
    expect(err).toMatchObject({ kind: 'timeout', retryable: false })
    expect(err.message).toContain('client deadline')
    expect(err.message).toContain('after the 1 ms request timeout')
    expect(err.message).not.toContain('SDK')
  })

  it('names the one-hour default when no timeoutMs was configured', async () => {
    const client = {
      responses: {
        create: () =>
          Promise.reject(new XaiStreamError({ kind: 'deadline', timeoutMs: 3_600_000 })),
      },
    }
    const err = await failure(xaiAdapter({ client }).run(req47(), CTX))
    expect(err.message).toContain('3600000 ms request timeout')
  })
})
