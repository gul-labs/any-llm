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
import { getEventListeners } from 'node:events'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LlmError, createClient, retryMiddleware } from '@gullabs/core'
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
    ['rate_limit_exceeded', 'rate_limited', false],
    ['bio_policy', 'content_filter', false],
    ['invalid_prompt', 'bad_request', false],
    ['some_future_code', 'unknown', false],
  ] as const)(
    'an error event with code %s before any output is %s, retryable %s',
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
      // Nothing was generated, so there is nothing to estimate.
      expect(err.usage).toBeUndefined()
    },
  )

  it.each([
    ['server_error', 'server'],
    ['rate_limit_exceeded', 'rate_limited'],
    ['invalid_prompt', 'bad_request'],
  ] as const)(
    'an error event with code %s after output began is %s, never retryable, with estimated usage',
    async (code, kind) => {
      const events: SseEvent[] = [
        ...partialStream(null),
        { type: 'error', code, message: 'mid-run', param: null },
      ]
      const err = await failure(streamingAdapter(respond(events)).run(req45(), CTX))
      expect(err).toMatchObject({ kind, retryable: false, provider: 'xai' })
      expect(err.usage?.details['usage_estimated']).toBe(1)
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
    // A mid-stream rate limit is not retried: the call may already have billed.
    expect(err).toMatchObject({ kind: 'rate_limited', retryable: false })
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

/**
 * The stream of a one-message answer, cut after its content: the events up to
 * and including `output_item.done`, with the terminal event omitted.
 */
const partialStream = (usage: unknown): SseEvent[] =>
  synthesizeStreamEvents(
    completeResponse({
      usage,
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'abcdefgh' }],
        },
      ],
    }),
    { omitTerminal: true },
  )

/** The same stream cut before any output event (only the two response snapshots). */
const openedStream = (): SseEvent[] =>
  partialStream(null).filter(
    (e) => e.type === 'response.created' || e.type === 'response.in_progress',
  )

/** Delivers `events`, then fails the body (an error would drop chunks still queued). */
function cutBody(events: SseEvent[], error: unknown): Stub {
  return () => {
    let sent = false
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true
              controller.enqueue(new TextEncoder().encode(sseBody(events)))
            } else {
              controller.error(error)
            }
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    )
  }
}

const resetError = (): TypeError =>
  new TypeError('terminated', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
  })

describe('a stream that cannot be completed (P1-1: progress decides whether a retry is safe)', () => {
  it('cut BEFORE any output event: a retryable server error with no usage', async () => {
    const err = await failure(streamingAdapter(respond(openedStream())).run(req45(), CTX))
    expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'xai' })
    expect(err.message).toContain('ended before response.completed')
    expect(err.usage).toBeUndefined()
  })

  it('ends AFTER output without response.completed: a NON-retryable server error with an estimate', async () => {
    const err = await failure(
      streamingAdapter(respond(partialStream(null))).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'xai' })
    expect(err.message).toContain('ended before response.completed')
    expect(err.message).toContain('response.output_item.done')
    // 8 characters of text / 4; the request's input estimated from its length.
    expect(err.usage).toMatchObject({ outputTokens: 2 })
    expect(err.usage?.details['usage_estimated']).toBe(1)
    expect(err.usage?.details['cost_in_usd_ticks']).toBeUndefined()
    expect(err.cause).toBeInstanceOf(Error)
  })

  it('an empty body is the same retryable error with no events', async () => {
    const err = await failure(
      streamingAdapter(() => Promise.resolve(rawSseResponse(''))).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(err.message).toContain('no events')
  })

  it('usage in a response snapshot is never used: not exact, not even as the estimate', async () => {
    const snapshot = (events: SseEvent[]) =>
      events.map((e) =>
        e.type === 'response.in_progress'
          ? {
              ...e,
              response: {
                ...(e['response'] as Plain),
                usage: { input_tokens: 5000, output_tokens: 0, cost_in_usd_ticks: 9e9 },
                service_tier: 'priority',
              },
            }
          : e,
      )
    const before = await failure(
      streamingAdapter(respond(snapshot(openedStream()))).run(req45(), CTX),
    )
    expect(before.usage).toBeUndefined()
    expect(before.servedServiceTier).toBe('priority')
    const after = await failure(
      streamingAdapter(respond(snapshot(partialStream(null)))).run(req45(), CTX),
    )
    expect(after.usage?.inputTokens).toBeLessThan(100)
    expect(after.usage?.details['cost_in_usd_ticks']).toBeUndefined()
    expect(after.servedServiceTier).toBe('priority')
  })

  it('the estimate prices as estimated, never exact, and counts as a priced attempt', async () => {
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [xaiAdapter({ transport: transportOf(respond(partialStream(null))) })],
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
    const error = telemetry.errors[0]
    expect(error?.cost?.confidence).toBe('estimated')
    expect(error?.cost?.providerReported).toBeUndefined()
    expect(error?.cost?.microUsd).toBeGreaterThan(0)
    expect(error?.callCost).toMatchObject({ attempts: 1, unpricedAttempts: 0 })
  })

  it('unknown usage before any output is unpriced, not free: a lower bound of zero over one unpriced attempt', async () => {
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [xaiAdapter({ transport: transportOf(respond(openedStream())) })],
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

  it('a body that is not valid SSE JSON is a malformed-stream error, retryable only before output', async () => {
    const bad = 'event: response.created\ndata: {not json\n\n'
    const before = await failure(
      streamingAdapter(() => Promise.resolve(rawSseResponse(bad))).run(req45(), CTX),
    )
    expect(before).toMatchObject({ kind: 'server', retryable: true, provider: 'xai' })
    expect(before.message).toContain('xAI stream is malformed')
    const after = await failure(
      streamingAdapter(() =>
        Promise.resolve(rawSseResponse(sseBody(partialStream(null)) + bad)),
      ).run(req45(), CTX),
    )
    expect(after).toMatchObject({ kind: 'server', retryable: false })
    expect(after.usage?.details['usage_estimated']).toBe(1)
  })

  it('a connection cut mid-body after output is a non-retryable server error carrying the cause', async () => {
    const err = await failure(
      streamingAdapter(cutBody(partialStream(null), resetError())).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'xai' })
    expect(err.reason).toBeUndefined()
    expect(err.usage?.details['usage_estimated']).toBe(1)
    expect(String((err.cause as Error).cause)).toContain('terminated')
  })

  it('a connection cut before any output stays a retryable server error', async () => {
    const err = await failure(
      streamingAdapter(cutBody(openedStream(), resetError())).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: true })
    expect(err.usage).toBeUndefined()
  })

  it("Node's body timer firing mid-stream is a non-retryable transport timeout, with the estimate after output", async () => {
    const bodyTimeout = Object.assign(new Error('Body Timeout Error'), {
      name: 'BodyTimeoutError',
      code: 'UND_ERR_BODY_TIMEOUT',
    })
    const err = await failure(
      streamingAdapter(
        cutBody(partialStream(null), new TypeError('terminated', { cause: bodyTimeout })),
      ).run(req45(), CTX),
    )
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
    })
    expect(err.usage?.details['usage_estimated']).toBe(1)
  })
})

describe('retries through the real engine (P1-1, P2-1)', () => {
  /** A client with the documented retry middleware over a counted stub. */
  function retrying(stub: Stub) {
    const calls = { n: 0 }
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [
        xaiAdapter({
          transport: transportOf((url, init) => {
            calls.n++
            return stub(url, init)
          }),
        }),
      ],
      modelRegistry: xaiRegistry,
      pricingSources: { xai: xaiPricingSource() },
      sink: new RecordingSink(),
      telemetry,
      middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })],
    })
    const generate = () =>
      failure(
        client.generate(
          {
            provider: 'xai',
            model: 'grok-4.5',
            messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          },
          { auth: { apiKey: 'test-key' } },
        ),
      )
    return { calls, telemetry, generate }
  }

  it('a cut after output is NOT retried: one fetch, the attempt priced as an estimate', async () => {
    const { calls, telemetry, generate } = retrying(
      cutBody(partialStream(null), resetError()),
    )
    const err = await generate()
    expect(calls.n).toBe(1)
    expect(err).toMatchObject({ kind: 'server', retryable: false })
    expect(telemetry.errors[0]?.callCost).toMatchObject({
      attempts: 1,
      unpricedAttempts: 0,
    })
    expect(telemetry.errors[0]?.cost?.confidence).toBe('estimated')
  })

  it('a stream that ends after output without its terminal event is NOT retried', async () => {
    const { calls, generate } = retrying(respond(partialStream(null)))
    await generate()
    expect(calls.n).toBe(1)
  })

  it('a cut before any output IS retried, every attempt unpriced', async () => {
    const { calls, telemetry, generate } = retrying(cutBody(openedStream(), resetError()))
    await generate()
    expect(calls.n).toBe(3)
    expect(telemetry.errors[0]?.callCost).toEqual({
      microUsd: 0,
      attempts: 3,
      unpricedAttempts: 3,
    })
  })

  it('a mid-stream rate_limit_exceeded is not retried even before output, and is not known-free', async () => {
    const events: SseEvent[] = [
      ...openedStream(),
      { type: 'error', code: 'rate_limit_exceeded', message: 'slow down' },
    ]
    const { calls, telemetry, generate } = retrying(respond(events))
    const err = await generate()
    expect(calls.n).toBe(1)
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: false,
      mayHaveBilled: true,
    })
    // The stream had started: unlike an HTTP 429, this attempt may have billed.
    expect(telemetry.errors[0]?.callCost).toEqual({
      microUsd: 0,
      attempts: 1,
      unpricedAttempts: 1,
    })
  })

  it('a mid-stream invalid_prompt (bad_request) is also an unpriced attempt, not known-free', async () => {
    const events: SseEvent[] = [
      ...openedStream(),
      { type: 'error', code: 'invalid_prompt', message: 'bad' },
    ]
    const { telemetry, generate } = retrying(respond(events))
    await generate()
    expect(telemetry.errors[0]?.callCost).toMatchObject({ unpricedAttempts: 1 })
  })

  it('a server_error event before any output is retried; HTTP 429 stays known-free', async () => {
    const events: SseEvent[] = [
      ...openedStream(),
      { type: 'error', code: 'server_error', message: 'oops' },
    ]
    const server = retrying(respond(events))
    await server.generate()
    expect(server.calls.n).toBe(3)

    const http = retrying(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'slow' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    await http.generate()
    expect(http.telemetry.errors[0]?.callCost).toMatchObject({ unpricedAttempts: 0 })
  })
})

describe('reconciliation is enrichment: a complete, billed stream is never thrown away (P1-2)', () => {
  const ticks = 4_033_200_000
  const response = completeResponse({
    output: [
      { id: 'rs_1', type: 'reasoning', status: 'completed', summary: [] },
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'the answer' }],
      },
    ],
    usage: { input_tokens: 2, output_tokens: 2, cost_in_usd_ticks: ticks },
  })

  it('a final object that disagrees with an item event on type returns the answer from the final object, with a warning', async () => {
    const wrong = {
      ...response,
      output: [
        { id: 'rs_1', type: 'function_call', call_id: 'c', name: 'n', arguments: '{}' },
        ...(response['output'] as Plain[]).slice(1),
      ],
    }
    const result = await streamingAdapter(
      respond(synthesizeStreamEvents(response, { finalResponse: wrong })),
    ).run(req45(), CTX)
    expect(result.text).toBe('the answer')
    expect(result.usage.details['cost_in_usd_ticks']).toBe(ticks)
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('is a "reasoning" in the stream and a "function_call"'),
    ])
  })

  it('item events with no output_index are skipped; the answer and the priced usage survive', async () => {
    const events = synthesizeStreamEvents(response).map((e) => {
      if (
        e.type === 'response.output_item.added' ||
        e.type === 'response.output_item.done'
      ) {
        const { output_index: _index, ...rest } = e
        return rest as SseEvent
      }
      return e
    })
    const result = await streamingAdapter(respond(events)).run(req45(), CTX)
    expect(result.text).toBe('the answer')
    expect(result.usage.details['cost_in_usd_ticks']).toBe(ticks)
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('skipped 2 stream event(s)'),
      expect.stringContaining('skipped 2 stream event(s)'),
    ])
  })

  it('through the engine such a call succeeds in one fetch, priced exactly', async () => {
    const wrong = { ...response, output: 'nope' }
    let fetches = 0
    const telemetry = new RecordingTelemetry()
    const client = createClient({
      adapters: [
        xaiAdapter({
          transport: transportOf(() => {
            fetches++
            return Promise.resolve(
              sseResponse(synthesizeStreamEvents(response, { finalResponse: wrong })),
            )
          }),
        }),
      ],
      modelRegistry: xaiRegistry,
      pricingSources: { xai: xaiPricingSource() },
      sink: new RecordingSink(),
      telemetry,
      middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })],
    })
    const result = await client.generate(
      {
        provider: 'xai',
        model: 'grok-4.5',
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      },
      { auth: { apiKey: 'test-key' } },
    )
    expect(fetches).toBe(1)
    expect(result.text).toBe('the answer')
    expect(result.callCost).toMatchObject({ attempts: 1, unpricedAttempts: 0 })
  })

  it('a terminal response with no token counts is a typed non-retryable server error, not a TypeError', async () => {
    for (const usage of [undefined, null, { total_tokens: 3 }]) {
      const noUsage = { ...response, usage }
      const err = await failure(
        streamingAdapter(
          respond(synthesizeStreamEvents(noUsage, { terminal: 'response.incomplete' })),
        ).run(req45(), CTX),
      )
      expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'xai' })
      expect(err.message).toContain('resp_fixture')
      expect(err.message).toContain('carries no numeric usage')
    }
  })

  it('any failure to map a complete, billed response is a typed non-retryable error carrying its exact usage', async () => {
    // A client that hands over a response whose `output` is not a list (the
    // stream reducer always builds one, so only an injected client can).
    const strange = { ...response, output: 5 } as unknown as never
    const err = await failure(
      xaiAdapter({ client: makeFakeXai(strange) }).run(req45(), CTX),
    )
    expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'xai' })
    expect(err.message).toContain('could not be mapped')
    expect(err.usage?.details['cost_in_usd_ticks']).toBe(ticks)
    expect(err.usage?.details['usage_estimated']).toBeUndefined()
  })

  it('response.incomplete whose object says in_progress is still the length finish reason', async () => {
    const lying = {
      ...response,
      status: 'in_progress',
      incomplete_details: { reason: 'max_output_tokens' },
    }
    const result = await streamingAdapter(
      respond(synthesizeStreamEvents(lying, { terminal: 'response.incomplete' })),
    ).run(req45(), CTX)
    expect(result.finishReason).toBe('length')
  })
})

describe('frames that are not events (P3-2, P3-3)', () => {
  const full = synthesizeStreamEvents(
    completeResponse({
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 1 },
    }),
  )

  it('a bare `event: keepalive` frame and a `data: [DONE]` frame are skipped silently', async () => {
    const body = `event: keepalive\n\n${sseBody(full)}data: [DONE]\n\n`
    const result = await streamingAdapter(() =>
      Promise.resolve(rawSseResponse(body)),
    ).run(req45(), CTX)
    expect(result.text).toBe('ok')
    expect(result.warnings).toEqual([])
  })

  it('a named JSON frame with no type is skipped and reported as a warning', async () => {
    const body = `event: ping\ndata: {"hello":1}\n\n${sseBody(full)}`
    const result = await streamingAdapter(() =>
      Promise.resolve(rawSseResponse(body)),
    ).run(req45(), CTX)
    expect(result.text).toBe('ok')
    expect(result.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining('an event that has no string `type`'),
    ])
  })

  it('a transport.fetch that returns a buffered JSON body is a clear non-retryable error naming the cause', async () => {
    const telemetry = new RecordingTelemetry()
    let fetches = 0
    const client = createClient({
      adapters: [
        xaiAdapter({
          transport: transportOf(() => {
            fetches++
            return Promise.resolve(Response.json({ id: 'resp', output: [] }))
          }),
        }),
      ],
      modelRegistry: xaiRegistry,
      pricingSources: { xai: xaiPricingSource() },
      sink: new RecordingSink(),
      telemetry,
      middleware: [retryMiddleware({ maxAttempts: 3, baseDelayMs: 0 })],
    })
    const err = await failure(
      client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
        },
        { auth: { apiKey: 'test-key' } },
      ),
    )
    expect(fetches).toBe(1)
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false, provider: 'xai' })
    expect(err.message).toContain('non-event-stream body')
    expect(err.message).toContain('application/json')
    expect(err.message).toContain('transport.fetch')
    // The upstream call may have run: not known-free.
    expect(telemetry.errors[0]?.callCost).toMatchObject({ unpricedAttempts: 1 })
  })
})

describe('idleTimeoutMs bounds a half-open connection (P2-5)', () => {
  const heartbeats =
    (everyMs: number): Stub =>
    (_url, init) => {
      const signal = init['signal'] as AbortSignal
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const timer = setInterval(() => {
                try {
                  controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'))
                } catch {
                  clearInterval(timer)
                }
              }, everyMs)
              signal.addEventListener('abort', () => {
                clearInterval(timer)
                try {
                  controller.error(new DOMException('aborted', 'AbortError'))
                } catch {
                  // closed
                }
              })
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      )
    }

  it('a silent open stream ends as a non-retryable transport timeout, before the request deadline', async () => {
    const adapter = xaiAdapter({
      transport: {
        fetch: openStream(OPEN_EVENTS) as unknown as typeof fetch,
        idleTimeoutMs: 60,
      },
    })
    const started = Date.now()
    const err = await failure(adapter.run(req45(), CTX))
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(err).toMatchObject({
      kind: 'timeout',
      retryable: false,
      reason: 'transport_timeout',
      provider: 'xai',
    })
    expect(err.message).toContain('idle timeout')
    expect(err.message).toContain('60 ms')
  })

  it('heartbeat comments count as activity: a chatty stream is not idle, the deadline still bounds it', async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      { fetch: heartbeats(10) as unknown as typeof fetch, idleTimeoutMs: 60 },
    )
    const started = Date.now()
    const err = await client.responses.create(PARAMS, { timeout: 250 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(classifyXaiError(err).message).toContain('SDK deadline')
  })

  it('is off by default: a silent stream is bounded by the deadline alone', async () => {
    const client = await buildXaiClient(
      { apiKey: 'k' },
      transportOf(openStream(OPEN_EVENTS)),
    )
    const err = await client.responses.create(PARAMS, { timeout: 150 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(classifyXaiError(err).message).toContain('SDK deadline')
  })

  it('after output the idle error carries the usage estimate', async () => {
    const adapter = xaiAdapter({
      transport: {
        fetch: openStream(partialStream(null)) as unknown as typeof fetch,
        idleTimeoutMs: 40,
      },
    })
    const err = await failure(adapter.run(req45(), CTX))
    expect(err.message).toContain('idle timeout')
    expect(err.usage?.details['usage_estimated']).toBe(1)
  })

  it.each([0, -1, 1.5, Number.NaN, '5', Number.MAX_SAFE_INTEGER])(
    'rejects idleTimeoutMs %s with bad_request before anything is sent',
    (value) => {
      expect(() =>
        xaiAdapter({
          transport: { fetch: (() => {}) as never, idleTimeoutMs: value as number },
        }),
      ).toThrowError(expect.objectContaining({ kind: 'bad_request' }) as never)
    },
  )
})

describe('what the client leaves behind (P2-4)', () => {
  const activeTimeouts = (): number =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

  const okEvents = synthesizeStreamEvents(
    completeResponse({ output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
  )

  it('leaves no timer and no abort listener after a success', async () => {
    const before = activeTimeouts()
    const signal = new AbortController().signal
    const client = await buildXaiClient(
      { apiKey: 'k' },
      { fetch: respond(okEvents) as unknown as typeof fetch, idleTimeoutMs: 5_000 },
    )
    await client.responses.create(PARAMS, { signal, timeout: 60_000 })
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(activeTimeouts()).toBeLessThanOrEqual(before)
  })

  it('leaves none after a failure, a cut stream or a deadline', async () => {
    const before = activeTimeouts()
    for (const stub of [
      respond(partialStream(null)),
      cutBody(partialStream(null), resetError()),
      openStream(OPEN_EVENTS),
    ]) {
      const signal = new AbortController().signal
      const client = await buildXaiClient(
        { apiKey: 'k' },
        { fetch: stub as unknown as typeof fetch, idleTimeoutMs: 5_000 },
      )
      await client.responses
        .create(PARAMS, { signal, timeout: 80 })
        .catch(() => undefined)
      expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    }
    expect(activeTimeouts()).toBeLessThanOrEqual(before)
  })

  it('leaves none after a caller abort', async () => {
    const before = activeTimeouts()
    const controller = new AbortController()
    const client = await buildXaiClient(
      { apiKey: 'k' },
      { fetch: openStream(OPEN_EVENTS) as unknown as typeof fetch, idleTimeoutMs: 5_000 },
    )
    const pending = client.responses
      .create(PARAMS, { signal: controller.signal, timeout: 60_000 })
      .catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await pending
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(activeTimeouts()).toBeLessThanOrEqual(before)
  })
})

describe('the fake client and the real streaming path agree (P3-7)', () => {
  it('makeFakeXai bypasses the stream (it replaces `responses.create`, below which the reducer lives); a streamed run of the same response gives the same result', async () => {
    const response = completeResponse({
      model: 'grok-4.5',
      output: [
        { id: 'rs_1', type: 'reasoning', status: 'completed', summary: [] },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'same answer' }],
        },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
    })
    const viaFake = await xaiAdapter({ client: makeFakeXai(response as never) }).run(
      req45(),
      CTX,
    )
    const viaStream = await streamingAdapter(
      respond(synthesizeStreamEvents(response)),
    ).run(req45(), CTX)
    expect(viaStream).toEqual(viaFake)
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
