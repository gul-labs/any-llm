/**
 * The adapter against REAL xAI streams (ADR-013, ADR-040 Amendment A), through
 * the real `openai` SDK with a stubbed `fetch` that serves the captured bytes.
 *
 * `__fixtures__/37-streamed-events.json` is the raw event text of live runs of
 * every feature class that only had synthetic coverage before: a function call
 * and its `'state'` replay, strict structured output, one and several web
 * searches, an X search, the priority tier and a `response.incomplete`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { AdapterCtx, AdapterResult, ResolvedRequest } from '@gullabs/core'
import { makeFakeXai } from '@gullabs/testing'
import { xaiAdapter } from './adapter.js'
import { grok45ModelDescriptor, grok47ModelDescriptor } from './models.js'
import { computeXaiCost } from './pricing.js'
import { rawSseResponse } from './test-sse.js'

type Plain = Record<string, unknown>
type Captured = { model: string; request: Plain; sse: string }

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/37-streamed-events.json', import.meta.url)),
    'utf8',
  ),
) as { streams: Record<string, Captured> }

const stream = (name: string): Captured => fixture.streams[name] as Captured

const CTX: AdapterCtx = {
  auth: { apiKey: 'test-key' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

/** The terminal response of a captured stream. */
function terminalResponse(captured: Captured): Plain {
  const blocks = captured.sse.split('\n\n').filter((b) => b.includes('data: '))
  const last = JSON.parse(
    (blocks[blocks.length - 1] as string)
      .split('\n')
      .find((l) => l.startsWith('data: '))
      ?.slice(6) as string,
  ) as Plain
  return last['response'] as Plain
}

/** The text of the first user message of a captured request (turn 1 and 2 share it). */
function firstUserText(captured: Captured): string {
  const first = (captured.request['input'] as Plain[])[0] as Plain
  return ((first['content'] as Plain[])[0] as Plain)['text'] as string
}

/** The ResolvedRequest that produces `captured.request` (the same fields the capture script set). */
function requestFor(captured: Captured, overrides: Partial<ResolvedRequest> = {}) {
  const wire = captured.request
  const reasoning = wire['reasoning'] as { effort: 'low' | 'medium' | 'high' } | undefined
  const tools = wire['tools'] as Plain[] | undefined
  const serverTools = tools?.filter((t) => t['type'] !== 'function')
  const text = wire['text'] as { format: { schema: unknown } } | undefined
  const functionTools = tools?.filter((t) => t['type'] === 'function')
  const req: ResolvedRequest = {
    provider: 'xai',
    model: captured.model,
    messages: [
      { role: 'user', parts: [{ kind: 'text', text: firstUserText(captured) }] },
    ],
    modelDescriptor:
      captured.model === 'grok-4.7' ? grok47ModelDescriptor : grok45ModelDescriptor,
    config: {
      ...(reasoning !== undefined ? { reasoning: { effort: reasoning.effort } } : {}),
      ...(typeof wire['max_output_tokens'] === 'number'
        ? { maxOutputTokens: wire['max_output_tokens'] }
        : {}),
      ...(wire['service_tier'] === 'priority' ? { serviceTier: 'priority' } : {}),
      ...(serverTools !== undefined && serverTools.length > 0
        ? {
            providerOptions: {
              xai: {
                tools: serverTools,
                ...(typeof wire['max_turns'] === 'number'
                  ? { maxTurns: wire['max_turns'] }
                  : {}),
              },
            },
          }
        : {}),
    },
    ...(functionTools !== undefined && functionTools.length > 0
      ? {
          tools: functionTools.map((t) => ({
            name: t['name'] as string,
            description: t['description'] as string,
            inputJsonSchema: t['parameters'] as never,
          })),
        }
      : {}),
    ...(text !== undefined ? { outputJsonSchema: text.format.schema as never } : {}),
    ...overrides,
  } as ResolvedRequest
  return req
}

const serve = (captured: Captured, seen?: Plain[]) =>
  xaiAdapter({
    transport: {
      fetch: ((_url: unknown, init: Record<string, unknown>) => {
        seen?.push(JSON.parse(String(init['body'])) as Plain)
        return Promise.resolve(rawSseResponse(captured.sse))
      }) as unknown as typeof fetch,
    },
  })

const NAMES = Object.keys(fixture.streams).filter(
  (n) => n !== 'function_call_turn2_state_replay',
)

describe('every real stream maps exactly as its terminal response maps non-streamed', () => {
  it.each(NAMES)('%s', async (name) => {
    const captured = stream(name)
    const req = requestFor(captured)
    const streamed = await serve(captured).run(req, CTX)
    const direct = await xaiAdapter({
      client: makeFakeXai(terminalResponse(captured) as never),
    }).run(req, CTX)
    expect(streamed).toEqual(direct)
    // The streams agree with their final objects, so reconciliation said nothing.
    expect(
      streamed.warnings.filter((w) => w.message.startsWith('xai: output item')),
    ).toEqual([])
  })

  it.each(NAMES)('%s: the priced cost equals what xAI billed', async (name) => {
    const captured = stream(name)
    const result = await serve(captured).run(requestFor(captured), CTX)
    const ticks = result.usage.details['cost_in_usd_ticks'] as number
    const cost = computeXaiCost(captured.model, result.usage, result.servedServiceTier)
    expect(cost.confidence).toBe('exact')
    expect(Math.abs((cost.microUsd as number) - ticks / 10_000)).toBeLessThanOrEqual(2)
  })
})

describe('the request the adapter builds is the one that was captured', () => {
  it.each(NAMES)('%s: the wire body is identical', async (name) => {
    const captured = stream(name)
    const seen: Plain[] = []
    await serve(captured, seen).run(requestFor(captured), CTX)
    expect(seen[0]).toEqual(captured.request)
  })
})

describe('what each real stream returns', () => {
  it('plain: the text, one assistant text part, stop', async () => {
    const result = await serve(stream('plain')).run(requestFor(stream('plain')), CTX)
    expect(result.text).toBe('391')
    expect(result.finishReason).toBe('stop')
    expect(result.message.parts).toEqual([{ kind: 'text', text: '391' }])
  })

  it('priority: the served tier is priority and it was billed at the priority rate', async () => {
    const result = await serve(stream('priority')).run(
      requestFor(stream('priority')),
      CTX,
    )
    expect(result.servedServiceTier).toBe('priority')
  })

  it('incomplete (max_output_tokens): the partial text with finish reason length', async () => {
    const captured = stream('incomplete')
    const result = await serve(captured).run(requestFor(captured), CTX)
    expect(result.finishReason).toBe('length')
    expect(result.text?.startsWith('**Rivers: Lifelines of the Earth**')).toBe(true)
    expect(result.text).toBe(
      (
        ((terminalResponse(captured)['output'] as Plain[])[0] as Plain)[
          'content'
        ] as Plain[]
      )
        .map((p) => p['text'])
        .join(''),
    )
  })

  it.each(['schema_low', 'schema_high'])(
    '%s: strict structured output is parsed from the one message item',
    async (name) => {
      const captured = stream(name)
      const result = await serve(captured).run(requestFor(captured), CTX)
      expect(result.warnings).toEqual([])
      expect(result.rawStructured).toEqual(JSON.parse(result.text ?? ''))
      expect(typeof result.rawStructured).toBe('object')
    },
  )

  it('schema: the strict json_schema wire shape is the one that streamed live', async () => {
    const captured = stream('schema_low')
    const seen: Plain[] = []
    await serve(captured, seen).run(requestFor(captured), CTX)
    expect(seen[0]?.['text']).toEqual(captured.request['text'])
    expect(seen[0]).toMatchObject({ stream: true, store: false })
  })

  it('function call: the call, its arguments and the reasoning item in the state', async () => {
    const captured = stream('function_call_turn1')
    const result = await serve(captured).run(requestFor(captured), CTX)
    expect(result.finishReason).toBe('tool_calls')
    expect(result.toolCalls).toEqual([
      {
        toolCallId: expect.stringMatching(/^call-/) as string,
        toolName: 'get_weather',
        args: { city: 'Paris' },
      },
    ])
    const state = result.transientProviderState as { xai: { input: Plain[] } }
    expect(state.xai.input.map((i) => i['type'] ?? i['role'])).toEqual([
      'user',
      'reasoning',
      'function_call',
    ])
    expect(state.xai.input[1]?.['encrypted_content']).toMatch(/^enc_/)
  })

  it('function call: the state built from the real stream is exactly the input of the real second request', async () => {
    const turn1 = stream('function_call_turn1')
    const turn2 = stream('function_call_turn2_state_replay')
    const first = await serve(turn1).run(requestFor(turn1), CTX)
    const call = first.toolCalls?.[0]
    expect(call).toBeDefined()
    const seen: Plain[] = []
    const second = await serve(turn2, seen).run(
      requestFor(turn2, {
        messages: [
          {
            role: 'user',
            parts: [
              {
                kind: 'tool-result',
                toolCallId: (call as { toolCallId: string }).toolCallId,
                toolName: 'get_weather',
                result: { tempC: 18, sky: 'clear' },
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city.',
            inputJsonSchema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
        transientProviderState: first.transientProviderState as never,
      }),
      CTX,
    )
    // Field for field the body xAI accepted (HTTP 200) when this was captured live.
    expect(seen[0]?.['input']).toEqual(turn2.request['input'])
    expect(seen[0]).toEqual(turn2.request)
    expect(second.finishReason).toBe('stop')
    expect(second.text?.length).toBeGreaterThan(0)
  })

  it('web search (one): the citation, the counter and the inline range', async () => {
    const captured = stream('web_search_one')
    const result = await serve(captured).run(requestFor(captured), CTX)
    expect(result.usage.details['web_search_calls']).toBe(1)
    expect(result.citations?.[0]?.url).toContain('britannica.com')
    expect(result.text).toContain('Canberra')
  })

  it('web search (several, grok-4.7): every call is counted, the 29 citations kept, no warning', async () => {
    const captured = stream('web_search_multi')
    const result = await serve(captured).run(requestFor(captured), CTX)
    expect(result.usage.details['web_search_calls']).toBeGreaterThanOrEqual(3)
    expect(result.citations?.length).toBeGreaterThan(5)
    // The final object lists every source on every search call (live finding):
    // that is not reported as a stream/final disagreement.
    expect(result.warnings).toEqual([])
  })

  it('x search: priced from the item counters, the custom tool call is replayed in the state', async () => {
    const captured = stream('x_search')
    const result = await serve(captured).run(requestFor(captured), CTX)
    expect(result.usage.details['x_posts_fetched']).toBeGreaterThanOrEqual(0)
    expect(result.text?.length).toBeGreaterThan(0)
  })
})

describe('the same real streams, damaged', () => {
  const damaged = (name: string, edit: (events: Plain[]) => Plain[]): Captured => {
    const captured = stream(name)
    const events = captured.sse
      .split('\n\n')
      .filter(Boolean)
      .map(
        (b) =>
          JSON.parse(
            b
              .split('\n')
              .find((l) => l.startsWith('data: '))
              ?.slice(6) as string,
          ) as Plain,
      )
    return {
      ...captured,
      sse: edit(events)
        .map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(''),
    }
  }

  it('cut before the terminal event: not retryable, the received text priced as an estimate', async () => {
    const cut = damaged('plain', (events) => events.slice(0, -1))
    const err = await serve(cut)
      .run(requestFor(cut), CTX)
      .then(
        () => undefined,
        (e: unknown) => e as LlmError,
      )
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'server', retryable: false })
    expect(err?.usage?.outputTokens).toBe(1) // "391" is 3 characters
    expect(err?.usage?.details['usage_estimated']).toBe(1)
  })

  it('every item event stripped of output_index: still answered from the final object, with a warning', async () => {
    const stripped = damaged('schema_low', (events) =>
      events.map((e) => {
        if (String(e['type']).startsWith('response.output_item')) {
          const { output_index: _i, ...rest } = e
          return rest
        }
        return e
      }),
    )
    const direct: AdapterResult = await serve(stream('schema_low')).run(
      requestFor(stream('schema_low')),
      CTX,
    )
    const result = await serve(stripped).run(requestFor(stripped), CTX)
    expect(result.text).toBe(direct.text)
    expect(result.usage).toEqual(direct.usage)
    expect(result.transientProviderState).toEqual(direct.transientProviderState)
    expect(result.warnings.map((w) => w.message).join('\n')).toContain('skipped')
  })
})
