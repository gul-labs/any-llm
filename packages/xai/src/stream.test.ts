/**
 * The stream reducer (ADR-040): events in, one reconciled response out.
 *
 * SYNTHETIC (ADR-013): event sequences come from `synthesizeStreamEvents`, the
 * OpenAI Responses streaming grammar applied to the recorded non-streamed
 * fixtures. Live capture P9a/P12 kept event types, usage and timings only
 * (`36-streamed-responses.json`); the last describe block pins the synthetic
 * grammar to the event types the real stream carried.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { XaiStreamError, XaiStreamReducer } from './stream.js'
import { synthesizeStreamEvents } from './test-sse.js'
import type { SseEvent } from './test-sse.js'

type Plain = Record<string, unknown>

const fixtureDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url))

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixtureDir + name, 'utf8'))
}

/** Every response-shaped object (`output` array of objects plus `usage`) in the fixtures. */
function collectResponses(): Array<{ name: string; response: Plain }> {
  const found: Array<{ name: string; response: Plain }> = []
  const walk = (value: unknown, name: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${name}[${i}]`))
    } else if (typeof value === 'object' && value !== null) {
      const o = value as Plain
      if (
        Array.isArray(o['output']) &&
        o['output'].length > 0 &&
        o['output'].every((x) => typeof x === 'object' && x !== null) &&
        typeof o['usage'] === 'object'
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

function reduce(events: SseEvent[]) {
  const reducer = new XaiStreamReducer()
  for (const event of events) if (reducer.push(event)) break
  return reducer.result()
}

const RESPONSES = collectResponses()

describe('fixtures to stream events (synthetic grammar)', () => {
  it('covers the recorded non-streamed responses', () => {
    expect(RESPONSES.length).toBeGreaterThanOrEqual(30)
    const types = new Set(
      RESPONSES.flatMap((r) => (r.response['output'] as Plain[]).map((i) => i['type'])),
    )
    for (const type of ['reasoning', 'message', 'web_search_call', 'function_call']) {
      expect(types).toContain(type)
    }
  })

  it.each(RESPONSES.map((r) => [r.name, r.response] as const))(
    '%s: an agreeing stream reconciles to exactly the recorded output, with no notes',
    (_name, response) => {
      const { response: reduced, notes } = reduce(synthesizeStreamEvents(response))
      expect(reduced['output']).toEqual(response['output'])
      expect(notes).toEqual([])
    },
  )

  it.each(RESPONSES.map((r) => [r.name, r.response] as const))(
    '%s: an EMPTY final output is rebuilt from the done events to exactly the recorded output',
    (_name, response) => {
      const events = synthesizeStreamEvents(response, {
        finalResponse: { ...response, output: [] },
      })
      const { response: reduced, notes } = reduce(events)
      expect(reduced['output']).toEqual(response['output'])
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain('rebuilt from the stream events')
    },
  )

  it.each(RESPONSES.map((r) => [r.name, r.response] as const))(
    '%s: a final output with the reasoning items dropped (the P9a shape) gets them back, in order',
    (_name, response) => {
      const output = response['output'] as Plain[]
      const withoutReasoning = output.filter((item) => item['type'] !== 'reasoning')
      const events = synthesizeStreamEvents(response, {
        finalResponse: { ...response, output: withoutReasoning },
      })
      const { response: reduced, notes } = reduce(events)
      expect(reduced['output']).toEqual(output)
      expect(notes.length === 0).toBe(withoutReasoning.length === output.length)
    },
  )

  it.each(RESPONSES.map((r) => [r.name, r.response] as const))(
    '%s: with no done events the items assemble from deltas to the recorded text, annotations, summaries and arguments',
    (_name, response) => {
      const events = synthesizeStreamEvents(response, {
        omitDone: true,
        finalResponse: { ...response, output: [] },
      })
      const { response: reduced, notes } = reduce(events)
      const rebuilt = reduced['output'] as Plain[]
      const recorded = response['output'] as Plain[]
      expect(rebuilt).toHaveLength(recorded.length)
      recorded.forEach((item, i) => {
        const got = rebuilt[i] as Plain
        expect(got['type']).toBe(item['type'])
        expect(got['status']).toBe(
          response['status'] === 'incomplete' ? 'incomplete' : 'completed',
        )
        if (item['type'] === 'message') {
          const parts = (item['content'] as Plain[]).map((p) => ({
            text: p['text'],
            annotations: p['annotations'] ?? [],
          }))
          expect(
            (got['content'] as Plain[]).map((p) => ({
              text: p['text'],
              annotations: p['annotations'] ?? [],
            })),
          ).toEqual(parts)
        } else if (item['type'] === 'reasoning') {
          expect((got['summary'] as Plain[]).map((p) => p['text'])).toEqual(
            (item['summary'] as Plain[]).map((p) => p['text']),
          )
        } else if (item['type'] === 'function_call') {
          expect(got['arguments']).toBe(item['arguments'])
          expect(got['call_id']).toBe(item['call_id'])
          expect(got['name']).toBe(item['name'])
        }
      })
      expect(notes).toHaveLength(1)
      expect(notes[0]).toContain('assembled from the stream deltas')
    },
  )
})

describe('reconciliation rules', () => {
  const response = {
    id: 'resp_1',
    model: 'grok-4.7',
    status: 'completed',
    usage: { input_tokens: 5, output_tokens: 7 },
    output: [
      {
        id: 'rs_1',
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: 'think' }],
        encrypted_content: 'ENC',
      },
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
      },
    ],
  }

  it('the final object is authoritative for a field both carry, and the difference is reported', () => {
    const final = JSON.parse(JSON.stringify(response)) as typeof response
    ;(final.output[1] as Plain)['content'] = [
      { type: 'output_text', text: 'answer [[1]](https://x)', annotations: [] },
    ]
    const { response: reduced, notes } = reduce(
      synthesizeStreamEvents(response, { finalResponse: final }),
    )
    expect(reduced['output']).toEqual(final.output)
    expect(notes).toEqual([
      'xai: output item message msg_1 differs between the stream and the final response in field(s) [content]; the final response is used.',
    ])
  })

  it('a field the final object lacks and a done event carries is filled from the event', () => {
    const final = JSON.parse(JSON.stringify(response)) as typeof response
    delete (final.output[0] as Plain)['encrypted_content']
    const { response: reduced, notes } = reduce(
      synthesizeStreamEvents(response, { finalResponse: final }),
    )
    expect((reduced['output'] as Plain[])[0]?.['encrypted_content']).toBe('ENC')
    expect(notes).toEqual([
      'xai: output item reasoning rs_1 lacked field(s) [encrypted_content] in the final response; taken from the stream.',
    ])
  })

  it('an item that appears only in the final object is kept (the final object decides what exists)', () => {
    const events = synthesizeStreamEvents(response)
    const reducedEvents = events.filter(
      (e) => !(typeof e['output_index'] === 'number' && e['output_index'] === 0),
    )
    const { response: reduced, notes } = reduce(reducedEvents)
    expect(reduced['output']).toEqual(response.output)
    expect(notes).toEqual([])
  })

  it('an event-only item lands at its output_index among the final items', () => {
    const final = { ...response, output: [response.output[1]] }
    const { response: reduced } = reduce(
      synthesizeStreamEvents(response, { finalResponse: final }),
    )
    expect((reduced['output'] as Plain[]).map((i) => i['id'])).toEqual(['rs_1', 'msg_1'])
  })

  it('id-less items are matched by type and order, not duplicated', () => {
    const anonymous = {
      ...response,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'a' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'b' }],
        },
      ],
    }
    const { response: reduced } = reduce(synthesizeStreamEvents(anonymous))
    expect(reduced['output']).toEqual(anonymous.output)
  })

  it('an assembled item of an incomplete response is marked incomplete', () => {
    const { response: reduced } = reduce(
      synthesizeStreamEvents(
        { ...response, status: 'incomplete' },
        {
          omitDone: true,
          finalResponse: { ...response, status: 'incomplete', output: [] },
        },
      ),
    )
    expect(
      (reduced['output'] as Plain[]).every((i) => i['status'] === 'incomplete'),
    ).toBe(true)
  })

  it('the same id with two types cannot be reconciled', () => {
    const final = JSON.parse(JSON.stringify(response)) as typeof response
    ;(final.output[0] as Plain)['type'] = 'function_call'
    expect(() =>
      reduce(synthesizeStreamEvents(response, { finalResponse: final })),
    ).toThrow(
      /output item function_call rs_1 is a "reasoning" in the stream and a "function_call" in the final response/,
    )
  })

  it.each([
    ['a final output that is not an array', { ...response, output: 'nope' }],
    ['a final output item that is not an object', { ...response, output: ['x'] }],
  ])('%s is malformed', (_name, final) => {
    expect(() =>
      reduce(synthesizeStreamEvents(response, { finalResponse: final as Plain })),
    ).toThrow(XaiStreamError)
  })

  it.each([
    ['an event without a type', [{ nope: 1 }]],
    ['a terminal event without a response', [{ type: 'response.completed' }]],
    [
      'an item event without an index',
      [{ type: 'response.output_item.added', item: { type: 'message' } }],
    ],
    [
      'an item event without an item',
      [{ type: 'response.output_item.done', output_index: 0 }],
    ],
  ])('%s is a malformed stream', (_name, events) => {
    const reducer = new XaiStreamReducer()
    expect(() => {
      for (const event of events) reducer.push(event)
    }).toThrowError(/xAI stream is malformed/)
  })

  it('a delta for an item the stream never opened is ignored', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({
      type: 'response.output_text.delta',
      output_index: 9,
      content_index: 0,
      delta: 'x',
    })
    expect(
      reducer.push({ type: 'response.completed', response: { ...response, output: [] } }),
    ).toBe(true)
    expect(reducer.result().response.output).toEqual([])
  })

  it('unknown event types and heartbeats carry nothing and change nothing', () => {
    const events = synthesizeStreamEvents(response)
    events.splice(3, 0, { type: 'response.some_future_event', payload: 1 })
    const { response: reduced, notes } = reduce(events)
    expect(reduced['output']).toEqual(response.output)
    expect(notes).toEqual([])
  })

  it('response.failed keeps its response and always reads as failed', () => {
    const failed = {
      ...response,
      status: 'in_progress',
      error: { code: 'server_error', message: 'boom' },
      output: [],
    }
    const { response: reduced, notes } = reduce(
      synthesizeStreamEvents(failed, { terminal: 'response.failed' }),
    )
    expect(reduced.status).toBe('failed')
    expect(reduced.error).toEqual({ code: 'server_error', message: 'boom' })
    expect(notes).toEqual([])
  })

  it('response.incomplete is reconciled like response.completed', () => {
    const final = {
      ...response,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }
    const { response: reduced } = reduce(
      synthesizeStreamEvents(final, {
        terminal: 'response.incomplete',
        finalResponse: { ...final, output: [] },
      }),
    )
    expect(reduced.status).toBe('incomplete')
    expect(reduced.output).toEqual(response.output)
  })

  it('an error event is a typed stream error carrying its code', () => {
    const reducer = new XaiStreamReducer()
    expect(() =>
      reducer.push({ type: 'error', code: 'server_error', message: 'upstream died' }),
    ).toThrowError(
      expect.objectContaining({
        failure: { kind: 'error_event', code: 'server_error', message: 'upstream died' },
      }) as never,
    )
  })

  it('a stream with no terminal event is ended_early and carries the latest usage it saw', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({
      type: 'response.created',
      response: { service_tier: 'priority', usage: null },
    })
    reducer.push({
      type: 'response.in_progress',
      response: {
        usage: { input_tokens: 4, output_tokens: 0 },
        service_tier: 'priority',
      },
    })
    reducer.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message' },
    })
    const error = reducer.endedEarly()
    expect(error.failure).toEqual({
      kind: 'ended_early',
      lastEventType: 'response.output_item.added',
    })
    expect(error.partialUsage).toEqual({ input_tokens: 4, output_tokens: 0 })
    expect(error.servedServiceTier).toBe('priority')
    expect(() => reducer.result()).toThrow(XaiStreamError)
  })

  it('usage that is null or lacks token counts is not partial usage', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({ type: 'response.created', response: { usage: null } })
    reducer.push({
      type: 'response.in_progress',
      response: { usage: { total_tokens: 1 } },
    })
    expect(reducer.endedEarly().partialUsage).toBeUndefined()
  })
})

describe('the synthetic grammar matches the real xAI event types (live captures P9a, P12)', () => {
  const real = loadFixture('36-streamed-responses.json') as {
    p9a: Record<
      string,
      Array<{
        nonStreamed: { outputItemTypes: string[] }
        streamed: {
          eventTypeCounts: Record<string, number>
          outputItemTypes: string[]
          annotationsCount: number
          usage: Plain
        }
      }>
    >
    p12: Record<
      string,
      { eventTypeCounts: Record<string, number>; finalOutputItemTypes: unknown }
    >
  }

  it('records the P9a finding: the streamed final object lacked the reasoning item in 2 of 2 search runs', () => {
    for (const pair of real.p9a['web_search'] ?? []) {
      expect(pair.nonStreamed.outputItemTypes).toEqual([
        'web_search_call',
        'reasoning',
        'message',
      ])
      expect(pair.streamed.outputItemTypes).toEqual(['web_search_call', 'message'])
    }
    expect(real.p9a['web_search']).toHaveLength(2)
  })

  it('the real stream announced no reasoning item either, so events and final agreed', () => {
    for (const pair of real.p9a['web_search'] ?? []) {
      expect(pair.streamed.eventTypeCounts['response.output_item.added']).toBe(2)
      expect(pair.streamed.eventTypeCounts['response.output_item.done']).toBe(2)
      expect(pair.streamed.eventTypeCounts).not.toHaveProperty(
        'response.reasoning_summary_part.added',
      )
    }
  })

  it('a synthetic stream of the P9a search shape emits exactly the real event types', () => {
    const pair = real.p9a['web_search']?.[0]
    expect(pair).toBeDefined()
    const synthetic = synthesizeStreamEvents({
      id: 'resp_p9a',
      model: 'grok-4.5',
      status: 'completed',
      usage: pair?.streamed.usage,
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
    const syntheticTypes = new Set(synthetic.map((e) => e.type))
    expect(syntheticTypes).toEqual(
      new Set(Object.keys(pair?.streamed.eventTypeCounts ?? {})),
    )
  })

  it('a synthetic stream of the P12 reasoning shape emits the real event types (minus SSE comments)', () => {
    const run = real.p12['p12-stream-A-grok-4.6-xhigh']
    expect(run).toBeDefined()
    const synthetic = synthesizeStreamEvents({
      id: 'resp_p12',
      model: 'grok-4.6',
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: [{ type: 'summary_text', text: 'steps' }],
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ANSWER: 33', annotations: [] }],
        },
      ],
    })
    const realTypes = new Set(Object.keys(run?.eventTypeCounts ?? {}))
    realTypes.delete('comment')
    expect(new Set(synthetic.map((e) => e.type))).toEqual(realTypes)
  })

  it('every long P12 stream ended on response.completed with a completed status and no error event', () => {
    for (const run of Object.values(real.p12)) {
      expect(run.eventTypeCounts['response.completed']).toBe(1)
      expect(
        Object.keys(run.eventTypeCounts).some(
          (t) => t === 'error' || t === 'response.failed',
        ),
      ).toBe(false)
    }
  })
})
