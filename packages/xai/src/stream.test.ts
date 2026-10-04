/**
 * The stream reducer (ADR-040): events in, one reconciled response out.
 *
 * Mixed evidence, each block says which (ADR-013). The reconciliation rules run
 * over SYNTHETIC sequences: `synthesizeStreamEvents` is the OpenAI Responses
 * streaming grammar applied to the recorded non-streamed fixtures, so those
 * tests prove the rules, not xAI's grammar. The delta-assembly block is
 * hand-written (no `*.done` events, so the deltas alone decide). The reducer
 * against REAL xAI event bodies is `stream.real.test.ts` (fixture
 * `37-streamed-events.json`); the last block here pins the synthetic grammar to
 * the event types of the earlier P9a/P12 captures (`36-streamed-responses.json`).
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

  it('the same id with two types keeps the final object item and reports it (enrichment, never a gate)', () => {
    const final = JSON.parse(JSON.stringify(response)) as typeof response
    ;(final.output[0] as Plain)['type'] = 'function_call'
    const { response: reduced, notes } = reduce(
      synthesizeStreamEvents(response, { finalResponse: final }),
    )
    expect(reduced['output']).toEqual(final.output)
    expect(notes).toEqual([
      'xai: output item function_call rs_1 is a "reasoning" in the stream and a "function_call" in the final response; the final response is used.',
    ])
  })

  it('a final output that is not an array is replaced by the items the events built', () => {
    const { response: reduced, notes } = reduce(
      synthesizeStreamEvents(response, {
        finalResponse: { ...response, output: 'nope' },
      }),
    )
    expect(reduced['output']).toEqual(response.output)
    expect(notes).toEqual([
      'xai: the final response `output` is not an array; the output items were built from the stream events.',
    ])
  })

  it('a final output item that is not an object is dropped and reported', () => {
    const { response: reduced, notes } = reduce(
      synthesizeStreamEvents(response, {
        finalResponse: { ...response, output: ['x', ...response.output] },
      }),
    )
    expect(reduced['output']).toEqual(response.output)
    expect(notes).toEqual([
      'xai: dropped 1 non-object item(s) from the final response `output`.',
    ])
  })

  it('a terminal event without a response object is the one malformed shape', () => {
    const reducer = new XaiStreamReducer()
    expect(() => reducer.push({ type: 'response.completed' })).toThrowError(
      /xAI stream is malformed: response.completed carries no response object/,
    )
  })

  it('a body that is not JSON is a malformed stream', () => {
    const reducer = new XaiStreamReducer()
    expect(() => reducer.pushFrame({ event: undefined, data: '{not json' })).toThrowError(
      /xAI stream is malformed: an event body is not valid JSON/,
    )
  })

  it.each([
    ['an event without a type', [{ nope: 1 }], /an event that has no string `type`/],
    [
      'an item event without an index',
      [{ type: 'response.output_item.added', item: { type: 'message' } }],
      /output_item.added event with no integer output_index or typed item/,
    ],
    [
      'an item event without an item',
      [{ type: 'response.output_item.done', output_index: 0 }],
      /output_item.done event with no integer output_index or typed item/,
    ],
    [
      'an item event with a fractional index',
      [
        {
          type: 'response.output_item.done',
          output_index: 0.5,
          item: { type: 'message' },
        },
      ],
      /output_item.done event with no integer output_index or typed item/,
    ],
  ])('%s is skipped, reported, and the final response is used', (_name, events, note) => {
    const reducer = new XaiStreamReducer()
    for (const event of events) reducer.push(event)
    reducer.push({ type: 'response.completed', response })
    const { response: reduced, notes } = reducer.result()
    expect(reduced.output).toEqual(response.output)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(note)
  })

  it('a frame with no data, the [DONE] sentinel and a typeless JSON body are skipped', () => {
    const reducer = new XaiStreamReducer()
    expect(reducer.pushFrame({ event: 'keepalive', data: '' })).toBe(false)
    expect(reducer.pushFrame({ event: undefined, data: '[DONE]' })).toBe(false)
    expect(reducer.pushFrame({ event: 'ping', data: '{"hello":1}' })).toBe(false)
    reducer.pushFrame({
      event: 'response.completed',
      data: JSON.stringify({ type: 'response.completed', response }),
    })
    const { notes } = reducer.result()
    // The two benign frames say nothing; the typeless JSON object is reported.
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('an event that has no string `type`')
  })

  it('an `event: error` frame whose JSON has no type, nested or flat, is the error event', () => {
    for (const data of [
      { error: { code: 'rate_limit_exceeded', message: 'slow' } },
      { code: 'rate_limit_exceeded', message: 'slow' },
    ]) {
      const reducer = new XaiStreamReducer()
      expect(() =>
        reducer.pushFrame({ event: 'error', data: JSON.stringify(data) }),
      ).toThrowError(
        expect.objectContaining({
          failure: { kind: 'error_event', code: 'rate_limit_exceeded', message: 'slow' },
        }) as never,
      )
    }
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

  it('progress: only output events count, and the received characters are totalled', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({ type: 'response.created', response: { usage: null } })
    reducer.push({ type: 'response.in_progress', response: { usage: null } })
    expect(reducer.progress()).toEqual({ progressed: false, outputChars: 0 })
    expect(reducer.endedEarly().progress.progressed).toBe(false)
    reducer.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', content: [] },
    })
    expect(reducer.progress().progressed).toBe(true)
    reducer.push({
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    })
    reducer.push({
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: 'hello',
    })
    reducer.push({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'function_call', arguments: '' },
    })
    reducer.push({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      delta: '{"a":1}',
    })
    expect(reducer.progress()).toEqual({ progressed: true, outputChars: 12 })
    const error = reducer.endedEarly()
    expect(error.failure).toEqual({
      kind: 'ended_early',
      lastEventType: 'response.function_call_arguments.delta',
    })
    expect(error.progress).toEqual({ progressed: true, outputChars: 12 })
    expect(() => reducer.result()).toThrow(XaiStreamError)
  })

  it('snapshot usage and cost ticks are never partial usage; only the tier is taken from a snapshot', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({
      type: 'response.in_progress',
      response: {
        usage: { input_tokens: 4, output_tokens: 0, cost_in_usd_ticks: 5 },
        service_tier: 'priority',
      },
    })
    const error = reducer.endedEarly()
    expect(error.terminalUsage).toBeUndefined()
    expect(error.servedServiceTier).toBe('priority')
  })

  it('an error after the terminal event carries the terminal usage, cost ticks included', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({
      type: 'response.completed',
      response: {
        service_tier: 'default',
        usage: { input_tokens: 9, output_tokens: 3, cost_in_usd_ticks: 4033200000 },
        output: [],
      },
    })
    expect(reducer.progress().progressed).toBe(true)
    const error = reducer.endedEarly()
    expect(error.terminalUsage).toEqual({
      input_tokens: 9,
      output_tokens: 3,
      cost_in_usd_ticks: 4033200000,
    })
    expect(error.servedServiceTier).toBe('default')
  })

  it('a terminal usage without token counts is not usage', () => {
    const reducer = new XaiStreamReducer()
    reducer.push({
      type: 'response.incomplete',
      response: { usage: { total_tokens: 1 }, output: [] },
    })
    expect(reducer.context().terminalUsage).toBeUndefined()
  })
})

describe('delta assembly (hand-written event sequences with no done events)', () => {
  const item = (index: number, body: Plain): Plain => ({
    type: 'response.output_item.added',
    output_index: index,
    item: body,
  })
  const finish = (events: Plain[], status = 'completed') => {
    const reducer = new XaiStreamReducer()
    for (const event of events) reducer.push(event)
    reducer.push({ type: 'response.completed', response: { status, output: [] } })
    return reducer.result().response.output as Plain[]
  }

  it('a text delta is appended exactly once, in order, per part', () => {
    const [message] = finish([
      item(0, { type: 'message', role: 'assistant', content: [] }),
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'Hel',
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'lo ',
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'wörld',
      },
    ])
    expect((message?.['content'] as Plain[])[0]?.['text']).toBe('Hello wörld')
  })

  it('interleaved items and out-of-order content parts each keep their own text', () => {
    const [first, second] = finish([
      item(0, { type: 'message', content: [] }),
      item(1, { type: 'message', content: [] }),
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 1,
        delta: 'B1',
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: 'A0',
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta: 'B0',
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        content_index: 0,
        delta: '+',
      },
    ])
    expect((first?.['content'] as Plain[]).map((p) => p['text'])).toEqual(['A0+'])
    expect((second?.['content'] as Plain[]).map((p) => p['text'])).toEqual(['B0', 'B1'])
  })

  it('an annotation lands at its annotation_index, not one past it', () => {
    const [message] = finish([
      item(0, { type: 'message', content: [] }),
      {
        type: 'response.content_part.added',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.annotation.added',
        output_index: 0,
        content_index: 0,
        annotation_index: 1,
        annotation: { type: 'url_citation', url: 'https://b' },
      },
      {
        type: 'response.output_text.annotation.added',
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: { type: 'url_citation', url: 'https://a' },
      },
    ])
    expect(
      ((message?.['content'] as Plain[])[0]?.['annotations'] as Plain[]).map(
        (a) => a['url'],
      ),
    ).toEqual(['https://a', 'https://b'])
  })

  it('function-call argument deltas and custom tool input deltas are appended', () => {
    const [call, custom] = finish([
      item(0, { type: 'function_call', call_id: 'c', name: 'f', arguments: '' }),
      item(1, {
        type: 'custom_tool_call',
        call_id: 'x',
        name: 'x_keyword_search',
        input: '',
      }),
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"ci' },
      { type: 'response.custom_tool_call_input.delta', output_index: 1, delta: '{"q":' },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: 'ty":"Paris"}',
      },
      { type: 'response.custom_tool_call_input.delta', output_index: 1, delta: '"x"}' },
    ])
    expect(call?.['arguments']).toBe('{"city":"Paris"}')
    expect(custom?.['input']).toBe('{"q":"x"}')
  })

  it('reasoning summary parts assemble per summary_index', () => {
    const [reasoning] = finish([
      item(0, { type: 'reasoning', summary: [] }),
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 1,
        delta: 'second',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'first ',
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        delta: 'part',
      },
    ])
    expect((reasoning?.['summary'] as Plain[]).map((p) => p['text'])).toEqual([
      'first part',
      'second',
    ])
  })

  it('an item the response ended is finished: completed, or incomplete for an incomplete response', () => {
    const open = [item(0, { type: 'message', status: 'in_progress', content: [] })]
    expect(finish(open)[0]?.['status']).toBe('completed')
    expect(finish(open, 'incomplete')[0]?.['status']).toBe('incomplete')
  })
})

describe('matching items that the final object omits', () => {
  const message = (id: string | undefined, text: string): Plain => ({
    ...(id !== undefined ? { id } : {}),
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  })
  const run = (streamed: Plain[], final: Plain[]) =>
    reduce(
      synthesizeStreamEvents(
        {
          id: 'r',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
          output: streamed,
        },
        {
          finalResponse: {
            id: 'r',
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 1 },
            output: final,
          },
        },
      ),
    )

  it('two items under one id, the final object omitting the FIRST: neither is lost or duplicated', () => {
    const first = message('msg_1', 'first draft')
    const second = message('msg_1', 'second')
    const { response, notes } = run([first, second], [second])
    expect(response.output).toEqual([first, second])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('rebuilt from the stream events')
  })

  it('the final object omitting the LAST of an id group is rebuilt at its index', () => {
    const first = message('msg_1', 'first draft')
    const second = message('msg_1', 'second')
    const { response } = run([first, second], [first])
    expect(response.output).toEqual([first, second])
  })

  it('an item the stream called by another id but with identical content is one item', () => {
    const streamed = {
      id: 'rs_stream',
      type: 'reasoning',
      status: 'completed',
      summary: [],
      encrypted_content: 'ENC',
    }
    const final = { ...streamed, id: 'rs_final' }
    const { response, notes } = run([streamed], [final])
    expect(response.output).toEqual([final])
    expect(notes).toEqual([])
  })

  it('an id on one side only does not duplicate identical content either', () => {
    const { response } = run([message(undefined, 'same')], [message('msg_late', 'same')])
    expect(response.output).toEqual([message('msg_late', 'same')])
  })

  it('items with different content under different ids are both kept', () => {
    const { response } = run([message('msg_a', 'a')], [message('msg_b', 'b')])
    expect((response.output as Plain[]).map((i) => i['id'])).toEqual(['msg_a', 'msg_b'])
  })
})

describe('what a divergence is worth reporting (live finding, 2026-10-03)', () => {
  it('a search call whose action.sources differ is not reported; the final object is used', () => {
    const streamed = {
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'q', sources: [{ url: 'https://a' }] },
    }
    const final = {
      ...streamed,
      action: {
        ...streamed.action,
        sources: [{ url: 'https://a' }, { url: 'https://b' }],
      },
    }
    const { response, notes } = reduce(
      synthesizeStreamEvents(
        {
          id: 'r',
          status: 'completed',
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [streamed],
        },
        {
          finalResponse: {
            id: 'r',
            status: 'completed',
            usage: { input_tokens: 1, output_tokens: 1 },
            output: [final],
          },
        },
      ),
    )
    expect(response.output).toEqual([final])
    expect(notes).toEqual([])
  })
})

describe('response.incomplete is normalised like response.failed', () => {
  it.each(['in_progress', 'completed', undefined])(
    'an incomplete event whose response says %s is incomplete, with its assembled items finished as incomplete',
    (status) => {
      const reducer = new XaiStreamReducer()
      reducer.push({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', status: 'in_progress', content: [] },
      })
      reducer.push({
        type: 'response.incomplete',
        response: { ...(status !== undefined ? { status } : {}), output: [] },
      })
      const { response } = reducer.result()
      expect(response.status).toBe('incomplete')
      expect((response.output as Plain[])[0]?.['status']).toBe('incomplete')
    },
  )
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
