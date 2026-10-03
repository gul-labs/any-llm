/**
 * Server-sent-event reduction for the xAI Responses API (ADR-040).
 *
 * `run()` sends `stream: true` and reads the SSE stream to its terminal event.
 * The terminal event carries the same response object a non-streamed call
 * returns, and live capture P9a showed that object can be INCOMPLETE: two of
 * two streamed search runs returned a final `output` without the `reasoning`
 * item the non-streamed call had. Everything downstream (the assistant
 * message, citations, the `'state'` continuation that replays the provider's
 * own output items) is built from `output`, so this module rebuilds the output
 * item list from the events and reconciles it with the final object.
 *
 * Reconciliation rules (a pure function of the events; no I/O):
 *
 * 1. Items are matched by `id` and occurrence (xAI repeats an id inside one
 *    `output`: live fixtures carry two `message` items with one `msg_` id); an
 *    item with no id is matched to the same type's n-th id-less item on the
 *    other side.
 * 2. The final object is authoritative for an item it carries. A field it lacks
 *    that a completed (`output_item.done`) event carries is filled from the
 *    event; a field both carry with different values keeps the final's value
 *    and is reported in the notes.
 * 3. An item the events completed and the final object lacks is inserted at its
 *    `output_index`.
 * 4. An item that only ever got `output_item.added` plus deltas, and that the
 *    final object lacks, is assembled from the deltas (text, annotations,
 *    summary parts, function arguments) and marked finished; the notes say so.
 * 5. Structural disagreement cannot be reconciled and throws
 *    {@link XaiStreamError}: the same id with two types, or a malformed event.
 *
 * @module
 */

import type { XaiResponseShape, XaiUsageShape } from './client.js'

/** Why a streamed call failed outside an HTTP error response. */
export type XaiStreamFailure =
  | { kind: 'ended_early'; lastEventType: string | undefined }
  | { kind: 'error_event'; code: string | undefined; message: string | undefined }
  | { kind: 'malformed'; detail: string }
  | { kind: 'deadline'; timeoutMs: number }

/**
 * A streamed xAI call that failed mid-stream. `classifyXaiError` turns it into a
 * typed `LlmError`: usage here is whatever the latest `response.*` snapshot
 * carried, and usually none (the final usage only arrives on the terminal
 * event), in which case the attempt is unpriced rather than free.
 *
 * @internal
 */
export class XaiStreamError extends Error {
  readonly failure: XaiStreamFailure
  readonly partialUsage: XaiUsageShape | undefined
  readonly servedServiceTier: string | undefined

  constructor(
    failure: XaiStreamFailure,
    context: { usage?: XaiUsageShape; serviceTier?: string; cause?: unknown } = {},
  ) {
    super(describeFailure(failure), { cause: context.cause })
    this.name = 'XaiStreamError'
    this.failure = failure
    this.partialUsage = context.usage
    this.servedServiceTier = context.serviceTier
  }
}

function describeFailure(failure: XaiStreamFailure): string {
  switch (failure.kind) {
    case 'ended_early':
      return `xAI stream ended before response.completed${
        failure.lastEventType !== undefined
          ? ` (last event: ${failure.lastEventType})`
          : ' (no events)'
      }`
    case 'error_event':
      return `xAI stream reported an error${
        failure.code !== undefined ? ` (code "${failure.code}")` : ''
      }${failure.message !== undefined ? `: ${failure.message}` : ''}`
    case 'malformed':
      return `xAI stream is malformed: ${failure.detail}`
    case 'deadline':
      return `the stream was still open after the ${failure.timeoutMs} ms request timeout`
  }
}

type PlainRecord = Record<string, unknown>

function isRecord(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
    )
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => k in b && deepEqual(a[k], b[k]))
    )
  }
  return false
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/** The event-side view of one output item. */
interface StreamItem {
  item: PlainRecord
  /** True once `response.output_item.done` delivered the finished item. */
  done: boolean
}

/** The reduced result of a stream that reached a terminal event. */
export interface ReducedXaiStream {
  /** The terminal event's response, with `output` reconciled. */
  response: XaiResponseShape
  /** Diagnostics for what reconciliation did; empty when events and final agree. */
  notes: string[]
}

const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
])

/** Latest numeric usage a `response.*` snapshot carried, if any. */
function usageOf(snapshot: PlainRecord | undefined): XaiUsageShape | undefined {
  const usage = snapshot?.['usage']
  if (
    isRecord(usage) &&
    typeof usage['input_tokens'] === 'number' &&
    typeof usage['output_tokens'] === 'number'
  ) {
    return usage as XaiUsageShape
  }
  return undefined
}

/**
 * Folds Responses API stream events into one response object.
 *
 * Feed every event to {@link push} until it returns `true`, then call
 * {@link result}. When the stream ends before a terminal event, call
 * {@link endedEarly} for the error to throw.
 */
export class XaiStreamReducer {
  private readonly items = new Map<number, StreamItem>()
  private snapshot: PlainRecord | undefined
  private terminal: { type: string; response: PlainRecord } | undefined
  private lastType: string | undefined

  /** Applies one event. Returns `true` once the terminal event has been seen. */
  push(event: unknown): boolean {
    if (!isRecord(event) || typeof event['type'] !== 'string') {
      throw this.malformed('an event has no string `type`')
    }
    const type = event['type']
    this.lastType = type
    if (TERMINAL_EVENTS.has(type)) {
      const response = event['response']
      if (!isRecord(response)) {
        throw this.malformed(`${type} carries no response object`)
      }
      this.terminal = { type, response }
      return true
    }
    switch (type) {
      case 'response.created':
      case 'response.in_progress':
        if (isRecord(event['response'])) this.snapshot = event['response']
        return false
      case 'error':
        throw new XaiStreamError(
          {
            kind: 'error_event',
            code: typeof event['code'] === 'string' ? event['code'] : undefined,
            message: typeof event['message'] === 'string' ? event['message'] : undefined,
          },
          this.context(),
        )
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const index = this.indexOf(event)
        const item = event['item']
        if (!isRecord(item) || typeof item['type'] !== 'string') {
          throw this.malformed(`${type} carries no item with a string type`)
        }
        this.items.set(index, { item: clone(item), done: type.endsWith('.done') })
        return false
      }
      default:
        this.applyDelta(type, event)
        return false
    }
  }

  /** The error for a stream that ended without a terminal event. */
  endedEarly(): XaiStreamError {
    return new XaiStreamError(
      { kind: 'ended_early', lastEventType: this.lastType },
      this.context(),
    )
  }

  /** Partial usage and tier the latest snapshot carried (for stream failures). */
  context(): { usage?: XaiUsageShape; serviceTier?: string } {
    const usage = usageOf(this.snapshot)
    const tier = this.snapshot?.['service_tier']
    return {
      ...(usage !== undefined ? { usage } : {}),
      ...(typeof tier === 'string' && tier.length > 0 ? { serviceTier: tier } : {}),
    }
  }

  /**
   * The terminal response with its output reconciled against the events.
   *
   * @throws XaiStreamError when the stream has no terminal event yet, or events
   *   and the final response disagree structurally.
   */
  result(): ReducedXaiStream {
    const terminal = this.terminal
    if (terminal === undefined) throw this.endedEarly()
    const response = terminal.response
    if (terminal.type === 'response.failed') {
      // The event type is the authority for failure: a failed event whose
      // response object forgot to say so must still be a failure downstream.
      const status = response['status']
      return {
        response: {
          ...response,
          status: status === 'failed' || status === 'cancelled' ? status : 'failed',
        } as unknown as XaiResponseShape,
        notes: [],
      }
    }
    const { output, notes } = this.reconcile(response['output'], response['status'])
    return {
      response: { ...response, output } as unknown as XaiResponseShape,
      notes,
    }
  }

  private malformed(detail: string): XaiStreamError {
    return new XaiStreamError({ kind: 'malformed', detail }, this.context())
  }

  private indexOf(event: PlainRecord): number {
    const index = event['output_index']
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw this.malformed(`${String(event['type'])} has no integer output_index`)
    }
    return index
  }

  /**
   * Deltas build up the item an `added` event opened. A delta for an item the
   * stream never opened is ignored: the terminal object or a `done` event still
   * carries the item, and a lost delta must not fail a billed call.
   */
  private applyDelta(type: string, event: PlainRecord): void {
    const entry = this.items.get(
      typeof event['output_index'] === 'number' ? event['output_index'] : -1,
    )
    if (entry === undefined) return
    const item = entry.item
    const contentIndex = event['content_index']
    const summaryIndex = event['summary_index']
    const textAt = (
      list: unknown,
      index: unknown,
      defaults: PlainRecord,
    ): PlainRecord => {
      if (!Array.isArray(list) || typeof index !== 'number') return {}
      const existing: unknown = list[index]
      if (isRecord(existing)) return existing
      const created = { ...defaults }
      list[index] = created
      return created
    }
    const content = (): unknown[] => {
      if (!Array.isArray(item['content'])) item['content'] = []
      return item['content'] as unknown[]
    }
    const summary = (): unknown[] => {
      if (!Array.isArray(item['summary'])) item['summary'] = []
      return item['summary'] as unknown[]
    }
    switch (type) {
      case 'response.content_part.added':
      case 'response.content_part.done':
        if (typeof contentIndex === 'number' && isRecord(event['part'])) {
          content()[contentIndex] = clone(event['part'])
        }
        return
      case 'response.output_text.delta': {
        const part = textAt(content(), contentIndex, { type: 'output_text', text: '' })
        if (typeof event['delta'] === 'string') {
          part['text'] =
            `${typeof part['text'] === 'string' ? part['text'] : ''}${event['delta']}`
        }
        return
      }
      case 'response.output_text.done': {
        const part = textAt(content(), contentIndex, { type: 'output_text', text: '' })
        if (typeof event['text'] === 'string') part['text'] = event['text']
        return
      }
      case 'response.output_text.annotation.added': {
        const part = textAt(content(), contentIndex, { type: 'output_text', text: '' })
        if (!Array.isArray(part['annotations'])) part['annotations'] = []
        const index = event['annotation_index']
        if (typeof index === 'number' && event['annotation'] !== undefined) {
          ;(part['annotations'] as unknown[])[index] = clone(event['annotation'])
        }
        return
      }
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        if (typeof summaryIndex === 'number' && isRecord(event['part'])) {
          summary()[summaryIndex] = clone(event['part'])
        }
        return
      case 'response.reasoning_summary_text.delta': {
        const part = textAt(summary(), summaryIndex, { type: 'summary_text', text: '' })
        if (typeof event['delta'] === 'string') {
          part['text'] =
            `${typeof part['text'] === 'string' ? part['text'] : ''}${event['delta']}`
        }
        return
      }
      case 'response.reasoning_summary_text.done': {
        const part = textAt(summary(), summaryIndex, { type: 'summary_text', text: '' })
        if (typeof event['text'] === 'string') part['text'] = event['text']
        return
      }
      case 'response.function_call_arguments.delta':
        if (typeof event['delta'] === 'string') {
          item['arguments'] =
            `${typeof item['arguments'] === 'string' ? item['arguments'] : ''}${event['delta']}`
        }
        return
      case 'response.function_call_arguments.done':
        if (typeof event['arguments'] === 'string') item['arguments'] = event['arguments']
        return
      default:
        // `response.web_search_call.*`, heartbeats and event types this
        // version does not know carry nothing the item events do not.
        return
    }
  }

  private reconcile(
    finalOutput: unknown,
    responseStatus: unknown,
  ): { output: unknown[]; notes: string[] } {
    if (finalOutput !== undefined && !Array.isArray(finalOutput)) {
      throw this.malformed('the final response `output` is not an array')
    }
    const finalItems: PlainRecord[] = []
    for (const item of finalOutput ?? []) {
      if (!isRecord(item)) {
        throw this.malformed('the final response `output` holds a non-object item')
      }
      finalItems.push(clone(item))
    }

    // Real xAI responses repeat an id within one `output` (two `message` items
    // sharing one `msg_` id, two `reasoning` items sharing one `rs_` id), so an
    // id alone is not a key: it is the id plus how many times that id has
    // appeared so far, in output order on both sides.
    const keyOf = (counters: Map<string, number>, item: PlainRecord): string => {
      const id = item['id']
      const label =
        typeof id === 'string' && id.length > 0
          ? `id:${id}`
          : `anon:${String(item['type'])}`
      const n = counters.get(label) ?? 0
      counters.set(label, n + 1)
      return `${label}:${n}`
    }
    const labelOf = (item: PlainRecord): string =>
      typeof item['id'] === 'string' && item['id'].length > 0
        ? `${String(item['type'])} ${item['id']}`
        : String(item['type'])

    const finalCounters = new Map<string, number>()
    const finalByKey = new Map<string, PlainRecord>()
    for (const item of finalItems) finalByKey.set(keyOf(finalCounters, item), item)

    const notes: string[] = []
    const eventCounters = new Map<string, number>()
    const insertions: Array<{ index: number; item: PlainRecord }> = []
    const rebuilt: string[] = []
    const assembled: string[] = []
    const sorted = [...this.items.entries()].sort(([a], [b]) => a - b)
    for (const [index, entry] of sorted) {
      const key = keyOf(eventCounters, entry.item)
      const finalItem = finalByKey.get(key)
      if (finalItem !== undefined) {
        if (finalItem['type'] !== entry.item['type']) {
          throw this.malformed(
            `output item ${labelOf(finalItem)} is a "${String(entry.item['type'])}" in the stream and a "${String(finalItem['type'])}" in the final response`,
          )
        }
        if (!entry.done) continue
        const filled: string[] = []
        const diverged: string[] = []
        for (const [field, value] of Object.entries(entry.item)) {
          if (!(field in finalItem)) {
            finalItem[field] = clone(value)
            filled.push(field)
          } else if (!deepEqual(finalItem[field], value)) {
            diverged.push(field)
          }
        }
        if (filled.length > 0) {
          notes.push(
            `xai: output item ${labelOf(finalItem)} lacked field(s) [${filled.join(', ')}] in the final response; taken from the stream.`,
          )
        }
        if (diverged.length > 0) {
          notes.push(
            `xai: output item ${labelOf(finalItem)} differs between the stream and the final response in field(s) [${diverged.join(', ')}]; the final response is used.`,
          )
        }
        continue
      }
      const item = clone(entry.item)
      if (!entry.done) {
        // Never finished by an `output_item.done` and absent from the final
        // object: what the deltas built is all there is. The response ended, so
        // the item is finished too (a replayed `in_progress` item is not valid).
        item['status'] = responseStatus === 'incomplete' ? 'incomplete' : 'completed'
        assembled.push(labelOf(item))
      } else {
        rebuilt.push(labelOf(item))
      }
      insertions.push({ index, item })
    }

    const output: PlainRecord[] = [...finalItems]
    for (const { index, item } of insertions) {
      output.splice(Math.min(index, output.length), 0, item)
    }
    if (rebuilt.length > 0) {
      notes.push(
        `xai: the final response lacked ${rebuilt.length} output item(s) [${rebuilt.join(', ')}] that the stream completed; they were rebuilt from the stream events.`,
      )
    }
    if (assembled.length > 0) {
      notes.push(
        `xai: the final response lacked ${assembled.length} output item(s) [${assembled.join(', ')}] that the stream never completed; they were assembled from the stream deltas and may lack provider-only fields.`,
      )
    }
    return { output, notes }
  }
}
