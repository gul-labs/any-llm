/**
 * The stream reducer against REAL xAI event streams (ADR-013, ADR-040 Amendment A).
 *
 * `__fixtures__/37-streamed-events.json` holds the raw server-sent-event text of
 * live streams captured on 2026-10-03 through the built adapter: a plain
 * reasoning call, a function call and its `'state'` replay, strict structured
 * output, one and several web searches, an X search, the priority tier and a
 * `response.incomplete`. Nothing here is synthesised, so these tests are not the
 * circular ones the synthetic grammar allows: they stop the reducer from
 * inverting its own test helper.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSseFrames } from './sse.js'
import type { XaiSseFrame } from './stream.js'
import { XaiStreamReducer } from './stream.js'

type Plain = Record<string, unknown>

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./__fixtures__/37-streamed-events.json', import.meta.url)),
    'utf8',
  ),
) as { streams: Record<string, { model: string; request: Plain; sse: string }> }

const NAMES = Object.keys(fixture.streams)

async function framesOf(sse: string): Promise<XaiSseFrame[]> {
  const frames: XaiSseFrame[] = []
  const body = new Response(sse).body as ReadableStream<Uint8Array>
  for await (const frame of readSseFrames(body)) frames.push(frame)
  return frames
}

async function eventsOf(name: string): Promise<Plain[]> {
  const frames = await framesOf(fixture.streams[name]?.sse ?? '')
  return frames.map((f) => JSON.parse(f.data) as Plain)
}

function terminalOf(events: Plain[]): Plain {
  const last = events[events.length - 1] as Plain
  expect(['response.completed', 'response.incomplete']).toContain(last['type'])
  return last['response'] as Plain
}

function reduce(events: Plain[]) {
  const reducer = new XaiStreamReducer()
  for (const event of events) if (reducer.push(event)) break
  return reducer.result()
}

const DONE_EVENTS = new Set([
  'response.output_item.done',
  'response.output_text.done',
  'response.content_part.done',
  'response.reasoning_summary_text.done',
  'response.reasoning_summary_part.done',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.done',
])

describe('the pinned real streams', () => {
  it('cover every feature class', () => {
    expect(NAMES).toEqual([
      'plain',
      'priority',
      'incomplete',
      'schema_low',
      'schema_high',
      'function_call_turn1',
      'function_call_turn2_state_replay',
      'web_search_one',
      'web_search_multi',
      'x_search',
    ])
  })

  it.each(NAMES)(
    '%s: every item event and delta carries an integer output_index',
    async (name) => {
      const events = await eventsOf(name)
      const itemEvents = events.filter(
        (e) =>
          typeof e['type'] === 'string' &&
          /^response\.(output_item|content_part|output_text|reasoning_summary|function_call|custom_tool_call|web_search_call)/.test(
            e['type'],
          ),
      )
      expect(itemEvents.length).toBeGreaterThan(0)
      for (const event of itemEvents) {
        expect(Number.isInteger(event['output_index'])).toBe(true)
      }
    },
  )

  it.each(NAMES)('%s: the snapshots carry usage: null', async (name) => {
    const events = await eventsOf(name)
    for (const event of events.filter(
      (e) => e['type'] === 'response.created' || e['type'] === 'response.in_progress',
    )) {
      expect((event['response'] as Plain)['usage']).toBeNull()
    }
  })
})

describe('reducing a real stream', () => {
  it.each(NAMES)(
    '%s: events and the final object agree, so the output is the final output and there are no notes',
    async (name) => {
      const events = await eventsOf(name)
      const { response, notes } = reduce(events)
      expect(response.output).toEqual(terminalOf(events)['output'])
      expect(notes).toEqual([])
    },
  )

  it.each(NAMES)(
    "%s: each real output_item.done equals the final item at its index, except a search call's cumulative sources",
    async (name) => {
      const events = await eventsOf(name)
      const final = terminalOf(events)['output'] as Plain[]
      const done = events.filter((e) => e['type'] === 'response.output_item.done')
      for (const event of done) {
        const streamed = event['item'] as Plain
        const finalItem = final[event['output_index'] as number] as Plain
        if (streamed['type'] === 'web_search_call') {
          expect({ ...streamed, action: undefined }).toEqual({
            ...finalItem,
            action: undefined,
          })
          const action = streamed['action'] as Plain
          const finalAction = finalItem['action'] as Plain
          expect(action['query']).toEqual(finalAction['query'])
          // The final object lists every source of the run on every search call.
          const urls = (a: Plain) => (a['sources'] as Plain[]).map((s) => s['url'])
          expect(urls(finalAction)).toEqual(expect.arrayContaining(urls(action)))
        } else {
          expect(streamed).toEqual(finalItem)
        }
      }
    },
  )

  it.each(NAMES)(
    '%s: an EMPTY final output is rebuilt from the real done events to the real final items',
    async (name) => {
      const events = await eventsOf(name)
      const terminal = terminalOf(events)
      const withEmptyFinal = events.map((e) =>
        e === events[events.length - 1]
          ? { ...e, response: { ...terminal, output: [] } }
          : e,
      )
      const { response } = reduce(withEmptyFinal)
      const final = terminal['output'] as Plain[]
      const rebuilt = response.output as Plain[]
      expect(rebuilt.map((i) => i['type'])).toEqual(final.map((i) => i['type']))
      rebuilt.forEach((item, i) => {
        const real = final[i] as Plain
        if (real['type'] === 'web_search_call') {
          expect(item['id']).toBe(real['id'])
        } else {
          expect(item).toEqual(real)
        }
      })
    },
  )

  it.each(NAMES)(
    '%s: with every *.done event removed, the items assemble from added + deltas to the real items',
    async (name) => {
      const events = await eventsOf(name)
      const terminal = terminalOf(events)
      const doneItems = events
        .filter((e) => e['type'] === 'response.output_item.done')
        .sort((a, b) => (a['output_index'] as number) - (b['output_index'] as number))
      const deltaOnly = events
        .filter((e) => !DONE_EVENTS.has(String(e['type'])))
        .map((e) =>
          e === events[events.length - 1]
            ? { ...e, response: { ...terminal, output: [] } }
            : e,
        )
      const { response, notes } = reduce(deltaOnly)
      const rebuilt = response.output as Plain[]
      const incomplete = terminal['status'] === 'incomplete'
      // The incomplete stream never sends a done event: the terminal response is the reference.
      const reference: Plain[] =
        doneItems.length > 0
          ? doneItems.map((e) => e['item'] as Plain)
          : (terminal['output'] as Plain[])
      expect(rebuilt).toHaveLength(reference.length)
      let deltas = 0
      rebuilt.forEach((item, i) => {
        const real = reference[i] as Plain
        expect(item['type']).toBe(real['type'])
        expect(item['status']).toBe(incomplete ? 'incomplete' : 'completed')
        if (real['type'] === 'message') {
          expect(item['content']).toEqual(real['content'])
          deltas += 1
        } else if (real['type'] === 'reasoning') {
          expect(item['summary']).toEqual(real['summary'])
        } else if (real['type'] === 'function_call') {
          expect(item['arguments']).toBe(real['arguments'])
          expect(item['call_id']).toBe(real['call_id'])
          expect(item['name']).toBe(real['name'])
          deltas += 1
        } else if (real['type'] === 'custom_tool_call') {
          expect(item['input']).toBe(real['input'])
          deltas += 1
        }
      })
      // Not vacuous: every stream builds at least one item from deltas alone.
      expect(deltas).toBeGreaterThan(0)
      expect(notes.some((n) => n.includes('assembled from the stream deltas'))).toBe(true)
    },
  )

  it('the multi-search stream carries many annotation events, applied at their own indexes', async () => {
    const events = await eventsOf('web_search_multi')
    const annotations = events.filter(
      (e) => e['type'] === 'response.output_text.annotation.added',
    )
    expect(annotations.length).toBeGreaterThan(10)
    const terminal = terminalOf(events)
    const message = (terminal['output'] as Plain[]).find((i) => i['type'] === 'message')
    const real = ((message?.['content'] as Plain[])[0] as Plain)['annotations'] as Plain[]
    expect(real).toHaveLength(annotations.length)
    annotations.forEach((e, i) => {
      expect(e['annotation_index']).toBe(i)
      expect(e['annotation']).toEqual(real[i])
    })
  })

  it('the function-call stream delivers its whole argument string in one delta', async () => {
    const events = await eventsOf('function_call_turn1')
    const deltas = events.filter(
      (e) => e['type'] === 'response.function_call_arguments.delta',
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.['delta']).toBe('{"city":"Paris"}')
  })

  it('response.incomplete arrives with no done events and status incomplete', async () => {
    const events = await eventsOf('incomplete')
    expect(events.some((e) => DONE_EVENTS.has(String(e['type'])))).toBe(false)
    const last = events[events.length - 1] as Plain
    expect(last['type']).toBe('response.incomplete')
    const response = last['response'] as Plain
    expect(response['status']).toBe('incomplete')
    expect(response['incomplete_details']).toEqual({ reason: 'max_output_tokens' })
    expect(reduce(events).response.status).toBe('incomplete')
  })
})
