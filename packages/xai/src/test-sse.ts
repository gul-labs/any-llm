/**
 * Test helpers for the streamed Responses API (ADR-040): SSE bodies for a
 * stubbed `fetch`, and a synthesiser that turns a response object into the
 * event sequence the OpenAI Responses streaming grammar documents.
 *
 * SYNTHETIC (ADR-013): the grammar here is OpenAI's documented Responses
 * streaming contract (the API xAI is compatible with), not a capture. Live
 * capture P9a pinned the event TYPES of real xAI streams (see
 * `__fixtures__/36-streamed-responses.json`); nothing here invents a capture.
 * Tests built on it label themselves synthetic.
 *
 * @module
 */

export type SseEvent = { type: string; [key: string]: unknown }

type Plain = Record<string, unknown>

/** `event:` / `data:` blocks, one per event, as the wire carries them. */
export function sseBody(events: readonly SseEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** A 200 `text/event-stream` response over `events`. */
export function sseResponse(
  events: readonly SseEvent[],
  headers: Record<string, string> = {},
): Response {
  return new Response(sseBody(events), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...headers },
  })
}

/** A 200 `text/event-stream` response over a body that is not event-shaped. */
export function rawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

export interface SynthesizeOptions {
  /** Emit no `output_item.done` events, so items exist only as added + deltas. */
  omitDone?: boolean
  /** Replace the terminal event's response (default: the response itself). */
  finalResponse?: Plain
  /** Terminal event type (default `response.completed`). */
  terminal?: 'response.completed' | 'response.incomplete' | 'response.failed'
  /** Omit the terminal event, as a stream cut short does. */
  omitTerminal?: boolean
}

function chunks(text: string): string[] {
  if (text.length < 3) return [text]
  const a = Math.floor(text.length / 3)
  const b = Math.floor((2 * text.length) / 3)
  return [text.slice(0, a), text.slice(a, b), text.slice(b)]
}

/**
 * The events a streamed call would carry for `response`: created and
 * in-progress snapshots, then for each output item its `added` skeleton, the
 * deltas that build it, and its `done` item, then the terminal event.
 */
export function synthesizeStreamEvents(
  response: Plain,
  options: SynthesizeOptions = {},
): SseEvent[] {
  const events: SseEvent[] = []
  let seq = 0
  const push = (type: string, body: Plain = {}): void => {
    events.push({ type, sequence_number: seq++, ...body })
  }
  const snapshot = { ...response, status: 'in_progress', output: [], usage: null }
  push('response.created', { response: snapshot })
  push('response.in_progress', { response: snapshot })

  const output = Array.isArray(response['output']) ? (response['output'] as Plain[]) : []
  output.forEach((item, outputIndex) => {
    const at = { output_index: outputIndex }
    const itemId = item['id']
    const skeleton: Plain = { ...item, status: 'in_progress' }
    if (item['type'] === 'message') skeleton['content'] = []
    if (item['type'] === 'reasoning') skeleton['summary'] = []
    if (item['type'] === 'function_call') skeleton['arguments'] = ''
    push('response.output_item.added', { ...at, item: skeleton })

    if (item['type'] === 'message') {
      const content = Array.isArray(item['content']) ? (item['content'] as Plain[]) : []
      content.forEach((part, contentIndex) => {
        const where = { ...at, item_id: itemId, content_index: contentIndex }
        const text = typeof part['text'] === 'string' ? part['text'] : ''
        push('response.content_part.added', {
          ...where,
          part: { ...part, text: '', annotations: [] },
        })
        for (const delta of chunks(text))
          push('response.output_text.delta', { ...where, delta })
        const annotations = Array.isArray(part['annotations'])
          ? (part['annotations'] as unknown[])
          : []
        annotations.forEach((annotation, annotationIndex) => {
          push('response.output_text.annotation.added', {
            ...where,
            annotation_index: annotationIndex,
            annotation,
          })
        })
        push('response.output_text.done', { ...where, text })
        push('response.content_part.done', { ...where, part })
      })
    } else if (item['type'] === 'reasoning') {
      const summary = Array.isArray(item['summary']) ? (item['summary'] as Plain[]) : []
      summary.forEach((part, summaryIndex) => {
        const where = { ...at, item_id: itemId, summary_index: summaryIndex }
        const text = typeof part['text'] === 'string' ? part['text'] : ''
        push('response.reasoning_summary_part.added', {
          ...where,
          part: { ...part, text: '' },
        })
        for (const delta of chunks(text)) {
          push('response.reasoning_summary_text.delta', { ...where, delta })
        }
        push('response.reasoning_summary_text.done', { ...where, text })
        push('response.reasoning_summary_part.done', { ...where, part })
      })
    } else if (item['type'] === 'function_call') {
      const args = typeof item['arguments'] === 'string' ? item['arguments'] : ''
      const where = { ...at, item_id: itemId }
      for (const delta of chunks(args)) {
        push('response.function_call_arguments.delta', { ...where, delta })
      }
      push('response.function_call_arguments.done', { ...where, arguments: args })
    } else if (item['type'] === 'web_search_call') {
      const where = { ...at, item_id: itemId }
      push('response.web_search_call.in_progress', where)
      push('response.web_search_call.searching', where)
      push('response.web_search_call.completed', where)
    }
    if (options.omitDone !== true) push('response.output_item.done', { ...at, item })
  })

  if (options.omitTerminal !== true) {
    push(options.terminal ?? 'response.completed', {
      response: options.finalResponse ?? response,
    })
  }
  return events
}
