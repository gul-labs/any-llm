/**
 * The xAI adapter streams internally (ADR-040), through the REAL `openai` SDK
 * with a stubbed `fetch`: nothing touches the network.
 *
 * SYNTHETIC (ADR-013): event sequences are the OpenAI Responses streaming
 * grammar applied to recorded non-streamed fixtures (`synthesizeStreamEvents`);
 * live capture P9a/P12 kept event types, usage and timings only
 * (`__fixtures__/36-streamed-responses.json`), and the usage objects pinned
 * there are the real streamed ones.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import type { AdapterCtx, AdapterResult, ResolvedRequest } from '@gullabs/core'
import { RecordingSink, RecordingTelemetry, makeFakeXai } from '@gullabs/testing'
import { classifyXaiError, xaiAdapter } from './adapter.js'
import { buildXaiClient } from './client.js'
import type { XaiResponseCreateParams, XaiTransport } from './client.js'
import { grok45ModelDescriptor, grok47ModelDescriptor, xaiRegistry } from './models.js'
import { computeXaiCost, xaiPricingSource } from './pricing.js'
import { xaiProvider } from './provider.js'
import {
  rawSseResponse,
  sseBody,
  sseResponse,
  synthesizeStreamEvents,
} from './test-sse.js'
import type { SseEvent } from './test-sse.js'

type Plain = Record<string, unknown>

const fixtureDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url))
const loadFixture = (name: string): Plain =>
  JSON.parse(readFileSync(fixtureDir + name, 'utf8')) as Plain

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

type Stub = (input: unknown, init: Record<string, unknown>) => Promise<Response>

function transportOf(stub: Stub): XaiTransport {
  return { fetch: stub as unknown as typeof fetch }
}

/** An adapter whose HTTP goes through the real SDK to `stub`. */
const streamingAdapter = (stub: Stub) => xaiAdapter({ transport: transportOf(stub) })

const respond =
  (events: SseEvent[]): Stub =>
  () =>
    Promise.resolve(sseResponse(events))

function req47(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.7',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: grok47ModelDescriptor,
    ...overrides,
  }
}

function req45(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
    config: {},
    modelDescriptor: grok45ModelDescriptor,
    ...overrides,
  }
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(LlmError)
  return err as LlmError
}

/** Every response-shaped object with numeric token usage in the fixtures. */
function collectResponses(): Array<{ name: string; response: Plain }> {
  const found: Array<{ name: string; response: Plain }> = []
  const walk = (value: unknown, name: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${name}[${i}]`))
    } else if (typeof value === 'object' && value !== null) {
      const o = value as Plain
      const usage = o['usage'] as Plain | undefined
      if (
        Array.isArray(o['output']) &&
        o['output'].length > 0 &&
        o['output'].every((x) => typeof x === 'object' && x !== null) &&
        typeof usage?.['input_tokens'] === 'number' &&
        typeof usage['output_tokens'] === 'number'
      ) {
        found.push({ name, response: o })
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${name}.${k}`)
    }
  }
  for (const file of readdirSync(fixtureDir).filter((f) => /^\d.*\.json$/.test(f))) {
    walk(loadFixture(file), file)
  }
  return found
}

/** A fixture response completed with the fields a real response always has. */
function completeResponse(response: Plain): Plain {
  return { id: 'resp_fixture', model: 'grok-4.7', status: 'completed', ...response }
}

const without = (r: AdapterResult): Omit<AdapterResult, 'warnings'> => {
  const { warnings: _warnings, ...rest } = r
  return rest
}

describe('the request on the wire', () => {
  it('sends stream: true with store: false and asks for an event stream', async () => {
    const seen: Array<{ url: string; init: Record<string, unknown> }> = []
    const stub: Stub = (url, init) => {
      seen.push({ url: String(url), init })
      return Promise.resolve(
        sseResponse(
          synthesizeStreamEvents(
            completeResponse({
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'hi' }],
                },
              ],
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
          ),
        ),
      )
    }
    const result = await streamingAdapter(stub).run(req45(), CTX)
    expect(result.text).toBe('hi')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.x.ai/v1/responses')
    const body = JSON.parse(String(seen[0]?.init['body'])) as Plain
    expect(body).toMatchObject({ model: 'grok-4.5', stream: true, store: false })
    const headers = new Headers(
      seen[0]?.init['headers'] as ConstructorParameters<typeof Headers>[0],
    )
    expect(headers.get('accept')).toBe('text/event-stream')
    expect(headers.get('authorization')).toBe('Bearer test-key')
  })

  it('reads a stream split into one-byte chunks and skips SSE comment heartbeats', async () => {
    const response = completeResponse({
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'héllo wörld ✓', annotations: [] }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    })
    const text = `: heartbeat\n\n${sseBody(synthesizeStreamEvents(response)).replace(/\n\n/g, '\n\n: heartbeat\n\n')}`
    const bytes = new TextEncoder().encode(text)
    const stub: Stub = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
              controller.close()
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    const result = await streamingAdapter(stub).run(req45(), CTX)
    expect(result.text).toBe('héllo wörld ✓')
    expect(result.warnings).toEqual([])
  })

  it('goes through createClient and xaiProvider({ transport }) like any other call', async () => {
    const stub = respond(
      synthesizeStreamEvents(
        completeResponse({
          model: 'grok-4.5',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'via client' }],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }),
      ),
    )
    const client = createClient({
      adapters: [xaiProvider({ transport: transportOf(stub) }).adapter],
      modelRegistry: xaiRegistry,
      pricingSources: { xai: xaiPricingSource() },
      sink: new RecordingSink(),
    })
    const result = await client.generate(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'test-key' } },
    )
    expect(result.text).toBe('via client')
    expect(result.usage.inputTokens).toBe(10)
  })
})

describe('a streamed call maps to exactly what the non-streamed call maps to (synthetic events over recorded fixtures)', () => {
  const responses = collectResponses().map(
    (r) => [r.name, completeResponse(r.response)] as const,
  )

  it('covers the recorded responses', () => {
    expect(responses.length).toBeGreaterThanOrEqual(30)
  })

  it.each(responses)('%s', async (_name, response) => {
    const direct = await xaiAdapter({ client: makeFakeXai(response as never) }).run(
      req47(),
      CTX,
    )
    const streamed = await streamingAdapter(
      respond(synthesizeStreamEvents(response)),
    ).run(req47(), CTX)
    expect(streamed).toEqual(direct)
  })

  it.each(responses)(
    '%s, when the final object lost its reasoning items, keeps the same result and continuation state',
    async (_name, response) => {
      const output = response['output'] as Plain[]
      const lost = output.filter((item) => item['type'] !== 'reasoning')
      const direct = await xaiAdapter({ client: makeFakeXai(response as never) }).run(
        req47(),
        CTX,
      )
      const streamed = await streamingAdapter(
        respond(
          synthesizeStreamEvents(response, {
            finalResponse: { ...response, output: lost },
          }),
        ),
      ).run(req47(), CTX)
      expect(without(streamed)).toEqual(without(direct))
      expect(streamed.warnings.length).toBe(
        direct.warnings.length + (lost.length === output.length ? 0 : 1),
      )
    },
  )
})

describe('the continuation state keeps the provider reasoning the final object omitted (P9a)', () => {
  const first = loadFixture('30-grok-4-7-search-replay.json')['first'] as Plain
  const response = completeResponse(first)

  it('holds the encrypted reasoning items of the events when the final object has none', async () => {
    const lost = (response['output'] as Plain[]).filter((i) => i['type'] !== 'reasoning')
    const result = await streamingAdapter(
      respond(
        synthesizeStreamEvents(response, {
          finalResponse: { ...response, output: lost },
        }),
      ),
    ).run(req47(), CTX)
    const state = result.transientProviderState as { xai: { input: Plain[] } }
    const reasoning = state.xai.input.filter((i) => i['type'] === 'reasoning')
    expect(reasoning).toHaveLength(3)
    expect(reasoning.every((i) => typeof i['encrypted_content'] === 'string')).toBe(true)
    expect(state.xai.input.map((i) => i['type'])).toEqual([
      undefined, // the user message
      ...(response['output'] as Plain[]).map((i) => i['type']),
    ])
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('rebuilt from the stream events'),
    ])
  })

  it('replays the rebuilt state on the next turn exactly as the non-streamed state replays', async () => {
    const lost = (response['output'] as Plain[]).filter((i) => i['type'] !== 'reasoning')
    const direct = await xaiAdapter({ client: makeFakeXai(response as never) }).run(
      req47(),
      CTX,
    )
    const streamed = await streamingAdapter(
      respond(
        synthesizeStreamEvents(response, {
          finalResponse: { ...response, output: lost },
        }),
      ),
    ).run(req47(), CTX)
    expect(streamed.transientProviderState).toEqual(direct.transientProviderState)

    const sent: Plain[] = []
    const next = streamingAdapter((_url, init) => {
      sent.push(JSON.parse(String(init['body'])) as Plain)
      return Promise.resolve(
        sseResponse(
          synthesizeStreamEvents(
            completeResponse({
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'ok' }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ),
        ),
      )
    })
    await next.run(
      req47({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'again' }] }],
        transientProviderState: streamed.transientProviderState as never,
      }),
      CTX,
    )
    const input = sent[0]?.['input'] as Plain[]
    expect(input.filter((i) => i['type'] === 'reasoning')).toHaveLength(3)
  })

  it('the real P9a shape (events and final both lack a reasoning item) is not a disagreement', async () => {
    const real = loadFixture('36-streamed-responses.json') as {
      p9a: { web_search: Array<{ streamed: { usage: Plain } }> }
    }
    const usage = real.p9a.web_search[0]?.streamed.usage as Plain
    const p9a = completeResponse({
      model: 'grok-4.5',
      usage,
      output: [
        {
          id: 'ws_1',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search' },
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'The latest stable Node.js version is 22.23.3 (LTS).[[1]](https://nodejs.org/en/blog)',
              annotations: [
                { type: 'url_citation', url: 'https://nodejs.org/en/blog', title: '1' },
              ],
            },
          ],
        },
      ],
    })
    const result = await streamingAdapter(respond(synthesizeStreamEvents(p9a))).run(
      req45({
        config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } },
      }),
      CTX,
    )
    expect(result.warnings).toEqual([])
    expect(result.text).toContain('22.23.3')
    expect(result.citations?.[0]?.url).toBe('https://nodejs.org/en/blog')
    expect(result.usage.details['web_search_calls']).toBe(1)
  })
})

describe('streamed usage reconciles to the billed ticks (real P9a streamed usage objects)', () => {
  const real = loadFixture('36-streamed-responses.json') as {
    p9a: Record<string, Array<{ streamed: { usage: Plain } }>>
  }
  const cases = Object.entries(real.p9a).flatMap(([name, pairs]) =>
    pairs.map((p, i) => [`${name} #${i + 1}`, name, p.streamed.usage] as const),
  )

  it.each(cases)('%s', async (_label, name, usage) => {
    const search = name === 'web_search'
    const result = await streamingAdapter(
      respond(
        synthesizeStreamEvents(
          completeResponse({
            model: 'grok-4.5',
            usage,
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'x' }],
              },
            ],
          }),
        ),
      ),
    ).run(
      req45(
        search
          ? { config: { providerOptions: { xai: { tools: [{ type: 'web_search' }] } } } }
          : {},
      ),
      CTX,
    )
    const cost = computeXaiCost('grok-4.5', result.usage, result.servedServiceTier)
    expect(cost.confidence).toBe('exact')
    expect(
      Math.abs(
        (cost.microUsd as number) - (usage['cost_in_usd_ticks'] as number) / 10_000,
      ),
    ).toBeLessThanOrEqual(2)
  })
})

describe('terminal events map as the non-streamed path does (R4)', () => {
  const failed = JSON.parse(
    readFileSync(fixtureDir + 'doc-derived-error-shapes.json', 'utf8'),
  ) as Record<string, Plain>

  it.each([
    ['failedResponse', 'server', true],
    ['failedRateLimit', 'rate_limited', true],
    ['failedInvalidPrompt', 'bad_request', false],
    ['failedPolicy', 'content_filter', false],
    ['failedUnknownCode', 'unknown', false],
    ['failedNoError', 'unknown', false],
    ['cancelledResponse', 'unknown', false],
  ] as const)(
    'response.failed (%s) is %s, retryable %s, with the billed usage',
    async (name, kind, retryable) => {
      const body = failed[name] as Plain
      const events = synthesizeStreamEvents(body, { terminal: 'response.failed' })
      const err = await failure(streamingAdapter(respond(events)).run(req45(), CTX))
      const direct = await failure(
        xaiAdapter({ client: makeFakeXai(body as never) }).run(req45(), CTX),
      )
      expect(err).toMatchObject({ kind, retryable, provider: 'xai' })
      expect(err.message).toBe(direct.message)
      expect(err.usage).toEqual(direct.usage)
      expect(err.usage).toBeDefined()
    },
  )

  it.each([
    ['server_error', 'server', true],
    ['rate_limit_exceeded', 'rate_limited', true],
    ['bio_policy', 'content_filter', false],
    ['invalid_prompt', 'bad_request', false],
    ['some_future_code', 'unknown', false],
  ] as const)(
    'an error event with code %s is %s, retryable %s',
    async (code, kind, retryable) => {
      const events: SseEvent[] = [
        ...synthesizeStreamEvents(
          completeResponse({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
          { omitTerminal: true },
        ),
        { type: 'error', code, message: 'upstream said no', param: null },
      ]
      const err = await failure(streamingAdapter(respond(events)).run(req45(), CTX))
      expect(err).toMatchObject({ kind, retryable, provider: 'xai' })
      expect(err.message).toContain(code)
      expect(err.message).toContain('upstream said no')
    },
  )

  it('an SSE `event: error` frame with a nested error object classifies by its code', async () => {
    const body =
      sseBody(
        synthesizeStreamEvents(completeResponse({ output: [] }), { omitTerminal: true }),
      ) +
      `event: error\ndata: ${JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })}\n\n`
    const err = await failure(
      streamingAdapter(() => Promise.resolve(rawSseResponse(body))).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'rate_limited', retryable: true })
  })

  it('response.incomplete returns the partial answer as finish reason length, like the non-streamed path', async () => {
    const incomplete = completeResponse({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'cut off mid-sen' }],
        },
      ],
      usage: { input_tokens: 5, output_tokens: 8 },
    })
    const direct = await xaiAdapter({ client: makeFakeXai(incomplete as never) }).run(
      req45(),
      CTX,
    )
    const streamed = await streamingAdapter(
      respond(synthesizeStreamEvents(incomplete, { terminal: 'response.incomplete' })),
    ).run(req45(), CTX)
    expect(streamed.finishReason).toBe('length')
    expect(streamed).toEqual(direct)
  })
})

describe('a stream that cannot be completed', () => {
  const partial = (usage: unknown): SseEvent[] =>
    synthesizeStreamEvents(
      completeResponse({
        usage,
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'abc' }],
          },
        ],
      }),
      { omitTerminal: true },
    )

  it('ends without response.completed: a retryable server error naming the last event', async () => {
    const err = await failure(streamingAdapter(respond(partial(null))).run(req45(), CTX))
    expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'xai' })
    expect(err.message).toContain('ended before response.completed')
    expect(err.message).toContain('response.output_item.done')
    expect(err.usage).toBeUndefined()
  })

  it('an empty body is the same error with no events', async () => {
    const err = await failure(
      streamingAdapter(() => Promise.resolve(rawSseResponse(''))).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(err.message).toContain('no events')
  })

  it('carries partial usage only when a response snapshot reported tokens', async () => {
    const events = partial(null)
    const withUsage = events.map((e) =>
      e.type === 'response.in_progress'
        ? {
            ...e,
            response: {
              ...(e['response'] as Plain),
              usage: { input_tokens: 12, output_tokens: 0 },
              service_tier: 'priority',
            },
          }
        : e,
    )
    const err = await failure(streamingAdapter(respond(withUsage)).run(req45(), CTX))
    expect(err.usage).toMatchObject({ inputTokens: 12, outputTokens: 0 })
    expect(err.servedServiceTier).toBe('priority')
  })

  it('unknown usage is unpriced, not free: the call cost is a lower bound of zero over one unpriced attempt', async () => {
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [xaiAdapter({ transport: transportOf(respond(partial(null))) })],
      modelRegistry: xaiRegistry,
      pricingSources: { xai: xaiPricingSource() },
      sink: new RecordingSink(),
      telemetry,
    })
    await failure(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    )
    expect(telemetry.errors).toHaveLength(1)
    expect(telemetry.errors[0]?.usage).toBeUndefined()
    expect(telemetry.errors[0]?.callCost).toEqual({
      microUsd: 0,
      attempts: 1,
      unpricedAttempts: 1,
    })
  })

  it('a body that is not valid SSE JSON is a retryable malformed-stream error', async () => {
    const err = await failure(
      streamingAdapter(() =>
        Promise.resolve(rawSseResponse('event: response.created\ndata: {not json\n\n')),
      ).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'xai' })
    expect(err.message).toContain('xAI stream is malformed')
  })

  it('a final object that disagrees structurally with the events is a retryable server error', async () => {
    const response = completeResponse({
      output: [
        { id: 'rs_1', type: 'reasoning', status: 'completed', summary: [] },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'x' }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 2 },
    })
    const wrong = {
      ...response,
      output: [
        { id: 'rs_1', type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' },
      ],
    }
    const err = await failure(
      streamingAdapter(
        respond(synthesizeStreamEvents(response, { finalResponse: wrong })),
      ).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(err.message).toContain('is a "reasoning" in the stream and a "function_call"')
  })

  it('a connection cut mid-body is a retryable server error', async () => {
    const stub: Stub = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(sseBody(partial(null).slice(0, 3))),
              )
              controller.error(
                new TypeError('terminated', {
                  cause: Object.assign(new Error('other side closed'), {
                    code: 'UND_ERR_SOCKET',
                  }),
                }),
              )
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    const err = await failure(streamingAdapter(stub).run(req45(), CTX))
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(err.reason).toBeUndefined()
  })

  it("Node's body timer firing mid-stream is a non-retryable transport timeout", async () => {
    const bodyTimeout = Object.assign(new Error('Body Timeout Error'), {
      name: 'BodyTimeoutError',
      code: 'UND_ERR_BODY_TIMEOUT',
    })
    const stub: Stub = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(sseBody(partial(null).slice(0, 3))),
              )
              controller.error(new TypeError('terminated', { cause: bodyTimeout }))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    const err = await failure(streamingAdapter(stub).run(req45(), CTX))
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
  })
})

// ---------------------------------------------------------------------------
// What the SDK timeout and the caller signal mean for a stream (ADR-040)
// ---------------------------------------------------------------------------

/**
 * A response whose stream sends `events` and then stays open until the request
 * is aborted, as a quiet but connected provider does.
 */
function openStream(events: SseEvent[]): Stub {
  return (_url, init) => {
    const signal = init['signal'] as AbortSignal
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseBody(events)))
            signal.addEventListener('abort', () => {
              try {
                controller.error(
                  new DOMException('This operation was aborted', 'AbortError'),
                )
              } catch {
                // already closed
              }
            })
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
  }
}

const OPEN_EVENTS = synthesizeStreamEvents(
  completeResponse({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
  { omitTerminal: true },
)
const PARAMS: XaiResponseCreateParams = { model: 'grok-4.5', input: [], store: false }

describe('the SDK timeout and the caller signal on a stream', () => {
  it('the openai SDK `timeout` covers only the wait for headers for a stream: an open stream outlives it', async () => {
    const { default: OpenAI } = await import('openai')
    const sdk = new OpenAI({
      apiKey: 'k',
      baseURL: 'https://api.x.ai/v1',
      maxRetries: 0,
      fetch: openStream(OPEN_EVENTS) as unknown as typeof fetch,
    })
    const stream = (await (
      sdk.responses.create as unknown as (
        p: unknown,
        o: unknown,
      ) => Promise<AsyncIterable<{ type: string }>>
    ).call(
      sdk.responses,
      { model: 'm', input: [], stream: true },
      { timeout: 40 },
    )) as AsyncIterable<{
      type: string
    }>
    const seen: string[] = []
    const reader = (async () => {
      for await (const event of stream) seen.push(event.type)
    })()
    // Four times the SDK timeout later the stream is still open and was not aborted.
    await new Promise((resolve) => setTimeout(resolve, 160))
    const state = await Promise.race([
      reader.then(() => 'ended'),
      Promise.resolve('open'),
    ])
    expect(state).toBe('open')
    expect(seen).toContain('response.created')
  })

  it('the client applies its timeout to the whole stream: a quiet open stream ends as a deadline error', async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      transportOf(openStream(OPEN_EVENTS)),
    )
    const started = Date.now()
    const err = await client.responses.create(PARAMS, { timeout: 60 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(5_000)
    const classified = classifyXaiError(err)
    expect(classified).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
    })
    expect(classified.message).toContain('SDK deadline')
    expect(classified.message).toContain('60 ms')
  })

  it('the deadline is not an idle timer: a stream that keeps sending is cut at the deadline too', async () => {
    const stub: Stub = (_url, init) => {
      const signal = init['signal'] as AbortSignal
      let timer: ReturnType<typeof setInterval> | undefined
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(() => {
                controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
              }, 10)
              signal.addEventListener('abort', () => {
                clearInterval(timer)
                controller.error(new DOMException('aborted', 'AbortError'))
              })
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    }
    const client = await buildXaiClient({ apiKey: 'k' }, transportOf(stub))
    const err = await client.responses.create(PARAMS, { timeout: 80 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(classifyXaiError(err)).toMatchObject({
      kind: 'timeout',
      reason: 'transport_timeout',
    })
  })

  it('a stream that finishes inside the deadline is untouched by it', async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      transportOf(
        respond(
          synthesizeStreamEvents(
            completeResponse({
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          ),
        ),
      ),
    )
    await expect(
      client.responses.create(PARAMS, { timeout: 5_000 }),
    ).resolves.toMatchObject({
      status: 'completed',
    })
  })

  it('a caller abort mid-stream is an abort, not a timeout and not a short stream', async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      transportOf(openStream(OPEN_EVENTS)),
    )
    const controller = new AbortController()
    const pending = client.responses
      .create(PARAMS, { signal: controller.signal, timeout: 5_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    const classified = classifyXaiError(await pending)
    expect(classified.kind).toBe('aborted')
    expect(classified.retryable).toBe(false)
  })

  it("the engine's deadline (an LlmError abort reason) reaches the caller unchanged mid-stream", async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      transportOf(openStream(OPEN_EVENTS)),
    )
    const controller = new AbortController()
    const deadline = new LlmError('call deadline', { kind: 'timeout', retryable: false })
    const pending = client.responses
      .create(PARAMS, { signal: controller.signal, timeout: 5_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort(deadline)
    expect(classifyXaiError(await pending)).toBe(deadline)
  })

  it('an already-aborted signal never produces a result', async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      transportOf(openStream(OPEN_EVENTS)),
    )
    const controller = new AbortController()
    controller.abort()
    const err = await client.responses
      .create(PARAMS, { signal: controller.signal, timeout: 5_000 })
      .then(
        () => undefined,
        (e: unknown) => e,
      )
    // The SDK refuses before sending; the engine, not this adapter, names the abort.
    expect(classifyXaiError(err).kind).not.toBe('timeout')
    expect(err).toBeDefined()
  })

  it('through the adapter: the signal the engine hands over aborts a stream in flight', async () => {
    const controller = new AbortController()
    const adapter = streamingAdapter(openStream(OPEN_EVENTS))
    const pending = failure(adapter.run(req45(), { ...CTX, signal: controller.signal }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    controller.abort()
    expect((await pending).kind).toBe('aborted')
  })
})
